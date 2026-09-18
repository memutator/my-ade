// mahas-runtime — C-CLIENT refusal vocabulary.
//
// Every domain refusal maps to a canonical ErrorCode from mahas-contracts
// (spec/common.md). Malformed payloads throw plain TypeError instead: a
// contract violation by the caller, not a domain state the client can
// reconcile against.

import type { ErrorCode, ErrorRetry, MahasError } from '../../../mahas-contracts/src/index.ts'

/** MahasError-shaped throwable — the registry serializes code/retry/details */
export class ClientOpError extends Error implements MahasError {
  readonly code: ErrorCode
  readonly retry: ErrorRetry
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, retry: ErrorRetry = 'none', details?: unknown) {
    super(message)
    this.name = 'ClientOpError'
    this.code = code
    this.retry = retry
    this.details = details
  }
}

export function fail(
  code: ErrorCode,
  message: string,
  retry: ErrorRetry = 'none',
  details?: unknown
): never {
  throw new ClientOpError(code, message, retry, details)
}

/** view is stale — client must rebuild from runtime.snapshot before retrying */
export function snapshotRequired(message: string, details?: unknown): never {
  return fail('SNAPSHOT_REQUIRED', message, 'reconcile', details)
}

export function staleRevision(message: string, details?: unknown): never {
  return fail('STALE_REVISION', message, 'reconcile', details)
}

export function controlUnavailable(message: string, details?: unknown): never {
  return fail('CONTROL_UNAVAILABLE', message, 'same-operation', details)
}

export function conflict(message: string, details?: unknown): never {
  return fail('OPERATION_CONFLICT', message, 'none', details)
}

export function scopeDenied(message: string, details?: unknown): never {
  return fail('SCOPE_DENIED', message, 'none', details)
}

// ── payload guards ──────────────────────────────────────────────────────────

export function reqString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return v
}

export function optNumber(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`${field} must be a finite number`)
  }
  return v
}

export function reqNumber(v: unknown, field: string): number {
  const n = optNumber(v, field)
  if (n === undefined) throw new TypeError(`${field} is required`)
  return n
}

export function reqInt(v: unknown, field: string, min: number, max: number): number {
  const n = reqNumber(v, field)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new TypeError(`${field} must be an integer in [${min}, ${max}]`)
  }
  return n
}

export function asRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new TypeError('payload must be an object')
  }
  return payload as Record<string, unknown>
}

/** is this error one of ours (a MahasError-shaped refusal)? */
export function isClientOpError(e: unknown): e is ClientOpError {
  return e instanceof ClientOpError
}
