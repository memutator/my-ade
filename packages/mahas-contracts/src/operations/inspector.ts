// mahas-contracts/operations/inspector — inspector operation DTOs.
//
// The inspector projects actual domain records at an authorized detail level.
// Runtime handlers decide visibility and build the projections; this module
// only describes the JSON-safe request/result boundary consumed by clients.

import type {
  BundleDigest,
  ControllerEpoch,
  EffectIntent,
  EffectReceipt,
  ExecutionGeneration,
  Id,
  ImplementationRevision,
  ModelVersionId,
  RoleInterfaceDigest,
  TaskRevision
} from '../common.ts'
import type { ProcessSpec } from '../client.ts'
import type { ExecutionId, ExecutionLiveness, HostId, MemberId } from '../identity.ts'
import type {
  ContextRequirement,
  CoverageBinding,
  HarnessProfile,
  ImplementationComponent,
  InterfaceMaintenanceRef,
  RoleImplementation,
  RoleInterface
} from '../role.ts'
import type { AuthorizationTarget, GrantKind } from '../access.ts'
import type { ResidualResource } from '../work.ts'
import type { DomainEvent } from '../observation.ts'

// ── payloads ──────────────────────────────────────────────────────────────

export interface InterfaceGetPayload {
  modelVersion: ModelVersionId
  roleId: Id
}

export interface RoleImplementationsPayload {
  modelVersion: ModelVersionId
  roleId: Id
  hostId?: HostId
  componentNeeds?: string[]
}

export interface ImplementationPreparePayload {
  interfaceDigest: RoleInterfaceDigest
  harnessProfileRevision: string
  componentGraph: ImplementationComponent[]
  coverageBindings: CoverageBinding[]
  maintainerRoleId: Id
}

export interface ImplementationPublishPayload {
  candidateId: Id
  candidateDigest: string
  expectedInterfaceDigest: RoleInterfaceDigest
  semanticDecision: string
}

export interface ImplementationRetirePayload {
  implementationId: Id
  revision: ImplementationRevision
  reason: string
}

export interface HarnessProfileInspectPayload {
  profileId: Id | string
  revision?: number | string
  hostId: HostId | string
}

export interface ContextInspectPayload {
  bundleDigest?: BundleDigest | string
  executionId?: ExecutionId | string
  detail: 'own' | 'composition' | 'maintenance'
}

export interface SurfaceDescribePayload {
  operation?: string
  expectedSurfaceDigest?: string
}

export interface AccessInspectPayload {
  memberId?: MemberId | string
  grantId?: Id | string
}

export interface WorkerPreparePayload {
  assignmentId: Id | string
  assignmentRevision: number
  implementationRevision: ImplementationRevision
  taskRevision?: TaskRevision
  /** the host the workspace is prepared on — required by the planner */
  placementIntent: { hostId: string } & Record<string, unknown>
  harnessProfileRevision: number
  purpose: 'work' | 'verification'
}

export interface WorkerInspectPayload {
  executionId?: ExecutionId | string
  memberId?: MemberId | string
  /**
   * ask the host to probe the recorded process before answering. Additive to
   * an otherwise pure read: an unanswered probe is reported as
   * liveness 'unverifiable' with the failure under `probe`, never as death.
   */
  probe?: boolean
}

export interface RuntimeSnapshotPayload {
  scope: unknown
  projectionPurpose?: string
}

export interface RuntimeSubscribePayload {
  scope: unknown
  epoch?: number | ControllerEpoch
  afterSequence?: number
  visibilityDigest?: string
}

// ── result envelopes ──────────────────────────────────────────────────────

/**
 * interface.get — the role's semantic interface at the read model status.
 *
 * `interface.requirements.contextRequirements` is the nested canonical list;
 * `contextRequirements` repeats it flattened for clients that only read the
 * clause list (both come from the same derivation).
 */
export interface InterfaceGetResult {
  interface: RoleInterface
  digest: RoleInterfaceDigest
  contextRequirements: ContextRequirement[]
  /** model-derived staleness refs — InterfaceMaintenanceRef, not a binding */
  maintenanceRefs: InterfaceMaintenanceRef[]
  /** model_versions.status at read time — consumers decide freshness policy */
  modelStatus: string
}

export interface ImplementationOffer {
  implementationId?: Id | string
  revision?: ImplementationRevision
  interfaceDigest?: RoleInterfaceDigest
  profileId?: Id | string
  profileRevision?: string
  support?: string
  blockers?: string[]
}

export interface RoleImplementationsResult {
  implementations: ImplementationOffer[]
}

export interface ImplementationPrepareResult {
  candidate: RoleImplementation
  candidateId?: Id | string
  uncoveredClauses: string[]
  unsupportedComponents: ImplementationComponent[]
  digest: string
}

export interface ImplementationPublishResult {
  implementationId: Id | string
  revision: ImplementationRevision
}

export interface ImplementationRetireResult {
  implementationId?: Id | string
  revision?: ImplementationRevision
  status: string
  referencingExecutions: (ExecutionId | string)[]
}

export interface HarnessProfileInspectResult {
  profile: HarnessProfile
  admissionState?: string
  observedExecutableIdentity?: string
  capabilities?: unknown
}

/** one component the bundle manifest declares — intent, not delivery */
export interface PlannedComponent {
  componentId: string
  kind: string
  /** bundle-relative path the manifest names */
  path: string
  /** project | user | organization | provider | … (as recorded) */
  scope: string
  digest: string
  activation?: string
  loadPhase?: string
}

/** one recorded injection receipt revision — delivery evidence per phase */
export interface AttachedPhase {
  phase: string
  revision: number
  components: unknown[]
  inherited: unknown[]
  evidence: unknown
}

/** instructions observed outside the bundle */
export interface InheritedInput {
  /** project | user | organization | provider */
  scope: string
  path?: string
  /** known = bytes observed; absent = probed, not present; unknown = not
   *  observable or enumerable by this runtime */
  status: 'known' | 'absent' | 'unknown'
  digest?: string
  note?: string
}

export interface ContextUnknown {
  what: string
  reason?: string
}

/**
 * context.inspect — planned intent vs recorded delivery evidence.
 *
 * `planned` is what the bundle manifest declares, `attached` is one entry per
 * recorded injection_receipts row, `missing` lists planned componentIds with
 * no materialized-phase evidence, and `unknowns` is what this runtime cannot
 * see (including the provider's hidden system prompt) — its presence means we
 * do NOT claim full context. Detail `own` is self-scoped to the caller's own
 * execution.
 */
export interface ContextInspectResult {
  executionId?: ExecutionId | string
  memberId?: Id | string
  launchPlanId?: Id | string
  bundleDigest: BundleDigest | string
  pins: {
    interfaceDigest: string
    implementationId: string
    implementationRevision: number
    surfaceDigest: string
    requiredTextDigest: string
    harnessProfileId?: string
  }
  planned: PlannedComponent[]
  attached: AttachedPhase[]
  inherited: InheritedInput[]
  /** planned componentIds with no materialized-phase evidence yet */
  missing: string[]
  unknowns: ContextUnknown[]
  /** maintenance detail only: bundle source-observation pins */
  sourceObservations?: unknown
  manifestDigest?: string
}

/**
 * one command the caller's surface exposes. The CLI builds help, completion
 * and MCP tool lists ONLY from these rows (REQ-09: a hidden operation never
 * appears, so the descriptor list IS the visible surface).
 */
export interface SurfaceOperationDescriptor {
  name: string
  summary: string | null
  mutation: boolean
  visibility: 'operator' | 'member' | 'service' | 'host'
  inputSchema: unknown
  outputSchema: unknown
}

/**
 * surface.describe — the projected command surface for this credential.
 *
 * This is the projection, not the persisted `command_surfaces` row: the
 * digest, whether the caller's pinned digest went stale, and the visible
 * operation descriptors. The row's internal evidence (actions_and_schemas,
 * policy pins) is not shipped to a client.
 */
export interface SurfaceDescribeResult {
  surfaceDigest: string
  /** true when the caller pinned a different digest — the fresh digest is returned */
  stale: boolean
  operations: SurfaceOperationDescriptor[]
}

/** scope_json summary of one inspected grant — resolved targets, no secrets */
export interface GrantScopeSummary {
  runId?: string
  memberId?: string
  /** actual targets resolved server-side, never the payload's intent */
  targets: AuthorizationTarget[]
  provisioning?: {
    allowedRoleIds: string[]
    maxMembers?: number
    profileAdmission?: string
  }
  continuation?: {
    memberId: string
    allowedWakeRoute?: string
    budget?: number
  }
}

/** one grant row of an access.inspect response */
export interface GrantInspectSummary {
  grantId: string
  kind: GrantKind
  revision: number
  actions: string[]
  scopeSummary: GrantScopeSummary
  /** authority-clock expiry, null when the grant never expires */
  expiresAt: number | null
  revokedAt: number | null
  status: 'active' | 'expired' | 'revoked'
}

/**
 * access.inspect — what the inspected subject may actually do right now.
 *
 * Exactly one subject is inspected: a member (`memberId`) or a single grant
 * (`grantId`). `grants` carries the grants behind that subject — one row for
 * a single-grant inspect, the member's grants otherwise — and each row states
 * its own expiry and revocation, so no separate expiry/revocation arrays are
 * needed. Effective actions are this subject's current ceiling, never another
 * principal's internals.
 */
export interface AccessInspectResult {
  memberId?: string
  grantId?: string
  /** the role policy pinned for the member view, null for a grant view */
  policy?: { policyId?: string; policyRevision?: number } | null
  effectiveActions: string[]
  grants: GrantInspectSummary[]
}

/**
 * worker.prepare — resolve implementation/bundle/surface/inputs and pin a
 * LaunchPlan. No process is started: `existing` reports an idempotent
 * re-prepare of identical pins, and the pins are the exact set the plan fixed.
 */
export interface WorkerPrepareResult {
  launchPlanId: string
  digest: string
  state: string
  /** true when identical pins were already planned (idempotent re-prepare) */
  existing: boolean
  /** the pinned identity set — assignment/member/run/model/role/interface/
   *  implementation/profile/grant/policy/task/envelope/bundle/surface/host */
  pins: Record<string, unknown>
  processSpec: ProcessSpec | Record<string, unknown>
  plannedSurface: { digest: string; actions: string[] }
  /** paths/ids of components the plan requires */
  requiredComponents: string[]
  reservations: { reservationId: string; kind: string; mode: string }[]
  blockers: LaunchBlocker[]
}

/** one pin the launch plan fixes — shown verbatim, never re-resolved */
export interface LaunchPin {
  name: string
  value: string
}

/** a blocker that kept worker.prepare from producing a usable plan */
export interface LaunchBlocker {
  code?: string
  message: string
  detail?: unknown
}

/** the joined worker's evidence for this execution (one row per generation) */
export interface WorkerJoinEvidence {
  joinedAt?: number
}

/** the dispatch authority pinned to this execution, verbatim */
export interface WorkerInspectTaskAuthority {
  dispatchId?: string
  taskId?: string
  taskRevision?: number
  phase?: string
  authorityState?: string
  assignmentDeliveryId?: string | null
}

/** one recorded injection receipt revision for this execution */
export interface InjectionReceiptPin {
  phase: string
  revision: number
}

export interface StageRecord {
  stage: string
  state?: string
  at?: number
  evidence?: unknown
}

export interface StageReceipt {
  currentStage?: string
  failedStage?: string
  stages?: StageRecord[]
  effects?: (EffectIntent | EffectReceipt)[]
  residualResources?: ResidualResource[]
  nextAllowedActions?: string[]
}

/**
 * worker.inspect — the flattened execution view (C-LAUNCH, observation only).
 *
 * Every field is read verbatim from the execution/launch rows: `phase` is the
 * recorded execution state (never expanded into implied stages), `liveness` is
 * the recorded value or the fresh probe answer, and `stageReceipt` is the
 * cumulative receipt for this execution's launch plan — evidence about what
 * happened, never a completion verdict. worker.start is deliberately not on
 * this surface.
 */
export interface WorkerInspectResult {
  executionId: string
  memberId: string
  generation: number
  hostId: string
  launchPlanId: string
  /** launch_plans.digest — absent only if the plan row is missing */
  planDigest?: string
  /** the recorded execution state (executions.state) */
  phase: string
  liveness: ExecutionLiveness
  /** bound terminal record, null when this execution has none */
  terminalId: string | null
  /** process_identity_json, parsed verbatim (ProcessIncarnation-shaped) */
  processEvidence: unknown
  /** host probe answer — present only when the caller asked for `probe` */
  probe?: unknown
  joined: WorkerJoinEvidence | null
  taskAuthority: WorkerInspectTaskAuthority | null
  injectionReceipts: InjectionReceiptPin[]
  stageReceipt: StageReceipt | null
  residuals: ResidualResource[]
  failedStage?: string
  nextAllowedActions: string[]
}

export interface SnapshotEntity {
  kind: string
  id: string
  revision?: number
  state?: unknown
  data?: unknown
}

export interface RuntimeSnapshotResult {
  epoch: number | ControllerEpoch
  sequence: number
  visibilityDigest: string
  entities: SnapshotEntity[]
}

export interface RuntimeSubscribeResult {
  events: DomainEvent[]
  nextSequence?: number
  visibilityDigest?: string
}

export type ExecutionGenerationPin = ExecutionGeneration
