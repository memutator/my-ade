import type { DatabaseSync } from 'node:sqlite'
import type {
  MeteringEvidenceRef,
  UsageAccountingStatus,
  UsageAttribution,
  UsageCost,
  UsageCounterEpoch,
  UsageCoverageRef,
  UsageEntry,
  UsageEntryWithAttribution,
  UsageLedgerChange,
  UsageReading,
  UsageValues
} from '../../../../mahas-contracts/src/metering/index.ts'
import { withTx } from '../../storage/transaction.ts'
import {
  CHAIN_RECOMPUTE_LIMIT,
  applyCounterRecomputeIntent,
  counterCursorOf,
  enqueueCounterRecompute,
  ingestCounterCheckpoint,
  listCounterRecomputeIntents,
  otherCounterEpochExists,
  readCounterRow,
  recomputeCounterChain,
  setCounterEntryRevision,
  usageEntryIdFor,
  usageStatusFor,
  validateUsageValues,
  type ChainEntryPort,
  type CounterChainCursor,
  type CounterEpochRelation,
  type CounterIdentity,
  type CounterNormalization,
  type CounterRecomputeIntent,
  type UsageStreamRole
} from './counters.ts'

export { usageEntryIdFor, listCounterRecomputeIntents }
export type { CounterChainCursor, CounterEpochRelation, CounterIdentity, CounterRecomputeIntent, UsageStreamRole }

/** Domain context supplied by the trusted collector orchestration, not by a Pack. */
export interface UsageIngestIntent {
  reading: UsageReading
  harnessId: string
  installationId?: string | null
  originMachineId?: string | null
  /** Installation/data namespace; required so identical native keys never collapse across configs. */
  accountingNamespace: string
  accountingKey: string
  coverage: readonly UsageCoverageRef[]
  cost?: UsageCost | null
  streamRole: UsageStreamRole
  /**
   * What the collector knows about this epoch's relation to the counter's
   * previous epoch. Omitted means unknown: a counter that already had another
   * epoch stays unresolved until a disjoint reset carries evidence.
   */
  counterEpochRelation?: CounterEpochRelation
  counterEpochEvidence?: readonly MeteringEvidenceRef[]
  attribution?: Omit<UsageAttribution, 'entryId' | 'revision' | 'validFromRevision'> | null
  createdAt: number
}

const json = (value: unknown): string => JSON.stringify(value ?? null)

const parse = <T>(text: string | null, fallback: T): T => {
  if (text === null) return fallback
  try { return JSON.parse(text) as T } catch { return fallback }
}

interface EntrySeed {
  id: string
  sessionId: string | null
  installationId: string | null
  originMachineId: string | null
  accountingKey: string
  coverage: readonly UsageCoverageRef[]
  readingIds: readonly string[]
  cost: UsageCost | null
  streamRole: UsageStreamRole
  counterEpoch: UsageCounterEpoch | null
  createdAt: number
}

const held = (values: UsageValues, reason: string): CounterNormalization => ({
  values, usageTime: { kind: 'unknown', reason }, status: 'unresolved', advance: false
})

function insertReadingFacet(
  db: DatabaseSync,
  intent: UsageIngestIntent,
  counterEpoch: UsageCounterEpoch | null
): void {
  const payload = intent.reading.payload
  db.prepare(
    `INSERT OR IGNORE INTO usage_reading_facets
       (observation_id,session_id,measurement_key,mode,counter_scope,counter_epoch,
        counter_epoch_relation,counter_epoch_evidence_json,values_json,semantics_json,
        time_coverage_json,source_evidence_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(intent.reading.observationId, payload.sessionId ?? null, payload.measurementKey,
    payload.mode, payload.counterScope ?? null, payload.counterEpoch ?? null,
    counterEpoch?.relation ?? null, json(counterEpoch?.evidence ?? []), json(payload.values),
    json(payload.semantics), json(payload.timeCoverage), json(payload.sourceEvidence))
}

function recordChange(
  db: DatabaseSync,
  entryId: string,
  revision: number,
  kind: 'entry' | 'attribution',
  changedAt: number
): number {
  const result = db.prepare(
    'INSERT INTO usage_ledger_changes(entry_id,entry_revision,kind,changed_at) VALUES (?,?,?,?)'
  ).run(entryId, revision, kind, changedAt)
  const sequence = Number(result.lastInsertRowid)
  db.prepare('INSERT INTO usage_aggregate_intents(change_sequence,state) VALUES (?,?)')
    .run(sequence, 'pending')
  return sequence
}

function nextRevision(db: DatabaseSync, id: string): number {
  const row = db.prepare('SELECT MAX(revision) AS revision FROM usage_entries WHERE id=?')
    .get(id) as { revision: number | null }
  return (row.revision ?? 0) + 1
}

/**
 * Write the next revision of a ledger entry. Every earlier revision becomes
 * `superseded`, so a corrected snapshot replaces the amount it previously
 * contributed instead of being added to it.
 */
function insertEntryRevision(
  db: DatabaseSync,
  namespace: string,
  harnessId: string,
  seed: EntrySeed,
  normalization: CounterNormalization,
  changedAt: number
): UsageEntry {
  const revision = nextRevision(db, seed.id)
  if (revision > 1) {
    db.prepare('UPDATE usage_entries SET accounting_status=? WHERE id=? AND revision<?')
      .run('superseded', seed.id, revision)
  }
  const entry: UsageEntry = {
    id: seed.id, revision, sessionId: seed.sessionId, harnessId,
    installationId: seed.installationId, originMachineId: seed.originMachineId,
    accountingKey: seed.accountingKey, coverage: seed.coverage,
    readingIds: seed.readingIds, usageTime: normalization.usageTime,
    normalizedTokens: normalization.values, cost: seed.cost,
    accountingStatus: normalization.status, supersedesEntryId: revision > 1 ? seed.id : null,
    counterEpoch: seed.counterEpoch, createdAt: seed.createdAt
  }
  db.prepare(
    `INSERT INTO usage_entries
       (id,revision,session_id,harness_id,installation_id,origin_machine_id,accounting_namespace,
        accounting_key,coverage_json,reading_ids_json,usage_time_json,normalized_tokens_json,cost_json,
        accounting_status,stream_role,counter_epoch_json,supersedes_entry_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(entry.id, entry.revision, entry.sessionId ?? null, entry.harnessId,
    entry.installationId ?? null, entry.originMachineId ?? null, namespace, entry.accountingKey,
    json(entry.coverage),
    json(entry.readingIds), json(entry.usageTime), json(entry.normalizedTokens),
    entry.cost == null ? null : json(entry.cost), entry.accountingStatus, seed.streamRole,
    entry.counterEpoch == null ? null : json(entry.counterEpoch), entry.supersedesEntryId ?? null,
    entry.createdAt)
  recordChange(db, entry.id, revision, 'entry', changedAt)
  return entry
}

function sameNormalization(entry: UsageEntry, normalization: CounterNormalization): boolean {
  return entry.accountingStatus === normalization.status &&
    json(entry.normalizedTokens) === json(normalization.values) &&
    json(entry.usageTime) === json(normalization.usageTime)
}

function seedFromIntent(
  intent: UsageIngestIntent,
  id: string,
  counterEpoch: UsageCounterEpoch | null
): EntrySeed {
  return {
    id, sessionId: intent.reading.payload.sessionId ?? null,
    installationId: intent.installationId ?? null,
    originMachineId: intent.originMachineId ?? null,
    accountingKey: intent.accountingKey, coverage: intent.coverage,
    readingIds: [intent.reading.observationId], cost: intent.cost ?? null,
    streamRole: intent.streamRole, counterEpoch, createdAt: intent.createdAt
  }
}

function seedFromEntry(entry: UsageEntry): EntrySeed {
  return {
    id: entry.id, sessionId: entry.sessionId ?? null,
    installationId: entry.installationId ?? null,
    originMachineId: entry.originMachineId ?? null,
    accountingKey: entry.accountingKey, coverage: entry.coverage,
    readingIds: entry.readingIds, cost: entry.cost ?? null,
    streamRole: entry.streamRole ?? 'primary', counterEpoch: entry.counterEpoch ?? null,
    createdAt: entry.createdAt
  }
}

/**
 * Ledger-side port for the counter chain. A row whose normalization did not
 * change is left at its current revision: a late arrival that does not move
 * this row's accounting must not churn the ledger or its aggregate feed.
 */
function chainEntryPort(
  db: DatabaseSync,
  context: {
    harnessId: string
    accountingNamespace: string
    seed?: EntrySeed | null
    readingId?: string | null
  }
): ChainEntryPort {
  const idFor = (accountingKey: string): string =>
    usageEntryIdFor(context.harnessId, context.accountingNamespace, accountingKey)
  return {
    entryIdFor: idFor,
    read(entryId) {
      const entry = getUsageEntry(db, entryId)
      return entry
        ? { entryId, coverage: entry.coverage, streamRole: entry.streamRole ?? 'primary',
            accountingStatus: entry.accountingStatus }
        : null
    },
    write({ accountingKey, normalization, createdAt }) {
      const current = getUsageEntry(db, idFor(accountingKey))
      // The seed carries THIS reading's service context (coverage, epoch claim,
      // session, cost). A new revision of an existing lineage must not inherit
      // the previous revision's epoch claim or coverage.
      const pending = context.seed && accountingKey === context.seed.accountingKey
        ? context.seed
        : null
      if (!current && !pending) return
      if (current && sameNormalization(current, normalization) &&
          (!context.readingId || current.readingIds.includes(context.readingId))) return
      const base = pending ?? seedFromEntry(current!)
      const history = pending && current ? current.readingIds : base.readingIds
      const readingId = context.readingId
      const readingIds = readingId && !history.includes(readingId)
        ? [...history, readingId]
        : history
      insertEntryRevision(db, context.accountingNamespace, context.harnessId,
        { ...base, readingIds }, normalization, createdAt)
    }
  }
}

function applyAttribution(
  db: DatabaseSync,
  intent: UsageIngestIntent,
  entry: UsageEntry
): void {
  if (!intent.attribution) return
  const next = intent.attribution
  const current = getUsageAttribution(db, entry.id)
  if (current && sameAttribution(current, next)) return
  reviseUsageAttributionInTransaction(db, { ...next, entryId: entry.id,
    revision: 1, validFromRevision: entry.revision }, intent.createdAt)
}

/** Material comparison: re-reporting the same evidence must not churn revisions. */
function sameAttribution(
  current: UsageAttribution,
  next: Omit<UsageAttribution, 'entryId' | 'revision' | 'validFromRevision'>
): boolean {
  return current.basis === next.basis && current.status === next.status &&
    (current.connectionId ?? null) === (next.connectionId ?? null) &&
    (current.offeringId ?? null) === (next.offeringId ?? null) &&
    (current.providerId ?? null) === (next.providerId ?? null) &&
    (current.credentialId ?? null) === (next.credentialId ?? null) &&
    (current.executionId ?? null) === (next.executionId ?? null) &&
    json(current.requestedModel ?? null) === json(next.requestedModel ?? null) &&
    json(current.servedModel ?? null) === json(next.servedModel ?? null) &&
    json(current.evidence) === json(next.evidence)
}

/**
 * Account one usage reading inside the caller's transaction. Delta readings
 * use the reported time coverage; cumulative readings are normalized against
 * the counter's confirmed position, and a correction additionally
 * re-normalizes the observations that were computed against the old value.
 */
export function accountUsageReadingInTransaction(
  db: DatabaseSync,
  intent: UsageIngestIntent
): UsageEntry {
  const existingByReading = db.prepare(
    `SELECT e.id,e.revision FROM usage_entries e, json_each(e.reading_ids_json) r
     WHERE r.value=? ORDER BY e.revision DESC LIMIT 1`
  ).get(intent.reading.observationId) as { id: string; revision: number } | undefined
  if (existingByReading) {
    const existing = getUsageEntry(db, existingByReading.id, existingByReading.revision)
    if (!existing) throw new Error('usage entry disappeared during transaction')
    return existing
  }
  if (!intent.accountingNamespace) throw new Error('usage accountingNamespace is required')
  validateUsageValues(intent.reading.payload.values)
  const payload = intent.reading.payload
  const id = usageEntryIdFor(intent.harnessId, intent.accountingNamespace, intent.accountingKey)
  const coverageStatus = usageStatusFor(intent.streamRole, intent.coverage)

  if (payload.mode === 'delta') {
    insertReadingFacet(db, intent, null)
    const entry = insertEntryRevision(db, intent.accountingNamespace, intent.harnessId,
      seedFromIntent(intent, id, null),
      { values: payload.values, usageTime: payload.timeCoverage, status: coverageStatus,
        advance: false }, intent.createdAt)
    applyAttribution(db, intent, entry)
    return entry
  }

  const scope = payload.counterScope
  const epoch = payload.counterEpoch
  if (!scope || !epoch) {
    insertReadingFacet(db, intent, null)
    const entry = insertEntryRevision(db, intent.accountingNamespace, intent.harnessId,
      seedFromIntent(intent, id, null), held(payload.values, 'cumulative counter has no scope/epoch'),
      intent.createdAt)
    applyAttribution(db, intent, entry)
    return entry
  }
  const key: CounterIdentity = {
    harnessId: intent.harnessId, accountingNamespace: intent.accountingNamespace,
    counterScope: scope, counterEpoch: epoch, measurementKey: payload.measurementKey
  }
  const epochEvidence = intent.counterEpochEvidence ?? []
  const relation: CounterEpochRelation =
    intent.counterEpochRelation ?? (otherCounterEpochExists(db, key) ? 'unknown' : 'first')
  const counterEpoch: UsageCounterEpoch = { scope, epoch, relation, evidence: epochEvidence }
  insertReadingFacet(db, intent, counterEpoch)

  const outcome = coverageStatus === 'unresolved'
    ? { written: false as const, reason: 'coverage relation keeps this reading unaccounted' }
    : ingestCounterCheckpoint(db, {
        key, accountingKey: intent.accountingKey, readingId: intent.reading.observationId,
        values: payload.values, observedAt: intent.reading.observedAt,
        recordedAt: intent.createdAt, relation, hasEpochEvidence: epochEvidence.length > 0
      })
  if (!outcome.written) {
    const entry = insertEntryRevision(db, intent.accountingNamespace, intent.harnessId,
      seedFromIntent(intent, id, counterEpoch), held(payload.values, outcome.reason),
      intent.createdAt)
    applyAttribution(db, intent, entry)
    return entry
  }
  const seed = seedFromIntent(intent, id, counterEpoch)
  const port = chainEntryPort(db, {
    harnessId: intent.harnessId, accountingNamespace: intent.accountingNamespace,
    seed, readingId: intent.reading.observationId
  })
  const row = readCounterRow(db, key, intent.accountingKey)
  if (!row) throw new Error('counter checkpoint vanished after ingest')
  const chain = recomputeCounterChain(db, key, counterCursorOf(row), port, {
    changedAt: intent.createdAt, limit: CHAIN_RECOMPUTE_LIMIT,
    pending: { accountingKey: intent.accountingKey,
      view: { entryId: id, coverage: intent.coverage, streamRole: intent.streamRole,
        accountingStatus: coverageStatus } }
  })
  if (chain.cursor) {
    enqueueCounterRecompute(db, key, chain.cursor,
      'bounded correction recompute left rows to re-normalize', intent.createdAt)
  }
  const entry = getUsageEntry(db, id)
  if (!entry) throw new Error('counter ingest left no ledger entry')
  setCounterEntryRevision(db, key, intent.accountingKey, entry.revision)
  applyAttribution(db, intent, entry)
  return entry
}

export function accountUsageReading(db: DatabaseSync, intent: UsageIngestIntent): UsageEntry {
  return withTx(db, (tx) => accountUsageReadingInTransaction(tx, intent))
}

interface RawEntry {
  id: string; revision: number; session_id: string | null; harness_id: string
  installation_id: string | null; origin_machine_id: string | null; accounting_key: string
  coverage_json: string; reading_ids_json: string; usage_time_json: string
  normalized_tokens_json: string; cost_json: string | null
  accounting_status: UsageAccountingStatus; stream_role: UsageStreamRole
  counter_epoch_json: string | null; supersedes_entry_id: string | null; created_at: number
}

const mapEntry = (r: RawEntry): UsageEntry => ({
  id: r.id, revision: r.revision, sessionId: r.session_id, harnessId: r.harness_id,
  installationId: r.installation_id, originMachineId: r.origin_machine_id,
  accountingKey: r.accounting_key, coverage: parse(r.coverage_json, []),
  readingIds: parse(r.reading_ids_json, []),
  usageTime: parse(r.usage_time_json, { kind: 'unknown', reason: 'invalid stored usage time' }),
  normalizedTokens: parse(r.normalized_tokens_json, {
    inputTotal: null, outputTotal: null, total: null, cacheReadInput: null,
    cacheWriteInput: null, reasoningOutput: null
  }), cost: parse(r.cost_json, null), accountingStatus: r.accounting_status,
  streamRole: r.stream_role ?? 'primary', counterEpoch: parse(r.counter_epoch_json, null),
  supersedesEntryId: r.supersedes_entry_id, createdAt: r.created_at
})



/** Latest stored revision by default, or one exact revision when asked. */
export function getUsageEntry(db: DatabaseSync, id: string, revision?: number): UsageEntry | null {
  const row = revision === undefined
    ? db.prepare('SELECT * FROM usage_entries WHERE id=? ORDER BY revision DESC LIMIT 1').get(id)
    : db.prepare('SELECT * FROM usage_entries WHERE id=? AND revision=?').get(id, revision)
  return row ? mapEntry(row as unknown as RawEntry) : null
}

const CURRENT_REVISION = 'e.revision=(SELECT MAX(x.revision) FROM usage_entries x WHERE x.id=e.id)'

export function listUsageEntries(
  db: DatabaseSync,
  options: { harnessId?: string; status?: UsageAccountingStatus; limit?: number } = {}
): UsageEntry[] {
  const clauses = [CURRENT_REVISION]
  const args: (string | number)[] = []
  if (options.harnessId) { clauses.push('e.harness_id=?'); args.push(options.harnessId) }
  if (options.status) { clauses.push('e.accounting_status=?'); args.push(options.status) }
  args.push(Math.max(0, Math.min(options.limit ?? 500, 5_000)))
  const sql = `SELECT e.* FROM usage_entries e WHERE ${clauses.join(' AND ')} ORDER BY e.created_at,e.id LIMIT ?`
  return (db.prepare(sql).all(...args) as unknown as RawEntry[]).map(mapEntry)
}

/**
 * Stable, gap-free snapshot scan used by aggregate rebuilds. `afterId` is the
 * last id returned by the preceding page; revisions are collapsed before the
 * cursor predicate so a rebuild sees exactly one current row per entry.
 */
export function scanUsageEntries(
  db: DatabaseSync,
  options: { afterId?: string | null; status?: UsageAccountingStatus; limit?: number } = {}
): UsageEntry[] {
  const clauses = [CURRENT_REVISION, 'e.id>?']
  const args: (string | number)[] = [options.afterId ?? '']
  if (options.status) { clauses.push('e.accounting_status=?'); args.push(options.status) }
  args.push(Math.max(1, Math.min(options.limit ?? 1_000, 5_000)))
  const sql = `SELECT e.* FROM usage_entries e WHERE ${clauses.join(' AND ')} ORDER BY e.id LIMIT ?`
  return (db.prepare(sql).all(...args) as unknown as RawEntry[]).map(mapEntry)
}

/** Cursor page of current ledger entries with their current attribution. */
export function queryUsageEntries(
  db: DatabaseSync,
  options: {
    harnessId?: string
    status?: UsageAccountingStatus
    afterId?: string | null
    limit?: number
  } = {}
): { items: UsageEntryWithAttribution[]; nextCursor?: string } {
  const limit = Math.max(1, Math.min(options.limit ?? 500, 5_000))
  const clauses = [CURRENT_REVISION, 'e.id>?']
  const args: (string | number)[] = [options.afterId ?? '']
  if (options.harnessId) { clauses.push('e.harness_id=?'); args.push(options.harnessId) }
  if (options.status) { clauses.push('e.accounting_status=?'); args.push(options.status) }
  args.push(limit)
  const sql = `SELECT e.* FROM usage_entries e WHERE ${clauses.join(' AND ')} ORDER BY e.id LIMIT ?`
  const entries = (db.prepare(sql).all(...args) as unknown as RawEntry[]).map(mapEntry)
  const byEntry = new Map(listUsageAttributions(db, entries.map((entry) => entry.id))
    .map((attribution) => [attribution.entryId, attribution]))
  const last = entries[entries.length - 1]
  return {
    items: entries.map((entry) => ({ entry, attribution: byEntry.get(entry.id) ?? null })),
    ...(entries.length === limit && last ? { nextCursor: last.id } : {})
  }
}

export function getUsageEntryWithAttribution(
  db: DatabaseSync,
  id: string
): UsageEntryWithAttribution | null {
  const entry = getUsageEntry(db, id)
  return entry ? { entry, attribution: getUsageAttribution(db, id) } : null
}

export function reviseUsageAttributionInTransaction(
  db: DatabaseSync,
  attribution: UsageAttribution,
  changedAt: number
): UsageAttribution {
  if (!getUsageEntry(db, attribution.entryId)) {
    throw new Error(`unknown usage entry ${attribution.entryId}`)
  }
  if (attribution.connectionId && (attribution.providerId || attribution.offeringId)) {
    throw new Error('provider/offering must be derived from a known connection, not duplicated')
  }
  const latest = db.prepare('SELECT MAX(revision) AS revision FROM usage_attributions WHERE entry_id=?')
    .get(attribution.entryId) as { revision: number | null }
  const revision = (latest.revision ?? 0) + 1
  const stored = { ...attribution, revision }
  db.prepare(
    `INSERT INTO usage_attributions
       (entry_id,revision,connection_id,offering_id,provider_id,credential_id,
        requested_model_json,served_model_json,execution_id,dispatch_id,basis,evidence_json,status,
        valid_from_revision)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(stored.entryId, revision, stored.connectionId ?? null, stored.offeringId ?? null,
    stored.providerId ?? null, stored.credentialId ?? null,
    stored.requestedModel == null ? null : json(stored.requestedModel),
    stored.servedModel == null ? null : json(stored.servedModel), stored.executionId ?? null,
    stored.dispatchId ?? null, stored.basis, json(stored.evidence), stored.status,
    stored.validFromRevision)
  recordChange(db, stored.entryId, revision, 'attribution', changedAt)
  return stored
}

export function reviseUsageAttribution(
  db: DatabaseSync,
  attribution: UsageAttribution,
  changedAt: number
): UsageAttribution {
  return withTx(db, (tx) => reviseUsageAttributionInTransaction(tx, attribution, changedAt))
}

interface RawAttribution {
  entry_id: string; revision: number; connection_id: string | null; offering_id: string | null
  provider_id: string | null; credential_id: string | null; requested_model_json: string | null
  served_model_json: string | null; execution_id: string | null; dispatch_id: string | null
  basis: UsageAttribution['basis']; evidence_json: string; status: UsageAttribution['status']
  valid_from_revision: number
}

const mapAttribution = (r: RawAttribution): UsageAttribution => ({
  entryId: r.entry_id, revision: r.revision, connectionId: r.connection_id,
  offeringId: r.offering_id, providerId: r.provider_id, credentialId: r.credential_id,
  requestedModel: parse(r.requested_model_json, null),
  servedModel: parse(r.served_model_json, null),
  executionId: r.execution_id, dispatchId: r.dispatch_id, basis: r.basis,
  evidence: parse(r.evidence_json, []), status: r.status,
  validFromRevision: r.valid_from_revision
})

export function getUsageAttribution(db: DatabaseSync, entryId: string): UsageAttribution | null {
  const row = db.prepare(
    'SELECT * FROM usage_attributions WHERE entry_id=? ORDER BY revision DESC LIMIT 1'
  ).get(entryId)
  return row ? mapAttribution(row as unknown as RawAttribution) : null
}

export function listUsageAttributions(
  db: DatabaseSync,
  entryIds: readonly string[]
): UsageAttribution[] {
  if (entryIds.length === 0) return []
  const marks = entryIds.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT a.* FROM usage_attributions a
     WHERE a.entry_id IN (${marks}) AND
       a.revision=(SELECT MAX(x.revision) FROM usage_attributions x WHERE x.entry_id=a.entry_id)
     ORDER BY a.entry_id`
  ).all(...entryIds) as unknown as RawAttribution[]
  return rows.map(mapAttribution)
}

export function usageLedgerWatermark(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(MAX(sequence),0) AS watermark FROM usage_ledger_changes')
    .get() as { watermark: number }
  return row.watermark
}

export function listUsageLedgerChanges(
  db: DatabaseSync,
  after: number,
  limit = 500
): UsageLedgerChange[] {
  const rows = db.prepare(
    `SELECT sequence,entry_id,entry_revision,kind,changed_at FROM usage_ledger_changes
     WHERE sequence>? ORDER BY sequence LIMIT ?`
  ).all(after, Math.max(0, Math.min(limit, 5_000))) as unknown as Array<{
    sequence: number; entry_id: string; entry_revision: number
    kind: 'entry' | 'attribution'; changed_at: number
  }>
  return rows.map((r) => ({ sequence: r.sequence, entryId: r.entry_id,
    entryRevision: r.entry_revision, kind: r.kind, changedAt: r.changed_at }))
}

/**
 * Drain deferred counter corrections: each intent re-normalizes one bounded
 * page of its counter chain and stays pending until the chain end is reached.
 */
export function drainCounterRecomputeIntents(
  db: DatabaseSync,
  options: { limit?: number; now: number }
): { intents: number; applied: number; recomputed: number; pending: number } {
  return withTx(db, (tx) => {
    const intents = listCounterRecomputeIntents(tx,
      { state: 'pending', limit: options.limit ?? 10 })
    let applied = 0
    let recomputed = 0
    for (const intent of intents) {
      const port = chainEntryPort(tx, { harnessId: intent.key.harnessId,
        accountingNamespace: intent.key.accountingNamespace })
      const result = recomputeCounterChain(tx, intent.key, intent.cursor, port,
        { limit: CHAIN_RECOMPUTE_LIMIT, changedAt: options.now })
      recomputed += result.recomputed
      if (result.exhausted) {
        applyCounterRecomputeIntent(tx, intent.id, null, options.now)
        applied += 1
      } else {
        applyCounterRecomputeIntent(tx, intent.id, result.cursor, options.now)
      }
    }
    const pending = listCounterRecomputeIntents(tx, { state: 'pending', limit: 1 }).length
    return { intents: intents.length, applied, recomputed, pending }
  })
}
