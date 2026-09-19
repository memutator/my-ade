// mahas-runtime/model — versioned RDD aggregate storage (spec/domains/rdd.md,
// spec/storage.md §3).
//
// A ModelVersion's payload is the set of rdd_* rows keyed by model_version:
// boundaries (each with its single responsibility_statement), criteria,
// boundary_paths, boundary_edges (contains tree), horizontal_roles, rdd_roles,
// rdd_contexts (path only — bodies stay in the authored files), boundary/
// horizontal context links, rdd_contracts + contract_consumers, rdd_non_goals.
// `role_search_rows` (+ the role_search_fts mirror) is a regenerable projection
// built in the SAME write transaction as the publication (D-RDD §4).
//
// This module is pure row IO + the in-memory snapshot shape the change-set,
// structural rules and publisher all work on. Published payloads are never
// mutated: a change materializes a new model_version row set (S-COMMON §6).

import type { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../storage/db.ts'
import type { ModelChange, ModelVersion, Project } from '../../../mahas-contracts/src/rdd.ts'

/* ------------------------------------------------------------------ */
/* In-memory snapshot — the unit edits apply to and rules validate.    */
/* ------------------------------------------------------------------ */

export interface SnapshotCriterion {
  id: string
  criterion: string
  description: string
  ordinal: number
}

export interface SnapshotPath {
  path: string
  kind: 'file' | 'directory'
}

export interface SnapshotBoundary {
  id: string
  name: string
  /** single responsibility declaration — one per boundary, never a list */
  responsibilityStatement: string
  /** null = this boundary claims the root slot (publish requires exactly one) */
  parentId: string | null
  paths: SnapshotPath[]
  criteria: SnapshotCriterion[]
  contextIds: string[]
}

export interface SnapshotContract {
  id: string
  name: string
  schemaPath: string
  providerBoundaryId: string
  consumerBoundaryIds: string[]
}

export interface SnapshotRole {
  id: string
  name: string
  /** professional duty for joint-responsibility formation — not a task brief */
  description: string
  boundaryId: string
  horizontalRoleName: string
}

export interface SnapshotContext {
  id: string
  /** repo-relative path only — the document body stays in the file */
  path: string
}

export interface SnapshotNonGoal {
  id: string
  boundaryId: string
  statement: string
}

export interface SnapshotHorizontalRole {
  name: string
  contextIds: string[]
}

/**
 * The whole versioned RDD payload of one model_version, materialized.
 * Maps (not arrays) so edits are O(1) lookups; serialization sorts keys so
 * digests are deterministic.
 */
export interface ModelSnapshot {
  goal: string
  boundaries: Map<string, SnapshotBoundary>
  horizontalRoles: Map<string, SnapshotHorizontalRole>
  roles: Map<string, SnapshotRole>
  contexts: Map<string, SnapshotContext>
  contracts: Map<string, SnapshotContract>
  nonGoals: Map<string, SnapshotNonGoal>
}

export function emptySnapshot(goal: string): ModelSnapshot {
  return {
    goal,
    boundaries: new Map(),
    horizontalRoles: new Map(),
    roles: new Map(),
    contexts: new Map(),
    contracts: new Map(),
    nonGoals: new Map()
  }
}

export function cloneSnapshot(s: ModelSnapshot): ModelSnapshot {
  return structuredClone(s)
}

/** the single parentless boundary id, or null when there is not exactly one */
export function rootBoundaryIdOf(s: ModelSnapshot): string | null {
  let root: string | null = null
  for (const b of s.boundaries.values()) {
    if (b.parentId === null) {
      if (root !== null) return null // more than one — structural error
      root = b.id
    }
  }
  return root
}

/* ------------------------------------------------------------------ */
/* Canonical payload — the digest basis and the snapshot op response.  */
/* ------------------------------------------------------------------ */

/** plain-object, key-sorted serialization of a snapshot — deterministic */
export function snapshotPayload(s: ModelSnapshot): Record<string, unknown> {
  const sortIds = (m: Map<string, unknown>): string[] => [...m.keys()].sort()
  return {
    goal: s.goal,
    boundaries: sortIds(s.boundaries).map((id) => {
      const b = s.boundaries.get(id)!
      return {
        id: b.id,
        name: b.name,
        responsibilityStatement: b.responsibilityStatement,
        parentId: b.parentId,
        paths: [...b.paths].sort((x, y) => x.path.localeCompare(y.path)),
        criteria: [...b.criteria].sort((x, y) => x.ordinal - y.ordinal),
        contextIds: [...b.contextIds].sort()
      }
    }),
    horizontalRoles: sortIds(s.horizontalRoles).map((name) => {
      const h = s.horizontalRoles.get(name)!
      return { name: h.name, contextIds: [...h.contextIds].sort() }
    }),
    roles: sortIds(s.roles).map((id) => ({ ...s.roles.get(id)! })),
    contexts: sortIds(s.contexts).map((id) => ({ ...s.contexts.get(id)! })),
    contracts: sortIds(s.contracts).map((id) => {
      const c = s.contracts.get(id)!
      return {
        id: c.id,
        name: c.name,
        schemaPath: c.schemaPath,
        providerBoundaryId: c.providerBoundaryId,
        consumerBoundaryIds: [...c.consumerBoundaryIds].sort()
      }
    }),
    nonGoals: sortIds(s.nonGoals).map((id) => ({ ...s.nonGoals.get(id)! }))
  }
}

/** canonical JSON — sorted object keys at every depth */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

/** sha-256 over the canonical snapshot payload — the model_versions.digest */
export function snapshotDigest(s: ModelSnapshot): string {
  return sha256Hex(canonicalJson(snapshotPayload(s)))
}

/* ------------------------------------------------------------------ */
/* Row ↔ snapshot loading                                              */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v)
}

export function loadProject(db: DatabaseSync, projectId: string): Project | null {
  const r = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as Row | undefined
  if (!r) return null
  return {
    id: str(r.id),
    name: str(r.name),
    goal: str(r.goal),
    repositoryRoot: str(r.repository_root),
    activeModelVersion: r.active_model_version === null ? null : str(r.active_model_version),
    revision: num(r.revision)
  } as Project
}

export function findProjectByRoot(db: DatabaseSync, repositoryRoot: string): Project | null {
  const r = db.prepare('SELECT * FROM projects WHERE repository_root=?').get(repositoryRoot) as
    Row | undefined
  if (!r) return null
  return loadProject(db, str(r.id))
}

export function insertProject(db: DatabaseSync, p: Project): void {
  db.prepare(
    'INSERT INTO projects(id,name,goal,repository_root,active_model_version,revision) VALUES(?,?,?,?,?,?)'
  ).run(p.id, p.name, p.goal, p.repositoryRoot, p.activeModelVersion ?? null, p.revision)
}

export function loadModelVersion(db: DatabaseSync, versionId: string): ModelVersion | null {
  const r = db.prepare('SELECT * FROM model_versions WHERE id=?').get(versionId) as Row | undefined
  if (!r) return null
  return {
    id: str(r.id),
    projectId: str(r.project_id),
    parentVersion: r.parent_version === null ? null : str(r.parent_version),
    rootBoundaryId: r.root_boundary_id === null ? null : str(r.root_boundary_id),
    goalSnapshot: str(r.goal_snapshot),
    status: str(r.status),
    digest: r.digest === null ? null : str(r.digest),
    createdAt: num(r.created_at)
  } as ModelVersion
}

/** materialize one version's full RDD payload; null when the version is absent */
export function loadSnapshot(db: DatabaseSync, modelVersionId: string): ModelSnapshot | null {
  const v = loadModelVersion(db, modelVersionId)
  if (!v) return null
  const s = emptySnapshot(v.goalSnapshot)

  for (const r of all(
    db,
    'SELECT * FROM rdd_boundaries WHERE model_version=? ORDER BY id',
    modelVersionId
  )) {
    s.boundaries.set(str(r.id), {
      id: str(r.id),
      name: str(r.name),
      responsibilityStatement: str(r.responsibility_statement),
      parentId: null, // filled from boundary_edges below
      paths: [],
      criteria: [],
      contextIds: []
    })
  }
  for (const r of all(
    db,
    'SELECT * FROM boundary_edges WHERE model_version=? ORDER BY child_id',
    modelVersionId
  )) {
    const b = s.boundaries.get(str(r.child_id))
    if (b) b.parentId = str(r.parent_id)
  }
  for (const r of all(
    db,
    'SELECT * FROM boundary_paths WHERE model_version=? ORDER BY path',
    modelVersionId
  )) {
    const b = s.boundaries.get(str(r.boundary_id))
    if (b) b.paths.push({ path: str(r.path), kind: str(r.kind) as 'file' | 'directory' })
  }
  for (const r of all(
    db,
    'SELECT * FROM rdd_criteria WHERE model_version=? ORDER BY boundary_id, ordinal',
    modelVersionId
  )) {
    const b = s.boundaries.get(str(r.boundary_id))
    if (b)
      b.criteria.push({
        id: str(r.id),
        criterion: str(r.criterion),
        description: str(r.description),
        ordinal: num(r.ordinal)
      })
  }
  for (const r of all(
    db,
    'SELECT * FROM horizontal_roles WHERE model_version=? ORDER BY name',
    modelVersionId
  )) {
    s.horizontalRoles.set(str(r.name), { name: str(r.name), contextIds: [] })
  }
  for (const r of all(
    db,
    'SELECT * FROM rdd_contexts WHERE model_version=? ORDER BY id',
    modelVersionId
  )) {
    s.contexts.set(str(r.id), { id: str(r.id), path: str(r.path) })
  }
  for (const r of all(
    db,
    'SELECT * FROM boundary_contexts WHERE model_version=? ORDER BY boundary_id, context_id',
    modelVersionId
  )) {
    s.boundaries.get(str(r.boundary_id))?.contextIds.push(str(r.context_id))
  }
  for (const r of all(
    db,
    'SELECT * FROM horizontal_contexts WHERE model_version=? ORDER BY horizontal_role_name, context_id',
    modelVersionId
  )) {
    s.horizontalRoles.get(str(r.horizontal_role_name))?.contextIds.push(str(r.context_id))
  }
  for (const r of all(
    db,
    'SELECT * FROM rdd_roles WHERE model_version=? ORDER BY id',
    modelVersionId
  )) {
    s.roles.set(str(r.id), {
      id: str(r.id),
      name: str(r.name),
      description: str(r.description),
      boundaryId: str(r.boundary_id),
      horizontalRoleName: str(r.horizontal_role_name)
    })
  }
  for (const r of all(
    db,
    'SELECT * FROM rdd_contracts WHERE model_version=? ORDER BY id',
    modelVersionId
  )) {
    s.contracts.set(str(r.id), {
      id: str(r.id),
      name: str(r.name),
      schemaPath: str(r.schema_path),
      providerBoundaryId: str(r.provider_boundary_id),
      consumerBoundaryIds: []
    })
  }
  for (const r of all(
    db,
    'SELECT * FROM contract_consumers WHERE model_version=? ORDER BY contract_id, consumer_boundary_id',
    modelVersionId
  )) {
    s.contracts.get(str(r.contract_id))?.consumerBoundaryIds.push(str(r.consumer_boundary_id))
  }
  for (const r of all(
    db,
    'SELECT * FROM rdd_non_goals WHERE model_version=? ORDER BY id',
    modelVersionId
  )) {
    s.nonGoals.set(str(r.id), {
      id: str(r.id),
      boundaryId: str(r.boundary_id),
      statement: str(r.statement)
    })
  }
  return s
}

function all(db: DatabaseSync, sql: string, ...args: string[]): Row[] {
  return db.prepare(sql).all(...args) as Row[]
}

/* ------------------------------------------------------------------ */
/* Writing a whole version payload (draft insert or publish insert)    */
/* ------------------------------------------------------------------ */

/**
 * Insert model_versions + every rdd_* row for a snapshot. Never UPDATEs an
 * existing version — publication is a new row set (S-COMMON §6).
 */
export function insertSnapshot(
  db: DatabaseSync,
  versionId: string,
  projectId: string,
  parentVersion: string | null,
  snapshot: ModelSnapshot,
  status: 'draft' | 'published',
  createdAt: number
): { digest: string; rootBoundaryId: string | null } {
  const digest = snapshotDigest(snapshot)
  const rootBoundaryId = status === 'published' ? rootBoundaryIdOf(snapshot) : null
  db.prepare(
    `INSERT INTO model_versions(id,project_id,parent_version,root_boundary_id,goal_snapshot,status,digest,created_at)
     VALUES(?,?,?,?,?,?,?,?)`
  ).run(
    versionId,
    projectId,
    parentVersion,
    rootBoundaryId,
    snapshot.goal,
    status,
    digest,
    createdAt
  )

  const insB = db.prepare(
    'INSERT INTO rdd_boundaries(model_version,id,name,responsibility_statement) VALUES(?,?,?,?)'
  )
  const insCrit = db.prepare(
    'INSERT INTO rdd_criteria(model_version,boundary_id,id,criterion,description,ordinal) VALUES(?,?,?,?,?,?)'
  )
  const insPath = db.prepare(
    'INSERT INTO boundary_paths(model_version,boundary_id,path,kind) VALUES(?,?,?,?)'
  )
  const insEdge = db.prepare(
    'INSERT INTO boundary_edges(model_version,child_id,parent_id) VALUES(?,?,?)'
  )
  const insBC = db.prepare(
    'INSERT INTO boundary_contexts(model_version,boundary_id,context_id) VALUES(?,?,?)'
  )
  for (const b of [...snapshot.boundaries.values()].sort((x, y) => x.id.localeCompare(y.id))) {
    insB.run(versionId, b.id, b.name, b.responsibilityStatement)
    if (b.parentId !== null) insEdge.run(versionId, b.id, b.parentId)
    for (const p of b.paths) insPath.run(versionId, b.id, p.path, p.kind)
    for (const c of b.criteria)
      insCrit.run(versionId, b.id, c.id, c.criterion, c.description, c.ordinal)
    for (const cx of b.contextIds) insBC.run(versionId, b.id, cx)
  }

  const insH = db.prepare('INSERT INTO horizontal_roles(model_version,name) VALUES(?,?)')
  const insHC = db.prepare(
    'INSERT INTO horizontal_contexts(model_version,horizontal_role_name,context_id) VALUES(?,?,?)'
  )
  for (const h of [...snapshot.horizontalRoles.values()].sort((x, y) =>
    x.name.localeCompare(y.name)
  )) {
    insH.run(versionId, h.name)
    for (const cx of h.contextIds) insHC.run(versionId, h.name, cx)
  }

  const insCx = db.prepare('INSERT INTO rdd_contexts(model_version,id,path) VALUES(?,?,?)')
  for (const c of [...snapshot.contexts.values()].sort((x, y) => x.id.localeCompare(y.id))) {
    insCx.run(versionId, c.id, c.path)
  }

  const insR = db.prepare(
    `INSERT INTO rdd_roles(model_version,id,name,description,boundary_id,horizontal_role_name)
     VALUES(?,?,?,?,?,?)`
  )
  for (const r of [...snapshot.roles.values()].sort((x, y) => x.id.localeCompare(y.id))) {
    insR.run(versionId, r.id, r.name, r.description, r.boundaryId, r.horizontalRoleName)
  }

  const insC = db.prepare(
    'INSERT INTO rdd_contracts(model_version,id,name,schema_path,provider_boundary_id) VALUES(?,?,?,?,?)'
  )
  const insCC = db.prepare(
    'INSERT INTO contract_consumers(model_version,contract_id,consumer_boundary_id) VALUES(?,?,?)'
  )
  for (const c of [...snapshot.contracts.values()].sort((x, y) => x.id.localeCompare(y.id))) {
    insC.run(versionId, c.id, c.name, c.schemaPath, c.providerBoundaryId)
    for (const consumer of c.consumerBoundaryIds) insCC.run(versionId, c.id, consumer)
  }

  const insNG = db.prepare(
    'INSERT INTO rdd_non_goals(model_version,id,boundary_id,statement) VALUES(?,?,?,?)'
  )
  for (const n of [...snapshot.nonGoals.values()].sort((x, y) => x.id.localeCompare(y.id))) {
    insNG.run(versionId, n.id, n.boundaryId, n.statement)
  }

  return { digest, rootBoundaryId }
}

/* ------------------------------------------------------------------ */
/* projects.active_model_version CAS + version status transitions      */
/* ------------------------------------------------------------------ */

/**
 * Compare-and-swap the active pointer. `expected === null` means "no active
 * version" (IS NULL). Returns false → caller reports STALE_REVISION.
 * Also moves the project's current goal to the published goalSnapshot.
 */
export function casActiveModelVersion(
  db: DatabaseSync,
  projectId: string,
  expected: string | null,
  next: string,
  goal: string
): boolean {
  const r = db
    .prepare(
      `UPDATE projects
         SET active_model_version=?, goal=?, revision=revision+1
       WHERE id=? AND active_model_version IS ?`
    )
    .run(next, goal, projectId, expected)
  return Number(r.changes) === 1
}

export function setVersionStatus(
  db: DatabaseSync,
  versionId: string,
  status: 'draft' | 'published' | 'superseded'
): void {
  db.prepare('UPDATE model_versions SET status=? WHERE id=?').run(status, versionId)
}

/* ------------------------------------------------------------------ */
/* model_changes — prepared/committed/rejected candidates              */
/* ------------------------------------------------------------------ */

/**
 * Storage-row shape of the C-MODEL ModelChange contract object (IMP-02 owns
 * the canonical type — edits/touchedTargets/diagnostics are the parsed JSON
 * columns of model_changes). `state` lifecycle: prepared → committed|rejected.
 */
export type StoredModelChange = ModelChange

export interface ModelChangeRow {
  id: string
  projectId: string
  baseVersion: string
  candidateDigest: string
  state: 'prepared' | 'committed' | 'rejected'
  edits: unknown[]
  touchedTargets: unknown[]
  diagnostics: unknown
}

export function loadModelChange(db: DatabaseSync, changeId: string): StoredModelChange | null {
  const r = db.prepare('SELECT * FROM model_changes WHERE id=?').get(changeId) as Row | undefined
  if (!r) return null
  const row: ModelChangeRow = {
    id: str(r.id),
    projectId: str(r.project_id),
    baseVersion: str(r.base_version),
    candidateDigest: str(r.candidate_digest),
    state: str(r.state) as ModelChangeRow['state'],
    edits: JSON.parse(str(r.edits_json)) as unknown[],
    touchedTargets: JSON.parse(str(r.touched_targets_json)) as unknown[],
    diagnostics: JSON.parse(str(r.diagnostics_json))
  }
  return row as unknown as StoredModelChange
}

/** fields the writers below rely on — decoupled from ModelChange's exact
 * field typing until IMP-02 lands; names follow the camelCase DDL convention */
export function changeFields(c: StoredModelChange): ModelChangeRow {
  return c as unknown as ModelChangeRow
}

export function insertModelChange(db: DatabaseSync, c: StoredModelChange): void {
  const f = changeFields(c)
  db.prepare(
    `INSERT INTO model_changes(id,project_id,base_version,candidate_digest,state,edits_json,touched_targets_json,diagnostics_json)
     VALUES(?,?,?,?,?,?,?,?)`
  ).run(
    f.id,
    f.projectId,
    f.baseVersion,
    f.candidateDigest,
    f.state,
    canonicalJson(f.edits),
    canonicalJson(f.touchedTargets),
    canonicalJson(f.diagnostics)
  )
}

export function updateModelChange(
  db: DatabaseSync,
  changeId: string,
  state: ModelChangeRow['state'],
  diagnostics: unknown
): void {
  db.prepare('UPDATE model_changes SET state=?, diagnostics_json=? WHERE id=?').run(
    state,
    canonicalJson(diagnostics),
    changeId
  )
}

/* ------------------------------------------------------------------ */
/* impact_candidates + role_search_rows are written by the IMP-05      */
/* ports (`./impact-candidates.ts` computeModelImpact, `./indices.ts`  */
/* writeSearchProjection) inside the same publication transaction —    */
/* publisher.ts calls them; this file does not duplicate them.         */
/* ------------------------------------------------------------------ */
