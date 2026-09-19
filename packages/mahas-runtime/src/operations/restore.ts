// operations/restore.ts — backup.restore (C-RECOVERY).
//
// Contract (spec/contracts/recovery-operations.md):
//   input:  {backupSetId, expectedRuntimeStopped, targetPath}
//   output: restore receipt + restored-unconfirmed runtime state
//   pre:    runtime writes stopped · manifest/digest/schema verified
//   effect: DB/content restored; EVERY past execution starts as
//           reconciliation-needed — a restored process identity is
//           UNCONFIRMED and is never re-approved as a writer
//   refusal/unclear: STALE_REVISION, PROCESS_UNVERIFIABLE; restore must not
//                    resurrect past PID authority.
//
// Verification order is deliberate: nothing is written to the target until
// the manifest digest, every listed file digest, snapshot integrity and
// schema compatibility all check out, and the target is proven to have no
// live writer.

import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  atomicWriteBytes,
  canonicalJson,
  existsOrThrow,
  opsError,
  probeNoLiveWriter,
  readFileBytes,
  readJsonFile,
  removeStaleJournalSiblings,
  requireStorageDeps,
  sha256File
} from './support.ts'
import { assertReadableSchema, assertWritableSchema } from './migration.ts'
import type { BackupManifest, BackupOpsDeps } from './backup.ts'

// ---------------------------------------------------------------------------
// payload
// ---------------------------------------------------------------------------

export interface BackupRestorePayload {
  backupSetId: string
  expectedRuntimeStopped: boolean
  targetPath: string
  /** restore host snapshots too (default false — hosts re-register on boot) */
  restoreHosts?: { sourcePath: string; targetPath: string }[] | boolean
  /** directory external blobs are copied back into (default deps.externalBlobDir) */
  blobTargetDir?: string
}

export function parseRestorePayload(payload: unknown): BackupRestorePayload {
  const p = (payload ?? {}) as Record<string, unknown>
  if (typeof p.backupSetId !== 'string' || !p.backupSetId) {
    throw opsError('INPUT_NOT_READY', 'backup.restore requires backupSetId', 'same-operation')
  }
  if (p.expectedRuntimeStopped !== true) {
    throw opsError(
      'INVALID_TRANSITION',
      'backup.restore requires expectedRuntimeStopped: true — the caller must attest ' +
        'the target runtime is offline before its files are touched',
      'none'
    )
  }
  if (typeof p.targetPath !== 'string' || !p.targetPath) {
    throw opsError('INPUT_NOT_READY', 'backup.restore requires targetPath', 'same-operation')
  }
  return {
    backupSetId: p.backupSetId,
    expectedRuntimeStopped: true,
    targetPath: p.targetPath,
    restoreHosts: p.restoreHosts as BackupRestorePayload['restoreHosts'],
    blobTargetDir: typeof p.blobTargetDir === 'string' ? p.blobTargetDir : undefined
  }
}

export interface RestoreResult {
  backupSetId: string
  targetPath: string
  manifestDigest: string
  schemaVersion: number
  unconfirmedExecutions: number
  restoredBlobs: number
  restoredArtifacts: number
  restoredHosts: string[]
  warnings: string[]
  /** every restored execution starts unconfirmed — never auto-writer */
  runtimeState: 'restored-unconfirmed'
}

// ---------------------------------------------------------------------------
// manifest verification
// ---------------------------------------------------------------------------

export function readBackupManifest(setDir: string): BackupManifest {
  const manifestPath = join(setDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw opsError(
      'INPUT_NOT_READY',
      `backup set has no manifest.json: ${setDir}`,
      'same-operation'
    )
  }
  const manifest = readJsonFile(manifestPath) as BackupManifest
  if (manifest.kind !== 'mahas-control-backup' || manifest.formatVersion !== 1) {
    throw opsError(
      'ARTIFACT_MISMATCH',
      `unrecognized backup manifest format in ${manifestPath}`,
      'none'
    )
  }
  // verify manifest self-digest: recompute over the manifest minus the field
  const declared = manifest.manifestDigest
  if (typeof declared !== 'string' || !declared) {
    throw opsError('ARTIFACT_MISMATCH', 'backup manifest lacks manifestDigest', 'none')
  }
  const unsigned = { ...manifest }
  delete unsigned.manifestDigest
  const recomputed = sha256File(new TextEncoder().encode(canonicalJson(unsigned)))
  if (recomputed !== declared) {
    throw opsError(
      'ARTIFACT_MISMATCH',
      'backup manifest digest mismatch — manifest was altered',
      'none',
      {
        declared,
        recomputed
      }
    )
  }
  return manifest
}

/** verify every file the manifest lists exists and matches its sha256 */
function verifyManifestFiles(setDir: string, manifest: BackupManifest): void {
  const check = (rel: string | undefined, sha256: string | undefined, label: string): void => {
    if (!rel || !sha256) return // nothing captured for this entry
    const p = join(setDir, rel)
    if (!existsSync(p)) {
      throw opsError('ARTIFACT_MISMATCH', `backup file missing for ${label}: ${rel}`, 'none')
    }
    const actual = sha256File(readFileBytes(p))
    if (actual !== sha256) {
      throw opsError(
        'ARTIFACT_MISMATCH',
        `backup file digest mismatch for ${label}: ${rel}`,
        'none',
        {
          declared: sha256,
          actual
        }
      )
    }
  }
  check(manifest.control?.path, manifest.control?.sha256, 'control snapshot')
  for (const h of manifest.hosts ?? []) check(h.path, h.sha256, `host snapshot ${h.sourcePath}`)
  for (const c of manifest.content ?? []) check(c.path, c.sha256, `content blob ${c.digest}`)
  for (const a of manifest.artifacts ?? []) check(a.path, a.sha256, `artifact ${a.artifactId}`)
}

/** open the snapshot image read-only and check integrity + schema compat */
function validateSnapshot(setDir: string, manifest: BackupManifest): { schemaVersion: number } {
  const imagePath = join(setDir, manifest.control.path)
  existsOrThrow(imagePath, 'control snapshot')
  let probe: DatabaseSync | null = null
  try {
    probe = new DatabaseSync(imagePath, { readOnly: true })
    const integrity = probe.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
    if (integrity.integrity_check !== 'ok') {
      throw opsError(
        'ARTIFACT_MISMATCH',
        `snapshot integrity_check: ${integrity.integrity_check}`,
        'none'
      )
    }
    const schemaVersion = assertReadableSchema(probe)
    return { schemaVersion }
  } finally {
    try {
      probe?.close()
    } catch {
      /* close failure does not change the verdict */
    }
  }
}

// ---------------------------------------------------------------------------
// backup.restore
// ---------------------------------------------------------------------------

/**
 * Restore a backup set to `targetPath`. Writes happen only after every
 * verification passes. The restored DB is then opened once by this operation
 * (the runtime is offline — restore is the only writer) to mark every
 * previously-live execution `unverifiable` and stamp the restore event, so
 * the next boot's reconciliation starts from explicit evidence instead of
 * resurrecting past PID authority.
 */
export function restoreBackupSet(
  db: DatabaseSync,
  deps: BackupOpsDeps,
  payload: BackupRestorePayload
): RestoreResult {
  requireStorageDeps(deps)
  assertWritableSchema(db)

  const setDir = join(deps.backupRoot, payload.backupSetId)
  const warnings: string[] = []

  // 1. manifest + digest + file verification (nothing written yet)
  const manifest = readBackupManifest(setDir)
  const rowDigest = readRecordedDigest(db, payload.backupSetId)
  if (rowDigest && rowDigest !== manifest.manifestDigest) {
    throw opsError(
      'ARTIFACT_MISMATCH',
      'backup_sets row digest does not match the manifest on disk',
      'none',
      { recorded: rowDigest, manifest: manifest.manifestDigest }
    )
  }
  verifyManifestFiles(setDir, manifest)
  const { schemaVersion } = validateSnapshot(setDir, manifest) // STALE_REVISION gate

  // 2. the target must be provably stopped — attested AND probed
  const targetPath = resolve(payload.targetPath)
  if (deps.controlDbPath && resolve(deps.controlDbPath) === targetPath) {
    throw opsError(
      'INVALID_TRANSITION',
      'restore target is the live control DB path — stop the runtime and restore from an offline tool',
      'none'
    )
  }
  if (deps.isTargetStopped && !deps.isTargetStopped(targetPath)) {
    throw opsError(
      'STOP_UNKNOWN',
      `operator liveness check reports a live writer on ${targetPath}`,
      'reconcile'
    )
  }
  const probe = probeNoLiveWriter(targetPath)
  if (!probe.stopped) {
    throw opsError('STOP_UNKNOWN', `cannot prove target is stopped: ${probe.detail}`, 'reconcile')
  }

  // 3. place the snapshot — stale -wal/-shm/-journal siblings removed first
  //    so a previous WAL database's frames are never replayed into the image
  const removedSiblings = removeStaleJournalSiblings(targetPath)
  if (removedSiblings.length > 0) {
    warnings.push(`removed stale journal siblings: ${removedSiblings.join(', ')}`)
  }
  const image = readFileBytes(join(setDir, manifest.control.path))
  mkdirSync(resolve(targetPath, '..'), { recursive: true })
  atomicWriteBytes(targetPath, image)

  // 4. open the restored db once (offline — restore is the sole writer) and
  //    mark every past execution unconfirmed: liveness 'live'→'unverifiable'.
  //    Nothing here re-approves a writer; resource_claims stay as evidence
  //    for the next boot's reconciliation (spec/storage.md §7, REQ-15/16).
  let unconfirmedExecutions = 0
  const restored = deps.openDb(targetPath)
  try {
    deps.withTx(restored, (tx) => {
      unconfirmedExecutions = markExecutionsUnconfirmed(tx)
      tx.prepare(
        `INSERT INTO schema_meta(key, value) VALUES ('restored_from_backup', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(payload.backupSetId)
      tx.prepare(`UPDATE backup_sets SET state = 'restored' WHERE id = ?`).run(payload.backupSetId)
      deps.appendDomainEvent(
        tx,
        payload.backupSetId,
        2,
        'backup.restored',
        { scope: 'operations' },
        {
          targetPath,
          unconfirmedExecutions,
          removedSiblings
        }
      )
    })
  } finally {
    restored.close()
  }

  // 5. copy captured external content + artifacts back to the blob store,
  //    re-verifying each digest after copy
  const blobTargetDir = payload.blobTargetDir ?? deps.externalBlobDir
  const { restoredBlobs, restoredArtifacts } = restoreContent(
    setDir,
    manifest,
    blobTargetDir,
    warnings
  )

  // 6. host snapshots are restored only on explicit mapping — a host comes
  //    back through its own boot/hello, never silently from a file drop
  const restoredHosts = restoreHosts(setDir, manifest, payload, warnings)

  // 7. record on the live control db (caller's tx) that a restore happened
  deps.appendDomainEvent(
    db,
    payload.backupSetId,
    1,
    'backup.restore-recorded',
    { scope: 'operations' },
    {
      targetPath,
      manifestDigest: manifest.manifestDigest,
      unconfirmedExecutions
    }
  )
  markRestoreOnRegistryRow(db, payload.backupSetId)

  return {
    backupSetId: payload.backupSetId,
    targetPath,
    manifestDigest: manifest.manifestDigest!,
    schemaVersion,
    unconfirmedExecutions,
    restoredBlobs,
    restoredArtifacts,
    restoredHosts,
    warnings,
    runtimeState: 'restored-unconfirmed'
  }
}

/** standalone entry — deps.withTx around the whole op on the registry db */
export function restoreBackupSetStandalone(
  db: DatabaseSync,
  deps: BackupOpsDeps,
  payload: BackupRestorePayload
): RestoreResult {
  return deps.withTx(db, (tx) => restoreBackupSet(tx, deps, payload))
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function readRecordedDigest(db: DatabaseSync, backupSetId: string): string | null {
  try {
    const row = db
      .prepare('SELECT manifest_digest FROM backup_sets WHERE id = ?')
      .get(backupSetId) as { manifest_digest: string } | undefined
    return row?.manifest_digest ?? null
  } catch {
    return null
  }
}

function markRestoreOnRegistryRow(db: DatabaseSync, backupSetId: string): void {
  try {
    db.prepare(`UPDATE backup_sets SET state = 'restored' WHERE id = ?`).run(backupSetId)
  } catch {
    /* registry db without backup_sets — nothing to mark */
  }
}

function markExecutionsUnconfirmed(tx: DatabaseSync): number {
  const now = Date.now()
  let n = 0
  try {
    const res = tx
      .prepare(
        `UPDATE executions
         SET liveness = 'unverifiable',
             state = CASE
               WHEN state IN ('exited', 'abandoned') THEN state
               ELSE 'start_unknown'
             END
         WHERE liveness = 'live' OR state NOT IN ('exited', 'abandoned')`
      )
      .run()
    n = Number(res.changes)
  } catch {
    /* no executions table in this snapshot */
  }
  try {
    tx.prepare(
      `UPDATE execution_credentials
       SET revoked_at = ?, revision = revision + 1
       WHERE revoked_at IS NULL`
    ).run(now)
  } catch {
    /* no credentials table in this snapshot */
  }
  return n
}

function restoreContent(
  setDir: string,
  manifest: BackupManifest,
  blobTargetDir: string | undefined,
  warnings: string[]
): { restoredBlobs: number; restoredArtifacts: number } {
  let restoredBlobs = 0
  let restoredArtifacts = 0
  const copyVerified = (rel: string, declared: string, destName: string): void => {
    const src = join(setDir, rel)
    const bytes = readFileBytes(src)
    if (sha256File(bytes) !== declared) {
      throw opsError('ARTIFACT_MISMATCH', `restored copy digest mismatch: ${rel}`, 'none')
    }
    if (blobTargetDir) {
      atomicWriteBytes(join(blobTargetDir, destName), bytes)
    }
  }
  for (const c of manifest.content ?? []) {
    if (c.status !== 'captured' || !c.path || !c.sha256) continue
    try {
      // F-003: external blob dest must use the writer's shard rule
      // (<digest[0:2]>/<digest>), matching putExternalContentBlob's
      // external_ref — a flat <root>/<digest> write is unreadable by getContentBlob.
      copyVerified(c.path, c.sha256, `${c.digest.slice(0, 2)}/${c.digest}`)
      restoredBlobs++
    } catch (e) {
      warnings.push(
        `blob ${c.digest.slice(0, 12)}… not restored: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }
  for (const a of manifest.artifacts ?? []) {
    if (a.status !== 'captured' || !a.path || !a.sha256) continue
    try {
      copyVerified(a.path, a.sha256, `artifact-${a.artifactId}-${a.revision}`)
      restoredArtifacts++
    } catch (e) {
      warnings.push(
        `artifact ${a.artifactId} not restored: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }
  return { restoredBlobs, restoredArtifacts }
}

function restoreHosts(
  setDir: string,
  manifest: BackupManifest,
  payload: BackupRestorePayload,
  warnings: string[]
): string[] {
  const out: string[] = []
  const spec = payload.restoreHosts
  if (!spec) return out
  for (const h of manifest.hosts ?? []) {
    if (h.status !== 'captured' || !h.path) continue
    const target = Array.isArray(spec)
      ? spec.find((m) => m.sourcePath === h.sourcePath)?.targetPath
      : h.sourcePath
    if (!target) {
      warnings.push(`host snapshot for ${h.sourcePath} has no restore target — skipped`)
      continue
    }
    try {
      const src = join(setDir, h.path)
      if (h.sha256 && sha256File(readFileBytes(src)) !== h.sha256) {
        throw new Error('host snapshot digest mismatch')
      }
      removeStaleJournalSiblings(target)
      mkdirSync(resolve(target, '..'), { recursive: true })
      copyFileSync(src, target)
      out.push(target)
    } catch (e) {
      warnings.push(
        `host snapshot ${h.sourcePath} not restored: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }
  return out
}
