/** Desktop legacy import — one-time migration of the renderer's persisted
 * resume records into the session store.
 *
 * A desktop record is *placement only*: it says which tab a native session was
 * last seen in, never that the session is alive, resumable or still the user's.
 * The import therefore
 *
 *   · writes a canonical session row in an explicit `desktop-legacy` namespace
 *     (per machine) — a native id is never merged into another namespace's row,
 *     because the same native id under another installation is a different
 *     session until evidence says otherwise;
 *   · records the exact marker native → canonical (machine + harness + legacy
 *     source) as a namespace alias, so a re-import is idempotent and a reader can
 *     resolve the mapping without guessing;
 *   · stores the old fields (cwd, wsId, paneId, tabId) as session placement
 *     metadata, and an attachment that carries the machine;
 *   · gives the handle `resumeSupport: 'supported'` only when the harness Pack
 *     declares a resume recipe — everything else is `unsupported`;
 *   · refuses to resurrect a session the store already knows to be a child,
 *     internal or external run, and refuses harnesses the Pack does not know.
 *
 * Everything runs in one transaction with stable ids, so a retry of the same
 * batch is a no-op rather than a duplicate. */

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  HarnessSession,
  SessionAttachment,
  SessionHandle,
  SessionNamespaceAlias
} from '../../../mahas-contracts/src/sessions/index.ts'
import type { OperationRegistry } from '../api/registry.ts'
import { mahasError } from '../api/handler-ports.ts'
import { withTx } from '../storage/transaction.ts'
import {
  findHarnessSession,
  putSessionAttachment,
  putSessionHandle,
  putSessionNamespaceAlias,
  upsertHarnessSession
} from './store.ts'

export const DESKTOP_IMPORT_OPERATION = 'session.desktop.import'
/** Explicit namespace: desktop records are their own source, never merged. */
export const DESKTOP_LEGACY_NAMESPACE = 'desktop-legacy'
/** The hook transport's namespace — consulted for child/external evidence. */
export const HOOK_NAMESPACE = 'hook'
export function desktopLegacyNamespace(machineId: string): string {
  return DESKTOP_LEGACY_NAMESPACE + ':' + machineId
}

export interface DesktopImportRecord {
  nativeSessionId: string
  harnessId: string
  cwd?: string
  wsId?: string
  paneId?: string
  tabId?: string
  observedAt?: number
  /** Main-stamped final snapshot, before the app closes its PTYs. */
  shutdown?: { runId: string; at: number }
}

export interface DesktopImportMapping {
  nativeSessionId: string
  harnessId: string
  /** canonical session id the caller must use from now on */
  sessionId: string
  handleId: string
  resumeSupport: 'supported' | 'unsupported'
  placement: { cwd?: string; wsId?: string; paneId?: string; tabId?: string }
  /** true when this batch created the rows (false = replayed) */
  created: boolean
}

export interface DesktopImportDiagnostic {
  code:
    | 'desktop-import.unknown-harness'
    | 'desktop-import.invalid-record'
    | 'desktop-import.known-child-or-external'
  message: string
  nativeSessionId?: string
}

export interface DesktopImportResult {
  committed: true
  imported: number
  replayed: number
  skipped: number
  mappings: DesktopImportMapping[]
  diagnostics: DesktopImportDiagnostic[]
}

export interface DesktopImportOptions {
  machineId: string
  /**
   * Pack-declared resume recipes. Only a harness listed here can receive a
   * `supported` handle; without the map every harness is unknown and skipped —
   * an invented installation is worse than an unimported record.
   */
  harnessResume?: { hasResumeRecipe(harnessId: string): boolean }
  now?: number
}

const MAX_RECORDS = 512

function sha(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function stableId(prefix: string, ...parts: unknown[]): string {
  return prefix + '.' + sha(parts).slice(0, 32)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateRequest(value: unknown): DesktopImportRecord[] {
  if (!object(value) || !Array.isArray(value.records) || value.records.length > MAX_RECORDS) {
    throw mahasError('MODEL_INVALID', 'invalid bounded desktop import request', 'none')
  }
  return value.records as DesktopImportRecord[]
}

function placementOf(record: DesktopImportRecord): DesktopImportMapping['placement'] {
  return {
    ...(record.cwd ? { cwd: record.cwd } : {}),
    ...(record.wsId ? { wsId: record.wsId } : {}),
    ...(record.paneId ? { paneId: record.paneId } : {}),
    ...(record.tabId ? { tabId: record.tabId } : {})
  }
}

/** A session the store already knows to be a child/internal/external run. */
function knownNonResumable(
  db: DatabaseSync,
  record: DesktopImportRecord,
  machineId: string
): boolean {
  // This is an exclusion, never an identity merge. Restrict the evidence to
  // this machine; native ids belonging to another machine cannot veto import.
  const candidates = db
    .prepare(
      `SELECT metadata_json FROM harness_sessions s
    WHERE harness_id=? AND native_session_key=? AND (origin_machine_id=? OR EXISTS
      (SELECT 1 FROM session_attachments a WHERE a.session_id=s.id AND a.machine_id=?))`
    )
    .all(record.harnessId, record.nativeSessionId, machineId, machineId)
  return candidates.some((row) => {
    const meta = JSON.parse(String(row.metadata_json)) as Record<string, unknown>
    if (
      meta.child === true ||
      meta.internalRun === true ||
      meta.externalRun === true ||
      meta.external === true
    )
      return true
    if (meta.ended !== true && meta.event !== 'session-end') return false
    // A session-end emitted as this app closes its own PTYs remains historical
    // fact. Only an exact main-stamped shutdown checkpoint can retain its
    // resume candidate; an earlier end or another run/tab cannot be revived.
    const shutdown = record.shutdown
    const endedAt = typeof meta.ts === 'number' ? meta.ts : NaN
    return !(
      shutdown &&
      typeof shutdown.runId === 'string' &&
      shutdown.runId.length > 0 &&
      Number.isFinite(shutdown.at) &&
      endedAt >= shutdown.at &&
      endedAt <= shutdown.at + 30_000 &&
      meta.mahasSession === shutdown.runId &&
      record.paneId &&
      record.tabId &&
      meta.paneId === record.paneId &&
      meta.tabId === record.tabId
    )
  })
}

export function importDesktopSessions(
  db: DatabaseSync,
  request: unknown,
  options: DesktopImportOptions
): DesktopImportResult {
  const records = validateRequest(request)
  const now = options.now ?? Date.now()
  const namespace = desktopLegacyNamespace(options.machineId)
  const diagnostics: DesktopImportDiagnostic[] = []
  const mappings: DesktopImportMapping[] = []
  let skipped = 0
  let replayed = 0

  const seen = new Set<string>()
  withTx(db, () => {
    for (const raw of records) {
      const record = object(raw) ? (raw as unknown as DesktopImportRecord) : null
      const nativeSessionId =
        record && typeof record.nativeSessionId === 'string' ? record.nativeSessionId.trim() : ''
      const harnessId =
        record && typeof record.harnessId === 'string' ? record.harnessId.trim() : ''
      if (!nativeSessionId || !harnessId) {
        skipped++
        diagnostics.push({
          code: 'desktop-import.invalid-record',
          message: 'a desktop record needs a nativeSessionId and a harnessId'
        })
        continue
      }
      const key = harnessId + '\u0000' + nativeSessionId
      if (seen.has(key)) continue
      seen.add(key)

      if (!options.harnessResume?.hasResumeRecipe(harnessId)) {
        // unknown harness: the Pack does not declare it, so there is no
        // installation, no namespace and no resume route to record
        skipped++
        diagnostics.push({
          code: 'desktop-import.unknown-harness',
          message: 'the harness Pack declares no entry for ' + harnessId,
          nativeSessionId
        })
        continue
      }
      if (knownNonResumable(db, { ...record!, harnessId, nativeSessionId }, options.machineId)) {
        skipped++
        diagnostics.push({
          code: 'desktop-import.known-child-or-external',
          message: 'the store already knows this run is a child/internal/external session',
          nativeSessionId
        })
        continue
      }

      const observedAt = Number.isFinite(record?.observedAt) ? Number(record!.observedAt) : now
      const placement = placementOf(record!)
      const sessionId = stableId('session', harnessId, namespace, nativeSessionId)
      const existing = findHarnessSession(db, harnessId, namespace, nativeSessionId)
      const created = !existing || existing.id !== sessionId ? true : false

      const session: HarnessSession = {
        id: sessionId,
        harnessId,
        originMachineId: options.machineId,
        namespace,
        nativeSessionKey: nativeSessionId,
        parentSessionId: null,
        title: null,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        metadata: {
          legacy: {
            source: DESKTOP_LEGACY_NAMESPACE,
            machineId: options.machineId,
            importedAt: now
          },
          /** exact marker: this native id, this harness, this machine */
          legacyNativeId: nativeSessionId,
          placementOnly: true,
          ...(record?.shutdown
            ? { shutdown: { runId: record.shutdown.runId, at: record.shutdown.at } }
            : {}),
          ...(Object.keys(placement).length ? { placement } : {})
        }
      }
      upsertHarnessSession(db, session)

      const evidence = [
        {
          sourceRecordKey: namespace + ':' + nativeSessionId,
          description: 'desktop legacy resume record (placement only)'
        }
      ]
      const alias: SessionNamespaceAlias = {
        id: stableId('alias', harnessId, namespace, nativeSessionId),
        sessionId,
        namespace,
        nativeSessionKey: nativeSessionId,
        validFrom: observedAt,
        validUntil: null,
        evidence
      }
      putSessionNamespaceAlias(db, alias)

      const resumeSupport: SessionHandle['resumeSupport'] = 'supported'
      const handle: SessionHandle = {
        id: stableId('handle', sessionId, DESKTOP_LEGACY_NAMESPACE),
        sessionId,
        installationId: null,
        nativeId: nativeSessionId,
        locator: {
          namespace,
          machineId: options.machineId,
          placementOnly: true,
          ...(Object.keys(placement).length ? { placement } : {})
        },
        resumeSupport,
        observedAt,
        evidence
      }
      putSessionHandle(db, handle)

      const attachment: SessionAttachment = {
        id: stableId('attachment', sessionId, DESKTOP_LEGACY_NAMESPACE),
        sessionId,
        installationId: null,
        machineId: options.machineId,
        processIdentity: null,
        executionId: null,
        dispatchId: null,
        observedFrom: observedAt,
        observedUntil: null,
        evidence
      }
      putSessionAttachment(db, attachment)

      if (!created) replayed++
      mappings.push({
        nativeSessionId,
        harnessId,
        sessionId,
        handleId: handle.id,
        resumeSupport: 'supported',
        placement,
        created
      })
    }
  })

  return {
    committed: true,
    imported: mappings.filter((mapping) => mapping.created).length,
    replayed,
    skipped,
    mappings,
    diagnostics
  }
}

/**
 * Register the import operation. Composition supplies the machine id and the
 * Pack's resume-support map (packages/mahas-harness-config →
 * `harnessResumeSupport`); this module touches only the session tables, so it
 * needs no runtime ports.
 */
export function registerDesktopImportOperation(
  registry: OperationRegistry,
  options: DesktopImportOptions
): void {
  registry.register(
    {
      name: DESKTOP_IMPORT_OPERATION,
      visibility: 'operator',
      mutation: true,
      summary: 'import the desktop resume map as placement-only session records',
      inputSchema: { type: 'object' }
    },
    (txn, payload) => importDesktopSessions(txn.db, payload, options)
  )
}
