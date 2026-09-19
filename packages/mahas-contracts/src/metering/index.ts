import type { JsonObject, JsonValue } from '../common.ts'
import type { DispatchId, ExecutionId } from '../identity.ts'
import type { EpochMillis, ObservationId } from '../ids.ts'
import type {
  HarnessId,
  InferenceModelId,
  NativeModelAliasId,
  OfferingId,
  ProviderId
} from '../catalog/index.ts'
import type {
  HarnessInstallationId,
  MachineId,
  ProviderConnectionId,
  ProviderCredentialId,
  ProviderIdentityClaim
} from '../inventory/index.ts'
import type { HarnessSessionId } from '../sessions/index.ts'
import type { IntegrationCapability } from '../integration/index.ts'

export type CollectionSourceId = string
export type CollectionBatchId = string
export type CollectionCoverageId = string
export type CollectionRequestId = string
export type UsageEntryId = string
export type UsageStatisticId = string
export type UsageSummaryKey = string

/** Capabilities a bounded collection batch can serve. */
export type CollectionCapability = Extract<
  IntegrationCapability,
  'events' | 'sessions' | 'usage' | 'quota'
>

export interface MeteringEvidenceRef {
  observationId?: ObservationId
  sourceId?: CollectionSourceId
  sourceRecordKey?: string
  description?: string
  /** raw evidence the collector attached (kept verbatim, never interpreted) */
  data?: JsonObject
}

export type CollectionSubjectRef =
  | { kind: 'installation'; installationId: HarnessInstallationId }
  | { kind: 'connection'; connectionId: ProviderConnectionId }
  | { kind: 'session'; sessionId: HarnessSessionId }
  | { kind: 'machine'; machineId: MachineId }

export type CollectionSourceKind = 'file' | 'database' | 'hook-stream' | 'provider-api' | 'other'
export type CollectionSourceStatus = 'active' | 'missing' | 'unavailable' | 'retired' | 'unknown'

export interface CollectionSource {
  id: CollectionSourceId
  machineId: MachineId
  subject: CollectionSubjectRef
  locator: JsonObject
  kind: CollectionSourceKind
  sourceGeneration: string
  identityEvidence: JsonObject
  status: CollectionSourceStatus
  firstObservedAt: EpochMillis
  lastObservedAt: EpochMillis
}

/** Opaque position is interpreted only by the pinned collector revision. */
export interface CollectionCursor {
  sourceId: CollectionSourceId
  sourceGeneration: string
  collectorRevision: string
  position: JsonValue
  checkpointRevision: number
  lastCommittedAt?: EpochMillis | null
}

export interface CollectionDiagnostic {
  code: string
  severity: 'info' | 'warning' | 'error'
  message: string
  sourceRecordKey?: string
  position?: JsonValue
  details?: JsonObject
}

export type CollectionBatchResult = 'committed' | 'partial' | 'failed' | 'cancelled'

export interface CollectionBatch {
  id: CollectionBatchId
  sourceId: CollectionSourceId
  sourceGeneration: string
  adapterPackId: string
  adapterPackRevision: number
  integrationContractId: string
  contractRevision: number
  cursorBefore?: CollectionCursor | null
  cursorAfter?: CollectionCursor | null
  startedAt: EpochMillis
  committedAt?: EpochMillis | null
  result: CollectionBatchResult
  diagnostics: readonly CollectionDiagnostic[]
}

export type CollectionCompleteness = 'complete' | 'partial' | 'gap' | 'unknown'

export interface CollectionCoverage {
  id: CollectionCoverageId
  sourceId?: CollectionSourceId | null
  subject: CollectionSubjectRef
  interval?: { start: EpochMillis; end: EpochMillis } | null
  completeness: CollectionCompleteness
  gapReason?: string | null
  lastSuccessAt?: EpochMillis | null
  watermark?: string | null
}

/** `processed` means one scheduler pass ran for the request — never that the source was fully collected (coverage lives on the batch). */
export type CollectionRequestStatus = 'pending' | 'claimed' | 'processed' | 'failed' | 'cancelled'

/**
 * A durable "collect this source now" intent. A request is a queue row rather
 * than an execution: the scheduler claims it, runs one bounded Pack batch and
 * records the resulting collection batch id. Requesting collection therefore
 * never performs I/O inside the operation transaction, and a daemon restart
 * recovers by scanning pending rows.
 */
export interface CollectionRequest {
  id: CollectionRequestId
  sourceId: CollectionSourceId
  capability: CollectionCapability
  requestedBy: string
  requestedAt: EpochMillis
  notBefore?: EpochMillis | null
  maxRecords: number
  maxBytes: number
  reason?: string | null
  status: CollectionRequestStatus
  claimedBy?: string | null
  claimedAt?: EpochMillis | null
  claimExpiresAt?: EpochMillis | null
  attempts: number
  batchId?: CollectionBatchId | null
  /** settled at this time; what the pass achieved is on batchId and diagnostics */
  processedAt?: EpochMillis | null
  diagnostics: readonly CollectionDiagnostic[]
}

/** Common fact envelope: typed records below share this Observation identity. */
export interface MeteringReading<TPayload, TSchema extends string> {
  observationId: ObservationId
  batchId: CollectionBatchId
  sourceRecordKey: string
  sourceRecordRevision?: string | null
  observedAt: EpochMillis
  occurredAt?: EpochMillis | null
  payloadSchema: TSchema
  payload: TPayload
  evidence: readonly MeteringEvidenceRef[]
}

export type UsageMeasurementMode = 'delta' | 'cumulative'
export type UsageAxisResolution = 'per-record' | 'per-counter' | 'unavailable'

export interface UsageCapabilityResolution {
  provider: UsageAxisResolution
  offering: UsageAxisResolution
  connection: UsageAxisResolution
  requestedModel: UsageAxisResolution
  servedModel: UsageAxisResolution
}

export interface UsageValues {
  inputTotal: number | null
  outputTotal: number | null
  total: number | null
  cacheReadInput: number | null
  cacheWriteInput: number | null
  reasoningOutput: number | null
}

export type UsageComponent = keyof UsageValues

/** Explicit containment prevents cache/reasoning details being summed twice. */
export interface UsageSemantics {
  unit: 'tokens'
  componentRelations: readonly {
    component: UsageComponent
    relation: 'includes' | 'excludes' | 'overlaps' | 'unknown'
    other: UsageComponent
  }[]
  reportedTotal?: number | null
  calculatedTotal?: number | null
  totalMismatch?: boolean
  completeness: 'complete' | 'partial' | 'unknown'
  nativeFields: JsonObject
}

export type UsageTime =
  | {
      kind: 'point'
      at: EpochMillis
      basis: string
      nativeTimestamp?: string | null
      nativeUtcOffsetMinutes?: number | null
      precision?: string | null
    }
  | {
      kind: 'interval'
      startExclusive: EpochMillis
      endInclusive: EpochMillis
      basis: string
      precision?: string | null
    }
  | { kind: 'unknown'; reason: string }

export interface UsageReadingPayload {
  sessionId?: HarnessSessionId | null
  measurementKey: string
  mode: UsageMeasurementMode
  counterScope?: string | null
  counterEpoch?: string | null
  values: UsageValues
  semantics: UsageSemantics
  timeCoverage: UsageTime
  sourceEvidence: JsonObject
}

export type UsageReading = MeteringReading<UsageReadingPayload, 'mahas.usage-reading/v1'>

export interface UsageCost {
  amount: number
  currency: string
  basis: 'reported' | 'estimated'
  pricingRevision?: string | null
}

export type UsageAccountingStatus = 'counted' | 'duplicate' | 'unresolved' | 'superseded'

/**
 * How a cumulative counter's epoch relates to the counter's previous epoch.
 * 'first' asserts no previous epoch existed, 'disjoint' is a declared reset and
 * must carry evidence, 'unknown' is the honest default when a collector cannot
 * prove either. A value drop alone is never any of these.
 */
export type UsageCounterEpochRelation = 'first' | 'disjoint' | 'unknown'

export interface UsageCounterEpoch {
  scope: string
  epoch: string
  relation: UsageCounterEpochRelation
  evidence: readonly MeteringEvidenceRef[]
}

export interface UsageCoverageRef {
  coverageId: CollectionCoverageId
  scope: 'request' | 'session' | 'counter' | 'other'
  scopeKey: string
  relation: 'direct' | 'includes' | 'included-by' | 'overlaps' | 'unknown'
}

export interface UsageEntry {
  id: UsageEntryId
  revision: number
  sessionId?: HarnessSessionId | null
  harnessId: HarnessId
  installationId?: HarnessInstallationId | null
  originMachineId?: MachineId | null
  accountingKey: string
  coverage: readonly UsageCoverageRef[]
  readingIds: readonly ObservationId[]
  usageTime: UsageTime
  normalizedTokens: UsageValues
  cost?: UsageCost | null
  accountingStatus: UsageAccountingStatus
  /** Collecting stream role; a corroborating or unresolved stream is never a second total. */
  streamRole?: 'primary' | 'corroborating' | 'unresolved' | null
  supersedesEntryId?: UsageEntryId | null
  /** Present for cumulative readings; the durable record of the epoch claim. */
  counterEpoch?: UsageCounterEpoch | null
  createdAt: EpochMillis
}

/** A ledger entry with its current attribution revision, if any. */
export interface UsageEntryWithAttribution {
  entry: UsageEntry
  attribution: UsageAttribution | null
}

export interface UsageLedgerChange {
  sequence: number
  entryId: UsageEntryId
  entryRevision: number
  kind: 'entry' | 'attribution'
  changedAt: EpochMillis
}

/** Page of the stable, gap-free ledger scan used by aggregate rebuilds. */
export interface UsageLedgerScanResult {
  items: readonly UsageEntryWithAttribution[]
  watermark: { ledger: string; attribution: string }
  nextCursor?: string
}

export interface UsageModelRef {
  nativeName: string
  namespace: string
  modelId?: InferenceModelId | null
  aliasId?: NativeModelAliasId | null
  mappingEvidence?: readonly MeteringEvidenceRef[]
}

export type UsageAttributionBasis = 'reported' | 'configured-at-time' | 'correlated' | 'manual'
export type UsageAttributionStatus = 'verified' | 'observed' | 'inferred' | 'unknown' | 'superseded'

export interface UsageAttribution {
  entryId: UsageEntryId
  revision: number
  /** When connection is known, provider/offering are derived through it. */
  connectionId?: ProviderConnectionId | null
  offeringId?: OfferingId | null
  providerId?: ProviderId | null
  credentialId?: ProviderCredentialId | null
  requestedModel?: UsageModelRef | null
  servedModel?: UsageModelRef | null
  executionId?: ExecutionId | null
  dispatchId?: DispatchId | null
  basis: UsageAttributionBasis
  evidence: readonly MeteringEvidenceRef[]
  status: UsageAttributionStatus
  validFromRevision: number
}

/**
 * Rollup axes of a stored summary or statistic row.
 *
 * A key that is PRESENT means the row is grouped by that axis; a 'null' value
 * is the group for entries whose axis value is unknown (unattributed), and an
 * absent key means the rollup is not grouped by that axis at all. 'null'
 * therefore never collapses into "axis not present": a row keyed by
 * (machineId, providerId=null) is the per-machine unattributed-provider
 * bucket, not a machine rollup, and selecting a rollup shape is an exact
 * match on the SET of present keys — never on which values are non-null.
 *
 * Model axes keep their NATIVE identity (UsageModelRef): a native name with
 * no catalog resolution is still a distinct group and is never rewritten to
 * some other InferenceModelId. 'verifiedPool' is a scope derived from a
 * verified provider pool claim — never from a shared credential or a matching
 * email — and marks the rows a pool-share read partitions.
 */
export interface UsageDimensions {
  machineId?: MachineId | null
  harnessId?: HarnessId | null
  sessionId?: HarnessSessionId | null
  providerId?: ProviderId | null
  offeringId?: OfferingId | null
  connectionId?: ProviderConnectionId | null
  requestedModel?: UsageModelRef | null
  servedModel?: UsageModelRef | null
  verifiedPool?: UsageVerifiedPoolRef | null
  organizationId?: string | null
  organizationRelation?: 'harness-publisher' | 'model-publisher' | 'provider-operator' | null
}

/** A provider-reported shared usage pool, evidenced by a verified pool claim. */
export interface UsageVerifiedPoolRef {
  providerPoolKey: string
  scope: string
}

export interface UsageTimeBucket {
  grain: 'hour' | 'day' | 'week' | 'all-time'
  startUtc?: EpochMillis | null
  endUtc?: EpochMillis | null
  timeZone: string
  weekStart?: 'monday' | 'sunday' | null
}

export interface UsageCoverageSummary {
  completeness: CollectionCompleteness
  knownTokens: number
  unknownTokens: number | null
  unallocatedTimeTokens: number
  coverageIds: readonly CollectionCoverageId[]
}

export interface UsageAttributionCoverage {
  attributedTokens: number
  unattributedTokens: number
  status: 'complete' | 'partial' | 'unknown'
}

export interface UsageSummary {
  key: UsageSummaryKey
  dimensions: UsageDimensions
  timeBucket?: UsageTimeBucket | null
  totals: UsageValues
  coverage: UsageCoverageSummary
  attributionCoverage: UsageAttributionCoverage
  definitionRevision: number
  ledgerWatermark: string
  attributionWatermark: string
  aggregateGeneration: string
  pending: boolean
  computedAt: EpochMillis
}

export type UsageStatisticMetric =
  | 'weekly-average'
  | 'daily-average-within-week'
  | 'hourly-by-date'
  | 'hour-of-day-distribution'
  | 'hour-of-day-average'

export interface StatisticExclusion {
  start: EpochMillis
  end: EpochMillis
  reason: string
}

export interface UsageStatisticBucket {
  key: string
  startUtc?: EpochMillis
  endUtc?: EpochMillis
  value: UsageValues
  denominator?: number | null
  coverage: UsageCoverageSummary
}

export interface UsageStatistic {
  id: UsageStatisticId
  definitionRevision: number
  metric: UsageStatisticMetric
  dimensions: UsageDimensions
  range: { start: EpochMillis; end: EpochMillis }
  timeZone: string
  calendarPolicy: { weekStart: 'monday' | 'sunday'; completedPeriodsOnly: boolean }
  value?: UsageValues | null
  buckets?: readonly UsageStatisticBucket[]
  numerator: UsageValues
  denominator?: number | null
  expectedPeriods?: number | null
  validPeriods?: number | null
  exclusions: readonly StatisticExclusion[]
  coverage: UsageCoverageSummary
  sourceWatermarks: readonly string[]
  asOf: EpochMillis
  computedAt: EpochMillis
}

export type QuotaAvailability = 'known' | 'unknown' | 'unlimited'

export interface QuotaPeriod {
  kind: 'rolling' | 'calendar' | 'lifetime' | 'instant' | 'unknown'
  startsAt?: EpochMillis | null
  endsAt?: EpochMillis | null
  resetAt?: EpochMillis | null
}

export interface QuotaMeter {
  key: string
  label: string
  resource: string
  scope: string
  sharedPoolKey?: string | null
  unit: 'tokens' | 'requests' | 'currency' | 'credits' | 'ratio' | (string & {})
  used?: number | null
  limit?: number | null
  remaining?: number | null
  utilization?: number | null
  period?: QuotaPeriod | null
  availability: QuotaAvailability
}

export interface QuotaEntitlement {
  key: string
  scope: string
  value: JsonValue
  validFrom?: EpochMillis | null
  validUntil?: EpochMillis | null
  evidence: readonly MeteringEvidenceRef[]
}

export interface QuotaPlanClaim {
  key: string
  label?: string | null
  value: string
  observedAt: EpochMillis
  evidence: readonly MeteringEvidenceRef[]
}

export interface QuotaReadingPayload {
  connectionId: ProviderConnectionId
  observedAt: EpochMillis
  providerMeasuredAt?: EpochMillis | null
  identityClaims: readonly ProviderIdentityClaim[]
  planClaims: readonly QuotaPlanClaim[]
  meters: readonly QuotaMeter[]
  entitlements: readonly QuotaEntitlement[]
  status: 'success' | 'partial' | 'failure'
  diagnostics: readonly CollectionDiagnostic[]
  sourceEvidence: JsonObject
}

export type QuotaReading = MeteringReading<QuotaReadingPayload, 'mahas.quota-reading/v1'>

export interface MeteringQueryEnvelope<T> {
  items: readonly T[]
  coverage: readonly CollectionCoverage[]
  freshness: { asOf: EpochMillis; lastSuccessfulCollectionAt?: EpochMillis | null }
  watermark: { ledger?: string; attribution?: string; aggregate?: string }
  unidentified: readonly { axis: string; amount?: number | null; reason: string }[]
  nextCursor?: string
}

/** Query DTOs returned by the collection operations. */
export type CollectionSourceQueryResult = MeteringQueryEnvelope<CollectionSource>
export type CollectionBatchQueryResult = MeteringQueryEnvelope<CollectionBatch>
export type CollectionCoverageQueryResult = MeteringQueryEnvelope<CollectionCoverage>
export type CollectionRequestQueryResult = MeteringQueryEnvelope<CollectionRequest>

/** Per-source collection status: what is known now, and what still has to run. */
export interface CollectionStatusResult {
  source: CollectionSource
  cursor: CollectionCursor | null
  latestBatch: CollectionBatch | null
  batches: readonly CollectionBatch[]
  coverage: readonly CollectionCoverage[]
  requests: readonly CollectionRequest[]
  pendingRequestCount: number
  freshness: { asOf: EpochMillis; lastSuccessfulCollectionAt?: EpochMillis | null }
  unidentified: readonly { axis: string; amount?: number | null; reason: string }[]
}

/** Query DTOs returned by the usage ledger operations. */
export type UsageEntryQueryResult = MeteringQueryEnvelope<UsageEntryWithAttribution>

export interface UsageAttributionQueryResult {
  entry: UsageEntry
  attribution: UsageAttribution | null
}
