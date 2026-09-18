// mahas-runtime / coordination — Dispatch rows, authority and the attempt
// generation/revision checks.
//
// IMP-14 (dispatch side of C-WORK). A Dispatch is an ATTEMPT on an exact
// taskId+taskRevision — never "the task's latest". Authority is singular:
// the DDL partial-unique indexes make at most one authority_state='active'
// dispatch per task_id and per execution_id. The phase axis
// (reserved→starting→awaiting_join→awaiting_accept→running→reported→settled,
// revoked from anywhere) is the authoritative attempt state — it is NOT the
// execution's OS liveness, which is a separate axis owned elsewhere.
//
// Fencing and settling both release authority: the row keeps its pinned
// revision forever, but authority_state leaves 'active' and the task's
// current_dispatch_id pointer is cleared — so a fenced attempt's late
// accept/report can no longer validate (checkAttemptAuthority throws
// INVALID_TRANSITION on a non-active authority_state before any field check).
//
// Storage contract: spec/storage.md §3 — dispatches (+ its two partial
// unique indexes), tasks.current_dispatch_id, task_specs, members,
// executions, work_envelopes (existence only).

import type { DatabaseSync } from 'node:sqlite'
import { appendDomainEvent } from '../storage/db.ts'
import { fail, one, run, toDispatch } from './internal.ts'
import { getTask, getTaskSpec } from './task-spec.ts'
import type { Dispatch, Task, TaskSpec } from '../../../mahas-contracts/src/work.ts'

export type DispatchPhase =
  | 'reserved'
  | 'starting'
  | 'awaiting_join'
  | 'awaiting_accept'
  | 'running'
  | 'reported'
  | 'settled'
  | 'revoked'

/** legal phase moves — 'revoked' is reachable from any non-terminal phase */
const PHASE_TRANSITIONS: Record<DispatchPhase, readonly DispatchPhase[]> = {
  reserved: ['starting', 'awaiting_join', 'revoked'],
  starting: ['awaiting_join', 'awaiting_accept', 'revoked'],
  awaiting_join: ['awaiting_accept', 'revoked'],
  awaiting_accept: ['running', 'revoked'],
  running: ['reported', 'revoked'],
  reported: ['settled', 'revoked'],
  settled: [],
  revoked: []
}

// ── reads ─────────────────────────────────────────────────────────────────

export function getDispatch(db: DatabaseSync, dispatchId: string): Dispatch | null {
  const r = one(db, 'SELECT * FROM dispatches WHERE id = ?', dispatchId)
  return r ? toDispatch(r) : null
}

/** the ONE authoritative attempt on a task (partial unique index) */
export function getActiveDispatchForTask(db: DatabaseSync, taskId: string): Dispatch | null {
  const r = one(db, "SELECT * FROM dispatches WHERE task_id = ? AND authority_state = 'active'", taskId)
  return r ? toDispatch(r) : null
}

/** the ONE authoritative attempt hosted by an execution (partial unique index) */
export function getActiveDispatchForExecution(db: DatabaseSync, executionId: string): Dispatch | null {
  const r = one(db, "SELECT * FROM dispatches WHERE execution_id = ? AND authority_state = 'active'", executionId)
  return r ? toDispatch(r) : null
}

// ── writes ────────────────────────────────────────────────────────────────

export interface ReserveDispatchInput {
  dispatchId: string
  taskId: string
  /** exact pin — must equal tasks.current_revision at reserve time */
  taskRevision: number
  memberId: string
  executionId: string
  /** expected execution generation — STALE_EXECUTION on mismatch */
  generation: number
  envelopeDigest: string
  assignmentDeliveryId?: string
}

/**
 * Insert the authoritative attempt and point tasks.current_dispatch_id at it,
 * atomically inside the caller's transaction. Re-checks every premise:
 * exact spec revision is current, member belongs to the task's run and (when
 * the spec names an assignee) IS the assignee, the execution is that member's
 * own row at the expected generation, the envelope exists, and no other
 * active dispatch holds the task or the execution (the DDL partial-unique
 * indexes are the backstop — these checks produce the honest conflicts).
 */
export function reserveDispatch(db: DatabaseSync, input: ReserveDispatchInput): Dispatch {
  const task = getTask(db, input.taskId)
  if (!task) fail('INVALID_TRANSITION', `task ${input.taskId} does not exist`, 'none', { taskId: input.taskId })
  const currentRevision = task!.currentRevision as unknown as number
  if (input.taskRevision !== currentRevision) {
    fail(
      'STALE_REVISION',
      `task ${input.taskId} is at revision ${currentRevision}; cannot dispatch pinned revision ${input.taskRevision}`,
      'none',
      { taskId: input.taskId, currentRevision, taskRevision: input.taskRevision }
    )
  }
  const spec = getTaskSpec(db, input.taskId, input.taskRevision)
  if (!spec) {
    fail('STALE_REVISION', `task ${input.taskId} has no spec revision ${input.taskRevision}`, 'none', input)
  }
  const specAssignee = (spec as unknown as Record<string, unknown>).assignedMemberId as string | null | undefined
  if (specAssignee != null && specAssignee !== input.memberId) {
    fail(
      'SCOPE_DENIED',
      `task ${input.taskId}@${input.taskRevision} is assigned to member ${specAssignee}, not ${input.memberId}`,
      'none',
      { taskId: input.taskId, assignedMemberId: specAssignee, memberId: input.memberId }
    )
  }

  const member = one(db, 'SELECT id, run_id, state FROM members WHERE id = ?', input.memberId)
  if (!member) fail('INVALID_TRANSITION', `member ${input.memberId} does not exist`, 'none', { memberId: input.memberId })
  if (member!.run_id !== task!.runId) {
    fail(
      'SCOPE_DENIED',
      `member ${input.memberId} is in run ${member!.run_id}, task ${input.taskId} is in run ${task!.runId}`,
      'none',
      { memberId: input.memberId, memberRun: member!.run_id, taskRun: task!.runId }
    )
  }
  if (member!.state === 'retired') {
    fail('INVALID_TRANSITION', `member ${input.memberId} is retired`, 'none', { memberId: input.memberId })
  }

  const execution = one(db, 'SELECT id, member_id, generation FROM executions WHERE id = ?', input.executionId)
  if (!execution || execution.member_id !== input.memberId || execution.generation !== input.generation) {
    fail(
      'STALE_EXECUTION',
      `execution ${input.executionId} generation ${input.generation} is not a current target for member ${input.memberId}`,
      'none',
      { executionId: input.executionId, generation: input.generation, memberId: input.memberId, found: execution ?? null }
    )
  }

  const envelope = one(db, 'SELECT kind FROM work_envelopes WHERE digest = ?', input.envelopeDigest)
  if (!envelope || envelope.kind !== 'task') {
    fail('ARTIFACT_MISMATCH', `work envelope ${input.envelopeDigest} does not exist or is not task-kind`, 'none', {
      envelopeDigest: input.envelopeDigest
    })
  }

  const onTask = getActiveDispatchForTask(db, input.taskId)
  if (onTask) {
    fail('OPERATION_CONFLICT', `task ${input.taskId} already has active dispatch ${onTask.id}`, 'none', {
      taskId: input.taskId,
      activeDispatchId: onTask.id
    })
  }
  const onExecution = getActiveDispatchForExecution(db, input.executionId)
  if (onExecution) {
    fail('OPERATION_CONFLICT', `execution ${input.executionId} already hosts active dispatch ${onExecution.id}`, 'none', {
      executionId: input.executionId,
      activeDispatchId: onExecution.id
    })
  }

  run(
    db,
    'INSERT INTO dispatches (id, task_id, task_revision, member_id, execution_id, generation,' +
      ' envelope_digest, phase, authority_state, assignment_delivery_id, revision)' +
      " VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', 'active', ?, 1)",
    input.dispatchId,
    input.taskId,
    input.taskRevision,
    input.memberId,
    input.executionId,
    input.generation,
    input.envelopeDigest,
    input.assignmentDeliveryId ?? null
  )
  run(db, 'UPDATE tasks SET current_dispatch_id = ? WHERE id = ?', input.dispatchId, input.taskId)
  appendDomainEvent(
    db,
    input.dispatchId,
    1,
    'dispatch.reserved',
    { taskId: input.taskId, executionId: input.executionId },
    { taskRevision: input.taskRevision, memberId: input.memberId, envelopeDigest: input.envelopeDigest }
  )
  return getDispatch(db, input.dispatchId)!
}

/** attach the assignment Message/Delivery id once mail (IMP-15) has created it */
export function linkAssignmentDelivery(
  db: DatabaseSync,
  dispatchId: string,
  deliveryId: string,
  expectedRevision?: number
): Dispatch {
  const d = mustGet(db, dispatchId)
  casRevision(d, expectedRevision)
  run(db, 'UPDATE dispatches SET assignment_delivery_id = ?, revision = revision + 1 WHERE id = ?', deliveryId, dispatchId)
  return getDispatch(db, dispatchId)!
}

/**
 * Move a dispatch along the phase axis. OS-liveness evidence never appears
 * here — 'revoked' is an authority decision, not a process observation.
 */
export function advanceDispatchPhase(
  db: DatabaseSync,
  dispatchId: string,
  to: DispatchPhase,
  expectedRevision?: number
): Dispatch {
  const d = mustGet(db, dispatchId)
  casRevision(d, expectedRevision)
  const from = d.phase as DispatchPhase
  if (from === to) return d
  if (!PHASE_TRANSITIONS[from].includes(to)) {
    fail('INVALID_TRANSITION', `dispatch ${dispatchId} cannot move ${from} → ${to}`, 'none', { dispatchId, from, to })
  }
  run(db, 'UPDATE dispatches SET phase = ?, revision = revision + 1 WHERE id = ?', to, dispatchId)
  appendDomainEvent(db, dispatchId, d.revision + 1, 'dispatch.phase', { taskId: d.taskId }, { from, to })
  return getDispatch(db, dispatchId)!
}

/**
 * task.accept's dispatch-side effect: the pinned-envelope attempt moves to
 * 'running'. Caller (IMP-20) has already authenticated the join; here we
 * re-verify attempt authority (exact revision + envelope + optional
 * execution/generation) and require the awaiting_accept phase.
 */
export function acceptDispatch(
  db: DatabaseSync,
  dispatchId: string,
  check?: { taskRevision?: number; executionId?: string; generation?: number; envelopeDigest?: string }
): Dispatch {
  checkAttemptAuthority(db, { dispatchId, ...check })
  return advanceDispatchPhase(db, dispatchId, 'running')
}

/**
 * Fence an attempt: authority leaves 'active', phase → 'revoked', the task's
 * current_dispatch_id is cleared if it still points here. Idempotent on an
 * already-revoked dispatch (a fence is a safety net, not a transition);
 * fencing a settled dispatch is INVALID_TRANSITION.
 */
export function fenceDispatch(
  db: DatabaseSync,
  dispatchId: string,
  input?: { reason?: string; expectedRevision?: number }
): Dispatch {
  const d = mustGet(db, dispatchId)
  casRevision(d, input?.expectedRevision)
  if (d.authorityState === 'revoked') return d
  if (d.authorityState === 'settled') {
    fail('INVALID_TRANSITION', `dispatch ${dispatchId} is settled and cannot be fenced`, 'none', { dispatchId })
  }
  run(
    db,
    "UPDATE dispatches SET authority_state = 'revoked', phase = 'revoked', revision = revision + 1 WHERE id = ?",
    dispatchId
  )
  run(db, 'UPDATE tasks SET current_dispatch_id = NULL WHERE id = ? AND current_dispatch_id = ?', d.taskId as string, dispatchId)
  appendDomainEvent(
    db,
    dispatchId,
    d.revision + 1,
    'dispatch.fenced',
    { taskId: d.taskId, executionId: d.executionId },
    { reason: input?.reason ?? null }
  )
  return getDispatch(db, dispatchId)!
}

/**
 * Settle an attempt after its Outcome is decided: authority_state → 'settled',
 * phase → 'settled', task pointer cleared. Idempotent re-settle returns the
 * row unchanged; settling before 'reported' is INVALID_TRANSITION.
 */
export function settleDispatch(db: DatabaseSync, dispatchId: string, expectedRevision?: number): Dispatch {
  const d = mustGet(db, dispatchId)
  casRevision(d, expectedRevision)
  if (d.authorityState === 'settled') return d
  if (d.authorityState !== 'active' || d.phase !== 'reported') {
    fail(
      'INVALID_TRANSITION',
      `dispatch ${dispatchId} (authority=${d.authorityState}, phase=${d.phase}) cannot settle`,
      'none',
      { dispatchId }
    )
  }
  run(
    db,
    "UPDATE dispatches SET authority_state = 'settled', phase = 'settled', revision = revision + 1 WHERE id = ?",
    dispatchId
  )
  run(db, 'UPDATE tasks SET current_dispatch_id = NULL WHERE id = ? AND current_dispatch_id = ?', d.taskId as string, dispatchId)
  appendDomainEvent(db, dispatchId, d.revision + 1, 'dispatch.settled', { taskId: d.taskId }, null)
  return getDispatch(db, dispatchId)!
}

// ── the accept/report authority check ──────────────────────────────────────

export interface AttemptCheck {
  dispatchId: string
  /** caller-claimed spec pin — must equal the dispatch's own task_revision */
  taskRevision?: number
  executionId?: string
  /** caller-claimed execution generation — must equal the dispatch's */
  generation?: number
  /** caller-claimed envelope — must equal the dispatch's pinned digest */
  envelopeDigest?: string
}

/**
 * The function task.accept / task.report (IMP-20/21) gate on. It validates
 * that the named dispatch is still THE authoritative attempt for its exact
 * pinned revision — comparing against dispatch.task_revision, not
 * tasks.current_revision, so an attempt a coordinator explicitly kept across
 * a spec revision stays valid under its own pin while its result can never
 * be adopted by the newer requirement revision.
 *
 * Throws: STALE_REVISION (unknown dispatch or revision mismatch),
 * INVALID_TRANSITION (attempt no longer authoritative / pointer moved),
 * STALE_EXECUTION (execution or generation drift), ARTIFACT_MISMATCH
 * (envelope digest mismatch).
 */
export function checkAttemptAuthority(
  db: DatabaseSync,
  check: AttemptCheck
): { dispatch: Dispatch; task: Task; spec: TaskSpec } {
  const d = getDispatch(db, check.dispatchId)
  if (!d) fail('STALE_REVISION', `dispatch ${check.dispatchId} does not exist`, 'none', { dispatchId: check.dispatchId })

  const authority = (d as unknown as { authorityState: string }).authorityState
  if (authority !== 'active') {
    fail(
      'INVALID_TRANSITION',
      `dispatch ${check.dispatchId} is ${authority} — no longer the authoritative attempt`,
      'none',
      { dispatchId: check.dispatchId, authorityState: authority }
    )
  }

  const task = getTask(db, d!.taskId as unknown as string)
  if (!task || (task.currentDispatchId as unknown as string | null | undefined) !== check.dispatchId) {
    fail('INVALID_TRANSITION', `dispatch ${check.dispatchId} is not the task's current attempt pointer`, 'none', {
      dispatchId: check.dispatchId,
      taskCurrentDispatchId: task?.currentDispatchId ?? null
    })
  }

  const dispatchRevision = d!.taskRevision as unknown as number
  if (check.taskRevision !== undefined && check.taskRevision !== dispatchRevision) {
    fail(
      'STALE_REVISION',
      `dispatch ${check.dispatchId} pins task revision ${dispatchRevision}, caller claimed ${check.taskRevision}`,
      'none',
      { dispatchId: check.dispatchId, dispatchTaskRevision: dispatchRevision, claimedTaskRevision: check.taskRevision }
    )
  }

  if (check.executionId !== undefined && check.executionId !== (d!.executionId as unknown as string)) {
    fail(
      'STALE_EXECUTION',
      `dispatch ${check.dispatchId} belongs to execution ${d!.executionId}, not ${check.executionId}`,
      'none',
      { dispatchId: check.dispatchId, executionId: d!.executionId }
    )
  }
  if (check.generation !== undefined && check.generation !== (d!.generation as unknown as number)) {
    fail(
      'STALE_EXECUTION',
      `dispatch ${check.dispatchId} pins execution generation ${d!.generation}, caller claimed ${check.generation}`,
      'none',
      { dispatchId: check.dispatchId, dispatchGeneration: d!.generation, claimedGeneration: check.generation }
    )
  }
  // paranoid cross-check: the execution row still exists at the pinned generation
  const execution = one(db, 'SELECT generation FROM executions WHERE id = ?', d!.executionId as unknown as string)
  if (!execution || execution.generation !== (d!.generation as unknown as number)) {
    fail(
      'STALE_EXECUTION',
      `execution ${d!.executionId} no longer matches dispatch ${check.dispatchId}'s pinned generation`,
      'none',
      { dispatchId: check.dispatchId, executionId: d!.executionId }
    )
  }

  if (check.envelopeDigest !== undefined && check.envelopeDigest !== (d!.envelopeDigest as unknown as string)) {
    fail(
      'ARTIFACT_MISMATCH',
      `dispatch ${check.dispatchId} pins envelope ${d!.envelopeDigest}, caller claimed ${check.envelopeDigest}`,
      'none',
      { dispatchId: check.dispatchId, envelopeDigest: d!.envelopeDigest }
    )
  }

  const spec = getTaskSpec(db, d!.taskId as unknown as string, dispatchRevision)
  if (!spec) {
    fail(
      'STALE_REVISION',
      `task ${d!.taskId} spec revision ${dispatchRevision} referenced by dispatch is gone`,
      'none',
      { dispatchId: check.dispatchId }
    )
  }
  return { dispatch: d!, task: task!, spec }
}

// ── internals ──────────────────────────────────────────────────────────────

function mustGet(db: DatabaseSync, dispatchId: string): Dispatch {
  const d = getDispatch(db, dispatchId)
  if (!d) fail('STALE_REVISION', `dispatch ${dispatchId} does not exist`, 'none', { dispatchId })
  return d!
}

function casRevision(d: Dispatch, expectedRevision?: number): void {
  const current = (d as unknown as { revision: number }).revision
  if (expectedRevision !== undefined && expectedRevision !== current) {
    fail('STALE_REVISION', `dispatch ${d.id} is at revision ${current}, expected ${expectedRevision}`, 'none', {
      dispatchId: d.id,
      revision: current,
      expectedRevision
    })
  }
}
