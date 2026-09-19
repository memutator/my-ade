// mahas-runtime / mail — execution.wake (IMP-21, C-LAUNCH).
//
// Wake is orthogonal to the mailbox (D-MAIL §5): outstanding Deliveries are
// already stored. This service only records an attention-pointer attempt
// gated on a ContinuationGrant + a profile-declared safe recipe + budget.
// Failure NEVER deletes or fences Deliveries. A missing grant is an honest
// UNAVAILABLE_OPERATION — never a fake 'sent'.

import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import type { WakeRequest, WakeState } from '../../../mahas-contracts/src/mail.ts'
import type { TargetRef } from '../access/authorize.ts'
import {
  asObject,
  defaultNewId,
  fail,
  optInt,
  optString,
  reqString
} from './shared.ts'

function one(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): Record<string, unknown> | null {
  const row = db.prepare(sql).get(...params)
  return (row as Record<string, unknown> | undefined) ?? null
}

export type WakeReceiptStatus = 'sent' | 'unsupported' | 'pending' | 'unknown'

export interface WakeReceipt {
  status: WakeReceiptStatus
  wakeRequestId?: string
  operationKey: string
  state?: WakeState
  reason?: string
  deliveryIds: string[]
}

export interface ExecutionWakeInput {
  memberId: string
  deliveryIds: string[]
  continuationGrantId?: string
  expectedExecutionGeneration?: number
  operationKey?: string
}

interface GrantRow {
  id: string
  kind: string
  revoked_at: number | null
  expires_at: number | null
  scope_json: string
  actions_json: string
}

interface ContinuationScope {
  memberId?: string
  allowedWakeRoute?: string
  budget?: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function parseExecutionWakePayload(raw: unknown): ExecutionWakeInput {
  const op = 'execution.wake'
  const p = asObject(raw, op)
  const ids = p.deliveryIds
  let deliveryIds: string[] = []
  if (ids === undefined || ids === null) deliveryIds = []
  else if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
    fail('MODEL_INVALID', `${op}: 'deliveryIds' must be a string array`, 'none')
  } else deliveryIds = ids as string[]
  return {
    memberId: reqString(p, 'memberId', op),
    deliveryIds,
    continuationGrantId: optString(p, 'continuationGrantId', op),
    expectedExecutionGeneration: optInt(p, 'expectedExecutionGeneration', op),
    operationKey: optString(p, 'operationKey', op)
  }
}

export function wakeResolveTargets(db: DatabaseSync, raw: unknown): TargetRef[] {
  const p = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
  const targets: TargetRef[] = []
  if (typeof p.memberId === 'string' && p.memberId.length > 0) {
    targets.push({ kind: 'member', id: p.memberId })
  }
  if (typeof p.continuationGrantId === 'string' && p.continuationGrantId.length > 0) {
    targets.push({ kind: 'grant', id: p.continuationGrantId })
  }
  if (Array.isArray(p.deliveryIds)) {
    for (const id of p.deliveryIds) {
      if (typeof id === 'string' && id.length > 0) targets.push({ kind: 'delivery', id })
    }
  }
  const member = typeof p.memberId === 'string' ? one(db, 'SELECT current_execution_id FROM members WHERE id = ?', p.memberId) : null
  if (member?.current_execution_id) {
    targets.push({ kind: 'execution', id: String(member.current_execution_id) })
  }
  return targets
}

function loadContinuationGrant(
  db: DatabaseSync,
  input: ExecutionWakeInput,
  now: number
): GrantRow {
  const op = 'execution.wake'
  let row: GrantRow | null = null
  if (input.continuationGrantId) {
    const found = one(db, 'SELECT * FROM grants WHERE id = ?', input.continuationGrantId)
    if (!found) {
      fail(
        'UNAVAILABLE_OPERATION',
        `${op}: continuation grant ${input.continuationGrantId} does not exist`,
        'none',
        { continuationGrantId: input.continuationGrantId }
      )
    }
    row = found as unknown as GrantRow
  } else {
    const rows = db
      .prepare(
        "SELECT * FROM grants WHERE kind = 'continuation' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)"
      )
      .all(now) as unknown as GrantRow[]
    const matching = rows.filter((g) => {
      const scope = parseJson(g.scope_json)
      if (!isRecord(scope)) return false
      const cont = isRecord(scope.continuation) ? scope.continuation : scope
      return String(cont.memberId ?? '') === input.memberId
    })
    if (matching.length === 1) row = matching[0]!
    else if (matching.length > 1) {
      fail(
        'UNAVAILABLE_OPERATION',
        `${op}: multiple continuation grants cover member ${input.memberId} — pass continuationGrantId`,
        'none'
      )
    }
  }
  if (!row) {
    fail(
      'UNAVAILABLE_OPERATION',
      `${op}: no ContinuationGrant covers member ${input.memberId}`,
      'none',
      { memberId: input.memberId }
    )
  }
  if (row.kind !== 'continuation') {
    fail(
      'SCOPE_DENIED',
      `${op}: grant ${row.id} is kind '${row.kind}', not continuation`,
      'none'
    )
  }
  if (row.revoked_at != null) {
    fail('GRANT_REVOKED', `${op}: continuation grant ${row.id} is revoked`, 'none')
  }
  if (row.expires_at != null && Number(row.expires_at) <= now) {
    fail('GRANT_REVOKED', `${op}: continuation grant ${row.id} has expired`, 'none')
  }
  const scope = parseJson(row.scope_json)
  const cont: ContinuationScope = isRecord(scope)
    ? ((isRecord(scope.continuation) ? scope.continuation : scope) as ContinuationScope)
    : {}
  if (cont.memberId && cont.memberId !== input.memberId) {
    fail(
      'SCOPE_DENIED',
      `${op}: continuation grant ${row.id} is bound to member ${cont.memberId}, not ${input.memberId}`,
      'none'
    )
  }
  if (typeof cont.budget === 'number') {
    const used = one(
      db,
      "SELECT COUNT(*) AS n FROM wake_requests WHERE continuation_grant_id = ? AND state NOT IN ('failed','unavailable')",
      row.id
    )
    const n = Number(used?.n ?? 0)
    if (cont.budget <= 0 || n >= cont.budget) {
      fail(
        'SCOPE_DENIED',
        `${op}: continuation grant ${row.id} wake budget exhausted (${n}/${cont.budget})`,
        'none'
      )
    }
  }
  return row
}

function recipeSupportsWake(db: DatabaseSync, memberId: string): {
  supported: boolean
  reason: string
  route?: string
} {
  const row = one(
    db,
    `SELECT hp.recipe_json AS recipe_json, hp.capabilities_json AS capabilities_json
       FROM members m
       JOIN role_implementations ri
         ON ri.id = m.implementation_id AND ri.revision = m.implementation_revision
       JOIN harness_profiles hp
         ON hp.id = ri.profile_id AND hp.revision = ri.profile_revision
      WHERE m.id = ?`,
    memberId
  )
  if (!row) {
    return { supported: false, reason: 'member has no harness profile recipe to confirm a safe wake route' }
  }
  const recipe = parseJson(String(row.recipe_json ?? '{}'))
  const caps = parseJson(String(row.capabilities_json ?? '{}'))
  if (isRecord(caps) && caps.wake === false) {
    return { supported: false, reason: 'harness profile capabilities.wake is false' }
  }
  const wake = isRecord(recipe)
    ? (recipe.wake ?? recipe.wakeRecipe ?? (isRecord(recipe.injection) ? recipe.injection.wake : undefined))
    : undefined
  if (wake === undefined || wake === null) {
    return { supported: false, reason: 'harness profile recipe declares no wake route' }
  }
  if (wake === false) {
    return { supported: false, reason: 'harness profile recipe.wake is false' }
  }
  if (typeof wake === 'string') {
    const s = wake.toLowerCase()
    if (s === 'unsupported' || s === 'none' || s === 'manual') {
      return { supported: false, reason: `wake route is ${wake}`, route: wake }
    }
    return { supported: true, reason: 'recipe names a wake route', route: wake }
  }
  if (isRecord(wake)) {
    const automatic = wake.automatic
    const route = typeof wake.route === 'string' ? wake.route : undefined
    if (automatic === false) {
      return {
        supported: false,
        reason: 'wake recipe is not automatic — idle TUI needs manual resume; deliveries stay outstanding',
        route
      }
    }
    if (route === 'unsupported' || route === 'none') {
      return { supported: false, reason: `wake route is ${route}`, route }
    }
    return { supported: true, reason: 'recipe declares a wake route', route }
  }
  return { supported: false, reason: 'wake recipe is not a recognised shape' }
}

function assertDeliveriesUntouched(
  db: DatabaseSync,
  memberId: string,
  deliveryIds: string[]
): void {
  for (const id of deliveryIds) {
    const d = one(
      db,
      'SELECT id, recipient_member_id, status FROM deliveries WHERE id = ?',
      id
    )
    if (!d) {
      fail('MODEL_INVALID', `execution.wake: delivery ${id} does not exist`, 'none')
    }
    if (String(d.recipient_member_id) !== memberId) {
      fail(
        'SCOPE_DENIED',
        `execution.wake: delivery ${id} is not addressed to member ${memberId}`,
        'none'
      )
    }
    // status is observed only — never UPDATEd here
  }
}

function receiptOf(row: Record<string, unknown>): WakeReceipt {
  const receipt = parseJson(String(row.receipt_json ?? '{}'))
  if (isRecord(receipt) && typeof receipt.status === 'string') {
    return receipt as unknown as WakeReceipt
  }
  const state = String(row.state ?? 'unknown') as WakeState
  const status: WakeReceiptStatus =
    state === 'delivered' ? 'sent' : state === 'unavailable' ? 'unsupported' : state === 'requested' || state === 'attempting' ? 'pending' : 'unknown'
  const set = parseJson(String(row.delivery_set_json ?? '[]'))
  return {
    status,
    wakeRequestId: String(row.id),
    operationKey: String(row.operation_key),
    state,
    deliveryIds: Array.isArray(set) ? set.filter((x) => typeof x === 'string') : []
  }
}

/**
 * Record a wake attempt. On every path — including unsupported — deliveries
 * are left exactly as they were.
 */
export function executionWake(
  db: DatabaseSync,
  raw: unknown,
  ctx: AuthenticatedContext
): WakeReceipt {
  const op = 'execution.wake'
  const input = parseExecutionWakePayload(raw)
  const member = one(
    db,
    'SELECT id, generation, current_execution_id, state FROM members WHERE id = ?',
    input.memberId
  )
  if (!member) {
    fail('SCOPE_DENIED', `${op}: member ${input.memberId} does not exist`, 'none')
  }
  if (String(member.state) === 'retired') {
    fail('INVALID_TRANSITION', `${op}: member ${input.memberId} is retired`, 'none')
  }
  if (input.expectedExecutionGeneration !== undefined) {
    if (Number(member.generation) !== input.expectedExecutionGeneration) {
      fail(
        'STALE_EXECUTION',
        `${op}: member ${input.memberId} is at generation ${member.generation}, expected ${input.expectedExecutionGeneration}`,
        'none'
      )
    }
    const execId = member.current_execution_id ? String(member.current_execution_id) : ''
    if (execId) {
      const ex = one(db, 'SELECT generation FROM executions WHERE id = ?', execId)
      if (!ex || Number(ex.generation) !== input.expectedExecutionGeneration) {
        fail(
          'STALE_EXECUTION',
          `${op}: execution ${execId} does not match expected generation ${input.expectedExecutionGeneration}`,
          'none'
        )
      }
    }
  }
  if (ctx.memberId && String(ctx.memberId) !== input.memberId) {
    // operator-scoped credentials have no memberId; a member credential may
    // only wake its own mailbox
    fail(
      'SCOPE_DENIED',
      `${op}: credential member ${ctx.memberId} cannot wake member ${input.memberId}`,
      'none'
    )
  }

  // deliveries are identified, never mutated
  assertDeliveriesUntouched(db, input.memberId, input.deliveryIds)

  const now = Date.now()
  const grant = loadContinuationGrant(db, input, now)
  const key =
    input.operationKey ??
    `wake:${input.memberId}:${member.current_execution_id ?? 'none'}:${member.generation}:${[...input.deliveryIds].sort().join(',')}`

  const existing = one(db, 'SELECT * FROM wake_requests WHERE operation_key = ?', key)
  if (existing) return receiptOf(existing)

  const recipe = recipeSupportsWake(db, input.memberId)
  // this boundary does not own host.terminal.input — even a supported recipe
  // is recorded as pending, never faked as 'sent'
  const status: WakeReceiptStatus = recipe.supported ? 'pending' : 'unsupported'
  const state: WakeState = recipe.supported ? 'requested' : 'unavailable'
  const receipt: WakeReceipt = {
    status,
    operationKey: key,
    state,
    reason: recipe.reason,
    deliveryIds: input.deliveryIds
  }
  const id = defaultNewId('wak')
  db.prepare(
    'INSERT INTO wake_requests (id, member_id, execution_id, continuation_grant_id, operation_key, state, delivery_set_json, receipt_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    input.memberId,
    member.current_execution_id ? String(member.current_execution_id) : null,
    grant.id,
    key,
    state,
    JSON.stringify(input.deliveryIds),
    JSON.stringify({ ...receipt, wakeRequestId: id, route: recipe.route ?? null })
  )
  receipt.wakeRequestId = id
  return receipt
}

export type { WakeRequest }
