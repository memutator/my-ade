// observation/collection/requests.ts — the durable collection request queue.
//
// A request is a queued intent, never an execution: the operation transaction
// only writes the row, and the scheduler claims it and runs one bounded Pack
// batch outside that transaction. A daemon restart recovers by scanning pending
// rows, so a UI "collect now" cannot leave the collection path half-run.

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  CollectionCapability,
  CollectionDiagnostic,
  CollectionRequest,
  CollectionRequestStatus
} from '../../../../mahas-contracts/src/metering/index.ts'

const json = (value: unknown): string => JSON.stringify(value ?? null)

const parse = <T>(text: string, fallback: T): T => {
  try { return JSON.parse(text) as T } catch { return fallback }
}

interface RawRequest {
  id: string; source_id: string; capability: CollectionCapability; requested_by: string
  requested_at: number; not_before: number | null; max_records: number; max_bytes: number
  reason: string | null; status: CollectionRequestStatus; claimed_by: string | null
  claimed_at: number | null; claim_expires_at: number | null; attempts: number
  batch_id: string | null; processed_at: number | null; diagnostics_json: string
}

const mapRequest = (row: RawRequest): CollectionRequest => ({
  id: row.id, sourceId: row.source_id, capability: row.capability,
  requestedBy: row.requested_by, requestedAt: row.requested_at, notBefore: row.not_before,
  maxRecords: row.max_records, maxBytes: row.max_bytes, reason: row.reason,
  status: row.status, claimedBy: row.claimed_by, claimedAt: row.claimed_at,
  claimExpiresAt: row.claim_expires_at, attempts: row.attempts, batchId: row.batch_id,
  processedAt: row.processed_at, diagnostics: parse(row.diagnostics_json, [])
})

export const DEFAULT_REQUEST_MAX_RECORDS = 500
export const DEFAULT_REQUEST_MAX_BYTES = 8 * 1024 * 1024
export const DEFAULT_CLAIM_LEASE_MS = 60_000

export interface RequestCollectionInput {
  sourceId: string
  capability: CollectionCapability
  requestedBy: string
  requestedAt: number
  maxRecords?: number
  maxBytes?: number
  reason?: string | null
  notBefore?: number | null
  /** stable caller key (usually the operation id); makes the write idempotent */
  idempotencyKey?: string | null
}

export function getCollectionRequest(db: DatabaseSync, id: string): CollectionRequest | null {
  const row = db.prepare('SELECT * FROM collection_requests WHERE id=?').get(id)
  return row ? mapRequest(row as unknown as RawRequest) : null
}

/**
 * Enqueue one bounded collection. A pending request for the same source and
 * capability is coalesced instead of queued twice, so repeated UI clicks and
 * scheduler wake hints cannot pile up overlapping work for one source.
 */
export function requestCollection(
  db: DatabaseSync,
  input: RequestCollectionInput
): CollectionRequest {
  const existing = input.idempotencyKey
    ? db.prepare('SELECT * FROM collection_requests WHERE idempotency_key=?')
        .get(input.idempotencyKey) as RawRequest | undefined
    : db.prepare(
        `SELECT * FROM collection_requests WHERE source_id=? AND capability=? AND
           status IN ('pending','claimed') ORDER BY requested_at,id LIMIT 1`
      ).get(input.sourceId, input.capability) as RawRequest | undefined
  if (existing) return mapRequest(existing)
  const request: CollectionRequest = {
    id: 'creq_' + randomUUID(),
    sourceId: input.sourceId,
    capability: input.capability,
    requestedBy: input.requestedBy,
    requestedAt: input.requestedAt,
    notBefore: input.notBefore ?? null,
    maxRecords: Math.max(1, input.maxRecords ?? DEFAULT_REQUEST_MAX_RECORDS),
    maxBytes: Math.max(1, input.maxBytes ?? DEFAULT_REQUEST_MAX_BYTES),
    reason: input.reason ?? null,
    status: 'pending',
    claimedBy: null, claimedAt: null, claimExpiresAt: null, attempts: 0,
    batchId: null, processedAt: null, diagnostics: []
  }
  db.prepare(
    `INSERT INTO collection_requests
       (id,source_id,capability,requested_by,requested_at,not_before,max_records,max_bytes,reason,
        idempotency_key,status,claimed_by,claimed_at,claim_expires_at,attempts,batch_id,
        processed_at,diagnostics_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,'pending',NULL,NULL,NULL,0,NULL,NULL,'[]')`
  ).run(request.id, request.sourceId, request.capability, request.requestedBy,
    request.requestedAt, request.notBefore ?? null, request.maxRecords, request.maxBytes,
    request.reason ?? null, input.idempotencyKey ?? null)
  return request
}

export function listCollectionRequests(
  db: DatabaseSync,
  options: { sourceId?: string; status?: CollectionRequestStatus; limit?: number } = {}
): CollectionRequest[] {
  const clauses: string[] = []
  const args: (string | number)[] = []
  if (options.sourceId) { clauses.push('source_id=?'); args.push(options.sourceId) }
  if (options.status) { clauses.push('status=?'); args.push(options.status) }
  args.push(Math.max(1, Math.min(options.limit ?? 100, 1_000)))
  const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : ''
  const sql = `SELECT * FROM collection_requests ${where} ORDER BY requested_at,id LIMIT ?`
  return (db.prepare(sql).all(...args) as unknown as RawRequest[]).map(mapRequest)
}

export function countPendingCollectionRequests(db: DatabaseSync, sourceId?: string): number {
  const row = sourceId
    ? db.prepare(`SELECT COUNT(*) AS n FROM collection_requests WHERE source_id=? AND status IN ('pending','claimed')`).get(sourceId) as { n: number }
    : db.prepare(`SELECT COUNT(*) AS n FROM collection_requests WHERE status IN ('pending','claimed')`).get() as { n: number }
  return row.n
}

/**
 * Claims due requests for one scheduler pass. An expired claim returns to the
 * queue so a crashed batch does not wedge the source forever; `attempts` keeps
 * the retry count visible.
 */
export function claimCollectionRequests(
  db: DatabaseSync,
  options: {
    claimId: string
    now: number
    limit?: number
    leaseMs?: number
    sourceId?: string
  }
): CollectionRequest[] {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 100))
  const leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_CLAIM_LEASE_MS)
  const clauses = [
    `(status='pending' OR (status='claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at<=?))`,
    'COALESCE(not_before,0)<=?'
  ]
  const args: (string | number)[] = [options.now, options.now]
  if (options.sourceId) { clauses.push('source_id=?'); args.push(options.sourceId) }
  args.push(limit)
  const sql = `SELECT * FROM collection_requests WHERE ${clauses.join(' AND ')} ORDER BY requested_at,id LIMIT ?`
  const candidates = db.prepare(sql).all(...args) as unknown as RawRequest[]
  const claimed: CollectionRequest[] = []
  for (const candidate of candidates) {
    const changed = db.prepare(
      `UPDATE collection_requests SET status='claimed', claimed_by=?, claimed_at=?,
         claim_expires_at=?, attempts=attempts+1
       WHERE id=? AND (status='pending' OR (status='claimed' AND claim_expires_at IS NOT NULL AND
         claim_expires_at<=?))`
    ).run(options.claimId, options.now, options.now + leaseMs, candidate.id, options.now).changes
    if (changed !== 1) continue
    const stored = getCollectionRequest(db, candidate.id)
    if (stored) claimed.push(stored)
  }
  return claimed
}

/** One scheduler pass outcome; processed never asserts source coverage. */
export type CollectionRequestOutcome = 'processed' | 'failed' | 'cancelled'

/**
 * Settle a claimed request. The claim id is the CAS token: a worker whose lease
 * moved on cannot overwrite the row another worker now owns.
 */
export function completeCollectionRequest(
  db: DatabaseSync,
  input: {
    id: string
    claimId: string
    outcome: CollectionRequestOutcome
    batchId?: string | null
    diagnostics?: readonly CollectionDiagnostic[]
    processedAt: number
  }
): CollectionRequest {
  const changed = db.prepare(
    `UPDATE collection_requests SET status=?, batch_id=?, processed_at=?, diagnostics_json=?
     WHERE id=? AND status='claimed' AND claimed_by=?`
  ).run(input.outcome, input.batchId ?? null, input.processedAt,
    json(input.diagnostics ?? []), input.id, input.claimId).changes
  if (changed !== 1) {
    throw new Error(`collection request ${input.id} is not claimed by ${input.claimId}`)
  }
  const stored = getCollectionRequest(db, input.id)
  if (!stored) throw new Error(`collection request ${input.id} disappeared`)
  return stored
}

/** Cancel a request that has not settled yet (queue hygiene, not an abort). */
export function cancelCollectionRequest(
  db: DatabaseSync,
  input: { id: string; cancelledAt: number; reason?: string | null }
): CollectionRequest {
  const changed = db.prepare(
    `UPDATE collection_requests SET status='cancelled', processed_at=?, claimed_by=NULL,
       claim_expires_at=NULL, diagnostics_json=?
     WHERE id=? AND status IN ('pending','claimed')`
  ).run(input.cancelledAt,
    json(input.reason ? [{ code: 'cancelled', severity: 'info', message: input.reason }] : []),
    input.id).changes
  if (changed !== 1) throw new Error(`collection request ${input.id} is already settled`)
  const stored = getCollectionRequest(db, input.id)
  if (!stored) throw new Error(`collection request ${input.id} disappeared`)
  return stored
}
