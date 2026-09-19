import type { TokenTotals, UsageDimensions } from '../aggregates/types.ts'

export type StatisticMetric = 'weekly-average' | 'daily-average-within-week' | 'hourly-by-date' |
  'hour-of-day-distribution' | 'hour-of-day-average'

export interface StatisticDefinition {
  id: string
  definitionRevision: number
  metric: StatisticMetric
  dimensions: UsageDimensions
  timeZone: string
  weekStart: 1 | 7
  completedPeriodsOnly: boolean
  window: { kind: 'rolling-completed-weeks'; count: number } | { kind: 'fixed'; start: number; end: number }
  enabled: boolean
}

export interface StatisticCoverage {
  completeness: 'complete' | 'partial' | 'unknown'
  /** Sum of the observed `total` component; never a substitute for unknown. */
  knownTokens: number
  /** null when at least one contributing value is unknown; 0 only when every
   * in-scope period observed a value. */
  unknownTokens: number | null
  unallocatedTimeTokens: number
  coverageIds: string[]
  /** In-scope periods that contributed an observed value. */
  knownPeriods: number
  /** In-scope periods whose token values are unknown (not an observed zero). */
  unknownPeriods: number
  /** Components unknown for at least one contributing period. */
  incompleteComponents: (keyof TokenTotals)[]
  /** The published aggregate generation still has ledger changes to consume,
   * so periods that look empty may simply not be folded in yet. */
  pending: boolean
}

export interface StatisticBucket {
  key: string
  startUtc?: number
  endUtc?: number
  value: TokenTotals
  denominator?: number | null
  coverage: StatisticCoverage
}

export interface StatisticExclusion { start: number; end: number; reason: string }

export interface PersistedUsageStatistic {
  id: string
  definitionRevision: number
  resultRevision: number
  metric: StatisticMetric
  dimensions: UsageDimensions
  range: { start: number; end: number }
  timeZone: string
  calendarPolicy: { weekStart: 'monday' | 'sunday'; completedPeriodsOnly: boolean }
  value: TokenTotals | null
  buckets: StatisticBucket[] | null
  numerator: TokenTotals
  denominator: number | null
  expectedPeriods: number | null
  validPeriods: number | null
  exclusions: StatisticExclusion[]
  coverage: StatisticCoverage
  sourceWatermarks: string[]
  asOf: number
  computedAt: number
}

export interface CoverageSpanInput {
  id: string
  /** Existing CollectionCoverage fact. Time/status are projected from it and
   * cannot be supplied independently by the statistics caller. */
  coverageId: string
  dimensions: UsageDimensions
  revision: number
  observedAt: number
}
