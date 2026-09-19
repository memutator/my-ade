// observation/subscriptions.ts — runtime.subscribe + the server-side
// subscription cursor store.
//
// C-OBSERVATION `runtime.subscribe`: input {scope, epoch, afterSequence,
// visibilityDigest}; output an ordered domain_events stream or
// SNAPSHOT_REQUIRED. The event cursor IS domain_events.sequence — this
// projection consumes the shared outbox appended by every service
// (instruction §5), so a client that keeps the cursor loses nothing the
// ledger committed.
//
// Contract guarantees implemented here:
//  - epoch mismatch → SNAPSHOT_REQUIRED (the stream restarted)
//  - visibilityDigest mismatch → SNAPSHOT_REQUIRED (grants/scope changed
//    since the snapshot — never keep serving stale visibility)
//  - afterSequence behind the retained window → SNAPSHOT_REQUIRED
//    'expired'; ahead of the ledger → 'gap'
//  - subscription state is SERVER-SIDE and ephemeral: unsubscribe/detach
//    drops the cursor and mutates no domain record (REQ-23 — pane moves,
//    detached renderers and unsubscribes never change the authoritative
//    record or writer authority)
//  - per-transport capability/visibility is re-checked on every open/poll —
//    no other socket's capability is assumed (instruction §5)

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/index.ts'
import { mahasError } from './intervention.ts'
import {
  currentControllerEpoch,
  ledgerBounds,
  visibilityDigestOf,
  visibilityRuleFor
} from './projection.ts'
import type { SnapshotScope, VisibilityRule } from './projection.ts'
import type { ObservationDeps, ResolvedObservationDeps } from './index.ts'

/** the single shared outbox stream this projection serves */
export const DOMAIN_EVENT_STREAM_ID = 'domain-events'

/** spec §2 SubscriptionCursor — the value a client holds between calls. */
export interface SubscriptionCursor {
  streamId: string
  epoch: number
  lastSequence: number
  visibilityDigest: string
}

/** one stored domain_events row, already JSON-parsed. */
export interface DomainEventView {
  sequence: number
  aggregateId: string
  aggregateRevision: number
  eventType: string
  scope: Record<string, unknown>
  payload: unknown
}

/** server-side subscription record — ephemeral, never a domain entity. */
export interface Subscription {
  id: string
  principalId: string
  transportSessionId: string
  scope: SnapshotScope
  rule: VisibilityRule
  cursor: SubscriptionCursor
  createdAt: number
}

export interface SubscribeResult {
  subscriptionId: string
  cursor: SubscriptionCursor
  events: DomainEventView[]
  /** true when more committed events remain past the returned cursor */
  hasMore: boolean
}

export const SUBSCRIBE_BATCH_LIMIT = 500

/**
 * F-025: bound on server-side hub entries. Orphaned subscriptions (dropped
 * sockets, clients that never unsubscribe) die with the daemon; the cap only
 * stops unbounded growth from clients that re-subscribe without reusing
 * their subscriptionId.
 */
export const SUBSCRIPTION_HUB_LIMIT = 2000

// ---------------------------------------------------------------------------
// event reading + filtering
// ---------------------------------------------------------------------------

interface RawEventRow {
  sequence: number
  aggregate_id: string
  aggregate_revision: number
  event_type: string
  scope_json: string
  payload_json: string
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function readEventsSince(
  db: DatabaseSync,
  afterSequence: number,
  limit: number
): DomainEventView[] {
  const raws = db
    .prepare(
      `SELECT sequence, aggregate_id, aggregate_revision, event_type, scope_json, payload_json
       FROM domain_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`
    )
    .all(afterSequence, limit + 1) as unknown as RawEventRow[] // +1 row = hasMore probe
  return raws.map((r) => ({
    sequence: r.sequence,
    aggregateId: r.aggregate_id,
    aggregateRevision: r.aggregate_revision,
    eventType: r.event_type,
    scope: (parseJson(r.scope_json) ?? {}) as Record<string, unknown>,
    payload: parseJson(r.payload_json)
  }))
}

/**
 * scope + visibility filter for one event.
 *  - Scope match: every dimension the caller scoped to must equal the
 *    event's scope dimension (an event without that dimension is only
 *    delivered to unscoped-on-that-dimension readers).
 *  - Member-class: events pinned to a different member or to an execution
 *    owned by a different member are withheld — the same rows a member's
 *    snapshot would redact.
 */
export function eventVisible(
  ev: DomainEventView,
  scope: SnapshotScope,
  rule: VisibilityRule,
  memberOfExecution: (executionId: string) => string | null
): boolean {
  const s = ev.scope as Record<string, unknown>
  if (rule.kind === 'member') {
    if (typeof s.runId === 'string' && s.runId !== rule.runId) return false
    if (typeof s.memberId === 'string' && s.memberId !== rule.memberId) return false
    if (typeof s.executionId === 'string') {
      const owner = memberOfExecution(s.executionId)
      if (owner !== null && owner !== rule.memberId) return false
      if (owner === null) return false // execution outside the member's run
    }
    // events with no run scope (global/service) are withheld from members —
    // the member view is their run, not the control plane's internals
    if (typeof s.runId !== 'string' && typeof s.executionId !== 'string') return false
  }
  if (scope.runId && s.runId !== scope.runId) return false
  if (scope.memberId && s.memberId !== scope.memberId) return false
  if (scope.executionId && s.executionId !== scope.executionId) return false
  if (scope.projectId && s.projectId !== scope.projectId) return false
  return true
}

/** member lookup used by eventVisible — cached per call batch. */
export function executionOwnerResolver(db: DatabaseSync): (executionId: string) => string | null {
  const cache = new Map<string, string | null>()
  return (executionId) => {
    if (cache.has(executionId)) return cache.get(executionId)!
    const row = db.prepare(`SELECT member_id FROM executions WHERE id = ?`).get(executionId) as
      { member_id: string } | undefined
    const owner = row?.member_id ?? null
    cache.set(executionId, owner)
    return owner
  }
}

/**
 * Validate a presented cursor against the current ledger. Returns the
 * reason a snapshot is required, or null when the cursor is servable.
 * Pure check — reused by subscribe open, poll, and IMP-23's recovery.
 */
export function cursorStaleness(
  db: DatabaseSync,
  deps: ObservationDeps,
  ctx: AuthenticatedContext,
  scope: SnapshotScope,
  rule: VisibilityRule,
  epoch: number,
  afterSequence: number,
  presentedDigest: string
): 'epoch-mismatch' | 'visibility-changed' | 'cursor-expired' | 'cursor-gap' | null {
  const currentEpoch = currentControllerEpoch(db, ctx)
  if (epoch !== currentEpoch) return 'epoch-mismatch'
  const currentDigest = visibilityDigestOf(deps, ctx, rule, scope)
  if (presentedDigest !== currentDigest) return 'visibility-changed'
  const { min, max } = ledgerBounds(db)
  if (max !== null && afterSequence > max) return 'cursor-gap'
  if (min !== null && min > 0 && afterSequence < min - 1) return 'cursor-expired'
  return null
}

export function snapshotRequired(reason: string, details?: unknown): MahasErrorShape {
  return mahasError('SNAPSHOT_REQUIRED', `subscription cursor cannot be served: ${reason}`, {
    reason,
    ...(details as Record<string, unknown> | undefined)
  })
}

interface MahasErrorShape {
  code: string
  message: string
  retry: string
  details?: unknown
}

// ---------------------------------------------------------------------------
// subscription hub — in-process cursor store for the RPC transport
// ---------------------------------------------------------------------------

export class SubscriptionHub {
  private readonly subs = new Map<string, Subscription>()

  /** open a subscription — caller has already validated the cursor */
  open(
    ctx: AuthenticatedContext,
    scope: SnapshotScope,
    rule: VisibilityRule,
    cursor: SubscriptionCursor,
    now: number
  ): Subscription {
    // F-025: the pull model lets clients re-subscribe forever, and a dropped
    // socket never fired closeSession (the transport has no session-close
    // hook) — cap the hub so orphaned entries cannot grow without bound.
    // Eviction answers unknown-subscription on next poll, which is the
    // honest re-snapshot gate, never silent loss (the ledger still holds the
    // events; the client re-presents its cursor).
    while (this.subs.size >= SUBSCRIPTION_HUB_LIMIT) {
      const oldest = this.subs.keys().next()
      if (oldest.done) break
      this.subs.delete(oldest.value)
    }
    const sub: Subscription = {
      id: randomUUID(),
      principalId: ctx.principalId,
      transportSessionId: ctx.transportSessionId,
      scope,
      rule,
      cursor,
      createdAt: now
    }
    this.subs.set(sub.id, sub)
    return sub
  }

  get(id: string): Subscription | undefined {
    return this.subs.get(id)
  }

  advance(id: string, lastSequence: number): void {
    const sub = this.subs.get(id)
    if (sub) sub.cursor = { ...sub.cursor, lastSequence }
  }

  /** detach/unsubscribe — drops the cursor, touches no domain record */
  close(id: string): boolean {
    return this.subs.delete(id)
  }

  /** a transport session ended — only ITS subscriptions are released */
  closeSession(transportSessionId: string): number {
    let n = 0
    for (const [id, sub] of this.subs) {
      if (sub.transportSessionId === transportSessionId) {
        this.subs.delete(id)
        n++
      }
    }
    return n
  }

  list(): Subscription[] {
    return [...this.subs.values()]
  }
}

// ---------------------------------------------------------------------------
// subscribe implementation — shared by the op handler and hub.poll
// ---------------------------------------------------------------------------

function serve(
  db: DatabaseSync,
  deps: ObservationDeps,
  ctx: AuthenticatedContext,
  scope: SnapshotScope,
  rule: VisibilityRule,
  epoch: number,
  afterSequence: number,
  presentedDigest: string,
  batchLimit: number
): { events: DomainEventView[]; lastSequence: number; hasMore: boolean } {
  const stale = cursorStaleness(db, deps, ctx, scope, rule, epoch, afterSequence, presentedDigest)
  if (stale) throw snapshotRequired(stale, { epoch, afterSequence })
  const owner = executionOwnerResolver(db)
  const batch = readEventsSince(db, afterSequence, batchLimit)
  const events: DomainEventView[] = []
  let lastSequence = afterSequence
  for (const ev of batch) {
    // ordering is ledger order — a filtered-out event still advances the
    // cursor so the client never re-reads it
    lastSequence = ev.sequence
    if (events.length >= batchLimit) break
    if (eventVisible(ev, scope, rule, owner)) events.push(ev)
  }
  const hasMore = lastSequence < (ledgerBounds(db).max ?? 0)
  return { events, lastSequence, hasMore }
}

interface TxnLike {
  db: DatabaseSync
  ctx: AuthenticatedContext
}

export function makeRuntimeSubscribeHandler(deps: ResolvedObservationDeps) {
  return (txn: TxnLike, payload: unknown): unknown => {
    const p = (payload ?? {}) as Record<string, unknown>
    // F-025: the returned subscriptionId is consumable — presenting it polls
    // the stored cursor (advancing the server side) instead of minting a new
    // orphan hub entry per call. Unknown or foreign-session ids answer
    // SNAPSHOT_REQUIRED 'unknown-subscription', the honest re-snapshot gate.
    if (typeof p.subscriptionId === 'string' && p.subscriptionId.length > 0) {
      return pollSubscription(txn.db, deps, txn.ctx, p.subscriptionId)
    }
    const scope = normalizeScope(p)
    const epoch = typeof p.epoch === 'number' ? p.epoch : NaN
    const afterSequence = typeof p.afterSequence === 'number' ? p.afterSequence : NaN
    const digest = typeof p.visibilityDigest === 'string' ? p.visibilityDigest : ''
    if (!Number.isFinite(epoch) || !Number.isFinite(afterSequence) || afterSequence < 0) {
      throw snapshotRequired('malformed-cursor', { epoch: p.epoch, afterSequence: p.afterSequence })
    }
    const rule = (deps.visibilityRule ?? visibilityRuleFor)(txn.db, txn.ctx)
    deps.authorize(txn.ctx, 'runtime.subscribe', [
      ...(scope.runId ? [{ kind: 'run', id: scope.runId }] : []),
      ...(scope.executionId ? [{ kind: 'execution', id: scope.executionId }] : []),
      ...(scope.memberId ? [{ kind: 'member', id: scope.memberId }] : []),
      ...(scope.runId || scope.executionId || scope.memberId
        ? []
        : [{ kind: 'runtime', id: 'mahasd' }])
    ])

    const { events, lastSequence, hasMore } = serve(
      txn.db,
      deps,
      txn.ctx,
      scope,
      rule,
      epoch,
      afterSequence,
      digest,
      deps.subscribeBatchLimit ?? SUBSCRIBE_BATCH_LIMIT
    )
    const cursor: SubscriptionCursor = {
      streamId: DOMAIN_EVENT_STREAM_ID,
      epoch,
      lastSequence,
      visibilityDigest: digest
    }
    const sub = deps.subscriptions.open(txn.ctx, scope, rule, cursor, deps.now())
    const result: SubscribeResult = { subscriptionId: sub.id, cursor, events, hasMore }
    return result
  }
}

function normalizeScope(p: Record<string, unknown>): SnapshotScope {
  const inner = (p.scope ?? {}) as Record<string, unknown>
  const pick = (k: 'runId' | 'projectId' | 'memberId' | 'executionId'): string | undefined =>
    typeof p[k] === 'string'
      ? (p[k] as string)
      : typeof inner[k] === 'string'
        ? (inner[k] as string)
        : undefined
  return {
    runId: pick('runId'),
    projectId: pick('projectId'),
    memberId: pick('memberId'),
    executionId: pick('executionId')
  }
}

/**
 * Continue an existing subscription — the transport's poll/drain path.
 * Re-runs the full cursor validation: an expired/revoked/changed cursor
 * answers SNAPSHOT_REQUIRED exactly like a fresh subscribe.
 */
export function pollSubscription(
  db: DatabaseSync,
  deps: ResolvedObservationDeps,
  ctx: AuthenticatedContext,
  subscriptionId: string
): SubscribeResult {
  const sub = deps.subscriptions.get(subscriptionId)
  if (!sub || sub.transportSessionId !== ctx.transportSessionId) {
    throw snapshotRequired('unknown-subscription', { subscriptionId })
  }
  const { events, lastSequence, hasMore } = serve(
    db,
    deps,
    ctx,
    sub.scope,
    (deps.visibilityRule ?? visibilityRuleFor)(db, ctx),
    sub.cursor.epoch,
    sub.cursor.lastSequence,
    sub.cursor.visibilityDigest,
    deps.subscribeBatchLimit ?? SUBSCRIBE_BATCH_LIMIT
  )
  deps.subscriptions.advance(subscriptionId, lastSequence)
  const cursor: SubscriptionCursor = { ...sub.cursor, lastSequence }
  return { subscriptionId, cursor, events, hasMore }
}

/**
 * F-025: `runtime.unsubscribe` — drop a subscription cursor. Ownership is by
 * principal, not transport session, so a client that dropped its socket can
 * still clean up the orphaned id after reconnecting (the id alone was the
 * leak vector: nothing consumed it). Unknown or foreign-principal ids answer
 * SNAPSHOT_REQUIRED 'unknown-subscription'. Dropping a cursor touches no
 * domain record (REQ-23).
 */
export function makeRuntimeUnsubscribeHandler(deps: ResolvedObservationDeps) {
  return (txn: TxnLike, payload: unknown): unknown => {
    const p = (payload ?? {}) as Record<string, unknown>
    const subscriptionId = typeof p.subscriptionId === 'string' ? p.subscriptionId : ''
    if (!subscriptionId) {
      throw snapshotRequired('malformed-cursor', { subscriptionId: p.subscriptionId })
    }
    const sub = deps.subscriptions.get(subscriptionId)
    if (!sub || sub.principalId !== txn.ctx.principalId) {
      throw snapshotRequired('unknown-subscription', { subscriptionId })
    }
    deps.authorize(txn.ctx, 'runtime.unsubscribe', [
      ...(sub.scope.runId ? [{ kind: 'run', id: sub.scope.runId }] : []),
      ...(sub.scope.executionId ? [{ kind: 'execution', id: sub.scope.executionId }] : []),
      ...(sub.scope.memberId ? [{ kind: 'member', id: sub.scope.memberId }] : []),
      ...(sub.scope.runId || sub.scope.executionId || sub.scope.memberId
        ? []
        : [{ kind: 'runtime', id: 'mahasd' }])
    ])
    deps.subscriptions.close(subscriptionId)
    return { unsubscribed: true, subscriptionId }
  }
}
