// effective-context — the `context.inspect` query and op registration.
//
// IMP-09 · realization/launch boundary (C-REALIZATION context.inspect).
// Answers, for one execution (or one pinned bundle): which components were
// PLANNED, which were actually ATTACHED per recorded loading evidence, which
// organization/user/project instructions were INHERITED, and what remains
// UNKNOWN. Planned descriptor ≠ actual loading evidence — a manifest entry
// is never reported as delivered without an injection receipt.
//
// Honesty rule (spec): the provider's hidden native system prompt is not
// observable, so it is always reported in `unknowns` — this query never
// claims knowledge of the full effective context.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import type { AuthenticatedContext, BundleDigest, Id } from '../../../mahas-contracts/src/index.ts'
// IMP-11's registry API lands in parallel — type-only import per
// packages/SHARED-APIS.md (OperationRegistry/OperationSpec/OperationHandler).
import type { OperationRegistry } from '../api/registry.ts'

import { sha256Hex } from '../storage/db.ts'

import { fail, parseBundleManifest } from './component-store.ts'
import type { OperationCaller } from './materializer.ts'

// ---------------------------------------------------------------------------
// contract — spec/contracts/realization.md context.inspect
//   input:  bundleDigest OR executionId, detail: own|composition|maintenance
//   output: planned components / attached receipt / inherited known inputs /
//           unknowns

export type InspectDetail = 'own' | 'composition' | 'maintenance'

export interface InspectContextInput {
  executionId?: Id
  bundleDigest?: BundleDigest
  detail?: InspectDetail
}

export interface PlannedComponentView {
  componentId: string
  kind: string
  path: string
  scope: string
  digest: string
  activation?: string
  loadPhase?: string
}

export interface AttachedPhaseView {
  phase: string
  revision: number
  components: unknown[]
  inherited: unknown[]
  evidence: unknown
}

export interface InheritedInputView {
  /** 'project' | 'user' | 'organization' | 'provider' */
  scope: string
  path?: string
  /** known = bytes observed; absent = probed, not present; unknown = not
   *  observable/enumerable by this runtime */
  status: 'known' | 'absent' | 'unknown'
  digest?: string
  note?: string
}

export interface UnknownInputView {
  what: string
  reason: string
}

export interface EffectiveContextReport {
  executionId?: Id
  memberId?: Id
  launchPlanId?: Id
  bundleDigest: BundleDigest
  pins: {
    interfaceDigest: string
    implementationId: string
    implementationRevision: number
    surfaceDigest: string
    requiredTextDigest: string
    harnessProfileId?: string
  }
  /** what the bundle manifest declares — intent, not delivery evidence */
  planned: PlannedComponentView[]
  /** recorded loading evidence, one entry per injection_receipts row */
  attached: AttachedPhaseView[]
  /** inherited instructions observed outside the bundle */
  inherited: InheritedInputView[]
  /** planned componentIds with no materialized-phase evidence yet */
  missing: string[]
  /** things this runtime cannot see — including the provider's hidden
   *  system prompt; presence here means we do NOT claim full context */
  unknowns: UnknownInputView[]
  /** maintenance detail only: bundle source-observation pins */
  sourceObservations?: unknown
  /** execution manifest digest recorded at publish, if materialized */
  manifestDigest?: string
}

export interface InspectDeps {
  db: DatabaseSync
  caller?: OperationCaller
  /** root under which per-execution directories are published — used to
   *  check that the materialized root still exists */
  executionRootsDir?: string
  /** injectable fs probe for tests (defaults to real fs) */
  probe?: (path: string) => 'file' | 'dir' | 'missing'
  readBytes?: (path: string) => Uint8Array | null
  digest?: (data: string | Uint8Array) => string
  ctx?: AuthenticatedContext
}

// ---------------------------------------------------------------------------
// main query

export async function inspectEffectiveContext(
  deps: InspectDeps,
  input: InspectContextInput
): Promise<EffectiveContextReport> {
  const detail: InspectDetail = input.detail ?? 'own'
  if (input.executionId === undefined && input.bundleDigest === undefined) {
    fail('MODEL_INVALID', 'context.inspect requires executionId or bundleDigest')
  }

  // ---- resolve execution → launch plan → bundle pin -----------------------
  let execution: ExecutionRow | null = null
  let launchPlan: LaunchPlanRow | null = null
  if (input.executionId !== undefined) {
    execution = getExecution(deps.db, input.executionId)
    if (execution === null) {
      fail('MODEL_INVALID', 'execution not found', 'none', { executionId: input.executionId })
    }
    launchPlan = getLaunchPlan(deps.db, execution.launchPlanId)
  }
  const bundleDigest = input.bundleDigest ?? (launchPlan?.bundleDigest as BundleDigest | undefined)
  if (bundleDigest === undefined) {
    fail('MODEL_INVALID', 'cannot resolve a bundleDigest for this execution', 'reconcile', {
      executionId: input.executionId
    })
  }
  if (
    launchPlan !== null &&
    input.bundleDigest !== undefined &&
    launchPlan.bundleDigest !== String(input.bundleDigest)
  ) {
    fail('MODEL_INVALID', 'execution is not pinned to the requested bundle', 'none', {
      executionId: input.executionId,
      pinned: launchPlan.bundleDigest,
      requested: input.bundleDigest
    })
  }

  // ---- self-scope: detail 'own' may only read the caller's own execution --
  if (detail === 'own' && deps.ctx !== undefined && execution !== null) {
    const ctx = deps.ctx
    const isSelf =
      (ctx.executionId !== undefined && String(ctx.executionId) === execution.id) ||
      (ctx.memberId !== undefined && String(ctx.memberId) === execution.memberId)
    if (!isSelf) {
      fail('SCOPE_DENIED', 'detail=own is limited to the owning member/execution')
    }
  }

  // ---- load bundle + manifest (planned components) -------------------------
  const bundle = getBundle(deps.db, String(bundleDigest))
  if (bundle === null) {
    fail('MODEL_INVALID', 'context bundle not found', 'none', { bundleDigest })
  }
  const manifest = parseBundleManifest(bundle.manifestJson)
  const planned: PlannedComponentView[] = manifest.components.map((c) => ({
    componentId: c.componentId,
    kind: c.kind,
    path: c.path,
    scope: c.scope ?? 'execution',
    digest: c.digest,
    activation: c.activation,
    loadPhase: c.loadPhase
  }))
  if (manifest.requiredText !== undefined) {
    planned.unshift({
      componentId: '(required-text)',
      kind: 'instruction',
      path: manifest.requiredText.path ?? 'role/mandatory.md',
      scope: 'execution',
      digest: manifest.requiredText.digest
    })
  }

  // ---- attached evidence: injection_receipts rows --------------------------
  const attached: AttachedPhaseView[] =
    execution === null
      ? []
      : (
          deps.db
            .prepare(
              `SELECT phase, revision, components_json, inherited_json, evidence_json
             FROM injection_receipts WHERE execution_id=? ORDER BY revision, phase`
            )
            .all(execution.id) as Record<string, unknown>[]
        ).map((r) => ({
          phase: String(r['phase']),
          revision: Number(r['revision']),
          components: JSON.parse(String(r['components_json'])),
          inherited: JSON.parse(String(r['inherited_json'])),
          evidence: JSON.parse(String(r['evidence_json']))
        }))

  const materialized = attached.findLast((a) => a.phase === 'materialized')
  const materializedIds = new Set(
    ((materialized?.components ?? []) as Record<string, unknown>[])
      .map((c) => c['componentId'])
      .filter((v): v is string => typeof v === 'string')
  )
  const missing = manifest.components
    .map((c) => c.componentId)
    .filter((id) => materialized === undefined || !materializedIds.has(id))
  if (manifest.requiredText !== undefined && materialized === undefined) {
    missing.unshift('(required-text)')
  }

  // ---- inherited inputs -----------------------------------------------------
  const unknowns: UnknownInputView[] = []
  const inherited = await probeInherited(deps, {
    execution,
    launchPlan,
    bundle,
    unknowns
  })

  // the provider's hidden system prompt is never observable — never claim it
  unknowns.push({
    what: 'provider-native system prompt',
    reason:
      'hidden prompt bytes are not observable by mahas; the effective context is not fully known'
  })

  // ---- execution manifest digest -------------------------------------------
  let manifestDigest: string | undefined
  if (execution !== null && deps.executionRootsDir !== undefined) {
    const mp = join(deps.executionRootsDir, execution.id, 'manifest.json')
    const bytes = readBytes(deps, mp)
    if (bytes !== null) {
      manifestDigest = (deps.digest ?? sha256Hex)(bytes)
    } else {
      unknowns.push({
        what: 'execution manifest',
        reason: 'execution root not present on this host — materialization may not have run here'
      })
    }
  }

  const report: EffectiveContextReport = {
    executionId: execution?.id as Id | undefined,
    memberId: execution?.memberId as Id | undefined,
    launchPlanId: execution?.launchPlanId as Id | undefined,
    bundleDigest,
    pins: {
      interfaceDigest: bundle.interfaceDigest,
      implementationId: bundle.implementationId,
      implementationRevision: bundle.implementationRevision,
      surfaceDigest: bundle.surfaceDigest,
      requiredTextDigest: bundle.requiredTextDigest,
      harnessProfileId: bundle.profileId
    },
    planned,
    attached,
    inherited,
    missing,
    unknowns
  }
  if (detail === 'maintenance') {
    try {
      report.sourceObservations = JSON.parse(bundle.sourceObservationsJson)
    } catch {
      report.sourceObservations = bundle.sourceObservationsJson
    }
  }
  if (manifestDigest !== undefined) report.manifestDigest = manifestDigest
  return report
}

// ---------------------------------------------------------------------------
// op registration — context.inspect is my owned operation

export interface MaterializeOpsDeps {
  caller?: OperationCaller
  executionRootsDir?: string
}

/**
 * Register the materializer boundary's operations. Currently exactly one:
 * `context.inspect` — query-only (mutation:false), member-visible (the
 * registry's dispatch still runs visibility → authorize → idempotency;
 * 'own' detail is additionally enforced against the caller's identity).
 * resolveTargets derives the actual targets from server state — the
 * authorization evidence, never the request's self-declaration.
 */
export function registerMaterializeOps(
  registry: OperationRegistry,
  deps: MaterializeOpsDeps
): void {
  registry.register(
    {
      name: 'context.inspect',
      visibility: 'member',
      mutation: false,
      summary:
        'planned components vs recorded loading evidence, inherited inputs and unknowns for an execution or bundle',
      inputSchema: {
        type: 'object',
        properties: {
          executionId: { type: 'string' },
          bundleDigest: { type: 'string' },
          detail: { type: 'string', enum: ['own', 'composition', 'maintenance'] }
        },
        additionalProperties: false
      },
      resolveTargets: (txn, payload) => {
        const p = (payload ?? {}) as Record<string, unknown>
        const targets: { kind: string; id: string }[] = []
        if (typeof p['executionId'] === 'string') {
          targets.push({ kind: 'execution', id: p['executionId'] })
          const exec = txn.db
            .prepare(`SELECT launch_plan_id FROM executions WHERE id=?`)
            .get(p['executionId']) as { launch_plan_id?: string } | undefined
          if (exec?.launch_plan_id !== undefined) {
            targets.push({ kind: 'launch_plan', id: exec.launch_plan_id })
          }
        }
        if (typeof p['bundleDigest'] === 'string') {
          targets.push({ kind: 'context_bundle', id: p['bundleDigest'] })
        }
        return targets
      }
    },
    async (txn, payload) => {
      const p = (payload ?? {}) as Record<string, unknown>
      return inspectEffectiveContext(
        {
          db: txn.db,
          ctx: txn.ctx,
          caller: deps.caller,
          executionRootsDir: deps.executionRootsDir
        },
        {
          executionId: p['executionId'] as Id | undefined,
          bundleDigest: p['bundleDigest'] as BundleDigest | undefined,
          detail: p['detail'] as InspectDetail | undefined
        }
      )
    }
  )
}

// ---------------------------------------------------------------------------
// internals — raw row shapes (DDL column names → camelCase fields)

interface BundleRow {
  manifestJson: string
  interfaceDigest: string
  implementationId: string
  implementationRevision: number
  surfaceDigest: string
  requiredTextDigest: string
  sourceObservationsJson: string
  profileId?: string
}

interface ExecutionRow {
  id: string
  memberId: string
  launchPlanId: string
}

interface LaunchPlanRow {
  id: string
  bundleDigest: string
  reservationsJson: string
}

function getBundle(db: DatabaseSync, digest: string): BundleRow | null {
  const row = db
    .prepare(
      `SELECT b.manifest_json, b.interface_digest, b.implementation_id, b.implementation_revision,
              b.surface_digest, b.required_text_digest, b.source_observations_json,
              i.profile_id AS profile_id
       FROM context_bundles b
       LEFT JOIN role_implementations i
         ON i.id = b.implementation_id AND i.revision = b.implementation_revision
       WHERE b.digest=?`
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
    sourceObservationsJson: String(row['source_observations_json']),
    profileId: row['profile_id'] === null ? undefined : String(row['profile_id'])
  }
}

function getExecution(db: DatabaseSync, executionId: Id): ExecutionRow | null {
  const row = db
    .prepare(`SELECT id, member_id, launch_plan_id FROM executions WHERE id=?`)
    .get(String(executionId)) as Record<string, unknown> | undefined
  if (row === undefined) return null
  return {
    id: String(row['id']),
    memberId: String(row['member_id']),
    launchPlanId: String(row['launch_plan_id'])
  }
}

function getLaunchPlan(db: DatabaseSync, id: string): LaunchPlanRow | null {
  const row = db
    .prepare(`SELECT id, bundle_digest, reservations_json FROM launch_plans WHERE id=?`)
    .get(id) as Record<string, unknown> | undefined
  if (row === undefined) return null
  return {
    id: String(row['id']),
    bundleDigest: String(row['bundle_digest']),
    reservationsJson: String(row['reservations_json'])
  }
}

// ---- inherited-input probing --------------------------------------------------
// Conventional auto-load locations outside the bundle. Which paths a harness
// actually reads is profile knowledge — the map below covers the documented
// routes (spec/injection.md §5–6); anything we cannot enumerate stays
// 'unknown', never silently dropped.

interface ProbeSpec {
  scope: 'project' | 'user' | 'organization'
  /** checkout-relative or absolute path */
  path: string
  note?: string
}

const PROFILE_PROBE_PATHS: Record<string, ProbeSpec[]> = {
  claude: [
    { scope: 'project', path: 'CLAUDE.md', note: 'project memory file' },
    { scope: 'project', path: '.claude/settings.json', note: 'project settings' },
    { scope: 'project', path: '.claude/CLAUDE.md' },
    { scope: 'user', path: '~/.claude/CLAUDE.md', note: 'user memory file' }
  ],
  codex: [
    { scope: 'project', path: 'AGENTS.md', note: 'project instructions' },
    { scope: 'project', path: '.agents/skills', note: 'project skill directory' },
    { scope: 'user', path: '~/.codex/AGENTS.md', note: 'user instructions' }
  ],
  generic: [
    { scope: 'project', path: 'AGENTS.md' },
    { scope: 'project', path: 'CLAUDE.md' }
  ]
}

function probesForProfile(profileId: string | undefined): ProbeSpec[] {
  const key = (profileId ?? 'generic').toLowerCase()
  const table = PROFILE_PROBE_PATHS[key] ?? PROFILE_PROBE_PATHS['generic']
  const seen = new Set<string>()
  return table.filter((p) => {
    const k = `${p.scope}:${p.path}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

async function probeInherited(
  deps: InspectDeps,
  args: {
    execution: ExecutionRow | null
    launchPlan: LaunchPlanRow | null
    bundle: BundleRow
    unknowns: UnknownInputView[]
  }
): Promise<InheritedInputView[]> {
  const out: InheritedInputView[] = []

  // resolve the checkout root: the materialize receipt records it; otherwise
  // try the launch plan's workspace reservation via workspace.inspect
  let checkoutPath: string | null = null
  if (args.execution !== null) {
    checkoutPath = checkoutFromReceipt(deps.db, args.execution.id)
  }
  if (checkoutPath === null && args.launchPlan !== null && deps.caller !== undefined) {
    const workspaceId = workspaceFromReservations(args.launchPlan.reservationsJson)
    if (workspaceId !== null) {
      try {
        const res = (await deps.caller('workspace.inspect', { workspaceId })) as Record<
          string,
          unknown
        >
        const checkout = res['checkout'] as Record<string, unknown> | undefined
        if (typeof checkout?.['canonicalPath'] === 'string') {
          checkoutPath = checkout['canonicalPath']
        }
      } catch {
        args.unknowns.push({
          what: 'workspace.checkout',
          reason: 'workspace.inspect failed — project-scope inherited inputs unverifiable'
        })
      }
    }
  }
  if (checkoutPath === null && args.execution !== null) {
    args.unknowns.push({
      what: 'project-scope inherited inputs',
      reason: 'no checkout path resolvable from receipt or workspace reservation'
    })
  }

  for (const spec of probesForProfile(args.bundle.profileId)) {
    const path = spec.path.startsWith('~/')
      ? join(homedir(), spec.path.slice(2))
      : checkoutPath !== null
        ? join(checkoutPath, spec.path)
        : null
    if (path === null) {
      out.push({
        scope: spec.scope,
        path: spec.path,
        status: 'unknown',
        note: 'no checkout resolved'
      })
      continue
    }
    const kind = probePath(deps, path)
    if (kind === 'missing') {
      out.push({ scope: spec.scope, path, status: 'absent', note: spec.note })
      continue
    }
    if (kind === 'dir') {
      out.push({
        scope: spec.scope,
        path,
        status: 'known',
        note: `${spec.note ?? 'directory'} (presence observed)`
      })
      continue
    }
    const bytes = readBytes(deps, path)
    if (bytes === null) {
      out.push({ scope: spec.scope, path, status: 'unknown', note: 'exists but unreadable' })
      continue
    }
    out.push({
      scope: spec.scope,
      path,
      status: 'known',
      digest: (deps.digest ?? sha256Hex)(bytes),
      note: spec.note
    })
  }
  // organization-managed instructions are not enumerable from here
  out.push({
    scope: 'organization',
    status: 'unknown',
    note: 'organization-managed instruction paths are not enumerable by this runtime'
  })
  return out
}

function probePath(deps: InspectDeps, path: string): 'file' | 'dir' | 'missing' {
  if (deps.probe !== undefined) return deps.probe(path)
  try {
    const st = statSync(path)
    return st.isDirectory() ? 'dir' : 'file'
  } catch {
    return 'missing'
  }
}

function readBytes(deps: InspectDeps, path: string): Uint8Array | null {
  if (deps.readBytes !== undefined) return deps.readBytes(path)
  try {
    if (!existsSync(path)) return null
    return new Uint8Array(readFileSync(path))
  } catch {
    return null
  }
}

function checkoutFromReceipt(db: DatabaseSync, executionId: string): string | null {
  const row = db
    .prepare(
      `SELECT evidence_json FROM injection_receipts
       WHERE execution_id=? AND phase='materialized' ORDER BY revision DESC LIMIT 1`
    )
    .get(executionId) as { evidence_json?: string } | undefined
  if (row?.evidence_json === undefined) return null
  try {
    const ev = JSON.parse(row.evidence_json) as Record<string, unknown>
    return typeof ev['checkoutPath'] === 'string' ? ev['checkoutPath'] : null
  } catch {
    return null
  }
}

function workspaceFromReservations(reservationsJson: string): string | null {
  try {
    const r = JSON.parse(reservationsJson) as Record<string, unknown>
    const ws = r['workspaceId'] ?? (r['workspace'] as Record<string, unknown> | undefined)?.['id']
    return typeof ws === 'string' ? ws : null
  } catch {
    return null
  }
}
