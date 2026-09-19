// Durable collection/session/usage smoke. Run directly with Node 24.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import type {
  CollectionBatch,
  CollectionCoverage,
  CollectionSource,
  UsageCoverageRef,
  UsageReading,
  UsageValues
} from '../../../../mahas-contracts/src/metering/index.ts'
import { SESSION_SCHEMA_SQL } from '../../sessions/migrations.ts'
import { COLLECTION_SCHEMA_SQL } from '../../observation/collection/migrations.ts'
import {
  CollectionCheckpointConflict,
  commitCollectionBatch
} from '../../observation/collection/commit.ts'
import { USAGE_SCHEMA_SQL } from './migrations.ts'
import { listUsageEntries, usageLedgerWatermark, type UsageIngestIntent } from './ledger.ts'

const db = new DatabaseSync(':memory:')
db.exec(`
PRAGMA foreign_keys=ON;
CREATE TABLE executions (id TEXT PRIMARY KEY);
CREATE TABLE dispatches (id TEXT PRIMARY KEY);
CREATE TABLE observations (
  id TEXT PRIMARY KEY, execution_id TEXT, dispatch_id TEXT, source TEXT NOT NULL,
  fact_type TEXT NOT NULL, observed_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  identity_evidence_json TEXT NOT NULL CHECK(json_valid(identity_evidence_json))
);
${SESSION_SCHEMA_SQL}
${COLLECTION_SCHEMA_SQL}
${USAGE_SCHEMA_SQL}
`)

const source = (generation = 'inode-1', status: CollectionSource['status'] = 'active'): CollectionSource => ({
  id: 'src-1', machineId: 'machine-1', subject: { kind: 'installation', installationId: 'inst-1' },
  locator: { path: '/fixture/usage.jsonl' }, kind: 'file', sourceGeneration: generation,
  identityEvidence: { device: 1, inode: generation }, status, firstObservedAt: 1, lastObservedAt: 100
})

const coverage = (id: string, completeness: CollectionCoverage['completeness'] = 'complete'):
  CollectionCoverage => ({
  id, sourceId: 'src-1', subject: { kind: 'installation', installationId: 'inst-1' },
  completeness, gapReason: completeness === 'gap' ? 'malformed complete record' : null,
  lastSuccessAt: completeness === 'complete' ? 100 : null, watermark: id
})

const covRef = (id: string, relation: UsageCoverageRef['relation'] = 'direct'): UsageCoverageRef => ({
  coverageId: id, scope: 'counter', scopeKey: 'account', relation
})

const values = (total: number | null, input: number | null = null): UsageValues => ({
  inputTotal: input, outputTotal: null, total, cacheReadInput: 0,
  cacheWriteInput: null, reasoningOutput: null
})

const reading = (
  id: string,
  recordKey: string,
  observedAt: number,
  value: UsageValues,
  mode: 'delta' | 'cumulative' = 'delta',
  epoch = 'epoch-1',
  revision?: string
): UsageReading => ({
  observationId: id, batchId: `batch-${id}`, sourceRecordKey: recordKey,
  sourceRecordRevision: revision ?? null, observedAt, occurredAt: null,
  payloadSchema: 'mahas.usage-reading/v1',
  payload: {
    measurementKey: 'tokens', mode, counterScope: mode === 'cumulative' ? 'account' : null,
    counterEpoch: mode === 'cumulative' ? epoch : null, values: value,
    semantics: { unit: 'tokens', componentRelations: [], completeness: 'partial', nativeFields: {} },
    timeCoverage: mode === 'delta'
      ? { kind: 'point', at: observedAt - 10, basis: 'request-complete' }
      : { kind: 'unknown', reason: 'counter snapshot' },
    sourceEvidence: { fixture: true }
  },
  evidence: [{ sourceId: 'src-1', sourceRecordKey: recordKey }]
})

const intent = (
  r: UsageReading,
  coverageId: string,
  accountingKey: string,
  relation: UsageCoverageRef['relation'] = 'direct',
  streamRole: UsageIngestIntent['streamRole'] = 'primary',
  epochRelation: UsageIngestIntent['counterEpochRelation'] = 'first'
): UsageIngestIntent => ({
  reading: r, harnessId: 'codex', installationId: 'inst-1', originMachineId: 'machine-1',
  accountingNamespace: '/fixture/codex-home', accountingKey, coverage: [covRef(coverageId, relation)],
  streamRole, counterEpochRelation: epochRelation, createdAt: r.observedAt
})

const batch = (
  id: string,
  generation: string,
  before: number | null,
  after: number | null,
  diagnostics: CollectionBatch['diagnostics'] = []
): CollectionBatch => ({
  id, sourceId: 'src-1', sourceGeneration: generation, adapterPackId: 'pack-codex',
  adapterPackRevision: 1, integrationContractId: 'usage-v1', contractRevision: 1,
  cursorBefore: before === null ? null : {
    sourceId: 'src-1', sourceGeneration: generation, collectorRevision: 'collector-1',
    position: { offset: before * 10 }, checkpointRevision: before, lastCommittedAt: before * 100
  },
  cursorAfter: after === null ? null : {
    sourceId: 'src-1', sourceGeneration: generation, collectorRevision: 'collector-1',
    position: { offset: after * 10 }, checkpointRevision: after, lastCommittedAt: after * 100
  },
  startedAt: (after ?? before ?? 0) * 100, committedAt: (after ?? before ?? 0) * 100 + 1,
  result: diagnostics.length ? 'partial' : 'committed', diagnostics
})

const session = {
  id: 'session-1', harnessId: 'codex', originMachineId: null, namespace: '/fixture/codex-home',
  nativeSessionKey: 'full-native-id-aaaa', parentSessionId: null, title: 'fixture',
  firstObservedAt: 1, lastObservedAt: 10, metadata: {}
} as const

// Delta commit proves null remains unknown while observed zero survives.
const r1 = reading('obs-1', 'native-request-1', 100, values(8, null))
const first = commitCollectionBatch(db, {
  source: source(), batch: batch('batch-1', 'inode-1', null, 1), expectedCheckpointRevision: null,
  coverage: [coverage('coverage-1')], sessions: [session], usage: [intent(r1, 'coverage-1', 'req-1')]
})
assert.equal(first.insertedObservations, 1)
assert.equal(first.cursor?.checkpointRevision, 1)
let entries = listUsageEntries(db)
assert.equal(entries.length, 1)
assert.equal(entries[0]?.normalizedTokens.inputTotal, null)
assert.equal(entries[0]?.normalizedTokens.cacheReadInput, 0)
assert.equal(entries[0]?.usageTime.kind, 'point')

// Exact batch replay is a no-op even though the caller presents the old expectation.
assert.equal(commitCollectionBatch(db, {
  source: source(), batch: batch('batch-1', 'inode-1', null, 1), expectedCheckpointRevision: null,
  coverage: [coverage('coverage-1')], sessions: [session], usage: [intent(r1, 'coverage-1', 'req-1')]
}).replayed, true)
assert.equal(listUsageEntries(db).length, 1)

// A racing collector loses CAS and its facts roll back with the batch.
assert.throws(() => commitCollectionBatch(db, {
  source: source(), batch: batch('batch-race', 'inode-1', 0, 1), expectedCheckpointRevision: 0,
  coverage: [coverage('coverage-race')], usage: [
    intent(reading('obs-race', 'race', 150, values(99)), 'coverage-race', 'race')
  ]
}), CollectionCheckpointConflict)
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM observations WHERE id='obs-race'").get()!['n'], 0)

// Cumulative baseline is all-time/unknown; subsequent increase is an interval delta.
const r2 = reading('obs-2', 'counter-100', 200, values(100), 'cumulative')
commitCollectionBatch(db, {
  source: source(), batch: batch('batch-2', 'inode-1', 1, 2), expectedCheckpointRevision: 1,
  coverage: [coverage('coverage-2')], usage: [intent(r2, 'coverage-2', 'counter-baseline')]
})
const r3 = reading('obs-3', 'counter-150', 300, values(150), 'cumulative')
commitCollectionBatch(db, {
  source: source(), batch: batch('batch-3', 'inode-1', 2, 3), expectedCheckpointRevision: 2,
  coverage: [coverage('coverage-3')], usage: [intent(r3, 'coverage-3', 'counter-increment-1')]
})
entries = listUsageEntries(db)
assert.equal(entries.find((e) => e.accountingKey === 'counter-baseline')?.usageTime.kind, 'unknown')
const increment = entries.find((e) => e.accountingKey === 'counter-increment-1')
assert.equal(increment?.normalizedTokens.total, 50)
assert.deepEqual(increment?.usageTime, {
  kind: 'interval', startExclusive: 200, endInclusive: 300,
  basis: 'between-counter-observations', precision: 'observation interval'
})

// Decrease is unresolved and does not move the confirmed counter checkpoint.
const r4 = reading('obs-4', 'counter-90', 400, values(90), 'cumulative')
commitCollectionBatch(db, {
  source: source(), batch: batch('batch-4', 'inode-1', 3, 4), expectedCheckpointRevision: 3,
  coverage: [coverage('coverage-4')], usage: [intent(r4, 'coverage-4', 'counter-decrease')]
})
assert.equal(listUsageEntries(db).find((e) => e.accountingKey === 'counter-decrease')?.accountingStatus,
  'unresolved')
const r5 = reading('obs-5', 'counter-175', 500, values(175), 'cumulative')
commitCollectionBatch(db, {
  source: source(), batch: batch('batch-5', 'inode-1', 4, 5), expectedCheckpointRevision: 4,
  coverage: [coverage('coverage-5')], usage: [intent(r5, 'coverage-5', 'counter-increment-2')]
})
assert.equal(listUsageEntries(db).find((e) => e.accountingKey === 'counter-increment-2')
  ?.normalizedTokens.total, 25)

// Explicit overlap policies never inflate confirmed totals.
const overlapCases = [
  intent(reading('obs-6a', 'child', 600, values(30)), 'coverage-6', 'child', 'included-by'),
  intent(reading('obs-6b', 'ambiguous', 600, values(40)), 'coverage-6', 'ambiguous', 'overlaps'),
  intent(reading('obs-6c', 'corroborating', 600, values(50)), 'coverage-6', 'copy', 'direct', 'corroborating')
]
commitCollectionBatch(db, {
  source: source(), batch: batch('batch-6', 'inode-1', 5, 6), expectedCheckpointRevision: 5,
  coverage: [coverage('coverage-6')], usage: overlapCases
})
entries = listUsageEntries(db)
assert.equal(entries.find((e) => e.accountingKey === 'child')?.accountingStatus, 'duplicate')
assert.equal(entries.find((e) => e.accountingKey === 'ambiguous')?.accountingStatus, 'unresolved')
assert.equal(entries.find((e) => e.accountingKey === 'copy')?.accountingStatus, 'duplicate')

// Rotation changes generation, not native record identity: re-read is deduplicated.
const rotated = commitCollectionBatch(db, {
  source: source('inode-2'),
  batch: {
    ...batch('batch-7', 'inode-2', 6, 7),
    cursorBefore: { sourceId: 'src-1', sourceGeneration: 'inode-1', collectorRevision: 'collector-1',
      position: { offset: 60 }, checkpointRevision: 6, lastCommittedAt: 600 }
  },
  expectedCheckpointRevision: 6, coverage: [coverage('coverage-7')],
  usage: [intent({ ...r1, batchId: 'batch-7', observationId: 'obs-reread' },
    'coverage-7', 'would-duplicate')]
})
assert.equal(rotated.duplicateObservations, 1)
assert.equal(listUsageEntries(db).some((e) => e.accountingKey === 'would-duplicate'), false)

// Malformed completed records cannot be hidden behind "complete" coverage.
assert.throws(() => commitCollectionBatch(db, {
  source: source('inode-2'), batch: batch('batch-malformed', 'inode-2', 7, 8, [{
    code: 'malformed-record', severity: 'error', message: 'bad JSON', sourceRecordKey: 'line-8'
  }]), expectedCheckpointRevision: 7, coverage: [coverage('coverage-malformed', 'complete')]
}), /partial\/gap coverage/)

// The same malformed batch can advance with an explicit durable gap.
commitCollectionBatch(db, {
  source: source('inode-2'), batch: batch('batch-8', 'inode-2', 7, 8, [{
    code: 'malformed-record', severity: 'error', message: 'bad JSON', sourceRecordKey: 'line-8'
  }]), expectedCheckpointRevision: 7, coverage: [coverage('coverage-8', 'gap')]
})

// Source disappearance updates source status but retains the complete ledger.
const beforeMissing = listUsageEntries(db).length
commitCollectionBatch(db, {
  source: source('inode-2', 'missing'), batch: batch('batch-9', 'inode-2', 8, null),
  expectedCheckpointRevision: 8, coverage: [{ ...coverage('coverage-9', 'gap'), gapReason: 'source missing' }]
})
assert.equal(listUsageEntries(db).length, beforeMissing)
assert.ok(usageLedgerWatermark(db) >= beforeMissing)

// ── cumulative correction, held decrease and epoch reset ────────────────────
/** Its own counter identity, so this chain never mixes with the earlier one. */
const snap = (id: string, recordKey: string, observedAt: number, value: number,
  epoch = 'epoch-1', revision?: string, measurementKey = 'snap-tokens'): UsageReading => {
  const base = reading(id, recordKey, observedAt, values(value), 'cumulative', epoch, revision)
  return { ...base, payload: { ...base.payload, measurementKey, counterScope: 'snap-account' } }
}

// A first snapshot is an all-time baseline, the next one an interval delta.
commitCollectionBatch(db, {
  source: source('inode-2'), batch: batch('batch-10', 'inode-2', 8, 9),
  expectedCheckpointRevision: 8, coverage: [coverage('coverage-10')],
  usage: [intent(snap('obs-10', 'snap-a', 1000, 1000), 'coverage-10', 'snap-a')]
})
commitCollectionBatch(db, {
  source: source('inode-2'), batch: batch('batch-11', 'inode-2', 9, 10),
  expectedCheckpointRevision: 9, coverage: [coverage('coverage-11')],
  usage: [intent(snap('obs-11', 'snap-b', 2000, 1500), 'coverage-11', 'snap-b')]
})
assert.equal(listUsageEntries(db).find((e) => e.accountingKey === 'snap-b')?.normalizedTokens.total, 500)

// Correcting the FIRST snapshot must not diff it against its own superseded
// value, and the delta recorded after it has to be re-normalized in the same
// commit (1500 vs 1200 = 300, not 500).
commitCollectionBatch(db, {
  source: source('inode-2'), batch: batch('batch-12', 'inode-2', 10, 11),
  expectedCheckpointRevision: 10, coverage: [coverage('coverage-12')],
  usage: [intent(snap('obs-12', 'snap-a', 1000, 1200, 'epoch-1', 'rev-2'), 'coverage-12', 'snap-a')]
})
let corrected = listUsageEntries(db)
const snapA = corrected.find((e) => e.accountingKey === 'snap-a')!
const snapB = corrected.find((e) => e.accountingKey === 'snap-b')!
assert.equal(snapA.revision, 2)
assert.equal(snapA.normalizedTokens.total, 1200)
assert.equal(snapA.usageTime.kind, 'unknown')
assert.equal(snapB.revision, 2)
assert.equal(snapB.normalizedTokens.total, 300)
assert.deepEqual(snapB.usageTime, {
  kind: 'interval', startExclusive: 1000, endInclusive: 2000,
  basis: 'between-counter-observations', precision: 'observation interval'
})
assert.equal(db.prepare('SELECT accounting_status AS s FROM usage_entries WHERE id=? AND revision=1').get(snapA.id)!['s'], 'superseded')
assert.equal(db.prepare('SELECT accounting_status AS s FROM usage_entries WHERE id=? AND revision=1').get(snapB.id)!['s'], 'superseded')

// A counter decrease is held: it writes no checkpoint, so the next confirmed
// increase measures its run from the last confirmed position (1500 -> 1600).
commitCollectionBatch(db, {
  source: source('inode-2'), batch: batch('batch-13', 'inode-2', 11, 12),
  expectedCheckpointRevision: 11, coverage: [coverage('coverage-13')],
  usage: [intent(snap('obs-13', 'snap-c', 3000, 1400), 'coverage-13', 'snap-c')]
})
corrected = listUsageEntries(db)
assert.equal(corrected.find((e) => e.accountingKey === 'snap-c')?.accountingStatus, 'unresolved')
assert.equal(corrected.find((e) => e.accountingKey === 'snap-c')?.normalizedTokens.total, 1400)
// The held observation is still recorded as a counter position, but an
// unresolved entry never becomes the baseline for the next delta.
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_counter_checkpoints WHERE accounting_key=?').get('snap-c')!['n'], 1)
commitCollectionBatch(db, {
  source: source('inode-2'), batch: batch('batch-14', 'inode-2', 12, 13),
  expectedCheckpointRevision: 12, coverage: [coverage('coverage-14')],
  usage: [intent(snap('obs-14', 'snap-d', 4000, 1600), 'coverage-14', 'snap-d')]
})
const snapD = listUsageEntries(db).find((e) => e.accountingKey === 'snap-d')!
assert.equal(snapD.normalizedTokens.total, 100)
assert.deepEqual(snapD.usageTime, {
  kind: 'interval', startExclusive: 2000, endInclusive: 4000,
  basis: 'between-counter-observations', precision: 'observation interval'
})

// An epoch change is not a reset until the collector evidences it.
commitCollectionBatch(db, {
  source: source('inode-2'), batch: batch('batch-15', 'inode-2', 13, 14),
  expectedCheckpointRevision: 13, coverage: [coverage('coverage-15')],
  usage: [intent(snap('obs-15', 'snap-e', 5000, 50, 'epoch-2', 'rev-1'), 'coverage-15', 'snap-e')]
})
assert.equal(listUsageEntries(db).find((e) => e.accountingKey === 'snap-e')?.accountingStatus, 'unresolved')
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_counter_checkpoints WHERE counter_epoch=?').get('epoch-2')!['n'], 0)
const resetIntent = intent(snap('obs-16', 'snap-e', 5000, 50, 'epoch-2', 'rev-2'), 'coverage-16', 'snap-e')
resetIntent.counterEpochRelation = 'disjoint'
resetIntent.counterEpochEvidence = [{ sourceId: 'src-1', sourceRecordKey: 'snap-e',
  description: 'provider reported a new quota epoch' }]
commitCollectionBatch(db, {
  source: source('inode-2'), batch: batch('batch-16', 'inode-2', 14, 15),
  expectedCheckpointRevision: 14, coverage: [coverage('coverage-16')], usage: [resetIntent]
})
const snapE = listUsageEntries(db).find((e) => e.accountingKey === 'snap-e')!
assert.equal(snapE.accountingStatus, 'counted')
assert.equal(snapE.normalizedTokens.total, 50)
assert.equal(snapE.counterEpoch?.relation, 'disjoint')
assert.equal(snapE.counterEpoch?.evidence.length, 1)
assert.equal(snapE.usageTime.kind, 'unknown')
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_counter_checkpoints WHERE counter_epoch=?').get('epoch-2')!['n'], 1)
assert.equal(listCounterRecomputeIntents(db).length, 0)

// Two measurements of one source record are two lineages: the record key alone
// must not collapse the second reading into the first.
const measured = (id: string, recordKey: string, measurementKey: string, value: number): UsageReading =>
  snap(id, recordKey, 6000, value, 'epoch-1', 'm1', measurementKey)
commitCollectionBatch(db, {
  source: source('inode-2'), batch: batch('batch-17', 'inode-2', 15, 16),
  expectedCheckpointRevision: 15, coverage: [coverage('coverage-17')],
  usage: [
    intent(measured('obs-17a', 'multi', 'snap-multi-tokens', 200), 'coverage-17', 'multi#tokens'),
    intent(measured('obs-17b', 'multi', 'snap-multi-requests', 30), 'coverage-17', 'multi#requests')
  ]
})
assert.equal(listUsageEntries(db).find((e) => e.accountingKey === 'multi#tokens')?.normalizedTokens.total, 200)
assert.equal(listUsageEntries(db).find((e) => e.accountingKey === 'multi#requests')?.normalizedTokens.total, 30)
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observation_collection_facets WHERE source_record_key=?').get('multi')!['n'], 2)

// Re-reading the unchanged second measurement stays a duplicate within its facet.
commitCollectionBatch(db, {
  source: source('inode-2'), batch: batch('batch-18', 'inode-2', 16, 17),
  expectedCheckpointRevision: 16, coverage: [coverage('coverage-18')],
  usage: [intent(measured('obs-18', 'multi', 'snap-multi-requests', 30), 'coverage-18',
    'multi#requests-reread')]
})
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observation_collection_facets WHERE source_record_key=?').get('multi')!['n'], 2)

db.close()
console.log('session/collection/usage ledger smoke: ok')
import { listCounterRecomputeIntents } from './counters.ts'
