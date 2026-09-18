// mahas-contracts — the shared contract port.
//
// The ONLY packages/* module the renderer and preload may import, and the
// only dependency every other package shares (packages/README.md documents
// the enforced direction). Everything exported here is a pure type or a
// pure constant — no I/O, no Node APIs — so a type import in the renderer
// can never smuggle control-plane internals into a view.

export type {
  MemberId,
  ExecutionId,
  TerminalId,
  TaskId,
  DispatchId,
  NativeConversationId,
  ViewId,
  HostId,
  OperationId,
  ExecutionLiveness,
  ExecutionState,
  AgentActivity,
  ProcessIncarnation,
  Execution,
  Terminal
} from './identity.ts'

export type {
  ServiceEndpoint,
  ServiceReadiness,
  ServiceStatus,
  ShutdownMode,
  ShutdownRequest,
  ShutdownAck
} from './service.ts'

export type {
  ExecutionBinding,
  BindViewRequest,
  UnbindViewRequest,
  ClientViewBinding
} from './binding.ts'

export type {
  ControlErrorCode,
  ControlError,
  ControlResult,
  ProcessSpec,
  CreateExecutionRequest,
  ExecutionQuery,
  RuntimeClient
} from './client.ts'

export type {
  Id,
  Revision,
  ModelVersionId,
  RoleInterfaceDigest,
  ImplementationRevision,
  BundleDigest,
  TaskRevision,
  PlanRevision,
  ExecutionGeneration,
  ControllerEpoch,
  HostIncarnation,
  ContentRef,
  ArtifactRef,
  PathRef,
  JsonObject,
  JsonValue,
  WireFieldPolicy,
  CommandRequest,
  AuthenticatedContext,
  ReceiptStatus,
  CommandReceipt,
  ErrorRetry,
  MahasError,
  ErrorCode,
  QueryResult,
  EffectState,
  EffectIntent,
  EffectReceipt
} from './common.ts'
export { WIRE_FIELD_POLICY } from './common.ts'

// domain entity id vocabulary (ids.ts) — re-exported flat so consumers keep
// importing every canonical name from this one path
export type {
  EpochMillis,
  ProjectId,
  BoundaryId,
  CriterionId,
  RoleId,
  RddContextId,
  RddContractId,
  NonGoalId,
  ModelChangeId,
  ImplementationId,
  HarnessProfileId,
  ComponentId,
  ClauseId,
  PrincipalId,
  RolePolicyId,
  GrantId,
  AuthorizationDecisionId,
  RunId,
  AssignmentId,
  PlanCandidateId,
  RuntimeInstanceId,
  LaunchPlanId,
  ExecutionCredentialId,
  HandoffId,
  MessageId,
  DeliveryId,
  WakeRequestId,
  ArtifactId,
  OutcomeId,
  SettlementId,
  RunDecisionId,
  ResourceId,
  CheckoutId,
  WorkspaceId,
  ResourceClaimId,
  ResourceTransferId,
  RetentionPinId,
  ObservationId,
  InterventionId,
  ClientId,
  ClientViewBindingId,
  ResumeCandidateId,
  ImpactCandidateId,
  BackupSetId,
  SupportAttestationId,
  MigrationReceiptId,
  SubscriptionStreamId
} from './ids.ts'

export type {
  Project,
  ModelVersionStatus,
  ModelVersion,
  Boundary,
  Criterion,
  BoundaryPathKind,
  BoundaryPath,
  BoundaryEdge,
  HorizontalRole,
  Role,
  RddContext,
  BoundaryContext,
  HorizontalContext,
  RddContract,
  ContractConsumer,
  NonGoal,
  ModelChangeState,
  ModelChangeTargetKind,
  ModelChangeTarget,
  DiagnosticSeverity,
  ModelDiagnostic,
  ModelChangeEdit,
  ModelChange,
  SearchRow
} from './rdd.ts'

export type {
  CriterionRef,
  DeliveryClass,
  ContextRequirement,
  RoleInterfaceRequirements,
  JudgmentScope,
  RoleInterface,
  AdmissionState,
  HarnessRecipe,
  HarnessCapabilities,
  ExecutableIdentity,
  HarnessProfile,
  ImplementationStatus,
  RoleImplementation,
  ComponentKind,
  ComponentBinding,
  Realization,
  CoverageBinding,
  ImplementationComponent,
  MaintenanceBinding,
  BundleManifest,
  SourceObservation,
  ContextBundle
} from './role.ts'

export type {
  PrincipalKind,
  Principal,
  PolicySelector,
  ActionCeiling,
  ProjectionPolicy,
  RolePolicy,
  GrantKind,
  GrantScope,
  GrantAction,
  AssignmentGrant,
  ProvisioningGrant,
  ContinuationGrant,
  Grant,
  SurfaceOperationDescriptor,
  SurfaceActionsAndSchemas,
  SurfacePolicyPins,
  CommandSurface,
  AuthorizationTarget,
  AuthorizationDecision
} from './access.ts'

export type {
  RunPurpose,
  RunState,
  Run,
  MemberState,
  Member,
  AssignmentKind,
  AssignmentScope,
  Assignment,
  PlanDisposition,
  Plan,
  PlanCandidate,
  TaskDisplayState,
  BindingKind,
  InputBinding,
  OutputSlot,
  SettlementPolicy,
  TaskSpec,
  TaskEdgeRequirements,
  TaskEdge,
  DispatchPhase,
  DispatchAuthorityState,
  Dispatch,
  AttemptObservation,
  ResidualResource,
  RuntimeInstance,
  ExecutionHostState,
  ExecutionHost,
  ControllerLease,
  ExecutionRecord,
  NativeConversation,
  ExecutionCredentialMode,
  ExecutionCredential,
  WorkEnvelope,
  ExecutionReservation,
  LaunchProcessSpec,
  LaunchPlanPins,
  LaunchPlanState,
  LaunchPlan,
  InjectionPhase,
  InjectionComponentEvidence,
  EvidenceLevel,
  InjectionReceipt,
  WorkerJoin,
  HandoffBinding,
  Handoff
} from './work.ts'

export type {
  MessageKind,
  MessageLinks,
  Message,
  DeliveryStatus,
  DeliveryHandling,
  Delivery,
  InboxRead,
  WakeState,
  WakeRoute,
  WakeRequest,
  ArtifactStorageRef,
  Artifact,
  OutcomeResult,
  CriterionAssessment,
  Outcome,
  OutcomeOutput,
  SettlementDecision,
  Settlement,
  RunDecision
} from './mail.ts'

export type {
  ResourceKind,
  Resource,
  CheckoutState,
  RepositoryIdentity,
  Checkout,
  WorkspaceKind,
  WorkspaceState,
  Workspace,
  ClaimMode,
  ClaimState,
  ClaimOwnerKind,
  ResourceClaim,
  TransferState,
  ResourceTransfer,
  TerminalState,
  TerminalRecord,
  InputLease,
  RetentionPin,
  ContentBlob
} from './resource.ts'

export type {
  ObservationSource,
  ConfidenceClass,
  Observation,
  DomainEvent,
  InterventionKind,
  InterventionState,
  Intervention,
  ResumeSupportState,
  ResumeCandidate,
  ImpactState,
  ImpactCandidate,
  MigrationReceipt,
  BackupSet,
  RuntimeShutdown,
  SupportAttestation
} from './observation.ts'

export type {
  ModelOperationName,
  DiscoveryOperationName,
  RealizationOperationName,
  AccessOperationName,
  WorkOperationName,
  MailOperationName,
  LaunchOperationName,
  HostOperationName,
  ResourceOperationName,
  RecoveryOperationName,
  ObservationOperationName,
  ClientOperationName
} from './ops.ts'
export {
  MODEL_OPERATION_NAMES,
  DISCOVERY_OPERATION_NAMES,
  REALIZATION_OPERATION_NAMES,
  ACCESS_OPERATION_NAMES,
  WORK_OPERATION_NAMES,
  MAIL_OPERATION_NAMES,
  LAUNCH_OPERATION_NAMES,
  HOST_OPERATION_NAMES,
  RESOURCE_OPERATION_NAMES,
  RECOVERY_OPERATION_NAMES,
  OBSERVATION_OPERATION_NAMES,
  CLIENT_OPERATION_NAMES,
  OPERATION_NAMES
} from './ops.ts'
