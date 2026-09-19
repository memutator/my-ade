// Pack collection → atomic ledger commit fixtures.
//
// Covers the acceptance cases that only exist on the strict Pack seam:
//   · two installations of one harness reporting the same native keys
//   · exact batch replay, and a failed commit that rolls back completely
//   · source loss that keeps the collected ledger and records a coverage gap
//   · foreign and child sessions preserved without creating Tasks/Executions
//   · overlap accounting, alias/evidence attribution and cursor validation
//   · the durable collection request queue and its operation surface
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import type {
  PackCollectionResult,
  PackCollectionResultEnvelope,
  PackSessionAttachmentObservation,
  PackSessionEventObservation,
  PackSessionObservation,
  PackUsageAttributionHint,
  PackUsageReadingObservation
} from '../../../../mahas-contracts/src/integration/index.ts'
import type {
  CollectionBatch,
  CollectionDiagnostic,
  CollectionSource
} from '../../../../mahas-contracts/src/metering/index.ts'
import { CATALOG_SCHEMA_SQL } from '../../catalog/migration.ts'
import { INVENTORY_SCHEMA_SQL } from '../../inventory/migration.ts'
import type { JsonObject } from '../../../../mahas-contracts/src/common.ts'
import type { HarnessSession } from '../../../../mahas-contracts/src/sessions/index.ts'
import { getHarnessSession, upsertHarnessSession } from '../../sessions/store.ts'
import { SESSION_SCHEMA_SQL } from '../../sessions/migrations.ts'
import { USAGE_SCHEMA_SQL } from '../../metering/usage/migrations.ts'
import { getUsageAttribution } from '../../metering/usage/ledger.ts'
import { COLLECTION_SCHEMA_SQL } from './migrations.ts'
import { commitPackCollectionResult, getCollectionCursor } from './commit.ts'
import type { CommitCollectionBatchResult, CommitPackCollectionInput } from './commit.ts'
import { getCollectionStatus, listCollectionBatches } from './query.ts'
import {
  cancelCollectionRequest,
  claimCollectionRequests,
  completeCollectionRequest,
  listCollectionRequests,
  requestCollection
} from './requests.ts'
import { COLLECTION_OPERATION_NAMES, registerCollectionOperations } from './operations.ts'
import type { OperationHandler, OperationSpec, TxnContext } from '../../api/registry.ts'

const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys=ON;')
db.exec(`
CREATE TABLE executions (id TEXT PRIMARY KEY);
CREATE TABLE dispatches (id TEXT PRIMARY KEY);
CREATE TABLE observations (
  id TEXT PRIMARY KEY, execution_id TEXT, dispatch_id TEXT, source TEXT NOT NULL,
  fact_type TEXT NOT NULL, observed_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  identity_evidence_json TEXT NOT NULL CHECK(json_valid(identity_evidence_json))
);
${CATALOG_SCHEMA_SQL}
${INVENTORY_SCHEMA_SQL}
${SESSION_SCHEMA_SQL}
${COLLECTION_SCHEMA_SQL}
${USAGE_SCHEMA_SQL}
`)

const T0 = 1_700_000_000_000
const MACHINE = 'machine-1'

db.exec(`
INSERT INTO catalog_harnesses (id,publisher_organization_id,label,identity_metadata_json,revision) VALUES ('codex',NULL,'Codex','{}',1);
INSERT INTO catalog_organizations (id,name,metadata_json,revision) VALUES ('org.openai','OpenAI','{}',1);
INSERT INTO catalog_providers (id,operator_organization_id,label,realm,metadata_json,revision) VALUES ('openai','org.openai','OpenAI','openai','{}',1);
INSERT INTO catalog_offerings (id,provider_id,offering_key,label,metadata_json,revision) VALUES ('openai/chatgpt','openai','chatgpt','ChatGPT','{}',1);
INSERT INTO catalog_inference_models (id,publisher_organization_id,label,model_version,metadata_json,revision) VALUES ('model-x','org.openai','gpt-5-codex',NULL,'{}',1);
INSERT INTO catalog_native_model_aliases (id,namespace_kind,namespace_id,native_name,first_observed_at,last_observed_at,metadata_json,revision) VALUES ('alias-1','harness','codex','gpt-5-codex',${T0 - 1000},${T0},'{}',1);
INSERT INTO catalog_model_alias_resolutions (id,alias_id,model_id,valid_from,valid_until,confidence,evidence_json,revision) VALUES ('alias-1@1','alias-1','model-x',${T0 - 1000},NULL,'declared','[]',1);
INSERT INTO inventory_machines (id,label,first_seen_at,last_seen_at,metadata_json,revision) VALUES ('${MACHINE}','local',1,2,'{}',1);
INSERT INTO inventory_machines (id,label,first_seen_at,last_seen_at,metadata_json,revision) VALUES ('machine-remote','remote',1,2,'{}',1);
INSERT INTO inventory_provider_credentials (id,machine_id,material_ref,material_revision,ownership,availability,first_seen_at,last_seen_at,revision) VALUES ('cred-1','${MACHINE}','secret://codex',1,'user','available',1,2,1);
INSERT INTO inventory_provider_connections (id,offering_id,credential_id,auth_scope_json,first_seen_at,observed_until,availability,origin,revision) VALUES ('conn-1','openai/chatgpt','cred-1','{}',${T0 - 1000},NULL,'available','discovered',1);
`)

const installation = (id: string, dataNamespace: string): void => {
  db.prepare(`INSERT INTO inventory_installations
    (id,machine_id,harness_id,executable_locator,config_namespace,data_namespace,first_seen_at,
     last_seen_at,presence,origin,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, MACHINE, 'codex', '/usr/bin/codex', 'config-' + dataNamespace, dataNamespace,
      T0 - 10_000, T0, 'present', 'discovered', 1)
}
installation('inst-a', 'data-a')
installation('inst-b', 'data-b')

const payload = (overrides: Partial<PackCollectionResult> = {}): PackCollectionResult => ({
  observations: [], sessions: [], handles: [], attachments: [], events: [], usageReadings: [],
  usageAttributionHints: [], quotaReadings: [], exhausted: true,
  coverage: { completeness: 'complete' }, diagnostics: [], ...overrides
})

const envelope = (
  body: PackCollectionResult,
  status: PackCollectionResultEnvelope['status'] = 'success',
  completedAt = T0,
  diagnostics: CollectionDiagnostic[] = []
): PackCollectionResultEnvelope => ({
  protocolVersion: '1', operationId: 'op-' + completedAt, action: 'collect', status, payload: body,
  diagnostics, startedAt: completedAt - 5, completedAt
})

const source = (id: string, installationId: string, generation = 'gen-1',
  status: CollectionSource['status'] = 'active'): CollectionSource => ({
  id, machineId: MACHINE, subject: { kind: 'installation', installationId },
  locator: { path: '/fixture/' + id }, kind: 'file', sourceGeneration: generation,
  identityEvidence: { inode: generation }, status, firstObservedAt: T0, lastObservedAt: T0 + 60_000
})

const batch = (
  id: string, sourceId: string, generation: string, checkpointRevision: number | null,
  cursorAfter: number | null, committedAt = T0,
  result: CollectionBatch['result'] = 'committed',
  diagnostics: CollectionDiagnostic[] = []
): CollectionBatch => ({
  id, sourceId, sourceGeneration: generation, adapterPackId: 'pack-codex', adapterPackRevision: 1,
  integrationContractId: 'usage-v1', contractRevision: 1,
  cursorBefore: checkpointRevision === null ? null : {
    sourceId, sourceGeneration: generation, collectorRevision: 'collector-1',
    position: { offset: checkpointRevision }, checkpointRevision, lastCommittedAt: T0
  },
  cursorAfter: cursorAfter === null ? null : {
    sourceId, sourceGeneration: generation, collectorRevision: 'collector-1',
    position: { offset: cursorAfter }, checkpointRevision: cursorAfter, lastCommittedAt: committedAt
  },
  startedAt: committedAt - 5, committedAt, result, diagnostics
})

const session = (key: string, overrides: Partial<PackSessionObservation> = {}):
PackSessionObservation => ({
  sourceRecordKey: 'session-record-' + key, harnessId: 'codex', namespace: 'default',
  nativeSessionKey: key, firstObservedAt: T0, lastObservedAt: T0 + 1000, metadata: {},
  ...overrides
})

const usageValues = (total: number | null): PackUsageReadingObservation['values'] => ({
  inputTotal: null, outputTotal: null, total, cacheReadInput: 0, cacheWriteInput: null,
  reasoningOutput: null
})

const reading = (
  recordKey: string,
  total: number | null,
  overrides: Partial<PackUsageReadingObservation> = {}
): PackUsageReadingObservation => ({
  sourceRecordKey: recordKey, measurementKey: 'tokens', mode: 'cumulative',
  counterScope: 'account', counterEpoch: 'epoch-1', values: usageValues(total),
  semantics: { unit: 'tokens', componentRelations: [], completeness: 'partial', nativeFields: {} },
  timeCoverage: { kind: 'unknown', reason: 'counter snapshot' }, sourceEvidence: {}, ...overrides
})

const attachment = (recordKey: string, sessionNativeKey: string, overrides:
  Partial<PackSessionAttachmentObservation> = {}): PackSessionAttachmentObservation => ({
  sourceRecordKey: recordKey, sessionNativeKey, machineId: MACHINE, observedFrom: T0,
  evidence: [{ sourceRecordKey: recordKey, description: 'process tree' }], ...overrides
})

const event = (recordKey: string, overrides: Partial<PackSessionEventObservation> = {}):
PackSessionEventObservation => ({
  sourceRecordKey: recordKey, kind: 'turn-complete', nativeKind: 'Stop', observedAt: T0 + 10,
  origin: 'hook', payload: { fixture: true }, evidence: [{ sourceRecordKey: recordKey }],
  ...overrides
})

const commit = (input: CommitPackCollectionInput): CommitCollectionBatchResult =>
  commitPackCollectionResult(db, input)

const count = (table: string, where = '1=1', ...args: (string | number)[]): number =>
  Number((db.prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE ' + where).get(...args) as
  { n: number }).n)
// ── two installations of one harness ─────────────────────────────────────────
const sourceA = source('src-a', 'inst-a')
const sourceB = source('src-b', 'inst-b')
const installations = (id: string, sourceId: string, batchId: string, installationId: string):
CommitCollectionBatchResult =>
  commit({
    result: envelope(payload({ sessions: [session('native-1')],
      usageReadings: [reading('snap-' + installationId, 100)] })),
    source: id === 'src-a' ? sourceA : sourceB,
    batch: batch(batchId, sourceId, 'gen-1', null, 1),
    expectedCheckpointRevision: null, installationId
  })
const firstInstall = installations('src-a', 'src-a', 'batch-a1', 'inst-a')
const secondInstall = installations('src-b', 'src-b', 'batch-b1', 'inst-b')
assert.equal(firstInstall.insertedObservations, 1)
assert.equal(secondInstall.insertedObservations, 1)
assert.equal(count('harness_sessions'), 2)
assert.equal(count('usage_entries'), 2)
assert.equal(db.prepare('SELECT COUNT(DISTINCT id) AS n FROM harness_sessions').get()!['n'], 2)
const accountingNamespaces = (db.prepare(
  'SELECT DISTINCT accounting_namespace AS ns FROM usage_entries ORDER BY ns'
).all() as unknown as Array<{ ns: string }>)
assert.equal(accountingNamespaces.length, 2)
assert.ok(accountingNamespaces.every((row) => row.ns.startsWith('installation:')))
assert.equal(getCollectionCursor(db, 'src-a')?.checkpointRevision, 1)
assert.equal(getCollectionCursor(db, 'src-b')?.checkpointRevision, 1)
assert.equal(count('usage_entries', 'normalized_tokens_json LIKE ?', '%"total":100%'), 2)

// ── exact batch replay is a no-op ────────────────────────────────────────────
installations('src-a', 'src-a', 'batch-a1', 'inst-a')
installations('src-b', 'src-b', 'batch-b1', 'inst-b')
assert.equal(count('observations'), 2)
assert.equal(count('usage_entries'), 2)
assert.equal(count('observation_collection_facets'), 2)
assert.equal(count('collection_batches'), 2)

// ── a failed commit rolls back completely ────────────────────────────────────
const beforeRollback = {
  observations: count('observations'), entries: count('usage_entries'),
  sessions: count('harness_sessions'), cursor: getCollectionCursor(db, 'src-a')?.checkpointRevision
}
assert.throws(() => commit({
  result: envelope(payload({
    sessions: [session('native-2')],
    events: [event('event-bad', { sessionNativeKey: 'native-2',
      attachmentSourceRecordKey: 'attachment-that-does-not-exist' })]
  })),
  source: sourceA, batch: batch('batch-a2', 'src-a', 'gen-1', 1, 2),
  expectedCheckpointRevision: 1, installationId: 'inst-a'
}), /unknown attachment/)
assert.equal(count('observations'), beforeRollback.observations)
assert.equal(count('usage_entries'), beforeRollback.entries)
assert.equal(count('harness_sessions'), beforeRollback.sessions)
assert.equal(getCollectionCursor(db, 'src-a')?.checkpointRevision, beforeRollback.cursor)
assert.equal(count('harness_sessions', 'native_session_key=?', 'native-2'), 0)

// ── source loss keeps the ledger and records the gap ────────────────────────
const lost = commit({
  result: envelope(payload({
    coverage: { completeness: 'gap', gapReason: 'source missing' }
  })),
  source: source('src-a', 'inst-a', 'gen-1', 'missing'),
  batch: batch('batch-a3', 'src-a', 'gen-1', 1, null, T0 + 1000, 'partial'),
  expectedCheckpointRevision: 1, installationId: 'inst-a'
})
assert.equal(lost.insertedObservations, 0)
assert.equal(count('usage_entries'), 2)

const statusA = getCollectionStatus(db, 'src-a')!
assert.equal(statusA.source.status, 'missing')
assert.equal(statusA.pendingRequestCount, 0)
assert.ok(statusA.coverage.some((item) => item.gapReason === 'source missing'))
assert.ok(statusA.unidentified.some((item) => item.axis === 'source'))

// ── foreign and child sessions are preserved, never a Task ──────────────────
commit({
  result: envelope(payload({
    sessions: [
      session('session-foreign', { originMachineId: 'machine-remote', namespace: 'remote' }),
      session('session-child', { parentNativeSessionKey: 'session-never-collected' })
    ],
    attachments: [attachment('attach-remote-1', 'session-foreign',
      { machineId: 'machine-remote' })]
  })),
  source: sourceA,
  batch: batch('batch-a4', 'src-a', 'gen-1', 1, null, T0 + 2000, 'partial'),
  expectedCheckpointRevision: 1, installationId: 'inst-a'
})
const foreign = db.prepare('SELECT * FROM harness_sessions WHERE native_session_key=?')
  .get('session-foreign') as { id: string; origin_machine_id: string | null; namespace: string }
assert.equal(foreign.origin_machine_id, 'machine-remote')
assert.ok(foreign.namespace.startsWith('installation:'))
const child = db.prepare('SELECT * FROM harness_sessions WHERE native_session_key=?')
  .get('session-child') as { parent_session_id: string | null; metadata_json: string }
assert.equal(child.parent_session_id, null)
assert.match(child.metadata_json, /unresolvedParentNativeSessionKey/)
assert.match(child.metadata_json, /session-never-collected/)
const childBatch = listCollectionBatches(db, 'src-a').find((item) => item.id === 'batch-a4')!
assert.ok(childBatch.diagnostics.some((item) => item.code === 'unresolved-parent-session'))
assert.equal(count('session_attachments', 'execution_id IS NOT NULL'), 0)
assert.equal(count('executions'), 0)

// ── session metadata merges instead of being replaced ───────────────────────
const sessionRow = (metadata: JsonObject, overrides: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 'session-merge-fixture', harnessId: 'codex', originMachineId: MACHINE,
  namespace: 'installation:inst-a:data-a:default', nativeSessionKey: 'merge-native-1',
  parentSessionId: null, title: 'merge fixture', firstObservedAt: T0, lastObservedAt: T0 + 100,
  metadata, ...overrides
})
upsertHarnessSession(db, sessionRow({ harnessProfileId: 'profile-1', turnCount: 3 }))
// A later Pack upsert that omits the backfilled key must not drop it.
upsertHarnessSession(db, sessionRow({ turnCount: 4, modelHint: 'gpt-5-codex' },
  { lastObservedAt: T0 + 200 }))
let merged = getHarnessSession(db, 'session-merge-fixture')!
assert.equal(merged.metadata['harnessProfileId'], 'profile-1')
assert.equal(merged.metadata['turnCount'], 4)
assert.equal(merged.metadata['modelHint'], 'gpt-5-codex')
// A newer observation may state a false field explicitly.
upsertHarnessSession(db, sessionRow({ subagent: false }, { lastObservedAt: T0 + 300 }))
assert.equal(getHarnessSession(db, 'session-merge-fixture')!.metadata['subagent'], false)
// A LATE (older) observation only fills gaps: it cannot flip what a newer batch
// already stated, but a key nobody wrote yet is still backfilled.
upsertHarnessSession(db, sessionRow({ subagent: true, staleNote: 'backfilled' },
  { firstObservedAt: T0 - 500, lastObservedAt: T0 + 50 }))
merged = getHarnessSession(db, 'session-merge-fixture')!
assert.equal(merged.metadata['subagent'], false)
assert.equal(merged.metadata['staleNote'], 'backfilled')
assert.equal(merged.metadata['harnessProfileId'], 'profile-1')
// An explicit null is not a statement, and the observed window stays bounded.
upsertHarnessSession(db, sessionRow({ harnessProfileId: null },
  { lastObservedAt: T0 + 400, title: null }))
merged = getHarnessSession(db, 'session-merge-fixture')!
assert.equal(merged.metadata['harnessProfileId'], 'profile-1')
assert.equal(merged.title, 'merge fixture')
assert.equal(merged.firstObservedAt, T0 - 500)
assert.equal(merged.lastObservedAt, T0 + 400)

assert.equal(count('dispatches'), 0)

// ── overlap accounting comes from the Pack, not from a guess ────────────────
commit({
  result: envelope(payload({
    sessions: [session('parent-session'),
      session('child-session', { parentNativeSessionKey: 'parent-session' })],
    usageReadings: [
      reading('parent-snap', 500, { measurementKey: 'parent-tokens',
        sessionNativeKey: 'parent-session' }),
      reading('child-snap', 120, { measurementKey: 'child-tokens',
        sessionNativeKey: 'child-session',
        overlap: { relation: 'included-by', scope: 'session', scopeKey: 'parent-session',
          reason: 'child turn already counted by the parent snapshot',
          evidence: [{ sourceRecordKey: 'child-snap', description: 'same counter window' }] } }),
      reading('mirror-snap', 500, { measurementKey: 'mirror-tokens',
        overlap: { relation: 'overlaps',
          evidence: [{ sourceRecordKey: 'mirror-snap', description: 'second exporter' }] } })
    ]
  })),
  source: sourceA,
  batch: batch('batch-a5', 'src-a', 'gen-1', 1, null, T0 + 3000, 'partial'),
  expectedCheckpointRevision: 1, installationId: 'inst-a'
})
interface RawEntryRow {
  id: string; accounting_status: string; coverage_json: string | null
}
const entryByKey = (needle: string): RawEntryRow => db.prepare(
  'SELECT * FROM usage_entries WHERE accounting_key LIKE ?'
).get('%' + needle + '%') as unknown as RawEntryRow
const parentEntry = entryByKey('parent-snap')
const childEntry = entryByKey('child-snap')
const mirrorEntry = entryByKey('mirror-snap')
assert.equal(parentEntry.accounting_status, 'counted')
assert.equal(childEntry.accounting_status, 'duplicate')
assert.equal(mirrorEntry.accounting_status, 'unresolved')
const parentSessionId = (db.prepare(
  'SELECT id FROM harness_sessions WHERE native_session_key=?'
).get('parent-session') as { id: string }).id
const childCoverage = JSON.parse(childEntry.coverage_json ?? '[]') as Array<{
  relation: string; scope: string; scopeKey: string }>
assert.equal(childCoverage[0]?.relation, 'included-by')
assert.equal(childCoverage[0]?.scope, 'session')
assert.equal(childCoverage[0]?.scopeKey, parentSessionId)
const mirrorCoverage = JSON.parse(mirrorEntry.coverage_json ?? '[]') as Array<{
  relation: string }>
assert.equal(mirrorCoverage[0]?.relation, 'overlaps')


// ── alias resolution is time-scoped, attribution needs evidence ─────────────
const hintFor = (recordKey: string, overrides: Partial<PackUsageAttributionHint> = {}):
PackUsageAttributionHint => ({
  sourceRecordKey: recordKey, connectionId: 'conn-1',
  requestedModel: { nativeName: 'gpt-5-codex', namespace: 'codex' },
  basis: 'reported', confidence: 'observed',
  evidence: [{ sourceRecordKey: recordKey, description: 'provider response' }], ...overrides
})
const attributionFor = (recordKey: string, measurementKey: string, at: number,
  label?: string): CommitPackCollectionInput => ({
  result: envelope(payload({
    usageReadings: [reading(recordKey, 42, { measurementKey,
      timeCoverage: { kind: 'point', at, basis: 'request-complete' } })],
    usageAttributionHints: [hintFor(recordKey, label === undefined ? {} : {
      requestedModel: { nativeName: label, namespace: 'codex' } })]
  })),
  source: sourceA,
  batch: batch('batch-attr-' + recordKey, 'src-a', 'gen-1', 1, null, T0 + 4000, 'partial'),
  expectedCheckpointRevision: 1, installationId: 'inst-a'
})
commit(attributionFor('attr-snap', 'attr-tokens', T0 - 100))
const attrEntry = entryByKey('attr-snap')
const attribution = getUsageAttribution(db, attrEntry.id)!
assert.equal(attribution.connectionId, 'conn-1')
assert.equal(attribution.offeringId, null)
assert.equal(attribution.requestedModel?.aliasId, 'alias-1')
assert.equal(attribution.requestedModel?.modelId, 'model-x')
assert.equal(attribution.requestedModel?.mappingEvidence?.length, 1)
assert.equal(attribution.status, 'observed')

// Usage from before the mapping existed must not inherit it.
commit(attributionFor('old-snap', 'old-tokens', T0 - 50_000))
const older = getUsageAttribution(db, entryByKey('old-snap').id)!
assert.equal(older.requestedModel?.aliasId ?? null, null)
assert.equal(older.requestedModel?.modelId ?? null, null)
assert.equal(older.requestedModel?.nativeName, 'gpt-5-codex')

// A confidence claim without evidence, and a mapping that contradicts the
// catalog, are both refused inside the commit.
assert.throws(() => commit({
  result: envelope(payload({
    usageReadings: [reading('unproven', 5, { measurementKey: 'unproven-tokens' })],
    usageAttributionHints: [hintFor('unproven', { confidence: 'verified', evidence: [] })]
  })),
  source: sourceA,
  batch: batch('batch-attr-unproven', 'src-a', 'gen-1', 1, null, T0 + 5000, 'partial'),
  expectedCheckpointRevision: 1, installationId: 'inst-a'
}), /with no evidence/)
db.prepare(`INSERT INTO catalog_inference_models
  (id,publisher_organization_id,label,model_version,metadata_json,revision)
  VALUES ('model-y','org.openai','other',NULL,'{}',1)`).run()
assert.throws(() => commit({
  result: envelope(payload({
    usageReadings: [reading('conflict', 5, { measurementKey: 'conflict-tokens' })],
    usageAttributionHints: [hintFor('conflict', {
      requestedModel: { nativeName: 'gpt-5-codex', namespace: 'codex', modelId: 'model-y' } })]
  })),
  source: sourceA,
  batch: batch('batch-attr-conflict', 'src-a', 'gen-1', 1, null, T0 + 5000, 'partial'),
  expectedCheckpointRevision: 1, installationId: 'inst-a'
}), /conflicts with the catalog alias resolution/)

// ── envelope status, cursor and coverage validation ─────────────────────────
const validationBatch = (id: string, result: CollectionBatch['result'] = 'committed'):
CollectionBatch =>
  batch(id, 'src-a', 'gen-1', 1, null, T0 + 5000, result)
assert.throws(() => commit({
  result: envelope(payload(), 'failed'), source: sourceA,
  batch: validationBatch('batch-v1'), expectedCheckpointRevision: 1, installationId: 'inst-a'
}), /cannot commit a batch reported as/)
assert.throws(() => commit({
  result: envelope(payload()), source: sourceA,
  batch: { ...validationBatch('batch-v2'), committedAt: null },
  expectedCheckpointRevision: 1, installationId: 'inst-a'
}), /must record committedAt/)
assert.throws(() => commit({
  result: envelope({ ...payload(), exhausted: false }), source: sourceA,
  batch: validationBatch('batch-v3'), expectedCheckpointRevision: 1, installationId: 'inst-a'
}), /nextCursor/)
assert.throws(() => commit({
  result: envelope({ ...payload(),
    usageReadings: [reading('bad-snap', 1, { counterScope: undefined, counterEpoch: undefined })] }),
  source: sourceA, batch: validationBatch('batch-v4'),
  expectedCheckpointRevision: 1, installationId: 'inst-a'
}), /counterScope/)
assert.throws(() => commit({
  result: envelope(payload(), 'success', T0 + 5000, [{
    code: 'malformed-record', severity: 'error', message: 'bad line', sourceRecordKey: 'line-9'
  }]),
  source: sourceA, batch: validationBatch('batch-v5'),
  expectedCheckpointRevision: 1, installationId: 'inst-a'
}), /partial/)

// ── durable collection request queue ────────────────────────────────────────
const queued = requestCollection(db, { sourceId: 'src-a', capability: 'usage',
  requestedBy: 'operator', requestedAt: T0 })
assert.equal(queued.status, 'pending')
assert.equal(requestCollection(db, { sourceId: 'src-a', capability: 'usage',
  requestedBy: 'operator', requestedAt: T0 + 1 }).id, queued.id)
const claimed = claimCollectionRequests(db, { claimId: 'worker-1', now: T0 + 2 })
assert.equal(claimed.length, 1)
assert.equal(claimed[0]?.attempts, 1)
const settled = completeCollectionRequest(db, { id: queued.id, claimId: 'worker-1',
  outcome: 'processed', batchId: 'batch-a3', processedAt: T0 + 3 })
assert.equal(settled.status, 'processed')
assert.equal(settled.processedAt, T0 + 3)
assert.equal(settled.batchId, 'batch-a3')
assert.throws(() => completeCollectionRequest(db, { id: queued.id, claimId: 'worker-9',
  outcome: 'processed', processedAt: T0 + 4 }), /is not claimed by/)
commit({
  result: envelope(payload({ coverage: { completeness: 'gap', gapReason: 'source missing' } })),
  source: source('src-b', 'inst-b', 'gen-2', 'missing'),
  batch: {
    ...batch('batch-b2', 'src-b', 'gen-2', 1, null, T0 + 6000, 'partial'),
    cursorBefore: { sourceId: 'src-b', sourceGeneration: 'gen-1', collectorRevision: 'collector-1',
      position: { offset: 1 }, checkpointRevision: 1, lastCommittedAt: T0 }
  },
  expectedCheckpointRevision: 1, installationId: 'inst-b'
})
const leased = requestCollection(db, { sourceId: 'src-b', capability: 'sessions',
  requestedBy: 'operator', requestedAt: T0 + 10 })
claimCollectionRequests(db, { claimId: 'worker-1', now: T0 + 11, leaseMs: 1_000 })
const reclaimed = claimCollectionRequests(db, { claimId: 'worker-2', now: T0 + 5_000 })
assert.equal(reclaimed.length, 1)
assert.equal(reclaimed[0]?.id, leased.id)
assert.equal(reclaimed[0]?.claimedBy, 'worker-2')
assert.equal(reclaimed[0]?.attempts, 2)
const cancelled = cancelCollectionRequest(db, { id: leased.id, cancelledAt: T0 + 6_000,
  reason: 'superseded by a manual sweep' })
assert.equal(cancelled.status, 'cancelled')
// ── operation surface: queries return explicit DTOs and accept {} ───────────
const registered: Array<{ spec: OperationSpec; handler: OperationHandler }> = []
registerCollectionOperations({ register: (spec, handler) => { registered.push({ spec, handler }) } })
assert.deepEqual(registered.map((item) => item.spec.name).sort(),
  [...Object.values(COLLECTION_OPERATION_NAMES)].sort())
const call = (name: string, body?: unknown): unknown => {
  const item = registered.find((entry) => entry.spec.name === name)!
  const txn = { db, ctx: { principalId: 'operator' }, emitEvent: () => {},
    intendEffect: () => '' } as unknown as TxnContext
  return item.handler(txn, body)
}
const listedSources = call('collection.source.list', {}) as { items: Array<{ id: string }>;
  unidentified: unknown[] }
assert.equal(listedSources.items.length, 2)
assert.ok(Array.isArray(listedSources.unidentified))
const sourceStatus = call('collection.source.get', { sourceId: 'src-a' }) as {
  source: { id: string }; cursor: { checkpointRevision: number } | null }
assert.equal(sourceStatus.source.id, 'src-a')
assert.equal(sourceStatus.cursor?.checkpointRevision, 1)
const listedBatches = call('collection.batch.list', { sourceId: 'src-a' }) as {
  items: unknown[] }
assert.ok(listedBatches.items.length >= 4)
const listedCoverage = call('collection.coverage.list', { sourceId: 'src-a' }) as {
  items: unknown[] }
assert.ok(listedCoverage.items.length >= 1)
const observed = call('collection.source.observe', { source: source('src-c', 'inst-a') }) as {
  id: string }
assert.equal(observed.id, 'src-c')
const apiRequest = call('collection.request', { sourceId: 'src-c', capability: 'usage',
  idempotencyKey: 'fixture-request-1' }) as { id: string; status: string }
assert.equal(apiRequest.status, 'pending')
const repeated = call('collection.request', { sourceId: 'src-c', capability: 'usage',
  idempotencyKey: 'fixture-request-1' }) as { id: string }
assert.equal(repeated.id, apiRequest.id)
const apiClaims = call('collection.request.claim', { claimId: 'api-worker' }) as Array<{
  id: string }>
assert.equal(apiClaims.length, 1)
assert.equal(apiClaims[0]?.id, apiRequest.id)
const apiSettled = call('collection.request.complete', { id: apiRequest.id,
  claimId: 'api-worker', outcome: 'processed', batchId: 'batch-a1' }) as { status: string }
assert.equal(apiSettled.status, 'processed')
const requestList = call('collection.request.list', {}) as { items: unknown[] }
assert.ok(requestList.items.length >= 3)
const cancelledByApi = call('collection.request', { sourceId: 'src-c', capability: 'events' },
  ) as { id: string }
const cancelledResult = call('collection.request.cancel',
  { id: cancelledByApi.id, reason: 'no longer needed' }) as { status: string }
assert.equal(cancelledResult.status, 'cancelled')


assert.equal(listCollectionRequests(db, { status: 'pending' }).length, 0)
db.close()
console.log('Pack collection pipeline smoke: ok')
