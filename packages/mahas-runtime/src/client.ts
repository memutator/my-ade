// mahas-runtime — RuntimeClient implementations.
//
// There is exactly one honest client today: one that reports the real
// endpoint status and answers CONTROL_UNAVAILABLE for every operation that
// needs a negotiated control session. IMP-17 (service lifetime) and
// IMP-23 (recovery/reattach) replace `unavailableClient` with a transport
// that actually performs the C-* operations — callers must not learn to
// expect success from this seam.

import type {
  ControlError,
  ControlResult,
  Execution,
  ClientViewBinding,
  RuntimeClient,
  ServiceStatus,
  ShutdownAck
} from '../../mahas-contracts/src/index.ts'

export function controlError(
  code: ControlError['code'],
  message: string,
  retryable = false
): ControlError {
  return { code, message, retryable }
}

export function unavailable<T>(detail: string): ControlResult<T> {
  return { ok: false, error: controlError('CONTROL_UNAVAILABLE', detail, true) }
}

/**
 * A RuntimeClient whose mutation/query operations honestly refuse: there is
 * no control session, so no execution can be created, looked up, bound or
 * shut down through it. status() still answers truthfully — that much the
 * bootstrap can verify on its own.
 */
export function unavailableClient(getStatus: () => ServiceStatus): RuntimeClient {
  const refuse = <T>(op: string): Promise<ControlResult<T>> =>
    Promise.resolve(
      unavailable(
        `${op}: no control-plane session — the endpoint at ` +
          `${getStatus().endpoint?.address ?? '(unresolved)'} is not serving ` +
          `negotiated RPC yet (service lifetime lands in IMP-17, recovery in IMP-23)`
      )
    )
  return {
    status: () => Promise.resolve({ ok: true, value: getStatus() }),
    createExecution: () => refuse<Execution>('executions.create'),
    getExecution: () => refuse<Execution | null>('executions.get'),
    listExecutions: () => refuse<Execution[]>('executions.list'),
    bindView: () => refuse<ClientViewBinding>('client.view.bind'),
    unbindView: () => refuse<null>('client.view.unbind'),
    requestShutdown: () => refuse<ShutdownAck>('runtime.shutdown'),
    disconnect: () => Promise.resolve()
  }
}
