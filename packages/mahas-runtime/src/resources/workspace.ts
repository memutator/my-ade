// resources/workspace.ts — workspace.prepare + workspace.inspect (C-RESOURCE).
//
// IMP-16. Logical Workspace ≠ physical Checkout: prepare reserves a write
// claim on the canonical checkout identity, declares the host effect through
// txn.intendEffect (durable effect_intents + outbox row in the same
// transaction — spec/common.md §3's atomic unit), performs the host effect,
// then finalizes the checkout identity from the host receipt. Partial
// failure is preserved as effect state + residuals in the committed domain
// event and the operation result — never silently retried with fresh IDs
// (REQ-13/14, execution-lifecycle §3).
//
// Authorization is the registry's job: these specs carry resolveTargets so
// admission authorizes the ACTUAL targets (D-ACCESS §2); handlers never
// re-derive scope from payload claims.

import type { DatabaseSync } from 'node:sqlite'
import type { TargetRef, TxnContext } from '../api/registry.ts'
import type { Checkout, Workspace } from '../../../mahas-contracts/src/resource.ts'
import type { Id } from '../../../mahas-contracts/src/common.ts'
import {
  canonicalPathGuess,
  checkoutsAt,
  fail,
  getCheckout,
  getWorkspace,
  isMahasError,
  isPendingIdentity,
  liveFilesystemIdentity,
  mintId,
  toCheckout,
  toWorkspace,
  type CheckoutRepository
} from './checkout.ts'
import {
  activeWriteClaim,
  claimsForResource,
  insertClaim,
  pinsForTargets,
  toClaim,
  toPin,
  type ClaimOwner
} from './claims.ts'
import type { ResolvedResourceDeps } from './mod.ts'

// ---------------------------------------------------------------------------
// payloads / results (C-RESOURCE §workspace.prepare, §workspace.inspect)
// ---------------------------------------------------------------------------

export interface PlacementIntent {
  /** folder = materialize/use a plain directory; worktree = git worktree add */
  kind: 'folder' | 'worktree'
  /**
   * approved containment root on the host (canonicalized there). The host
   * rejects targets escaping it — boundary.paths is NOT this sandbox (§5).
   * Defaults to the project's repository_root when omitted.
   */
  projectRoot?: string
  /** host-local path the checkout should live at */
  targetPath: string
  /** control-mirror execution_hosts.id; defaults to deps.defaultHostId */
  hostId?: Id
  /** expected repository identity evidence (canonical git-dir path) */
  repositoryIdentity?: string
  /** worktree branch to create; detached HEAD when absent */
  branch?: string
}

export interface OwnerReservation {
  ownerKind: string
  ownerId: string
  generation?: number
}

export interface WorkspacePreparePayload {
  projectId: Id
  placementIntent: PlacementIntent
  expectedBaseCommit?: string
  ownerReservation: OwnerReservation
}

export interface EffectSummary {
  /** the effect_intents/effect_outbox row id — also the host effectKey */
  intentId: string
  kind: string
  /** the host's verdict: confirmed | rejected | unknown (the persisted row is
   *  'prepared' until the outbox pump reconciles it via host.effect.get) */
  state: string
  receipt?: unknown
  residuals?: unknown[]
}

export interface WorkspacePrepareResult {
  workspace: Workspace
  checkout: Checkout
  claim: unknown
  effect: EffectSummary
}

export interface WorkspaceInspectPayload {
  workspaceId: Id
  /** also ask the host for live exists/dirty evidence (default false) */
  probe?: boolean
}

export interface WorkspaceInspectResult {
  workspace: Workspace
  checkout: Checkout
  claims: unknown[]
  retentionPins: unknown[]
  retainReasons: string[]
  probe?: unknown
}

// ---------------------------------------------------------------------------
// host wire shapes — mirrored by mahas-execution-host workspaces/*
// ---------------------------------------------------------------------------

interface HostPreparePayload {
  kind: 'folder' | 'worktree'
  projectRoot: string
  targetPath: string
  expectedRepositoryIdentity?: string
  baseCommit?: string
  branch?: string
  claimToken?: string
}

export interface HostPrepareResult {
  effectKey: string
  state: 'confirmed' | 'rejected' | 'unknown'
  receipt?: unknown
  checkout?: {
    canonicalPath: string
    filesystemIdentity: string
    repositoryIdentity?: string
    worktreeIdentity?: string
    headCommit?: string
    isRepo?: boolean
  }
  residuals?: unknown[]
  reason?: { code: string; message: string }
}

export interface HostProbeResult {
  state: 'exists' | 'absent' | 'unverifiable'
  dirty?: 'clean' | 'dirty' | 'unverifiable' | null
  evidence?: unknown
}

// ---------------------------------------------------------------------------
// transaction helper — handlers normally run inside the registry's
// transaction (admission.ts runInTransaction); when invoked directly (tests,
// nested calls on a raw db) we open our own so the unit stays atomic.
// ---------------------------------------------------------------------------

export function inTx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn()
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* connection-level failure — nothing left to roll back */
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// payload validation — bad shape is INPUT_NOT_READY, never a silent default
// ---------------------------------------------------------------------------

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    fail('INPUT_NOT_READY', `payload.${name} must be a non-empty string`, 'none', { field: name })
  }
  return v
}

function requireOwner(v: unknown, name: string): ClaimOwner {
  const o = v as Partial<OwnerReservation> | undefined
  if (
    !o ||
    typeof o.ownerKind !== 'string' ||
    !o.ownerKind ||
    typeof o.ownerId !== 'string' ||
    !o.ownerId
  ) {
    fail('INPUT_NOT_READY', `${name} requires {ownerKind, ownerId}`, 'none', { field: name })
  }
  return {
    ownerKind: o.ownerKind,
    ownerId: o.ownerId,
    generation: typeof o.generation === 'number' && o.generation > 0 ? o.generation : 1
  }
}

// ---------------------------------------------------------------------------
// resolveTargets — the ACTUAL targets admission authorizes (read-only; runs
// on the admission facade and again inside the write transaction)
// ---------------------------------------------------------------------------

export function workspacePrepareTargets(_txn: TxnContext, payload: unknown): TargetRef[] {
  const p = payload as Partial<WorkspacePreparePayload>
  const targets: TargetRef[] = []
  if (typeof p?.projectId === 'string' && p.projectId) {
    targets.push({ kind: 'project', id: p.projectId })
  }
  return targets
}

export function workspaceInspectTargets(_txn: TxnContext, payload: unknown): TargetRef[] {
  const p = payload as Partial<WorkspaceInspectPayload>
  return typeof p?.workspaceId === 'string' && p.workspaceId
    ? [{ kind: 'workspace', id: p.workspaceId }]
    : []
}

// ---------------------------------------------------------------------------
// workspace.prepare
// ---------------------------------------------------------------------------

export async function workspacePrepareHandler(
  txn: TxnContext,
  payload: unknown,
  deps: ResolvedResourceDeps
): Promise<WorkspacePrepareResult> {
  const p = payload as Partial<WorkspacePreparePayload>
  const projectId = requireString(p?.projectId, 'projectId')
  const intent = p?.placementIntent
  if (!intent || (intent.kind !== 'folder' && intent.kind !== 'worktree')) {
    fail('INPUT_NOT_READY', 'placementIntent.kind must be folder|worktree', 'none', {
      field: 'placementIntent.kind'
    })
  }
  const targetPath = requireString(intent.targetPath, 'placementIntent.targetPath')
  const owner = requireOwner(p?.ownerReservation, 'ownerReservation')
  const expectedBaseCommit =
    typeof p?.expectedBaseCommit === 'string' ? p.expectedBaseCommit : undefined

  const db = txn.db
  const startedAt = deps.now()

  // ---- reservation: project lookup, overlap scan, rows, claim, intent ---
  const reserved = inTx(db, () => {
    const project = db
      .prepare('SELECT id, repository_root FROM projects WHERE id=?')
      .get(projectId) as { id: string; repository_root: string } | undefined
    if (!project) {
      fail('INPUT_NOT_READY', 'project not found for placement', 'none', { projectId })
    }
    const hostId = (intent.hostId ?? deps.defaultHostId) as string
    const projectRoot = intent.projectRoot ?? project.repository_root
    const pathGuess = canonicalPathGuess(targetPath)
    const live = liveFilesystemIdentity(pathGuess)

    // overlap scan on the CANONICAL location — not on workspaceId (§4).
    // A checkout row at this path is the same live resource when its stored
    // identity matches the directory on disk now, or it is still provisional
    // (a racing prepare mid-effect). Stale identities belong to dead
    // resources and do not block a fresh checkout.
    for (const row of checkoutsAt(db, hostId, pathGuess)) {
      const sameLive =
        isPendingIdentity(row.filesystem_identity) ||
        (live.status === 'present' && live.identity === row.filesystem_identity)
      if (!sameLive) continue
      const blocker = activeWriteClaim(db, row.resource_id)
      if (blocker) {
        fail(
          'RESOURCE_BUSY',
          'canonical checkout already has a live or unverified writer',
          'none',
          {
            checkoutId: row.id,
            canonicalPath: row.canonical_path,
            filesystemIdentity: row.filesystem_identity,
            blockingClaimId: blocker.id,
            blockingOwner: { kind: blocker.owner_kind, id: blocker.owner_id }
          }
        )
      }
    }

    const resourceId = mintId('resource')
    const checkoutId = mintId('checkout')
    const workspaceId = mintId('workspace')
    const claimId = mintId('claim')

    const hostPayload: HostPreparePayload = {
      kind: intent.kind,
      projectRoot,
      targetPath,
      expectedRepositoryIdentity: intent.repositoryIdentity,
      baseCommit: expectedBaseCommit,
      branch: intent.branch,
      claimToken: claimId
    }
    // declare the effect BEFORE the rows: the intent id is the durable host
    // effectKey (<operationId>:effect:<n> — stable across reconcile replay)
    const effectId = txn.intendEffect({
      kind: 'host.workspace.prepare',
      hostId,
      payload: hostPayload
    })

    db.prepare('INSERT INTO resources (id, kind, host_id, identity_json) VALUES (?,?,?,?)').run(
      resourceId,
      'checkout',
      hostId,
      JSON.stringify({ requestedPath: targetPath, canonicalPathGuess: pathGuess })
    )
    db.prepare(
      `INSERT INTO checkouts (id, resource_id, host_id, canonical_path, filesystem_identity, repository_json, revision)
       VALUES (?,?,?,?,?,?,?)`
    ).run(
      checkoutId,
      resourceId,
      hostId,
      pathGuess,
      `pending:${effectId}`,
      JSON.stringify({} satisfies CheckoutRepository),
      1
    )
    db.prepare(
      'INSERT INTO workspaces (id, project_id, checkout_id, kind, state) VALUES (?,?,?,?,?)'
    ).run(
      workspaceId,
      projectId,
      checkoutId,
      intent.kind === 'worktree' ? 'git-worktree' : 'folder',
      'preparing'
    )
    insertClaim(db, { id: claimId, resourceId, owner, mode: 'write' })
    txn.emitEvent({
      aggregateId: workspaceId,
      aggregateRevision: 1,
      eventType: 'workspace.prepare.reserved',
      scope: { projectId },
      payload: { workspaceId, checkoutId, claimId, effectId, hostId, pathGuess }
    })
    return { hostId, pathGuess, workspaceId, checkoutId, claimId, effectId, hostPayload }
  })

  // ---- host effect: the execution-host does the real fs work ------------
  let hostResult: HostPrepareResult | null = null
  let hostError: unknown = null
  try {
    const client = await deps.hostClient(reserved.hostId as Id)
    hostResult = await client.call<HostPrepareResult>(
      'host.workspace.prepare',
      reserved.hostPayload,
      { effectKey: reserved.effectId }
    )
  } catch (e) {
    hostError = e
  }

  // ---- identity finalize: host receipt is the authority ------------------
  return inTx(db, () => {
    const residuals: unknown[] = [...(hostResult?.residuals ?? [])]
    let effectState: string
    let receipt: unknown

    if (hostResult && hostResult.state === 'confirmed' && hostResult.checkout) {
      const repo: CheckoutRepository = {
        repositoryIdentity: hostResult.checkout.repositoryIdentity,
        worktreeIdentity: hostResult.checkout.worktreeIdentity,
        headCommit: hostResult.checkout.headCommit,
        isRepo: hostResult.checkout.isRepo
      }
      try {
        db.prepare(
          'UPDATE checkouts SET canonical_path=?, filesystem_identity=?, repository_json=?, revision=revision+1 WHERE id=?'
        ).run(
          hostResult.checkout.canonicalPath,
          hostResult.checkout.filesystemIdentity,
          JSON.stringify(repo),
          reserved.checkoutId
        )
      } catch (e) {
        // (host,canonical_path,filesystem_identity) unique conflict — another
        // finalized checkout already owns this physical directory. Keep the
        // provisional row + held claim as evidence; no silent fold.
        residuals.push({
          resourceRef: reserved.checkoutId,
          reason: 'identity-finalize-conflict',
          liveEvidence: String((e as Error).message)
        })
        db.prepare("UPDATE workspaces SET state='prepare-unknown' WHERE id=?").run(
          reserved.workspaceId
        )
        effectState = 'unknown'
        receipt = {
          state: 'unknown',
          reason: {
            code: 'RESOURCE_BUSY',
            message: 'checkout identity finalize collided with an existing resource'
          },
          hostReceipt: hostResult.receipt
        }
        return finishPrepare(db, txn, reserved, deps, startedAt, effectState, receipt, residuals)
      }
      db.prepare("UPDATE workspaces SET state='ready' WHERE id=?").run(reserved.workspaceId)
      effectState = 'confirmed'
      receipt = { state: 'confirmed', hostReceipt: hostResult.receipt, at: deps.now() }
    } else if (hostResult && hostResult.state === 'rejected') {
      db.prepare("UPDATE workspaces SET state='failed' WHERE id=?").run(reserved.workspaceId)
      effectState = 'rejected'
      receipt = {
        state: 'rejected',
        reason: hostResult.reason ?? { code: 'UNKNOWN', message: 'host rejected without reason' },
        hostReceipt: hostResult.receipt
      }
    } else {
      // host said unknown, transport failed, or malformed result — the
      // directory MAY exist; claim stays held and the leftover path is a
      // recorded residual, not deleted evidence (REQ-13/16).
      db.prepare("UPDATE workspaces SET state='prepare-unknown' WHERE id=?").run(
        reserved.workspaceId
      )
      effectState = 'unknown'
      receipt = {
        state: 'unknown',
        reason: hostError
          ? {
              code: 'CONTROL_UNAVAILABLE',
              message: String((hostError as Error).message ?? hostError)
            }
          : (hostResult?.reason ?? { code: 'START_UNKNOWN', message: 'host returned no verdict' }),
        hostReceipt: hostResult?.receipt
      }
      residuals.push({
        resourceRef: reserved.checkoutId,
        reason: 'prepare-outcome-unverified',
        liveEvidence: { canonicalPathGuess: reserved.pathGuess, targetPath },
        cleanupPolicy: 'preserve-until-reconciled'
      })
    }
    return finishPrepare(db, txn, reserved, deps, startedAt, effectState, receipt, residuals)
  })
}

interface ReservedPrepare {
  hostId: string
  pathGuess: string
  workspaceId: string
  checkoutId: string
  claimId: string
  effectId: string
  hostPayload: HostPreparePayload
}

function finishPrepare(
  db: DatabaseSync,
  txn: TxnContext,
  r: ReservedPrepare,
  deps: ResolvedResourceDeps,
  startedAt: number,
  effectState: string,
  receipt: unknown,
  residuals: unknown[]
): WorkspacePrepareResult {
  const ws = getWorkspace(db, r.workspaceId)!
  txn.emitEvent({
    aggregateId: r.workspaceId,
    aggregateRevision: 1,
    eventType: `workspace.prepare.${effectState}`,
    scope: { projectId: ws.project_id },
    payload: {
      effectId: r.effectId,
      effectState,
      residuals,
      startedAt,
      finishedAt: deps.now()
    }
  })
  const co = getCheckout(db, r.checkoutId)!
  const claim = activeWriteClaim(db, co.resource_id) ?? claimsForResource(db, co.resource_id)[0]
  return {
    workspace: toWorkspace(ws),
    checkout: toCheckout(co),
    claim: claim ? toClaim(claim) : null,
    effect: {
      intentId: r.effectId,
      kind: 'host.workspace.prepare',
      state: effectState,
      receipt,
      residuals
    }
  }
}

// ---------------------------------------------------------------------------
// workspace.inspect — query + optional live probe. Observation only: never
// mutates checkout/claim state. An unverifiable probe is EVIDENCE, not absence.
// ---------------------------------------------------------------------------

export async function workspaceInspectHandler(
  txn: TxnContext,
  payload: unknown,
  deps: ResolvedResourceDeps
): Promise<WorkspaceInspectResult> {
  const p = payload as Partial<WorkspaceInspectPayload>
  const workspaceId = requireString(p?.workspaceId, 'workspaceId')
  const db = txn.db

  const ws = getWorkspace(db, workspaceId)
  if (!ws) fail('INPUT_NOT_READY', 'workspace not found', 'none', { workspaceId })
  const co = getCheckout(db, ws.checkout_id)
  if (!co) {
    fail('MODEL_INVALID', 'workspace references a missing checkout', 'reconcile', {
      workspaceId,
      checkoutId: ws.checkout_id
    })
  }
  const claims = claimsForResource(db, co.resource_id)
  const pins = pinsForTargets(db, [co.resource_id, co.id, ws.id])
  const retainReasons = pins.map((pin) => `${pin.holder_kind}:${pin.holder_id} — ${pin.reason}`)

  let probe: unknown = undefined
  if (p?.probe && !isPendingIdentity(co.filesystem_identity)) {
    try {
      const client = await deps.hostClient(co.host_id as Id)
      const repo = JSON.parse(co.repository_json) as CheckoutRepository
      probe = await client.call<HostProbeResult>('host.workspace.probe', {
        checkoutId: co.id,
        canonicalPath: co.canonical_path,
        expectedFilesystemIdentity: co.filesystem_identity,
        expectedWorktreeIdentity: repo.worktreeIdentity
      })
    } catch (e) {
      // PROCESS_UNVERIFIABLE / unreachable host both land here: the verdict is
      // 'unverifiable' evidence — NEVER collapsed into 'absent' (C-HOST §probe)
      probe = {
        state: 'unverifiable',
        evidence: { error: isMahasError(e) ? e.code : String((e as Error).message ?? e) }
      }
    }
  } else if (p?.probe) {
    probe = {
      state: 'unverifiable',
      evidence: { reason: 'checkout identity not finalized — host effect pending or failed' }
    }
  }

  return {
    workspace: toWorkspace(ws),
    checkout: toCheckout(co),
    claims: claims.map(toClaim),
    retentionPins: pins.map(toPin),
    retainReasons,
    probe
  }
}
