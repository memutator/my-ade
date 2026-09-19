// observation/intervention.ts — Intervention store + raise/resolve ops.
//
// C-OBSERVATION `intervention.raise` / `intervention.resolve`, REQ-24:
// an Intervention records evidence + scope + state for a human-attention
// request. It is NOT a generic-PTY permission auto-approval API — this
// boundary never answers the prompt; it records the request, keeps the
// real terminal connection point as evidence, and resolves explicitly.
// An old request must never apply to a different prompt: resolve re-checks
// the bound execution's currentness (STALE_EXECUTION) and the record's
// revision (STALE_REVISION).
//
// Storage (spec/storage.md §3 `interventions`): id, run_id?, member_id?,
// execution_id?, state, revision, evidence_json, response_json. The spec
// object's `kind` lives in evidence_json.kind; `responder`/`responseNote`
// live in response_json.

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext, MahasError } from '../../../mahas-contracts/src/index.ts'
import type { Intervention } from '../../../mahas-contracts/src/index.ts'
import type { ObservationDeps } from './index.ts'

export type InterventionState = 'open' | 'claimed' | 'resolved' | 'obsolete'

/** states a resolve/claim may still act on */
const OPEN_STATES = new Set<InterventionState>(['open', 'claimed'])

export interface TerminalEvidence {
  terminalId: string
  hostIncarnation?: string
  outputEpoch?: string
  lastSequence?: number
}

/** evidence_json payload — kind + the real terminal connection point. */
export interface InterventionEvidence {
  kind: string
  requestedHumanAction?: string
  /** caller-supplied evidence (fact payload, prompt text, refs) */
  detail?: unknown
  /** the observation that raised this intervention, when automated */
  factId?: string
  /** real terminal the human should attach to — never a transcript copy */
  terminal?: TerminalEvidence
  /** execution pins taken at raise time — staleness is judged against them */
  executionRevision?: number
  executionGeneration?: number
  raisedBy: string
  raisedAt: number
}

/** response_json payload — who answered and what they decided. */
export interface InterventionResponse {
  responder?: string
  responseNote?: string
  evidenceRef?: string
  resolvedAt?: number
  outcome?: 'resolved' | 'obsolete' | 'claimed'
  obsoleteReason?: string
}

export interface InterventionRow {
  id: string
  runId: string | null
  memberId: string | null
  executionId: string | null
  state: InterventionState
  revision: number
  evidence: InterventionEvidence
  response: InterventionResponse
}

export interface RaiseInterventionInput {
  runId?: string
  memberId?: string
  executionId?: string
  kind: string
  evidence?: unknown
  requestedHumanAction?: string
  /** internal raisers (observation ingest) pass the originating fact */
  factId?: string
  raisedBy?: string
}

interface RawInterventionRow {
  id: string
  run_id: string | null
  member_id: string | null
  execution_id: string | null
  state: string
  revision: number
  evidence_json: string
  response_json: string
}

function parseJson(text: string, fallback: unknown): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function toInterventionRow(raw: RawInterventionRow): InterventionRow {
  return {
    id: raw.id,
    runId: raw.run_id,
    memberId: raw.member_id,
    executionId: raw.execution_id,
    state: raw.state as InterventionState,
    revision: raw.revision,
    evidence: (parseJson(raw.evidence_json, {}) ?? {}) as InterventionEvidence,
    response: (parseJson(raw.response_json, {}) ?? {}) as InterventionResponse
  }
}

export function getIntervention(db: DatabaseSync, id: string): InterventionRow | null {
  const raw = db
    .prepare(
      `SELECT id, run_id, member_id, execution_id, state, revision, evidence_json, response_json
       FROM interventions WHERE id = ?`
    )
    .get(id) as RawInterventionRow | undefined
  return raw ? toInterventionRow(raw) : null
}

export function listInterventions(
  db: DatabaseSync,
  filter: {
    runId?: string
    memberId?: string
    executionId?: string
    executionIds?: readonly string[]
  }
): InterventionRow[] {
  const where: string[] = []
  const args: (string | number)[] = []
  if (filter.executionIds !== undefined) {
    if (filter.executionIds.length === 0) return []
    where.push(`execution_id IN (${filter.executionIds.map(() => '?').join(',')})`)
    args.push(...filter.executionIds)
  } else {
    if (filter.runId) {
      where.push('(run_id = ? OR member_id IN (SELECT id FROM members WHERE run_id = ?))')
      args.push(filter.runId, filter.runId)
    }
    if (filter.memberId) {
      where.push('member_id = ?')
      args.push(filter.memberId)
    }
    if (filter.executionId) {
      where.push('execution_id = ?')
      args.push(filter.executionId)
    }
  }
  const raws = db
    .prepare(
      `SELECT id, run_id, member_id, execution_id, state, revision, evidence_json, response_json
       FROM interventions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY rowid ASC`
    )
    .all(...args) as unknown as RawInterventionRow[]
  return raws.map(toInterventionRow)
}

/** open/claimed interventions of a kind for one execution (supersede scan) */
export function openInterventionsFor(
  db: DatabaseSync,
  executionId: string,
  kind?: string
): InterventionRow[] {
  return listInterventions(db, { executionId }).filter(
    (i) => OPEN_STATES.has(i.state) && (kind === undefined || i.evidence.kind === kind)
  )
}

/** current execution snapshot relevant to staleness + terminal evidence. */
interface ExecutionSnapshot {
  id: string
  memberId: string
  generation: number
  state: string
  liveness: string
  revision: number
  terminalId: string | null
  runId: string | null
}

function loadExecution(db: DatabaseSync, id: string): ExecutionSnapshot | null {
  const row = db
    .prepare(
      `SELECT e.id, e.member_id, e.generation, e.state, e.liveness, e.revision, e.terminal_id,
              m.run_id AS run_id
       FROM executions e LEFT JOIN members m ON e.member_id = m.id
       WHERE e.id = ?`
    )
    .get(id) as
    | {
        id: string
        member_id: string
        generation: number
        state: string
        liveness: string
        revision: number
        terminal_id: string | null
        run_id: string | null
      }
    | undefined
  if (!row) return null
  return {
    id: row.id,
    memberId: row.member_id,
    generation: row.generation,
    state: row.state,
    liveness: row.liveness,
    revision: row.revision,
    terminalId: row.terminal_id,
    runId: row.run_id
  }
}

/** real terminal evidence — the connection point a human attaches to. */
function terminalEvidence(
  db: DatabaseSync,
  terminalId: string | null
): TerminalEvidence | undefined {
  if (!terminalId) return undefined
  const row = db
    .prepare(
      `SELECT id, host_incarnation, output_epoch, last_sequence FROM terminal_records WHERE id = ?`
    )
    .get(terminalId) as
    | { id: string; host_incarnation: string; output_epoch: string; last_sequence: number }
    | undefined
  if (!row) return { terminalId }
  return {
    terminalId: row.id,
    hostIncarnation: row.host_incarnation,
    outputEpoch: row.output_epoch,
    lastSequence: row.last_sequence
  }
}

export function mahasError(
  code: MahasError['code'],
  message: string,
  details?: unknown
): MahasError {
  return { code, message, retry: code === 'SNAPSHOT_REQUIRED' ? 'reconcile' : 'none', details }
}

function ensureMemberScope(
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  runId: string | null
): void {
  // member-class callers may only act inside their own run; service /
  // operator principals (no memberId) are gated by authorize() instead.
  if (!ctx.memberId) return
  const mine = db.prepare(`SELECT run_id FROM members WHERE id = ?`).get(ctx.memberId) as
    { run_id: string } | undefined
  if (!mine || !runId || mine.run_id !== runId) {
    throw mahasError('SCOPE_DENIED', 'intervention target is outside the caller member scope', {
      memberId: ctx.memberId,
      runId
    })
  }
}

/**
 * Store an intervention + its domain event in the caller's transaction.
 * Shared by the `intervention.raise` op and observation-internal raisers
 * (needs-input automation in ingress).
 */
export function raiseInterventionRecord(
  db: DatabaseSync,
  deps: ObservationDeps,
  input: RaiseInterventionInput,
  now: number
): InterventionRow {
  const exec = input.executionId ? loadExecution(db, input.executionId) : null
  if (input.executionId && !exec) {
    throw mahasError('SCOPE_DENIED', 'unknown execution for intervention scope', {
      executionId: input.executionId
    })
  }
  const runId = input.runId ?? exec?.runId ?? null
  const memberId = input.memberId ?? exec?.memberId ?? null
  const evidence: InterventionEvidence = {
    kind: input.kind,
    requestedHumanAction: input.requestedHumanAction,
    detail: input.evidence,
    factId: input.factId,
    terminal: terminalEvidence(db, exec?.terminalId ?? null),
    executionRevision: exec?.revision,
    executionGeneration: exec?.generation,
    raisedBy: input.raisedBy ?? 'observation-service',
    raisedAt: now
  }
  const row: InterventionRow = {
    id: randomUUID(),
    runId,
    memberId,
    executionId: input.executionId ?? null,
    state: 'open',
    revision: 1,
    evidence,
    response: {}
  }
  db.prepare(
    `INSERT INTO interventions (id, run_id, member_id, execution_id, state, revision, evidence_json, response_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.runId,
    row.memberId,
    row.executionId,
    row.state,
    row.revision,
    JSON.stringify(row.evidence),
    JSON.stringify(row.response)
  )
  deps.appendDomainEvent(db, row.id, row.revision, 'intervention.raised', interventionScope(row), {
    kind: evidence.kind,
    requestedHumanAction: evidence.requestedHumanAction,
    factId: evidence.factId,
    terminalId: evidence.terminal?.terminalId
  })
  return row
}

function interventionScope(row: InterventionRow): Record<string, string> {
  const scope: Record<string, string> = {}
  if (row.runId) scope.runId = row.runId
  if (row.memberId) scope.memberId = row.memberId
  if (row.executionId) scope.executionId = row.executionId
  return scope
}

/**
 * Mark open/claimed interventions obsolete — the supersede path used when
 * a newer fact proves the request is stale (e.g. the turn moved on past a
 * needs-input ask). Recording obsolescence is bookkeeping, not answering
 * the prompt, so it is allowed on stale executions.
 */
export function obsoleteInterventions(
  db: DatabaseSync,
  deps: ObservationDeps,
  ids: readonly string[],
  reason: string,
  factId: string | undefined,
  now: number
): string[] {
  const changed: string[] = []
  for (const id of ids) {
    const row = getIntervention(db, id)
    if (!row || !OPEN_STATES.has(row.state)) continue
    const response: InterventionResponse = {
      ...row.response,
      outcome: 'obsolete',
      obsoleteReason: reason,
      resolvedAt: now
    }
    const revision = row.revision + 1
    db.prepare(
      `UPDATE interventions SET state = 'obsolete', revision = ?, response_json = ? WHERE id = ?`
    ).run(revision, JSON.stringify(response), id)
    deps.appendDomainEvent(
      db,
      id,
      revision,
      'intervention.obsolete',
      interventionScope({ ...row, revision }),
      { kind: row.evidence.kind, obsoleteReason: reason, factId }
    )
    changed.push(id)
  }
  return changed
}

// ---------------------------------------------------------------------------
// operation handlers (TxnContext comes from IMP-11's registry dispatch)
// ---------------------------------------------------------------------------

interface TxnLike {
  db: DatabaseSync
  ctx: AuthenticatedContext
}

export function makeInterventionRaiseHandler(deps: ObservationDeps) {
  return (txn: TxnLike, payload: unknown): unknown => {
    const p = (payload ?? {}) as Record<string, unknown>
    const kind = typeof p.kind === 'string' ? p.kind : undefined
    if (!kind) throw mahasError('SCOPE_DENIED', 'intervention.raise requires kind')
    const executionId = typeof p.executionId === 'string' ? p.executionId : undefined
    const memberId = typeof p.memberId === 'string' ? p.memberId : undefined
    const runId = typeof p.runId === 'string' ? p.runId : undefined

    const exec = executionId ? loadExecution(txn.db, executionId) : null
    if (executionId && !exec) {
      throw mahasError('SCOPE_DENIED', 'unknown execution for intervention scope', { executionId })
    }
    const effectiveRunId = runId ?? exec?.runId ?? (memberId ? runOfMember(txn.db, memberId) : null)
    const targets = [
      ...(effectiveRunId ? [{ kind: 'run', id: effectiveRunId }] : []),
      ...(memberId || exec ? [{ kind: 'member', id: (memberId ?? exec!.memberId) as string }] : []),
      ...(executionId ? [{ kind: 'execution', id: executionId }] : []),
      ...(typeof p.taskRef === 'string' ? [{ kind: 'task', id: p.taskRef }] : [])
    ]
    // the contract input is an execution/member/task ref — a raise with no
    // resolvable scope is denied, not anchored to a fabricated target.
    if (targets.length === 0) {
      throw mahasError('SCOPE_DENIED', 'intervention.raise requires an execution/member/task ref')
    }
    deps.authorize(txn.ctx, 'intervention.raise', targets)
    ensureMemberScope(txn.db, txn.ctx, effectiveRunId)

    const row = raiseInterventionRecord(
      txn.db,
      deps,
      {
        runId: effectiveRunId ?? undefined,
        memberId: memberId ?? exec?.memberId,
        executionId,
        kind,
        evidence: p.evidence,
        requestedHumanAction:
          typeof p.requestedHumanAction === 'string' ? p.requestedHumanAction : undefined,
        raisedBy: txn.ctx.principalId
      },
      deps.now()
    )
    return { interventionId: row.id, state: row.state, revision: row.revision }
  }
}

function runOfMember(db: DatabaseSync, memberId: string): string | null {
  const row = db.prepare(`SELECT run_id FROM members WHERE id = ?`).get(memberId) as
    { run_id: string } | undefined
  return row?.run_id ?? null
}

/**
 * Is the request still about the CURRENT prompt? Generation change, exit,
 * or abandonment means the pinned prompt is gone — a resolve must never
 * land on a different prompt than the one that was raised.
 */
function executionStale(exec: ExecutionSnapshot | null, evidence: InterventionEvidence): boolean {
  if (!exec) return true // the bound execution is gone entirely
  if (
    evidence.executionGeneration !== undefined &&
    evidence.executionGeneration !== exec.generation
  )
    return true
  if (exec.state === 'exited' || exec.state === 'abandoned') return true
  if (exec.liveness === 'exited') return true
  return false
}

export function makeInterventionResolveHandler(deps: ObservationDeps) {
  return (txn: TxnLike, payload: unknown): unknown => {
    const p = (payload ?? {}) as Record<string, unknown>
    const id = typeof p.interventionId === 'string' ? p.interventionId : undefined
    if (!id) throw mahasError('SCOPE_DENIED', 'intervention.resolve requires interventionId')
    const row = getIntervention(txn.db, id)
    if (!row) throw mahasError('SCOPE_DENIED', 'unknown intervention', { interventionId: id })

    deps.authorize(txn.ctx, 'intervention.resolve', [
      { kind: 'intervention', id },
      ...(row.runId ? [{ kind: 'run', id: row.runId }] : []),
      ...(row.executionId ? [{ kind: 'execution', id: row.executionId }] : [])
    ])
    ensureMemberScope(txn.db, txn.ctx, row.runId)

    const transition =
      p.transition === 'claim' || p.transition === 'obsolete' ? p.transition : 'resolve'

    // terminal states are idempotent reads — an already-closed record is
    // returned unchanged rather than re-written or blindly errored.
    if (!OPEN_STATES.has(row.state)) {
      return { interventionId: row.id, state: row.state, revision: row.revision }
    }

    if (p.expectedRevision !== undefined && p.expectedRevision !== row.revision) {
      throw mahasError('STALE_REVISION', 'intervention revision mismatch', {
        interventionId: id,
        expected: p.expectedRevision,
        actual: row.revision
      })
    }

    const exec = row.executionId ? loadExecution(txn.db, row.executionId) : null
    const stale = row.executionId ? executionStale(exec, row.evidence) : false
    if (stale && transition !== 'obsolete') {
      // the prompt this resolve would answer is gone — refuse rather than
      // apply the response to a different (or dead) request.
      throw mahasError('STALE_EXECUTION', 'intervention bound execution is stale', {
        interventionId: id,
        executionId: row.executionId,
        executionRevision: row.evidence.executionRevision,
        executionGeneration: row.evidence.executionGeneration
      })
    }

    const now = deps.now()
    let state: InterventionState
    let response: InterventionResponse
    if (transition === 'claim') {
      state = 'claimed'
      response = { ...row.response, responder: txn.ctx.principalId, outcome: 'claimed' }
    } else if (transition === 'obsolete') {
      state = 'obsolete'
      response = {
        ...row.response,
        responder: txn.ctx.principalId,
        outcome: 'obsolete',
        obsoleteReason:
          typeof p.responseNote === 'string'
            ? p.responseNote
            : stale
              ? 'stale-execution'
              : 'withdrawn',
        resolvedAt: now
      }
    } else {
      state = 'resolved'
      response = {
        responder: txn.ctx.principalId,
        responseNote: typeof p.responseNote === 'string' ? p.responseNote : undefined,
        evidenceRef: typeof p.evidenceRef === 'string' ? p.evidenceRef : undefined,
        resolvedAt: now,
        outcome: 'resolved'
      }
    }
    const revision = row.revision + 1
    db_update(txn.db, id, state, revision, response)
    deps.appendDomainEvent(
      txn.db,
      id,
      revision,
      state === 'resolved'
        ? 'intervention.resolved'
        : state === 'claimed'
          ? 'intervention.claimed'
          : 'intervention.obsolete',
      interventionScope({ ...row, revision }),
      {
        kind: row.evidence.kind,
        responder: response.responder,
        outcome: response.outcome,
        obsoleteReason: response.obsoleteReason
      }
    )
    return { interventionId: id, state, revision }
  }
}

function db_update(
  db: DatabaseSync,
  id: string,
  state: InterventionState,
  revision: number,
  response: InterventionResponse
): void {
  db.prepare(
    `UPDATE interventions SET state = ?, revision = ?, response_json = ? WHERE id = ?`
  ).run(state, revision, JSON.stringify(response), id)
}

/** map a storage row to the canonical contract shape (IMP-02 name). */
export function toContractIntervention(row: InterventionRow): Intervention {
  return {
    id: row.id,
    runId: row.runId ?? undefined,
    memberId: row.memberId ?? undefined,
    executionId: row.executionId ?? undefined,
    kind: row.evidence.kind,
    evidence: row.evidence,
    state: row.state,
    responder: row.response.responder,
    responseNote: row.response.responseNote
  } as Intervention
}
