// mahas-runtime/inspector — per-operation payload and result envelopes.
//
// IMP-32 reads the C-* contract "입력/반환" tables and writes them down
// here as types. These are the workbench's READING of the spec — the
// normative wire schema is IMP-02's deliverable; when it lands these
// declarations converge onto it (handoff notes track this).
//
// Real domain records (RoleInterface, RoleImplementation, LaunchPlan,
// InjectionReceipt, CommandSurface, Grant, ExecutionRecord…) are carried
// VERBATIM inside the envelopes — the inspectors exist to show real
// records, never synthesized state (IMP-32 §4; REQ-23).

import type {
  Id,
  ModelVersionId,
  RoleInterfaceDigest,
  ImplementationRevision,
  BundleDigest,
  TaskRevision,
  ExecutionGeneration,
  ControllerEpoch,
  ExecutionLiveness,
  ProcessIncarnation,
  MemberId,
  ExecutionId,
  HostId,
  ProcessSpec,
  EffectIntent,
  EffectReceipt
} from '../../../mahas-contracts/src/index.ts'
import type {
  RoleInterface,
  ContextRequirement,
  HarnessProfile,
  RoleImplementation,
  ImplementationComponent,
  CoverageBinding,
  MaintenanceBinding
} from '../../../mahas-contracts/src/role.ts'
import type { CommandSurface, Grant } from '../../../mahas-contracts/src/access.ts'
import type {
  LaunchPlan,
  ExecutionRecord,
  InjectionReceipt,
  WorkerJoin,
  ResidualResource,
  AttemptObservation
} from '../../../mahas-contracts/src/work.ts'
import type { DomainEvent } from '../../../mahas-contracts/src/observation.ts'

// ── payloads (spec "입력" rows) ────────────────────────────────────────────

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
  /** the implementer's declared semantic judgement — REQUIRED, not a
   *  mechanical-check echo (C-REALIZATION implementation.publish) */
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
  /** resolution level the caller is entitled to (C-REALIZATION context.inspect) */
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
  assignmentRevision?: number
  implementationRevision: ImplementationRevision
  taskRevision?: TaskRevision
  placementIntent?: unknown
  harnessProfileRevision: string
  purpose: 'work' | 'verification'
}

export interface WorkerInspectPayload {
  executionId?: ExecutionId | string
  memberId?: MemberId | string
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

// ── result envelopes (spec "반환" rows) ────────────────────────────────────

export interface InterfaceGetResult {
  interface: RoleInterface
  requirements: ContextRequirement[]
  digest: RoleInterfaceDigest
  maintenanceRefs: MaintenanceBinding[]
}

/** C-DISCOVERY role.implementations — one offered implementation row */
export interface ImplementationOffer {
  implementationId?: Id | string
  revision?: ImplementationRevision
  interfaceDigest?: RoleInterfaceDigest
  profileId?: Id | string
  profileRevision?: string
  /** documented | verified | disabled | unknown — verbatim */
  support?: string
  blockers?: string[]
}

export interface RoleImplementationsResult {
  implementations: ImplementationOffer[]
}

export interface ImplementationPrepareResult {
  /** the stored candidate record — structural diagnostics live beside it */
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
  /** 'retired' — verbatim from the op */
  status: string
  /** executions pinned to this revision — retire must not destroy them */
  referencingExecutions: (ExecutionId | string)[]
}

export interface HarnessProfileInspectResult {
  profile: HarnessProfile
  /** draft | documented | verified | disabled — verbatim */
  admissionState?: string
  observedExecutableIdentity?: string
  /** recipe capability detail — structure is profile-specific */
  capabilities?: unknown
}

/** one planned bundle entry — manifest row, NOT evidence of injection */
export interface PlannedComponent {
  componentId: string
  kind?: string
  /** load route declared for it (file/text/preload), if recorded */
  loadRoute?: string
  byteDigest?: string
  raw?: unknown
}

/** an input the execution inherited outside the bundle (provider-hidden
 *  prompts stay 'unknown' — see ContextUnknown below) */
export interface InheritedInput {
  label?: string
  source?: string
  digest?: string
  raw?: unknown
}

/** something the inspector can honestly only report as unknown */
export interface ContextUnknown {
  what: string
  reason?: string
}

export interface ContextInspectResult {
  plannedComponents: PlannedComponent[]
  /** the real InjectionReceipt / EffectiveContextReceipt record, or null */
  attachedReceipt: InjectionReceipt | null
  inheritedInputs: InheritedInput[]
  unknowns: ContextUnknown[]
  bundleDigest?: BundleDigest | string
  executionId?: ExecutionId | string
  /** join evidence when the server reports it — absent ≠ failed */
  workerJoin?: WorkerJoin | null
}

export interface SurfaceDescribeResult {
  surface: CommandSurface
  surfaceDigest?: string
}

export interface AccessInspectResult {
  /** effective action names the CURRENT grant set actually permits */
  effectiveActions: string[]
  /** scope summary — grant/target structure is IMP-02's wire shape */
  scopeSummary?: Record<string, unknown>
  expiry?: number | null
  revoked: boolean
  /** the real grant records when the scope permits showing them */
  grants?: Grant[]
  memberId?: MemberId | string
  grantId?: Id | string
}

/** one exact pin from worker.prepare (model pin, digests, generation…) */
export interface LaunchPin {
  name: string
  value: string
}

export interface LaunchBlocker {
  code?: string
  message: string
  detail?: unknown
}

export interface WorkerPrepareResult {
  plan: LaunchPlan
  pins: LaunchPin[]
  /** the exact processSpec the plan fixes — argv array, never a shell line */
  processSpec: ProcessSpec | Record<string, unknown>
  blockers: LaunchBlocker[]
  plannedSurface?: CommandSurface
  requiredComponents?: PlannedComponent[]
}

export interface ProcessEvidence {
  processIncarnation?: ProcessIncarnation
  observedAt?: number
  source?: string
  detail?: unknown
}

/** what authority the execution acts under — dispatch/task linkage,
 *  never collapsed into the Execution identity itself (REQ-11) */
export interface TaskAuthority {
  dispatchId?: string
  taskId?: string
  taskRevision?: TaskRevision
  assignmentId?: string
  kind?: string
}

/** one stage inside the cumulative start receipt (C-LAUNCH stage chain) */
export interface StageRecord {
  stage: string
  state?: string
  at?: number
  evidence?: unknown
}

/** the cumulative worker.start receipt — partial failure is preserved */
export interface StageReceipt {
  currentStage?: string
  failedStage?: string
  stages?: StageRecord[]
  effects?: (EffectIntent | EffectReceipt)[]
  residualResources?: ResidualResource[]
  nextAllowedActions?: string[]
}

export interface WorkerInspectResult {
  execution: ExecutionRecord
  phase?: string
  liveness?: ExecutionLiveness
  processEvidence?: ProcessEvidence
  taskAuthority?: TaskAuthority
  /** the current cumulative receipt — null when none is recorded yet */
  receipt?: StageReceipt | null
  residuals: ResidualResource[]
  join?: WorkerJoin | null
  observations?: AttemptObservation[]
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

/** an execution generation as it appears inside pin/authority records */
export type ExecutionGenerationPin = ExecutionGeneration
