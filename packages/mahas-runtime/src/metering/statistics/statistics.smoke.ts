// Persisted statistic fixtures (weekly calendar weeks, coverage gaps, DST hour
// distribution). Run directly with Node 24:
//   node packages/mahas-runtime/src/metering/statistics/statistics.smoke.ts
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import {
  addConnection, addCoverage, addProvider, createFixtureDb, pointTime, recordUsage, tick
} from '../aggregates/fixtures.ts'
import { usageLedgerAggregateSource } from '../aggregates/ledger-source.ts'
import { refreshUsageAggregates } from '../aggregates/service.ts'
import { bucketForPoint, completedWeekBuckets, instantsForLocal, localParts } from '../aggregates/time.ts'
import { projectUsageStatistic, statisticUnidentified, usageStatisticEnvelope } from '../aggregates/dto.ts'
import { refreshUsageStatistics, registerCoverageSpan, registerStatisticDefinition } from './service.ts'
import type { StatisticDefinition, StatisticMetric } from './types.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR

const define = (db: DatabaseSync, input: { id: string; metric: StatisticMetric; timeZone: string;
  window: StatisticDefinition['window']; weekStart?: 1 | 7 }): void => {
  registerStatisticDefinition(db, { id: input.id, definitionRevision: 1, metric: input.metric,
    dimensions: {}, timeZone: input.timeZone, weekStart: input.weekStart ?? 1,
    completedPeriodsOnly: true, window: input.window, enabled: true })
}

const localWeekday = (at: number, timeZone: string): number => {
  const p = localParts(at, timeZone)
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
  return day === 0 ? 7 : day
}

// ── 최근 4개 완결된 월요일 시작 달력 주 ──────────────────────────────────────
{
  const db = createFixtureDb()
  addProvider(db, 'provider-anthropic', 'offering-claude')
  addConnection(db, 'conn-1', 'offering-claude')
  const source = usageLedgerAggregateSource(db)
  const timeZone = 'Asia/Seoul'
  const asOf = Date.parse('2026-03-18T03:00:00.000Z')
  const weeks = completedWeekBuckets(asOf, 4, timeZone, 1)
  assert.equal(weeks.length, 4)
  assert.deepEqual(weeks.map((week) => week.startUtc),
    ['2026-02-15T15:00:00.000Z', '2026-02-22T15:00:00.000Z', '2026-03-01T15:00:00.000Z',
      '2026-03-08T15:00:00.000Z'].map(Date.parse),
  'completed weeks are local Mondays in the user time zone')
  for (const week of weeks) assert.equal(localWeekday(week.startUtc!, timeZone), 1)
  assert.equal(weeks[3]!.endUtc! - weeks[0]!.startUtc!, 28 * DAY)
  assert.equal(weeks[3]!.endUtc!, bucketForPoint(asOf, 'week', timeZone, 1).startUtc,
    'the rolling window ends where the current, incomplete week starts')

  addCoverage(db, { id: 'cov-weeks', start: weeks[0]!.startUtc!, end: weeks[3]!.endUtc!,
    completeness: 'complete' })
  define(db, { id: 'weekly-total', metric: 'weekly-average', timeZone,
    window: { kind: 'rolling-completed-weeks', count: 4 } })
  registerCoverageSpan(db, { id: 'span-weeks', coverageId: 'cov-weeks', dimensions: {},
    revision: 1, observedAt: tick() })

  const totals = [1_000_000, 0, 2_000_000, 1_000_000]
  for (const [index, week] of weeks.entries()) {
    if (totals[index] === 0) continue
    const at = week.startUtc! + 10 * HOUR
    recordUsage(db, { readingId: `week-${index}`, accountingKey: `week-${index}`,
      values: { total: totals[index]! }, time: pointTime(at),
      attribution: { connectionId: 'conn-1', status: 'verified' } })
  }
  refreshUsageAggregates(db, source, { timeZone, now: asOf })
  const statistics = refreshUsageStatistics(db, { asOf, source })
  assert.equal(statistics.length, 1)
  let weekly = statistics[0]!
  assert.equal(weekly.metric, 'weekly-average')
  assert.equal(weekly.value?.total, 1_000_000, 'observed zero-use weeks count as zero')
  assert.equal(weekly.denominator, 4)
  assert.equal(weekly.expectedPeriods, 4)
  assert.equal(weekly.validPeriods, 4)
  assert.equal(weekly.exclusions.length, 0)
  assert.equal(weekly.coverage.completeness, 'complete')
  assert.equal(weekly.coverage.unknownTokens, 0)
  assert.equal(weekly.coverage.knownPeriods, 4)
  assert.equal(weekly.coverage.unknownPeriods, 0)
  assert.deepEqual(weekly.buckets!.map((bucket) => bucket.startUtc), weeks.map((week) => week.startUtc))
  assert.deepEqual(weekly.buckets!.map((bucket) => bucket.value.total), totals)
  assert.equal(weekly.calendarPolicy.weekStart, 'monday')
  assert.deepEqual(weekly.sourceWatermarks.filter((watermark) => watermark.startsWith('ledger:')).length, 1)

  const projected = projectUsageStatistic(weekly)
  assert.equal(projected.coverage.completeness, 'complete')
  assert.equal(projected.coverage.unknownTokens, 0)
  assert.equal(projected.denominator, 4)
  assert.equal(projected.calendarPolicy.weekStart, 'monday')
  assert.equal(projected.coverage.coverageIds.length, 1)
  assert.equal(statisticUnidentified([weekly]).length, 5,
    'components that were never observed are stated, not filled with zero')

  // A collection gap removes the week from the numerator and the denominator.
  addCoverage(db, { id: 'cov-gap', start: weeks[1]!.startUtc!, end: weeks[1]!.endUtc!,
    completeness: 'gap', gapReason: 'collector reported a gap' })
  registerCoverageSpan(db, { id: 'span-gap', coverageId: 'cov-gap', dimensions: {},
    revision: 1, observedAt: tick() })
  weekly = refreshUsageStatistics(db, { asOf, source })[0]!
  assert.equal(weekly.validPeriods, 3)
  assert.equal(weekly.expectedPeriods, 4)
  assert.equal(weekly.exclusions.length, 1)
  assert.equal(weekly.exclusions[0]!.reason, 'collector reported a gap')
  assert.ok(Math.abs(weekly.value!.total! - 4_000_000 / 3) < 1e-6,
    'a gap week leaves both the sum and the denominator')
  assert.equal(weekly.coverage.completeness, 'partial')
  assert.equal(weekly.coverage.unknownTokens, null, 'a partially observed window is not reported as fully known')
  const gapEnvelope = usageStatisticEnvelope([weekly])
  assert.equal(gapEnvelope.items[0]!.coverage.unknownTokens, null)
  assert.equal(gapEnvelope.items[0]!.exclusions.length, 1)

  // Coverage can be corrected later; the higher revision wins and no second gas
  // span is left behind.
  addCoverage(db, { id: 'cov-gap', start: weeks[1]!.startUtc!, end: weeks[1]!.endUtc!,
    completeness: 'complete' })
  registerCoverageSpan(db, { id: 'span-gap', coverageId: 'cov-gap', dimensions: {},
    revision: 2, observedAt: tick() })
  weekly = refreshUsageStatistics(db, { asOf, source })[0]!
  assert.equal(weekly.validPeriods, 4)
  assert.equal(weekly.value!.total, 1_000_000)
  assert.equal(weekly.coverage.completeness, 'complete')

  // An unquantified week keeps the sum of known weeks but never publishes it as
  // the average of the window.
  recordUsage(db, { readingId: 'week-unknown', accountingKey: 'week-unknown', values: {},
    time: pointTime(weeks[2]!.startUtc! + 12 * HOUR),
    attribution: { connectionId: 'conn-1', status: 'verified' } })
  refreshUsageAggregates(db, source, { timeZone, now: asOf })
  weekly = refreshUsageStatistics(db, { asOf, source })[0]!
  assert.equal(weekly.validPeriods, 4)
  assert.equal(weekly.coverage.unknownPeriods, 1)
  assert.equal(weekly.value!.total, null, 'an unknown week is not averaged away')
  assert.equal(weekly.numerator.total, 4_000_000, 'known weeks are still summed')
  assert.equal(weekly.coverage.completeness, 'partial')
  assert.equal(weekly.coverage.knownTokens, 4_000_000)
  assert.equal(weekly.coverage.unknownTokens, null)
  db.close()
}

// ── 일광절약 경계와 현지 0~23시 분포 ─────────────────────────────────────────
{
  const db = createFixtureDb()
  const timeZone = 'America/New_York'
  const source = usageLedgerAggregateSource(db)
  const dayBounds = (year: number, month: number, day: number): { start: number; end: number; hours: number } => {
    const start = instantsForLocal({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone)[0]!
    const end = instantsForLocal({ year, month, day: day + 1, hour: 0, minute: 0, second: 0 }, timeZone)[0]!
    return { start, end, hours: (end - start) / HOUR }
  }
  const spring = dayBounds(2026, 3, 8)
  const fall = dayBounds(2026, 11, 1)
  assert.equal(spring.hours, 23, 'the spring day loses an hour')
  assert.equal(fall.hours, 25, 'the autumn day repeats an hour')

  let index = 0
  for (let at = spring.start; at < spring.end; at += HOUR) {
    recordUsage(db, { readingId: `spring-${index}`, accountingKey: `spring-${index}`,
      values: { total: 1 }, time: pointTime(at) })
    index += 1
  }
  for (let at = fall.start; at < fall.end; at += HOUR) {
    const hour = localParts(at, timeZone).hour
    recordUsage(db, { readingId: `fall-${index}`, accountingKey: `fall-${index}`,
      values: { total: hour === 1 ? (index % 2 === 0 ? 10 : 30) : 1 }, time: pointTime(at) })
    index += 1
  }
  addCoverage(db, { id: 'cov-spring', start: spring.start, end: spring.end, completeness: 'complete' })
  addCoverage(db, { id: 'cov-fall', start: fall.start, end: fall.end, completeness: 'complete' })
  define(db, { id: 'spring-hours', metric: 'hour-of-day-distribution', timeZone,
    window: { kind: 'fixed', start: spring.start, end: spring.end } })
  define(db, { id: 'fall-hours', metric: 'hour-of-day-distribution', timeZone,
    window: { kind: 'fixed', start: fall.start, end: fall.end } })
  define(db, { id: 'fall-average', metric: 'hour-of-day-average', timeZone,
    window: { kind: 'fixed', start: fall.start, end: fall.end } })
  define(db, { id: 'fall-by-date', metric: 'hourly-by-date', timeZone,
    window: { kind: 'fixed', start: fall.start, end: fall.end } })
  registerCoverageSpan(db, { id: 'span-spring', coverageId: 'cov-spring', dimensions: {},
    revision: 1, observedAt: tick() })
  registerCoverageSpan(db, { id: 'span-fall', coverageId: 'cov-fall', dimensions: {},
    revision: 1, observedAt: tick() })
  refreshUsageAggregates(db, source, { timeZone, now: fall.end })
  const byId = new Map(refreshUsageStatistics(db, { asOf: fall.end, source })
    .map((statistic) => [statistic.id, statistic]))

  const springHours = byId.get('spring-hours')!
  assert.equal(springHours.expectedPeriods, 23)
  assert.equal(springHours.validPeriods, 23)
  assert.equal(springHours.buckets!.length, 23)
  assert.equal(springHours.buckets!.some((bucket) => bucket.key === '02'), false,
    'the local hour that does not exist is not invented')
  assert.equal(springHours.numerator.total, 23)

  const fallHours = byId.get('fall-hours')!
  assert.equal(fallHours.expectedPeriods, 25, 'the repeated local hour is observed twice')
  assert.equal(fallHours.validPeriods, 25)
  assert.equal(fallHours.buckets!.length, 24)
  const repeated = fallHours.buckets!.find((bucket) => bucket.key === '01')!
  assert.equal(repeated.value.total, 40, 'both occurrences of the repeated hour are kept')
  assert.equal(fallHours.buckets!.find((bucket) => bucket.key === '00')!.value.total, 1)
  assert.equal(fallHours.coverage.completeness, 'complete')

  const fallAverage = byId.get('fall-average')!
  const averaged = fallAverage.buckets!.find((bucket) => bucket.key === '01')!
  assert.equal(averaged.denominator, 2, 'the observed occurrence count is the denominator')
  assert.equal(averaged.value.total, 20)
  assert.equal(fallAverage.buckets!.find((bucket) => bucket.key === '03')!.denominator, 1)
  assert.equal(fallAverage.buckets!.find((bucket) => bucket.key === '03')!.value.total, 1)

  const byDate = byId.get('fall-by-date')!
  assert.equal(byDate.buckets!.length, 25, 'each observed occurrence keeps its own key')
  const oneAm = byDate.buckets!.filter((bucket) => bucket.key.includes('T01@'))
  assert.equal(oneAm.length, 2)
  assert.deepEqual(oneAm.map((bucket) => bucket.value.total).sort(), [10, 30])
  db.close()
}

console.log('usage statistics smoke: ok')
