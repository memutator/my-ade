// mahas-runtime — maintenance/basis-observer (IMP-27).
//
// The DETECTION half of the model/realization maintenance flow
// (spec/domains/resources-observation.md §3 ImpactCandidate, §6 유지관리 이벤트;
// spec/domains/role-realization.md §5; spec/domains/rdd.md §3).
//
// When a parent responsibility, contract, boundary/horizontal context, context
// source snapshot or role implementation changes, this module derives the
// change basis (before/after refs) and records `impact_candidates` rows in
// state 'candidate'. It NEVER:
//   - decides semantic impact (candidate ≠ confirmed — D-RESOURCE §3:
//     "의미 영향 자동 확정 안 함");
//   - refreshes instruction content (refresh is a separate responsible-party
//     task — REQ-21; classification.ts only records the judgment);
//   - rewrites running bundles — a bundle pinned by an active execution is
//     never re-resolved here (REQ-21).
//
// The candidate computation is scope-aware: contract changes use the UNION of
// before/after consumers (D-RESOURCE §6 — a consumer that disappeared must not
// drop out of notification), parent changes reach direct children plus the
// parent's own composition view, horizontal context changes reach every role
// implementation that references them, and implementation coverage /
// maintenance_bindings carry the realization-side staleness paths.
//
// Entry points are plain functions taking `db` so they can run INSIDE the
// publishing transaction (model.change.commit records ModelPublished + the
// stale-candidate intent in one atomic unit — rdd.md §3) or standalone
// (withTx wrapping when not already in a transaction). IMP-30 wires them as
// hooks; applyDomainEvent() additionally lets an outbox pump feed them.
//
// IMP-05 (model/discovery) promises a "scope-aware before/after impact
// 계산 포트"; when the composition root injects it as
// deps.computeModelImpactCandidates its structural targets are merged with
// the realization-side derivation owned here (maintenance_bindings,
// implementation coverage, interface drift) — deduped by
// (targetKind, targetId, reason.kind).

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { inTransaction, withTx } from '../storage/transaction.ts'
import type { ErrorCode, ErrorRetry, MahasError } from '../../../mahas-contracts/src/common.ts'

/* ------------------------------------------------------------------ *
 * shared error + row codec (the other maintenance modules import these)
 * ------------------------------------------------------------------ */

/** domain verdict thrown by maintenance code — MahasError-shaped on the wire */
export class MaintenanceError extends Error {
  readonly code: ErrorCode
  readonly retry: ErrorRetry
  readonly details?: unknown

  constructor(
    code: ErrorCode,
    message: string,
    options?: { retry?: ErrorRetry; details?: unknown }
  ) {
    super(message)
    this.name = 'MaintenanceError'
    this.code = code
    this.retry = options?.retry ?? 'none'
    this.details = options?.details
  }

  toMahasError(): MahasError {
    return { code: this.code, message: this.message, retry: this.retry, details: this.details }
  }
}

export function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new MaintenanceError(code, message, { details })
}

/* ------------------------------------------------------------------ *
 * candidate shapes (row codec follows spec/storage.md §3 DDL field names
 * converted to camelCase — SHARED-APIS convention)
 * ------------------------------------------------------------------ */

export type ImpactTargetKind = 'boundary' | 'role' | 'interface' | 'implementation'
export type ImpactCandidateState = 'candidate' | 'confirmed' | 'dismissed' | 'resolved'

export type ImpactReasonKind =
  | 'parent-responsibility' // parent statement/name changed -> direct-child re-translation
  | 'parent-composition' // child set changed -> parent's composition view re-review
  | 'boundary-moved' // reparented subtree root
  | 'contract-consumer' // contract row or consumer-set changed (before ∪ after)
  | 'boundary-context' // boundary<->context link added/removed
  | 'horizontal-context' // horizontal-role<->context link added/removed
  | 'context-redirect' // rdd_contexts.path changed for a linked context
  | 'context-source' // stored source bytes digest changed (hash ≠ semantic verdict)
  | 'role-structure' // role definition added/removed/edited
  | 'horizontal-role' // horizontal role added/removed/revised
  | 'interface-digest' // role's current interface digest != implementation's pinned digest
  | 'implementation-basis' // an implementation this impl bases on changed
  | 'implementation-retired' // an implementation this impl bases on was retired
  | 'reported-effect' // problem reported through an outcome's contractEffects

/** denormalized read scope stored inside reason_json for query filters */
export interface ImpactScope {
  projectId?: string
  modelVersion?: string
  roleId?: string
  boundaryId?: string
  maintainerRoleId?: string
}

export interface ImpactReason {
  kind: ImpactReasonKind
  summary: string
  /** versioned ref to the prior state (null when the target is new) */
  beforeRef?: unknown
  /** versioned ref to the new state (null when the basis was removed) */
  afterRef?: unknown
  /**
   * true  — the reason touches a required (initial-delivery) coverage clause;
   * false — provably conditional-only;
   * null/absent — undetermined; the launch policy decides how to treat it.
   */
  required?: boolean | null
  scope: ImpactScope
  detectedAt: number
}

/** one candidate to persist — produced by basis derivation */
export interface CandidateDraft {
  targetKind: ImpactTargetKind
  targetId: string
  reason: Omit<ImpactReason, 'detectedAt'>
}

export interface CandidateResolution {
  decision?: ImpactCandidateState
  rationale?: string
  decidedBy?: { principalId: string; memberId?: string }
  decidedAt?: number
  resolutionRef?: unknown
  links?: MaintenanceLink[]
}

export interface MaintenanceLink {
  kind: string
  id: string
  revision?: number
  linkedBy: string
  linkedAt: number
  note?: string
}

export interface ImpactCandidateRow {
  id: string
  changeRef: string
  targetKind: ImpactTargetKind
  targetId: string
  state: ImpactCandidateState
  revision: number
  reason: ImpactReason
  resolution: CandidateResolution
  rowid: number
}

function parseJsonColumn(raw: unknown, fallback: unknown): unknown {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function rowToCandidate(r: Record<string, unknown>): ImpactCandidateRow {
  const reason = parseJsonColumn(r.reason_json, {}) as ImpactReason
  const resolution = parseJsonColumn(r.resolution_json, {}) as CandidateResolution
  return {
    id: String(r.id),
    changeRef: String(r.change_ref),
    targetKind: String(r.target_kind) as ImpactTargetKind,
    targetId: String(r.target_id),
    state: String(r.state) as ImpactCandidateState,
    revision: Number(r.revision),
    reason: typeof reason === 'object' && reason !== null ? reason : ({} as ImpactReason),
    resolution:
      typeof resolution === 'object' && resolution !== null
        ? resolution
        : ({} as CandidateResolution),
    rowid: Number(r.rid ?? r.rowid)
  }
}

export function loadCandidate(db: DatabaseSync, id: string): ImpactCandidateRow | null {
  const row = db.prepare('SELECT rowid AS rid, * FROM impact_candidates WHERE id = ?').get(id) as
    Record<string, unknown> | undefined
  return row === undefined ? null : rowToCandidate(row)
}

/* ------------------------------------------------------------------ *
 * basis changes — the normalized "what actually changed" input to
 * target derivation. Produced by diffing model snapshots (robust to the
 * exact TypedModelEdit payload shape, which IMP-04 owns) or supplied
 * directly by the observation entry points.
 * ------------------------------------------------------------------ */

export type BasisChange =
  | {
      kind: 'responsibility'
      modelVersion: string
      boundaryId: string
      beforeRef: unknown
      afterRef: unknown
    }
  | {
      kind: 'composition'
      modelVersion: string
      boundaryId: string
      beforeRef: unknown
      afterRef: unknown
    }
  | {
      kind: 'boundary-moved'
      modelVersion: string
      boundaryId: string
      beforeParentId?: string
      afterParentId?: string
    }
  | {
      kind: 'contract'
      modelVersion: string
      baseModelVersion?: string
      contractId: string
      beforeRef: unknown
      afterRef: unknown
    }
  | {
      kind: 'boundary-context'
      modelVersion: string
      boundaryId: string
      contextId: string
      linkChange: 'linked' | 'unlinked'
    }
  | {
      kind: 'horizontal-context'
      modelVersion: string
      horizontalRoleName: string
      contextId: string
      linkChange: 'linked' | 'unlinked'
    }
  | {
      kind: 'context-redirect'
      modelVersion: string
      contextId: string
      beforePath?: string
      afterPath?: string
    }
  | {
      kind: 'context-source'
      modelVersion: string
      contextId: string
      path?: string
      beforeDigest?: string
      afterDigest?: string
    }
  | { kind: 'role'; modelVersion: string; roleId: string; beforeRef: unknown; afterRef: unknown }
  | { kind: 'horizontal-role'; modelVersion: string; horizontalRoleName: string }
  | {
      kind: 'interface-drift'
      modelVersion: string
      implementationId: string
      implementationRevision: number
      roleId?: string
      maintainerRoleId?: string
      beforeDigest?: string
      afterDigest?: string
    }
  | {
      kind: 'implementation'
      implementationId: string
      revision: number
      change: 'published' | 'retired'
      interfaceDigest?: string
      maintainerRoleId?: string
      modelVersion?: string
    }
  | {
      kind: 'reported-effect'
      modelVersion?: string
      contractId: string
      outcomeRef: { id: string; revision: number }
      reportedByMemberId?: string
      runId?: string
    }

/** IMP-05's promised impact-computation port (wired by the composition root) */
export type ModelImpactComputation = (
  db: DatabaseSync,
  basis: readonly BasisChange[],
  versions: { baseModelVersion?: string; modelVersion: string }
) => readonly CandidateDraft[]

export interface ObserverDeps {
  /** IMP-05 port — merged into model-publication/context derivations when wired */
  computeModelImpactCandidates?: ModelImpactComputation
  now?: () => number
  idgen?: () => string
}

const now = (deps: ObserverDeps): number => (deps.now ?? Date.now)()
const newId = (deps: ObserverDeps): string => (deps.idgen ?? (() => `ic_${randomUUID()}`))()

/* ------------------------------------------------------------------ *
 * diffModelVersions — derive the basis set by comparing the base and the
 * freshly published snapshot. Using the snapshot diff (not the edit list)
 * keeps the before/after relation authoritative: a consumer that was
 * REMOVED still appears in `beforeRef` and gets its candidate
 * (D-RESOURCE §6).
 * ------------------------------------------------------------------ */

interface BoundaryRow {
  id: string
  name: string
  responsibility_statement: string
}
interface ContractRow {
  id: string
  name: string
  schema_path: string
  provider_boundary_id: string
}
interface RoleRow {
  id: string
  name: string
  description: string
  boundary_id: string
  horizontal_role_name: string
}

function rows<T>(db: DatabaseSync, sql: string, ...args: (string | number)[]): T[] {
  return db.prepare(sql).all(...args) as unknown as T[]
}

export function diffModelVersions(
  db: DatabaseSync,
  baseModelVersion: string,
  modelVersion: string
): BasisChange[] {
  const basis: BasisChange[] = []

  // -- boundaries: statement/name changes + membership deltas -------------
  const bBase = new Map(
    rows<BoundaryRow>(
      db,
      'SELECT id, name, responsibility_statement FROM rdd_boundaries WHERE model_version = ?',
      baseModelVersion
    ).map((r) => [r.id, r])
  )
  const bNext = new Map(
    rows<BoundaryRow>(
      db,
      'SELECT id, name, responsibility_statement FROM rdd_boundaries WHERE model_version = ?',
      modelVersion
    ).map((r) => [r.id, r])
  )
  for (const [id, after] of bNext) {
    const before = bBase.get(id)
    if (before === undefined) continue // newly added boundary — nothing to stalify
    if (
      before.responsibility_statement !== after.responsibility_statement ||
      before.name !== after.name
    ) {
      basis.push({
        kind: 'responsibility',
        modelVersion,
        boundaryId: id,
        beforeRef: {
          modelVersion: baseModelVersion,
          name: before.name,
          responsibilityStatement: before.responsibility_statement
        },
        afterRef: {
          modelVersion,
          name: after.name,
          responsibilityStatement: after.responsibility_statement
        }
      })
    }
  }

  // -- edges: reparents + child-set composition changes -------------------
  const eBase = new Map(
    rows<{ child_id: string; parent_id: string }>(
      db,
      'SELECT child_id, parent_id FROM boundary_edges WHERE model_version = ?',
      baseModelVersion
    ).map((r) => [r.child_id, r.parent_id])
  )
  const eNext = new Map(
    rows<{ child_id: string; parent_id: string }>(
      db,
      'SELECT child_id, parent_id FROM boundary_edges WHERE model_version = ?',
      modelVersion
    ).map((r) => [r.child_id, r.parent_id])
  )
  const compositionChanged = new Set<string>()
  for (const [child, parent] of eNext) {
    const before = eBase.get(child)
    if (before === undefined) {
      compositionChanged.add(parent) // new child joins the composition
    } else if (before !== parent) {
      basis.push({
        kind: 'boundary-moved',
        modelVersion,
        boundaryId: child,
        beforeParentId: before,
        afterParentId: parent
      })
      compositionChanged.add(before)
      compositionChanged.add(parent)
    }
  }
  for (const [child, parent] of eBase) {
    if (!eNext.has(child)) compositionChanged.add(parent) // child left the composition
  }
  for (const boundaryId of compositionChanged) {
    if (!bNext.has(boundaryId)) continue // parent itself retired — covered by role/interface drift
    basis.push({
      kind: 'composition',
      modelVersion,
      boundaryId,
      beforeRef: { modelVersion: baseModelVersion },
      afterRef: { modelVersion }
    })
  }

  // -- contracts: row diffs ∪ consumer-set diffs (before ∪ after) ---------
  const cBase = new Map(
    rows<ContractRow>(
      db,
      'SELECT id, name, schema_path, provider_boundary_id FROM rdd_contracts WHERE model_version = ?',
      baseModelVersion
    ).map((r) => [r.id, r])
  )
  const cNext = new Map(
    rows<ContractRow>(
      db,
      'SELECT id, name, schema_path, provider_boundary_id FROM rdd_contracts WHERE model_version = ?',
      modelVersion
    ).map((r) => [r.id, r])
  )
  const consumersOf = (v: string): Map<string, Set<string>> => {
    const m = new Map<string, Set<string>>()
    for (const r of rows<{ contract_id: string; consumer_boundary_id: string }>(
      db,
      'SELECT contract_id, consumer_boundary_id FROM contract_consumers WHERE model_version = ?',
      v
    )) {
      const s = m.get(r.contract_id)
      if (s) s.add(r.consumer_boundary_id)
      else m.set(r.contract_id, new Set([r.consumer_boundary_id]))
    }
    return m
  }
  const consBase = consumersOf(baseModelVersion)
  const consNext = consumersOf(modelVersion)

  const contractIds = new Set<string>([...cBase.keys(), ...cNext.keys()])
  for (const contractId of contractIds) {
    const before = cBase.get(contractId)
    const after = cNext.get(contractId)
    const bc = consBase.get(contractId) ?? new Set<string>()
    const ac = consNext.get(contractId) ?? new Set<string>()
    const rowChanged =
      before === undefined ||
      after === undefined ||
      before.name !== after.name ||
      before.schema_path !== after.schema_path ||
      before.provider_boundary_id !== after.provider_boundary_id
    const consumersChanged = !setEquals(bc, ac)
    if (!rowChanged && !consumersChanged) continue
    basis.push({
      kind: 'contract',
      modelVersion,
      baseModelVersion,
      contractId,
      beforeRef: {
        modelVersion: baseModelVersion,
        contract: before ?? null,
        consumers: [...bc].sort()
      },
      afterRef: {
        modelVersion,
        contract: after ?? null,
        consumers: [...ac].sort()
      }
    })
  }

  // -- boundary/horizontal context link diffs -----------------------------
  const linkDiff = <K extends string>(
    table: 'boundary_contexts' | 'horizontal_contexts',
    ownerCol: K
  ): { owner: string; contextId: string; change: 'linked' | 'unlinked' }[] => {
    const at = (v: string): Map<string, { owner: string; contextId: string }> =>
      new Map(
        rows<Record<K, string> & { owner: string; context_id: string }>(
          db,
          `SELECT ${ownerCol} AS owner, context_id FROM ${table} WHERE model_version = ?`,
          v
        ).map((r) => [`${r.owner}${r.context_id}`, { owner: r.owner, contextId: r.context_id }])
      )
    const before = at(baseModelVersion)
    const after = at(modelVersion)
    const out: { owner: string; contextId: string; change: 'linked' | 'unlinked' }[] = []
    for (const [k, v] of after) if (!before.has(k)) out.push({ ...v, change: 'linked' })
    for (const [k, v] of before) if (!after.has(k)) out.push({ ...v, change: 'unlinked' })
    return out
  }
  for (const d of linkDiff('boundary_contexts', 'boundary_id')) {
    basis.push({
      kind: 'boundary-context',
      modelVersion,
      boundaryId: d.owner,
      contextId: d.contextId,
      linkChange: d.change
    })
  }
  for (const d of linkDiff('horizontal_contexts', 'horizontal_role_name')) {
    basis.push({
      kind: 'horizontal-context',
      modelVersion,
      horizontalRoleName: d.owner,
      contextId: d.contextId,
      linkChange: d.change
    })
  }

  // -- context path redirects ----------------------------------------------
  const ctxBase = new Map(
    rows<{ id: string; path: string }>(
      db,
      'SELECT id, path FROM rdd_contexts WHERE model_version = ?',
      baseModelVersion
    ).map((r) => [r.id, r.path])
  )
  const ctxNext = new Map(
    rows<{ id: string; path: string }>(
      db,
      'SELECT id, path FROM rdd_contexts WHERE model_version = ?',
      modelVersion
    ).map((r) => [r.id, r.path])
  )
  for (const [id, path] of ctxNext) {
    const before = ctxBase.get(id)
    if (before !== undefined && before !== path) {
      basis.push({
        kind: 'context-redirect',
        modelVersion,
        contextId: id,
        beforePath: before,
        afterPath: path
      })
    }
  }

  // -- roles + horizontal roles --------------------------------------------
  const rBase = new Map(
    rows<RoleRow>(
      db,
      'SELECT id, name, description, boundary_id, horizontal_role_name FROM rdd_roles WHERE model_version = ?',
      baseModelVersion
    ).map((r) => [r.id, r])
  )
  const rNext = new Map(
    rows<RoleRow>(
      db,
      'SELECT id, name, description, boundary_id, horizontal_role_name FROM rdd_roles WHERE model_version = ?',
      modelVersion
    ).map((r) => [r.id, r])
  )
  for (const [id, after] of rNext) {
    const before = rBase.get(id)
    const changed =
      before === undefined ||
      before.name !== after.name ||
      before.description !== after.description ||
      before.boundary_id !== after.boundary_id ||
      before.horizontal_role_name !== after.horizontal_role_name
    if (changed) {
      basis.push({
        kind: 'role',
        modelVersion,
        roleId: id,
        beforeRef: { modelVersion: baseModelVersion, role: before ?? null },
        afterRef: { modelVersion, role: after }
      })
    }
  }
  for (const id of rBase.keys()) {
    if (!rNext.has(id)) {
      basis.push({
        kind: 'role',
        modelVersion,
        roleId: id,
        beforeRef: { modelVersion: baseModelVersion, role: rBase.get(id) },
        afterRef: { modelVersion, role: null }
      })
    }
  }

  const hBase = new Set(
    rows<{ name: string }>(
      db,
      'SELECT name FROM horizontal_roles WHERE model_version = ?',
      baseModelVersion
    ).map((r) => r.name)
  )
  const hNext = new Set(
    rows<{ name: string }>(
      db,
      'SELECT name FROM horizontal_roles WHERE model_version = ?',
      modelVersion
    ).map((r) => r.name)
  )
  for (const name of new Set([...hBase, ...hNext])) {
    if (hBase.has(name) !== hNext.has(name)) {
      basis.push({ kind: 'horizontal-role', modelVersion, horizontalRoleName: name })
    }
  }

  // -- interface drift ------------------------------------------------------
  // A non-retired implementation is stale when the interface digest it pins
  // is no longer the live interface snapshot of its role at `modelVersion`.
  // Scope: only impls whose role participates in base OR next version —
  // other projects' impls are never drift-flagged by this publication.
  const impls = rows<{
    id: string
    revision: number
    interface_digest: string
    maintainer_role_id: string
  }>(
    db,
    `SELECT ri.id, ri.revision, ri.interface_digest, ri.maintainer_role_id
     FROM role_implementations ri
     JOIN role_interfaces i ON i.digest = ri.interface_digest
     WHERE ri.status <> 'retired'
       AND i.role_id IN (
         SELECT id FROM rdd_roles WHERE model_version = ?
         UNION SELECT id FROM rdd_roles WHERE model_version = ?
       )`,
    modelVersion,
    baseModelVersion
  )
  const roleOfDigest = new Map(
    rows<{ digest: string; role_id: string }>(
      db,
      'SELECT digest, role_id FROM role_interfaces'
    ).map((r) => [r.digest, r.role_id])
  )
  const liveDigests = new Set(
    rows<{ digest: string }>(
      db,
      'SELECT digest FROM role_interfaces WHERE model_version = ?',
      modelVersion
    ).map((r) => r.digest)
  )
  const digestOfRoleNext = new Map(
    rows<{ digest: string; role_id: string }>(
      db,
      'SELECT digest, role_id FROM role_interfaces WHERE model_version = ?',
      modelVersion
    ).map((r) => [r.role_id, r.digest])
  )
  for (const impl of impls) {
    if (liveDigests.has(impl.interface_digest)) continue // still current — no drift
    const roleId = roleOfDigest.get(impl.interface_digest)
    basis.push({
      kind: 'interface-drift',
      modelVersion,
      implementationId: impl.id,
      implementationRevision: impl.revision,
      roleId,
      maintainerRoleId: impl.maintainer_role_id,
      beforeDigest: impl.interface_digest,
      afterDigest: roleId === undefined ? undefined : digestOfRoleNext.get(roleId)
    })
  }

  return basis
}

function setEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

/* ------------------------------------------------------------------ *
 * relation walks used by target derivation
 * ------------------------------------------------------------------ */

function rolesOfBoundary(db: DatabaseSync, modelVersion: string, boundaryId: string): string[] {
  return rows<{ id: string }>(
    db,
    'SELECT id FROM rdd_roles WHERE model_version = ? AND boundary_id = ?',
    modelVersion,
    boundaryId
  ).map((r) => r.id)
}

interface ImplRef {
  id: string
  revision: number
  interfaceDigest: string
  maintainerRoleId: string
}

/** non-retired implementations of a role (impl -> interface -> role join) */
function implsOfRole(db: DatabaseSync, roleId: string): ImplRef[] {
  return rows<{
    id: string
    revision: number
    interface_digest: string
    maintainer_role_id: string
  }>(
    db,
    `SELECT ri.id, ri.revision, ri.interface_digest, ri.maintainer_role_id
     FROM role_implementations ri
     JOIN role_interfaces i ON i.digest = ri.interface_digest
     WHERE i.role_id = ? AND ri.status <> 'retired'`,
    roleId
  ).map((r) => ({
    id: r.id,
    revision: r.revision,
    interfaceDigest: r.interface_digest,
    maintainerRoleId: r.maintainer_role_id
  }))
}

function childBoundaries(db: DatabaseSync, modelVersion: string, parentId: string): string[] {
  return rows<{ child_id: string }>(
    db,
    'SELECT child_id FROM boundary_edges WHERE model_version = ? AND parent_id = ?',
    modelVersion,
    parentId
  ).map((r) => r.child_id)
}

/**
 * Implementations whose maintenance_bindings basis_ref mentions `value`
 * under any of `keys`. basis_ref_json shape is owned by IMP-07; matching is
 * a tolerant deep scan (objects/arrays/strings) — a binding that clearly
 * names the changed element is a stale candidate, nothing more is claimed.
 */
function implsWithBasisRef(db: DatabaseSync, keys: readonly string[], value: string): ImplRef[] {
  const bindings = rows<{
    implementation_id: string
    implementation_revision: number
    basis_ref_json: string
  }>(
    db,
    'SELECT implementation_id, implementation_revision, basis_ref_json FROM maintenance_bindings'
  )
  const hits = new Map<string, ImplRef>()
  for (const b of bindings) {
    const parsed = parseJsonColumn(b.basis_ref_json, null)
    if (parsed === null || !deepRefMatch(parsed, keys, value)) continue
    const impl = db
      .prepare(
        `SELECT ri.id, ri.revision, ri.interface_digest, ri.maintainer_role_id, ri.status
         FROM role_implementations ri WHERE ri.id = ? AND ri.revision = ?`
      )
      .get(b.implementation_id, b.implementation_revision) as
      | {
          id: string
          revision: number
          interface_digest: string
          maintainer_role_id: string
          status: string
        }
      | undefined
    if (impl === undefined || impl.status === 'retired') continue
    hits.set(impl.id, {
      id: impl.id,
      revision: impl.revision,
      interfaceDigest: impl.interface_digest,
      maintainerRoleId: impl.maintainer_role_id
    })
  }
  return [...hits.values()]
}

function deepRefMatch(node: unknown, keys: readonly string[], value: string): boolean {
  if (typeof node === 'string') return node === value
  if (Array.isArray(node)) return node.some((n) => deepRefMatch(n, keys, value))
  if (typeof node === 'object' && node !== null) {
    const o = node as Record<string, unknown>
    for (const k of keys) {
      if (o[k] === value) return true
    }
    return Object.values(o).some((v) => deepRefMatch(v, keys, value))
  }
  return false
}

const CONTEXT_REF_KEYS = ['contextId', 'context_id', 'contextRef', 'context'] as const

/**
 * Role interfaces at `modelVersion` whose requirements_json mentions the
 * context. Returns the roles plus whether ANY matching requirement is
 * initial-delivery (a required clause — feeds `reason.required`).
 */
function rolesRequiringContext(
  db: DatabaseSync,
  modelVersion: string,
  contextId: string
): { roleId: string; required: boolean }[] {
  const ifaces = rows<{ digest: string; role_id: string; requirements_json: string }>(
    db,
    'SELECT digest, role_id, requirements_json FROM role_interfaces WHERE model_version = ?',
    modelVersion
  )
  const out = new Map<string, { roleId: string; required: boolean }>()
  for (const i of ifaces) {
    const reqs = parseJsonColumn(i.requirements_json, [])
    if (!Array.isArray(reqs)) continue
    let matched = false
    let required = false
    for (const req of reqs) {
      if (deepRefMatch(req, CONTEXT_REF_KEYS, contextId)) {
        matched = true
        const dc = (req as Record<string, unknown>).deliveryClass
        if (dc === 'initial') required = true
      }
    }
    if (matched) {
      const cur = out.get(i.role_id)
      out.set(i.role_id, { roleId: i.role_id, required: required || (cur?.required ?? false) })
    }
  }
  return [...out.values()]
}

function projectOfModelVersion(db: DatabaseSync, modelVersion: string): string | undefined {
  const r = db.prepare('SELECT project_id FROM model_versions WHERE id = ?').get(modelVersion) as
    { project_id: string } | undefined
  return r?.project_id
}

/* ------------------------------------------------------------------ *
 * deriveTargets — BasisChange -> CandidateDraft[]
 * ------------------------------------------------------------------ */

export function deriveTargets(
  db: DatabaseSync,
  basis: BasisChange,
  projectId: string | undefined
): CandidateDraft[] {
  const drafts: CandidateDraft[] = []
  const scopeBase: ImpactScope = { projectId, modelVersion: basis.modelVersion }

  const emitRole = (
    roleId: string,
    boundaryId: string | undefined,
    kind: ImpactReasonKind,
    summary: string,
    beforeRef: unknown,
    afterRef: unknown,
    required?: boolean | null
  ): void => {
    drafts.push({
      targetKind: 'role',
      targetId: roleId,
      reason: {
        kind,
        summary,
        beforeRef,
        afterRef,
        required: required ?? null,
        scope: { ...scopeBase, roleId, boundaryId }
      }
    })
    for (const impl of implsOfRole(db, roleId)) {
      drafts.push({
        targetKind: 'implementation',
        targetId: impl.id,
        reason: {
          kind,
          summary,
          beforeRef,
          afterRef,
          required: required ?? null,
          scope: { ...scopeBase, roleId, boundaryId, maintainerRoleId: impl.maintainerRoleId }
        }
      })
    }
  }

  const emitContextLinked = (
    roles: { roleId: string; boundaryId?: string; required: boolean | null }[],
    kind: ImpactReasonKind,
    summary: string,
    beforeRef: unknown,
    afterRef: unknown,
    contextId: string
  ): void => {
    const seenImpls = new Set<string>()
    for (const r of roles) {
      emitRole(r.roleId, r.boundaryId, kind, summary, beforeRef, afterRef, r.required)
      for (const impl of implsOfRole(db, r.roleId)) seenImpls.add(impl.id)
    }
    // realization-side path: impls whose maintenance basis names the context
    // even when no live link row points at them (D-RESOURCE §3
    // MaintenanceBinding — "implementation maintenance basis").
    for (const impl of implsWithBasisRef(db, CONTEXT_REF_KEYS, contextId)) {
      if (seenImpls.has(impl.id)) continue
      seenImpls.add(impl.id)
      drafts.push({
        targetKind: 'implementation',
        targetId: impl.id,
        reason: {
          kind,
          summary: `${summary} (maintenance basis ref)`,
          beforeRef,
          afterRef,
          required: null,
          scope: { ...scopeBase, maintainerRoleId: impl.maintainerRoleId }
        }
      })
    }
  }

  switch (basis.kind) {
    case 'responsibility': {
      // rdd.md §2 / D-RESOURCE §6: parent change -> DIRECT children re-translation.
      for (const child of childBoundaries(db, basis.modelVersion, basis.boundaryId)) {
        for (const roleId of rolesOfBoundary(db, basis.modelVersion, child)) {
          emitRole(
            roleId,
            child,
            'parent-responsibility',
            `parent boundary ${basis.boundaryId} responsibility changed; direct-child translation must be re-reviewed`,
            basis.beforeRef,
            basis.afterRef
          )
        }
      }
      break
    }
    case 'composition': {
      for (const roleId of rolesOfBoundary(db, basis.modelVersion, basis.boundaryId)) {
        emitRole(
          roleId,
          basis.boundaryId,
          'parent-composition',
          `boundary ${basis.boundaryId} child set changed; parent composition view must be re-reviewed`,
          basis.beforeRef,
          basis.afterRef
        )
      }
      break
    }
    case 'boundary-moved': {
      for (const roleId of rolesOfBoundary(db, basis.modelVersion, basis.boundaryId)) {
        emitRole(
          roleId,
          basis.boundaryId,
          'boundary-moved',
          `boundary ${basis.boundaryId} reparented ${basis.beforeParentId ?? '?'} -> ${basis.afterParentId ?? '?'}; inherited translation must be re-derived`,
          { modelVersion: basis.modelVersion, parentId: basis.beforeParentId },
          { modelVersion: basis.modelVersion, parentId: basis.afterParentId }
        )
      }
      break
    }
    case 'contract': {
      // before ∪ after consumers (D-RESOURCE §6: a vanished consumer still
      // gets notified — its removal is itself an impact to review).
      const beforeConsumers = ((basis.beforeRef as { consumers?: string[] } | null)?.consumers ??
        []) as string[]
      const afterConsumers = ((basis.afterRef as { consumers?: string[] } | null)?.consumers ??
        []) as string[]
      const union = new Map<string, 'removed' | 'added' | 'continued'>()
      for (const c of beforeConsumers) union.set(c, 'removed')
      for (const c of afterConsumers) union.set(c, union.has(c) ? 'continued' : 'added')
      for (const [consumerBoundaryId, membership] of union) {
        // roles are resolved in the version where the consumer exists;
        // 'removed' consumers only have roles at the base version.
        const v =
          membership === 'removed'
            ? (basis.baseModelVersion ?? basis.modelVersion)
            : basis.modelVersion
        for (const roleId of rolesOfBoundary(db, v, consumerBoundaryId)) {
          emitRole(
            roleId,
            consumerBoundaryId,
            'contract-consumer',
            `contract ${basis.contractId} changed (consumer membership: ${membership})`,
            basis.beforeRef,
            basis.afterRef
          )
        }
      }
      break
    }
    case 'boundary-context': {
      const boundaryRoleIds = rolesOfBoundary(db, basis.modelVersion, basis.boundaryId)
      const roles = [
        ...boundaryRoleIds.map((roleId) => ({
          roleId,
          boundaryId: basis.boundaryId,
          required: null as boolean | null
        })),
        ...rolesRequiringContext(db, basis.modelVersion, basis.contextId)
          .filter((r) => !boundaryRoleIds.includes(r.roleId))
          .map((r) => ({ roleId: r.roleId, boundaryId: undefined, required: r.required }))
      ]
      emitContextLinked(
        roles,
        'boundary-context',
        `boundary ${basis.boundaryId} ${basis.linkChange} context ${basis.contextId}`,
        { modelVersion: basis.modelVersion, contextId: basis.contextId },
        {
          modelVersion: basis.modelVersion,
          contextId: basis.contextId,
          linkChange: basis.linkChange
        },
        basis.contextId
      )
      break
    }
    case 'horizontal-context': {
      const roleIds = rows<{ id: string }>(
        db,
        'SELECT id FROM rdd_roles WHERE model_version = ? AND horizontal_role_name = ?',
        basis.modelVersion,
        basis.horizontalRoleName
      ).map((r) => r.id)
      const linked = roleIds.map((roleId) => ({
        roleId,
        boundaryId: undefined,
        required: null as boolean | null
      }))
      const viaReqs = rolesRequiringContext(db, basis.modelVersion, basis.contextId)
        .filter((r) => !roleIds.includes(r.roleId))
        .map((r) => ({ roleId: r.roleId, boundaryId: undefined, required: r.required }))
      emitContextLinked(
        [...linked, ...viaReqs],
        'horizontal-context',
        `horizontal role ${basis.horizontalRoleName} ${basis.linkChange} context ${basis.contextId}`,
        { modelVersion: basis.modelVersion, contextId: basis.contextId },
        {
          modelVersion: basis.modelVersion,
          contextId: basis.contextId,
          linkChange: basis.linkChange
        },
        basis.contextId
      )
      break
    }
    case 'context-redirect':
    case 'context-source': {
      const boundaries = rows<{ boundary_id: string }>(
        db,
        'SELECT boundary_id FROM boundary_contexts WHERE model_version = ? AND context_id = ?',
        basis.modelVersion,
        basis.contextId
      ).map((r) => r.boundary_id)
      const hroles = rows<{ horizontal_role_name: string }>(
        db,
        'SELECT horizontal_role_name FROM horizontal_contexts WHERE model_version = ? AND context_id = ?',
        basis.modelVersion,
        basis.contextId
      ).map((r) => r.horizontal_role_name)
      const roles = new Map<
        string,
        { roleId: string; boundaryId?: string; required: boolean | null }
      >()
      for (const b of boundaries) {
        for (const roleId of rolesOfBoundary(db, basis.modelVersion, b)) {
          roles.set(roleId, { roleId, boundaryId: b, required: null })
        }
      }
      for (const h of hroles) {
        for (const r of rows<{ id: string }>(
          db,
          'SELECT id FROM rdd_roles WHERE model_version = ? AND horizontal_role_name = ?',
          basis.modelVersion,
          h
        )) {
          if (!roles.has(r.id)) roles.set(r.id, { roleId: r.id, required: null })
        }
      }
      for (const r of rolesRequiringContext(db, basis.modelVersion, basis.contextId)) {
        const cur = roles.get(r.roleId)
        roles.set(r.roleId, { roleId: r.roleId, boundaryId: cur?.boundaryId, required: r.required })
      }
      const isSource = basis.kind === 'context-source'
      emitContextLinked(
        [...roles.values()],
        isSource ? 'context-source' : 'context-redirect',
        isSource
          ? `context ${basis.contextId} source digest changed (hash change is a stale candidate, not a semantic verdict)`
          : `context ${basis.contextId} path redirected ${basis.beforePath ?? '?'} -> ${basis.afterPath ?? '?'}`,
        isSource
          ? { contextId: basis.contextId, path: basis.path, digest: basis.beforeDigest }
          : { contextId: basis.contextId, path: basis.beforePath },
        isSource
          ? { contextId: basis.contextId, path: basis.path, digest: basis.afterDigest }
          : { contextId: basis.contextId, path: basis.afterPath },
        basis.contextId
      )
      break
    }
    case 'role': {
      emitRole(
        basis.roleId,
        (basis.afterRef as { role?: { boundary_id?: string } } | null)?.role?.boundary_id ??
          (basis.beforeRef as { role?: { boundary_id?: string } } | null)?.role?.boundary_id,
        'role-structure',
        `role ${basis.roleId} definition changed`,
        basis.beforeRef,
        basis.afterRef
      )
      break
    }
    case 'horizontal-role': {
      const roleIds = rows<{ id: string }>(
        db,
        'SELECT id FROM rdd_roles WHERE model_version = ? AND horizontal_role_name = ?',
        basis.modelVersion,
        basis.horizontalRoleName
      ).map((r) => r.id)
      for (const roleId of roleIds) {
        emitRole(
          roleId,
          undefined,
          'horizontal-role',
          `horizontal role ${basis.horizontalRoleName} changed`,
          { modelVersion: basis.modelVersion },
          { modelVersion: basis.modelVersion, horizontalRoleName: basis.horizontalRoleName }
        )
      }
      break
    }
    case 'interface-drift': {
      drafts.push({
        targetKind: 'implementation',
        targetId: basis.implementationId,
        reason: {
          kind: 'interface-digest',
          summary: `role interface digest drifted: implementation pins ${basis.beforeDigest ?? '?'} but the live interface is ${basis.afterDigest ?? 'absent'}`,
          beforeRef: { interfaceDigest: basis.beforeDigest, modelVersion: basis.modelVersion },
          afterRef: {
            interfaceDigest: basis.afterDigest ?? null,
            modelVersion: basis.modelVersion
          },
          required: null,
          scope: { ...scopeBase, roleId: basis.roleId, maintainerRoleId: basis.maintainerRoleId }
        }
      })
      break
    }
    case 'implementation': {
      // dependent impls: maintenance basis naming the changed impl or its interface
      const deps1 = implsWithBasisRef(
        db,
        ['implementationId', 'implementation_id', 'id'],
        basis.implementationId
      )
      const deps2 = basis.interfaceDigest
        ? implsWithBasisRef(
            db,
            ['interfaceDigest', 'interface_digest', 'digest'],
            basis.interfaceDigest
          )
        : []
      const seen = new Set<string>()
      for (const impl of [...deps1, ...deps2]) {
        if (impl.id === basis.implementationId || seen.has(impl.id)) continue
        seen.add(impl.id)
        drafts.push({
          targetKind: 'implementation',
          targetId: impl.id,
          reason: {
            kind: basis.change === 'retired' ? 'implementation-retired' : 'implementation-basis',
            summary: `maintenance basis implementation ${basis.implementationId}@${basis.revision} was ${basis.change}`,
            beforeRef: {
              implementationId: basis.implementationId,
              interfaceDigest: basis.interfaceDigest
            },
            afterRef: {
              implementationId: basis.implementationId,
              revision: basis.revision,
              change: basis.change
            },
            required: null,
            scope: { ...scopeBase, maintainerRoleId: impl.maintainerRoleId }
          }
        })
      }
      break
    }
    case 'reported-effect': {
      const contract = db
        .prepare(
          'SELECT provider_boundary_id FROM rdd_contracts WHERE model_version = ? AND id = ?'
        )
        .get(basis.modelVersion ?? '', basis.contractId) as
        { provider_boundary_id: string } | undefined
      const effectRef = {
        outcome: basis.outcomeRef,
        runId: basis.runId,
        reportedByMemberId: basis.reportedByMemberId
      }
      if (contract !== undefined) {
        for (const roleId of rolesOfBoundary(
          db,
          basis.modelVersion ?? '',
          contract.provider_boundary_id
        )) {
          emitRole(
            roleId,
            contract.provider_boundary_id,
            'reported-effect',
            `contract ${basis.contractId} effect reported by dispatch outcome — provider review needed`,
            effectRef,
            effectRef
          )
        }
      }
      if (basis.reportedByMemberId !== undefined) {
        const member = db
          .prepare('SELECT role_id FROM members WHERE id = ?')
          .get(basis.reportedByMemberId) as { role_id: string } | undefined
        if (member !== undefined) {
          emitRole(
            member.role_id,
            undefined,
            'reported-effect',
            `contract ${basis.contractId} effect reported by this member's outcome — consumer-side review`,
            effectRef,
            effectRef
          )
        }
      }
      break
    }
  }
  return drafts
}

/* ------------------------------------------------------------------ *
 * persistCandidates — idempotent insert + domain events
 * ------------------------------------------------------------------ */

export interface PersistResult {
  changeRef: string
  created: number
  candidateIds: string[]
}

export function persistCandidates(
  db: DatabaseSync,
  changeRef: string,
  drafts: readonly CandidateDraft[],
  deps: ObserverDeps
): PersistResult {
  const deduped = new Map<string, CandidateDraft>()
  for (const d of drafts) {
    const key = `${d.targetKind}${d.targetId}${d.reason.kind}`
    if (!deduped.has(key)) deduped.set(key, d)
  }

  const existsStmt = db.prepare(
    `SELECT 1 FROM impact_candidates
     WHERE change_ref = ? AND target_kind = ? AND target_id = ?
       AND json_extract(reason_json, '$.kind') = ?`
  )
  const insertStmt = db.prepare(
    `INSERT INTO impact_candidates
       (id, change_ref, target_kind, target_id, state, revision, reason_json, resolution_json)
     VALUES (?, ?, ?, ?, 'candidate', 1, ?, '{}')`
  )
  const eventStmt = db.prepare(
    `INSERT INTO domain_events (aggregate_id, aggregate_revision, event_type, scope_json, payload_json)
     VALUES (?, ?, ?, ?, ?)`
  )

  const candidateIds: string[] = []
  const t = now(deps)
  for (const d of deduped.values()) {
    const reason: ImpactReason = { ...d.reason, detectedAt: t }
    const found = existsStmt.get(changeRef, d.targetKind, d.targetId, d.reason.kind)
    if (found !== undefined) continue // same change re-observed — idempotent
    const id = newId(deps)
    insertStmt.run(id, changeRef, d.targetKind, d.targetId, JSON.stringify(reason))
    eventStmt.run(
      id,
      1,
      'ImpactCandidateRaised',
      JSON.stringify({
        projectId: reason.scope.projectId ?? null,
        modelVersion: reason.scope.modelVersion ?? null,
        changeRef
      }),
      JSON.stringify({
        candidateId: id,
        changeRef,
        targetKind: d.targetKind,
        targetId: d.targetId,
        reason
      })
    )
    candidateIds.push(id)
  }
  return { changeRef, created: candidateIds.length, candidateIds }
}

/** run `fn` inside the caller's transaction when present, else open one */
export function inUnit<T>(db: DatabaseSync, fn: (db: DatabaseSync) => T): T {
  return inTransaction(db) ? fn(db) : withTx(db, fn)
}

/* ------------------------------------------------------------------ *
 * observation entry points — one per change source.
 * All are idempotent for a repeated observation of the SAME change ref.
 * ------------------------------------------------------------------ */

export interface ModelPublicationInput {
  projectId: string
  /** model_changes.id of the committed change — becomes the changeRef */
  changeId: string
  baseModelVersion: string
  publishedModelVersion: string
}

/**
 * Called from the model publication flow (model.change.commit's transaction
 * or the ModelPublished intent consumer). Diffs base->published snapshots,
 * merges IMP-05's structural port when wired, persists candidates.
 */
export function observeModelPublication(
  db: DatabaseSync,
  input: ModelPublicationInput,
  deps: ObserverDeps = {}
): PersistResult {
  return inUnit(db, (tx) => {
    const basis = diffModelVersions(tx, input.baseModelVersion, input.publishedModelVersion)
    const own = basis.flatMap((b) => deriveTargets(tx, b, input.projectId))
    const ported =
      deps.computeModelImpactCandidates?.(tx, basis, {
        baseModelVersion: input.baseModelVersion,
        modelVersion: input.publishedModelVersion
      }) ?? []
    return persistCandidates(tx, `model-change:${input.changeId}`, [...own, ...ported], deps)
  })
}

export interface ContextSourceChangeInput {
  projectId: string
  modelVersion: string
  contextId: string
  path?: string
  beforeDigest?: string
  afterDigest?: string
}

/**
 * A registered context's stored bytes changed digest. Per role-realization §5
 * a hash change is NOT a semantic mismatch verdict — it only raises stale
 * candidates; new launches then apply the stale-interface/required-context
 * policy while existing executions keep their pinned bundle.
 */
export function observeContextSourceChange(
  db: DatabaseSync,
  input: ContextSourceChangeInput,
  deps: ObserverDeps = {}
): PersistResult {
  if (input.beforeDigest !== undefined && input.beforeDigest === input.afterDigest) {
    return {
      changeRef: `context-source:${input.contextId}:${input.afterDigest ?? 'unknown'}`,
      created: 0,
      candidateIds: []
    }
  }
  const basis: BasisChange = {
    kind: 'context-source',
    modelVersion: input.modelVersion,
    contextId: input.contextId,
    path: input.path,
    beforeDigest: input.beforeDigest,
    afterDigest: input.afterDigest
  }
  return inUnit(db, (tx) => {
    const own = deriveTargets(tx, basis, input.projectId)
    const ported =
      deps.computeModelImpactCandidates?.(tx, [basis], { modelVersion: input.modelVersion }) ?? []
    return persistCandidates(
      tx,
      `context-source:${input.contextId}:${input.afterDigest ?? 'unknown'}`,
      [...own, ...ported],
      deps
    )
  })
}

export interface ContractEffectsInput {
  runId: string
  outcomeId: string
  outcomeRevision: number
  reportedByMemberId?: string
  /** IMP-21's contractEffects payload — shape tolerated, contract refs extracted */
  effects: unknown
}

/**
 * Problems surfaced in a work report's contractEffects are routed into
 * maintenance input (D-RESOURCE §6). Only candidate rows are produced — the
 * reporting execution's own bundle is never touched.
 */
export function observeContractEffects(
  db: DatabaseSync,
  input: ContractEffectsInput,
  deps: ObserverDeps = {}
): PersistResult {
  const run = db
    .prepare('SELECT project_id, model_version FROM runs WHERE id = ?')
    .get(input.runId) as { project_id: string; model_version: string } | undefined
  if (run === undefined) {
    return {
      changeRef: `outcome:${input.outcomeId}:${input.outcomeRevision}`,
      created: 0,
      candidateIds: []
    }
  }
  const contractIds = extractContractRefs(input.effects)
  if (contractIds.length === 0) {
    return {
      changeRef: `outcome:${input.outcomeId}:${input.outcomeRevision}`,
      created: 0,
      candidateIds: []
    }
  }
  return inUnit(db, (tx) => {
    const drafts = contractIds.flatMap((contractId) =>
      deriveTargets(
        tx,
        {
          kind: 'reported-effect',
          modelVersion: run.model_version,
          contractId,
          outcomeRef: { id: input.outcomeId, revision: input.outcomeRevision },
          reportedByMemberId: input.reportedByMemberId,
          runId: input.runId
        },
        run.project_id
      )
    )
    return persistCandidates(
      tx,
      `outcome:${input.outcomeId}:${input.outcomeRevision}`,
      drafts,
      deps
    )
  })
}

/** tolerant extraction of contract ids from an outcome's contractEffects */
function extractContractRefs(effects: unknown): string[] {
  const ids = new Set<string>()
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      ids.add(node)
      return
    }
    if (Array.isArray(node)) {
      for (const n of node) visit(n)
      return
    }
    if (typeof node === 'object' && node !== null) {
      const o = node as Record<string, unknown>
      const direct = o.contractId ?? o.contract_id ?? o.contract
      if (typeof direct === 'string') ids.add(direct)
      else if (direct !== undefined) visit(direct)
      for (const [k, v] of Object.entries(o)) {
        if (k === 'contractId' || k === 'contract_id' || k === 'contract') continue
        if (typeof v === 'object' && v !== null) visit(v)
      }
    }
  }
  visit(effects)
  return [...ids]
}

export interface ImplementationChangeInput {
  implementationId: string
  revision: number
  change: 'published' | 'retired'
  interfaceDigest?: string
  maintainerRoleId?: string
  /** model version the implementation's role lives in — resolves project scope */
  modelVersion?: string
}

/**
 * A role implementation was published or retired (IMP-07's publication event).
 * Dependent implementations (maintenance_bindings basis) become candidates.
 * Running executions keep their pin — nothing here re-resolves bundles.
 */
export function observeImplementationChange(
  db: DatabaseSync,
  input: ImplementationChangeInput,
  deps: ObserverDeps = {}
): PersistResult {
  const projectId =
    input.modelVersion === undefined ? undefined : projectOfModelVersion(db, input.modelVersion)
  const basis: BasisChange = {
    kind: 'implementation',
    implementationId: input.implementationId,
    revision: input.revision,
    change: input.change,
    interfaceDigest: input.interfaceDigest,
    maintainerRoleId: input.maintainerRoleId,
    modelVersion: input.modelVersion
  }
  return inUnit(db, (tx) => {
    const drafts = deriveTargets(tx, basis, projectId)
    return persistCandidates(
      tx,
      `impl:${input.implementationId}:${input.revision}:${input.change}`,
      drafts,
      deps
    )
  })
}

/* ------------------------------------------------------------------ *
 * composition seams
 * ------------------------------------------------------------------ */

export interface MaintenanceHooks {
  /** inside (or right after) model.change.commit's transaction */
  onModelPublished(db: DatabaseSync, input: ModelPublicationInput): PersistResult
  /** a context's stored source bytes changed digest */
  onContextSourceChanged(db: DatabaseSync, input: ContextSourceChangeInput): PersistResult
  /** an outcome recorded contractEffects (IMP-21's task.report flow) */
  onContractEffectsReported(db: DatabaseSync, input: ContractEffectsInput): PersistResult
  /** implementation.publish / implementation.retire landed */
  onImplementationChanged(db: DatabaseSync, input: ImplementationChangeInput): PersistResult
  /** feed a domain_events row — returns true when the event was consumed */
  applyDomainEvent(db: DatabaseSync, event: { eventType: string; payload: unknown }): boolean
}

/**
 * Event-name mapping for outbox-driven feeding. These are the event types
 * this module consumes; producers must use the same names (recorded in the
 * IMP-27 handoff — adjust to the publishers' actual names if they differ).
 */
export const OBSERVED_EVENT_TYPES = {
  modelPublished: 'ModelPublished',
  contractEffectsReported: 'OutcomeRecorded',
  contextSourceChanged: 'ContextSourceChanged',
  implementationPublished: 'ImplementationPublished',
  implementationRetired: 'ImplementationRetired'
} as const

export function createMaintenanceHooks(deps: ObserverDeps = {}): MaintenanceHooks {
  return {
    onModelPublished: (db, input) => observeModelPublication(db, input, deps),
    onContextSourceChanged: (db, input) => observeContextSourceChange(db, input, deps),
    onContractEffectsReported: (db, input) => observeContractEffects(db, input, deps),
    onImplementationChanged: (db, input) => observeImplementationChange(db, input, deps),
    applyDomainEvent: (db, event) => {
      const p = (event.payload ?? {}) as Record<string, unknown>
      switch (event.eventType) {
        case OBSERVED_EVENT_TYPES.modelPublished:
          observeModelPublication(
            db,
            {
              projectId: String(p.projectId),
              changeId: String(p.changeId),
              baseModelVersion: String(p.baseModelVersion),
              publishedModelVersion: String(p.publishedModelVersion ?? p.modelVersion)
            },
            deps
          )
          return true
        case OBSERVED_EVENT_TYPES.contractEffectsReported:
          observeContractEffects(
            db,
            {
              runId: String(p.runId),
              outcomeId: String(p.outcomeId ?? p.id),
              outcomeRevision: Number(p.outcomeRevision ?? p.revision ?? 1),
              reportedByMemberId:
                p.reportedByMemberId === undefined ? undefined : String(p.reportedByMemberId),
              effects: p.contractEffects ?? p.contract_effects
            },
            deps
          )
          return true
        case OBSERVED_EVENT_TYPES.contextSourceChanged:
          observeContextSourceChange(
            db,
            {
              projectId: String(p.projectId),
              modelVersion: String(p.modelVersion),
              contextId: String(p.contextId),
              path: p.path === undefined ? undefined : String(p.path),
              beforeDigest: p.beforeDigest === undefined ? undefined : String(p.beforeDigest),
              afterDigest: p.afterDigest === undefined ? undefined : String(p.afterDigest)
            },
            deps
          )
          return true
        case OBSERVED_EVENT_TYPES.implementationPublished:
        case OBSERVED_EVENT_TYPES.implementationRetired:
          observeImplementationChange(
            db,
            {
              implementationId: String(p.implementationId ?? p.id),
              revision: Number(p.revision ?? 0),
              change:
                event.eventType === OBSERVED_EVENT_TYPES.implementationRetired
                  ? 'retired'
                  : 'published',
              interfaceDigest:
                p.interfaceDigest === undefined ? undefined : String(p.interfaceDigest),
              maintainerRoleId:
                p.maintainerRoleId === undefined ? undefined : String(p.maintainerRoleId),
              modelVersion: p.modelVersion === undefined ? undefined : String(p.modelVersion)
            },
            deps
          )
          return true
        default:
          return false
      }
    }
  }
}
