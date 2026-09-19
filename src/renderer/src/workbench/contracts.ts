// workbench/contracts.ts — the ONE import site for the canonical workbench
// operation DTOs (mahas-contracts/operations/{discovery,workbench,inspector}).
//
// This module declares no wire shape of its own. It re-exports the shared
// payloads so every workbench component has one import site, and so the
// renderer cannot drift into a private copy of a server payload — a local
// alias that "looks about right" is exactly the failure mode the shared
// contracts exist to prevent.
//
// Reads go through ./view-model.ts (explicit projections onto the canonical
// DTOs); writes use the request DTOs below verbatim. Ops are called by name
// through ./client.ts — the renderer never imports mahas-runtime.

// ── C-DISCOVERY ──────────────────────────────────────────────────────────
export type {
  AmbiguityGroup,
  AvailabilityBlocker,
  BoundarySummary,
  CandidateCard,
  Collaborator,
  CollaboratorReason,
  CollaboratorsRequest,
  CollaboratorsResult,
  ContractTension,
  CoordinationView,
  CriterionSummary,
  ImplementationAvailability,
  ImplementationsRequest,
  ImplementationsResult,
  InspectPerspective,
  InspectRequest,
  InspectResult,
  LocateClaimant,
  LocateRequest,
  LocateResult,
  LocatedPath,
  MatchReason,
  MemberAvailability,
  RelationshipRef,
  RoleSummary,
  ScopeCoverage,
  SearchRequest,
  SearchResult,
  SearchStatus,
  UnmatchedPath
} from '../../../../packages/mahas-contracts/src/operations/discovery.ts'

// ── C-WORK (plan / assignment / run projection) ──────────────────────────
export type {
  AssignmentKind,
  AssignmentPreviewRequest,
  AssignmentPreviewResult,
  AssignmentProjection,
  AttemptDisposition,
  CoordinatorRunProjection,
  EdgePatch,
  InputBindingWire,
  MemberProjection,
  OutputSlotWire,
  PendingInput,
  PlanCommitRequest,
  PlanCommitResult,
  PlanPatch,
  PlanPrepareRequest,
  PlanPrepareResult,
  PlanProjection,
  RunGetRequest,
  RunProjection,
  TaskEdgeProjection,
  TaskEligibility,
  TaskSpecPatch,
  TaskSpecProjection,
  TeamAssignRequest,
  TeamAssignResult
} from '../../../../packages/mahas-contracts/src/operations/workbench.ts'

// ── inspector / realization / access / launch reads ──────────────────────
export type {
  AccessInspectPayload,
  AccessInspectResult,
  AttachedPhase,
  ContextInspectPayload,
  ContextInspectResult,
  ContextUnknown,
  GrantInspectSummary,
  GrantScopeSummary,
  InheritedInput,
  InjectionReceiptPin,
  InterfaceGetPayload,
  InterfaceGetResult,
  LaunchBlocker,
  LaunchPin,
  PlannedComponent,
  StageReceipt,
  StageRecord,
  SurfaceDescribePayload,
  SurfaceDescribeResult,
  SurfaceOperationDescriptor,
  WorkerInspectPayload,
  WorkerInspectResult,
  WorkerInspectTaskAuthority,
  WorkerJoinEvidence
} from '../../../../packages/mahas-contracts/src/operations/inspector.ts'

// ── domain records the inspector lanes project ───────────────────────────
export type { CommandSurface, GrantScope } from '../../../../packages/mahas-contracts/src/access.ts'
export type {
  ContextRequirement,
  InterfaceMaintenanceRef,
  JudgmentScope,
  RoleInterface
} from '../../../../packages/mahas-contracts/src/role.ts'
export type {
  ExecutionRecord,
  ResidualResource,
  WorkerJoin
} from '../../../../packages/mahas-contracts/src/work.ts'
export type { ExecutionLiveness } from '../../../../packages/mahas-contracts/src/identity.ts'
