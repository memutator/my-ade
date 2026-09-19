import { randomUUID } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import type {
  CommandReceipt,
  CommandRequest,
  ErrorCode,
  ErrorRetry,
  MahasError
} from '../../mahas-contracts/src/index.ts'

export const MAHAS_RPC_PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

export type RpcCredential = unknown

export interface RpcCallOptions {
  operationId?: string
  expectedRevisions?: Record<string, number>
}

export interface RpcClient {
  readonly endpoint: string
  readonly transportSessionId: string
  readonly principalId: string
  readonly protocolVersion: number
  call(op: string, payload?: unknown, opts?: RpcCallOptions): Promise<CommandReceipt>
  close(): void
}

export type RpcConnector = (endpoint: string, credential: RpcCredential) => Promise<RpcClient>

interface PendingCall {
  resolve: (receipt: CommandReceipt) => void
  reject: (error: MahasError) => void
}

function mahasError(
  code: ErrorCode,
  message: string,
  retry: ErrorRetry = 'none',
  details?: unknown
): MahasError {
  return details === undefined ? { code, message, retry } : { code, message, retry, details }
}

function normalizeError(value: unknown, fallback: MahasError): MahasError {
  if (typeof value !== 'object' || value === null) return fallback
  const error = value as Record<string, unknown>
  if (typeof error.code !== 'string') return fallback
  const retries = ['none', 'same-operation', 'reconcile', 'replan']
  return {
    code: error.code as ErrorCode,
    message: typeof error.message === 'string' ? error.message : error.code,
    retry: (retries.includes(String(error.retry)) ? error.retry : 'none') as ErrorRetry,
    ...(error.details === undefined ? {} : { details: error.details })
  }
}

function unavailable(endpoint: string, detail: string): MahasError {
  return mahasError('CONTROL_UNAVAILABLE', `mahasd at ${endpoint}: ${detail}`, 'same-operation')
}

class Decoder {
  private buffered = ''
  private readonly onLine: (line: string) => void
  private readonly onOverflow: () => void

  constructor(onLine: (line: string) => void, onOverflow: () => void) {
    this.onLine = onLine
    this.onOverflow = onOverflow
  }

  feed(chunk: Uint8Array): void {
    this.buffered += Buffer.from(chunk).toString('utf8')
    for (;;) {
      const newline = this.buffered.indexOf('\n')
      if (newline < 0) {
        if (Buffer.byteLength(this.buffered, 'utf8') > MAX_FRAME_BYTES) {
          this.buffered = ''
          this.onOverflow()
        }
        return
      }
      const line = this.buffered.slice(0, newline)
      this.buffered = this.buffered.slice(newline + 1)
      if (line) this.onLine(line)
    }
  }
}

/**
 * Open one authenticated RPC session. Calls are never automatically resent:
 * a socket loss rejects the in-flight call so its operationId can be
 * reconciled explicitly through operation.get.
 */
export function connectRpc(
  endpoint: string,
  credential: RpcCredential,
  handshakeTimeoutMs = 10_000
): Promise<RpcClient> {
  return new Promise<RpcClient>((resolve, reject) => {
    let socket: Socket
    try {
      socket = connect(endpoint)
    } catch (error) {
      reject(unavailable(endpoint, `connect failed: ${String(error)}`))
      return
    }

    const pending = new Map<number, PendingCall>()
    let nextRequestId = 1
    let authenticated = false
    let closed = false

    const failPending = (error: MahasError): void => {
      for (const call of pending.values()) call.reject(error)
      pending.clear()
    }
    const teardown = (error?: MahasError): void => {
      if (closed) return
      closed = true
      failPending(error ?? unavailable(endpoint, 'connection closed'))
      socket.destroy()
    }
    const timer = setTimeout(() => {
      if (!authenticated) {
        teardown()
        reject(unavailable(endpoint, 'hello handshake timed out'))
      }
    }, handshakeTimeoutMs)

    let resolvedClient: RpcClient | null = null
    const decoder = new Decoder(
      (line) => {
        let frame: Record<string, unknown>
        try {
          const parsed = JSON.parse(line) as unknown
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
          frame = parsed as Record<string, unknown>
        } catch {
          const error = mahasError('MODEL_INVALID', 'unparseable RPC frame')
          teardown(error)
          if (!authenticated) reject(error)
          return
        }
        if (!authenticated) {
          clearTimeout(timer)
          if (frame.kind !== 'hello-ok') {
            const error = normalizeError(
              frame.error,
              mahasError('UNAUTHENTICATED', 'handshake refused')
            )
            teardown(error)
            reject(error)
            return
          }
          authenticated = true
          const transportSessionId = String(frame.transportSessionId ?? '')
          const principalId = String(frame.principalId ?? '')
          const protocolVersion = Number(frame.protocolVersion ?? 0)
          resolvedClient = {
            endpoint,
            transportSessionId,
            principalId,
            protocolVersion,
            call(operation, payload, opts) {
              if (closed || socket.destroyed) {
                return Promise.reject(
                  unavailable(
                    endpoint,
                    'client is closed; the operation was not resent — reconcile with the same operationId'
                  )
                )
              }
              const requestId = nextRequestId++
              const request: CommandRequest = {
                protocolVersion: String(protocolVersion),
                operation,
                operationId: opts?.operationId ?? randomUUID(),
                expectedRevisions: opts?.expectedRevisions,
                payload
              }
              return new Promise<CommandReceipt>((callResolve, callReject) => {
                pending.set(requestId, { resolve: callResolve, reject: callReject })
                socket.write(JSON.stringify({ kind: 'call', requestId, request }) + '\n')
              })
            },
            close: () => teardown(unavailable(endpoint, 'client closed by caller'))
          }
          resolve(resolvedClient)
          return
        }

        const requestId = typeof frame.requestId === 'number' ? frame.requestId : null
        if (requestId === null) return
        const call = pending.get(requestId)
        if (!call) return
        pending.delete(requestId)
        if (frame.kind === 'result') {
          call.resolve(frame.receipt as CommandReceipt)
        } else if (frame.kind === 'error') {
          call.reject(normalizeError(frame.error, mahasError('MODEL_INVALID', 'invalid RPC call')))
        }
      },
      () => teardown(mahasError('MODEL_INVALID', 'oversized frame from server'))
    )

    socket.on('data', (chunk) => decoder.feed(chunk))
    socket.on('connect', () => {
      socket.write(
        JSON.stringify({ kind: 'hello', protocolVersion: MAHAS_RPC_PROTOCOL_VERSION, credential }) +
          '\n'
      )
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      const failure = unavailable(endpoint, error.message || 'socket error')
      teardown(failure)
      if (!authenticated) reject(failure)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      const failure = unavailable(
        endpoint,
        authenticated ? 'socket closed mid-session' : 'socket closed before hello completed'
      )
      teardown(failure)
      if (!authenticated) reject(failure)
    })
  })
}
