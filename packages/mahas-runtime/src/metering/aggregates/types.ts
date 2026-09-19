import type { TimeBucket, TimeGrain } from './time.ts'

export interface TokenTotals {
  inputTotal: number | null
  outputTotal: number | null
  total: number | null
  cacheReadInput: number | null
  cacheWriteInput: number | null
  reasoningOutput: number | null
}

export interface ModelDimension {
  namespace: string
  nativeName: string
  modelId?: string
}

export interface UsageDimensions {
  sessionId?: string
  machineId?: string
  harnessId?: string
  providerId?: string | null
  offeringId?: string | null
  connectionId?: string | null
  requestedModel?: ModelDimension | null
  servedModel?: ModelDimension | null
  /** Set only from a verified provider pool claim; never derived from a shared credential. */
  verifiedPool?: { providerPoolKey: string; scope: string } | null
}

export type UsageTimeProjection =
  | { kind: 'point'; at: number; basis: string }
  | { kind: 'interval'; startExclusive: number; endInclusive: number; precision?: string }
  | { kind: 'unknown' }

/** Stable projection supplied by the ledger boundary. */
export interface AggregateEntryProjection {
  id: string
  revision: number
  accountingStatus: 'counted' | 'duplicate' | 'unresolved' | 'superseded'
  totals: TokenTotals
  dimensions: UsageDimensions
  usageTime: UsageTimeProjection
  attributionRevision: number
  attributionStatus: 'verified' | 'observed' | 'inferred' | 'unknown'
}

/**
 * One durable reader position. Every feed has its own coordinate so a change on
 * one feed can never advance (and therefore hide) another; the aggregate reader
 * persists the whole cursor with its summaries.
 *
 * - `ledger`/`attribution` are `usage_ledger_changes.sequence` positions. The
 *   ledger currently exposes one ordered feed so both advance together; they
 *   stay separate because freshness and statistics report them separately and a
 *   future split must not make the two sparsely replay each other.
 * - `poolClaim` is an opaque equality token (digest) over the verified provider
 *   pool-claim evidence. Claims are corrected in place (a `revision` bump on the
 *   same row), so insertion order cannot express their state.
 */
export interface AggregateCursor {
  ledger: number
  attribution: number
  poolClaim: string
  /** Resume point inside the affected-entry sequence of a pool-claim pass whose
   * affected set did not fit in one bounded batch. Absent/empty means the
   * digest above is fully consumed. */
  poolClaimResume?: { connectionId: string; entryId: string } | null
}

export interface AggregateChange {
  /** Set for ledger-feed changes; this sequence owns the `usage_aggregate_intents` row. */
  ledgerSequence: number | null
  /** `poolClaim` means: re-derive every entry attributed to `connectionId`. */
  kind: 'entry' | 'attribution' | 'poolClaim'
  entryId: string
  connectionId?: string | null
}

export interface AggregateChangeBatch {
  changes: readonly AggregateChange[]
  /** Position consumed by this batch — persist this, never a derived maximum. */
  cursor: AggregateCursor
  /** True when the source still holds changes beyond `cursor`. */
  pending: boolean
}

export interface AggregateChangeSource {
  readChanges(after: AggregateCursor, limit: number): AggregateChangeBatch
  readEntryProjection(entryId: string): AggregateEntryProjection | null
  /** Current position of every feed: freshness probe and rebuild snapshot. */
  highWatermarks(): AggregateCursor
  /** Only claims proven by provider evidence are returned here. */
  verifiedPoolForConnection?(
    connectionId: string,
    at: number | null
  ): { providerPoolKey: string; scope: string } | null
  /** Stable keyset scan of the latest counted ledger revision that already
   * existed at `snapshot`. The snapshot keeps a rebuild a bounded snapshot:
   * changes committed after it are applied by the catch-up feed, so a page
   * never chases a moving target. */
  scanCountedEntries?(
    afterId: string | null,
    limit: number,
    snapshot: AggregateCursor
  ): AggregateEntryProjection[]
}

/** Per-component known/unknown accounting behind one summary row. */
export interface TokenCoverage {
  /** Counted contributions with a known value; `entryCount - known` is unknown. */
  knownEntriesByComponent: Record<keyof TokenTotals, number>
  /** Contributions whose token amount is unknown, so the numeric
   * `unallocatedTokens`/`unknownAttributionTokens` are lower bounds only. */
  unquantifiedUnallocatedEntries: number
  unquantifiedUnattributedEntries: number
}

export interface UsageSummaryCoverage extends TokenCoverage {
  temporal: 'allocated' | 'partially-unallocated' | 'unallocated'
  /** Every counted entry contributed a known value for every component. */
  completeTotals: boolean
}

export interface UsageSummaryAttributionCoverage {
  status: 'complete' | 'partial' | 'unknown'
  /** Lower bound; see `coverage.unquantifiedUnattributedEntries`. */
  unknownTokens: number
}

export interface UsageSummary {
  key: string
  generation: number
  revision: number
  definitionRevision: number
  dimensions: UsageDimensions
  timeBucket: TimeBucket
  totals: TokenTotals
  entryCount: number
  unallocatedTokens: number
  unknownAttributionTokens: number
  coverage: UsageSummaryCoverage
  attributionCoverage: UsageSummaryAttributionCoverage
  ledgerWatermark: number
  attributionWatermark: number
  poolClaimWatermark: string
  computedAt: number
}

export interface VerifiedPoolShare {
  verifiedPool: { providerPoolKey: string; scope: string }
  dimensions: UsageDimensions
  /** Bucket the numerator and denominator were read from. */
  timeBucket: TimeBucket
  numerator: number | null
  denominator: number | null
  share: number | null
  denominatorCoverage: 'complete' | 'partial' | 'unknown'
  unknownDenominatorEntries: number
}

export interface SummaryFilter extends Partial<
  Omit<UsageDimensions, 'requestedModel' | 'servedModel' | 'verifiedPool'>
> {
  requestedModel?: ModelDimension | null
  servedModel?: ModelDimension | null
  verifiedPool?: { providerPoolKey: string; scope: string } | null
  grain?: TimeGrain
  startUtc?: number
  endUtc?: number
}

export interface SummaryPage {
  summaries: UsageSummary[]
  /** Keyset cursor over (bucketStart, summaryKey); null when the page is last. */
  nextCursor: string | null
  /** The walk reached the end of the published generation. */
  exhausted: boolean
}

export interface AggregateFreshness {
  ledgerWatermark: number
  attributionWatermark: number
  poolClaimWatermark: string
  /** The source holds changes the published generation has not consumed yet. */
  pending: boolean
  computedAt: number | null
}

export interface SummaryQueryResult {
  page: SummaryPage
  generation: number | null
  freshness: AggregateFreshness
}

export interface SummaryQueryOptions {
  /** Bounded page size; paging never rereads the ledger. */
  limit?: number
  cursor?: string | null
  /** Exact rollup shape: keep only rows whose dimension SET is exactly these
   *  axis names ('[]' selects the {} grand-total row). A present key is a
   *  grouping axis even when its value is null, so this is a match on the key
   *  set, never on which values are non-null — the same contract the
   *  published UsageDimensions documents. */
  dimensionKeys?: string[]
  /** Compare against a source position; omitted means no freshness probe. */
  source?: Pick<AggregateChangeSource, 'highWatermarks'>
}
