// source-snapshots.ts — pinned source-file observation for context.build.
//
// spec/contracts/realization.md context.build: "원본 파일 byte 관측을
// immutable snapshot에 저장". A sourceSnapshotPin is the caller's claim that
// repo-relative `path` currently has sha256 `digest`; the compiler reads the
// real bytes, proves the claim, and stores them as content_blobs so the
// bundle stays reproducible evidence (REQ-22 — snapshots are not a second
// authored 정본).
//
//   - file missing/unreadable      → SNAPSHOT_REQUIRED (no bytes to pin)
//   - observed digest ≠ pin digest → INTERFACE_STALE (source moved; the
//                                    implementation may need re-review —
//                                    D-ROLE §5 keeps this a stale candidate,
//                                    never a silent rebuild)
//   - two pins for one path with different digests → MODEL_INVALID

import { readFileSync } from 'node:fs'
import { resolve as resolvePath, sep as pathSep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { digestBytes, fail, putBlob, type SourceObservation } from './bundle-store.ts'

/** One pin from the context.build payload. */
export interface SourceSnapshotPin {
  path: string
  digest: string
  mediaType?: string
}

/** Returns the file's bytes, or null when it cannot be read. Injectable so
 *  tests and non-filesystem source providers can drive the compiler. */
export type SourceReader = (path: string) => Uint8Array | null

/** Observation plus the raw bytes — kept in memory only; the persisted
 *  SourceObservation (bundle-store.ts) drops `bytes`. */
export interface ObservedSource extends SourceObservation {
  bytes: Uint8Array
}

/**
 * PathRef rules (spec/common.md §1): repo-relative, no NUL, no absolute
 * paths, no `..` escapes. Additionally `\`, `.` segments, empty segments and
 * drive letters are rejected so one path spells one byte sequence on every
 * host.
 */
export function assertValidSourcePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length === 0) {
    fail('MODEL_INVALID', `source path must be a non-empty string, got ${JSON.stringify(path)}`)
  }
  if (
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path)
  ) {
    fail('MODEL_INVALID', `invalid source path (absolute or non-POSIX): ${JSON.stringify(path)}`)
  }
  const segments = path.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    fail('MODEL_INVALID', `invalid source path (empty/./.. segment): ${JSON.stringify(path)}`)
  }
}

const MEDIA_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.toml': 'application/toml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml'
}

export function mediaTypeForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.'))
  return MEDIA_BY_EXT[ext] ?? 'application/octet-stream'
}

/** Default reader: bytes under `root` (a checkout/repository root supplied
 *  by the caller — never guessed here). */
export function makeFilesystemReader(root: string): SourceReader {
  const rootResolved = resolvePath(root)
  return (rel) => {
    try {
      assertValidSourcePath(rel)
      const resolved = resolvePath(rootResolved, rel)
      const prefix = rootResolved.endsWith(pathSep) ? rootResolved : rootResolved + pathSep
      if (resolved !== rootResolved && !resolved.startsWith(prefix)) return null
      return new Uint8Array(readFileSync(resolved))
    } catch {
      return null
    }
  }
}

/**
 * Observe every pin, deterministically (paths sorted). The returned
 * observations already carry `blobDigest` — it is the sha256 of the bytes,
 * identical to what putContentBlob will store, so the manifest can be built
 * before the blobs hit the DB.
 */
export function observeSources(
  pins: readonly SourceSnapshotPin[],
  read: SourceReader
): ObservedSource[] {
  const byPath = new Map<string, SourceSnapshotPin>()
  for (const pin of pins) {
    if (pin === null || typeof pin !== 'object') {
      fail('MODEL_INVALID', `source pin must be an object, got ${JSON.stringify(pin)}`)
    }
    assertValidSourcePath(pin.path)
    if (typeof pin.digest !== 'string' || !/^[0-9a-f]{64}$/.test(pin.digest)) {
      fail('MODEL_INVALID', `source pin for ${pin.path} needs a lowercase sha256 hex digest`)
    }
    const prev = byPath.get(pin.path)
    if (prev) {
      if (prev.digest !== pin.digest) {
        fail('MODEL_INVALID', `conflicting sourceSnapshotPins for ${pin.path}`, { path: pin.path })
      }
      continue
    }
    byPath.set(pin.path, pin)
  }

  const observed: ObservedSource[] = []
  for (const path of [...byPath.keys()].sort()) {
    const pin = byPath.get(path)!
    const bytes = read(path)
    if (bytes === null) {
      fail(
        'SNAPSHOT_REQUIRED',
        `pinned source ${path} could not be observed`,
        { path },
        'same-operation'
      )
    }
    const observedDigest = digestBytes(bytes)
    if (observedDigest !== pin.digest) {
      fail(
        'INTERFACE_STALE',
        `source ${path} changed since it was pinned — the implementation may be stale`,
        { path, pinnedDigest: pin.digest, observedDigest },
        'reconcile'
      )
    }
    observed.push({
      path,
      pinnedDigest: pin.digest,
      observedDigest,
      blobDigest: observedDigest,
      byteLength: bytes.byteLength,
      mediaType: typeof pin.mediaType === 'string' ? pin.mediaType : mediaTypeForPath(path),
      bytes
    })
  }
  return observed
}

/** Persist observed source bytes to content_blobs (dedup by digest). */
export function persistObservedSources(
  db: DatabaseSync,
  observed: readonly ObservedSource[]
): void {
  for (const o of observed) {
    const blob = putBlob(db, o.bytes, o.mediaType)
    if (blob.digest !== o.blobDigest) {
      // putContentBlob is specified as sha256-of-bytes; a mismatch means the
      // kernel diverged from spec — fail loudly rather than record a lie.
      fail('MODEL_INVALID', `content blob digest mismatch for source ${o.path}`, {
        path: o.path,
        observedDigest: o.observedDigest,
        storedDigest: blob.digest
      })
    }
  }
}
