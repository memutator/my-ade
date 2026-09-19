// mahas-contracts — resources: checkouts, workspaces, claims, leases
// (IMP-02).
//
// spec/domains/resources-observation.md §1 + spec/storage.md §3. Identity is
// canonical-path + filesystem birth evidence (+ worktree identity) — never a
// project name or workspace id. One writer per resource is a DB-level
// invariant, not a convention.

import type { ContentRef, ExecutionGeneration, Id, Revision } from './common.ts'
import type { EpochMillis } from './ids.ts'
import type {
  ArtifactId,
  CheckoutId,
  PrincipalId,
  ResourceClaimId,
  ResourceId,
  ResourceTransferId,
  RetentionPinId,
  WorkspaceId
} from './ids.ts'
import type { ProcessIncarnation, TerminalId } from './identity.ts'

/* ── Resource / Checkout / Workspace ──────────────────────────────────── */

export type ResourceKind = 'checkout' | 'terminal' | 'package' | 'artifact' | (string & {})

/** resources — the claimable identity behind a checkout/terminal/package */
export interface Resource {
  id: ResourceId
  kind: ResourceKind
  hostId?: Id | null
  identity: unknown
}

export type CheckoutState = 'active' | 'released' | 'unknown' | (string & {})

export interface RepositoryIdentity {
  repositoryRoot?: string
  repositoryIdentity?: string
  worktreeIdentity?: string
  [key: string]: unknown
}

/** checkouts — actual directory identity; unique host+canonical path+birth */
export interface Checkout {
  id: CheckoutId
  resourceId: ResourceId
  hostId: Id
  canonicalPath: string
  filesystemIdentity: string
  repository: RepositoryIdentity | unknown
  repositoryIdentity?: string
  worktreeIdentity?: string
  revision: Revision
  state?: CheckoutState
}

export type WorkspaceKind = 'folder' | 'git-worktree' | (string & {})

export type WorkspaceState = 'active' | 'released' | 'unknown' | (string & {})

/** workspaces — a logical work environment; several may share a checkout */
export interface Workspace {
  id: WorkspaceId
  projectId: Id
  kind: WorkspaceKind
  checkoutId: CheckoutId
  state: WorkspaceState
}

/* ── ResourceClaim / ResourceTransfer ─────────────────────────────────── */

export type ClaimMode = 'read' | 'write'
export type ClaimState = 'held' | 'transferring' | 'released' | 'unknown'
export type ClaimOwnerKind = 'execution' | 'dispatch' | 'member' | 'operator' | (string & {})

/** resource_claims — held/unknown live writers may not be double-assigned */
export interface ResourceClaim {
  id: ResourceClaimId
  resourceId: ResourceId
  ownerKind: ClaimOwnerKind
  ownerId: Id
  mode: ClaimMode
  generation: ExecutionGeneration
  state: ClaimState
  revision: Revision
  /** convenience refs the C-RESOURCE contracts expose alongside the row */
  checkoutId?: CheckoutId
  terminalId?: TerminalId
  artifactId?: ArtifactId
  ownerExecutionId?: Id
  ownerDispatchId?: Id
}

export type TransferState =
  'requested' | 'quiesced' | 'committed' | 'rejected' | 'unknown' | (string & {})

/** resource_transfers — explicit handoff after old-owner quiescence */
export interface ResourceTransfer {
  id: ResourceTransferId
  claimId: ResourceClaimId
  expectedClaimRevision: Revision
  fromOwner: string
  toOwner: string
  state: TransferState
  evidence: unknown
}

/* ── TerminalRecord / InputLease ──────────────────────────────────────── */

export type TerminalState = 'open' | 'closed' | 'unknown' | (string & {})

/** terminal_records — host-owned terminal, independent of any pane/tab */
export interface TerminalRecord {
  id: TerminalId
  hostId: Id
  resourceId: ResourceId
  hostIncarnation: string
  ptyId: string
  outputEpoch: string
  lastSequence: number
  state: TerminalState
  processIdentity: ProcessIncarnation | unknown
}

/** terminal_input_leases — serializes operator input/resize ownership */
export interface InputLease {
  terminalId: TerminalId
  principalId: PrincipalId
  revision: Revision
  expiresAt: EpochMillis
}

/* ── RetentionPin / ContentBlob ───────────────────────────────────────── */

/** retention_pins — GC is forbidden while a published/active/handed-off
 *  object still references the target */
export interface RetentionPin {
  id: RetentionPinId
  targetKind: string
  targetId: string
  holderKind: string
  holderId: string
  reason: string
}

/** content_blobs — immutable snapshot/cache/artifact bytes */
export interface ContentBlob {
  digest: string
  mediaType: string
  byteLength: number
  bytes?: Uint8Array
  externalStorageRef?: string
  verified?: boolean
  ref?: ContentRef
}
