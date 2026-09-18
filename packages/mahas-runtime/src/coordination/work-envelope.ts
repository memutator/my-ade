// mahas-runtime / coordination — WorkEnvelope construction and pinning.
//
// IMP-14 (dispatch side of C-WORK). A WorkEnvelope is the authoritative text
// of THIS attempt: the current requirement body, the work scope, the exact
// input pins, the peer relations and the output/report conditions — written
// into content_blobs so a digest addresses actual bytes, never a reference
// (REQ-07: the requirement text must be part of the initial input; a blob
// digest is not the text, it pins it).
//
// Two kinds, mirroring assignments.kind:
//   'task'         — carries the TaskSpec revision's requirementText + scope +
//                    pinned inputs + peers + report contract for one dispatch.
//   'coordination' — carries the Run mandate + role context for a coordinator
//                    spawned without a Task. It NEVER fabricates a task or a
//                    dispatch row (instruction §4.4).
//
// Envelope digest = sha256 over canonical JSON of
//   { kind, assignmentId, assignmentRevision, bodyDigest, bindings }
// — deterministic for identical inputs, so a rebuild reproduces the digest
// and the row dedups on its PRIMARY KEY.
//
// Storage contract: spec/storage.md §3 — work_envelopes, content_blobs,
// assignments, members, runs, tasks, task_specs (reads).

import type { DatabaseSync } from 'node:sqlite'
import { appendDomainEvent, putContentBlob, sha256Hex } from '../storage/db.ts'
import { canonicalJson, fail, one, toAssignment, toMember } from './internal.ts'
import { getTask, getTaskSpec } from './task-spec.ts'
import { pinInputs } from './input-resolver.ts'
import type { ArtifactRef } from '../../../mahas-contracts/src/common.ts'
import type { WorkEnvelope } from '../../../mahas-contracts/src/work.ts'

export const ENVELOPE_MEDIA_TYPE = 'application/json;profile=mahas.work-envelope'

export interface PeerRef {
  memberId: string
  roleId?: string
  taskId?: string
}

export interface StoredEnvelope {
  digest: string
  kind: 'task' | 'coordination'
  assignmentId: string
  assignmentRevision: number
  bodyDigest: string
  /** parsed bindings_json — resolved inputs, peers, linkage fields */
  bindings: Record<string, unknown>
  /** parsed body document — the pinned text itself */
  body: Record<string, unknown>
  /** domain-shaped view per D-ROLE §2 */
  envelope: WorkEnvelope
}

function storeEnvelope(
  db: DatabaseSync,
  kind: 'task' | 'coordination',
  assignmentId: string,
  assignmentRevision: number,
  body: Record<string, unknown>,
  bindings: Record<string, unknown>
): StoredEnvelope {
  const bodyBytes = new TextEncoder().encode(canonicalJson(body))
  const bodyRef = putContentBlob(db, bodyBytes, ENVELOPE_MEDIA_TYPE)
  const digest = sha256Hex(canonicalJson({ kind, assignmentId, assignmentRevision, bodyDigest: bodyRef.digest, bindings }))
  db.prepare(
    'INSERT OR IGNORE INTO work_envelopes (digest, assignment_id, assignment_revision, kind, body_digest, bindings_json)' +
      ' VALUES (?, ?, ?, ?, ?, ?)'
  ).run(digest, assignmentId, assignmentRevision, kind, bodyRef.digest, canonicalJson(bindings))
  appendDomainEvent(db, digest, 1, 'envelope.pinned', { kind, assignmentId, assignmentRevision }, { bodyDigest: bodyRef.digest })
  return {
    digest,
    kind,
    assignmentId,
    assignmentRevision,
    bodyDigest: bodyRef.digest,
    bindings,
    body,
    envelope: {
      digest,
      kind,
      runId: body.runId,
      memberId: body.memberId,
      taskRevision: body.taskRevision ?? undefined,
      dispatchId: body.dispatchId ?? undefined,
      currentRequirementText: body.requirementText ?? body.mandateText,
      inputBindings: bindings.inputs,
      peers: bindings.peers,
      reportContract: bindings.reportContract
    } as unknown as WorkEnvelope
  }
}

/** TaskSpec JSON fields are mapped by internal.toTaskSpec as inputs/outputs —
 *  tolerate the D-WORK names (inputBindings/outputSlots) too until IMP-02's
 *  canonical field names land. */
function specField(spec: unknown, ...names: string[]): unknown {
  const o = spec as Record<string, unknown>
  for (const n of names) if (o[n] !== undefined) return o[n]
  return undefined
}

/**
 * Pin a task-kind WorkEnvelope: resolves this TaskSpec revision's inputs to
 * exact refs (INPUT_NOT_READY on unresolved required slots) and writes the
 * requirement body + scope + peers + report contract into content_blobs.
 *
 * `dispatchId` is optional because worker.prepare pins the envelope BEFORE
 * the dispatch row exists; task.dispatch (same-transaction creation) passes
 * it so the envelope body names its attempt.
 */
export function buildTaskEnvelope(
  db: DatabaseSync,
  input: {
    assignmentId: string
    assignmentRevision: number
    taskId: string
    taskRevision: number
    dispatchId?: string
    peers?: PeerRef[]
    inputOverrides?: Readonly<Record<string, ArtifactRef>>
  }
): StoredEnvelope {
  const arow = one(
    db,
    'SELECT * FROM assignments WHERE id = ? AND revision = ?',
    input.assignmentId,
    input.assignmentRevision
  )
  if (!arow) {
    fail('INVALID_TRANSITION', `assignment ${input.assignmentId}@${input.assignmentRevision} does not exist`, 'none', {
      assignmentId: input.assignmentId
    })
  }
  const assignment = toAssignment(arow!)
  if ((assignment.kind as unknown as string) !== 'task') {
    fail('INVALID_TRANSITION', `assignment ${input.assignmentId}@${input.assignmentRevision} is kind '${assignment.kind}', not 'task'`, 'none', {
      assignmentId: input.assignmentId
    })
  }
  if (
    (assignment.taskId as unknown as string | undefined) !== input.taskId ||
    (assignment.taskRevision as unknown as number | undefined) !== input.taskRevision
  ) {
    fail(
      'INVALID_TRANSITION',
      `assignment ${input.assignmentId}@${input.assignmentRevision} does not cover task ${input.taskId}@${input.taskRevision}`,
      'none',
      {
        assignmentId: input.assignmentId,
        assignmentTask: assignment.taskId,
        assignmentTaskRevision: assignment.taskRevision,
        taskId: input.taskId,
        taskRevision: input.taskRevision
      }
    )
  }
  const mrow = one(db, 'SELECT * FROM members WHERE id = ?', assignment.memberId as unknown as string)
  if (!mrow) fail('INVALID_TRANSITION', `member ${assignment.memberId} does not exist`, 'none', { memberId: assignment.memberId })
  const member = toMember(mrow!)

  const task = getTask(db, input.taskId)
  if (!task) fail('INVALID_TRANSITION', `task ${input.taskId} does not exist`, 'none', { taskId: input.taskId })
  const spec = getTaskSpec(db, input.taskId, input.taskRevision)
  if (!spec) {
    fail('STALE_REVISION', `task ${input.taskId} has no spec revision ${input.taskRevision}`, 'none', {
      taskId: input.taskId,
      taskRevision: input.taskRevision
    })
  }
  const inputs = pinInputs(db, (specField(spec, 'inputs', 'inputBindings') as unknown[]) ?? [], {
    overrides: input.inputOverrides
  })
  const peers = input.peers ?? []
  const reportContract = {
    outputs: specField(spec, 'outputs', 'outputSlots') ?? [],
    settlementPolicy: specField(spec, 'settlementPolicy') ?? null
  }

  const body: Record<string, unknown> = {
    kind: 'task',
    runId: task!.runId,
    memberId: member.id,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    dispatchId: input.dispatchId ?? null,
    title: specField(spec, 'title') ?? null,
    requirementText: specField(spec, 'requirementText') ?? '',
    mandateText: assignment.mandateText,
    scope: assignment.scope,
    inputBindings: inputs,
    peers,
    reportContract
  }
  const bindings: Record<string, unknown> = {
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    dispatchId: input.dispatchId ?? null,
    inputs,
    peers,
    reportContract
  }
  return storeEnvelope(db, 'task', input.assignmentId, input.assignmentRevision, body, bindings)
}

/**
 * Pin a coordination-kind WorkEnvelope for a coordinator spawned without a
 * Task: the Run mandate + goal and the role context go into the body. No
 * task/dispatch fields are fabricated — the body carries `taskId: null`.
 */
export function buildCoordinationEnvelope(
  db: DatabaseSync,
  input: {
    assignmentId: string
    assignmentRevision: number
    roleContext: { roleId: string; implementationId: string; implementationRevision: number; interfaceDigest?: string }
    peers?: PeerRef[]
  }
): StoredEnvelope {
  const arow = one(db, 'SELECT * FROM assignments WHERE id = ? AND revision = ?', input.assignmentId, input.assignmentRevision)
  if (!arow) {
    fail('INVALID_TRANSITION', `assignment ${input.assignmentId}@${input.assignmentRevision} does not exist`, 'none', {
      assignmentId: input.assignmentId
    })
  }
  const assignment = toAssignment(arow!)
  if ((assignment.kind as unknown as string) !== 'coordination') {
    fail(
      'INVALID_TRANSITION',
      `assignment ${input.assignmentId}@${input.assignmentRevision} is kind '${assignment.kind}', not 'coordination'`,
      'none',
      { assignmentId: input.assignmentId }
    )
  }
  const mrow = one(db, 'SELECT * FROM members WHERE id = ?', assignment.memberId as unknown as string)
  if (!mrow) fail('INVALID_TRANSITION', `member ${assignment.memberId} does not exist`, 'none', { memberId: assignment.memberId })
  const member = toMember(mrow!)
  const runRow = one(db, 'SELECT goal_text FROM runs WHERE id = ?', member.runId as unknown as string)

  const body: Record<string, unknown> = {
    kind: 'coordination',
    runId: member.runId,
    memberId: member.id,
    taskId: null,
    taskRevision: null,
    dispatchId: null,
    mandateText: assignment.mandateText,
    goalText: runRow?.goal_text ?? null,
    scope: assignment.scope,
    roleContext: input.roleContext,
    peers: input.peers ?? []
  }
  const bindings: Record<string, unknown> = {
    memberId: member.id,
    roleContext: input.roleContext,
    peers: input.peers ?? []
  }
  return storeEnvelope(db, 'coordination', input.assignmentId, input.assignmentRevision, body, bindings)
}

/** Envelope row + pinned body, or null. */
export function getWorkEnvelope(db: DatabaseSync, digest: string): StoredEnvelope | null {
  const row = one(
    db,
    'SELECT digest, assignment_id, assignment_revision, kind, body_digest, bindings_json FROM work_envelopes WHERE digest = ?',
    digest
  )
  if (!row) return null
  const blob = one(db, 'SELECT body FROM content_blobs WHERE digest = ?', row.body_digest as string)
  const raw = blob?.body
  const body =
    raw instanceof Uint8Array ? (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>) : {}
  const bindings = JSON.parse(row.bindings_json as string) as Record<string, unknown>
  return {
    digest: row.digest as string,
    kind: row.kind as 'task' | 'coordination',
    assignmentId: row.assignment_id as string,
    assignmentRevision: row.assignment_revision as number,
    bodyDigest: row.body_digest as string,
    bindings,
    body,
    envelope: {
      digest: row.digest,
      kind: row.kind,
      runId: body.runId,
      memberId: body.memberId,
      taskRevision: body.taskRevision ?? undefined,
      dispatchId: body.dispatchId ?? undefined,
      currentRequirementText: body.requirementText ?? body.mandateText,
      inputBindings: bindings.inputs,
      peers: bindings.peers,
      reportContract: bindings.reportContract
    } as unknown as WorkEnvelope
  }
}
