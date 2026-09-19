// mahas-runtime / coordination — Settlement (IMP-21, C-WORK outcome.decide).
//
// owner-declaration: task.report writes the Settlement in the same
// transaction as the Outcome. designated-acceptance: only the named acceptor
// may decide the exact outcome revision — old decisions never follow a new
// revision, and a superseded TaskSpec cannot inherit a prior success.

import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import type { Settlement, SettlementDecision } from '../../../mahas-contracts/src/mail.ts'
import type { SettlementPolicy } from '../../../mahas-contracts/src/work.ts'
import { ACCEPTING_DECISIONS } from './input-resolver.ts'
import { appendDomainEvent } from '../storage/db.ts'
import {
  asObject,
  badInput,
  fail,
  newId,
  nowMs,
  one,
  optInt,
  optStr,
  reqStr,
  run
} from './internal.ts'
import { getTask } from './task-spec.ts'
import { isDesignatedAcceptance, loadOutcome, policyOf } from './outcome.ts'

export function normalizeDecision(raw: string): SettlementDecision {
  const v = raw.trim().toLowerCase()
  if (v === 'accept' || v === 'accepted' || v === 'approve' || v === 'approved') return 'accepted'
  if (v === 'reject' || v === 'rejected' || v === 'deny' || v === 'denied') return 'rejected'
  if (
    v === 'changes-requested' ||
    v === 'changes_requested' ||
    v === 'revise' ||
    v === 'revision-requested'
  ) {
    return 'changes-requested'
  }
  fail(
    'MODEL_INVALID',
    `decision must be accepted|rejected (or changes-requested), got ${JSON.stringify(raw)}`
  )
}

export function isAccepting(decision: string): boolean {
  return (ACCEPTING_DECISIONS as readonly string[]).includes(decision)
}

export function loadSettlement(
  db: DatabaseSync,
  outcomeId: string,
  outcomeRevision: number
): Settlement | null {
  const r = one(
    db,
    'SELECT * FROM settlements WHERE outcome_id = ? AND outcome_revision = ?',
    outcomeId,
    outcomeRevision
  )
  if (!r) return null
  return {
    id: r.id as Settlement['id'],
    outcomeId: r.outcome_id as Settlement['outcomeId'],
    outcomeRevision: Number(r.outcome_revision) as Settlement['outcomeRevision'],
    authorityMemberId: r.authority_member_id as Settlement['authorityMemberId'],
    decision: r.decision as SettlementDecision,
    reason: String(r.reason),
    decidedAt: Number(r.decided_at)
  }
}

export interface InsertSettlementInput {
  outcomeId: string
  outcomeRevision: number
  authorityMemberId: string
  decision: SettlementDecision
  reason: string
  decidedAt?: number
}

export function insertSettlement(db: DatabaseSync, input: InsertSettlementInput): Settlement {
  const existing = loadSettlement(db, input.outcomeId, input.outcomeRevision)
  if (existing) {
    if (existing.decision === input.decision && existing.authorityMemberId === input.authorityMemberId) {
      return existing
    }
    fail(
      'OPERATION_CONFLICT',
      `outcome ${input.outcomeId}@${input.outcomeRevision} is already settled as ${existing.decision}`,
      'none',
      { existing }
    )
  }
  const id = newId('stl') as string
  const at = input.decidedAt ?? nowMs()
  run(
    db,
    'INSERT INTO settlements (id, outcome_id, outcome_revision, authority_member_id, decision, reason, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    input.outcomeId,
    input.outcomeRevision,
    input.authorityMemberId,
    input.decision,
    input.reason,
    at
  )
  appendDomainEvent(
    db,
    id,
    1,
    'outcome.decided',
    { outcomeId: input.outcomeId, outcomeRevision: input.outcomeRevision },
    { decision: input.decision, authorityMemberId: input.authorityMemberId }
  )
  return {
    id: id as Settlement['id'],
    outcomeId: input.outcomeId as Settlement['outcomeId'],
    outcomeRevision: input.outcomeRevision as Settlement['outcomeRevision'],
    authorityMemberId: input.authorityMemberId as Settlement['authorityMemberId'],
    decision: input.decision,
    reason: input.reason,
    decidedAt: at
  }
}

function acceptorMemberId(policy: SettlementPolicy): string | undefined {
  const rec = policy as Record<string, unknown>
  const id = rec.acceptorMemberId ?? rec.acceptor
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

function acceptorRoleId(policy: SettlementPolicy): string | undefined {
  const rec = policy as Record<string, unknown>
  const id = rec.acceptorRoleId ?? rec.roleId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Only the TaskSpec's designated acceptor may decide. Missing designation is
 * a closed door — we never fall back to "anyone with the op name".
 */
export function assertDesignatedAcceptor(
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  policy: SettlementPolicy,
  op: string
): string {
  if (!isDesignatedAcceptance(policy)) {
    fail(
      'SCOPE_DENIED',
      `${op}: this TaskSpec is not designated-acceptance — owner-declaration settles at task.report`,
      'none'
    )
  }
  const caller = ctx.memberId ? String(ctx.memberId) : ''
  if (!caller) {
    fail('UNAUTHENTICATED', `${op}: designated acceptance requires a Member-scoped credential`)
  }
  const wantMember = acceptorMemberId(policy)
  const wantRole = acceptorRoleId(policy)
  if (!wantMember && !wantRole) {
    fail('SCOPE_DENIED', `${op}: TaskSpec names no designated acceptor`, 'none')
  }
  const member = one(db, 'SELECT id, role_id, state FROM members WHERE id = ?', caller)
  if (!member) {
    fail('SCOPE_DENIED', `${op}: member ${caller} does not exist`, 'none')
  }
  if (wantMember && wantMember !== caller) {
    fail(
      'SCOPE_DENIED',
      `${op}: designated acceptor is member ${wantMember}, not ${caller}`,
      'none',
      { acceptorMemberId: wantMember, caller }
    )
  }
  if (wantRole && String(member.role_id) !== wantRole) {
    fail(
      'SCOPE_DENIED',
      `${op}: designated acceptor role is ${wantRole}, caller occupies ${member.role_id}`,
      'none',
      { acceptorRoleId: wantRole, callerRoleId: member.role_id }
    )
  }
  return caller
}

export interface OutcomeDecideInput {
  outcomeId: string
  outcomeRevision: number
  decision: string
  reason: string
  expectedTaskRevision?: number
}

export function parseOutcomeDecidePayload(raw: unknown): OutcomeDecideInput {
  const op = 'outcome.decide'
  const p = asObject(raw, op)
  const revision = optInt(p, 'outcomeRevision', op) ?? optInt(p, 'revision', op)
  if (revision === undefined) badInput(`${op}: 'outcomeRevision' is required`)
  return {
    outcomeId: reqStr(p, 'outcomeId', op),
    outcomeRevision: revision,
    decision: reqStr(p, 'decision', op),
    reason: optStr(p, 'reason', op) ?? '',
    expectedTaskRevision: optInt(p, 'expectedTaskRevision', op) ?? optInt(p, 'taskRevision', op)
  }
}

export function requireExactOutcome(
  db: DatabaseSync,
  input: OutcomeDecideInput,
  op: string
): NonNullable<ReturnType<typeof loadOutcome>> {
  const outcome = loadOutcome(db, input.outcomeId, input.outcomeRevision)
  if (!outcome) {
    fail(
      'STALE_REVISION',
      `${op}: outcome ${input.outcomeId}@${input.outcomeRevision} does not exist`,
      'none',
      { outcomeId: input.outcomeId, outcomeRevision: input.outcomeRevision }
    )
  }
  const task = getTask(db, String(outcome.taskId))
  if (!task) {
    fail('STALE_REVISION', `${op}: task ${outcome.taskId} does not exist`, 'none')
  }
  const current = Number(task.currentRevision)
  const pinned = Number(outcome.taskRevision)
  if (input.expectedTaskRevision !== undefined && input.expectedTaskRevision !== pinned) {
    fail(
      'STALE_REVISION',
      `${op}: outcome pins task revision ${pinned}, expected ${input.expectedTaskRevision}`,
      'none',
      { pinned, expectedTaskRevision: input.expectedTaskRevision }
    )
  }
  // a superseded TaskSpec must not inherit this result as the new requirement's success
  if (current !== pinned) {
    fail(
      'STALE_REVISION',
      `${op}: task ${outcome.taskId} is at revision ${current}; outcome ${input.outcomeId}@${input.outcomeRevision} pins ${pinned} and cannot be adopted`,
      'none',
      { current, pinned }
    )
  }
  return outcome
}

export { policyOf }
