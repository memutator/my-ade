// storage/db.ts — the storage boundary's public entrypoint.
//
// This module fixes the SHARED-APIS.md IMP-03 surface exactly:
//   openControlDb, withTx, sha256Hex, putContentBlob, getContentBlob,
//   appendDomainEvent, insertReceipt, findReceipt
// and re-exports the boundary's supporting API (transaction unit-of-work,
// external blob store, receipt conflict probe, effect intent/outbox
// repository, migration/version introspection). Consumers import from THIS
// file — never from the sibling implementation modules — so internals can
// move without breaking call sites.
//
// Contracts come from mahas-contracts; this file adds none of its own.

export { StorageError } from './errors.ts'

export { openControlDb } from './database.ts'
export type { OpenControlDbOptions } from './database.ts'

export { withTx, inTransaction, commitUnitOfWork } from './transaction.ts'
export type { DomainEventWrite, ReceiptWrite, UnitOfWork, UnitWrites } from './transaction.ts'

export {
  sha256Hex,
  putContentBlob,
  getContentBlob,
  putExternalContentBlob,
  setContentStoreRoot,
  contentStoreRoot,
  MAX_INLINE_BLOB_BYTES
} from './blob-store.ts'

export { insertReceipt, findReceipt, findConflictingReceipt } from './receipt-store.ts'

export {
  appendDomainEvent,
  lastEventSequence,
  stageEffectIntent,
  getEffectIntent,
  findEffectsByOperationKey,
  updateEffectState,
  listPendingEffects
} from './event-outbox.ts'
export type {
  EffectIntentInput,
  EffectStateUpdate,
  PendingEffect,
  StoredEffectIntent
} from './event-outbox.ts'

export {
  applyMigrations,
  schemaVersion,
  CONTROL_DB_OWNER,
  CONTROL_MIGRATIONS,
  CONTROL_SCHEMA_VERSION
} from './migrations.ts'
export type { Migration } from './migrations.ts'
