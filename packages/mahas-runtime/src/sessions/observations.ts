import type { DatabaseSync } from 'node:sqlite'
import type { SessionEvent } from '../../../mahas-contracts/src/sessions/index.ts'
import { getObservation, insertObservation } from '../observation/facts.ts'

export function insertSessionEventObservation(db: DatabaseSync, event: SessionEvent): void {
  insertObservation(db, {
    id: event.observationId,
    executionId: null,
    dispatchId: null,
    source: event.origin,
    factType: event.kind,
    observedAt: event.observedAt,
    payload: { schema: 'mahas.session-event/v1', ...event.payload },
    identityEvidence: { sessionId: event.sessionId ?? null, evidence: event.evidence }
  })
  db.prepare(
    `INSERT INTO observation_session_facets
       (observation_id,session_id,attachment_id,native_kind,native_turn_id,occurred_at,origin)
     VALUES (?,?,?,?,?,?,?)`
  ).run(event.observationId, event.sessionId ?? null, event.attachmentId ?? null,
    event.nativeKind, event.nativeTurnId ?? null, event.occurredAt ?? null, event.origin)
}

interface RawFacet {
  observation_id: string; session_id: string | null; attachment_id: string | null
  native_kind: string; native_turn_id: string | null; occurred_at: number | null; origin: string
}

export function getSessionEvent(db: DatabaseSync, observationId: string): SessionEvent | null {
  const facet = db.prepare(
    'SELECT * FROM observation_session_facets WHERE observation_id=?'
  ).get(observationId) as RawFacet | undefined
  const observation = facet ? getObservation(db, observationId) : null
  if (!facet || !observation) return null
  const raw = observation.payload as Record<string, unknown> | null
  // The payload schema tag travels on the observation fact, not on the event body.
  const { schema: payloadSchema, ...payload } = raw ?? {}
  void payloadSchema
  return {
    observationId: facet.observation_id,
    sessionId: facet.session_id,
    attachmentId: facet.attachment_id,
    kind: observation.factType as SessionEvent['kind'],
    nativeKind: facet.native_kind,
    nativeTurnId: facet.native_turn_id,
    occurredAt: facet.occurred_at,
    observedAt: observation.observedAt,
    origin: facet.origin,
    payload,
    evidence: (observation.identityEvidence['evidence'] ?? []) as SessionEvent['evidence']
  }
}

export function listSessionEvents(db: DatabaseSync, sessionId: string, limit = 200): SessionEvent[] {
  const ids = db.prepare(
    `SELECT f.observation_id FROM observation_session_facets f
     JOIN observations o ON o.id=f.observation_id
     WHERE f.session_id=? ORDER BY o.observed_at DESC,o.rowid DESC LIMIT ?`
  ).all(sessionId, Math.max(0, Math.min(limit, 1_000))) as unknown as { observation_id: string }[]
  return ids.map((r) => getSessionEvent(db, r.observation_id)).filter((v): v is SessionEvent => v !== null)
}
