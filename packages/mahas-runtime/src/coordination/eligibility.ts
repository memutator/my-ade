// coordination/eligibility.ts — eligible/blocked projection for plan tasks.
//
// D-WORK §4: a settled predecessor alone does not make a successor ready —
// every required output slot needs an exact ArtifactRef, and every edge's
// settlementRequirement must hold. This module ONLY projects; nothing here
// auto-dispatches, auto-retries, or mutates state (instruction §4.5).

import type { DatabaseSync } from 'node:sqlite'
import type { Id, ArtifactRef } from '../../../mahas-contracts/src/common.ts'
import type { InputBinding, TaskEdge } from '../../../mahas-contracts/src/work.ts'
import { all, one, toTaskEdge, toTaskSpec } from './internal.ts'

/** display state vocabulary fixed by D-WORK §2 */
export type TaskDisplayState =
  | 'unassigned'
  | 'blocked'
  | 'eligible'
  | 'active'
  | 'reported'
  | 'accepted'
  | 'failed'
  | 'cancelled'

export interface PendingInput {
  slot: string
  kind: string
  reason: string
}

export interface ResolvedInput {
  slot: string
  kind: string
  artifact?: ArtifactRef
  contractId?: string
}

export interface TaskEligibility {
  taskId: Id
  taskRevision: number
  state: TaskDisplayState
  assignedMemberId?: Id
  blockedReasons: string[]
  pendingInputs: PendingInput[]
  resolvedInputs: ResolvedInput[]
}

/** settlementRequirement vocabulary (edge.requirements_json) */
export const SETTLEMENT_ACCEPTED = 'accepted'
export const SETTLEMENT_REPORTED = 'reported'
export const SETTLEMENT_SETTLED = 'settled'

/* ------------------------------------------------------------------ */
/* outcome helpers                                                     */
/* ------------------------------------------------------------------ */

interface OutcomeRow {
  id: string
  revision: number
  taskId: string
  taskRevision: number
  dispatchId: string
}

/** latest outcome reported for a task (any dispatch — newest revision wins) */
function latestOutcome(db: DatabaseSync, taskId: string): OutcomeRow | null {
  const r = one(
    db,
    'SELECT id, revision, task_id AS taskId, task_revision AS taskRevision, dispatch_id AS dispatchId FROM outcomes WHERE task_id=? ORDER BY revision DESC LIMIT 1',
    taskId
  )
  return (r as OutcomeRow | null) ?? null
}

function outcomeOutput(
  db: DatabaseSync,
  outcomeId: string,
  outcomeRevision: number,
  slot: string
): ArtifactRef | null {
  const r = one(
    db,
    'SELECT artifact_id, artifact_revision FROM outcome_outputs WHERE outcome_id=? AND outcome_revision=? AND slot=?',
    outcomeId,
    outcomeRevision,
    slot
  )
  if (!r) return null
  const art = one(
    db,
    'SELECT digest FROM artifacts WHERE id=? AND revision=?',
    r.artifact_id as string,
    r.artifact_revision as number
  )
  if (!art) return null
  return {
    artifactId: r.artifact_id as Id,
    revision: r.artifact_revision as ArtifactRef['revision'],
    digest: art.digest as string
  }
}

function settlementDecision(
  db: DatabaseSync,
  outcomeId: string,
  outcomeRevision: number
): string | null {
  const r = one(
    db,
    'SELECT decision FROM settlements WHERE outcome_id=? AND outcome_revision=?',
    outcomeId,
    outcomeRevision
  )
  return r ? (r.decision as string) : null
}

/**
 * Does one edge's settlement requirement hold for the predecessor's latest
 * outcome? 'accepted' → settlement decision accepted; 'reported' → outcome
 * exists; 'settled' → settlement recorded (any decision) or dispatch settled.
 */
export function edgeSettlementSatisfied(
  db: DatabaseSync,
  edge: TaskEdge
): { ok: boolean; reason?: string } {
  const outcome = latestOutcome(db, edge.predecessorTaskId as string)
  const req = edge.settlementRequirement ?? SETTLEMENT_ACCEPTED
  if (!outcome) {
    return { ok: false, reason: `predecessor ${edge.predecessorTaskId} has no reported outcome` }
  }
  switch (req) {
    case SETTLEMENT_REPORTED:
      return { ok: true }
    case SETTLEMENT_SETTLED: {
      const dec = settlementDecision(db, outcome.id, outcome.revision)
      if (dec !== null) return { ok: true }
      const d = one(db, 'SELECT authority_state FROM dispatches WHERE id=?', outcome.dispatchId)
      if (d && (d.authority_state as string) === 'settled') return { ok: true }
      return { ok: false, reason: `predecessor ${edge.predecessorTaskId} outcome not settled` }
    }
    case SETTLEMENT_ACCEPTED:
    default: {
      const dec = settlementDecision(db, outcome.id, outcome.revision)
      if (dec === 'accepted' || dec === 'accept') return { ok: true }
      return {
        ok: false,
        reason: `predecessor ${edge.predecessorTaskId} outcome not accepted (decision=${dec ?? 'none'})`
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* input binding resolution                                            */
/* ------------------------------------------------------------------ */

/**
 * Resolves InputBindings of a TaskSpec against current outcome/artifact
 * state. kind='task-output' pins to the exact artifact of the producer's
 * latest outcome; 'artifact' validates the pinned artifact exists;
 * 'contract' validates the contract exists in the run's model.
 */
export function resolveInputBindings(
  db: DatabaseSync,
  runId: string,
  modelVersion: string,
  bindings: InputBinding[]
): { resolved: ResolvedInput[]; pending: PendingInput[] } {
  const resolved: ResolvedInput[] = []
  const pending: PendingInput[] = []
  for (const b of bindings) {
    const slot = (b as { slot?: string }).slot ?? ''
    const kind = (b as { kind?: string }).kind ?? ''
    const identity = (b as { identity?: Record<string, unknown> }).identity ?? {}
    const required = (b as { required?: boolean }).required !== false
    switch (kind) {
      case 'artifact': {
        const art = one(
          db,
          'SELECT id, revision, digest, run_id FROM artifacts WHERE id=? AND revision=?',
          identity.artifactId as string,
          identity.revision as number
        )
        if (art) {
          if ((art.run_id as string) !== runId) {
            pending.push({
              slot,
              kind,
              reason: `artifact ${identity.artifactId} belongs to run ${art.run_id}, not ${runId}`
            })
          } else {
            resolved.push({
              slot,
              kind,
              artifact: {
                artifactId: art.id as Id,
                revision: art.revision as ArtifactRef['revision'],
                digest: art.digest as string
              }
            })
          }
        } else if (required) {
          pending.push({
            slot,
            kind,
            reason: `artifact ${identity.artifactId}@${identity.revision} not found`
          })
        }
        break
      }
      case 'task-output': {
        const fromTask = (identity.taskId ?? identity.fromTaskId ?? identity.task) as
          string | undefined
        const outputSlot = (identity.outputSlot ?? identity.output ?? identity.slot) as
          string | undefined
        if (!fromTask || !outputSlot) {
          pending.push({
            slot,
            kind,
            reason: 'task-output binding missing taskId/outputSlot identity'
          })
          break
        }
        const outcome = latestOutcome(db, fromTask)
        const art = outcome ? outcomeOutput(db, outcome.id, outcome.revision, outputSlot) : null
        if (art) {
          resolved.push({ slot, kind, artifact: art })
        } else if (required) {
          pending.push({
            slot,
            kind,
            reason: `task ${fromTask} has no outcome output '${outputSlot}' yet`
          })
        }
        break
      }
      case 'contract': {
        const contractId = (identity.contractId ?? identity.id) as string | undefined
        const c = contractId
          ? one(
              db,
              'SELECT id FROM rdd_contracts WHERE model_version=? AND id=?',
              modelVersion,
              contractId
            )
          : null
        if (c) {
          resolved.push({ slot, kind, contractId })
        } else if (required) {
          pending.push({
            slot,
            kind,
            reason: `contract ${contractId ?? '?'} not in model ${modelVersion}`
          })
        }
        break
      }
      default:
        if (required)
          pending.push({
            slot,
            kind: kind || 'unknown',
            reason: `unknown input binding kind '${kind}'`
          })
    }
  }
  return { resolved, pending }
}

/* ------------------------------------------------------------------ */
/* eligibility projection                                              */
/* ------------------------------------------------------------------ */

/**
 * Per-task projection over a plan revision. Read-only — computes display
 * state from latest TaskSpec + current Dispatch/Settlement per D-WORK §2.
 */
export function computeEligibility(
  db: DatabaseSync,
  runId: string,
  planRevision: number
): TaskEligibility[] {
  const run = one(db, 'SELECT model_version FROM runs WHERE id=?', runId)
  const modelVersion = (run?.model_version as string) ?? ''

  const planTasks = all(
    db,
    'SELECT task_id, task_revision FROM plan_tasks WHERE run_id=? AND plan_revision=?',
    runId,
    planRevision
  )
  const edgeRows = all(
    db,
    'SELECT * FROM task_edges WHERE run_id=? AND plan_revision=?',
    runId,
    planRevision
  ).map(toTaskEdge)
  const inbound = new Map<string, TaskEdge[]>()
  for (const e of edgeRows) {
    const k = e.successorTaskId as string
    inbound.set(k, [...(inbound.get(k) ?? []), e])
  }

  // task-kind assignment rows satisfy the assignee check alongside
  // task_specs.assigned_member_id (an assignment is the binding record)
  const assignedRows = all(
    db,
    "SELECT a.task_id, a.member_id FROM assignments a JOIN members m ON a.member_id=m.id WHERE m.run_id=? AND a.kind='task' AND m.state<>'retired'",
    runId
  )
  const assignedTo = new Map<string, string>()
  for (const r of assignedRows) assignedTo.set(r.task_id as string, r.member_id as string)

  const out: TaskEligibility[] = []
  for (const pt of planTasks) {
    const taskId = pt.task_id as string
    const spec = toTaskSpec(
      one(
        db,
        'SELECT * FROM task_specs WHERE task_id=? AND revision=?',
        taskId,
        pt.task_revision as number
      ) ??
        one(
          db,
          'SELECT s.* FROM task_specs s JOIN tasks t ON s.task_id=t.id AND s.revision=t.current_revision WHERE t.id=?',
          taskId
        )!
    )
    const assignedMemberId =
      (spec.assignedMemberId as Id | undefined) ?? (assignedTo.get(taskId) as Id | undefined)
    const blockedReasons: string[] = []

    // current dispatch decides active/reported/accepted/failed
    const d = one(
      db,
      'SELECT * FROM dispatches WHERE task_id=? ORDER BY revision DESC LIMIT 1',
      taskId
    )
    let state: TaskDisplayState | null = null
    if (d) {
      const authority = d.authority_state as string
      const phase = d.phase as string
      if (authority === 'active') {
        state = phase === 'reported' ? 'reported' : 'active'
      } else if (authority === 'settled') {
        const outcome = latestOutcome(db, taskId)
        const dec = outcome ? settlementDecision(db, outcome.id, outcome.revision) : null
        state =
          dec === 'accepted' || dec === 'accept' ? 'accepted' : dec !== null ? 'failed' : 'reported'
      }
      // 'revoked' attempts leave the task re-projected below (no active attempt)
    }

    const { resolved, pending } = resolveInputBindings(
      db,
      runId,
      modelVersion,
      (spec.inputs as InputBinding[] | null | undefined) ?? []
    )
    for (const pi of pending) blockedReasons.push(`input '${pi.slot}': ${pi.reason}`)

    for (const e of inbound.get(taskId) ?? []) {
      const sat = edgeSettlementSatisfied(db, e)
      if (!sat.ok) blockedReasons.push(sat.reason ?? `edge ${e.predecessorTaskId}→${taskId} unmet`)
      for (const outName of e.requiredOutputNames ?? []) {
        const outcome = latestOutcome(db, e.predecessorTaskId as string)
        const art = outcome ? outcomeOutput(db, outcome.id, outcome.revision, outName) : null
        if (!art)
          blockedReasons.push(`required output '${outName}' of ${e.predecessorTaskId} not pinned`)
      }
    }

    if (state === null) {
      if (assignedMemberId === undefined) state = 'unassigned'
      else if (blockedReasons.length > 0) state = 'blocked'
      else state = 'eligible'
    }

    out.push({
      taskId: taskId as Id,
      taskRevision: spec.revision as number,
      state,
      assignedMemberId,
      blockedReasons,
      pendingInputs: pending,
      resolvedInputs: resolved
    })
  }
  return out
}
