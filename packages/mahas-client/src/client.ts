import type {
  BindViewRequest,
  ClientViewBinding,
  CommandReceipt,
  ControlError,
  ControlResult,
  CreateExecutionRequest,
  Execution,
  ExecutionQuery,
  RuntimeClient,
  ServiceEndpoint,
  ServiceStatus,
  ShutdownAck,
  ShutdownRequest,
  UnbindViewRequest
} from '../../mahas-contracts/src/index.ts'
import { connectRpc, type RpcCallOptions, type RpcClient, type RpcConnector } from './rpc.ts'
import { resolveOperatorConnection, type OperatorConnectionOptions } from './connection.ts'

export function receiptToControl<T>(receipt: CommandReceipt): ControlResult<T> {
  if (receipt.status === 'committed') return { ok: true, value: receipt.result as T }
  const rawCode = receipt.error?.code ?? 'UNKNOWN'
  // ControlError's older public union is narrower than the canonical receipt
  // vocabulary. Preserve the daemon's code at runtime instead of flattening
  // e.g. UNAVAILABLE_OPERATION or SNAPSHOT_REQUIRED into UNKNOWN.
  const code = rawCode as ControlError['code']
  const indeterminate = receipt.status === 'pending' || receipt.status === 'unknown'
  return {
    ok: false,
    error: {
      code,
      message:
        receipt.error?.message ??
        (indeterminate
          ? `${receipt.status}: outcome not yet known for operation ${receipt.operationId}`
          : `operation ${receipt.operationId} was ${receipt.status}`),
      retryable:
        indeterminate ||
        receipt.error?.retry === 'same-operation' ||
        receipt.error?.retry === 'reconcile'
    }
  }
}

export interface MahasClient extends RuntimeClient {
  readonly endpoint: ServiceEndpoint
  call(operation: string, payload?: unknown, options?: RpcCallOptions): Promise<CommandReceipt>
  currentStatus(): ServiceStatus
  refresh(): Promise<ServiceStatus>
}

export interface MahasClientOptions extends OperatorConnectionOptions {
  connector?: RpcConnector
  now?: () => number
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const value = error as Record<string, unknown>
    if (typeof value.message === 'string') {
      return typeof value.code === 'string' ? `${value.code}: ${value.message}` : value.message
    }
  }
  return String(error)
}

function provesProtocolPeer(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as Record<string, unknown>).code
  return code === 'UNAUTHENTICATED' || code === 'HOST_PROTOCOL_MISMATCH'
}

interface ExecutionSnapshot {
  entities?: {
    executions?: Array<{
      id: string
      memberId?: string
      generation?: number
      hostId?: string
      state: Execution['state']
      liveness?: Execution['liveness']
      terminalId?: string | null
    }>
  }
}

function executionsFromSnapshot(value: ExecutionSnapshot): Execution[] | null {
  const rows = value.entities?.executions
  if (!Array.isArray(rows)) return null
  return rows.map((row) => ({
    id: row.id,
    memberId: row.memberId,
    generation: row.generation,
    hostId: row.hostId,
    state: row.state,
    liveness: row.liveness,
    ...(row.terminalId ? { terminalId: row.terminalId } : {})
  }))
}

export function createMahasClient(options: MahasClientOptions): MahasClient {
  const connector = options.connector ?? connectRpc
  const now = options.now ?? Date.now
  const endpoint: ServiceEndpoint = {
    kind: 'unix-socket',
    address: options.endpoint ?? process.env.MAHASD_ENDPOINT ?? `${options.configDir}/mahasd.sock`,
    service: 'mahasd'
  }
  let rpc: RpcClient | null = null
  let connecting: Promise<RpcClient> | null = null
  let closed = false
  let status: ServiceStatus = {
    service: 'mahasd',
    readiness: 'unavailable',
    endpoint,
    detail: 'no authenticated control-plane session',
    checkedAt: now()
  }

  const update = (readiness: ServiceStatus['readiness'], detail: string): ServiceStatus => {
    status = { service: 'mahasd', readiness, endpoint, detail, checkedAt: now() }
    return status
  }
  const drop = (): void => {
    try {
      rpc?.close()
    } catch {
      // already closed
    }
    rpc = null
  }
  const session = async (): Promise<RpcClient> => {
    if (closed) throw new Error('mahas client is disconnected')
    if (rpc) return rpc
    if (connecting) return connecting
    connecting = (async () => {
      const resolved = await resolveOperatorConnection(options)
      endpoint.address = resolved.endpoint
      const connected = await connector(resolved.endpoint, resolved.credential)
      rpc = connected
      update(
        'degraded',
        `authenticated as ${connected.principalId}; runtime readiness has not been checked`
      )
      return connected
    })()
    try {
      return await connecting
    } catch (error) {
      update(provesProtocolPeer(error) ? 'degraded' : 'unavailable', failureMessage(error))
      throw error
    } finally {
      connecting = null
    }
  }
  const call = async (
    operation: string,
    payload?: unknown,
    callOptions?: RpcCallOptions
  ): Promise<CommandReceipt> => {
    const connected = await session()
    try {
      return await connected.call(operation, payload, callOptions)
    } catch (error) {
      // The failed call is not retried. Only the next independent call may
      // establish a fresh session; mutations reconcile by operationId.
      drop()
      update(provesProtocolPeer(error) ? 'degraded' : 'unavailable', failureMessage(error))
      throw error
    }
  }
  const asControl = async <T>(
    operation: string,
    payload?: unknown,
    callOptions?: RpcCallOptions
  ): Promise<ControlResult<T>> => {
    try {
      return receiptToControl<T>(await call(operation, payload, callOptions))
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'CONTROL_UNAVAILABLE',
          message: failureMessage(error),
          retryable: true
        }
      }
    }
  }
  const listExecutions = async (query?: ExecutionQuery): Promise<ControlResult<Execution[]>> => {
    const snapshot = await asControl<ExecutionSnapshot>('runtime.snapshot', {
      ...(query?.executionId ? { executionId: query.executionId } : {}),
      ...(query?.memberId ? { memberId: query.memberId } : {})
    })
    if (!snapshot.ok) return snapshot
    const executions = executionsFromSnapshot(snapshot.value)
    if (!executions) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN',
          message: 'runtime.snapshot did not contain an executions projection'
        }
      }
    }
    return {
      ok: true,
      value: executions.filter(
        (execution) =>
          (!query?.executionId || execution.id === query.executionId) &&
          (!query?.memberId || execution.memberId === query.memberId) &&
          (!query?.state || execution.state === query.state)
      )
    }
  }

  const client: MahasClient = {
    endpoint,
    call,
    currentStatus: () => status,
    async refresh() {
      if (closed) return update('stopped', 'client disconnected')
      try {
        const result = receiptToControl<
          Partial<ServiceStatus> & { state?: string; writableReady?: boolean }
        >(await call('runtime.status', {}))
        if (!result.ok) return update('degraded', result.error.message)
        const reported = result.value
        const knownReadiness = [
          'starting',
          'ready',
          'degraded',
          'unavailable',
          'unverifiable',
          'stopped'
        ].includes(String(reported.readiness ?? reported.state))
          ? (reported.readiness ?? reported.state)
          : undefined
        const readiness =
          reported.writableReady === true
            ? 'ready'
            : reported.writableReady === false
              ? 'degraded'
              : (knownReadiness ?? 'ready')
        status = {
          service: 'mahasd',
          readiness: readiness as ServiceStatus['readiness'],
          endpoint,
          detail: reported.detail ?? 'authenticated runtime.status completed',
          checkedAt: now()
        }
        return status
      } catch (error) {
        return update(provesProtocolPeer(error) ? 'degraded' : 'unavailable', failureMessage(error))
      }
    },
    status: async () => ({ ok: true, value: await client.refresh() }),
    createExecution: (req: CreateExecutionRequest): Promise<ControlResult<Execution>> =>
      asControl('executions.create', req, { operationId: req.operationId }),
    getExecution: async (id): Promise<ControlResult<Execution | null>> => {
      const listed = await listExecutions({ executionId: id })
      return listed.ok ? { ok: true, value: listed.value[0] ?? null } : listed
    },
    listExecutions,
    bindView: (req: BindViewRequest): Promise<ControlResult<ClientViewBinding>> =>
      asControl('client.view.bind', req, { operationId: req.operationId }),
    unbindView: (req: UnbindViewRequest): Promise<ControlResult<null>> =>
      asControl('client.view.unbind', req, { operationId: req.operationId }),
    requestShutdown: (req: ShutdownRequest): Promise<ControlResult<ShutdownAck>> =>
      asControl('runtime.shutdown', req, { operationId: req.operationId }),
    async disconnect() {
      closed = true
      drop()
      update('stopped', 'client disconnected')
    }
  }
  return client
}
