// observation/projection.ts — role-aware runtime.snapshot projection.
//
// C-OBSERVATION `runtime.snapshot`: returns {epoch, sequence,
// visibilityDigest, entities} — the recovery basis for UI clients
// (REQ-23). The cursor is the domain_events global sequence the snapshot
// was read against; a client then follows with runtime.subscribe.
//
// Honesty rules this projection enforces:
//  - Stored liveness is restored-UNCONFIRMED: an execution stored 'live'
//    is projected 'live' only when bound observation evidence exists at or
//    after this controller's epoch start; otherwise 'unverifiable'
//    (instruction §4.2, spec/storage.md §7 — a DB snapshot's past process
//    identity is never re-approved as a writer without new evidence).
//  - live / working / Task outcome stay SEPARATE: `state`+`liveness` come
//    from the execution record, `activity` folds ObservationFacts, and no
//    field here ever reports task settlement.
//  - Output silence is never completion: 'process-idle' facts project as
//    their own fact type — nothing re-types them into turn-complete.
//  - Role-aware read filter: member-class principals see their own run and
//    get foreign members' fact payloads redacted (contract: role-aware
//    read filter / metadata redaction).

import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/index.ts'
import { activityOf, foldFacts, targetKeyFor } from './attention.ts'
import type { TargetAttention } from './attention.ts'
import {
  listObservationsForExecution,
  listObservationsForExecutions,
  listUnboundObservations,
  lastObservedAt
} from './facts.ts'
import type { ConfidenceClass, ObservationRow } from './facts.ts'
import { listInterventions, mahasError } from './intervention.ts'
import type { InterventionRow } from './intervention.ts'
import type { ObservationDeps } from './index.ts'

// ---------------------------------------------------------------------------
// scope + visibility
// ---------------------------------------------------------------------------

export interface SnapshotScope {
  runId?: string
  projectId?: string
  memberId?: string
  executionId?: string
  /** cap on stored facts returned — default 200 */
  observationLimit?: number
}

/**
 * Who may see what. 'member' restricts to the caller's run and redacts
 * other members' fact payloads; 'unrestricted' is operator/service-class.
 * The real policy object is role_policies.projection_policy (IMP-10) —
 * this rule is the honest v1 floor, replaceable via ObservationDeps.
 */
export type VisibilityRule =
  { kind: 'unrestricted' } | { kind: 'member'; runId: string; memberId: string }

export function visibilityRuleFor(db: DatabaseSync, ctx: AuthenticatedContext): VisibilityRule {
  if (!ctx.memberId) return { kind: 'unrestricted' }
  const row = db.prepare(`SELECT run_id FROM members WHERE id = ?`).get(ctx.memberId) as
    { run_id: string } | undefined
  // a member with no membership row sees nothing — empty runId matches none
  return { kind: 'member', runId: row?.run_id ?? '', memberId: ctx.memberId }
}

/** canonical JSON for digests — key order fixed so digests are stable. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

/**
 * The visibility digest a client echoes back on subscribe. It captures the
 * caller's identity + grant revisions + read scope: a grant revoke, a
 * member rebind, or a scope change flips the digest and the stream answers
 * SNAPSHOT_REQUIRED instead of silently serving stale visibility.
 */
export function visibilityDigestOf(
  deps: ObservationDeps,
  ctx: AuthenticatedContext,
  rule: VisibilityRule,
  scope: SnapshotScope
): string {
  const basis = {
    principalId: ctx.principalId,
    memberId: ctx.memberId ?? null,
    grantRevisions: sortKeys(ctx.grantRevisions ?? {}),
    rule: rule.kind === 'member' ? { kind: 'member', runId: rule.runId } : { kind: 'unrestricted' },
    scope: {
      runId: scope.runId ?? null,
      projectId: scope.projectId ?? null,
      memberId: scope.memberId ?? null,
      executionId: scope.executionId ?? null
    }
  }
  return deps.sha256Hex(canonicalJson(basis))
}

/** current controller epoch — runtime_instances max, else the ctx epoch. */
export function currentControllerEpoch(db: DatabaseSync, ctx: AuthenticatedContext): number {
  const row = db.prepare(`SELECT MAX(controller_epoch) AS epoch FROM runtime_instances`).get() as
    { epoch: number | null } | undefined
  return row?.epoch ?? ctx.controllerEpoch
}

/** domain_events sequence bounds — the outbox cursor's valid range. */
export function ledgerBounds(db: DatabaseSync): { min: number | null; max: number | null } {
  const row = db
    .prepare(`SELECT MIN(sequence) AS min, MAX(sequence) AS max FROM domain_events`)
    .get() as { min: number | null; max: number | null }
  return { min: row.min, max: row.max }
}

// ---------------------------------------------------------------------------
// entity views
// ---------------------------------------------------------------------------

export interface ExecutionProjection {
  id: string
  memberId: string
  runId: string | null
  projectId: string | null
  generation: number
  hostId: string | null
  /** stored lifecycle state — kept verbatim, never equated with liveness */
  state: string
  /** PROJECTED liveness — stored 'live' without current-epoch evidence → unverifiable */
  liveness: 'live' | 'unverifiable' | 'exited'
  /** the row's stored liveness, exposed so clients can tell projection from storage */
  storedLiveness: string
  /** folded from ObservationFacts — never Task outcome */
  activity: 'working' | 'idle' | 'needs-input' | 'unknown'
  terminalId: string | null
  revision: number
  lastObservedAt: number | null
}

export interface ObservationView {
  id: string
  executionId: string | null
  dispatchId: string | null
  source: string
  factType: string
  observedAt: number
  confidenceClass: ConfidenceClass | undefined
  /** absent when redacted for a member-class reader */
  payload?: unknown
  identityEvidence?: unknown
  /** digest of the withheld payload when redacted */
  redacted?: boolean
}

export interface InterventionView {
  id: string
  runId: string | null
  memberId: string | null
  executionId: string | null
  kind: string
  state: string
  revision: number
  requestedHumanAction?: string
  terminal?: unknown
  responder?: string
  responseNote?: string
  resolvedAt?: number
  raisedAt?: number
}

export interface ResumeCandidateView {
  id: string
  executionId: string
  supportState: string
  nativeHandle: unknown
  evidence: unknown
}

export interface ViewBindingView {
  id: string
  clientId: string
  viewId: string
  executionId: string | null
  terminalId: string | null
  layout: unknown
}

export interface RuntimeSnapshot {
  epoch: number
  /** domain_events sequence this snapshot covers — the subscribe cursor */
  sequence: number
  visibilityDigest: string
  scope: SnapshotScope
  entities: {
    executions: ExecutionProjection[]
    interventions: InterventionView[]
    observations: ObservationView[]
    /** unbound/foreign facts — unrestricted readers only */
    unboundObservations: ObservationView[]
    resumeCandidates: ResumeCandidateView[]
    viewBindings: ViewBindingView[]
  }
  /** per-execution folded attention state — pending asks, working flags */
  attention: TargetAttention[]
}

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

interface ExecutionRow {
  id: string
  member_id: string
  generation: number
  host_id: string
  state: string
  liveness: string
  terminal_id: string | null
  revision: number
  run_id: string | null
  project_id: string | null
}

function scopedExecutions(
  db: DatabaseSync,
  scope: SnapshotScope,
  rule: VisibilityRule
): ExecutionRow[] {
  const where: string[] = []
  const args: (string | number)[] = []
  const runId = rule.kind === 'member' ? rule.runId : scope.runId
  if (rule.kind === 'member') {
    where.push('m.run_id = ?')
    args.push(rule.runId)
  }
  if (runId && rule.kind !== 'member') {
    where.push('m.run_id = ?')
    args.push(runId)
  }
  if (scope.projectId) {
    where.push('r.project_id = ?')
    args.push(scope.projectId)
  }
  if (scope.memberId) {
    where.push('e.member_id = ?')
    args.push(scope.memberId)
  }
  if (scope.executionId) {
    where.push('e.id = ?')
    args.push(scope.executionId)
  }
  return db
    .prepare(
      `SELECT e.id, e.member_id, e.generation, e.host_id, e.state, e.liveness,
              e.terminal_id, e.revision, m.run_id AS run_id, r.project_id AS project_id
       FROM executions e
       LEFT JOIN members m ON e.member_id = m.id
       LEFT JOIN runs r ON m.run_id = r.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY e.id`
    )
    .all(...args) as unknown as ExecutionRow[]
}

function observationView(
  row: ObservationRow,
  redact: boolean,
  sha: (s: string) => string
): ObservationView {
  const confidenceClass = row.identityEvidence.confidenceClass
  if (redact) {
    return {
      id: row.id,
      executionId: row.executionId,
      dispatchId: row.dispatchId,
      source: row.source,
      factType: row.factType,
      observedAt: row.observedAt,
      confidenceClass,
      redacted: true,
      payload: { digest: sha(JSON.stringify(row.payload ?? null)) },
      identityEvidence: {
        provider: row.identityEvidence.provider,
        confidenceClass,
        attribution: row.identityEvidence.attribution
      }
    }
  }
  return {
    id: row.id,
    executionId: row.executionId,
    dispatchId: row.dispatchId,
    source: row.source,
    factType: row.factType,
    observedAt: row.observedAt,
    confidenceClass,
    payload: row.payload,
    identityEvidence: row.identityEvidence
  }
}

function interventionView(row: InterventionRow): InterventionView {
  return {
    id: row.id,
    runId: row.runId,
    memberId: row.memberId,
    executionId: row.executionId,
    kind: row.evidence.kind,
    state: row.state,
    revision: row.revision,
    requestedHumanAction: row.evidence.requestedHumanAction,
    terminal: row.evidence.terminal,
    responder: row.response.responder,
    responseNote: row.response.responseNote,
    resolvedAt: row.response.resolvedAt,
    raisedAt: row.evidence.raisedAt
  }
}

function listResumeCandidates(
  db: DatabaseSync,
  executionIds: readonly string[]
): ResumeCandidateView[] {
  if (executionIds.length === 0) return []
  const marks = executionIds.map(() => '?').join(',')
  const raws = db
    .prepare(
      `SELECT id, execution_id, support_state, native_handle_json, evidence_json
       FROM resume_candidates WHERE execution_id IN (${marks}) ORDER BY rowid`
    )
    .all(...executionIds) as {
    id: string
    execution_id: string
    support_state: string
    native_handle_json: string
    evidence_json: string
  }[]
  return raws.map((r) => ({
    id: r.id,
    executionId: r.execution_id,
    supportState: r.support_state,
    nativeHandle: parseJson(r.native_handle_json),
    evidence: parseJson(r.evidence_json)
  }))
}

function listViewBindings(db: DatabaseSync, clientId: string): ViewBindingView[] {
  const raws = db
    .prepare(
      `SELECT id, client_id, view_id, execution_id, terminal_id, layout_binding_json
       FROM client_view_bindings WHERE client_id = ? ORDER BY rowid`
    )
    .all(clientId) as {
    id: string
    client_id: string
    view_id: string
    execution_id: string | null
    terminal_id: string | null
    layout_binding_json: string
  }[]
  return raws.map((r) => ({
    id: r.id,
    clientId: r.client_id,
    viewId: r.view_id,
    executionId: r.execution_id,
    terminalId: r.terminal_id,
    layout: parseJson(r.layout_binding_json)
  }))
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// snapshot builder — shared by the op handler and direct in-process callers
// ---------------------------------------------------------------------------

export function buildSnapshot(
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  deps: ObservationDeps,
  scope: SnapshotScope
): RuntimeSnapshot {
  const rule = (deps.visibilityRule ?? visibilityRuleFor)(db, ctx)

  // member-class callers may not point the scope outside their own run —
  // narrower-than-allowed is fine, wider is SCOPE_DENIED.
  if (rule.kind === 'member' && scope.runId && scope.runId !== rule.runId) {
    throw mahasError('SCOPE_DENIED', 'snapshot scope is outside the caller member run', {
      runId: scope.runId
    })
  }

  // Sequence FIRST: entities may cover writes newer than `sequence`, which
  // only causes duplicate delivery on re-subscribe — the safe direction.
  // Reading sequence last could hide committed events behind the cursor.
  const { max } = ledgerBounds(db)
  const sequence = max ?? 0

  const execs = scopedExecutions(db, scope, rule)
  const execIds = execs.map((e) => e.id)
  const limit = scope.observationLimit ?? 200
  const epochStartedAt = deps.epochStartedAt

  const attention: TargetAttention[] = []
  const executions: ExecutionProjection[] = execs.map((e) => {
    const facts = listObservationsForExecution(db, e.id, limit)
    const att = foldFacts(targetKeyFor(e.id, {}), facts)
    attention.push(att)
    const lastObs = lastObservedAt(db, e.id)
    const liveEvidence = deps.liveEvidenceSince
      ? deps.liveEvidenceSince(db, e.id, epochStartedAt)
      : (lastObs ?? 0) >= epochStartedAt
    const stored = e.liveness
    const liveness =
      stored === 'live'
        ? liveEvidence
          ? 'live'
          : 'unverifiable'
        : (stored as ExecutionProjection['liveness'])
    return {
      id: e.id,
      memberId: e.member_id,
      runId: e.run_id,
      projectId: e.project_id,
      generation: e.generation,
      hostId: e.host_id,
      state: e.state,
      liveness,
      storedLiveness: stored,
      activity: activityOf(att),
      terminalId: e.terminal_id,
      revision: e.revision,
      lastObservedAt: lastObs
    }
  })

  const execMember = new Map(execs.map((e) => [e.id, e.member_id]))
  const redactFor = (executionId: string | null): boolean =>
    rule.kind === 'member' && executionId !== null && execMember.get(executionId) !== rule.memberId

  const facts = listObservationsForExecutions(db, execIds, limit)
  const observations = facts.map((f) =>
    observationView(f, redactFor(f.executionId), deps.sha256Hex)
  )
  // unbound/foreign facts stay out of member-scoped views entirely —
  // they are unattributed input, not run state.
  const unbound =
    rule.kind === 'unrestricted'
      ? listUnboundObservations(db, limit).map((f) => observationView(f, false, deps.sha256Hex))
      : []

  const interventions = (
    rule.kind === 'member'
      ? listInterventions(db, { executionIds: execIds })
      : listInterventions(db, {
          runId: scope.runId,
          memberId: scope.memberId,
          executionId: scope.executionId,
          ...(scope.runId || scope.memberId || scope.executionId ? {} : { executionIds: execIds })
        })
  ).map(interventionView)

  const resumeCandidates = listResumeCandidates(db, execIds)
  const viewBindings = listViewBindings(db, ctx.principalId)

  const visibilityDigest = visibilityDigestOf(deps, ctx, rule, scope)
  const epoch = currentControllerEpoch(db, ctx)

  return {
    epoch,
    sequence,
    visibilityDigest,
    scope,
    entities: {
      executions,
      interventions,
      observations,
      unboundObservations: unbound,
      resumeCandidates,
      viewBindings
    },
    attention
  }
}

// ---------------------------------------------------------------------------
// operation handler
// ---------------------------------------------------------------------------

interface TxnLike {
  db: DatabaseSync
  ctx: AuthenticatedContext
}

export function makeRuntimeSnapshotHandler(deps: ObservationDeps) {
  return (txn: TxnLike, payload: unknown): unknown => {
    const p = (payload ?? {}) as Record<string, unknown>
    const scope: SnapshotScope = {
      runId:
        typeof p.runId === 'string'
          ? p.runId
          : ((p.scope as Record<string, unknown> | undefined)?.runId as string | undefined),
      projectId:
        typeof p.projectId === 'string'
          ? p.projectId
          : ((p.scope as Record<string, unknown> | undefined)?.projectId as string | undefined),
      memberId:
        typeof p.memberId === 'string'
          ? p.memberId
          : ((p.scope as Record<string, unknown> | undefined)?.memberId as string | undefined),
      executionId:
        typeof p.executionId === 'string'
          ? p.executionId
          : ((p.scope as Record<string, unknown> | undefined)?.executionId as string | undefined),
      observationLimit: typeof p.observationLimit === 'number' ? p.observationLimit : undefined
    }
    const targets = [
      ...(scope.runId ? [{ kind: 'run', id: scope.runId }] : []),
      ...(scope.projectId ? [{ kind: 'project', id: scope.projectId }] : []),
      ...(scope.memberId ? [{ kind: 'member', id: scope.memberId }] : []),
      ...(scope.executionId ? [{ kind: 'execution', id: scope.executionId }] : [])
    ]
    if (targets.length === 0) targets.push({ kind: 'runtime', id: 'mahasd' })
    deps.authorize(txn.ctx, 'runtime.snapshot', targets)
    return buildSnapshot(txn.db, txn.ctx, deps, scope)
  }
}
