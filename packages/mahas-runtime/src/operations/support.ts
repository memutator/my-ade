// operations/support.ts — internal helpers shared by the IMP-29 operations
// modules (migration/backup/restore/gc). Not a public entrypoint; the public
// surface is registerBackupOps + the explicit migration/GC functions.
//
// spec/storage.md §7: durability is WAL+FULL; a live WAL database is never
// captured by copying its main file alone. Snapshots in this package go
// through SQLite's own consistent-image APIs (sqlite3_serialize via
// DatabaseSync.serialize(), or the online backup API), and every persisted
// artifact carries a SHA-256 digest so partial copies surface as
// failed/unknown rather than silent success.

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ErrorCode, ErrorRetry, MahasError } from '../../../mahas-contracts/src/common.ts'

/**
 * Storage helpers this boundary consumes. IMP-30's composition root injects
 * the canonical IMP-03 implementations from `../storage/db.ts`
 * (openControlDb/withTx/sha256Hex/appendDomainEvent/putContentBlob) — the
 * field names here mirror those signatures exactly so the wiring is
 * pass-through, never a local re-implementation.
 */
export interface StorageOpsDeps {
  /** IMP-03 openControlDb — pragma WAL/FK/synchronous=FULL + schema v1 migrate */
  openDb(path: string): DatabaseSync
  /** IMP-03 withTx — BEGIN IMMEDIATE … COMMIT/ROLLBACK */
  withTx<T>(db: DatabaseSync, fn: (db: DatabaseSync) => T): T
  /** IMP-03 sha256Hex — lowercase hex, no prefix */
  sha256Hex(data: string | Uint8Array): string
  /** IMP-03 appendDomainEvent — projection outbox row inside the caller's tx */
  appendDomainEvent(
    db: DatabaseSync,
    aggregateId: string,
    aggregateRevision: number,
    eventType: string,
    scope: unknown,
    payload: unknown
  ): void
  /** IMP-03 putContentBlob — digest-dedup store; needed by legacy import */
  putContentBlob?(db: DatabaseSync, bytes: Uint8Array, mediaType: string): { digest: string }
  now?(): number
  /** id generator — defaults to crypto.randomUUID with a kind prefix */
  newId?(kind: string): string
}

export function requireStorageDeps(deps: StorageOpsDeps): void {
  for (const k of ['openDb', 'withTx', 'sha256Hex', 'appendDomainEvent'] as const) {
    if (typeof deps[k] !== 'function') {
      throw opsError(
        'CONTROL_UNAVAILABLE',
        `operations deps missing '${k}' — inject the IMP-03 canonical helper`,
        'none'
      )
    }
  }
}

/**
 * Open a database purely to read a consistent image — used for host DB
 * snapshots so the control plane never acts as a second writer on the
 * execution-host's own store (spec/storage.md §5). Read-only open is tried
 * first; a WAL db whose -shm is absent may reject it, in which case a normal
 * open is used (an open+serialize never issues a logical write).
 */
export function openForSnapshot(path: string): DatabaseSync {
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return new DatabaseSync(path)
  }
}

export function nowMs(deps: Pick<StorageOpsDeps, 'now'>): number {
  return deps.now ? deps.now() : Date.now()
}

export function genId(deps: Pick<StorageOpsDeps, 'newId'>, kind: string): string {
  return deps.newId ? deps.newId(kind) : `${kind}-${randomUUID()}`
}

/** throw a MahasError-shaped Error (code + retry travel with it) */
export function opsError(
  code: ErrorCode,
  message: string,
  retry: ErrorRetry = 'none',
  details?: unknown
): MahasError & Error {
  return Object.assign(new Error(message), { code, retry, details })
}

export function isMahasError(e: unknown): e is MahasError & Error {
  return e instanceof Error && typeof (e as { code?: unknown }).code === 'string'
}

/**
 * `DatabaseSync.serialize()` / `.deserialize()` exist in the Node runtime
 * (verified on Node 24) but are not yet present in @types/node 22. Access
 * goes through this narrow structural interface so the cast is documented in
 * exactly one place. sqlite3_serialize produces a consistent database image
 * — the sanctioned alternative to copying a live WAL file (spec/storage.md §7).
 */
interface SerializableDatabase {
  serialize(): Uint8Array
}

/** consistent full-db image of an open database (never raw file bytes) */
export function snapshotImage(db: DatabaseSync): Uint8Array {
  const s = (db as unknown as SerializableDatabase).serialize
  if (typeof s !== 'function') {
    throw opsError(
      'CONTROL_UNAVAILABLE',
      'DatabaseSync.serialize() unavailable — cannot take a consistent snapshot on this runtime',
      'same-operation'
    )
  }
  return s.call(db)
}

/** sha256 of a byte string, lowercase hex — local copy for file digests;
 * row-level digests go through deps.sha256Hex (the IMP-03 canonical helper). */
export function sha256File(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function readFileBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path))
}

/** write bytes via tmp+rename in the same directory (crash-safe publish) */
export function atomicWriteBytes(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(tmp, bytes)
  renameSync(tmp, path)
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

export function existsOrThrow(path: string, label: string): void {
  if (!existsSync(path)) {
    throw opsError('ARTIFACT_MISMATCH', `${label} not found: ${path}`, 'none')
  }
}

/**
 * Deterministic JSON (recursively sorted keys) — the byte string that
 * manifest_digest/fingerprints are computed over, so verification does not
 * depend on object key order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

export function removeIfExists(path: string): boolean {
  if (!existsSync(path)) return false
  rmSync(path, { recursive: true, force: true })
  return true
}

/**
 * Remove a SQLite database's leftover journal siblings (-wal/-shm/-journal).
 * Mandatory before placing a snapshot image at a path a previous WAL database
 * occupied: a stale -wal would be replayed into the restored image on open.
 */
export function removeStaleJournalSiblings(dbPath: string): string[] {
  const removed: string[] = []
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (existsSync(dbPath + suffix)) {
      rmSync(dbPath + suffix, { force: true })
      removed.push(dbPath + suffix)
    }
  }
  return removed
}

/**
 * Live-writer probe: if another connection holds the write lock on `dbPath`,
 * an immediate transaction cannot begin. A busy result means a live (or
 * unverifiable) writer exists and the caller must refuse — it is NOT proof
 * that the file is unused, only that it must not be overwritten.
 */
export function probeNoLiveWriter(dbPath: string): { stopped: boolean; detail: string } {
  if (!existsSync(dbPath)) return { stopped: true, detail: 'target does not exist yet' }
  let probe: DatabaseSync | null = null
  try {
    probe = new DatabaseSync(dbPath)
    probe.exec('PRAGMA busy_timeout=0')
    probe.exec('BEGIN IMMEDIATE')
    probe.exec('ROLLBACK')
    return { stopped: true, detail: 'acquired write lock — no live writer' }
  } catch (e) {
    return {
      stopped: false,
      detail: `write lock unavailable: ${e instanceof Error ? e.message : String(e)}`
    }
  } finally {
    try {
      probe?.close()
    } catch {
      /* probe close failure is not evidence either way */
    }
  }
}

/** best-effort row count; -1 when the table is absent (partial schemas) */
export function tryCount(db: DatabaseSync, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { n?: number } | undefined
    return typeof row?.n === 'number' ? row.n : -1
  } catch {
    return -1
  }
}

export function joinPath(...parts: string[]): string {
  return join(...parts)
}
