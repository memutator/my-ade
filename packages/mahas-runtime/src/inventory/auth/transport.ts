// inventory/auth/transport.ts — the dedicated secret-bearing channel.
//
// Ordinary operations are receipt-bearing: their payloads, receipts, traces and
// domain-event rows are persisted, exported with diagnostics, and readable by an
// operator. Provider sign-in material must therefore never travel through them. Two
// mechanical shapes keep that true:
//
//   • the deposit store — a secret is handed in exactly once, kept in memory, and
//     referenced afterwards by a single-use handle bound to its scope;
//   • the dedicated transport — 'auth.secret.deposit' is the ONLY method that accepts
//     raw secret values, and it is never dispatched through the ordinary operation
//     path. The flow methods below take handles.
//
// assertOrdinaryAuthPayload() guards the other direction: an auth call that reaches an
// ordinary (receipt-writing) dispatch with material in it is rejected instead of
// persisted. No audit entry ever carries a payload.

import { randomUUID } from 'node:crypto'
import { redactText } from '../../integration/safety.ts'
import type { AuthFlowView } from './coordinator.ts'

export const AUTH_CHANNEL_PROTOCOL = 'mahas.auth.channel/v1'

/** Every method the dedicated channel answers. */
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
  | 'auth.credential.importLocators'
  | 'auth.credential.adoptLocator'
  | 'auth.quota.collect'

export const AUTH_CHANNEL_METHODS: readonly AuthChannelMethod[] = [
  'auth.secret.deposit',
  'auth.flow.start',
  'auth.flow.submitCode',
  'auth.flow.submitSecret',
  'auth.flow.poll',
  'auth.flow.cancel',
  'auth.flow.status',
  'auth.flow.list',
  'auth.flow.refresh',
  'auth.credential.importLocators',
  'auth.credential.adoptLocator',
  'auth.quota.collect'
]

/** The one method that accepts a raw secret value. Never register it as an operation. */
export const AUTH_SECRET_INPUT_METHOD = 'auth.secret.deposit' as const

/** Methods that carry a handle instead of a value; they belong to the channel too. */
export const AUTH_HANDLE_METHODS = ['auth.flow.submitCode', 'auth.flow.submitSecret'] as const

/**
 * Methods safe for the ordinary operation/receipt surface: they neither accept nor
 * return material, so an operator may replay them from a receipt.
 */
export const AUTH_ORDINARY_METHODS: readonly string[] = [
  'auth.flow.start',
  'auth.flow.poll',
  'auth.flow.cancel',
  'auth.flow.status',
  'auth.flow.list',
  'auth.flow.refresh',
  'auth.intent.begin',
  'auth.intent.record',
  'auth.intent.complete',
  'auth.intent.list',
  'auth.credential.importLocators',
  'auth.credential.adoptLocator',
  'auth.service.status'
]

export type AuthTransportErrorCode =
  | 'UNKNOWN_METHOD'
  | 'INPUT_INVALID'
  | 'HANDLE_REQUIRED'
  | 'HANDLE_INVALID'
  | 'HANDLE_SCOPE_MISMATCH'
  | 'SECRET_IN_ORDINARY_PAYLOAD'
  | 'SECRET_OUTPUT_REJECTED'
  | 'DRIVER_FAILED'
  | 'SERVICE_STOPPED'

export class AuthTransportError extends Error {
  readonly code: AuthTransportErrorCode
  readonly detail?: string

  constructor(code: AuthTransportErrorCode, message: string, detail?: string) {
    super(redactText(message))
    this.name = 'AuthTransportError'
    this.code = code
    if (detail !== undefined) this.detail = redactText(detail)
  }
}

/** Field names that carry material in any provider payload mahas knows about. */
const MATERIAL_FIELDS = new Set(
  [
    'accesstoken',
    'access_token',
    'refreshtoken',
    'refresh_token',
    'idtoken',
    'id_token',
    'apikey',
    'api_key',
    'clientsecret',
    'client_secret',
    'secret',
    'sharedsecret',
    'token',
    'password',
    'authorization',
    'codeverifier',
    'code_verifier',
    'verifier',
    'devicecode',
    'device_code',
    'oauthcode',
    'authorizationcode',
    'authorization_code',
    'privatekey',
    'private_key',
    'sessionkey',
    'session_key'
  ].map((field) => field.toLowerCase())
)

/** Compact JWT: three base64url segments, no scheme, no separators. */
const JWT_SHAPE = /^[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}$/
const BEARER_SHAPE = /^\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}/i

const isMaterialField = (key: string): boolean => MATERIAL_FIELDS.has(key.toLowerCase())

/**
 * Strip every material-shaped field from a value. Returns a fresh structure;
 * containers such as credentialChange and materialRef survive because the reference
 * is not the material.
 */
export function stripSecretFields<T>(value: T, depth = 0): T {
  if (depth > 12) return value
  if (Array.isArray(value))
    return value.map((item) => stripSecretFields(item, depth + 1)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isMaterialField(key)) continue
      out[key] = stripSecretFields(item, depth + 1)
    }
    return out as unknown as T
  }
  return value
}

function findSecret(value: unknown, path: string, depth: number): string | null {
  if (depth > 12) return null
  if (typeof value === 'string') {
    if (JWT_SHAPE.test(value.trim()) || BEARER_SHAPE.test(value)) return path
    return null
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findSecret(value[index], path + '[' + index + ']', depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isMaterialField(key)) {
        if (item === undefined || item === null || item === '') continue
        return path + '.' + key
      }
      const hit = findSecret(item, path + '.' + key, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

/**
 * Reject a payload that carries material. Used on the ordinary operation path and on
 * every dedicated-channel response before it leaves the daemon.
 */
export function assertSecretFree(value: unknown, context: string): void {
  const hit = findSecret(value, '$', 0)
  if (hit) {
    throw new AuthTransportError(
      'SECRET_IN_ORDINARY_PAYLOAD',
      context + ' must not carry provider secret material',
      'material-shaped field at ' + hit
    )
  }
}

/** The ordinary (receipt-bearing) surface accepts only secret-free auth calls. */
export function assertOrdinaryAuthPayload(method: string, input: unknown): void {
  if (
    method === AUTH_SECRET_INPUT_METHOD ||
    (AUTH_HANDLE_METHODS as readonly string[]).includes(method)
  ) {
    throw new AuthTransportError(
      'SECRET_IN_ORDINARY_PAYLOAD',
      method + ' is a dedicated-channel method and cannot be dispatched as an ordinary operation'
    )
  }
  assertSecretFree(input, 'ordinary auth operation ' + method)
}

function scrubFlowView(view: AuthFlowView): AuthFlowView {
  const safe = stripSecretFields(view)
  assertSecretFree(safe, 'auth flow result')
  return safe
}

export interface SecretDeposit {
  handle: string
  scope: string
  expiresAt: number
}

export interface SecretDepositsOptions {
  now?: () => number
  ttlMs?: number
  maxEntries?: number
  randomId?: () => string
}

/**
 * In-memory, single-use deposit store. Nothing is written to disk and nothing is
 * logged: a handle is only meaningful inside the process that minted it, which is also
 * why a daemon restart invalidates pending sign-in input by construction.
 */
export class SecretDeposits {
  readonly #entries = new Map<string, { scope: string; value: string; expiresAt: number }>()
  readonly #now: () => number
  readonly #ttlMs: number
  readonly #maxEntries: number
  readonly #randomId: () => string

  constructor(options: SecretDepositsOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#ttlMs = options.ttlMs ?? 10 * 60 * 1000
    this.#maxEntries = options.maxEntries ?? 64
    this.#randomId = options.randomId ?? randomUUID
  }

  /** Hand a secret in once. The returned handle is the only durable reference. */
  deposit(value: string, scope: string): SecretDeposit {
    if (typeof value !== 'string' || value.length === 0) {
      throw new AuthTransportError('INPUT_INVALID', 'deposited secret must be a non-empty string')
    }
    if (typeof scope !== 'string' || !scope.trim()) {
      throw new AuthTransportError('INPUT_INVALID', 'a deposit scope is required')
    }
    this.sweep()
    if (this.#entries.size >= this.#maxEntries) {
      throw new AuthTransportError('INPUT_INVALID', 'too many pending secret deposits')
    }
    const handle = this.#randomId()
    const expiresAt = this.#now() + this.#ttlMs
    this.#entries.set(handle, { scope, value, expiresAt })
    return { handle, scope, expiresAt }
  }

  /** Single use: the entry is gone whether or not the caller keeps the string. */
  withdraw(handle: string, scope: string): string {
    const entry = this.#entries.get(handle)
    if (!entry)
      throw new AuthTransportError('HANDLE_INVALID', 'secret handle is unknown or already used')
    this.#entries.delete(handle)
    if (entry.expiresAt <= this.#now()) {
      throw new AuthTransportError('HANDLE_INVALID', 'secret handle expired')
    }
    if (entry.scope !== scope) {
      throw new AuthTransportError(
        'HANDLE_SCOPE_MISMATCH',
        'secret handle belongs to another scope'
      )
    }
    return entry.value
  }

  revoke(handle: string): boolean {
    return this.#entries.delete(handle)
  }

  revokeScope(scope: string): number {
    let removed = 0
    for (const [handle, entry] of this.#entries) {
      if (entry.scope === scope) {
        this.#entries.delete(handle)
        removed += 1
      }
    }
    return removed
  }

  sweep(): number {
    const now = this.#now()
    let removed = 0
    for (const [handle, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(handle)
        removed += 1
      }
    }
    return removed
  }

  size(): number {
    this.sweep()
    return this.#entries.size
  }

  /** Drop every pending secret — called by the service on stop/shutdown. */
  clear(): number {
    const count = this.#entries.size
    this.#entries.clear()
    return count
  }
}

export interface AuthChannelHandlers {
  start(input: {
    offeringId: string
    connectionId?: string
    callbackRedirect?: string
  }): Promise<AuthFlowView>
  submitCode(input: { flowId: string; code: string }): Promise<AuthFlowView>
  submitSecret(input: { flowId: string; secret: string }): Promise<AuthFlowView>
  poll(input: { flowId: string }): Promise<AuthFlowView>
  cancel(input: { flowId: string; reason?: string }): AuthFlowView | Promise<AuthFlowView>
  status(input: { flowId: string }): AuthFlowView | Promise<AuthFlowView>
  list(): readonly AuthFlowView[]
  refresh(input: {
    credentialRef: string
    expectedMaterialRevision: number
    offeringId: string
    connectionId: string
  }): Promise<AuthFlowView>
  /** secret-free connection/credential management on the same channel */
  importLocators(input: { machineId: string }): Promise<unknown>
  adoptLocator(input: {
    machineId: string
    offeringId: string
    credentialId: string
    accountContinuity: 'confirmed-same'
    format: string
  }): Promise<unknown>
  /** daemon-side quota collection; never accepts caller material */
  collectQuota(): Promise<unknown>
}

export interface AuthChannelAuditEntry {
  at: number
  method: AuthChannelMethod
  flowId?: string
  outcome: 'ok' | 'rejected' | 'failed'
  durationMs: number
  code?: AuthTransportErrorCode
}

export type AuthChannelAuditSink = (entry: AuthChannelAuditEntry) => void

export interface AuthChannelRequest {
  protocolVersion: string
  operationId?: string
  method: AuthChannelMethod
  /** flow or intent the call belongs to; also the deposit scope for handles */
  scope?: string
  input?: Record<string, unknown>
}

export interface AuthChannelResponse {
  protocolVersion: string
  method: AuthChannelMethod
  status: 'ok' | 'failed'
  result?: unknown
  /** present for auth.secret.deposit only; the deposit stores the value itself */
  deposit?: SecretDeposit
  error?: { code: AuthTransportErrorCode; message: string; detail?: string }
  audit: Omit<AuthChannelAuditEntry, 'at' | 'method' | 'durationMs'>
}

const requireString = (
  input: Record<string, unknown> | undefined,
  field: string,
  method: string
): string => {
  const value = input?.[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new AuthTransportError('INPUT_INVALID', method + ' requires ' + field)
  }
  return value
}

export interface DedicatedAuthTransportOptions {
  handlers: AuthChannelHandlers
  deposits?: SecretDeposits
  audit?: AuthChannelAuditSink
  now?: () => number
}

/**
 * The dedicated channel the daemon serves outside the receipt pipeline. The only
 * method that sees a raw secret is the deposit; every other method either carries a
 * handle or is secret-free by contract.
 */
export class DedicatedAuthTransport {
  readonly deposits: SecretDeposits
  readonly #handlers: AuthChannelHandlers
  readonly #audit: AuthChannelAuditSink | undefined
  readonly #now: () => number

  constructor(options: DedicatedAuthTransportOptions) {
    this.#handlers = options.handlers
    this.deposits = options.deposits ?? new SecretDeposits()
    this.#audit = options.audit
    this.#now = options.now ?? Date.now
  }

  /** Scope a handle belongs to; a flow id, so a handle cannot cross flows. */
  static scopeForFlow(flowId: string): string {
    return 'flow:' + flowId
  }

  async invoke(request: AuthChannelRequest): Promise<AuthChannelResponse> {
    const startedAt = this.#now()
    const method = request.method
    let flowId: string | undefined
    const settle = (
      status: AuthChannelResponse['status'],
      extra: { result?: unknown; deposit?: SecretDeposit; error?: AuthChannelResponse['error'] }
    ): AuthChannelResponse => {
      this.#audit?.({
        at: startedAt,
        method,
        ...(flowId ? { flowId } : {}),
        outcome: status === 'ok' ? 'ok' : 'failed',
        durationMs: this.#now() - startedAt,
        ...(extra.error ? { code: extra.error.code } : {})
      })
      return {
        protocolVersion: AUTH_CHANNEL_PROTOCOL,
        method,
        status,
        ...(extra.result !== undefined ? { result: extra.result } : {}),
        ...(extra.deposit ? { deposit: extra.deposit } : {}),
        ...(extra.error ? { error: extra.error } : {}),
        audit: {
          outcome: status === 'ok' ? 'ok' : 'failed',
          ...(flowId ? { flowId } : {}),
          ...(extra.error ? { code: extra.error.code } : {})
        }
      }
    }
    const fail = (error: unknown): AuthChannelResponse => {
      const known =
        error instanceof AuthTransportError
          ? error
          : new AuthTransportError(
              'DRIVER_FAILED',
              error instanceof Error ? error.message : 'auth channel call failed'
            )
      this.#audit?.({
        at: startedAt,
        method,
        ...(flowId ? { flowId } : {}),
        outcome: 'rejected',
        durationMs: this.#now() - startedAt,
        code: known.code
      })
      return {
        protocolVersion: AUTH_CHANNEL_PROTOCOL,
        method,
        status: 'failed',
        error: {
          code: known.code,
          message: known.message,
          ...(known.detail ? { detail: known.detail } : {})
        },
        audit: { outcome: 'rejected', ...(flowId ? { flowId } : {}), code: known.code }
      }
    }

    try {
      if (!AUTH_CHANNEL_METHODS.includes(method)) {
        throw new AuthTransportError(
          'UNKNOWN_METHOD',
          'unknown auth channel method ' + String(method)
        )
      }
      const input = request.input ?? {}
      switch (method) {
        case 'auth.secret.deposit': {
          const value = requireString(input, 'secret', method)
          const scope = requireString(input, 'scope', method)
          return settle('ok', { deposit: this.deposits.deposit(value, scope) })
        }
        case 'auth.flow.start': {
          const offeringId = requireString(input, 'offeringId', method)
          const connectionId =
            typeof input.connectionId === 'string' ? input.connectionId : undefined
          const callbackRedirect =
            typeof input.callbackRedirect === 'string' ? input.callbackRedirect : undefined
          assertSecretFree(input, method)
          const view = await this.#handlers.start({
            offeringId,
            ...(connectionId ? { connectionId } : {}),
            ...(callbackRedirect ? { callbackRedirect } : {})
          })
          flowId = view.flowId
          return settle('ok', { result: scrubFlowView(view) })
        }
        case 'auth.flow.submitCode':
        case 'auth.flow.submitSecret': {
          const target = requireString(input, 'flowId', method)
          flowId = target
          const handle = requireString(input, 'handle', method)
          const secret = this.deposits.withdraw(handle, DedicatedAuthTransport.scopeForFlow(target))
          assertSecretFree(input, method)
          const view =
            method === 'auth.flow.submitCode'
              ? await this.#handlers.submitCode({ flowId: target, code: secret })
              : await this.#handlers.submitSecret({ flowId: target, secret })
          return settle('ok', { result: scrubFlowView(view) })
        }
        case 'auth.flow.poll': {
          const target = requireString(input, 'flowId', method)
          flowId = target
          assertSecretFree(input, method)
          return settle('ok', {
            result: scrubFlowView(await this.#handlers.poll({ flowId: target }))
          })
        }
        case 'auth.flow.cancel': {
          const target = requireString(input, 'flowId', method)
          flowId = target
          const reason = typeof input.reason === 'string' ? input.reason : undefined
          assertSecretFree(input, method)
          this.deposits.revokeScope(DedicatedAuthTransport.scopeForFlow(target))
          return settle('ok', {
            result: scrubFlowView(
              await this.#handlers.cancel({ flowId: target, ...(reason ? { reason } : {}) })
            )
          })
        }
        case 'auth.flow.status': {
          const target = requireString(input, 'flowId', method)
          flowId = target
          assertSecretFree(input, method)
          return settle('ok', {
            result: scrubFlowView(await this.#handlers.status({ flowId: target }))
          })
        }
        case 'auth.flow.list': {
          assertSecretFree(input, method)
          return settle('ok', { result: this.#handlers.list().map(scrubFlowView) })
        }
        case 'auth.flow.refresh': {
          const credentialRef = requireString(input, 'credentialRef', method)
          const offeringId = requireString(input, 'offeringId', method)
          const connectionId = requireString(input, 'connectionId', method)
          const expectedMaterialRevision = input.expectedMaterialRevision
          if (
            !Number.isSafeInteger(expectedMaterialRevision) ||
            Number(expectedMaterialRevision) < 1
          ) {
            throw new AuthTransportError(
              'INPUT_INVALID',
              'auth.flow.refresh requires expectedMaterialRevision'
            )
          }
          assertSecretFree(input, method)
          const view = await this.#handlers.refresh({
            credentialRef,
            offeringId,
            connectionId,
            expectedMaterialRevision: Number(expectedMaterialRevision)
          })
          flowId = view.flowId
          return settle('ok', { result: scrubFlowView(view) })
        }
        case 'auth.credential.importLocators': {
          const machineId = requireString(input, 'machineId', method)
          assertSecretFree(input, method)
          return settle('ok', { result: await this.#handlers.importLocators({ machineId }) })
        }
        case 'auth.credential.adoptLocator': {
          const machineId = requireString(input, 'machineId', method)
          const offeringId = requireString(input, 'offeringId', method)
          const credentialId = requireString(input, 'credentialId', method)
          const format = requireString(input, 'format', method)
          if (input.accountContinuity !== 'confirmed-same') {
            throw new AuthTransportError(
              'INPUT_INVALID',
              'adoption requires accountContinuity=confirmed-same; mahas never merges accounts silently'
            )
          }
          assertSecretFree(input, method)
          return settle('ok', {
            result: await this.#handlers.adoptLocator({
              machineId,
              offeringId,
              credentialId,
              accountContinuity: 'confirmed-same',
              format
            })
          })
        }
        case 'auth.quota.collect': {
          // No input: the daemon resolves material from stored credentials itself.
          assertSecretFree(input, method)
          return settle('ok', { result: await this.#handlers.collectQuota() })
        }
        default:
          throw new AuthTransportError(
            'UNKNOWN_METHOD',
            'unknown auth channel method ' + String(method)
          )
      }
    } catch (error) {
      return fail(error)
    }
  }
}
