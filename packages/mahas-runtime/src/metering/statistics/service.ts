import type { DatabaseSync } from 'node:sqlite'
import { withTx } from '../../storage/transaction.ts'
import { bucketForPoint, completedWeekBuckets, localParts, type TimeBucket } from '../aggregates/time.ts'
import { allUsageSummaries, stableKey, publishedGeneration } from '../aggregates/service.ts'
import type { AggregateChangeSource, TokenTotals, UsageDimensions, UsageSummary } from '../aggregates/types.ts'
import type {
  CoverageSpanInput, PersistedUsageStatistic, StatisticBucket, StatisticCoverage,
  StatisticDefinition, StatisticExclusion, StatisticMetric
} from './types.ts'

const tokenKeys: readonly (keyof TokenTotals)[] = [
  'inputTotal', 'outputTotal', 'total', 'cacheReadInput', 'cacheWriteInput', 'reasoningOutput'
]

const zeroTotals = (): TokenTotals => ({ inputTotal: 0, outputTotal: 0, total: 0,
  cacheReadInput: 0, cacheWriteInput: 0, reasoningOutput: 0 })
const unknownTotals = (): TokenTotals => ({ inputTotal: null, outputTotal: null, total: null,
  cacheReadInput: null, cacheWriteInput: null, reasoningOutput: null })

type KnownCounts = Record<keyof TokenTotals, number>

const noKnown = (): KnownCounts => ({ inputTotal: 0, outputTotal: 0, total: 0,
  cacheReadInput: 0, cacheWriteInput: 0, reasoningOutput: 0 })

/** Fold one period into the running sum. A null component is never added as
 * zero, so an unknown amount cannot silently become no usage. `knownComponents`
 * marks the periods that observed the component completely: a partly observed
 * period still contributes the amount that was seen (a lower bound the caller
 * reports as such) but does not count as a known period, so an average refuses
 * to divide instead of spreading a partial sum over every period. */
function accumulate(sum: TokenTotals, known: KnownCounts, source: TokenTotals, knownComponents?: KnownCounts): void {
  for (const key of tokenKeys) {
    const value = source[key]
    if (value === null) continue
    sum[key] = (sum[key] ?? 0) + value
    if (!knownComponents || knownComponents[key] >= 1) known[key] += 1
  }
}

function divideByPeriods(sum: TokenTotals, known: KnownCounts, periods: number): TokenTotals {
  const result = unknownTotals()
  for (const key of tokenKeys) {
    const value = sum[key]
    result[key] = value !== null && periods > 0 && known[key] === periods ? value / periods : null
  }
  return result
}

function incompleteOf(known: KnownCounts, periods: number): (keyof TokenTotals)[] {
  return tokenKeys.filter((key) => known[key] < periods)
}

function coverageOf(input: {
  sum: TokenTotals
  known: KnownCounts
  periods: number
  expected: number
  unknownPeriods: number
  unallocated: number
  ids: readonly string[]
  pending: boolean
}): StatisticCoverage {
  const incomplete = incompleteOf(input.known, input.periods)
  const knownPeriods = input.known.total
  /* Completeness is about the token total the coverage/`knownTokens` fields
   * describe. A component that was never observed (a source that only reports
   * one metric) stays visible through `incompleteComponents` instead of making
   * every statistic partial forever. */
  const complete = input.periods === input.expected && input.expected > 0 &&
    input.unknownPeriods === 0 && knownPeriods === input.periods && !input.pending
  const completeness: StatisticCoverage['completeness'] = complete ? 'complete'
    : knownPeriods === 0 ? 'unknown' : 'partial'
  return {
    completeness,
    knownTokens: input.sum.total ?? 0,
    unknownTokens: complete ? 0 : null,
    unallocatedTimeTokens: input.unallocated,
    coverageIds: [...new Set(input.ids)],
    knownPeriods,
    unknownPeriods: input.unknownPeriods,
    incompleteComponents: incomplete,
    pending: input.pending
  }
}

export function registerStatisticDefinition(db: DatabaseSync, definition: StatisticDefinition, updatedAt = Date.now()): void {
  // Intl validates the timezone now instead of failing in a background refresh.
  new Intl.DateTimeFormat('en', { timeZone: definition.timeZone }).format(0)
  if (definition.window.kind === 'rolling-completed-weeks' && (!Number.isInteger(definition.window.count) || definition.window.count < 1)) {
    throw new RangeError('rolling statistic count must be a positive integer')
  }
  db.prepare(`INSERT INTO metering_statistic_definitions
    (id,definition_revision,metric,dimensions_json,time_zone,week_start,completed_periods_only,window_json,enabled,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      definition_revision=excluded.definition_revision,metric=excluded.metric,dimensions_json=excluded.dimensions_json,
      time_zone=excluded.time_zone,week_start=excluded.week_start,completed_periods_only=excluded.completed_periods_only,
      window_json=excluded.window_json,enabled=excluded.enabled,updated_at=excluded.updated_at`)
    .run(definition.id, definition.definitionRevision, definition.metric, stableKey(definition.dimensions), definition.timeZone,
      definition.weekStart, definition.completedPeriodsOnly ? 1 : 0, JSON.stringify(definition.window), definition.enabled ? 1 : 0, updatedAt)
}

/** Record a proven observed span or an explicit gap. Callers must use the
 * same scoped dimensions used by the statistic; a credential match is not
 * treated as an account/pool identity. */
export function registerCoverageSpan(db: DatabaseSync, span: CoverageSpanInput): void {
  const canonical = db.prepare(`SELECT source_id,interval_json,completeness,gap_reason
    FROM collection_coverage WHERE id=?`).get(span.coverageId) as {
      source_id: string | null; interval_json: string | null
      completeness: 'complete' | 'partial' | 'gap' | 'unknown'; gap_reason: string | null
    } | undefined
  if (!canonical) throw new Error(`collection coverage ${span.coverageId} does not exist`)
  if (!canonical.interval_json) throw new Error(`collection coverage ${span.coverageId} has no time interval`)
  const interval = JSON.parse(canonical.interval_json) as { start: number; end: number }
  if (!Number.isSafeInteger(interval.start) || !Number.isSafeInteger(interval.end) || interval.end <= interval.start) {
    throw new RangeError('canonical coverage interval is invalid')
  }
  const status = canonical.completeness === 'complete' ? 'good' : 'missing'
  const reason = status === 'good' ? null : (canonical.gap_reason ?? `collection coverage is ${canonical.completeness}`)
  db.prepare(`INSERT INTO metering_coverage_spans
    (id,coverage_id,source_id,dimensions_json,start_utc,end_utc,status,reason,revision,observed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET dimensions_json=excluded.dimensions_json,start_utc=excluded.start_utc,
      coverage_id=excluded.coverage_id,source_id=excluded.source_id,end_utc=excluded.end_utc,
      status=excluded.status,reason=excluded.reason,revision=excluded.revision,
      observed_at=excluded.observed_at WHERE excluded.revision > metering_coverage_spans.revision`)
    .run(span.id, span.coverageId, canonical.source_id, stableKey(span.dimensions), interval.start,
      interval.end, status, reason, span.revision, span.observedAt)
}

interface Span { id: string; start: number; end: number; status: 'good' | 'missing'; reason: string | null }

function spansFor(db: DatabaseSync, dimensions: UsageDimensions, start: number, end: number): Span[] {
  return (db.prepare(`SELECT id,start_utc,end_utc,status,reason FROM metering_coverage_spans
    WHERE dimensions_json=? AND end_utc>? AND start_utc<? ORDER BY start_utc,end_utc`)
    .all(stableKey(dimensions), start, end) as unknown as Array<{ id: string; start_utc: number; end_utc: number; status: 'good' | 'missing'; reason: string | null }>)
    .map((r) => ({ id: r.id, start: r.start_utc, end: r.end_utc, status: r.status, reason: r.reason }))
}

function assess(spans: readonly Span[], start: number, end: number): { good: boolean; ids: string[]; reason?: string } {
  const missing = spans.find((s) => s.status === 'missing' && s.start < end && s.end > start)
  if (missing) return { good: false, ids: [missing.id], reason: missing.reason ?? 'collection gap' }
  const good = spans.filter((s) => s.status === 'good').map((s) => ({ start: Math.max(start, s.start), end: Math.min(end, s.end) }))
    .filter((s) => s.end > s.start).sort((a, b) => a.start - b.start)
  let cursor = start
  for (const span of good) { if (span.start > cursor) break; cursor = Math.max(cursor, span.end) }
  return { good: cursor >= end, ids: spans.filter((s) => s.status === 'good').map((s) => s.id),
    ...(cursor >= end ? {} : { reason: 'collection coverage unknown' }) }
}

function exactSummary(summaries: readonly UsageSummary[], dimensions: UsageDimensions, bucket: TimeBucket): UsageSummary | undefined {
  return summaries.find((s) => stableKey(s.dimensions) === stableKey(dimensions) && s.timeBucket.grain === bucket.grain &&
    s.timeBucket.startUtc === bucket.startUtc && s.timeBucket.endUtc === bucket.endUtc)
}

function statisticRange(definition: StatisticDefinition, asOf: number): { start: number; end: number; periods?: TimeBucket[] } {
  if (definition.window.kind === 'fixed') return { start: definition.window.start, end: definition.window.end }
  const periods = completedWeekBuckets(asOf, definition.window.count, definition.timeZone, definition.weekStart)
  return { start: periods[0]!.startUtc!, end: periods[periods.length - 1]!.endUtc!, periods }
}

function hourlyBuckets(start: number, end: number, timeZone: string, weekStart: number): TimeBucket[] {
  const result: TimeBucket[] = []
  let cursor = bucketForPoint(start, 'hour', timeZone, weekStart).startUtc!
  while (cursor < end) {
    const bucket = bucketForPoint(cursor, 'hour', timeZone, weekStart)
    if (bucket.endUtc! > start) result.push(bucket)
    cursor = bucket.endUtc!
  }
  return result
}

function calendarBuckets(start: number, end: number, grain: 'day' | 'week', timeZone: string, weekStart: number): TimeBucket[] {
  const result: TimeBucket[] = []
  let bucket = bucketForPoint(start, grain, timeZone, weekStart)
  while (bucket.startUtc! < end) {
    if (bucket.startUtc! >= start && bucket.endUtc! <= end) result.push(bucket)
    bucket = bucketForPoint(bucket.endUtc!, grain, timeZone, weekStart)
  }
  return result
}

interface PeriodState {
  totals: TokenTotals
  /** Components every counted entry of this period reported. A period whose
   * total is only partly observed must not enter an average as a full value. */
  knownComponents: KnownCounts
  unallocatedTokens: number
  ids: string[]
  excluded?: StatisticExclusion
}

function periodState(spans: readonly Span[], summaries: readonly UsageSummary[], dimensions: UsageDimensions, period: TimeBucket): PeriodState {
  const state = assess(spans, period.startUtc!, period.endUtc!)
  const unknown = noKnown()
  if (!state.good) return { totals: unknownTotals(), knownComponents: unknown,
    unallocatedTokens: 0, ids: state.ids,
    excluded: { start: period.startUtc!, end: period.endUtc!, reason: state.reason! } }
  const summary = exactSummary(summaries, dimensions, period)
  // A covered bucket with no row is observed zero usage; a row whose coverage
  // says some entries were unknown keeps only its known components.
  const knownComponents = noKnown()
  for (const key of tokenKeys) {
    knownComponents[key] = !summary || summary.coverage.knownEntriesByComponent[key] >= summary.entryCount ? 1 : 0
  }
  return { totals: summary?.totals ?? zeroTotals(), knownComponents,
    unallocatedTokens: summary?.unallocatedTokens ?? 0, ids: state.ids }
}

interface Computed {
  value: TokenTotals | null
  buckets: StatisticBucket[]
  numerator: TokenTotals
  denominator: number | null
  expectedPeriods: number
  validPeriods: number
  exclusions: StatisticExclusion[]
  coverage: StatisticCoverage
}

function computeAveraged(db: DatabaseSync, definition: StatisticDefinition, periods: readonly TimeBucket[], grain: 'week' | 'day', pending: boolean): Computed {
  const start = periods[0]!.startUtc!
  const end = periods[periods.length - 1]!.endUtc!
  const summaries = allUsageSummaries(db, { ...definition.dimensions, grain, startUtc: start, endUtc: end }).summaries
  const spans = spansFor(db, definition.dimensions, start, end)
  const sum = unknownTotals()
  const known = noKnown()
  const exclusions: StatisticExclusion[] = []
  const ids: string[] = []
  const buckets: StatisticBucket[] = []
  let valid = 0
  let unknownPeriods = 0
  let unallocated = 0
  for (const period of periods) {
    const state = periodState(spans, summaries, definition.dimensions, period)
    ids.push(...state.ids)
    if (state.excluded) { exclusions.push(state.excluded); continue }
    valid++
    accumulate(sum, known, state.totals, state.knownComponents)
    const periodKnown = state.knownComponents
    if (periodKnown.total < 1) unknownPeriods++
    unallocated += state.unallocatedTokens
    buckets.push({ key: String(period.startUtc), startUtc: period.startUtc!, endUtc: period.endUtc!,
      value: state.totals, denominator: 1,
      coverage: coverageOf({ sum: state.totals, known: periodKnown, periods: 1, expected: 1,
        unknownPeriods: periodKnown.total < 1 ? 1 : 0, unallocated: state.unallocatedTokens,
        ids: state.ids, pending }) })
  }
  const expected = periods.length
  return {
    value: valid ? divideByPeriods(sum, known, valid) : null,
    buckets, numerator: sum, denominator: valid, expectedPeriods: expected, validPeriods: valid,
    exclusions,
    coverage: coverageOf({ sum, known, periods: valid, expected, unknownPeriods, unallocated, ids, pending })
  }
}

function computeWeekly(db: DatabaseSync, definition: StatisticDefinition, periods: readonly TimeBucket[], pending: boolean): Computed {
  return computeAveraged(db, definition, periods, 'week', pending)
}

function computeDailyWithinWeek(db: DatabaseSync, definition: StatisticDefinition, start: number, end: number, pending: boolean): Computed {
  return computeAveraged(db, definition, calendarBuckets(start, end, 'day', definition.timeZone, definition.weekStart), 'day', pending)
}

/** Hourly metrics never average across periods by accident: they group by the
 * requested local key, and `hour-of-day-average` divides by the number of
 * observed occurrences of that local hour so a short period cannot inflate an
 * hourly mean. */
function computeHourly(db: DatabaseSync, definition: StatisticDefinition, start: number, end: number, pending: boolean): Computed {
  const periods = hourlyBuckets(start, end, definition.timeZone, definition.weekStart)
  const summaries = allUsageSummaries(db, { ...definition.dimensions, grain: 'hour', startUtc: start, endUtc: end }).summaries
  const spans = spansFor(db, definition.dimensions, start, end)
  const sum = unknownTotals()
  const known = noKnown()
  const exclusions: StatisticExclusion[] = []
  const ids: string[] = []
  const grouped = new Map<string, { sum: TokenTotals; known: KnownCounts; occurrences: number; ids: string[] }>()
  let valid = 0
  let unknownPeriods = 0
  let unallocated = 0
  for (const period of periods) {
    const state = periodState(spans, summaries, definition.dimensions, period)
    ids.push(...state.ids)
    if (state.excluded) { exclusions.push({ ...state.excluded, start: Math.max(start, state.excluded.start),
      end: Math.min(end, state.excluded.end) }); continue }
    valid++
    accumulate(sum, known, state.totals, state.knownComponents)
    if (state.knownComponents.total < 1) unknownPeriods++
    unallocated += state.unallocatedTokens
    const p = localParts(period.startUtc!, definition.timeZone)
    const key = definition.metric === 'hourly-by-date'
      ? `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(p.hour).padStart(2, '0')}@${period.startUtc}`
      : String(p.hour).padStart(2, '0')
    const group = grouped.get(key) ?? { sum: unknownTotals(), known: noKnown(), occurrences: 0, ids: [] }
    accumulate(group.sum, group.known, state.totals, state.knownComponents)
    group.occurrences++
    group.ids.push(...state.ids)
    grouped.set(key, group)
  }
  const buckets = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => ({
    key,
    value: definition.metric === 'hour-of-day-average'
      ? divideByPeriods(group.sum, group.known, group.occurrences) : group.sum,
    denominator: definition.metric === 'hour-of-day-average' ? group.occurrences : null,
    coverage: coverageOf({ sum: group.sum, known: group.known, periods: group.occurrences,
      expected: group.occurrences, unknownPeriods: group.occurrences - group.known.total,
      unallocated: 0, ids: group.ids, pending })
  }))
  return { value: null, buckets, numerator: sum, denominator: null, expectedPeriods: periods.length,
    validPeriods: valid, exclusions,
    coverage: coverageOf({ sum, known, periods: valid, expected: periods.length, unknownPeriods,
      unallocated, ids, pending }) }
}

function readDefinitions(db: DatabaseSync): StatisticDefinition[] {
  return (db.prepare('SELECT * FROM metering_statistic_definitions WHERE enabled=1 ORDER BY id').all() as unknown as Record<string, unknown>[])
    .map((r) => ({ id: String(r['id']), definitionRevision: Number(r['definition_revision']), metric: r['metric'] as StatisticMetric,
      dimensions: JSON.parse(String(r['dimensions_json'])) as UsageDimensions, timeZone: String(r['time_zone']),
      weekStart: Number(r['week_start']) as 1 | 7, completedPeriodsOnly: Number(r['completed_periods_only']) === 1,
      window: JSON.parse(String(r['window_json'])) as StatisticDefinition['window'], enabled: true }))
}

function persist(db: DatabaseSync, statistic: Omit<PersistedUsageStatistic, 'resultRevision'>): PersistedUsageStatistic {
  const prior = db.prepare('SELECT COALESCE(MAX(result_revision),0) AS revision FROM metering_usage_statistics WHERE id=?')
    .get(statistic.id) as { revision: number }
  const result = { ...statistic, resultRevision: prior.revision + 1 }
  db.prepare(`INSERT INTO metering_usage_statistics
    (id,definition_revision,result_revision,metric,dimensions_json,range_start,range_end,time_zone,
     calendar_policy_json,value_json,buckets_json,numerator_json,denominator,expected_periods,valid_periods,
     exclusions_json,coverage_json,source_watermarks_json,as_of,computed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(result.id, result.definitionRevision, result.resultRevision, result.metric, stableKey(result.dimensions),
      result.range.start, result.range.end, result.timeZone, JSON.stringify(result.calendarPolicy),
      result.value ? JSON.stringify(result.value) : null, result.buckets ? JSON.stringify(result.buckets) : null,
      JSON.stringify(result.numerator), result.denominator, result.expectedPeriods, result.validPeriods,
      JSON.stringify(result.exclusions), JSON.stringify(result.coverage), JSON.stringify(result.sourceWatermarks),
      result.asOf, result.computedAt)
  return result
}

export interface RefreshStatisticsOptions {
  asOf?: number
  /** Optional freshness probe: a pending aggregate generation makes every
   * statistic partial, because a bucket that looks empty may still be unfilled. */
  source?: Pick<AggregateChangeSource, 'highWatermarks'>
}

/** Recompute registered projections from persisted summaries. This is called
 * on schedule even with no new ledger change so rolling ranges and their
 * denominators advance with asOf. */
export function refreshUsageStatistics(db: DatabaseSync, options: RefreshStatisticsOptions = {}): PersistedUsageStatistic[] {
  const asOf = options.asOf ?? Date.now()
  const generation = publishedGeneration(db)
  if (!generation) return []
  const pending = options.source
    ? pendingAgainst(options.source, generation.ledger_watermark, generation.attribution_watermark,
      generation.pool_claim_watermark) : false
  return withTx(db, (tx) => readDefinitions(tx).map((definition) => {
    const range = statisticRange(definition, asOf)
    const periods = range.periods ?? calendarBuckets(range.start, range.end, 'week', definition.timeZone, definition.weekStart)
    const computed = definition.metric === 'weekly-average'
      ? computeWeekly(tx, definition, periods, pending)
      : definition.metric === 'daily-average-within-week'
        ? computeDailyWithinWeek(tx, definition, range.start, range.end, pending)
        : computeHourly(tx, definition, range.start, range.end, pending)
    return persist(tx, { id: definition.id, definitionRevision: definition.definitionRevision,
      metric: definition.metric, dimensions: definition.dimensions, range: { start: range.start, end: range.end },
      timeZone: definition.timeZone, calendarPolicy: { weekStart: definition.weekStart === 1 ? 'monday' : 'sunday', completedPeriodsOnly: definition.completedPeriodsOnly },
      ...computed,
      sourceWatermarks: [`aggregate-generation:${generation.generation}`, `ledger:${generation.ledger_watermark}`,
        `attribution:${generation.attribution_watermark}`, `pool-claim:${generation.pool_claim_watermark}`],
      asOf, computedAt: Date.now() })
  }))
}

function pendingAgainst(source: Pick<AggregateChangeSource, 'highWatermarks'>,
  ledger: number, attribution: number, poolClaim: string): boolean {
  const high = source.highWatermarks()
  return high.ledger > ledger || high.attribution > attribution || high.poolClaim !== poolClaim
}

function mapStatistic(r: Record<string, unknown>): PersistedUsageStatistic {
  return { id: String(r['id']), definitionRevision: Number(r['definition_revision']), resultRevision: Number(r['result_revision']),
    metric: r['metric'] as StatisticMetric, dimensions: JSON.parse(String(r['dimensions_json'])),
    range: { start: Number(r['range_start']), end: Number(r['range_end']) }, timeZone: String(r['time_zone']),
    calendarPolicy: JSON.parse(String(r['calendar_policy_json'])),
    value: r['value_json'] === null ? null : JSON.parse(String(r['value_json'])),
    buckets: r['buckets_json'] === null ? null : JSON.parse(String(r['buckets_json'])),
    numerator: JSON.parse(String(r['numerator_json'])), denominator: r['denominator'] as number | null,
    expectedPeriods: r['expected_periods'] as number | null, validPeriods: r['valid_periods'] as number | null,
    exclusions: JSON.parse(String(r['exclusions_json'])), coverage: JSON.parse(String(r['coverage_json'])),
    sourceWatermarks: JSON.parse(String(r['source_watermarks_json'])), asOf: Number(r['as_of']), computedAt: Number(r['computed_at']) }
}

export function getUsageStatistic(db: DatabaseSync, id: string): PersistedUsageStatistic | null {
  const row = db.prepare(`SELECT * FROM metering_usage_statistics WHERE id=? ORDER BY result_revision DESC LIMIT 1`).get(id)
  return row ? mapStatistic(row as Record<string, unknown>) : null
}

export function listUsageStatistics(db: DatabaseSync, options: { metric?: StatisticMetric; dimensions?: UsageDimensions } = {}): PersistedUsageStatistic[] {
  const rows = db.prepare(`SELECT s.* FROM metering_usage_statistics s WHERE s.result_revision=
    (SELECT MAX(x.result_revision) FROM metering_usage_statistics x WHERE x.id=s.id) ORDER BY s.id`).all() as unknown as Record<string, unknown>[]
  return rows.map(mapStatistic).filter((s) => (!options.metric || s.metric === options.metric) &&
    (!options.dimensions || Object.entries(options.dimensions).every(([k, v]) => stableKey(s.dimensions[k as keyof UsageDimensions]) === stableKey(v))))
}
