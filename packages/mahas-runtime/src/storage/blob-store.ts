// storage/blob-store.ts — content-addressed blob storage (content_blobs,
// spec/storage.md §2; ContentBlob in domains/resources-observation.md §1).
//
// Two storage shapes per instruction §4.4:
//   * small instruction/config snapshots → inline `body` (putContentBlob)
//   * large artifacts → content-addressed external store + manifest row
//     (putExternalContentBlob): bytes live at <storeRoot>/<digest[0:2]>/<digest>,
//     published by tmp-write + fsync + atomic rename, and the row records
//     external_ref + verified=1 only after a read-back digest 확인.
//
// getContentBlob re-verifies SHA-256 on every read — a row whose bytes no
// longer match its digest key is ARTIFACT_MISMATCH, never silently returned.
//
// Dedup: digest is the primary key. Storing the same bytes twice returns the
// existing row's authoritative media_type/byte_length without rewriting.
//
// Ordering (spec/storage.md §5): putExternalContentBlob performs FILE I/O —
// call it OUTSIDE withTx. The row insert is then the transaction-visible
// publish marker; an abandoned file after rollback is GC work (retention
// pins), not corruption.

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ContentRef } from '../../../mahas-contracts/src/index.ts'
import { StorageError } from './errors.ts'

/**
 * Guidance threshold for the inline-vs-external decision (spec/storage.md §2:
 * "작은 context/config는 body, 대형 artifact만 external_ref 허용"). Callers
 * choose which function to call — this constant is the shared policy, not an
 * enforced limit inside putContentBlob.
 */
export const MAX_INLINE_BLOB_BYTES = 256 * 1024

/** lowercase hex SHA-256, no prefix — the canonical digest encoding */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** per-connection external store root, wired by openControlDb / setContentStoreRoot */
const storeRoots = new WeakMap<DatabaseSync, string>()

/** associate an external content store directory with this connection */
export function setContentStoreRoot(db: DatabaseSync, root: string): void {
  storeRoots.set(db, root)
}

/** the store root associated with this connection, if any */
export function contentStoreRoot(db: DatabaseSync): string | undefined {
  return storeRoots.get(db)
}

interface BlobRow {
  media_type: unknown
  byte_length: unknown
  body: unknown
  external_ref: unknown
  verified: unknown
}

function selectBlob(db: DatabaseSync, digest: string): BlobRow | undefined {
  return db
    .prepare(
      'SELECT media_type, byte_length, body, external_ref, verified FROM content_blobs WHERE digest=?'
    )
    .get(digest) as BlobRow | undefined
}

/**
 * Store `bytes` inline in content_blobs, deduplicated by digest.
 * Returns the ContentRef — on a dedup hit the STORED row's media type and
 * length win (they are the authoritative record for that digest).
 */
export function putContentBlob(db: DatabaseSync, bytes: Uint8Array, mediaType: string): ContentRef {
  const digest = sha256Hex(bytes)
  const existing = selectBlob(db, digest)
  if (existing !== undefined) {
    return {
      digest,
      mediaType: String(existing.media_type),
      sizeBytes: Number(existing.byte_length)
    }
  }
  db.prepare(
    'INSERT INTO content_blobs(digest, media_type, byte_length, body, external_ref, verified) ' +
      'VALUES (?,?,?,?,NULL,1)'
  ).run(digest, mediaType, bytes.byteLength, bytes)
  return { digest, mediaType, sizeBytes: bytes.byteLength }
}

/**
 * Publish `bytes` to the content-addressed external store and record the
 * manifest row (body=NULL, external_ref=<store-relative path>, verified=1).
 *
 * FILE I/O — call outside withTx (spec/storage.md §5). The visible publish
 * marker is the file appearing at its content-addressed name via atomic
 * rename; the DB row is inserted afterwards and verified=1 means "bytes at
 * external_ref re-hashed to digest at publish/read time".
 */
export function putExternalContentBlob(
  db: DatabaseSync,
  bytes: Uint8Array,
  mediaType: string,
  options?: { storeDir?: string }
): ContentRef {
  const digest = sha256Hex(bytes)
  const existing = selectBlob(db, digest)
  if (existing !== undefined) {
    return {
      digest,
      mediaType: String(existing.media_type),
      sizeBytes: Number(existing.byte_length)
    }
  }
  const root = options?.storeDir ?? storeRoots.get(db)
  if (root === undefined) {
    throw new Error(
      'putExternalContentBlob: no content store root for this connection — ' +
        'open via openControlDb or call setContentStoreRoot first'
    )
  }
  const rel = `${digest.slice(0, 2)}/${digest}`
  const abs = join(root, rel)
  const dir = dirname(abs)
  mkdirSync(dir, { recursive: true })

  const digestOfFile = (): string | null => {
    if (!existsSync(abs)) return null
    return sha256Hex(readFileSync(abs))
  }

  // content-addressed name ⇒ an existing file with a matching digest IS the
  // content; a mismatching one is replaced via the same atomic publish path.
  if (digestOfFile() !== digest) {
    const tmp = join(dir, `.${digest}.${process.pid}.${randomUUID()}.tmp`)
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, abs)
    // read-back digest 확인 — verified=1 below must mean bytes-at-rest hash to
    // the key, not merely that we intended them to.
    if (digestOfFile() !== digest) {
      throw new StorageError(
        'ARTIFACT_MISMATCH',
        `external blob ${digest} failed post-publish digest verification`,
        { retry: 'reconcile', details: { digest, path: abs } }
      )
    }
  }
  db.prepare(
    'INSERT INTO content_blobs(digest, media_type, byte_length, body, external_ref, verified) ' +
      'VALUES (?,?,?,NULL,?,1)'
  ).run(digest, mediaType, bytes.byteLength, rel)
  return { digest, mediaType, sizeBytes: bytes.byteLength }
}

/**
 * Read a blob by digest. Returns null when no row exists.
 * Re-verifies the SHA-256 on every read — inline AND external. A digest
 * mismatch is ARTIFACT_MISMATCH, never silently returned bytes.
 */
export function getContentBlob(
  db: DatabaseSync,
  digest: string
): { bytes: Uint8Array; mediaType: string } | null {
  const row = selectBlob(db, digest)
  if (row === undefined) return null
  let bytes: Uint8Array
  if (row.body !== null && row.body !== undefined) {
    const body = row.body
    bytes = body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array(body as ArrayBuffer)
  } else if (typeof row.external_ref === 'string') {
    const root = storeRoots.get(db)
    if (root === undefined) {
      throw new Error(
        `content blob ${digest} is external (${row.external_ref}) but no content ` +
          'store root is associated with this connection'
      )
    }
    bytes = new Uint8Array(readFileSync(join(root, row.external_ref)))
  } else {
    // CHECK constraint makes this unreachable — defence, not logic
    throw new StorageError(
      'ARTIFACT_MISMATCH',
      `content blob ${digest} has neither body nor external_ref`
    )
  }
  if (sha256Hex(bytes) !== digest) {
    throw new StorageError(
      'ARTIFACT_MISMATCH',
      `content blob ${digest} bytes do not hash to their key`,
      {
        retry: 'reconcile',
        details: { digest, externalRef: row.external_ref ?? null }
      }
    )
  }
  return { bytes, mediaType: String(row.media_type) }
}
