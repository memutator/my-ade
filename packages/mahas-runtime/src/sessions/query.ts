// sessions/query.ts — durable read models over persisted sessions.
//
// A session row is discovered evidence only: reading it here never creates a
// Task or an Execution, and a session whose origin machine is another host
// stays visible with its own origin instead of being merged into a local one.

import type { DatabaseSync } from 'node:sqlite'
import type {
  HarnessSession,
  HarnessSessionId,
  SessionDetailResult,
  SessionEventKind,
  SessionEventQueryResult,
  SessionHandleQueryResult,
  SessionQueryResult
} from '../../../mahas-contracts/src/sessions/index.ts'
import { listSessionAttachments, listSessionHandles } from './store.ts'
import { listSessionEvents } from './observations.ts'

const parsed = <T>(value: string | null, fallback: T): T => {
  if (value === null) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

interface RawSessionRow {
  id: string; harness_id: string; origin_machine_id: string | null; namespace: string
  native_session_key: string; parent_session_id: string | null; title: string | null
  first_observed_at: number; last_observed_at: number; metadata_json: string
}

const mapSession = (row: RawSessionRow): HarnessSession => ({
  id: row.id, harnessId: row.harness_id, originMachineId: row.origin_machine_id,
  namespace: row.namespace, nativeSessionKey: row.native_session_key,
  parentSessionId: row.parent_session_id, title: row.title,
  firstObservedAt: row.first_observed_at, lastObservedAt: row.last_observed_at,
  metadata: parsed(row.metadata_json, {})
})

export interface SessionQueryOptions {
  harnessId?: string
  originMachineId?: string
  parentSessionId?: string
  /** only sessions with no known parent */
  rootsOnly?: boolean
  /** only sessions with a handle at this installation (resume candidates) */
  installationId?: string
  afterId?: string | null
  limit?: number
}

export function queryHarnessSessions(
  db: DatabaseSync,
  options: SessionQueryOptions = {}
): SessionQueryResult {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000))
  const clauses = ['s.id>?']
  const args: (string | number)[] = [options.afterId ?? '']
  if (options.harnessId) { clauses.push('s.harness_id=?'); args.push(options.harnessId) }
  if (options.originMachineId) {
    clauses.push('s.origin_machine_id=?'); args.push(options.originMachineId)
  }
  if (options.parentSessionId) {
    clauses.push('s.parent_session_id=?'); args.push(options.parentSessionId)
  } else if (options.rootsOnly) {
    clauses.push('s.parent_session_id IS NULL')
  }
  if (options.installationId) {
    clauses.push('EXISTS (SELECT 1 FROM session_handles h WHERE h.session_id=s.id AND h.installation_id=?)')
    args.push(options.installationId)
  }
  args.push(limit)
  const sql = `SELECT s.* FROM harness_sessions s WHERE ${clauses.join(' AND ')} ORDER BY s.id LIMIT ?`
  const items = (db.prepare(sql).all(...args) as unknown as RawSessionRow[]).map(mapSession)
  const last = items[items.length - 1]
  return {
    items, asOf: Date.now(),
    ...(items.length === limit && last ? { nextCursor: last.id } : {})
  }
}

export function listChildSessionIds(
  db: DatabaseSync,
  parentSessionId: HarnessSessionId
): HarnessSessionId[] {
  return (db.prepare(
    'SELECT id FROM harness_sessions WHERE parent_session_id=? ORDER BY id'
  ).all(parentSessionId) as unknown as Array<{ id: string }>).map((row) => row.id)
}

export function getSessionDetail(
  db: DatabaseSync,
  sessionId: HarnessSessionId
): SessionDetailResult | null {
  const row = db.prepare('SELECT * FROM harness_sessions WHERE id=?').get(sessionId)
  if (!row) return null
  const session = mapSession(row as unknown as RawSessionRow)
  const last = db.prepare(
    `SELECT o.fact_type AS kind, o.observed_at AS observed_at
     FROM observation_session_facets f JOIN observations o ON o.id=f.observation_id
     WHERE f.session_id=? ORDER BY o.observed_at DESC,o.rowid DESC LIMIT 1`
  ).get(sessionId) as { kind: string; observed_at: number } | undefined
  return {
    session,
    handles: listSessionHandles(db, sessionId),
    attachments: listSessionAttachments(db, sessionId),
    childSessionIds: listChildSessionIds(db, sessionId),
    lastEventAt: last?.observed_at ?? null,
    lastEventKind: (last?.kind as SessionEventKind | undefined) ?? null,
    asOf: Date.now()
  }
}

export function querySessionEvents(
  db: DatabaseSync,
  sessionId: HarnessSessionId,
  options: { limit?: number } = {}
): SessionEventQueryResult {
  return { items: listSessionEvents(db, sessionId, options.limit ?? 200), asOf: Date.now() }
}

export function querySessionHandles(
  db: DatabaseSync,
  sessionId: HarnessSessionId
): SessionHandleQueryResult {
  return { items: listSessionHandles(db, sessionId), asOf: Date.now() }
}

