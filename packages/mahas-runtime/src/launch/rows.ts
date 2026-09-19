// mahas-runtime/launch — durable row codecs.
//
// The launch coordinator's stages read and write a handful of rows by hand
// (launch plan, execution, grant, member, dispatch). The SQL lives with the
// stage that needs it; what belongs here is the SHAPE of those rows and the
// JSON columns on them, because a mistyped column name or a JSON.parse on a
// null column is the kind of mistake that shows up as a mysterious undefined
// deep inside a stage rather than as an error at the boundary.
//
// Kept separate from deps.ts so other launch modules (reconcile, join) can
// share the row shapes without importing the coordinator's internals.

import type { DatabaseSync } from 'node:sqlite'
import type { ExecutionLiveness, ExecutionState } from '../../../mahas-contracts/src/identity.ts'

export interface LaunchPlanRow {
  id: string
  assignment_id: string
  assignment_revision: number
  digest: string
  bundle_digest: string
  envelope_digest: string
  surface_digest: string
  state: string
  process_spec_json: string
  pins_json: string
  reservations_json: string
}

export interface ExecutionRow {
  id: string
  member_id: string
  generation: number
  host_id: string
  launch_plan_id: string
  state: ExecutionState
  liveness: ExecutionLiveness
  terminal_id: string | null
  process_identity_json: string
  native_conversation_json: string
  revision: number
}

export interface GrantRow {
  id: string
  revoked_at: number | null
  expires_at: number | null
}

export interface MemberRow {
  id: string
  generation: number
  current_execution_id: string | null
  state: string
  revision: number
}

/** one row, or undefined — the shape every launch lookup wants */
export function getRow<T>(
  db: DatabaseSync,
  sql: string,
  ...args: (string | number | null)[]
): T | undefined {
  return db.prepare(sql).get(...args) as T | undefined
}

/** same lookup, normalized to null — for callers whose type is `T | null` */
export function findRow<T>(
  db: DatabaseSync,
  sql: string,
  ...args: (string | number | null)[]
): T | null {
  return getRow<T>(db, sql, ...args) ?? null
}

/**
 * Parse a JSON column that is allowed to be absent or malformed.
 *
 * Launch rows are written by earlier stages (and by older builds), so a
 * column can legitimately be '{}' or missing. `fallback` is returned rather
 * than throwing: the caller's contract is "the durable record did not carry
 * this", which is a state the stages already handle — an exception here would
 * be classified as an unknown effect outcome instead.
 */
export function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
