// Desktop client for the daemon's DEDICATED auth channel.
//
// Provider sign-in material must never travel through the ordinary (receipt-
// bearing) operation surface: receipts, traces, domain events and diagnostics
// are persisted and operator-readable. The daemon therefore serves the auth
// channel on its own socket, and this file is the desktop's only client for it.
//
// Framing (agreed with the daemon auth transport):
//
//   · transport — the same NDJSON RPC session the desktop already uses
//     (`connectRpc`: hello with the operator credential, then requestId-framed
//     calls). The endpoint is the auth socket, NOT mahasd's ordinary socket.
//   · call — `operation` is the channel method name; `payload` is the channel
//     request body `{ protocolVersion, method, scope?, input? }` so a server can
//     hand it to the transport's `invoke()` unchanged.
//   · reply — the receipt carries the channel response. The daemon must NOT
//     persist it (the transport is deliberately outside the receipt pipeline);
//     the desktop reads `receipt.result` and, when the server returned the
//     response unwrapped, wraps it here. Either way the value the renderer sees
//     is secret-free: a raw secret only ever goes IN (auth.secret.deposit) and
//     comes back as a single-use handle.
//
// The one method that accepts a raw value is `auth.secret.deposit`; every other
// method carries a handle or is secret-free. `submitCode`/`submitSecret` use the
// handle's scope, which the transport derives from the flow id — the desktop
// reproduces that one derivation here and nowhere else.

import { join } from 'node:path'
import { app } from 'electron'
import { mahasConfigDir } from '../eventsFile'
import { AUTH_CHANNEL_PROTOCOL, responseFrom } from './authResponse.ts'
import { connectRpc, resolveOperatorConnection } from '../../../packages/mahas-client/src/index.ts'
import type { RpcClient } from '../../../packages/mahas-client/src/index.ts'
import type { ControlError, ControlResult } from '../../../packages/mahas-contracts/src/index.ts'

/** channel protocol version, mirrored from the daemon transport */
export { AUTH_CHANNEL_PROTOCOL } from './authResponse.ts'

/** endpoint override for tests/alternate installs */
export const AUTH_CHANNEL_ENDPOINT_ENV = 'MAHAS_AUTH_ENDPOINT'

/** the dedicated socket the daemon serves next to its ordinary one */
export const AUTH_SOCKET_FILENAME = 'mahasd-auth.sock'

export type AuthChannelMethod =
  | 'auth.secret.deposit'
  | 'auth.flow.start'
  | 'auth.flow.submitCode'
  | 'auth.flow.submitSecret'
  | 'auth.flow.poll'
  | 'auth.flow.cancel'
  | 'auth.flow.status'
  | 'auth.flow.list'
  | 'auth.flow.refresh'

/** what `auth.secret.deposit` hands back — a reference, never the value */
export interface AuthSecretDeposit {
  handle: string
  scope: string
  expiresAt: number
}

export interface AuthChannelError {
  code: string
  message: string
  detail?: string
}

export interface AuthChannelResponse {
  protocolVersion: string
  method: string
  status: 'ok' | 'failed'
  result?: unknown
  deposit?: AuthSecretDeposit
  error?: AuthChannelError
}

export interface AuthChannelCall {
  method: AuthChannelMethod
  /** flow/intent the call belongs to; also the deposit scope for handles */
  scope?: string
  input?: Record<string, unknown>
  operationId?: string
}

function configDir(): string {
  return mahasConfigDir()
}

export function authChannelEndpoint(): string {
  return process.env[AUTH_CHANNEL_ENDPOINT_ENV] ?? join(configDir(), AUTH_SOCKET_FILENAME)
}

/** Env var the desktop sets when it starts the daemon so the auth domain adopts
 *  the credential files THIS profile already has (legacy `usageAccounts`).
 *  Deliberately explicit: the daemon must never guess a desktop userData path,
 *  and dev runs keep a different root than an installed app. */
export const LEGACY_USAGE_ACCOUNTS_ROOT_ENV = 'MAHAS_LEGACY_USAGE_ACCOUNTS_ROOT'

/** Where this profile keeps credential files registered before the inventory
 *  domain existed (`<userData>/usage-accounts`). */
export function legacyUsageAccountsRoot(): string {
  return join(app.getPath('userData'), 'usage-accounts')
}

let session: RpcClient | null = null
let connecting: Promise<RpcClient> | null = null

/** one authenticated session against the auth socket; a failure drops it so the
 *  next call re-handshakes instead of remembering a dead socket */
async function openSession(): Promise<RpcClient> {
  if (session) return session
  if (connecting) return connecting
  connecting = (async () => {
    const resolved = await resolveOperatorConnection({ configDir: configDir() })
    return connectRpc(authChannelEndpoint(), resolved.credential)
  })()
  try {
    session = await connecting
    return session
  } finally {
    connecting = null
  }
}

export function dropAuthSession(): void {
  const current = session
  session = null
  try {
    current?.close()
  } catch {
    // already closed
  }
}

function failure(error: unknown, fallback = 'auth channel call failed'): ControlError {
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown; retry?: unknown }
    if (typeof value.code === 'string') {
      return {
        code: value.code as ControlError['code'],
        message: typeof value.message === 'string' ? value.message : fallback,
        retryable: value.retry === 'same-operation' || value.retry === 'reconcile'
      }
    }
  }
  return {
    code: 'CONTROL_UNAVAILABLE',
    message: error instanceof Error ? error.message : String(error),
    retryable: true
  }
}

/** one dedicated-channel call. The secret (when there is one) is a parameter of
 *  the deposit helper below and never reaches this function's logging paths. */
export async function callAuthChannel(
  call: AuthChannelCall
): Promise<ControlResult<AuthChannelResponse>> {
  let client: RpcClient
  try {
    client = await openSession()
  } catch (error) {
    return { ok: false, error: failure(error, 'auth channel unreachable') }
  }
  try {
    const receipt = (await client.call(
      call.method,
      {
        protocolVersion: AUTH_CHANNEL_PROTOCOL,
        method: call.method,
        ...(call.scope ? { scope: call.scope } : {}),
        input: call.input ?? {}
      },
      call.operationId ? { operationId: call.operationId } : undefined
    )) as unknown as Record<string, unknown>
    return responseFrom(call.method, receipt)
  } catch (error) {
    // the session may be half-dead; do not reuse it for the next call
    dropAuthSession()
    return { ok: false, error: failure(error) }
  }
}

/** handle scope for a flow — mirrors `DedicatedAuthTransport.scopeForFlow` */
export function authScopeForFlow(flowId: string): string {
  return 'flow:' + flowId
}

/** hand a value (pasted code or provider secret) to the daemon once */
export async function depositSecret(
  scope: string,
  value: string
): Promise<ControlResult<AuthSecretDeposit>> {
  const response = await callAuthChannel({
    method: 'auth.secret.deposit',
    input: { secret: value, scope }
  })
  if (!response.ok) return response
  const deposit = response.value.deposit
  if (!deposit || typeof deposit.handle !== 'string') {
    return {
      ok: false,
      error: { code: 'UNKNOWN', message: 'auth.secret.deposit returned no handle' }
    }
  }
  return { ok: true, value: deposit }
}

export function startAuthFlow(input: {
  offeringId: string
  connectionId?: string
  callbackRedirect?: string
}): Promise<ControlResult<AuthChannelResponse>> {
  return callAuthChannel({ method: 'auth.flow.start', input: { ...input } })
}

/** submit a pasted authorization code: deposit it, then use the handle */
export async function submitFlowCode(
  flowId: string,
  code: string
): Promise<ControlResult<AuthChannelResponse>> {
  const deposit = await depositSecret(authScopeForFlow(flowId), code)
  if (!deposit.ok) return deposit
  return callAuthChannel({
    method: 'auth.flow.submitCode',
    scope: authScopeForFlow(flowId),
    input: { flowId, handle: deposit.value.handle }
  })
}

/** submit a provider secret (API key) the same way */
export async function submitFlowSecret(
  flowId: string,
  secret: string
): Promise<ControlResult<AuthChannelResponse>> {
  const deposit = await depositSecret(authScopeForFlow(flowId), secret)
  if (!deposit.ok) return deposit
  return callAuthChannel({
    method: 'auth.flow.submitSecret',
    scope: authScopeForFlow(flowId),
    input: { flowId, handle: deposit.value.handle }
  })
}

export function pollAuthFlow(flowId: string): Promise<ControlResult<AuthChannelResponse>> {
  return callAuthChannel({ method: 'auth.flow.poll', input: { flowId } })
}

export function readAuthFlow(flowId: string): Promise<ControlResult<AuthChannelResponse>> {
  return callAuthChannel({ method: 'auth.flow.status', input: { flowId } })
}

export function cancelAuthFlow(
  flowId: string,
  reason?: string
): Promise<ControlResult<AuthChannelResponse>> {
  return callAuthChannel({
    method: 'auth.flow.cancel',
    input: { flowId, ...(reason ? { reason } : {}) }
  })
}

export function refreshAuthFlow(input: {
  credentialRef: string
  offeringId: string
  connectionId: string
  expectedMaterialRevision: number
}): Promise<ControlResult<AuthChannelResponse>> {
  return callAuthChannel({ method: 'auth.flow.refresh', input: { ...input } })
}
