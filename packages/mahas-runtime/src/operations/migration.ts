// operations/migration.ts — schema compatibility gate, explicit migrations,
// and one-shot legacy imports, all witnessed by MigrationReceipt rows.
//
// spec/storage.md §5: "오래된 schema의 바이너리는 write 금지" — a binary
// built for an older schema must never silently write into a newer one.
// assertWritableSchema() is that gate; every mutation entrypoint in this
// boundary calls it first.
//
// spec/domains/resources-observation.md §3: MigrationReceipt
//   {id, fromSchema/toSchema, stage, fingerprint, backupRef, outcome}
// → migration_receipts DDL: (id PK, from_version, to_version, state,
//   payload_json). `state` carries stage/outcome; payload_json carries the
//   stage trail, input fingerprint, backupRef and outcome detail.
//
// Legacy import is an explicit, idempotent operation: bytes are fingerprinted,
// mapped rows are inserted once, and the original payload is preserved as a
// ContentBlob. records.json is never connected as a second writer
// (spec/storage.md §1, REQ-02) — import copies; it does not link.

import type { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import type { MigrationReceipt } from '../../../mahas-contracts/src/observation.ts'
import { genId, nowMs, opsError, requireStorageDeps, type StorageOpsDeps } from './support.ts'
import { CONTROL_SCHEMA_VERSION } from '../storage/migrations.ts'

// ---------------------------------------------------------------------------
// Schema version gate
// ---------------------------------------------------------------------------

/** Same version gate as the database opener; never maintain a second version. */
export { CONTROL_SCHEMA_VERSION }
/** lowest schema this binary can still read */
export const MIN_SUPPORTED_SCHEMA_VERSION = 1

export const SCHEMA_META_KEYS = {
  schemaVersion: 'schema_version',
  minSupported: 'schema_min_supported'
} as const

/** null when the schema_meta row is absent (uninitialized/partial db) */
export function readSchemaVersion(db: DatabaseSync): number | null {
  try {
    const row = db
      .prepare('SELECT value FROM schema_meta WHERE key = ?')
      .get(SCHEMA_META_KEYS.schemaVersion) as { value: string } | undefined
    if (!row) return null
    const v = Number(row.value)
    return Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/**
 * The write gate. Throws unless this binary is allowed to write the db:
 *  - version newer than CONTROL_SCHEMA_VERSION → an old-schema binary must
 *    not write into a newer database (downgrade write protection)
 *  - version older than the supported floor or absent → the schema is not
 *    initialized; only migrations/restore may touch it
 */
export function assertWritableSchema(db: DatabaseSync): void {
  const v = readSchemaVersion(db)
  if (v === null) {
    throw opsError(
      'INVALID_TRANSITION',
      'schema_meta.schema_version is absent — the database is not initialized; ' +
        'only an explicit migration or restore may write it',
      'none'
    )
  }
  if (v > CONTROL_SCHEMA_VERSION) {
    throw opsError(
      'INVALID_TRANSITION',
      `database schema v${v} is newer than this binary's writable v${CONTROL_SCHEMA_VERSION} — ` +
        'an old-schema binary must not write (spec/storage.md §5)',
      'none',
      { schemaVersion: v, binaryVersion: CONTROL_SCHEMA_VERSION }
    )
  }
  if (v < MIN_SUPPORTED_SCHEMA_VERSION) {
    throw opsError(
      'INVALID_TRANSITION',
      `database schema v${v} is below the supported floor v${MIN_SUPPORTED_SCHEMA_VERSION} — ` +
        'run explicit migrations first',
      'reconcile',
      { schemaVersion: v }
    )
  }
}

/** read-side gate used by restore validation (never blocks on equal/older) */
export function assertReadableSchema(db: DatabaseSync): number {
  const v = readSchemaVersion(db)
  if (v === null) {
    throw opsError('INVALID_TRANSITION', 'restored image has no schema_meta.schema_version', 'none')
  }
  if (v > CONTROL_SCHEMA_VERSION) {
    throw opsError(
      'STALE_REVISION',
      `backup schema v${v} exceeds this binary's supported v${CONTROL_SCHEMA_VERSION}`,
      'none',
      { schemaVersion: v, binaryVersion: CONTROL_SCHEMA_VERSION }
    )
  }
  return v
}

// ---------------------------------------------------------------------------
// MigrationReceipt helpers
// ---------------------------------------------------------------------------

export interface MigrationReceiptPayload {
  kind: 'schema-migration' | 'legacy-import'
  stage: string
  stages: { stage: string; at: number; detail?: string }[]
  fingerprint: string
  backupRef?: string
  outcome?: unknown
  startedAt: number
  completedAt?: number
}

export function insertMigrationReceipt(
  db: DatabaseSync,
  receipt: { id: string; fromVersion: number; toVersion: number; state: string },
  payload: MigrationReceiptPayload
): void {
  db.prepare(
    `INSERT INTO migration_receipts(id, from_version, to_version, state, payload_json)
     VALUES (?, ?, ?, ?, ?)`
  ).run(receipt.id, receipt.fromVersion, receipt.toVersion, receipt.state, JSON.stringify(payload))
}

export function updateMigrationReceipt(
  db: DatabaseSync,
  id: string,
  state: string,
  patch: Partial<MigrationReceiptPayload>
): void {
  const row = db.prepare('SELECT payload_json FROM migration_receipts WHERE id = ?').get(id) as
    { payload_json: string } | undefined
  const payload = row
    ? ({ ...JSON.parse(row.payload_json), ...patch } as MigrationReceiptPayload)
    : ({
        kind: 'schema-migration',
        stage: 'unknown',
        stages: [],
        fingerprint: '',
        startedAt: 0,
        ...patch
      } as MigrationReceiptPayload)
  db.prepare('UPDATE migration_receipts SET state = ?, payload_json = ? WHERE id = ?').run(
    state,
    JSON.stringify(payload),
    id
  )
}

export function listMigrationReceipts(db: DatabaseSync): MigrationReceipt[] {
  const rows = db.prepare('SELECT * FROM migration_receipts ORDER BY rowid').all() as Record<
    string,
    unknown
  >[]
  return rows.map((r) => ({
    id: r.id,
    fromSchema: r.from_version,
    toSchema: r.to_version,
    stage: (JSON.parse(r.payload_json as string) as MigrationReceiptPayload).stage,
    fingerprint: (JSON.parse(r.payload_json as string) as MigrationReceiptPayload).fingerprint,
    backupRef: (JSON.parse(r.payload_json as string) as MigrationReceiptPayload).backupRef,
    outcome: (JSON.parse(r.payload_json as string) as MigrationReceiptPayload).outcome,
    state: r.state
  })) as unknown as MigrationReceipt[]
}

// ---------------------------------------------------------------------------
// Explicit schema migrations
// ---------------------------------------------------------------------------

export interface MigrationStep {
  /** version this step produces when applied */
  toVersion: number
  stage: string
  apply(db: DatabaseSync): void
}

export interface MigrationRunReport {
  fromVersion: number
  toVersion: number
  receipts: { id: string; fromVersion: number; toVersion: number; state: string }[]
}

/**
 * Apply pending steps in order, each in its own write tx, each witnessed by a
 * MigrationReceipt recording stage trail + input fingerprint + optional
 * backupRef. A step failure leaves state='failed' so the next run resumes
 * honestly instead of skipping ahead.
 */
export function runMigrations(
  db: DatabaseSync,
  deps: StorageOpsDeps,
  steps: MigrationStep[],
  opts: { backupBefore?: (db: DatabaseSync) => string | undefined } = {}
): MigrationRunReport {
  requireStorageDeps(deps)
  const startedAt = nowMs(deps)
  let current = readSchemaVersion(db)
  const receipts: MigrationRunReport['receipts'] = []

  for (const step of steps) {
    const from = current ?? 0
    if (step.toVersion <= from) continue
    const id = genId(deps, 'mig')
    const fingerprint = deps.sha256Hex(`${from}->${step.toVersion}:${step.stage}:${startedAt}`)
    const backupRef = opts.backupBefore?.(db)
    const payload: MigrationReceiptPayload = {
      kind: 'schema-migration',
      stage: 'started',
      stages: [{ stage: 'started', at: nowMs(deps) }],
      fingerprint,
      backupRef,
      startedAt
    }
    deps.withTx(db, (tx) => {
      insertMigrationReceipt(
        tx,
        { id, fromVersion: from, toVersion: step.toVersion, state: 'started' },
        payload
      )
    })
    try {
      deps.withTx(db, (tx) => {
        step.apply(tx)
        tx.prepare(
          `INSERT INTO schema_meta(key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).run(SCHEMA_META_KEYS.schemaVersion, String(step.toVersion))
        updateMigrationReceipt(tx, id, 'applied', {
          stage: 'complete',
          stages: [...payload.stages, { stage: 'applied', at: nowMs(deps) }],
          completedAt: nowMs(deps),
          outcome: { applied: true }
        })
      })
      receipts.push({ id, fromVersion: from, toVersion: step.toVersion, state: 'applied' })
      current = step.toVersion
    } catch (e) {
      try {
        deps.withTx(db, (tx) => {
          updateMigrationReceipt(tx, id, 'failed', {
            stage: 'failed',
            stages: [...payload.stages, { stage: 'failed', at: nowMs(deps) }],
            completedAt: nowMs(deps),
            outcome: { applied: false, error: e instanceof Error ? e.message : String(e) }
          })
        })
      } catch {
        /* the failed receipt itself must not mask the step error */
      }
      throw e
    }
  }
  return { fromVersion: readSchemaVersion(db) ?? 0, toVersion: current ?? 0, receipts }
}

// ---------------------------------------------------------------------------
// Legacy import — one-shot, fingerprinted, receipted
// ---------------------------------------------------------------------------

export type LegacySourceKind = 'records-json' | 'observation-registry' | 'generic-json'

export interface LegacyImportInput {
  sourceKind: LegacySourceKind
  /** bytes take precedence; sourcePath is read once (never linked/watched) */
  bytes?: Uint8Array | string
  sourcePath?: string
  /** optional current model/role/interface snapshot to store alongside */
  snapshot?: unknown
}

export interface LegacyImportResult {
  receiptId: string
  alreadyApplied: boolean
  fingerprint: string
  imported: { projects: number; observations: number; snapshots: number }
  skipped: { projects: number; observations: number }
  preservedBlobDigest?: string
}

interface LegacyProjectRow {
  id?: unknown
  name?: unknown
  path?: unknown
  repository_root?: unknown
  repositoryRoot?: unknown
  goal?: unknown
}

function parseJsonBytes(bytes: Uint8Array | string): unknown {
  return JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes))
}

/**
 * Import a legacy records.json / observation registry into the control DB.
 * Idempotent on the input fingerprint: an identical input returns the
 * original receipt instead of duplicating rows. The source file is read
 * once — never registered as a second writer (REQ-02).
 */
export function importLegacyRecords(
  db: DatabaseSync,
  deps: StorageOpsDeps,
  input: LegacyImportInput
): LegacyImportResult {
  requireStorageDeps(deps)
  const bytes =
    input.bytes ??
    (input.sourcePath && existsSync(input.sourcePath)
      ? new Uint8Array(readFileSync(input.sourcePath))
      : undefined)
  if (!bytes) {
    throw opsError(
      'INPUT_NOT_READY',
      'legacy import requires bytes or a readable sourcePath',
      'same-operation'
    )
  }
  const fingerprint = deps.sha256Hex(bytes)

  // fingerprint idempotency — a completed import of these exact bytes is
  // returned, not re-applied
  const prior = db
    .prepare(`SELECT id, state, payload_json FROM migration_receipts WHERE state = 'applied'`)
    .all() as { id: string; state: string; payload_json: string }[]
  for (const r of prior) {
    try {
      const p = JSON.parse(r.payload_json) as MigrationReceiptPayload
      if (p.kind === 'legacy-import' && p.fingerprint === fingerprint) {
        const o = (p.outcome ?? {}) as Partial<LegacyImportResult>
        return {
          receiptId: r.id,
          alreadyApplied: true,
          fingerprint,
          imported: o.imported ?? { projects: 0, observations: 0, snapshots: 0 },
          skipped: o.skipped ?? { projects: 0, observations: 0 },
          preservedBlobDigest: o.preservedBlobDigest
        }
      }
    } catch {
      /* unreadable payload — keep scanning */
    }
  }

  const receiptId = genId(deps, 'mig')
  const startedAt = nowMs(deps)
  const stages: MigrationReceiptPayload['stages'] = [{ stage: 'read', at: startedAt }]

  const finish = (state: 'applied' | 'failed', outcome: unknown): void => {
    stages.push({ stage: state === 'applied' ? 'complete' : 'failed', at: nowMs(deps) })
    deps.withTx(db, (tx) => {
      insertMigrationReceipt(
        tx,
        { id: receiptId, fromVersion: 0, toVersion: CONTROL_SCHEMA_VERSION, state },
        {
          kind: 'legacy-import',
          stage: state === 'applied' ? 'complete' : 'failed',
          stages,
          fingerprint,
          outcome,
          startedAt,
          completedAt: nowMs(deps)
        }
      )
    })
  }

  let parsed: unknown
  try {
    parsed = parseJsonBytes(bytes)
    stages.push({ stage: 'validate', at: nowMs(deps) })
  } catch (e) {
    finish('failed', { error: `source is not JSON: ${e instanceof Error ? e.message : String(e)}` })
    throw opsError('INPUT_NOT_READY', 'legacy source is not valid JSON', 'same-operation')
  }

  try {
    const result = deps.withTx(db, (tx) => {
      const imported = { projects: 0, observations: 0, snapshots: 0 }
      const skipped = { projects: 0, observations: 0 }
      let preservedBlobDigest: string | undefined

      // preserve the raw source as an immutable blob — import evidence,
      // not a second authored copy
      if (deps.putContentBlob) {
        const blobBytes = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
        preservedBlobDigest = deps.putContentBlob(tx, blobBytes, 'application/json').digest
      }

      const root = parsed as Record<string, unknown>
      const projects = Array.isArray(root?.projects)
        ? (root.projects as LegacyProjectRow[])
        : Array.isArray(parsed)
          ? (parsed as LegacyProjectRow[])
          : []
      for (const p of projects) {
        const id = typeof p.id === 'string' ? p.id : undefined
        const name = typeof p.name === 'string' ? p.name : id
        const root2 = typeof p.repository_root === 'string' ? p.repository_root : p.repositoryRoot
        const repoRoot =
          typeof root2 === 'string' ? root2 : typeof p.path === 'string' ? p.path : undefined
        if (!id || !name || !repoRoot) {
          skipped.projects++
          continue
        }
        const res = tx
          .prepare(
            `INSERT OR IGNORE INTO projects(id, name, goal, repository_root, revision)
             VALUES (?, ?, ?, ?, 1)`
          )
          .run(id, name, typeof p.goal === 'string' ? p.goal : '', repoRoot)
        if (Number(res.changes) > 0) imported.projects++
        else skipped.projects++
      }

      const observations = Array.isArray(root?.observations)
        ? (root.observations as Record<string, unknown>[])
        : []
      for (const [i, o] of observations.entries()) {
        const id =
          typeof o.id === 'string'
            ? o.id
            : `legacy-obs-${deps.sha256Hex(fingerprint + i).slice(0, 24)}`
        const source = typeof o.source === 'string' ? o.source : 'legacy-import'
        const factType =
          typeof o.fact_type === 'string'
            ? o.fact_type
            : typeof o.factType === 'string'
              ? o.factType
              : 'legacy-record'
        const observedAt =
          typeof o.observed_at === 'number'
            ? o.observed_at
            : typeof o.observedAt === 'number'
              ? o.observedAt
              : startedAt
        try {
          const res = tx
            .prepare(
              `INSERT OR IGNORE INTO observations(id, execution_id, dispatch_id, source, fact_type, observed_at, payload_json, identity_evidence_json)
               VALUES (?, NULL, NULL, ?, ?, ?, ?, '{}')`
            )
            .run(id, source, factType, observedAt, JSON.stringify(o.payload ?? o))
          if (Number(res.changes) > 0) imported.observations++
          else skipped.observations++
        } catch {
          skipped.observations++
        }
      }

      if (input.snapshot !== undefined && deps.putContentBlob) {
        deps.putContentBlob(
          tx,
          new TextEncoder().encode(JSON.stringify(input.snapshot)),
          'application/json'
        )
        imported.snapshots++
      }
      stages.push({ stage: 'import', at: nowMs(deps) })
      return { imported, skipped, preservedBlobDigest }
    })

    finish('applied', { ...result, sourceKind: input.sourceKind, sourcePath: input.sourcePath })
    return {
      receiptId,
      alreadyApplied: false,
      fingerprint,
      imported: result.imported,
      skipped: result.skipped,
      preservedBlobDigest: result.preservedBlobDigest
    }
  } catch (e) {
    finish('failed', { error: e instanceof Error ? e.message : String(e) })
    throw e
  }
}
