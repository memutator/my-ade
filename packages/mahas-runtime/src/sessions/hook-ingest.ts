/** The normalized hook channel is a domain input, not a provider parser.
 * Desktop delivery and the daemon reader share this atomic ingestion path. */
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { JsonObject, JsonValue } from '../../../mahas-contracts/src/common.ts'
import type { AgentHookEvent, AgentHookIngestRequest, AgentHookIngestResult } from '../../../mahas-contracts/src/operations/hooks.ts'
import type { HarnessSession, SessionAttachment, SessionEvent, SessionHandle } from '../../../mahas-contracts/src/sessions/index.ts'
import type { CollectionDiagnostic, CollectionSource } from '../../../mahas-contracts/src/metering/index.ts'
import type { OperationRegistry } from '../api/registry.ts'
import { mahasError } from '../api/handler-ports.ts'
import { commitCollectionBatch, getCollectionCursor, type CollectedSessionEvent } from '../observation/collection/commit.ts'
import { withTx } from '../storage/transaction.ts'
import { findHarnessSession, listSessionAttachments } from './store.ts'

const hash = (...parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const eventKinds = new Set<SessionEvent['kind']>(['session-start', 'session-end', 'turn-start', 'turn-complete', 'turn-cancelled', 'needs-input', 'idle', 'error', 'other'])
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function hookCollectionSourceId(machineId: string, path: string): string {
  return `hook-source.${hash(machineId, resolve(path))}`
}

export interface HookCheckpoint {
  generation: string
  position: JsonValue
  expectedRevision: number | null
  diagnostics?: CollectionDiagnostic[]
}

export interface CommitHookRecordsOptions {
  machineId: string
  adapterPack?: { id: string; revision: number }
  harnessResume?: { hasResumeRecipe(harnessId: string): boolean }
  request: AgentHookIngestRequest
  now?: number
  /** Only the daemon reader advances the durable stream position. */
  checkpoint?: HookCheckpoint
}

function validateRequest(value: unknown): AgentHookIngestRequest {
  if (!object(value) || !object(value.source) || value.source.kind !== 'hook-stream' ||
      !object(value.source.locator) || typeof value.source.locator.path !== 'string' || !value.source.locator.path ||
      typeof value.source.sourceKey !== 'string' || typeof value.source.generation !== 'string' ||
      !Array.isArray(value.records) || value.records.length > 512) {
    throw mahasError('MODEL_INVALID', 'invalid bounded hook-stream request', 'none')
  }
  let bytes = 0
  for (const record of value.records) {
    if (!object(record) || typeof record.sourceRecordKey !== 'string' || !record.sourceRecordKey ||
        !Number.isSafeInteger(record.offset) || Number(record.offset) < 0 ||
        typeof record.raw !== 'string' || !object(record.event) ||
        typeof record.event.provider !== 'string' || !record.event.provider || typeof record.event.event !== 'string') {
      throw mahasError('MODEL_INVALID', 'invalid hook-stream record', 'none')
    }
    bytes += Buffer.byteLength(record.raw)
  }
  if (bytes > 2 * 1024 * 1024) throw mahasError('MODEL_INVALID', 'hook-stream batch exceeds byte limit', 'none')
  return value as unknown as AgentHookIngestRequest
}

export function commitHookRecords(db: DatabaseSync, options: CommitHookRecordsOptions): AgentHookIngestResult {
  const request = validateRequest(options.request)
  const now = options.now ?? Date.now()
  const path = resolve(request.source.locator.path)
  const sourceId = hookCollectionSourceId(options.machineId, path)
  return withTx(db, () => {
    const cursor = getCollectionCursor(db, sourceId)
    const generation = options.checkpoint?.generation ?? cursor?.sourceGeneration ?? request.source.generation
    const source: CollectionSource = { id: sourceId, machineId: options.machineId,
      subject: { kind: 'machine', machineId: options.machineId }, locator: { path }, kind: 'hook-stream',
      sourceGeneration: generation, identityEvidence: { format: 'mahas.hook-stream/v2' },
      status: 'active', firstObservedAt: now, lastObservedAt: now }
    const sessions = new Map<string, HarnessSession>()
    const handles: SessionHandle[] = []
    const attachments: SessionAttachment[] = []
    const events: CollectedSessionEvent[] = []
    const diagnostics = [...(options.checkpoint?.diagnostics ?? [])]
    const seen = new Set<string>()
    for (const record of request.records) {
      // Counter-based file generations can restart with the desktop. Contents
      // and byte position provide the same identity to both ingest producers.
      const key = hash(path, record.offset, record.raw)
      if (seen.has(key)) continue
      seen.add(key)
      const present = db.prepare(`SELECT 1 FROM observation_collection_facets
        WHERE source_id=? AND facet='session-event' AND source_record_key=?`).get(sourceId, key)
      if (present) continue
      let event: AgentHookEvent
      try {
        const raw: unknown = JSON.parse(record.raw)
        if (!object(raw) || typeof raw.provider !== 'string' || !raw.provider || typeof raw.event !== 'string') throw new Error('invalid normalized event')
        event = raw as unknown as AgentHookEvent
      } catch {
        diagnostics.push({ code: 'hook.invalid-record', severity: 'error', message: 'Malformed normalized hook event', sourceRecordKey: key })
        continue
      }
      const evidence = [{ sourceId, sourceRecordKey: key }]
      const occurredAt = typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : null
      const at = occurredAt ?? now
      const extra = event as AgentHookEvent & { namespace?: string; machineId?: string; installationId?: string; resumeSupport?: SessionHandle['resumeSupport'] }
      const namespace = extra.namespace || `hook:${sourceId}:${event.provider}`
      const sessionFor = (nativeId: string): HarnessSession => {
        const staged = [...sessions.values()].find((s) => s.harnessId === event.provider && s.namespace === namespace && s.nativeSessionKey === nativeId)
        const existing = staged ?? findHarnessSession(db, event.provider, namespace, nativeId)
        return existing ?? { id: `session.${hash(event.provider, namespace, nativeId)}`, harnessId: event.provider,
          originMachineId: extra.machineId ?? null, namespace, nativeSessionKey: nativeId,
          firstObservedAt: at, lastObservedAt: at, metadata: {} }
      }
      let sessionId: string | null = null
      let attachmentId: string | null = null
      if (event.sessionId) {
        const session = sessionFor(event.sessionId)
        sessionId = session.id
        if (event.parentSessionId && event.parentSessionId !== event.sessionId) {
          const parent = sessionFor(event.parentSessionId)
          sessions.set(parent.id, parent)
          session.parentSessionId = parent.id
        }
        session.firstObservedAt = Math.min(session.firstObservedAt, at)
        session.lastObservedAt = Math.max(session.lastObservedAt, at)
        session.title = event.name ?? session.title
        session.metadata = { ...session.metadata, ...JSON.parse(JSON.stringify(event)), hookSourceId: sourceId }
        sessions.set(session.id, session)
        handles.push({ id: `handle.${hash(sessionId, extra.installationId ?? null, event.sessionId)}`,
          sessionId, nativeId: event.sessionId, installationId: extra.installationId ?? null,
          locator: { kind: 'hook-session', cwd: event.cwd ?? null, paneId: event.paneId ?? null,
            tabId: event.tabId ?? null, mahasSession: event.mahasSession ?? null, sourcePath: path },
          resumeSupport: event.child || event.internalRun ? 'unsupported' : extra.resumeSupport ??
            (options.harnessResume?.hasResumeRecipe(event.provider) ? 'supported' : 'unknown'), observedAt: at, evidence })
        if (event.mahasSession && event.paneId && event.tabId) {
          attachmentId = `attachment.${hash(sessionId, event.mahasSession, event.paneId, event.tabId)}`
          const previous = listSessionAttachments(db, sessionId).find((a) => a.id === attachmentId)
          attachments.push({ id: attachmentId, sessionId, installationId: extra.installationId ?? null,
            machineId: options.machineId, observedFrom: Math.min(previous?.observedFrom ?? at, at),
            observedUntil: event.event === 'session-end' ? Math.max(previous?.observedUntil ?? at, at) : previous?.observedUntil ?? null,
            evidence: [...evidence, { description: JSON.stringify({ mahasSession: event.mahasSession, paneId: event.paneId, tabId: event.tabId }) }] })
        }
      }
      events.push({ sourceRecordKey: key, event: { observationId: `hook-observation.${hash(sourceId, key)}`,
        sessionId, attachmentId, kind: eventKinds.has(event.event as SessionEvent['kind']) ? event.event as SessionEvent['kind'] : 'other',
        nativeKind: event.nativeEvent ?? event.event, occurredAt, observedAt: now, origin: 'hook',
        payload: JSON.parse(JSON.stringify(event)) as JsonObject, evidence } })
    }
    if (events.length || diagnostics.length || options.checkpoint) {
      const batchId = `hook-batch.${randomUUID()}`
      const after = options.checkpoint ? { sourceId, sourceGeneration: generation, collectorRevision: 'mahas.hook-stream/v2',
        position: options.checkpoint.position, checkpointRevision: (options.checkpoint.expectedRevision ?? 0) + 1, lastCommittedAt: now } : null
      commitCollectionBatch(db, { source, batch: { id: batchId, sourceId, sourceGeneration: generation,
        adapterPackId: options.adapterPack?.id ?? 'mahas.normalized-hook-stream', adapterPackRevision: options.adapterPack?.revision ?? 2,
        integrationContractId: 'mahas.integration.events', contractRevision: 1,
        cursorBefore: cursor, cursorAfter: after, startedAt: now, committedAt: now,
        result: diagnostics.length ? 'partial' : 'committed', diagnostics },
        expectedCheckpointRevision: options.checkpoint ? options.checkpoint.expectedRevision : cursor?.checkpointRevision ?? null,
        coverage: [{ id: `coverage.${batchId}`, sourceId, subject: source.subject,
          completeness: diagnostics.length ? 'gap' : 'unknown', gapReason: diagnostics.length ? 'malformed-or-truncated-hook-stream' : null,
          lastSuccessAt: now }], sessions: [...sessions.values()], handles, attachments, sessionEvents: events })
    }
    return { committed: true, recordKeys: request.records.map((record) => record.sourceRecordKey) }
  })
}

export function registerHookIngestOperation(registry: OperationRegistry, machineId: string, adapterPack?: CommitHookRecordsOptions['adapterPack'], harnessResume?: CommitHookRecordsOptions['harnessResume']): void {
  registry.register({ name: 'session.hook.ingest', visibility: 'operator', mutation: true,
    summary: 'commit normalized hook events before attention delivery', inputSchema: { type: 'object' } },
  (txn, payload) => commitHookRecords(txn.db, { machineId, adapterPack, harnessResume, request: validateRequest(payload) }))
}
