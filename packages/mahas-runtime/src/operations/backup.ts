// operations/backup.ts — backup.create (C-RECOVERY).
//
// Contract (spec/contracts/recovery-operations.md):
//   input:  {scope, retentionPolicy}
//   output: BackupSet with consistency point and blob pins
//   effect: explicit snapshot operation + backup manifest recorded
//   refusal/unclear: partial copy is failed/unknown; a success that omitted
//                    raw WAL files may never be claimed by copying the main
//                    file alone.
//
// Implementation (spec/storage.md §7): the control snapshot is taken with
// sqlite3_serialize (DatabaseSync.serialize) — a consistent image of the WAL
// database, never a raw copy of its main file. The manifest binds the
// snapshot digest + every ContentBlob/Artifact/host-receipt the set needs,
// and each referenced object gets a retention_pins row so GC keeps it.

import type { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import type { BackupSet } from '../../../mahas-contracts/src/observation.ts'
import type { OperationRegistry, TxnContext } from '../api/registry.ts'
import {
  atomicWriteBytes,
  canonicalJson,
  genId,
  isMahasError,
  nowMs,
  openForSnapshot,
  opsError,
  readFileBytes,
  requireStorageDeps,
  sha256File,
  snapshotImage,
  type StorageOpsDeps
} from './support.ts'
import { assertWritableSchema, readSchemaVersion } from './migration.ts'
import { pinBackupContents, unpinByHolder } from './gc.ts'
import { restoreBackupSet, parseRestorePayload, type RestoreResult } from './restore.ts'

// ---------------------------------------------------------------------------
// deps & payload types
// ---------------------------------------------------------------------------

export interface BackupOpsDeps extends StorageOpsDeps {
  /** root directory that holds one subdirectory per backup set */
  backupRoot: string
  /** absolute path of the live control DB — restore refuses to target it */
  controlDbPath?: string
  /** execution-host DB files to include as host snapshots */
  hostDbPaths?: () => readonly string[]
  /** root under which content_blobs.external_ref paths resolve */
  externalBlobDir?: string
  /** operator-supplied liveness check for a restore target (best-effort) */
  isTargetStopped?: (dbPath: string) => boolean
}

export interface BackupScope {
  /** false | true | explicit host db paths (default: deps.hostDbPaths) */
  includeHosts?: boolean | string[]
  /** copy external_ref blob files into the set (default true) */
  includeExternalBlobs?: boolean
}

export interface BackupCreatePayload {
  scope?: BackupScope
  retentionPolicy?: unknown
}

export interface BackupResidue {
  kind: string
  ref: string
  reason: string
}

export interface BackupManifest {
  kind: 'mahas-control-backup'
  formatVersion: 1
  backupSetId: string
  schemaVersion: number | null
  capturedAt: number
  consistencyPoint: {
    capturedAt: number
    method: 'sqlite3_serialize'
    imageDigest: string
    imageBytes: number
  }
  control: { path: string; sha256: string; bytes: number }
  hosts: {
    sourcePath: string
    path?: string
    sha256?: string
    bytes?: number
    status: 'captured' | 'failed'
    error?: string
  }[]
  content: {
    digest: string
    mediaType: string
    byteLength: number
    location: 'db' | 'external'
    path?: string
    sha256?: string
    status: 'captured-in-snapshot' | 'captured' | 'missing' | 'digest-mismatch'
    error?: string
  }[]
  artifacts: {
    artifactId: string
    revision: number
    digest: string
    storageRef: unknown
    path?: string
    sha256?: string
    status: 'ref-recorded' | 'captured' | 'missing' | 'digest-mismatch'
    error?: string
  }[]
  retentionPolicy: unknown
  residues: BackupResidue[]
  /** sha256 over canonicalJson(manifest without this field) */
  manifestDigest?: string
}

export type BackupSetState = 'creating' | 'complete' | 'incomplete' | 'failed' | 'restored'

export interface CreateBackupResult {
  backupSet: BackupSet
  id: string
  state: BackupSetState
  dir: string
  manifestDigest: string
  consistencyPoint: BackupManifest['consistencyPoint']
  contentPins: string[]
  residues: BackupResidue[]
}

// ---------------------------------------------------------------------------
// payload parsing
// ---------------------------------------------------------------------------

export function parseCreatePayload(payload: unknown): BackupCreatePayload {
  const p = (payload ?? {}) as Record<string, unknown>
  const scopeIn = (p.scope ?? {}) as Record<string, unknown>
  const scope: BackupScope = {}
  if (scopeIn.includeHosts !== undefined) {
    if (
      typeof scopeIn.includeHosts === 'boolean' ||
      (Array.isArray(scopeIn.includeHosts) &&
        scopeIn.includeHosts.every((x) => typeof x === 'string'))
    ) {
      scope.includeHosts = scopeIn.includeHosts as BackupScope['includeHosts']
    } else {
      throw opsError(
        'INPUT_NOT_READY',
        'scope.includeHosts must be boolean or string[]',
        'same-operation'
      )
    }
  }
  if (scopeIn.includeExternalBlobs !== undefined) {
    if (typeof scopeIn.includeExternalBlobs !== 'boolean') {
      throw opsError(
        'INPUT_NOT_READY',
        'scope.includeExternalBlobs must be boolean',
        'same-operation'
      )
    }
    scope.includeExternalBlobs = scopeIn.includeExternalBlobs
  }
  return { scope, retentionPolicy: p.retentionPolicy }
}

// ---------------------------------------------------------------------------
// backup.create
// ---------------------------------------------------------------------------

/**
 * Build a backup set. Row writes go to `db` inside the CALLER's atomic unit
 * (the registry wraps handlers; standalone callers use
 * createBackupSetStandalone, which wraps this in deps.withTx). File artifacts
 * land under `<backupRoot>/<backupSetId>/` — a FAILED marker file is left on
 * error so an interrupted set can never masquerade as complete.
 */
export function createBackupSet(
  db: DatabaseSync,
  deps: BackupOpsDeps,
  payload: BackupCreatePayload
): CreateBackupResult {
  requireStorageDeps(deps)
  assertWritableSchema(db)

  const backupSetId = genId(deps, 'backup')
  const setDir = join(deps.backupRoot, backupSetId)
  const residues: BackupResidue[] = []

  try {
    mkdirSync(setDir, { recursive: true })

    // 1. consistent control snapshot FIRST — before this operation writes
    //    any bookkeeping rows, so the image is the pre-backup state.
    const capturedAt = nowMs(deps)
    const image = snapshotImage(db)
    const imageDigest = sha256File(image)
    const consistencyPoint: BackupManifest['consistencyPoint'] = {
      capturedAt,
      method: 'sqlite3_serialize',
      imageDigest,
      imageBytes: image.length
    }
    const controlEntry = { path: 'control.sqlite', sha256: imageDigest, bytes: image.length }
    atomicWriteBytes(join(setDir, controlEntry.path), image)

    // 2. host snapshots — same consistent-image rule on the host's own DB;
    //    opened snapshot-only so the control plane never writes to it.
    const hosts: BackupManifest['hosts'] = []
    const hostPaths = resolveHostPaths(deps, payload.scope)
    hostPaths.forEach((sourcePath, i) => {
      const entry: BackupManifest['hosts'][number] = { sourcePath, status: 'failed' }
      hosts.push(entry)
      try {
        if (!existsSync(sourcePath)) throw new Error('host db file not found')
        const hostDb = openForSnapshot(sourcePath)
        try {
          const himg = snapshotImage(hostDb)
          entry.path = `hosts/host-${i}-${basename(sourcePath)}`
          entry.sha256 = sha256File(himg)
          entry.bytes = himg.length
          atomicWriteBytes(join(setDir, entry.path), himg)
          entry.status = 'captured'
        } finally {
          hostDb.close()
        }
      } catch (e) {
        entry.error = e instanceof Error ? e.message : String(e)
        residues.push({ kind: 'host-snapshot', ref: sourcePath, reason: entry.error })
      }
    })

    // 3. content inventory — db-resident bytes travel inside the snapshot;
    //    external_ref files are copied and digest-verified.
    const includeExternal = payload.scope?.includeExternalBlobs !== false
    const content: BackupManifest['content'] = []
    const pinRefs: { targetKind: string; targetId: string }[] = []
    for (const b of inventoryContent(db)) {
      const entry: BackupManifest['content'][number] = {
        digest: b.digest,
        mediaType: b.media_type,
        byteLength: b.byte_length,
        location: b.external_ref ? 'external' : 'db',
        status: 'captured-in-snapshot'
      }
      content.push(entry)
      if (!b.external_ref) {
        pinRefs.push({ targetKind: 'content_blob', targetId: b.digest })
        continue
      }
      entry.status = 'missing'
      if (!includeExternal) {
        entry.error = 'external blob excluded by scope'
        residues.push({ kind: 'external-blob', ref: b.digest, reason: entry.error })
        continue
      }
      try {
        const src = isAbsolute(b.external_ref)
          ? b.external_ref
          : join(deps.externalBlobDir ?? '', b.external_ref)
        if (!existsSync(src)) throw new Error(`external blob not found: ${src}`)
        const bytes = readFileBytes(src)
        const digest = sha256File(bytes)
        entry.path = `blobs/${b.digest}`
        entry.sha256 = digest
        if (digest !== b.digest) {
          entry.status = 'digest-mismatch'
          entry.error = `content digest ${b.digest.slice(0, 12)}… != file sha256 ${digest.slice(0, 12)}…`
          residues.push({ kind: 'external-blob', ref: b.digest, reason: entry.error })
        } else {
          atomicWriteBytes(join(setDir, entry.path), bytes)
          entry.status = 'captured'
        }
      } catch (e) {
        entry.error = e instanceof Error ? e.message : String(e)
        residues.push({ kind: 'external-blob', ref: b.digest, reason: entry.error })
      }
      // pinned regardless of capture state — a missing/mismatched blob is
      // exactly what a restore must be able to investigate
      pinRefs.push({ targetKind: 'content_blob', targetId: b.digest })
    }

    // 4. artifact inventory — refs are recorded verbatim; resolvable local
    //    file refs are copied and digest-verified.
    const artifacts: BackupManifest['artifacts'] = []
    for (const a of inventoryArtifacts(db)) {
      const entry: BackupManifest['artifacts'][number] = {
        artifactId: a.id,
        revision: a.revision,
        digest: a.digest,
        storageRef: safeJson(a.storage_ref_json),
        status: 'ref-recorded'
      }
      artifacts.push(entry)
      const local = localRefPath(entry.storageRef)
      if (local) {
        try {
          const src = isAbsolute(local) ? local : join(deps.externalBlobDir ?? '', local)
          if (!existsSync(src)) throw new Error(`artifact file not found: ${src}`)
          const bytes = readFileBytes(src)
          entry.path = `artifacts/${a.id}-${a.revision}`
          entry.sha256 = sha256File(bytes)
          if (a.digest && entry.sha256 !== a.digest) {
            entry.status = 'digest-mismatch'
            entry.error = `artifact digest ${a.digest.slice(0, 12)}… != file sha256 ${entry.sha256.slice(0, 12)}…`
            residues.push({ kind: 'artifact', ref: a.id, reason: entry.error })
          } else {
            atomicWriteBytes(join(setDir, entry.path), bytes)
            entry.status = 'captured'
          }
        } catch (e) {
          entry.error = e instanceof Error ? e.message : String(e)
          entry.status = 'missing'
          residues.push({ kind: 'artifact', ref: a.id, reason: entry.error })
        }
      }
      pinRefs.push({ targetKind: 'artifact', targetId: a.id })
    }

    // 5. manifest — digest over the canonical form without the digest field
    const manifest: BackupManifest = {
      kind: 'mahas-control-backup',
      formatVersion: 1,
      backupSetId,
      schemaVersion: readSchemaVersion(db),
      capturedAt,
      consistencyPoint,
      control: controlEntry,
      hosts,
      content,
      artifacts,
      retentionPolicy: payload.retentionPolicy ?? null,
      residues
    }
    const manifestDigest = deps.sha256Hex(canonicalJson(manifest))
    const manifestText = canonicalJson({ ...manifest, manifestDigest })
    atomicWriteBytes(join(setDir, 'manifest.json'), manifestText)

    // 6. retention pins + backup_sets row + domain event (caller's tx)
    const contentPins = pinBackupContents(db, deps, backupSetId, pinRefs)
    const state: BackupSetState = residues.length === 0 ? 'complete' : 'incomplete'
    insertBackupSetRow(db, {
      id: backupSetId,
      state,
      consistencyPoint,
      manifestDigest,
      manifestJson: manifestText
    })
    deps.appendDomainEvent(
      db,
      backupSetId,
      1,
      'backup.created',
      { scope: 'operations' },
      {
        manifestDigest,
        state,
        residueCount: residues.length
      }
    )

    return {
      backupSet: {
        id: backupSetId,
        controlDbSnapshot: controlEntry,
        hostSnapshot: hosts.filter((h) => h.status === 'captured'),
        contentPins,
        consistencyPoint,
        manifestDigest
      } as unknown as BackupSet,
      id: backupSetId,
      state,
      dir: setDir,
      manifestDigest,
      consistencyPoint,
      contentPins,
      residues
    }
  } catch (e) {
    // partial copy → honest failure: leave a FAILED marker in the set dir
    // (survives even a rolled-back tx) and record a failed row when possible.
    try {
      mkdirSync(setDir, { recursive: true })
      writeFileSync(
        join(setDir, 'FAILED'),
        `${nowMs(deps)} ${isMahasError(e) ? e.code : 'ERROR'}: ${e instanceof Error ? e.message : String(e)}\n`
      )
    } catch {
      /* even the marker failing must not mask the original error */
    }
    try {
      insertBackupSetRow(db, {
        id: backupSetId,
        state: 'failed',
        consistencyPoint: {
          capturedAt: nowMs(deps),
          method: 'sqlite3_serialize',
          imageDigest: '',
          imageBytes: 0
        },
        manifestDigest: '',
        manifestJson: '{}'
      })
      unpinByHolder(db, 'backup_set', backupSetId)
    } catch {
      /* row may be impossible inside a doomed tx — the FAILED file stands */
    }
    if (isMahasError(e)) throw e
    throw opsError(
      'CONTROL_UNAVAILABLE',
      `backup.create failed: ${e instanceof Error ? e.message : String(e)}`,
      'same-operation',
      {
        backupSetId
      }
    )
  }
}

/** standalone entry (maintenance tooling/tests): wraps the op in one tx */
export function createBackupSetStandalone(
  db: DatabaseSync,
  deps: BackupOpsDeps,
  payload: BackupCreatePayload
): CreateBackupResult {
  return deps.withTx(db, (tx) => createBackupSet(tx, deps, payload))
}

function resolveHostPaths(deps: BackupOpsDeps, scope?: BackupScope): readonly string[] {
  const inc = scope?.includeHosts
  if (inc === false) return []
  if (Array.isArray(inc)) return inc
  return deps.hostDbPaths?.() ?? []
}

interface ContentRow {
  digest: string
  media_type: string
  byte_length: number
  external_ref: string | null
}

function inventoryContent(db: DatabaseSync): ContentRow[] {
  try {
    return db
      .prepare('SELECT digest, media_type, byte_length, external_ref FROM content_blobs')
      .all() as unknown as ContentRow[]
  } catch {
    return []
  }
}

interface ArtifactRow {
  id: string
  revision: number
  digest: string
  storage_ref_json: string
}

function inventoryArtifacts(db: DatabaseSync): ArtifactRow[] {
  try {
    return db
      .prepare('SELECT id, revision, digest, storage_ref_json FROM artifacts')
      .all() as unknown as ArtifactRow[]
  } catch {
    return []
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** pull a local filesystem path out of a storage_ref when one is declared */
function localRefPath(storageRef: unknown): string | undefined {
  if (!storageRef || typeof storageRef !== 'object') return undefined
  const r = storageRef as Record<string, unknown>
  for (const k of ['path', 'externalPath', 'external_ref', 'file']) {
    if (typeof r[k] === 'string' && r[k]) return r[k] as string
  }
  return undefined
}

export function insertBackupSetRow(
  db: DatabaseSync,
  row: {
    id: string
    state: BackupSetState
    consistencyPoint: BackupManifest['consistencyPoint']
    manifestDigest: string
    manifestJson: string
  }
): void {
  db.prepare(
    `INSERT INTO backup_sets(id, state, consistency_point, manifest_digest, manifest_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       state = excluded.state,
       consistency_point = excluded.consistency_point,
       manifest_digest = excluded.manifest_digest,
       manifest_json = excluded.manifest_json`
  ).run(
    row.id,
    row.state,
    JSON.stringify(row.consistencyPoint),
    row.manifestDigest,
    row.manifestJson
  )
}

// ---------------------------------------------------------------------------
// registry wiring — the only exported entrypoint IMP-30 composes
// ---------------------------------------------------------------------------

/**
 * Register the C-RECOVERY operations this task owns.
 *   backup.create  — operator backup 권한 (mutation)
 *   backup.restore — operator offline restore (mutation)
 * The handlers are synchronous by design (snapshot via serialize, fs via
 * sync APIs) so they remain correct whether the registry runs them inside a
 * synchronous write tx or awaits a promise.
 */
export function registerBackupOps(registry: OperationRegistry, deps: BackupOpsDeps): void {
  registry.register(
    { name: 'backup.create', visibility: 'operator', mutation: true },
    (txn: TxnContext, payload: unknown) =>
      createBackupSet(txn.db, deps, parseCreatePayload(payload))
  )
  registry.register(
    { name: 'backup.restore', visibility: 'operator', mutation: true },
    (txn: TxnContext, payload: unknown): RestoreResult =>
      restoreBackupSet(txn.db, deps, parseRestorePayload(payload))
  )
}
