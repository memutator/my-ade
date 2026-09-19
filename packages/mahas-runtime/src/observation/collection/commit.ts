import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { JsonObject } from '../../../../mahas-contracts/src/common.ts'
import {
  validatePackBoundaryPayload,
  type PackCollectionResult,
  type PackCollectionResultEnvelope,
  type PackUsageReadingObservation,
  type PackUsageAttributionHint
} from '../../../../mahas-contracts/src/integration/index.ts'
import type {
  CollectionBatch,
  CollectionCoverage,
  CollectionCursor,
  CollectionDiagnostic,
  CollectionSource,
  MeteringEvidenceRef,
  MeteringReading,
  QuotaReading,
  UsageAttribution,
  UsageModelRef,
  UsageReading,
  UsageTime
} from '../../../../mahas-contracts/src/metering/index.ts'
import type {
  HarnessSession,
  SessionAttachment,
  SessionEvent,
  SessionHandle,
  SessionNamespaceAlias
} from '../../../../mahas-contracts/src/sessions/index.ts'
import { getObservation, insertObservation } from '../facts.ts'
import { withTx } from '../../storage/transaction.ts'
import {
  putSessionAttachment,
  putSessionHandle,
  putSessionNamespaceAlias,
  upsertHarnessSession
} from '../../sessions/store.ts'
import { insertSessionEventObservation } from '../../sessions/observations.ts'
import {
  accountUsageReadingInTransaction,
  type UsageIngestIntent
} from '../../metering/usage/ledger.ts'
import { recordQuotaReadingInTransaction } from '../../metering/quota/store.ts'

export interface CollectedSessionEvent {
  event: SessionEvent
  sourceRecordKey: string
  sourceRecordRevision?: string | null
  payloadSchema?: string
}

export interface NormalizedCollectionRecords {
  observations?: readonly MeteringReading<JsonObject, string>[]
  sessions?: readonly HarnessSession[]
  namespaceAliases?: readonly SessionNamespaceAlias[]
  handles?: readonly SessionHandle[]
  attachments?: readonly SessionAttachment[]
  sessionEvents?: readonly CollectedSessionEvent[]
  usage?: readonly UsageIngestIntent[]
  quota?: readonly QuotaReading[]
}

export interface CommitCollectionBatchInput extends NormalizedCollectionRecords {
  source: CollectionSource
  batch: CollectionBatch
  expectedCheckpointRevision: number | null
  coverage: readonly CollectionCoverage[]
}

export interface CommitCollectionBatchResult {
  batchId: string
  replayed: boolean
  insertedObservations: number
  duplicateObservations: number
  cursor: CollectionCursor | null
  ledgerWatermark: number
}

/** Declared without constructor parameter properties so Node can run this module directly. */
export class CollectionCheckpointConflict extends Error {
  readonly sourceId: string
  readonly expected: number | null
  readonly actual: number | null

  constructor(sourceId: string, expected: number | null, actual: number | null) {
    super(`collection checkpoint conflict for ${sourceId}: expected ${expected}, actual ${actual}`)
    this.name = 'CollectionCheckpointConflict'
    this.sourceId = sourceId
    this.expected = expected
    this.actual = actual
  }
}

const json = (value: unknown): string => JSON.stringify(value ?? null)
const parse = <T>(text: string | null, fallback: T): T => {
  if (text === null) return fallback
  try { return JSON.parse(text) as T } catch { return fallback }
}

interface RawCursor {
  source_id: string; source_generation: string; collector_revision: string
  position_json: string; checkpoint_revision: number; last_committed_at: number | null
}

const mapCursor = (r: RawCursor): CollectionCursor => ({
  sourceId: r.source_id, sourceGeneration: r.source_generation,
  collectorRevision: r.collector_revision, position: parse(r.position_json, null),
  checkpointRevision: r.checkpoint_revision, lastCommittedAt: r.last_committed_at
})

export function getCollectionCursor(db: DatabaseSync, sourceId: string): CollectionCursor | null {
  const row = db.prepare('SELECT * FROM collection_cursors WHERE source_id=?').get(sourceId)
  return row ? mapCursor(row as unknown as RawCursor) : null
}

/** Status/time/generation may advance; stable source identity may not mutate. */
export function upsertCollectionSource(db: DatabaseSync, source: CollectionSource): void {
  const existing = db.prepare(
    'SELECT machine_id,subject_json,locator_json,kind FROM collection_sources WHERE id=?'
  ).get(source.id) as {
    machine_id: string; subject_json: string; locator_json: string; kind: string
  } | undefined
  if (existing && (existing.machine_id !== source.machineId || existing.kind !== source.kind ||
      existing.subject_json !== json(source.subject) || existing.locator_json !== json(source.locator))) {
    throw new Error(`collection source ${source.id} cannot change stable identity`)
  }
  db.prepare(
    `INSERT INTO collection_sources
       (id,machine_id,subject_json,locator_json,kind,source_generation,identity_evidence_json,status,
        first_observed_at,last_observed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       source_generation=excluded.source_generation,
       identity_evidence_json=excluded.identity_evidence_json,status=excluded.status,
       first_observed_at=MIN(collection_sources.first_observed_at,excluded.first_observed_at),
       last_observed_at=MAX(collection_sources.last_observed_at,excluded.last_observed_at)`
  ).run(source.id, source.machineId, json(source.subject), json(source.locator), source.kind,
    source.sourceGeneration, json(source.identityEvidence), source.status,
    source.firstObservedAt, source.lastObservedAt)
}

/**
 * A facet is the kind of fact one source record produced. Two facets may
 * legitimately share a record key (a row that is both a session and a usage
 * snapshot), and one usage record may carry several measurements that each get
 * their own reading — so identity is (facet, key, revision, discriminator)
 * rather than the record key alone.
 */
export type CollectionFacetKind = 'observation' | 'session-event' | 'usage' | 'quota'

function existingRecordObservation(
  db: DatabaseSync,
  sourceId: string,
  facet: CollectionFacetKind,
  sourceRecordKey: string,
  sourceRecordRevision?: string | null,
  recordDiscriminator = ''
): string | null {
  const row = db.prepare(
    `SELECT observation_id FROM observation_collection_facets
     WHERE source_id=? AND facet=? AND source_record_key=? AND source_record_revision=? AND
       record_discriminator=?`
  ).get(sourceId, facet, sourceRecordKey, sourceRecordRevision ?? '', recordDiscriminator) as
    | { observation_id: string }
    | undefined
  return row?.observation_id ?? null
}

function attachCollectionFacet(
  db: DatabaseSync,
  batch: CollectionBatch,
  facet: CollectionFacetKind,
  record: {
    observationId: string; sourceRecordKey: string; sourceRecordRevision?: string | null
    recordDiscriminator?: string; occurredAt?: number | null; payloadSchema: string
    evidence: unknown
  }
): void {
  db.prepare(
    `INSERT INTO observation_collection_facets
       (observation_id,batch_id,source_id,facet,source_record_key,source_record_revision,
        record_discriminator,occurred_at,payload_schema,evidence_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(record.observationId, batch.id, batch.sourceId, facet, record.sourceRecordKey,
    record.sourceRecordRevision ?? '', record.recordDiscriminator ?? '', record.occurredAt ?? null,
    record.payloadSchema, json(record.evidence))
}

function insertReading<TPayload extends object, TSchema extends string>(
  db: DatabaseSync,
  batch: CollectionBatch,
  facet: CollectionFacetKind,
  reading: MeteringReading<TPayload, TSchema>,
  recordDiscriminator = ''
): boolean {
  if (existingRecordObservation(db, batch.sourceId, facet, reading.sourceRecordKey,
      reading.sourceRecordRevision, recordDiscriminator)) return false
  const collision = getObservation(db, reading.observationId)
  if (collision) throw new Error(`observation id ${reading.observationId} has different provenance`)
  insertObservation(db, {
    id: reading.observationId, executionId: null, dispatchId: null, source: 'service',
    factType: reading.payloadSchema, observedAt: reading.observedAt, payload: reading.payload,
    identityEvidence: { collectionSourceId: batch.sourceId, facet, evidence: reading.evidence }
  })
  attachCollectionFacet(db, batch, facet, {
    observationId: reading.observationId, sourceRecordKey: reading.sourceRecordKey,
    sourceRecordRevision: reading.sourceRecordRevision, recordDiscriminator,
    occurredAt: reading.occurredAt, payloadSchema: reading.payloadSchema,
    evidence: reading.evidence
  })
  return true
}

function insertCollectedSessionEvent(
  db: DatabaseSync,
  batch: CollectionBatch,
  collected: CollectedSessionEvent
): boolean {
  if (existingRecordObservation(db, batch.sourceId, 'session-event', collected.sourceRecordKey,
      collected.sourceRecordRevision)) return false
  insertSessionEventObservation(db, collected.event)
  attachCollectionFacet(db, batch, 'session-event', {
    observationId: collected.event.observationId,
    sourceRecordKey: collected.sourceRecordKey,
    sourceRecordRevision: collected.sourceRecordRevision,
    occurredAt: collected.event.occurredAt,
    payloadSchema: collected.payloadSchema ?? 'mahas.session-event/v1',
    evidence: collected.event.evidence
  })
  return true
}

function currentLedgerWatermark(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM usage_ledger_changes').get() as {
    n: number
  }
  return row.n
}

function commitInner(db: DatabaseSync, input: CommitCollectionBatchInput): CommitCollectionBatchResult {
  const existingBatch = db.prepare(
    `SELECT source_id,source_generation,adapter_pack_id,adapter_pack_revision,
            integration_contract_id,contract_revision,cursor_after_json
     FROM collection_batches WHERE id=?`
  ).get(input.batch.id) as {
    source_id: string; source_generation: string; adapter_pack_id: string
    adapter_pack_revision: number; integration_contract_id: string; contract_revision: number
    cursor_after_json: string | null
  } | undefined
  if (existingBatch) {
    if (existingBatch.source_id !== input.source.id ||
        existingBatch.source_generation !== input.batch.sourceGeneration ||
        existingBatch.adapter_pack_id !== input.batch.adapterPackId ||
        existingBatch.adapter_pack_revision !== input.batch.adapterPackRevision ||
        existingBatch.integration_contract_id !== input.batch.integrationContractId ||
        existingBatch.contract_revision !== input.batch.contractRevision ||
        existingBatch.cursor_after_json !== (input.batch.cursorAfter == null ? null : json(input.batch.cursorAfter))) {
      throw new Error('batch id replay does not match the committed batch')
    }
    return {
      batchId: input.batch.id, replayed: true, insertedObservations: 0,
      duplicateObservations: 0, cursor: getCollectionCursor(db, input.source.id),
      ledgerWatermark: currentLedgerWatermark(db)
    }
  }
  if (input.batch.sourceId !== input.source.id ||
      input.batch.sourceGeneration !== input.source.sourceGeneration) {
    throw new Error('batch source identity/generation does not match collection source')
  }
  upsertCollectionSource(db, input.source)
  const current = getCollectionCursor(db, input.source.id)
  const actual = current?.checkpointRevision ?? null
  if (actual !== input.expectedCheckpointRevision) {
    throw new CollectionCheckpointConflict(input.source.id, input.expectedCheckpointRevision, actual)
  }
  if (input.batch.cursorBefore && (input.batch.cursorBefore.checkpointRevision !== actual ||
      (current !== null && input.batch.cursorBefore.sourceGeneration !== current.sourceGeneration))) {
    throw new CollectionCheckpointConflict(input.source.id,
      input.batch.cursorBefore.checkpointRevision, actual)
  }
  if (input.batch.result === 'failed' && input.batch.cursorAfter) {
    throw new Error('failed collection batch cannot advance its cursor')
  }
  if (input.batch.result === 'cancelled' && input.batch.cursorAfter) {
    throw new Error('cancelled collection batch cannot advance its cursor')
  }
  if ((input.batch.result === 'committed' || input.batch.result === 'partial') &&
      typeof input.batch.committedAt !== 'number') {
    throw new Error('a committed or partial batch must record committedAt')
  }
  if (typeof input.batch.committedAt === 'number' &&
      input.batch.committedAt < input.batch.startedAt) {
    throw new Error('batch committedAt precedes startedAt')
  }
  // A usage entry with no coverage cannot be placed in any accounted range, and
  // a reference to a coverage row nobody wrote makes the entry unjoinable.
  const batchCoverage = new Set(input.coverage.map((c) => c.id))
  for (const intent of input.usage ?? []) {
    if (intent.coverage.length === 0) {
      throw new Error(`usage intent ${intent.accountingKey} requires at least one coverage reference`)
    }
    for (const ref of intent.coverage) {
      if (batchCoverage.has(ref.coverageId)) continue
      const known = db.prepare('SELECT 1 AS present FROM collection_coverage WHERE id=?')
        .get(ref.coverageId)
      if (!known) {
        throw new Error(`usage coverage ${ref.coverageId} is neither in this batch nor stored`)
      }
    }
  }
  const malformed = input.batch.diagnostics.some((d) => d.severity === 'error' && d.sourceRecordKey)
  if (malformed && !input.coverage.some((c) => c.completeness === 'gap' || c.completeness === 'partial')) {
    throw new Error('malformed complete records require explicit partial/gap coverage')
  }
  db.prepare(
    `INSERT INTO collection_batches
       (id,source_id,source_generation,adapter_pack_id,adapter_pack_revision,
        integration_contract_id,contract_revision,cursor_before_json,cursor_after_json,started_at,
        committed_at,result,diagnostics_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(input.batch.id, input.batch.sourceId, input.batch.sourceGeneration,
    input.batch.adapterPackId, input.batch.adapterPackRevision, input.batch.integrationContractId,
    input.batch.contractRevision, input.batch.cursorBefore == null ? null : json(input.batch.cursorBefore),
    input.batch.cursorAfter == null ? null : json(input.batch.cursorAfter), input.batch.startedAt,
    input.batch.committedAt ?? null, input.batch.result, json(input.batch.diagnostics))

  for (const session of input.sessions ?? []) upsertHarnessSession(db, session)
  for (const alias of input.namespaceAliases ?? []) putSessionNamespaceAlias(db, alias)
  for (const handle of input.handles ?? []) putSessionHandle(db, handle)
  for (const attachment of input.attachments ?? []) putSessionAttachment(db, attachment)

  let inserted = 0
  let duplicates = 0
  for (const reading of input.observations ?? []) {
    if (insertReading(db, input.batch, 'observation', reading)) inserted += 1
    else duplicates += 1
  }
  for (const event of input.sessionEvents ?? []) {
    if (insertCollectedSessionEvent(db, input.batch, event)) inserted += 1
    else duplicates += 1
  }
  for (const intent of input.usage ?? []) {
    const reading: UsageReading = intent.reading
    if (insertReading(db, input.batch, 'usage', reading, reading.payload.measurementKey)) {
      inserted += 1
      accountUsageReadingInTransaction(db, intent)
    } else {
      duplicates += 1
    }
  }
  for (const reading of input.quota ?? []) {
    if (existingRecordObservation(db, input.batch.sourceId, 'quota', reading.sourceRecordKey,
      reading.sourceRecordRevision)) {
      duplicates += 1
      continue
    }
    recordQuotaReadingInTransaction(db, reading)
    attachCollectionFacet(db, input.batch, 'quota', reading)
    inserted += 1
  }
  for (const coverage of input.coverage) {
    if (coverage.sourceId != null && coverage.sourceId !== input.source.id) {
      throw new Error(`coverage ${coverage.id} belongs to another source`)
    }
    db.prepare(
      `INSERT INTO collection_coverage
         (id,batch_id,source_id,subject_json,interval_json,completeness,gap_reason,
          last_success_at,watermark)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(coverage.id, input.batch.id, coverage.sourceId ?? null, json(coverage.subject),
      coverage.interval == null ? null : json(coverage.interval), coverage.completeness,
      coverage.gapReason ?? null, coverage.lastSuccessAt ?? null, coverage.watermark ?? null)
  }
  if (input.batch.cursorAfter) {
    const after = input.batch.cursorAfter
    if (after.sourceId !== input.source.id || after.sourceGeneration !== input.source.sourceGeneration ||
        after.checkpointRevision !== (actual ?? 0) + 1) {
      throw new Error('cursorAfter must advance the same source/generation by exactly one revision')
    }
    if (current) {
      const changed = db.prepare(
        `UPDATE collection_cursors SET source_generation=?,collector_revision=?,position_json=?,
           checkpoint_revision=?,last_committed_at=?
         WHERE source_id=? AND checkpoint_revision=?`
      ).run(after.sourceGeneration, after.collectorRevision, json(after.position),
        after.checkpointRevision, after.lastCommittedAt ?? input.batch.committedAt ?? null,
        after.sourceId, actual).changes
      if (changed !== 1) throw new CollectionCheckpointConflict(after.sourceId, actual, null)
    } else {
      db.prepare(
        `INSERT INTO collection_cursors
           (source_id,source_generation,collector_revision,position_json,checkpoint_revision,last_committed_at)
         VALUES (?,?,?,?,?,?)`
      ).run(after.sourceId, after.sourceGeneration, after.collectorRevision, json(after.position),
        after.checkpointRevision, after.lastCommittedAt ?? input.batch.committedAt ?? null)
    }
  }
  return {
    batchId: input.batch.id, replayed: false, insertedObservations: inserted,
    duplicateObservations: duplicates, cursor: getCollectionCursor(db, input.source.id),
    ledgerWatermark: currentLedgerWatermark(db)
  }
}

/** Batch, facts, ledger intent and checkpoint are one durable commit. */
export function commitCollectionBatch(
  db: DatabaseSync,
  input: CommitCollectionBatchInput
): CommitCollectionBatchResult {
  return withTx(db, (tx) => commitInner(tx, input))
}

export interface CommitPackCollectionInput {
  result: PackCollectionResultEnvelope
  source: CollectionSource
  batch: CollectionBatch
  expectedCheckpointRevision: number | null
  /** Trusted request context. Pack output cannot select another installation. */
  installationId: string
}

const stableId = (prefix: string, ...parts: readonly string[]): string =>
  `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex')}`

const evidenceRefs = (
  sourceId: string,
  sourceRecordKey: string,
  evidence: readonly { sourceRecordKey?: string; description?: string; data?: JsonObject }[]
): MeteringEvidenceRef[] => evidence.map((item) => ({
  sourceId,
  sourceRecordKey: item.sourceRecordKey ?? sourceRecordKey,
  ...(item.description === undefined ? {} : { description: item.description }),
  ...(item.data === undefined ? {} : { data: item.data })
}))

/**
 * Identity for a record whose Pack gave no revision. Re-reading unchanged
 * content keeps the same revision (deduplicated), while changed content becomes
 * a new revision that the ledger accounts as a correction of that lineage
 * instead of silently dropping the update.
 */
function derivedRecordRevision(record: PackUsageReadingObservation): string {
  const material = JSON.stringify({
    mode: record.mode, counterScope: record.counterScope ?? null,
    counterEpoch: record.counterEpoch ?? null, values: record.values,
    timeCoverage: record.timeCoverage, completeness: record.semantics.completeness,
    relations: record.semantics.componentRelations,
    reportedTotal: record.semantics.reportedTotal ?? null
  })
  return 'content:' + createHash('sha256').update(material).digest('hex').slice(0, 32)
}

interface InstallationContext {
  id: string
  machineId: string
  harnessId: string
  dataNamespace: string
}

function installationContext(db: DatabaseSync, id: string): InstallationContext {
  const row = db.prepare(
    `SELECT id,machine_id,harness_id,data_namespace FROM inventory_installations WHERE id=?`
  ).get(id) as { id: string; machine_id: string; harness_id: string; data_namespace: string } | undefined
  if (!row) throw new Error(`unknown collection installation ${id}`)
  return { id: row.id, machineId: row.machine_id, harnessId: row.harness_id,
    dataNamespace: row.data_namespace }
}

/** Installation qualification prevents two installs of one harness sharing native ids/counters. */
const nativeNamespace = (installation: InstallationContext, namespace: string): string =>
  `installation:${installation.id}:${installation.dataNamespace}:${namespace}`

/**
 * Session identity for a collector record that has no stored row yet.
 *
 * NOTE (documented, not yet refactored): `recovery/session-handles.ts`
 * (`stableSessionId`) and `sessions/desktop-import.ts` reproduce this same
 * hash formula for their own recovery paths. The three must stay
 * byte-identical — same prefix, same `installation:<id>:<dataNamespace>:<ns>`
 * qualification, NUL separator — or recovery stops resolving the sessions the
 * collector stored. Consolidating them into one helper is a separate change
 * owned by whoever takes recovery; until then this is the collector-side copy.
 */
function resolveSessionId(
  db: DatabaseSync,
  installation: InstallationContext,
  namespace: string,
  nativeKey: string
): string {
  const qualified = nativeNamespace(installation, namespace)
  const direct = db.prepare(
    'SELECT id FROM harness_sessions WHERE harness_id=? AND namespace=? AND native_session_key=?'
  ).get(installation.harnessId, qualified, nativeKey) as { id: string } | undefined
  if (direct) return direct.id
  const alias = db.prepare(
    `SELECT session_id AS id FROM session_namespace_aliases
     WHERE harness_id=? AND namespace=? AND native_session_key=?`
  ).get(installation.harnessId, qualified, nativeKey) as { id: string } | undefined
  return alias?.id ?? stableId('session', installation.harnessId, qualified, nativeKey)
}

/** Candidate session ids for one native key inside this installation's scope. */
function lookupNativeSessions(
  db: DatabaseSync,
  installation: InstallationContext,
  batchSessions: ReadonlyMap<string, string>,
  nativeKey: string
): string[] {
  const fromBatch = batchSessions.get(nativeKey)
  if (fromBatch) return [fromBatch]
  const rows = db.prepare(
    `SELECT DISTINCT s.id FROM harness_sessions s
     LEFT JOIN session_handles h ON h.session_id=s.id
     WHERE s.harness_id=? AND (s.native_session_key=? OR h.native_id=?) AND
       (h.installation_id IS NULL OR h.installation_id=?) LIMIT 2`
  ).all(installation.harnessId, nativeKey, nativeKey, installation.id) as unknown as { id: string }[]
  return rows.map((row) => row.id)
}

function resolveExistingSessionByNativeKey(
  db: DatabaseSync,
  installation: InstallationContext,
  batchSessions: ReadonlyMap<string, string>,
  nativeKey: string
): string {
  const ids = lookupNativeSessions(db, installation, batchSessions, nativeKey)
  if (ids.length !== 1) throw new Error(
    ids.length === 0 ? `unknown native session ${nativeKey}` : `ambiguous native session ${nativeKey}`
  )
  return ids[0]!
}

/**
 * Parent links may point outside what this batch collected. Returning the
 * candidate count lets the caller keep the row and record a warning rather
 * than failing the whole batch or inventing a parent session.
 */
function resolveParentSession(
  db: DatabaseSync,
  installation: InstallationContext,
  batchSessions: ReadonlyMap<string, string>,
  nativeKey: string
): { id: string | null; candidates: number } {
  const ids = lookupNativeSessions(db, installation, batchSessions, nativeKey)
  return { id: ids.length === 1 ? ids[0]! : null, candidates: ids.length }
}

interface AliasResolution {
  aliasId: string
  modelId: string
  validFrom: number
  validUntil: number | null
  confidence: string
}

/**
 * Catalog alias resolution at the time the usage happened. A mapping that was
 * not valid at that instant is not applied — yesterday's usage is never
 * rewritten with today's alias mapping.
 */
function resolveModelAlias(
  db: DatabaseSync,
  namespace: string,
  nativeName: string,
  at: number
): AliasResolution | null {
  const row = db.prepare(
    `SELECT a.id AS alias_id, r.model_id, r.valid_from, r.valid_until, r.confidence
     FROM catalog_native_model_aliases a
     JOIN catalog_model_alias_resolutions r ON r.alias_id=a.id
     WHERE a.native_name=? AND a.namespace_id=? AND r.valid_from<=? AND
       (r.valid_until IS NULL OR r.valid_until>=?)
     ORDER BY CASE WHEN a.namespace_kind='harness' THEN 0 ELSE 1 END, r.valid_from DESC,
       r.revision DESC LIMIT 1`
  ).get(nativeName, namespace, at, at) as
    | { alias_id: string; model_id: string; valid_from: number; valid_until: number | null
        confidence: string }
    | undefined
  return row
    ? { aliasId: row.alias_id, modelId: row.model_id, validFrom: row.valid_from,
        validUntil: row.valid_until, confidence: row.confidence }
    : null
}

/**
 * A native model reference keeps the reported name even when no mapping is
 * known: the unresolved axis stays null instead of being guessed, and a
 * declared id must agree with the catalog resolution that applied at the time.
 */
function modelRef(
  db: DatabaseSync,
  sourceId: string,
  value: unknown,
  field: string,
  at: number
): UsageModelRef | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  const raw = value as Record<string, unknown>
  if (typeof raw.nativeName !== 'string' || !raw.nativeName ||
      typeof raw.namespace !== 'string' || !raw.namespace) {
    throw new Error(`${field} requires explicit nativeName and namespace`)
  }
  const declaredModelId = typeof raw.modelId === 'string' && raw.modelId ? raw.modelId : null
  const declaredAliasId = typeof raw.aliasId === 'string' && raw.aliasId ? raw.aliasId : null
  if (declaredModelId && !db.prepare('SELECT 1 AS present FROM catalog_inference_models WHERE id=?')
      .get(declaredModelId)) {
    throw new Error(`${field} names unknown inference model ${declaredModelId}`)
  }
  if (declaredAliasId &&
      !db.prepare('SELECT 1 AS present FROM catalog_native_model_aliases WHERE id=?')
        .get(declaredAliasId)) {
    throw new Error(`${field} names unknown native model alias ${declaredAliasId}`)
  }
  const resolved = resolveModelAlias(db, raw.namespace, raw.nativeName, at)
  if (resolved && declaredModelId && resolved.modelId !== declaredModelId) {
    throw new Error(`${field} conflicts with the catalog alias resolution for ${raw.nativeName}`)
  }
  const ref: UsageModelRef = { nativeName: raw.nativeName, namespace: raw.namespace }
  const aliasId = declaredAliasId ?? resolved?.aliasId ?? null
  const modelId = declaredModelId ?? resolved?.modelId ?? null
  if (aliasId) ref.aliasId = aliasId
  if (modelId) ref.modelId = modelId
  if (resolved) {
    ref.mappingEvidence = [{
      sourceId,
      description: `catalog alias ${resolved.aliasId} -> ${resolved.modelId} ` +
        `(${resolved.confidence}, valid ${resolved.validFrom}..${resolved.validUntil ?? 'open'})`
    }]
  }
  return ref
}

function attributionFromHint(
  db: DatabaseSync,
  sourceId: string,
  hint: PackUsageAttributionHint,
  /** usage time when known, otherwise the observation time */
  at: number
): Omit<UsageAttribution, 'entryId' | 'revision' | 'validFromRevision'> {
  const connectionId: string | null = hint.connectionId ?? null
  let offeringId: string | null = hint.offeringId ?? null
  let providerId: string | null = hint.providerId ?? null
  if (connectionId) {
    const row = db.prepare(
      `SELECT c.offering_id,o.provider_id FROM inventory_provider_connections c
       JOIN catalog_offerings o ON o.id=c.offering_id WHERE c.id=?`
    ).get(connectionId) as { offering_id: string; provider_id: string } | undefined
    if (!row) throw new Error(`unknown attribution connection ${connectionId}`)
    if (offeringId && offeringId !== row.offering_id) throw new Error('attribution offering conflicts with connection')
    if (providerId && providerId !== row.provider_id) throw new Error('attribution provider conflicts with connection')
    offeringId = null
    providerId = null
  } else if (offeringId) {
    const row = db.prepare('SELECT provider_id FROM catalog_offerings WHERE id=?').get(offeringId) as
      { provider_id: string } | undefined
    if (!row) throw new Error(`unknown attribution offering ${offeringId}`)
    if (providerId && providerId !== row.provider_id) throw new Error('attribution provider conflicts with offering')
    providerId = null
  } else if (providerId && !db.prepare('SELECT 1 FROM catalog_providers WHERE id=?').get(providerId)) {
    throw new Error(`unknown attribution provider ${providerId}`)
  }
  // A confidence claim without evidence would outrank what the collector saw.
  if ((hint.confidence === 'verified' || hint.confidence === 'observed') && hint.evidence.length === 0) {
    throw new Error(`attribution hint ${hint.sourceRecordKey} claims ${hint.confidence} with no evidence`)
  }
  return {
    connectionId, offeringId, providerId, credentialId: null,
    requestedModel: modelRef(db, sourceId, hint.requestedModel, 'requestedModel', at),
    servedModel: modelRef(db, sourceId, hint.servedModel, 'servedModel', at),
    executionId: null, dispatchId: null, basis: hint.basis,
    evidence: evidenceRefs(sourceId, hint.sourceRecordKey, hint.evidence),
    status: hint.confidence
  }
}

function normalizePackPayload(
  db: DatabaseSync,
  input: CommitPackCollectionInput,
  payload: PackCollectionResult
): NormalizedCollectionRecords & {
  coverage: readonly CollectionCoverage[]
  diagnostics: readonly CollectionDiagnostic[]
} {
  const issues = validatePackBoundaryPayload('collection', 'response', payload)
  if (issues.length) throw new Error(`invalid Pack collection payload: ${issues[0]!.path} ${issues[0]!.message}`)
  const installation = installationContext(db, input.installationId)
  if (input.source.subject.kind === 'installation' &&
      input.source.subject.installationId !== installation.id) {
    throw new Error('collection source belongs to another installation')
  }
  const coverageId = stableId('coverage', input.batch.id)
  const coverage: CollectionCoverage = {
    id: coverageId, sourceId: input.source.id, subject: input.source.subject,
    interval: payload.coverage.interval ?? null, completeness: payload.coverage.completeness,
    gapReason: payload.coverage.gapReason ?? null,
    lastSuccessAt: payload.coverage.completeness === 'complete' ? input.result.completedAt : null,
    watermark: payload.coverage.watermark ?? null
  }

  const diagnostics: CollectionDiagnostic[] = []
  const seenSessionNative = new Map<string, string>()
  const sessionRows: HarnessSession[] = payload.sessions.map((record) => {
    if (record.harnessId !== installation.harnessId) throw new Error('Pack session harness conflicts with installation')
    const namespace = nativeNamespace(installation, record.namespace)
    const id = resolveSessionId(db, installation, record.namespace, record.nativeSessionKey)
    const prior = seenSessionNative.get(record.nativeSessionKey)
    if (prior && prior !== id) throw new Error(`ambiguous batch native session ${record.nativeSessionKey}`)
    seenSessionNative.set(record.nativeSessionKey, id)
    return { id, harnessId: installation.harnessId,
      originMachineId: record.originMachineId ?? installation.machineId, namespace,
      nativeSessionKey: record.nativeSessionKey, parentSessionId: null,
      title: record.title ?? null, firstObservedAt: record.firstObservedAt,
      lastObservedAt: record.lastObservedAt, metadata: record.metadata }
  })
  // A child session whose parent lives in another installation (or was never
  // collected) is still stored as evidence: the parent link stays unresolved and
  // the native key is preserved instead of inventing a session row.
  payload.sessions.forEach((record, index) => {
    const nativeParent = record.parentNativeSessionKey
    if (!nativeParent) return
    const resolved = resolveParentSession(db, installation, seenSessionNative, nativeParent)
    if (resolved.id) {
      sessionRows[index]!.parentSessionId = resolved.id
      return
    }
    const row = sessionRows[index]!
    row.metadata = { ...row.metadata, unresolvedParentNativeSessionKey: nativeParent }
    diagnostics.push({
      code: resolved.candidates === 0 ? 'unresolved-parent-session' : 'ambiguous-parent-session',
      severity: 'warning',
      message: `parent session ${nativeParent} matches ${resolved.candidates} stored sessions`,
      sourceRecordKey: record.sourceRecordKey
    })
  })

  const handles = payload.handles.map((record) => ({
    id: stableId('handle', input.source.id, record.sourceRecordKey),
    sessionId: resolveExistingSessionByNativeKey(db, installation, seenSessionNative, record.sessionNativeKey),
    installationId: record.installationId ?? installation.id, nativeId: record.nativeId,
    locator: record.locator ?? null, resumeSupport: record.resumeSupport,
    observedAt: record.observedAt,
    evidence: evidenceRefs(input.source.id, record.sourceRecordKey, record.evidence)
  }))
  if (handles.some((h) => h.installationId !== installation.id)) {
    throw new Error('Pack handle installation conflicts with collection installation')
  }
  const attachmentByRecord = new Map<string, string>()
  const attachments = payload.attachments.map((record) => {
    const id = stableId('attachment', input.source.id, record.sourceRecordKey)
    attachmentByRecord.set(record.sourceRecordKey, id)
    return { id,
      sessionId: resolveExistingSessionByNativeKey(db, installation, seenSessionNative, record.sessionNativeKey),
      installationId: record.installationId ?? installation.id, machineId: record.machineId,
      processIdentity: record.processIdentity ?? null, executionId: record.executionId ?? null,
      dispatchId: null, observedFrom: record.observedFrom, observedUntil: record.observedUntil ?? null,
      evidence: evidenceRefs(input.source.id, record.sourceRecordKey, record.evidence) }
  })
  if (attachments.some((a) => a.installationId !== installation.id)) {
    throw new Error('Pack attachment installation conflicts with collection installation')
  }

  const events = payload.events.map((record) => {
    // An event that names an attachment must name one this batch created or the
    // store already holds: a dangling link would silently detach the event from
    // the process incarnation it documents.
    let attachmentId: string | null = null
    if (record.attachmentSourceRecordKey) {
      attachmentId = attachmentByRecord.get(record.attachmentSourceRecordKey) ??
        stableId('attachment', input.source.id, record.attachmentSourceRecordKey)
      const stored = db.prepare('SELECT 1 AS present FROM session_attachments WHERE id=?')
        .get(attachmentId)
      if (!stored) {
        throw new Error(`session event ${record.sourceRecordKey} references unknown attachment ` +
          record.attachmentSourceRecordKey)
      }
    }
    return {
      sourceRecordKey: record.sourceRecordKey,
      event: {
        observationId: stableId('observation', input.source.id, record.sourceRecordKey, ''),
        sessionId: record.sessionNativeKey
          ? resolveExistingSessionByNativeKey(db, installation, seenSessionNative,
              record.sessionNativeKey)
          : null,
        attachmentId,
        kind: record.kind, nativeKind: record.nativeKind,
        nativeTurnId: record.nativeTurnId ?? null,
        occurredAt: record.occurredAt ?? null, observedAt: record.observedAt, origin: record.origin,
        payload: record.payload,
        evidence: evidenceRefs(input.source.id, record.sourceRecordKey, record.evidence)
      }
    }
  })

  const hints = new Map<string, PackUsageAttributionHint>()
  for (const hint of payload.usageAttributionHints) {
    if (hints.has(hint.sourceRecordKey)) throw new Error(`duplicate attribution hint ${hint.sourceRecordKey}`)
    hints.set(hint.sourceRecordKey, hint)
  }
  const tokenKeys = new Set<string>([
    'inputTotal', 'outputTotal', 'total', 'cacheReadInput', 'cacheWriteInput', 'reasoningOutput'
  ])
  const usage = payload.usageReadings.map((record): UsageIngestIntent => {
    const revision = record.sourceRecordRevision ?? derivedRecordRevision(record)
    const sessionId = record.sessionNativeKey
      ? resolveExistingSessionByNativeKey(db, installation, seenSessionNative, record.sessionNativeKey) : null
    for (const relation of record.semantics.componentRelations) {
      if (!tokenKeys.has(relation.component) || !tokenKeys.has(relation.other)) {
        throw new Error(`usage semantics names an unknown component for ${record.sourceRecordKey}`)
      }
    }
    if (record.mode === 'cumulative' && (!record.counterScope || !record.counterEpoch)) {
      throw new Error(`cumulative reading ${record.sourceRecordKey} requires counterScope and counterEpoch`)
    }
    const at = record.timeCoverage.kind === 'point'
      ? record.timeCoverage.at
      : input.result.completedAt
    // One source record can carry several measurements; each measurement is its
    // own counter lineage and its own ledger entry.
    const accountingKey = `${record.sourceRecordKey}#${record.measurementKey}`
    const overlap = record.overlap
    const evidence: MeteringEvidenceRef[] = [
      { sourceId: input.source.id, sourceRecordKey: record.sourceRecordKey }
    ]
    if (overlap && (overlap.relation !== 'direct' || overlap.counterpartSourceRecordKey)) {
      evidence.push({
        sourceId: input.source.id,
        sourceRecordKey: overlap.counterpartSourceRecordKey ?? record.sourceRecordKey,
        description: `usage overlap ${overlap.relation}` +
          (overlap.reason === undefined ? '' : `: ${overlap.reason}`)
      })
    }
    let scopeKey = overlap?.scopeKey ?? (record.mode === 'cumulative'
      ? (record.counterScope as string)
      : accountingKey)
    if (overlap?.scope === 'session' && overlap.scopeKey) {
      scopeKey = resolveExistingSessionByNativeKey(db, installation, seenSessionNative,
        overlap.scopeKey)
    }
    const reading: UsageReading = {
      observationId: stableId('observation', input.source.id, record.sourceRecordKey, revision,
        record.measurementKey),
      batchId: input.batch.id, sourceRecordKey: record.sourceRecordKey,
      sourceRecordRevision: revision,
      observedAt: input.result.completedAt,
      occurredAt: record.timeCoverage.kind === 'point' ? record.timeCoverage.at : null,
      payloadSchema: 'mahas.usage-reading/v1', evidence,
      payload: { sessionId, measurementKey: record.measurementKey, mode: record.mode,
        counterScope: record.counterScope ?? null, counterEpoch: record.counterEpoch ?? null,
        values: record.values, semantics: record.semantics as UsageReading['payload']['semantics'],
        timeCoverage: record.timeCoverage as UsageTime,
        sourceEvidence: record.sourceEvidence }
    }
    const hint = hints.get(record.sourceRecordKey)
    hints.delete(record.sourceRecordKey)
    return { reading, harnessId: installation.harnessId, installationId: installation.id,
      originMachineId: installation.machineId,
      accountingNamespace: nativeNamespace(installation, 'usage'),
      accountingKey,
      coverage: [{ coverageId,
        scope: overlap?.scope ?? (record.mode === 'cumulative' ? 'counter' : 'request'),
        scopeKey, relation: overlap?.relation ?? 'direct' }],
      streamRole: 'primary',
      counterEpochRelation: record.counterEpochRelation,
      counterEpochEvidence: evidenceRefs(input.source.id, record.sourceRecordKey,
        record.counterEpochEvidence ?? []),
      attribution: hint ? attributionFromHint(db, input.source.id, hint, at) : null,
      createdAt: input.result.completedAt }
  })
  if (hints.size) throw new Error(`attribution hint has no usage reading: ${hints.keys().next().value}`)

  const observations = payload.observations.map((record): MeteringReading<JsonObject, string> => ({
    observationId: stableId('observation', input.source.id, record.sourceRecordKey,
      record.sourceRecordRevision ?? ''), batchId: input.batch.id,
    sourceRecordKey: record.sourceRecordKey, sourceRecordRevision: record.sourceRecordRevision ?? null,
    observedAt: input.result.completedAt, occurredAt: record.occurredAt ?? null,
    payloadSchema: record.payloadSchema, payload: record.payload,
    evidence: evidenceRefs(input.source.id, record.sourceRecordKey, record.evidence)
  }))
  const quota = payload.quotaReadings.map((record): QuotaReading => ({
    observationId: stableId('observation', input.source.id, record.sourceRecordKey, ''),
    batchId: input.batch.id, sourceRecordKey: record.sourceRecordKey, sourceRecordRevision: null,
    observedAt: record.observedAt, occurredAt: record.providerMeasuredAt ?? null,
    payloadSchema: 'mahas.quota-reading/v1', evidence: [{ sourceId: input.source.id,
      sourceRecordKey: record.sourceRecordKey }],
    payload: { connectionId: record.connectionId, observedAt: record.observedAt,
      providerMeasuredAt: record.providerMeasuredAt ?? null,
      identityClaims: record.identityClaims as never, planClaims: record.planClaims as never,
      meters: record.meters as never, entitlements: record.entitlements as never,
      status: record.status, diagnostics: payload.diagnostics, sourceEvidence: record.sourceEvidence }
  }))
  return { observations, sessions: sessionRows, handles, attachments, sessionEvents: events,
    usage, quota, coverage: [coverage], diagnostics }
}

/** Envelope status → the batch result it is allowed to commit. */
const BATCH_RESULT_BY_PACK_STATUS = {
  success: 'committed', partial: 'partial', failed: 'failed', cancelled: 'cancelled',
  'timed-out': 'failed'
} as const satisfies Record<PackCollectionResultEnvelope['status'], CollectionBatch['result']>

function mergeDiagnostics(
  groups: readonly (readonly CollectionDiagnostic[] | undefined)[]
): CollectionDiagnostic[] {
  const out: CollectionDiagnostic[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const item of group ?? []) {
      const key = [item.code, item.severity, item.message, item.sourceRecordKey ?? ''].join('\u0000')
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

/**
 * Generic Pack seam: validated wire result, normalized facts and checkpoint
 * commit atomically. Safe to call inside an already-open transaction (the
 * scheduler's serialized DB unit) — the nested withTx() degrades to a savepoint.
 */
export function commitPackCollectionResultInTransaction(
  db: DatabaseSync,
  input: CommitPackCollectionInput
): CommitCollectionBatchResult {
  if (!input.result.payload) throw new Error('Pack result has no collection payload')
  const expected = BATCH_RESULT_BY_PACK_STATUS[input.result.status]
  const compatible = input.batch.result === expected ||
    (expected === 'committed' && input.batch.result === 'partial')
  if (!compatible) {
    throw new Error(`Pack result status ${input.result.status} cannot commit a batch reported as ` +
      input.batch.result)
  }
  const records = normalizePackPayload(db, input, input.result.payload)
  return commitCollectionBatch(db, {
    ...records, source: input.source,
    batch: {
      ...input.batch,
      diagnostics: mergeDiagnostics([input.batch.diagnostics, input.result.diagnostics,
        input.result.payload.diagnostics, records.diagnostics])
    },
    expectedCheckpointRevision: input.expectedCheckpointRevision, coverage: records.coverage
  })
}

export function commitPackCollectionResult(
  db: DatabaseSync,
  input: CommitPackCollectionInput
): CommitCollectionBatchResult {
  return withTx(db, (tx) => commitPackCollectionResultInTransaction(tx, input))
}
