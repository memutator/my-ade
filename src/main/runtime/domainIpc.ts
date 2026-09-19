// Desktop domain query/action adapter.
//
// This is the ONLY place the desktop reads the canonical domain store: catalog
// + inventory (what exists), metering (summaries, statistics, quota), collection
// (what is being gathered) and the usage/session ledger (what was observed).
// Handlers call the daemon operation registry through the single authenticated
// runtime session and map the answers into the wire DTOs in
// `src/preload/domain.ts`.
//
// Rules that are load-bearing and must survive every future edit:
//
//   1. A QUERY IS A STORED READ. Nothing here scans a harness log, parses a
//      session file, probes a provider or unlocks a credential. When the store
//      has no answer the seam reports CONTROL_UNAVAILABLE (or a partial result
//      with diagnostics) so the UI can say "unknown" honestly.
//   2. COLLECTION IS A SEPARATE MUTATION. `domain:collection.request` queues
//      durable collection requests per SOURCE (`collection.source.list` then
//      `collection.request {sourceId, capability}`) for the daemon scheduler to
//      run. Opening or re-reading a view never collects.
//   3. PROVIDER SECRETS NEVER TOUCH THIS FILE'S TRANSPORT. Sign-in goes through
//      the daemon's dedicated auth channel (see authClient.ts); a secret is
//      deposited there once and only a handle comes back.
//   4. MAPPING IS EXPLICIT. Every field the UI reads is named and validated; an
//      unexpected daemon shape becomes a diagnostics entry, never a cast.

import { ipcMain } from 'electron'
import { receiptToControl } from '../../../packages/mahas-client/src/index.ts'
import type {
  CollectionCoverage,
  CollectionRequest,
  ControlResult,
  HarnessInstallation,
  HarnessProviderBinding,
  HarnessSession,
  ProviderConnection,
  ProviderCredential,
  ProviderIdentityClaim,
  QuotaReading,
  SessionDetailResult,
  UsageAttributionCoverage,
  UsageAttribution,
  UsageCoverageSummary,
  UsageEntry,
  UsageModelRef,
  UsageStatistic,
  UsageStatisticBucket,
  UsageSummary,
  UsageTimeBucket,
  UsageValues
} from '../../../packages/mahas-contracts/src/index.ts'
import type {
  DomainAuthFlow,
  DomainAuthFileImportRequest,
  DomainAuthFileImportResult,
  DomainAuthOutcome,
  DomainAuthRefreshRequest,
  DomainAuthSecretRequest,
  DomainAuthStartRequest,
  DomainAuthSubmitCodeRequest,
  DomainCollectionRequest,
  DomainCollectionRequestResult,
  DomainCollectionSourceView,
  DomainCollectionSourcesResult,
  DomainFreshness,
  DomainOfferingView,
  DomainQuotaCurrentView,
  DomainReadiness,
  DomainSessionDetailResult,
  DomainSessionsRequest,
  DomainSessionsResult,
  DomainSourceRemovalResult,
  DomainUnidentified,
  DomainUsageLedgerRequest,
  DomainUsageLedgerResult,
  DomainUsageSourceView,
  DomainUsageSourcesRequest,
  DomainUsageSourcesResult,
  DomainUsageStatisticsRequest,
  DomainUsageStatisticsResult,
  DomainUsageSummariesResult,
  DomainUsageSummaryRequest
} from '../../preload/domain'
import { runtimeHandle } from '../runtimeClient.ts'
import {
  cancelAuthFlow as cancelAuthChannelFlow,
  pollAuthFlow as pollAuthChannelFlow,
  readAuthFlow as readAuthChannelFlow,
  refreshAuthFlow,
  startAuthFlow,
  submitFlowCode,
  submitFlowSecret
} from './authClient.ts'

/** Canonical daemon operations this adapter consumes. Published here so daemon
 *  composition can wire exactly these names (see
 *  docs/plans/usage-consumer-seams.md); a rename is a one-line change. */
export const DOMAIN_QUERY_OPERATIONS = {
  catalogSnapshot: 'catalog.snapshot',
  inventorySnapshot: 'inventory.snapshot',
  usageSummaryQuery: 'metering.summary.query',
  usageStatisticsList: 'metering.statistic.list',
  usageEntryList: 'usage.entry.list',
  quotaCurrent: 'metering.quota.current',
  quotaCollect: 'auth.quota.collect',
  sessionList: 'session.list',
  sessionGet: 'session.get',
  collectionSourceList: 'collection.source.list',
  collectionRequest: 'collection.request',
  inventoryObservationRecord: 'inventory.observation.record',
  locatorImport: 'auth.locator.import',
  connectionInventory: 'auth.connection.inventory'
} as const

// ── transport ──────────────────────────────────────────────────────────────

function unavailable<T>(message: string): ControlResult<T> {
  return { ok: false, error: { code: 'CONTROL_UNAVAILABLE', message, retryable: true } }
}

function invalid<T>(message: string): ControlResult<T> {
  return { ok: false, error: { code: 'INVALID_ARGUMENT', message } }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** one authenticated registry call — no retry, no invented fallback */
export async function callDomain<T>(
  operation: string,
  payload?: unknown
): Promise<ControlResult<T>> {
  const handle = runtimeHandle()
  if (!handle) return unavailable(`${operation}: no runtime attachment`)
  try {
    return receiptToControl<T>(await handle.client.call(operation, payload))
  } catch (error) {
    return unavailable(`${operation}: ${failureMessage(error)}`)
  }
}

// ── validation ─────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : []

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined

const int = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const nullableInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** statistic metrics the daemon registers; an unknown metric is refused rather
 *  than surfaced as an unlabelled card */
const STATISTIC_METRICS = [
  'weekly-average',
  'daily-average-within-week',
  'hourly-by-date',
  'hour-of-day-distribution',
  'hour-of-day-average'
] as const

/** null means "not reported" and is preserved; a non-numeric value is a
 *  protocol violation, and the whole reading is refused instead of guessed. */
function usageValues(value: unknown): UsageValues | null {
  if (!isRecord(value)) return null
  const keys = [
    'inputTotal',
    'outputTotal',
    'total',
    'cacheReadInput',
    'cacheWriteInput',
    'reasoningOutput'
  ] as const
  const out: Record<string, number | null> = {}
  for (const key of keys) {
    const raw = value[key]
    if (raw === null || raw === undefined) {
      out[key] = null
      continue
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
    out[key] = raw
  }
  return out as unknown as UsageValues
}

function coverageRows(value: unknown): CollectionCoverage[] {
  return rows(value).flatMap((row): CollectionCoverage[] => {
    const id = text(row['id'])
    const subject = isRecord(row['subject']) ? row['subject'] : null
    if (!id || !subject) return []
    const interval = isRecord(row['interval']) ? row['interval'] : null
    // an interval with a missing/malformed bound is DROPPED, not defaulted to
    // epoch 0: a fabricated timestamp is worse than an absent one
    const intervalStart = interval ? int(interval['start']) : undefined
    const intervalEnd = interval ? int(interval['end']) : undefined
    return [
      {
        id,
        sourceId: text(row['sourceId']) ?? null,
        subject: subject as unknown as CollectionCoverage['subject'],
        interval:
          intervalStart !== undefined && intervalEnd !== undefined
            ? { start: intervalStart, end: intervalEnd }
            : null,
        completeness: (text(row['completeness']) ??
          'unknown') as CollectionCoverage['completeness'],
        gapReason: text(row['gapReason']) ?? null,
        lastSuccessAt: nullableInt(row['lastSuccessAt']),
        watermark: text(row['watermark']) ?? null
      }
    ]
  })
}

function freshnessOf(value: unknown, fallbackAsOf: number): DomainFreshness {
  const raw = isRecord(value) ? value : {}
  const watermark = isRecord(raw['watermark']) ? raw['watermark'] : {}
  return {
    asOf: int(raw['asOf']) ?? fallbackAsOf,
    lastSuccessfulCollectionAt: nullableInt(raw['lastSuccessfulCollectionAt']),
    ledgerWatermark: nullableInt(watermark['ledger'] ?? raw['ledgerWatermark']),
    attributionWatermark: nullableInt(watermark['attribution'] ?? raw['attributionWatermark']),
    aggregateWatermark: nullableInt(watermark['aggregate']),
    pending: raw['pending'] === true
  }
}

function unidentifiedOf(value: unknown): DomainUnidentified[] {
  return rows(value).flatMap((row): DomainUnidentified[] => {
    const axis = text(row['axis'])
    const reason = text(row['reason'])
    if (!axis || !reason) return []
    return [{ axis, amount: nullableInt(row['amount']), reason }]
  })
}

function readinessOf(diagnostics: string[]): DomainReadiness {
  if (!diagnostics.length) return { state: 'ready', diagnostics: [] }
  return { state: 'partial', diagnostics }
}

// ── usage sources (catalog + inventory + quota current) ────────────────────

interface CatalogProjection {
  labels: {
    harnesses: Record<string, string>
    providers: Record<string, string>
    offerings: Record<string, string>
  }
  offerings: DomainOfferingView[]
}

function catalogProjection(snapshot: unknown): CatalogProjection {
  const raw = isRecord(snapshot) ? snapshot : {}
  const versions = (key: string): Record<string, unknown>[] =>
    rows(raw[key]).flatMap((row) => (isRecord(row['value']) ? [row['value']] : []))
  const labels = (key: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const value of versions(key)) {
      const id = text(value['id'])
      const label = text(value['label'])
      if (id && label) out[id] = label
    }
    return out
  }
  const providers = labels('providers')
  const offerings: DomainOfferingView[] = versions('offerings').flatMap((value) => {
    const id = text(value['id'])
    const providerId = text(value['providerId'])
    const label = text(value['label'])
    if (!id || !providerId || !label) return []
    return [
      {
        id,
        providerId,
        label,
        ...(providers[providerId] ? { providerLabel: providers[providerId] } : {})
      }
    ]
  })
  return {
    labels: { harnesses: labels('harnesses'), providers, offerings: labels('offerings') },
    offerings
  }
}

interface InventoryProjection {
  installations: HarnessInstallation[]
  credentials: ProviderCredential[]
  connections: ProviderConnection[]
  identityClaims: ProviderIdentityClaim[]
  bindings: HarnessProviderBinding[]
  offeringProvider: Map<string, string>
}

const emptyInventory: InventoryProjection = {
  installations: [],
  credentials: [],
  connections: [],
  identityClaims: [],
  bindings: [],
  offeringProvider: new Map()
}

function inventoryProjection(snapshot: unknown, catalog: CatalogProjection): InventoryProjection {
  const raw = isRecord(snapshot) ? snapshot : {}
  const values = (key: string): Record<string, unknown>[] =>
    rows(raw[key]).flatMap((row) => (isRecord(row['value']) ? [row['value']] : []))
  return {
    installations: values('installations') as unknown as HarnessInstallation[],
    credentials: values('credentials') as unknown as ProviderCredential[],
    connections: values('connections') as unknown as ProviderConnection[],
    identityClaims: values('identityClaims') as unknown as ProviderIdentityClaim[],
    bindings: values('bindings') as unknown as HarnessProviderBinding[],
    offeringProvider: new Map(
      catalog.offerings.map((offering) => [offering.id, offering.providerId])
    )
  }
}

function quotaViewOf(connectionId: string, value: unknown): DomainQuotaCurrentView {
  const raw = isRecord(value) ? value : {}
  const reading = (key: string): QuotaReading | null => {
    const candidate = raw[key]
    if (!isRecord(candidate) || !text(candidate['observationId'])) return null
    return candidate as unknown as QuotaReading
  }
  return {
    connectionId,
    latest: reading('latest'),
    lastSuccess: reading('lastSuccess'),
    failure: reading('currentFailure') ?? reading('failure')
  }
}

/** One source per open connection, plus legacy registrations. Optional harness
 *  bindings supply labels, never proof that traffic used the connection. */
export async function readUsageSources(
  request: DomainUsageSourcesRequest = {}
): Promise<ControlResult<DomainUsageSourcesResult>> {
  const now = Date.now()
  const diagnostics: string[] = []
  const [catalog, inventory] = await Promise.all([
    callDomain<unknown>(DOMAIN_QUERY_OPERATIONS.catalogSnapshot),
    callDomain<unknown>(DOMAIN_QUERY_OPERATIONS.inventorySnapshot)
  ])
  if (!catalog.ok) diagnostics.push(`catalog.snapshot: ${catalog.error.message}`)
  if (!inventory.ok) diagnostics.push(`inventory.snapshot: ${inventory.error.message}`)

  const catalogView = catalog.ok
    ? catalogProjection(catalog.value)
    : { labels: { harnesses: {}, providers: {}, offerings: {} }, offerings: [] }
  const projection = inventory.ok
    ? inventoryProjection(inventory.value, catalogView)
    : emptyInventory

  const limit = Math.max(1, Math.min(request.limit ?? 100, 500))
  const credentialById = new Map(projection.credentials.map((entry) => [entry.id, entry]))
  const installationById = new Map(projection.installations.map((entry) => [entry.id, entry]))
  const openConnections = new Set(
    projection.connections.filter((entry) => entry.observedUntil == null).map((entry) => entry.id)
  )

  const sources: DomainUsageSourceView[] = []
  const offeringsByHarness = new Map<string, string[]>()
  for (const binding of projection.bindings) {
    if (binding.observedUntil != null) continue
    if (!openConnections.has(binding.connectionId)) continue
    const installation = installationById.get(binding.installationId)
    const connection = projection.connections.find((entry) => entry.id === binding.connectionId)
    if (!installation || !connection) continue
    const listed = offeringsByHarness.get(installation.harnessId) ?? []
    if (!listed.includes(connection.offeringId)) listed.push(connection.offeringId)
    offeringsByHarness.set(installation.harnessId, listed)
  }
  // Signing in creates a connection, not evidence that any harness uses it.
  // Include every open connection; bindings only supply an optional label.
  for (const connection of projection.connections) {
    if (!openConnections.has(connection.id)) continue
    const binding = projection.bindings.find(
      (entry) =>
        entry.connectionId === connection.id &&
        entry.observedUntil == null &&
        installationById.has(entry.installationId)
    )
    const installation = binding ? installationById.get(binding.installationId) : undefined
    const providerId = projection.offeringProvider.get(connection.offeringId)
    const credential = credentialById.get(connection.credentialId)
    sources.push({
      key: `connection:${connection.id}`,
      ...(installation
        ? { harnessId: installation.harnessId, installationId: installation.id }
        : {}),
      origin: 'domain',
      connectionId: connection.id,
      offeringId: connection.offeringId,
      ...(providerId ? { providerId } : {}),
      ...(installation && catalogView.labels.harnesses[installation.harnessId]
        ? { harnessLabel: catalogView.labels.harnesses[installation.harnessId] }
        : {}),
      ...(catalogView.labels.offerings[connection.offeringId]
        ? { offeringLabel: catalogView.labels.offerings[connection.offeringId] }
        : {}),
      ...(providerId && catalogView.labels.providers[providerId]
        ? { providerLabel: catalogView.labels.providers[providerId] }
        : {}),
      ...(credential?.materialRef ? { materialRef: credential.materialRef } : {}),
      ...(credential?.materialRevision !== undefined
        ? { materialRevision: credential.materialRevision }
        : {}),
      identityClaims: projection.identityClaims
        .filter((claim) => claim.connectionId === connection.id && claim.validUntil == null)
        .map((claim) => ({
          kind: claim.kind,
          value: claim.value,
          confidence: claim.confidence,
          observedAt: claim.observedAt
        })),
      planClaims: []
    })
    if (sources.length >= limit) break
  }
  if (openConnections.size > sources.length)
    diagnostics.push(`showing ${sources.length} of ${openConnections.size} stored connections`)
  if ((request.legacySources?.length ?? 0) > limit)
    diagnostics.push(`legacy source list limited to ${limit} rows`)

  for (const record of (request.legacySources ?? []).slice(0, limit)) {
    const harnessId = text(record.harnessId)
    if (!harnessId || !text(record.path)) continue
    if (
      projection.credentials.some(
        (credential) => credential.materialRef === 'locator://file/' + record.path
      )
    )
      continue
    sources.push({
      key: `legacy:${record.id}`,
      harnessId,
      origin: 'legacy',
      materialRef: record.path,
      ...(catalogView.labels.harnesses[harnessId]
        ? { harnessLabel: catalogView.labels.harnesses[harnessId] }
        : {}),
      ...(text(record.label) ? { offeringLabel: text(record.label) } : {}),
      identityClaims: [],
      planClaims: []
    })
  }

  const domainSources = sources.filter(
    (source) => source.origin === 'domain' && source.connectionId
  )
  const quotaResults = await Promise.allSettled(
    domainSources.map((source) =>
      callDomain<unknown>(DOMAIN_QUERY_OPERATIONS.quotaCurrent, {
        connectionId: source.connectionId
      })
    )
  )
  const quota: DomainQuotaCurrentView[] = []
  quotaResults.forEach((result, index) => {
    const source = domainSources[index]
    if (!source?.connectionId) return
    if (result.status === 'rejected') {
      diagnostics.push(
        `metering.quota.current(${source.connectionId}): ${failureMessage(result.reason)}`
      )
      quota.push({
        connectionId: source.connectionId,
        latest: null,
        lastSuccess: null,
        failure: null
      })
      return
    }
    if (result.value.ok) {
      quota.push(quotaViewOf(source.connectionId, result.value.value))
      return
    }
    diagnostics.push(
      `metering.quota.current(${source.connectionId}): ${result.value.error.message}`
    )
    quota.push({
      connectionId: source.connectionId,
      latest: null,
      lastSuccess: null,
      failure: null
    })
  })

  const readiness: DomainReadiness = !inventory.ok
    ? { state: 'unavailable', diagnostics }
    : readinessOf(diagnostics)
  return {
    ok: true,
    value: {
      sources,
      quota,
      labels: catalogView.labels,
      offerings: catalogView.offerings,
      offeringsByHarness: Object.fromEntries(offeringsByHarness),
      readiness,
      freshness: { asOf: now }
    }
  }
}

// ── usage ledger (stored entries with their attribution) ───────────────────

export async function readUsageLedger(
  request: DomainUsageLedgerRequest = {}
): Promise<ControlResult<DomainUsageLedgerResult>> {
  const now = Date.now()
  const result = await callDomain<unknown>(DOMAIN_QUERY_OPERATIONS.usageEntryList, {
    ...(request.harnessId ? { harnessId: request.harnessId } : {}),
    ...(request.status ? { status: request.status } : {}),
    ...(request.afterId ? { afterId: request.afterId } : {}),
    limit: Math.max(1, Math.min(request.limit ?? 500, 5_000))
  })
  if (!result.ok) {
    return {
      ok: true,
      value: {
        items: [],
        coverage: [],
        unidentified: [],
        freshness: { asOf: now },
        watermark: {},
        readiness: { state: 'unavailable', diagnostics: [result.error.message] }
      }
    }
  }
  const raw = isRecord(result.value) ? result.value : {}
  const rawItems = rows(raw['items'])
  const items = rawItems.flatMap((row) => {
    const entry = row['entry']
    if (!isRecord(entry) || !text(entry['id'])) return []
    return [
      {
        entry: entry as unknown as UsageEntry,
        attribution: isRecord(row['attribution'])
          ? (row['attribution'] as unknown as UsageAttribution)
          : null
      }
    ]
  })
  const diagnostics: string[] = []
  if (rawItems.length !== items.length) {
    diagnostics.push(
      `${rawItems.length - items.length} ledger rows had no entry id and were dropped`
    )
  }
  const nextCursor = text(raw['nextCursor'])
  const watermark = isRecord(raw['watermark']) ? raw['watermark'] : {}
  return {
    ok: true,
    value: {
      items,
      coverage: coverageRows(raw['coverage']),
      unidentified: unidentifiedOf(raw['unidentified']),
      freshness: freshnessOf(raw['freshness'], now),
      watermark: {
        ...(text(watermark['ledger']) ? { ledger: text(watermark['ledger']) } : {}),
        ...(text(watermark['attribution']) ? { attribution: text(watermark['attribution']) } : {}),
        ...(text(watermark['aggregate']) ? { aggregate: text(watermark['aggregate']) } : {})
      },
      ...(nextCursor ? { nextCursor } : {}),
      readiness: readinessOf(diagnostics)
    }
  }
}

// ── usage summaries (published aggregate generation) ───────────────────────

function watermarkOf(value: unknown): DomainUsageSummariesResult['watermark'] {
  const raw = isRecord(value) ? value : {}
  const ledger = text(raw['ledger'])
  const attribution = text(raw['attribution'])
  const aggregate = text(raw['aggregate'])
  return {
    ...(ledger ? { ledger } : {}),
    ...(attribution ? { attribution } : {}),
    ...(aggregate ? { aggregate } : {})
  }
}

function coverageSummary(value: unknown): UsageCoverageSummary | null {
  if (!isRecord(value)) return null
  const completeness = text(value['completeness'])
  if (completeness !== 'complete' && completeness !== 'partial' && completeness !== 'unknown')
    return null
  return {
    completeness,
    knownTokens: int(value['knownTokens']) ?? 0,
    unknownTokens: nullableInt(value['unknownTokens']),
    unallocatedTimeTokens: int(value['unallocatedTimeTokens']) ?? 0,
    coverageIds: strings(value['coverageIds'])
  }
}

function attributionCoverage(value: unknown): UsageAttributionCoverage | null {
  if (!isRecord(value)) return null
  const status = text(value['status'])
  if (status !== 'complete' && status !== 'partial' && status !== 'unknown') return null
  return {
    attributedTokens: int(value['attributedTokens']) ?? 0,
    unattributedTokens: int(value['unattributedTokens']) ?? 0,
    status
  }
}

function timeBucketOf(value: unknown): UsageTimeBucket | null {
  if (!isRecord(value)) return null
  const grain = text(value['grain'])
  if (grain !== 'hour' && grain !== 'day' && grain !== 'week' && grain !== 'all-time') return null
  const weekStart = text(value['weekStart'])
  return {
    grain,
    startUtc: nullableInt(value['startUtc']),
    endUtc: nullableInt(value['endUtc']),
    timeZone: text(value['timeZone']) ?? 'UTC',
    ...(weekStart === 'sunday' || weekStart === 'monday' ? { weekStart } : {})
  }
}

/** scalar axes whose value is an id string or null (grouped, unattributed) */
const DIMENSION_ID_AXES = [
  'machineId',
  'harnessId',
  'sessionId',
  'providerId',
  'offeringId',
  'connectionId',
  'organizationId'
] as const

function modelRefOf(value: unknown): UsageModelRef | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const nativeName = text(value['nativeName'])
  const namespace = text(value['namespace'])
  if (!nativeName || !namespace) return undefined
  const modelId = value['modelId']
  const aliasId = value['aliasId']
  if (modelId !== undefined && modelId !== null && typeof modelId !== 'string') return undefined
  if (aliasId !== undefined && aliasId !== null && typeof aliasId !== 'string') return undefined
  return {
    nativeName,
    namespace,
    ...(typeof modelId === 'string' ? { modelId } : {}),
    ...(typeof aliasId === 'string' ? { aliasId } : {}),
    ...(Array.isArray(value['mappingEvidence'])
      ? { mappingEvidence: value['mappingEvidence'] as UsageModelRef['mappingEvidence'] }
      : {})
  }
}

/** Validate the rollup axes of one published summary row. Key presence is the
 *  grouping contract — a key the projection does not know means the row came
 *  from a shape this desktop cannot interpret, so the row is refused (the
 *  caller logs a diagnostic) instead of silently re-keyed. */
function usageDimensions(value: unknown): UsageSummary['dimensions'] | null {
  if (!isRecord(value)) return null
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue
    if ((DIMENSION_ID_AXES as readonly string[]).includes(key)) {
      if (raw !== null && typeof raw !== 'string') return null
      out[key] = raw
      continue
    }
    if (key === 'organizationRelation') {
      if (
        raw !== null &&
        raw !== 'harness-publisher' &&
        raw !== 'model-publisher' &&
        raw !== 'provider-operator'
      )
        return null
      out[key] = raw
      continue
    }
    if (key === 'requestedModel' || key === 'servedModel') {
      const model = modelRefOf(raw)
      if (model === undefined) return null
      out[key] = model
      continue
    }
    if (key === 'verifiedPool') {
      if (raw === null) {
        out[key] = null
        continue
      }
      if (!isRecord(raw)) return null
      const providerPoolKey = text(raw['providerPoolKey'])
      const scope = text(raw['scope'])
      if (!providerPoolKey || !scope) return null
      out[key] = { providerPoolKey, scope }
      continue
    }
    return null
  }
  return out as UsageSummary['dimensions']
}

/** Validate one published summary row against the contract DTO. A row that does
 *  not match is reported as a diagnostic; it is never coerced into a shape the
 *  aggregation did not produce. */
function summaryItem(value: Record<string, unknown>): UsageSummary | null {
  const key = text(value['key'])
  const totals = usageValues(value['totals'])
  const coverage = coverageSummary(value['coverage'])
  const attribution = attributionCoverage(value['attributionCoverage'])
  const timeBucket = timeBucketOf(value['timeBucket'])
  const dimensions = usageDimensions(value['dimensions'])
  // `computedAt` is printed ("computed …"): a row without it is refused instead
  // of being shown with an epoch-0 stamp. The watermarks are opaque read tokens
  // and are not displayed.
  const computedAt = int(value['computedAt'])
  if (
    !key ||
    !totals ||
    !coverage ||
    !attribution ||
    !timeBucket ||
    !dimensions ||
    computedAt === undefined
  ) {
    return null
  }
  return {
    key,
    dimensions,
    timeBucket,
    totals,
    coverage,
    attributionCoverage: attribution,
    definitionRevision: int(value['definitionRevision']) ?? 0,
    ledgerWatermark: text(value['ledgerWatermark']) ?? '',
    attributionWatermark: text(value['attributionWatermark']) ?? '',
    aggregateGeneration: text(value['aggregateGeneration']) ?? '',
    pending: value['pending'] === true,
    computedAt
  }
}

/** `metering.summary.query`'s canonical envelope → the wire DTO. One shape
 *  only: the published generation decides what is a summary, and a page that
 *  mixes rollup shapes is the caller's to interpret. */
function summaryEnvelope(value: unknown, now: number): DomainUsageSummariesResult {
  const raw = isRecord(value) ? value : {}
  const incoming = rows(raw['items'])
  const diagnostics: string[] = []
  const items: UsageSummary[] = []
  for (const row of incoming) {
    const mapped = summaryItem(row)
    if (!mapped) {
      diagnostics.push('a summary row did not match the published projection')
      continue
    }
    items.push(mapped)
  }
  const nextCursor = text(raw['nextCursor'])
  const page = isRecord(raw['page']) ? raw['page'] : {}
  const generation = text(raw['aggregateGeneration'])
  return {
    items,
    coverage: coverageRows(raw['coverage']),
    freshness: freshnessOf(raw['freshness'], now),
    watermark: watermarkOf(raw['watermark']),
    unidentified: unidentifiedOf(raw['unidentified']),
    ...(nextCursor ? { nextCursor } : {}),
    aggregateGeneration: raw['aggregateGeneration'] === null ? null : (generation ?? null),
    pending: raw['pending'] === true,
    page: { size: int(page['size']) ?? items.length, exhausted: page['exhausted'] === true },
    readiness: readinessOf(diagnostics)
  }
}

export async function readUsageSummaries(
  request: DomainUsageSummaryRequest = {}
): Promise<ControlResult<DomainUsageSummariesResult>> {
  const now = Date.now()
  const result = await callDomain<unknown>(DOMAIN_QUERY_OPERATIONS.usageSummaryQuery, {
    filter: {
      // the daemon's stored grain name for the public 'all-time' bucket is
      // 'alltime'; the public DTO renames it back on the way out
      ...(request.grain ? { grain: request.grain === 'all-time' ? 'alltime' : request.grain } : {}),
      ...(request.startUtc !== undefined ? { startUtc: request.startUtc } : {}),
      ...(request.endUtc !== undefined ? { endUtc: request.endUtc } : {}),
      ...(request.dimensions ?? {})
    },
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
    ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
    ...(request.dimensionKeys !== undefined ? { dimensionKeys: request.dimensionKeys } : {})
  })
  if (!result.ok) {
    return {
      ok: true,
      value: {
        items: [],
        coverage: [],
        freshness: { asOf: now },
        watermark: {},
        unidentified: [],
        aggregateGeneration: null,
        pending: false,
        page: { size: 0, exhausted: false },
        readiness: { state: 'unavailable', diagnostics: [result.error.message] }
      }
    }
  }
  return { ok: true, value: summaryEnvelope(result.value, now) }
}

// ── usage statistics (weekly / daily / hourly persisted results) ───────────

function statisticBucket(value: Record<string, unknown>): UsageStatisticBucket | null {
  const key = text(value['key'])
  const bucketValue = usageValues(value['value'])
  const coverage = coverageSummary(value['coverage'])
  if (!key || !bucketValue || !coverage) return null
  const startUtc = int(value['startUtc'])
  const endUtc = int(value['endUtc'])
  return {
    key,
    ...(startUtc === undefined ? {} : { startUtc }),
    ...(endUtc === undefined ? {} : { endUtc }),
    value: bucketValue,
    ...(value['denominator'] === undefined || value['denominator'] === null
      ? {}
      : { denominator: nullableInt(value['denominator']) }),
    coverage
  }
}

/** Validate one persisted statistic row against the contract DTO. */
function statisticItem(value: Record<string, unknown>): UsageStatistic | null {
  const id = text(value['id'])
  const metric = text(value['metric'])
  const range = isRecord(value['range']) ? value['range'] : null
  const coverage = coverageSummary(value['coverage'])
  const numerator = usageValues(value['numerator'])
  const calendar = isRecord(value['calendarPolicy']) ? value['calendarPolicy'] : null
  if (!id || !metric || !(STATISTIC_METRICS as readonly string[]).includes(metric)) return null
  if (!range || !coverage || !numerator || !calendar) return null
  const weekStart = text(calendar['weekStart'])
  if (weekStart !== 'monday' && weekStart !== 'sunday') return null
  const buckets = Array.isArray(value['buckets'])
    ? value['buckets'].flatMap((bucket): UsageStatisticBucket[] => {
        if (!isRecord(bucket)) return []
        const mapped = statisticBucket(bucket)
        return mapped ? [mapped] : []
      })
    : null
  const value0 = usageValues(value['value'])
  const denominator = nullableInt(value['denominator'])
  const expectedPeriods = nullableInt(value['expectedPeriods'])
  const validPeriods = nullableInt(value['validPeriods'])
  // both stamps are printed by the statistics panel
  const asOf = int(value['asOf'])
  const computedAt = int(value['computedAt'])
  if (asOf === undefined || computedAt === undefined) return null
  return {
    id,
    definitionRevision: int(value['definitionRevision']) ?? 0,
    metric: metric as UsageStatistic['metric'],
    dimensions: (isRecord(value['dimensions'])
      ? value['dimensions']
      : {}) as UsageStatistic['dimensions'],
    range: { start: int(range['start']) ?? 0, end: int(range['end']) ?? 0 },
    timeZone: text(value['timeZone']) ?? 'UTC',
    calendarPolicy: {
      weekStart,
      completedPeriodsOnly: calendar['completedPeriodsOnly'] === true
    },
    value: value0,
    ...(buckets ? { buckets } : {}),
    numerator,
    denominator,
    expectedPeriods,
    validPeriods,
    exclusions: rows(value['exclusions']).flatMap((row) => {
      const reason = text(row['reason'])
      const start = int(row['start'])
      const end = int(row['end'])
      if (!reason || start === undefined || end === undefined) return []
      return [{ start, end, reason }]
    }),
    coverage,
    sourceWatermarks: strings(value['sourceWatermarks']),
    asOf,
    computedAt
  }
}

export async function readUsageStatistics(
  request: DomainUsageStatisticsRequest = {}
): Promise<ControlResult<DomainUsageStatisticsResult>> {
  const now = Date.now()
  const result = await callDomain<unknown>(DOMAIN_QUERY_OPERATIONS.usageStatisticsList, {
    ...(request.metric ? { metric: request.metric } : {}),
    ...(request.dimensions ? { dimensions: request.dimensions } : {})
  })
  if (!result.ok) {
    return {
      ok: true,
      value: {
        items: [],
        coverage: [],
        freshness: { asOf: now },
        watermark: {},
        unidentified: [],
        page: { size: 0 },
        readiness: { state: 'unavailable', diagnostics: [result.error.message] }
      }
    }
  }
  const raw = isRecord(result.value) ? result.value : {}
  const incoming = rows(raw['items'])
  const diagnostics: string[] = []
  const items: UsageStatistic[] = []
  for (const row of incoming) {
    const mapped = statisticItem(row)
    if (!mapped) {
      diagnostics.push('a statistic row did not match the published projection')
      continue
    }
    items.push(mapped)
  }
  const page = isRecord(raw['page']) ? raw['page'] : {}
  return {
    ok: true,
    value: {
      items,
      coverage: coverageRows(raw['coverage']),
      freshness: freshnessOf(raw['freshness'], now),
      watermark: watermarkOf(raw['watermark']),
      unidentified: unidentifiedOf(raw['unidentified']),
      page: { size: int(page['size']) ?? items.length },
      readiness: readinessOf(diagnostics)
    }
  }
}

// ── stored sessions ─────────────────────────────────────────────────────────

export async function readStoredSessions(
  request: DomainSessionsRequest = {}
): Promise<ControlResult<DomainSessionsResult>> {
  const now = Date.now()
  const result = await callDomain<unknown>(DOMAIN_QUERY_OPERATIONS.sessionList, {
    ...(request.harnessId ? { harnessId: request.harnessId } : {}),
    ...(request.installationId ? { installationId: request.installationId } : {}),
    ...(request.originMachineId ? { originMachineId: request.originMachineId } : {}),
    ...(request.parentSessionId ? { parentSessionId: request.parentSessionId } : {}),
    ...(request.rootsOnly ? { rootsOnly: true } : {}),
    ...(request.afterId ? { afterId: request.afterId } : {}),
    limit: Math.max(1, Math.min(request.limit ?? 200, 1_000))
  })
  if (!result.ok) {
    return {
      ok: true,
      value: {
        items: [],
        asOf: now,
        readiness: { state: 'unavailable', diagnostics: [result.error.message] }
      }
    }
  }
  const raw = isRecord(result.value) ? result.value : {}
  const incoming = rows(raw['items'])
  const sessions = incoming.filter((row) => text(row['id'])) as unknown as HarnessSession[]
  const diagnostics: string[] = []
  if (incoming.length !== sessions.length) {
    diagnostics.push(`${incoming.length - sessions.length} session rows had no id and were dropped`)
  }
  const nextCursor = text(raw['nextCursor'])
  return {
    ok: true,
    value: {
      items: sessions,
      asOf: int(raw['asOf']) ?? now,
      ...(nextCursor ? { nextCursor } : {}),
      readiness: readinessOf(diagnostics)
    }
  }
}

/** one session's handles/children — used by consumers that need resume support;
 *  the list read answers sessions only, so this is a separate bounded call. */
export async function readSessionDetail(
  sessionId: string
): Promise<ControlResult<DomainSessionDetailResult>> {
  if (!sessionId) return invalid('session detail requires a sessionId')
  const result = await callDomain<SessionDetailResult | null>(DOMAIN_QUERY_OPERATIONS.sessionGet, {
    sessionId
  })
  if (!result.ok) return result
  const detail = result.value
  if (
    !detail?.session?.id ||
    !Array.isArray(detail.handles) ||
    !Array.isArray(detail.attachments)
  ) {
    return invalid(`session.get returned no session for ${sessionId}`)
  }
  return { ok: true, value: { ...detail, attachmentCount: detail.attachments.length } }
}

// ── collection (queueing, never collecting here) ───────────────────────────

function collectionSourceView(value: Record<string, unknown>): DomainCollectionSourceView | null {
  const id = text(value['id'])
  const subject = isRecord(value['subject']) ? value['subject'] : null
  const subjectKind = text(subject?.['kind'])
  if (!id || !subjectKind) return null
  const subjectId =
    text(subject?.['installationId']) ??
    text(subject?.['connectionId']) ??
    text(subject?.['sessionId']) ??
    text(subject?.['machineId'])
  return {
    id,
    kind: text(value['kind']) ?? 'other',
    status: (text(value['status']) ?? 'unknown') as DomainCollectionSourceView['status'],
    subjectKind: subjectKind as DomainCollectionSourceView['subjectKind'],
    ...(subjectId ? { subjectId } : {}),
    // observation stamps stay absent when the store did not report them — an
    // epoch-0 default would read as "observed in 1970"
    ...(int(value['firstObservedAt']) !== undefined
      ? { firstObservedAt: int(value['firstObservedAt']) }
      : {}),
    ...(int(value['lastObservedAt']) !== undefined
      ? { lastObservedAt: int(value['lastObservedAt']) }
      : {})
  }
}

export async function readCollectionSources(
  limit = 200
): Promise<ControlResult<DomainCollectionSourcesResult>> {
  const result = await callDomain<unknown>(DOMAIN_QUERY_OPERATIONS.collectionSourceList, {
    limit: Math.max(1, Math.min(limit, 500))
  })
  if (!result.ok) {
    return {
      ok: true,
      value: {
        sources: [],
        readiness: { state: 'unavailable', diagnostics: [result.error.message] }
      }
    }
  }
  const raw = isRecord(result.value) ? result.value : {}
  const incoming = rows(raw['items'])
  const sources = incoming.flatMap((row): DomainCollectionSourceView[] => {
    const mapped = collectionSourceView(row)
    return mapped ? [mapped] : []
  })
  const diagnostics: string[] = []
  if (incoming.length !== sources.length) {
    diagnostics.push(`${incoming.length - sources.length} source rows could not be mapped`)
  }
  return { ok: true, value: { sources, readiness: readinessOf(diagnostics) } }
}

/** Queue durable collection work for the daemon scheduler. The desktop never
 *  collects: it names the sources and the capability, and reports what was
 *  queued (or why nothing was). */
export async function requestCollection(
  request: DomainCollectionRequest = {}
): Promise<ControlResult<DomainCollectionRequestResult>> {
  const capability = request.capability ?? 'usage'
  if (capability === 'quota') {
    const signalled = await callDomain<unknown>(DOMAIN_QUERY_OPERATIONS.quotaCollect, {})
    if (!signalled.ok) return signalled
    return {
      ok: true,
      value: {
        requested: true,
        queued: [],
        detail: 'quota refresh requested; stored results update after collection'
      }
    }
  }
  const listed = await readCollectionSources()
  if (!listed.ok) return listed
  if (listed.value.readiness.state === 'unavailable') {
    return {
      ok: true,
      value: {
        requested: false,
        queued: [],
        detail: listed.value.readiness.diagnostics[0] ?? 'collection sources unavailable'
      }
    }
  }
  const candidates = listed.value.sources
    .filter((source) => source.status === 'active' || source.status === 'unknown')
    .filter((source) =>
      request.installationId
        ? source.subjectKind === 'installation' && source.subjectId === request.installationId
        : true
    )
    .filter((source) =>
      request.connectionId
        ? source.subjectKind === 'connection' && source.subjectId === request.connectionId
        : true
    )
    .slice(0, 25)
  if (!candidates.length) {
    return {
      ok: true,
      value: {
        requested: false,
        queued: [],
        detail: 'no active collection source is registered for this scope yet'
      }
    }
  }
  const results = await Promise.allSettled(
    candidates.map((source) =>
      callDomain<CollectionRequest>(DOMAIN_QUERY_OPERATIONS.collectionRequest, {
        sourceId: source.id,
        capability,
        reason: request.reason ?? 'desktop-request'
      })
    )
  )
  const queued: DomainCollectionRequestResult['queued'] = []
  const diagnostics: string[] = []
  results.forEach((result, index) => {
    const source = candidates[index]
    if (!source) return
    if (result.status === 'rejected') {
      diagnostics.push(`${source.id}: ${failureMessage(result.reason)}`)
      return
    }
    if (!result.value.ok) {
      diagnostics.push(`${source.id}: ${result.value.error.message}`)
      return
    }
    const request = result.value.value
    queued.push({ sourceId: source.id, requestId: request.id, status: request.status })
  })
  return {
    ok: true,
    value: {
      requested: queued.length > 0,
      queued,
      ...(queued.length
        ? { detail: `queued ${queued.length} ${capability} collection request(s)` }
        : { detail: diagnostics[0] ?? 'no collection request was accepted' })
    }
  }
}

// ── provider sign-in (dedicated auth channel) ──────────────────────────────

/** Close a canonical source: the inventory domain records the connection as
 *  confirmed-removed, which ends its bindings and leaves the stored usage
 *  history in place. Nothing here deletes a credential file — the desktop only
 *  reports what the user decided. */
export async function removeUsageSource(
  connectionId: string
): Promise<ControlResult<DomainSourceRemovalResult>> {
  if (!connectionId) return invalid('removing a source requires a connectionId')
  const result = await callDomain<unknown>(DOMAIN_QUERY_OPERATIONS.inventoryObservationRecord, {
    id: `observation:connection-removed:${connectionId}:${Date.now()}`,
    subjectKind: 'connection',
    subjectId: connectionId,
    outcome: 'removed',
    observedAt: Date.now(),
    sourceRef: 'desktop-usage-widget'
  })
  if (!result.ok) return result
  return { ok: true, value: { removed: true } }
}

function authFlowOf(value: unknown): DomainAuthFlow | null {
  const raw = isRecord(value) ? value : null
  if (!raw) return null
  const flowId = text(raw['flowId'])
  const state = text(raw['state'])
  if (!flowId || !state) return null
  const effectRaw = isRecord(raw['effect']) ? raw['effect'] : null
  const effectUrl = effectRaw ? text(effectRaw['url']) : undefined
  const inputRaw = isRecord(raw['requiredInput']) ? raw['requiredInput'] : null
  const inputKind = inputRaw ? text(inputRaw['kind']) : undefined
  const changeRaw = isRecord(raw['credentialChange']) ? raw['credentialChange'] : null
  const changeRef = changeRaw ? text(changeRaw['materialRef']) : undefined
  const expiresAt = int(raw['expiresAt'])
  const error = text(raw['error'])
  const currentRevision = int(raw['currentRevision'])
  return {
    flowId,
    state: state as DomainAuthFlow['state'],
    ...(text(raw['connectionId']) ? { connectionId: text(raw['connectionId']) } : {}),
    ...(text(raw['credentialId']) ? { credentialId: text(raw['credentialId']) } : {}),
    ...(effectRaw && effectRaw['kind'] === 'open-browser' && effectUrl
      ? { effect: { kind: 'open-browser' as const, url: effectUrl } }
      : {}),
    ...(inputRaw && inputKind
      ? {
          requiredInput: {
            kind: inputKind as NonNullable<DomainAuthFlow['requiredInput']>['kind'],
            ...(text(inputRaw['userCode']) ? { userCode: text(inputRaw['userCode']) } : {}),
            ...(text(inputRaw['verificationUri'])
              ? { verificationUri: text(inputRaw['verificationUri']) }
              : {}),
            ...(int(inputRaw['retryAt']) !== undefined
              ? { retryAt: int(inputRaw['retryAt']) }
              : {}),
            ...(text(inputRaw['label']) ? { label: text(inputRaw['label']) } : {})
          }
        }
      : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(changeRaw &&
    changeRef &&
    (changeRaw['kind'] === 'create' || changeRaw['kind'] === 'refresh') &&
    int(changeRaw['materialRevision']) !== undefined
      ? {
          credentialChange: {
            kind: changeRaw['kind'] as 'create' | 'refresh',
            materialRef: changeRef,
            materialRevision: int(changeRaw['materialRevision']) as number,
            ...(int(changeRaw['previousRevision']) !== undefined
              ? { previousRevision: int(changeRaw['previousRevision']) }
              : {})
          }
        }
      : {}),
    identityClaims: rows(raw['identityClaims']).flatMap((claim) => {
      const kind = text(claim['kind'])
      const claimValue = text(claim['value'])
      const connectionId = text(claim['connectionId'])
      if (!kind || !claimValue || !connectionId) return []
      return [
        {
          kind,
          value: claimValue,
          confidence: text(claim['confidence']) ?? 'observed',
          connectionId
        }
      ]
    }),
    ...(error ? { error } : {}),
    ...(raw['conflict'] === true ? { conflict: true } : {}),
    ...(currentRevision !== undefined ? { currentRevision } : {})
  }
}

function authOutcomeOf(response: { result?: unknown }): DomainAuthOutcome | null {
  const flow = authFlowOf(response.result)
  if (!flow) return null
  const account =
    flow.identityClaims.find((claim) => claim.kind === 'email')?.value ??
    flow.identityClaims[0]?.value
  return {
    ok: flow.state === 'complete',
    state: flow.state,
    flowId: flow.flowId,
    ...(flow.connectionId ? { connectionId: flow.connectionId } : {}),
    ...(flow.credentialChange?.materialRef
      ? { credentialRef: flow.credentialChange.materialRef }
      : {}),
    ...(account ? { account } : {}),
    ...(flow.error ? { error: flow.error } : {})
  }
}

export async function startAuth(
  request: DomainAuthStartRequest
): Promise<ControlResult<DomainAuthFlow>> {
  if (!request?.offeringId) return invalid('auth start requires an offeringId')
  const response = await startAuthFlow({
    offeringId: request.offeringId,
    ...(request.connectionId ? { connectionId: request.connectionId } : {})
  })
  if (!response.ok) return response
  const flow = authFlowOf(response.value.result)
  if (!flow) return invalid('auth.flow.start returned no usable flow')
  return { ok: true, value: flow }
}

export async function submitAuthCode(
  request: DomainAuthSubmitCodeRequest
): Promise<ControlResult<DomainAuthOutcome>> {
  if (!request?.flowId || !request.code) return invalid('code submission requires flowId and code')
  const response = await submitFlowCode(request.flowId, request.code)
  if (!response.ok) return response
  const outcome = authOutcomeOf(response.value)
  if (!outcome) return invalid('auth.flow.submitCode returned no flow view')
  return { ok: true, value: outcome }
}

export async function submitAuthSecret(
  request: DomainAuthSecretRequest
): Promise<ControlResult<DomainAuthOutcome>> {
  if (!request?.flowId || !request.secret) {
    return invalid('secret submission requires flowId and secret')
  }
  const response = await submitFlowSecret(request.flowId, request.secret)
  if (!response.ok) return response
  const outcome = authOutcomeOf(response.value)
  if (!outcome) return invalid('auth.flow.submitSecret returned no flow view')
  return { ok: true, value: outcome }
}

/** Polling returns the FLOW, not an outcome: a device flow republishes its
 *  `requiredInput` (with `retryAt`) until it completes, and the UI needs the
 *  effect/input kind to keep showing the right thing. */
export async function pollAuthFlow(flowId: string): Promise<ControlResult<DomainAuthFlow>> {
  if (!flowId) return invalid('poll requires a flowId')
  const response = await pollAuthChannelFlow(flowId)
  if (!response.ok) return response
  const flow = authFlowOf(response.value.result)
  if (!flow) return invalid('auth.flow.poll returned no flow view')
  return { ok: true, value: flow }
}

export async function readAuthFlow(flowId: string): Promise<ControlResult<DomainAuthFlow | null>> {
  if (!flowId) return invalid('status requires a flowId')
  const response = await readAuthChannelFlow(flowId)
  if (!response.ok) return response
  return { ok: true, value: authFlowOf(response.value.result) }
}

export async function cancelAuthFlow(flowId: string): Promise<ControlResult<null>> {
  if (!flowId) return invalid('cancel requires a flowId')
  const response = await cancelAuthChannelFlow(flowId)
  return response.ok ? { ok: true, value: null } : response
}

export async function refreshCredential(
  request: DomainAuthRefreshRequest
): Promise<ControlResult<DomainAuthOutcome>> {
  if (!request?.connectionId || !request.credentialRef || !request.offeringId) {
    return invalid('credential refresh requires connectionId, credentialRef and offeringId')
  }
  const response = await refreshAuthFlow({
    connectionId: request.connectionId,
    credentialRef: request.credentialRef,
    offeringId: request.offeringId,
    expectedMaterialRevision: request.expectedMaterialRevision
  })
  if (!response.ok) return response
  const outcome = authOutcomeOf(response.value)
  if (!outcome) return invalid('auth.flow.refresh returned no flow view')
  return { ok: true, value: outcome }
}

/** The selected path travels as a reference. Only the daemon/Pack reads it. */
export async function importAuthFile(
  request: DomainAuthFileImportRequest
): Promise<ControlResult<DomainAuthFileImportResult>> {
  const offeringId = text(request?.offeringId)
  const path = text(request?.path)
  if (!offeringId || !path?.startsWith('/') || path.includes('\0'))
    return invalid('file import requires an offering and an absolute filesystem path')
  const imported = await callDomain<unknown>(DOMAIN_QUERY_OPERATIONS.locatorImport, {
    offeringId,
    path
  })
  if (!imported.ok) return imported
  const result = isRecord(imported.value) ? imported.value : {}
  const newIds = Array.isArray(result['imported'])
    ? result['imported'].filter((id): id is string => typeof id === 'string')
    : []
  const oldIds = Array.isArray(result['unchanged'])
    ? result['unchanged'].filter((id): id is string => typeof id === 'string')
    : []
  const credentialIds = new Set([...newIds, ...oldIds])
  if (!credentialIds.size) return invalid('the selected credential file could not be imported')
  const inventory = await callDomain<unknown>(DOMAIN_QUERY_OPERATIONS.connectionInventory)
  if (!inventory.ok) return inventory
  const snapshot = isRecord(inventory.value) ? inventory.value : {}
  const connection = rows(snapshot['connections']).find(
    (row) =>
      row['offeringId'] === offeringId &&
      typeof row['credentialId'] === 'string' &&
      credentialIds.has(row['credentialId'])
  )
  const connectionId = connection && text(connection['id'])
  const credentialId = connection && text(connection['credentialId'])
  if (!connectionId || !credentialId)
    return invalid('this file was previously removed; no active connection was reopened')
  return {
    ok: true,
    value: { connectionId, credentialId, imported: newIds.includes(credentialId) }
  }
}

// ── ipc registration ───────────────────────────────────────────────────────

/** Wire the domain read/action channels. The app bootstrap (main/index.ts)
 *  calls this next to `registerRuntimeIpc`. */
export function registerDomainIpc(): void {
  ipcMain.handle('domain:usage.sources', (_e, request?: DomainUsageSourcesRequest) =>
    readUsageSources(isRecord(request) ? (request as DomainUsageSourcesRequest) : {})
  )
  ipcMain.handle('domain:usage.ledger', (_e, request?: DomainUsageLedgerRequest) =>
    readUsageLedger(isRecord(request) ? (request as DomainUsageLedgerRequest) : {})
  )
  ipcMain.handle('domain:usage.summaries', (_e, request?: DomainUsageSummaryRequest) =>
    readUsageSummaries(isRecord(request) ? (request as DomainUsageSummaryRequest) : {})
  )
  ipcMain.handle('domain:usage.statistics', (_e, request?: DomainUsageStatisticsRequest) =>
    readUsageStatistics(isRecord(request) ? (request as DomainUsageStatisticsRequest) : {})
  )
  ipcMain.handle('domain:sessions.list', (_e, request?: DomainSessionsRequest) =>
    readStoredSessions(isRecord(request) ? (request as DomainSessionsRequest) : {})
  )
  ipcMain.handle('domain:sessions.detail', (_e, sessionId: string) =>
    readSessionDetail(String(sessionId ?? ''))
  )
  ipcMain.handle('domain:collection.sources', () => readCollectionSources())
  ipcMain.handle('domain:collection.request', (_e, request?: DomainCollectionRequest) =>
    requestCollection(isRecord(request) ? (request as DomainCollectionRequest) : {})
  )
  ipcMain.handle('domain:usage.removeSource', (_e, connectionId: string) =>
    removeUsageSource(String(connectionId ?? ''))
  )
  ipcMain.handle('domain:auth.importFile', (_e, request: DomainAuthFileImportRequest) =>
    importAuthFile(request)
  )
  ipcMain.handle('domain:auth.start', (_e, request: DomainAuthStartRequest) => startAuth(request))
  ipcMain.handle('domain:auth.submitCode', (_e, request: DomainAuthSubmitCodeRequest) =>
    submitAuthCode(request)
  )
  ipcMain.handle('domain:auth.saveSecret', (_e, request: DomainAuthSecretRequest) =>
    submitAuthSecret(request)
  )
  ipcMain.handle('domain:auth.poll', (_e, flowId: string) => pollAuthFlow(String(flowId ?? '')))
  ipcMain.handle('domain:auth.status', (_e, flowId: string) => readAuthFlow(String(flowId ?? '')))
  ipcMain.handle('domain:auth.cancel', (_e, flowId: string) => cancelAuthFlow(String(flowId ?? '')))
  ipcMain.handle('domain:auth.refresh', (_e, request: DomainAuthRefreshRequest) =>
    refreshCredential(request)
  )
}
