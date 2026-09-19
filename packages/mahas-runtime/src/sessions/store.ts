import type { DatabaseSync } from 'node:sqlite'
import type { JsonObject } from '../../../mahas-contracts/src/common.ts'
import type {
  HarnessSession,
  HarnessSessionId,
  SessionAttachment,
  SessionHandle,
  SessionNamespaceAlias
} from '../../../mahas-contracts/src/sessions/index.ts'

const json = (value: unknown): string => JSON.stringify(value ?? null)
const parsed = <T>(value: string | null, fallback: T): T => {
  if (value === null) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

interface RawSession {
  id: string
  harness_id: string
  origin_machine_id: string | null
  namespace: string
  native_session_key: string
  parent_session_id: string | null
  title: string | null
  first_observed_at: number
  last_observed_at: number
  metadata_json: string
}

const mapSession = (row: RawSession): HarnessSession => ({
  id: row.id,
  harnessId: row.harness_id,
  originMachineId: row.origin_machine_id,
  namespace: row.namespace,
  nativeSessionKey: row.native_session_key,
  parentSessionId: row.parent_session_id,
  title: row.title,
  firstObservedAt: row.first_observed_at,
  lastObservedAt: row.last_observed_at,
  metadata: parsed(row.metadata_json, {})
})

/**
 * Upserts only by the full native identity. A suffix or title is never a
 * merge key. The first observation never moves forward and the last never
 * moves backward, so discovery replay is harmless.
 */
/** Only plain objects are mergeable metadata; anything else is treated as absent. */
function metadataObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
}

/**
 * Metadata is additive. A later Pack upsert that simply omits a key must not
 * drop what a backfill already wrote — a lost `harnessProfileId` refuses
 * resume — so the stored object is merged with the incoming one instead of
 * being replaced. An observation that is NOT newer than the stored row only
 * fills gaps, so a late batch cannot flip a field a newer batch stated. A null
 * incoming value is "no statement", matching the COALESCE rules on the
 * columns above; the merge is top-level, nested objects are opaque values.
 */
function mergeSessionMetadata(
  existing: JsonObject,
  incoming: JsonObject,
  incomingIsNewer: boolean
): JsonObject {
  const merged: JsonObject = { ...existing }
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) continue
    if (!(key in merged) || incomingIsNewer) merged[key] = value
  }
  return merged
}

export function upsertHarnessSession(db: DatabaseSync, session: HarnessSession): HarnessSession {
  const identity = db
    .prepare(
      `SELECT id FROM harness_sessions
       WHERE harness_id=? AND namespace=? AND native_session_key=?`
    )
    .get(session.harnessId, session.namespace, session.nativeSessionKey) as
    | { id: string }
    | undefined
  if (identity && identity.id !== session.id) {
    throw new Error(`session identity already belongs to ${identity.id}`)
  }
  const prior = db.prepare(
    'SELECT last_observed_at,metadata_json FROM harness_sessions WHERE id=?'
  ).get(session.id) as { last_observed_at: number; metadata_json: string } | undefined
  const metadata = prior
    ? mergeSessionMetadata(metadataObject(parsed(prior.metadata_json, {})),
        metadataObject(session.metadata), session.lastObservedAt >= prior.last_observed_at)
    : metadataObject(session.metadata)
  db.prepare(
    `INSERT INTO harness_sessions
       (id,harness_id,origin_machine_id,namespace,native_session_key,parent_session_id,title,
        first_observed_at,last_observed_at,metadata_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       origin_machine_id=COALESCE(harness_sessions.origin_machine_id,excluded.origin_machine_id),
       parent_session_id=COALESCE(harness_sessions.parent_session_id,excluded.parent_session_id),
       title=COALESCE(excluded.title,harness_sessions.title),
       first_observed_at=MIN(harness_sessions.first_observed_at,excluded.first_observed_at),
       last_observed_at=MAX(harness_sessions.last_observed_at,excluded.last_observed_at),
       metadata_json=excluded.metadata_json`
  ).run(
    session.id,
    session.harnessId,
    session.originMachineId ?? null,
    session.namespace,
    session.nativeSessionKey,
    session.parentSessionId ?? null,
    session.title ?? null,
    session.firstObservedAt,
    session.lastObservedAt,
    json(metadata)
  )
  const stored = getHarnessSession(db, session.id)
  if (!stored || stored.harnessId !== session.harnessId || stored.namespace !== session.namespace ||
      stored.nativeSessionKey !== session.nativeSessionKey) {
    throw new Error(`session ${session.id} cannot change native identity`)
  }
  return stored
}

export function getHarnessSession(db: DatabaseSync, id: HarnessSessionId): HarnessSession | null {
  const row = db.prepare('SELECT * FROM harness_sessions WHERE id=?').get(id) as RawSession | undefined
  return row ? mapSession(row) : null
}

export function findHarnessSession(
  db: DatabaseSync,
  harnessId: string,
  namespace: string,
  nativeSessionKey: string
): HarnessSession | null {
  const row = db
    .prepare(
      `SELECT * FROM harness_sessions
       WHERE harness_id=? AND namespace=? AND native_session_key=?`
    )
    .get(harnessId, namespace, nativeSessionKey) as RawSession | undefined
  return row ? mapSession(row) : null
}

export function listHarnessSessions(
  db: DatabaseSync,
  options: { harnessId?: string; limit?: number } = {}
): HarnessSession[] {
  const limit = Math.max(0, Math.min(options.limit ?? 100, 1_000))
  const rows = options.harnessId
    ? db.prepare(
        'SELECT * FROM harness_sessions WHERE harness_id=? ORDER BY last_observed_at DESC,id LIMIT ?'
      ).all(options.harnessId, limit)
    : db.prepare('SELECT * FROM harness_sessions ORDER BY last_observed_at DESC,id LIMIT ?').all(limit)
  return (rows as unknown as RawSession[]).map(mapSession)
}

export function putSessionNamespaceAlias(db: DatabaseSync, alias: SessionNamespaceAlias): void {
  const session = getHarnessSession(db, alias.sessionId)
  if (!session) throw new Error(`unknown session ${alias.sessionId}`)
  db.prepare(
    `INSERT INTO session_namespace_aliases
       (id,session_id,harness_id,namespace,native_session_key,valid_from,valid_until,evidence_json)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET valid_until=excluded.valid_until,evidence_json=excluded.evidence_json`
  ).run(alias.id, alias.sessionId, session.harnessId, alias.namespace, alias.nativeSessionKey, alias.validFrom,
    alias.validUntil ?? null, json(alias.evidence))
}

export function putSessionHandle(db: DatabaseSync, handle: SessionHandle): void {
  db.prepare(
    `INSERT INTO session_handles
       (id,session_id,installation_id,native_id,locator_json,resume_support,observed_at,evidence_json)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       locator_json=excluded.locator_json,resume_support=excluded.resume_support,
       observed_at=MAX(session_handles.observed_at,excluded.observed_at),evidence_json=excluded.evidence_json`
  ).run(handle.id, handle.sessionId, handle.installationId ?? null, handle.nativeId,
    handle.locator == null ? null : json(handle.locator), handle.resumeSupport, handle.observedAt,
    json(handle.evidence))
}

interface RawHandle {
  id: string; session_id: string; installation_id: string | null; native_id: string
  locator_json: string | null; resume_support: SessionHandle['resumeSupport']; observed_at: number
  evidence_json: string
}

export function listSessionHandles(db: DatabaseSync, sessionId: HarnessSessionId): SessionHandle[] {
  return (db.prepare(
    'SELECT * FROM session_handles WHERE session_id=? ORDER BY observed_at DESC,id'
  ).all(sessionId) as unknown as RawHandle[]).map((r) => ({
    id: r.id, sessionId: r.session_id, installationId: r.installation_id, nativeId: r.native_id,
    locator: parsed(r.locator_json, null), resumeSupport: r.resume_support, observedAt: r.observed_at,
    evidence: parsed(r.evidence_json, [])
  }))
}

export function putSessionAttachment(db: DatabaseSync, attachment: SessionAttachment): void {
  db.prepare(
    `INSERT INTO session_attachments
       (id,session_id,installation_id,machine_id,process_identity_json,execution_id,dispatch_id,
        observed_from,observed_until,evidence_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       observed_until=excluded.observed_until,evidence_json=excluded.evidence_json`
  ).run(attachment.id, attachment.sessionId, attachment.installationId ?? null,
    attachment.machineId, attachment.processIdentity == null ? null : json(attachment.processIdentity),
    attachment.executionId ?? null, attachment.dispatchId ?? null, attachment.observedFrom,
    attachment.observedUntil ?? null, json(attachment.evidence))
}

interface RawAttachment {
  id: string; session_id: string; installation_id: string | null; machine_id: string
  process_identity_json: string | null; execution_id: string | null; dispatch_id: string | null
  observed_from: number; observed_until: number | null; evidence_json: string
}

export function listSessionAttachments(
  db: DatabaseSync,
  sessionId: HarnessSessionId
): SessionAttachment[] {
  return (db.prepare(
    'SELECT * FROM session_attachments WHERE session_id=? ORDER BY observed_from DESC,id'
  ).all(sessionId) as unknown as RawAttachment[]).map((r) => ({
    id: r.id, sessionId: r.session_id, installationId: r.installation_id,
    machineId: r.machine_id, processIdentity: parsed(r.process_identity_json, null),
    executionId: r.execution_id, dispatchId: r.dispatch_id, observedFrom: r.observed_from,
    observedUntil: r.observed_until, evidence: parsed(r.evidence_json, [])
  }))
}
