// Exact-shape selection over the stored aggregate rows.
//
// The daemon persists one summary row per (dimension SET, time bucket). A key
// that is PRESENT in 'dimensions' is an axis the row is grouped by — including
// axes whose value is null (the unattributed group). Two different rollups can
// therefore share every non-null value and still be different shapes, so every
// selection here is an exact match on the SET of present keys:
//
//   {}                                        every counted entry (the only
//                                             row a grand total may come from)
//   {sessionId}                               one stored session
//   {machineId?, harnessId}                   one harness (machine partition)
//   {machineId?, providerId}                  one provider, or the
//                                             unattributed bucket (null)
//   {machineId?, harnessId, offeringId}       one offering on one harness
//   {machineId?, harnessId, offeringId,
//    connectionId}                            one connection on one harness
//   {requestedModel} / {servedModel}          one native model identity
//   {machineId?, harnessId, requestedModel}   per-harness model
//   {machineId?, harnessId, servedModel}
//   {verifiedPool}                            one verified pool (denominator)
//   {machineId?, harnessId, verifiedPool}     pool share numerator
//
// This module is deliberately free of renderer imports so the selection rules
// can be exercised directly by 'rollup.smoke.ts' under Node.
import type {
  CollectionCompleteness,
  UsageAttributionCoverage,
  UsageCoverageSummary,
  UsageModelRef,
  UsageSummary,
  UsageValues,
  UsageVerifiedPoolRef
} from '../../../../../packages/mahas-contracts/src/index.ts'

export const emptyValues = (): UsageValues => ({
  inputTotal: null,
  outputTotal: null,
  total: null,
  cacheReadInput: null,
  cacheWriteInput: null,
  reasoningOutput: null
})

/** Total for a headline: the stored 'total' is authoritative; a synthesized
 *  total is a LOWER BOUND produced only when both input and output are known
 *  (containment relations live on the reading, not on these rows). */
export const displayTotal = (values: UsageValues): number | null => {
  if (values.total !== null) return values.total
  if (values.inputTotal === null || values.outputTotal === null) return null
  return values.inputTotal + values.outputTotal
}

/** Presentation sum over PERSISTED rows (never a rescan). 'unknownComponents'
 *  no input reported at all (result null); 'partialComponents' some did and
 *  some did not (result is a lower bound — print it with a marker). */
export function sumValues(items: readonly UsageValues[]): {
  values: UsageValues
  unknownComponents: string[]
  partialComponents: string[]
} {
  const out: Record<string, number | null> = {}
  const unknown: string[] = []
  const partial: string[] = []
  for (const key of Object.keys(emptyValues()) as (keyof UsageValues)[]) {
    let known = 0
    let missing = 0
    let total = 0
    for (const item of items) {
      const value = item[key]
      if (value === null) {
        missing += 1
        continue
      }
      known += 1
      total += value
    }
    out[key] = known > 0 ? total : null
    if (known === 0 && items.length > 0) unknown.push(key)
    else if (missing > 0) partial.push(key)
  }
  return {
    values: out as unknown as UsageValues,
    unknownComponents: unknown,
    partialComponents: partial
  }
}

// ── shapes ─────────────────────────────────────────────────────────────────

/** axes the row is grouped by — the PRESENT keys, sorted. A null value is
 *  still a grouping axis (the unattributed group), so presence — not a
 *  non-null value — decides the shape. */
export function dimensionAxes(row: UsageSummary): string[] {
  return Object.keys(row.dimensions)
    .filter((key) => row.dimensions[key as keyof UsageSummary['dimensions']] !== undefined)
    .sort()
}

/** rows whose dimension set is EXACTLY 'axes' — the shape-specific rollup */
export function exactShape(summaries: readonly UsageSummary[], axes: string[]): UsageSummary[] {
  const wanted = [...axes].sort().join(',')
  return summaries.filter((row) => dimensionAxes(row).join(',') === wanted)
}

/** The only row that totals every counted entry. Anything else is a partition
 *  of one axis family, and different families overlap — a headline total read
 *  from anywhere else would either miss entries or double-count them. */
export function globalSummary(summaries: readonly UsageSummary[]): UsageSummary | undefined {
  return summaries.find((row) => dimensionAxes(row).length === 0)
}

/** The stored rollup shapes each axis family may take, as dimensionSets()
 *  persists them. A row that does not match its family's shapes exactly is a
 *  DIFFERENT question (a finer rollup) and is never folded in — that is what
 *  keeps a connection row from being counted inside an offering total. */
const AXIS_SHAPES = {
  harnessId: ['harnessId', 'harnessId,machineId'],
  providerId: ['providerId', 'machineId,providerId'],
  offeringId: ['harnessId,offeringId', 'harnessId,machineId,offeringId'],
  connectionId: [
    'connectionId,harnessId,offeringId',
    'connectionId,harnessId,machineId,offeringId'
  ],
  requestedModel: ['requestedModel'],
  servedModel: ['servedModel'],
  verifiedPool: ['verifiedPool'],
  poolHarness: ['harnessId,verifiedPool', 'harnessId,machineId,verifiedPool']
} as const

function rowsOfShapes(
  summaries: readonly UsageSummary[],
  shapes: readonly string[]
): UsageSummary[] {
  const wanted = new Set(shapes)
  return summaries.filter((row) => wanted.has(dimensionAxes(row).join(',')))
}

// ── combined coverage over non-overlapping partitions ──────────────────────

const worstCompleteness = (values: readonly CollectionCompleteness[]): CollectionCompleteness =>
  values.includes('unknown')
    ? 'unknown'
    : values.includes('gap')
      ? 'gap'
      : values.includes('partial')
        ? 'partial'
        : 'complete'

/** Sum coverage of DISJOINT partitions (e.g. the same harness on two
 *  machines). unknownTokens stays null when any partition cannot quantify its
 *  unknown amount. */
export function sumCoverage(rows: readonly UsageSummary[]): UsageCoverageSummary {
  const unknownQuantified = rows.every((row) => row.coverage.unknownTokens !== null)
  return {
    completeness: worstCompleteness(rows.map((row) => row.coverage.completeness)),
    knownTokens: rows.reduce((total, row) => total + row.coverage.knownTokens, 0),
    unknownTokens: unknownQuantified
      ? rows.reduce((total, row) => total + (row.coverage.unknownTokens ?? 0), 0)
      : null,
    unallocatedTimeTokens: rows.reduce(
      (total, row) => total + row.coverage.unallocatedTimeTokens,
      0
    ),
    coverageIds: [...new Set(rows.flatMap((row) => row.coverage.coverageIds))]
  }
}

export function sumAttribution(rows: readonly UsageSummary[]): UsageAttributionCoverage {
  const worst = worstCompleteness(rows.map((row) => row.attributionCoverage.status))
  return {
    attributedTokens: rows.reduce(
      (total, row) => total + row.attributionCoverage.attributedTokens,
      0
    ),
    unattributedTokens: rows.reduce(
      (total, row) => total + row.attributionCoverage.unattributedTokens,
      0
    ),
    // attribution status has no 'gap' value; a coverage gap reads as partial
    status: worst === 'gap' ? 'partial' : worst
  }
}

// ── grouped totals ─────────────────────────────────────────────────────────

export interface GroupedTotalsView {
  /** grouping identity: the axis value as stored (null = unattributed group) */
  id: string | null
  totals: UsageValues
  unknownComponents: string[]
  partialComponents: string[]
  coverage: UsageCoverageSummary
  attribution: UsageAttributionCoverage
  pending: boolean
  computedAt: number
  /** stored rows summed into this view (>1 = machine partitions of one id) */
  partitions: number
}

function groupTotals(
  rows: readonly UsageSummary[],
  idOf: (row: UsageSummary) => string | null
): GroupedTotalsView[] {
  const groups = new Map<string, { id: string | null; rows: UsageSummary[] }>()
  for (const row of rows) {
    const id = idOf(row)
    const key = id === null ? '' : id
    const found = groups.get(key) ?? { id, rows: [] }
    found.rows.push(row)
    groups.set(key, found)
  }
  return [...groups.values()].map((group) => {
    const summed = sumValues(group.rows.map((row) => row.totals))
    return {
      id: group.id,
      totals: summed.values,
      unknownComponents: summed.unknownComponents,
      partialComponents: summed.partialComponents,
      coverage: sumCoverage(group.rows),
      attribution: sumAttribution(group.rows),
      pending: group.rows.some((row) => row.pending),
      computedAt: Math.max(...group.rows.map((row) => row.computedAt)),
      partitions: group.rows.length
    }
  })
}

const idAxis =
  (axis: 'harnessId' | 'providerId' | 'offeringId' | 'connectionId') =>
  (row: UsageSummary): string | null => {
    const value = row.dimensions[axis]
    return typeof value === 'string' ? value : null
  }

export type HarnessTotalsView = GroupedTotalsView & { id: string }

/** per-harness totals from the harness rollup rows. Rows whose axes are
 *  exactly {harnessId} or {machineId, harnessId} — nothing else answers this
 *  question. Machine partitions of one harness are disjoint, so they are
 *  summed; a row with a null harnessId is not a harness and is dropped. */
export function harnessTotals(summaries: readonly UsageSummary[]): HarnessTotalsView[] {
  return groupTotals(rowsOfShapes(summaries, AXIS_SHAPES.harnessId), idAxis('harnessId')).flatMap(
    (view): HarnessTotalsView[] => (view.id === null ? [] : [{ ...view, id: view.id }])
  )
}

/** per-provider totals; the null id is the unattributed bucket, kept as its
 *  own group instead of being dropped or merged into a provider. */
export function providerTotals(summaries: readonly UsageSummary[]): GroupedTotalsView[] {
  return groupTotals(rowsOfShapes(summaries, AXIS_SHAPES.providerId), idAxis('providerId'))
}

/** per-offering totals (stored per harness; partitions summed per offering). */
export function offeringTotals(summaries: readonly UsageSummary[]): GroupedTotalsView[] {
  return groupTotals(rowsOfShapes(summaries, AXIS_SHAPES.offeringId), idAxis('offeringId'))
}

/** per-connection totals. */
export function connectionTotals(summaries: readonly UsageSummary[]): GroupedTotalsView[] {
  return groupTotals(rowsOfShapes(summaries, AXIS_SHAPES.connectionId), idAxis('connectionId'))
}

// ── models ─────────────────────────────────────────────────────────────────

export interface ModelTotalsView extends GroupedTotalsView {
  /** native identity — always present for a reported model */
  ref: UsageModelRef | null
}

const modelKey = (ref: UsageModelRef | null | undefined): string =>
  ref ? ref.namespace + '/' + ref.nativeName : ''

function modelTotals(
  summaries: readonly UsageSummary[],
  axis: 'requestedModel' | 'servedModel'
): ModelTotalsView[] {
  const rows = rowsOfShapes(summaries, AXIS_SHAPES[axis])
  const groups = new Map<string, { ref: UsageModelRef | null; rows: UsageSummary[] }>()
  for (const row of rows) {
    const ref = row.dimensions[axis] ?? null
    const key = modelKey(ref)
    const found = groups.get(key) ?? { ref, rows: [] }
    found.rows.push(row)
    groups.set(key, found)
  }
  return [...groups.values()].map((group) => {
    const summed = sumValues(group.rows.map((row) => row.totals))
    return {
      id: group.ref ? modelKey(group.ref) : null,
      ref: group.ref,
      totals: summed.values,
      unknownComponents: summed.unknownComponents,
      partialComponents: summed.partialComponents,
      coverage: sumCoverage(group.rows),
      attribution: sumAttribution(group.rows),
      pending: group.rows.some((row) => row.pending),
      computedAt: Math.max(...group.rows.map((row) => row.computedAt)),
      partitions: group.rows.length
    }
  })
}

/** Requested and served model breakdowns: two DIFFERENT rollups over the same
 *  entries, returned side by side and never summed together. */
export function modelBreakdown(summaries: readonly UsageSummary[]): {
  requested: ModelTotalsView[]
  served: ModelTotalsView[]
} {
  return {
    requested: modelTotals(summaries, 'requestedModel'),
    served: modelTotals(summaries, 'servedModel')
  }
}

// ── verified pool shares ───────────────────────────────────────────────────

export interface PoolShareView {
  pool: UsageVerifiedPoolRef
  /** observed pool total (the {verifiedPool} row) */
  denominator: number | null
  denominatorCoverage: 'complete' | 'partial' | 'unknown'
  /** per-harness observed shares; share is null when either side is unknown */
  shares: { harnessId: string; numerator: number | null; share: number | null }[]
  pending: boolean
  computedAt: number
}

// a ':' join would collide ('a:b','c') with ('a','b:c'); the pair is the key
const poolKey = (pool: UsageVerifiedPoolRef): string =>
  JSON.stringify([pool.scope, pool.providerPoolKey])

/** Observed token shares of verified provider pools, derived from the same
 *  stored rows 'metering.pool.share' reads: the {verifiedPool} row is the
 *  denominator and {machineId?, harnessId, verifiedPool} rows are the
 *  per-harness numerators. Entries outside every verified pool are not a
 *  share — the caller reports them as the unattributed remainder. */
export function poolShares(summaries: readonly UsageSummary[]): PoolShareView[] {
  const denominators = rowsOfShapes(summaries, AXIS_SHAPES.verifiedPool)
  const numerators = rowsOfShapes(summaries, AXIS_SHAPES.poolHarness)
  const pools = new Map<
    string,
    { pool: UsageVerifiedPoolRef; denominator: UsageSummary | null; numerators: UsageSummary[] }
  >()
  for (const row of denominators) {
    const pool = row.dimensions.verifiedPool
    if (!pool) continue
    const found = pools.get(poolKey(pool)) ?? { pool, denominator: null, numerators: [] }
    found.denominator = row
    pools.set(poolKey(pool), found)
  }
  for (const row of numerators) {
    const pool = row.dimensions.verifiedPool
    if (!pool) continue
    const found = pools.get(poolKey(pool)) ?? { pool, denominator: null, numerators: [] }
    found.numerators.push(row)
    pools.set(poolKey(pool), found)
  }
  const out: PoolShareView[] = []
  for (const group of pools.values()) {
    const denominator = group.denominator ? displayTotal(group.denominator.totals) : null
    const byHarness = groupTotals(group.numerators, idAxis('harnessId'))
    const rows = [group.denominator, ...group.numerators].filter(
      (row): row is UsageSummary => row !== null
    )
    out.push({
      pool: group.pool,
      denominator,
      denominatorCoverage: !group.denominator
        ? 'unknown'
        : group.denominator.coverage.completeness === 'complete'
          ? 'complete'
          : group.denominator.coverage.completeness === 'unknown'
            ? 'unknown'
            : 'partial',
      shares: byHarness.flatMap((view) => {
        if (view.id === null) return []
        const numerator = displayTotal(view.totals)
        return [
          {
            harnessId: view.id,
            numerator,
            share:
              numerator !== null && denominator !== null && denominator > 0
                ? numerator / denominator
                : null
          }
        ]
      }),
      pending: rows.some((row) => row.pending),
      computedAt: Math.max(0, ...rows.map((row) => row.computedAt))
    })
  }
  return out
}
