// storage.ts — the execution-host's own DB boundary (execution-host.sqlite,
// spec/storage.md §4). The host is a separate daemon and the single writer of
// THIS file; it never opens mahas.sqlite.
//
// Boundary note (SHARED-APIS.md IMP-03): withTx/sha256Hex are re-exported
// from this module so host code never imports mahas-runtime — the enforced
// package direction (eslint.config.mjs) allows execution-host to depend on
// contracts only, so the two tiny helpers are deliberate mirrors of
// packages/mahas-runtime/src/storage/{transaction,blob-store}.ts. Keep them
// signature-identical; if a shared no-deps sqlite port ever lands, both
// copies converge onto it.
//
// Schema versioning: spec §4 defines NO schema_meta/migration_receipts table
// for the host DB, so the version lives in PRAGMA user_version (a built-in,
// not a table — the DDL below stays verbatim). An unmanaged or NEWER file is
// refused, same gate as the control DB.

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export const HOST_SCHEMA_VERSION = 1

/**
 * Open (and initialize to schema v1) the execution-host DB. Applies
 * spec/storage.md §4 DDL verbatim plus the spec pragmas (foreign_keys, WAL,
 * synchronous=FULL); busy_timeout is applied per IMP-03 instruction §4.2
 * (connection-level hardening, not schema).
 *
 * Refuses: files with foreign user tables, and schema versions newer than
 * this binary — the host must fail the open, never write an unverified file.
 */
export function openHostDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA synchronous=FULL')
    db.exec('PRAGMA foreign_keys=ON')
    db.exec('PRAGMA busy_timeout=5000')

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'"
      )
      .all()
      .map((r) => String(r['name']))
    const version = Number(db.prepare('PRAGMA user_version').get()?.['user_version'] ?? 0)
    if (version > HOST_SCHEMA_VERSION) {
      throw new Error(
        `execution-host DB schema v${version} is newer than this binary supports ` +
          `(v${HOST_SCHEMA_VERSION}) — an older binary must not write a newer DB`
      )
    }
    if (version === 0) {
      if (tables.length > 0) {
        throw new Error(
          'execution-host DB has user tables but user_version=0 — refusing to ' +
            'treat an unmanaged/foreign SQLite file as the host DB'
        )
      }
      withTx(db, (tx) => tx.exec(HOST_SCHEMA_DDL_V1))
      db.exec(`PRAGMA user_version=${HOST_SCHEMA_VERSION}`)
    } else if (!tables.includes('host_identity')) {
      throw new Error(
        'execution-host DB is stamped user_version=1 but lacks host_identity — ' +
          'file is not a v1 host DB'
      )
    }
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

// ── shared-helper mirrors (see header note — identical signatures) ──────────

/** per-connection transaction depth so nested withTx() uses SAVEPOINT */
const txDepth = new WeakMap<DatabaseSync, number>()

/**
 * Run `fn` inside a write transaction: BEGIN IMMEDIATE … COMMIT / ROLLBACK;
 * nested calls degrade to SAVEPOINT. Mirror of mahas-runtime's withTx.
 * DB work only inside the callback — fs/process effects stay outside.
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
        /* preserve the original error */
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
      /* preserve the original error */
    }
    throw err
  } finally {
    txDepth.set(db, depth)
  }
}

/** lowercase hex SHA-256, no prefix — mirror of mahas-runtime's sha256Hex */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

// ── spec/storage.md §4 — execution-host DB DDL, verbatim (PRAGMAs excluded) ─

const HOST_SCHEMA_DDL_V1 = `
CREATE TABLE host_identity(id TEXT PRIMARY KEY, incarnation TEXT NOT NULL, protocol_version TEXT NOT NULL, process_identity_json TEXT NOT NULL CHECK(json_valid(process_identity_json)));
CREATE TABLE host_controller_lease(id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL, revision INTEGER NOT NULL, expires_at INTEGER NOT NULL, proof_json TEXT NOT NULL CHECK(json_valid(proof_json)));
CREATE TABLE host_effects(effect_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, intent_json TEXT NOT NULL CHECK(json_valid(intent_json)), receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)));
CREATE TABLE host_processes(spawn_nonce TEXT PRIMARY KEY, execution_id TEXT NOT NULL, generation INTEGER NOT NULL, pid INTEGER, state TEXT NOT NULL, identity_json TEXT NOT NULL CHECK(json_valid(identity_json)), process_spec_json TEXT NOT NULL CHECK(json_valid(process_spec_json)));
CREATE TABLE host_terminals(id TEXT PRIMARY KEY, spawn_nonce TEXT NOT NULL REFERENCES host_processes(spawn_nonce), pty_id TEXT NOT NULL, output_epoch TEXT NOT NULL, last_sequence INTEGER NOT NULL, state TEXT NOT NULL, buffer_ref TEXT);
CREATE TABLE host_workspaces(id TEXT PRIMARY KEY, effect_key TEXT NOT NULL REFERENCES host_effects(effect_key), canonical_path TEXT NOT NULL, identity_json TEXT NOT NULL CHECK(json_valid(identity_json)), state TEXT NOT NULL);
`
