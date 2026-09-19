// Canonical stored rows → what the usage/tokens UI renders.
//
// The mapping keeps three distinctions that the old scanner UI could not make:
//
//   · UNKNOWN vs ZERO — a token component the store reports as `null` stays
//     `null` here. `usageNumber()` is GEOMETRY ONLY (bar widths, maxima, sorts);
//     anything that PRINTS a number uses `usageLabel()`, which renders an
//     unknown amount as '—' rather than as a measured 0.
//   · SHAPE vs SHAPE — aggregate rows exist for several dimension shapes
//     (harness-only, per-session, per-model…). A total is read from the row
//     whose dimension set is exactly the axis asked for; overlapping rows are
//     never added together.
//   · COVERAGE — an entry count, a known-component count, unallocated time and
//     unattributed tokens are carried to the screen instead of being silently
//     folded into a total.

import type {
  CollectionCompleteness,
  QuotaMeter,
  QuotaReading,
  UsageAttribution,
  UsageAttributionBasis,
  UsageAttributionStatus,
  UsageEntry,
  UsageStatistic,
  UsageValues
} from '../../../../../packages/mahas-contracts/src/index.ts'
import { fmtTok } from '../../utils'
import type { DomainQuotaCurrentView, DomainUsageSourceView } from '../../../../preload/domain'
import { sumValues } from './rollup'

// Exact-shape rollup selection lives in './rollup' (pure, Node-testable);
// re-exported here so existing consumers keep one import path.
export {
  connectionTotals,
  dimensionAxes,
  displayTotal,
  emptyValues,
  exactShape,
  globalSummary,
  harnessTotals,
  modelBreakdown,
  offeringTotals,
  poolShares,
  providerTotals,
  sumValues
} from './rollup'
export type { GroupedTotalsView, HarnessTotalsView, ModelTotalsView, PoolShareView } from './rollup'

/** GEOMETRY ONLY: bar widths, maxima, sort keys. Never a label — printing an
 *  unknown quantity through this function would read as a measured 0. */
export const usageNumber = (value: number | null | undefined): number => value ?? 0

/** Label for a possibly-unknown token amount: '—' when the store has no value. */
export function usageLabel(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : fmtTok(value)
}

// ── quota ──────────────────────────────────────────────────────────────────

export type MeterState = 'known' | 'unknown' | 'unlimited'

export interface QuotaWindowView {
  id: string
  label: string
  state: MeterState
  usedPct?: number
  resetAt?: number
  detail?: string
}

export type QuotaCardState = 'ready' | 'empty' | 'failed' | 'legacy'

export interface QuotaCardView {
  key: string
  harnessId?: string
  serviceLabel?: string
  origin: 'domain' | 'legacy'
  /** canonical connection behind this card; absent for legacy registrations */
  connectionId?: string
  state: QuotaCardState
  accountLabel?: string
  planLabel?: string
  identityClaims: { kind: string; value: string; confidence: string }[]
  planClaims: { key: string; label?: string | null; value: string }[]
  /** material reference (path/ref) — displayed, never opened here */
  materialRef?: string
  windows: QuotaWindowView[]
  observedAt?: number
  lastSuccessAt?: number
  providerMeasuredAt?: number
  failureMessage?: string
  diagnostics: string[]
}

/** Meter utilization → percentage, using stored used/limit first. A meter with
 *  neither a limit nor a utilization is `unknown`, NOT 0%. */
function meterPercent(meter: QuotaMeter): number | undefined {
  if (meter.used != null && meter.limit != null && meter.limit > 0) {
    return Math.max(0, Math.min(100, (meter.used / meter.limit) * 100))
  }
  if (meter.utilization != null) {
    return Math.max(0, Math.min(100, meter.utilization * 100))
  }
  return undefined
}

function meterDetail(meter: QuotaMeter): string | undefined {
  const bits: string[] = []
  if (meter.used != null && meter.limit != null) {
    bits.push(`${meter.used}/${meter.limit} ${meter.unit}`)
  } else if (meter.remaining != null) {
    bits.push(`${meter.remaining} ${meter.unit} left`)
  } else if (meter.limit != null) {
    bits.push(`limit ${meter.limit} ${meter.unit}`)
  }
  if (meter.availability === 'unlimited') bits.push('unlimited')
  if (meter.availability === 'unknown') bits.push('unknown')
  if (meter.period?.kind && meter.period.kind !== 'unknown') bits.push(meter.period.kind)
  return bits.join(' · ') || undefined
}

function quotaWindows(reading: QuotaReading): QuotaWindowView[] {
  return reading.payload.meters.map((meter) => {
    const usedPct = meterPercent(meter)
    const resetAt = meter.period?.resetAt ?? meter.period?.endsAt ?? undefined
    const detail = meterDetail(meter)
    const state: MeterState =
      meter.availability === 'unlimited' ? 'unlimited' : usedPct === undefined ? 'unknown' : 'known'
    return {
      id: meter.key,
      label: meter.label,
      state,
      ...(usedPct === undefined ? {} : { usedPct }),
      ...(resetAt == null ? {} : { resetAt }),
      ...(detail ? { detail } : {})
    }
  })
}

/** One card per selectable source. Quota comes from the newest stored reading
 *  that succeeded; a current failure is reported NEXT TO the numbers instead of
 *  replacing them (the plan's "실패와 마지막 성공값·시각을 함께 반환"). */
export function quotaCards(
  sources: DomainUsageSourceView[],
  quota: DomainQuotaCurrentView[],
  diagnostics: string[] = []
): QuotaCardView[] {
  const byConnection = new Map(quota.map((entry) => [entry.connectionId, entry]))
  return sources.map((source) => {
    const base: Omit<QuotaCardView, 'state' | 'windows'> = {
      key: source.key,
      harnessId: source.harnessId,
      serviceLabel: source.offeringLabel ?? source.providerLabel ?? source.offeringId,
      origin: source.origin,
      ...(source.connectionId ? { connectionId: source.connectionId } : {}),
      identityClaims: source.identityClaims.map((claim) => ({
        kind: claim.kind,
        value: claim.value,
        confidence: claim.confidence
      })),
      planClaims: source.planClaims.map((claim) => ({
        key: claim.key,
        label: claim.label,
        value: claim.value
      })),
      ...(source.materialRef ? { materialRef: source.materialRef } : {}),
      diagnostics: [...diagnostics]
    }
    if (source.origin === 'legacy') {
      return { ...base, state: 'legacy' as const, windows: [] }
    }
    const view = source.connectionId ? byConnection.get(source.connectionId) : undefined
    const latest = view?.latest ?? null
    const lastSuccess = view?.lastSuccess ?? null
    const failure = view?.failure ?? null
    const shown = lastSuccess ?? latest
    if (!shown) {
      return {
        ...base,
        state: failure ? ('failed' as const) : ('empty' as const),
        windows: [],
        ...(failure ? { failureMessage: failureText(failure) } : {})
      }
    }
    const account =
      shown.payload.identityClaims.find((claim) => claim.kind === 'email')?.value ??
      shown.payload.identityClaims[0]?.value
    const planClaim = shown.payload.planClaims[0]
    return {
      ...base,
      state: 'ready' as const,
      windows: quotaWindows(shown),
      observedAt: shown.observedAt,
      ...(shown.payload.providerMeasuredAt != null
        ? { providerMeasuredAt: shown.payload.providerMeasuredAt }
        : {}),
      ...(lastSuccess ? { lastSuccessAt: lastSuccess.observedAt } : {}),
      ...(account ? { accountLabel: account } : {}),
      ...(planClaim ? { planLabel: planClaim.label ?? planClaim.value } : {}),
      ...(failure && failure !== shown ? { failureMessage: failureText(failure) } : {})
    }
  })
}

function failureText(reading: QuotaReading | null): string | undefined {
  if (!reading) return undefined
  return (
    reading.payload.diagnostics[0]?.message ?? `quota collection reported ${reading.payload.status}`
  )
}

// ── stored ledger entries ──────────────────────────────────────────────────

export interface SessionUsageRowView {
  sessionId: string
  harnessId: string
  totals: UsageValues
  /** components no counted entry reported (value is null in `totals`) */
  unknownComponents: string[]
  /** components only some counted entries reported — `totals` is a lower bound */
  partialComponents: string[]
  costUsd?: number
  entryCount: number
  /** entries the store did not count, kept visible instead of dropped */
  unresolvedCount: number
  duplicateCount: number
  supersededCount: number
  attribution?: UsageAttributionStatus
  attributionBasis?: UsageAttributionBasis
  firstAt?: number
  lastAt?: number
  timeUnknownCount: number
}

function entryTime(entry: UsageEntry): { at?: number; known: boolean } {
  const time = entry.usageTime
  if (time.kind === 'point') return { at: time.at, known: true }
  if (time.kind === 'interval') return { at: time.endInclusive, known: true }
  return { known: false }
}

/** Per-session rows from the stored ledger. Each row arrives with the entry's
 *  current attribution (`usage.entry.list` returns both), and entries the store
 *  marked duplicate, unresolved or superseded are counted rather than summed:
 *  the accounting decision belongs to the daemon, and hiding it here would make
 *  a lossy total look exact. */
export function sessionUsageRows(
  items: readonly { entry: UsageEntry; attribution: UsageAttribution | null }[]
): SessionUsageRowView[] {
  const grouped = new Map<string, UsageEntry[]>()
  const attributionByEntry = new Map<string, UsageAttribution>()
  for (const item of items) {
    const entry = item.entry
    if (!entry.sessionId) continue
    const list = grouped.get(entry.sessionId) ?? []
    list.push(entry)
    grouped.set(entry.sessionId, list)
    if (item.attribution) attributionByEntry.set(entry.id, item.attribution)
  }
  return [...grouped.entries()].map(([sessionId, rows]) => {
    const counted = rows.filter((row) => row.accountingStatus === 'counted')
    const { values, unknownComponents, partialComponents } = sumValues(
      counted.map((row) => row.normalizedTokens)
    )
    const costTotal = counted.reduce(
      (sum, row) => (row.cost && row.cost.currency === 'USD' ? sum + row.cost.amount : sum),
      0
    )
    const costs = counted.some((row) => row.cost && row.cost.currency === 'USD')
    const times = counted.map(entryTime)
    const known = times.flatMap((time) => (time.at === undefined ? [] : [time.at]))
    const newest = counted.reduce<UsageEntry | null>(
      (latest, row) => (!latest || row.createdAt > latest.createdAt ? row : latest),
      null
    )
    const attribution = newest ? attributionByEntry.get(newest.id) : undefined
    return {
      sessionId,
      harnessId: counted[0]?.harnessId ?? rows[0]?.harnessId ?? '',
      totals: values,
      unknownComponents,
      partialComponents,
      ...(costs ? { costUsd: costTotal } : {}),
      entryCount: counted.length,
      unresolvedCount: rows.filter((row) => row.accountingStatus === 'unresolved').length,
      duplicateCount: rows.filter((row) => row.accountingStatus === 'duplicate').length,
      supersededCount: rows.filter((row) => row.accountingStatus === 'superseded').length,
      ...(attribution
        ? { attribution: attribution.status, attributionBasis: attribution.basis }
        : {}),
      ...(known.length ? { firstAt: Math.min(...known), lastAt: Math.max(...known) } : {}),
      timeUnknownCount: times.filter((time) => !time.known).length
    }
  })
}

// ── statistics ─────────────────────────────────────────────────────────────

export interface StatisticBucketView {
  key: string
  startUtc?: number
  endUtc?: number
  value: UsageValues
  denominator: number | null
  completeness: CollectionCompleteness
  unknownTokens: number | null
  unallocatedTimeTokens: number
}

export interface StatisticCardView {
  id: string
  metric: string
  range: { start: number; end: number }
  timeZone: string
  weekStart: 'monday' | 'sunday'
  completedPeriodsOnly: boolean
  value: UsageValues | null
  numerator: UsageValues
  denominator: number | null
  expectedPeriods: number | null
  validPeriods: number | null
  completeness: CollectionCompleteness
  unknownTokens: number | null
  unallocatedTimeTokens: number
  exclusions: { start: number; end: number; reason: string }[]
  asOf: number
  computedAt: number
  buckets: StatisticBucketView[]
}

export function statisticCards(statistics: readonly UsageStatistic[]): StatisticCardView[] {
  return statistics.map((row) => ({
    id: row.id,
    metric: row.metric,
    range: row.range,
    timeZone: row.timeZone,
    weekStart: row.calendarPolicy.weekStart,
    completedPeriodsOnly: row.calendarPolicy.completedPeriodsOnly,
    value: row.value ?? null,
    numerator: row.numerator,
    denominator: row.denominator ?? null,
    expectedPeriods: row.expectedPeriods ?? null,
    validPeriods: row.validPeriods ?? null,
    completeness: row.coverage.completeness,
    unknownTokens: row.coverage.unknownTokens,
    unallocatedTimeTokens: row.coverage.unallocatedTimeTokens,
    exclusions: row.exclusions.map((exclusion) => ({
      start: exclusion.start,
      end: exclusion.end,
      reason: exclusion.reason
    })),
    asOf: row.asOf,
    computedAt: row.computedAt,
    buckets: (row.buckets ?? []).map((bucket) => ({
      key: bucket.key,
      ...(bucket.startUtc === undefined ? {} : { startUtc: bucket.startUtc }),
      ...(bucket.endUtc === undefined ? {} : { endUtc: bucket.endUtc }),
      value: bucket.value,
      denominator: bucket.denominator ?? null,
      completeness: bucket.coverage.completeness,
      unknownTokens: bucket.coverage.unknownTokens,
      unallocatedTimeTokens: bucket.coverage.unallocatedTimeTokens
    }))
  }))
}

// ── freshness / coverage lines ─────────────────────────────────────────────

/** the i18n key for a completeness value — one mapping for every panel */
export type CoverageLabelKey =
  'statsCoverageComplete' | 'statsCoveragePartial' | 'statsCoverageUnknown'

export function coverageLabelKey(completeness: CollectionCompleteness): CoverageLabelKey {
  if (completeness === 'complete') return 'statsCoverageComplete'
  if (completeness === 'partial') return 'statsCoveragePartial'
  return 'statsCoverageUnknown'
}
