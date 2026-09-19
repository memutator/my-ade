// mahas-runtime / coordination — public settlement ops (IMP-21).
//
// Registers task.report, outcome.decide, execution.wake on the operation
// registry. Composition may call registerSettlementOps(registry) directly;
// registerCoordinationOps also invokes it so a locked composition.ts still
// surfaces the handlers.

import type { DatabaseSync } from 'node:sqlite'
import type { OperationRegistry, TxnContext } from '../api/registry.ts'
import type { TargetRef } from '../access/authorize.ts'
import { executionWake, wakeResolveTargets } from '../mail/wake-service.ts'
import {
  advanceDispatchPhase,
  settleDispatch,
  type DispatchPhase
} from './dispatch-authority.ts'
import { recordAcceptedHandoff } from './handoff.ts'
import { fail } from './internal.ts'
import {
  assertReportOutputs,
  insertOutcomeRevision,
  isOwnerDeclaration,
  normalizeResult,
  parseTaskReportPayload,
  policyOf,
  requireActiveAttempt,
  type ReportedOutput
} from './outcome.ts'
import {
  assertDesignatedAcceptor,
  insertSettlement,
  isAccepting,
  loadSettlement,
  normalizeDecision,
  parseOutcomeDecidePayload,
  requireExactOutcome
} from './settlement.ts'
import { getTaskSpec } from './task-spec.ts'
import { computeEligibility } from './eligibility.ts'

function asObj(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

function reportResolveTargets(txn: TxnContext, raw: unknown): TargetRef[] {
  const p = asObj(raw)
  const dispatchId = typeof p.dispatchId === 'string' ? p.dispatchId : ''
  const targets: TargetRef[] = []
  if (dispatchId) targets.push({ kind: 'dispatch', id: dispatchId })
  const row = dispatchId
    ? (txn.db
        .prepare('SELECT task_id, member_id, execution_id FROM dispatches WHERE id = ?')
        .get(dispatchId) as
        | { task_id: string; member_id: string; execution_id: string }
        | undefined)
    : undefined
  if (row) {
    targets.push({ kind: 'task', id: row.task_id })
    targets.push({ kind: 'member', id: row.member_id })
    targets.push({ kind: 'execution', id: row.execution_id })
  }
  return targets
}

function decideResolveTargets(txn: TxnContext, raw: unknown): TargetRef[] {
  const p = asObj(raw)
  const outcomeId = typeof p.outcomeId === 'string' ? p.outcomeId : ''
  const targets: TargetRef[] = []
  if (outcomeId) targets.push({ kind: 'outcome', id: outcomeId })
  const row = outcomeId
    ? (txn.db
        .prepare('SELECT task_id, dispatch_id FROM outcomes WHERE id = ? ORDER BY revision DESC LIMIT 1')
        .get(outcomeId) as { task_id: string; dispatch_id: string } | undefined)
    : undefined
  if (row) {
    targets.push({ kind: 'task', id: row.task_id })
    targets.push({ kind: 'dispatch', id: row.dispatch_id })
  }
  return targets
}

function moveTowardReported(db: DatabaseSync, dispatchId: string, phase: DispatchPhase): void {
  if (phase === 'running') advanceDispatchPhase(db, dispatchId, 'reported')
}

function acceptAndHandoff(
  db: DatabaseSync,
  args: {
    dispatchId: string
    memberId: string
    outcomeId: string
    outcomeRevision: number
    outputs: ReportedOutput[]
    reason: string
  }
): ReturnType<typeof insertSettlement> {
  const settlement = insertSettlement(db, {
    outcomeId: args.outcomeId,
    outcomeRevision: args.outcomeRevision,
    authorityMemberId: args.memberId,
    decision: 'accepted',
    reason: args.reason
  })
  settleDispatch(db, args.dispatchId)
  if (args.outputs.length > 0) {
    recordAcceptedHandoff(db, {
      fromDispatchId: args.dispatchId,
      outputs: args.outputs,
      acceptedOutcomeRevision: args.outcomeRevision,
      outcomeId: args.outcomeId
    })
  }
  return settlement
}

function taskReport(txn: TxnContext, raw: unknown): unknown {
  const op = 'task.report'
  const input = parseTaskReportPayload(raw)
  if (input.taskRevision < 0) {
    fail('MODEL_INVALID', `${op}: 'taskRevision' must be a positive integer`, 'none')
  }
  const { dispatch, spec } = requireActiveAttempt(txn.db, {
    dispatchId: input.dispatchId,
    taskRevision: input.taskRevision,
    envelopeDigest: input.envelopeDigest,
    executionId: txn.ctx.executionId ? String(txn.ctx.executionId) : undefined,
    generation:
      txn.ctx.executionGeneration !== undefined ? Number(txn.ctx.executionGeneration) : undefined
  })
  if (txn.ctx.memberId && String(txn.ctx.memberId) !== String(dispatch.memberId)) {
    fail(
      'SCOPE_DENIED',
      `${op}: dispatch ${dispatch.id} belongs to member ${dispatch.memberId}, not ${txn.ctx.memberId}`,
      'none'
    )
  }
  const phase = dispatch.phase as DispatchPhase
  if (phase !== 'running' && phase !== 'reported') {
    fail(
      'INVALID_TRANSITION',
      `dispatch ${dispatch.id} (phase=${phase}) cannot report — need running or reported`,
      'none',
      { dispatchId: String(dispatch.id), phase }
    )
  }

  const result = normalizeResult(input.result)
  const outputs = assertReportOutputs(txn.db, dispatch, spec, result, input.outputs, op)
  const stored = insertOutcomeRevision(txn.db, {
    taskId: String(dispatch.taskId),
    taskRevision: Number(dispatch.taskRevision),
    dispatchId: String(dispatch.id),
    result,
    rationale: input.rationale,
    assessment: input.criterionAssessment,
    outputs,
    contractEffects: input.contractEffects
  })
  moveTowardReported(txn.db, String(dispatch.id), phase)

  const policy = policyOf(spec)
  let settlement = loadSettlement(txn.db, String(stored.outcome.id), Number(stored.outcome.revision))
  let handoff: unknown = null
  if (isOwnerDeclaration(policy)) {
    settlement = acceptAndHandoff(txn.db, {
      dispatchId: String(dispatch.id),
      memberId: String(dispatch.memberId),
      outcomeId: String(stored.outcome.id),
      outcomeRevision: Number(stored.outcome.revision),
      outputs,
      reason: 'owner-declaration'
    })
    handoff = { recorded: outputs.length > 0 }
  }

  return {
    outcome: stored.outcome,
    outcomeId: stored.outcome.id,
    outcomeRevision: stored.outcome.revision,
    settlement: settlement ?? { state: 'pending', policy: policyOf(spec) },
    settlementState: settlement ? settlement.decision : 'pending',
    handoffEvents: handoff
  }
}

function outcomeDecide(txn: TxnContext, raw: unknown): unknown {
  const op = 'outcome.decide'
  const input = parseOutcomeDecidePayload(raw)
  const outcome = requireExactOutcome(txn.db, input, op)
  const spec = getTaskSpec(txn.db, String(outcome.taskId), Number(outcome.taskRevision))
  if (!spec) {
    fail(
      'STALE_REVISION',
      `${op}: task ${outcome.taskId} spec revision ${outcome.taskRevision} is gone`,
      'none'
    )
  }
  const policy = policyOf(spec)
  const authorityMemberId = assertDesignatedAcceptor(txn.db, txn.ctx, policy, op)
  const decision = normalizeDecision(input.decision)

  const settlement = insertSettlement(txn.db, {
    outcomeId: String(outcome.id),
    outcomeRevision: Number(outcome.revision),
    authorityMemberId,
    decision,
    reason: input.reason
  })

  const outputs = (outcome.outputRefs ?? []).map((r) => ({
    slot: '',
    artifactId: String(r.artifactId),
    artifactRevision: Number(r.revision),
    digest: r.digest
  }))
  // recover slot names from outcome_outputs (outputRefs may omit them)
  const rows = txn.db
    .prepare(
      'SELECT slot, artifact_id, artifact_revision FROM outcome_outputs WHERE outcome_id = ? AND outcome_revision = ?'
    )
    .all(String(outcome.id), Number(outcome.revision)) as {
    slot: string
    artifact_id: string
    artifact_revision: number
  }[]
  const slotted: ReportedOutput[] = rows.map((r) => ({
    slot: r.slot,
    artifactId: r.artifact_id,
    artifactRevision: r.artifact_revision
  }))

  if (isAccepting(decision)) {
    settleDispatch(txn.db, String(outcome.dispatchId))
    if (slotted.length > 0) {
      recordAcceptedHandoff(txn.db, {
        fromDispatchId: String(outcome.dispatchId),
        outputs: slotted,
        acceptedOutcomeRevision: Number(outcome.revision),
        outcomeId: String(outcome.id)
      })
    }
  }

  const task = txn.db
    .prepare('SELECT run_id FROM tasks WHERE id = ?')
    .get(String(outcome.taskId)) as { run_id?: string } | undefined
  const run = task?.run_id
    ? (txn.db
        .prepare('SELECT current_plan_revision FROM runs WHERE id = ?')
        .get(task.run_id) as { current_plan_revision?: number } | undefined)
    : undefined
  const eligibility =
    task?.run_id && typeof run?.current_plan_revision === 'number'
      ? computeEligibility(txn.db, task.run_id, run.current_plan_revision)
      : []

  return {
    settlement,
    eligibility,
    decision: settlement.decision,
    outputs: slotted.length > 0 ? slotted : outputs
  }
}

function executionWakeHandler(txn: TxnContext, raw: unknown): unknown {
  return executionWake(txn.db, raw, txn.ctx)
}

function wakeTargets(txn: TxnContext, raw: unknown): TargetRef[] {
  return wakeResolveTargets(txn.db, raw)
}

/**
 * Register task.report, outcome.decide, execution.wake. All three mutate and
 * resolve actual targets from the payload (never from caller intent alone).
 */
export function registerSettlementOps(registry: OperationRegistry): void {
  registry.register(
    {
      name: 'task.report',
      visibility: 'member',
      mutation: true,
      summary: 'declare an Outcome on the current authoritative Dispatch',
      inputSchema: {
        type: 'object',
        required: ['dispatchId', 'taskRevision', 'result'],
        properties: {
          dispatchId: { type: 'string' },
          taskRevision: { type: 'integer' },
          envelopeDigest: { type: 'string' },
          result: { type: 'string' },
          rationale: { type: 'string' },
          criterionAssessment: { type: 'array' },
          outputs: { type: 'array' },
          contractEffects: {}
        }
      },
      resolveTargets: reportResolveTargets
    },
    taskReport
  )
  registry.register(
    {
      name: 'outcome.decide',
      visibility: 'member',
      mutation: true,
      summary: 'accept or reject an exact Outcome revision (designated acceptor)',
      inputSchema: {
        type: 'object',
        required: ['outcomeId', 'outcomeRevision', 'decision'],
        properties: {
          outcomeId: { type: 'string' },
          outcomeRevision: { type: 'integer' },
          decision: { type: 'string' },
          reason: { type: 'string' },
          expectedTaskRevision: { type: 'integer' }
        }
      },
      resolveTargets: decideResolveTargets
    },
    outcomeDecide
  )
  registry.register(
    {
      name: 'execution.wake',
      visibility: 'member',
      mutation: true,
      summary: 'deliver an attention pointer for outstanding deliveries (ContinuationGrant gated)',
      inputSchema: {
        type: 'object',
        required: ['memberId', 'deliveryIds'],
        properties: {
          memberId: { type: 'string' },
          deliveryIds: { type: 'array', items: { type: 'string' } },
          continuationGrantId: { type: 'string' },
          expectedExecutionGeneration: { type: 'integer' }
        }
      },
      resolveTargets: wakeTargets
    },
    executionWakeHandler
  )
}
