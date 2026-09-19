// operations/gc.ts — retention pins and explicit garbage-collection ops.
//
// spec/storage.md §7: published models/implementations, live-or-unknown
// executions, unprocessed deliveries, accepted outputs and backup-pinned
// blobs are NEVER collected. Retention cleanup is an explicit operation, and
// partial cleanup leaves recorded residue in retry-safe form — never a
// silent partial sweep.
//
// spec/domains/resources-observation.md §1: RetentionPin {objectRef, reason,
// holderRef} — an object referenced by a published implementation, active
// execution, or handoff result must not be collected.
//
// storage.md §3 retention_pins DDL:
//   id TEXT PK, target_kind TEXT, target_id TEXT, holder_kind TEXT,
//   holder_id TEXT, reason TEXT
//
// This module owns:
//   - the typed resolver that maps retention_pins.target_kind → table/key,
//   - pin/unpin/query helpers other ops (backup.create) compose,
//   - planGc/runGc — explicit, dry-run-able, residue-recording collection.

import type { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { RetentionPin } from '../../../mahas-contracts/src/resource.ts'
import { nowMs, tryCount, type StorageOpsDeps } from './support.ts'

// ---------------------------------------------------------------------------
// RetentionPin typed resolver
// ---------------------------------------------------------------------------

/**
 * Every target_kind this schema understands and the (table, key) it resolves
 * to. A pin on an unknown kind still records — the resolver reports
 * `exists:false, resolvable:false` instead of guessing.
 */
export const PIN_TARGET_KINDS = {
  content_blob: { table: 'content_blobs', keyColumn: 'digest' },
  artifact: { table: 'artifacts', keyColumn: 'id' },
  model_version: { table: 'model_versions', keyColumn: 'id' },
  role_implementation: { table: 'role_implementations', keyColumn: 'id' },
  backup_set: { table: 'backup_sets', keyColumn: 'id' },
  execution: { table: 'executions', keyColumn: 'id' },
  member: { table: 'members', keyColumn: 'id' },
  run: { table: 'runs', keyColumn: 'id' },
  delivery: { table: 'deliveries', keyColumn: 'id' },
  message: { table: 'messages', keyColumn: 'id' },
  context_bundle: { table: 'context_bundles', keyColumn: 'digest' },
  work_envelope: { table: 'work_envelopes', keyColumn: 'digest' },
  external_blob: { table: 'content_blobs', keyColumn: 'digest' },
  harness_session: { table: 'harness_sessions', keyColumn: 'id' },
  collection_source: { table: 'collection_sources', keyColumn: 'id' },
  collection_batch: { table: 'collection_batches', keyColumn: 'id' },
  usage_entry: { table: 'usage_entries', keyColumn: 'id' },
  usage_reading: { table: 'usage_reading_facets', keyColumn: 'observation_id' },
  integration_pack: { table: 'integration_packs', keyColumn: 'id' }
} as const

export type PinTargetKind = keyof typeof PIN_TARGET_KINDS

export interface ResolvedPinTarget {
  resolvable: boolean
  exists: boolean
  table?: string
  keyColumn?: string
  detail?: string
}

/** resolve one pin's target to a row — typed, never kind-string blind */
export function resolvePinTarget(db: DatabaseSync, pin: RetentionPin): ResolvedPinTarget {
  const spec = PIN_TARGET_KINDS[pin.targetKind as PinTargetKind]
  if (!spec)
    return { resolvable: false, exists: false, detail: `unknown target_kind '${pin.targetKind}'` }
  try {
    const row = db
      .prepare(`SELECT ${spec.keyColumn} AS k FROM ${spec.table} WHERE ${spec.keyColumn} = ?`)
      .get(pin.targetId)
    return {
      resolvable: true,
      exists: row !== undefined,
      table: spec.table,
      keyColumn: spec.keyColumn
    }
  } catch (e) {
    return {
      resolvable: true,
      exists: false,
      table: spec.table,
      keyColumn: spec.keyColumn,
      detail: `lookup failed: ${e instanceof Error ? e.message : String(e)}`
    }
  }
}

function rowToPin(row: Record<string, unknown>): RetentionPin {
  return {
    id: row.id as RetentionPin['id'],
    targetKind: row.target_kind as RetentionPin['targetKind'],
    targetId: row.target_id as RetentionPin['targetId'],
    holderKind: row.holder_kind as RetentionPin['holderKind'],
    holderId: row.holder_id as RetentionPin['holderId'],
    reason: row.reason as RetentionPin['reason']
  } as RetentionPin
}

/**
 * Deterministic pin id — re-pinning the same (target, holder) pair is a
 * no-op, which makes pin-writing retry-safe inside any caller's tx.
 */
export function pinIdFor(
  deps: Pick<StorageOpsDeps, 'sha256Hex'>,
  targetKind: string,
  targetId: string,
  holderKind: string,
  holderId: string
): string {
  return `pin-${deps.sha256Hex(`${targetKind}|${targetId}|${holderKind}|${holderId}`)}`.slice(0, 80)
}

export interface PinInput {
  targetKind: PinTargetKind | string
  targetId: string
  holderKind: string
  holderId: string
  reason: string
}

/** insert-if-absent; returns the (possibly pre-existing) pin id */
export function pinTarget(db: DatabaseSync, deps: StorageOpsDeps, pin: PinInput): string {
  const id = pinIdFor(deps, pin.targetKind, pin.targetId, pin.holderKind, pin.holderId)
  db.prepare(
    `INSERT OR IGNORE INTO retention_pins(id, target_kind, target_id, holder_kind, holder_id, reason)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, pin.targetKind, pin.targetId, pin.holderKind, pin.holderId, pin.reason)
  return id
}

export function unpinTarget(db: DatabaseSync, pinId: string): boolean {
  const res = db.prepare('DELETE FROM retention_pins WHERE id = ?').run(pinId)
  return Number(res.changes) > 0
}

/** drop every pin held by (holderKind, holderId) — e.g. a deleted backup set */
export function unpinByHolder(db: DatabaseSync, holderKind: string, holderId: string): number {
  const res = db
    .prepare('DELETE FROM retention_pins WHERE holder_kind = ? AND holder_id = ?')
    .run(holderKind, holderId)
  return Number(res.changes)
}

export function pinsForTarget(
  db: DatabaseSync,
  targetKind: string,
  targetId: string
): RetentionPin[] {
  try {
    const rows = db
      .prepare('SELECT * FROM retention_pins WHERE target_kind = ? AND target_id = ?')
      .all(targetKind, targetId) as Record<string, unknown>[]
    return rows.map(rowToPin)
  } catch {
    return []
  }
}

export function pinsByHolder(
  db: DatabaseSync,
  holderKind: string,
  holderId: string
): RetentionPin[] {
  try {
    const rows = db
      .prepare('SELECT * FROM retention_pins WHERE holder_kind = ? AND holder_id = ?')
      .all(holderKind, holderId) as Record<string, unknown>[]
    return rows.map(rowToPin)
  } catch {
    return []
  }
}

export function isTargetPinned(db: DatabaseSync, targetKind: string, targetId: string): boolean {
  try {
    return (
      db
        .prepare(
          'SELECT 1 AS x FROM retention_pins WHERE target_kind = ? AND target_id = ? LIMIT 1'
        )
        .get(targetKind, targetId) !== undefined
    )
  } catch {
    // an unreadable pin table must be treated as "pinned" — collection errs
    // conservative, never destructive (spec §7).
    return true
  }
}

// ---------------------------------------------------------------------------
// GC — explicit retention operations only
// ---------------------------------------------------------------------------

export type GcTargetKind =
  'unreferenced_content_blobs' | 'orphan_external_blob_files' | 'failed_backup_sets'

export interface GcCandidate {
  kind: GcTargetKind
  id: string
  detail: string
}

export interface GcResidue {
  kind: string
  id: string
  reason: string
  retryable: true
}

export interface GcPlan {
  plannedAt: number
  collectable: GcCandidate[]
  protectedCounts: Record<string, number>
  skipped: { pinned: number; referenced: number; unreadable: number }
}

export interface GcReport extends GcPlan {
  dryRun: boolean
  collected: GcCandidate[]
  residues: GcResidue[]
}

export interface GcOptions {
  dryRun?: boolean
  targets?: GcTargetKind[]
  externalBlobDir?: string
  backupRoot?: string
}

/**
 * Live references that keep a content_blobs row uncollectable. Each entry is
 * a (sql, param) probe evaluated per candidate digest; a probe that cannot be
 * evaluated counts as a reference — see isBlobReferenced.
 */
const BLOB_REFERENCE_PROBES: { source: string; sql: string }[] = [
  {
    source: 'work_envelopes.body_digest',
    sql: 'SELECT 1 AS x FROM work_envelopes WHERE body_digest = ? LIMIT 1'
  },
  {
    source: 'context_bundles.required_text_digest',
    sql: 'SELECT 1 AS x FROM context_bundles WHERE required_text_digest = ? LIMIT 1'
  },
  {
    source: 'artifacts.storage_ref_json.digest',
    sql: `SELECT 1 AS x FROM artifacts
          WHERE json_extract(storage_ref_json, '$.digest') = ? LIMIT 1`
  },
  {
    source: 'backup_sets.manifest_json',
    sql: `SELECT 1 AS x FROM backup_sets
          WHERE state IN ('complete','incomplete','restored')
            AND manifest_json LIKE '%' || ? || '%' LIMIT 1`
  }
]

/**
 * Conservative reference check: ANY failure to prove non-reference is
 * treated as "referenced" — GC never deletes on ambiguous evidence.
 */
export function isBlobReferenced(
  db: DatabaseSync,
  digest: string
): { referenced: boolean; by?: string } {
  for (const probe of BLOB_REFERENCE_PROBES) {
    try {
      if (db.prepare(probe.sql).get(digest) !== undefined) {
        return { referenced: true, by: probe.source }
      }
    } catch {
      return { referenced: true, by: `${probe.source} (unverifiable — probe failed)` }
    }
  }
  return { referenced: false }
}

/** counts reported for transparency — these classes are never candidates */
function protectedCounts(db: DatabaseSync): Record<string, number> {
  return {
    published_model_versions: tryCount(
      db,
      `SELECT count(*) AS n FROM model_versions WHERE status = 'published'`
    ),
    published_role_implementations: tryCount(
      db,
      `SELECT count(*) AS n FROM role_implementations WHERE status IN ('published','active')`
    ),
    live_or_unknown_executions: tryCount(
      db,
      `SELECT count(*) AS n FROM executions WHERE liveness IN ('live','unverifiable')`
    ),
    outstanding_deliveries: tryCount(
      db,
      `SELECT count(*) AS n FROM deliveries WHERE status = 'outstanding'`
    ),
    accepted_outcomes: tryCount(
      db,
      `SELECT count(*) AS n FROM settlements WHERE decision = 'accepted'`
    ),
    retention_pins: tryCount(db, 'SELECT count(*) AS n FROM retention_pins')
  }
}

interface BlobRow {
  digest: string
  external_ref: string | null
  byte_length: number
}

/**
 * Plan collection: enumerate candidates WITHOUT deleting. The only entity
 * class this GC ever selects is content (content_blobs rows, external blob
 * files, failed backup sets) — live domain objects are never candidates.
 */
export function planGc(db: DatabaseSync, deps: StorageOpsDeps, opts: GcOptions = {}): GcPlan {
  const targets = new Set<GcTargetKind>(
    opts.targets ?? ['unreferenced_content_blobs', 'orphan_external_blob_files']
  )
  const collectable: GcCandidate[] = []
  const skipped = { pinned: 0, referenced: 0, unreadable: 0 }

  if (targets.has('unreferenced_content_blobs')) {
    let blobs: BlobRow[] = []
    try {
      blobs = db
        .prepare('SELECT digest, external_ref, byte_length FROM content_blobs')
        .all() as unknown as BlobRow[]
    } catch {
      skipped.unreadable++
    }
    for (const b of blobs) {
      if (
        isTargetPinned(db, 'content_blob', b.digest) ||
        isTargetPinned(db, 'external_blob', b.digest)
      ) {
        skipped.pinned++
        continue
      }
      const ref = isBlobReferenced(db, b.digest)
      if (ref.referenced) {
        skipped.referenced++
        continue
      }
      collectable.push({
        kind: 'unreferenced_content_blobs',
        id: b.digest,
        detail: `content_blob ${b.digest.slice(0, 16)}… (${b.byte_length}B${b.external_ref ? ', external' : ''})`
      })
    }
  }

  if (targets.has('orphan_external_blob_files') && opts.externalBlobDir) {
    collectable.push(...planOrphanBlobFiles(db, opts.externalBlobDir, skipped))
  }

  if (targets.has('failed_backup_sets') && opts.backupRoot) {
    try {
      const rows = db.prepare(`SELECT id FROM backup_sets WHERE state = 'failed'`).all() as {
        id: string
      }[]
      for (const r of rows) {
        if (isTargetPinned(db, 'backup_set', r.id)) {
          skipped.pinned++
          continue
        }
        collectable.push({
          kind: 'failed_backup_sets',
          id: r.id,
          detail: `failed backup set ${r.id}`
        })
      }
    } catch {
      skipped.unreadable++
    }
  }

  return {
    plannedAt: nowMs(deps),
    collectable,
    protectedCounts: protectedCounts(db),
    skipped
  }
}

function planOrphanBlobFiles(
  db: DatabaseSync,
  externalBlobDir: string,
  skipped: { pinned: number; referenced: number; unreadable: number }
): GcCandidate[] {
  const out: GcCandidate[] = []
  // F-004: shard-aware recursive walk — the store layout is
  // <root>/<digest[0:2]>/<digest> (see putExternalContentBlob), so a
  // top-level readdir only sees shard directories. Enumerate real files
  // with their store-relative path and never list a directory as a
  // deletion candidate.
  let relFiles: string[] = []
  try {
    relFiles = listBlobFilesRecursive(externalBlobDir)
  } catch {
    skipped.unreadable++
    return out
  }
  let known = new Set<string>()
  try {
    known = new Set(
      (
        db.prepare('SELECT digest FROM content_blobs WHERE external_ref IS NOT NULL').all() as {
          digest: string
        }[]
      ).map((r) => r.digest)
    )
  } catch {
    skipped.unreadable++
    return out // cannot prove orphanhood — collect nothing
  }
  for (const f of relFiles) {
    // known holds digests; relFiles holds store-relative paths
    // (<shard>/<digest> or legacy flat <digest>).
    const digest = f.includes('/') ? (f.split('/').pop() as string) : f
    if (known.has(digest)) continue // a row references it — not an orphan
    if (isTargetPinned(db, 'external_blob', f) || isTargetPinned(db, 'external_blob', digest)) {
      skipped.pinned++
      continue
    }
    out.push({
      kind: 'orphan_external_blob_files',
      id: f,
      detail: `external blob file ${f} with no content_blobs row`
    })
  }
  return out
}

/**
 * Recursively list blob files under the external store as store-relative
 * paths. Directories (incl. shard dirs) are never returned — only regular
 * files — so the planner cannot emit an EISDIR unlink candidate. Dot/tmp
 * files are skipped.
 */
function listBlobFilesRecursive(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name.endsWith('.tmp')) continue
      const abs = join(dir, name)
      const relPath = rel.length > 0 ? `${rel}/${name}` : name
      let isDir = false
      try {
        isDir = statSync(abs).isDirectory()
      } catch {
        continue // raced away — not provably an orphan
      }
      if (isDir) walk(abs, relPath)
      else out.push(relPath)
    }
  }
  walk(root, '')
  return out
}

/**
 * Execute a GC plan. Every deletion is individually keyed and idempotent
 * (DELETE by digest / rm by name), so re-running after a failure only retries
 * what remains. Failures are recorded BOTH in the returned report and as
 * retry-safe residue rows in effect_intents (state 'unknown' — a reconcile
 * target, never a silent gap; spec/common.md §5).
 */
export function runGc(db: DatabaseSync, deps: StorageOpsDeps, opts: GcOptions = {}): GcReport {
  const plan = planGc(db, deps, opts)
  const report: GcReport = { ...plan, dryRun: opts.dryRun === true, collected: [], residues: [] }
  if (report.dryRun) return report

  for (const c of plan.collectable) {
    try {
      collectOne(db, c, opts)
      report.collected.push(c)
    } catch (e) {
      const residue: GcResidue = {
        kind: c.kind,
        id: c.id,
        reason: e instanceof Error ? e.message : String(e),
        retryable: true
      }
      report.residues.push(residue)
      recordResidue(db, deps, residue)
    }
  }
  return report
}

function collectOne(db: DatabaseSync, c: GcCandidate, opts: GcOptions): void {
  switch (c.kind) {
    case 'unreferenced_content_blobs': {
      // re-verify inside the delete: concurrent pin/reference between plan and
      // collect still protects the row
      if (isTargetPinned(db, 'content_blob', c.id)) return
      const ref = isBlobReferenced(db, c.id)
      if (ref.referenced) return
      const row = db
        .prepare('SELECT external_ref FROM content_blobs WHERE digest = ?')
        .get(c.id) as { external_ref: string | null } | undefined
      db.prepare('DELETE FROM content_blobs WHERE digest = ?').run(c.id)
      if (row?.external_ref && opts.externalBlobDir) {
        const p = join(opts.externalBlobDir, row.external_ref)
        if (existsSync(p)) unlinkSync(p)
      }
      return
    }
    case 'orphan_external_blob_files': {
      if (!opts.externalBlobDir) return
      if (isTargetPinned(db, 'external_blob', c.id)) return
      const p = join(opts.externalBlobDir, c.id)
      if (existsSync(p)) unlinkSync(p)
      return
    }
    case 'failed_backup_sets': {
      if (!opts.backupRoot) return
      if (isTargetPinned(db, 'backup_set', c.id)) return
      db.prepare(`DELETE FROM backup_sets WHERE id = ? AND state = 'failed'`).run(c.id)
      rmSync(join(opts.backupRoot, c.id), { recursive: true, force: true })
      unpinByHolder(db, 'backup_set', c.id)
      return
    }
  }
}

/**
 * Retry-safe residue record: a deterministic effect id means a retried sweep
 * upserts instead of duplicating. The residue states the failed target,
 * reason, and cleanup policy explicitly (ResidualResource contract —
 * resources-observation §1).
 */
function recordResidue(db: DatabaseSync, deps: StorageOpsDeps, residue: GcResidue): void {
  try {
    const effectId = `gc-residue-${deps.sha256Hex(`${residue.kind}|${residue.id}`).slice(0, 32)}`
    const payload = {
      effectId,
      resourceRef: { kind: residue.kind, id: residue.id },
      reason: residue.reason,
      liveEvidence: null,
      cleanupPolicy: 'retry: rerun gc target — deletion is idempotent'
    }
    db.prepare(
      `INSERT INTO effect_intents(id, operation_key, kind, fingerprint, host_id, state, payload_json, receipt_json, residuals_json)
       VALUES (?, ?, 'gc.collect', ?, NULL, 'unknown', ?, '{}', ?)
       ON CONFLICT(id) DO UPDATE SET
         state = 'unknown',
         residuals_json = excluded.residuals_json`
    ).run(
      effectId,
      `gc:${residue.kind}:${residue.id}`,
      deps.sha256Hex(JSON.stringify(residue)),
      JSON.stringify(payload),
      JSON.stringify([payload])
    )
  } catch {
    // residue recording itself failing never masks the original failure —
    // it is already in the returned report.
  }
}

/** convenience for backup.create: pin every content/artifact ref it captured */
export function pinBackupContents(
  db: DatabaseSync,
  deps: StorageOpsDeps,
  backupSetId: string,
  refs: { targetKind: PinTargetKind | string; targetId: string }[]
): string[] {
  const ids: string[] = []
  for (const r of refs) {
    ids.push(
      pinTarget(db, deps, {
        targetKind: r.targetKind,
        targetId: r.targetId,
        holderKind: 'backup_set',
        holderId: backupSetId,
        reason: 'retained by backup set manifest'
      })
    )
  }
  return ids
}
