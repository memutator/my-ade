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
