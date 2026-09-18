// mahas-runtime/observation — C-OBSERVATION boundary entrypoint (IMP-26).
//
// Observation facts, interventions, projections and subscriptions. The
// boundary is dependency-injected: the composition root (mahasd, IMP-30)
// supplies the kernel helpers so this module never imports sibling service
// internals.
//
// registerObservationOps wires the four implemented operations. The
// `observation.ingest` ingress is registered separately by the composition
// root (its trusted-ingress policy is a deployment decision, not a domain
// one) — it is deliberately absent from the default registration.

import type { DatabaseSync } from 'node:sqlite'
import type { OperationRegistry, OperationHandler } from '../api/registry.ts'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import { SubscriptionHub } from './subscriptions.ts'
import { makeInterventionRaiseHandler, makeInterventionResolveHandler } from './intervention.ts'
import { makeRuntimeSnapshotHandler } from './projection.ts'
import { makeRuntimeSubscribeHandler } from './subscriptions.ts'

/* ── injected kernel surface ─────────────────────────────────────────── */

export interface ObservationAuthorizeTarget {
  kind: string
  id: string
}

export interface ObservationDeps {
  /** authority clock, epoch-ms */
  now(): number
  /** the controller epoch this runtime instance started with */
  epochStartedAt: number
  /** kernel digest helper (storage/db.ts sha256Hex) */
  sha256Hex(data: string | Uint8Array): string
  /** kernel domain-event append (storage/db.ts) */
  appendDomainEvent(
    db: DatabaseSync,
    aggregateId: string,
    aggregateRevision: number,
    eventType: string,
    scope: unknown,
    payload: unknown
  ): void
  /** IMP-10 authorization — throws on denial */
  authorize(
    ctx: AuthenticatedContext,
    operation: string,
    targets: ObservationAuthorizeTarget[]
  ): void
  /** positive process-liveness evidence since the epoch (optional: honest unknown when absent) */
  liveEvidenceSince?(db: DatabaseSync, executionId: string, epochStartedAt: number): unknown
  /** override the default role-derived visibility rule */
  visibilityRule?: (
    db: DatabaseSync,
    ctx: AuthenticatedContext
  ) => import('./projection.ts').VisibilityRule
  /** server-side ephemeral subscription store */
  subscriptions?: SubscriptionHub
  /** per-poll batch cap (defaults to SUBSCRIBE_BATCH_LIMIT) */
  subscribeBatchLimit?: number
}

export interface ResolvedObservationDeps extends ObservationDeps {
  subscriptions: SubscriptionHub
}

export function resolveObservationDeps(deps: ObservationDeps): ResolvedObservationDeps {
  return { ...deps, subscriptions: deps.subscriptions ?? new SubscriptionHub() }
}

/* ── registration ────────────────────────────────────────────────────── */

export function registerObservationOps(
  registry: OperationRegistry,
  deps: ObservationDeps
): ResolvedObservationDeps {
  const d = resolveObservationDeps(deps)

  const register = (name: string, mutation: boolean, handler: OperationHandler): void =>
    registry.register({ name, visibility: 'member', mutation }, handler)

  register('intervention.raise', true, makeInterventionRaiseHandler(d) as OperationHandler)
  register('intervention.resolve', true, makeInterventionResolveHandler(d) as OperationHandler)
  register('runtime.snapshot', false, makeRuntimeSnapshotHandler(d) as OperationHandler)
  register('runtime.subscribe', false, makeRuntimeSubscribeHandler(d) as OperationHandler)

  return d
}

/* ── public surface ──────────────────────────────────────────────────── */

export {
  AttentionTracker,
  foldFacts,
  activityOf,
  targetKeyFor,
  ATTENTION_DEDUPE_MS,
  ATTENTION_BURST_MS
} from './attention.ts'
export type {
  AttentionVerdict,
  AttentionSignal,
  AttentionDecision,
  TargetAttention
} from './attention.ts'

export {
  OBSERVATION_SOURCES,
  NOTIFY_FACT_TYPES,
  SETTLE_FACT_TYPES,
  WORKING_SET_FACT_TYPES,
  WORKING_CLEAR_FACT_TYPES,
  STRONG_RESUME_FACT_TYPES,
  insertObservation,
  getObservation,
  listObservationsForExecution,
  listObservationsForExecutions,
  listUnboundObservations,
  lastObservedAt,
  toContractObservation
} from './facts.ts'
export type { ObservationRow, IdentityEvidence } from './facts.ts'
export type { ObservationSource, ConfidenceClass } from './facts.ts'

export {
  getIntervention,
  listInterventions,
  openInterventionsFor,
  raiseInterventionRecord,
  obsoleteInterventions,
  makeInterventionRaiseHandler,
  makeInterventionResolveHandler,
  toContractIntervention
} from './intervention.ts'
export type { InterventionRow, RaiseInterventionInput } from './intervention.ts'

export {
  visibilityRuleFor,
  canonicalJson,
  visibilityDigestOf,
  currentControllerEpoch,
  ledgerBounds,
  buildSnapshot,
  makeRuntimeSnapshotHandler
} from './projection.ts'
export type {
  SnapshotScope,
  VisibilityRule,
  ExecutionProjection,
  ObservationView,
  InterventionView,
  ResumeCandidateView,
  ViewBindingView,
  RuntimeSnapshot
} from './projection.ts'

export {
  SubscriptionHub,
  DOMAIN_EVENT_STREAM_ID,
  SUBSCRIBE_BATCH_LIMIT,
  readEventsSince,
  eventVisible,
  executionOwnerResolver,
  cursorStaleness,
  snapshotRequired,
  makeRuntimeSubscribeHandler,
  pollSubscription
} from './subscriptions.ts'
export type {
  SubscriptionCursor,
  DomainEventView,
  Subscription,
  SubscribeResult
} from './subscriptions.ts'
