// mahas-contracts — work: Run, Member, Assignment, Plan/Task DAG, and the
// execution ledger (IMP-02).
//
// spec/domains/work.md §1–4 + spec/domains/execution.md §1, field names
// follow spec/storage.md §3 column names in camelCase (JSON payload columns
// drop the `_json` suffix: `scope_json` → `scope`).
//
// Deliberate separations the types keep visible:
//   - Task (durable identity + current pointers) ≠ TaskSpec (immutable
//     revision). A Dispatch always pins taskId + taskRevision.
//   - Dispatch.phase (authoritative attempt lifecycle) ≠ authorityState
//     (active/settled/revoked) ≠ OS process liveness (ExecutionRecord).
//   - ExecutionRecord (control mirror of one logical execution) ≠
//     Execution (identity.ts seam view).
//   - WorkEnvelope (this attempt's pinned text+bindings) ≠ LaunchPlan
//     (prepared spawn plan) ≠ ContextBundle (frozen implementation bytes).

import type {
  ArtifactRef,
  BundleDigest,
  ControllerEpoch,
  ExecutionGeneration,
  HostIncarnation,
  Id,
  ImplementationRevision,
  ModelVersionId,
  PlanRevision,
  RoleInterfaceDigest,
  TaskRevision,
  Revision
} from './common.ts'
import type {
  AssignmentId,
  ExecutionCredentialId,
  GrantId,
  HandoffId,
  LaunchPlanId,
  PlanCandidateId,
  ProjectId,
  RoleId,
  RolePolicyId,
  RunId,
  RuntimeInstanceId,
  ComponentId,
  EpochMillis
} from './ids.ts'
import type {
  DispatchId,
  ExecutionLiveness,
  ExecutionState,
  MemberId,
  ProcessIncarnation,
  TerminalId
} from './identity.ts'
import type { AuthorizationTarget } from './access.ts'
import type { HarnessSessionId, SessionHandleId } from './sessions/index.ts'

/* ── Run / Member / Assignment (runs, members, assignments) ───────────── */

export type RunPurpose = 'work' | 'verification'
export type RunState = 'draft' | 'active' | 'settled' | 'archived'

/** runs — a bounded collaboration, not a scheduler */
export interface Run {
  id: RunId
  projectId: ProjectId
  modelVersion: ModelVersionId
  goalText: string
  purpose: RunPurpose
  coordinatorMemberId?: MemberId
  state: RunState
  currentPlanRevision?: PlanRevision
  revision: Revision
}

export type MemberState = 'pending' | 'assigned' | 'active' | 'retired'

/** members — a durable role occupant with a persistent mailbox address */
export interface Member {
  id: MemberId
  runId: RunId
  modelVersion: ModelVersionId
  roleId: RoleId
  implementationId: Id
  implementationRevision: ImplementationRevision
  /** monotonically increasing execution generation (D-MAIL §2 fence) */
  generation: ExecutionGeneration
  currentExecutionId?: Id
  state: MemberState
  revision: Revision
}

export type AssignmentKind = 'coordination' | 'task'

/** scope_json — what the mandate reaches (targets resolved server-side) */
export interface AssignmentScope {
  operations?: string[]
  targets?: AuthorizationTarget[]
  [key: string]: unknown
}

/** assignments — binds one Member to a mandate; coordination needs no Task */
export interface Assignment {
  id: AssignmentId
  revision: Revision
  memberId: MemberId
  kind: AssignmentKind
  mandateText: string
  grantId: GrantId
  taskId?: Id
  taskRevision?: TaskRevision
  scope: AssignmentScope
}

/* ── Plan / PlanCandidate (plans, plan_candidates) ────────────────────── */

/** one entry of plans.dispositions_json — what the plan did with a candidate */
export interface PlanDisposition {
  taskId?: string
  disposition?: string
  reason?: string
  [key: string]: unknown
}

/** plans — immutable committed plan revision */
export interface Plan {
  runId: RunId
  revision: PlanRevision
  digest: string
  dispositions: PlanDisposition[] | unknown
}

/** plan_candidates — a prepared DAG patch, not yet committed */
export interface PlanCandidate {
  id: PlanCandidateId
  runId: RunId
  baseRevision?: PlanRevision | null
  digest: string
  patch: unknown
  diagnostics: unknown
}

/* ── Task / TaskSpec (tasks, task_specs) ──────────────────────────────── */

/**
 * Display states projected from the latest TaskSpec + current
 * Dispatch/Settlement (D-WORK §2) — never stored as UI strings and never a
 * dispatch precondition.
 */
export type TaskDisplayState =
  | 'unassigned'
  | 'blocked'
  | 'eligible'
  | 'active'
  | 'reported'
  | 'accepted'
  | 'failed'
  | 'cancelled'

/** tasks — durable identity + CURRENT pointers (currentRevision/currentDispatchId) */
export interface Task {
  id: Id
  runId: RunId
  currentRevision: TaskRevision
  currentDispatchId?: DispatchId
}

export type BindingKind = 'artifact' | 'task-output' | 'contract'

/**
 * inputs_json entry — a future task-output resolves to an exact ArtifactRef
 * at dispatch start; `required` defaults to true.
 */
export interface InputBinding {
  slot: string
  kind: BindingKind
  required?: boolean
  /** kind 'artifact' */
  artifactId?: string
  artifactRevision?: Revision
  /** kind 'task-output' */
  taskId?: string
  taskRevision?: TaskRevision
  outputSlot?: string
  /** kind 'contract' */
  contractId?: string
  contractRevision?: Revision
  modelVersion?: string
  /** aliases used by some clients / PlanPatch dialects */
  name?: string
  fromTaskId?: string
  output?: string
  identity?: {
    taskId?: string
    outputSlot?: string
    artifactId?: string
    [key: string]: unknown
  }
}

/** outputs_json entry — an output slot the TaskSpec promises */
export interface OutputSlot {
  slot: string
  description?: string
  /** contract that defines the I/O promise, when one exists */
  contractId?: string
  required?: boolean
  /** PlanPatch / UI alias for `slot` */
  name?: string
}

/** settlement_policy_json — owner-declaration or designated-acceptance */
export interface SettlementPolicy {
  mode?: 'owner-declaration' | 'designated-acceptance' | (string & {})
  acceptorRoleId?: RoleId
  acceptorMemberId?: MemberId
  /** aliases */
  kind?: 'owner-declaration' | 'designated-acceptance' | (string & {})
  acceptor?: MemberId
  [key: string]: unknown
}

/** task_specs — one immutable revision; the unit a Dispatch pins */
export interface TaskSpec {
  taskId: Id
  revision: TaskRevision
  title: string
  requirementText: string
  ownerRoleId: RoleId
  assignedMemberId?: MemberId
  /** inputs_json — future task-outputs resolve to exact ArtifactRefs at dispatch */
  inputs: InputBinding[] | unknown
  /** outputs_json — the slots this TaskSpec promises */
  outputs: OutputSlot[] | unknown
  settlementPolicy: SettlementPolicy | unknown
  /** tolerated aliases for the D-WORK prose names */
  inputBindings?: InputBinding[] | unknown
  outputSlots?: OutputSlot[] | unknown
}

/** task_edges.requirements_json — what the successor needs from the edge */
export interface TaskEdgeRequirements {
  requiredOutputNames?: string[]
  requiredOutputs?: string[]
  settlementRequirement?: string
  [key: string]: unknown
}

/** task_edges — predecessor→successor DAG edge; cycles are rejected */
export interface TaskEdge {
  runId: RunId
  planRevision: PlanRevision
  predecessorTaskId: Id
  successorTaskId: Id
  requiredOutputNames: string[]
  settlementRequirement: string
}

/* ── Dispatch / attempt observation (dispatches) ──────────────────────── */

/**
 * Authoritative attempt lifecycle (D-WORK §2). `start_unknown`/`stop_unknown`
 * are execution-axis states, deliberately NOT members here.
 */
export type DispatchPhase =
  | 'reserved'
  | 'starting'
  | 'awaiting_join'
  | 'awaiting_accept'
  | 'running'
  | 'reported'
  | 'settled'
  | 'revoked'

export type DispatchAuthorityState = 'active' | 'settled' | 'revoked'

/** dispatches — one authoritative attempt per Task at a time */
export interface Dispatch {
  id: DispatchId
  taskId: Id
  taskRevision: TaskRevision
  memberId: MemberId
  executionId: Id
  generation: ExecutionGeneration
  envelopeDigest: string
  phase: DispatchPhase
  authorityState: DispatchAuthorityState
  assignmentDeliveryId?: Id
  revision: Revision
}

/** attempt_observations / observations source — evidence, not authority */
export interface AttemptObservation {
  dispatchId: DispatchId
  source: string
  fact: string
  observedAt: EpochMillis
  identityEvidence?: unknown
}

/** residual_resources (effect_intents.residuals_json entry) */
export interface ResidualResource {
  effectId?: string
  resourceRef?: string
  kind?: string
  ref?: string
  state?: string
  reason?: string
  liveEvidence?: unknown
  cleanupPolicy?: string
  note?: string
  [key: string]: unknown
}

/* ── Execution host / lease (runtime_instances, execution_hosts,
      controller_leases) ─────────────────────────────────────────────── */

export interface RuntimeInstance {
  id: RuntimeInstanceId
  controllerEpoch: ControllerEpoch
  processIdentity: ProcessIncarnation | unknown
  endpointIncarnation: string
  state: string
}

export type ExecutionHostState = string

export interface ExecutionHost {
  id: Id
  hostIncarnation: HostIncarnation
  protocolVersion: string
  state: ExecutionHostState
  identity: ProcessIncarnation | unknown
}

/**
 * controller_leases — expiry/TTL alone never proves the previous owner dead;
 * `reconciliationState` records the positive evidence basis of a takeover.
 */
export interface ControllerLease {
  hostId: Id
  epoch: ControllerEpoch
  ownerProcessIdentity: ProcessIncarnation | unknown
  nonce: string
  expiresAt: EpochMillis
  reconciliationState: string
  revision: Revision
  proof?: unknown
}

/* ── Execution ledger (executions, execution_credentials) ─────────────── */

/** executions — the control-plane mirror of one logical execution */
export interface ExecutionRecord {
  id: Id
  memberId: MemberId
  generation: ExecutionGeneration
  hostId: Id
  launchPlanId: LaunchPlanId
  state: ExecutionState
  liveness: ExecutionLiveness
  terminalId?: TerminalId
  processIdentity: ProcessIncarnation | unknown
  /**
   * Migration-compatibility copy of the native handle captured at launch.
   * It is no longer an authoritative session record: the persistent identity
   * is `HarnessSession` + `SessionHandle` (./sessions/index.ts), reached via
   * `sessionId`/`sessionHandleId`. Readers must prefer the canonical
   * reference and treat this JSON as evidence about where a handle came from.
   */
  nativeConversation?: NativeConversation
  /** canonical HarnessSession this execution runs — absent until resolved */
  sessionId?: HarnessSessionId
  /** canonical SessionHandle (resume locator) recorded for that session */
  sessionHandleId?: SessionHandleId
  revision: Revision
  /** epoch-ms bookkeeping where the owner keeps it alongside the row */
  createdAt?: EpochMillis
  updatedAt?: EpochMillis
}

/**
 * Legacy native history re-entry point — a hint, never a liveness proof.
 *
 * Superseded by `HarnessSession` (identity) + `SessionHandle` (resume
 * support, installation, locator). This shape survives only so pre-migration
 * rows keep parsing: a consumer resolves it through the canonical session
 * store and must not treat a populated instance as the authoritative session
 * copy. New writers record a canonical handle instead of extending this.
 */
export interface NativeConversation {
  harnessProfileId?: Id
  nativeId?: string
  capturedBy?: string
  capturedAt?: EpochMillis
  resumeSupport?: string
  [key: string]: unknown
}

export type ExecutionCredentialMode = 'bootstrap' | 'full'

/** execution_credentials — secret material is never returned by a read op */
export interface ExecutionCredential {
  id: ExecutionCredentialId
  /** scrypt/sha256 hash — the plaintext secret is never stored or echoed */
  secretHash: string
  principalId: Id
  executionId: Id
  generation: ExecutionGeneration
  mode: ExecutionCredentialMode
  revokedAt?: EpochMillis
  revision: Revision
}

/* ── WorkEnvelope / LaunchPlan ────────────────────────────────────────── */

/**
 * work_envelopes — the authoritative text of THIS attempt. The digest pins
 * the actual bytes (body in content_blobs); `currentRequirementText` is the
 * resolved text itself, not the digest.
 */
export interface WorkEnvelope {
  digest: string
  kind: 'task' | 'coordination'
  runId: RunId
  memberId: MemberId
  taskId?: Id
  taskRevision?: TaskRevision
  dispatchId?: DispatchId
  currentRequirementText: string
  inputBindings: InputBinding[] | unknown
  peers?: unknown
  reportContract?: unknown
}

/** launch_plans.reservations_json entry */
export interface ExecutionReservation {
  reservationId: string
  kind: string
  mode?: string
  [key: string]: unknown
}

/** launch_plans.process_spec_json — primitive spawn shape (argv array) */
export interface LaunchProcessSpec {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  terminal?: { cols: number; rows: number }
  [key: string]: unknown
}

/** launch_plans.pins_json — the exact revisions this plan froze */
export interface LaunchPlanPins {
  assignment?: { id: string; revision: number; kind?: string }
  member?: { id: string }
  run?: { id: string; purpose?: string }
  modelVersion?: string
  roleId?: string
  interfaceDigest?: RoleInterfaceDigest | string
  implementation?: { id: string; revision: number }
  harnessProfile?: { id: string; revision: number }
  grant?: { id: string; revision: number }
  policy?: { id: string; revision: number } | null
  task?: { id: string; revision: number } | null
  envelope?: { digest: string }
  bundle?: { digest: BundleDigest | string }
  surface?: { digest: string }
  host?: { id: string; incarnation?: string }
  placementIntent?: unknown
  purpose?: RunPurpose
  routes?: unknown
  inputs?: unknown
  [key: string]: unknown
}

export type LaunchPlanState =
  'planned' | 'prepared' | 'committed' | 'used' | 'expired' | 'superseded'

/**
 * launch_plans — a prepared spawn. Prepared ≠ started: the first DB
 * transaction of worker.start fixes the Dispatch and current attempt.
 */
export interface LaunchPlan {
  id: LaunchPlanId
  assignmentId: AssignmentId
  assignmentRevision: Revision
  digest: string
  bundleDigest: BundleDigest | string
  envelopeDigest: string
  surfaceDigest: string
  state: LaunchPlanState | string
  processSpec: LaunchProcessSpec | unknown
  pins: LaunchPlanPins | unknown
  reservations: ExecutionReservation[] | unknown
  /** control-plane additions the owner keeps beside the DDL row */
  runId?: RunId
  memberId?: MemberId
  roleId?: RoleId
  modelVersion?: ModelVersionId
  purpose?: RunPurpose
  policyId?: RolePolicyId | null
  createdAt?: EpochMillis
  updatedAt?: EpochMillis
}

/* ── Injection / join receipts ───────────────────────────────────────── */

export type InjectionPhase = 'materialized' | 'attached' | 'worker_joined' | (string & {})

/** one entry of injection_receipts.components_json */
export interface InjectionComponentEvidence {
  componentId?: ComponentId
  kind?: string
  digest?: string
  route?: string
  [key: string]: unknown
}

export type EvidenceLevel = 'declared' | 'observed' | 'verified' | (string & {})

/** injection_receipts — materialized/attached/worker_joined are distinct */
export interface InjectionReceipt {
  executionId: Id
  phase: InjectionPhase
  revision: Revision
  contentDigests?: string[]
  route?: string
  attachedAt?: EpochMillis
  evidenceLevel?: EvidenceLevel
  components: InjectionComponentEvidence[] | unknown
  inherited?: unknown
  evidence?: unknown
}

/** worker_joins — the agent protocol declaration; understanding is not proven */
export interface WorkerJoin {
  executionId: Id
  generation: ExecutionGeneration
  bundleDigest: BundleDigest | string
  surfaceDigest: string
  envelopeDigest: string
  joinedAt: EpochMillis
  credentialId?: ExecutionCredentialId
}

/* ── Handoff ──────────────────────────────────────────────────────────── */

/** handoffs.bindings_json entry — which result/resource moves where */
export interface HandoffBinding {
  artifactRefs?: ArtifactRef[]
  resourceIds?: string[]
  acceptedOutcomeRevision?: Revision
  [key: string]: unknown
}

/** handoffs — result and resource movement, linked separately */
export interface Handoff {
  id: HandoffId
  fromDispatchId: DispatchId
  toTaskId?: Id
  toMemberId?: MemberId
  artifactRefs: ArtifactRef[]
  acceptedOutcomeRevision?: Revision
  bindings?: HandoffBinding | unknown
}
