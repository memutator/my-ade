// api/admission.ts — the ONE admission pipeline every entrypoint shares
// (CLI / UI / raw RPC / internal makeCaller — C-ACCESS: 같은 admission).
//
// Pipeline order (SHARED-APIS IMP-11, spec/common.md §2–4, D-ACCESS §3):
//   1. registered?            unknown → UNAVAILABLE_OPERATION (trace: unknown)
//   2. implemented?           spec-only → UNAVAILABLE_OPERATION (trace: unimplemented)
//   3. visible?               surfaceFor ∩ isOperationVisible (IMP-10) →
//                             UNAVAILABLE_OPERATION (trace: hidden) — the
//                             worker error never distinguishes hidden/unknown
//   4. authorize              resolveTargets(actual) → authorize(ctx,op,targets)
//   5. idempotency (mutation) findReceipt(principalScope,operation,operationId):
//                             same fingerprint → stored receipt (read auth was
//                             just re-checked at step 4 — spec §3 requires it);
//                             different fingerprint → OPERATION_CONFLICT
//   6. write tx               BEGIN IMMEDIATE → re-resolve actual targets →
//                             authorize again (current grant re-read in-tx,
//                             D-ACCESS §4) → expectedRevisions compare →
//                             handler → pre-commit grant+revision re-check →
//                             domain events (emitted via txn.emitEvent) +
//                             effect intents/outbox (txn.intendEffect) +
//                             receipt insert → COMMIT
//      query tx               BEGIN DEFERRED → same checks, no receipt persist
//   7. errors                 thrown MahasError → 'rejected' receipt (never
//                             persisted — 'same-operation' retries must be
//                             able to re-execute); non-MahasError faults
//                             propagate (infrastructure, not business)
//
// Nested dispatch (makeCaller inside a handler): joins the ambient
// transaction via AsyncLocalStorage — the inner op becomes part of the
// caller's atomic unit instead of opening a second SQLite transaction on the
// single-writer connection.

import { AsyncLocalStorage } from 'node:async_hooks'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AuthenticatedContext,
  CommandReceipt,
  CommandRequest,
  CommandSurface,
  EffectIntent,
  ErrorCode,
  MahasError
} from '../../../mahas-contracts/src/index.ts'
import { asId, isMahasError, mahasError } from './handler-ports.ts'
import type {
  AdmissionTrace,
  DomainEventInput,
  EffectIntentInput,
  OperationRegistryDeps,
  RegisteredOperation,
  TargetRef,
  TxnContext
} from './handler-ports.ts'

// ── ambient transaction (nested makeCaller dispatches join it) ───────────────

const ambientTxn = new AsyncLocalStorage<TxnContext>()

// ── canonical payload fingerprint ───────────────────────────────────────────

/**
 * Canonical JSON: recursively sorted object keys, JSON.stringify escaping.
 * The receipt fingerprint for one (operationId) key — spec/common.md §3.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = canonicalize(v)
    }
    return out
  }
  return value
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

export function fingerprintPayload(deps: OperationRegistryDeps, payload: unknown): string {
  return deps.storage.sha256Hex(canonicalJson(payload ?? null))
}

// ── idempotency scope ────────────────────────────────────────────────────────

/** spec/common.md §3: (principalScope, operation, operationId). Scoped to the
 *  authenticated principal — the server-derived identity, never payload claims. */
export function principalScopeOf(ctx: AuthenticatedContext): string {
  return String(ctx.principalId)
}

// ── transaction runner ──────────────────────────────────────────────────────

export type TxMode = 'IMMEDIATE' | 'DEFERRED'

/**
 * Async-capable BEGIN…COMMIT/ROLLBACK. IMP-03's withTx is synchronous and
 * cannot hold a transaction across an awaited OperationHandler; this runner
 * keeps identical semantics (BEGIN IMMEDIATE write lock for mutations,
 * DEFERRED for queries). Single-writer mahasd makes holding the lock across
 * the handler await safe — nested dispatches join via ambientTxn instead of
 * re-entering BEGIN.
 */
/** transaction-depth hooks the pipeline forwards to the storage boundary so a
 *  handler's nested withTx() degrades to SAVEPOINT (see StorageBoundary). */
export interface TxDepthHooks {
  markTxOpen?: (db: DatabaseSync) => void
  markTxClose?: (db: DatabaseSync) => void
}

export async function runInTransaction<T>(
  db: DatabaseSync,
  mode: TxMode,
  fn: (db: DatabaseSync) => T | Promise<T>,
  hooks?: TxDepthHooks
): Promise<T> {
  db.exec(`BEGIN ${mode}`)
  hooks?.markTxOpen?.(db)
  try {
    const value = await fn(db)
    db.exec('COMMIT')
    return value
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // connection may already have rolled back (e.g. SQLITE error on COMMIT)
    }
    throw err
  } finally {
    hooks?.markTxClose?.(db)
  }
}

// ── the admission pipeline ──────────────────────────────────────────────────

export async function runAdmission(
  deps: OperationRegistryDeps,
  ops: ReadonlyMap<string, RegisteredOperation>,
  ctx: AuthenticatedContext,
  req: CommandRequest
): Promise<CommandReceipt> {
  const clock = deps.clock ?? Date.now
  const trace = (
    outcome: AdmissionTrace['outcome'],
    extra?: { reason?: AdmissionTrace['reason']; errorCode?: ErrorCode; detail?: string }
  ): void => {
    deps.trace?.({
      at: clock(),
      principalId: String(ctx.principalId),
      operation: req.operation,
      operationId: req.operationId,
      outcome,
      reason: extra?.reason,
      errorCode: extra?.errorCode,
      detail: extra?.detail
    })
  }
  const fingerprint = fingerprintPayload(deps, req.payload)
  const reject = (error: MahasError, reason?: AdmissionTrace['reason']): CommandReceipt => {
    trace(error.code === 'OPERATION_CONFLICT' ? 'conflict' : 'denied', {
      reason,
      errorCode: error.code
    })
    return {
      operationId: req.operationId ?? '',
      fingerprint,
      status: 'rejected',
      error,
      effects: [],
      domainRevision: 0,
      eventCursor: currentEventCursor(deps.db)
    }
  }

  // 1–2. registered and implemented — the response NEVER reveals which failed
  const entry = ops.get(req.operation)
  if (!entry) {
    return reject(
      mahasError('UNAVAILABLE_OPERATION', `operation is not available`),
      'unknown-operation'
    )
  }
  if (!entry.handler) {
    return reject(
      mahasError('UNAVAILABLE_OPERATION', `operation is not available`),
      'unimplemented-operation'
    )
  }

  // 3. visibility — role ceiling ∩ current grants, computed by IMP-10.
  let surface: CommandSurface
  try {
    surface = deps.access.surfaceFor(ctx, deps.db)
  } catch (err) {
    if (isMahasError(err)) return reject(err, 'unauthenticated')
    throw err
  }
  if (!deps.access.isOperationVisible(surface, req.operation)) {
    return reject(
      mahasError('UNAVAILABLE_OPERATION', `operation is not available`),
      'hidden-operation'
    )
  }

  // 4. admission authorize on resolved ACTUAL targets (payload intent is not
  //    evidence — D-ACCESS §2). Also satisfies the replay read-auth recheck.
  const admissionTxn = readFacadeTxn(deps, ctx)
  try {
    const targets = await resolveTargets(entry, admissionTxn, req.payload)
    deps.access.authorize(ctx, req.operation, targets)
  } catch (err) {
    if (isMahasError(err)) {
      return reject(err, err.code === 'SCOPE_DENIED' ? 'scope-denied' : 'unauthenticated')
    }
    throw err
  }

  // 5. idempotency — mutations only (queries carry no receipt record).
  const scope = principalScopeOf(ctx)
  if (entry.spec.mutation) {
    if (!req.operationId) {
      return reject(
        mahasError(
          'INVALID_TRANSITION',
          `mutation ${req.operation} requires a non-empty operationId`,
          'none'
        ),
        'missing-operation-id'
      )
    }
    const stored = deps.storage.findReceipt(deps.db, scope, req.operation, req.operationId)
    if (stored) {
      if (stored.fingerprint !== fingerprint) {
        return reject(
          mahasError(
            'OPERATION_CONFLICT',
            `operationId ${req.operationId} was already used with a different payload`,
            'none',
            { operation: req.operation, operationId: req.operationId }
          ),
          'conflicting-fingerprint'
        )
      }
      trace('replayed')
      return stored // read authorization was re-checked at step 4 (spec §3)
    }
  }

  // 6–7. execute inside the transaction (or join the ambient one).
  // long-poll queries (inbox.wait) must not hold BEGIN across sleep —
  // they run autocommit so the single writer is not fenced for maxWaitMs.
  const ambient = ambientTxn.getStore()
  const longPoll = entry.spec.longPoll === true || entry.spec.name === 'inbox.wait'
  // F-005: the raw BEGIN below must register in the shared transaction depth,
  // otherwise a handler's nested withTx()/inTransaction() sees depth 0 and
  // issues a second BEGIN on the same connection (ERR_SQLITE_ERROR).
  const txHooks: TxDepthHooks = {
    markTxOpen: deps.storage.markTxOpen,
    markTxClose: deps.storage.markTxClose
  }
  try {
    const receipt =
      ambient !== undefined && ambient.db === deps.db
        ? await ambientTxn.run(nestedTxn(deps, ctx, req, entry.spec.mutation), () =>
            executeInTxn(deps, entry, ctx, req, scope, fingerprint, trace)
          )
        : longPoll
          ? await ambientTxn.run(txnFor(deps, deps.db, ctx, req, entry.spec.mutation), () =>
              executeInTxn(deps, entry, ctx, req, scope, fingerprint, trace)
            )
          : await runInTransaction(
              deps.db,
              entry.spec.mutation ? 'IMMEDIATE' : 'DEFERRED',
              (db) =>
                ambientTxn.run(txnFor(deps, db, ctx, req, entry.spec.mutation), () =>
                  executeInTxn(deps, entry, ctx, req, scope, fingerprint, trace)
                ),
              txHooks
            )
    trace('committed')
    return receipt
  } catch (err) {
    if (isMahasError(err)) {
      // business rejection — framed as a receipt, never persisted, so a
      // 'same-operation' retry with the same operationId can still re-execute.
      return reject(err, 'handler-error')
    }
    // F-028: a bare TypeError is a caller payload-shape bug (every payload
    // guard throws it), never an ambiguous outcome — frame it as a rejected
    // MODEL_INVALID receipt. Without this the client sees status:'unknown' +
    // CONTROL_UNAVAILABLE with no receipt, indistinguishable from a genuine
    // ambiguous dispatch failure that requires reconcile. The transaction
    // above already rolled back, so "nothing applied, fix your payload" is
    // the honest answer; retry 'none' because resending the same bytes can
    // never succeed.
    if (err instanceof TypeError) {
      return reject(
        mahasError(
          'MODEL_INVALID',
          `malformed payload for ${req.operation}: ${err.message}`,
          'none'
        ),
        'handler-error'
      )
    }
    throw err
  }
}

// ── in-transaction execution ────────────────────────────────────────────────

async function executeInTxn(
  deps: OperationRegistryDeps,
  entry: RegisteredOperation,
  ctx: AuthenticatedContext,
  req: CommandRequest,
  scope: string,
  fingerprint: string,
  trace: (outcome: AdmissionTrace['outcome'], extra?: { reason?: AdmissionTrace['reason'] }) => void
): Promise<CommandReceipt> {
  const txn = ambientTxn.getStore()
  if (!txn) throw new Error('executeInTxn without ambient transaction')

  // actual targets re-read INSIDE the write transaction (spec §3), then the
  // current grant is re-verified against the same snapshot (D-ACCESS §4).
  const targets = await resolveTargets(entry, txn, req.payload)
  deps.access.authorize(ctx, req.operation, targets)
  await checkExpectedRevisions(entry, txn, req)

  // in-tx idempotency recheck — closes the two-connections race where a
  // competing dispatch committed the same key after our admission lookup.
  if (entry.spec.mutation) {
    const stored = deps.storage.findReceipt(deps.db, scope, req.operation, req.operationId)
    if (stored) {
      if (stored.fingerprint !== fingerprint) {
        throw mahasError(
          'OPERATION_CONFLICT',
          `operationId ${req.operationId} was already used with a different payload`,
          'none',
          { operation: req.operation, operationId: req.operationId }
        )
      }
      trace('replayed')
      return stored
    }
  }

  const result = await entry.handler!(txn, req.payload)

  // commit-직전 re-check: grant revocation or revision drift raced by the
  // handler's own writes is caught before COMMIT (instruction §4.4), EXCEPT
  // grants this operation itself revoked (F-019 — a self-revocation must not
  // fence its own transaction).
  const exempt = txnInternals.get(txn)?.exemptedGrants ?? new Set<string>()
  const finalTargets = await resolveTargets(entry, txn, req.payload)
  deps.access.authorize(withGrantExemptions(ctx, exempt), req.operation, finalTargets)
  await checkExpectedRevisions(entry, txn, req)

  const effects = flushEffectIntents(deps, txn, req, scope)
  const receipt: CommandReceipt = {
    operationId: req.operationId,
    fingerprint,
    status: 'committed',
    result,
    effects,
    domainRevision: txnDomainRevision(txn),
    eventCursor: currentEventCursor(deps.db)
  }
  if (entry.spec.mutation) {
    // operation_receipts' PK carries the operation column, but neither
    // CommandReceipt nor insertReceipt's signature passes it — attach it on
    // the stored copy only (flagged to IMP-02/03; returned receipt stays
    // contract-exact).
    deps.storage.insertReceipt(
      deps.db,
      { ...receipt, operation: req.operation } as CommandReceipt,
      scope
    )
  }
  return receipt
}

// ── expectedRevisions ───────────────────────────────────────────────────────

async function checkExpectedRevisions(
  entry: RegisteredOperation,
  txn: TxnContext,
  req: CommandRequest
): Promise<void> {
  const expected = req.expectedRevisions
  if (!expected) return
  const ids = Object.keys(expected)
  if (ids.length === 0) return
  const actuals = entry.spec.resolveRevisions ? await entry.spec.resolveRevisions(txn, ids) : {}
  for (const id of ids) {
    const actual = actuals[id]
    if (actual === undefined || actual !== expected[id]) {
      throw mahasError(
        'STALE_REVISION',
        `expectedRevisions mismatch for ${id} in ${req.operation}`,
        'same-operation',
        { entityId: id, expected: expected[id], actual: actual ?? null }
      )
    }
  }
}

// ── target resolution ───────────────────────────────────────────────────────

/**
 * payload id field → actual-target kind. The migration default resolver for
 * operations that have not yet declared their own `resolveTargets`: it lifts
 * the ids the payload names into TargetRefs so coverage is still evaluated
 * against real rows (never against request intent as authority). Field names
 * are canonical wire names — a payload that names nothing concrete falls back
 * to the caller's own principal anchor, which only the caller's own grant (or
 * a wildcard operator grant) can cover.
 */
const PAYLOAD_TARGET_KINDS: Readonly<Record<string, string>> = {
  projectId: 'project',
  modelVersion: 'modelVersion',
  boundaryId: 'boundary',
  roleId: 'role',
  runId: 'run',
  memberId: 'member',
  taskId: 'task',
  planId: 'plan',
  dispatchId: 'dispatch',
  deliveryId: 'delivery',
  messageId: 'message',
  artifactId: 'artifact',
  executionId: 'execution',
  executionCredentialId: 'executionCredential',
  grantId: 'grant',
  policyId: 'policy',
  resourceId: 'resource',
  checkoutId: 'checkout',
  transferId: 'resourceTransfer',
  claimId: 'resourceClaim',
  terminalId: 'terminal',
  workspaceId: 'workspace',
  hostId: 'host',
  wakeRequestId: 'wakeRequest',
  outcomeId: 'outcome',
  settlementId: 'settlement',
  observationId: 'observation',
  notificationId: 'notification'
}

function collectPayloadTargets(value: unknown, out: TargetRef[], depth = 0): void {
  if (depth > 3 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectPayloadTargets(item, out, depth + 1)
    return
  }
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const kind = PAYLOAD_TARGET_KINDS[key]
    if (kind && typeof raw === 'string' && raw.length > 0) {
      out.push({ kind, id: raw })
    } else if (kind && Array.isArray(raw)) {
      for (const id of raw) if (typeof id === 'string' && id.length > 0) out.push({ kind, id })
    } else if (typeof raw === 'object' && raw !== null) {
      collectPayloadTargets(raw, out, depth + 1)
    }
  }
}

/** deterministic dedupe of resolved payload targets */
export function defaultTargetsFromPayload(ctx: AuthenticatedContext, payload: unknown): TargetRef[] {
  const out: TargetRef[] = []
  collectPayloadTargets(payload, out)
  const seen = new Set<string>()
  const deduped = out.filter((t) => {
    const key = `${t.kind}:${t.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (deduped.length > 0) return deduped
  // no concrete entity named → the caller's own principal is the only object
  // this call may be authorized against. Fail-closed for everything wider.
  return [{ kind: 'principal', id: String(ctx.principalId) }]
}

/**
 * Mutation ops SHOULD declare `resolveTargets` (D-ACCESS §2). Operations not
 * yet migrated fall back to `defaultTargetsFromPayload` so the pipeline still
 * evaluates coverage against concrete rows instead of refusing outright
 * (fix-progress mid-migration blocker); the fallback never widens coverage
 * beyond the caller's own principal when the payload names nothing.
 */
async function resolveTargets(
  entry: RegisteredOperation,
  txn: TxnContext,
  payload: unknown
): Promise<TargetRef[]> {
  const resolver = entry.spec.resolveTargets
  const targets = resolver
    ? ((await resolver(txn, payload)) ?? [])
    : defaultTargetsFromPayload(txn.ctx, payload)
  // mutations: empty actual-target set is SCOPE_DENIED, never trivial cover.
  // queries may still resolve to [].
  if (entry.spec.mutation && targets.length === 0) {
    throw mahasError(
      'SCOPE_DENIED',
      `mutation ${entry.spec.name} resolved no actual targets`,
      'none'
    )
  }
  return targets
}

// ── txn context construction ────────────────────────────────────────────────

interface EmittedEvent extends DomainEventInput {}
interface PendingEffect extends EffectIntentInput {}

interface TxnInternals {
  emitted: EmittedEvent[]
  pendingEffects: PendingEffect[]
  /** grant ids this operation revoked itself — exempt from the pre-commit fence */
  exemptedGrants: Set<string>
}

const txnInternals = new WeakMap<TxnContext, TxnInternals>()

/** ctx with the given attested grants removed (F-019 self-revocation exempt) */
function withGrantExemptions(ctx: AuthenticatedContext, exempt: ReadonlySet<string>): AuthenticatedContext {
  if (exempt.size === 0) return ctx
  const grantRevisions: Record<string, number> = {}
  for (const [id, rev] of Object.entries(ctx.grantRevisions ?? {})) {
    if (!exempt.has(id)) grantRevisions[id] = rev
  }
  return { ...ctx, grantRevisions }
}

function txnFor(
  deps: OperationRegistryDeps,
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  req: CommandRequest,
  mutation: boolean
): TxnContext {
  const internals: TxnInternals = { emitted: [], pendingEffects: [], exemptedGrants: new Set() }
  const txn: TxnContext = {
    db,
    ctx,
    emitEvent: mutation
      ? (event: DomainEventInput): void => {
          deps.storage.appendDomainEvent(
            db,
            event.aggregateId,
            event.aggregateRevision,
            event.eventType,
            event.scope ?? {},
            event.payload ?? {}
          )
          internals.emitted.push(event)
        }
      : () => {
          throw mahasError(
            'INVALID_TRANSITION',
            `query operation ${req.operation} must not emit domain events`,
            'none'
          )
        },
    intendEffect: mutation
      ? (intent: EffectIntentInput): string => {
          const id = `${req.operationId}:effect:${internals.pendingEffects.length}`
          internals.pendingEffects.push(intent)
          return id
        }
      : () => {
          throw mahasError(
            'INVALID_TRANSITION',
            `query operation ${req.operation} must not declare effect intents`,
            'none'
          )
        },
    exemptGrantRecheck: (grantId: string): void => {
      internals.exemptedGrants.add(grantId)
    }
  }
  txnInternals.set(txn, internals)
  return txn
}

/** nested dispatch — same DB, ambient transaction already open */
function nestedTxn(
  deps: OperationRegistryDeps,
  ctx: AuthenticatedContext,
  req: CommandRequest,
  mutation: boolean
): TxnContext {
  return txnFor(deps, deps.db, ctx, req, mutation)
}

/** read-only facade used for admission-time target resolution — handlers are
 *  never invoked on it, so emissions are hard errors. */
function readFacadeTxn(deps: OperationRegistryDeps, ctx: AuthenticatedContext): TxnContext {
  const txn: TxnContext = {
    db: deps.db,
    ctx,
    emitEvent: () => {
      throw mahasError('INVALID_TRANSITION', 'emitEvent outside a write transaction', 'none')
    },
    intendEffect: () => {
      throw mahasError('INVALID_TRANSITION', 'intendEffect outside a write transaction', 'none')
    }
  }
  txnInternals.set(txn, { emitted: [], pendingEffects: [], exemptedGrants: new Set() })
  return txn
}

function txnDomainRevision(txn: TxnContext): number {
  const internals = txnInternals.get(txn)
  if (!internals || internals.emitted.length === 0) return 0
  return Math.max(...internals.emitted.map((e) => e.aggregateRevision))
}

// ── effect intents + outbox (spec/storage.md §3 DDL) ─────────────────────────

function flushEffectIntents(
  deps: OperationRegistryDeps,
  txn: TxnContext,
  req: CommandRequest,
  scope: string
): EffectIntent[] {
  const internals = txnInternals.get(txn)
  if (!internals || internals.pendingEffects.length === 0) return []
  const operationKey = `${scope}/${req.operation}/${req.operationId}`
  const insertIntent = deps.db.prepare(
    `INSERT INTO effect_intents
       (id, operation_key, kind, fingerprint, host_id, state, payload_json, receipt_json, residuals_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertOutbox = deps.db.prepare(
    `INSERT INTO effect_outbox (effect_id, state, next_attempt_at) VALUES (?, ?, ?)`
  )
  const effects: EffectIntent[] = []
  internals.pendingEffects.forEach((input, i) => {
    const id = `${req.operationId}:effect:${i}`
    const fingerprint =
      input.fingerprint ??
      deps.storage.sha256Hex(canonicalJson({ kind: input.kind, payload: input.payload ?? null }))
    insertIntent.run(
      id,
      operationKey,
      input.kind,
      fingerprint,
      input.hostId ?? null,
      'prepared',
      JSON.stringify(input.payload ?? null),
      '{}',
      '[]'
    )
    insertOutbox.run(id, 'pending', null)
    effects.push({
      id: asId(id),
      operationKey,
      kind: input.kind,
      fingerprint,
      hostId: input.hostId === undefined ? undefined : asId(input.hostId),
      state: 'prepared',
      payload: input.payload ?? null
    })
  })
  return effects
}

// ── domain event cursor ─────────────────────────────────────────────────────

/** last appended domain_events sequence — the receipt's eventCursor and the
 *  subscription resume point (S-STORAGE §2 domain_events/projection outbox). */
export function currentEventCursor(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS c FROM domain_events').get() as
    { c: number } | undefined
  return row?.c ?? 0
}
