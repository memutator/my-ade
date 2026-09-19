// mahas-runtime — maintenance/task-link (IMP-27).
//
// The EXPLICIT connection between an ImpactCandidate and the maintenance work
// that resolves it (IMP-27 §4.4, §6). Two rules dominate:
//
//   - The runtime never creates or rewrites the maintenance work itself.
//     When a maintainer judges that refresh work is needed, a 팀장
//     (coordinator) issues it through the normal explicit Plan/Task
//     operations (plan.prepare / plan.commit / task.dispatch — C-WORK).
//     This module only RECORDS that a candidate is bound to such a
//     pre-existing Task (or other resolution artifact). "runtime이 자기
//     판단으로 내용을 다시 쓰지 않는다".
//
//   - An agent may not update its own active instructions mid-run
//     (REQ-21, instruction §4.5). resolveMemberPins() computes what an
//     active execution pins — bundle interface digest, implementation,
//     role, boundary — and classification.ts refuses self-scoped
//     dismiss/resolve verdicts against those pins under the member's
//     current scope.

import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import {
  inUnit,
  loadCandidate,
  type ImpactCandidateRow,
  type MaintenanceLink,
  type ObserverDeps
} from './basis-observer.ts'
import { fail } from './codec.ts'

/* ------------------------------------------------------------------ *
 * resolution refs — what a `resolved` verdict may point at
 * ------------------------------------------------------------------ */

export type ResolutionRefKind = 'task' | 'plan' | 'implementation' | 'model-change' | 'outcome'

export interface ResolutionRef {
  kind: ResolutionRefKind
  /** taskId | runId | implementationId | changeId | outcomeId */
  id: string
  revision?: number
}

/**
 * Tolerant normalization of a caller-supplied resolutionRef. Accepted
 * shapes: {kind:'task', taskId, revision?}, {kind:'task', id, revision?},
 * {kind:'implementation', implementationId, implementationRevision}, etc.
 */
export function normalizeResolutionRef(raw: unknown): ResolutionRef | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const kindRaw = o.kind ?? o.type
  if (typeof kindRaw !== 'string') return null
  const kind = kindRaw as ResolutionRefKind
  if (!['task', 'plan', 'implementation', 'model-change', 'outcome'].includes(kind)) return null

  const pick = (...names: string[]): unknown => {
    for (const n of names) if (o[n] !== undefined) return o[n]
    return undefined
  }
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined

  switch (kind) {
    case 'task': {
      const id = pick('taskId', 'task_id', 'id')
      const revision = num(pick('taskRevision', 'task_revision', 'revision'))
      return typeof id === 'string' && id.length > 0 ? { kind, id, revision } : null
    }
    case 'plan': {
      const id = pick('runId', 'run_id', 'id')
      const revision = num(pick('planRevision', 'plan_revision', 'revision'))
      return typeof id === 'string' && id.length > 0 && revision !== undefined
        ? { kind, id, revision }
        : null
    }
    case 'implementation': {
      const id = pick('implementationId', 'implementation_id', 'id')
      const revision = num(pick('implementationRevision', 'implementation_revision', 'revision'))
      return typeof id === 'string' && id.length > 0 && revision !== undefined
        ? { kind, id, revision }
        : null
    }
    case 'model-change': {
      const id = pick('changeId', 'change_id', 'id')
      return typeof id === 'string' && id.length > 0 ? { kind, id } : null
    }
    case 'outcome': {
      const id = pick('outcomeId', 'outcome_id', 'id')
      const revision = num(pick('outcomeRevision', 'outcome_revision', 'revision'))
      return typeof id === 'string' && id.length > 0 && revision !== undefined
        ? { kind, id, revision }
        : null
    }
  }
}

/**
 * Existence check for a resolutionRef — the contract requires the ref to
 * actually exist before `resolved` is recorded (C-MODEL model.impact.classify:
 * "resolutionRef 존재 확인"). Read-only FK-style probes against the spec
 * tables; it does NOT judge whether the ref is a *correct* resolution.
 */
export function resolutionRefExists(db: DatabaseSync, ref: ResolutionRef): boolean {
  switch (ref.kind) {
    case 'task': {
      if (ref.revision === undefined) {
        return db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(ref.id) !== undefined
      }
      return (
        db
          .prepare('SELECT 1 FROM task_specs WHERE task_id = ? AND revision = ?')
          .get(ref.id, ref.revision) !== undefined
      )
    }
    case 'plan':
      return (
        db
          .prepare('SELECT 1 FROM plans WHERE run_id = ? AND revision = ?')
          .get(ref.id, ref.revision ?? -1) !== undefined
      )
    case 'implementation':
      return (
        db
          .prepare(
            `SELECT 1 FROM role_implementations
             WHERE id = ? AND revision = ? AND status <> 'retired'`
          )
          .get(ref.id, ref.revision ?? -1) !== undefined
      )
    case 'model-change':
      return db.prepare('SELECT 1 FROM model_changes WHERE id = ?').get(ref.id) !== undefined
    case 'outcome':
      return (
        db
          .prepare('SELECT 1 FROM outcomes WHERE id = ? AND revision = ?')
          .get(ref.id, ref.revision ?? -1) !== undefined
      )
  }
}

/* ------------------------------------------------------------------ *
 * linkMaintenanceTask — bind a candidate to an EXISTING maintenance task
 * ------------------------------------------------------------------ */

export interface LinkInput {
  candidateId: string
  /** the task the coordinator explicitly created for this maintenance work */
  taskRef: unknown // normalized like a 'task' ResolutionRef
  note?: string
}

export interface LinkResult {
  candidateId: string
  revision: number
  linkCount: number
}

/**
 * Record an explicit candidate -> maintenance-Task association. Verifies
 * both sides exist; stores the link inside resolution_json.links (the row's
 * decision fields stay untouched — linking is not classification).
 *
 * Callable inside a coordinator's transaction (composition wiring) or
 * standalone. Never creates the Task itself.
 */
export function linkMaintenanceTask(
  db: DatabaseSync,
  input: LinkInput,
  ctx: Pick<AuthenticatedContext, 'principalId'>,
  deps: ObserverDeps = {}
): LinkResult {
  const ref = normalizeResolutionRef(input.taskRef)
  if (ref === null || ref.kind !== 'task') {
    fail(
      'MODEL_INVALID',
      'taskRef must reference an existing task ({kind:"task", taskId, revision?})'
    )
  }
  if (!resolutionRefExists(db, ref)) {
    fail(
      'MODEL_INVALID',
      `maintenance task ${ref.id} does not exist — create it via plan/task operations first`
    )
  }
  return inUnit(db, (tx) => {
    const candidate = loadCandidate(tx, input.candidateId)
    if (candidate === null) {
      fail('INVALID_TRANSITION', `impact candidate ${input.candidateId} not found`)
    }
    if (candidate.state === 'resolved' || candidate.state === 'dismissed') {
      fail(
        'INVALID_TRANSITION',
        `cannot link maintenance work to a ${candidate.state} candidate — classify it first`
      )
    }
    const links: MaintenanceLink[] = Array.isArray(candidate.resolution.links)
      ? [...candidate.resolution.links]
      : []
    if (!links.some((l) => l.kind === 'task' && l.id === ref.id && l.revision === ref.revision)) {
      links.push({
        kind: 'task',
        id: ref.id,
        revision: ref.revision,
        linkedBy: String(ctx.principalId),
        linkedAt: (deps.now ?? Date.now)(),
        ...(input.note === undefined ? {} : { note: input.note })
      })
    }
    const resolution = { ...candidate.resolution, links }
    const newRevision = candidate.revision + 1
    const changed = tx
      .prepare(
        `UPDATE impact_candidates
         SET resolution_json = ?, revision = ?
         WHERE id = ? AND revision = ?`
      )
      .run(JSON.stringify(resolution), newRevision, candidate.id, candidate.revision)
    if (Number(changed.changes) === 0) {
      fail('STALE_REVISION', `candidate ${candidate.id} changed concurrently`)
    }
    tx.prepare(
      `INSERT INTO domain_events (aggregate_id, aggregate_revision, event_type, scope_json, payload_json)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      candidate.id,
      newRevision,
      'ImpactCandidateLinked',
      JSON.stringify({
        projectId: candidate.reason.scope?.projectId ?? null,
        modelVersion: candidate.reason.scope?.modelVersion ?? null
      }),
      JSON.stringify({ candidateId: candidate.id, taskRef: ref, linkedBy: String(ctx.principalId) })
    )
    return { candidateId: candidate.id, revision: newRevision, linkCount: links.length }
  })
}

/* ------------------------------------------------------------------ *
 * member pin resolution — the self-active-instruction guard input
 * ------------------------------------------------------------------ */

export interface MemberPins {
  memberId: string
  roleId?: string
  boundaryId?: string
  implementationId?: string
  implementationRevision?: number
  /** bundle interface digest pinned by the live execution's launch plan */
  interfaceDigest?: string
  /** member has a live/unverifiable current execution */
  active: boolean
}

/**
 * What an active member currently pins. The member's execution -> launch
 * plan -> bundle chain is authoritative; an 'unverifiable' liveness still
 * counts as pinned (the pin may only be dropped on proven exit — the same
 * conservatism the runtime applies to bundle GC).
 */
export function resolveMemberPins(db: DatabaseSync, memberId: string): MemberPins | null {
  const member = db
    .prepare(
      `SELECT m.id, m.role_id, m.model_version, m.implementation_id, m.implementation_revision,
              m.current_execution_id,
              r.boundary_id AS role_boundary_id
       FROM members m
       LEFT JOIN rdd_roles r ON r.model_version = m.model_version AND r.id = m.role_id
       WHERE m.id = ?`
    )
    .get(memberId) as
    | {
        id: string
        role_id: string
        model_version: string
        implementation_id: string
        implementation_revision: number
        current_execution_id: string | null
        role_boundary_id: string | null
      }
    | undefined
  if (member === undefined) return null

  const pins: MemberPins = {
    memberId,
    roleId: member.role_id,
    boundaryId: member.role_boundary_id ?? undefined,
    implementationId: member.implementation_id,
    implementationRevision: member.implementation_revision,
    active: false
  }
  if (member.current_execution_id === null) return pins

  const exec = db
    .prepare(
      `SELECT e.liveness, lp.bundle_digest, cb.interface_digest
       FROM executions e
       LEFT JOIN launch_plans lp ON lp.id = e.launch_plan_id
       LEFT JOIN context_bundles cb ON cb.digest = lp.bundle_digest
       WHERE e.id = ?`
    )
    .get(member.current_execution_id) as
    { liveness: string; bundle_digest: string | null; interface_digest: string | null } | undefined
  if (exec === undefined) return pins

  pins.interfaceDigest = exec.interface_digest ?? undefined
  // 'live' or 'unverifiable' — only a proven 'exited' drops the pin
  pins.active = exec.liveness === 'live' || exec.liveness === 'unverifiable'
  return pins
}

/**
 * Does this candidate's target touch the member's own pinned instruction
 * set? Used to refuse self-scoped dismiss/resolve verdicts (REQ-21 — the
 * running agent is never the refresher of its own active instructions).
 */
export function candidateTouchesPins(candidate: ImpactCandidateRow, pins: MemberPins): boolean {
  switch (candidate.targetKind) {
    case 'implementation':
      return pins.implementationId !== undefined && candidate.targetId === pins.implementationId
    case 'interface':
      return pins.interfaceDigest !== undefined && candidate.targetId === pins.interfaceDigest
    case 'role':
      return pins.roleId !== undefined && candidate.targetId === pins.roleId
    case 'boundary':
      return pins.boundaryId !== undefined && candidate.targetId === pins.boundaryId
  }
}
