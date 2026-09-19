import type { JsonObject } from '../common.ts'
import type { DispatchId, ExecutionId, ProcessIncarnation } from '../identity.ts'
import type { EpochMillis, ObservationId } from '../ids.ts'
import type { HarnessId } from '../catalog/index.ts'
import type { HarnessInstallationId, MachineId } from '../inventory/index.ts'

export type HarnessSessionId = string
export type SessionHandleId = string
export type SessionAttachmentId = string
export type SessionNamespaceAliasId = string

export interface SessionEvidenceRef {
  observationId?: ObservationId
  sourceId?: string
  sourceRecordKey?: string
  description?: string
  /** raw evidence the collector attached (kept verbatim, never interpreted) */
  data?: JsonObject
}

export interface HarnessSession {
  id: HarnessSessionId
  harnessId: HarnessId
  originMachineId?: MachineId | null
  namespace: string
  nativeSessionKey: string
  parentSessionId?: HarnessSessionId | null
  title?: string | null
  firstObservedAt: EpochMillis
  lastObservedAt: EpochMillis
  metadata: JsonObject
}

export interface SessionNamespaceAlias {
  id: SessionNamespaceAliasId
  sessionId: HarnessSessionId
  namespace: string
  nativeSessionKey: string
  validFrom: EpochMillis
  validUntil?: EpochMillis | null
  evidence: readonly SessionEvidenceRef[]
}

export type SessionResumeSupport = 'supported' | 'unsupported' | 'unknown'

/** A locator is not a liveness or resumability assertion. */
export interface SessionHandle {
  id: SessionHandleId
  sessionId: HarnessSessionId
  installationId?: HarnessInstallationId | null
  nativeId: string
  locator?: JsonObject | null
  resumeSupport: SessionResumeSupport
  observedAt: EpochMillis
  evidence: readonly SessionEvidenceRef[]
}

export interface SessionAttachment {
  id: SessionAttachmentId
  sessionId: HarnessSessionId
  installationId?: HarnessInstallationId | null
  machineId: MachineId
  processIdentity?: ProcessIncarnation | null
  executionId?: ExecutionId | null
  dispatchId?: DispatchId | null
  observedFrom: EpochMillis
  observedUntil?: EpochMillis | null
  evidence: readonly SessionEvidenceRef[]
}

export type SessionEventKind =
  | 'session-start'
  | 'session-end'
  | 'turn-start'
  | 'turn-complete'
  | 'turn-cancelled'
  | 'needs-input'
  | 'idle'
  | 'error'
  | 'other'

/** Typed projection of an Observation; `observationId` is the canonical fact id. */
export interface SessionEvent {
  observationId: ObservationId
  sessionId?: HarnessSessionId | null
  attachmentId?: SessionAttachmentId | null
  kind: SessionEventKind
  nativeKind: string
  nativeTurnId?: string | null
  occurredAt?: EpochMillis | null
  observedAt: EpochMillis
  origin: 'hook' | 'process' | 'log' | 'api' | 'import' | (string & {})
  payload: JsonObject
  evidence: readonly SessionEvidenceRef[]
}

export interface SessionQueryResult {
  items: readonly HarnessSession[]
  asOf: EpochMillis
  nextCursor?: string
}

/**
 * One session with everything the resume/attention consumers need. Child
 * sessions are separate rows: discovering them never synthesizes a Task or an
 * Execution, and a session that belongs to another machine keeps its origin.
 */
export interface SessionDetailResult {
  session: HarnessSession
  handles: readonly SessionHandle[]
  attachments: readonly SessionAttachment[]
  childSessionIds: readonly HarnessSessionId[]
  lastEventAt?: EpochMillis | null
  lastEventKind?: SessionEventKind | null
  asOf: EpochMillis
}

export interface SessionEventQueryResult {
  items: readonly SessionEvent[]
  asOf: EpochMillis
  nextCursor?: string
}

export interface SessionHandleQueryResult {
  items: readonly SessionHandle[]
  asOf: EpochMillis
}
