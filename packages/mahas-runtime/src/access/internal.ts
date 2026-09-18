// internal.ts — shared helpers for the access boundary (IMP-10).
//
// Not a public entrypoint: authorize.ts re-exports the fixed SHARED-APIS
// kernel surface; sibling modules import these utilities directly.

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { withTx } from '../storage/db.ts'
import type { ErrorCode, ErrorRetry, MahasError } from '../../../mahas-contracts/src/index.ts'

/**
 * Error thrown across the access boundary. Carries the wire MahasError
 * shape ({code, message, retry, details?}) while staying a real Error so
 * callers keep a stack. Registry/transport code should read `.code`.
 */
export class AccessError extends Error implements MahasError {
  readonly code: ErrorCode
  readonly retry: ErrorRetry
  readonly details?: unknown

  constructor(
    code: ErrorCode,
    message: string,
    options?: { retry?: ErrorRetry; details?: unknown }
  ) {
    super(message)
    this.name = 'AccessError'
    this.code = code
    this.retry = options?.retry ?? 'none'
    if (options?.details !== undefined) this.details = options.details
  }
}

/** Throw an AccessError. `never` return keeps callers' narrowing honest. */
export function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new AccessError(code, message, { details })
}

/**
 * Run `fn` inside a write transaction unless the caller already opened one
 * (the OperationRegistry wraps handlers in withTx — nested BEGIN would fail,
 * so we join the outer transaction instead of duplicating withTx).
 */
export function ensureTx<T>(db: DatabaseSync, fn: (db: DatabaseSync) => T): T {
  return db.isTransaction ? fn(db) : withTx(db, fn)
}

/** Opaque id minting — `prefix_<uuid>`. Ids are never labels or paths. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

export function nowMs(): number {
  return Date.now()
}

/** Deterministic JSON (recursively sorted object keys) for digests/pins. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}
