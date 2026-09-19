// mahas-runtime/maintenance — shared error and row codecs.
//
// These three things were defined inside basis-observer.ts and imported from
// there by classification.ts, impact-service.ts, task-link.ts and the smoke
// tests. That made the observer module a de-facto shared library: importing a
// row shape dragged in the whole basis diff. They live here instead, because
// they are about how maintenance talks to storage, not about what a basis
// change means.
//
// Nothing here is new behavior — the error class, the `fail` helper and the
// candidate row projection are moved verbatim so the wire shape
// (spec/storage.md §3 DDL → camelCase, SHARED-APIS convention) has exactly one
// definition.

import type { DatabaseSync } from 'node:sqlite'
import type { ErrorCode, ErrorRetry, MahasError } from '../../../mahas-contracts/src/common.ts'

/* ------------------------------------------------------------------ *
 * errors
 * ------------------------------------------------------------------ */

/** domain verdict thrown by maintenance code — MahasError-shaped on the wire */
export class MaintenanceError extends Error {
  readonly code: ErrorCode
  readonly retry: ErrorRetry
  readonly details?: unknown

  constructor(
    code: ErrorCode,
    message: string,
    options?: { retry?: ErrorRetry; details?: unknown }
  ) {
    super(message)
    this.name = 'MaintenanceError'
    this.code = code
    this.retry = options?.retry ?? 'none'
    this.details = options?.details
  }

  toMahasError(): MahasError {
    return { code: this.code, message: this.message, retry: this.retry, details: this.details }
  }
}

export function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new MaintenanceError(code, message, { details })
}

/* ------------------------------------------------------------------ *
 * row codecs
 * ------------------------------------------------------------------ */

/**
 * Parse a JSON column that may be absent or malformed, returning `fallback`.
 * Maintenance rows are written by earlier revisions of this code, so a column
 * can legitimately be '{}' — an exception here would surface as a storage
 * failure instead of the "no recorded reason" state the caller already
 * handles.
 */
export function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** every row a query returns, typed by the caller's projection */
export function rows<T>(db: DatabaseSync, sql: string, ...args: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...args) as T[]
}
