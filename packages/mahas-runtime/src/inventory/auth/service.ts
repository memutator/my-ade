// inventory/auth/service.ts — the daemon-side auth service.
//
// The daemon owns three things a desktop window may not: sign-in flows that outlive the
// window, the durable intent record that says what a flow was for, and the single
// transaction that turns a completed flow into inventory rows.
//
// Two halves per operation, because the admission pipeline may hold a transaction across
// an awaited handler:
//
//   prepareX()  — effect phase: filesystem and secret-store work, NO transaction held.
//   commitX()   — completion phase: DB writes only, safe inside a caller's transaction
//                 (the deferred admission's tx-2) or wrapped in its own withTx.
//
// Every standalone commit runs through the injected serialized database port. No DDL
// happens here: the control migration owns AUTH_SCHEMA_SQL.

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { JsonObject } from '../../../../mahas-contracts/src/common.ts'
import type { EpochMillis } from '../../../../mahas-contracts/src/ids.ts'
import type {
  CredentialOwnership,
  ProviderCredential,
  ProviderConnection,
  ProviderIdentityClaim
} from '../../../../mahas-contracts/src/inventory/index.ts'
import { mahasError } from '../../api/handler-ports.ts'
import { withTx } from '../../storage/transaction.ts'
import {
  putIdentityClaim,
  putProviderConnection,
  refreshCredential,
  registerCredential,
  replaceCredential
} from '../repository.ts'
import {
  AuthCallbackError,
  UnavailableAuthCallback,
  type AuthCallbackHandle,
  type AuthCallbackPort
} from './callback.ts'
import {
  importedLocatorCredential,
  locatorPathFrom,
  locatorConnectionId,
  LocatorMaterialReader,
  nodeLocatorFileIo,
  probeLocators,
  type CredentialMaterialFormat,
  type LocatorCandidate,
  type LocatorFileIo,
  type LocatorProbe,
  type LocatorRoots,
  type ProviderLocatorCatalog
} from './locators.ts'
import type { ManagedSecretStore } from './secret-store.ts'
import { AuthTransportError, DedicatedAuthTransport, SecretDeposits } from './transport.ts'
import type { AuthChannelHandlers } from './transport.ts'
import type { AuthFlowView, ProviderAuthDriver } from './coordinator.ts'

export type AuthIntentKind = 'login' | 'add-account' | 'replace-account' | 'refresh' | 'repair'
export type AuthIntentState =
  | 'pending'
  | 'needs-input'
  | 'effect-required'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface AuthIntent {
  id: string
  kind: AuthIntentKind
  offeringId: string
  connectionId?: string | null
  credentialId?: string | null
  expectedMaterialRevision?: number | null
  flowId?: string | null
  state: AuthIntentState
  requiredInput?: JsonObject | null
  effect?: JsonObject | null
  errorCode?: string | null
  resultCredentialId?: string | null
  resultConnectionId?: string | null
  createdAt: EpochMillis
  updatedAt: EpochMillis
  completedAt?: EpochMillis | null
  revision: number
}

export interface AuthIntentCompletion {
  intent: AuthIntent
  completed: boolean
  credentialId?: string
  connectionId?: string
  materialRef?: string
  materialRevision?: number
  identityClaimIds: readonly string[]
  replacedCredentialId?: string
}

/**
 * CredentialOwnership has no 'mahas' member yet. Mahas-managed material is persisted as
 * 'machine' — still distinguishable from a user's own file ('user') and from another
 * application's file ('external'), with the provenance row keeping the managed origin.
 * Seam: widen the enum + the inventory_provider_credentials CHECK, then this constant
 * becomes 'mahas'.
 */
export const MANAGED_CREDENTIAL_OWNERSHIP: CredentialOwnership = 'machine'

/** The serialized DB port. Raw withTx is only ever called INSIDE this port. */
export type SerializedDatabase = <T>(work: () => T | Promise<T>) => Promise<T>

export interface AuthServiceDeps {
  db: DatabaseSync
  database: SerializedDatabase
  secrets: ManagedSecretStore
  driver: ProviderAuthDriver
  catalog: ProviderLocatorCatalog
  roots: LocatorRoots
  machineId?: string
  callback?: AuthCallbackPort
  fileIo?: LocatorFileIo
  now?: () => number
  id?: () => string
}

export interface AuthServiceStatus {
  state: 'stopped' | 'ready'
  startedAt?: number
  flows: number
  deposits: number
  intents: { pending: number; interrupted: number; complete: number }
  callbacks: { open: number; port: 'loopback' | 'unavailable' }
  stoppedReason?: string
}

interface IntentRow {
  id: string
  intent_kind: string
  offering_id: string
  connection_id: string | null
  credential_id: string | null
  expected_material_revision: number | null
  flow_id: string | null
  state: string
  required_input_json: string | null
  effect_json: string | null
  error_code: string | null
  result_credential_id: string | null
  result_connection_id: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
  revision: number
}

const parseJson = <T>(text: string | null): T | null => {
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function mapIntent(row: IntentRow): AuthIntent {
  return {
    id: row.id,
    kind: row.intent_kind as AuthIntentKind,
    offeringId: row.offering_id,
    connectionId: row.connection_id,
    credentialId: row.credential_id,
    expectedMaterialRevision: row.expected_material_revision,
    flowId: row.flow_id,
    state: row.state as AuthIntentState,
    requiredInput: parseJson<JsonObject>(row.required_input_json),
    effect: parseJson<JsonObject>(row.effect_json),
    errorCode: row.error_code,
    resultCredentialId: row.result_credential_id,
    resultConnectionId: row.result_connection_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    revision: row.revision
  }
}

/**
 * Flow state as an intent state. A completed FLOW is not a completed INTENT: the
 * credential change, connection and claims still have to be committed, so a finished flow
 * is recorded as 'pending' and only the completion phase may write 'complete'.
 */
function intentStateFromView(view: AuthFlowView): AuthIntentState {
  switch (view.state) {
    case 'complete':
      return 'pending'
    case 'needs-input':
      return 'needs-input'
    case 'effect-required':
      return 'effect-required'
    case 'failed':
      return 'failed'
    default:
      return 'pending'
  }
}

export interface BeginIntentInput {
  kind: AuthIntentKind
  offeringId: string
  connectionId?: string
  credentialId?: string
  expectedMaterialRevision?: number
}

export interface ImportLocatorsInput {
  machineId: string
  /** restrict the import to a subset of the Pack catalog (tests, settings UI) */
  candidates?: readonly LocatorCandidate[]
}

export interface ImportLocatorsResult {
  imported: string[]
  unchanged: string[]
  unavailable: string[]
}

/** Effect-phase output of a locator import. */
export interface PreparedLocatorImport {
  machineId: string
  probes: readonly LocatorProbe[]
  unavailable: readonly string[]
}

export interface AdoptLocatorInput {
  machineId: string
  offeringId: string
  credentialId: string
  /** asserts the same account continues; adoption never merges accounts silently */
  accountContinuity: 'confirmed-same'
  format: CredentialMaterialFormat
  authScope?: readonly string[]
}

export interface AdoptLocatorResult {
  replacedCredentialId: string
  credentialId: string
  connectionId: string
  materialRef: string
  materialRevision: number
  identityClaimIds: readonly string[]
}

/** Effect-phase output of adoption; the completion phase consumes it. */
export interface PreparedAdoption {
  input: AdoptLocatorInput
  replacedCredentialId: string
  machineId: string
  locatorRef: string
  materialRef: string
  materialRevision: number
}

export class AuthService {
  readonly #db: DatabaseSync
  readonly #database: SerializedDatabase
  readonly #secrets: ManagedSecretStore
  readonly #driver: ProviderAuthDriver
  readonly #catalog: ProviderLocatorCatalog
  readonly #roots: LocatorRoots
  readonly #machineId: string | undefined
  readonly #callback: AuthCallbackPort
  readonly #material: LocatorMaterialReader
  readonly #fileIo: LocatorFileIo
  readonly #now: () => number
  readonly #id: () => string
  readonly #callbacks = new Map<string, AuthCallbackHandle>()
  readonly #flowErrors = new Map<string, string>()
  readonly #channelIntents = new Map<string, string>()
  readonly #callbackWork = new Set<Promise<void>>()
  readonly deposits: SecretDeposits
  #state: AuthServiceStatus['state'] = 'stopped'
  #startedAt: number | undefined
  #stoppedReason: string | undefined

  constructor(deps: AuthServiceDeps) {
    this.#db = deps.db
    this.#database = deps.database
    this.#secrets = deps.secrets
    this.#driver = deps.driver
    this.#catalog = deps.catalog
    this.#roots = deps.roots
    this.#machineId = deps.machineId
    this.#callback = deps.callback ?? new UnavailableAuthCallback()
    this.#fileIo = deps.fileIo ?? nodeLocatorFileIo
    this.#material = new LocatorMaterialReader(deps.catalog, this.#fileIo)
    this.#now = deps.now ?? Date.now
    this.#id = deps.id ?? randomUUID
    this.deposits = new SecretDeposits({ now: this.#now })
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Ready the service. The schema fragment is applied by the control migration, so boot
   * only sweeps ephemeral state: deposits die with the previous process, and an intent that
   * was waiting for input can no longer be completed by the flow it named.
   */
  async boot(): Promise<AuthServiceStatus> {
    if (this.#state === 'ready') return this.status()
    this.#state = 'ready'
    this.#startedAt = this.#now()
    this.#stoppedReason = undefined
    this.deposits.clear()
    await this.markInterruptedIntents()
    return this.status()
  }

  /** Teardown: cancel live flows, close listeners, drop pending secrets. */
  async shutdown(reason = 'daemon shutdown'): Promise<AuthServiceStatus> {
    for (const [flowId, handle] of [...this.#callbacks]) {
      handle.close()
      this.#callbacks.delete(flowId)
      try {
        this.#driver.cancel(flowId, reason)
      } catch {
        // a driver that cannot cancel must not block teardown
      }
    }
    await Promise.allSettled([...this.#callbackWork])
    this.#channelIntents.clear()
    this.deposits.clear()
    this.#state = 'stopped'
    this.#stoppedReason = reason
    return this.status()
  }

  status(): AuthServiceStatus {
    const counts = this.#db
      .prepare(
        "SELECT SUM(CASE WHEN state IN ('pending','needs-input','effect-required') THEN 1 ELSE 0 END) AS pending, " +
          "SUM(CASE WHEN state='interrupted' THEN 1 ELSE 0 END) AS interrupted, " +
          "SUM(CASE WHEN state='complete' THEN 1 ELSE 0 END) AS complete FROM auth_intents"
      )
      .get() as { pending: number | null; interrupted: number | null; complete: number | null }
    return {
      state: this.#state,
      ...(this.#startedAt !== undefined ? { startedAt: this.#startedAt } : {}),
      flows: this.#callbacks.size,
      deposits: this.deposits.size(),
      intents: {
        pending: Number(counts.pending ?? 0),
        interrupted: Number(counts.interrupted ?? 0),
        complete: Number(counts.complete ?? 0)
      },
      callbacks: {
        open: this.#callbacks.size,
        port: this.#callback instanceof UnavailableAuthCallback ? 'unavailable' : 'loopback'
      },
      ...(this.#stoppedReason ? { stoppedReason: this.#stoppedReason } : {})
    }
  }

  #requireReady(): void {
    if (this.#state !== 'ready') {
      throw new AuthTransportError('SERVICE_STOPPED', 'the auth service is not running')
    }
  }

  // Low-level flow effects; durable channel handlers below commit separately.

  async start(
    input: {
      offeringId: string
      connectionId?: string
      callbackRedirect?: string
    },
    channelIntentId?: string
  ): Promise<AuthFlowView> {
    this.#requireReady()
    const opened = await this.#openCallback(input.offeringId, input.callbackRedirect)
    try {
      const view = await this.#driver.start({
        offeringId: input.offeringId,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        ...(opened.redirect ? { callbackRedirect: opened.redirect } : {})
      })
      if (channelIntentId) {
        this.#channelIntents.set(view.flowId, channelIntentId)
        await this.#persistChannelFlow(view)
      }
      if (opened.handle && view.state === 'effect-required') {
        this.#callbacks.set(view.flowId, opened.handle)
        this.#watchCallback(view.flowId, opened.handle)
      } else if (opened.handle) {
        opened.handle.close()
      }
      return view
    } catch (error) {
      opened.handle?.close()
      throw error
    }
  }

  async submitCode(input: { flowId: string; code: string }): Promise<AuthFlowView> {
    const view = await this.#driver.submitCode(input.flowId, input.code)
    this.#settleFlow(input.flowId, view)
    return view
  }

  async submitSecret(input: { flowId: string; secret: string }): Promise<AuthFlowView> {
    const view = await this.#driver.submitSecret(input.flowId, input.secret)
    this.#settleFlow(input.flowId, view)
    return view
  }

  async poll(input: { flowId: string }): Promise<AuthFlowView> {
    const view = await this.#driver.poll(input.flowId)
    this.#settleFlow(input.flowId, view)
    return view
  }

  cancel(input: { flowId: string; reason?: string }): AuthFlowView {
    this.#closeCallback(input.flowId)
    this.deposits.revokeScope(DedicatedAuthTransport.scopeForFlow(input.flowId))
    return this.#driver.cancel(input.flowId, input.reason)
  }

  /** Flow status with any callback-side error folded in. */
  flowStatus(input: { flowId: string }): AuthFlowView {
    const view = this.#driver.status(input.flowId)
    const recorded = this.#flowErrors.get(input.flowId)
    return recorded ? { ...view, error: recorded } : view
  }

  /**
   * The AuthChannelHandlers projection. Flow methods come from this service; the
   * secret-free management methods (locator import/adoption, quota collection) are supplied
   * by the composition that owns those domains.
   */
  channelHandlers(extra?: {
    importLocators?(input: { machineId: string }): Promise<unknown>
    adoptLocator?(input: {
      machineId: string
      offeringId: string
      credentialId: string
      accountContinuity: 'confirmed-same'
      format: string
    }): Promise<unknown>
    collectQuota?(): Promise<unknown>
  }): AuthChannelHandlers {
    return {
      start: (input) => this.start(input),
      submitCode: (input) => this.submitCode(input),
      submitSecret: (input) => this.submitSecret(input),
      poll: (input) => this.poll(input),
      cancel: (input) => this.cancel(input),
      status: (input) => this.flowStatus(input),
      list: () => this.list(),
      refresh: (input) => this.refresh(input),
      importLocators:
        extra?.importLocators ?? ((input) => this.importLocators({ machineId: input.machineId })),
      adoptLocator:
        extra?.adoptLocator ??
        ((input) =>
          this.adoptLocator({
            machineId: input.machineId,
            offeringId: input.offeringId,
            credentialId: input.credentialId,
            accountContinuity: 'confirmed-same',
            format: input.format
          })),
      collectQuota:
        extra?.collectQuota ??
        (() => Promise.reject(new Error('quota collection is not available in this composition')))
    }
  }

  /** User-facing flows own their durable intent. Secret effects finish outside
   * the writer queue; only inventory/public progress commits enter it. */
  durableChannelHandlers(
    extra?: Parameters<AuthService['channelHandlers']>[0]
  ): AuthChannelHandlers {
    const raw = this.channelHandlers(extra)
    return {
      ...raw,
      start: async (input) => {
        this.#requireReady()
        const intent = await this.#database(() => {
          const existing = input.connectionId
            ? this.#connectionForChannel(input.connectionId, input.offeringId)
            : null
          return this.beginIntent({
            kind: existing ? 'replace-account' : 'login',
            offeringId: input.offeringId,
            ...(existing
              ? { connectionId: input.connectionId, credentialId: existing.credentialId }
              : {})
          })
        })
        try {
          const view = await this.start(input, intent.id)
          return this.#persistChannelFlow(view)
        } catch (error) {
          await this.#database(() =>
            this.recordFlow(intent.id, {
              flowId: '',
              state: 'failed',
              error: 'auth-start-failed'
            })
          )
          throw error
        }
      },
      submitCode: async (input) => this.#persistChannelFlow(await raw.submitCode(input)),
      submitSecret: async (input) => this.#persistChannelFlow(await raw.submitSecret(input)),
      poll: async (input) => this.#persistChannelFlow(await raw.poll(input)),
      status: async (input) => this.#persistChannelFlow(await raw.status(input)),
      cancel: async (input) => {
        const view = await raw.cancel(input)
        await this.#persistChannelFlow(view)
        const intentId = this.#channelIntents.get(input.flowId)
        if (intentId)
          await this.#database(() => {
            this.#db
              .prepare(
                "UPDATE auth_intents SET state='cancelled',updated_at=?,revision=revision+1 WHERE id=? AND state!='complete'"
              )
              .run(this.#now(), intentId)
          })
        return view
      },
      refresh: async (input) => {
        this.#requireReady()
        const intent = await this.#database(() => {
          const existing = this.#connectionForChannel(input.connectionId, input.offeringId)
          if (
            existing.materialRef !== input.credentialRef ||
            existing.materialRevision !== input.expectedMaterialRevision
          ) {
            throw new AuthTransportError(
              'INPUT_INVALID',
              'credential reference or revision does not match the connection'
            )
          }
          return this.beginIntent({
            kind: 'refresh',
            offeringId: input.offeringId,
            connectionId: input.connectionId,
            credentialId: existing.credentialId,
            expectedMaterialRevision: input.expectedMaterialRevision
          })
        })
        try {
          const view = await raw.refresh(input)
          this.#channelIntents.set(view.flowId, intent.id)
          return this.#persistChannelFlow(view)
        } catch (error) {
          await this.#database(() =>
            this.recordFlow(intent.id, {
              flowId: '',
              state: 'failed',
              error: 'auth-refresh-failed'
            })
          )
          throw error
        }
      }
    }
  }

  #connectionForChannel(
    connectionId: string,
    offeringId: string
  ): {
    credentialId: string
    materialRef: string
    materialRevision: number
  } {
    const row = this.#db
      .prepare(
        'SELECT c.credential_id,p.material_ref,p.material_revision FROM inventory_provider_connections c ' +
          'JOIN inventory_provider_credentials p ON p.id=c.credential_id WHERE c.id=? AND c.offering_id=? ' +
          'AND c.observed_until IS NULL AND p.observed_until IS NULL'
      )
      .get(connectionId, offeringId) as
      { credential_id: string; material_ref: string; material_revision: number } | undefined
    if (!row)
      throw new AuthTransportError(
        'INPUT_INVALID',
        'connection is missing, closed or belongs to another offering'
      )
    return {
      credentialId: row.credential_id,
      materialRef: row.material_ref,
      materialRevision: row.material_revision
    }
  }

  async #persistChannelFlow(view: AuthFlowView): Promise<AuthFlowView> {
    const intentId = this.#channelIntents.get(view.flowId)
    if (!intentId) return view
    const completion = await this.#database(() =>
      withTx(this.#db, (db) => {
        const current = this.#intentOf(db, intentId)
        // A status read cannot reopen a cancelled flow or regress a committed intent.
        if (current?.state === 'cancelled') return null
        if (!current?.resultCredentialId) this.recordFlowInTransaction(db, intentId, view)
        return this.commitCompletionInTransaction(db, intentId, view)
      })
    )
    return completion?.completed
      ? { ...view, connectionId: completion.connectionId, credentialId: completion.credentialId }
      : view
  }

  list(): readonly AuthFlowView[] {
    const flows = typeof this.#driver.list === 'function' ? this.#driver.list() : []
    return flows.map((view) => {
      const recorded = this.#flowErrors.get(view.flowId)
      return recorded ? { ...view, error: recorded } : view
    })
  }

  async refresh(input: {
    credentialRef: string
    expectedMaterialRevision: number
    offeringId: string
    connectionId: string
  }): Promise<AuthFlowView> {
    this.#requireReady()
    return this.#driver.refresh(input)
  }

  // ── intents ──────────────────────────────────────────────────────────────

  beginIntent(input: BeginIntentInput): AuthIntent {
    const now = this.#now()
    const intent: AuthIntent = {
      id: this.#id(),
      kind: input.kind,
      offeringId: input.offeringId,
      connectionId: input.connectionId ?? null,
      credentialId: input.credentialId ?? null,
      expectedMaterialRevision: input.expectedMaterialRevision ?? null,
      flowId: null,
      state: 'pending',
      requiredInput: null,
      effect: null,
      errorCode: null,
      resultCredentialId: null,
      resultConnectionId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      revision: 1
    }
    withTx(this.#db, (db) => {
      db.prepare(
        'INSERT INTO auth_intents ' +
          '(id,intent_kind,offering_id,connection_id,credential_id,expected_material_revision,flow_id,state,' +
          'required_input_json,effect_json,error_code,result_credential_id,result_connection_id,' +
          'created_at,updated_at,completed_at,revision) ' +
          'VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?,NULL,1)'
      ).run(
        intent.id,
        intent.kind,
        intent.offeringId,
        intent.connectionId ?? null,
        intent.credentialId ?? null,
        intent.expectedMaterialRevision ?? null,
        intent.flowId ?? null,
        intent.state,
        now,
        now
      )
    })
    return intent
  }

  getIntent(intentId: string): AuthIntent | null {
    return this.#intentOf(this.#db, intentId)
  }

  listIntents(
    filter: { state?: AuthIntentState; offeringId?: string; limit?: number } = {}
  ): AuthIntent[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 500))
    const rows =
      filter.state && filter.offeringId
        ? this.#db
            .prepare(
              'SELECT * FROM auth_intents WHERE state=? AND offering_id=? ORDER BY created_at DESC LIMIT ?'
            )
            .all(filter.state, filter.offeringId, limit)
        : filter.state
          ? this.#db
              .prepare('SELECT * FROM auth_intents WHERE state=? ORDER BY created_at DESC LIMIT ?')
              .all(filter.state, limit)
          : filter.offeringId
            ? this.#db
                .prepare(
                  'SELECT * FROM auth_intents WHERE offering_id=? ORDER BY created_at DESC LIMIT ?'
                )
                .all(filter.offeringId, limit)
            : this.#db
                .prepare('SELECT * FROM auth_intents ORDER BY created_at DESC LIMIT ?')
                .all(limit)
    return (rows as unknown as IntentRow[]).map(mapIntent)
  }

  #intentOf(db: DatabaseSync, intentId: string): AuthIntent | null {
    const row = db.prepare('SELECT * FROM auth_intents WHERE id=?').get(intentId) as
      IntentRow | undefined
    return row ? mapIntent(row) : null
  }

  /** Record where a flow got to: public fields only, never material. */
  recordFlow(intentId: string, view: AuthFlowView): AuthIntent {
    return withTx(this.#db, (db) => this.recordFlowInTransaction(db, intentId, view))
  }

  /** The DB half of recordFlow; the caller owns the transaction. */
  recordFlowInTransaction(db: DatabaseSync, intentId: string, view: AuthFlowView): AuthIntent {
    const current = this.#intentOf(db, intentId)
    if (!current)
      throw mahasError('MODEL_INVALID', 'auth intent ' + intentId + ' does not exist', 'none')
    if (current.state === 'complete') return current
    const state = intentStateFromView(view)
    const now = this.#now()
    db.prepare(
      'UPDATE auth_intents SET state=?, flow_id=?, required_input_json=?, effect_json=?, error_code=?,' +
        ' updated_at=?, completed_at=?, revision=revision+1 WHERE id=?'
    ).run(
      state,
      view.flowId,
      view.requiredInput ? JSON.stringify(view.requiredInput) : null,
      view.effect ? JSON.stringify(view.effect) : null,
      view.state === 'failed' ? (view.error ?? 'auth-failed').slice(0, 200) : null,
      now,
      state === 'complete' ? now : null,
      intentId
    )
    return this.#intentOf(db, intentId) as AuthIntent
  }

  /**
   * Standalone completion: read the flow status (a driver call, no transaction) and then
   * commit. The deferred operation path uses the two halves instead.
   */
  async completeIntent(intentId: string): Promise<AuthIntentCompletion> {
    const intent = this.getIntent(intentId)
    if (!intent)
      throw mahasError('MODEL_INVALID', 'auth intent ' + intentId + ' does not exist', 'none')
    if (intent.flowId && intent.state !== 'complete') {
      const view = this.flowStatus({ flowId: intent.flowId })
      return this.#database(() => this.commitCompletionInTransaction(this.#db, intentId, view))
    }
    return this.#database(() =>
      this.commitCompletionInTransaction(this.#db, intentId, {
        flowId: intent.flowId ?? '',
        state: 'unknown'
      })
    )
  }

  /**
   * Completion phase: credential change, connection (with account replacement when asked),
   * identity claims and the intent update in ONE transaction. DB only — safe inside a
   * caller's transaction, including the deferred admission's tx-2.
   */
  commitCompletionInTransaction(
    db: DatabaseSync,
    intentId: string,
    view: AuthFlowView
  ): AuthIntentCompletion {
    const intent = this.#intentOf(db, intentId)
    if (!intent)
      throw mahasError('MODEL_INVALID', 'auth intent ' + intentId + ' does not exist', 'none')
    if (intent.state === 'complete' && intent.resultCredentialId) {
      return {
        intent,
        completed: true,
        credentialId: intent.resultCredentialId,
        ...(intent.resultConnectionId ? { connectionId: intent.resultConnectionId } : {}),
        identityClaimIds: []
      }
    }
    if (view.state !== 'complete') {
      const recorded = this.recordFlowInTransaction(db, intentId, view)
      return { intent: recorded, completed: false, identityClaimIds: [] }
    }
    return this.#commitCompletion(db, intent, view)
  }

  #commitCompletion(
    db: DatabaseSync,
    intent: AuthIntent,
    view: AuthFlowView
  ): AuthIntentCompletion {
    const change = view.credentialChange
    if (!change)
      throw mahasError('MODEL_INVALID', 'a completed flow must report a credential change', 'none')
    const claims = view.identityClaims ?? []
    const now = this.#now()
    if (intent.kind === 'refresh') {
      if (claims.length === 0) {
        throw mahasError(
          'INVALID_TRANSITION',
          'a refresh needs affirmative same-account evidence before the revision advances',
          'none'
        )
      }
      if (!intent.credentialId || intent.expectedMaterialRevision == null) {
        throw mahasError(
          'MODEL_INVALID',
          'refresh intent is missing its credential revision',
          'none'
        )
      }
      refreshCredential(db, {
        credentialId: intent.credentialId,
        expectedMaterialRevision: intent.expectedMaterialRevision,
        nextMaterialRevision: change.materialRevision,
        observedAt: now,
        accountContinuity: 'confirmed-same',
        availability: 'available'
      })
      const claimIds = this.#putClaims(
        db,
        intent.connectionId ?? null,
        claims,
        now,
        'credential refresh'
      )
      const updated = this.#completeIntentRow(db, intent.id, {
        credentialId: intent.credentialId,
        connectionId: intent.connectionId ?? null,
        now
      })
      return {
        intent: updated,
        completed: true,
        credentialId: intent.credentialId,
        ...(intent.connectionId ? { connectionId: intent.connectionId } : {}),
        identityClaimIds: claimIds
      }
    }

    const replacement = intent.kind === 'replace-account'
    if (replacement && !intent.credentialId) {
      throw mahasError('MODEL_INVALID', 'replace-account needs the credential it replaces', 'none')
    }
    const credentialId = this.#id()
    const connectionId = this.#id()
    const credential: ProviderCredential = {
      id: credentialId,
      machineId: this.#machineOf(db, intent.credentialId ?? null),
      materialRef: change.materialRef,
      materialRevision: change.materialRevision,
      ownership: MANAGED_CREDENTIAL_OWNERSHIP,
      availability: 'available',
      firstSeenAt: now,
      lastSeenAt: now
    }
    const connection: ProviderConnection = {
      id: connectionId,
      offeringId: intent.offeringId,
      credentialId,
      authScope: null,
      firstSeenAt: now,
      observedUntil: null,
      availability: 'available',
      origin: 'registered'
    }
    let replacedCredentialId: string | undefined
    if (replacement) {
      replaceCredential(db, {
        oldCredentialId: intent.credentialId as string,
        replacement: credential,
        replacedAt: now
      })
      replacedCredentialId = intent.credentialId as string
    } else {
      registerCredential(db, credential)
    }
    putProviderConnection(db, connection)
    db.prepare(
      'INSERT INTO auth_credential_provenance(credential_id,origin,locator_ref,imported_at,evidence_json)' +
        ' VALUES(?,?,?,?,?)' +
        ' ON CONFLICT(credential_id) DO UPDATE SET origin=excluded.origin,' +
        ' imported_at=excluded.imported_at, evidence_json=excluded.evidence_json'
    ).run(
      credentialId,
      'managed',
      null,
      now,
      JSON.stringify({ flowId: view.flowId, intentId: intent.id, kind: change.kind })
    )
    const claimIds = this.#putClaims(db, connectionId, claims, now, 'sign-in')
    const updated = this.#completeIntentRow(db, intent.id, { credentialId, connectionId, now })
    return {
      intent: updated,
      completed: true,
      credentialId,
      connectionId,
      materialRef: change.materialRef,
      materialRevision: change.materialRevision,
      identityClaimIds: claimIds,
      ...(replacedCredentialId ? { replacedCredentialId } : {})
    }
  }

  #completeIntentRow(
    db: DatabaseSync,
    intentId: string,
    result: { credentialId: string | null; connectionId: string | null; now: number }
  ): AuthIntent {
    db.prepare(
      "UPDATE auth_intents SET state='complete', result_credential_id=?, result_connection_id=?," +
        ' completed_at=?, updated_at=?, revision=revision+1 WHERE id=?'
    ).run(result.credentialId, result.connectionId, result.now, result.now, intentId)
    return this.#intentOf(db, intentId) as AuthIntent
  }

  #machineOf(db: DatabaseSync, credentialId: string | null): string {
    if (credentialId) {
      const row = db
        .prepare('SELECT machine_id FROM inventory_provider_credentials WHERE id=?')
        .get(credentialId) as { machine_id: string } | undefined
      if (row) return row.machine_id
    }
    if (this.#machineId) return this.#machineId
    const machine = db
      .prepare('SELECT id FROM inventory_machines ORDER BY last_seen_at DESC LIMIT 1')
      .get() as { id: string } | undefined
    if (!machine)
      throw mahasError('MODEL_INVALID', 'no machine is registered for this credential', 'none')
    return machine.id
  }

  #putClaims(
    db: DatabaseSync,
    connectionId: string | null,
    claims: readonly ProviderIdentityClaim[],
    now: number,
    evidenceLabel: string
  ): string[] {
    if (!connectionId) return []
    const ids: string[] = []
    for (const claim of claims) {
      const value: ProviderIdentityClaim = {
        id: claim.id,
        connectionId,
        kind: claim.kind,
        value: claim.value,
        observedAt: now,
        validUntil: claim.validUntil ?? null,
        confidence: claim.confidence,
        evidence: [...(claim.evidence ?? []), { description: evidenceLabel }]
      }
      putIdentityClaim(db, value)
      ids.push(value.id)
    }
    return ids
  }

  // ── existing locators ────────────────────────────────────────────────────

  /** Effect phase: probe the credential files the Pack catalog points at. */
  async prepareLocatorImport(input: ImportLocatorsInput): Promise<PreparedLocatorImport> {
    const candidates = input.candidates ?? this.#catalog.candidates(this.#roots)
    const probes = await probeLocators(candidates, this.#fileIo)
    return {
      machineId: input.machineId,
      probes: probes.filter((probe) => probe.available),
      unavailable: probes.filter((probe) => !probe.available).map((probe) => probe.ref)
    }
  }

  /**
   * Completion phase: register the probed files as read-only locator references. DB only,
   * so it is safe inside a caller's transaction.
   */
  commitLocatorImportInTransaction(
    db: DatabaseSync,
    prepared: PreparedLocatorImport
  ): ImportLocatorsResult {
    const now = this.#now()
    const imported: string[] = []
    const unchanged: string[] = []
    for (const probe of prepared.probes) {
      const record = importedLocatorCredential({ machineId: prepared.machineId, probe, now })
      // The locator lineages of two offerings may point at the same file. The lookup is
      // scoped to THIS offering's lineage: the deterministic credential id already encodes
      // (machine, offering, ref), and successor credentials (post-split, adopted) carry a
      // connection — open or closed — for the offering. Another offering's rows must not
      // resolve as 'existing', or a second offering would hijack the first's history.
      const existing = db
        .prepare(
          'SELECT p.evidence_json,c.id,c.availability,c.observed_until,c.material_ref,p.origin' +
            ' FROM auth_credential_provenance p JOIN inventory_provider_credentials c ON c.id=p.credential_id' +
            ' WHERE p.locator_ref=? AND c.machine_id=?' +
            ' AND (c.id=? OR EXISTS(SELECT 1 FROM inventory_provider_connections pc' +
            ' WHERE pc.credential_id=c.id AND pc.offering_id=?))' +
            ' ORDER BY p.imported_at DESC,c.rowid DESC LIMIT 1'
        )
        .get(record.ref, prepared.machineId, record.credential.id, probe.candidate.offeringId) as
        | {
            id: string
            evidence_json: string
            availability: string
            observed_until: number | null
            material_ref: string
            origin: string
          }
        | undefined
      // Adoption moves ownership into the managed store. A later discovery of
      // the old CLI file must not reactivate it or undo an explicit removal.
      if (existing && (existing.origin === 'adopted-locator' || existing.observed_until != null)) {
        unchanged.push(existing.id)
        continue
      }
      const previousConnection = existing
        ? (db
            .prepare(
              'SELECT id,observed_until FROM inventory_provider_connections WHERE credential_id=? AND offering_id=? ORDER BY rowid DESC LIMIT 1'
            )
            .get(existing.id, probe.candidate.offeringId) as
            { id: string; observed_until: number | null } | undefined)
        : undefined
      if (previousConnection?.observed_until != null) {
        unchanged.push(existing!.id)
        continue
      }
      const evidence = JSON.stringify(record.evidence)
      let credentialId = existing?.id ?? record.credential.id
      if (
        existing &&
        existing.evidence_json === evidence &&
        existing.availability === 'available'
      ) {
        db.prepare('UPDATE inventory_provider_credentials SET last_seen_at=? WHERE id=?').run(
          now,
          credentialId
        )
        unchanged.push(credentialId)
      } else {
        if (existing) {
          // A changed external file is not affirmative same-account evidence.
          // Split its history conservatively; do not label an mtime change as
          // a confirmed token refresh and merge different accounts' quota.
          credentialId = this.#id()
          replaceCredential(db, {
            oldCredentialId: existing.id,
            replacement: { ...record.credential, id: credentialId },
            replacedAt: now
          })
        } else registerCredential(db, record.credential)
        db.prepare(
          'INSERT INTO auth_credential_provenance(credential_id,origin,locator_ref,imported_at,evidence_json) VALUES(?,?,?,?,?)'
        ).run(credentialId, 'imported-locator', record.ref, now, evidence)
        imported.push(credentialId)
      }
      // The Pack's candidate is evidence for its offering only. Registering a
      // connection enables quota; no harness binding or account identity is inferred.
      if (!previousConnection || credentialId !== existing?.id)
        putProviderConnection(db, {
          id: locatorConnectionId(credentialId),
          offeringId: probe.candidate.offeringId,
          credentialId,
          firstSeenAt: now,
          availability: 'available',
          origin: 'discovered'
        })
    }
    return { imported, unchanged, unavailable: [...prepared.unavailable] }
  }

  /** Standalone import: probe, then commit in one serialized section. */
  importLocators(input: ImportLocatorsInput): Promise<ImportLocatorsResult> {
    return this.prepareLocatorImport(input).then((prepared) =>
      this.#database(() =>
        withTx(this.#db, (db) => this.commitLocatorImportInTransaction(db, prepared))
      )
    )
  }

  /**
   * Effect phase of adoption: read the user's file and copy its material into the managed
   * store. No transaction is held while this runs.
   */
  async prepareAdoption(input: AdoptLocatorInput): Promise<PreparedAdoption> {
    if (input.accountContinuity !== 'confirmed-same') {
      throw mahasError(
        'MODEL_INVALID',
        'locator adoption requires confirmed account continuity',
        'none'
      )
    }
    const row = this.#credentialForAdoption(input.credentialId)
    const material = await this.#material.read(input.format, row.material_ref)
    const stored = await this.#secrets.put({
      offeringId: input.offeringId,
      material,
      ownership: 'mahas'
    })
    return {
      input,
      replacedCredentialId: row.id,
      machineId: input.machineId || row.machine_id,
      locatorRef: row.material_ref,
      materialRef: stored.ref,
      materialRevision: stored.revision
    }
  }

  /**
   * Completion phase of adoption: the locator credential ends, the managed credential and
   * its connection are registered and the carried identity claims are rewritten. DB only.
   */
  commitAdoptionInTransaction(db: DatabaseSync, prepared: PreparedAdoption): AdoptLocatorResult {
    const now = this.#now()
    const credential: ProviderCredential = {
      id: this.#id(),
      machineId: prepared.machineId,
      materialRef: prepared.materialRef,
      materialRevision: prepared.materialRevision,
      ownership: MANAGED_CREDENTIAL_OWNERSHIP,
      availability: 'available',
      firstSeenAt: now,
      lastSeenAt: now
    }
    const connectionId = this.#id()
    const connection: ProviderConnection = {
      id: connectionId,
      offeringId: prepared.input.offeringId,
      credentialId: credential.id,
      authScope: prepared.input.authScope ?? null,
      firstSeenAt: now,
      observedUntil: null,
      availability: 'available',
      origin: 'registered'
    }
    const carried = this.#latestClaimsOf(db, prepared.replacedCredentialId)
    replaceCredential(db, {
      oldCredentialId: prepared.replacedCredentialId,
      replacement: credential,
      replacedAt: now
    })
    putProviderConnection(db, connection)
    db.prepare(
      'INSERT INTO auth_credential_provenance(credential_id,origin,locator_ref,imported_at,evidence_json)' +
        ' VALUES(?,?,?,?,?)'
    ).run(
      credential.id,
      'adopted-locator',
      prepared.locatorRef,
      now,
      JSON.stringify({ adoptedFrom: prepared.replacedCredentialId, format: prepared.input.format })
    )
    const claimIds = this.#putClaims(db, connectionId, carried, now, 'material adoption')
    return {
      replacedCredentialId: prepared.replacedCredentialId,
      credentialId: credential.id,
      connectionId,
      materialRef: prepared.materialRef,
      materialRevision: prepared.materialRevision,
      identityClaimIds: claimIds
    }
  }

  /** Standalone adoption: effect phase, then the commit in one serialized section. */
  async adoptLocator(input: AdoptLocatorInput): Promise<AdoptLocatorResult> {
    const prepared = await this.prepareAdoption(input)
    return this.#database(() =>
      withTx(this.#db, (db) => this.commitAdoptionInTransaction(db, prepared))
    )
  }

  #credentialForAdoption(credentialId: string): {
    id: string
    machine_id: string
    material_ref: string
  } {
    const row = this.#db
      .prepare('SELECT * FROM inventory_provider_credentials WHERE id=?')
      .get(credentialId) as
      | { id: string; machine_id: string; material_ref: string; observed_until: number | null }
      | undefined
    if (!row) throw mahasError('MODEL_INVALID', 'credential to adopt does not exist', 'none')
    if (row.observed_until != null) {
      throw mahasError('INVALID_TRANSITION', 'credential was already replaced', 'none')
    }
    if (!locatorPathFrom(row.material_ref)) {
      throw mahasError(
        'INVALID_TRANSITION',
        'credential is not backed by an existing locator file',
        'none'
      )
    }
    return row
  }

  #latestClaimsOf(db: DatabaseSync, credentialId: string): ProviderIdentityClaim[] {
    const rows = db
      .prepare(
        'SELECT c.* FROM inventory_identity_claims c' +
          ' JOIN inventory_provider_connections p ON p.id=c.connection_id' +
          ' WHERE p.credential_id=? AND p.observed_until IS NULL ORDER BY c.observed_at ASC'
      )
      .all(credentialId) as Array<Record<string, unknown>>
    const latest = new Map<string, ProviderIdentityClaim>()
    for (const row of rows) {
      const claim: ProviderIdentityClaim = {
        id: String(row.id),
        connectionId: String(row.connection_id),
        kind: String(row.kind),
        value: String(row.claim_value),
        observedAt: Number(row.observed_at),
        validUntil: row.valid_until == null ? null : Number(row.valid_until),
        confidence: String(row.confidence) as ProviderIdentityClaim['confidence'],
        evidence:
          parseJson<ProviderIdentityClaim['evidence'][number][]>(String(row.evidence_json)) ?? []
      }
      latest.set(claim.kind + ':' + claim.value, claim)
    }
    return [...latest.values()]
  }

  /** Provenance for one credential: managed, imported or adopted. */
  provenance(
    credentialId: string
  ): { origin: string; locatorRef: string | null; importedAt: number } | null {
    const row = this.#db
      .prepare(
        'SELECT origin, locator_ref, imported_at FROM auth_credential_provenance WHERE credential_id=?'
      )
      .get(credentialId) as
      { origin: string; locator_ref: string | null; imported_at: number } | undefined
    return row
      ? { origin: row.origin, locatorRef: row.locator_ref, importedAt: Number(row.imported_at) }
      : null
  }

  /** Pending work that a previous process could no longer finish. */
  markInterruptedIntents(): Promise<number> {
    const now = this.#now()
    return this.#database(() =>
      withTx(this.#db, (db) => {
        const result = db
          .prepare(
            "UPDATE auth_intents SET state='interrupted', updated_at=?, revision=revision+1" +
              " WHERE state IN ('pending','needs-input','effect-required')"
          )
          .run(now)
        return Number(result.changes)
      })
    )
  }

  // ── callback plumbing ────────────────────────────────────────────────────

  async #openCallback(
    offeringId: string,
    callbackRedirect?: string
  ): Promise<{ redirect?: string; handle: AuthCallbackHandle | null }> {
    if (callbackRedirect) return { redirect: callbackRedirect, handle: null }
    const spec =
      typeof this.#driver.callbackSpec === 'function' ? this.#driver.callbackSpec(offeringId) : null
    if (!spec) return { handle: null }
    try {
      const handle = await this.#callback.open({
        host: spec.host ?? '127.0.0.1',
        port: spec.port ?? 0,
        path: spec.path
      })
      const redirect =
        spec.mode === 'provider-registered' ? (spec.redirect ?? handle.redirect) : handle.redirect
      return { redirect, handle }
    } catch (error) {
      if (error instanceof AuthCallbackError && error.code === 'UNAVAILABLE')
        return { handle: null }
      throw error
    }
  }

  /**
   * The browser completes the redirect on its own; the daemon finishes the token exchange as
   * soon as the code lands, so a closed window cannot strand a flow.
   */
  #watchCallback(flowId: string, handle: AuthCallbackHandle): void {
    const work = handle
      .awaitResult()
      .then(async (result) => {
        const code = result.state ? result.code + '#' + result.state : result.code
        try {
          const view = await this.#driver.submitCode(flowId, code)
          this.#settleFlow(flowId, view)
          await this.#persistChannelFlow(view)
        } catch (error) {
          this.#flowErrors.set(
            flowId,
            error instanceof Error ? error.message : 'callback completion failed'
          )
        } finally {
          this.#closeCallback(flowId)
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof AuthCallbackError) || error.code !== 'CLOSED') {
          this.#flowErrors.set(flowId, error instanceof Error ? error.message : 'callback failed')
        }
        this.#closeCallback(flowId)
      })
    this.#callbackWork.add(work)
    void work.finally(() => this.#callbackWork.delete(work))
  }

  #settleFlow(flowId: string, view: AuthFlowView): void {
    if (view.state === 'complete' || view.state === 'failed') this.#closeCallback(flowId)
    if (view.state === 'complete') {
      this.deposits.revokeScope(DedicatedAuthTransport.scopeForFlow(flowId))
    }
  }

  #closeCallback(flowId: string): void {
    const handle = this.#callbacks.get(flowId)
    if (!handle) return
    this.#callbacks.delete(flowId)
    handle.close()
  }
}

/** Build an auth service over already-resolved dependencies. */
export function createAuthService(deps: AuthServiceDeps): AuthService {
  return new AuthService(deps)
}
