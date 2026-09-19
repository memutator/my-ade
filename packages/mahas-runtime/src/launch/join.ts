// mahas-runtime — execution.join / execution.heartbeat (launch/access, IMP-20).
//
// Contract: spec/contracts/launch.md. registerJoinOps is the entrypoint the
// service composer calls once; it also registers task.accept (acceptance.ts)
// since all three ops share this boundary's deps.
//
// execution.join — the booted agent's explicit participation receipt:
//   * the caller must authenticate with THIS execution's bootstrap
//     ExecutionCredential — the launcher's principal cannot join for the
//     agent (spec/injection.md §7: 대리 join 불가);
//   * executionGeneration + bundle/surface/envelope digests are compared
//     against the pinned LaunchPlan row — the digest the worker was actually
//     launched with, not what the agent claims it understood;
//   * in one transaction: WorkerJoin insert, credential mode bootstrap→full
//     (server 승격), execution awaiting_join→ready, active dispatch
//     →awaiting_accept (join is NOT task accept — separate receipts),
//     worker_joined injection receipt, domain event.
//   Digest equality is evidence the launch pins were received, never proof
//   the model understood its instructions.
//
// execution.heartbeat — stores a member-sourced ObservationFact and returns
//   the server's current control view. It changes NO authority: not liveness,
//   not task outcome, not lease takeover evidence (spec/contracts/launch.md).

import type { DatabaseSync } from 'node:sqlite'
import type { CommandSurface } from '../../../mahas-contracts/src/index.ts'
import { surfaceFor } from '../access/authorize.ts'
import type { OperationHandler, OperationRegistry, TargetRef, TxnContext } from '../api/registry.ts'
import {
  acceptResolveRevisions,
  acceptResolveTargets,
  taskAcceptHandler,
  type AcceptOpsDeps
} from './acceptance.ts'
import { promoteCredentialToFull } from './bootstrap-credential.ts'
import {
  asPayload,
  fail,
  findLiveCredential,
  grantForExecution,
  loadDispatch,
  loadExecution,
  loadLaunchPlan,
  loadMember,
  loadWorkerJoin,
  newId,
  optionalString,
  requireInt,
  requireLiveGrant,
  requireString,
  revisionsOf,
  type CredentialRow,
  type LaunchPlanRow
} from './store.ts'

export interface JoinOpsDeps extends AcceptOpsDeps {
  now?: () => number
}

function now(deps: JoinOpsDeps): number {
  return deps.now?.() ?? Date.now()
}

// ---------- execution.join ----------

interface JoinPayload {
  executionId: string
  generation: number
  bundleDigest: string
  surfaceDigest: string
  envelopeDigest: string
}

function parseJoinPayload(raw: unknown): JoinPayload {
  const payload = asPayload(raw)
  return {
    executionId: requireString(payload, 'executionId'),
    generation: requireInt(payload, 'generation'),
    bundleDigest: requireString(payload, 'bundleDigest'),
    surfaceDigest: requireString(payload, 'surfaceDigest'),
    envelopeDigest: requireString(payload, 'envelopeDigest')
  }
}

function checkPlanDigests(plan: LaunchPlanRow, p: JoinPayload): void {
  const mismatches: Record<string, { expected: string; actual: string }> = {}
  if (plan.bundle_digest !== p.bundleDigest) {
    mismatches.bundleDigest = { expected: plan.bundle_digest, actual: p.bundleDigest }
  }
  if (plan.surface_digest !== p.surfaceDigest) {
    mismatches.surfaceDigest = { expected: plan.surface_digest, actual: p.surfaceDigest }
  }
  if (plan.envelope_digest !== p.envelopeDigest) {
    mismatches.envelopeDigest = { expected: plan.envelope_digest, actual: p.envelopeDigest }
  }
  if (Object.keys(mismatches).length > 0) {
    fail(
      'ARTIFACT_MISMATCH',
      `join digests do not match launch plan ${plan.id}`,
      'reconcile',
      mismatches
    )
  }
}

function recordedJoin(db: DatabaseSync, executionId: string, generation: number): unknown | null {
  const join = loadWorkerJoin(db, executionId, generation)
  if (!join) return null
  return {
    join: {
      executionId: join.execution_id,
      generation: join.generation,
      bundleDigest: join.bundle_digest,
      surfaceDigest: join.surface_digest,
      envelopeDigest: join.envelope_digest,
      joinedAt: join.joined_at
    },
    alreadyJoined: true
  }
}

/** next revision for an injection_receipts (execution_id, phase) pair */
function nextInjectionRevision(db: DatabaseSync, executionId: string, phase: string): number {
  const row = db
    .prepare(
      `SELECT MAX(revision) AS max_rev FROM injection_receipts WHERE execution_id = ? AND phase = ?`
    )
    .get(executionId, phase) as { max_rev: number | null } | undefined
  return (row?.max_rev ?? 0) + 1
}

function executionJoinHandler(deps: JoinOpsDeps): OperationHandler {
  return (txn: TxnContext, raw: unknown): unknown => {
    const { db, ctx } = txn
    const at = now(deps)
    const p = parseJoinPayload(raw)

    // The credential — not the payload — decides which execution may join.
    // A launcher/service principal has no execution binding, so 대리 join
    // fails here rather than at the transport's mercy.
    if (!ctx.executionId || ctx.executionId !== p.executionId) {
      fail(
        'SCOPE_DENIED',
        'execution.join requires the bootstrap credential bound to this execution',
        'none'
      )
    }
    if (
      ctx.executionGeneration === undefined ||
      (ctx.executionGeneration as number) !== p.generation
    ) {
      fail(
        'STALE_EXECUTION',
        `join generation ${p.generation} is not the credential's generation`,
        'reconcile'
      )
    }

    const execution = loadExecution(db, p.executionId)
    if (!execution) {
      fail('STALE_EXECUTION', `execution ${p.executionId} does not exist`, 'reconcile')
    }
    if (execution.generation !== p.generation) {
      fail(
        'STALE_EXECUTION',
        `execution ${p.executionId} is generation ${execution.generation}, not ${p.generation}`,
        'reconcile'
      )
    }

    // a live credential of this principal for this exact generation
    const credential: CredentialRow | null = findLiveCredential(
      db,
      p.executionId,
      p.generation,
      ctx.principalId as string
    )
    if (!credential) {
      fail('SCOPE_DENIED', 'no live credential for this execution/generation', 'none')
    }

    const member = loadMember(db, execution.member_id)
    if (member?.state === 'retired') {
      fail('INVALID_TRANSITION', `member ${member.id} is retired`, 'replan')
    }

    const binding = grantForExecution(db, execution)
    requireLiveGrant(binding?.grant ?? null, at, `execution ${execution.id}`)

    // ---- already-joined path: full credential + recorded WorkerJoin ----
    if (credential.mode === 'full' || execution.state === 'ready') {
      const existing = recordedJoin(db, p.executionId, p.generation)
      if (existing) {
        const plan = loadLaunchPlan(db, execution.launch_plan_id)
        if (plan) checkPlanDigests(plan, p) // same digests → same truth; different → mismatch
        const surface = surfaceFor(ctx, db)
        return {
          ...existing,
          credentialBinding: {
            credentialId: credential.id,
            mode: 'full',
            memberId: execution.member_id,
            executionId: execution.id,
            generation: execution.generation
          },
          effectiveSurface: surface,
          surfaceDigest: plan?.surface_digest ?? null
        }
      }
      fail(
        'INVALID_TRANSITION',
        `execution ${execution.id} is '${execution.state}' with no WorkerJoin recorded`,
        'reconcile'
      )
    }

    if (execution.state !== 'awaiting_join') {
      const stale = execution.state === 'exited' || execution.state === 'abandoned'
      fail(
        stale ? 'STALE_EXECUTION' : 'INVALID_TRANSITION',
        `execution ${execution.id} is '${execution.state}', not awaiting_join`,
        stale ? 'reconcile' : 'same-operation'
      )
    }

    const plan = loadLaunchPlan(db, execution.launch_plan_id)
    if (!plan) {
      fail('STALE_EXECUTION', `launch plan ${execution.launch_plan_id} is missing`, 'reconcile')
    }
    checkPlanDigests(plan, p)

    // ---- commit: WorkerJoin + credential promotion + phase flips ----
    db.prepare(
      `INSERT INTO worker_joins
         (execution_id, generation, bundle_digest, surface_digest, envelope_digest, joined_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(p.executionId, p.generation, p.bundleDigest, p.surfaceDigest, p.envelopeDigest, at)

    promoteCredentialToFull(db, credential.id)

    const execUpdated = db
      .prepare(
        `UPDATE executions SET state = 'ready', revision = revision + 1
         WHERE id = ? AND state = 'awaiting_join'`
      )
      .run(execution.id)
    if (execUpdated.changes !== 1) {
      fail(
        'INVALID_TRANSITION',
        `execution ${execution.id} left awaiting_join concurrently`,
        'reconcile'
      )
    }
    const execRevision = execution.revision + 1

    // join is not task accept — the dispatch moves to awaiting_accept only.
    const dispatchUpdated = db
      .prepare(
        `UPDATE dispatches SET phase = 'awaiting_accept', revision = revision + 1
         WHERE execution_id = ? AND generation = ? AND authority_state = 'active'
           AND phase IN ('reserved', 'starting', 'awaiting_join')`
      )
      .run(execution.id, p.generation)

    // worker_joined injection receipt — agent-declared digests, not a
    // verified model-side understanding (spec/injection.md §7).
    const joinReceiptRevision = nextInjectionRevision(db, execution.id, 'worker_joined')
    db.prepare(
      `INSERT INTO injection_receipts
         (execution_id, phase, revision, components_json, inherited_json, evidence_json)
       VALUES (?, 'worker_joined', ?, ?, ?, ?)`
    ).run(
      execution.id,
      joinReceiptRevision,
      JSON.stringify([
        { kind: 'bundle', digest: p.bundleDigest, route: 'agent-declared' },
        { kind: 'surface', digest: p.surfaceDigest, route: 'agent-declared' },
        { kind: 'envelope', digest: p.envelopeDigest, route: 'agent-declared' }
      ]),
      JSON.stringify([]),
      JSON.stringify({
        credentialId: credential.id,
        joinedAt: at,
        launchPlanId: plan.id,
        evidenceLevel: 'pins-declared-not-comprehension'
      })
    )

    txn.emitEvent({
      aggregateId: execution.id,
      aggregateRevision: execRevision,
      eventType: 'execution.joined',
      scope: { memberId: execution.member_id, runId: member?.run_id ?? null },
      payload: {
        generation: p.generation,
        bundleDigest: p.bundleDigest,
        surfaceDigest: p.surfaceDigest,
        envelopeDigest: p.envelopeDigest,
        dispatchesAdvanced: Number(dispatchUpdated.changes)
      }
    })

    const surface: CommandSurface = surfaceFor(ctx, db)
    return {
      join: {
        executionId: execution.id,
        generation: p.generation,
        bundleDigest: p.bundleDigest,
        surfaceDigest: p.surfaceDigest,
        envelopeDigest: p.envelopeDigest,
        joinedAt: at
      },
      alreadyJoined: false,
      credentialBinding: {
        // state identifiers only — the secret is never returned (spec §3:
        // 비밀이 아닌 상태 식별자)
        credentialId: credential.id,
        mode: 'full',
        memberId: execution.member_id,
        executionId: execution.id,
        generation: execution.generation
      },
      effectiveSurface: surface,
      surfaceDigest: plan.surface_digest,
      dispatchesAdvanced: Number(dispatchUpdated.changes)
    }
  }
}

// ---------- execution.heartbeat ----------

interface HeartbeatPayload {
  executionId: string
  generation: number
  activityHint?: string
  activeDispatchId?: string
}

function parseHeartbeatPayload(raw: unknown): HeartbeatPayload {
  const payload = asPayload(raw)
  return {
    executionId: requireString(payload, 'executionId'),
    generation: requireInt(payload, 'generation'),
    activityHint: optionalString(payload, 'activityHint'),
    activeDispatchId: optionalString(payload, 'activeDispatchId')
  }
}

function heartbeatHandler(deps: JoinOpsDeps): OperationHandler {
  return (txn: TxnContext, raw: unknown): unknown => {
    const { db, ctx } = txn
    const at = now(deps)
    const p = parseHeartbeatPayload(raw)

    if (!ctx.executionId || ctx.executionId !== p.executionId) {
      fail('SCOPE_DENIED', 'execution.heartbeat requires this execution’s credential', 'none')
    }
    if (
      ctx.executionGeneration === undefined ||
      (ctx.executionGeneration as number) !== p.generation
    ) {
      fail(
        'STALE_EXECUTION',
        `heartbeat generation ${p.generation} is not the credential's generation`,
        'reconcile'
      )
    }

    const execution = loadExecution(db, p.executionId)
    if (!execution || execution.generation !== p.generation) {
      fail(
        'STALE_EXECUTION',
        `execution ${p.executionId} generation ${p.generation} is not current`,
        'reconcile'
      )
    }
    if (execution.state === 'exited' || execution.state === 'abandoned') {
      fail('STALE_EXECUTION', `execution ${execution.id} is '${execution.state}'`, 'reconcile')
    }

    // heartbeat is a post-join operation — a bootstrap-mode credential never
    // reaches it through the surface filter; re-checked here in depth.
    const credential = findLiveCredential(
      db,
      p.executionId,
      p.generation,
      ctx.principalId as string
    )
    if (!credential || credential.mode !== 'full') {
      fail('SCOPE_DENIED', 'execution.heartbeat requires the promoted (full) credential', 'none')
    }

    // the hinted dispatch is recorded as a claim — only bound to the column
    // when it verifiably belongs to this execution (FK + honesty)
    let dispatchId: string | null = null
    if (p.activeDispatchId) {
      const hinted = loadDispatch(db, p.activeDispatchId)
      if (hinted && hinted.execution_id === execution.id && hinted.generation === p.generation) {
        dispatchId = hinted.id
      }
    }

    db.prepare(
      `INSERT INTO observations
         (id, execution_id, dispatch_id, source, fact_type, observed_at, payload_json, identity_evidence_json)
       VALUES (?, ?, ?, 'member', 'heartbeat', ?, ?, ?)`
    ).run(
      newId(),
      execution.id,
      dispatchId,
      at,
      JSON.stringify({
        activityHint: p.activityHint ?? null,
        claimedDispatchId: p.activeDispatchId ?? null
      }),
      JSON.stringify({
        credentialId: credential.id,
        principalId: ctx.principalId,
        generation: p.generation,
        transportSessionId: ctx.transportSessionId
      })
    )

    return {
      observedAt: at,
      controlStatus: {
        executionId: execution.id,
        state: execution.state,
        liveness: execution.liveness,
        revision: execution.revision
      }
    }
  }
}

// ---------- admission resolvers (read-only; the pipeline calls authorize) ----------

function joinResolveTargets(txn: TxnContext, raw: unknown): TargetRef[] {
  const payload = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const executionId = typeof payload.executionId === 'string' ? payload.executionId : ''
  const targets: TargetRef[] = [{ kind: 'execution', id: executionId }]
  const execution = executionId ? loadExecution(txn.db, executionId) : null
  if (execution) {
    targets.push({ kind: 'member', id: execution.member_id })
    targets.push({ kind: 'launchPlan', id: execution.launch_plan_id })
  }
  return targets
}

function heartbeatResolveTargets(txn: TxnContext, raw: unknown): TargetRef[] {
  const payload = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const executionId = typeof payload.executionId === 'string' ? payload.executionId : ''
  const targets: TargetRef[] = [{ kind: 'execution', id: executionId }]
  const execution = executionId ? loadExecution(txn.db, executionId) : null
  if (execution) targets.push({ kind: 'member', id: execution.member_id })
  return targets
}

/**
 * Register this boundary's operations on the service registry.
 *   execution.join       — member, mutation
 *   execution.heartbeat  — member, mutation (observation write)
 *   task.accept          — member, mutation
 * resolveTargets/resolveRevisions feed the admission pipeline's own
 * authorize + expectedRevisions checks (spec/common.md §3); handlers keep
 * the domain binding checks the pipeline cannot express.
 * Bootstrap-surface restriction (only join/show/describe/get allowed before
 * join) is enforced by decide()'s execution join-state (BOOTSTRAP_OPERATIONS
 * in access/authorize.ts) — the worker credential carries no mode field, so
 * no transport-layer check could do it (F-057).
 */
export function registerJoinOps(registry: OperationRegistry, deps: JoinOpsDeps = {}): void {
  registry.register(
    {
      name: 'execution.join',
      visibility: 'member',
      mutation: true,
      summary: 'declare agent participation bound to the pinned launch digests',
      inputSchema: {
        type: 'object',
        required: ['executionId', 'generation', 'bundleDigest', 'surfaceDigest', 'envelopeDigest'],
        properties: {
          executionId: { type: 'string' },
          generation: { type: 'integer' },
          bundleDigest: { type: 'string' },
          surfaceDigest: { type: 'string' },
          envelopeDigest: { type: 'string' }
        },
        additionalProperties: false
      },
      resolveTargets: joinResolveTargets,
      resolveRevisions: (txn, entityIds) => revisionsOf(txn.db, entityIds)
    },
    executionJoinHandler(deps)
  )
  registry.register(
    {
      name: 'execution.heartbeat',
      visibility: 'member',
      mutation: true,
      summary: 'record a member liveness observation; never claims outcome or death',
      inputSchema: {
        type: 'object',
        required: ['executionId', 'generation'],
        properties: {
          executionId: { type: 'string' },
          generation: { type: 'integer' },
          activityHint: { type: 'string' },
          activeDispatchId: { type: 'string' }
        },
        additionalProperties: false
      },
      resolveTargets: heartbeatResolveTargets,
      resolveRevisions: (txn, entityIds) => revisionsOf(txn.db, entityIds)
    },
    heartbeatHandler(deps)
  )
  registry.register(
    {
      name: 'task.accept',
      visibility: 'member',
      mutation: true,
      summary: 'accept the current dispatch’s exact TaskRevision and WorkEnvelopeDigest',
      inputSchema: {
        type: 'object',
        required: ['dispatchId', 'taskRevision', 'envelopeDigest'],
        properties: {
          dispatchId: { type: 'string' },
          taskRevision: { type: 'integer' },
          envelopeDigest: { type: 'string' }
        },
        additionalProperties: false
      },
      resolveTargets: acceptResolveTargets,
      resolveRevisions: acceptResolveRevisions
    },
    taskAcceptHandler(deps)
  )
}
