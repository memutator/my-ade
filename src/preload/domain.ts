// Desktop wire DTOs for canonical domain reads (catalog / inventory / metering
// / sessions / usage / collection) and domain actions (provider sign-in).
// These are the only shapes `window.mahas.domain.*` transports.
//
// Where the daemon already publishes a shared contract DTO, the wire type IS
// that DTO (`UsageEntryQueryResult`, `SessionQueryResult`) plus the transport
// state the daemon does not own (`readiness`). Where the daemon still returns a
// runtime projection whose public DTO is pending (usage summaries and
// statistics), the fields are spelled out here so the mapping in
// `src/main/runtime/domainIpc.ts` stays visible instead of hidden behind a cast.
//
// Two rules shape every read:
//
//   1. A read is a STORED projection. Nothing in this seam scans a source file,
//      parses a harness log, probes a provider or calls a provider API.
//   2. Missing data stays missing. `null` is "unknown", never zero, and a
//      partial read says which parts it could not cover.

import type {
  CollectionCoverage,
  CollectionRequest,
  ProviderIdentityClaim,
  QuotaReading,
  SessionQueryResult,
  SessionDetailResult,
  UsageEntryQueryResult,
  UsageStatistic,
  UsageSummary,
  UsageValues
} from '../../packages/mahas-contracts/src/index.ts'

/** Freshness/watermark envelope shared by the domain reads. Watermarks identify
 *  a read position; they are not versions to compare lexically. */
export interface DomainFreshness {
  /** when the desktop assembled this answer */
  asOf: number
  /** newest successful collection the answer can be based on */
  lastSuccessfulCollectionAt?: number | null
  ledgerWatermark?: number | null
  attributionWatermark?: number | null
  aggregateWatermark?: number | null
  /** stored rows exist that a pending aggregate/statistic refresh has not
   *  incorporated yet */
  pending?: boolean
}

/** A quantity the store could not attribute to one axis. Reported alongside
 *  totals, never folded into them. */
export interface DomainUnidentified {
  axis: string
  amount?: number | null
  reason: string
}

export interface DomainReadiness {
  /** 'ready' = every requested sub-read answered; 'partial' = some sub-read
   *  failed or some rows could not be mapped (diagnostics say which);
   *  'unavailable' = no stored answer at all */
  state: 'ready' | 'partial' | 'unavailable'
  diagnostics: string[]
}

// ── usage sources (inventory connections + desktop legacy registrations) ────

/** A desktop record the user registered before the inventory domain existed
 *  (settings.usageAccounts). It names a harness and a credential file; it is
 *  not a ProviderConnection and is never presented as one. */
export interface DomainLegacySource {
  id: string
  path: string
  /** old serialized harness selector (`provider`), already resolved through the
   *  desktop compatibility mapper */
  harnessId?: string
  label?: string
}

export interface DomainUsageSourcesRequest {
  legacySources?: DomainLegacySource[]
  limit?: number
}

/** Identity claim observed for a connection (email, account id, …). Claims are
 *  sourced observations, not merge keys. */
export interface DomainIdentityClaimView {
  kind: string
  value: string
  confidence: 'declared' | 'observed' | 'verified'
  observedAt: number
}

export interface DomainPlanClaimView {
  key: string
  label?: string | null
  value: string
  observedAt: number
}

/** One quota source the usage widget can display. `origin: 'legacy'` records
 *  exist only in desktop settings and have no stored quota history. */
export interface DomainUsageSourceView {
  key: string
  /** Absent when no observed harness binding exists for this connection. */
  harnessId?: string
  origin: 'domain' | 'legacy'
  connectionId?: string
  installationId?: string
  providerId?: string
  offeringId?: string
  harnessLabel?: string
  offeringLabel?: string
  providerLabel?: string
  /** credential material reference (a locator/ref the inventory points at) */
  materialRef?: string
  /** material revision the store has for that reference — the CAS input a
   *  credential refresh must send back */
  materialRevision?: number
  identityClaims: DomainIdentityClaimView[]
  planClaims: DomainPlanClaimView[]
}

export interface DomainOfferingView {
  id: string
  providerId: string
  label: string
  providerLabel?: string
}

/** Durable quota state for one connection: the newest observation, the last
 *  SUCCESS, and the current failure are three different facts. */
export interface DomainQuotaCurrentView {
  connectionId: string
  latest: QuotaReading | null
  lastSuccess: QuotaReading | null
  failure: QuotaReading | null
}

export interface DomainUsageSourcesResult {
  sources: DomainUsageSourceView[]
  quota: DomainQuotaCurrentView[]
  /** catalog labels resolved from the persisted catalog snapshot */
  labels: {
    harnesses: Record<string, string>
    providers: Record<string, string>
    offerings: Record<string, string>
  }
  /** the persisted catalog's offerings — the sign-in chooser reads these */
  offerings: DomainOfferingView[]
  /** offerings this harness's stored config bindings already point at (oldest
   *  first). Config evidence: it says which product the harness was set up for,
   *  not which one a new sign-in should use. */
  offeringsByHarness: Record<string, string[]>
  readiness: DomainReadiness
  freshness: DomainFreshness
}

// ── stored usage ledger ─────────────────────────────────────────────────────

/** Mirrors the daemon's `usage.entry.list` payload. There is deliberately no
 *  session filter: the operation pages the stable ledger by id, and the desktop
 *  groups the returned rows by session. */
export interface DomainUsageLedgerRequest {
  harnessId?: string
  status?: 'counted' | 'duplicate' | 'unresolved' | 'superseded'
  afterId?: string
  limit?: number
}

export interface DomainUsageLedgerResult extends UsageEntryQueryResult {
  readiness: DomainReadiness
}

// ── stored usage summaries (published aggregate generation) ─────────────────

export interface DomainUsageSummaryRequest {
  /** public time-bucket vocabulary; the daemon's stored grain name for
   *  'all-time' is 'alltime' and the adapter translates it */
  grain?: 'hour' | 'day' | 'week' | 'all-time'
  startUtc?: number
  endUtc?: number
  /** exact dimension filters; omitted keys do not filter. Scalar axes take an
   *  id string or null (the unattributed group); model axes take
   *  {namespace, nativeName, modelId?} or null, and verifiedPool takes
   *  {providerPoolKey, scope} — the same shapes the summary rows carry. */
  dimensions?: Record<string, unknown>
  /** exact rollup shape: keep only rows grouped by precisely these axes —
   *  '[]' selects the {} grand-total row, which a bounded page can otherwise
   *  miss. Combines with 'dimensions' (value filter) conjunctively. */
  dimensionKeys?: string[]
  limit?: number
  cursor?: string
}

/** `metering.summary.query` answers the canonical `UsageSummaryEnvelope`:
 *  contract `UsageSummary` items plus the generation/pending/page state the
 *  public DTO already declares. Aggregates are stored per dimension SET, so a
 *  page mixes rollup shapes (harness-only, per-session, per-model…) — consumers
 *  select the exact shape they need instead of adding overlapping rows. */
export interface DomainUsageSummariesResult {
  items: UsageSummary[]
  coverage: CollectionCoverage[]
  freshness: DomainFreshness
  watermark: { ledger?: string; attribution?: string; aggregate?: string }
  unidentified: DomainUnidentified[]
  nextCursor?: string
  /** published aggregate generation these rows were read from */
  aggregateGeneration: string | null
  /** the ledger holds changes this generation has not consumed */
  pending: boolean
  page: { size: number; exhausted: boolean }
  readiness: DomainReadiness
}

// ── stored statistics (weekly / daily / hourly persisted results) ───────────

export type DomainStatisticMetric =
  | 'weekly-average'
  | 'daily-average-within-week'
  | 'hourly-by-date'
  | 'hour-of-day-distribution'
  | 'hour-of-day-average'

export interface DomainUsageStatisticsRequest {
  metric?: DomainStatisticMetric
  dimensions?: Record<string, unknown>
}

/** `metering.statistic.list` answers the canonical `UsageStatisticEnvelope`;
 *  the items are contract `UsageStatistic` rows. */
export interface DomainUsageStatisticsResult {
  items: UsageStatistic[]
  coverage: CollectionCoverage[]
  freshness: DomainFreshness
  watermark: { ledger?: string; attribution?: string; aggregate?: string }
  unidentified: DomainUnidentified[]
  nextCursor?: string
  page: { size: number }
  readiness: DomainReadiness
}

/** one shape only: the public DTO above. Kept as aliases so view code can name
 *  what it consumes without restating contract fields. */
export type DomainUsageSummaryRow = UsageSummary
export type DomainUsageStatisticRow = UsageStatistic

export type { UsageValues }

// ── stored sessions ─────────────────────────────────────────────────────────

export interface DomainSessionsRequest {
  harnessId?: string
  installationId?: string
  originMachineId?: string
  parentSessionId?: string
  rootsOnly?: boolean
  afterId?: string
  limit?: number
}

export interface DomainSessionsResult extends SessionQueryResult {
  readiness: DomainReadiness
}

/** handle/attachment rows for one session (the list read does not carry them) */
export interface DomainSessionDetailResult extends SessionDetailResult {
  attachmentCount: number
}

// ── collection (separate from every read above) ─────────────────────────────

/** A source the daemon can collect from, as the desktop needs to see it. */
export interface DomainCollectionSourceView {
  id: string
  kind: string
  status: 'active' | 'missing' | 'unavailable' | 'retired' | 'unknown'
  subjectKind: 'installation' | 'connection' | 'session' | 'machine'
  subjectId?: string
  /** absent when the store did not report a stamp (never defaulted) */
  firstObservedAt?: number
  lastObservedAt?: number
}

export interface DomainCollectionRequest {
  /** narrow the request; without either, every active source is asked */
  installationId?: string
  connectionId?: string
  capability?: 'usage' | 'quota' | 'events' | 'sessions'
  reason?: string
}

export interface DomainCollectionRequestResult {
  requested: boolean
  /** one entry per source the daemon queued work for */
  queued: { sourceId: string; requestId: string; status: string }[]
  /** present when nothing was queued (no source yet, scheduler unavailable) */
  detail?: string
}

export interface DomainCollectionSourcesResult {
  sources: DomainCollectionSourceView[]
  readiness: DomainReadiness
}

/** Closing a connection in the inventory domain: the observation outcome
 *  'removed' ends its bindings without deleting the credential reference or the
 *  history it already produced. */
export interface DomainSourceRemovalRequest {
  connectionId: string
  /** free-form reference for the observation (who/what decided this) */
  sourceRef?: string
}

export interface DomainSourceRemovalResult {
  removed: boolean
  detail?: string
}

// ── provider sign-in (daemon-owned flows on their own transport) ────────────

/** What the UI must do next: open a page, collect input, or keep polling. */
export interface DomainAuthEffect {
  kind: 'open-browser'
  url: string
}

export type DomainAuthRequiredInputKind =
  'secret' | 'authorization-code' | 'localhost-callback' | 'device' | 'device-poll'

export interface DomainAuthRequiredInput {
  kind: DomainAuthRequiredInputKind
  /** device flows only: the code the user types on the provider page */
  userCode?: string
  verificationUri?: string
  /** device-poll only: wait until this time before polling again */
  retryAt?: number
  label?: string
}

export interface DomainAuthFlow {
  flowId: string
  connectionId?: string
  credentialId?: string
  state: 'complete' | 'needs-input' | 'effect-required' | 'failed' | 'unknown'
  effect?: DomainAuthEffect
  requiredInput?: DomainAuthRequiredInput
  expiresAt?: number
  credentialChange?: {
    kind: 'create' | 'refresh'
    materialRef: string
    materialRevision: number
    previousRevision?: number
  }
  identityClaims: { kind: string; value: string; confidence: string; connectionId: string }[]
  /** reported by the flow when it failed */
  error?: string
  /** material revision conflict during a refresh */
  conflict?: boolean
  currentRevision?: number
}

export interface DomainAuthStartRequest {
  /** the offering the user is signing in to (from the catalog) */
  offeringId: string
  /** replace/refresh material for an existing connection instead of adding one */
  connectionId?: string
  /** desktop-side label for the new registration, echoed back on completion */
  label?: string
}

export interface DomainAuthSubmitCodeRequest {
  flowId: string
  code: string
}

export interface DomainAuthSecretRequest {
  /** the flow that asked for a secret (`requiredInput.kind === 'secret'`) */
  flowId: string
  secret: string
}

export interface DomainAuthOutcome {
  ok: boolean
  state: DomainAuthFlow['state']
  flowId: string
  connectionId?: string
  credentialRef?: string
  account?: string
  error?: string
}

export interface DomainAuthRefreshRequest {
  connectionId: string
  credentialRef: string
  offeringId: string
  expectedMaterialRevision: number
}

/** Import one existing credential file into the canonical inventory as a
 *  read-only locator reference: the daemon probes the path and registers the
 *  credential + connection, the Pack catalog decides the credential format
 *  from the offering, and the file material is never copied or transported.
 *  This is the canonical replacement for the old desktop-only registration. */
export interface DomainAuthFileImportRequest {
  /** the offering this file belongs to (the Pack resolves the format from it) */
  offeringId: string
  /** absolute path of the existing credential file */
  path: string
}

export interface DomainAuthFileImportResult {
  /** true when a credential was created; false for an unchanged existing import */
  imported: boolean
  /** The committed, active inventory records for this file and offering. */
  connectionId: string
  credentialId: string
  /** why nothing was registered (unreadable file, unknown offering, …) */
  detail?: string
}

export type { CollectionRequest, ProviderIdentityClaim }
