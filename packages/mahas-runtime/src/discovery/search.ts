// mahas-runtime/src/discovery/search.ts — responsibility.search
//
// The 팀장's discovery read (REQ-04): natural-language / code-path /
// contract / horizontal-role / boundary-scope filters over ONE pinned
// model snapshot, answered as CandidateCard[] + territory diagnostics —
// never an auto-selected assignee (검색 결과 반환은 배정이나 spawn이
// 아니다).
//
// Pipeline (contract §"검색 표현과 알고리즘", storage.md §6):
//   1. structural filters + permission narrow the candidate set first
//   2. text query then matches inside that set — FTS5 over the IMP-05
//      projection with parameter binding (the raw query string is never
//      executed as FTS/SQL grammar), plus LIKE-escaped substring fallback
//      for Korean partial matches; every projection hit is re-joined to
//      the real role/boundary rows before it counts
//   3. the visibility filter drops candidates outside the caller's
//      grants — silently (no hidden counts/snippets)
//   4. cards carry matchReasons + relationshipRefs + availability +
//      current member state + a sealed selectionToken
//   5. ordering is lexical convenience only — not an expertise score
//   6. the cursor binds modelVersion + visibilityDigest + the normalized
//      filter, so pages can't be mixed across snapshots or grants

import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import type { DiscoveryDeps } from './deps.ts'
import {
  boundarySubtree,
  boundarySummary,
  claimantsForPath,
  childrenOf,
  eventHighWater,
  getBoundary,
  latestAssignmentKind,
  listContractRelations,
  listCriteria,
  listRoles,
  membersForRole,
  parentOf,
  projectRepositoryRoot,
  resolveModelVersion,
  roleDigest,
  roleSummary,
  tryNormalizeRepoPath,
  visibilityDigest
} from './model-read.ts'
import type { BoundaryRow, NormalizedPath, PathClaim, RoleRow } from './model-read.ts'
import {
  availabilityForRole,
  implementationPinDigest,
  implementationSetDigest
} from './implementation-availability.ts'
import { issueSelectionToken, openPageCursor, sealPageCursor } from './selection-token.ts'
import { resolveVisibleTerritory } from './locate.ts'
import { discoveryError, target, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from './types.ts'
import { makeVisibility } from './visibility.ts'
import type {
  CandidateCard,
  MatchReason,
  MemberAvailability,
  RelationshipRef,
  SearchRequest,
  SearchResult,
  UnmatchedPath,
  AmbiguityGroup
} from './types.ts'

// ---------------------------------------------------------------------------
// request validation + normalization
// ---------------------------------------------------------------------------

interface SearchFilter {
  query?: string
  paths: NormalizedPath[]
  rawPaths: string[]
  invalidPaths: string[]
  contractIds: string[]
  horizontalRoleNames: string[]
  scopeBoundaryId?: string
}

function normalizeFilter(raw: Partial<SearchRequest>, repositoryRoot?: string): SearchFilter {
  const f: SearchFilter = {
    paths: [],
    rawPaths: [],
    invalidPaths: [],
    contractIds: [],
    horizontalRoleNames: []
  }
  if (typeof raw.query === 'string' && raw.query.trim().length > 0) f.query = raw.query.trim()
  if (Array.isArray(raw.paths))
    for (const p of raw.paths) {
      const np = typeof p === 'string' ? tryNormalizeRepoPath(p, repositoryRoot) : null
      if (np === null) f.invalidPaths.push(String(p))
      else {
        f.paths.push(np)
        f.rawPaths.push(np.path)
      }
    }
  if (Array.isArray(raw.contractIds))
    f.contractIds = raw.contractIds.filter((c): c is string => typeof c === 'string')
  if (Array.isArray(raw.horizontalRoleNames))
    f.horizontalRoleNames = raw.horizontalRoleNames.filter(
      (c): c is string => typeof c === 'string'
    )
  if (typeof raw.scopeBoundaryId === 'string' && raw.scopeBoundaryId.length > 0)
    f.scopeBoundaryId = raw.scopeBoundaryId
  return f
}

function filterHasSignal(f: SearchFilter): boolean {
  return (
    f.query !== undefined ||
    f.paths.length > 0 ||
    f.contractIds.length > 0 ||
    f.horizontalRoleNames.length > 0 ||
    f.scopeBoundaryId !== undefined
  )
}

/** canonical filter shape for cursor equality (order-insensitive) */
function canonicalFilter(f: SearchFilter): unknown {
  return {
    q: f.query ?? null,
    p: [...f.rawPaths].sort(),
    ip: [...f.invalidPaths].sort(),
    c: [...f.contractIds].sort(),
    h: [...f.horizontalRoleNames].sort(),
    s: f.scopeBoundaryId ?? null
  }
}

function sameFilter(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function validateSearchRequest(
  payload: unknown,
  repositoryRoot?: string
): {
  projectId: string
  modelVersion?: string
  filter: SearchFilter
  cursor?: string
  limit: number
} {
  const p = payload as Partial<SearchRequest>
  if (typeof p?.projectId !== 'string' || p.projectId.length === 0)
    throw discoveryError('MODEL_INVALID', 'responsibility.search requires projectId')
  if (p?.modelVersion !== undefined && typeof p.modelVersion !== 'string')
    throw discoveryError('MODEL_INVALID', 'modelVersion must be a string')
  if (p?.cursor !== undefined && typeof p.cursor !== 'string')
    throw discoveryError('MODEL_INVALID', 'cursor must be a string')
  let limit = SEARCH_DEFAULT_LIMIT
  if (p?.limit !== undefined) {
    if (typeof p.limit !== 'number' || !Number.isInteger(p.limit) || p.limit < 1)
      throw discoveryError('MODEL_INVALID', 'limit must be a positive integer')
    limit = Math.min(p.limit, SEARCH_MAX_LIMIT)
  }
  const filter = normalizeFilter(p ?? {}, repositoryRoot)
  if (p?.cursor === undefined && !filterHasSignal(filter))
    throw discoveryError(
      'MODEL_INVALID',
      'responsibility.search requires a query or at least one structural filter'
    )
  return {
    projectId: p.projectId,
    ...(p?.modelVersion !== undefined ? { modelVersion: p.modelVersion } : {}),
    filter,
    ...(p?.cursor !== undefined ? { cursor: p.cursor } : {}),
    limit
  }
}

// ---------------------------------------------------------------------------
// text matching — FTS5 projection + LIKE-escaped substring fallback
// ---------------------------------------------------------------------------

/** split a plain query into match tokens — unicode letter/number runs */
function queryTokens(query: string): string[] {
  return query
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c)
}

interface TextHit {
  fts: boolean
  substring: boolean
}

/**
 * roleIds whose normalized search text matches ANY token (OR recall —
 * ordering is never a score). FTS is tried first; the LIKE-escaped
 * substring fallback catches Korean partial matches unicode61
 * tokenization can't express. Projection hits are verified against real
 * role rows by the caller's candidate join — never trusted alone.
 */
function textMatchedRoles(
  db: DatabaseSync,
  modelVersion: string,
  tokens: string[]
): Map<string, TextHit> {
  const hits = new Map<string, TextHit>()
  const hit = (roleId: string, key: keyof TextHit): void => {
    const h = hits.get(roleId) ?? { fts: false, substring: false }
    h[key] = true
    hits.set(roleId, h)
  }
  if (tokens.length === 0) return hits

  // FTS — the raw query string is re-tokenized and bound as parameters;
  // FTS operator syntax in user input is data, never executed grammar
  const expr = tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ')
  try {
    for (const r of db
      .prepare(
        'SELECT role_id FROM role_search_fts WHERE model_version = ? AND role_search_fts MATCH ?'
      )
      .all(modelVersion, expr) as { role_id: string }[])
      hit(r.role_id, 'fts')
  } catch {
    // projection missing/not yet built — the substring path still covers
  }

  // substring fallback — parameter binding + LIKE escape (storage.md §6)
  for (const t of tokens)
    for (const r of db
      .prepare(
        `SELECT role_id FROM role_search_rows
         WHERE model_version = ? AND normalized_text LIKE ? ESCAPE '\\'`
      )
      .all(modelVersion, `%${likeEscape(t.toLowerCase())}%`) as { role_id: string }[])
      hit(r.role_id, 'substring')
  return hits
}

/** which real field a token matched — the honest matchReason, not a snippet */
function fieldMatches(
  db: DatabaseSync,
  modelVersion: string,
  role: RoleRow,
  boundary: BoundaryRow,
  tokens: string[]
): MatchReason[] {
  const reasons: MatchReason[] = []
  const needle = tokens.map((t) => t.toLowerCase())
  const has = (s: string): boolean => {
    const l = s.toLowerCase()
    return needle.some((n) => l.includes(n))
  }
  if (has(role.name)) reasons.push({ kind: 'text', field: 'role-name', match: 'substring' })
  if (has(role.description))
    reasons.push({ kind: 'text', field: 'role-description', match: 'substring' })
  if (has(boundary.responsibility_statement))
    reasons.push({ kind: 'text', field: 'responsibility', match: 'substring' })
  for (const c of listCriteria(db, modelVersion, boundary.id))
    if (has(c.criterion) || has(c.description)) {
      reasons.push({ kind: 'text', field: 'criterion', match: 'substring' })
      break
    }
  return reasons
}

// ---------------------------------------------------------------------------
// the operation
// ---------------------------------------------------------------------------

interface PathResolution {
  np: NormalizedPath
  /** visible claims on the path (owns + covers) */
  claims: PathClaim[]
  /** every visible boundary claiming the path (owns + covers) */
  claimantIds: Set<string>
  /** visible 'owns' claims only */
  ownerIds: Set<string>
  /** non-ancestor same-depth owners — an ambiguity group member */
  tiedOwnerIds: string[]
  hasRole: boolean
}

export function responsibilitySearch(
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  deps: DiscoveryDeps,
  payload: unknown
): SearchResult {
  const projectId =
    typeof (payload as { projectId?: unknown })?.projectId === 'string'
      ? (payload as { projectId: string }).projectId
      : ''
  const req = validateSearchRequest(payload, projectId ? projectRepositoryRoot(db, projectId) : undefined)
  const now = deps.now !== undefined ? deps.now() : Date.now()

  // --- cursor handling: bind model snapshot + visibility + filter -------
  // open the cursor first so an unpinned request continues on the
  // cursor's own snapshot instead of silently jumping to the new active
  const cursor = req.cursor !== undefined ? openPageCursor(deps.tokenSecret, req.cursor) : null
  if (req.cursor !== undefined && cursor === null)
    throw discoveryError('MODEL_INVALID', 'cursor is malformed or not issued here')

  const mv = resolveModelVersion(db, req.projectId, req.modelVersion ?? cursor?.modelVersion)
  const vd = visibilityDigest(ctx, mv.id)

  let offset = 0
  let limit = req.limit
  let filter = req.filter
  if (cursor !== null) {
    if (cursor.modelVersion !== mv.id)
      throw discoveryError(
        'STALE_REVISION',
        'cursor is bound to a different model snapshot',
        { cursorModelVersion: cursor.modelVersion, modelVersion: mv.id },
        'replan'
      )
    if (cursor.visibilityDigest !== vd)
      throw discoveryError(
        'STALE_REVISION',
        'cursor is bound to a different visibility context',
        undefined,
        'replan'
      )
    const requestFilter = canonicalFilter(req.filter)
    if (filterHasSignal(req.filter) && !sameFilter(cursor.filter, requestFilter))
      throw discoveryError(
        'MODEL_INVALID',
        'request filters differ from the filters bound to the cursor'
      )
    // cursor-only continuation reuses the bound normalized filter
    if (!filterHasSignal(req.filter)) filter = denormalizeFilter(cursor.filter)
    offset = cursor.offset
    limit = Math.min(cursor.limit, SEARCH_MAX_LIMIT)
  }

  const vis = makeVisibility(ctx, deps, 'responsibility.search', mv.id, [
    target('project', req.projectId)
  ])
  vis.require(
    filter.scopeBoundaryId !== undefined ? [target('boundary', filter.scopeBoundaryId)] : []
  )

  // --- structural candidate sets ---------------------------------------
  const allRoles = listRoles(db, mv.id)
  const boundariesById = new Map<string, BoundaryRow>()

  let scopeSet: Set<string> | null = null
  if (filter.scopeBoundaryId !== undefined) {
    if (getBoundary(db, mv.id, filter.scopeBoundaryId) === undefined)
      throw discoveryError('MODEL_INVALID', 'scopeBoundaryId not in model snapshot', {
        scopeBoundaryId: filter.scopeBoundaryId
      })
    scopeSet = boundarySubtree(db, mv.id, filter.scopeBoundaryId)
  }

  const pathResolutions: PathResolution[] = []
  const pathBoundaryUnion = new Set<string>()
  for (const np of filter.paths) {
    const claims = claimantsForPath(db, mv.id, np).filter((c) => vis.boundaryVisible(c.boundaryId))
    const owners = claims.filter((c) => c.claim === 'owns')
    const territory = resolveVisibleTerritory(db, mv.id, np, (id) => vis.boundaryVisible(id))
    const tied =
      territory.status === 'ambiguous' ? territory.ambiguousBoundaryIds : []
    const ownerIds = new Set(
      territory.status === 'resolved' && territory.winnerId
        ? [territory.winnerId]
        : owners.map((c) => c.boundaryId)
    )
    const claimantIds = new Set(claims.map((c) => c.boundaryId))
    const res: PathResolution = {
      np,
      claims,
      claimantIds,
      ownerIds,
      tiedOwnerIds: tied,
      hasRole: [...claimantIds].some((b) =>
        allRoles.some((r) => r.boundary_id === b && vis.roleVisible(r.id, b))
      )
    }
    pathResolutions.push(res)
    for (const b of claimantIds) pathBoundaryUnion.add(b)
  }

  const contractRels = listContractRelations(db, mv.id)
  const contractBoundaryUnion = new Set<string>()
  const unmatchedContractIds: string[] = []
  for (const cid of filter.contractIds) {
    const rel = contractRels.find((r) => r.contract.id === cid)
    if (rel === undefined) {
      unmatchedContractIds.push(cid)
      continue
    }
    if (vis.boundaryVisible(rel.contract.provider_boundary_id))
      contractBoundaryUnion.add(rel.contract.provider_boundary_id)
    for (const c of rel.consumerBoundaryIds)
      if (vis.boundaryVisible(c)) contractBoundaryUnion.add(c)
  }

  const hroleSet = new Set(filter.horizontalRoleNames)

  // --- candidate roles: conjunctive structural + text + visibility -----
  const tokens = filter.query !== undefined ? queryTokens(filter.query) : []
  const textHits =
    filter.query !== undefined ? textMatchedRoles(db, mv.id, tokens) : new Map<string, TextHit>()

  const candidates = allRoles.filter((r) => {
    if (scopeSet !== null && !scopeSet.has(r.boundary_id)) return false
    if (filter.paths.length > 0 && !pathBoundaryUnion.has(r.boundary_id)) return false
    if (filter.contractIds.length > 0 && !contractBoundaryUnion.has(r.boundary_id)) return false
    if (hroleSet.size > 0 && !hroleSet.has(r.horizontal_role_name)) return false
    if (filter.query !== undefined && !textHits.has(r.id)) return false
    return vis.roleVisible(r.id, r.boundary_id)
  })

  // --- diagnostics: unmatched paths / ambiguity / roleless territory ---
  const unmatchedPaths: UnmatchedPath[] = filter.invalidPaths.map((p) => ({
    path: p,
    status: 'invalid' as const,
    reason: 'not a valid repo-relative path'
  }))
  const ambiguityGroups: AmbiguityGroup[] = []
  const rolelessBoundaries = new Set<string>()

  for (const res of pathResolutions) {
    if (res.tiedOwnerIds.length > 0) {
      unmatchedPaths.push({
        path: res.np.path,
        status: 'ambiguous',
        boundaryIds: res.tiedOwnerIds
      })
      ambiguityGroups.push({
        kind: 'territory-overlap',
        paths: [res.np.path],
        boundaryIds: res.tiedOwnerIds
      })
    } else if (res.ownerIds.size === 0) {
      unmatchedPaths.push({
        path: res.np.path,
        status: 'unassigned',
        ...(res.claimantIds.size > 0 ? { boundaryIds: [...res.claimantIds] } : {}),
        reason:
          res.claimantIds.size > 0
            ? 'no boundary owns this path; descendant claims exist under it'
            : 'no boundary owns this path'
      })
    } else if (!res.hasRole) {
      unmatchedPaths.push({
        path: res.np.path,
        status: 'no-responsible-role',
        boundaryIds: [...res.ownerIds]
      })
      for (const b of res.ownerIds) rolelessBoundaries.add(b)
    }
  }

  // structural boundary matches that ended with no visible role —
  // the unassigned-territory report the 팀장 reads (REQ-04)
  const structuralBoundaryUnion = new Set<string>([
    ...pathBoundaryUnion,
    ...contractBoundaryUnion,
    ...(scopeSet ?? [])
  ])
  for (const b of structuralBoundaryUnion) {
    const hasVisibleRole = allRoles.some((r) => r.boundary_id === b && vis.roleVisible(r.id, b))
    if (!hasVisibleRole && vis.boundaryVisible(b)) rolelessBoundaries.add(b)
  }

  // --- assemble cards ---------------------------------------------------
  const cards: CandidateCard[] = []
  for (const role of candidates) {
    let boundary = boundariesById.get(role.boundary_id)
    if (boundary === undefined) {
      const b = getBoundary(db, mv.id, role.boundary_id)
      if (b === undefined) continue
      boundary = b
      boundariesById.set(role.boundary_id, b)
    }

    const matchReasons: MatchReason[] = []
    if (scopeSet !== null) matchReasons.push({ kind: 'scope', path: filter.scopeBoundaryId })

    // path reasons from this boundary's claims on the requested paths
    for (const res of pathResolutions)
      for (const c of res.claims)
        if (c.boundaryId === role.boundary_id)
          matchReasons.push({
            kind:
              c.claim === 'covers'
                ? 'path-covered'
                : c.matchedPath === res.np.path
                  ? 'path-exact'
                  : 'path-prefix',
            path: res.np.path,
            matchedPath: c.matchedPath
          })

    for (const rel of contractRels) {
      if (!filter.contractIds.includes(rel.contract.id)) continue
      if (rel.contract.provider_boundary_id === role.boundary_id)
        matchReasons.push({
          kind: 'contract',
          contractId: rel.contract.id,
          direction: 'provides'
        })
      if (rel.consumerBoundaryIds.includes(role.boundary_id))
        matchReasons.push({
          kind: 'contract',
          contractId: rel.contract.id,
          direction: 'consumes'
        })
    }

    if (hroleSet.has(role.horizontal_role_name))
      matchReasons.push({
        kind: 'horizontal-role',
        horizontalRoleName: role.horizontal_role_name
      })

    if (filter.query !== undefined) {
      const hit = textHits.get(role.id)
      if (hit?.fts) matchReasons.push({ kind: 'text', field: 'search-text', match: 'fts' })
      matchReasons.push(...fieldMatches(db, mv.id, role, boundary, tokens))
    }

    // relationship refs — every referenced boundary/role re-checked for
    // visibility so a card never names something the caller cannot see
    const relationshipRefs: RelationshipRef[] = []
    const pushRef = (ref: RelationshipRef): void => {
      if (relationshipRefs.length >= 12) return
      if (ref.boundaryId !== undefined && !vis.boundaryVisible(ref.boundaryId)) return
      relationshipRefs.push(ref)
    }
    for (const sib of listRoles(db, mv.id, role.boundary_id))
      if (sib.id !== role.id && vis.roleVisible(sib.id, sib.boundary_id))
        pushRef({ kind: 'same-boundary', roleId: sib.id, boundaryId: sib.boundary_id })
    const parent = parentOf(db, mv.id, role.boundary_id)
    if (parent !== undefined) pushRef({ kind: 'contains', boundaryId: parent, direction: 'parent' })
    for (const child of childrenOf(db, mv.id, role.boundary_id))
      pushRef({ kind: 'contains', boundaryId: child, direction: 'child' })
    for (const rel of contractRels) {
      if (rel.contract.provider_boundary_id === role.boundary_id)
        for (const c of rel.consumerBoundaryIds)
          pushRef({
            kind: 'contract',
            contractId: rel.contract.id,
            contractName: rel.contract.name,
            boundaryId: c,
            direction: 'provides'
          })
      if (rel.consumerBoundaryIds.includes(role.boundary_id))
        pushRef({
          kind: 'contract',
          contractId: rel.contract.id,
          contractName: rel.contract.name,
          boundaryId: rel.contract.provider_boundary_id,
          direction: 'consumes'
        })
    }

    const { interfaceDigests, items: impls } = availabilityForRole(db, mv.id, role.id, {
      observedAt: now
    })
    const implPin =
      impls.length === 1
        ? {
            implementationId: impls[0]!.implementationId,
            implementationRevision: impls[0]!.revision,
            implementationDigest: implementationPinDigest({
              id: impls[0]!.implementationId,
              revision: impls[0]!.revision,
              interfaceDigest: impls[0]!.interfaceDigest,
              profileId: impls[0]!.profileId,
              profileRevision: impls[0]!.profileRevision,
              status: impls[0]!.status
            }),
            implementationCandidateDigest: implementationPinDigest({
              id: impls[0]!.implementationId,
              revision: impls[0]!.revision,
              interfaceDigest: impls[0]!.interfaceDigest,
              profileId: impls[0]!.profileId,
              profileRevision: impls[0]!.profileRevision,
              status: impls[0]!.status
            })
          }
        : impls.length > 1
          ? { implementationCandidateDigest: implementationSetDigest(impls) }
          : {}

    const memberAvailability: MemberAvailability[] = membersForRole(
      db,
      mv.id,
      role.id,
      req.projectId
    )
      .filter((m) => vis.runVisible(m.run_id))
      .map((m) => {
        const kind = latestAssignmentKind(db, m.id)
        return {
          memberId: m.id,
          runId: m.run_id,
          state: m.state,
          generation: m.generation,
          ...(kind !== undefined ? { assignmentKind: kind } : {}),
          observedAt: now
        }
      })

    const selectionToken = issueSelectionToken(deps.tokenSecret, {
      projectId: req.projectId,
      modelVersion: mv.id,
      roleId: role.id,
      roleDigest: roleDigest(role, mv.id),
      ...(interfaceDigests.length === 1 ? { interfaceDigest: interfaceDigests[0] } : {}),
      ...implPin,
      ...(filter.scopeBoundaryId !== undefined
        ? { scope: { scopeBoundaryId: filter.scopeBoundaryId } }
        : {}),
      issuedAt: now,
      ...(deps.tokenKeyId !== undefined ? { keyId: deps.tokenKeyId } : {})
    })

    cards.push({
      boundary: boundarySummary(db, mv.id, boundary),
      role: roleSummary(role),
      matchReasons,
      relationshipRefs,
      implementationAvailability: impls,
      memberAvailability,
      scopeCoverage: {
        matchedPaths: res_pathsForBoundary(pathResolutions, role.boundary_id),
        matchedContractIds: filter.contractIds.filter((cid) => {
          const rel = contractRels.find((r) => r.contract.id === cid)
          return (
            rel !== undefined &&
            (rel.contract.provider_boundary_id === role.boundary_id ||
              rel.consumerBoundaryIds.includes(role.boundary_id))
          )
        }),
        coversScope: scopeSet === null || scopeSet.has(role.boundary_id)
      },
      selectionToken
    })
  }

  // lexical ordering — 탐색 편의 only, never an expertise score or pick
  cards.sort(
    (a, b) =>
      a.boundary.name.localeCompare(b.boundary.name) ||
      a.role.name.localeCompare(b.role.name) ||
      a.role.id.localeCompare(b.role.id)
  )

  const page = cards.slice(offset, offset + limit)
  const nextCursor =
    offset + limit < cards.length
      ? sealPageCursor(deps.tokenSecret, {
          v: 1,
          modelVersion: mv.id,
          visibilityDigest: vd,
          filter: canonicalFilter(filter),
          offset: offset + limit,
          limit
        })
      : undefined

  const status: SearchResult['status'] =
    page.length > 0
      ? 'ok'
      : ambiguityGroups.length > 0
        ? 'ambiguous'
        : rolelessBoundaries.size > 0 ||
            unmatchedPaths.some(
              (u) => u.status === 'unassigned' || u.status === 'no-responsible-role'
            )
          ? 'unassigned'
          : 'no-match'

  return {
    modelVersion: mv.id,
    snapshotRevision: eventHighWater(db),
    staleModel: mv.stale,
    status,
    items: page,
    unmatchedPaths,
    ambiguityGroups,
    diagnostics: {
      rolelessBoundaryIds: [...rolelessBoundaries].sort(),
      unmatchedContractIds
    },
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    visibility: { visibilityDigest: vd, grantRevisions: ctx.grantRevisions }
  }
}

function res_pathsForBoundary(res: PathResolution[], boundaryId: string): string[] {
  const out: string[] = []
  for (const r of res) if (r.claimantIds.has(boundaryId)) out.push(r.np.path)
  return out
}

/** rebuild a SearchFilter from the cursor's canonical filter payload */
function denormalizeFilter(canonical: unknown): SearchFilter {
  const c = canonical as {
    q?: string | null
    p?: string[]
    ip?: string[]
    c?: string[]
    h?: string[]
    s?: string | null
  }
  const paths: NormalizedPath[] = []
  const rawPaths: string[] = []
  for (const p of c.p ?? []) {
    const np = tryNormalizeRepoPath(p)
    if (np !== null) {
      paths.push(np)
      rawPaths.push(np.path)
    }
  }
  return {
    ...(typeof c.q === 'string' ? { query: c.q } : {}),
    paths,
    rawPaths,
    invalidPaths: [...(c.ip ?? [])],
    contractIds: [...(c.c ?? [])],
    horizontalRoleNames: [...(c.h ?? [])],
    ...(typeof c.s === 'string' ? { scopeBoundaryId: c.s } : {})
  }
}
