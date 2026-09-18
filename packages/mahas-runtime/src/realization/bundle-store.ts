// bundle-store.ts — ContextBundle persistence + canonical serialization.
//
// Leaf module of the realization compiler (IMP-08, C-REALIZATION context.build):
// it imports only the shared storage kernel (IMP-03, spec/storage.md §3) and
// contract types — never a sibling realization module, so the import graph
// stays a DAG: bundle-store ← source-snapshots / coverage ← compiler.
//
// Owns:
//   - canonicalJson: the ONLY byte form digests are computed over (sorted
//     object keys recursively; arrays keep declared order). Same input value
//     → same bytes → same sha256, which is what makes context.build
//     deterministic per spec/contracts/realization.md §빌드 함수.
//   - fail(): every compiler rejection is a MahasError-shaped throw — the
//     IMP-11 registry turns it into a rejected CommandReceipt.
//   - putBlob / insertContextBundle / getContextBundle: content_blobs and
//     context_bundles rows, exactly the DDL columns.

import type { DatabaseSync } from 'node:sqlite'
import { putContentBlob, sha256Hex } from '../storage/db.ts'
import type {
  BundleDigest,
  ErrorCode,
  ErrorRetry,
  MahasError
} from '../../../mahas-contracts/src/common.ts'

// ---------------------------------------------------------------------------
// errors

/** Throw a MahasError. `retry` defaults to 'none': a deterministic compile
 *  fails the same way on identical input, so blind retries are pointless. */
export function fail(
  code: ErrorCode,
  message: string,
  details?: unknown,
  retry: ErrorRetry = 'none'
): never {
  const error: MahasError = { code, message, retry }
  if (details !== undefined) error.details = details
  throw error
}

// ---------------------------------------------------------------------------
// canonical serialization

/**
 * Deterministic JSON: object keys sorted at every depth, array order
 * preserved (declared order is meaningful input), undefined object members
 * dropped. Non-JSON values are a compile-time defect → MODEL_INVALID.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key]
      if (member === undefined) continue
      out[key] = sortKeysDeep(member)
    }
    return out
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    fail('MODEL_INVALID', `non-JSON value cannot be canonically serialized: ${typeof value}`)
  }
  return value
}

// ---------------------------------------------------------------------------
// byte / digest helpers

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** utf-8 decode for injected source text. Non-UTF-8 bytes cannot become
 *  instruction text — refuse instead of silently inserting U+FFFD. */
export function utf8Decode(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('MODEL_INVALID', `${what} is not valid UTF-8 and cannot be injected as instruction text`)
  }
}

export function digestBytes(bytes: Uint8Array): string {
  return sha256Hex(bytes)
}

export function digestText(text: string): string {
  return sha256Hex(utf8(text))
}

/** sha256 over canonicalJson — the only digest used for bundle identity. */
export function digestCanonical(value: unknown): string {
  return sha256Hex(utf8(canonicalJson(value)))
}

// ---------------------------------------------------------------------------
// persisted shapes (spec/storage.md §3 columns + manifest layout)

/** One entry of context_bundles.source_observations_json — proof that the
 *  exact pinned source bytes were observed at build time. This is
 *  reproduction evidence, not a new authored copy (REQ-22). */
export interface SourceObservation {
  path: string
  pinnedDigest: string
  observedDigest: string
  /** content_blobs digest of the observed bytes (== observedDigest) */
  blobDigest: string
  byteLength: number
  mediaType: string
}

/** CoverageBinding as recorded in manifest.coverage — one row per
 *  (clause, component, section) realization decision. `delivery` is the
 *  compiled load route for THIS binding (spec/injection.md §4). */
export interface CoverageRecord {
  clauseId: string
  componentId: string
  sectionKey: string
  realization: 'verbatim' | 'reexpressed'
  requiredLoadPhase: 'inline' | 'preload' | 'catalog'
  delivery: 'mandatory-text' | 'confirmed-preload' | 'catalog'
}

/** manifest.components[] — every component of the implementation revision,
 *  with the digest of its rendered artifact blob and where the launch-time
 *  materializer installs it under <execution-root>/ (spec/injection.md §3). */
export interface ComponentManifestEntry {
  componentId: string
  kind: string
  activation: string
  installPath: string
  blobDigest: string
  byteLength: number
  mediaType: string
  loadRoutes: string[]
  consumes: string[]
  covers: string[]
}

/** Trace-only echo of maintenance_bindings (instruction §4.3): recorded so
 *  reviewers can see why a section exists — NEVER an injection list. */
export interface MaintenanceBasisEntry {
  id: string
  basisRef: unknown
  componentRef: unknown
}

export interface BundleManifest {
  format: 'context-bundle/1'
  role: { id: string; name?: string; modelVersion: string }
  interfaceDigest: string
  implementationId: string
  implementationRevision: number
  surfaceDigest: string
  requiredText: { digest: string; byteLength: number; mediaType: string }
  components: ComponentManifestEntry[]
  coverage: CoverageRecord[]
  sourceObservations: SourceObservation[]
  maintenanceBasis: MaintenanceBasisEntry[]
  surface: { digest: string; actions: string[] }
}

export interface ContextBundleRecord {
  digest: string
  implementationId: string
  implementationRevision: number
  interfaceDigest: string
  surfaceDigest: string
  requiredTextDigest: string
  manifest: BundleManifest
  sourceObservations: SourceObservation[]
}

// ---------------------------------------------------------------------------
// persistence

export interface StoredBlob {
  digest: string
  mediaType: string
  byteLength: number
}

/** Store bytes in content_blobs (dedup by digest is the kernel's job). */
export function putBlob(db: DatabaseSync, bytes: Uint8Array, mediaType: string): StoredBlob {
  const ref = putContentBlob(db, bytes, mediaType)
  return { digest: ref.digest, mediaType, byteLength: bytes.byteLength }
}

/**
 * Insert the context_bundles row. Bundles are content-addressed and
 * immutable: an identical digest means identical content, so OR IGNORE is
 * the correct idempotent rebuild — no revision churn, no overwrite.
 */
export function insertContextBundle(db: DatabaseSync, record: ContextBundleRecord): void {
  db.prepare(
    `INSERT OR IGNORE INTO context_bundles
       (digest, implementation_id, implementation_revision, interface_digest,
        surface_digest, required_text_digest, manifest_json, source_observations_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.digest,
    record.implementationId,
    record.implementationRevision,
    record.interfaceDigest,
    record.surfaceDigest,
    record.requiredTextDigest,
    canonicalJson(record.manifest),
    canonicalJson(record.sourceObservations)
  )
}

export function getContextBundle(db: DatabaseSync, digest: string): ContextBundleRecord | null {
  const row = db
    .prepare(
      `SELECT digest, implementation_id, implementation_revision, interface_digest,
              surface_digest, required_text_digest, manifest_json, source_observations_json
         FROM context_bundles WHERE digest = ?`
    )
    .get(digest) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    digest: row.digest as string,
    implementationId: row.implementation_id as string,
    implementationRevision: row.implementation_revision as number,
    interfaceDigest: row.interface_digest as string,
    surfaceDigest: row.surface_digest as string,
    requiredTextDigest: row.required_text_digest as string,
    manifest: JSON.parse(row.manifest_json as string) as BundleManifest,
    sourceObservations: JSON.parse(row.source_observations_json as string) as SourceObservation[]
  }
}

/**
 * Bundle identity = sha256 over the canonical manifest. The manifest already
 * carries every input pin (interface/implementation/surface digests), the
 * requiredText digest, per-component artifact digests and the source
 * observations — so hashing it fixes the whole build, nothing else needed.
 */
export function bundleDigestOf(manifest: BundleManifest): BundleDigest {
  return digestCanonical(manifest) as BundleDigest
}
