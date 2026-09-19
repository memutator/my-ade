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
//                             domain events (txn.emitEvent) + effect
//                             intents/outbox (txn.intendEffect) + receipt
//                             insert → COMMIT
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
//
// Two invariants this module owns beyond the original pipeline:
//
//   • ONE ROOT AT A TIME PER CONNECTION — serializeDatabase(db, fn) is a
//     per-DatabaseSync FIFO. Every admission section that touches the DB
//     (visibility/authorize/idempotency reads AND the write transaction)
//     runs inside it, so an autocommit read can never observe a foreign
//     admission's uncommitted rows — SQLite reads on the SAME connection do
//     see the open transaction, which would otherwise leak a foreign unit's
//     grants, receipts or target rows into this admission's decision — and
//     two independent async roots can never interleave BEGIN on one
//     connection. Nested dispatch is AsyncLocalStorage-aware: a call from an
//     async context that already holds that DB's slot runs inline instead of
//     queueing behind itself (which would deadlock). Other writers (the
//     collection scheduler, background refresh) opt in through the same
//     exported seam so their short commits do not join a foreign admission
//     transaction.
//
//   • EXTERNAL EFFECTS OUTSIDE THE TRANSACTION — an operation whose spec
//     declares `deferEffects: 'outside-transaction'` (deferredSpec) is
//     admitted durably first (tx-1: checks + an effect_intents row, COMMIT),
//     performs its filesystem/process effect with NO transaction and NO
//     serialization held, and is completed atomically afterwards (tx-2:
//     domain rows + domain events + declared effects + operation receipt +
//     effect state, all in one COMMIT). A Pack registration snapshot or a
//     conformance child invocation therefore never runs inside BEGIN…COMMIT.
//     The legacy shortcut of marking such a mutation `longPoll: true` is
//     deliberately NOT used: that skips the transaction entirely, which makes
//     the receipt a separate non-atomic write and would let a crash leave a
//     half-applied revision with no receipt — or a receipt with no revision.
//
// Deferred state machine (per operation key = scope/operation/operationId):
//   no receipt, no durable row   → admit (tx-1) → effect (no tx) → complete (tx-2)
//   durable row prepared|attempting|unknown, no receipt
//                                → 'pending' receipt; the effect is NEVER
//                                  re-executed (spec/common.md §5: retry needs
//                                  a stored receipt or positive evidence of
//                                  non-execution)
//   receipt present              → normal idempotent replay (step 5)
//   effect threw MahasError      → the admitted row is released (positive
//                                  evidence nothing applied) and the error is
//                                  rethrown as an unpersisted rejection, so
//                                  'same-operation' retries re-execute
//   effect/completion threw other→ outcome is ambiguous: the durable row stays
//                                  (pending-set member for reconcile) and the
//                                  receipt is 'unknown' + retry 'reconcile'
//   completion tx failed         → tx rolled back (nothing applied) → release
//                                  the row, surface the error

import { AsyncLocalStorage } from 'node:async_hooks'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AuthenticatedContext,
  CommandReceipt,
  CommandRequest,
  CommandSurface,
  EffectIntent,
  EffectState,
  ErrorCode,
  MahasError
} from '../../../mahas-contracts/src/index.ts'
import { asId, isMahasError, mahasError } from './handler-ports.ts'
import type {
  AdmissionTrace,
  DomainEventInput,
  EffectIntentInput,
  OperationHandler,
  OperationRegistryDeps,
  OperationSpec,
  RegisteredOperation,
  TargetRef,
  TxnContext
} from './handler-ports.ts'

// ── per-database serialization (one writer root per connection) ──────────────

/** tail of each connection's admission queue (resolved when that section ends) */
const dbQueues = new WeakMap<DatabaseSync, Promise<unknown>>()
/** DBs whose slot the current async context already holds — reentrancy guard */
const dbSerialization = new AsyncLocalStorage<ReadonlySet<DatabaseSync>>()
/** how many roots are holding or waiting for the slot (diagnostics/tests) */
const dbContenders = new WeakMap<DatabaseSync, number>()

/** does the CURRENT async context hold this connection's serialization slot? */
export function holdsDatabaseSerialization(db: DatabaseSync): boolean {
  return dbSerialization.getStore()?.has(db) === true
}

/** holders + waiters for one connection (0 when idle) — observability only */
export function databaseContenders(db: DatabaseSync): number {
  return dbContenders.get(db) ?? 0
}

/**
 * Run `fn` as the ONLY root touching `db` — FIFO per connection.
 *
 * Every DB read or transaction of the admission pipeline happens inside this
 * section, and so must any other writer on the same control DB (the
 * collection scheduler's short commit: `await serializeDatabase(db, () =>
 * withTx(db, ...))`). Nested calls from a context that already holds the slot
 * run inline (AsyncLocalStorage-aware), which is what keeps nested dispatch
 * and handler-internal helpers from deadlocking on their own lock.
 */
export async function serializeDatabase<T>(db: DatabaseSync, fn: () => T | Promise<T>): Promise<T> {
  if (holdsDatabaseSerialization(db)) return await fn()
  const previous = dbQueues.get(db) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  dbQueues.set(
    db,
    previous.then(
      () => gate,
      () => gate
    )
  )
  dbContenders.set(db, (dbContenders.get(db) ?? 0) + 1)
  try {
    await previous.then(
      () => undefined,
      () => undefined
    )
    const inherited = dbSerialization.getStore()
    const held = new Set<DatabaseSync>(inherited ?? [])
    held.add(db)
    return await dbSerialization.run(held, async () => await fn())
  } finally {
    const remaining = (dbContenders.get(db) ?? 1) - 1
    if (remaining <= 0) dbContenders.delete(db)
    else dbContenders.set(db, remaining)
    release()
  }
}

/** alias used by the composition root / scheduler seam */
export const withSerializedDatabase = serializeDatabase

// ── ambient transaction (nested makeCaller dispatches join it) ───────────────

const ambientTxn = new AsyncLocalStorage<TxnContext | undefined>()

/**
 * Is the CURRENT async context inside an admission handler's transaction for
 * this connection? (The transaction object a nested makeCaller dispatch would
 * join.) Exposed so callers can prove they are NOT inside one — the deferred
 * effect path must run with no ambient transaction.
 */
export function hasAmbientTransaction(db: DatabaseSync): boolean {
  const ambient = ambientTxn.getStore()
  return ambient !== undefined && ambient.db === db
}

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
 * re-entering BEGIN, and independent roots wait in serializeDatabase().
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
  // Every transaction takes its connection's slot: a BEGIN must never land
  // while another root's transaction is open on the same connection.
  return await serializeDatabase(db, async () => {
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
  })
}

// ── deferred (outside-transaction) effects ──────────────────────────────────

/**
 * Spec marker for operations whose effect must never run inside the DB
 * transaction. Written by the operation owner through deferredSpec(); read by
 * the pipeline. Kept as a plain optional field (not a required OperationSpec
 * member) so operation registrations outside this module stay untouched — if
 * IMP-11 promotes it into OperationSpec, this reader keeps working.
 */
export interface DeferredEffectSpec {
  deferEffects?: 'outside-transaction'
}

/** stamp an operation spec as effect-outside-transaction (mutations only) */
export function deferredSpec<T extends OperationSpec & { mutation: true }>(
  spec: T
): T & DeferredEffectSpec {
  return { ...spec, deferEffects: 'outside-transaction' }
}

/** does this spec require the durable admit → effect → complete split? */
export function hasDeferredEffects(spec: OperationSpec): boolean {
  return (spec as OperationSpec & DeferredEffectSpec).deferEffects === 'outside-transaction'
}

/**
 * What a deferred handler receives instead of a TxnContext: NO transaction is
 * open while it runs, so it must only perform the external effect (filesystem,
 * child process, network) and return the completion closure holding the DB
 * writes for tx-2.
 */
export interface DeferredEffectContext {
  db: DatabaseSync
  ctx: AuthenticatedContext
  payload: unknown
  operationId: string
  /** idempotency anchor: `${scope}/${operation}/${operationId}` */
  operationKey: string
  /** the durable effect_intents row id for this admission */
  effectId: string
}

/** the atomic second half: domain writes + events, executed in tx-2 */
export interface DeferredCompletion {
  /** called inside the completion transaction (receipt written in the same COMMIT) */
  complete(txn: TxnContext): unknown | Promise<unknown>
}

/**
 * A deferred operation handler. Throw MahasError for a business failure that
 * provably left NOTHING applied (invalid payload, unreadable manifest,
 * unsupported capability): the durable admission is released and the caller
 * may retry with the same operationId. Any other throw is treated as an
 * ambiguous outcome — the durable row stays for reconcile.
 */
export type DeferredOperationHandler = (
  effect: DeferredEffectContext
) => DeferredCompletion | void | Promise<DeferredCompletion | void>

/** register-time adapter: the pipeline hands the effect context as first arg */
export function asDeferredHandler(handler: DeferredOperationHandler): OperationHandler {
  return handler as unknown as OperationHandler
}

/**
 * Register-time bundle: mark the spec AND adapt the handler in one call.
 *
 *   operations.register(...deferredMutation(spec, async (effect) => {
 *     const prepared = await service.prepare(effect.payload)   // fs/network/HTTP
 *     return { complete: (txn) => service.commit(txn.db, prepared) }
 *   }))
 *
 * Contract for the two phases (this is what keeps a long fs/network await from
 * running inside BEGIN):
 *
 *   effect(effect)      — no transaction and no serialization slot are held.
 *                         Await anything; nested `database(() => withTx(db, …))`
 *                         calls are fine (they take the free slot and commit on
 *                         their own). Throw MahasError when the effect provably
 *                         applied nothing → admission releases the durable
 *                         admission and the caller may retry 'same-operation'.
 *
 *   complete(txn)       — runs INSIDE the completion transaction, in the same
 *                         async context, so re-entrant `serializeDatabase` /
 *                         `withTx` calls from this context run inline instead of
 *                         queueing (no self-deadlock) and stay inside tx-2.
 *                         Keep it to DB work: file/process/network IO belongs in
 *                         the effect phase, and awaiting a FOREIGN async root
 *                         that needs the same connection's slot would deadlock
 *                         (it waits for the tx-2 slot you are holding).
 */
export function deferredMutation<T extends OperationSpec & { mutation: true }>(
  spec: T,
  handler: DeferredOperationHandler
): [T & DeferredEffectSpec, OperationHandler] {
  return [deferredSpec(spec), asDeferredHandler(handler)]
}

/**
 * The admission trace outcome widened by this module for the deferred state
 * machine ('pending' = an admitted effect is still in flight; 'unknown' = the
 * effect outcome is ambiguous). Flagged to IMP-11: AdmissionTrace['outcome']
 * should carry both; the cast below keeps consumers that read the existing
 * union working unchanged.
 */
export type AdmissionOutcome = AdmissionTrace['outcome'] | 'pending' | 'unknown'

/** optional trace detail carried alongside an outcome */
type TraceExtra = {
  reason?: AdmissionTrace['reason']
  errorCode?: ErrorCode
  detail?: string
}

// ── the admission pipeline ──────────────────────────────────────────────────

export async function runAdmission(
  deps: OperationRegistryDeps,
  ops: ReadonlyMap<string, RegisteredOperation>,
  ctx: AuthenticatedContext,
  req: CommandRequest
): Promise<CommandReceipt> {
  const clock = deps.clock ?? Date.now
  const trace = (outcome: AdmissionOutcome, extra?: TraceExtra): void => {
    deps.trace?.({
      at: clock(),
      principalId: String(ctx.principalId),
      operation: req.operation,
      operationId: req.operationId,
      outcome,
      reason: extra?.reason,
      errorCode: extra?.errorCode,
      detail: extra?.detail
    } as AdmissionTrace)
  }
  const fingerprint = fingerprintPayload(deps, req.payload)
  const reject = async (
    error: MahasError,
    reason?: AdmissionTrace['reason']
  ): Promise<CommandReceipt> => {
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
      eventCursor: await readCursor(deps)
    }
  }

  // 1–2. registered and implemented — the response NEVER reveals which failed
  const entry = ops.get(req.operation)
  if (!entry) {
    return await reject(
      mahasError('UNAVAILABLE_OPERATION', `operation is not available`),
      'unknown-operation'
    )
  }
  if (!entry.handler) {
    return await reject(
      mahasError('UNAVAILABLE_OPERATION', `operation is not available`),
      'unimplemented-operation'
    )
  }

  const deferred = entry.spec.mutation && hasDeferredEffects(entry.spec)
  const ambient = ambientTxn.getStore()
  const nested = ambient !== undefined && ambient.db === deps.db
  if (deferred && nested) {
    // the effect would run inside the caller's open transaction — refuse
    // instead of silently executing a child process / snapshot under BEGIN.
    return await reject(
      mahasError(
        'INVALID_TRANSITION',
        `deferred operation ${req.operation} cannot run inside an ambient transaction; dispatch it at the top level`,
        'none'
      ),
      'handler-error'
    )
  }

  try {
    const receipt = deferred
      ? await runDeferredAdmission(deps, entry, ctx, req, fingerprint, trace, reject)
      : await runImmediateAdmission(deps, entry, ctx, req, fingerprint, trace, reject)
    trace('committed')
    return receipt
  } catch (err) {
    if (isMahasError(err)) {
      // business rejection — framed as a receipt, never persisted, so a
      // 'same-operation' retry with the same operationId can still re-execute.
      return await reject(err, 'handler-error')
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
      return await reject(
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

/** eventCursor read — always under the connection's slot (a foreign open
 *  transaction on the same connection would otherwise leak its sequence). */
async function readCursor(deps: OperationRegistryDeps): Promise<number> {
  return await serializeDatabase(deps.db, () => currentEventCursor(deps.db))
}

// ── immediate (in-transaction) admission ────────────────────────────────────

type PreDecision = { answer?: CommandReceipt }

/**
 * Steps 3–6 for operations that do not declare outside-transaction effects.
 * Admission reads and the write transaction are separate serialized sections
 * (the in-tx re-reads close the window between them, spec/common.md §3);
 * long-poll queries release the slot for the duration of their wait.
 */
async function runImmediateAdmission(
  deps: OperationRegistryDeps,
  entry: RegisteredOperation,
  ctx: AuthenticatedContext,
  req: CommandRequest,
  fingerprint: string,
  trace: (outcome: AdmissionOutcome, extra?: TraceExtra) => void,
  reject: (error: MahasError, reason?: AdmissionTrace['reason']) => Promise<CommandReceipt>
): Promise<CommandReceipt> {
  const ambient = ambientTxn.getStore()
  const nested = ambient !== undefined && ambient.db === deps.db
  // long-poll queries (inbox.wait) must not hold BEGIN across sleep —
  // they run autocommit so the single writer is not fenced for maxWaitMs.
  const longPoll = entry.spec.longPoll === true || entry.spec.name === 'inbox.wait'
  // F-005: the raw BEGIN below must register in the shared transaction depth,
  // otherwise a handler's nested withTx()/inTransaction() sees depth 0 and
  // issues a second BEGIN on the same connection (ERR_SQLITE_ERROR).
  const txHooks: TxDepthHooks = {
    markTxOpen: deps.storage.markTxOpen,
    markTxClose: deps.storage.markTxClose
  }

  const pre: PreDecision = await serializeDatabase(deps.db, () =>
    admissionChecks(deps, entry, ctx, req, fingerprint, trace, reject)
  )
  if (pre.answer) return pre.answer

  if (nested) {
    return await ambientTxn.run(nestedTxn(deps, ctx, req, entry.spec.mutation), () =>
      executeInTxn(deps, entry, ctx, req, fingerprint, trace)
    )
  }
  if (longPoll) {
    return await ambientTxn.run(txnFor(deps, deps.db, ctx, req, entry.spec.mutation), () =>
      executeInTxn(deps, entry, ctx, req, fingerprint, trace)
    )
  }
  return await runInTransaction(
    deps.db,
    entry.spec.mutation ? 'IMMEDIATE' : 'DEFERRED',
    (db) =>
      ambientTxn.run(txnFor(deps, db, ctx, req, entry.spec.mutation), () =>
        executeInTxn(deps, entry, ctx, req, fingerprint, trace)
      ),
    txHooks
  )
}

/**
 * Steps 3–5 — visibility, admission authorize and the idempotency lookup.
 * MUST run inside the connection's serialization slot (the caller owns it).
 */
async function admissionChecks(
  deps: OperationRegistryDeps,
  entry: RegisteredOperation,
  ctx: AuthenticatedContext,
  req: CommandRequest,
  fingerprint: string,
  trace: (outcome: AdmissionOutcome, extra?: TraceExtra) => void,
  reject: (error: MahasError, reason?: AdmissionTrace['reason']) => Promise<CommandReceipt>
): Promise<PreDecision> {
  // 3. visibility — role ceiling ∩ current grants, computed by IMP-10.
  let surface: CommandSurface
  try {
    surface = deps.access.surfaceFor(ctx, deps.db)
  } catch (err) {
    if (isMahasError(err)) return { answer: await reject(err, 'unauthenticated') }
    throw err
  }
  if (!deps.access.isOperationVisible(surface, req.operation)) {
    return {
      answer: await reject(
        mahasError('UNAVAILABLE_OPERATION', `operation is not available`),
        'hidden-operation'
      )
    }
  }

  // 4. admission authorize on resolved ACTUAL targets (payload intent is not
  //    evidence — D-ACCESS §2). Also satisfies the replay read-auth recheck.
  const admissionTxn = readFacadeTxn(deps, ctx)
  try {
    const targets = await resolveTargets(entry, admissionTxn, req.payload)
    deps.access.authorize(ctx, req.operation, targets)
  } catch (err) {
    if (isMahasError(err)) {
      return {
        answer: await reject(err, err.code === 'SCOPE_DENIED' ? 'scope-denied' : 'unauthenticated')
      }
    }
    throw err
  }

  // 5. idempotency — mutations only (queries carry no receipt record).
  const scope = principalScopeOf(ctx)
  if (entry.spec.mutation) {
    if (!req.operationId) {
      return {
        answer: await reject(
          mahasError(
            'INVALID_TRANSITION',
            `mutation ${req.operation} requires a non-empty operationId`,
            'none'
          ),
          'missing-operation-id'
        )
      }
    }
    const stored = deps.storage.findReceipt(deps.db, scope, req.operation, req.operationId)
    if (stored) {
      if (stored.fingerprint !== fingerprint) {
        return {
          answer: await reject(
            mahasError(
              'OPERATION_CONFLICT',
              `operationId ${req.operationId} was already used with a different payload`,
              'none',
              { operation: req.operation, operationId: req.operationId }
            ),
            'conflicting-fingerprint'
          )
        }
      }
      trace('replayed')
      return { answer: stored } // read authorization was re-checked at step 4
    }
  }
  return {}
}

// ── deferred admission: durable admit → effect → atomic completion ──────────

type DeferredPhase =
  | { kind: 'admitted' }
  | { kind: 'replayed'; receipt: CommandReceipt }
  | { kind: 'pending'; state: EffectState }

async function runDeferredAdmission(
  deps: OperationRegistryDeps,
  entry: RegisteredOperation,
  ctx: AuthenticatedContext,
  req: CommandRequest,
  fingerprint: string,
  trace: (outcome: AdmissionOutcome, extra?: TraceExtra) => void,
  reject: (error: MahasError, reason?: AdmissionTrace['reason']) => Promise<CommandReceipt>
): Promise<CommandReceipt> {
  const scope = principalScopeOf(ctx)
  const operationKey = `${scope}/${req.operation}/${req.operationId}`
  const effectId = `${req.operationId}:effect:0`
  const txHooks: TxDepthHooks = {
    markTxOpen: deps.storage.markTxOpen,
    markTxClose: deps.storage.markTxClose
  }

  // ── tx-1: admission + durable admitted request, committed before any effect
  const phase: DeferredPhase | CommandReceipt = await serializeDatabase(deps.db, async () => {
    const pre = await admissionChecks(deps, entry, ctx, req, fingerprint, trace, reject)
    if (pre.answer) return pre.answer
    return await runInTransaction(
      deps.db,
      'IMMEDIATE',
      (db) =>
        ambientTxn.run(txnFor(deps, db, ctx, req, true), async (): Promise<DeferredPhase> => {
          const txn = ambientTxn.getStore() as TxnContext
          const targets = await resolveTargets(entry, txn, req.payload)
          deps.access.authorize(ctx, req.operation, targets)
          await checkExpectedRevisions(entry, txn, req)
          const stored = deps.storage.findReceipt(deps.db, scope, req.operation, req.operationId)
          if (stored) {
            if (stored.fingerprint !== fingerprint) throw operationConflict(req)
            trace('replayed')
            return { kind: 'replayed', receipt: stored }
          }
          const durable = findAdmittedEffects(db, operationKey)
          if (durable.length > 0) {
            const row = durable[0] as AdmittedEffectRow
            if (row.fingerprint !== fingerprint) throw operationConflict(req)
            return { kind: 'pending', state: row.state }
          }
          insertAdmittedEffect(db, {
            id: effectId,
            operationKey,
            kind: req.operation,
            fingerprint,
            payload: redactAdmissionPayload(req.payload)
          })
          return { kind: 'admitted' }
        }),
      txHooks
    )
  })

  if ('status' in phase) return phase
  if (phase.kind === 'replayed') return phase.receipt
  if (phase.kind === 'pending') {
    trace('pending', {
      reason: 'handler-error',
      detail: `effect already admitted (state ${phase.state}); awaiting atomic completion`
    })
    return await pendingReceipt(deps, req, fingerprint, phase.state)
  }

  // ── effect: NO transaction, NO serialization slot held
  const marked = await serializeDatabase(deps.db, () => markEffectAttempting(deps.db, effectId))
  if (!marked) {
    // a concurrent root completed the admission between tx-1 and here
    const after = await serializeDatabase(deps.db, () => findAdmittedEffects(deps.db, operationKey))
    const state = after[0]?.state ?? 'unknown'
    trace('pending', { reason: 'handler-error', detail: `concurrent completion (state ${state})` })
    return await pendingReceipt(deps, req, fingerprint, state)
  }

  const effectContext: DeferredEffectContext = {
    db: deps.db,
    ctx,
    payload: req.payload,
    operationId: req.operationId as string,
    operationKey,
    effectId
  }
  let completion: DeferredCompletion | void
  try {
    completion = await (entry.handler as unknown as DeferredOperationHandler)(effectContext)
  } catch (err) {
    if (isMahasError(err)) {
      // business failure that provably applied nothing → release the admission
      // so a 'same-operation' retry re-executes, and report it as an ordinary
      // unpersisted rejection.
      await releaseAdmittedEffectSafely(deps, effectId, trace)
      throw err
    }
    // ambiguous: the effect started and we cannot prove it left nothing behind
    trace('unknown', {
      reason: 'handler-error',
      errorCode: 'CONTROL_UNAVAILABLE',
      detail: err instanceof Error ? err.message : String(err)
    })
    return await unknownReceipt(deps, req, fingerprint, err)
  }
  const complete = typeof completion === 'function' ? completion : completion?.complete

  // ── tx-2: atomic completion — domain writes, events, receipt, effect state
  try {
    return await serializeDatabase(deps.db, () =>
      runInTransaction(
        deps.db,
        'IMMEDIATE',
        (db) =>
          ambientTxn.run(txnFor(deps, db, ctx, req, true), async () => {
            const txn = ambientTxn.getStore() as TxnContext
            const targets = await resolveTargets(entry, txn, req.payload)
            deps.access.authorize(ctx, req.operation, targets)
            await checkExpectedRevisions(entry, txn, req)
            const result = complete ? await complete(txn) : undefined
            // commit-직전 re-check (same rule as executeInTxn, including the
            // F-019 self-revocation exemption).
            const exempt = txnInternals.get(txn)?.exemptedGrants ?? new Set<string>()
            const finalTargets = await resolveTargets(entry, txn, req.payload)
            deps.access.authorize(withGrantExemptions(ctx, exempt), req.operation, finalTargets)
            await checkExpectedRevisions(entry, txn, req)
            const effects = flushEffectIntents(deps, txn, req, scope)
            const receipt: CommandReceipt = {
              operationId: req.operationId as string,
              fingerprint,
              status: 'committed',
              result,
              effects,
              domainRevision: txnDomainRevision(txn),
              eventCursor: currentEventCursor(deps.db)
            }
            deps.storage.insertReceipt(
              deps.db,
              { ...receipt, operation: req.operation } as CommandReceipt,
              scope
            )
            setAdmittedEffectState(deps.db, effectId, 'confirmed', receipt)
            return receipt
          }),
        txHooks
      )
    )
  } catch (err) {
    // the transaction rolled back — nothing was applied, so the admission can
    // be released for a retry (MahasError) or kept (infrastructure faults
    // whose cause may not be a clean rollback).
    if (isMahasError(err)) await releaseAdmittedEffectSafely(deps, effectId, trace)
    else {
      trace('unknown', {
        reason: 'handler-error',
        errorCode: 'CONTROL_UNAVAILABLE',
        detail: err instanceof Error ? err.message : String(err)
      })
    }
    throw err
  }
}

function operationConflict(req: CommandRequest): MahasError {
  return mahasError(
    'OPERATION_CONFLICT',
    `operationId ${req.operationId} was already used with a different payload`,
    'none',
    { operation: req.operation, operationId: req.operationId }
  )
}

// ── durable admitted-request rows (effect_intents / effect_outbox) ──────────

interface AdmittedEffectRow {
  id: string
  operationKey: string
  fingerprint: string
  state: EffectState
}

function findAdmittedEffects(db: DatabaseSync, operationKey: string): AdmittedEffectRow[] {
  const rows = db
    .prepare(
      'SELECT id, operation_key, fingerprint, state FROM effect_intents WHERE operation_key=? ORDER BY id'
    )
    .all(operationKey) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    operationKey: String(row.operation_key),
    fingerprint: String(row.fingerprint),
    state: String(row.state) as EffectState
  }))
}

/** a durable admitted request that has not completed yet */
export interface DeferredAdmissionRecord extends AdmittedEffectRow {
  kind: string
  /** redacted admitted payload — evidence, not a replay source */
  payload: unknown
}

/**
 * The pending durable admissions (states prepared | attempting | unknown) —
 * the reconcile surface for a boot-time or periodic worker. A row here means
 * 'an external effect was admitted and its atomic completion has not been
 * observed'; the runtime never re-executes it on its own (spec/common.md §5:
 * a retry needs the stored receipt or positive evidence of non-execution).
 */
export function listDeferredAdmissions(db: DatabaseSync): DeferredAdmissionRecord[] {
  const rows = db
    .prepare(
      'SELECT id, operation_key, kind, fingerprint, state, payload_json FROM effect_intents ' +
        "WHERE state IN ('prepared','attempting','unknown') ORDER BY id"
    )
    .all() as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    operationKey: String(row.operation_key),
    kind: String(row.kind),
    fingerprint: String(row.fingerprint),
    state: String(row.state) as EffectState,
    payload: JSON.parse(String(row.payload_json))
  }))
}

/**
 * Abandon an admitted request whose effect is PROVEN not to have applied
 * (reconcile evidence: no revision row, no snapshot, no receipt): the durable
 * row is removed so re-dispatching the same operation key re-executes the
 * effect instead of answering 'pending' forever.
 *
 * The caller owns the transaction decision — wrap in serializeDatabase() to
 * take this connection's slot.
 */
export function releaseDeferredAdmission(db: DatabaseSync, effectId: string): void {
  releaseAdmittedEffect(db, effectId)
}

/**
 * The durable "admitted request" record: an effect_intents row (state
 * 'prepared') + its outbox row, written and COMMITTED before the effect runs.
 * The payload is redacted — the effect ledger is not a secret store (auth
 * material never travels through a generic Pack invocation), and the row must
 * remain readable for reconcile without leaking credentials.
 */
function insertAdmittedEffect(
  db: DatabaseSync,
  input: { id: string; operationKey: string; kind: string; fingerprint: string; payload: unknown }
): void {
  db.prepare(
    'INSERT INTO effect_intents(id, operation_key, kind, fingerprint, host_id, state, payload_json, receipt_json, residuals_json) ' +
      "VALUES (?,?,?,?,NULL,'prepared',?,?,?)"
  ).run(
    input.id,
    input.operationKey,
    input.kind,
    input.fingerprint,
    JSON.stringify(input.payload ?? null),
    '{}',
    '[]'
  )
  db.prepare(
    "INSERT INTO effect_outbox(effect_id, state, next_attempt_at) VALUES (?,'prepared',NULL)"
  ).run(input.id)
}

/** prepared → attempting (evidence that the effect was started), autocommit */
function markEffectAttempting(db: DatabaseSync, effectId: string): boolean {
  const updated = db
    .prepare("UPDATE effect_intents SET state='attempting' WHERE id=? AND state='prepared'")
    .run(effectId)
  if (Number(updated.changes) !== 1) return false
  db.prepare("UPDATE effect_outbox SET state='attempting' WHERE effect_id=?").run(effectId)
  return true
}

/** attempting → confirmed with the committed receipt (called INSIDE tx-2) */
function setAdmittedEffectState(
  db: DatabaseSync,
  effectId: string,
  state: EffectState,
  receipt?: CommandReceipt
): void {
  if (receipt === undefined) {
    db.prepare('UPDATE effect_intents SET state=? WHERE id=?').run(state, effectId)
  } else {
    db.prepare('UPDATE effect_intents SET state=?, receipt_json=? WHERE id=?').run(
      state,
      JSON.stringify(receipt),
      effectId
    )
  }
  db.prepare(
    'INSERT INTO effect_outbox(effect_id, state, next_attempt_at) VALUES (?,?,NULL) ' +
      'ON CONFLICT(effect_id) DO UPDATE SET state=excluded.state, next_attempt_at=excluded.next_attempt_at'
  ).run(effectId, state)
}

/** positive evidence of non-execution → drop the admission so retry re-runs */
function releaseAdmittedEffect(db: DatabaseSync, effectId: string): void {
  db.prepare('DELETE FROM effect_outbox WHERE effect_id=?').run(effectId)
  db.prepare('DELETE FROM effect_intents WHERE id=?').run(effectId)
}

async function releaseAdmittedEffectSafely(
  deps: OperationRegistryDeps,
  effectId: string,
  trace: (
    outcome: AdmissionOutcome,
    extra?: { reason?: AdmissionTrace['reason']; detail?: string }
  ) => void
): Promise<void> {
  try {
    await serializeDatabase(deps.db, () => releaseAdmittedEffect(deps.db, effectId))
  } catch (err) {
    // the durable row stays: the next dispatch of this operation key answers
    // 'pending' instead of re-running an effect we could not prove unapplied.
    trace('unknown', {
      reason: 'handler-error',
      detail: `could not release admitted effect ${effectId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    })
  }
}

function redactAdmissionPayload(payload: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]'
  if (Array.isArray(payload))
    return payload.slice(0, 50).map((v) => redactAdmissionPayload(v, depth + 1))
  if (payload && typeof payload === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(payload as Record<string, unknown>).slice(0, 50)) {
      out[key] = /(?:secret|token|password|credential|authorization|api[_-]?key|cookie)/i.test(key)
        ? '[REDACTED]'
        : redactAdmissionPayload(value, depth + 1)
    }
    return out
  }
  return payload
}

/** an admitted effect is still in flight — answer without re-executing it */
async function pendingReceipt(
  deps: OperationRegistryDeps,
  req: CommandRequest,
  fingerprint: string,
  state: EffectState
): Promise<CommandReceipt> {
  return {
    operationId: req.operationId ?? '',
    fingerprint,
    status: 'pending',
    error: mahasError(
      'CONTROL_UNAVAILABLE',
      `operation ${req.operation} is already admitted (effect state ${state}) and awaits atomic completion`,
      'reconcile'
    ),
    effects: [],
    domainRevision: 0,
    eventCursor: await readCursor(deps)
  }
}

/** the effect left an outcome we cannot prove — reconcile, never auto-retry */
async function unknownReceipt(
  deps: OperationRegistryDeps,
  req: CommandRequest,
  fingerprint: string,
  cause: unknown
): Promise<CommandReceipt> {
  return {
    operationId: req.operationId ?? '',
    fingerprint,
    status: 'unknown',
    error: mahasError(
      'CONTROL_UNAVAILABLE',
      `operation ${req.operation} effect outcome is unknown: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      'reconcile'
    ),
    effects: [],
    domainRevision: 0,
    eventCursor: await readCursor(deps)
  }
}

// ── in-transaction execution ────────────────────────────────────────────────

async function executeInTxn(
  deps: OperationRegistryDeps,
  entry: RegisteredOperation,
  ctx: AuthenticatedContext,
  req: CommandRequest,
  fingerprint: string,
  trace: (outcome: AdmissionOutcome, extra?: { reason?: AdmissionTrace['reason'] }) => void
): Promise<CommandReceipt> {
  const txn = ambientTxn.getStore()
  if (!txn) throw new Error('executeInTxn without ambient transaction')
  const scope = principalScopeOf(ctx)

  // actual targets re-read INSIDE the write transaction (spec §3), then the
  // current grant is re-verified against the same snapshot (D-ACCESS §4).
  // Each re-read takes the connection slot when the caller (a long-poll
  // query running autocommit) is not already inside one.
  const targets = await serializeDatabase(deps.db, () => resolveTargets(entry, txn, req.payload))
  deps.access.authorize(ctx, req.operation, targets)
  await serializeDatabase(deps.db, () => checkExpectedRevisions(entry, txn, req))

  // in-tx idempotency recheck — closes the two-connections race where a
  // competing dispatch committed the same key after our admission lookup.
  if (entry.spec.mutation) {
    const stored = await serializeDatabase(deps.db, () =>
      deps.storage.findReceipt(deps.db, scope, req.operation, req.operationId)
    )
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
  const finalTargets = await serializeDatabase(deps.db, () =>
    resolveTargets(entry, txn, req.payload)
  )
  deps.access.authorize(withGrantExemptions(ctx, exempt), req.operation, finalTargets)
  await serializeDatabase(deps.db, () => checkExpectedRevisions(entry, txn, req))

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
export function defaultTargetsFromPayload(
  ctx: AuthenticatedContext,
  payload: unknown
): TargetRef[] {
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
function withGrantExemptions(
  ctx: AuthenticatedContext,
  exempt: ReadonlySet<string>
): AuthenticatedContext {
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
