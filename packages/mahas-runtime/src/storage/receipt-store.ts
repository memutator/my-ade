// storage/receipt-store.ts — operation idempotency receipts
// (operation_receipts, spec/storage.md §3; admission rule spec/common.md §3).
//
// Idempotency key = (principal_scope, operation, operation_id). Same key +
// same canonical-payload fingerprint ⇒ the stored receipt is the answer.
// Same key + different fingerprint ⇒ OPERATION_CONFLICT — never overwritten,
// never silently accepted.
//
// operation source: the seeded CommandReceipt (spec/common.md §2 shape) has
// no `operation` field, yet the table's key requires it. Callers therefore
// attach `operation` to the receipt object they pass in — the dispatch layer
// (IMP-11) knows the operation name at admission time. insertReceipt refuses
// a receipt without it rather than corrupting the keyspace with ''.
// (Flagged to IMP-02 owner: if CommandReceipt gains `operation`, this code
// keeps working unchanged.)

import type { DatabaseSync } from 'node:sqlite'
import type { CommandReceipt } from '../../../mahas-contracts/src/index.ts'
import { StorageError } from './errors.ts'

interface ReceiptRow {
  fingerprint: unknown
  status: unknown
  result_json: unknown
  created_at: unknown
}

function selectReceipt(
  db: DatabaseSync,
  principalScope: string,
  operation: string,
  operationId: string
): ReceiptRow | undefined {
  return db
    .prepare(
      'SELECT fingerprint, status, result_json, created_at FROM operation_receipts ' +
        'WHERE principal_scope=? AND operation=? AND operation_id=?'
    )
    .get(principalScope, operation, operationId) as ReceiptRow | undefined
}

function operationOf(receipt: CommandReceipt): string {
  const operation = (receipt as { operation?: unknown }).operation
  if (typeof operation !== 'string' || operation === '') {
    throw new Error(
      'insertReceipt: receipt must carry `operation` (non-empty string) — the ' +
        'idempotency key is (principalScope, operation, operationId) and the ' +
        'seeded CommandReceipt type does not declare the field yet'
    )
  }
  return operation
}

/**
 * Upsert a CommandReceipt under its idempotency key.
 *
 * Re-inserting the same key requires the SAME fingerprint — a differing
 * fingerprint is OPERATION_CONFLICT (the conflicting stored receipt stays as
 * evidence; nothing is overwritten). Same fingerprint ⇒ row updated, which
 * makes retried writes safe.
 */
export function insertReceipt(
  db: DatabaseSync,
  receipt: CommandReceipt,
  principalScope: string
): void {
  const operation = operationOf(receipt)
  const existing = selectReceipt(db, principalScope, operation, receipt.operationId)
  if (existing !== undefined && String(existing.fingerprint) !== receipt.fingerprint) {
    throw new StorageError(
      'OPERATION_CONFLICT',
      `operation receipt (${principalScope}, ${operation}, ${receipt.operationId}) ` +
        'already exists with a different fingerprint',
      {
        retry: 'none',
        details: {
          storedFingerprint: String(existing.fingerprint),
          fingerprint: receipt.fingerprint
        }
      }
    )
  }
  db.prepare(
    'INSERT INTO operation_receipts(principal_scope, operation, operation_id, fingerprint, status, result_json, created_at) ' +
      'VALUES (?,?,?,?,?,?,?) ' +
      'ON CONFLICT(principal_scope, operation, operation_id) DO UPDATE SET ' +
      'fingerprint=excluded.fingerprint, status=excluded.status, ' +
      'result_json=excluded.result_json, created_at=excluded.created_at'
  ).run(
    principalScope,
    operation,
    receipt.operationId,
    receipt.fingerprint,
    receipt.status,
    JSON.stringify(receipt),
    Date.now()
  )
}

/**
 * Fetch the stored CommandReceipt for an idempotency key, or null.
 * The stored result_json IS the full receipt; columns are trusted indexed
 * copies and a disagreement is treated as corruption, not a variant.
 */
export function findReceipt(
  db: DatabaseSync,
  principalScope: string,
  operation: string,
  operationId: string
): CommandReceipt | null {
  const row = selectReceipt(db, principalScope, operation, operationId)
  if (row === undefined) return null
  const receipt = JSON.parse(String(row.result_json)) as CommandReceipt
  if (receipt.operationId !== operationId || receipt.fingerprint !== String(row.fingerprint)) {
    throw new StorageError(
      'ARTIFACT_MISMATCH',
      `operation receipt (${principalScope}, ${operation}, ${operationId}) payload ` +
        'disagrees with its indexed columns',
      { retry: 'reconcile' }
    )
  }
  return receipt
}

/**
 * Conflict probe for admission (spec/common.md §3): returns the stored
 * receipt ONLY when the key exists AND its fingerprint differs — i.e. the
 * OPERATION_CONFLICT case. Same-fingerprint or absent ⇒ null, admission may
 * proceed (and use findReceipt to serve the stored receipt for a replay).
 */
export function findConflictingReceipt(
  db: DatabaseSync,
  principalScope: string,
  operation: string,
  operationId: string,
  fingerprint: string
): CommandReceipt | null {
  const stored = findReceipt(db, principalScope, operation, operationId)
  if (stored === null || stored.fingerprint === fingerprint) return null
  return stored
}
