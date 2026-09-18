// api/handler-ports.ts — the ports domain operations plug into (IMP-11).
//
// Spec basis:
//   spec/common.md §2–3   CommandRequest/AuthenticatedContext/CommandReceipt
//                         envelope; mutation idempotency
//                         (principalScope,operation,operationId) + canonical
//                         payload fingerprint; expectedRevisions compared
//                         inside the same write transaction.
//   spec/operations.md    the 정본 operation index (OPERATION_NAMES lives in
//                         registry.ts and mirrors this table).
//   packages/SHARED-APIS.md
//     IMP-11 owns TxnContext, OperationHandler, OperationSpec,
//     OperationRegistry, makeCaller, OPERATION_NAMES at
//     packages/mahas-runtime/src/api/registry.ts.
//
// Peer boundaries this file only TYPES against (value deps are injected
// through OperationRegistryDeps — registry.ts binds the real modules):
//   IMP-10 packages/mahas-runtime/src/access/authorize.ts — TargetRef,
//     authorize, surfaceFor, isOperationVisible.
//   IMP-03 packages/mahas-runtime/src/storage/db.ts — sha256Hex,
//     insertReceipt, findReceipt, appendDomainEvent, withTx.
//   IMP-02 packages/mahas-contracts — CommandSurface and envelope types.
//
// TxnContext NOTE (additive extension of the SHARED-APIS sketch):
//   SHARED-APIS pins `{ db, ctx }`. The common-spec atomic unit
//   (object revision change + receipt + domain event + effect intent/outbox
//   in ONE transaction) requires a sanctioned channel for handlers to emit
//   domain events and declare effect intents — so `emitEvent`/`intendEffect`
//   are part of the object the registry hands to handlers. Both are required
//   here; handlers registered for non-mutation operations get throwing
//   implementations (queries must not write events or effects).

import type { DatabaseSync } from 'node:sqlite'
import type {
  AuthenticatedContext,
  CommandReceipt,
  CommandSurface,
  ErrorCode,
  ErrorRetry,
  Id,
  MahasError
} from '../../../mahas-contracts/src/index.ts'
import type { TargetRef } from '../access/authorize.ts'

export type { TargetRef } from '../access/authorize.ts'

/** spec/operations.md visibility classes — enforced by IMP-10's surfaceFor,
 *  never by role-branching inside this boundary. */
export type OperationVisibility = 'operator' | 'member' | 'service' | 'host'

/** a domain event a handler wants appended inside the write transaction */
export interface DomainEventInput {
  aggregateId: string
  aggregateRevision: number
  eventType: string
  scope?: unknown
  payload?: unknown
}

/** an external effect the handler declares; the registry persists it as an
 *  EffectIntent + effect_outbox row in the same transaction (spec/common.md §3). */
export interface EffectIntentInput {
  kind: string
  payload?: unknown
  hostId?: string
  /** defaults to sha256Hex(canonical({kind,payload})) when omitted */
  fingerprint?: string
}

/** what the registry hands to every OperationHandler inside the transaction */
export interface TxnContext {
  db: DatabaseSync
  ctx: AuthenticatedContext
  emitEvent(event: DomainEventInput): void
  /** returns the minted effect id (`<operationId>:effect:<n>`) */
  intendEffect(intent: EffectIntentInput): string
}

export type OperationHandler = (txn: TxnContext, payload: unknown) => unknown | Promise<unknown>

export interface OperationSpec {
  name: string
  visibility: OperationVisibility
  mutation: boolean
  /** one-line description used in surface/help projections */
  summary?: string
  /** JSON-schema-ish descriptor echoed through surface.describe / CLI schema */
  inputSchema?: unknown
  outputSchema?: unknown
  /**
   * Resolves the ACTUAL targets of this call from server state — the
   * authorization evidence (D-ACCESS §2: request payload intent is never the
   * auth basis). Called once at admission and again inside the write
   * transaction (and once more pre-commit), so it must be read-only.
   */
  resolveTargets?: (txn: TxnContext, payload: unknown) => TargetRef[] | Promise<TargetRef[]>
  /**
   * Reads current revisions for entities named by
   * CommandRequest.expectedRevisions — compared inside the same write
   * transaction (spec/common.md §3). Absent resolver + non-empty
   * expectedRevisions = the precondition cannot be honoured → STALE_REVISION.
   */
  resolveRevisions?: (
    txn: TxnContext,
    entityIds: readonly string[]
  ) => Record<string, number | undefined> | Promise<Record<string, number | undefined>>
}

/** a registered operation: spec + (possibly absent) handler. Spec-only
 *  registrations stay OUT of surfaces and dispatch as UNAVAILABLE_OPERATION
 *  (instruction §4.5: 미구현 handler를 가진 action은 사용 가능 surface에 넣지 않는다). */
export interface RegisteredOperation {
  spec: OperationSpec
  handler?: OperationHandler
}

// ── injected peer boundaries ────────────────────────────────────────────────

/** IMP-10 packages/mahas-runtime/src/access/authorize.ts — the ONLY
 *  authorization enforcer. This boundary never re-implements role logic. */
export interface AccessBoundary {
  authorize(ctx: AuthenticatedContext, operation: string, targets: TargetRef[]): void
  surfaceFor(ctx: AuthenticatedContext, db: DatabaseSync): CommandSurface
  isOperationVisible(surface: CommandSurface, operation: string): boolean
}

/** IMP-03 packages/mahas-runtime/src/storage/db.ts helpers the pipeline uses.
 *  withTx is deliberately NOT consumed: OperationHandler may return a Promise
 *  and the synchronous withTx contract cannot hold a transaction across an
 *  await — admission.ts carries an async-capable runner with identical
 *  BEGIN IMMEDIATE…COMMIT/ROLLBACK semantics (see runInTransaction). */
export interface StorageBoundary {
  sha256Hex(data: string | Uint8Array): string
  insertReceipt(db: DatabaseSync, receipt: CommandReceipt, principalScope: string): void
  findReceipt(
    db: DatabaseSync,
    principalScope: string,
    operation: string,
    operationId: string
  ): CommandReceipt | null
  appendDomainEvent(
    db: DatabaseSync,
    aggregateId: string,
    aggregateRevision: number,
    eventType: string,
    scope: unknown,
    payload: unknown
  ): void
}

/** admin-side diagnostic trail. Worker-facing errors NEVER distinguish
 *  hidden from unknown operations (UNAVAILABLE_OPERATION both ways —
 *  spec/common.md §2), but this trace MAY (관리자 trace에는 denied/unknown을
 *  구별할 수 있다). Wired to observation/logging by the composition root. */
export interface AdmissionTrace {
  at: number
  principalId: string
  operation: string
  operationId?: string
  outcome: 'committed' | 'rejected' | 'replayed' | 'conflict' | 'denied'
  reason?:
    | 'unknown-operation'
    | 'unimplemented-operation'
    | 'hidden-operation'
    | 'missing-operation-id'
    | 'unauthenticated'
    | 'scope-denied'
    | 'stale-revision'
    | 'conflicting-fingerprint'
    | 'handler-error'
  errorCode?: ErrorCode
  detail?: string
}

export interface OperationRegistryDeps {
  db: DatabaseSync
  access: AccessBoundary
  storage: StorageBoundary
  trace?: (event: AdmissionTrace) => void
  /** authority clock, epoch-ms (spec/common.md §1) — defaults to Date.now */
  clock?: () => number
}

// ── errors ──────────────────────────────────────────────────────────────────

export function mahasError(
  code: ErrorCode,
  message: string,
  retry: ErrorRetry = 'none',
  details?: unknown
): MahasError {
  return details === undefined ? { code, message, retry } : { code, message, retry, details }
}

export function isMahasError(x: unknown): x is MahasError {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as MahasError).code === 'string' &&
    typeof (x as MahasError).message === 'string'
  )
}

/** thrown by makeCaller when a dispatch does not commit — carries the receipt's
 *  MahasError so cross-domain callers keep the real code/retry semantics. */
export class OperationCallError extends Error {
  readonly mahasError: MahasError
  readonly operation: string
  constructor(operation: string, error: MahasError) {
    super(`${operation} failed: ${error.code} — ${error.message}`)
    this.name = 'OperationCallError'
    this.operation = operation
    this.mahasError = error
  }
}

/** branded-id helper for effect ids minted by the registry */
export function asId(raw: string): Id {
  return raw as Id
}
