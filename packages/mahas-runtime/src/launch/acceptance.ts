// mahas-runtime — task.accept: 명시 Task 인수 (launch/access, IMP-20).
//
// Contract: spec/contracts/work.md `task.accept`. The member holding the
// current Dispatch declares acceptance of an exact TaskRevision +
// WorkEnvelopeDigest. It is NOT execution.join and not a generic turn-start:
// join binds the process to the launch pins, accept binds the member to this
// dispatch's work. On success the accept phase, the assignment Delivery ack
// and the receipt commit in ONE transaction (S-STORAGE §5).
//
// Guards (all inside the write tx):
//   caller binding — ctx.executionId/executionGeneration must be the
//     dispatch's own execution+generation (a past generation's accept can
//     never touch current authority — REQ-15).
//   dispatch      — exists, authority_state='active', member matches caller.
//   pins          — taskRevision + envelopeDigest must equal the dispatch row.
//   join ordering — a WorkerJoin for this generation must already exist.
//   delivery      — the assignment Delivery is outstanding, addressed to the
//     caller and stamped with the current consumer generation.

import type { AuthenticatedContext } from '../../../mahas-contracts/src/index.ts'
import type { OperationHandler, TargetRef, TxnContext } from '../api/registry.ts'
import {
  asPayload,
  fail,
  grantForExecution,
  loadDelivery,
  loadDispatch,
  loadExecution,
  loadMember,
  loadWorkerJoin,
  requireInt,
  requireLiveGrant,
  requireString,
  revisionsOf,
  type DispatchRow
} from './store.ts'

export interface AcceptOpsDeps {
  now?: () => number
}

interface AcceptPayload {
  dispatchId: string
  taskRevision: number
  envelopeDigest: string
}

function parseAcceptPayload(raw: unknown): AcceptPayload {
  const payload = asPayload(raw)
  return {
    dispatchId: requireString(payload, 'dispatchId'),
    taskRevision: requireInt(payload, 'taskRevision'),
    envelopeDigest: requireString(payload, 'envelopeDigest')
  }
}

function now(deps: AcceptOpsDeps): number {
  return deps.now?.() ?? Date.now()
}

function requireExecutionBound(
  ctx: AuthenticatedContext,
  operation: string
): {
  executionId: string
  generation: number
  memberId: string
} {
  if (!ctx.executionId || ctx.executionGeneration === undefined || !ctx.memberId) {
    fail(
      'SCOPE_DENIED',
      `${operation} requires an execution-bound worker credential, not an operator/service principal`,
      'none'
    )
  }
  return {
    executionId: ctx.executionId as string,
    generation: ctx.executionGeneration as number,
    memberId: ctx.memberId as string
  }
}

function recordedAcceptance(dispatch: DispatchRow, deliveryId: string | null): unknown {
  return {
    dispatchId: dispatch.id,
    taskId: dispatch.task_id,
    acceptedRevision: dispatch.task_revision,
    dispatchRevision: dispatch.revision,
    phase: dispatch.phase,
    acknowledgedAssignmentDelivery: deliveryId,
    alreadyAccepted: true
  }
}

/**
 * task.accept — commit accept + assignment delivery ack atomically.
 * A second accept with a NEW operationId on an already-accepted dispatch
 * returns the recorded acceptance rather than failing (same payload → same
 * truth; same operationId replays at the registry's idempotency layer).
 */
export function taskAcceptHandler(deps: AcceptOpsDeps = {}): OperationHandler {
  return (txn: TxnContext, raw: unknown): unknown => {
    const { db, ctx } = txn
    const at = now(deps)
    const p = parseAcceptPayload(raw)
    const caller = requireExecutionBound(ctx, 'task.accept')

    const dispatch = loadDispatch(db, p.dispatchId)
    if (!dispatch || dispatch.member_id !== caller.memberId) {
      // existence of other members' dispatches is not disclosed
      fail('SCOPE_DENIED', `dispatch ${p.dispatchId} is not callable by this member`, 'none')
    }
    if (dispatch.execution_id !== caller.executionId || dispatch.generation !== caller.generation) {
      fail(
        'STALE_EXECUTION',
        `dispatch ${p.dispatchId} belongs to execution ${dispatch.execution_id} generation ` +
          `${dispatch.generation}; the caller is bound to ${caller.executionId} generation ${caller.generation}`,
        'reconcile'
      )
    }
    if (dispatch.task_revision !== p.taskRevision) {
      fail(
        'STALE_REVISION',
        `dispatch ${p.dispatchId} is at task revision ${dispatch.task_revision}, not ${p.taskRevision}`,
        'reconcile'
      )
    }
    if (dispatch.envelope_digest !== p.envelopeDigest) {
      fail(
        'ARTIFACT_MISMATCH',
        `dispatch ${p.dispatchId} pins envelope digest ${dispatch.envelope_digest}, not ${p.envelopeDigest}`,
        'reconcile'
      )
    }
    if (dispatch.authority_state !== 'active') {
      fail(
        'INVALID_TRANSITION',
        `dispatch ${p.dispatchId} authority is ${dispatch.authority_state}, not active`,
        'reconcile'
      )
    }

    // join must have completed for THIS generation — accept on an unjoined
    // or past-generation execution is meaningless (spec/injection.md §7).
    if (!loadWorkerJoin(db, caller.executionId, caller.generation)) {
      fail(
        'INVALID_TRANSITION',
        'execution.join has not completed for this generation',
        'same-operation'
      )
    }

    // current grant re-read inside the write tx (S-COMMON §3)
    const execution = loadExecution(db, caller.executionId)
    const member = loadMember(db, caller.memberId)
    const grantBinding = execution ? grantForExecution(db, execution) : null
    requireLiveGrant(grantBinding?.grant ?? null, at, `dispatch ${dispatch.id}`)

    if (dispatch.phase === 'awaiting_accept') {
      const nextRevision = dispatch.revision + 1
      const updated = db
        .prepare(
          `UPDATE dispatches SET phase = 'running', revision = revision + 1
           WHERE id = ? AND phase = 'awaiting_accept' AND authority_state = 'active'`
        )
        .run(dispatch.id)
      if (updated.changes !== 1) {
        fail(
          'INVALID_TRANSITION',
          `dispatch ${dispatch.id} moved out of awaiting_accept`,
          'reconcile'
        )
      }

      let ackedDelivery: string | null = null
      if (dispatch.assignment_delivery_id) {
        const delivery = loadDelivery(db, dispatch.assignment_delivery_id)
        if (!delivery || delivery.recipient_member_id !== caller.memberId) {
          fail(
            'SCOPE_DENIED',
            `assignment delivery for dispatch ${dispatch.id} is not the caller's`,
            'reconcile'
          )
        }
        if (delivery.consumer_generation !== caller.generation) {
          fail(
            'STALE_EXECUTION',
            `assignment delivery ${delivery.id} is stamped for consumer generation ` +
              `${delivery.consumer_generation}, current is ${caller.generation}`,
            'reconcile'
          )
        }
        if (delivery.status !== 'outstanding') {
          fail(
            'INVALID_TRANSITION',
            `assignment delivery ${delivery.id} is ${delivery.status}, not outstanding`,
            'reconcile'
          )
        }
        db.prepare(
          `UPDATE deliveries SET status = 'acknowledged', acked_at = ?, revision = revision + 1
           WHERE id = ? AND status = 'outstanding'`
        ).run(at, delivery.id)
        ackedDelivery = delivery.id
      }

      txn.emitEvent({
        aggregateId: dispatch.id,
        aggregateRevision: nextRevision,
        eventType: 'task.accepted',
        scope: {
          memberId: caller.memberId,
          runId: member?.run_id ?? null,
          taskId: dispatch.task_id
        },
        payload: {
          taskRevision: dispatch.task_revision,
          envelopeDigest: dispatch.envelope_digest,
          acknowledgedAssignmentDelivery: ackedDelivery
        }
      })

      return {
        dispatchId: dispatch.id,
        taskId: dispatch.task_id,
        acceptedRevision: dispatch.task_revision,
        dispatchRevision: nextRevision,
        phase: 'running',
        acknowledgedAssignmentDelivery: ackedDelivery,
        alreadyAccepted: false
      }
    }

    if (dispatch.phase === 'running') {
      // same truth already committed — hand back the recorded acceptance
      return recordedAcceptance(dispatch, dispatch.assignment_delivery_id)
    }

    fail(
      'INVALID_TRANSITION',
      `dispatch ${dispatch.id} is in phase '${dispatch.phase}'; task.accept requires 'awaiting_accept'`,
      dispatch.phase === 'awaiting_join' ? 'same-operation' : 'reconcile'
    )
  }
}

// ---------- admission resolvers (read-only; the pipeline calls authorize) ----------

export function acceptResolveTargets(txn: TxnContext, raw: unknown): TargetRef[] {
  const payload = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const dispatchId = typeof payload.dispatchId === 'string' ? payload.dispatchId : ''
  const dispatch = dispatchId ? loadDispatch(txn.db, dispatchId) : null
  if (!dispatch) return [{ kind: 'dispatch', id: dispatchId }]
  const targets: TargetRef[] = [
    { kind: 'dispatch', id: dispatch.id },
    { kind: 'task', id: dispatch.task_id },
    { kind: 'member', id: dispatch.member_id },
    { kind: 'execution', id: dispatch.execution_id }
  ]
  if (dispatch.assignment_delivery_id) {
    targets.push({ kind: 'delivery', id: dispatch.assignment_delivery_id })
  }
  return targets
}

export function acceptResolveRevisions(
  txn: TxnContext,
  entityIds: readonly string[]
): Record<string, number | undefined> {
  return revisionsOf(txn.db, entityIds)
}
