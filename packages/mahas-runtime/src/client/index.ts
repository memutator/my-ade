// mahas-runtime — C-CLIENT boundary (IMP-28).
//
// Server side: registerClientOps(registry, deps) — called once from mahasd's
// composition with the real kernel implementations (see ops.ts header).
// Client side: clientTerminalOpsOverRpc / unavailableClientTerminalOps —
// the desktop IPC seam in src/main/runtimeClient.ts routes these.

export { registerClientOps } from './ops.ts'
export { clientTerminalOpsOverRpc, unavailableClientTerminalOps } from './port.ts'
export { ClientOpError, isClientOpError } from './errors.ts'
export { DEFAULT_INPUT_LEASE_TTL_MS } from './terminal.ts'
export { CLIENT_OPERATION_NAMES } from './types.ts'
export type {
  AppendDomainEventFn,
  AuthorizeFn,
  ClientOpCaller,
  ClientOperationHandler,
  ClientOperationName,
  ClientOperationSpec,
  ClientOpsDeps,
  ClientOpsRegistry,
  ClientTerminalOps,
  ClientTxn,
  ClientViewUnbindResult,
  HostCaller,
  InputLeaseGrant,
  OperationCaller,
  TerminalAttachRequest,
  TerminalAttachResult,
  TerminalDetachRequest,
  TerminalDetachResult,
  TerminalInputIntent,
  TerminalInputRequest,
  TerminalInputResult,
  TerminalResizeRequest,
  TerminalResizeResult,
  TerminalSnapshotRequest,
  TerminalSnapshotResult
} from './types.ts'
