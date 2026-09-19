// storage/transaction.ts — the write-transaction boundary (spec/storage.md §5,
// spec/common.md §3).
//
// One atomic unit = domain mutations + operation receipt + domain events +
// effect intent/outbox rows. withTx() takes the SQLite write lock up front
// (BEGIN IMMEDIATE) so a second writer fails after busy_timeout instead of
// discovering contention at COMMIT; nested calls degrade to SAVEPOINTs so
// services may compose inside a caller's transaction.
//
// HARD RULE (instruction §4.3, spec/storage.md §5): the callback must only do
// DB work. Filesystem/process/network effects belong OUTSIDE the transaction
// (publish the file with putExternalContentBlob first, or perform the OS
// effect under its effect key afterwards) — never hidden inside withTx.

import type { DatabaseSync } from 'node:sqlite'
import type { CommandReceipt } from '../../../mahas-contracts/src/index.ts'
import { insertReceipt } from './receipt-store.ts'
import {
  appendDomainEvent,
  stageEffectIntent,
  updateEffectState,
  type EffectIntentInput,
  type EffectStateUpdate
} from './event-outbox.ts'

/** per-connection transaction depth so nested withTx() uses SAVEPOINT */
const txDepth = new WeakMap<DatabaseSync, number>()

/** is this connection currently inside a withTx() transaction? */
export function inTransaction(db: DatabaseSync): boolean {
  return (txDepth.get(db) ?? 0) > 0
}

/**
 * Register a transaction opened OUTSIDE withTx() (the admission pipeline's
 * async-capable runner issues a raw BEGIN so it can hold the tx across an
 * awaited handler). Without this, `inTransaction()` is false inside handlers
 * and a nested withTx() issues a second BEGIN on the same connection —
 * `ERR_SQLITE_ERROR: cannot start a transaction within a transaction` (F-005).
 * Paired with markTransactionClosed() after COMMIT/ROLLBACK.
 */
export function markTransactionOpen(db: DatabaseSync): void {
  txDepth.set(db, (txDepth.get(db) ?? 0) + 1)
}

/** clear one depth level registered by markTransactionOpen() */
export function markTransactionClosed(db: DatabaseSync): void {
  const depth = txDepth.get(db) ?? 0
  if (depth <= 1) txDepth.delete(db)
  else txDepth.set(db, depth - 1)
}

/**
 * Run `fn` inside a write transaction.
 *
 * Outermost call: BEGIN IMMEDIATE … COMMIT, ROLLBACK on throw.
 * Nested call: SAVEPOINT … RELEASE, ROLLBACK TO SAVEPOINT on throw — the
 * outer transaction still decides the final outcome.
 */
export function withTx<T>(db: DatabaseSync, fn: (db: DatabaseSync) => T): T {
  const depth = txDepth.get(db) ?? 0
  if (depth === 0) {
    db.exec('BEGIN IMMEDIATE')
    txDepth.set(db, 1)
    try {
      const result = fn(db)
      db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* connection-level failure — the original error is the truth */
      }
      throw err
    } finally {
      txDepth.delete(db)
    }
  }

  const savepoint = `mahas_tx_${depth}`
  db.exec(`SAVEPOINT ${savepoint}`)
  txDepth.set(db, depth + 1)
  try {
    const result = fn(db)
    db.exec(`RELEASE ${savepoint}`)
    return result
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO ${savepoint}`)
      db.exec(`RELEASE ${savepoint}`)
    } catch {
      /* outer transaction will roll back — preserve the original error */
    }
    throw err
  } finally {
    txDepth.set(db, depth)
  }
}

/** a CommandReceipt to persist under (principalScope, operation, operationId) */
export interface ReceiptWrite {
  receipt: CommandReceipt
  principalScope: string
}

/** a DomainEvent row to append to the projection outbox */
export interface DomainEventWrite {
  aggregateId: string
  aggregateRevision: number
  eventType: string
  scope: unknown
  payload: unknown
}

/**
 * The non-mutation writes of one atomic unit, produced AFTER the domain
 * mutation so they can pin its result (receipt digest, revision numbers).
 */
export interface UnitWrites {
  receipts?: ReceiptWrite[]
  events?: DomainEventWrite[]
  /** new effect intents to stage (effect_intents row + effect_outbox row) */
  effectIntents?: EffectIntentInput[]
  /** state transitions of already-staged effects */
  effectUpdates?: Array<{ id: string } & EffectStateUpdate>
}

/**
 * One atomic unit of work (spec/common.md §3):
 *   mutate()      — domain mutations ONLY, no fs/process/network I/O
 *   writes(result)— receipt + domain events + effect intents derived from
 *                   the mutation, applied in the SAME transaction
 */
export interface UnitOfWork<T> {
  mutate(db: DatabaseSync): T
  writes?(result: T, db: DatabaseSync): UnitWrites
}

/**
 * Run a full atomic unit in a single write transaction: domain mutation +
 * receipt + domain event + effect intent/outbox, committed or rolled back
 * together. External effects are NOT executed here — the caller performs
 * them afterwards under the staged effect's stable key.
 */
export function commitUnitOfWork<T>(db: DatabaseSync, work: UnitOfWork<T>): T {
  return withTx(db, (tx) => {
    const result = work.mutate(tx)
    const writes = work.writes?.(result, tx) ?? {}
    for (const intent of writes.effectIntents ?? []) stageEffectIntent(tx, intent)
    for (const update of writes.effectUpdates ?? []) {
      const { id, ...state } = update
      updateEffectState(tx, id, state)
    }
    for (const r of writes.receipts ?? []) insertReceipt(tx, r.receipt, r.principalScope)
    for (const e of writes.events ?? []) {
      appendDomainEvent(tx, e.aggregateId, e.aggregateRevision, e.eventType, e.scope, e.payload)
    }
    return result
  })
}
