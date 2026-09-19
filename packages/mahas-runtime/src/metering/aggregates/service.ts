import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { withTx } from '../../storage/transaction.ts'
import { bucketForInterval, bucketForPoint, type TimeBucket } from './time.ts'
import type {
  AggregateChange,
  AggregateChangeSource,
  AggregateCursor,
  AggregateEntryProjection,
  AggregateFreshness,
  ModelDimension,
  SummaryFilter,
  SummaryQueryOptions,
  SummaryQueryResult,
  TokenTotals,
  UsageDimensions,
  UsageSummary,
  VerifiedPoolShare
} from './types.ts'

/** Bumped whenever the derivation below changes meaning; a published
 * generation with another revision is never refreshed into, it is replaced by
 * a fresh generation that converges through the durable change feed. */
export const USAGE_SUMMARY_DEFINITION_REVISION = 2

const DEFAULT_PAGE = 500
/** Internal walk page for dimension-filtered queries. */
const QUERY_FETCH = 400

interface StoredContribution {
  dimensions: UsageDimensions
  bucket: TimeBucket
  totals: TokenTotals
  entryCount: number
  unallocatedTokens: number
  unknownAttributionTokens: number
  /** Unallocated/unattributed with an unknown amount: the numeric columns
   * above stay a lower bound instead of reading as "nothing was unallocated". */
  unallocatedUnquantified: number
  unattributedUnquantified: number
}

export interface MeteringAggregateGeneration {
  generation: number
  definition_revision: number
  ledger_watermark: number
  attribution_watermark: number
  pool_claim_watermark: string
  pool_claim_cursor: string
  time_zone: string
  week_start: number
}

type GenerationRow = MeteringAggregateGeneration

const tokenKeys: readonly (keyof TokenTotals)[] = [
  'inputTotal',
  'outputTotal',
  'total',
  'cacheReadInput',
  'cacheWriteInput',
  'reasoningOutput'
]
const knownColumns: Record<keyof TokenTotals, string> = {
  inputTotal: 'input_known_count',
  outputTotal: 'output_known_count',
  total: 'total_known_count',
  cacheReadInput: 'cache_read_known_count',
  cacheWriteInput: 'cache_write_known_count',
  reasoningOutput: 'reasoning_known_count'
}

export function stableKey(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function summaryKey(dimensions: UsageDimensions, bucket: TimeBucket): string {
  return createHash('sha256').update(stableKey({ dimensions, bucket })).digest('hex')
}

function emptyTotals(): TokenTotals {
  return {
    inputTotal: null,
    outputTotal: null,
    total: null,
    cacheReadInput: null,
    cacheWriteInput: null,
    reasoningOutput: null
  }
}

/* ── generation lifecycle ────────────────────────────────────────────────── */

function generationRow(db: DatabaseSync, generation: number): GenerationRow | undefined {
  return db
    .prepare(
      `SELECT generation,definition_revision,ledger_watermark,attribution_watermark,
    pool_claim_watermark,pool_claim_cursor,time_zone,week_start
    FROM metering_aggregate_generations WHERE generation=?`
    )
    .get(generation) as GenerationRow | undefined
}

export function publishedGeneration(db: DatabaseSync): GenerationRow | undefined {
  return db
    .prepare(
      `SELECT generation,definition_revision,ledger_watermark,attribution_watermark,
    pool_claim_watermark,pool_claim_cursor,time_zone,week_start
    FROM metering_aggregate_generations WHERE state='published'`
    )
    .get() as GenerationRow | undefined
}

function decodeResume(text: string): AggregateCursor['poolClaimResume'] {
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as { connectionId?: string; entryId?: string }
    return parsed.connectionId && parsed.entryId
      ? { connectionId: parsed.connectionId, entryId: parsed.entryId }
      : null
  } catch {
    return null
  }
}

function encodeResume(resume: AggregateCursor['poolClaimResume']): string {
  return resume
    ? JSON.stringify({ connectionId: resume.connectionId, entryId: resume.entryId })
    : ''
}

function cursorOf(row: GenerationRow): AggregateCursor {
  return {
    ledger: row.ledger_watermark,
    attribution: row.attribution_watermark,
    poolClaim: row.pool_claim_watermark,
    poolClaimResume: decodeResume(row.pool_claim_cursor)
  }
}

function saveCursor(db: DatabaseSync, generation: number, cursor: AggregateCursor): void {
  db.prepare(
    `UPDATE metering_aggregate_generations
    SET ledger_watermark=?,attribution_watermark=?,pool_claim_watermark=?,pool_claim_cursor=?
    WHERE generation=?`
  ).run(
    cursor.ledger,
    cursor.attribution,
    cursor.poolClaim,
    encodeResume(cursor.poolClaimResume),
    generation
  )
}

/** A generation that changed its time zone or definition cannot absorb a
 * refresh: retire it and start a fresh published generation that the feed
 * refills, instead of mixing bucket semantics in one generation. */
function ensureGeneration(
  db: DatabaseSync,
  now: number,
  options: RefreshAggregatesOptions
): GenerationRow {
  const found = publishedGeneration(db)
  const weekStart = options.weekStart ?? 1
  if (
    found &&
    found.definition_revision === USAGE_SUMMARY_DEFINITION_REVISION &&
    found.time_zone === options.timeZone &&
    found.week_start === weekStart
  )
    return found
  const generation = withTx(db, (tx) => {
    tx.prepare(
      `UPDATE metering_aggregate_generations SET state='retired' WHERE state='published'`
    ).run()
    const created = tx
      .prepare(
        `INSERT INTO metering_aggregate_generations
      (state,definition_revision,time_zone,week_start,created_at,published_at) VALUES ('published',?,?,?,?,?)`
      )
      .run(USAGE_SUMMARY_DEFINITION_REVISION, options.timeZone, weekStart, now, now)
    return Number(created.lastInsertRowid)
  })
  return generationRow(db, generation)!
}

function deleteGeneration(db: DatabaseSync, generation: number): void {
  db.prepare('DELETE FROM metering_aggregate_contributions WHERE generation=?').run(generation)
  db.prepare('DELETE FROM metering_usage_summaries WHERE generation=?').run(generation)
  db.prepare(
    `DELETE FROM metering_aggregate_generations WHERE generation=? AND state='building'`
  ).run(generation)
}

/** Drop building generations left behind by an interrupted or abandoned
 * rebuild. Only publication can leave `building`, so every such row is dead
 * work and its summaries must not be queried or counted as a generation. */
export function pruneAbandonedGenerations(db: DatabaseSync): number {
  const rows = db
    .prepare(`SELECT generation FROM metering_aggregate_generations WHERE state='building'`)
    .all() as unknown as Array<{ generation: number }>
  if (!rows.length) return 0
  withTx(db, (tx) => {
    for (const row of rows) deleteGeneration(tx, row.generation)
  })
  return rows.length
}

/* ── contribution derivation ─────────────────────────────────────────────── */

function amountOf(entry: AggregateEntryProjection): number | null {
  if (entry.totals.total !== null) return entry.totals.total
  if (entry.totals.inputTotal !== null && entry.totals.outputTotal !== null) {
    return entry.totals.inputTotal + entry.totals.outputTotal
  }
  return null
}

function isUnattributed(entry: AggregateEntryProjection): boolean {
  return (
    entry.attributionStatus === 'unknown' ||
    (!entry.dimensions.providerId && !entry.dimensions.offeringId && !entry.dimensions.connectionId)
  )
}

function enrichProjection(
  entry: AggregateEntryProjection | null,
  source: AggregateChangeSource
): AggregateEntryProjection | null {
  if (!entry?.dimensions.connectionId || !source.verifiedPoolForConnection) return entry
  const at =
    entry.usageTime.kind === 'point'
      ? entry.usageTime.at
      : entry.usageTime.kind === 'interval'
        ? entry.usageTime.endInclusive
        : null
  entry.dimensions.verifiedPool = source.verifiedPoolForConnection(
    entry.dimensions.connectionId,
    at
  )
  return entry
}

function model(value: ModelDimension | null | undefined): ModelDimension | null {
  return value
    ? {
        namespace: value.namespace,
        nativeName: value.nativeName,
        ...(value.modelId ? { modelId: value.modelId } : {})
      }
    : null
}

/** Dimension sets a summary may be filtered by. They are combinations that
 * answer a real question, not the cross product of every axis. */
function dimensionSets(entry: AggregateEntryProjection): UsageDimensions[] {
  const d = entry.dimensions
  const machine = d.machineId ? { machineId: d.machineId } : {}
  const base = { ...machine, harnessId: d.harnessId! }
  const providerScope = { ...machine, providerId: d.providerId ?? null }
  const offeringScope = { ...base, offeringId: d.offeringId ?? null }
  const connectionScope = { ...offeringScope, connectionId: d.connectionId ?? null }
  const requestedModel = model(d.requestedModel)
  const servedModel = model(d.servedModel)
  const result: UsageDimensions[] = [
    {},
    ...(d.sessionId ? [{ sessionId: d.sessionId }] : []),
    base,
    providerScope,
    offeringScope,
    connectionScope,
    { requestedModel },
    { servedModel },
    { ...base, requestedModel },
    { ...base, servedModel }
  ]
  if (d.verifiedPool) {
    result.push({ verifiedPool: d.verifiedPool }, { ...base, verifiedPool: d.verifiedPool })
  }
  const seen = new Set<string>()
  return result.filter((item) => {
    const key = stableKey(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function timeBuckets(
  entry: AggregateEntryProjection,
  timeZone: string,
  weekStart: number
): { bucket: TimeBucket; unallocated: boolean }[] {
  const all: { bucket: TimeBucket; unallocated: boolean }[] = [
    {
      bucket: { grain: 'alltime', startUtc: null, endUtc: null, timeZone, weekStart },
      unallocated: entry.usageTime.kind === 'unknown'
    }
  ]
  if (entry.usageTime.kind === 'unknown') return all
  for (const grain of ['hour', 'day', 'week'] as const) {
    const bucket =
      entry.usageTime.kind === 'point'
        ? bucketForPoint(entry.usageTime.at, grain, timeZone, weekStart)
        : bucketForInterval(
            entry.usageTime.startExclusive,
            entry.usageTime.endInclusive,
            grain,
            timeZone,
            weekStart
          )
    if (bucket) all.push({ bucket, unallocated: false })
  }
  // The all-time row exposes any amount that could not be assigned at the
  // finest requested grain; coarser rows are still valid when their entire
  // interval fits.
  if (entry.usageTime.kind === 'interval' && !all.some((x) => x.bucket.grain === 'hour'))
    all[0]!.unallocated = true
  return all
}

function contributions(
  entry: AggregateEntryProjection | null,
  timeZone: string,
  weekStart: number
): StoredContribution[] {
  if (!entry || entry.accountingStatus !== 'counted') return []
  const amount = amountOf(entry)
  const quantifiable = amount !== null
  const unattributed = isUnattributed(entry)
  const result: StoredContribution[] = []
  for (const dimensions of dimensionSets(entry))
    for (const { bucket, unallocated } of timeBuckets(entry, timeZone, weekStart)) {
      result.push({
        dimensions,
        bucket,
        totals: entry.totals,
        entryCount: 1,
        unallocatedTokens: unallocated && quantifiable ? amount : 0,
        unknownAttributionTokens: unattributed && quantifiable ? amount : 0,
        unallocatedUnquantified: unallocated && !quantifiable ? 1 : 0,
        unattributedUnquantified: unattributed && !quantifiable ? 1 : 0
      })
    }
  return result
}

function temporalOf(
  unallocated: number,
  unquantified: number,
  amount: number | null
): UsageSummary['coverage']['temporal'] {
  if (unallocated === 0 && unquantified === 0) return 'allocated'
  if (unquantified > 0) return 'partially-unallocated'
  return amount !== null && unallocated >= amount ? 'unallocated' : 'partially-unallocated'
}

function attributionStatusOf(
  unattributed: number,
  unquantified: number,
  amount: number | null
): UsageSummary['attributionCoverage']['status'] {
  if (unattributed === 0 && unquantified === 0) return 'complete'
  if (unquantified > 0) return 'partial'
  return amount !== null && unattributed >= amount ? 'unknown' : 'partial'
}

function mutateSummary(
  db: DatabaseSync,
  generation: number,
  c: StoredContribution,
  direction: 1 | -1,
  watermarks: AggregateCursor,
  now: number
): void {
  const key = summaryKey(c.dimensions, c.bucket)
  const row = db
    .prepare('SELECT * FROM metering_usage_summaries WHERE generation=? AND summary_key=?')
    .get(generation, key) as Record<string, unknown> | undefined
  const currentTotals: TokenTotals = row
    ? {
        inputTotal: row['input_tokens'] as number | null,
        outputTotal: row['output_tokens'] as number | null,
        total: row['total_tokens'] as number | null,
        cacheReadInput: row['cache_read_input_tokens'] as number | null,
        cacheWriteInput: row['cache_write_input_tokens'] as number | null,
        reasoningOutput: row['reasoning_output_tokens'] as number | null
      }
    : emptyTotals()
  const known = {} as Record<keyof TokenTotals, number>
  for (const field of tokenKeys) {
    const oldKnown = Number(row?.[knownColumns[field]] ?? 0)
    const value = c.totals[field]
    known[field] = Math.max(0, oldKnown + (value === null ? 0 : direction))
    const sum = Math.max(0, (currentTotals[field] ?? 0) + (value === null ? 0 : direction * value))
    currentTotals[field] = known[field] === 0 ? null : sum
  }
  const entries = Math.max(0, Number(row?.['entry_count'] ?? 0) + direction * c.entryCount)
  const unallocated = Math.max(
    0,
    Number(row?.['unallocated_tokens'] ?? 0) + direction * c.unallocatedTokens
  )
  const unattributed = Math.max(
    0,
    Number(row?.['unknown_attribution_tokens'] ?? 0) + direction * c.unknownAttributionTokens
  )
  const unallocatedUnknown = Math.max(
    0,
    Number(row?.['unallocated_unknown_entries'] ?? 0) + direction * c.unallocatedUnquantified
  )
  const unattributedUnknown = Math.max(
    0,
    Number(row?.['unknown_attribution_unknown_entries'] ?? 0) +
      direction * c.unattributedUnquantified
  )
  const amount = currentTotals.total
  const completeTotals = entries > 0 && known.total === entries
  db.prepare(
    `INSERT INTO metering_usage_summaries
    (generation,summary_key,revision,definition_revision,dimensions_json,grain,bucket_start_utc,bucket_end_utc,
     time_zone,week_start,input_tokens,output_tokens,total_tokens,cache_read_input_tokens,
     cache_write_input_tokens,reasoning_output_tokens,input_known_count,output_known_count,total_known_count,
     cache_read_known_count,cache_write_known_count,reasoning_known_count,entry_count,unallocated_tokens,unknown_attribution_tokens,
     unallocated_unknown_entries,unknown_attribution_unknown_entries,
     coverage_json,attribution_coverage_json,ledger_watermark,attribution_watermark,pool_claim_watermark,computed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(generation,summary_key) DO UPDATE SET revision=revision+1,
     input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,total_tokens=excluded.total_tokens,
     cache_read_input_tokens=excluded.cache_read_input_tokens,cache_write_input_tokens=excluded.cache_write_input_tokens,
     reasoning_output_tokens=excluded.reasoning_output_tokens,input_known_count=excluded.input_known_count,
     output_known_count=excluded.output_known_count,total_known_count=excluded.total_known_count,
     cache_read_known_count=excluded.cache_read_known_count,cache_write_known_count=excluded.cache_write_known_count,
     reasoning_known_count=excluded.reasoning_known_count,entry_count=excluded.entry_count,
     unallocated_tokens=excluded.unallocated_tokens,unknown_attribution_tokens=excluded.unknown_attribution_tokens,
     unallocated_unknown_entries=excluded.unallocated_unknown_entries,
     unknown_attribution_unknown_entries=excluded.unknown_attribution_unknown_entries,
     coverage_json=excluded.coverage_json,attribution_coverage_json=excluded.attribution_coverage_json,
     ledger_watermark=excluded.ledger_watermark,attribution_watermark=excluded.attribution_watermark,
     pool_claim_watermark=excluded.pool_claim_watermark,computed_at=excluded.computed_at`
  ).run(
    generation,
    key,
    1,
    USAGE_SUMMARY_DEFINITION_REVISION,
    stableKey(c.dimensions),
    c.bucket.grain,
    c.bucket.startUtc,
    c.bucket.endUtc,
    c.bucket.timeZone,
    c.bucket.weekStart,
    currentTotals.inputTotal,
    currentTotals.outputTotal,
    currentTotals.total,
    currentTotals.cacheReadInput,
    currentTotals.cacheWriteInput,
    currentTotals.reasoningOutput,
    known.inputTotal,
    known.outputTotal,
    known.total,
    known.cacheReadInput,
    known.cacheWriteInput,
    known.reasoningOutput,
    entries,
    unallocated,
    unattributed,
    unallocatedUnknown,
    unattributedUnknown,
    JSON.stringify({
      temporal: temporalOf(unallocated, unallocatedUnknown, amount),
      completeTotals,
      knownEntriesByComponent: known,
      unquantifiedUnallocatedEntries: unallocatedUnknown,
      unquantifiedUnattributedEntries: unattributedUnknown
    }),
    JSON.stringify({
      status: attributionStatusOf(unattributed, unattributedUnknown, amount),
      unknownTokens: unattributed
    }),
    watermarks.ledger,
    watermarks.attribution,
    watermarks.poolClaim,
    now
  )
}

function replaceEntryContributions(
  db: DatabaseSync,
  generation: number,
  entryId: string,
  next: StoredContribution[],
  watermarks: AggregateCursor,
  now: number
): void {
  const old = db
    .prepare(
      `SELECT summary_key,contribution_json FROM metering_aggregate_contributions
    WHERE generation=? AND entry_id=?`
    )
    .all(generation, entryId) as unknown as Array<{
    summary_key: string
    contribution_json: string
  }>
  for (const item of old)
    mutateSummary(
      db,
      generation,
      JSON.parse(item.contribution_json) as StoredContribution,
      -1,
      watermarks,
      now
    )
  db.prepare('DELETE FROM metering_aggregate_contributions WHERE generation=? AND entry_id=?').run(
    generation,
    entryId
  )
  for (const item of next) {
    const key = summaryKey(item.dimensions, item.bucket)
    mutateSummary(db, generation, item, 1, watermarks, now)
    db.prepare(
      `INSERT INTO metering_aggregate_contributions
      (generation,entry_id,summary_key,contribution_json) VALUES (?,?,?,?)`
    ).run(generation, entryId, key, JSON.stringify(item))
  }
  /* A correction that moves an entry to another dimension leaves the previous
   * summary empty. A rebuild would never create such a row, so the incremental
   * path drops it as well — otherwise refresh and rebuild disagree. */
  const touched = new Set<string>([
    ...old.map((item) => item.summary_key),
    ...next.map((item) => summaryKey(item.dimensions, item.bucket))
  ])
  for (const key of touched)
    if (isEmptied(db, generation, key)) {
      db.prepare('DELETE FROM metering_usage_summaries WHERE generation=? AND summary_key=?').run(
        generation,
        key
      )
    }
}

function isEmptied(db: DatabaseSync, generation: number, key: string): boolean {
  const row = db
    .prepare(
      `SELECT entry_count,unallocated_tokens,unknown_attribution_tokens,
    unallocated_unknown_entries,unknown_attribution_unknown_entries
    FROM metering_usage_summaries WHERE generation=? AND summary_key=?`
    )
    .get(generation, key) as Record<string, number> | undefined
  if (!row) return false
  const empty =
    Number(row['entry_count']) === 0 &&
    Number(row['unallocated_tokens']) === 0 &&
    Number(row['unknown_attribution_tokens']) === 0 &&
    Number(row['unallocated_unknown_entries']) === 0 &&
    Number(row['unknown_attribution_unknown_entries']) === 0
  if (!empty) return false
  const known = db
    .prepare(
      `SELECT COALESCE(SUM(input_known_count+output_known_count+total_known_count+
    cache_read_known_count+cache_write_known_count+reasoning_known_count),0) AS n
    FROM metering_usage_summaries WHERE generation=? AND summary_key=?`
    )
    .get(generation, key) as { n: number }
  if (Number(known.n) !== 0) return false
  return (
    db
      .prepare(
        'SELECT 1 AS present FROM metering_aggregate_contributions WHERE generation=? AND summary_key=? LIMIT 1'
      )
      .get(generation, key) === undefined
  )
}

function applyEntryIds(
  db: DatabaseSync,
  generation: number,
  source: AggregateChangeSource,
  options: RefreshAggregatesOptions,
  entryIds: Iterable<string>,
  cursor: AggregateCursor,
  now: number
): number {
  let applied = 0
  for (const entryId of entryIds) {
    const projection = enrichProjection(source.readEntryProjection(entryId), source)
    replaceEntryContributions(
      db,
      generation,
      entryId,
      contributions(projection, options.timeZone, options.weekStart ?? 1),
      cursor,
      now
    )
    applied++
  }
  return applied
}

function markIntentsApplied(
  db: DatabaseSync,
  generation: number,
  changes: readonly AggregateChange[]
): void {
  const statement =
    db.prepare(`UPDATE usage_aggregate_intents SET state='applied',applied_generation=?
    WHERE change_sequence=? AND state='pending'`)
  for (const change of changes) {
    if (change.ledgerSequence === null) continue
    statement.run(String(generation), change.ledgerSequence)
  }
}

function dedupeEntryIds(changes: readonly AggregateChange[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const change of changes) {
    if (seen.has(change.entryId)) continue
    seen.add(change.entryId)
    ordered.push(change.entryId)
  }
  return ordered
}

function pendingAgainst(high: AggregateCursor, cursor: AggregateCursor): boolean {
  return (
    high.ledger > cursor.ledger ||
    high.attribution > cursor.attribution ||
    high.poolClaim !== cursor.poolClaim
  )
}

export interface RefreshAggregatesOptions {
  timeZone: string
  weekStart?: number
  limit?: number
  now?: number
  /** Bounded publish attempts when the source keeps changing under a rebuild. */
  maxPublishAttempts?: number
}

export interface RefreshAggregatesResult {
  generation: number
  applied: number
  pending: boolean
  cursor: AggregateCursor
  ledgerWatermark: number
  attributionWatermark: number
}

export class AggregateRebuildConflict extends Error {
  readonly code = 'aggregate-rebuild-conflict'
  /** Not a constructor parameter property: Node's type stripping cannot run those. */
  readonly generation: number
  readonly attempts: number
  constructor(generation: number, attempts: number) {
    super(
      `usage ledger kept changing during ${attempts} publish attempts; the abandoned build was dropped`
    )
    this.name = 'AggregateRebuildConflict'
    this.generation = generation
    this.attempts = attempts
  }
}

/** Apply one bounded change-feed batch and persist the consumed cursor in the
 * same transaction as the summaries it produced: a retry after a crash either
 * sees both or neither, so replayed changes never double-count. */
export function refreshUsageAggregates(
  db: DatabaseSync,
  source: AggregateChangeSource,
  options: RefreshAggregatesOptions
): RefreshAggregatesResult {
  const now = options.now ?? Date.now()
  const generation = ensureGeneration(db, now, options)
  const cursor = cursorOf(generation)
  const limit = Math.max(1, options.limit ?? DEFAULT_PAGE)
  const outcome = withTx(db, (tx) => {
    // Read the feed under the write lock so the checkpoint cannot be paired
    // with projections that were already superseded by a concurrent commit.
    const batch = source.readChanges(cursor, limit)
    if (!batch.changes.length) return { applied: 0, cursor }
    const entryIds = dedupeEntryIds(batch.changes)
    const applied = applyEntryIds(
      tx,
      generation.generation,
      source,
      options,
      entryIds,
      batch.cursor,
      now
    )
    saveCursor(tx, generation.generation, batch.cursor)
    markIntentsApplied(tx, generation.generation, batch.changes)
    return { applied, cursor: batch.cursor }
  })
  const high = source.highWatermarks()
  return {
    generation: generation.generation,
    applied: outcome.applied,
    pending: pendingAgainst(high, outcome.cursor),
    cursor: outcome.cursor,
    ledgerWatermark: outcome.cursor.ledger,
    attributionWatermark: outcome.cursor.attribution
  }
}

export interface RebuildAggregatesResult {
  generation: number
  /** Counted entries the snapshot scan folded into the new generation. */
  scanned: number
  /** Entries the catch-up feed re-applied because they changed mid-rebuild. */
  caughtUp: number
  /** Abandoned building generations dropped before this rebuild started. */
  pruned: number
  publishAttempts: number
  cursor: AggregateCursor
}

/** Build a new generation beside the published one from the durable ledger in
 * bounded pages, catch up the changes that landed during the scan, then flip
 * publication in one short write transaction. The previously published
 * generation stays queryable until that flip. */
export function rebuildUsageAggregates(
  db: DatabaseSync,
  source: AggregateChangeSource,
  options: RefreshAggregatesOptions
): RebuildAggregatesResult {
  if (!source.scanCountedEntries)
    throw new Error('aggregate source does not support ledger rebuild scanning')
  const now = options.now ?? Date.now()
  const limit = Math.max(1, options.limit ?? DEFAULT_PAGE)
  const pruned = pruneAbandonedGenerations(db)
  const snapshot = source.highWatermarks()
  const created = db
    .prepare(
      `INSERT INTO metering_aggregate_generations
    (state,definition_revision,time_zone,week_start,created_at) VALUES ('building',?,?,?,?)`
    )
    .run(USAGE_SUMMARY_DEFINITION_REVISION, options.timeZone, options.weekStart ?? 1, now)
  const generation = Number(created.lastInsertRowid)

  let scanned = 0
  let afterId: string | null = null
  try {
    for (;;) {
      const page = source.scanCountedEntries(afterId, limit, snapshot)
      if (!page.length) break
      withTx(db, (tx) => {
        for (const entry of page) {
          replaceEntryContributions(
            tx,
            generation,
            entry.id,
            contributions(
              enrichProjection(entry, source),
              options.timeZone,
              options.weekStart ?? 1
            ),
            { ledger: 0, attribution: 0, poolClaim: '' },
            now
          )
        }
      })
      scanned += page.length
      afterId = page[page.length - 1]!.id
      // A short page means the snapshot scan is exhausted; the catch-up feed
      // below, not another scan page, owns everything newer.
      if (page.length < limit) break
    }

    let cursor: AggregateCursor = snapshot
    let caughtUp = 0
    let attempts = 0
    const maxAttempts = Math.max(1, options.maxPublishAttempts ?? 3)
    for (;;) {
      attempts++
      const attempt = withTx(db, (tx) => {
        let feed = cursor
        let applied = 0
        for (;;) {
          const batch = source.readChanges(feed, limit)
          if (!batch.changes.length) break
          applied += applyEntryIds(
            tx,
            generation,
            source,
            options,
            dedupeEntryIds(batch.changes),
            batch.cursor,
            now
          )
          feed = batch.cursor
        }
        const high = source.highWatermarks()
        if (pendingAgainst(high, feed)) return { published: false as const, cursor: feed, applied }
        tx.prepare(
          `UPDATE metering_usage_summaries SET ledger_watermark=?,attribution_watermark=?,
          pool_claim_watermark=? WHERE generation=?`
        ).run(feed.ledger, feed.attribution, feed.poolClaim, generation)
        tx.prepare(
          `UPDATE usage_aggregate_intents SET state='applied',applied_generation=?
          WHERE change_sequence<=? AND state='pending'`
        ).run(String(generation), feed.ledger)
        tx.prepare(
          `UPDATE metering_aggregate_generations SET state='retired' WHERE state='published'`
        ).run()
        const flipped = tx
          .prepare(
            `UPDATE metering_aggregate_generations SET state='published',
          ledger_watermark=?,attribution_watermark=?,pool_claim_watermark=?,pool_claim_cursor='',published_at=?
          WHERE generation=? AND state='building'`
          )
          .run(feed.ledger, feed.attribution, feed.poolClaim, now, generation)
        if (Number(flipped.changes) !== 1)
          throw new Error(`aggregate generation ${generation} is no longer building`)
        return { published: true as const, cursor: feed, applied }
      })
      cursor = attempt.cursor
      caughtUp += attempt.applied
      if (attempt.published) {
        return { generation, scanned, caughtUp, pruned, publishAttempts: attempts, cursor }
      }
      if (attempts >= maxAttempts) {
        // Abandon this build instead of publishing a generation that omits a
        // concurrent change. The published generation was never touched.
        deleteGeneration(db, generation)
        throw new AggregateRebuildConflict(generation, attempts)
      }
    }
  } catch (error) {
    if (!(error instanceof AggregateRebuildConflict)) {
      // A failed scan must not leave an unreachable building generation behind.
      deleteGeneration(db, generation)
    }
    throw error
  }
}

/* ── queries over the published generation ───────────────────────────────── */

interface PageCursor {
  bucket: number
  key: string
}

function encodePageCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodePageCursor(value: string | null | undefined): PageCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as PageCursor
    return typeof parsed.bucket === 'number' && typeof parsed.key === 'string' ? parsed : null
  } catch {
    return null
  }
}

function matches(actual: unknown, expected: unknown): boolean {
  return expected === undefined || stableKey(actual) === stableKey(expected)
}

function mapSummary(row: Record<string, unknown>): UsageSummary {
  return {
    key: String(row['summary_key']),
    generation: Number(row['generation']),
    revision: Number(row['revision']),
    definitionRevision: Number(row['definition_revision']),
    dimensions: JSON.parse(String(row['dimensions_json'])) as UsageDimensions,
    timeBucket: {
      grain: row['grain'] as TimeBucket['grain'],
      startUtc: row['bucket_start_utc'] as number | null,
      endUtc: row['bucket_end_utc'] as number | null,
      timeZone: String(row['time_zone']),
      weekStart: Number(row['week_start'])
    },
    totals: {
      inputTotal: row['input_tokens'] as number | null,
      outputTotal: row['output_tokens'] as number | null,
      total: row['total_tokens'] as number | null,
      cacheReadInput: row['cache_read_input_tokens'] as number | null,
      cacheWriteInput: row['cache_write_input_tokens'] as number | null,
      reasoningOutput: row['reasoning_output_tokens'] as number | null
    },
    entryCount: Number(row['entry_count']),
    unallocatedTokens: Number(row['unallocated_tokens']),
    unknownAttributionTokens: Number(row['unknown_attribution_tokens']),
    coverage: JSON.parse(String(row['coverage_json'])) as UsageSummary['coverage'],
    attributionCoverage: JSON.parse(
      String(row['attribution_coverage_json'])
    ) as UsageSummary['attributionCoverage'],
    ledgerWatermark: Number(row['ledger_watermark']),
    attributionWatermark: Number(row['attribution_watermark']),
    poolClaimWatermark: String(row['pool_claim_watermark']),
    computedAt: Number(row['computed_at'])
  }
}

function summaryFilterParts(filter: SummaryFilter): {
  clauses: string[]
  args: (string | number)[]
  dimensions: UsageDimensions
} {
  const clauses = ['generation=?']
  const args: (string | number)[] = []
  if (filter.grain) {
    clauses.push('grain=?')
    args.push(filter.grain)
  }
  if (filter.startUtc !== undefined) {
    clauses.push('(bucket_end_utc IS NULL OR bucket_end_utc>?)')
    args.push(filter.startUtc)
  }
  if (filter.endUtc !== undefined) {
    clauses.push('(bucket_start_utc IS NULL OR bucket_start_utc<?)')
    args.push(filter.endUtc)
  }
  const dimensions = Object.fromEntries(
    Object.entries(filter).filter(([key]) => !['grain', 'startUtc', 'endUtc'].includes(key))
  ) as UsageDimensions
  return { clauses, args, dimensions }
}

interface WalkResult {
  rows: UsageSummary[]
  /** Position of the last examined row: the exact resume point of the walk. */
  last: PageCursor | null
  exhausted: boolean
}

/** Walk the published generation in keyset order, keeping only rows whose
 * dimensions match the filter. Rows come from the persisted projection, never
 * from the ledger or native logs. */
function walkSummaries(
  db: DatabaseSync,
  generation: number,
  filter: SummaryFilter,
  limit: number,
  cursor: PageCursor | null,
  dimensionKeys?: string[]
): WalkResult {
  const parts = summaryFilterParts(filter)
  // The exact-shape predicate belongs to the SQL, not the post-fetch scan:
  // the walk examines at most 32*QUERY_FETCH rows, so a shape filter applied
  // after paging could return an empty page with a live cursor while the {} row
  // sits beyond the guard. Set equality = same key count AND every wanted key
  // present (wanted keys are deduped, so equal counts imply equal sets).
  if (dimensionKeys !== undefined) {
    const wanted = JSON.stringify([...new Set(dimensionKeys)])
    parts.clauses.push(
      '(SELECT COUNT(*) FROM json_each(dimensions_json)) = (SELECT COUNT(*) FROM json_each(?))',
      'NOT EXISTS (SELECT 1 FROM json_each(?) wanted WHERE wanted.value NOT IN (SELECT actual.key FROM json_each(dimensions_json) actual))'
    )
    parts.args.push(wanted, wanted)
  }
  const rows: UsageSummary[] = []
  let last: PageCursor | null = null
  let position = cursor
  let exhausted = false
  let guard = 0
  while (rows.length < limit && guard < 32) {
    guard++
    // The statement is rebuilt per iteration because the keyset clause exists
    // only while a position is held — a scan that fills its first page without
    // a cursor would otherwise push position args the SQL has no binds for.
    const sql = `SELECT * FROM metering_usage_summaries WHERE ${parts.clauses.join(' AND ')}
      ${position ? 'AND (COALESCE(bucket_start_utc,-1)>? OR (COALESCE(bucket_start_utc,-1)=? AND summary_key>?))' : ''}
      ORDER BY COALESCE(bucket_start_utc,-1),summary_key LIMIT ?`
    const pageArgs: (string | number)[] = [generation, ...parts.args]
    if (position) pageArgs.push(position.bucket, position.bucket, position.key)
    pageArgs.push(QUERY_FETCH)
    const page = db.prepare(sql).all(...pageArgs) as unknown as Record<string, unknown>[]
    if (!page.length) {
      exhausted = true
      break
    }
    let examined: PageCursor | null = null
    for (const row of page) {
      examined = { bucket: Number(row['bucket_start_utc'] ?? -1), key: String(row['summary_key']) }
      const summary = mapSummary(row)
      if (
        !Object.entries(parts.dimensions).every(([k, v]) =>
          matches(summary.dimensions[k as keyof UsageDimensions], v)
        )
      )
        continue
      rows.push(summary)
      if (rows.length >= limit) break
    }
    position = examined ?? position
    last = position
    // The page was cut short by the caller's limit, so the rest of it is still
    // unexamined — the walk is not exhausted, it just stops here.
    if (rows.length >= limit) break
    if (page.length < QUERY_FETCH) {
      exhausted = true
      break
    }
  }
  return { rows, last, exhausted }
}

/** Query only the published generation, in bounded keyset pages. Combined
 * filters are conjunctive and rankings are a sort of these canonical summary
 * rows, never a second total. */
export function queryUsageSummaries(
  db: DatabaseSync,
  filter: SummaryFilter = {},
  options: SummaryQueryOptions = {}
): SummaryQueryResult {
  const generation = publishedGeneration(db)
  const limit = Math.max(1, Math.min(options.limit ?? 500, 5_000))
  if (!generation) {
    return {
      page: { summaries: [], nextCursor: null, exhausted: true },
      generation: null,
      freshness: {
        ledgerWatermark: 0,
        attributionWatermark: 0,
        poolClaimWatermark: '',
        pending: false,
        computedAt: null
      }
    }
  }
  const cursor = decodePageCursor(options.cursor)
  const walk = walkSummaries(
    db,
    generation.generation,
    filter,
    limit,
    cursor,
    options.dimensionKeys
  )
  const nextCursor = !walk.exhausted && walk.last ? encodePageCursor(walk.last) : null
  return {
    page: { summaries: walk.rows, nextCursor, exhausted: walk.exhausted },
    generation: generation.generation,
    freshness: freshnessOf(generation, options.source, walk.rows)
  }
}

function freshnessOf(
  generation: GenerationRow,
  source: Pick<AggregateChangeSource, 'highWatermarks'> | undefined,
  rows: readonly UsageSummary[]
): AggregateFreshness {
  const cursor = cursorOf(generation)
  let pending = false
  if (source) {
    const high = source.highWatermarks()
    pending = pendingAgainst(high, cursor)
  }
  return {
    ledgerWatermark: cursor.ledger,
    attributionWatermark: cursor.attribution,
    poolClaimWatermark: cursor.poolClaim,
    pending,
    computedAt: rows.length ? Math.max(...rows.map((row) => row.computedAt)) : null
  }
}

/** Rank matching summaries across the whole published generation. Ranking a
 * page would rank an arbitrary slice, so this walks the persisted rows and
 * keeps a bounded top-N. */
export function rankUsageSummaries(
  db: DatabaseSync,
  filter: SummaryFilter,
  limit = 20
): UsageSummary[] {
  const generation = publishedGeneration(db)
  if (!generation) return []
  const wanted = Math.max(1, Math.min(limit, 5_000))
  const best: UsageSummary[] = []
  for (const summary of allUsageSummaries(db, filter).summaries) {
    best.push(summary)
    if (best.length > wanted * 4) {
      best.sort((a, b) => (b.totals.total ?? -1) - (a.totals.total ?? -1))
      best.length = wanted
    }
  }
  return best.sort((a, b) => (b.totals.total ?? -1) - (a.totals.total ?? -1)).slice(0, wanted)
}

export interface AllSummariesResult {
  summaries: UsageSummary[]
  /** The last page reached the end of the generation. */
  exhausted: boolean
  pages: number
}

/** Every matching row of the published generation, page by page. Statistics,
 * rankings and pool shares must not treat a bounded page as the whole range. */
export function allUsageSummaries(
  db: DatabaseSync,
  filter: SummaryFilter = {},
  pageSize = 2_000
): AllSummariesResult {
  const summaries: UsageSummary[] = []
  let cursor: string | null = null
  for (let page = 1; page <= 10_000; page++) {
    const result = queryUsageSummaries(db, filter, {
      limit: Math.max(1, Math.min(pageSize, 5_000)),
      cursor
    })
    summaries.push(...result.page.summaries)
    if (result.page.exhausted || !result.page.nextCursor)
      return { summaries, exhausted: result.page.exhausted, pages: page }
    cursor = result.page.nextCursor
  }
  return { summaries, exhausted: false, pages: 10_000 }
}

/** Harness token shares of one verified provider pool. The denominator is the
 * pool-level row of the same bucket; entries whose totals are unknown are
 * reported as unknown rather than counted as zero. */
export function queryVerifiedPoolShares(
  db: DatabaseSync,
  filter: SummaryFilter & {
    verifiedPool: { providerPoolKey: string; scope: string }
  }
): VerifiedPoolShare[] {
  const generation = publishedGeneration(db)
  if (!generation) return []
  const grain = filter.grain ?? 'alltime'
  const rows = allUsageSummaries(db, { ...filter, grain }).summaries
  const bucketKey = (row: UsageSummary): string =>
    `${row.timeBucket.grain}:${row.timeBucket.startUtc ?? 'all'}:${row.timeBucket.endUtc ?? 'all'}`
  const poolRows = rows.filter((row) => !row.dimensions.harnessId && row.dimensions.verifiedPool)
  const harnessRows = rows.filter((row) => row.dimensions.harnessId && row.dimensions.verifiedPool)
  const shares: VerifiedPoolShare[] = []
  for (const denominatorRow of poolRows) {
    const denominator = denominatorRow.totals.total
    const known = denominatorRow.coverage.knownEntriesByComponent.total
    const coverage =
      denominatorRow.entryCount === 0 || known === 0
        ? 'unknown'
        : denominatorRow.coverage.completeTotals
          ? 'complete'
          : 'partial'
    for (const row of harnessRows) {
      if (bucketKey(row) !== bucketKey(denominatorRow)) continue
      shares.push({
        verifiedPool: filter.verifiedPool,
        dimensions: row.dimensions,
        timeBucket: denominatorRow.timeBucket,
        numerator: row.totals.total,
        denominator,
        share:
          denominator !== null && denominator > 0 && row.totals.total !== null
            ? row.totals.total / denominator
            : null,
        denominatorCoverage: coverage,
        unknownDenominatorEntries: Math.max(0, denominatorRow.entryCount - known)
      })
    }
  }
  return shares
}
