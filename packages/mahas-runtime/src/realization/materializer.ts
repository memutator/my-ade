// materializer — turn a ContextBundle into real on-disk artifacts.
//
// IMP-09 · realization/launch boundary. Implements spec/injection.md §3–4:
// compiled components are staged into a per-execution staging directory and
// atomically published only after every byte's digest matches the bundle
// manifest. Delivery is REAL — files exist on disk, task/initial.txt carries
// the actual first-input text (REQ-07); nothing here declares delivery by
// registering a path in env/config.
//
// Checkout-scoped components (profile-required project auto-discovery paths,
// e.g. .agents/skills/<c>/SKILL.md) are written only into a canonical
// checkout whose exclusive write claim is held by this execution — resolved
// via the workspace domain through op-dispatch (`workspace.inspect`), never
// a sibling import (C-RESOURCE; IMP-16 provides the op).
//
// Pins preserved: interfaceDigest / implementationId+revision / bundleDigest
// / surfaceDigest / requiredTextDigest ride the immutable execution manifest
// and the materialized InjectionReceipt; a retention_pins row keeps the
// bundle alive while the execution holds it. Agent credentials never enter
// the text manifest — connection/* entries are recorded as
// {path, private:true} only, no bytes, no digest of secret material.

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import type { BundleDigest, Id } from '../../../mahas-contracts/src/index.ts'
// Canonical IMP-02 domain names — imported per packages/SHARED-APIS.md.
// They land with mahas-contracts resource.ts/work.ts; type-only imports.
import type { Checkout, ResourceClaim } from '../../../mahas-contracts/src/resource.ts'
import type { ResidualResource } from '../../../mahas-contracts/src/work.ts'

import {
  appendDomainEvent,
  getContentBlob,
  getEffectIntent,
  sha256Hex,
  stageEffectIntent,
  updateEffectState,
  withTx
} from '../storage/db.ts'
import { isMahasError } from '../api/handler-ports.ts'

import {
  canonicalJson,
  canonicalRelPath,
  fail,
  parseBundleManifest,
  planExecutionFiles,
  type BundleManifest,
  type ComponentKind,
  type ComponentScope,
  type PlannedFile
} from './component-store.ts'

// ---------------------------------------------------------------------------
// public contract

/** makeCaller(registry, ctx) result — services invoke cross-domain work via
 *  op-dispatch, never sibling imports. */
export type OperationCaller = (
  operation: string,
  payload?: unknown,
  expectedRevisions?: Record<string, number>
) => Promise<unknown>

export interface MaterializeDeps {
  db: DatabaseSync
  /** op-dispatch caller used for workspace.inspect (required only when a
   *  manifest component is checkout-scoped) */
  caller?: OperationCaller
  /** root under which per-execution directories are published */
  executionRootsDir: string
  now?: () => number
  /** sha256Hex-compatible digest — injectable for tests; defaults to the
   *  kernel helper from IMP-03's storage/db.ts */
  digest?: (data: string | Uint8Array) => string
}

export interface MaterializeInput {
  executionId: Id
  memberId?: Id
  launchPlanId?: Id
  bundleDigest: BundleDigest
  /** member's logical workspace — required iff any component is
   *  checkout-scoped; resolved to the canonical checkout via
   *  workspace.inspect */
  workspaceId?: Id
  /** expected holder of the checkout write claim; defaults to this
   *  execution ({kind:'execution', id:executionId}) */
  claimOwner?: { kind: string; id: string }
  /** pinned WorkEnvelope payload — produces task/initial.txt (the actual
   *  first-input text) and task/envelope.json */
  envelope?: {
    digest: string
    initialText: string
    envelopeJson: unknown
  }
  /** private worker connection files → connection/ (mode 0600, flagged
   *  private, digests kept out of the model-facing manifest) */
  connection?: { files: { name: string; bytes: Uint8Array }[] }
  /** scoped CLI launcher → bin/mahas */
  cli?: { executablePath: string; endpoint: string; extraEnv?: Record<string, string> }
  /** stable effect/operation key supplied by the launch coordinator */
  operationKey?: string
}

/** componentId → actualPath/argvIndex/configKey → byteDigest → loadingPhase
 *  (spec/injection.md §4 receipt route evidence) */
export interface ComponentRouteEvidence {
  componentId: string
  kind?: ComponentKind
  actualPath?: string
  argvIndex?: number
  configKey?: string
  byteDigest: string
  loadingPhase: string
}

export interface MaterializedFileRecord {
  path: string
  scope: ComponentScope
  /** absent on private (credential) files */
  digest?: string
  mode: number
  componentId?: string
  private?: boolean
}

export interface MaterializationPins {
  interfaceDigest: string
  implementationId: string
  implementationRevision: number
  bundleDigest: BundleDigest
  surfaceDigest: string
  requiredTextDigest: string
}

export interface MaterializeResult {
  outcome: 'published' | 'replayed'
  executionId: Id
  bundleDigest: BundleDigest
  executionRoot: string
  manifestPath: string
  /** sha256 of the immutable execution manifest.json bytes */
  manifestDigest: string
  files: MaterializedFileRecord[]
  routes: ComponentRouteEvidence[]
  /** the real first-input text the launcher attaches (never a path-only
   *  claim) — present iff input.envelope was supplied */
  firstInput?: { text: string; digest: string }
  effectId: string
  pins: MaterializationPins
  residualResources: ResidualResource[]
}

interface ExecutionManifest {
  schema: 'mahas.execution-manifest/v1'
  executionId: string
  bundleDigest: string
  pins: MaterializationPins
  files: MaterializedFileRecord[]
}

const RECEIPT_PHASE_MATERIALIZED = 'materialized'
const EFFECT_KIND = 'context.materialize'
const EXEC_MANIFEST = 'manifest.json'

// ---------------------------------------------------------------------------
// materializeBundle — IMP-19's launch coordinator calls this at the
// components_materialized stage. Idempotent: re-materializing the same
// execution+bundle returns the published result; a different bundle for the
// same execution is INVALID_TRANSITION (the pin cannot move).

export async function materializeBundle(
  deps: MaterializeDeps,
  input: MaterializeInput
): Promise<MaterializeResult> {
  const digest = deps.digest ?? sha256Hex
  const operationKey =
    input.operationKey ?? `${EFFECT_KIND}:${input.executionId}:${input.bundleDigest}`
  const fingerprint = digest(`${EFFECT_KIND}|${input.executionId}|${input.bundleDigest}`)
  const effectId = `fx-${fingerprint.slice(0, 24)}`
  const executionRoot = join(deps.executionRootsDir, String(input.executionId))
  const stagingRoot = join(
    deps.executionRootsDir,
    '.staging',
    `${input.executionId}-${fingerprint.slice(0, 12)}`
  )
  const manifestPath = join(executionRoot, EXEC_MANIFEST)

  // ---- load the pinned bundle + surface ----------------------------------
  const bundle = getContextBundle(deps.db, input.bundleDigest)
  if (bundle === null) {
    fail('MODEL_INVALID', 'context bundle not found', 'none', {
      bundleDigest: input.bundleDigest
    })
  }
  const manifestRaw = bundle.manifestJson
  const manifest = parseBundleManifest(manifestRaw)
  const pins: MaterializationPins = {
    interfaceDigest: bundle.interfaceDigest,
    implementationId: bundle.implementationId,
    implementationRevision: bundle.implementationRevision,
    bundleDigest: input.bundleDigest,
    surfaceDigest: bundle.surfaceDigest,
    requiredTextDigest: bundle.requiredTextDigest
  }

  // ---- replay short-circuit: a published root for the same bundle --------
  const prior = readExecutionManifest(manifestPath)
  if (prior !== null) {
    if (
      prior.bundleDigest !== String(input.bundleDigest) ||
      prior.executionId !== String(input.executionId)
    ) {
      fail('INVALID_TRANSITION', 'execution root is pinned to a different bundle', 'replan', {
        executionId: input.executionId,
        pinned: prior.bundleDigest,
        requested: input.bundleDigest
      })
    }
    const verify = verifyPublishedFiles(prior, executionRoot, digest)
    if (!verify.ok) {
      fail('ARTIFACT_MISMATCH', 'published execution root drifted from its manifest', 'reconcile', {
        missing: verify.missing,
        drifted: verify.drifted
      })
    }
    // a crash may have followed publish before the durable records landed —
    // commit them only when absent; never double-record a receipt
    if (materializedReceiptRevision(deps.db, input.executionId) === null) {
      // best-effort checkout re-resolution so receipt paths stay honest;
      // a missing claim at recovery time must not fail the replay
      let recoveredCheckout: string | null = null
      const hasCheckoutFiles = prior.files.some((f) => f.scope === 'checkout')
      if (hasCheckoutFiles && input.workspaceId !== undefined && deps.caller !== undefined) {
        try {
          recoveredCheckout = await resolveExclusiveCheckout(deps.caller, input)
        } catch {
          recoveredCheckout = null
        }
      }
      commitMaterializeRecords(deps, {
        effectId,
        operationKey,
        fingerprint,
        input,
        pins,
        manifest,
        files: prior.files,
        manifestDigest: digest(readFileSyncSafe(manifestPath) ?? ''),
        executionRoot,
        checkoutPath: recoveredCheckout,
        stagingResiduals: [],
        state: 'confirmed'
      })
    }
    return replayResult(prior, input, pins, executionRoot, manifestPath, effectId, digest)
  }

  // ---- plan ---------------------------------------------------------------
  const surface = getCommandSurfacePayload(deps.db, bundle.surfaceDigest)
  const blob = (d: string): { bytes: Uint8Array; mediaType: string } | null =>
    getContentBlob(deps.db, d)
  const files = planExecutionFiles({
    bundleDigest: input.bundleDigest,
    manifest,
    manifestRaw,
    blob,
    digest,
    envelope: input.envelope,
    surface: surface === null ? undefined : { actionsJson: surface },
    connection: input.connection,
    cli: input.cli
  })

  const checkoutFiles = files.filter((f) => f.scope === 'checkout')
  const execFiles = files.filter((f) => f.scope !== 'checkout')

  // ---- checkout claim (C-RESOURCE via op-dispatch) -------------------------
  let checkoutPath: string | null = null
  const residuals: ResidualResource[] = []
  if (checkoutFiles.length > 0) {
    if (input.workspaceId === undefined) {
      fail('INPUT_NOT_READY', 'checkout-scoped components require a workspaceId', 'replan', {
        components: checkoutFiles.map((f) => f.relativePath)
      })
    }
    if (deps.caller === undefined) {
      fail('CONTROL_UNAVAILABLE', 'workspace.inspect caller is not wired', 'reconcile')
    }
    checkoutPath = await resolveExclusiveCheckout(deps.caller, input)
  }

  // ---- effect intent: attempting (recorded before the side effect) -------
  recordEffectTx(deps, {
    effectId,
    operationKey,
    fingerprint,
    state: 'attempting',
    input,
    pins,
    receipt: { stage: 'attempting', executionRoot },
    residuals: []
  })

  let published = false
  try {
    // ---- stage → verify → atomic publish ----------------------------------
    await stageFiles(stagingRoot, execFiles, digest)
    const stagedManifest = buildExecutionManifest(input, pins, files)
    const manifestBytes = canonicalJson(stagedManifest)
    await writeFileAtomic(join(stagingRoot, EXEC_MANIFEST), manifestBytes, 0o644)
    await verifyStaged(stagingRoot, execFiles, digest)
    const manifestDigest = digest(manifestBytes)
    await mkdir(deps.executionRootsDir, { recursive: true })
    await rename(stagingRoot, executionRoot) // atomic publish — same fs
    published = true

    // ---- checkout-scoped files (per-file temp→rename, collision-safe) ----
    if (checkoutPath !== null) {
      await installCheckoutFiles(checkoutPath, checkoutFiles, fingerprint, residuals)
    }

    // ---- durable records ---------------------------------------------------
    commitMaterializeRecords(deps, {
      effectId,
      operationKey,
      fingerprint,
      input,
      pins,
      manifest,
      files: stagedManifest.files,
      manifestDigest,
      executionRoot,
      checkoutPath,
      stagingResiduals: residuals,
      state: 'confirmed'
    })

    return {
      outcome: 'published',
      executionId: input.executionId,
      bundleDigest: input.bundleDigest,
      executionRoot,
      manifestPath,
      manifestDigest,
      files: stagedManifest.files,
      routes: buildRoutes(manifest, files, executionRoot, checkoutPath),
      firstInput: input.envelope
        ? { text: input.envelope.initialText, digest: digest(input.envelope.initialText) }
        : undefined,
      effectId,
      pins,
      residualResources: residuals
    }
  } catch (e) {
    // materialize failure: the staging dir (pre-publish) or the published
    // root (post-publish partial failure) is LEFT in place and exported as
    // a residual resource via the effect receipt — never silently deleted.
    residuals.push({
      resourceRef: published ? executionRoot : stagingRoot,
      reason: published
        ? `materialize failed after publish (checkout install/commit): ${errMessage(e)}`
        : `materialize failed before publish: ${errMessage(e)}`,
      liveEvidence: published
        ? 'published execution root retained for operator inspection'
        : 'staging directory retained for operator inspection',
      cleanupPolicy: 'operator-release'
    } as unknown as ResidualResource)
    recordEffectTx(deps, {
      effectId,
      operationKey,
      fingerprint,
      // a MahasError verdict is a terminal business rejection; anything
      // else (incl. OS errors) stays 'unknown' — a reconcile target
      state: !(e instanceof Error) && isMahasError(e) ? 'rejected' : 'unknown',
      input,
      pins,
      receipt: {
        stage: 'failed',
        error:
          !(e instanceof Error) && isMahasError(e)
            ? { code: e.code, message: e.message }
            : { code: 'unknown', message: errMessage(e) }
      },
      residuals
    })
    throw e
  }
}

// ---------------------------------------------------------------------------
// shared receipt writer — IMP-19/IMP-20 reuse this for the later phases
// ('initial_attached', 'worker_joined') so injection_receipts keeps one shape.

export interface InjectionReceiptRecord {
  executionId: Id
  /** 'materialized' | 'initial_attached' | 'worker_joined' | … */
  phase: string
  /** explicit revision; default = next revision for (execution,phase) */
  revision?: number
  components: unknown[]
  inherited: unknown[]
  evidence: unknown
}

export function recordInjectionReceipt(
  db: DatabaseSync,
  receipt: InjectionReceiptRecord
): { revision: number } {
  const revision = receipt.revision ?? nextReceiptRevision(db, receipt.executionId, receipt.phase)
  db.prepare(
    `INSERT INTO injection_receipts (execution_id, phase, revision, components_json, inherited_json, evidence_json)
     VALUES (?,?,?,?,?,?)`
  ).run(
    String(receipt.executionId),
    receipt.phase,
    revision,
    JSON.stringify(receipt.components),
    JSON.stringify(receipt.inherited),
    JSON.stringify(receipt.evidence)
  )
  return { revision }
}

/** latest recorded revision for (executionId, phase), or null */
export function materializedReceiptRevision(db: DatabaseSync, executionId: Id): number | null {
  const row = db
    .prepare(
      `SELECT MAX(revision) AS r FROM injection_receipts WHERE execution_id=? AND phase='materialized'`
    )
    .get(String(executionId)) as { r: number | null } | undefined
  return row?.r ?? null
}

function nextReceiptRevision(db: DatabaseSync, executionId: Id, phase: string): number {
  const row = db
    .prepare(`SELECT MAX(revision) AS r FROM injection_receipts WHERE execution_id=? AND phase=?`)
    .get(String(executionId), phase) as { r: number | null } | undefined
  return (row?.r ?? 0) + 1
}

// ---------------------------------------------------------------------------
// internals

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : isMahasError(e) ? e.message : String(e)
}

function readFileSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** raw context_bundles row (DDL column names → camelCase) */
interface BundleRow {
  manifestJson: string
  interfaceDigest: string
  implementationId: string
  implementationRevision: number
  surfaceDigest: string
  requiredTextDigest: string
  sourceObservationsJson: string
}

function getContextBundle(db: DatabaseSync, digest: string): BundleRow | null {
  const row = db
    .prepare(
      `SELECT manifest_json, interface_digest, implementation_id, implementation_revision,
              surface_digest, required_text_digest, source_observations_json
       FROM context_bundles WHERE digest=?`
    )
    .get(digest) as Record<string, unknown> | undefined
  if (row === undefined) return null
  return {
    manifestJson: String(row['manifest_json']),
    interfaceDigest: String(row['interface_digest']),
    implementationId: String(row['implementation_id']),
    implementationRevision: Number(row['implementation_revision']),
    surfaceDigest: String(row['surface_digest']),
    requiredTextDigest: String(row['required_text_digest']),
    sourceObservationsJson: String(row['source_observations_json'])
  }
}

function getCommandSurfacePayload(db: DatabaseSync, surfaceDigest: string): unknown | null {
  const row = db
    .prepare(`SELECT actions_and_schemas_json FROM command_surfaces WHERE digest=?`)
    .get(surfaceDigest) as { actions_and_schemas_json?: string } | undefined
  if (row?.actions_and_schemas_json === undefined) return null
  try {
    return JSON.parse(row.actions_and_schemas_json)
  } catch {
    return null
  }
}

// Resolve the member's workspace → canonical checkout and require the
// exclusive write claim this execution owns (C-RESOURCE, REQ-16). Uses
// op-dispatch — never a sibling service import.
async function resolveExclusiveCheckout(
  caller: OperationCaller,
  input: MaterializeInput
): Promise<string> {
  const result = (await caller('workspace.inspect', {
    workspaceId: input.workspaceId
  })) as unknown
  if (!isRecord(result)) {
    fail('CONTROL_UNAVAILABLE', 'workspace.inspect returned no usable result', 'reconcile', {
      workspaceId: input.workspaceId
    })
  }
  const checkout = result['checkout'] as Checkout | undefined
  const claims = (result['claims'] ?? []) as ResourceClaim[]
  if (!isRecord(checkout) || typeof checkout['canonicalPath'] !== 'string') {
    fail('MODEL_INVALID', 'workspace.inspect result lacks a canonical checkout', 'reconcile', {
      workspaceId: input.workspaceId
    })
  }
  const owner = input.claimOwner ?? { kind: 'execution', id: String(input.executionId) }
  const canonical = realpathSync(checkout.canonicalPath)

  const writers = claims.filter(
    (c) =>
      c.mode === 'write' &&
      (c.state === 'held' || c.state === 'transferring' || c.state === 'unknown')
  )
  const ours = writers.find((c) => c.ownerKind === owner.kind && c.ownerId === owner.id)
  if (ours === undefined) {
    fail('SCOPE_DENIED', 'no held write claim on the checkout for this execution', 'replan', {
      checkoutId: checkout.id,
      owner
    })
  }
  if (ours.state !== 'held') {
    fail('RESOURCE_BUSY', 'checkout write claim is not held', 'reconcile', {
      claimId: ours.id,
      state: ours.state
    })
  }
  const others = writers.filter((c) => c.id !== ours.id)
  if (others.length > 0) {
    fail(
      'RESOURCE_BUSY',
      'checkout has another live or unknown writer — no exclusive claim',
      'reconcile',
      {
        conflictingClaims: others.map((c) => ({
          id: c.id,
          ownerKind: c.ownerKind,
          ownerId: c.ownerId,
          state: c.state
        }))
      }
    )
  }
  return canonical
}

// ---- staging ---------------------------------------------------------------

async function stageFiles(
  root: string,
  files: PlannedFile[],
  digest: (d: string | Uint8Array) => string
): Promise<void> {
  for (const f of files) {
    const dest = join(root, f.relativePath)
    try {
      // 'wx': a staged path may never overwrite — collisions were rejected
      // at plan time, so a surviving staged file means a prior attempt's
      // residual (same effect key resumes it) or foreign interference
      await writeFileAtomic(dest, f.bytes, f.mode, 'wx')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const existing = new Uint8Array(await readFile(dest))
      if (digest(existing) !== f.digest) {
        fail('ARTIFACT_MISMATCH', 'stale staged file conflicts with the plan', 'reconcile', {
          path: f.relativePath
        })
      }
      await chmod(dest, f.mode) // same bytes — resume as if staged
    }
    if (f.private === true) {
      await chmod(dirname(dest), 0o700)
    }
  }
}

async function writeFileAtomic(
  dest: string,
  bytes: Uint8Array | string,
  mode: number,
  flag: 'w' | 'wx' = 'w'
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, bytes, { mode, flag })
  await chmod(dest, mode)
}

async function verifyStaged(
  root: string,
  files: PlannedFile[],
  digest: (d: string | Uint8Array) => string
): Promise<void> {
  for (const f of files) {
    const dest = join(root, f.relativePath)
    let actual: Uint8Array
    try {
      actual = new Uint8Array(await readFile(dest))
    } catch {
      fail('ARTIFACT_MISMATCH', 'staged file missing before publish', 'reconcile', {
        path: f.relativePath
      })
    }
    const d = digest(actual)
    if (d !== f.digest) {
      fail('ARTIFACT_MISMATCH', 'staged file digest drifted before publish', 'reconcile', {
        path: f.relativePath,
        declared: f.digest,
        actual: d
      })
    }
  }
}

// ---- checkout-scoped install ------------------------------------------------
// Per file: canonicalize → reject symlink ancestors → temp sibling → wx →
// atomic rename. An existing target is a hard collision — never overwrite
// another writer's file in a shared checkout.

async function installCheckoutFiles(
  checkoutPath: string,
  files: PlannedFile[],
  fingerprint: string,
  residuals: ResidualResource[]
): Promise<void> {
  for (const f of files) {
    const rel = canonicalRelPath(f.relativePath)
    const dest = join(checkoutPath, rel)
    assertNoSymlinkAncestors(checkoutPath, rel)
    let exists = false
    try {
      await stat(dest)
      exists = true
    } catch {
      exists = false
    }
    if (exists) {
      fail(
        'OPERATION_CONFLICT',
        'checkout target already exists — refusing to overwrite',
        'replan',
        {
          path: rel
        }
      )
    }
    const tmp = `${dest}.mahas-tmp-${fingerprint.slice(0, 8)}`
    try {
      await writeFileAtomic(tmp, f.bytes, f.mode, 'wx')
      await rename(tmp, dest)
    } catch (e) {
      residuals.push({
        resourceRef: tmp,
        reason: `checkout install interrupted: ${errMessage(e)}`,
        liveEvidence: 'temp sibling retained',
        cleanupPolicy: 'operator-release'
      } as unknown as ResidualResource)
      throw e
    }
  }
}

function assertNoSymlinkAncestors(checkoutPath: string, rel: string): void {
  const parts = rel.split('/')
  let cur = checkoutPath
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part)
    try {
      if (lstatSync(cur).isSymbolicLink()) {
        fail('MODEL_INVALID', 'checkout path traverses a symlink — refusing install', 'none', {
          path: rel,
          ancestor: cur
        })
      }
    } catch (e) {
      // MahasError is a plain object; Node system errors are Error
      // instances (ENOENT/EACCES on a missing ancestor → created later)
      if (!(e instanceof Error)) throw e
    }
  }
}

// ---- execution manifest -----------------------------------------------------

function buildExecutionManifest(
  input: MaterializeInput,
  pins: MaterializationPins,
  files: PlannedFile[]
): ExecutionManifest {
  return {
    schema: 'mahas.execution-manifest/v1',
    executionId: String(input.executionId),
    bundleDigest: String(input.bundleDigest),
    pins,
    files: files.map((f) => ({
      path: f.relativePath,
      scope: f.scope,
      digest: f.private === true ? undefined : f.digest,
      mode: f.mode,
      componentId: f.componentId,
      private: f.private
    }))
  }
}

function readExecutionManifest(manifestPath: string): ExecutionManifest | null {
  try {
    const raw = readFileSyncSafe(manifestPath)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed['schema'] !== 'mahas.execution-manifest/v1') return null
    return parsed as unknown as ExecutionManifest
  } catch {
    return null
  }
}

function verifyPublishedFiles(
  manifest: ExecutionManifest,
  executionRoot: string,
  digest: (d: string | Uint8Array) => string
): { ok: boolean; missing: string[]; drifted: string[] } {
  const missing: string[] = []
  const drifted: string[] = []
  for (const f of manifest.files) {
    if (f.scope !== 'execution') continue // checkout files live outside this root
    const p = join(executionRoot, f.path)
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(readFileSync(p))
    } catch {
      missing.push(f.path)
      continue
    }
    if (f.private !== true && typeof f.digest === 'string' && digest(bytes) !== f.digest) {
      drifted.push(f.path)
    }
  }
  return { ok: missing.length === 0 && drifted.length === 0, missing, drifted }
}

// ---- routes + receipts ------------------------------------------------------

function buildRoutes(
  manifest: BundleManifest,
  files: PlannedFile[],
  executionRoot: string,
  checkoutPath: string | null
): ComponentRouteEvidence[] {
  const routes: ComponentRouteEvidence[] = []
  const byComponent = new Map(
    files.filter((f) => f.componentId !== undefined).map((f) => [f.componentId as string, f])
  )
  for (const c of manifest.components) {
    const f = byComponent.get(c.componentId)
    if (f === undefined) continue
    routes.push({
      componentId: c.componentId,
      kind: c.kind,
      actualPath:
        f.scope === 'checkout' && checkoutPath !== null
          ? join(checkoutPath, f.relativePath)
          : join(executionRoot, f.relativePath),
      argvIndex: c.route?.argvIndex,
      configKey: c.route?.configKey,
      byteDigest: f.digest,
      loadingPhase: c.loadPhase ?? 'materialized'
    })
  }
  return routes
}

interface CommitArgs {
  effectId: string
  operationKey: string
  fingerprint: string
  input: MaterializeInput
  pins: MaterializationPins
  manifest: BundleManifest
  files: MaterializedFileRecord[]
  manifestDigest: string
  executionRoot: string
  checkoutPath: string | null
  stagingResiduals: ResidualResource[]
  state: 'confirmed' | 'rejected' | 'unknown'
}

function commitMaterializeRecords(deps: MaterializeDeps, a: CommitArgs): { revision: number } {
  return withTx(deps.db, (db) => {
    writeEffectRecord(db, {
      effectId: a.effectId,
      operationKey: a.operationKey,
      fingerprint: a.fingerprint,
      state: a.state,
      input: a.input,
      pins: a.pins,
      receipt: {
        stage: a.state,
        executionRoot: a.executionRoot,
        manifestDigest: a.manifestDigest,
        fileCount: a.files.length
      },
      residuals: a.stagingResiduals
    })
    const { revision } = recordInjectionReceipt(db, {
      executionId: a.input.executionId,
      phase: RECEIPT_PHASE_MATERIALIZED,
      components: a.files
        .filter((f) => f.componentId !== undefined)
        .map((f) => ({
          componentId: f.componentId,
          actualPath:
            f.scope === 'checkout' && a.checkoutPath !== null
              ? join(a.checkoutPath, f.path)
              : join(a.executionRoot, f.path),
          byteDigest: f.digest,
          loadingPhase: 'materialized'
        })),
      inherited: [],
      evidence: {
        bundleDigest: a.input.bundleDigest,
        pins: a.pins,
        executionRoot: a.executionRoot,
        manifestDigest: a.manifestDigest,
        effectId: a.effectId,
        workspaceId: a.input.workspaceId,
        checkoutPath: a.checkoutPath,
        evidenceLevel: 'verified'
      }
    })
    // preserve the bundle pin for GC while this execution is live
    db.prepare(
      `INSERT OR IGNORE INTO retention_pins (id, target_kind, target_id, holder_kind, holder_id, reason)
       VALUES (?,?,?,?,?,?)`
    ).run(
      `pin-${a.effectId}`,
      'context_bundle',
      String(a.input.bundleDigest),
      'execution',
      String(a.input.executionId),
      'active-execution-context'
    )
    appendDomainEvent(
      db,
      String(a.input.executionId),
      revision,
      'execution.context.materialized',
      {
        executionId: a.input.executionId,
        memberId: a.input.memberId,
        launchPlanId: a.input.launchPlanId
      },
      { bundleDigest: a.input.bundleDigest, manifestDigest: a.manifestDigest, effectId: a.effectId }
    )
    return { revision }
  })
}

interface EffectRecordArgs {
  effectId: string
  operationKey: string
  fingerprint: string
  state: 'prepared' | 'attempting' | 'confirmed' | 'rejected' | 'unknown'
  input: MaterializeInput
  pins: MaterializationPins
  receipt: unknown
  residuals: ResidualResource[]
}

function writeEffectRecord(db: DatabaseSync, a: EffectRecordArgs): void {
  if (getEffectIntent(db, a.effectId) !== null) {
    updateEffectState(db, a.effectId, {
      state: a.state,
      receipt: a.receipt,
      residuals: a.residuals
    })
    return
  }
  stageEffectIntent(db, {
    id: a.effectId,
    operationKey: a.operationKey,
    kind: EFFECT_KIND,
    fingerprint: a.fingerprint,
    state: a.state,
    payload: {
      executionId: a.input.executionId,
      memberId: a.input.memberId,
      launchPlanId: a.input.launchPlanId,
      workspaceId: a.input.workspaceId,
      bundleDigest: a.input.bundleDigest,
      pins: a.pins
    },
    receipt: a.receipt,
    residuals: a.residuals
  })
}

function recordEffectTx(deps: MaterializeDeps, a: EffectRecordArgs): void {
  withTx(deps.db, (db) => writeEffectRecord(db, a))
}

function replayResult(
  prior: ExecutionManifest,
  input: MaterializeInput,
  pins: MaterializationPins,
  executionRoot: string,
  manifestPath: string,
  effectId: string,
  digest: (d: string | Uint8Array) => string
): MaterializeResult {
  const manifestBytes = readFileSyncSafe(manifestPath) ?? ''
  return {
    outcome: 'replayed',
    executionId: input.executionId,
    bundleDigest: input.bundleDigest,
    executionRoot,
    manifestPath,
    manifestDigest: digest(manifestBytes),
    files: prior.files,
    routes: prior.files
      .filter((f) => f.componentId !== undefined)
      .map((f) => ({
        componentId: f.componentId as string,
        actualPath: f.scope === 'checkout' ? f.path : join(executionRoot, f.path),
        byteDigest: typeof f.digest === 'string' ? f.digest : '',
        loadingPhase: 'materialized'
      })),
    firstInput: input.envelope
      ? { text: input.envelope.initialText, digest: digest(input.envelope.initialText) }
      : undefined,
    effectId,
    pins,
    residualResources: []
  }
}
