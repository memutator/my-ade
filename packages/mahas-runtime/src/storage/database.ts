// storage/database.ts — opening the control DB (mahas.sqlite).
//
// openControlDb performs, in order:
//   1. connection pragmas — journal_mode=WAL, synchronous=FULL,
//      foreign_keys=ON, busy_timeout=5000 (spec/storage.md §3 header + §7;
//      WAL+FULL is the chosen durability point, applied per connection)
//   2. the schema-version/write-compatibility gate + pending migrations
//      (migrations.ts) — an unmanaged, foreign-owned or NEWER file is
//      refused, never written "to see what happens"
//   3. content-store association — the external blob store defaults to a
//      '<db>.blobs/' sibling directory so the DB file and its external
//      content always travel together (backup, spec §7)
//
// Single-writer enforcement (spec/storage.md §5: mahasd is the single
// writer): the schema_owner marker refuses any second owner kind on the same
// file, and BEGIN IMMEDIATE (withTx) takes the DB write lock at transaction
// START — a concurrent writer hits SQLITE_BUSY after busy_timeout instead of
// queueing writes mid-transaction. Background indexer/CLI/renderer never
// open this DB for write.

import { DatabaseSync } from 'node:sqlite'
import { setContentStoreRoot } from './blob-store.ts'
import { applyMigrations, CONTROL_DB_OWNER, CONTROL_MIGRATIONS } from './migrations.ts'

export interface OpenControlDbOptions {
  /**
   * External content store root for external_ref blobs.
   * Default: '<path>.blobs' — pass explicitly when opening a DB whose store
   * lives elsewhere (e.g. a restored backup set).
   */
  contentStoreDir?: string
}

/**
 * Open (and migrate to schema v1) the mahas control DB. Returns a ready
 * DatabaseSync; throws StorageError on any incompatibility — the open must
 * fail, never degrade to unverified writes.
 */
export function openControlDb(path: string, options?: OpenControlDbOptions): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA synchronous=FULL')
    db.exec('PRAGMA foreign_keys=ON')
    db.exec('PRAGMA busy_timeout=5000')
    applyMigrations(db, CONTROL_MIGRATIONS, CONTROL_DB_OWNER)
  } catch (err) {
    db.close()
    throw err
  }
  setContentStoreRoot(db, options?.contentStoreDir ?? `${path}.blobs`)
  return db
}
