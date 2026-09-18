// mahas-runtime — maintenance/impact-service (IMP-27).
//
// The operation surface of the maintenance boundary: registerMaintenanceOps
// wires model.impact.list / model.impact.classify into the OperationRegistry
// (spec/operations.md — the only two operations this task owns).
//
//   model.impact.list      — candidates with reason + before/after refs,
//                            filtered by projectId/status/roleId, keyset
//                            cursor pagination (C-MODEL).
//   model.impact.classify  — the designated maintainer's explicit verdict
//                            (classification.ts).
//
// Also exported for the composition root (IMP-30): createMaintenanceHooks
// (basis-observer) — the detection entry points wired into
// model.change.commit / task.report / implementation publish flows — and
// unreviewedStaleCandidates(), the read model a launch path consults when
// applying the stale-interface/required-context policy to NEW launches
// (role-realization §5). Running bundles are never consulted or mutated
// here — an active execution's pin is untouchable (REQ-21).

import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext, QueryResult } from '../../../mahas-contracts/src/common.ts'
import {
  fail,
  rowToCandidate,
  type CandidateResolution,
  type ImpactCandidateRow,
  type ImpactCandidateState,
  type ImpactReason,
  type ImpactTargetKind,
  type ObserverDeps
} from './basis-observer.ts'
import { classifyCandidate, type AuthorizeFn, type ClassifyDecision } from './classification.ts'

// composition-root seams: the detection hooks (basis-observer) and the
// explicit candidate->task link — imported once from this module by IMP-30.
export {
  createMaintenanceHooks,
  type MaintenanceHooks,
  type ObserverDeps
} from './basis-observer.ts'
export { linkMaintenanceTask, resolveMemberPins } from './task-link.ts'

/* ------------------------------------------------------------------ *
 * registry seam — structural twin of IMP-11's OperationRegistry
 * (SHARED-APIS): {name, visibility, mutation} + handler(TxnContext,
 * payload). The real registry satisfies this shape once IMP-11 lands,
 * exactly like rpc/local-server.ts's OperationDispatcher port.
 * ------------------------------------------------------------------ */

export interface TxnContext {
  db: DatabaseSync
  ctx: AuthenticatedContext
}
export type OperationHandler = (txn: TxnContext, payload: unknown) => unknown | Promise<unknown>
export interface OperationSpec {
  name: string
  visibility: 'operator' | 'member' | 'service' | 'host'
  mutation: boolean
}
export interface OperationRegistrar {
  register(spec: OperationSpec, handler: OperationHandler): void
}

/** deps for this boundary — authorize is IMP-10's fixed signature */
export interface MaintenanceDeps extends ObserverDeps {
  authorize: AuthorizeFn
  /** optional makeCaller product for cross-domain calls when wired */
  call?: (
    operation: string,
    payload?: unknown,
    expectedRevisions?: Record<string, number>
  ) => Promise<unknown>
}

/* ------------------------------------------------------------------ *
 * wire view of a candidate (spec object shape, camelCase per SHARED-APIS)
 * ------------------------------------------------------------------ */

export interface ImpactCandidateView {
  id: string
  changeRef: string
  targetKind: ImpactTargetKind
  targetId: string
  state: ImpactCandidateState
  revision: number
  reason: ImpactReason
  resolution: CandidateResolution
}

function viewOf(row: ImpactCandidateRow): ImpactCandidateView {
  return {
    id: row.id,
    changeRef: row.changeRef,
    targetKind: row.targetKind,
    targetId: row.targetId,
    state: row.state,
    revision: row.revision,
    reason: row.reason,
    resolution: row.resolution
  }
}

/* ------------------------------------------------------------------ *
 * model.impact.list
 * ------------------------------------------------------------------ */

const IMPACT_STATES: readonly ImpactCandidateState[] = [
  'candidate',
  'confirmed',
  'dismissed',
  'resolved'
]

export interface ImpactListQuery {
  projectId: string
  status?: ImpactCandidateState
  roleId?: string
  cursor?: string
  limit?: number
}

const DEFAULT_PAGE = 50
const MAX_PAGE = 200

/** cursor = base64url({v,p,s,r,k:lastRowid}) — bound to its filter set */
function encodeCursor(q: ImpactListQuery, lastRowid: number): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      p: q.projectId,
      s: q.status ?? null,
      r: q.roleId ?? null,
      k: lastRowid
    }),
    'utf8'
  ).toString('base64url')
}

function decodeCursor(q: ImpactListQuery, raw: string): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    fail('STALE_REVISION', 'impact cursor is not readable — re-issue the query without a cursor')
  }
  const c = parsed as Record<string, unknown>
  if (
    typeof c !== 'object' ||
    c === null ||
    c.v !== 1 ||
    c.p !== q.projectId ||
    (c.s ?? null) !== (q.status ?? null) ||
    (c.r ?? null) !== (q.roleId ?? null) ||
    typeof c.k !== 'number'
  ) {
    fail('STALE_REVISION', 'impact cursor does not match this query — re-issue without a cursor')
  }
  return c.k as number
}

/**
 * Candidates for a project, newest-last by insertion order. roleId matches
 * the affected role OR the designated maintainer role recorded in the
 * reason scope (the "해당 책임자" view).
 */
export function listImpactCandidates(
  db: DatabaseSync,
  q: ImpactListQuery
): QueryResult<ImpactCandidateView> {
  const afterRowid = q.cursor === undefined ? 0 : decodeCursor(q, q.cursor)
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_PAGE, 1), MAX_PAGE)

  const rows = db
    .prepare(
      `SELECT rowid AS rid, * FROM impact_candidates
       WHERE json_extract(reason_json, '$.scope.projectId') = ?
         AND (? IS NULL OR state = ?)
         AND (? IS NULL OR rowid > ?)
         AND (
           ? IS NULL
           OR json_extract(reason_json, '$.scope.roleId') = ?
           OR json_extract(reason_json, '$.scope.maintainerRoleId') = ?
           OR (target_kind = 'role' AND target_id = ?)
         )
       ORDER BY rowid ASC
       LIMIT ?`
    )
    .all(
      q.projectId,
      q.status ?? null,
      q.status ?? null,
      q.cursor === undefined ? null : 1,
      afterRowid,
      q.roleId ?? null,
      q.roleId ?? null,
      q.roleId ?? null,
      q.roleId ?? null,
      limit + 1
    ) as Record<string, unknown>[]

  const hasMore = rows.length > limit
  const page = rows.slice(0, limit).map(rowToCandidate)
  const last = page[page.length - 1]

  let snapshotRevision = 0
  try {
    const s = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS s FROM domain_events').get() as
      { s: number } | undefined
    snapshotRevision = Number(s?.s ?? 0)
  } catch {
    snapshotRevision = 0 // projection marker only — absence of the outbox is not a verdict
  }

  return {
    snapshotRevision,
    items: page.map(viewOf),
    ...(hasMore && last !== undefined ? { nextCursor: encodeCursor(q, last.rowid) } : {}),
    visibility: {
      filter: { projectId: q.projectId, status: q.status ?? null, roleId: q.roleId ?? null }
    }
  }
}

/* ------------------------------------------------------------------ *
 * unreviewedStaleCandidates — the NEW-launch staleness policy input
 * ------------------------------------------------------------------ */

export interface StaleGateQuery {
  interfaceDigest?: string
  implementationId?: string
  roleId?: string
  /** when true, only reasons touching required (initial) coverage count */
  requiredOnly?: boolean
}

/**
 * Candidates still awaiting judgment (state 'candidate' or 'confirmed')
 * against an interface / implementation / role. context.build and the
 * launch path use this to apply the stale policy to NEW launches
 * (role-realization §5: unreviewed required items may block a launch);
 * existing executions keep their pinned bundle untouched.
 */
export function unreviewedStaleCandidates(
  db: DatabaseSync,
  q: StaleGateQuery
): ImpactCandidateView[] {
  const clauses: string[] = ["state IN ('candidate','confirmed')"]
  const args: (string | number)[] = []
  const targetClauses: string[] = []
  if (q.interfaceDigest !== undefined) {
    targetClauses.push(`(target_kind = 'interface' AND target_id = ?)`)
    args.push(q.interfaceDigest)
  }
  if (q.implementationId !== undefined) {
    targetClauses.push(`(target_kind = 'implementation' AND target_id = ?)`)
    args.push(q.implementationId)
  }
  if (q.roleId !== undefined) {
    targetClauses.push(
      `((target_kind = 'role' AND target_id = ?) OR json_extract(reason_json, '$.scope.roleId') = ?)`
    )
    args.push(q.roleId, q.roleId)
  }
  if (targetClauses.length === 0) return []
  clauses.push(`(${targetClauses.join(' OR ')})`)
  if (q.requiredOnly === true) {
    clauses.push(`json_extract(reason_json, '$.required') = 1`)
  }
  const rows = db
    .prepare(
      `SELECT rowid AS rid, * FROM impact_candidates WHERE ${clauses.join(' AND ')} ORDER BY rowid ASC`
    )
    .all(...args) as Record<string, unknown>[]
  return rows.map(rowToCandidate).map(viewOf)
}

/* ------------------------------------------------------------------ *
 * payload parsing (strict shapes, MODEL_INVALID on violation)
 * ------------------------------------------------------------------ */

function asObject(v: unknown, op: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    fail('MODEL_INVALID', `${op} payload must be an object`)
  }
  return v as Record<string, unknown>
}

function reqString(o: Record<string, unknown>, key: string, op: string): string {
  const v = o[key]
  if (typeof v !== 'string' || v.length === 0)
    fail('MODEL_INVALID', `${op}.${key} must be a non-empty string`)
  return v
}

function optString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function parseListPayload(payload: unknown): ImpactListQuery {
  const o = asObject(payload, 'model.impact.list')
  const projectId = reqString(o, 'projectId', 'model.impact.list')
  const status = optString(o, 'status')
  if (status !== undefined && !(IMPACT_STATES as readonly string[]).includes(status)) {
    fail('MODEL_INVALID', `model.impact.list.status must be one of ${IMPACT_STATES.join('|')}`)
  }
  const limitRaw = o.limit
  const limit =
    limitRaw === undefined
      ? undefined
      : typeof limitRaw === 'number' && Number.isInteger(limitRaw) && limitRaw > 0
        ? limitRaw
        : (() => {
            fail('MODEL_INVALID', 'model.impact.list.limit must be a positive integer')
          })()
  return {
    projectId,
    status: status as ImpactCandidateState | undefined,
    roleId: optString(o, 'roleId'),
    cursor: optString(o, 'cursor'),
    limit
  }
}

function parseClassifyPayload(payload: unknown): {
  candidateId: string
  expectedRevision: number
  decision: ClassifyDecision
  rationale: string
  resolutionRef?: unknown
} {
  const o = asObject(payload, 'model.impact.classify')
  const candidateId = reqString(o, 'candidateId', 'model.impact.classify')
  const rationale = reqString(o, 'rationale', 'model.impact.classify')
  const decision = o.decision
  if (decision !== 'confirmed' && decision !== 'dismissed' && decision !== 'resolved') {
    fail('MODEL_INVALID', 'model.impact.classify.decision must be confirmed|dismissed|resolved')
  }
  const rev = o.expectedRevision
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1) {
    fail('MODEL_INVALID', 'model.impact.classify.expectedRevision must be a positive integer')
  }
  return {
    candidateId,
    expectedRevision: rev,
    decision,
    rationale,
    resolutionRef: o.resolutionRef
  }
}

/* ------------------------------------------------------------------ *
 * registration — the two owned operations
 * ------------------------------------------------------------------ */

export function registerMaintenanceOps(registry: OperationRegistrar, deps: MaintenanceDeps): void {
  registry.register(
    { name: 'model.impact.list', visibility: 'member', mutation: false },
    (txn, payload) => {
      const q = parseListPayload(payload)
      deps.authorize(txn.ctx, 'model.impact.list', [{ kind: 'project', id: q.projectId }])
      return listImpactCandidates(txn.db, q)
    }
  )
  registry.register(
    { name: 'model.impact.classify', visibility: 'member', mutation: true },
    (txn, payload) => classifyCandidate(txn.db, txn.ctx, parseClassifyPayload(payload), deps)
  )
}
