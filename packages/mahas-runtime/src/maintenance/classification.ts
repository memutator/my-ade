// mahas-runtime — maintenance/classification (IMP-27).
//
// The JUDGMENT half of model.impact.classify (spec/contracts/model.md):
// the designated maintainer classifies a raised ImpactCandidate as
// confirmed | dismissed | resolved, with a rationale and — for resolved —
// a real resolutionRef. Recording the decision is ALL this does:
//   - no instruction/Task is created or executed here ("분류 + receipt.
//     지침/Task 생성 자동 실행 없음");
//   - detection (basis-observer) and refresh (the separate maintenance
//     Task) stay separate responsible-party work (REQ-21);
//   - an agent may not dismiss/resolve staleness against the instructions
//     its own live execution pins — self-refresh under the current scope
//     is denied ("agent의 자기 지침 갱신 요청은 current scope로 거부").

import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import {
  fail,
  loadCandidate,
  type CandidateResolution,
  type ImpactCandidateState,
  type ObserverDeps
} from './basis-observer.ts'
import {
  candidateTouchesPins,
  normalizeResolutionRef,
  resolutionRefExists,
  resolveMemberPins
} from './task-link.ts'

export type ClassifyDecision = 'confirmed' | 'dismissed' | 'resolved'

export interface ClassifyInput {
  candidateId: string
  expectedRevision: number
  decision: ClassifyDecision
  rationale: string
  resolutionRef?: unknown
}

export interface ClassifyResult {
  candidateId: string
  state: ImpactCandidateState
  revision: number
}

/** authorize dep — IMP-10's authorize(ctx, operation, targets) signature */
export type AuthorizeFn = (
  ctx: AuthenticatedContext,
  operation: string,
  targets: { kind: string; id: string }[]
) => void

export interface ClassifyDeps extends ObserverDeps {
  authorize: AuthorizeFn
}

/**
 * Permitted state transitions. 'resolved' is terminal — a new change raises
 * a NEW candidate rather than reopening a resolved one. 'dismissed' may be
 * re-judged (a maintainer can revisit a dismissal), 'confirmed' may settle
 * either way. The same verdict re-applied to its own state is a no-op
 * transition and is rejected — re-classify only to CHANGE the judgment.
 */
const ALLOWED: Record<ImpactCandidateState, readonly ClassifyDecision[]> = {
  candidate: ['confirmed', 'dismissed', 'resolved'],
  confirmed: ['dismissed', 'resolved'],
  dismissed: ['confirmed', 'resolved'],
  resolved: []
}

/**
 * The model.impact.classify domain logic. Caller supplies the operation
 * transaction (txn.db) and authenticated context; authorization runs
 * against the candidate's project, target and designated maintainer scope.
 */
export function classifyCandidate(
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  input: ClassifyInput,
  deps: ClassifyDeps
): ClassifyResult {
  if (typeof input.candidateId !== 'string' || input.candidateId.length === 0) {
    fail('MODEL_INVALID', 'candidateId is required')
  }
  if (!['confirmed', 'dismissed', 'resolved'].includes(input.decision)) {
    fail(
      'MODEL_INVALID',
      `decision must be confirmed|dismissed|resolved, got ${String(input.decision)}`
    )
  }
  if (typeof input.rationale !== 'string' || input.rationale.trim().length === 0) {
    fail(
      'MODEL_INVALID',
      'rationale is required — a classification without a stated reason is not a judgment'
    )
  }
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    fail('MODEL_INVALID', 'expectedRevision must be a positive integer')
  }

  const candidate = loadCandidate(db, input.candidateId)
  if (candidate === null) {
    fail('MODEL_INVALID', `impact candidate ${input.candidateId} not found`)
  }

  // designated-maintainer / responsible-party scope: the candidate's
  // project, the target itself, and the maintainer role recorded at
  // detection time are all offered to the access policy.
  const targets: { kind: string; id: string }[] = [
    { kind: 'impact-candidate', id: candidate.id },
    { kind: candidate.targetKind, id: candidate.targetId }
  ]
  if (candidate.reason.scope?.projectId !== undefined) {
    targets.push({ kind: 'project', id: candidate.reason.scope.projectId })
  }
  if (candidate.reason.scope?.maintainerRoleId !== undefined) {
    targets.push({ kind: 'role', id: candidate.reason.scope.maintainerRoleId })
  }
  deps.authorize(ctx, 'model.impact.classify', targets)

  if (candidate.revision !== input.expectedRevision) {
    fail(
      'STALE_REVISION',
      `candidate ${candidate.id} is at revision ${candidate.revision}, expected ${input.expectedRevision}`,
      {
        actual: candidate.revision,
        expected: input.expectedRevision
      }
    )
  }
  if (!ALLOWED[candidate.state].includes(input.decision)) {
    fail('INVALID_TRANSITION', `cannot move a ${candidate.state} candidate to '${input.decision}'`)
  }

  // self-active-instruction guard (REQ-21): an active member may CONFIRM
  // staleness on its own pinned instructions (detection-side honesty), but
  // may not dismiss or resolve it — clearing or settling the flag IS the
  // refresh judgment, which belongs to a separate responsible party.
  if (
    ctx.memberId !== undefined &&
    (input.decision === 'dismissed' || input.decision === 'resolved')
  ) {
    const pins = resolveMemberPins(db, String(ctx.memberId))
    if (pins !== null && pins.active && candidateTouchesPins(candidate, pins)) {
      fail(
        'SCOPE_DENIED',
        'an agent may not clear or resolve staleness against the instructions its own active execution pins — route the refresh through a separate maintenance task'
      )
    }
  }

  // resolved requires an actual resolution artifact — never an auto-verdict
  // (C-MODEL: "미확인 의미를 자동 resolved 처리 금지").
  let resolutionRef: unknown = undefined
  if (input.decision === 'resolved') {
    const ref = normalizeResolutionRef(input.resolutionRef)
    if (ref === null) {
      fail(
        'MODEL_INVALID',
        'resolved requires resolutionRef {kind: task|plan|implementation|model-change|outcome, id, revision?}'
      )
    }
    if (!resolutionRefExists(db, ref)) {
      fail('MODEL_INVALID', `resolutionRef ${ref.kind}:${ref.id} does not exist`)
    }
    resolutionRef = ref
  }

  const now = (deps.now ?? Date.now)()
  const resolution: CandidateResolution = {
    ...candidate.resolution,
    decision: input.decision,
    rationale: input.rationale,
    decidedBy: {
      principalId: String(ctx.principalId),
      ...(ctx.memberId === undefined ? {} : { memberId: String(ctx.memberId) })
    },
    decidedAt: now,
    resolutionRef
  }
  const newRevision = candidate.revision + 1
  const changed = db
    .prepare(
      `UPDATE impact_candidates
       SET state = ?, revision = ?, resolution_json = ?
       WHERE id = ? AND revision = ?`
    )
    .run(input.decision, newRevision, JSON.stringify(resolution), candidate.id, candidate.revision)
  if (Number(changed.changes) === 0) {
    fail('STALE_REVISION', `candidate ${candidate.id} changed concurrently — re-read and retry`)
  }
  db.prepare(
    `INSERT INTO domain_events (aggregate_id, aggregate_revision, event_type, scope_json, payload_json)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    candidate.id,
    newRevision,
    'ImpactCandidateClassified',
    JSON.stringify({
      projectId: candidate.reason.scope?.projectId ?? null,
      modelVersion: candidate.reason.scope?.modelVersion ?? null
    }),
    JSON.stringify({
      candidateId: candidate.id,
      decision: input.decision,
      decidedBy: resolution.decidedBy,
      resolutionRef: resolutionRef ?? null
    })
  )
  return { candidateId: candidate.id, state: input.decision, revision: newRevision }
}
