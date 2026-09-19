import type { DatabaseSync } from 'node:sqlite'
import type {
  CollectionBatch,
  CollectionCoverage,
  CollectionSource,
  CollectionStatusResult
} from '../../../../mahas-contracts/src/metering/index.ts'
import { getCollectionCursor } from './commit.ts'
import { countPendingCollectionRequests, listCollectionRequests } from './requests.ts'

const parse = <T>(text: string | null, fallback: T): T => {
  if (text === null) return fallback
  try { return JSON.parse(text) as T } catch { return fallback }
}

export function getCollectionSource(db: DatabaseSync, id: string): CollectionSource | null {
  const r = db.prepare('SELECT * FROM collection_sources WHERE id=?').get(id) as Record<string, unknown> | undefined
  return r ? {
    id: String(r['id']), machineId: String(r['machine_id']),
    subject: parse(String(r['subject_json']), { kind: 'machine', machineId: '' }),
    locator: parse(String(r['locator_json']), {}), kind: r['kind'] as CollectionSource['kind'],
    sourceGeneration: String(r['source_generation']),
    identityEvidence: parse(String(r['identity_evidence_json']), {}),
    status: r['status'] as CollectionSource['status'], firstObservedAt: Number(r['first_observed_at']),
    lastObservedAt: Number(r['last_observed_at'])
  } : null
}

export function listCollectionBatches(db: DatabaseSync, sourceId: string, limit = 100): CollectionBatch[] {
  return (db.prepare(
    'SELECT * FROM collection_batches WHERE source_id=? ORDER BY started_at DESC,id LIMIT ?'
  ).all(sourceId, Math.max(0, Math.min(limit, 1_000))) as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r['id']), sourceId: String(r['source_id']), sourceGeneration: String(r['source_generation']),
    adapterPackId: String(r['adapter_pack_id']), adapterPackRevision: Number(r['adapter_pack_revision']),
    integrationContractId: String(r['integration_contract_id']), contractRevision: Number(r['contract_revision']),
    cursorBefore: r['cursor_before_json'] == null ? null : parse(String(r['cursor_before_json']), null),
    cursorAfter: r['cursor_after_json'] == null ? null : parse(String(r['cursor_after_json']), null),
    startedAt: Number(r['started_at']), committedAt: r['committed_at'] == null ? null : Number(r['committed_at']),
    result: r['result'] as CollectionBatch['result'], diagnostics: parse(String(r['diagnostics_json']), [])
  }))
}

export function listCollectionCoverage(
  db: DatabaseSync,
  sourceId: string,
  limit = 500
): CollectionCoverage[] {
  return (db.prepare(
    `SELECT * FROM collection_coverage WHERE source_id=?
     ORDER BY COALESCE(last_success_at,0) DESC,id LIMIT ?`
  ).all(sourceId, Math.max(0, Math.min(limit, 5_000))) as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r['id']), sourceId: r['source_id'] == null ? null : String(r['source_id']),
    subject: parse(String(r['subject_json']), { kind: 'machine', machineId: '' }),
    interval: r['interval_json'] == null ? null : parse(String(r['interval_json']), null),
    completeness: r['completeness'] as CollectionCoverage['completeness'],
    gapReason: r['gap_reason'] == null ? null : String(r['gap_reason']),
    lastSuccessAt: r['last_success_at'] == null ? null : Number(r['last_success_at']),
    watermark: r['watermark'] == null ? null : String(r['watermark'])
  }))
}

export interface CollectionSourceQueryOptions {
  machineId?: string
  status?: CollectionSource['status']
  afterId?: string | null
  limit?: number
}

/** Cursor page over stored sources; a scheduler restart walks this to resume. */
export function queryCollectionSources(
  db: DatabaseSync,
  options: CollectionSourceQueryOptions = {}
): { items: CollectionSource[]; nextCursor?: string } {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000))
  const clauses = ['id>?']
  const args: (string | number)[] = [options.afterId ?? '']
  if (options.machineId) { clauses.push('machine_id=?'); args.push(options.machineId) }
  if (options.status) { clauses.push('status=?'); args.push(options.status) }
  args.push(limit)
  const sql = `SELECT * FROM collection_sources WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`
  const items = (db.prepare(sql).all(...args) as unknown as Record<string, unknown>[])
    .map((row) => getCollectionSource(db, String(row['id']))!)
  const last = items[items.length - 1]
  return {
    items,
    ...(items.length === limit && last ? { nextCursor: last.id } : {})
  }
}

/**
 * The newest collection that reported complete coverage. `undefined` and `null`
 * stay distinct on the wire: no successful collection is not the same as an
 * unknown one, and neither is a zero timestamp.
 */
export function lastSuccessfulCollectionAt(db: DatabaseSync): number | null {
  const row = db.prepare(
    `SELECT MAX(last_success_at) AS last_success_at FROM collection_coverage
     WHERE last_success_at IS NOT NULL`
  ).get() as { last_success_at: number | null }
  return row.last_success_at
}

export interface CollectionStatusOptions {
  batchLimit?: number
  coverageLimit?: number
  requestLimit?: number
}

/** Per-source status DTO: what is stored, what is due, and what is missing. */
export function getCollectionStatus(
  db: DatabaseSync,
  sourceId: string,
  options: CollectionStatusOptions = {}
): CollectionStatusResult | null {
  const source = getCollectionSource(db, sourceId)
  if (!source) return null
  const batches = listCollectionBatches(db, sourceId, options.batchLimit ?? 20)
  const coverage = listCollectionCoverage(db, sourceId, options.coverageLimit ?? 50)
  const requests = listCollectionRequests(db, { sourceId, limit: options.requestLimit ?? 20 })
  const unidentified: Array<{ axis: string; amount: number | null; reason: string }> = []
  if (source.status !== 'active') {
    unidentified.push({ axis: 'source', amount: null,
      reason: `source status is ${source.status}` })
  }
  const gaps = coverage.filter((item) => item.completeness !== 'complete')
  if (gaps.length > 0) {
    unidentified.push({ axis: 'coverage', amount: null,
      reason: `${gaps.length} coverage records are partial, gap or unknown` })
  }
  return {
    source,
    cursor: getCollectionCursor(db, sourceId),
    latestBatch: batches[0] ?? null,
    batches,
    coverage,
    requests,
    pendingRequestCount: countPendingCollectionRequests(db, sourceId),
    freshness: { asOf: Date.now(), lastSuccessfulCollectionAt: lastSuccessfulCollectionAt(db) },
    unidentified
  }
}
