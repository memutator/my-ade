// mahas-runtime — client-side port for the C-CLIENT terminal ops.
//
// This is the desktop-facing twin of ops.ts: the same seven op names, but
// called over an op-name transport (IMP-12's connectRpc caller) instead of
// registered on a registry. Two factories:
//
//   clientTerminalOpsOverRpc(call)  — real ops once a session exists
//   unavailableClientTerminalOps()  — honest CONTROL_UNAVAILABLE until then
//
// Mirrors unavailableClient() in ../client.ts: callers must never learn to
// expect success before a negotiated control session is real (REQ-14/27).

import type {
  ControlError,
  ControlErrorCode,
  ControlResult
} from '../../../mahas-contracts/src/index.ts'
import type {
  ClientOpCaller,
  ClientTerminalOps,
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
} from './types.ts'

/** ErrorCode (canonical) → ControlErrorCode (client port vocabulary) */
function toControlError(e: unknown): ControlError {
  const err = e as { code?: unknown; message?: unknown; retry?: unknown } | null
  const message = typeof err?.message === 'string' ? err.message : 'operation failed without detail'
  const retryable = err?.retry === 'same-operation' || err?.retry === 'reconcile'
  let code: ControlErrorCode = 'UNKNOWN'
  switch (err?.code) {
    case 'SCOPE_DENIED':
    case 'GRANT_REVOKED':
    case 'UNAUTHENTICATED':
      code = 'SCOPE_DENIED'
      break
    case 'STALE_REVISION':
    case 'STALE_EXECUTION':
      code = 'STALE_REVISION'
      break
    case 'OPERATION_CONFLICT':
    case 'RESOURCE_BUSY':
      code = 'CONFLICT'
      break
    case 'CONTROL_UNAVAILABLE':
    case 'HOST_PROTOCOL_MISMATCH':
      code = 'CONTROL_UNAVAILABLE'
      break
    case 'SNAPSHOT_REQUIRED':
      code = 'NOT_FOUND'
      break
    default:
      code = 'UNKNOWN'
  }
  return { code, message, retryable }
}

async function run<T>(
  call: ClientOpCaller,
  operation: string,
  payload: unknown
): Promise<ControlResult<T>> {
  try {
    return { ok: true, value: (await call(operation, payload)) as T }
  } catch (e) {
    return { ok: false, error: toControlError(e) }
  }
}

/** typed C-CLIENT surface over any op-name caller (e.g. connectRpc's call) */
export function clientTerminalOpsOverRpc(call: ClientOpCaller): ClientTerminalOps {
  return {
    terminalAttach: (req: TerminalAttachRequest) =>
      run<TerminalAttachResult>(call, 'terminal.attach', req),
    terminalInput: (req: TerminalInputRequest) =>
      run<TerminalInputResult>(call, 'terminal.input', req),
    terminalResize: (req: TerminalResizeRequest) =>
      run<TerminalResizeResult>(call, 'terminal.resize', req),
    terminalSnapshot: (req: TerminalSnapshotRequest) =>
      run<TerminalSnapshotResult>(call, 'terminal.snapshot', req),
    terminalDetach: (req: TerminalDetachRequest) =>
      run<TerminalDetachResult>(call, 'terminal.detach', req)
  }
}

/**
 * Honest refusal until a control session exists — same contract as
 * unavailableClient() for the exec:* channels.
 */
export function unavailableClientTerminalOps(getDetail: () => string): ClientTerminalOps {
  const refuse = <T>(op: string): Promise<ControlResult<T>> =>
    Promise.resolve({
      ok: false,
      error: {
        code: 'CONTROL_UNAVAILABLE',
        message: `${op}: ${getDetail()}`,
        retryable: true
      }
    })
  return {
    terminalAttach: () => refuse<TerminalAttachResult>('terminal.attach'),
    terminalInput: () => refuse<TerminalInputResult>('terminal.input'),
    terminalResize: () => refuse<TerminalResizeResult>('terminal.resize'),
    terminalSnapshot: () => refuse<TerminalSnapshotResult>('terminal.snapshot'),
    terminalDetach: () => refuse<TerminalDetachResult>('terminal.detach')
  }
}
