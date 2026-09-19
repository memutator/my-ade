// mahas-runtime rpc — the local collaboration server (spec C-ACCESS §1).
//
// serveRpc binds a unix domain socket (POSIX) or named pipe (Windows — the
// same node:net listen(path) call covers both) and speaks the NDJSON framing
// from framing.ts: one hello frame to authenticate + negotiate, then
// requestId-multiplexed CommandRequest→CommandReceipt calls dispatched
// through the OperationRegistry.
//
// Non-negotiables wired here:
//   - the AuthenticatedContext is built ONLY from the credential via the
//     injected `authenticate` — payload from/role fields are never consulted
//     (spec/common.md §2);
//   - transportSessionId is minted per connection and force-stamped onto the
//     context, so a client can never claim a session it does not hold;
//   - a dispatch() that throws yields a `status:'unknown'` receipt, never a
//     fabricated committed one — REQ-14 ambiguous answers stay unknown;
//   - nothing here decides which operations exist: visibility/authorization
//     is the registry's admission path (IMP-11), so an unauthorized or
//     nonexistent operation comes back exactly as the registry's receipt.

import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { chmod, stat, unlink } from 'node:fs/promises'
import { connect } from 'node:net'
import type {
  AuthenticatedContext,
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
  requestFromWire,
  type CallFrame,
  type ClientHelloFrame,
  type ResultFrame,
  type RpcAuthenticate,
  type ServerFrame
} from './framing.ts'

/** ms a connection may sit unauthenticated before the server drops it */
const HELLO_TIMEOUT_MS = 10_000

/**
 * The narrow transport port on the registry. SHARED-APIS fixes
 * `serveRpc(registry: OperationRegistry, …)`; IMP-11's OperationRegistry is
 * still in flight, so this structural shape is the contract — IMP-11's
 * `dispatch(ctx, req): Promise<CommandReceipt>` satisfies it exactly, and
 * the same object typechecks against the promised signature once it lands.
 */
export interface OperationDispatcher {
  dispatch(ctx: AuthenticatedContext, req: CommandRequest): Promise<CommandReceipt>
}

export interface RpcServer {
  endpoint: string
  close(): Promise<void>
}

/**
 * serveRpc returns this richer handle — still assignable to the fixed
 * `RpcServer` type. `ready` resolves once the socket is bound and accepting;
 * it rejects if the endpoint could not be claimed (already serving, EACCES).
 */
export interface RpcServerHandle extends RpcServer {
  ready: Promise<void>
}

/** does `path` currently accept a connection (i.e. a live server holds it)? */
function endpointAccepts(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(path)
    const timer = setTimeout(() => {
      sock.destroy()
      resolve(false)
    }, timeoutMs)
    sock.once('connect', () => {
      clearTimeout(timer)
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => {
      clearTimeout(timer)
      sock.destroy()
      resolve(false)
    })
  })
}

/** is this endpoint string a filesystem path (posix socket) vs a named pipe? */
function isPipeEndpoint(endpoint: string): boolean {
  return endpoint.startsWith('\\\\.\\pipe\\') || endpoint.startsWith('pipe:')
}

/**
 * Claim a filesystem socket path. A live listener wins — we refuse rather
 * than steal. A stale file (previous daemon crashed) is unlinked so the new
 * listener can bind. Named pipes skip all of this.
 */
async function claimEndpoint(endpoint: string): Promise<void> {
  if (isPipeEndpoint(endpoint)) return
  let exists = false
  try {
    await stat(endpoint)
    exists = true
  } catch {
    exists = false
  }
  if (exists) {
    if (await endpointAccepts(endpoint)) {
      throw mahasError(
        'CONTROL_UNAVAILABLE',
        `endpoint ${endpoint} already serves a live mahasd — refusing to double-bind`
      )
    }
    await unlink(endpoint) // stale socket file
  }
}

function writeFrame(sock: Socket, frame: ServerFrame): void {
  if (!sock.destroyed) sock.write(encodeFrame(frame))
}

function errorFrame(requestId: number | null, error: MahasError): ServerFrame {
  return { kind: 'error', requestId, error }
}

/**
 * One authenticated session on the wire. Awaits hello, authenticates via the
 * injected callback, then relays call frames to the registry. The context
 * captured here is reused for EVERY call on the connection — the client has
 * no say in it.
 */
function handleConnection(
  sock: Socket,
  registry: OperationDispatcher,
  endpoint: string,
  authenticate: RpcAuthenticate,
  sessions: Set<Socket>
): void {
  const transportSessionId = randomUUID()
  let ctx: AuthenticatedContext | null = null
  let helloSeen = false
  let frameChain: Promise<void> = Promise.resolve()

  const helloTimer = setTimeout(() => {
    if (!helloSeen) {
      writeFrame(
        sock,
        errorFrame(null, mahasError('UNAUTHENTICATED', 'hello not received in time'))
      )
      sock.destroy()
    }
  }, HELLO_TIMEOUT_MS)

  const decoder = new NdjsonDecoder(
    (line) => {
      // F-036: frames on one connection are processed strictly in arrival
      // order. onLine is async (hello authenticates, calls dispatch); firing
      // it bare lets a pipelined call race hello auth while ctx is still
      // null — answering unknown/CONTROL_UNAVAILABLE or committed depending
      // on timing. Chain per connection so a later frame waits for the
      // earlier one; a rejected link never breaks the chain (every frame
      // already reports its own errors). Cross-connection concurrency is
      // unaffected — the chain is per handleConnection.
      frameChain = frameChain.then(() => onLine(line)).then(
        () => undefined,
        () => undefined
      )
    },
    () => {
      writeFrame(sock, errorFrame(null, mahasError('MODEL_INVALID', 'frame exceeds size limit')))
      sock.destroy()
    }
  )

  sock.on('data', (chunk) => decoder.feed(chunk))
  sock.on('error', () => {
    /* peer vanished — pending dispatches settle on their own */
  })
  sock.on('close', () => {
    clearTimeout(helloTimer)
    sessions.delete(sock)
  })

  async function onLine(line: string): Promise<void> {
    const parsed = parseFrame(line)
    if (!parsed.ok) {
      writeFrame(sock, errorFrame(null, parsed.error))
      return
    }
    const frame = parsed.frame

    if (!helloSeen) {
      await onHello(frame)
      return
    }
    if (frame.kind !== 'call') {
      writeFrame(
        sock,
        errorFrame(
          typeof frame.requestId === 'number' ? frame.requestId : null,
          mahasError('MODEL_INVALID', `unexpected frame kind '${String(frame.kind)}'`)
        )
      )
      return
    }
    await onCall(frame as unknown as CallFrame)
  }

  async function onHello(frame: Record<string, unknown>): Promise<void> {
    helloSeen = true
    clearTimeout(helloTimer)
    if (frame.kind !== 'hello') {
      writeFrame(sock, errorFrame(null, mahasError('UNAUTHENTICATED', 'first frame must be hello')))
      sock.destroy()
      return
    }
    const hello = frame as unknown as ClientHelloFrame
    const offered = typeof hello.protocolVersion === 'number' ? hello.protocolVersion : 0
    const negotiated = Math.min(offered, MAHAS_RPC_PROTOCOL_VERSION)
    if (negotiated < 1) {
      writeFrame(sock, {
        kind: 'hello-error',
        error: mahasError(
          'HOST_PROTOCOL_MISMATCH',
          `no common protocol version (client ${offered}, server ${MAHAS_RPC_PROTOCOL_VERSION})`
        )
      } satisfies ServerFrame)
      sock.destroy()
      return
    }
    try {
      const built = await authenticate(hello.credential, { transportSessionId, endpoint })
      // the session id is a transport fact — override anything the
      // authenticator put there so it can never be a claim
      ctx = { ...built, transportSessionId }
      writeFrame(sock, {
        kind: 'hello-ok',
        protocolVersion: negotiated,
        transportSessionId,
        principalId: String(ctx.principalId)
      } satisfies ServerFrame)
    } catch (e) {
      const error = normalizeError(
        e,
        mahasError('UNAUTHENTICATED', 'credential refused by authenticator')
      )
      writeFrame(sock, { kind: 'hello-error', error } satisfies ServerFrame)
      sock.destroy()
    }
  }

  async function onCall(frame: CallFrame): Promise<void> {
    const requestId = typeof frame.requestId === 'number' ? frame.requestId : null
    if (requestId === null) {
      // no correlation id — the peer could never match a result to this call
      writeFrame(
        sock,
        errorFrame(null, mahasError('MODEL_INVALID', 'call frame requires a numeric requestId'))
      )
      return
    }
    const req = requestFromWire(frame.request)
    if ('code' in req) {
      writeFrame(sock, errorFrame(requestId, req))
      return
    }
    // envelope protocolVersion, when present, must match the negotiated one —
    // a mismatched request is malformed for THIS session, not dispatched
    if (req.protocolVersion !== '' && Number(req.protocolVersion) !== MAHAS_RPC_PROTOCOL_VERSION) {
      writeFrame(
        sock,
        errorFrame(
          requestId,
          mahasError(
            'HOST_PROTOCOL_MISMATCH',
            `request protocolVersion ${req.protocolVersion} does not match negotiated ${MAHAS_RPC_PROTOCOL_VERSION}`
          )
        )
      )
      return
    }
    let receipt: CommandReceipt
    try {
      // ctx is guaranteed non-null: frames serialize per connection (F-036),
      // so helloSeen implies onHello fully completed — a failed hello
      // destroys the socket before any call frame is processed.
      receipt = await registry.dispatch(ctx as AuthenticatedContext, req)
    } catch (e) {
      // REQ-14: a dispatch that fails to answer leaves the outcome genuinely
      // ambiguous. Report status:'unknown' with the caller's operationId so
      // the requester reconciles via operation.get — never invent committed.
      receipt = {
        operationId: req.operationId,
        fingerprint: '',
        status: 'unknown',
        error: normalizeError(
          e,
          mahasError(
            'CONTROL_UNAVAILABLE',
            'dispatch failed before a receipt was produced — reconcile via operation.get',
            'reconcile'
          )
        ),
        effects: [],
        domainRevision: 0,
        eventCursor: 0
      }
    }
    writeFrame(sock, { kind: 'result', requestId, receipt } satisfies ResultFrame)
  }
}

/**
 * Bind `endpoint` and serve `registry` over the NDJSON protocol. The
 * `authenticate` callback is the ONLY context constructor — it receives the
 * credential sent in hello plus the server-minted session info.
 *
 * mahasd runs TWO of these (spec/architecture.md §6): the worker endpoint
 * with worker credentials and a member-surface registry, the operator
 * endpoint with operator credentials and the operator surface. There is no
 * shared socket and no fallback between them.
 */
export function serveRpc(
  registry: OperationDispatcher,
  endpoint: string,
  authenticate: RpcAuthenticate
): RpcServerHandle {
  const sessions = new Set<Socket>()
  let closed = false

  const server: Server = createServer((sock) => {
    sock.setNoDelay(true)
    sessions.add(sock)
    handleConnection(sock, registry, endpoint, authenticate, sessions)
  })

  const ready = (async (): Promise<void> => {
    await claimEndpoint(endpoint)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, () => {
        server.off('error', reject)
        resolve()
      })
    })
    // socket file is proof of nothing (spec C-ACCESS: path ≠ auth) but it is
    // still execution-owner material — keep it user-only on POSIX
    if (!isPipeEndpoint(endpoint) && process.platform !== 'win32') {
      await chmod(endpoint, 0o600).catch(() => undefined)
    }
  })()

  return {
    endpoint,
    ready,
    close(): Promise<void> {
      if (closed) return Promise.resolve()
      closed = true
      for (const s of sessions) s.destroy()
      sessions.clear()
      return new Promise((resolve) => {
        server.close(() => {
          if (!isPipeEndpoint(endpoint)) {
            void unlink(endpoint)
              .catch(() => undefined)
              .then(() => resolve())
          } else {
            resolve()
          }
        })
      })
    }
  }
}
