// inventory/auth/channel-server.ts — the dedicated auth socket.
//
// The auth channel must never share the ordinary operation socket: a receipt is
// persisted, exported and readable, so a secret that enters an ordinary dispatch has
// already leaked. This module binds a SECOND endpoint (<configDir>/mahasd-auth.sock)
// with serveRpc, but with a dispatcher that answers only the auth channel methods and
// never touches the operation registry, the receipt store or the event outbox.
//
// The wire shape reuses the existing framing: the call's operation IS the channel
// method, and the payload is { scope?, input }. The result is wrapped in a transient
// CommandReceipt (status committed, domainRevision/eventCursor 0) so clients keep one
// client implementation; nothing about that receipt is written down.
//
// Authentication is operator-only. The endpoint is not a privilege boundary by path —
// the credential proof is — so the authenticator verifies the same operator secret the
// ordinary socket uses.

import { join } from 'node:path'
import type {
  AuthenticatedContext,
  CommandReceipt,
  CommandRequest,
  MahasError
} from '../../../../mahas-contracts/src/index.ts'
import { mahasError } from '../../api/handler-ports.ts'
import { canonicalJson, sha256 } from '../../integration/safety.ts'
import { serveRpc, type RpcServerHandle } from '../../rpc/local-server.ts'
import type { RpcAuthenticate } from '../../rpc/framing.ts'
import {
  AUTH_CHANNEL_METHODS,
  AUTH_CHANNEL_PROTOCOL,
  AuthTransportError,
  type AuthChannelAuditSink,
  type AuthChannelMethod,
  type AuthChannelResponse,
  type DedicatedAuthTransport
} from './transport.ts'

export const AUTH_SOCKET_FILENAME = 'mahasd-auth.sock'

export function authSocketEndpoint(configDir: string): string {
  return join(configDir, AUTH_SOCKET_FILENAME)
}

/** Translate a transport failure into the shared error taxonomy. */
export function authErrorFromTransport(error: AuthChannelResponse['error']): MahasError {
  if (!error) return mahasError('CONTROL_UNAVAILABLE', 'auth channel returned no result')
  switch (error.code) {
    case 'UNKNOWN_METHOD':
      return mahasError('UNAVAILABLE_OPERATION', error.message)
    case 'INPUT_INVALID':
    case 'HANDLE_REQUIRED':
    case 'HANDLE_INVALID':
    case 'HANDLE_SCOPE_MISMATCH':
      return mahasError(
        'MODEL_INVALID',
        error.message,
        'none',
        error.detail ? { detail: error.detail } : undefined
      )
    case 'SECRET_IN_ORDINARY_PAYLOAD':
      return mahasError('REQUIRED_ACTION_DENIED', error.message, 'none')
    case 'SERVICE_STOPPED':
      return mahasError('CONTROL_UNAVAILABLE', error.message, 'reconcile')
    default:
      return mahasError('INVALID_TRANSITION', error.message, 'none')
  }
}

export interface AuthChannelDispatcherOptions {
  transport: DedicatedAuthTransport
  audit?: AuthChannelAuditSink
  /**
   * Principal ids allowed on this channel. The daemon's operator authenticator mints
   * 'operator-local' (or a configured principal); the set comes from composition so the
   * channel never guesses an identity string.
   */
  allowedPrincipals: readonly string[]
}

/**
 * A dispatcher over the dedicated transport. It answers exactly the channel methods
 * and rejects everything else — there is no fallback to the operation registry, so an
 * unknown name cannot become an ordinary operation call.
 */
export class AuthChannelDispatcher {
  readonly #transport: DedicatedAuthTransport
  readonly #allowedPrincipals: ReadonlySet<string>

  constructor(options: AuthChannelDispatcherOptions) {
    this.#transport = options.transport
    if (options.allowedPrincipals.length === 0) {
      throw new AuthTransportError(
        'SERVICE_STOPPED',
        'the auth channel needs at least one allowed operator principal'
      )
    }
    this.#allowedPrincipals = new Set(options.allowedPrincipals)
  }

  async dispatch(ctx: AuthenticatedContext, request: CommandRequest): Promise<CommandReceipt> {
    const operationId = request.operationId
    const base = {
      operationId,
      // No idempotency store exists on this channel, and the payload may carry a secret
      // handle — so the fingerprint is derived from the method and operation id only.
      // The payload is never hashed, echoed or persisted.
      fingerprint: sha256(canonicalJson({ operation: request.operation, operationId })),
      status: 'committed' as const,
      effects: [],
      domainRevision: 0,
      eventCursor: 0
    }
    if (!this.#allowedPrincipals.has(String(ctx.principalId))) {
      return {
        ...base,
        status: 'rejected',
        error: mahasError('SCOPE_DENIED', 'the auth channel accepts operator principals only')
      }
    }
    if (!AUTH_CHANNEL_METHODS.includes(request.operation as AuthChannelMethod)) {
      return {
        ...base,
        status: 'rejected',
        error: mahasError(
          'UNAVAILABLE_OPERATION',
          'the auth channel answers only ' + AUTH_CHANNEL_METHODS.join(', ')
        )
      }
    }
    const payload = (request.payload ?? {}) as Record<string, unknown>
    const response = await this.#transport.invoke({
      protocolVersion: AUTH_CHANNEL_PROTOCOL,
      operationId,
      method: request.operation as AuthChannelMethod,
      ...(typeof payload.scope === 'string' ? { scope: payload.scope } : {}),
      ...(payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input)
        ? { input: payload.input as Record<string, unknown> }
        : {})
    })
    if (response.status !== 'ok') {
      return { ...base, status: 'rejected', error: authErrorFromTransport(response.error) }
    }
    // The response is already secret-free (transport.ts scrubs it). The receipt is
    // transient: no store, no event, no trace.
    return { ...base, result: response }
  }
}

export interface AuthChannelServerOptions {
  configDir: string
  transport: DedicatedAuthTransport
  authenticate: RpcAuthenticate
  /** principal ids the operator authenticator mints; composition supplies them */
  allowedPrincipals: readonly string[]
  audit?: AuthChannelAuditSink
}

export interface AuthChannelServer {
  endpoint: string
  ready: Promise<void>
  close(): Promise<void>
}

/** Bind the dedicated auth socket. Call only from the daemon composition root. */
export function serveAuthChannel(options: AuthChannelServerOptions): AuthChannelServer {
  const dispatcher = new AuthChannelDispatcher({
    transport: options.transport,
    allowedPrincipals: options.allowedPrincipals,
    ...(options.audit ? { audit: options.audit } : {})
  })
  const handle: RpcServerHandle = serveRpc(
    dispatcher,
    authSocketEndpoint(options.configDir),
    options.authenticate
  )
  return {
    endpoint: handle.endpoint,
    ready: handle.ready,
    close: () => handle.close()
  }
}

/**
 * Operators-only check. The allowed set is injected by composition because the
 * principal id is minted by the operator authenticator (the daemon's local operator is
 * 'operator-local', not a fixed literal this module could guess).
 */
export function requireOperatorContext(
  ctx: AuthenticatedContext,
  allowedPrincipals: readonly string[]
): void {
  if (!allowedPrincipals.includes(String(ctx.principalId))) {
    throw new AuthTransportError('SERVICE_STOPPED', 'the auth channel is operator-only')
  }
}
