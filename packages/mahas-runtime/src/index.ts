// mahas-runtime — control-plane client-side composition.
// The desktop imports bootstrapRuntime from here; the CLI uses the same
// handle for its `status` surface. Service internals (DB, lease, domain
// services) are NOT in this package's scope — they are injected behind the
// handle by IMP-17/IMP-23.

export {
  MAHAS_RUNTIME_PROTOCOL_VERSION,
  MAHASD_ENDPOINT_ENV,
  bootstrapRuntime,
  defaultMahasdEndpoint,
  parseEndpoint
} from './bootstrap.ts'
export type { RuntimeBootstrapOptions, RuntimeHandle } from './bootstrap.ts'
export { unavailableClient, unavailable, controlError } from './client.ts'

// C-CLIENT boundary (IMP-28) — server-side op registration for mahasd's
// composition, plus the desktop-facing typed port the IPC seam routes
export {
  CLIENT_OPERATION_NAMES,
  ClientOpError,
  clientTerminalOpsOverRpc,
  isClientOpError,
  registerClientOps,
  unavailableClientTerminalOps
} from './client/index.ts'
export type {
  ClientOpCaller,
  ClientOpsDeps,
  ClientOpsRegistry,
  ClientTerminalOps,
  ClientTxn,
  TerminalAttachRequest,
  TerminalAttachResult,
  TerminalDetachRequest,
  TerminalDetachResult,
  TerminalInputRequest,
  TerminalInputResult,
  TerminalResizeRequest,
  TerminalResizeResult,
  TerminalSnapshotRequest,
  TerminalSnapshotResult
} from './client/index.ts'
