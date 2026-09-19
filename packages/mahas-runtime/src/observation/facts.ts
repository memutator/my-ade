// observation/facts.ts — ObservationFact model, storage mapping, taxonomy.
//
// C-OBSERVATION `observation.ingest` + spec/domains/resources-observation.md
// §2: an ObservationFact keeps the SOURCE of the signal (hook, process
// detection, agent-declared, service) and the identity evidence it carried.
// Facts are observation records only — REQ-23/REQ-24: a fact is never Task
// or Delivery settlement, and output silence is never completion.
//
// Storage (spec/storage.md §3 `observations`): id, execution_id?,
// dispatch_id?, source, fact_type, observed_at, payload_json,
// identity_evidence_json. `confidenceClass` is a spec §2 field with no DDL
// column — it is persisted inside identity_evidence_json.confidenceClass.

import type { DatabaseSync } from 'node:sqlite'
import type { Observation } from '../../../mahas-contracts/src/index.ts'

/** spec §2 — provenance classes; the source stays attached to the fact. */
export type ObservationSource = 'hook' | 'process' | 'agent-declared' | 'service'

export const OBSERVATION_SOURCES: readonly ObservationSource[] = [
  'hook',
  'process',
  'agent-declared',
  'service'
]

/**
 * How strongly the fact is tied to a managed execution.
 *  - attributed: bound to an execution/dispatch by strong identity evidence
 *    (stamped ids, terminal id, native conversation handle, spawn nonce).
 *  - declared: bound by a caller hint or weak evidence (cwd-only) — the
 *    binding is the caller's claim, not verified identity.
 *  - unbound: no execution could be resolved; kept for audit, projected
 *    separately, never routed into settlement channels.
 *  - foreign: evidence says the fact belongs to another controller/session —
 *    stored but explicitly not ours (legacy `ours` filter port, REQ-23).
 */
export type ConfidenceClass = 'attributed' | 'declared' | 'unbound' | 'foreign'

/** spec §2 field set; JSON-payload columns keep their spec object shape. */
export interface IdentityEvidence {
  /** set by attribution resolution — the only writer is this boundary */
  confidenceClass?: ConfidenceClass
  /** why this class was assigned (adoption reason, missing hint, …) */
  attribution?: string
  /** controller/ingress session stamp — a foreign value means not-ours */
  mahasSession?: string
  /** legacy env-stamped pane/tab ids riding shell→agent→hook */
  paneId?: string
  tabId?: string
  terminalId?: string
  ptyId?: string
  spawnNonce?: string
  /** provider-native conversation/session id (resume hint, not authority) */
  nativeSessionId?: string
  provider?: string
  cwd?: string
  pid?: number
  runId?: string
  memberId?: string
  [k: string]: unknown
}

/** storage row shape for the `observations` table (DDL §3, camelCased). */
export interface ObservationRow {
  id: string
  executionId: string | null
  dispatchId: string | null
  source: string
  factType: string
  observedAt: number
  payload: unknown
  identityEvidence: IdentityEvidence
}

// ---------------------------------------------------------------------------
// fact-type taxonomy — ported from the legacy hook normalizer + attention
// policy (src/renderer/src/attention.ts). These sets classify what a fact
// MEANS for projected state; they never decide Task outcome.
// ---------------------------------------------------------------------------

/** events that can demand user attention — everything else is tracking-only */
export const NOTIFY_FACT_TYPES = new Set(['turn-complete', 'needs-input', 'error'])

/**
 * events that settle a pending needs-input: the turn moved on, finished,
 * was cancelled, errored, ended, or a new ask superseded the old one.
 * 'process-idle' settles too — the agent process left the tree, so a live
 * prompt died with it (legacy reportProcessIdle → settleFor).
 */
export const SETTLE_FACT_TYPES = new Set([
  'turn-start',
  'turn-complete',
  'turn-cancelled',
  'error',
  'session-end',
  'needs-input',
  'process-idle'
])

/** events that light the working projection — a real top-level turn began */
export const WORKING_SET_FACT_TYPES = new Set(['turn-start'])

/** events that drop the working projection — 'other' deliberately absent */
export const WORKING_CLEAR_FACT_TYPES = new Set([
  'turn-complete',
  'needs-input',
  'error',
  'turn-cancelled',
  'session-end',
  'process-idle',
  'idle'
])

/** events proving a real top-level turn — may displace a resume claim */
export const STRONG_RESUME_FACT_TYPES = new Set([
  'session-start',
  'turn-start',
  'turn-complete',
  'turn-cancelled',
  'needs-input',
  'error'
])

/** projected agent activity — an observation projection, never Task outcome */
export type AgentActivity = 'working' | 'idle' | 'needs-input' | 'unknown'

// ---------------------------------------------------------------------------
// storage mapping
// ---------------------------------------------------------------------------

export function insertObservation(db: DatabaseSync, row: ObservationRow): void {
  db.prepare(
    `INSERT INTO observations
       (id, execution_id, dispatch_id, source, fact_type, observed_at, payload_json, identity_evidence_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.executionId,
    row.dispatchId,
    row.source,
    row.factType,
    row.observedAt,
    JSON.stringify(row.payload ?? null),
    JSON.stringify(row.identityEvidence ?? {})
  )
}

interface RawObservationRow {
  id: string
  execution_id: string | null
  dispatch_id: string | null
  source: string
  fact_type: string
  observed_at: number
  payload_json: string
  identity_evidence_json: string
}

function parseJson(text: string, fallback: unknown): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function toObservationRow(raw: RawObservationRow): ObservationRow {
  return {
    id: raw.id,
    executionId: raw.execution_id,
    dispatchId: raw.dispatch_id,
    source: raw.source,
    factType: raw.fact_type,
    observedAt: raw.observed_at,
    payload: parseJson(raw.payload_json, null),
    identityEvidence: (parseJson(raw.identity_evidence_json, {}) ?? {}) as IdentityEvidence
  }
}

export function getObservation(db: DatabaseSync, id: string): ObservationRow | null {
  const raw = db
    .prepare(
      `SELECT id, execution_id, dispatch_id, source, fact_type, observed_at, payload_json, identity_evidence_json
       FROM observations WHERE id = ?`
    )
    .get(id) as RawObservationRow | undefined
  return raw ? toObservationRow(raw) : null
}

/**
 * Facts for one execution in fold order (observed_at, insertion order).
 * `limit` keeps the projection bounded — the newest facts win the fold, so
 * the tail is fetched and re-ordered ascending.
 */
export function listObservationsForExecution(
  db: DatabaseSync,
  executionId: string,
  limit = 200
): ObservationRow[] {
  const raws = db
    .prepare(
      `SELECT id, execution_id, dispatch_id, source, fact_type, observed_at, payload_json, identity_evidence_json
       FROM observations WHERE execution_id = ?
       ORDER BY observed_at DESC, rowid DESC LIMIT ?`
    )
    .all(executionId, limit) as unknown as RawObservationRow[]
  return raws.map(toObservationRow).reverse()
}

/** newest-first facts across an execution set (snapshot entity listing). */
export function listObservationsForExecutions(
  db: DatabaseSync,
  executionIds: readonly string[],
  limit: number
): ObservationRow[] {
  if (executionIds.length === 0 || limit <= 0) return []
  const marks = executionIds.map(() => '?').join(',')
  const raws = db
    .prepare(
      `SELECT id, execution_id, dispatch_id, source, fact_type, observed_at, payload_json, identity_evidence_json
       FROM observations WHERE execution_id IN (${marks})
       ORDER BY observed_at DESC, rowid DESC LIMIT ?`
    )
    .all(...executionIds, limit) as unknown as RawObservationRow[]
  return raws.map(toObservationRow).reverse()
}

/** unbound/foreign facts — never attributed to a managed execution. */
export function listUnboundObservations(db: DatabaseSync, limit: number): ObservationRow[] {
  if (limit <= 0) return []
  const raws = db
    .prepare(
      `SELECT id, execution_id, dispatch_id, source, fact_type, observed_at, payload_json, identity_evidence_json
       FROM observations WHERE execution_id IS NULL
       ORDER BY observed_at DESC, rowid DESC LIMIT ?`
    )
    .all(limit) as unknown as RawObservationRow[]
  return raws.map(toObservationRow).reverse()
}

/** most recent bound-fact time — live-evidence input for liveness projection */
export function lastObservedAt(db: DatabaseSync, executionId: string): number | null {
  const row = db
    .prepare(`SELECT MAX(observed_at) AS last FROM observations WHERE execution_id = ?`)
    .get(executionId) as { last: number | null }
  return row.last
}

/** map a storage row to the canonical contract shape (IMP-02 name). */
export function toContractObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    executionId: row.executionId ?? undefined,
    dispatchId: row.dispatchId ?? undefined,
    source: row.source,
    factType: row.factType,
    payload: row.payload,
    observedAt: row.observedAt,
    identityEvidence: row.identityEvidence,
    confidenceClass: row.identityEvidence.confidenceClass
  } as Observation
}
