// mahas-runtime/src/discovery/model-read.ts — read side of the storage
// contract (spec/storage.md §3, §6) for the discovery boundary.
//
// §6 rule honored throughout: role_search_rows / role_search_fts are
// REGENERABLE projections — every candidate they propose is re-joined
// against rdd_roles / rdd_boundaries / grants-backed visibility before it
// can appear in a result. FTS rows alone never answer a query.
//
// IMP-05 owns the write side of those projections and the model index
// helpers; this file only SELECTs from the shared schema v1 tables. If
// IMP-05's landed handoff exports a richer territory/index API the query
// internals here can delegate to it without changing the wire contract.

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import { discoveryError } from './types.ts'
import type { BoundarySummary, CriterionSummary, RoleSummary } from './types.ts'

// ---------------------------------------------------------------------------
// raw row shapes — spec/storage.md §3 column names
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: string
  name: string
  active_model_version: string | null
  revision: number
}
export interface ModelVersionRow {
  id: string
  project_id: string
  root_boundary_id: string | null
  status: 'draft' | 'published' | 'superseded'
  digest: string | null
}
export interface BoundaryRow {
  id: string
  name: string
  responsibility_statement: string
}
export interface CriterionRow {
  id: string
  criterion: string
  description: string
  ordinal: number
}
export interface RoleRow {
  id: string
  name: string
  description: string
  boundary_id: string
  horizontal_role_name: string
}
export interface BoundaryPathRow {
  boundary_id: string
  path: string
  kind: 'file' | 'directory'
}
export interface ContractRow {
  id: string
  name: string
  schema_path: string
  provider_boundary_id: string
}
export interface MemberRow {
  id: string
  run_id: string
  model_version: string
  role_id: string
  implementation_id: string
  implementation_revision: number
  generation: number
  state: string
}
export interface RoleImplementationRow {
  id: string
  revision: number
  interface_digest: string
  profile_id: string
  profile_revision: number
  status: string
  maintainer_role_id: string
}
export interface HarnessProfileRow {
  id: string
  revision: number
  state: string
  recipe_json: string
  capabilities_json: string
}

function rows<T>(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[]
}
function row<T>(
  db: DatabaseSync,
  sql: string,
  ...params: (string | number | null)[]
): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

// ---------------------------------------------------------------------------
// model resolution — every query pins one snapshot
// ---------------------------------------------------------------------------

export interface ResolvedModel {
  id: string
  /** true when the pinned version is not the project's active one */
  stale: boolean
  status: ModelVersionRow['status']
}

/**
 * Resolve the snapshot to query: the explicit modelVersion when given
 * (validated to belong to the project), else the project's active model.
 * Draft snapshots are never searchable — IMP-05's projections are only
 * built inside the publication transaction (storage.md §5).
 */
export function resolveModelVersion(
  db: DatabaseSync,
  projectId: string,
  requested?: string
): ResolvedModel {
  const project = row<ProjectRow>(
    db,
    'SELECT id, name, active_model_version, revision FROM projects WHERE id = ?',
    projectId
  )
  if (project === undefined)
    throw discoveryError('SCOPE_DENIED', 'project not visible or unknown', { projectId })

  if (requested !== undefined) {
    const mv = row<ModelVersionRow>(
      db,
      'SELECT id, project_id, root_boundary_id, status, digest FROM model_versions WHERE id = ?',
      requested
    )
    // a version outside this project is reported as invalid, not missing —
    // the caller's pin just can't be satisfied (no cross-project leak)
    if (mv === undefined || mv.project_id !== projectId)
      throw discoveryError('MODEL_INVALID', 'modelVersion does not belong to project', {
        projectId,
        modelVersion: requested
      })
    if (mv.status === 'draft')
      throw discoveryError('MODEL_INVALID', 'draft model snapshots are not searchable', {
        modelVersion: requested
      })
    return {
      id: mv.id,
      status: mv.status,
      stale: project.active_model_version !== mv.id
    }
  }

  if (project.active_model_version === null)
    throw discoveryError('MODEL_INVALID', 'project has no published model', { projectId })
  const mv = row<ModelVersionRow>(
    db,
    'SELECT id, project_id, root_boundary_id, status, digest FROM model_versions WHERE id = ?',
    project.active_model_version
  )
  if (mv === undefined)
    throw discoveryError('MODEL_INVALID', 'active model version is missing', {
      projectId,
      modelVersion: project.active_model_version
    })
  return { id: mv.id, status: mv.status, stale: false }
}

// ---------------------------------------------------------------------------
// path normalization — PathRef rules: repo-relative, no NUL/abs/.. escapes
// ---------------------------------------------------------------------------

export interface NormalizedPath {
  path: string
  /** caller marked it a directory (trailing '/') — hints cover matching */
  dirHint: boolean
}

export function normalizeRepoPath(raw: string): NormalizedPath {
  if (typeof raw !== 'string' || raw.length === 0)
    throw discoveryError('MODEL_INVALID', 'empty path', { path: raw })
  if (raw.includes('\0')) throw discoveryError('MODEL_INVALID', 'path contains NUL', { path: raw })
  if (raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw))
    throw discoveryError('MODEL_INVALID', 'absolute paths are not repo-relative', { path: raw })
  const dirHint = raw.endsWith('/')
  const out: string[] = []
  for (const seg of raw.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0)
        throw discoveryError('MODEL_INVALID', 'path escapes the repository root', {
          path: raw
        })
      out.pop()
      continue
    }
    out.push(seg)
  }
  if (out.length === 0)
    throw discoveryError('MODEL_INVALID', 'path resolves to the repository root', {
      path: raw
    })
  return { path: out.join('/'), dirHint }
}

/** safe normalize for per-path diagnostics — never throws */
export function tryNormalizeRepoPath(raw: string): NormalizedPath | null {
  try {
    return normalizeRepoPath(raw)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// territory — declared boundary_paths claims against a normalized path
// ---------------------------------------------------------------------------

export interface PathClaim {
  boundaryId: string
  matchedPath: string
  /** 'owns' competes for deepest; 'covers' is informational under a dir query */
  claim: 'owns' | 'covers'
  /** for 'owns': length of the matched boundary path (deeper wins) */
  depth: number
}

/**
 * Every boundary claiming `np`:
 *   owns   — exact file match, or directory claim equal to / ancestor of np
 *   covers — the boundary's declared paths sit strictly under np (np is a
 *            directory scope the boundary partially covers)
 * Visibility filtering is the caller's job — this is the raw index read.
 */
export function claimantsForPath(
  db: DatabaseSync,
  modelVersion: string,
  np: NormalizedPath
): PathClaim[] {
  const claims: PathClaim[] = []
  const seen = new Map<string, PathClaim>()
  for (const p of rows<BoundaryPathRow>(
    db,
    'SELECT boundary_id, path, kind FROM boundary_paths WHERE model_version = ?',
    modelVersion
  )) {
    let claim: PathClaim | null = null
    if (p.kind === 'file') {
      if (p.path === np.path)
        claim = {
          boundaryId: p.boundary_id,
          matchedPath: p.path,
          claim: 'owns',
          depth: p.path.length
        }
      else if (p.path.startsWith(np.path + '/'))
        claim = {
          boundaryId: p.boundary_id,
          matchedPath: p.path,
          claim: 'covers',
          depth: np.path.length
        }
    } else {
      // directory claim
      if (np.path === p.path || np.path.startsWith(p.path + '/'))
        claim = {
          boundaryId: p.boundary_id,
          matchedPath: p.path,
          claim: 'owns',
          depth: p.path.length
        }
      else if (p.path.startsWith(np.path + '/'))
        claim = {
          boundaryId: p.boundary_id,
          matchedPath: p.path,
          claim: 'covers',
          depth: np.path.length
        }
    }
    if (claim !== null) {
      const prev = seen.get(claim.boundaryId)
      // a boundary may own several matching paths — keep the deepest claim
      if (prev === undefined || claim.depth > prev.depth) seen.set(claim.boundaryId, claim)
    }
  }
  claims.push(...seen.values())
  return claims
}

// ---------------------------------------------------------------------------
// tree — boundary_edges (child_id → parent_id, single-parent tree)
// ---------------------------------------------------------------------------

/** inclusive descendant set of `rootId` inside the model's contains-tree */
export function boundarySubtree(
  db: DatabaseSync,
  modelVersion: string,
  rootId: string
): Set<string> {
  const out = new Set<string>()
  for (const r of rows<{ id: string }>(
    db,
    `WITH RECURSIVE sub(id) AS (
       SELECT ? AS id
       UNION
       SELECT e.child_id FROM boundary_edges e JOIN sub s ON e.parent_id = s.id
       WHERE e.model_version = ?
     ) SELECT id FROM sub`,
    rootId,
    modelVersion
  ))
    out.add(r.id)
  return out
}

/** ancestor chain of `id`, immediate parent first — excludes `id` itself */
export function ancestorsOf(db: DatabaseSync, modelVersion: string, id: string): string[] {
  return rows<{ parent_id: string }>(
    db,
    `WITH RECURSIVE anc(id) AS (
       SELECT parent_id AS id FROM boundary_edges
       WHERE model_version = ? AND child_id = ?
       UNION
       SELECT e.parent_id FROM boundary_edges e JOIN anc a ON e.child_id = a.id
       WHERE e.model_version = ?
     ) SELECT id AS parent_id FROM anc`,
    modelVersion,
    id,
    modelVersion
  ).map((r) => r.parent_id)
}

export function childrenOf(db: DatabaseSync, modelVersion: string, id: string): string[] {
  return rows<{ child_id: string }>(
    db,
    'SELECT child_id FROM boundary_edges WHERE model_version = ? AND parent_id = ?',
    modelVersion,
    id
  ).map((r) => r.child_id)
}

export function parentOf(db: DatabaseSync, modelVersion: string, id: string): string | undefined {
  return row<{ parent_id: string }>(
    db,
    'SELECT parent_id FROM boundary_edges WHERE model_version = ? AND child_id = ?',
    modelVersion,
    id
  )?.parent_id
}

// ---------------------------------------------------------------------------
// boundary / role summaries — 팀장 resolution: statements, criteria, 책무
// ---------------------------------------------------------------------------

export function getBoundary(
  db: DatabaseSync,
  modelVersion: string,
  id: string
): BoundaryRow | undefined {
  return row<BoundaryRow>(
    db,
    'SELECT id, name, responsibility_statement FROM rdd_boundaries WHERE model_version = ? AND id = ?',
    modelVersion,
    id
  )
}

export function listCriteria(
  db: DatabaseSync,
  modelVersion: string,
  boundaryId: string
): CriterionRow[] {
  return rows<CriterionRow>(
    db,
    'SELECT id, criterion, description, ordinal FROM rdd_criteria WHERE model_version = ? AND boundary_id = ? ORDER BY ordinal',
    modelVersion,
    boundaryId
  )
}

export function getRole(db: DatabaseSync, modelVersion: string, id: string): RoleRow | undefined {
  return row<RoleRow>(
    db,
    'SELECT id, name, description, boundary_id, horizontal_role_name FROM rdd_roles WHERE model_version = ? AND id = ?',
    modelVersion,
    id
  )
}

export function listRoles(db: DatabaseSync, modelVersion: string, boundaryId?: string): RoleRow[] {
  if (boundaryId === undefined)
    return rows<RoleRow>(
      db,
      'SELECT id, name, description, boundary_id, horizontal_role_name FROM rdd_roles WHERE model_version = ?',
      modelVersion
    )
  return rows<RoleRow>(
    db,
    'SELECT id, name, description, boundary_id, horizontal_role_name FROM rdd_roles WHERE model_version = ? AND boundary_id = ?',
    modelVersion,
    boundaryId
  )
}

export function boundarySummary(
  db: DatabaseSync,
  modelVersion: string,
  b: BoundaryRow
): BoundarySummary {
  return {
    id: b.id,
    name: b.name,
    responsibility: b.responsibility_statement,
    criteria: listCriteria(db, modelVersion, b.id).map((c): CriterionSummary => ({
      id: c.id,
      criterion: c.criterion,
      description: c.description,
      ordinal: c.ordinal
    }))
  }
}

export function roleSummary(r: RoleRow): RoleSummary {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    horizontalRole: r.horizontal_role_name
  }
}

/** content digest of the role row — the "roleRevision" pin for tokens */
export function roleDigest(r: RoleRow, modelVersion: string): string {
  return sha256Hex(
    JSON.stringify({
      mv: modelVersion,
      id: r.id,
      name: r.name,
      description: r.description,
      boundaryId: r.boundary_id,
      horizontalRole: r.horizontal_role_name
    })
  )
}

// ---------------------------------------------------------------------------
// contracts
// ---------------------------------------------------------------------------

export interface ContractRelation {
  contract: ContractRow
  consumerBoundaryIds: string[]
}

export function listContractRelations(db: DatabaseSync, modelVersion: string): ContractRelation[] {
  const contracts = rows<ContractRow>(
    db,
    'SELECT id, name, schema_path, provider_boundary_id FROM rdd_contracts WHERE model_version = ?',
    modelVersion
  )
  const consumers = rows<{ contract_id: string; consumer_boundary_id: string }>(
    db,
    'SELECT contract_id, consumer_boundary_id FROM contract_consumers WHERE model_version = ?',
    modelVersion
  )
  const byContract = new Map<string, string[]>()
  for (const c of consumers) {
    const list = byContract.get(c.contract_id) ?? []
    list.push(c.consumer_boundary_id)
    byContract.set(c.contract_id, list)
  }
  return contracts.map((c) => ({
    contract: c,
    consumerBoundaryIds: byContract.get(c.id) ?? []
  }))
}

// ---------------------------------------------------------------------------
// contexts / non-goals / interfaces — refs only, bodies never read here
// ---------------------------------------------------------------------------

export function boundaryContextPaths(
  db: DatabaseSync,
  modelVersion: string,
  boundaryId: string
): string[] {
  return rows<{ path: string }>(
    db,
    `SELECT c.path FROM boundary_contexts bc
     JOIN rdd_contexts c ON c.model_version = bc.model_version AND c.id = bc.context_id
     WHERE bc.model_version = ? AND bc.boundary_id = ? ORDER BY c.path`,
    modelVersion,
    boundaryId
  ).map((r) => r.path)
}

export function listNonGoals(
  db: DatabaseSync,
  modelVersion: string,
  boundaryId: string
): { id: string; statement: string }[] {
  return rows<{ id: string; statement: string }>(
    db,
    'SELECT id, statement FROM rdd_non_goals WHERE model_version = ? AND boundary_id = ?',
    modelVersion,
    boundaryId
  )
}

/** stored interface digests for a role in a model (normally exactly one) */
export function interfaceDigestsForRole(
  db: DatabaseSync,
  modelVersion: string,
  roleId: string
): string[] {
  return rows<{ digest: string }>(
    db,
    'SELECT digest FROM role_interfaces WHERE model_version = ? AND role_id = ?',
    modelVersion,
    roleId
  ).map((r) => r.digest)
}

export interface InterfaceRequirementRow {
  digest: string
  requirements: unknown[]
}

export function interfaceRequirementsForBoundaryRoles(
  db: DatabaseSync,
  modelVersion: string,
  boundaryId: string
): InterfaceRequirementRow[] {
  return rows<{ digest: string; requirements_json: string }>(
    db,
    `SELECT i.digest, i.requirements_json FROM role_interfaces i
     JOIN rdd_roles r ON r.model_version = i.model_version AND r.id = i.role_id
     WHERE i.model_version = ? AND r.boundary_id = ?`,
    modelVersion,
    boundaryId
  ).map((r) => {
    let requirements: unknown[] = []
    try {
      const parsed = JSON.parse(r.requirements_json) as unknown
      if (Array.isArray(parsed)) requirements = parsed
    } catch {
      // a malformed JSON column is a data defect — surface as no clauses
    }
    return { digest: r.digest, requirements }
  })
}

// ---------------------------------------------------------------------------
// implementations / profiles — publication metadata only (no bodies)
// ---------------------------------------------------------------------------

export function implementationsForDigests(
  db: DatabaseSync,
  interfaceDigests: string[]
): RoleImplementationRow[] {
  if (interfaceDigests.length === 0) return []
  const marks = interfaceDigests.map(() => '?').join(',')
  return rows<RoleImplementationRow>(
    db,
    `SELECT id, revision, interface_digest, profile_id, profile_revision, status, maintainer_role_id
     FROM role_implementations WHERE interface_digest IN (${marks})
     ORDER BY id, revision`,
    ...interfaceDigests
  )
}

export function getProfile(
  db: DatabaseSync,
  id: string,
  revision: number
): HarnessProfileRow | undefined {
  return row<HarnessProfileRow>(
    db,
    'SELECT id, revision, state, recipe_json, capabilities_json FROM harness_profiles WHERE id = ? AND revision = ?',
    id,
    revision
  )
}

/** latest support attestation decision for a profile revision, if any */
export function latestAttestation(
  db: DatabaseSync,
  profileId: string,
  profileRevision: number
): { decision: string; installation_json: string } | undefined {
  return row<{ decision: string; installation_json: string }>(
    db,
    `SELECT decision, installation_json FROM support_attestations
     WHERE profile_id = ? AND profile_revision = ?
     ORDER BY rowid DESC LIMIT 1`,
    profileId,
    profileRevision
  )
}

export function componentKindsForImpl(
  db: DatabaseSync,
  implementationId: string,
  implementationRevision: number
): string[] {
  return rows<{ kind: string }>(
    db,
    'SELECT DISTINCT kind FROM implementation_components WHERE implementation_id = ? AND implementation_revision = ?',
    implementationId,
    implementationRevision
  ).map((r) => r.kind)
}

// ---------------------------------------------------------------------------
// members — current assignment status (members of THIS model snapshot)
// ---------------------------------------------------------------------------

export function membersForRole(
  db: DatabaseSync,
  modelVersion: string,
  roleId: string,
  projectId: string
): (MemberRow & { project_id: string })[] {
  return rows<MemberRow & { project_id: string }>(
    db,
    `SELECT m.id, m.run_id, m.model_version, m.role_id, m.implementation_id,
            m.implementation_revision, m.generation, m.state, r.project_id
     FROM members m JOIN runs r ON r.id = m.run_id
     WHERE m.model_version = ? AND m.role_id = ? AND m.state != 'retired'
       AND r.project_id = ?`,
    modelVersion,
    roleId,
    projectId
  )
}

export function membersForRoleInRun(db: DatabaseSync, runId: string, roleId: string): MemberRow[] {
  return rows<MemberRow>(
    db,
    `SELECT id, run_id, model_version, role_id, implementation_id,
            implementation_revision, generation, state
     FROM members WHERE run_id = ? AND role_id = ? AND state != 'retired'`,
    runId,
    roleId
  )
}

export function latestAssignmentKind(
  db: DatabaseSync,
  memberId: string
): 'coordination' | 'task' | undefined {
  const r = row<{ kind: string }>(
    db,
    'SELECT kind FROM assignments WHERE member_id = ? ORDER BY revision DESC LIMIT 1',
    memberId
  )
  return r?.kind === 'coordination' || r?.kind === 'task' ? r.kind : undefined
}

export function getRun(
  db: DatabaseSync,
  runId: string
): { id: string; project_id: string; model_version: string; state: string } | undefined {
  return row<{ id: string; project_id: string; model_version: string; state: string }>(
    db,
    'SELECT id, project_id, model_version, state FROM runs WHERE id = ?',
    runId
  )
}

// ---------------------------------------------------------------------------
// snapshot marker + visibility digest (S-COMMON QueryResult, storage §6)
// ---------------------------------------------------------------------------

/** monotonic position of the domain log — the snapshot marker on results */
export function eventHighWater(db: DatabaseSync): number {
  const r = row<{ s: number | null }>(db, 'SELECT MAX(sequence) AS s FROM domain_events')
  return r?.s ?? 0
}

/** digest of what pins the caller's visibility for cursor binding */
export function visibilityDigest(ctx: AuthenticatedContext, modelVersion: string): string {
  return sha256Hex(
    JSON.stringify({
      p: ctx.principalId,
      g: ctx.grantRevisions,
      mv: modelVersion
    })
  )
}
