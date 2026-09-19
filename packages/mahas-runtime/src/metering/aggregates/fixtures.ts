/**
 * Synthetic, persisted fixtures for the aggregate/statistic boundary.
 *
 * Everything here is generated in-process against an in-memory SQLite control
 * DB: no real credentials, provider APIs, native logs or CLI configs are read.
 * The usage ledger is written through its real ingest API so the fixtures
 * exercise the durable feed, not a hand-inserted table.
 */
import { DatabaseSync } from 'node:sqlite'
import type {
  UsageAttribution, UsageCoverageRef, UsageReading, UsageTime, UsageValues
} from '../../../../mahas-contracts/src/metering/index.ts'
import { SESSION_SCHEMA_SQL } from '../../sessions/migrations.ts'
import { COLLECTION_SCHEMA_SQL } from '../../observation/collection/migrations.ts'
import { accountUsageReadingInTransaction, USAGE_SCHEMA_SQL } from '../usage/index.ts'
import { applyUsageAggregatesSchema } from './schema.ts'
import { applyUsageStatisticsSchema } from '../statistics/schema.ts'
import { withTx } from '../../storage/transaction.ts'

/** Minimal stand-ins for the tables the ledger references, plus the two
 * catalog/inventory columns the aggregate source reads (connection → provider
 * and offering, verified pool claims). */
const STUB_SCHEMA_SQL = `
CREATE TABLE executions (id TEXT PRIMARY KEY);
CREATE TABLE dispatches (id TEXT PRIMARY KEY);
CREATE TABLE observations (
  id TEXT PRIMARY KEY, execution_id TEXT, dispatch_id TEXT, source TEXT NOT NULL,
  fact_type TEXT NOT NULL, observed_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  identity_evidence_json TEXT NOT NULL CHECK(json_valid(identity_evidence_json))
);
CREATE TABLE catalog_providers (id TEXT PRIMARY KEY);
CREATE TABLE catalog_offerings (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES catalog_providers(id)
);
CREATE TABLE inventory_provider_connections (
  id TEXT PRIMARY KEY,
  offering_id TEXT NOT NULL REFERENCES catalog_offerings(id),
  credential_id TEXT,
  label TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  observed_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE inventory_quota_pool_claims (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES inventory_provider_connections(id),
  provider_pool_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  valid_until INTEGER,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  revision INTEGER NOT NULL CHECK(revision > 0)
);
`

export function createFixtureDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON;')
  db.exec(STUB_SCHEMA_SQL)
  db.exec(SESSION_SCHEMA_SQL)
  db.exec(COLLECTION_SCHEMA_SQL)
  db.exec(USAGE_SCHEMA_SQL)
  applyUsageAggregatesSchema(db)
  applyUsageStatisticsSchema(db)
  return db
}

let clock = 1_700_000_000_000
/** Monotonic clock so change sequences and created_at never go backwards. */
export function tick(step = 1_000): number {
  clock += step
  return clock
}

export function addProvider(db: DatabaseSync, providerId: string, offeringId: string): void {
  db.prepare('INSERT OR IGNORE INTO catalog_providers(id) VALUES (?)').run(providerId)
  db.prepare('INSERT OR IGNORE INTO catalog_offerings(id,provider_id) VALUES (?,?)').run(offeringId, providerId)
}

export function addConnection(db: DatabaseSync, connectionId: string, offeringId: string): void {
  db.prepare(`INSERT OR IGNORE INTO inventory_provider_connections(id,offering_id,observed_at)
    VALUES (?,?,?)`).run(connectionId, offeringId, tick())
}

const claimRevision = new Map<string, number>()

/** Insert a verified pool claim. A repeated id updates in place and bumps the
 * revision, exactly like the inventory repository's `putQuotaPoolClaim`, so the
 * fixture covers claim corrections as well as new claims. */
export function putPoolClaim(db: DatabaseSync, input: {
  id: string
  connectionId: string
  providerPoolKey: string
  scope: string
  observedAt: number
  validUntil?: number | null
}): number {
  const revision = (claimRevision.get(input.id) ?? 0) + 1
  claimRevision.set(input.id, revision)
  db.prepare(`INSERT INTO inventory_quota_pool_claims
    (id,connection_id,provider_pool_key,scope,observed_at,valid_until,evidence_json,revision)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET connection_id=excluded.connection_id,
      provider_pool_key=excluded.provider_pool_key,scope=excluded.scope,observed_at=excluded.observed_at,
      valid_until=excluded.valid_until,evidence_json=excluded.evidence_json,revision=excluded.revision`)
    .run(input.id, input.connectionId, input.providerPoolKey, input.scope, input.observedAt,
      input.validUntil ?? null, JSON.stringify([{ description: 'synthetic pool claim evidence' }]), revision)
  return revision
}

export interface CoverageInput {
  id: string
  sourceId?: string
  start: number
  end: number
  completeness?: 'complete' | 'partial' | 'gap' | 'unknown'
  gapReason?: string | null
  subject?: unknown
}

/** Canonical collection coverage plus the source it belongs to. */
export function addCoverage(db: DatabaseSync, input: CoverageInput): void {
  const sourceId = input.sourceId ?? 'src-fixture'
  const batchId = `batch-${input.id}`
  db.prepare(`INSERT OR IGNORE INTO collection_sources
    (id,machine_id,subject_json,locator_json,kind,source_generation,identity_evidence_json,status,
     first_observed_at,last_observed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(sourceId, 'machine-fixture', JSON.stringify(input.subject ?? { kind: 'machine', machineId: 'machine-fixture' }),
      JSON.stringify({ path: '/fixture/usage.jsonl' }), 'file', 'gen-1', JSON.stringify({ inode: 'gen-1' }),
      'active', 1, tick())
  db.prepare(`INSERT OR IGNORE INTO collection_batches
    (id,source_id,source_generation,adapter_pack_id,adapter_pack_revision,integration_contract_id,
     contract_revision,started_at,committed_at,result,diagnostics_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(batchId, sourceId, 'gen-1', 'pack.fixture', 1, 'contract.fixture', 1,
      tick(), tick(), 'committed', JSON.stringify([]))
  db.prepare(`INSERT INTO collection_coverage
    (id,batch_id,source_id,subject_json,interval_json,completeness,gap_reason,last_success_at,watermark)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET interval_json=excluded.interval_json,
      completeness=excluded.completeness,gap_reason=excluded.gap_reason,
      last_success_at=excluded.last_success_at,watermark=excluded.watermark`)
    .run(input.id, batchId, sourceId,
      JSON.stringify(input.subject ?? { kind: 'machine', machineId: 'machine-fixture' }),
      JSON.stringify({ start: input.start, end: input.end }), input.completeness ?? 'complete',
      input.gapReason ?? null, input.completeness === 'complete' ? tick() : null, input.id)
}

const usageValues = (input: Partial<UsageValues>): UsageValues => ({
  inputTotal: input.inputTotal ?? null, outputTotal: input.outputTotal ?? null,
  total: input.total ?? null, cacheReadInput: input.cacheReadInput ?? null,
  cacheWriteInput: input.cacheWriteInput ?? null, reasoningOutput: input.reasoningOutput ?? null
})

export interface ReadingInput {
  readingId: string
  /** Same key + new reading = a new revision of the same entry (a correction). */
  accountingKey: string
  values: Partial<UsageValues>
  time: UsageTime
  harnessId?: string
  namespace?: string
  sessionId?: string | null
  machineId?: string | null
  observedAt?: number
  createdAt?: number
  mode?: 'delta' | 'cumulative'
  counterScope?: string
  counterEpoch?: string
  counterEpochRelation?: 'first' | 'disjoint' | 'unknown'
  /** `null`/omitted means no attribution evidence at all. */
  attribution?: Partial<Omit<UsageAttribution, 'entryId' | 'revision' | 'validFromRevision'>> | null
}

const coverageRef = (id: string): UsageCoverageRef => ({ coverageId: id, scope: 'counter',
  scopeKey: 'fixture-account', relation: 'direct' })

/** The reading facet references the observation the reading arrived as; the
 * synthetic fixture states that fact explicitly instead of running a
 * collection batch. */
function insertObservation(db: DatabaseSync, observationId: string, observedAt: number): void {
  db.prepare(`INSERT OR IGNORE INTO observations
    (id,source,fact_type,observed_at,payload_json,identity_evidence_json)
    VALUES (?,?,?,?,?,?)`)
    .run(observationId, 'fixture', 'mahas.usage-reading/v1', observedAt,
      JSON.stringify({ fixture: true }), JSON.stringify({ synthetic: true }))
}

/** Record one usage reading through the durable ledger. */
export function recordUsage(db: DatabaseSync, input: ReadingInput): { entryId: string; revision: number } {
  const harnessId = input.harnessId ?? 'codex'
  const createdAt = input.createdAt ?? tick()
  const observedAt = input.observedAt ?? createdAt
  const time = input.time
  const reading: UsageReading = {
    observationId: input.readingId,
    batchId: 'batch-fixture',
    sourceRecordKey: input.readingId,
    observedAt,
    payloadSchema: 'mahas.usage-reading/v1',
    evidence: [],
    payload: {
      sessionId: input.sessionId ?? null,
      measurementKey: input.accountingKey,
      mode: input.mode ?? 'delta',
      counterScope: input.mode === 'cumulative' ? (input.counterScope ?? 'account') : null,
      counterEpoch: input.mode === 'cumulative' ? (input.counterEpoch ?? 'epoch-1') : null,
      values: usageValues(input.values),
      semantics: { unit: 'tokens', componentRelations: [], completeness: 'complete', nativeFields: {} },
      timeCoverage: time,
      sourceEvidence: { fixture: true }
    }
  }
  return withTx(db, (tx) => {
    insertObservation(tx, input.readingId, observedAt)
    const entry = accountUsageReadingInTransaction(tx, {
      reading, harnessId,
      installationId: null, originMachineId: input.machineId ?? 'machine-fixture',
      accountingNamespace: input.namespace ?? 'fixture', accountingKey: input.accountingKey,
      coverage: [coverageRef('cov-fixture')], cost: null, streamRole: 'primary',
      ...(input.counterEpochRelation ? { counterEpochRelation: input.counterEpochRelation } : {}),
      attribution: input.attribution ? {
        connectionId: input.attribution.connectionId ?? null,
        offeringId: input.attribution.offeringId ?? null,
        providerId: input.attribution.providerId ?? null,
        credentialId: null,
        requestedModel: input.attribution.requestedModel ?? null,
        servedModel: input.attribution.servedModel ?? null,
        executionId: null, dispatchId: null,
        basis: input.attribution.basis ?? 'reported',
        evidence: input.attribution.evidence ?? [{ description: 'fixture attribution' }],
        status: input.attribution.status ?? 'verified'
      } : null,
      createdAt
    })
    return { entryId: entry.id, revision: entry.revision }
  })
}

/** Record many readings inside one transaction (rebuild-scale fixtures). */
export function recordMany(db: DatabaseSync, count: number, make: (index: number) => ReadingInput): void {
  withTx(db, (tx) => {
    for (let index = 0; index < count; index++) {
      const input = make(index)
      const createdAt = input.createdAt ?? tick(1)
      const reading: UsageReading = {
        observationId: input.readingId, batchId: 'batch-fixture', sourceRecordKey: input.readingId,
        observedAt: input.observedAt ?? createdAt, payloadSchema: 'mahas.usage-reading/v1', evidence: [],
        payload: { sessionId: null, measurementKey: input.accountingKey, mode: 'delta',
          counterScope: null, counterEpoch: null, values: usageValues(input.values),
          semantics: { unit: 'tokens', componentRelations: [], completeness: 'complete', nativeFields: {} },
          timeCoverage: input.time, sourceEvidence: { fixture: true } }
      }
      insertObservation(tx, input.readingId, reading.observedAt)
      accountUsageReadingInTransaction(tx, {
        reading, harnessId: input.harnessId ?? 'codex', installationId: null,
        originMachineId: 'machine-fixture', accountingNamespace: input.namespace ?? 'fixture',
        accountingKey: input.accountingKey, coverage: [coverageRef('cov-fixture')], cost: null,
        streamRole: 'primary', attribution: null, createdAt
      })
    }
  })
}

export function pointTime(at: number): UsageTime {
  return { kind: 'point', at, basis: 'fixture-observed', precision: 'millisecond' }
}

export function intervalTime(startExclusive: number, endInclusive: number): UsageTime {
  return { kind: 'interval', startExclusive, endInclusive, basis: 'fixture-interval' }
}

export const unknownTime = (): UsageTime => ({ kind: 'unknown', reason: 'fixture: no observable usage time' })

export { applyUsageAggregatesSchema, applyUsageStatisticsSchema }
