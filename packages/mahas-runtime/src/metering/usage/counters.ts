// metering/usage/counters.ts — cumulative counter identity, lineage checkpoints
// and the bounded correction recompute.
//
// Rules this module exists to hold (milestone plan §6):
//   · counter 감소 → 명시 reset/정정/범위 변화 확인 전 보류; 음수 소비나 자동 재시작 금지
//   · SQL 기존 행 갱신 → PK 증가만 보지 않고 revision/watermark/겹침 재조회 계약 적용
//   · 누적 100 → 150 → 같은 범위라면 전체 150, 최초 baseline과 증가분의 근거 보존
//
// One checkpoint row exists per counter LINEAGE (the accounting key that
// reported the snapshot) instead of one row per counter. A correction then
// cannot use its own superseded value as the baseline, and the deltas recorded
// after it can be re-normalized in the same commit instead of staying computed
// against a value the ledger no longer believes.

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  UsageAccountingStatus,
  UsageCounterEpochRelation,
  UsageCoverageRef,
  UsageTime,
  UsageValues
} from '../../../../mahas-contracts/src/metering/index.ts'

export type UsageStreamRole = 'primary' | 'corroborating' | 'unresolved'
/** Historical name kept for callers that fed the ingest seam directly. */
export type CounterEpochRelation = UsageCounterEpochRelation

export const EMPTY_USAGE_VALUES: UsageValues = {
  inputTotal: null, outputTotal: null, total: null,
  cacheReadInput: null, cacheWriteInput: null, reasoningOutput: null
}

const TOKEN_KEYS: readonly (keyof UsageValues)[] = [
  'inputTotal', 'outputTotal', 'total', 'cacheReadInput', 'cacheWriteInput', 'reasoningOutput'
]

export function validateUsageValues(values: UsageValues): void {
  for (const key of TOKEN_KEYS) {
    const value = values[key]
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`usage ${key} must be a non-negative safe integer or null`)
    }
  }
}

/**
 * Ledger entry id for one counter/record lineage. The hash covers the
 * installation-qualified namespace, so two installs of one harness that report
 * the same native key never collapse into one entry.
 */
export function usageEntryIdFor(
  harnessId: string,
  accountingNamespace: string,
  accountingKey: string
): string {
  return 'usage_' + createHash('sha256')
    .update([harnessId, accountingNamespace, accountingKey].join('\u0000')).digest('hex')
}

/**
 * Accounting status straight from declared coverage: an overlapping or unknown
 * relation is never counted, and an included-by stream is a duplicate rather
 * than a second total.
 */
export function usageStatusFor(
  streamRole: UsageStreamRole,
  coverage: readonly UsageCoverageRef[]
): UsageAccountingStatus {
  if (streamRole === 'corroborating') return 'duplicate'
  if (streamRole === 'unresolved' || coverage.length === 0) return 'unresolved'
  if (coverage.some((c) => c.relation === 'overlaps' || c.relation === 'unknown')) return 'unresolved'
  if (coverage.every((c) => c.relation === 'included-by')) return 'duplicate'
  return 'counted'
}

/** null when any component would go negative — the caller must hold the reading. */
export function subtractUsageValues(current: UsageValues, previous: UsageValues): UsageValues | null {
  const out = {} as UsageValues
  for (const key of TOKEN_KEYS) {
    const now = current[key]
    const before = previous[key]
    if (now !== null && before !== null && now < before) return null
    out[key] = now === null || before === null ? null : now - before
  }
  return out
}

export interface CounterIdentity {
  harnessId: string
  accountingNamespace: string
  counterScope: string
  counterEpoch: string
  measurementKey: string
}

/** `(observed_at, recorded_at, accounting_key)` is the counter's stable order. */
export interface CounterChainCursor {
  observedAt: number
  recordedAt: number
  accountingKey: string
}

export interface CounterRow {
  accounting_key: string
  entry_revision: number
  reading_id: string
  values_json: string
  observed_at: number
  recorded_at: number
}

const COUNTER_COLUMNS = 'accounting_key,entry_revision,reading_id,values_json,observed_at,recorded_at'

export function counterRows(db: DatabaseSync, key: CounterIdentity): CounterRow[] {
  return db.prepare(
    `SELECT ${COUNTER_COLUMNS} FROM usage_counter_checkpoints
     WHERE harness_id=? AND accounting_namespace=? AND counter_scope=? AND counter_epoch=? AND
       measurement_key=?
     ORDER BY observed_at,recorded_at,accounting_key`
  ).all(key.harnessId, key.accountingNamespace, key.counterScope, key.counterEpoch,
    key.measurementKey) as unknown as CounterRow[]
}

export function readCounterRow(
  db: DatabaseSync,
  key: CounterIdentity,
  accountingKey: string
): CounterRow | null {
  const row = db.prepare(
    `SELECT ${COUNTER_COLUMNS} FROM usage_counter_checkpoints
     WHERE harness_id=? AND accounting_namespace=? AND counter_scope=? AND counter_epoch=? AND
       measurement_key=? AND accounting_key=?`
  ).get(key.harnessId, key.accountingNamespace, key.counterScope, key.counterEpoch,
    key.measurementKey, accountingKey)
  return row ? (row as unknown as CounterRow) : null
}

export function otherCounterEpochExists(db: DatabaseSync, key: CounterIdentity): boolean {
  return db.prepare(
    `SELECT 1 AS present FROM usage_counter_checkpoints
     WHERE harness_id=? AND accounting_namespace=? AND counter_scope=? AND measurement_key=? AND
       counter_epoch<>? LIMIT 1`
  ).get(key.harnessId, key.accountingNamespace, key.counterScope, key.measurementKey,
    key.counterEpoch) !== undefined
}

export const counterCursorOf = (row: CounterRow): CounterChainCursor => ({
  observedAt: row.observed_at, recordedAt: row.recorded_at, accountingKey: row.accounting_key
})

export function parseCounterValues(text: string, fallback: UsageValues): UsageValues {
  try { return JSON.parse(text) as UsageValues } catch { return fallback }
}

export interface CounterNormalization {
  values: UsageValues
  usageTime: UsageTime
  status: UsageAccountingStatus
  /** false when the ledger must not move the counter's confirmed position */
  advance: boolean
}

const held = (values: UsageValues, reason: string): CounterNormalization => ({
  values, usageTime: { kind: 'unknown', reason }, status: 'unresolved', advance: false
})

/**
 * Normalize one counter observation against the confirmed position that
 * precedes it in the counter's own order. `baseline === null` is the honest
 * first-snapshot case: the reported value becomes the all-time baseline, never
 * an interval, and never today's usage.
 */
export function normalizeAgainstCheckpoint(input: {
  values: UsageValues
  observedAt: number
  baseline: CounterRow | null
  coverageStatus: UsageAccountingStatus
}): CounterNormalization {
  const { values, observedAt, baseline, coverageStatus } = input
  if (!baseline) {
    return {
      values,
      usageTime: { kind: 'unknown', reason: 'initial cumulative baseline' },
      status: coverageStatus,
      advance: coverageStatus !== 'unresolved'
    }
  }
  if (observedAt < baseline.observed_at) {
    return held(values, 'counter observation predates the confirmed checkpoint')
  }
  const delta = subtractUsageValues(values, parseCounterValues(baseline.values_json, values))
  if (!delta) return held(values, 'counter decrease awaiting reset or correction evidence')
  const usageTime: UsageTime = observedAt > baseline.observed_at
    ? {
        kind: 'interval', startExclusive: baseline.observed_at, endInclusive: observedAt,
        basis: 'between-counter-observations', precision: 'observation interval'
      }
    : { kind: 'unknown', reason: 'counter delta spans observations recorded in the same instant' }
  return { values: delta, usageTime, status: coverageStatus,
    advance: coverageStatus !== 'unresolved' }
}

export interface CounterIngestInput {
  key: CounterIdentity
  accountingKey: string
  readingId: string
  values: UsageValues
  observedAt: number
  recordedAt: number
  relation: CounterEpochRelation
  hasEpochEvidence: boolean
}

export type CounterIngestOutcome =
  | { written: true }
  | { written: false; reason: string }

/**
 * Decide whether this observation may move the counter's confirmed position.
 * A new epoch is accepted only as a declared, evidenced disjoint reset; a value
 * below the same lineage's own prior snapshot is never a baseline.
 */
export function ingestCounterCheckpoint(
  db: DatabaseSync,
  input: CounterIngestInput
): CounterIngestOutcome {
  const own = readCounterRow(db, input.key, input.accountingKey)
  if (!own) {
    if (otherCounterEpochExists(db, input.key) &&
        !(input.relation === 'disjoint' && input.hasEpochEvidence)) {
      return { written: false, reason: 'counter epoch changed without an evidenced disjoint reset' }
    }
  } else if (subtractUsageValues(input.values,
      parseCounterValues(own.values_json, input.values)) === null) {
    return { written: false, reason: 'counter decrease awaiting reset or correction evidence' }
  }
  db.prepare(
    `INSERT INTO usage_counter_checkpoints
       (harness_id,accounting_namespace,counter_scope,counter_epoch,measurement_key,accounting_key,
        entry_revision,reading_id,values_json,observed_at,recorded_at)
     VALUES (?,?,?,?,?,?,0,?,?,?,?)
     ON CONFLICT(harness_id,accounting_namespace,counter_scope,counter_epoch,measurement_key,
       accounting_key)
     DO UPDATE SET reading_id=excluded.reading_id,values_json=excluded.values_json,
       observed_at=excluded.observed_at,recorded_at=excluded.recorded_at`
  ).run(input.key.harnessId, input.key.accountingNamespace, input.key.counterScope,
    input.key.counterEpoch, input.key.measurementKey, input.accountingKey, input.readingId,
    JSON.stringify(input.values), input.observedAt, input.recordedAt)
  return { written: true }
}

export function setCounterEntryRevision(
  db: DatabaseSync,
  key: CounterIdentity,
  accountingKey: string,
  revision: number
): void {
  db.prepare(
    `UPDATE usage_counter_checkpoints SET entry_revision=?
     WHERE harness_id=? AND accounting_namespace=? AND counter_scope=? AND counter_epoch=? AND
       measurement_key=? AND accounting_key=?`
  ).run(revision, key.harnessId, key.accountingNamespace, key.counterScope, key.counterEpoch,
    key.measurementKey, accountingKey)
}

// ── chain recompute ─────────────────────────────────────────────────────────

export interface ChainEntryView {
  entryId: string
  coverage: readonly UsageCoverageRef[]
  streamRole: UsageStreamRole
  /** current accounting status; a held row never becomes the next baseline */
  accountingStatus: UsageAccountingStatus
}

export interface ChainEntryWrite {
  accountingKey: string
  row: CounterRow
  normalization: CounterNormalization
  createdAt: number
}

/** Ledger-side port: the counter module never writes usage_entries itself. */
export interface ChainEntryPort {
  entryIdFor(accountingKey: string): string
  read(entryId: string): ChainEntryView | null
  write(input: ChainEntryWrite): void
}

export interface CounterChainResult {
  recomputed: number
  exhausted: boolean
  cursor: CounterChainCursor | null
}

/** Bounded page size for the ingest-time recompute. */
export const CHAIN_RECOMPUTE_LIMIT = 512

/** Stable id for a deferred recompute cursor so a repeated correction coalesces. */
export function counterRecomputeIntentId(key: CounterIdentity, cursor: CounterChainCursor): string {
  return 'recompute_' + createHash('sha256').update([key.harnessId, key.accountingNamespace,
    key.counterScope, key.counterEpoch, key.measurementKey, String(cursor.observedAt),
    String(cursor.recordedAt), cursor.accountingKey].join('\u0000')).digest('hex')
}

export function enqueueCounterRecompute(
  db: DatabaseSync,
  key: CounterIdentity,
  cursor: CounterChainCursor,
  reason: string,
  createdAt: number
): string {
  const id = counterRecomputeIntentId(key, cursor)
  db.prepare(
    `INSERT INTO usage_counter_recompute_intents
       (id,harness_id,accounting_namespace,counter_scope,counter_epoch,measurement_key,
        after_observed_at,after_recorded_at,after_accounting_key,reason,state,created_at,applied_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,NULL)
     ON CONFLICT(id) DO UPDATE SET reason=excluded.reason, state='pending', applied_at=NULL`
  ).run(id, key.harnessId, key.accountingNamespace, key.counterScope, key.counterEpoch,
    key.measurementKey, cursor.observedAt, cursor.recordedAt, cursor.accountingKey, reason, createdAt)
  return id
}

export interface CounterRecomputeIntent {
  id: string
  key: CounterIdentity
  cursor: CounterChainCursor
  reason: string
  state: 'pending' | 'applied'
  createdAt: number
  appliedAt: number | null
}

export function listCounterRecomputeIntents(
  db: DatabaseSync,
  options: { state?: 'pending' | 'applied'; limit?: number } = {}
): CounterRecomputeIntent[] {
  const state = options.state ?? 'pending'
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000))
  const rows = db.prepare(
    `SELECT * FROM usage_counter_recompute_intents WHERE state=?
     ORDER BY created_at,id LIMIT ?`
  ).all(state, limit) as unknown as Array<{
    id: string; harness_id: string; accounting_namespace: string; counter_scope: string
    counter_epoch: string; measurement_key: string; after_observed_at: number
    after_recorded_at: number; after_accounting_key: string; reason: string
    state: 'pending' | 'applied'; created_at: number; applied_at: number | null
  }>
  return rows.map((row) => ({
    id: row.id,
    key: { harnessId: row.harness_id, accountingNamespace: row.accounting_namespace,
      counterScope: row.counter_scope, counterEpoch: row.counter_epoch,
      measurementKey: row.measurement_key },
    cursor: { observedAt: row.after_observed_at, recordedAt: row.after_recorded_at,
      accountingKey: row.after_accounting_key },
    reason: row.reason, state: row.state, createdAt: row.created_at, appliedAt: row.applied_at
  }))
}

/** Advance a deferred recompute: applied when the page was the last one. */
export function applyCounterRecomputeIntent(
  db: DatabaseSync,
  id: string,
  cursor: CounterChainCursor | null,
  appliedAt: number
): void {
  if (cursor === null) {
    db.prepare(
      `UPDATE usage_counter_recompute_intents SET state='applied', applied_at=? WHERE id=?`
    ).run(appliedAt, id)
    return
  }
  db.prepare(
    `UPDATE usage_counter_recompute_intents SET after_observed_at=?, after_recorded_at=?,
       after_accounting_key=?, created_at=? WHERE id=?`
  ).run(cursor.observedAt, cursor.recordedAt, cursor.accountingKey, appliedAt, id)
}

/**
 * Re-normalize every observation at or after `from`, in counter order, against
 * the last confirmed position before it. Later rows keep their own source
 * values; only the ledger entry each row accounts for is rewritten, and the
 * caller decides (through the port) whether an unchanged row needs a revision.
 */
export function recomputeCounterChain(
  db: DatabaseSync,
  key: CounterIdentity,
  from: CounterChainCursor,
  port: ChainEntryPort,
  options: {
    limit?: number
    changedAt: number
    /** entry view for a lineage whose first revision this commit is writing */
    pending?: { accountingKey: string; view: ChainEntryView } | null
  }
): CounterChainResult {
  const rows = counterRows(db, key)
  const start = rows.findIndex((row) => row.observed_at === from.observedAt &&
    row.recorded_at === from.recordedAt && row.accounting_key === from.accountingKey)
  if (start < 0) return { recomputed: 0, exhausted: true, cursor: null }
  const limit = Math.max(1, Math.min(options.limit ?? CHAIN_RECOMPUTE_LIMIT, 5_000))
  const end = Math.min(rows.length, start + limit)
  // The baseline is the closest PRECEDING row the ledger still counts toward the
  // counter. A row that was held (unresolved) at its own normalization is an
  // observation we did not confirm, so the next delta must start from before it
  // rather than counting the held increase twice.
  let baseline: CounterRow | null = null
  for (let index = start - 1; index >= 0; index -= 1) {
    const candidate = rows[index]!
    const view = options.pending && options.pending.accountingKey === candidate.accounting_key
      ? options.pending.view
      : port.read(port.entryIdFor(candidate.accounting_key))
    if (view && view.accountingStatus !== 'unresolved') { baseline = candidate; break }
  }
  let recomputed = 0
  for (let index = start; index < end; index += 1) {
    const row = rows[index]!
    const view = options.pending && options.pending.accountingKey === row.accounting_key
      ? options.pending.view
      : port.read(port.entryIdFor(row.accounting_key))
    if (!view) continue
    const normalization = normalizeAgainstCheckpoint({
      values: parseCounterValues(row.values_json, EMPTY_USAGE_VALUES),
      observedAt: row.observed_at,
      baseline,
      coverageStatus: usageStatusFor(view.streamRole, view.coverage)
    })
    port.write({ accountingKey: row.accounting_key, row, normalization,
      createdAt: options.changedAt })
    if (normalization.advance) baseline = row
    recomputed += 1
  }
  const next = end < rows.length ? rows[end]! : null
  return { recomputed, exhausted: next === null, cursor: next ? counterCursorOf(next) : null }
}
