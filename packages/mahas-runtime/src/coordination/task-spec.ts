// mahas-runtime / coordination — Task identity vs immutable TaskSpec revisions.
//
// IMP-14 (dispatch side of C-WORK). Two separate stored things:
//   tasks      — the durable Task identity + CURRENT pointers
//                (current_revision, current_dispatch_id). Mutable pointers,
//                moved only inside a transaction.
//   task_specs — one immutable row per (task_id, revision). A Dispatch always
//                pins an exact taskId+taskRevision — never "latest". When a
//                requirement changes we INSERT a new revision row and move the
//                pointer; the revision an active Dispatch already references is
//                never rewritten (D-WORK §3: "active Dispatch가 참조하는
//                TaskSpec은 수정하지 않는다").
//
// Storage contract: spec/storage.md §3 tables `tasks`, `task_specs`.
// All functions run inside the caller's transaction (registry op handler or
// withTx) — they never open their own.

import type { DatabaseSync } from 'node:sqlite'
import { appendDomainEvent } from '../storage/db.ts'
import { fail, one, run, toTask, toTaskSpec } from './internal.ts'
import type { Task, TaskSpec } from '../../../mahas-contracts/src/work.ts'

// ── reads ─────────────────────────────────────────────────────────────────

/** Task identity row (current pointers), or null when unknown. */
export function getTask(db: DatabaseSync, taskId: string): Task | null {
  const r = one(db, 'SELECT * FROM tasks WHERE id = ?', taskId)
  return r ? toTask(r) : null
}

/**
 * Exact TaskSpec revision — the only way a Dispatch may reference a spec.
 * Returns null when the task or that revision does not exist.
 */
export function getTaskSpec(db: DatabaseSync, taskId: string, revision: number): TaskSpec | null {
  const r = one(db, 'SELECT * FROM task_specs WHERE task_id = ? AND revision = ?', taskId, revision)
  return r ? toTaskSpec(r) : null
}

/** Task joined with its CURRENT TaskSpec revision — convenience for services. */
export function getCurrentTaskSpec(
  db: DatabaseSync,
  taskId: string
): { task: Task; spec: TaskSpec } | null {
  const task = getTask(db, taskId)
  if (!task) return null
  const spec = getTaskSpec(db, taskId, task.currentRevision as unknown as number)
  if (!spec) return null
  return { task, spec }
}

// ── writes ────────────────────────────────────────────────────────────────

export interface TaskSpecContent {
  title: string
  requirementText: string
  ownerRoleId: string
  assignedMemberId?: string | null
  /** InputBinding[] — persisted verbatim into inputs_json */
  inputBindings?: unknown[]
  /** OutputSlot[] — persisted verbatim into outputs_json */
  outputSlots?: unknown[]
  /** settlement policy JSON — persisted verbatim */
  settlementPolicy?: unknown
}

/**
 * Create a Task identity plus its first immutable TaskSpec revision.
 * current_dispatch_id starts NULL — only reserveDispatch moves it.
 */
export function createTask(
  db: DatabaseSync,
  input: { taskId: string; runId: string } & TaskSpecContent
): { task: Task; spec: TaskSpec } {
  if (getTask(db, input.taskId)) {
    fail('OPERATION_CONFLICT', `task ${input.taskId} already exists`, 'none', {
      taskId: input.taskId
    })
  }
  run(
    db,
    'INSERT INTO tasks (id, run_id, current_revision, current_dispatch_id) VALUES (?, ?, 1, NULL)',
    input.taskId,
    input.runId
  )
  insertSpecRow(db, input.taskId, 1, input)
  appendDomainEvent(
    db,
    input.taskId,
    1,
    'task.created',
    { runId: input.runId },
    { revision: 1, title: input.title }
  )
  return { task: getTask(db, input.taskId)!, spec: getTaskSpec(db, input.taskId, 1)! }
}

/**
 * Append a new immutable TaskSpec revision and move the current_revision
 * pointer (CAS on expectedCurrentRevision when given).
 *
 * Pointer distinction this preserves (instruction §4.5): an active Dispatch
 * still pins its own task_revision, so a kept attempt continues to validate
 * against the revision it was dispatched under — its result is never adopted
 * by the new requirement revision. Disposition of that attempt (keep/fence)
 * is the caller's explicit choice, applied in the same transaction by the op
 * layer (dispatch-ops 'taskSpec.revise').
 */
export function putTaskSpecRevision(
  db: DatabaseSync,
  taskId: string,
  input: TaskSpecContent & { expectedCurrentRevision?: number }
): { task: Task; spec: TaskSpec } {
  const task = getTask(db, taskId)
  if (!task) fail('INVALID_TRANSITION', `task ${taskId} does not exist`, 'none', { taskId })
  const current = task.currentRevision as unknown as number
  if (input.expectedCurrentRevision !== undefined && input.expectedCurrentRevision !== current) {
    fail(
      'STALE_REVISION',
      `task ${taskId} current revision is ${current}, expected ${input.expectedCurrentRevision}`,
      'none',
      {
        taskId,
        currentRevision: current,
        expectedCurrentRevision: input.expectedCurrentRevision
      }
    )
  }
  const next = current + 1
  insertSpecRow(db, taskId, next, input)
  run(db, 'UPDATE tasks SET current_revision = ? WHERE id = ?', next, taskId)
  appendDomainEvent(
    db,
    taskId,
    next,
    'taskSpec.revised',
    { runId: task.runId },
    { revision: next, supersedes: current }
  )
  return { task: getTask(db, taskId)!, spec: getTaskSpec(db, taskId, next)! }
}

function insertSpecRow(
  db: DatabaseSync,
  taskId: string,
  revision: number,
  c: TaskSpecContent
): void {
  run(
    db,
    'INSERT INTO task_specs (task_id, revision, title, requirement_text, owner_role_id,' +
      ' assigned_member_id, inputs_json, outputs_json, settlement_policy_json)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    taskId,
    revision,
    c.title,
    c.requirementText,
    c.ownerRoleId,
    c.assignedMemberId ?? null,
    JSON.stringify(c.inputBindings ?? []),
    JSON.stringify(c.outputSlots ?? []),
    JSON.stringify(c.settlementPolicy ?? null)
  )
}
