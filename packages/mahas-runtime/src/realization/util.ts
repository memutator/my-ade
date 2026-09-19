// realization/util.ts — small shared helpers for the realization boundary.
//
// Digest stability is the whole point of this package: RoleInterface and
// candidate digests are content-addressed, so the SAME semantic content must
// always serialize to the SAME bytes. canonicalJson() gives that byte order
// (sorted object keys, explicit array order); callers sort arrays whose order
// is not semantic BEFORE digesting.

import { randomUUID } from 'node:crypto'
import { sha256Hex } from '../storage/db.ts'
import type { ErrorCode, ErrorRetry, MahasError } from '../../../mahas-contracts/src/common.ts'

/** throw a spec/common.md §4 error — handlers signal verdicts, not bugs */
export function fail(
  code: ErrorCode,
  message: string,
  opts?: { retry?: ErrorRetry; details?: unknown }
): never {
  const err: MahasError = { code, message, retry: opts?.retry ?? 'none' }
  if (opts?.details !== undefined) err.details = opts.details
  throw err
}

/** structural guard — payloads arrive as `unknown` through the registry */
export function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    fail('MODEL_INVALID', `${what} must be an object`)
  }
  return v as Record<string, unknown>
}

export function reqString(v: Record<string, unknown>, field: string): string {
  const s = v[field]
  if (typeof s !== 'string' || s.length === 0) {
    fail('MODEL_INVALID', `${field} must be a non-empty string`)
  }
  return s
}

export function optString(v: Record<string, unknown>, field: string): string | undefined {
  const s = v[field]
  if (s === undefined || s === null) return undefined
  if (typeof s !== 'string' || s.length === 0) {
    fail('MODEL_INVALID', `${field} must be a non-empty string when present`)
  }
  return s
}

export function reqInteger(v: Record<string, unknown>, field: string): number {
  const n = v[field]
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    fail('MODEL_INVALID', `${field} must be an integer >= 1`)
  }
  return n
}

export function reqArray(v: Record<string, unknown>, field: string): unknown[] {
  const a = v[field]
  if (!Array.isArray(a)) fail('MODEL_INVALID', `${field} must be an array`)
  return a
}

export function optArray(v: Record<string, unknown>, field: string): unknown[] {
  const a = v[field]
  if (a === undefined || a === null) return []
  if (!Array.isArray(a)) fail('MODEL_INVALID', `${field} must be an array when present`)
  return a
}

/**
 * Deterministic serialization for content addressing: object keys sorted at
 * every depth, arrays kept in caller order. undefined fields are dropped
 * (JSON.stringify semantics) so "absent" and "present-but-undefined" hash
 * identically.
 */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortForCanonical(v))
}

function sortForCanonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortForCanonical)
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = sortForCanonical((v as Record<string, unknown>)[k])
      if (val !== undefined) out[k] = val
    }
    return out
  }
  return v
}

/** content-addressed digest of a JSON-shaped value */
export function digestOf(v: unknown): string {
  return sha256Hex(canonicalJson(v))
}

/** new opaque entity id — never a label, path or provider-native id */
export function mintId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

export function nowMs(): number {
  return Date.now()
}
