// mahas-contracts — execution axis aggregation (IMP-02).
//
// spec/domains/execution.md §1: the execution-domain objects are assembled
// here so an execution-boundary implementer can import one module instead
// of hunting across identity/work/resource. The definitions live in their
// canonical modules — this file only re-exports (no second source of truth).
//
// The separation the spec insists on stays visible even in one import:
//   Execution          — the logical execution (identity.ts)
//   ExecutionRecord    — its control-plane ledger row (work.ts)
//   ProcessIncarnation — one OS birth (identity.ts)
//   TerminalRecord     — host-owned terminal, independent of any view
//                        (resource.ts)

export type {
  Execution,
  ExecutionId,
  ExecutionLiveness,
  ExecutionState,
  AgentActivity,
  ProcessIncarnation,
  Terminal,
  TerminalId,
  HostId
} from './identity.ts'

export type {
  RuntimeInstance,
  ExecutionHost,
  ControllerLease,
  ExecutionRecord,
  ExecutionCredential,
  ExecutionCredentialMode,
  NativeConversation,
  LaunchPlan,
  LaunchPlanState,
  LaunchProcessSpec,
  LaunchPlanPins,
  ExecutionReservation,
  InjectionReceipt,
  InjectionPhase,
  InjectionComponentEvidence,
  EvidenceLevel,
  WorkerJoin,
  Dispatch,
  DispatchPhase,
  DispatchAuthorityState
} from './work.ts'

export type {
  TerminalRecord,
  TerminalState,
  InputLease,
  ResourceClaim,
  ClaimMode,
  ClaimState,
  RetentionPin,
  ContentBlob
} from './resource.ts'
