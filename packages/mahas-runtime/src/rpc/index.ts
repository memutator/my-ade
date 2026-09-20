// mahas-runtime rpc — the local collaboration transport boundary (IMP-12).
//
// This is the port every local collaborator connects through: the CLI
// (packages/mahas-cli), the desktop workbench, and any future IPC client all
// use connectRpc; mahasd exposes the same command handler to all of them
// via serveRpc (spec C-ACCESS: one registry, no per-surface command
// dictionaries).

export {
  MAHAS_RPC_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  NdjsonDecoder,
  encodeFrame,
  isMahasError,
  mahasError,
  normalizeError,
  parseFrame,
  requestFromWire
} from './framing.ts'
export type {
  CallFrame,
  ClientFrame,
  ClientHelloFrame,
  ErrorFrame,
  ResultFrame,
  RpcAuthenticate,
  RpcCredential,
  RpcSessionInfo,
  ServerFrame,
  ServerHelloFrame,
  ServerHelloOkFrame,
  ServerHelloErrorFrame
} from './framing.ts'

export { serveRpc } from './local-server.ts'
export type { OperationDispatcher, RpcServer, RpcServerHandle } from './local-server.ts'

export { connectRpc } from './client.ts'
export type { RpcCallOptions, RpcClient } from './client.ts'

export {
  MAHAS_CONNECTION_FILE_ENV,
  MAHAS_OPERATOR_FILE_ENV,
  MAHAS_ROLE_ENV,
  OPERATOR_CONNECTION_FILENAME,
  WORKER_CONNECTION_FILENAME,
  defaultOperatorConnectionFile,
  defaultWorkerConnectionFile,
  mahasdOperatorEndpoint,
  mahasdWorkerEndpoint,
  resolveMahasConfigDir
} from './endpoints.ts'

export { readWorkerConnectionFile, redactCredential, workerConnectionPath } from './worker-auth.ts'
export type { WorkerConnectionFile, WorkerCredential } from './worker-auth.ts'

export { operatorConnectionPath, readOperatorConnectionFile } from './operator-auth.ts'
export type { OperatorConnectionFile, OperatorCredential } from './operator-auth.ts'

export { defaultPrincipalScope, registerOperationGet, OPERATION_GET_SPEC } from './operation-get.ts'
export type {
  OperationGetDeps,
  OperationRegistrar,
  PrincipalScopeOf,
  ReceiptLookup
} from './operation-get.ts'
