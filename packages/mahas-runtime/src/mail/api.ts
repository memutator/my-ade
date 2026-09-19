// mahas-runtime/mail — public surface of the coordination/mail boundary.
//
// Contract: spec/contracts/mail-artifacts.md (C-MAIL) — the durable
// mailbox, reply and artifact hand-off API. Domain semantics:
// spec/domains/messaging-outcomes.md §1–3,§5 and spec/storage.md
// (messages / deliveries / wake_requests / artifacts / retention_pins /
// content_blobs / operation_receipts).
//
// This file holds ONLY the injected dependency shape and the operation
// payload/result types so that consumers (IMP-21 outcome/wake, IMP-26
// observation, IMP-12 CLI transport) can code against one import site.
// Runtime values live in the sibling modules; registerMailOps wires them.

import type { DatabaseSync } from 'node:sqlite'
import type {
  ArtifactRef,
  AuthenticatedContext,
  ContentRef,
  Id,
  Revision
} from '../../../mahas-contracts/src/common.ts'
import type { Artifact, Delivery, InboxRead, Message } from '../../../mahas-contracts/src/mail.ts'
import type { TargetRef } from '../access/authorize.ts'

/** I/O the artifact pipeline needs — injectable so tests never touch disk/git. */
export interface MailIo {
  /** raw bytes of a file already resolved inside the producer's checkout */
  readFileBytes(absolutePath: string): Promise<Uint8Array>
  /**
   * Resolve a commit-ish to its canonical 40-hex sha inside a checkout's
   * repository and report the object size — null when the object does not
   * exist or is not a commit. (git rev-parse --verify <commit>^{commit})
   */
  gitResolveCommit(repoPath: string, commit: string): Promise<{ sha: string; bytes: number } | null>
}

/**
 * Kernel APIs injected by the composition root — signatures are the fixed
 * SHARED-APIS contracts (IMP-03 storage/db.ts, IMP-10 access/authorize.ts,
 * IMP-11 makeCaller). Services never import sibling service internals.
 */
export interface MailDeps {
  /** IMP-10 — throws MahasError SCOPE_DENIED/GRANT_REVOKED/UNAUTHENTICATED */
  authorize(ctx: AuthenticatedContext, operation: string, targets: TargetRef[]): void
  /** IMP-03 — content-addressed store, dedup by digest */
  putContentBlob(db: DatabaseSync, bytes: Uint8Array, mediaType: string): ContentRef
  getContentBlob(db: DatabaseSync, digest: string): { bytes: Uint8Array; mediaType: string } | null
  /** IMP-03 — domain_events outbox append inside the caller's transaction */
  appendDomainEvent(
    db: DatabaseSync,
    aggregateId: string,
    aggregateRevision: number,
    eventType: string,
    scope: unknown,
    payload: unknown
  ): void
  sha256Hex(data: string | Uint8Array): string
  /** IMP-11 makeCaller — reserved for cross-domain calls; current ops resolve
   *  scope from the control DB directly and do not require it. */
  caller?: (
    operation: string,
    payload?: unknown,
    expectedRevisions?: Record<string, number>
  ) => Promise<unknown>
  /** clock/id seams — default Date.now / `${prefix}_${crypto.randomUUID()}` */
  now?(): number
  newId?(prefix: string): string
  /** server resource policy for inbox.wait — not a business-meaning cap */
  limits?: {
    /** hard upper bound applied to any requested maxWaitMs (default 60_000) */
    maxWaitMs?: number
    /** ledger re-poll interval while waiting (default 100ms) */
    pollIntervalMs?: number
    /** max batch size for inbox.check/wait (default 200) */
    maxBatch?: number
  }
  /** filesystem/git access for artifact.publish/read — default: real fs+git */
  io?: MailIo
}

// ---------------------------------------------------------------------------
// inbox.check — FIFO outstanding batch; reading is NOT acking (REQ-18)
// ---------------------------------------------------------------------------

export interface InboxCheckPayload {
  cursor?: string
  limit?: number
}

/** one outstanding delivery joined with its immutable message + parsed refs */
export interface InboxItem {
  delivery: Delivery
  message: Message
  /** artifact refs carried on the message (links_json.artifactRefs) */
  artifactRefs: ArtifactRef[]
}

export interface InboxCheckResult {
  /** spec InboxRead snapshot — a response value, not a stored 정본 */
  read: InboxRead
  items: InboxItem[]
  /** opaque cursor = position after the last returned row (rowid-based) */
  cursor: string
}

// ---------------------------------------------------------------------------
// inbox.wait — bounded wait; timeout is an honest empty result, never an error
// ---------------------------------------------------------------------------

export interface InboxWaitPayload {
  cursor?: string
  maxWaitMs: number
  limit?: number
}

export interface InboxWaitResult {
  read: InboxRead
  items: InboxItem[]
  cursor: string
  /** true when the bound elapsed with nothing delivered — NOT a failure */
  timedOut: boolean
  waitedMs: number
}

// ---------------------------------------------------------------------------
// delivery.ack — processing/durable-followup declaration, not a read marker
// ---------------------------------------------------------------------------

export type AckHandling = 'completed' | 'durably-deferred'

export interface DeliveryAckPayload {
  deliveryId: string
  expectedDeliveryRevision: number
  handling: AckHandling
  /** required when handling === 'durably-deferred' (실제 후속 기록) */
  followupRef?: string
}

export interface DeliveryAckResult {
  ackRevision: Revision
}

// ---------------------------------------------------------------------------
// message.send — Message + ALL recipient Deliveries in one transaction
// ---------------------------------------------------------------------------

export interface MessageSendPayload {
  recipientMemberIds: string[]
  body: string
  /** descriptive kind: assignment/question/reply/handoff/notice/report/… */
  kind: string
  taskRef?: string
  contractRefs?: string[]
  artifactRefs?: ArtifactRef[]
}

export interface MessageSendResult {
  messageId: Id
  deliveryIds: Id[]
}

// ---------------------------------------------------------------------------
// message.replyAndAck — reply enqueue + original ack, atomically
// ---------------------------------------------------------------------------

export interface MessageReplyAndAckPayload {
  originalDeliveryId: string
  expectedDeliveryRevision?: number
  replyBody: string
  /** defaults to the original message's sender member */
  recipients?: string[]
  artifactRefs?: ArtifactRef[]
  handling: AckHandling
  /** explicit durable follow-up record; the reply itself qualifies */
  followupRef?: string
}

export interface MessageReplyAndAckResult {
  replyMessageId: Id
  deliveryIds: Id[]
  ackRevision: Revision
}

// ---------------------------------------------------------------------------
// artifact.publish — pin a file snapshot or git commit by digest/revision
// ---------------------------------------------------------------------------

export interface ArtifactPublishPayload {
  dispatchId: string
  outputSlot: string
  source: 'file' | 'git-commit'
  /** checkout containing sourcePath/commit — resolved from held claims when omitted */
  checkoutId?: string
  /** file source: path inside the checkout (repo-relative) or absolute-under-checkout */
  sourcePath?: string
  /** git-commit source: any commit-ish resolvable to a commit object */
  commit?: string
  mediaType: string
  expectedDigest?: string
}

export interface ArtifactPublishResult {
  artifactId: Id
  revision: Revision
  digest: string
  mediaType: string
  byteLength: number
}

// ---------------------------------------------------------------------------
// artifact.read — exact artifact only; live paths are never trusted output
// ---------------------------------------------------------------------------

export interface ArtifactReadRange {
  offset: number
  length?: number
}

export interface ArtifactReadPayload {
  artifactId: string
  revision: number
  expectedDigest: string
  range?: ArtifactReadRange
}

export type ArtifactAvailability = 'bytes' | 'reference' | 'unavailable'

export interface ArtifactReadResult {
  artifact: Artifact
  availability: ArtifactAvailability
  /** populated for content-blob artifacts */
  mediaType?: string
  byteLength?: number
  dataBase64?: string
  range?: { offset: number; length: number }
  /** populated for git-object artifacts — an identity, not a live path */
  gitRef?: { checkoutId: Id; commit: string }
  /** why bytes/reference are unavailable, when they are */
  reason?: string
}
