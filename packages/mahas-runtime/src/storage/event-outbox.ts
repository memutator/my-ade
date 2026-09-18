// storage/event-outbox.ts — domain event outbox + effect intent/outbox
// repository (domain_events, effect_intents, effect_outbox — spec/storage.md
// §3; states per spec/common.md §5).
//
// domain_events is the projection outbox: rows are appended inside the same
// write transaction as the domain mutation, then pumped to subscribers by
// global sequence.
//
// effect_intents is the ledger of external effects; effect_outbox is its
// pump queue. States: prepared | attempting | confirmed | rejected | unknown.
// 'unknown' is NOT a terminal failure — it stays in the pending set as a
// reconcile target (spec/common.md §5), and listPendingEffects deliberately
// has no LIMIT so a ledger cap can never silently drop unprocessed states
// (instruction §4.5).

import type { DatabaseSync } from 'node:sqlite'
import type { EffectState } from '../../../mahas-contracts/src/index.ts'

/** append a DomainEvent row inside the current write transaction */
export function appendDomainEvent(
  db: DatabaseSync,
  aggregateId: string,
  aggregateRevision: number,
  eventType: string,
  scope: unknown,
  payload: unknown
): void {
  db.prepare(
    'INSERT INTO domain_events(aggregate_id, aggregate_revision, event_type, scope_json, payload_json) ' +
      'VALUES (?,?,?,?,?)'
  ).run(
    aggregateId,
    aggregateRevision,
    eventType,
    JSON.stringify(scope ?? null),
    JSON.stringify(payload ?? null)
  )
}

/** current global event cursor (0 on an empty outbox) — for CommandReceipt.eventCursor */
export function lastEventSequence(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(MAX(sequence),0) AS seq FROM domain_events').get()
  return Number(row?.['seq'] ?? 0)
}

// ── effect intents + outbox ─────────────────────────────────────────────────

/** a new effect intent to stage (effect_intents row + effect_outbox row) */
export interface EffectIntentInput {
  id: string
  /** stable effect key — the idempotency anchor for the external effect */
  operationKey: string
  kind: string
  fingerprint: string
  hostId?: string | null
  /** defaults to 'prepared' */
  state?: EffectState
  payload: unknown
  /** EffectReceipt-shaped; defaults to {} (column is NOT NULL json) */
  receipt?: unknown
  /** ResidualResource[]; defaults to [] */
  residuals?: unknown
  /** effect_outbox scheduling hint; NULL = due immediately */
  nextAttemptAt?: number | null
}

/** an effect_intents row decoded to its domain shape */
export interface StoredEffectIntent {
  id: string
  operationKey: string
  kind: string
  fingerprint: string
  hostId: string | null
  state: EffectState
  payload: unknown
  receipt: unknown
  residuals: unknown
}

/** a pending effect joined with its outbox scheduling row */
export interface PendingEffect extends StoredEffectIntent {
  nextAttemptAt: number | null
}

/** state update applied to an existing intent (and its outbox row) */
export interface EffectStateUpdate {
  state: EffectState
  /** when provided, replaces receipt_json */
  receipt?: unknown
  /** when provided, replaces residuals_json */
  residuals?: unknown
  /** reschedule hint; undefined keeps current, null = due now */
  nextAttemptAt?: number | null
}

interface IntentRow {
  id: unknown
  operation_key: unknown
  kind: unknown
  fingerprint: unknown
  host_id: unknown
  state: unknown
  payload_json: unknown
  receipt_json: unknown
  residuals_json: unknown
}

function toIntent(row: IntentRow): StoredEffectIntent {
  return {
    id: String(row.id),
    operationKey: String(row.operation_key),
    kind: String(row.kind),
    fingerprint: String(row.fingerprint),
    hostId: row.host_id === null || row.host_id === undefined ? null : String(row.host_id),
    state: String(row.state) as EffectState,
    payload: JSON.parse(String(row.payload_json)),
    receipt: JSON.parse(String(row.receipt_json)),
    residuals: JSON.parse(String(row.residuals_json))
  }
}

const INTENT_COLUMNS =
  'id, operation_key, kind, fingerprint, host_id, state, payload_json, receipt_json, residuals_json'

/**
 * Stage a new effect intent: one effect_intents row + one effect_outbox row,
 * inside the caller's write transaction. Re-staging an existing id fails on
 * the primary key — retry of an already-admitted effect must look the stored
 * receipt up by operation key instead (spec/common.md §5 retry rule).
 */
export function stageEffectIntent(db: DatabaseSync, intent: EffectIntentInput): void {
  const state = intent.state ?? 'prepared'
  db.prepare(
    'INSERT INTO effect_intents(id, operation_key, kind, fingerprint, host_id, state, payload_json, receipt_json, residuals_json) ' +
      'VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    intent.id,
    intent.operationKey,
    intent.kind,
    intent.fingerprint,
    intent.hostId ?? null,
    state,
    JSON.stringify(intent.payload ?? null),
    JSON.stringify(intent.receipt ?? {}),
    JSON.stringify(intent.residuals ?? [])
  )
  db.prepare('INSERT INTO effect_outbox(effect_id, state, next_attempt_at) VALUES (?,?,?)').run(
    intent.id,
    state,
    intent.nextAttemptAt ?? null
  )
}

/** fetch one intent by id */
export function getEffectIntent(db: DatabaseSync, id: string): StoredEffectIntent | null {
  const row = db.prepare(`SELECT ${INTENT_COLUMNS} FROM effect_intents WHERE id=?`).get(id) as
    IntentRow | undefined
  return row === undefined ? null : toIntent(row)
}

/**
 * All intents sharing an operation key — the retry rule's lookup surface
 * ("이미 승인된 같은 effect key의 receipt 조회", spec/common.md §5). Ordered by
 * id; the caller decides which receipt/verdict applies.
 */
export function findEffectsByOperationKey(
  db: DatabaseSync,
  operationKey: string
): StoredEffectIntent[] {
  const rows = db
    .prepare(`SELECT ${INTENT_COLUMNS} FROM effect_intents WHERE operation_key=? ORDER BY id`)
    .all(operationKey) as unknown as IntentRow[]
  return rows.map(toIntent)
}

/**
 * Transition an effect intent and its outbox row together. Unknown id throws —
 * an effect update must never silently land on nothing.
 */
export function updateEffectState(db: DatabaseSync, id: string, update: EffectStateUpdate): void {
  const sets = ['state=?']
  const params: Array<string | number | null> = [update.state]
  if (update.receipt !== undefined) {
    sets.push('receipt_json=?')
    params.push(JSON.stringify(update.receipt))
  }
  if (update.residuals !== undefined) {
    sets.push('residuals_json=?')
    params.push(JSON.stringify(update.residuals))
  }
  params.push(id)
  const res = db.prepare(`UPDATE effect_intents SET ${sets.join(', ')} WHERE id=?`).run(...params)
  if (Number(res.changes) !== 1) {
    throw new Error(`updateEffectState: no effect_intents row with id ${id}`)
  }
  if (update.nextAttemptAt === undefined) {
    db.prepare(
      'INSERT INTO effect_outbox(effect_id, state) VALUES (?,?) ' +
        'ON CONFLICT(effect_id) DO UPDATE SET state=excluded.state'
    ).run(id, update.state)
  } else {
    db.prepare(
      'INSERT INTO effect_outbox(effect_id, state, next_attempt_at) VALUES (?,?,?) ' +
        'ON CONFLICT(effect_id) DO UPDATE SET state=excluded.state, next_attempt_at=excluded.next_attempt_at'
    ).run(id, update.state, update.nextAttemptAt)
  }
}

/**
 * Due effects for the pump: outbox rows in a pending state whose
 * next_attempt_at has passed, joined with the intent ledger.
 *
 * Default pending set = prepared | attempting | unknown — 'unknown' stays
 * visible because it is a reconcile target, not a terminal verdict
 * (spec/common.md §5). NO LIMIT clause on purpose: a cap would silently drop
 * unprocessed states (instruction §4.5). Callers iterate the full set.
 */
export function listPendingEffects(
  db: DatabaseSync,
  options?: { hostId?: string; now?: number; states?: EffectState[] }
): PendingEffect[] {
  const states = options?.states ?? ['prepared', 'attempting', 'unknown']
  const now = options?.now ?? Date.now()
  const placeholders = states.map(() => '?').join(',')
  const hostFilter = options?.hostId === undefined ? '' : ' AND e.host_id=?'
  const params: Array<string | number> = [...states, now]
  if (options?.hostId !== undefined) params.push(options.hostId)
  const rows = db
    .prepare(
      `SELECT ${INTENT_COLUMNS.split(', ')
        .map((c) => `e.${c}`)
        .join(', ')}, o.next_attempt_at AS next_attempt_at ` +
        `FROM effect_outbox o JOIN effect_intents e ON e.id=o.effect_id ` +
        `WHERE o.state IN (${placeholders}) ` +
        `AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)${hostFilter} ` +
        `ORDER BY o.effect_id`
    )
    .all(...params) as unknown as Array<IntentRow & { next_attempt_at: unknown }>
  return rows.map((row) => ({
    ...toIntent(row),
    nextAttemptAt:
      row.next_attempt_at === null || row.next_attempt_at === undefined
        ? null
        : Number(row.next_attempt_at)
  }))
}
