// mahas-contracts — mail: messages, deliveries, artifacts, outcomes (IMP-02).
//
// spec/domains/messaging-outcomes.md §1–5 + spec/storage.md §3. Storage rows
// are immutable; Delivery status is the authoritative receipt state (the
// inbox cursor is a performance tool only). JSON payload columns drop the
// `_json` suffix (`links_json` → `links`) exactly as access.ts does.

import type {
  ArtifactRef,
  ContentRef,
  ExecutionGeneration,
  Id,
  Revision,
  TaskRevision
} from './common.ts'
import type { EpochMillis } from './ids.ts'
import type { MemberId, TaskId } from './identity.ts'
import type {
  ArtifactId,
  DeliveryId,
  MessageId,
  OutcomeId,
  RunDecisionId,
  RunId,
  SettlementId,
  WakeRequestId
} from './ids.ts'

/* ── Message / Delivery / InboxRead ───────────────────────────────────── */

export type MessageKind =
  'assignment' | 'question' | 'reply' | 'handoff' | 'notice' | 'report' | (string & {})

/** links_json — task/contract refs plus artifact refs attached to the body */
export interface MessageLinks {
  taskId?: TaskId
  taskRevision?: TaskRevision
  contractId?: string
  artifactRefs?: ArtifactRef[]
  [key: string]: unknown
}

/** messages — immutable body; system assignment vs peer message principals */
export interface Message {
  id: MessageId
  runId: RunId
  senderPrincipalId: Id
  senderMemberId?: MemberId | null
  kind: MessageKind
  body: string
  links: MessageLinks | unknown
  createdAt: EpochMillis
}

export type DeliveryStatus = 'outstanding' | 'acknowledged' | 'fenced'

/** handling_json — what an ack declared: processed or durably deferred */
export interface DeliveryHandling {
  kind?: 'completed' | 'durably-deferred' | (string & {})
  followupRef?: string
  note?: string
  [key: string]: unknown
}

/** deliveries — per-recipient outstanding/acknowledged/fenced */
export interface Delivery {
  id: DeliveryId
  messageId: MessageId
  recipientMemberId: MemberId
  consumerGeneration: ExecutionGeneration
  status: DeliveryStatus
  revision: Revision
  ackedAt?: EpochMillis | null
  handling: DeliveryHandling | unknown
}

/** an inbox snapshot — a response value, not a stored source of truth */
export interface InboxRead {
  memberId: MemberId
  executionGeneration: ExecutionGeneration
  batchCursor: string
  deliveryIds: Id[]
}

/* ── WakeRequest ──────────────────────────────────────────────────────── */

export type WakeState =
  'requested' | 'attempting' | 'delivered' | 'unavailable' | 'failed' | (string & {})

export type WakeRoute = 'pty-input' | 'native-resume' | 'unsupported' | (string & {})

/** wake_requests — stored messages and attention delivery are separate */
export interface WakeRequest {
  id: WakeRequestId
  memberId: MemberId
  executionId?: Id | null
  continuationGrantId?: Id | null
  operationKey: string
  state: WakeState
  deliverySet: unknown
  route?: WakeRoute
  receipt?: unknown
}

/* ── Artifact ─────────────────────────────────────────────────────────── */

/**
 * storage_ref_json — either a content-addressed file blob or a Git commit
 * ref whose object existence + retention claim is maintained separately.
 */
export interface ArtifactStorageRef {
  kind?: 'content' | 'commit' | (string & {})
  contentRef?: ContentRef
  commitRef?: { repositoryRoot?: string; commit?: string; path?: string; [key: string]: unknown }
  blobDigest?: string
  externalStorageRef?: string
  [key: string]: unknown
}

/** artifacts — exact revision immutable; never a live dirty workspace path */
export interface Artifact {
  id: ArtifactId
  revision: Revision
  runId: RunId
  producerDispatchId: Id
  outputSlot: string
  digest: string
  mediaType: string
  byteLength: number
  storageRef: ArtifactStorageRef | unknown
  /** aliases the C-MAIL contracts may present alongside storageRef */
  contentRef?: ContentRef
  commitRef?: unknown
  retainedBy?: Id[]
}

/* ── Outcome / OutcomeOutput / Settlement / RunDecision ───────────────── */

export type OutcomeResult = 'succeeded' | 'failed' | 'blocked'

/** assessment_json — criterion-by-criterion explicit judgment, not a score */
export interface CriterionAssessment {
  criterionRef?: { boundaryId?: string; criterionId?: string }
  met?: boolean
  rationale?: string
  [key: string]: unknown
}

/**
 * outcomes — only the current authoritative Dispatch may declare; a new
 * Outcome revision never inherits the old Settlement.
 */
export interface Outcome {
  id: OutcomeId
  revision: Revision
  taskId: TaskId
  taskRevision: TaskRevision
  dispatchId: Id
  result: OutcomeResult
  rationale: string
  assessment: CriterionAssessment[] | unknown
  outputRefs?: ArtifactRef[]
  contractEffects?: unknown
}

/** outcome_outputs — the exact slot→artifact binding a settlement accepts */
export interface OutcomeOutput {
  outcomeId: OutcomeId
  outcomeRevision: Revision
  slot: string
  artifactId: ArtifactId
  artifactRevision: Revision
}

export type SettlementDecision = 'accepted' | 'rejected' | 'changes-requested' | (string & {})

/** settlements — owner-declaration or designated-acceptance, always explicit */
export interface Settlement {
  id: SettlementId
  outcomeId: OutcomeId
  outcomeRevision: Revision
  authorityMemberId: MemberId
  decision: SettlementDecision
  reason: string
  decidedAt: EpochMillis
}

/** run_decisions — the composition verdict, never the automatic sum of tasks */
export interface RunDecision {
  id: RunDecisionId
  runId: RunId
  planRevision: number
  coordinatorMemberId: MemberId
  decision: string
  rationale: string
}
