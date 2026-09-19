// mahas-contracts — observation, intervention, projection, maintenance and
// operations records (IMP-02).
//
// spec/domains/resources-observation.md §2–3 + spec/storage.md §3. The
// source of every fact is preserved (`source`/`identityEvidence`); an
// observation never silently becomes an authoritative result, and a client
// detach never means the worker stopped.

import type { Id, Revision, RoleInterfaceDigest } from './common.ts'
import type { EpochMillis } from './ids.ts'
import type {
  BackupSetId,
  ClientViewBindingId,
  ImpactCandidateId,
  InterventionId,
  MigrationReceiptId,
  ObservationId,
  ResumeCandidateId,
  SupportAttestationId
} from './ids.ts'

/* ── ObservationFact / DomainEvent ────────────────────────────────────── */

export type ObservationSource = 'hook' | 'process' | 'agent-declaration' | 'host' | (string & {})

export type ConfidenceClass = 'declared' | 'observed' | 'verified' | (string & {})

/** observations — the observation ledger; source provenance is retained */
export interface Observation {
  id: ObservationId
  executionId?: Id | null
  dispatchId?: Id | null
  source: ObservationSource
  factType: string
  observedAt: EpochMillis
  payload: unknown
  identityEvidence: unknown
  confidenceClass?: ConfidenceClass
}

/** domain_events — the projection outbox written with the transaction */
export interface DomainEvent {
  globalSequence: number
  scope: unknown
  aggregateId: string
  aggregateRevision: number
  eventType: string
  payload: unknown
  /** aliases the projection contracts use */
  sequence?: number
  type?: string
}

/* ── Intervention ─────────────────────────────────────────────────────── */

export type InterventionKind = 'permission' | 'question' | 'needs-input' | 'error' | (string & {})

export type InterventionState = 'open' | 'claimed' | 'resolved' | 'obsolete' | (string & {})

/** interventions — an answer is not the same as an actual permission grant */
export interface Intervention {
  id: InterventionId
  runId?: Id | null
  memberId?: Id | null
  executionId?: Id | null
  kind: InterventionKind
  evidence: unknown
  state: InterventionState
  responder?: Id | null
  responseNote?: string | null
  revision: Revision
}

/* ── ClientViewBinding ────────────────────────────────────────────────── */

/**
 * client_view_bindings — UI-owned layout state. Unbinding is a detach, not a
 * worker stop (self-view also lives in binding.ts for the desktop seam).
 */
export interface ClientViewBinding {
  id: ClientViewBindingId
  clientId: string
  viewId: string
  executionId?: Id | null
  terminalId?: Id | null
  layoutBinding: unknown
  sizeClaim?: unknown
}

/* ── ResumeCandidate ──────────────────────────────────────────────────── */

export type ResumeSupportState = 'supported' | 'unsupported' | 'unknown' | (string & {})

/**
 * resume_candidates — a native-conversation hint; `verifiedProcessState` is
 * the only field that speaks to actual liveness, and it is still not the
 * current control authority.
 */
export interface ResumeCandidate {
  id: ResumeCandidateId
  executionId: Id
  supportState: ResumeSupportState
  nativeHandle: unknown
  evidence: unknown
  source?: string
  verifiedProcessState?: string
}

/* ── ImpactCandidate ──────────────────────────────────────────────────── */

export type ImpactState = 'candidate' | 'confirmed' | 'dismissed' | 'resolved' | (string & {})

/** impact_candidates — semantic impact is never automatically confirmed */
export interface ImpactCandidate {
  id: ImpactCandidateId
  changeRef: unknown
  targetKind: string
  targetId: string
  reason: unknown
  state: ImpactState
  reviewer?: Id | null
  resolution?: unknown
  revision: Revision
}

/* ── Maintenance records ──────────────────────────────────────────────── */

/** migration_receipts */
export interface MigrationReceipt {
  id: MigrationReceiptId
  fromSchema: number
  toSchema: number
  stage: string
  fingerprint: string
  backupRef?: string | null
  outcome: string
}

/** backup_sets — SQLite + required blob/receipt consistency point */
export interface BackupSet {
  id: BackupSetId
  state: string
  consistencyPoint: EpochMillis | string
  manifestDigest: string
  manifest?: unknown
  controlDbSnapshot?: unknown
  hostSnapshot?: unknown
  contentPins?: unknown[]
}

/* ── Runtime shutdown / support attestation ───────────────────────────── */

export type ShutdownMode = 'leave-executions' | 'drain-and-stop'

/** runtime_shutdowns — mode and residuals are explicit, never inferred */
export interface RuntimeShutdown {
  operationId: string
  mode: ShutdownMode | string
  state?: string
  targetedExecutions?: Id[]
  stages: unknown
  residuals: unknown
  outcome?: unknown
}

/**
 * support_attestations — `documented` and `verified` stay distinguishable;
 * a documentation review never inflates into an executed test case.
 */
export interface SupportAttestation {
  id: SupportAttestationId
  profileId: Id
  profileRevision: Revision
  harnessProfileRevision?: RoleInterfaceDigest | number
  installedBinaryIdentity?: unknown
  installation?: unknown
  /** operating systems actually covered by the performed cases */
  os?: string[]
  performedCases: unknown
  decision: string
  evidenceRefs: unknown[]
}
