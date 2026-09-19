// Persisted aggregate fixtures. Run directly with Node 24:
//   node packages/mahas-runtime/src/metering/aggregates/aggregates.smoke.ts
// Everything is synthetic: an in-memory control DB written through the real
// ledger ingest API, no native logs, credentials or provider APIs.
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import {
  addConnection,
  addProvider,
  createFixtureDb,
  intervalTime,
  pointTime,
  putPoolClaim,
  recordMany,
  recordUsage,
  unknownTime
} from './fixtures.ts'
import { usageLedgerAggregateSource } from './ledger-source.ts'
import {
  AggregateRebuildConflict,
  allUsageSummaries,
  pruneAbandonedGenerations,
  publishedGeneration,
  queryUsageSummaries,
  queryVerifiedPoolShares,
  rebuildUsageAggregates,
  refreshUsageAggregates
} from './service.ts'
import { projectVerifiedPoolShare, usageSummaryEnvelope } from './dto.ts'
import type { AggregateChangeSource, UsageSummary } from './types.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** 2026-03-02T09:00:00Z — a Monday, mid-week, exact hour. */
const START = Date.parse('2026-03-02T09:00:00.000Z')

const grand = (
  db: DatabaseSync,
  grain: 'alltime' | 'hour' | 'day' | 'week' = 'alltime'
): UsageSummary => {
  const found = allUsageSummaries(db, { grain }).summaries.find(
    (row) => Object.keys(row.dimensions).length === 0
  )
  assert.ok(found, `expected a grand-total ${grain} summary`)
  return found
}

const contributionsOf = (db: DatabaseSync, entryId: string): number =>
  Number(
    (
      db
        .prepare('SELECT COUNT(*) AS n FROM metering_aggregate_contributions WHERE entry_id=?')
        .get(entryId) as { n: number }
    ).n
  )

const pendingIntents = (db: DatabaseSync): number =>
  Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM usage_aggregate_intents WHERE state='pending'`)
        .get() as { n: number }
    ).n
  )

// ── null → correction → unknown again ───────────────────────────────────────
{
  const db = createFixtureDb()
  addProvider(db, 'provider-anthropic', 'offering-claude')
  addConnection(db, 'conn-1', 'offering-claude')
  const source = usageLedgerAggregateSource(db)

  // An entry whose totals are entirely unknown must not read as zero.
  recordUsage(db, {
    readingId: 'r-unknown',
    accountingKey: 'session-a',
    values: {},
    time: pointTime(START)
  })
  let refreshed = refreshUsageAggregates(db, source, { timeZone: 'UTC', now: START })
  assert.equal(refreshed.applied, 1)
  let summary = grand(db)
  assert.equal(summary.entryCount, 1)
  assert.equal(summary.totals.total, null)
  assert.equal(summary.coverage.completeTotals, false)
  assert.equal(summary.coverage.knownEntriesByComponent.total, 0)
  assert.equal(summary.coverage.unquantifiedUnattributedEntries, 1)
  assert.equal(summary.coverage.unquantifiedUnallocatedEntries, 0)
  assert.equal(summary.attributionCoverage.status, 'partial')
  assert.equal(summary.coverage.temporal, 'allocated')

  const envelope = usageSummaryEnvelope({
    summaries: [summary],
    freshness: {
      ledgerWatermark: 0,
      attributionWatermark: 0,
      poolClaimWatermark: '',
      pending: false,
      computedAt: summary.computedAt
    },
    generation: summary.generation,
    nextCursor: null,
    exhausted: true
  })
  assert.equal(envelope.items[0]!.coverage.completeness, 'partial')
  assert.equal(envelope.items[0]!.coverage.unknownTokens, null)
  const providerGap = envelope.unidentified.find((item) => item.axis === 'provider')
  assert.ok(providerGap, 'unknown attribution must be reported, not dropped')
  assert.equal(providerGap.amount, null)
  assert.equal(envelope.items[0]!.timeBucket!.grain, 'all-time')
  assert.equal(envelope.items[0]!.timeBucket!.weekStart, 'monday')

  // A later reading for the same accounting key is a correction, not a new entry.
  recordUsage(db, {
    readingId: 'r-known',
    accountingKey: 'session-a',
    values: { total: 1_000, inputTotal: 400, outputTotal: 600 },
    time: pointTime(START + HOUR),
    attribution: { connectionId: 'conn-1', status: 'verified' }
  })
  refreshed = refreshUsageAggregates(db, source, { timeZone: 'UTC', now: START })
  assert.equal(refreshed.applied, 1)
  summary = grand(db)
  assert.equal(summary.entryCount, 1, 'a correction replaces the entry, it is not counted twice')
  assert.equal(summary.totals.total, 1_000)
  assert.equal(summary.totals.inputTotal, 400)
  assert.equal(summary.coverage.completeTotals, true)
  assert.equal(summary.attributionCoverage.status, 'complete')
  const derived = allUsageSummaries(db, {
    grain: 'alltime',
    providerId: 'provider-anthropic'
  }).summaries.find(
    (row) => row.dimensions.providerId === 'provider-anthropic' && !row.dimensions.harnessId
  )
  assert.ok(derived, 'provider dimension is derived through the connection')
  assert.equal(derived.totals.total, 1_000)
  assert.equal(derived.dimensions.offeringId, undefined)

  // Replaying the same feed is idempotent.
  assert.equal(refreshUsageAggregates(db, source, { timeZone: 'UTC', now: START }).applied, 0)
  assert.equal(grand(db).totals.total, 1_000)

  // Correcting back to an unknown amount removes the old projection.
  const entryId = recordUsage(db, {
    readingId: 'r-unknown-again',
    accountingKey: 'session-a',
    values: {},
    time: pointTime(START + 2 * HOUR),
    attribution: { status: 'unknown', connectionId: null, evidence: [] }
  })
  refreshUsageAggregates(db, source, { timeZone: 'UTC', now: START })
  summary = grand(db)
  assert.equal(summary.totals.total, null)
  assert.equal(summary.entryCount, 1)
  assert.equal(summary.coverage.unquantifiedUnattributedEntries, 1)
  assert.equal(
    contributionsOf(db, entryId.entryId) > 0,
    true,
    'the corrected entry is still tracked'
  )
  assert.equal(
    allUsageSummaries(db, { grain: 'alltime' }).summaries.filter(
      (row) => !row.dimensions.providerId && (row.totals.total ?? 0) > 0
    ).length,
    0
  )
  assert.equal(pendingIntents(db), 0, 'consumed intents are acknowledged')
  db.close()
}

// ── cursor-paged rebuild beyond the 5,000 row scan clamp ────────────────────
{
  const db = createFixtureDb()
  const total = 5_200
  recordMany(db, total, (index) => ({
    readingId: `bulk-${index}`,
    accountingKey: `bulk-key-${index}`,
    values: { total: 1 },
    time: unknownTime()
  }))
  const source = usageLedgerAggregateSource(db)
  const pages: number[] = []
  const counting: AggregateChangeSource = {
    ...source,
    scanCountedEntries: (afterId, limit, snapshot) => {
      const page = source.scanCountedEntries!(afterId, limit, snapshot)
      pages.push(page.length)
      return page
    }
  }
  const before = publishedGeneration(db)
  assert.equal(before, undefined)
  const rebuilt = rebuildUsageAggregates(db, counting, { timeZone: 'UTC', limit: 500, now: START })
  assert.equal(rebuilt.scanned, total, 'every counted entry is scanned, not just the first page')
  assert.ok(pages.length > 10, `expected many bounded pages, saw ${pages.length}`)
  assert.ok(pages.slice(0, -1).every((size) => size <= 500))
  const summary = grand(db)
  assert.equal(summary.entryCount, total)
  assert.equal(summary.totals.total, total)
  assert.equal(summary.coverage.completeTotals, true)
  assert.equal(summary.unallocatedTokens, total)
  assert.equal(summary.coverage.temporal, 'unallocated')
  assert.equal(summary.coverage.unquantifiedUnallocatedEntries, 0)
  const envelope = usageSummaryEnvelope({
    summaries: [summary],
    freshness: {
      ledgerWatermark: 0,
      attributionWatermark: 0,
      poolClaimWatermark: '',
      pending: false,
      computedAt: 0
    },
    generation: rebuilt.generation,
    nextCursor: null,
    exhausted: true
  })
  assert.equal(envelope.items[0]!.coverage.completeness, 'complete')
  assert.equal(envelope.items[0]!.coverage.unknownTokens, 0)
  assert.equal(envelope.items[0]!.coverage.unallocatedTimeTokens, total)
  assert.deepEqual(
    envelope.unidentified.filter((item) => item.axis === 'time').map((item) => item.amount),
    [total]
  )
  assert.equal(
    allUsageSummaries(db, { grain: 'hour' }).summaries.filter(
      (row) => Object.keys(row.dimensions).length === 0
    ).length,
    0,
    'an entry with no usage time must not be bucketed into an hour'
  )
  assert.equal(publishedGeneration(db)!.generation, rebuilt.generation)
  assert.equal(
    Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM metering_aggregate_generations
    WHERE state='published'`
          )
          .get() as { n: number }
      ).n
    ),
    1
  )
  db.close()
}

// ── concurrent correction catch-up, publish retry, abandoned generations ────
{
  const db = createFixtureDb()
  addProvider(db, 'p-1', 'o-1')
  addConnection(db, 'c-1', 'o-1')
  const source = usageLedgerAggregateSource(db)
  recordMany(db, 200, (index) => ({
    readingId: `e-${index}`,
    accountingKey: `k-${index}`,
    values: { total: 2 },
    time: pointTime(START + index * 1_000),
    observedAt: START + index * 1_000,
    createdAt: START + index * 1_000
  }))
  refreshUsageAggregates(db, source, { timeZone: 'UTC', now: START })
  assert.equal(grand(db).totals.total, 400)

  // A correction lands between scan pages: the catch-up feed owns it.
  let scans = 0
  let injected = false
  const racing: AggregateChangeSource = {
    ...source,
    scanCountedEntries: (afterId, limit, snapshot) => {
      const page = source.scanCountedEntries!(afterId, limit, snapshot)
      scans += 1
      if (scans === 2 && !injected) {
        injected = true
        recordUsage(db, {
          readingId: 'race-correction',
          accountingKey: 'k-0',
          values: { total: 1_000 },
          time: pointTime(START),
          observedAt: START + 1,
          createdAt: START + 1,
          attribution: { connectionId: 'c-1', status: 'verified' }
        })
      }
      return page
    }
  }
  const raced = rebuildUsageAggregates(db, racing, { timeZone: 'UTC', limit: 50, now: START })
  // The corrected entry is either still scanned (correction landed after its
  // page) or excluded from the snapshot scan because its current revision is
  // newer than the snapshot — in both cases the catch-up feed must apply it.
  assert.ok(raced.scanned >= 199 && raced.scanned <= 200, `unexpected scan count ${raced.scanned}`)
  assert.equal(raced.caughtUp, 1, 'the concurrent correction is applied before publication')
  assert.equal(
    grand(db).totals.total,
    1_398,
    'rebuild must not publish a generation missing the correction'
  )
  assert.equal(publishedGeneration(db)!.generation, raced.generation)

  // A publication that is told the feed moved must retry instead of publishing.
  let highCalls = 0
  const retrying: AggregateChangeSource = {
    ...source,
    highWatermarks: () => {
      highCalls += 1
      const real = source.highWatermarks!()
      return highCalls === 2
        ? { ...real, ledger: real.ledger + 1, attribution: real.attribution + 1 }
        : real
    }
  }
  const retried = rebuildUsageAggregates(db, retrying, {
    timeZone: 'UTC',
    limit: 50,
    now: START,
    maxPublishAttempts: 3
  })
  assert.equal(retried.publishAttempts, 2, 'the first publish attempt reports a moved feed')
  assert.equal(grand(db).totals.total, 1_398)

  // A source that never settles is abandoned, never published half-built.
  const settled = publishedGeneration(db)!.generation
  let drift = 0
  const neverSettles: AggregateChangeSource = {
    ...source,
    highWatermarks: () => {
      drift += 1
      const real = source.highWatermarks!()
      return { ...real, ledger: real.ledger + drift, attribution: real.attribution + drift }
    }
  }
  assert.throws(
    () =>
      rebuildUsageAggregates(db, neverSettles, {
        timeZone: 'UTC',
        limit: 50,
        now: START,
        maxPublishAttempts: 3
      }),
    AggregateRebuildConflict
  )
  assert.equal(
    Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM metering_aggregate_generations
    WHERE state='building'`
          )
          .get() as { n: number }
      ).n
    ),
    0,
    'the abandoned build is dropped'
  )
  assert.equal(
    publishedGeneration(db)!.generation,
    settled,
    'a failed rebuild never takes over the published generation'
  )
  assert.equal(grand(db).totals.total, 1_398, 'the previously published generation stays queryable')

  // An interrupted rebuild left behind by a crash is pruned with its rows.
  const stale = Number(
    db
      .prepare(
        `INSERT INTO metering_aggregate_generations
    (state,definition_revision,time_zone,week_start,created_at) VALUES ('building',2,'UTC',1,?)`
      )
      .run(START).lastInsertRowid
  )
  db.prepare(
    `INSERT INTO metering_usage_summaries
    (generation,summary_key,revision,definition_revision,dimensions_json,grain,time_zone,week_start,
     entry_count,unallocated_tokens,unknown_attribution_tokens,coverage_json,attribution_coverage_json,
     ledger_watermark,attribution_watermark,computed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    stale,
    'stale-key',
    1,
    2,
    '{}',
    'alltime',
    'UTC',
    1,
    1,
    0,
    0,
    JSON.stringify({
      temporal: 'allocated',
      completeTotals: true,
      knownEntriesByComponent: {},
      unquantifiedUnallocatedEntries: 0,
      unquantifiedUnattributedEntries: 0
    }),
    JSON.stringify({ status: 'complete', unknownTokens: 0 }),
    0,
    0,
    START
  )
  assert.equal(pruneAbandonedGenerations(db), 1)
  assert.equal(
    Number(
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM metering_usage_summaries WHERE generation=?')
          .get(stale) as { n: number }
      ).n
    ),
    0
  )
  const prunedAtStart = rebuildUsageAggregates(db, source, {
    timeZone: 'UTC',
    limit: 50,
    now: START
  })
  assert.equal(prunedAtStart.pruned, 0)
  db.close()
}

// ── verified pool shares and pool-claim corrections ────────────────────────
{
  const db = createFixtureDb()
  addProvider(db, 'provider-anthropic', 'offering-claude')
  addProvider(db, 'provider-openai', 'offering-chatgpt')
  addConnection(db, 'conn-1', 'offering-claude')
  addConnection(db, 'conn-2', 'offering-chatgpt')
  const source = usageLedgerAggregateSource(db)
  const poolX = { providerPoolKey: 'pool-x', scope: 'account' }
  // A claim is only applied to usage inside its observed validity window, so the
  // fixture observes it before the usage it describes.
  putPoolClaim(db, { id: 'claim-1', connectionId: 'conn-1', ...poolX, observedAt: START - DAY })
  putPoolClaim(db, { id: 'claim-2', connectionId: 'conn-2', ...poolX, observedAt: START - DAY })

  recordUsage(db, {
    readingId: 'p-codex',
    accountingKey: 'pool-codex',
    values: { total: 300 },
    time: pointTime(START),
    harnessId: 'codex',
    attribution: { connectionId: 'conn-1', status: 'verified' }
  })
  recordUsage(db, {
    readingId: 'p-claude',
    accountingKey: 'pool-claude',
    values: { total: 700 },
    time: pointTime(START),
    harnessId: 'claude',
    attribution: { connectionId: 'conn-2', status: 'verified' }
  })
  refreshUsageAggregates(db, source, { timeZone: 'UTC', now: START })

  let shares = queryVerifiedPoolShares(db, { grain: 'alltime', verifiedPool: poolX })
  const byHarness = (list: typeof shares): Map<string, number | null> =>
    new Map(list.map((share) => [share.dimensions.harnessId!, share.share]))
  assert.equal(shares.length, 2)
  assert.deepEqual([...byHarness(shares)].sort(), [
    ['claude', 0.7],
    ['codex', 0.3]
  ])
  assert.equal(shares[0]!.denominator, 1_000)
  assert.equal(shares[0]!.denominatorCoverage, 'complete')
  assert.equal(shares[0]!.unknownDenominatorEntries, 0)
  assert.equal(projectVerifiedPoolShare(shares[0]!).timeBucket.grain, 'all-time')

  // A claim for one connection moves only that connection's entries.
  putPoolClaim(db, {
    id: 'claim-2',
    connectionId: 'conn-2',
    providerPoolKey: 'pool-y',
    scope: 'account',
    observedAt: START - DAY
  })
  const moved = refreshUsageAggregates(db, source, { timeZone: 'UTC', now: START })
  assert.equal(moved.applied, 2, 'a pool-claim change re-derives both connections once')
  shares = queryVerifiedPoolShares(db, { grain: 'alltime', verifiedPool: poolX })
  assert.equal(shares.length, 1)
  assert.equal(shares[0]!.dimensions.harnessId, 'codex')
  assert.equal(shares[0]!.share, 1)
  const poolY = queryVerifiedPoolShares(db, {
    grain: 'alltime',
    verifiedPool: { providerPoolKey: 'pool-y', scope: 'account' }
  })
  assert.equal(poolY[0]!.dimensions.harnessId, 'claude')
  assert.equal(poolY[0]!.share, 1)

  // An in-place claim revision bump (no new row) is detected as well.
  putPoolClaim(db, {
    id: 'claim-2',
    connectionId: 'conn-2',
    providerPoolKey: 'pool-y',
    scope: 'account',
    observedAt: START - DAY,
    validUntil: START + 9 * DAY
  })
  assert.equal(refreshUsageAggregates(db, source, { timeZone: 'UTC', now: START }).applied, 2)
  assert.equal(
    refreshUsageAggregates(db, source, { timeZone: 'UTC', now: START }).applied,
    0,
    'a consumed claim position is not replayed'
  )

  // Unknown totals make the pool denominator partial instead of smaller.
  recordUsage(db, {
    readingId: 'p-unknown',
    accountingKey: 'pool-unknown',
    values: {},
    time: pointTime(START),
    harnessId: 'codex',
    attribution: { connectionId: 'conn-1', status: 'verified' }
  })
  refreshUsageAggregates(db, source, { timeZone: 'UTC', now: START })
  shares = queryVerifiedPoolShares(db, { grain: 'alltime', verifiedPool: poolX })
  assert.equal(shares[0]!.numerator, 300)
  assert.equal(shares[0]!.denominatorCoverage, 'partial')
  assert.equal(shares[0]!.unknownDenominatorEntries, 1)
  db.close()
}

// ── unallocated intervals are preserved, not spread across buckets ──────────
{
  const db = createFixtureDb()
  addProvider(db, 'p-1', 'o-1')
  addConnection(db, 'c-1', 'o-1')
  const source = usageLedgerAggregateSource(db)
  const day = Date.parse('2026-03-02T00:00:00.000Z')
  // Six hours cannot be assigned to an hour bucket without assuming a spread.
  const wide = recordUsage(db, {
    readingId: 'wide',
    accountingKey: 'wide',
    values: { total: 600 },
    time: intervalTime(day + 4 * HOUR, day + 10 * HOUR),
    attribution: { connectionId: 'c-1', status: 'verified' }
  })
  // An interval crossing local midnight is likewise unallocated for the day.
  recordUsage(db, {
    readingId: 'crosses',
    accountingKey: 'crosses',
    values: { total: 100 },
    time: intervalTime(day + 23 * HOUR, day + 25 * HOUR),
    attribution: { connectionId: 'c-1', status: 'verified' }
  })
  // A cumulative baseline has no observable usage time at all.
  recordUsage(db, {
    readingId: 'baseline',
    accountingKey: 'baseline',
    values: { total: 400 },
    time: unknownTime(),
    mode: 'cumulative',
    counterScope: 'account',
    counterEpoch: 'epoch-1',
    attribution: { connectionId: 'c-1', status: 'verified' }
  })
  refreshUsageAggregates(db, source, { timeZone: 'UTC', now: START })

  const alltime = grand(db)
  assert.equal(alltime.totals.total, 1_100)
  assert.equal(alltime.unallocatedTokens, 1_100, 'unallocated is a real amount, not zero')
  assert.equal(alltime.coverage.temporal, 'unallocated')
  assert.equal(alltime.coverage.unquantifiedUnallocatedEntries, 0)
  const hourRows = allUsageSummaries(db, { grain: 'hour' }).summaries.filter(
    (row) => Object.keys(row.dimensions).length === 0
  )
  assert.equal(hourRows.length, 0, 'a six hour interval never becomes one hour bucket')
  const dayRows = allUsageSummaries(db, { grain: 'day' }).summaries.filter(
    (row) => Object.keys(row.dimensions).length === 0
  )
  assert.deepEqual(
    dayRows.map((row) => [row.timeBucket.startUtc, row.totals.total]),
    [[day, 600]],
    'only the interval that fits one local day is allocated'
  )
  const weekStart = allUsageSummaries(db, { grain: 'week' }).summaries.filter(
    (row) => Object.keys(row.dimensions).length === 0
  )
  assert.equal(weekStart[0]!.totals.total, 700, 'day-crossing usage is still allocated to its week')
  assert.equal(contributionsOf(db, wide.entryId) > 0, true)
  const envelope = usageSummaryEnvelope({
    summaries: [alltime],
    freshness: {
      ledgerWatermark: 0,
      attributionWatermark: 0,
      poolClaimWatermark: '',
      pending: false,
      computedAt: 0
    },
    generation: alltime.generation,
    nextCursor: null,
    exhausted: true
  })
  assert.deepEqual(
    envelope.unidentified.filter((item) => item.axis === 'time').map((item) => item.amount),
    [1_100]
  )
  db.close()
}

// ── public DTO projection: bounded pages, axes and component coverage ───────
{
  const db = createFixtureDb()
  addProvider(db, 'provider-anthropic', 'offering-claude')
  addConnection(db, 'conn-1', 'offering-claude')
  const source = usageLedgerAggregateSource(db)
  recordUsage(db, {
    readingId: 'dto-1',
    accountingKey: 'dto-1',
    values: { total: 10, inputTotal: 4 },
    time: pointTime(START),
    attribution: {
      connectionId: 'conn-1',
      status: 'verified',
      requestedModel: {
        namespace: 'anthropic',
        nativeName: 'claude-3-5',
        modelId: 'model-claude-3-5'
      }
    }
  })
  recordUsage(db, {
    readingId: 'dto-2',
    accountingKey: 'dto-2',
    values: { total: 20 },
    time: pointTime(START),
    attribution: {
      connectionId: 'conn-1',
      status: 'observed',
      requestedModel: { namespace: 'anthropic', nativeName: 'unnamed-preview' }
    }
  })
  recordUsage(db, {
    readingId: 'dto-3',
    accountingKey: 'dto-3',
    values: {},
    time: pointTime(START)
  })
  refreshUsageAggregates(db, source, { timeZone: 'UTC', now: START })

  const first = queryUsageSummaries(db, { grain: 'alltime' }, { limit: 3, source })
  assert.equal(first.page.summaries.length, 3)
  assert.ok(first.page.nextCursor, 'a full page reports where to continue')
  assert.equal(first.page.exhausted, false)
  assert.equal(first.freshness.pending, false)
  assert.equal(first.freshness.ledgerWatermark, Number(publishedGeneration(db)!.ledger_watermark))
  const everything = allUsageSummaries(db, { grain: 'alltime' }).summaries
  const collected: UsageSummary[] = []
  let cursor: string | null = null
  let pages = 0
  for (;;) {
    const page = queryUsageSummaries(db, { grain: 'alltime' }, { limit: 3, cursor, source })
    collected.push(...page.page.summaries)
    pages += 1
    if (!page.page.nextCursor) break
    cursor = page.page.nextCursor
    assert.ok(pages < 50, 'paging must terminate')
  }
  assert.ok(pages > 1)
  assert.equal(collected.length, everything.length, 'paging visits every row exactly once')
  assert.equal(new Set(collected.map((row) => row.key)).size, everything.length)
  assert.equal(new Set(everything.map((row) => row.key)).size, everything.length)

  const envelope = usageSummaryEnvelope({
    summaries: everything,
    freshness: first.freshness,
    generation: first.generation,
    nextCursor: null,
    exhausted: true
  })
  const axes = new Set(envelope.unidentified.map((item) => item.axis))
  assert.equal(
    axes.has('model-alias:requested'),
    true,
    'an unmapped native model is reported, not relabelled'
  )
  assert.equal(axes.has('provider'), true, 'the unattributed entry keeps its axis')
  assert.equal(axes.has('component:inputTotal'), true, 'partial component observation is stated')
  assert.equal(axes.has('component:total'), true)
  const modeled = envelope.items.find(
    (item) =>
      item.dimensions.requestedModel?.modelId === 'model-claude-3-5' &&
      item.timeBucket?.grain === 'all-time'
  )
  assert.ok(modeled, 'a resolved catalog model rides inside the native ref')
  assert.equal(modeled.dimensions.requestedModel?.nativeName, 'claude-3-5')
  assert.equal(modeled.dimensions.requestedModel?.namespace, 'anthropic')
  const aliasRow = envelope.items.find(
    (item) =>
      item.timeBucket?.grain === 'all-time' &&
      item.key ===
        everything.find((row) => row.dimensions.requestedModel?.nativeName === 'unnamed-preview')!
          .key
  )
  assert.ok(aliasRow)
  assert.equal(
    aliasRow.dimensions.requestedModel?.nativeName,
    'unnamed-preview',
    'an unmapped native model keeps its own identity'
  )
  assert.equal(
    aliasRow.dimensions.requestedModel?.modelId,
    undefined,
    'an alias without a catalog model is never relabelled'
  )
  assert.equal(aliasRow.pending, false)
  assert.equal(typeof envelope.watermark.ledger, 'string')
  assert.equal(typeof envelope.aggregateGeneration, 'string')
  db.close()
}

// ── a definition or time zone change replaces the published generation ──────
{
  const db = createFixtureDb()
  const source = usageLedgerAggregateSource(db)
  recordUsage(db, {
    readingId: 'tz-1',
    accountingKey: 'tz-1',
    values: { total: 5 },
    time: pointTime(START)
  })
  recordUsage(db, {
    readingId: 'tz-2',
    accountingKey: 'tz-2',
    values: { total: 7 },
    time: pointTime(START + DAY)
  })
  const before = refreshUsageAggregates(db, source, { timeZone: 'UTC', now: START })
  assert.equal(grand(db).totals.total, 12)
  const switched = refreshUsageAggregates(db, source, { timeZone: 'Asia/Seoul', now: START })
  assert.notEqual(switched.generation, before.generation)
  assert.equal(publishedGeneration(db)!.generation, switched.generation)
  assert.equal(
    Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM metering_aggregate_generations
    WHERE state='published'`
          )
          .get() as { n: number }
      ).n
    ),
    1
  )
  assert.equal(switched.applied, 2, 'the fresh generation replays the durable feed')
  assert.equal(grand(db).totals.total, 12)
  assert.equal(grand(db).timeBucket.timeZone, 'Asia/Seoul')
  const days = allUsageSummaries(db, { grain: 'day' }).summaries.filter(
    (row) => Object.keys(row.dimensions).length === 0
  )
  assert.equal(days.length, 2)
  assert.deepEqual(
    days.map((row) => row.timeBucket.startUtc).sort(),
    ['2026-03-01T15:00:00.000Z', '2026-03-02T15:00:00.000Z'].map(Date.parse),
    'day buckets follow the configured time zone, not UTC'
  )
  assert.equal(new Set(days.map((row) => row.timeBucket.timeZone)).size, 1)
  db.close()
}

// ── exact-shape dimensionKeys + multi-page filtered walk ────────────────────
{
  const db = createFixtureDb()
  // 450 distinct sessions push the published generation past one QUERY_FETCH
  // page, so a filter that matches nothing still has to keep walking. The
  // ledger FK wants each session registered first.
  const insertSession = db.prepare(`INSERT INTO harness_sessions
    (id,harness_id,origin_machine_id,namespace,native_session_key,parent_session_id,title,
     first_observed_at,last_observed_at,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
  for (let index = 0; index < 450; index++) {
    insertSession.run(
      `sess-${index}`,
      'codex',
      'machine-fixture',
      'fixture',
      `native-${index}`,
      null,
      null,
      START + index,
      START + index,
      '{}'
    )
    recordUsage(db, {
      readingId: `shape-${index}`,
      accountingKey: `shape-${index}`,
      sessionId: `sess-${index}`,
      values: { total: 1 },
      time: pointTime(START + index)
    })
  }
  const source = usageLedgerAggregateSource(db)
  rebuildUsageAggregates(db, source, { timeZone: 'UTC', now: START })

  // dimensionKeys:[] selects exactly the {} grand-total row — a bounded page
  // cannot miss it behind rows of other shapes.
  const globalOnly = queryUsageSummaries(db, { grain: 'alltime' }, { dimensionKeys: [], limit: 10 })
  assert.equal(globalOnly.page.summaries.length, 1)
  assert.deepEqual(Object.keys(globalOnly.page.summaries[0]!.dimensions), [])
  assert.equal(globalOnly.page.summaries[0]!.totals.total, 450)

  // Exact means the SET of keys: {sessionId} rows only — never the {} row or
  // the {machineId,harnessId} rows that share the page.
  const sessions = queryUsageSummaries(
    db,
    { grain: 'alltime' },
    { dimensionKeys: ['sessionId'], limit: 5 }
  )
  assert.equal(sessions.page.summaries.length, 5)
  assert.ok(
    sessions.page.summaries.every((row) => Object.keys(row.dimensions).join(',') === 'sessionId')
  )
  assert.ok(sessions.page.nextCursor, 'more exact-shape rows remain beyond the page')
  const harnessShape = queryUsageSummaries(
    db,
    { grain: 'alltime' },
    { dimensionKeys: ['harnessId'], limit: 5 }
  )
  assert.equal(
    harnessShape.page.summaries.length,
    0,
    'the stored harness rollup is {machineId,harnessId} — {harnessId} alone is a different shape'
  )
  const machineHarness = queryUsageSummaries(
    db,
    { grain: 'alltime' },
    { dimensionKeys: ['harnessId', 'machineId'], limit: 5 }
  )
  assert.equal(machineHarness.page.summaries.length, 1)
  assert.equal(machineHarness.page.summaries[0]!.totals.total, 450)

  // Regression: a filtered walk that fills its first QUERY_FETCH page without
  // a cursor must rebuild the statement before the next page — the keyset
  // clause only exists once a position is held, and pushing position args
  // into the first statement bound too many parameters.
  const none = queryUsageSummaries(db, { grain: 'alltime', sessionId: 'sess-none' }, { limit: 5 })
  assert.equal(none.page.summaries.length, 0)
  assert.equal(none.page.exhausted, true)
  db.close()
}

// ── dimensionKeys is enforced in SQL, ahead of the walk's page guard ────────
{
  const db = createFixtureDb()
  recordUsage(db, {
    readingId: 'guard-1',
    accountingKey: 'guard-1',
    values: { total: 7 },
    time: pointTime(START)
  })
  const source = usageLedgerAggregateSource(db)
  rebuildUsageAggregates(db, source, { timeZone: 'UTC', now: START })
  const generation = publishedGeneration(db)!.generation
  // 12,801 wrong-shape rows keyed ahead of every real sha256 summary key —
  // '-' (0x2d) sorts below every hex digit, so this order is deterministic and
  // the {} row sits beyond the walk's 32*QUERY_FETCH examination guard. A
  // post-fetch shape filter would return an empty page with a live cursor.
  const insert = db.prepare(`INSERT INTO metering_usage_summaries
    (generation,summary_key,revision,definition_revision,dimensions_json,grain,
     bucket_start_utc,bucket_end_utc,time_zone,week_start,total_tokens,
     entry_count,unallocated_tokens,unknown_attribution_tokens,
     coverage_json,attribution_coverage_json,ledger_watermark,attribution_watermark,
     pool_claim_watermark,computed_at)
    VALUES (?,?,1,1,?,'alltime',NULL,NULL,'UTC',1,1,1,0,0,?,?,0,0,'',1)`)
  const coverageJson = JSON.stringify({
    completeness: 'complete',
    knownTokens: 1,
    unknownTokens: 0,
    unallocatedTimeTokens: 0,
    coverageIds: []
  })
  const attributionJson = JSON.stringify({
    attributedTokens: 1,
    unattributedTokens: 0,
    status: 'complete'
  })
  db.exec('BEGIN')
  for (let index = 0; index < 12_801; index++) {
    insert.run(
      generation,
      '-' + String(index).padStart(63, '0'),
      JSON.stringify({ sessionId: `sx-${index}` }),
      coverageJson,
      attributionJson
    )
  }
  db.exec('COMMIT')
  const globalRow = queryUsageSummaries(db, { grain: 'alltime' }, { dimensionKeys: [], limit: 1 })
  assert.equal(
    globalRow.page.summaries.length,
    1,
    'the {} row is found even when it sorts beyond the examination guard'
  )
  assert.equal(globalRow.page.summaries[0]!.totals.total, 7)
  db.close()
}

console.log('usage aggregate smoke: ok')
