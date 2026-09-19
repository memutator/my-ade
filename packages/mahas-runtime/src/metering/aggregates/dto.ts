/**
 * Projection from the persisted aggregate/statistic rows onto the canonical
 * `mahas-contracts/src/metering` DTOs.
 *
 * The read models here and the persisted rows are not the same shape on
 * purpose: rows keep the reader's coordinates (generation, feed positions,
 * per-component known counts) while the public DTO has to state coverage,
 * freshness and unidentified amounts without inventing numbers. Unknown never
 * projects to 0 — it projects to `unknownTokens: null`, a `partial`/`unknown`
 * completeness and an `unidentified[]` entry that says what is missing.
 */
import type {
  MeteringQueryEnvelope, UsageAttributionCoverage, UsageCoverageSummary,
  UsageDimensions as PublicUsageDimensions, UsageStatistic, UsageStatisticBucket as PublicStatisticBucket,
  UsageModelRef, UsageSummary as PublicUsageSummary, UsageTimeBucket, UsageValues
} from '../../../../mahas-contracts/src/metering/index.ts'
import type {
  AggregateFreshness, ModelDimension, TokenTotals, UsageDimensions, UsageSummary, VerifiedPoolShare
} from './types.ts'
import type { PersistedUsageStatistic, StatisticBucket, StatisticCoverage } from '../statistics/types.ts'

/** `amount` is always present: null means "an unknown amount exists and cannot
 * be totalled", 0 is never used as a stand-in for unknown. */
type Unidentified = { axis: string; amount: number | null; reason: string }

function values(totals: TokenTotals): UsageValues {
  return { inputTotal: totals.inputTotal, outputTotal: totals.outputTotal, total: totals.total,
    cacheReadInput: totals.cacheReadInput, cacheWriteInput: totals.cacheWriteInput,
    reasoningOutput: totals.reasoningOutput }
}

/** Map a stored model axis to the public ref: the native pair always survives;
 *  a catalog 'modelId' rides inside it only when the collector proved the
 *  mapping. 'undefined' means the axis is absent from this rollup shape. */
function publicModel(model: ModelDimension | null | undefined): UsageModelRef | null | undefined {
  if (model === undefined) return undefined
  if (model === null) return null
  return { nativeName: model.nativeName, namespace: model.namespace,
    ...(model.modelId ? { modelId: model.modelId } : {}) }
}

/**
 * The stored dimensions_json IS the public shape: every axis the rollup is
 * grouped by survives, including axes whose value is null (grouped but
 * unattributed). Dropping a null axis here would collapse two different
 * rollups — a per-machine unattributed-provider bucket and a plain harness
 * rollup — onto the same public dimensions, and dropping the pool axis would
 * make a pool share read as the global total.
 */
export function publicDimensions(dimensions: UsageDimensions): PublicUsageDimensions {
  const out: PublicUsageDimensions = {}
  if ('machineId' in dimensions) out.machineId = dimensions.machineId ?? null
  if ('harnessId' in dimensions) out.harnessId = dimensions.harnessId ?? null
  if ('sessionId' in dimensions) out.sessionId = dimensions.sessionId ?? null
  if ('providerId' in dimensions) out.providerId = dimensions.providerId ?? null
  if ('offeringId' in dimensions) out.offeringId = dimensions.offeringId ?? null
  if ('connectionId' in dimensions) out.connectionId = dimensions.connectionId ?? null
  if ('requestedModel' in dimensions) out.requestedModel = publicModel(dimensions.requestedModel) ?? null
  if ('servedModel' in dimensions) out.servedModel = publicModel(dimensions.servedModel) ?? null
  if ('verifiedPool' in dimensions) out.verifiedPool = dimensions.verifiedPool ?? null
  return out
}

function publicTimeBucket(bucket: UsageSummary['timeBucket']): UsageTimeBucket {
  return { grain: bucket.grain === 'alltime' ? 'all-time' : bucket.grain,
    startUtc: bucket.startUtc, endUtc: bucket.endUtc, timeZone: bucket.timeZone,
    weekStart: bucket.weekStart === 7 ? 'sunday' : 'monday' }
}

function coverageDto(coverage: {
  completeness: 'complete' | 'partial' | 'unknown'
  knownTokens: number
  unallocatedTimeTokens: number
  coverageIds: readonly string[]
}): UsageCoverageSummary {
  return { completeness: coverage.completeness, knownTokens: coverage.knownTokens,
    unknownTokens: coverage.completeness === 'complete' ? 0 : null,
    unallocatedTimeTokens: coverage.unallocatedTimeTokens, coverageIds: [...coverage.coverageIds] }
}

/** `complete` only when every counted entry contributed a known token total and
 * nothing depends on an unquantified amount. */
function summaryCompleteness(summary: UsageSummary): 'complete' | 'partial' | 'unknown' {
  if (summary.entryCount === 0) return 'unknown'
  const unquantified = summary.coverage.unquantifiedUnallocatedEntries +
    summary.coverage.unquantifiedUnattributedEntries
  if (unquantified > 0) return 'partial'
  const known = summary.coverage.knownEntriesByComponent.total
  if (known === 0) return 'unknown'
  return known === summary.entryCount ? 'complete' : 'partial'
}

function attributionDto(summary: UsageSummary): UsageAttributionCoverage {
  const known = summary.totals.total ?? 0
  const unattributed = summary.unknownAttributionTokens
  return { attributedTokens: Math.max(0, known - unattributed), unattributedTokens: unattributed,
    status: summary.attributionCoverage.status === 'unknown' ? 'unknown'
      : summary.attributionCoverage.status === 'complete' && summary.entryCount > 0 ? 'complete' : 'partial' }
}

export function projectUsageSummary(summary: UsageSummary, pending: boolean): PublicUsageSummary {
  return {
    key: summary.key,
    dimensions: publicDimensions(summary.dimensions),
    timeBucket: publicTimeBucket(summary.timeBucket),
    totals: values(summary.totals),
    coverage: coverageDto({ completeness: summaryCompleteness(summary),
      knownTokens: summary.totals.total ?? 0,
      unallocatedTimeTokens: summary.unallocatedTokens,
      coverageIds: [] }),
    attributionCoverage: attributionDto(summary),
    definitionRevision: summary.definitionRevision,
    ledgerWatermark: String(summary.ledgerWatermark),
    attributionWatermark: String(summary.attributionWatermark),
    aggregateGeneration: String(summary.generation),
    pending,
    computedAt: summary.computedAt
  }
}

function addUnidentified(target: Unidentified[], axis: string, amount: number | null, reason: string): void {
  const found = target.find((item) => item.axis === axis)
  if (found) {
    found.amount = found.amount === null || amount === null ? null : found.amount + amount
    found.reason = reason
    return
  }
  target.push({ axis, amount, reason })
}

/** What the page cannot put in a single number: unallocated time, unresolved
 * provider/model axes and components that are only partly observed. Amounts
 * stay null when any contributing row has an unquantified amount. */
export function unidentifiedFromSummaries(summaries: readonly UsageSummary[]): Unidentified[] {
  const out: Unidentified[] = []
  const alltime = summaries.filter((summary) => summary.timeBucket.grain === 'alltime')
  /* Only the exact global rollup accounts for every counted entry. Any other
   * row is a partition of one axis family, and different axis families overlap
   * (a session row and a provider row cover the same entries) — so when the
   * global row is not in this page the amounts below cannot be derived, and
   * the page says so instead of summing an arbitrary shortest row. */
  const global = alltime.filter((summary) => Object.keys(summary.dimensions).length === 0)
  let unallocated = 0
  let unallocatedNull = false
  let unattributed = 0
  let unattributedNull = false
  const components = new Map<keyof TokenTotals, { known: number; entries: number }>()
  for (const summary of global) {
    unallocated += summary.unallocatedTokens
    if (summary.coverage.unquantifiedUnallocatedEntries > 0) unallocatedNull = true
    unattributed += summary.unknownAttributionTokens
    if (summary.coverage.unquantifiedUnattributedEntries > 0) unattributedNull = true
    for (const key of Object.keys(summary.coverage.knownEntriesByComponent) as (keyof TokenTotals)[]) {
      const known = summary.coverage.knownEntriesByComponent[key]
      if (known >= summary.entryCount) continue
      const found = components.get(key) ?? { known: 0, entries: 0 }
      found.known += known
      found.entries += summary.entryCount
      components.set(key, found)
    }
  }
  if (!global.length) {
    addUnidentified(out, 'page', null,
      'the global rollup is outside this page; unallocated and unattributed amounts cannot be derived')
  }
  if (unallocated > 0 || unallocatedNull) {
    addUnidentified(out, 'time', unallocatedNull ? null : unallocated,
      'usage time could not be assigned to the query granularity')
  }
  if (unattributed > 0 || unattributedNull) {
    addUnidentified(out, 'provider', unattributedNull ? null : unattributed,
      'entries without evidenced provider/offering/connection attribution')
  }

  /* Model axes live on the single-axis model rows. requestedModel and
   * servedModel are DIFFERENT rollups over the same entries — every entry
   * contributes to one group per role — so the two roles are reported as
   * separate axes and their amounts are never summed together. */
  const single = alltime.filter((summary) => Object.keys(summary.dimensions).length === 1)
  for (const [role, axis] of [['requestedModel', 'requested'], ['servedModel', 'served']] as const) {
    const roleRows = single.filter((summary) => role in summary.dimensions)
    const unmapped = roleRows.filter((summary) => {
      const model = summary.dimensions[role]
      return !!model && !model.modelId
    })
    if (unmapped.length) {
      addUnidentified(out, `model-alias:${axis}`, sumAmount(unmapped),
        `${unmapped.length} ${axis} model dimensions name a native model with no catalog model mapping`)
    }
    const absent = roleRows.filter((summary) => summary.dimensions[role] == null)
    if (absent.length) {
      addUnidentified(out, `model:${axis}`, sumAmount(absent),
        `${absent.reduce((total, row) => total + row.entryCount, 0)} counted entries report no ${axis} model`)
    }
  }
  const noProvider = alltime.filter((summary) => {
    const names = Object.keys(summary.dimensions)
    return names.length > 0 && names.length <= 2 && names.every((name) => name === 'machineId' || name === 'providerId') &&
      'providerId' in summary.dimensions && summary.dimensions.providerId === null
  })
  if (noProvider.length) {
    addUnidentified(out, 'provider-unattributed', sumAmount(noProvider),
      `${noProvider.reduce((total, row) => total + row.entryCount, 0)} counted entries carry no evidenced provider`)
  }
  for (const [key, counts] of components) {
    addUnidentified(out, `component:${key}`, null,
      `${key} is known for ${counts.known} of ${counts.entries} counted entries`)
  }
  return out
}

/** Amounts stay null when any contributing row has an unknown amount. */
function sumAmount(rows: readonly UsageSummary[]): number | null {
  let total = 0
  for (const row of rows) {
    if (row.coverage.knownEntriesByComponent.total < row.entryCount) return null
    total += row.totals.total ?? 0
  }
  return total
}

export interface UsageSummaryEnvelope extends MeteringQueryEnvelope<PublicUsageSummary> {
  /** Published generation this page was read from; null when none exists yet. */
  aggregateGeneration: string | null
  /** The source holds changes this generation has not consumed. */
  pending: boolean
  page: { size: number; exhausted: boolean }
}

export function usageSummaryEnvelope(input: {
  summaries: readonly UsageSummary[]
  freshness: AggregateFreshness
  generation: number | null
  nextCursor: string | null
  exhausted: boolean
}): UsageSummaryEnvelope {
  const { freshness } = input
  return {
    items: input.summaries.map((summary) => projectUsageSummary(summary, freshness.pending)),
    // Aggregate summaries do not own collection-coverage facts: a coverage id
    // is bound by the statistic layer (metering.statistic.*), which projects
    // the canonical collection_coverage rows into its own scope.
    coverage: [],
    freshness: { asOf: freshness.computedAt ?? 0, lastSuccessfulCollectionAt: null },
    watermark: { ledger: String(freshness.ledgerWatermark),
      attribution: String(freshness.attributionWatermark),
      aggregate: input.generation === null ? undefined : String(input.generation) },
    unidentified: unidentifiedFromSummaries(input.summaries),
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
    aggregateGeneration: input.generation === null ? null : String(input.generation),
    pending: freshness.pending,
    page: { size: input.summaries.length, exhausted: input.exhausted }
  }
}

export interface PublicVerifiedPoolShare {
  verifiedPool: { providerPoolKey: string; scope: string }
  dimensions: PublicUsageDimensions
  timeBucket: UsageTimeBucket
  numerator: number | null
  denominator: number | null
  share: number | null
  denominatorCoverage: 'complete' | 'partial' | 'unknown'
  unknownDenominatorEntries: number
}

export function projectVerifiedPoolShare(share: VerifiedPoolShare): PublicVerifiedPoolShare {
  return { verifiedPool: share.verifiedPool, dimensions: publicDimensions(share.dimensions),
    timeBucket: publicTimeBucket(share.timeBucket), numerator: share.numerator, denominator: share.denominator,
    share: share.share, denominatorCoverage: share.denominatorCoverage,
    unknownDenominatorEntries: share.unknownDenominatorEntries }
}

function statisticBucketDto(bucket: StatisticBucket): PublicStatisticBucket {
  return { key: bucket.key, startUtc: bucket.startUtc, endUtc: bucket.endUtc,
    value: values(bucket.value), denominator: bucket.denominator,
    coverage: coverageDto({ completeness: bucket.coverage.completeness,
      knownTokens: bucket.coverage.knownTokens,
      unallocatedTimeTokens: bucket.coverage.unallocatedTimeTokens,
      coverageIds: bucket.coverage.coverageIds }) }
}

export function projectUsageStatistic(statistic: PersistedUsageStatistic): UsageStatistic {
  return {
    id: statistic.id,
    definitionRevision: statistic.definitionRevision,
    metric: statistic.metric,
    dimensions: publicDimensions(statistic.dimensions),
    range: statistic.range,
    timeZone: statistic.timeZone,
    calendarPolicy: statistic.calendarPolicy,
    value: statistic.value ? values(statistic.value) : null,
    ...(statistic.buckets ? { buckets: statistic.buckets.map(statisticBucketDto) } : {}),
    numerator: values(statistic.numerator),
    denominator: statistic.denominator,
    expectedPeriods: statistic.expectedPeriods,
    validPeriods: statistic.validPeriods,
    exclusions: statistic.exclusions.map((exclusion) => ({ ...exclusion })),
    coverage: coverageDto({ completeness: statistic.coverage.completeness,
      knownTokens: statistic.coverage.knownTokens,
      unallocatedTimeTokens: statistic.coverage.unallocatedTimeTokens,
      coverageIds: statistic.coverage.coverageIds }),
    sourceWatermarks: [...statistic.sourceWatermarks],
    asOf: statistic.asOf,
    computedAt: statistic.computedAt
  }
}

export interface UsageStatisticEnvelope extends MeteringQueryEnvelope<UsageStatistic> {
  page: { size: number }
}

export function statisticUnidentified(statistics: readonly PersistedUsageStatistic[]): Unidentified[] {
  const out: Unidentified[] = []
  let uncovered = 0
  let unknownValue = 0
  const components = new Map<string, number>()
  for (const statistic of statistics) {
    uncovered += statistic.coverage.unknownPeriods
    if (statistic.coverage.unknownTokens === null) unknownValue++
    for (const component of statistic.coverage.incompleteComponents) {
      components.set(component, (components.get(component) ?? 0) + 1)
    }
  }
  if (uncovered > 0) addUnidentified(out, 'coverage', null,
    `${uncovered} in-scope periods have no observed token values`)
  if (unknownValue > 0) addUnidentified(out, 'tokens', null,
    `${unknownValue} statistics contain values that are unknown, not zero`)
  for (const [component, count] of components) {
    addUnidentified(out, `component:${component}`, null,
      `${component} is unknown for at least one contributing period in ${count} statistics`)
  }
  return out
}

export function usageStatisticEnvelope(statistics: readonly PersistedUsageStatistic[]): UsageStatisticEnvelope {
  const watermarks = [...new Set(statistics.flatMap((statistic) => [...statistic.sourceWatermarks]))]
  const read = (prefix: string): string | undefined => watermarks
    .find((watermark) => watermark.startsWith(`${prefix}:`))?.slice(prefix.length + 1)
  return {
    items: statistics.map(projectUsageStatistic),
    coverage: [],
    freshness: { asOf: statistics.length ? Math.max(...statistics.map((statistic) => statistic.asOf)) : 0,
      lastSuccessfulCollectionAt: null },
    watermark: { ledger: read('ledger'), attribution: read('attribution'), aggregate: read('aggregate-generation') },
    unidentified: statisticUnidentified(statistics),
    page: { size: statistics.length }
  }
}

export function statisticCoverageSummary(coverage: StatisticCoverage): UsageCoverageSummary {
  return coverageDto({ completeness: coverage.completeness, knownTokens: coverage.knownTokens,
    unallocatedTimeTokens: coverage.unallocatedTimeTokens, coverageIds: coverage.coverageIds })
}
