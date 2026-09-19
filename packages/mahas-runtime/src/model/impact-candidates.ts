// mahas-runtime — model/discovery: change-impact candidate computation
// (IMP-05; REQ-21, spec/domains/rdd.md §2/§4, spec/storage.md §3
// impact_candidates, C-MODEL model.change.commit / model.impact.*).
//
// The port diffs a before/after model pair and writes STALE-REVIEW
// CANDIDATES — it never asserts real semantic impact (instruction §4.5):
//   - parent responsibility change  -> direct children's re-translation
//   - contract change               -> union of before/after consumers
//                                     (+ provider endpoint when it moved
//                                     or the contract came/went)
//   - horizontal context change     -> roles referencing that horizontalRole
//
// Candidates are written inside the SAME publication transaction that
// publishes the new model (storage.md §5) via deterministic ids, so a
// replayed commit inserts nothing twice. Classification and any follow-up
// Task issuance belong to IMP-27 — this file only persists the primitive
// state transition it needs.

import type { DatabaseSync } from 'node:sqlite'
import type {
  Id,
  ModelVersionId,
  Revision,
  MahasError,
  ErrorCode
} from '../../../mahas-contracts/src/common.ts'
import type { BoundaryId, ImpactCandidateId, RoleId } from '../../../mahas-contracts/src/ids.ts'
import type { ImpactCandidate } from '../../../mahas-contracts/src/observation.ts'
import { sha256Hex } from '../storage/db.ts'
import { loadContainsTree, subtreeBoundaryIds } from './territory.ts'

function fail(code: ErrorCode, message: string, details?: unknown): never {
  const error: MahasError & Error = Object.assign(new Error(message), {
    code,
    retry: 'none' as const,
    details
  })
  throw error
}

const mv = (v: ModelVersionId): string => v as string

function all<T>(db: DatabaseSync, sql: string, ...params: (string | number)[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[]
}

/* ------------------------------------------------------------------ *
 * candidate persistence primitives
 * ------------------------------------------------------------------ */

export type ImpactTargetKind = 'role' | 'boundary'

export type ImpactReasonKind =
  | 'parent-responsibility'
  | 'reparented'
  | 'contract'
  | 'horizontal-context'
  | 'implementation-revision'

export interface ImpactReason {
  kind: ImpactReasonKind
  /** reason-specific evidence refs (before/after ids, contract, context…) */
  details: Record<string, unknown>[]
  /**
   * F-059: denormalized read scope for the list surface
   * (maintenance/impact-service.ts filters on `scope.projectId`).
   * Absent on legacy rows — the reader falls back to the candidate's own
   * columns instead of dropping them.
   */
  scope?: { projectId: string }
}

export type ImpactCandidateState = 'open' | 'confirmed' | 'dismissed' | 'resolved'

interface ImpactCandidateRow {
  id: string
  change_ref: string
  target_kind: string
  target_id: string
  state: string
  revision: number
  reason_json: string
  resolution_json: string
}

const toCandidate = (r: ImpactCandidateRow): ImpactCandidate =>
  ({
    id: r.id,
    changeRef: r.change_ref,
    targetKind: r.target_kind,
    targetId: r.target_id,
    state: r.state,
    revision: r.revision,
    reason: JSON.parse(r.reason_json),
    resolution: JSON.parse(r.resolution_json)
  }) as ImpactCandidate

/**
 * Deterministic candidate identity: the same (changeRef, target, reasonKind)
 * always yields the same id, so re-running the computation inside a replayed
 * publish transaction is a no-op (INSERT OR IGNORE).
 */
export function impactCandidateId(
  changeRef: string,
  targetKind: ImpactTargetKind,
  targetId: string,
  reasonKind: ImpactReasonKind
): ImpactCandidateId {
  return `ic_${sha256Hex([changeRef, targetKind, targetId, reasonKind].join('\x00')).slice(0, 24)}` as BoundaryId
}

export interface ImpactCandidateInsert {
  changeRef: string
  targetKind: ImpactTargetKind
  targetId: string
  reason: ImpactReason
}

/**
 * Low-level writer shared by the model-diff computation below AND by other
 * staleness producers (e.g. IMP-08 emitting 'implementation-revision'
 * candidates when a RoleImplementation revision lands). Must be called
 * inside the caller's write transaction.
 */
export function insertImpactCandidate(
  db: DatabaseSync,
  input: ImpactCandidateInsert
): ImpactCandidateId {
  const id = impactCandidateId(
    input.changeRef,
    input.targetKind,
    input.targetId as string,
    input.reason.kind
  )
  db.prepare(
    `INSERT OR IGNORE INTO impact_candidates
       (id, change_ref, target_kind, target_id, state, revision, reason_json, resolution_json)
     VALUES (?, ?, ?, ?, 'open', 1, ?, '{}')`
  ).run(
    id as string,
    input.changeRef,
    input.targetKind,
    input.targetId as string,
    JSON.stringify(input.reason)
  )
  return id
}

/* ------------------------------------------------------------------ *
 * scope-aware before/after model impact computation
 * ------------------------------------------------------------------ */

export interface ModelImpactInput {
  /** the published model the change was based on */
  baseVersion: ModelVersionId
  /** the model snapshot being published now */
  newVersion: ModelVersionId
  /**
   * batch identity for this candidate set — C-MODEL model.change.commit
   * returns it as impactBatchId. The changeId is the natural value.
   */
  changeRef: string
  /**
   * scope restriction: when given, candidates are emitted only for targets
   * inside the inclusive subtrees of these boundaries (e.g. the maintainer's
   * mandate scope). Absent = whole model.
   */
  scopeBoundaryIds?: BoundaryId[]
  /**
   * F-059: owning project for the `scope:{projectId}` reason envelope.
   * Optional for backward compat — when absent it is resolved inside the
   * transaction from `newVersion` (model_versions.project_id) then
   * `changeRef` (model_changes.project_id). Unresolvable → legacy shape
   * (no scope); the list reader includes scopeless rows rather than
   * dropping them.
   */
  projectId?: string
}

export interface ModelImpactResult {
  changeRef: string
  candidateIds: ImpactCandidateId[]
  counts: Record<ImpactReasonKind, number>
}

interface ContractDiff {
  name: string
  schemaPath: string
  providerBoundaryId: string
}

function loadBoundaryStatements(db: DatabaseSync, version: ModelVersionId): Map<string, string> {
  return new Map(
    all<{ id: string; responsibility_statement: string }>(
      db,
      'SELECT id, responsibility_statement FROM rdd_boundaries WHERE model_version = ?',
      mv(version)
    ).map((r) => [r.id, r.responsibility_statement])
  )
}

function loadContracts(db: DatabaseSync, version: ModelVersionId): Map<string, ContractDiff> {
  return new Map(
    all<{ id: string; name: string; schema_path: string; provider_boundary_id: string }>(
      db,
      'SELECT id, name, schema_path, provider_boundary_id FROM rdd_contracts WHERE model_version = ?',
      mv(version)
    ).map((r) => [
      r.id,
      { name: r.name, schemaPath: r.schema_path, providerBoundaryId: r.provider_boundary_id }
    ])
  )
}

function loadConsumers(db: DatabaseSync, version: ModelVersionId): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const r of all<{ contract_id: string; consumer_boundary_id: string }>(
    db,
    'SELECT contract_id, consumer_boundary_id FROM contract_consumers WHERE model_version = ?',
    mv(version)
  )) {
    const s = out.get(r.contract_id) ?? new Set<string>()
    s.add(r.consumer_boundary_id)
    out.set(r.contract_id, s)
  }
  return out
}

function loadHorizontalContexts(
  db: DatabaseSync,
  version: ModelVersionId
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const r of all<{ horizontal_role_name: string; context_id: string }>(
    db,
    'SELECT horizontal_role_name, context_id FROM horizontal_contexts WHERE model_version = ?',
    mv(version)
  )) {
    const s = out.get(r.horizontal_role_name) ?? new Set<string>()
    s.add(r.context_id)
    out.set(r.horizontal_role_name, s)
  }
  return out
}

function rolesOf(db: DatabaseSync, version: ModelVersionId, boundaryId: string): Id[] {
  return all<{ id: string }>(
    db,
    'SELECT id FROM rdd_roles WHERE model_version = ? AND boundary_id = ? ORDER BY id',
    mv(version),
    boundaryId
  ).map((r) => r.id as Id)
}

const setEq = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x))

/**
 * F-059: resolve the owning project for the reason scope envelope.
 * Never throws — scope resolution must not fail candidate computation;
 * unresolvable → undefined → legacy scopeless shape (the list reader
 * includes scopeless rows rather than dropping them).
 */
function projectOfModelVersion(db: DatabaseSync, version: string): string | undefined {
  try {
    const row = db.prepare('SELECT project_id FROM model_versions WHERE id = ?').get(version) as
      { project_id: string } | undefined
    return row?.project_id
  } catch {
    return undefined
  }
}

function projectOfChangeRef(db: DatabaseSync, changeRef: string): string | undefined {
  try {
    const row = db.prepare('SELECT project_id FROM model_changes WHERE id = ?').get(changeRef) as
      { project_id: string } | undefined
    return row?.project_id
  } catch {
    return undefined
  }
}

/**
 * Compute and store the stale-review candidates for publishing `newVersion`
 * over `baseVersion`. Returns the batch identity (impactBatchId) and the
 * candidate ids written. Pure candidate generation — semantic judgement
 * stays with the maintainer (REQ-21).
 */
export function computeModelImpact(db: DatabaseSync, input: ModelImpactInput): ModelImpactResult {
  const { baseVersion, newVersion, changeRef } = input

  // F-059: scope envelope for the list reader (impact-service.ts filters on
  // reason_json.scope.projectId). Explicit input wins, then the published
  // version's project, then the change row's project.
  const scopeProjectId =
    input.projectId ?? projectOfModelVersion(db, mv(newVersion)) ?? projectOfChangeRef(db, changeRef)
  const reasonScope = scopeProjectId === undefined ? undefined : { projectId: scopeProjectId }

  const baseStmts = loadBoundaryStatements(db, baseVersion)
  const newStmts = loadBoundaryStatements(db, newVersion)
  const baseTree = loadContainsTree(db, baseVersion)
  const newTree = loadContainsTree(db, newVersion)
  const baseContracts = loadContracts(db, baseVersion)
  const newContracts = loadContracts(db, newVersion)
  const baseConsumers = loadConsumers(db, baseVersion)
  const newConsumers = loadConsumers(db, newVersion)
  const baseHctx = loadHorizontalContexts(db, baseVersion)
  const newHctx = loadHorizontalContexts(db, newVersion)

  // scope: expand the given boundaries to their inclusive subtrees in the
  // NEW tree (the structure the candidates will live under).
  let scope: Set<string> | null = null
  if (input.scopeBoundaryIds !== undefined) {
    scope = new Set<string>()
    for (const b of input.scopeBoundaryIds) {
      for (const x of subtreeBoundaryIds(newTree, b as string)) scope.add(x)
    }
  }
  const inScope = (boundaryId: string): boolean => scope === null || scope.has(boundaryId)

  // collect candidates as (targetBoundary, reasonKind, detail)
  const pending: {
    boundaryId: string
    reasonKind: ImpactReasonKind
    detail: Record<string, unknown>
  }[] = []
  const push = (
    boundaryId: string,
    reasonKind: ImpactReasonKind,
    detail: Record<string, unknown>
  ): void => {
    if (inScope(boundaryId)) pending.push({ boundaryId, reasonKind, detail })
  }

  // (a) parent responsibility changed -> each direct child re-translation
  for (const [boundaryId, newStmt] of newStmts) {
    const baseStmt = baseStmts.get(boundaryId)
    if (baseStmt === undefined || baseStmt === newStmt) continue
    for (const child of newTree.childrenOf.get(boundaryId) ?? []) {
      push(child, 'parent-responsibility', {
        parentBoundaryId: boundaryId,
        baseVersion: mv(baseVersion),
        newVersion: mv(newVersion)
      })
    }
  }

  // (b) reparented boundary -> its translation source itself changed
  for (const boundaryId of newStmts.keys()) {
    if (!baseStmts.has(boundaryId)) continue
    const baseParent = baseTree.parentOf.get(boundaryId) ?? null
    const newParent = newTree.parentOf.get(boundaryId) ?? null
    if (baseParent !== newParent) {
      push(boundaryId, 'reparented', { baseParentId: baseParent, newParentId: newParent })
    }
  }

  // (c) contract changed -> union of before/after consumers; provider
  //     endpoint joins when it moved or the contract was added/removed.
  const contractIds = new Set([...baseContracts.keys(), ...newContracts.keys()])
  for (const contractId of contractIds) {
    const before = baseContracts.get(contractId)
    const after = newContracts.get(contractId)
    const beforeConsumers = baseConsumers.get(contractId) ?? new Set<string>()
    const afterConsumers = newConsumers.get(contractId) ?? new Set<string>()
    const providerMoved =
      before !== undefined &&
      after !== undefined &&
      before.providerBoundaryId !== after.providerBoundaryId
    const fieldsChanged =
      before !== undefined &&
      after !== undefined &&
      (before.name !== after.name ||
        before.schemaPath !== after.schemaPath ||
        before.providerBoundaryId !== after.providerBoundaryId)
    const consumersChanged = !setEq(beforeConsumers, afterConsumers)
    const added = before === undefined
    const removed = after === undefined
    if (!added && !removed && !fieldsChanged && !consumersChanged) continue

    const change = added
      ? 'added'
      : removed
        ? 'removed'
        : providerMoved
          ? 'provider-changed'
          : 'revised'
    const affected = new Set([...beforeConsumers, ...afterConsumers])
    if (removed || added || providerMoved) {
      if (before !== undefined) affected.add(before.providerBoundaryId)
      if (after !== undefined) affected.add(after.providerBoundaryId)
    }
    for (const boundaryId of affected) {
      if (!newStmts.has(boundaryId)) continue // target must exist in the new model
      push(boundaryId, 'contract', {
        contractId,
        change,
        consumerBefore: beforeConsumers.has(boundaryId),
        consumerAfter: afterConsumers.has(boundaryId),
        provider:
          before?.providerBoundaryId === boundaryId || after?.providerBoundaryId === boundaryId
      })
    }
  }

  // (d) horizontal context links changed -> roles referencing the horizontal
  const hrNames = new Set([...baseHctx.keys(), ...newHctx.keys()])
  for (const hr of hrNames) {
    const before = baseHctx.get(hr) ?? new Set<string>()
    const after = newHctx.get(hr) ?? new Set<string>()
    if (setEq(before, after)) continue
    const added = [...after].filter((x) => !before.has(x))
    const removed = [...before].filter((x) => !after.has(x))
    for (const r of all<{ id: string; boundary_id: string }>(
      db,
      'SELECT id, boundary_id FROM rdd_roles WHERE model_version = ? AND horizontal_role_name = ?',
      mv(newVersion),
      hr
    )) {
      push(r.boundary_id, 'horizontal-context', {
        horizontalRoleName: hr,
        roleId: r.id,
        addedContextIds: added,
        removedContextIds: removed
      })
    }
  }

  // -- emit: one candidate per (target, reasonKind); role targets when the
  //    boundary has owners, a boundary target when it is unassigned so the
  //    staleness is never silently dropped.
  const grouped = new Map<
    string,
    { boundaryId: string; reasonKind: ImpactReasonKind; details: Record<string, unknown>[] }
  >()
  for (const p of pending) {
    const key = p.boundaryId + '\x00' + p.reasonKind
    const g = grouped.get(key) ?? {
      boundaryId: p.boundaryId,
      reasonKind: p.reasonKind,
      details: []
    }
    g.details.push(p.detail)
    grouped.set(key, g)
  }

  const candidateIds: ImpactCandidateId[] = []
  const counts: Record<ImpactReasonKind, number> = {
    'parent-responsibility': 0,
    reparented: 0,
    contract: 0,
    'horizontal-context': 0,
    'implementation-revision': 0
  }
  const emitted = new Set<string>()
  for (const g of grouped.values()) {
    const roles = rolesOf(db, newVersion, g.boundaryId)
    const targets: { kind: ImpactTargetKind; id: Id }[] =
      roles.length > 0
        ? roles.map((id) => ({ kind: 'role' as const, id }))
        : [{ kind: 'boundary', id: g.boundaryId as Id }]
    for (const t of targets) {
      const dedupKey = t.kind + '\x00' + t.id + '\x00' + g.reasonKind
      if (emitted.has(dedupKey)) continue
      emitted.add(dedupKey)
      const id = insertImpactCandidate(db, {
        changeRef,
        targetKind: t.kind,
        targetId: t.id,
        reason:
          reasonScope === undefined
            ? { kind: g.reasonKind, details: g.details }
            : { kind: g.reasonKind, details: g.details, scope: reasonScope }
      })
      candidateIds.push(id)
      counts[g.reasonKind] += 1
    }
  }

  return { changeRef, candidateIds, counts }
}

/* ------------------------------------------------------------------ *
 * candidate reads + the decision primitive IMP-27 wraps with
 * authorization/receipt (C-MODEL model.impact.list / .classify)
 * ------------------------------------------------------------------ */

export interface ImpactListFilter {
  changeRef?: string
  state?: ImpactCandidateState
  /** filters target_kind='role' rows by role id AND boundary rows by their
   *  owning boundary's roles (join, never bare id guessing) */
  roleId?: RoleId
  boundaryId?: BoundaryId
  limit?: number
  cursor?: string
}

export interface ImpactListResult {
  items: ImpactCandidate[]
  nextCursor?: string
}

interface ImpactCursor {
  qd: string
  off: number
}

const impactDigest = (f: ImpactListFilter): string =>
  sha256Hex(
    JSON.stringify({
      c: f.changeRef ?? null,
      s: f.state ?? null,
      r: f.roleId ?? null,
      b: f.boundaryId ?? null
    })
  )

export function listImpactCandidates(
  db: DatabaseSync,
  filter: ImpactListFilter = {}
): ImpactListResult {
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (filter.changeRef !== undefined) {
    clauses.push('ic.change_ref = ?')
    params.push(filter.changeRef)
  }
  if (filter.state !== undefined) {
    clauses.push('ic.state = ?')
    params.push(filter.state)
  }
  if (filter.roleId !== undefined) {
    clauses.push(`(ic.target_kind = 'role' AND ic.target_id = ?)`)
    params.push(filter.roleId as string)
  }
  if (filter.boundaryId !== undefined) {
    clauses.push(`(
      (ic.target_kind = 'boundary' AND ic.target_id = ?) OR
      (ic.target_kind = 'role' AND EXISTS (
        SELECT 1 FROM rdd_roles rr
        WHERE rr.id = ic.target_id AND rr.boundary_id = ?
      ))
    )`)
    params.push(filter.boundaryId as string, filter.boundaryId as string)
  }
  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`

  let offset = 0
  if (filter.cursor !== undefined) {
    try {
      const c = JSON.parse(Buffer.from(filter.cursor, 'base64url').toString('utf8')) as ImpactCursor
      if (c.qd === impactDigest(filter) && typeof c.off === 'number') offset = c.off
    } catch {
      fail('SNAPSHOT_REQUIRED', 'impact cursor is not decodable; re-query explicitly')
    }
  }

  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100)
  const rows = all<ImpactCandidateRow>(
    db,
    `SELECT ic.* FROM impact_candidates ic ${where} ORDER BY ic.id LIMIT ? OFFSET ?`,
    ...params,
    limit + 1,
    offset
  )
  const page = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit
      ? Buffer.from(
          JSON.stringify({ qd: impactDigest(filter), off: offset + limit }),
          'utf8'
        ).toString('base64url')
      : undefined
  return { items: page.map(toCandidate), nextCursor }
}

export function getImpactCandidate(
  db: DatabaseSync,
  candidateId: ImpactCandidateId
): ImpactCandidate | null {
  const rows = all<ImpactCandidateRow>(
    db,
    'SELECT * FROM impact_candidates WHERE id = ?',
    candidateId as string
  )
  return rows.length === 0 ? null : toCandidate(rows[0]!)
}

export interface ImpactDecisionInput {
  candidateId: ImpactCandidateId
  expectedRevision: Revision | number
  decision: 'confirmed' | 'dismissed' | 'resolved'
  rationale: string
  resolutionRef?: string
  decidedAt?: number
}

/**
 * Persistence primitive for model.impact.classify — revision-checked state
 * transition on my table. IMP-27 owns the authorization/receipt wrapper;
 * unconfirmed meaning is never auto-resolved here ('open' -> decision only).
 */
export function applyImpactDecision(db: DatabaseSync, input: ImpactDecisionInput): ImpactCandidate {
  const rows = all<ImpactCandidateRow>(
    db,
    'SELECT * FROM impact_candidates WHERE id = ?',
    input.candidateId as string
  )
  if (rows.length === 0) fail('MODEL_INVALID', `no impact candidate ${input.candidateId}`)
  const row = rows[0]!
  if (row.revision !== input.expectedRevision) {
    fail('STALE_REVISION', `impact candidate ${input.candidateId} is at revision ${row.revision}`, {
      expectedRevision: input.expectedRevision,
      actualRevision: row.revision
    })
  }
  if (row.state !== 'open') {
    fail('INVALID_TRANSITION', `impact candidate ${input.candidateId} is already ${row.state}`)
  }
  const resolution = {
    decision: input.decision,
    rationale: input.rationale,
    resolutionRef: input.resolutionRef ?? null,
    decidedAt: input.decidedAt ?? Date.now()
  }
  db.prepare(
    `UPDATE impact_candidates
     SET state = ?, revision = revision + 1, resolution_json = ?
     WHERE id = ? AND revision = ?`
  ).run(input.decision, JSON.stringify(resolution), input.candidateId as string, row.revision)
  return getImpactCandidate(db, input.candidateId)!
}
