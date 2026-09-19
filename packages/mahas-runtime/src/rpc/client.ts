// mahas-runtime rpc — connectRpc, the client every local collaborator uses.
//
// One socket, one authenticated session. The client sends hello with its
// credential, waits for the server's verified hello-ok, then multiplexes
// CommandRequest→CommandReceipt calls on requestId.
//
// REQ-14 honesty rules wired here:
//   - call() never auto-resends: a socket drop or timeout leaves the
//     operationId with the CALLER, who reconciles via operation.get — the
//     client will not mint a fresh id and retry a mutation behind anyone's
//     back;
//   - call() resolves the whole CommandReceipt (committed | rejected |
//     pending | unknown) — transport does not flatten that into success;
//   - a failed connect/handshake rejects with CONTROL_UNAVAILABLE (or the
//     server's own auth error), never with a fake acceptance.

import { connect, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import type {
  CommandReceipt,
  CommandRequest,
  MahasError
} from '../../../mahas-contracts/src/index.ts'
import {
  encodeFrame,
  mahasError,
  normalizeError,
  MAHAS_RPC_PROTOCOL_VERSION,
  NdjsonDecoder,
  parseFrame,
  type ClientHelloFrame,
  type ErrorFrame,
  type ResultFrame,
  type RpcCredential,
  type ServerHelloFrame
} from './framing.ts'

/** ms to wait for connect+hello before declaring the endpoint unavailable */
const HANDSHAKE_TIMEOUT_MS = 10_000

export interface RpcCallOptions {
  /**
   * caller-chosen idempotency id. Omit for a fresh operation; pass the SAME
   * id to re-ask after an ambiguous outcome — the server returns the stored
   * receipt for same-key/same-payload instead of re-executing (§3).
   */
  operationId?: string
  expectedRevisions?: Record<string, number>
}

/**
 * The collaboration client. `call` resolves the CommandReceipt — inspect
 * `receipt.status`/`receipt.error`; the transport never collapses rejected
 * or unknown into success or into an exception.
 */
export interface RpcClient {
  readonly endpoint: string
  /** server-minted session id from hello-ok */
  readonly transportSessionId: string
  /** principal the server verified for this credential */
  readonly principalId: string
  /** negotiated wire version */
  readonly protocolVersion: number
  call(op: string, payload?: unknown, opts?: RpcCallOptions): Promise<CommandReceipt>
  close(): void
}

interface PendingCall {
  resolve: (receipt: CommandReceipt) => void
  reject: (error: MahasError) => void
}

function controlUnavailable(endpoint: string, detail: string): MahasError {
  return mahasError('CONTROL_UNAVAILABLE', `mahasd at ${endpoint}: ${detail}`, 'same-operation')
}

/**
 * Connect, authenticate, and return the session client. Rejects with a
 * MahasError-shaped object: CONTROL_UNAVAILABLE when the endpoint cannot be
 * reached, the server's own error when the credential is refused
 * (UNAUTHENTICATED), HOST_PROTOCOL_MISMATCH on version failure.
 */
export function connectRpc(endpoint: string, credential: RpcCredential): Promise<RpcClient> {
  return new Promise<RpcClient>((resolve, reject) => {
    let sock: Socket
    try {
      sock = connect(endpoint)
    } catch (e) {
      reject(controlUnavailable(endpoint, `connect failed: ${(e as Error).message}`))
      return
    }

    const pending = new Map<number, PendingCall>()
    let nextRequestId = 1
    let settled = false // handshake complete?
    let closed = false
    let negotiated = 0
    let transportSessionId = ''
    let principalId = ''

    const failPending = (error: MahasError): void => {
      for (const p of pending.values()) p.reject(error)
      pending.clear()
    }

    const teardown = (error: MahasError | null): void => {
      if (closed) return
      closed = true
      failPending(error ?? controlUnavailable(endpoint, 'connection closed'))
      sock.destroy()
    }

    const handshakeTimer = setTimeout(() => {
      if (!settled) {
        teardown(null)
        reject(controlUnavailable(endpoint, 'hello handshake timed out'))
      }
    }, HANDSHAKE_TIMEOUT_MS)

    const decoder = new NdjsonDecoder(
      (line) => void onLine(line),
      () => {
        if (!settled) {
          teardown(null)
          reject(mahasError('MODEL_INVALID', 'oversized frame during handshake'))
        } else {
          teardown(mahasError('MODEL_INVALID', 'oversized frame from server'))
        }
      }
    )

    sock.on('data', (chunk) => decoder.feed(chunk))
    sock.on('error', (e) => {
      if (!settled) {
        clearTimeout(handshakeTimer)
        teardown(null)
        reject(
          controlUnavailable(endpoint, (e as NodeJS.ErrnoException).message ?? 'connect error')
        )
      } else {
        teardown(controlUnavailable(endpoint, 'socket error mid-session'))
      }
    })
    sock.on('close', () => {
      if (!settled) {
        clearTimeout(handshakeTimer)
        teardown(null)
        reject(controlUnavailable(endpoint, 'socket closed before hello completed'))
      } else {
        teardown(controlUnavailable(endpoint, 'socket closed mid-session'))
      }
    })
    sock.on('connect', () => {
      const hello: ClientHelloFrame = {
        kind: 'hello',
        protocolVersion: MAHAS_RPC_PROTOCOL_VERSION,
        credential
      }
      sock.write(encodeFrame(hello))
    })

    async function onLine(line: string): Promise<void> {
      const parsed = parseFrame(line)
      if (!parsed.ok) {
        teardown(parsed.error)
        if (!settled) reject(parsed.error)
        return
      }
      const frame = parsed.frame
      if (!settled) {
        onHello(frame as unknown as ServerHelloFrame)
        return
      }
      onServerFrame(frame)
    }

    function onHello(frame: ServerHelloFrame): void {
      clearTimeout(handshakeTimer)
      if (frame.kind === 'hello-ok') {
        settled = true
        negotiated = frame.protocolVersion
        transportSessionId = frame.transportSessionId
        principalId = frame.principalId
        resolve(client())
        return
      }
      const error =
        frame.kind === 'hello-error'
          ? normalizeError(frame.error, mahasError('UNAUTHENTICATED', 'handshake refused'))
          : mahasError('UNAUTHENTICATED', 'handshake refused')
      teardown(null)
      reject(error)
    }

    function onServerFrame(frame: Record<string, unknown>): void {
      const requestId = typeof frame.requestId === 'number' ? frame.requestId : null
      if (frame.kind === 'result') {
        const f = frame as unknown as ResultFrame
        const p = requestId === null ? undefined : pending.get(requestId!)
        if (p) {
          pending.delete(requestId!)
          p.resolve(f.receipt)
        }
        // a result with no pending call is unsolicited — ignore (no queue jump)
        return
      }
      if (frame.kind === 'error') {
        const f = frame as unknown as ErrorFrame
        if (f.requestId !== null) {
          const p = pending.get(f.requestId)
          if (p) {
            pending.delete(f.requestId)
            p.reject(f.error)
          }
        }
        // connection-scope transport errors carry no requestId — the socket
        // stays usable; nothing to do beyond dropping the bad frame
        return
      }
      // unknown frame kinds are ignored — forward-compat, never dispatched
    }

    function client(): RpcClient {
      return {
        endpoint,
        transportSessionId,
        principalId,
        protocolVersion: negotiated,
        call(op, payload, opts): Promise<CommandReceipt> {
          if (closed || sock.destroyed) {
            return Promise.reject(
              controlUnavailable(
                endpoint,
                'client is closed — the operationId was NOT sent; reconcile via operation.get'
              )
            )
          }
          const requestId = nextRequestId++
          const request: CommandRequest = {
            protocolVersion: String(negotiated),
            operation: op,
            operationId: opts?.operationId ?? randomUUID(),
            expectedRevisions: opts?.expectedRevisions,
            payload
          }
          return new Promise<CommandReceipt>((res, rej) => {
            pending.set(requestId, { resolve: res, reject: rej })
            sock.write(encodeFrame({ kind: 'call', requestId, request }))
          })
        },
        close(): void {
          teardown(controlUnavailable(endpoint, 'client closed by caller'))
        }
      }
    }
  })
}
