/**
 * Metering (aggregate + statistic) operation surface.
 *
 * Registration: `registerMeteringAggregateOps(registry)` — call it from the
 * composition root, which also applies `USAGE_AGGREGATES_SCHEMA_SQL` and
 * `USAGE_STATISTICS_SCHEMA_SQL` as additive migrations and grants service
 * visibility to the mutation rows below.
 *
 * Dependencies this module reads (owned elsewhere; signatures are what this
 * reader relies on, not what it may change):
 * - usage ledger feed `usage_ledger_changes(sequence,entry_id,entry_revision,kind,changed_at)`
 *   plus `usage_aggregate_intents(change_sequence,state,applied_generation)`;
 *   `usage_entries` current revision + `accounting_status`; `usage_attributions`
 *   current revision for connection/model/status.
 * - inventory `inventory_quota_pool_claims(connection_id,provider_pool_key,scope,observed_at,valid_until,revision)`
 *   joined through `inventory_provider_connections(id,offering_id)` /
 *   `catalog_offerings(id,provider_id)`. Claim rows are corrected in place, so
 *   this reader tracks them by a digest, not by insertion order; a claim row
 *   *removed* from the table cannot be attributed to a connection here and
 *   requires an explicit `metering.aggregate.rebuild`.
 * - collection `collection_coverage(id,interval_json,completeness,gap_reason)`
 *   as the only source of statistic coverage facts.
 * - public DTOs from `mahas-contracts/src/metering`: every read returns the
 *   contract shape (projected in `aggregates/dto.ts`).
 *
 * Operations (visibility, mutation):
 *   metering.summary.query (member, read)
 *     payload { filter?: SummaryFilter, limit?: int<=5000, cursor?: string|null,
 *        dimensionKeys?: string[] — exact rollup shape; [] selects the {} row }
 *     -> UsageSummaryEnvelope { items: contracts.UsageSummary[], coverage[],
 *        freshness, watermark{ledger,attribution,aggregate}, unidentified[],
 *        nextCursor?, aggregateGeneration, pending, page{size,exhausted} }
 *   metering.summary.rank (member, read)
 *     payload { filter?: SummaryFilter, limit? } -> same envelope, ranked by total
 *   metering.pool.share (member, read)
 *     payload { filter: SummaryFilter & { verifiedPool } } ->
 *     { verifiedPool, items: PublicVerifiedPoolShare[], denominatorCoverage,
 *       unidentified[], freshness, page }
 *   metering.aggregate.refresh (service, mutation)
 *     payload { timeZone, weekStart?, limit?, now?, maxPublishAttempts? }
 *     -> RefreshAggregatesResult { generation, applied, pending, cursor,
 *        ledgerWatermark, attributionWatermark }
 *   metering.aggregate.rebuild (service, mutation)
 *     payload { timeZone, weekStart?, limit?, now?, maxPublishAttempts? }
 *     -> RebuildAggregatesResult { generation, scanned, caughtUp, pruned,
 *        publishAttempts, cursor }; throws AggregateRebuildConflict
 *        (code 'aggregate-rebuild-conflict') when the feed never settles — the
 *        caller retries, the abandoned build is already dropped.
 *   metering.aggregate.prune (service, mutation) -> { pruned: number }
 *   metering.statistic.definition.register (service, mutation) -> definition
 *   metering.statistic.coverage.project (service, mutation) -> span
 *   metering.statistic.refresh (service, mutation) payload { asOf? }
 *     -> UsageStatisticEnvelope
 *   metering.statistic.get / list (member, read) -> UsageStatisticEnvelope | null
 */
import type { OperationRegistry } from '../api/registry.ts'
import { usageLedgerAggregateSource } from './aggregates/ledger-source.ts'
import {
  pruneAbandonedGenerations,
  queryUsageSummaries,
  queryVerifiedPoolShares,
  rankUsageSummaries,
  rebuildUsageAggregates,
  refreshUsageAggregates
} from './aggregates/service.ts'
import type { RefreshAggregatesOptions } from './aggregates/service.ts'
import type { ModelDimension, SummaryFilter, UsageDimensions } from './aggregates/types.ts'
import type { TimeGrain } from './aggregates/time.ts'
import {
  projectVerifiedPoolShare,
  statisticUnidentified,
  usageStatisticEnvelope,
  usageSummaryEnvelope
} from './aggregates/dto.ts'
import {
  getUsageStatistic,
  listUsageStatistics,
  refreshUsageStatistics,
  registerCoverageSpan,
  registerStatisticDefinition
} from './statistics/service.ts'
import type { CoverageSpanInput, StatisticDefinition, StatisticMetric } from './statistics/types.ts'

export const METERING_AGGREGATE_OPERATION_NAMES = [
  'metering.summary.query',
  'metering.summary.rank',
  'metering.pool.share',
  'metering.aggregate.refresh',
  'metering.aggregate.rebuild',
  'metering.aggregate.prune',
  'metering.statistic.definition.register',
  'metering.statistic.coverage.project',
  'metering.statistic.refresh',
  'metering.statistic.get',
  'metering.statistic.list'
] as const

const GRAINS: readonly TimeGrain[] = ['alltime', 'hour', 'day', 'week']
const METRICS: readonly StatisticMetric[] = [
  'weekly-average',
  'daily-average-within-week',
  'hourly-by-date',
  'hour-of-day-distribution',
  'hour-of-day-average'
]

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('payload must be an object')
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${field} must be a non-empty string`)
  return value
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error(`${field} must be a safe integer`)
  return value
}

function modelDimension(value: unknown, field: string): ModelDimension {
  const input = object(value)
  return {
    namespace: text(input['namespace'], `${field}.namespace`),
    nativeName: text(input['nativeName'], `${field}.nativeName`),
    ...(input['modelId'] === undefined
      ? {}
      : { modelId: text(input['modelId'], `${field}.modelId`) })
  }
}

function verifiedPool(value: unknown, field: string): { providerPoolKey: string; scope: string } {
  const input = object(value)
  return {
    providerPoolKey: text(input['providerPoolKey'], `${field}.providerPoolKey`),
    scope: text(input['scope'], `${field}.scope`)
  }
}

/** Explicit filter parsing: an unknown key or a wrong type is a caller error,
 * never a silently ignored narrowing. */
function summaryFilter(value: unknown, field = 'filter'): SummaryFilter {
  if (value === undefined || value === null) return {}
  const input = object(value)
  const filter: SummaryFilter = {}
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined) continue
    switch (key) {
      case 'sessionId':
      case 'machineId':
      case 'harnessId':
        filter[key] = text(raw, `${field}.${key}`)
        break
      case 'providerId':
      case 'offeringId':
      case 'connectionId':
        filter[key] = raw === null ? null : text(raw, `${field}.${key}`)
        break
      case 'requestedModel':
        filter.requestedModel = raw === null ? null : modelDimension(raw, `${field}.requestedModel`)
        break
      case 'servedModel':
        filter.servedModel = raw === null ? null : modelDimension(raw, `${field}.servedModel`)
        break
      case 'verifiedPool':
        filter.verifiedPool = raw === null ? null : verifiedPool(raw, `${field}.verifiedPool`)
        break
      case 'grain': {
        const grain = text(raw, `${field}.grain`) as TimeGrain
        if (!GRAINS.includes(grain))
          throw new Error(`${field}.grain must be one of ${GRAINS.join(', ')}`)
        filter.grain = grain
        break
      }
      case 'startUtc':
        filter.startUtc = integer(raw, `${field}.startUtc`)
        break
      case 'endUtc':
        filter.endUtc = integer(raw, `${field}.endUtc`)
        break
      default:
        throw new Error(`unsupported summary filter key ${key}`)
    }
  }
  return filter
}

/** Axis names a stored summary row may be grouped by — the UsageDimensions
 *  contract keys. An unknown name is a caller error, never a silent no-match. */
const DIMENSION_AXES = new Set([
  'machineId',
  'harnessId',
  'sessionId',
  'providerId',
  'offeringId',
  'connectionId',
  'requestedModel',
  'servedModel',
  'verifiedPool',
  'organizationId',
  'organizationRelation'
])

function dimensionKeys(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('dimensionKeys must be an array of axis names')
  const keys = value.map((raw, index) => {
    const key = text(raw, `dimensionKeys[${index}]`)
    if (!DIMENSION_AXES.has(key)) throw new Error(`unsupported dimension axis ${key}`)
    return key
  })
  return [...new Set(keys)]
}

function queryOptions(input: Record<string, unknown>): {
  limit?: number
  cursor?: string | null
  dimensionKeys?: string[]
} {
  return {
    ...(input['limit'] === undefined ? {} : { limit: integer(input['limit'], 'limit') }),
    ...(input['cursor'] === undefined
      ? {}
      : { cursor: input['cursor'] === null ? null : text(input['cursor'], 'cursor') }),
    ...(input['dimensionKeys'] === undefined
      ? {}
      : { dimensionKeys: dimensionKeys(input['dimensionKeys']) })
  }
}

function aggregateOptions(value: unknown): RefreshAggregatesOptions {
  const input = object(value)
  const timeZone = text(input['timeZone'], 'timeZone')
  new Intl.DateTimeFormat('en', { timeZone }).format(0)
  const weekStart = input['weekStart'] === undefined ? 1 : integer(input['weekStart'], 'weekStart')
  if (weekStart < 1 || weekStart > 7) throw new RangeError('weekStart must be 1..7')
  return {
    timeZone,
    weekStart,
    ...(input['limit'] === undefined ? {} : { limit: integer(input['limit'], 'limit') }),
    ...(input['now'] === undefined ? {} : { now: integer(input['now'], 'now') }),
    ...(input['maxPublishAttempts'] === undefined
      ? {}
      : { maxPublishAttempts: integer(input['maxPublishAttempts'], 'maxPublishAttempts') })
  }
}

function statisticDefinition(value: unknown): StatisticDefinition {
  const input = object(value)
  const window = object(input['window'])
  const kind = text(window['kind'], 'window.kind')
  const metric = text(input['metric'], 'metric') as StatisticMetric
  if (!METRICS.includes(metric)) throw new Error(`metric must be one of ${METRICS.join(', ')}`)
  const weekStart = integer(input['weekStart'] ?? 1, 'weekStart')
  if (weekStart !== 1 && weekStart !== 7)
    throw new Error('weekStart must be 1 (monday) or 7 (sunday)')
  const dimensions = (
    input['dimensions'] === undefined ? {} : summaryFilter(input['dimensions'], 'dimensions')
  ) as UsageDimensions
  const range =
    kind === 'fixed'
      ? (() => {
          const fixed = object(window) as Record<string, unknown>
          const start = integer(fixed['start'], 'window.start')
          const end = integer(fixed['end'], 'window.end')
          if (end <= start) throw new Error('window.end must be after window.start')
          return { kind: 'fixed' as const, start, end }
        })()
      : (() => {
          const count = integer(window['count'], 'window.count')
          if (count < 1) throw new Error('window.count must be positive')
          return { kind: 'rolling-completed-weeks' as const, count }
        })()
  return {
    id: text(input['id'], 'id'),
    definitionRevision: integer(input['definitionRevision'], 'definitionRevision'),
    metric,
    dimensions,
    timeZone: text(input['timeZone'], 'timeZone'),
    weekStart,
    completedPeriodsOnly: input['completedPeriodsOnly'] !== false,
    window: range,
    enabled: input['enabled'] !== false
  }
}

/** Canonical metering operation registrations. Every read returns the public
 * contract DTO projected from persisted rows: queries never rescan native logs,
 * and unknown amounts travel in `unidentified`/coverage instead of as zero. */
export function registerMeteringAggregateOps(registry: OperationRegistry): void {
  registry.register(
    {
      name: 'metering.summary.query',
      visibility: 'member',
      mutation: false,
      summary: 'query canonical persisted usage summaries, coverage and freshness'
    },
    (txn, payload) => {
      const input = object(payload)
      const result = queryUsageSummaries(txn.db, summaryFilter(input['filter']), {
        ...queryOptions(input),
        source: usageLedgerAggregateSource(txn.db)
      })
      return usageSummaryEnvelope({
        summaries: result.page.summaries,
        freshness: result.freshness,
        generation: result.generation,
        nextCursor: result.page.nextCursor,
        exhausted: result.page.exhausted
      })
    }
  )
  registry.register(
    {
      name: 'metering.summary.rank',
      visibility: 'member',
      mutation: false,
      summary: 'rank matching summaries across the published generation'
    },
    (txn, payload) => {
      const input = object(payload)
      const filter = summaryFilter(input['filter'])
      const items = rankUsageSummaries(
        txn.db,
        filter,
        input['limit'] === undefined ? 20 : integer(input['limit'], 'limit')
      )
      const result = queryUsageSummaries(txn.db, filter, {
        limit: 1,
        source: usageLedgerAggregateSource(txn.db)
      })
      return usageSummaryEnvelope({
        summaries: items,
        freshness: result.freshness,
        generation: result.generation,
        nextCursor: null,
        exhausted: true
      })
    }
  )
  registry.register(
    {
      name: 'metering.pool.share',
      visibility: 'member',
      mutation: false,
      summary: 'query harness token shares for a verified provider usage pool'
    },
    (txn, payload) => {
      const input = object(payload)
      const scoped = input['filter'] === undefined ? {} : object(input['filter'])
      if (scoped['verifiedPool'] === undefined) throw new Error('filter.verifiedPool is required')
      const pool = verifiedPool(scoped['verifiedPool'], 'filter.verifiedPool')
      const filter = { ...summaryFilter(input['filter']), verifiedPool: pool }
      const shares = queryVerifiedPoolShares(txn.db, filter)
      const result = queryUsageSummaries(txn.db, filter, {
        limit: 1,
        source: usageLedgerAggregateSource(txn.db)
      })
      return {
        verifiedPool: pool,
        items: shares.map(projectVerifiedPoolShare),
        denominatorCoverage: shares[0]?.denominatorCoverage ?? 'unknown',
        unidentified: [],
        freshness: result.freshness,
        page: { size: shares.length }
      }
    }
  )
  registry.register(
    {
      name: 'metering.aggregate.refresh',
      visibility: 'service',
      mutation: true,
      summary: 'apply one bounded usage-ledger change batch and persist its checkpoint'
    },
    (txn, payload) =>
      refreshUsageAggregates(txn.db, usageLedgerAggregateSource(txn.db), aggregateOptions(payload))
  )
  registry.register(
    {
      name: 'metering.aggregate.rebuild',
      visibility: 'service',
      mutation: true,
      summary: 'rebuild summaries beside the published generation and publish atomically'
    },
    (txn, payload) =>
      rebuildUsageAggregates(txn.db, usageLedgerAggregateSource(txn.db), aggregateOptions(payload))
  )
  registry.register(
    {
      name: 'metering.aggregate.prune',
      visibility: 'service',
      mutation: true,
      summary: 'drop building generations abandoned by an interrupted rebuild'
    },
    (txn) => ({ pruned: pruneAbandonedGenerations(txn.db) })
  )
  registry.register(
    {
      name: 'metering.statistic.definition.register',
      visibility: 'service',
      mutation: true,
      summary: 'register a versioned persisted usage statistic definition'
    },
    (txn, payload) => {
      const input = object(payload)
      const definition = statisticDefinition(input['definition'])
      registerStatisticDefinition(
        txn.db,
        definition,
        input['updatedAt'] === undefined ? Date.now() : integer(input['updatedAt'], 'updatedAt')
      )
      return definition
    }
  )
  registry.register(
    {
      name: 'metering.statistic.coverage.project',
      visibility: 'service',
      mutation: true,
      summary: 'project canonical collection coverage into a statistic scope'
    },
    (txn, payload) => {
      const input = object(payload)
      const span = input['span'] as unknown as CoverageSpanInput
      registerCoverageSpan(txn.db, span)
      return span
    }
  )
  registry.register(
    {
      name: 'metering.statistic.refresh',
      visibility: 'service',
      mutation: true,
      summary: 'recompute registered statistics, including rolling completed weeks'
    },
    (txn, payload) => {
      const input = object(payload)
      const statistics = refreshUsageStatistics(txn.db, {
        ...(input['asOf'] === undefined ? {} : { asOf: integer(input['asOf'], 'asOf') }),
        source: usageLedgerAggregateSource(txn.db)
      })
      return usageStatisticEnvelope(statistics)
    }
  )
  registry.register(
    {
      name: 'metering.statistic.get',
      visibility: 'member',
      mutation: false,
      summary: 'get the latest persisted result for a statistic definition'
    },
    (txn, payload) => {
      const statistic = getUsageStatistic(txn.db, text(object(payload)['id'], 'id'))
      if (!statistic) return null
      return {
        ...usageStatisticEnvelope([statistic]),
        unidentified: statisticUnidentified([statistic])
      }
    }
  )
  registry.register(
    {
      name: 'metering.statistic.list',
      visibility: 'member',
      mutation: false,
      summary: 'list latest persisted usage statistic results'
    },
    (txn, payload) => {
      const input = object(payload)
      const metric =
        input['metric'] === undefined
          ? undefined
          : (text(input['metric'], 'metric') as StatisticMetric)
      if (metric && !METRICS.includes(metric))
        throw new Error(`metric must be one of ${METRICS.join(', ')}`)
      const statistics = listUsageStatistics(txn.db, {
        ...(metric ? { metric } : {}),
        ...(input['dimensions'] === undefined
          ? {}
          : { dimensions: summaryFilter(input['dimensions'], 'dimensions') as UsageDimensions })
      })
      return usageStatisticEnvelope(statistics)
    }
  )
}
