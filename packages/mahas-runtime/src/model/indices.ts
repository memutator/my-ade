// mahas-runtime — model/discovery: 책임 관계 인덱스 + discovery query
// repository (IMP-05; spec/domains/rdd.md §4, spec/storage.md §3/§6,
// spec/contracts/discovery-assignment.md).
//
// Everything here is a REGENERABLE PROJECTION over the rdd_* relations:
// owners-by-boundary is the inverse index of rdd_roles (never a stored
// owners field), collaborators derive from same-boundary/contract/contains,
// and role_search_rows/role_search_fts are rebuilt per model version inside
// the publication transaction. No index row is ever returned without joining
// the real tables and applying the caller's visibility filter
// (storage.md §6: "FTS row만으로 조회하지 않는다").

import type { DatabaseSync } from 'node:sqlite'
import type {
  Id,
  ModelVersionId,
  MahasError,
  ErrorCode
} from '../../../mahas-contracts/src/common.ts'
import type {
  BoundaryId,
  ProjectId,
  RddContextId,
  RddContractId,
  RoleId,
  RunId
} from '../../../mahas-contracts/src/ids.ts'
import type {
  Boundary,
  BoundaryPath,
  Criterion,
  NonGoal,
  Role,
  RddContract,
  RddContext,
  SearchRow
} from '../../../mahas-contracts/src/rdd.ts'
import { sha256Hex } from '../storage/db.ts'
import { loadContainsTree, subtreeBoundaryIds, locatePaths } from './territory.ts'

/* ------------------------------------------------------------------ *
 * row mappers — DDL columns (storage.md §3) -> contract shapes.
 * Built literally then asserted: when IMP-02's exact field set lands,
 * drift surfaces here at the package boundary, not inside query logic.
 * ------------------------------------------------------------------ */

interface BoundaryRow {
  model_version: string
  id: string
  name: string
  responsibility_statement: string
}
interface RoleRow {
  model_version: string
  id: string
  name: string
  description: string
  boundary_id: string
  horizontal_role_name: string
}
interface CriterionRow {
  model_version: string
  boundary_id: string
  id: string
  criterion: string
  description: string
  ordinal: number
}
interface ContractRow {
  model_version: string
  id: string
  name: string
  schema_path: string
  provider_boundary_id: string
}
interface ContextRow {
  model_version: string
  id: string
  path: string
}

const toBoundary = (r: BoundaryRow): Boundary =>
  ({
    modelVersion: r.model_version,
    id: r.id,
    name: r.name,
    responsibilityStatement: r.responsibility_statement
  }) as Boundary

const toRole = (r: RoleRow): Role =>
  ({
    modelVersion: r.model_version,
    id: r.id,
    name: r.name,
    description: r.description,
    boundaryId: r.boundary_id,
    horizontalRoleName: r.horizontal_role_name
  }) as Role

const toCriterion = (r: CriterionRow): Criterion =>
  ({
    modelVersion: r.model_version,
    boundaryId: r.boundary_id,
    id: r.id,
    criterion: r.criterion,
    description: r.description,
    ordinal: r.ordinal
  }) as Criterion

const toContract = (r: ContractRow): RddContract =>
  ({
    modelVersion: r.model_version,
    id: r.id,
    name: r.name,
    schemaPath: r.schema_path,
    providerBoundaryId: r.provider_boundary_id
  }) as RddContract

const toContext = (r: ContextRow): RddContext =>
  ({ modelVersion: r.model_version, id: r.id, path: r.path }) as RddContext

const mv = (modelVersion: ModelVersionId): string => modelVersion as string

function all<T>(db: DatabaseSync, sql: string, ...params: (string | number)[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[]
}
function one<T>(db: DatabaseSync, sql: string, ...params: (string | number)[]): T | null {
  const rows = all<T>(db, sql, ...params)
  return rows.length === 0 ? null : rows[0]!
}

function fail(code: ErrorCode, message: string, details?: unknown): never {
  const error: MahasError & Error = Object.assign(new Error(message), {
    code,
    retry: 'none' as const,
    details
  })
  throw error
}

/* ------------------------------------------------------------------ *
 * responsibility relation index — plain relation reads over rdd_*
 * ------------------------------------------------------------------ */

export function getBoundary(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  boundaryId: BoundaryId
): Boundary | null {
  const r = one<BoundaryRow>(
    db,
    'SELECT * FROM rdd_boundaries WHERE model_version = ? AND id = ?',
    mv(modelVersion),
    boundaryId as string
  )
  return r === null ? null : toBoundary(r)
}

export function listBoundaries(db: DatabaseSync, modelVersion: ModelVersionId): Boundary[] {
  return all<BoundaryRow>(
    db,
    'SELECT * FROM rdd_boundaries WHERE model_version = ?',
    mv(modelVersion)
  ).map(toBoundary)
}

export function getRole(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  roleId: RoleId
): Role | null {
  const r = one<RoleRow>(
    db,
    'SELECT * FROM rdd_roles WHERE model_version = ? AND id = ?',
    mv(modelVersion),
    roleId as string
  )
  return r === null ? null : toRole(r)
}

export function listRoles(db: DatabaseSync, modelVersion: ModelVersionId): Role[] {
  return all<RoleRow>(db, 'SELECT * FROM rdd_roles WHERE model_version = ?', mv(modelVersion)).map(
    toRole
  )
}

/**
 * ownersByBoundary — the inverse index of rdd_roles (rdd.md §4).
 * Derived on every read; an `owners` field is never persisted.
 */
export function ownersByBoundary(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  boundaryId: BoundaryId
): Role[] {
  return all<RoleRow>(
    db,
    'SELECT * FROM rdd_roles WHERE model_version = ? AND boundary_id = ? ORDER BY name, id',
    mv(modelVersion),
    boundaryId as string
  ).map(toRole)
}

export function listCriteria(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  boundaryId: BoundaryId
): Criterion[] {
  return all<CriterionRow>(
    db,
    'SELECT * FROM rdd_criteria WHERE model_version = ? AND boundary_id = ? ORDER BY ordinal',
    mv(modelVersion),
    boundaryId as string
  ).map(toCriterion)
}

export function getParent(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  boundaryId: BoundaryId
): Id | null {
  const r = one<{ parent_id: string }>(
    db,
    'SELECT parent_id FROM boundary_edges WHERE model_version = ? AND child_id = ?',
    mv(modelVersion),
    boundaryId as string
  )
  return r === null ? null : (r.parent_id as Id)
}

export function listChildren(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  boundaryId: BoundaryId
): Id[] {
  return all<{ child_id: string }>(
    db,
    'SELECT child_id FROM boundary_edges WHERE model_version = ? AND parent_id = ? ORDER BY child_id',
    mv(modelVersion),
    boundaryId as string
  ).map((r) => r.child_id as Id)
}

/** Contracts whose provider endpoint is this boundary. */
export function contractsProvidedBy(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  boundaryId: BoundaryId
): RddContract[] {
  return all<ContractRow>(
    db,
    'SELECT * FROM rdd_contracts WHERE model_version = ? AND provider_boundary_id = ?',
    mv(modelVersion),
    boundaryId as string
  ).map(toContract)
}

/** Contracts this boundary consumes (provider boundary included on the row). */
export function contractsConsumedBy(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  boundaryId: BoundaryId
): RddContract[] {
  return all<ContractRow>(
    db,
    `SELECT c.* FROM rdd_contracts c
     JOIN contract_consumers cc
       ON cc.model_version = c.model_version AND cc.contract_id = c.id
     WHERE c.model_version = ? AND cc.consumer_boundary_id = ?`,
    mv(modelVersion),
    boundaryId as string
  ).map(toContract)
}

/** Registered territory claims of a boundary (boundary_paths relation). */
export function boundaryPaths(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  boundaryId: BoundaryId
): BoundaryPath[] {
  return all<{ model_version: string; boundary_id: string; path: string; kind: string }>(
    db,
    'SELECT * FROM boundary_paths WHERE model_version = ? AND boundary_id = ? ORDER BY path',
    mv(modelVersion),
    boundaryId as string
  ).map(
    (r) =>
      ({
        modelVersion: r.model_version,
        boundaryId: r.boundary_id,
        path: r.path,
        kind: r.kind
      }) as BoundaryPath
  )
}

/** Non-goals anchored at a boundary (rdd_non_goals relation). */
export function listNonGoals(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  boundaryId: BoundaryId
): NonGoal[] {
  return all<{ model_version: string; id: string; boundary_id: string; statement: string }>(
    db,
    'SELECT * FROM rdd_non_goals WHERE model_version = ? AND boundary_id = ? ORDER BY id',
    mv(modelVersion),
    boundaryId as string
  ).map(
    (r) =>
      ({
        modelVersion: r.model_version,
        id: r.id,
        boundaryId: r.boundary_id,
        statement: r.statement
      }) as NonGoal
  )
}

/** Consumer boundary ids of a contract (contract_consumers relation). */
export function consumersOf(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  contractId: RddContractId
): Id[] {
  return all<{ consumer_boundary_id: string }>(
    db,
    'SELECT consumer_boundary_id FROM contract_consumers WHERE model_version = ? AND contract_id = ? ORDER BY consumer_boundary_id',
    mv(modelVersion),
    contractId as string
  ).map((r) => r.consumer_boundary_id as Id)
}

/** Reuse-guidance contexts linked to a boundary's territory. */
export function boundaryContexts(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  boundaryId: BoundaryId
): RddContext[] {
  return all<ContextRow>(
    db,
    `SELECT c.* FROM rdd_contexts c
     JOIN boundary_contexts bc
       ON bc.model_version = c.model_version AND bc.context_id = c.id
     WHERE bc.model_version = ? AND bc.boundary_id = ?`,
    mv(modelVersion),
    boundaryId as string
  ).map(toContext)
}

/** Expertise contexts linked to a horizontal role. */
export function horizontalContexts(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  horizontalRoleName: string
): RddContext[] {
  return all<ContextRow>(
    db,
    `SELECT c.* FROM rdd_contexts c
     JOIN horizontal_contexts hc
       ON hc.model_version = c.model_version AND hc.context_id = c.id
     WHERE hc.model_version = ? AND hc.horizontal_role_name = ?`,
    mv(modelVersion),
    horizontalRoleName
  ).map(toContext)
}

/** Every place a context is used — boundary territories + horizontal roles. */
export function contextUsages(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  contextId: RddContextId
): { boundaryIds: BoundaryId[]; horizontalRoleNames: string[] } {
  const boundaryIds = all<{ boundary_id: string }>(
    db,
    'SELECT boundary_id FROM boundary_contexts WHERE model_version = ? AND context_id = ?',
    mv(modelVersion),
    contextId as string
  ).map((r) => r.boundary_id as BoundaryId)
  const horizontalRoleNames = all<{ horizontal_role_name: string }>(
    db,
    'SELECT horizontal_role_name FROM horizontal_contexts WHERE model_version = ? AND context_id = ?',
    mv(modelVersion),
    contextId as string
  ).map((r) => r.horizontal_role_name)
  return { boundaryIds, horizontalRoleNames }
}

/* ------------------------------------------------------------------ *
 * collaborators — same-boundary | contract | contains (rdd.md §4,
 * C-DISCOVERY responsibility.collaborators). Static relations only;
 * run members resolve to real rows, never invented addresses.
 * ------------------------------------------------------------------ */

export interface CollaboratorReason {
  kind: 'same-boundary' | 'contract' | 'contains'
  /** the boundary on the other side of the relation */
  boundaryId: BoundaryId
  contractId?: RddContractId
  /** caller's endpoint of the contract, when kind === 'contract' */
  callerPosition?: 'provider' | 'consumer'
  /** collaborator's position relative to the caller in the contains tree */
  containsDirection?: 'parent' | 'child'
}

export interface CollaboratorRef {
  roleId: RoleId
  name: string
  boundaryId: BoundaryId
  horizontalRoleName: string
  reasons: CollaboratorReason[]
  /** real members of `runId` holding this role; empty when unassigned */
  members: { id: Id; state: string }[]
}

export function listCollaborators(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  roleId: RoleId,
  runId?: RunId
): CollaboratorRef[] {
  const caller = getRole(db, modelVersion, roleId)
  if (caller === null) fail('NO_RESPONSIBLE_ROLE', `no role ${roleId} in ${modelVersion}`)
  const callerBoundary = caller!.boundaryId as string

  const tree = loadContainsTree(db, modelVersion)
  const related = new Map<string, CollaboratorReason[]>()
  const push = (boundaryId: string, reason: CollaboratorReason): void => {
    const list = related.get(boundaryId) ?? []
    list.push(reason)
    related.set(boundaryId, list)
  }

  // same-boundary collaborators are discovered at role level below.
  // contains: direct parent + direct children of the caller's boundary.
  const parent = tree.parentOf.get(callerBoundary)
  if (parent !== undefined) {
    push(parent, {
      kind: 'contains',
      boundaryId: parent as BoundaryId,
      containsDirection: 'parent'
    })
  }
  for (const child of tree.childrenOf.get(callerBoundary) ?? []) {
    push(child, { kind: 'contains', boundaryId: child as BoundaryId, containsDirection: 'child' })
  }

  // contract: caller provides -> consumers collaborate; caller consumes -> provider collaborates.
  for (const c of contractsProvidedBy(db, modelVersion, caller!.boundaryId)) {
    for (const consumer of consumersOf(db, modelVersion, c.id)) {
      push(consumer as string, {
        kind: 'contract',
        boundaryId: consumer,
        contractId: c.id,
        callerPosition: 'provider'
      })
    }
  }
  for (const c of contractsConsumedBy(db, modelVersion, caller!.boundaryId)) {
    push(c.providerBoundaryId as string, {
      kind: 'contract',
      boundaryId: c.providerBoundaryId,
      contractId: c.id,
      callerPosition: 'consumer'
    })
  }

  const memberRows = new Map<string, { id: Id; state: string }[]>()
  if (runId !== undefined) {
    for (const m of all<{ role_id: string; id: string; state: string }>(
      db,
      `SELECT role_id, id, state FROM members
       WHERE run_id = ? AND model_version = ?
       ORDER BY id`,
      runId as string,
      mv(modelVersion)
    )) {
      const list = memberRows.get(m.role_id) ?? []
      list.push({ id: m.id as Id, state: m.state })
      memberRows.set(m.role_id, list)
    }
  }

  const out: CollaboratorRef[] = []
  const seenRole = new Set<string>([roleId as string])

  // same-boundary roles first (relation holds at role granularity).
  for (const r of ownersByBoundary(db, modelVersion, caller!.boundaryId)) {
    if (seenRole.has(r.id as string)) continue
    seenRole.add(r.id as string)
    out.push({
      roleId: r.id,
      name: r.name,
      boundaryId: r.boundaryId,
      horizontalRoleName: r.horizontalRoleName,
      reasons: [{ kind: 'same-boundary', boundaryId: r.boundaryId }],
      members: memberRows.get(r.id as string) ?? []
    })
  }

  for (const [boundaryId, reasons] of related) {
    for (const r of ownersByBoundary(db, modelVersion, boundaryId as BoundaryId)) {
      if (seenRole.has(r.id as string)) continue
      seenRole.add(r.id as string)
      out.push({
        roleId: r.id,
        name: r.name,
        boundaryId: r.boundaryId,
        horizontalRoleName: r.horizontalRoleName,
        reasons: reasons.map((x) => ({ ...x })),
        members: memberRows.get(r.id as string) ?? []
      })
    }
  }
  out.sort(
    (a, b) => a.name.localeCompare(b.name) || (a.roleId as string).localeCompare(b.roleId as string)
  )
  return out
}

/* ------------------------------------------------------------------ *
 * search projection — rebuilt per version inside the publish
 * transaction (storage.md §5). Only fully-projected versions are
 * searchable, so projection writes MUST share the publish tx.
 * ------------------------------------------------------------------ */

/** Canonical text shape stored in role_search_rows.normalized_text. */
export function normalizeSearchText(s: string): string {
  return (
    s
      .normalize('NFKC')
      .toLowerCase()
      // eslint-disable-next-line no-control-regex -- strip control chars
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/**
 * SearchProjectionWriter — IMP-04 calls this inside the model publication
 * transaction after the rdd_* rows of `modelVersion` are stored. Idempotent:
 * existing projection rows for the version are replaced, older versions are
 * untouched so snapshot queries keep working (S-COMMON §3 cursor semantics).
 */
export function writeSearchProjection(
  db: DatabaseSync,
  modelVersion: ModelVersionId
): { roleCount: number } {
  db.prepare('DELETE FROM role_search_fts WHERE model_version = ?').run(mv(modelVersion))
  db.prepare('DELETE FROM role_search_rows WHERE model_version = ?').run(mv(modelVersion))

  const roles = all<RoleRow>(
    db,
    'SELECT * FROM rdd_roles WHERE model_version = ? ORDER BY id',
    mv(modelVersion)
  )
  const insRow = db.prepare(
    'INSERT INTO role_search_rows (model_version, role_id, normalized_text) VALUES (?, ?, ?)'
  )
  const insFts = db.prepare(
    'INSERT INTO role_search_fts (model_version, role_id, normalized_text) VALUES (?, ?, ?)'
  )
  for (const r of roles) {
    const boundary = one<BoundaryRow>(
      db,
      'SELECT * FROM rdd_boundaries WHERE model_version = ? AND id = ?',
      mv(modelVersion),
      r.boundary_id
    )
    const criteria = all<CriterionRow>(
      db,
      'SELECT * FROM rdd_criteria WHERE model_version = ? AND boundary_id = ?',
      mv(modelVersion),
      r.boundary_id
    )
    const paths = all<{ path: string }>(
      db,
      'SELECT path FROM boundary_paths WHERE model_version = ? AND boundary_id = ?',
      mv(modelVersion),
      r.boundary_id
    )
    const text = normalizeSearchText(
      [
        r.name,
        r.description,
        r.horizontal_role_name,
        boundary?.name ?? '',
        boundary?.responsibility_statement ?? '',
        ...criteria.flatMap((c) => [c.criterion, c.description]),
        ...paths.map((p) => p.path)
      ].join(' ')
    )
    insRow.run(mv(modelVersion), r.id, text)
    insFts.run(mv(modelVersion), r.id, text)
  }
  return { roleCount: roles.length }
}

/**
 * The publication port by name (instruction §6): IMP-04 injects/calls this
 * inside `model.change.commit`'s write transaction. It is the ONLY way new
 * model text becomes searchable — versions without projected rows simply
 * have no hits, which is the honest "not yet indexed" state.
 */
export interface SearchProjectionWriter {
  write(db: DatabaseSync, modelVersion: ModelVersionId): { roleCount: number }
}
export const searchProjectionWriter: SearchProjectionWriter = { write: writeSearchProjection }

/** Raw projection read — for projection verification, not for search hits. */
export function readSearchRow(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  roleId: RoleId
): SearchRow | null {
  const r = one<{ model_version: string; role_id: string; normalized_text: string }>(
    db,
    'SELECT * FROM role_search_rows WHERE model_version = ? AND role_id = ?',
    mv(modelVersion),
    roleId as string
  )
  return r === null
    ? null
    : ({
        modelVersion: r.model_version,
        roleId: r.role_id,
        normalizedText: r.normalized_text
      } as SearchRow)
}

/* ------------------------------------------------------------------ *
 * discovery query backbone (C-DISCOVERY responsibility.search).
 * Structure filters + visibility restrict the candidate pool first;
 * the plain-text query then intersects it. Lexical ordering is a
 * browsing convenience — never an expertise score.
 * ------------------------------------------------------------------ */

export type MatchReason =
  | {
      kind: 'path-exact' | 'path-prefix'
      path: string
      claim: string
      claimKind: 'file' | 'directory'
    }
  | { kind: 'contract'; contractId: Id; as: 'provider' | 'consumer' }
  | { kind: 'horizontal-role'; horizontalRoleName: string }
  | { kind: 'scope'; scopeBoundaryId: BoundaryId }
  | { kind: 'text'; via: 'fts' | 'substring' }

export interface RelationshipRef {
  kind: 'contract' | 'contains' | 'boundary-path'
  contractId?: RddContractId
  boundaryId?: BoundaryId
  direction?: 'provides' | 'consumes' | 'parent' | 'child'
  path?: string
}

export interface DiscoveryHit {
  boundary: Boundary
  /** owners of this boundary; empty = responsibility with no role (미배정) */
  roles: Role[]
  matchReasons: MatchReason[]
  relationshipRefs: RelationshipRef[]
}

export interface AmbiguityGroup {
  path: string
  boundaryIds: BoundaryId[]
}

/** the structure+text filter shape a result set is bound to */
export interface DiscoveryQueryShape {
  query?: string
  paths?: string[]
  contractIds?: RddContractId[]
  horizontalRoleNames?: string[]
  /** restrict to this boundary's inclusive subtree */
  scopeBoundaryId?: BoundaryId
}

export interface DiscoverySearchRequest extends DiscoveryQueryShape {
  projectId: ProjectId
  /** absent -> projects.active_model_version; cursor overrides with its own snapshot */
  modelVersion?: ModelVersionId
  /**
   * server-side visibility filter (storage.md §6 join+permission filter).
   * `undefined` = unrestricted (service-scope callers only); an empty list
   * legitimately returns nothing. Re-supply on cursor continuation — a
   * changed visibility set rebases the cursor instead of mixing results.
   */
  visibleBoundaryIds?: BoundaryId[]
  repositoryRoot?: string
  /**
   * opaque snapshot cursor. Passing it with NO filters/version continues
   * the cursor's own snapshot+shape; passing explicit filters/version is an
   * explicit re-query (result.cursorRebased is set when it could not
   * continue — spec/common.md §3: never mix result sets across snapshots).
   */
  cursor?: string
  /** default 20, hard cap 100 — a resource limit, not a relevance bar */
  limit?: number
}

export type DiscoveryDiagnostic = 'empty-request' | 'no-match'

export interface DiscoverySearchResult {
  modelVersion: ModelVersionId
  hits: DiscoveryHit[]
  unmatchedPaths: string[]
  ambiguityGroups: AmbiguityGroup[]
  nextCursor?: string
  /** present when the supplied cursor could not continue its snapshot */
  cursorRebased?: true
  diagnostic?: DiscoveryDiagnostic
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

interface SearchCursor {
  v: string // modelVersion the result set is bound to
  vd: string // visibility digest
  shape: DiscoveryQueryShape // the filter shape that produced the set
  off: number
}

const encodeCursor = (c: SearchCursor): string =>
  Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')

function decodeCursor(raw: string): SearchCursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as SearchCursor
    if (
      typeof c.v !== 'string' ||
      typeof c.off !== 'number' ||
      typeof c.vd !== 'string' ||
      typeof c.shape !== 'object' ||
      c.shape === null
    ) {
      throw new Error('shape')
    }
    return c
  } catch {
    fail('SNAPSHOT_REQUIRED', 'search cursor is not decodable; re-query explicitly')
  }
}

/** Escape a LIKE pattern fragment; use with `ESCAPE '\'`. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c)
}

/**
 * Build a SAFE FTS5 MATCH expression from an already-normalized query:
 * each whitespace-separated term is emitted as a quoted literal (double
 * quotes inside are doubled), terms are OR-ed for recall. The raw caller
 * string is never spliced into FTS grammar (C-DISCOVERY 검색 표현).
 */
export function buildFtsMatch(normalizedQuery: string): string | null {
  // terms must carry at least one tokenizable char (unicode61 keeps
  // letters/numbers/marks); pure-punctuation terms yield no FTS tokens and
  // would only confuse MATCH — the LIKE fallback still covers them.
  const terms = normalizedQuery
    .split(' ')
    .filter((t) => t.length > 0 && /[\p{L}\p{N}\p{M}]/u.test(t))
  if (terms.length === 0) return null
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

function textMatchedRoleIds(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  normalizedQuery: string
): { fts: Set<string>; substring: Set<string> } {
  const fts = new Set<string>()
  const substring = new Set<string>()
  const match = buildFtsMatch(normalizedQuery)
  if (match !== null) {
    for (const r of all<{ role_id: string }>(
      db,
      'SELECT role_id FROM role_search_fts WHERE role_search_fts MATCH ? AND model_version = ?',
      match,
      mv(modelVersion)
    )) {
      fts.add(r.role_id)
    }
  }
  // Korean/substring fallback — parameter-bound LIKE with explicit escaping
  // (storage.md §6); covers partial matches FTS tokenization cannot see.
  const like = '%' + escapeLike(normalizedQuery) + '%'
  for (const r of all<{ role_id: string }>(
    db,
    `SELECT role_id FROM role_search_rows
     WHERE model_version = ? AND normalized_text LIKE ? ESCAPE '\\'`,
    mv(modelVersion),
    like
  )) {
    substring.add(r.role_id)
  }
  return { fts, substring }
}

export function searchResponsibilities(
  db: DatabaseSync,
  req: DiscoverySearchRequest
): DiscoverySearchResult {
  // -- snapshot + cursor binding -------------------------------------
  // A cursor-only call continues the cursor's own snapshot+shape; explicit
  // filters/version are a re-query (rebase) rather than a silent mix.
  const requestedVersion = resolveVersion(db, req)
  let version = requestedVersion
  let offset = 0
  let cursorRebased: true | undefined
  const vd = visibilityDigest(req.visibleBoundaryIds)
  let shape: DiscoveryQueryShape = {
    query: req.query,
    paths: req.paths,
    contractIds: req.contractIds,
    horizontalRoleNames: req.horizontalRoleNames,
    scopeBoundaryId: req.scopeBoundaryId
  }
  if (req.cursor !== undefined) {
    const c = decodeCursor(req.cursor)
    const callerSupplied =
      req.query !== undefined ||
      (req.paths?.length ?? 0) > 0 ||
      (req.contractIds?.length ?? 0) > 0 ||
      (req.horizontalRoleNames?.length ?? 0) > 0 ||
      req.scopeBoundaryId !== undefined
    if (!callerSupplied && req.modelVersion === undefined) {
      // pure continuation: snapshot + filter shape both come from the cursor
      version = c.v as ModelVersionId
      shape = c.shape
      if (c.vd === vd) {
        offset = c.off
      } else {
        cursorRebased = true // visibility set changed — restart honestly
      }
    } else {
      // explicit query: continue only on identical snapshot+shape+visibility
      const continued =
        c.v === requestedVersion && c.vd === vd && shapeDigest(shape) === shapeDigest(c.shape)
      offset = continued ? c.off : 0
      cursorRebased = continued ? undefined : true
    }
  }

  const hasStructure =
    (shape.paths?.length ?? 0) > 0 ||
    (shape.contractIds?.length ?? 0) > 0 ||
    (shape.horizontalRoleNames?.length ?? 0) > 0
  if (shape.query === undefined && !hasStructure) {
    return {
      modelVersion: version,
      hits: [],
      unmatchedPaths: [],
      ambiguityGroups: [],
      diagnostic: 'empty-request'
    }
  }

  const tree = loadContainsTree(db, version)
  const reasons = new Map<string, MatchReason[]>()
  const relRefs = new Map<string, RelationshipRef[]>()
  const addReason = (b: string, r: MatchReason): Map<string, MatchReason[]> =>
    reasons.set(b, [...(reasons.get(b) ?? []), r])
  const addRef = (b: string, r: RelationshipRef): Map<string, RelationshipRef[]> =>
    relRefs.set(b, [...(relRefs.get(b) ?? []), r])

  // -- structural candidate pool (union of discovery filters) --------
  const unmatchedPaths: string[] = []
  const ambiguityGroups: AmbiguityGroup[] = []
  const structuralPool = new Set<string>()

  for (const look of locatePaths(db, version, shape.paths ?? [], {
    repositoryRoot: req.repositoryRoot
  })) {
    if (look.status === 'assigned') {
      structuralPool.add(look.boundaryId as string)
      const claim = look.claimants[0]!
      addReason(look.boundaryId as string, {
        kind: claim.path === look.path ? 'path-exact' : 'path-prefix',
        path: look.path,
        claim: claim.path,
        claimKind: claim.kind
      })
      addRef(look.boundaryId as string, {
        kind: 'boundary-path',
        boundaryId: look.boundaryId,
        path: claim.path
      })
    } else if (look.status === 'ambiguous') {
      for (const c of look.claimants) structuralPool.add(c.boundaryId as string)
      ambiguityGroups.push({ path: look.path, boundaryIds: look.ambiguousBoundaryIds ?? [] })
    } else {
      unmatchedPaths.push(look.path)
    }
  }

  for (const contractId of shape.contractIds ?? []) {
    const contract = one<ContractRow>(
      db,
      'SELECT * FROM rdd_contracts WHERE model_version = ? AND id = ?',
      mv(version),
      contractId as string
    )
    if (contract === null) continue
    structuralPool.add(contract.provider_boundary_id)
    addReason(contract.provider_boundary_id, {
      kind: 'contract',
      contractId: contractId as Id,
      as: 'provider'
    })
    addRef(contract.provider_boundary_id, {
      kind: 'contract',
      contractId,
      boundaryId: contract.provider_boundary_id as BoundaryId,
      direction: 'provides'
    })
    for (const consumer of consumersOf(db, version, contractId)) {
      structuralPool.add(consumer as string)
      addReason(consumer as string, {
        kind: 'contract',
        contractId: contractId as Id,
        as: 'consumer'
      })
      addRef(consumer as string, {
        kind: 'contract',
        contractId,
        boundaryId: consumer,
        direction: 'consumes'
      })
    }
  }

  for (const hr of shape.horizontalRoleNames ?? []) {
    for (const r of all<RoleRow>(
      db,
      'SELECT * FROM rdd_roles WHERE model_version = ? AND horizontal_role_name = ?',
      mv(version),
      hr
    ).map(toRole)) {
      structuralPool.add(r.boundaryId as string)
      addReason(r.boundaryId as string, { kind: 'horizontal-role', horizontalRoleName: hr })
    }
  }

  let pool: Set<string>
  if (hasStructure) {
    pool = structuralPool
  } else {
    pool = new Set(
      all<{ id: string }>(
        db,
        'SELECT id FROM rdd_boundaries WHERE model_version = ?',
        mv(version)
      ).map((r) => r.id)
    )
  }

  // -- scope + visibility intersection --------------------------------
  if (shape.scopeBoundaryId !== undefined) {
    const scope = subtreeBoundaryIds(tree, shape.scopeBoundaryId as string)
    for (const b of [...pool]) {
      if (scope.has(b)) {
        addReason(b, { kind: 'scope', scopeBoundaryId: shape.scopeBoundaryId })
      } else {
        pool.delete(b)
      }
    }
  }
  if (req.visibleBoundaryIds !== undefined) {
    const visible = new Set(req.visibleBoundaryIds.map((x) => x as string))
    for (const b of [...pool]) if (!visible.has(b)) pool.delete(b)
  }

  // -- text query intersection ---------------------------------------
  let boundaryTextHits: Set<string> | null = null
  let roleTextHits: { fts: Set<string>; substring: Set<string> } | null = null
  if (shape.query !== undefined) {
    const nq = normalizeSearchText(shape.query)
    if (nq.length === 0) {
      return {
        modelVersion: version,
        hits: [],
        unmatchedPaths,
        ambiguityGroups,
        diagnostic: 'no-match'
      }
    }
    roleTextHits = textMatchedRoleIds(db, version, nq)
    boundaryTextHits = new Set<string>()
    // boundary-level substring fallback — surfaces responsibilities that
    // own no role yet (미배정 영역), which role-keyed search rows cannot.
    for (const b of all<BoundaryRow>(
      db,
      'SELECT * FROM rdd_boundaries WHERE model_version = ?',
      mv(version)
    )) {
      if (normalizeSearchText(`${b.name} ${b.responsibility_statement}`).includes(nq)) {
        boundaryTextHits.add(b.id)
      }
    }
  }

  // -- hydrate hits through the real tables ---------------------------
  const hits: DiscoveryHit[] = []
  for (const boundaryId of pool) {
    const bRow = one<BoundaryRow>(
      db,
      'SELECT * FROM rdd_boundaries WHERE model_version = ? AND id = ?',
      mv(version),
      boundaryId
    )
    if (bRow === null) continue
    const roles = ownersByBoundary(db, version, boundaryId as BoundaryId)

    const rs = [...(reasons.get(boundaryId) ?? [])]
    if (roleTextHits !== null) {
      const matched = roles.some(
        (r) => roleTextHits!.fts.has(r.id as string) || roleTextHits!.substring.has(r.id as string)
      )
      const boundaryMatched = boundaryTextHits!.has(boundaryId)
      if (!matched && !boundaryMatched) continue
      for (const r of roles) {
        const via = roleTextHits.fts.has(r.id as string)
          ? 'fts'
          : roleTextHits.substring.has(r.id as string)
            ? 'substring'
            : null
        if (via !== null) rs.push({ kind: 'text', via })
      }
      if (boundaryMatched) rs.push({ kind: 'text', via: 'substring' })
    }
    hits.push({
      boundary: toBoundary(bRow),
      roles,
      matchReasons: rs,
      relationshipRefs: relRefs.get(boundaryId) ?? []
    })
  }

  hits.sort(
    (a, b) =>
      a.boundary.name.localeCompare(b.boundary.name) ||
      (a.boundary.id as string).localeCompare(b.boundary.id as string)
  )

  const limit = Math.min(Math.max(req.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const page = hits.slice(offset, offset + limit)
  const nextOffset = offset + page.length
  const nextCursor =
    nextOffset < hits.length
      ? encodeCursor({ v: version as string, vd, shape, off: nextOffset })
      : undefined

  return {
    modelVersion: version,
    hits: page,
    unmatchedPaths,
    ambiguityGroups,
    nextCursor,
    cursorRebased,
    diagnostic: hits.length === 0 ? 'no-match' : undefined
  }
}

function resolveVersion(db: DatabaseSync, req: DiscoverySearchRequest): ModelVersionId {
  if (req.modelVersion !== undefined) return req.modelVersion
  const r = one<{ active_model_version: string | null }>(
    db,
    'SELECT active_model_version FROM projects WHERE id = ?',
    req.projectId as string
  )
  if (r === null) fail('MODEL_INVALID', `unknown project ${req.projectId}`)
  if (r!.active_model_version === null) {
    fail('SNAPSHOT_REQUIRED', `project ${req.projectId} has no active model version`)
  }
  return r!.active_model_version as ModelVersionId
}

const visibilityDigest = (visible?: readonly BoundaryId[]): string =>
  sha256Hex(
    visible === undefined ? 'ALL' : JSON.stringify([...visible.map((x) => x as string)].sort())
  )

const shapeDigest = (shape: DiscoveryQueryShape): string =>
  sha256Hex(
    JSON.stringify({
      q: shape.query ?? null,
      p: shape.paths ?? [],
      c: shape.contractIds ?? [],
      h: shape.horizontalRoleNames ?? [],
      s: shape.scopeBoundaryId ?? null
    })
  )
