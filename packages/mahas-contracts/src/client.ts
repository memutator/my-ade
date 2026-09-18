// mahas-contracts — the runtime client port.
//
// This is the surface the desktop (and later the CLI) uses to talk to the
// control plane. It is deliberately a PORT, not a protocol: IMP-17/IMP-23
// inject the real transport (versioned ExecutionHost RPC + authenticated
// control channel) behind this shape, and the domain contracts (C-LAUNCH,
// C-HOST, C-CLIENT, C-RECOVERY) own the operation semantics. Until a
// session is negotiated every operation must answer CONTROL_UNAVAILABLE —
// never a fabricated success (REQ-14/REQ-27).

import type { Execution, ExecutionId, OperationId } from './identity.ts'
import type { BindViewRequest, ClientViewBinding, UnbindViewRequest } from './binding.ts'
import type { ServiceStatus, ShutdownAck, ShutdownRequest } from './service.ts'

/** stable rejection vocabulary — mirrors the C-* contracts' named refusals */
export type ControlErrorCode =
  | 'CONTROL_UNAVAILABLE'
  | 'SCOPE_DENIED'
  | 'STALE_REVISION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_ARGUMENT'
  | 'UNKNOWN'

export interface ControlError {
  code: ControlErrorCode
  message: string
  /** true when retrying the SAME operationId may still succeed (unknown outcome) */
  retryable?: boolean
}

export type ControlResult<T> = { ok: true; value: T } | { ok: false; error: ControlError }

/** D-EXEC §4 primitive spawn shape — argv array + cwd + explicit env allowlist */
export interface ProcessSpec {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  /** request a PTY-backed terminal with initial size; absent = pipes process */
  terminal?: { cols: number; rows: number }
}

/**
 * Managed-execution creation request. This is the ONLY route a managed
 * Execution may be created through (feature boundary, IMP-01 §4.3) — a
 * plain terminal keeps using the unmanaged pty path and can never become
 * an Execution by accident.
 */
export interface CreateExecutionRequest {
  /** REQ-14 — idempotency key, required on every mutation */
  operationId: OperationId
  memberId?: string
  launchPlanId?: string
  process: ProcessSpec
  purpose?: 'work' | 'verification'
}

export interface ExecutionQuery {
  executionId?: ExecutionId
  memberId?: string
  state?: Execution['state']
}

/**
 * The client-side runtime port. Implementations: mahas-runtime's bootstrap
 * (honest CONTROL_UNAVAILABLE until a control session exists) → IMP-17/23's
 * negotiated session transport.
 */
export interface RuntimeClient {
  /** current readiness of the control-plane endpoint */
  status(): Promise<ControlResult<ServiceStatus>>

  /** managed executions — create/query only ever flow through this port */
  createExecution(req: CreateExecutionRequest): Promise<ControlResult<Execution>>
  getExecution(id: ExecutionId): Promise<ControlResult<Execution | null>>
  listExecutions(query?: ExecutionQuery): Promise<ControlResult<Execution[]>>

  /** C-CLIENT client.view.bind / unbind */
  bindView(req: BindViewRequest): Promise<ControlResult<ClientViewBinding>>
  unbindView(req: UnbindViewRequest): Promise<ControlResult<null>>

  /**
   * Shutdown-request forwarding port (spec §5). 'drain-and-stop' and
   * 'leave-executions' are the only modes; UI close must never reach here —
   * UI close is a detach, which is disconnect(), not a shutdown request.
   */
  requestShutdown(req: ShutdownRequest): Promise<ControlResult<ShutdownAck>>

  /** drop this client's connection; changes nothing on the service side */
  disconnect(): Promise<void>
}
