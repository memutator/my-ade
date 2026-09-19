// mahas-runtime/src/discovery/locate.ts — responsibility.locate
//
// Per requested path: normalize (PathRef rules — no abs/NUL/.. escapes),
// resolve the deepest visible owning boundary from boundary_paths claims,
// or report ambiguous/unassigned/invalid. Contract rules honored:
//   - deepest (most specific) prefix wins; non-ancestor ties are ambiguous
//     and EVERY overlapping claimant is shown — never a random tie-break
//   - invisible claimants are filtered first: a hidden boundary cannot
//     claim territory in the caller's view (and never leaks its name)
//   - 'covers' claims (a boundary's paths under a queried directory) are
//     shown as informational claimants but do not compete for deepest
//   - query only; AMBIGUOUS_TERRITORY is reported per-path, not thrown,
//     because the contract's return shape is per-path diagnostics

import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import type { DiscoveryDeps } from './deps.ts'
import {
  loadContainsTree,
  resolveTerritory,
  type BoundaryPathRow as TerritoryPathRow
} from '../model/territory.ts'
import {
  ancestorsOf,
  claimantsForPath,
  eventHighWater,
  getBoundary,
  listRoles,
  projectRepositoryRoot,
  resolveModelVersion,
  roleSummary,
  tryNormalizeRepoPath,
  visibilityDigest
} from './model-read.ts'
import { discoveryError, target } from './types.ts'
import { makeVisibility } from './visibility.ts'
import type { LocateClaimant, LocatedPath, LocateRequest, LocateResult } from './types.ts'
import type { NormalizedPath, PathClaim } from './model-read.ts'

export function validateLocateRequest(payload: unknown): LocateRequest {
  const p = payload as Partial<LocateRequest>
  if (typeof p?.projectId !== 'string' || p.projectId.length === 0)
    throw discoveryError('MODEL_INVALID', 'responsibility.locate requires projectId')
  if (p?.modelVersion !== undefined && typeof p.modelVersion !== 'string')
    throw discoveryError('MODEL_INVALID', 'modelVersion must be a string')
  if (!Array.isArray(p?.paths) || p.paths.length === 0)
    throw discoveryError('MODEL_INVALID', 'responsibility.locate requires paths[]')
  if (p.paths.length > 256)
    throw discoveryError('MODEL_INVALID', 'paths[] exceeds the per-request bound', {
      limit: 256
    })
  return {
    projectId: p.projectId,
    ...(p.modelVersion !== undefined ? { modelVersion: p.modelVersion } : {}),
    paths: p.paths as string[]
  }
}

interface VisibleClaim extends PathClaim {
  boundaryName: string
}

export interface VisibleTerritory {
  status: 'resolved' | 'ambiguous' | 'unassigned'
  winnerId?: string
  /** non-ancestor overlapping claimants — never deepest-wins */
  ambiguousBoundaryIds: string[]
}

/**
 * Territory decision for one normalized path, using IMP-05 resolveTerritory
 * over the caller's visible claims. Non-ancestor overlap is always
 * ambiguous — a deeper claim never silently wins.
 */
export function resolveVisibleTerritory(
  db: DatabaseSync,
  modelVersion: string,
  np: NormalizedPath,
  visibleBoundary: (id: string) => boolean
): VisibleTerritory {
  const pathRows = db
    .prepare('SELECT boundary_id, path, kind FROM boundary_paths WHERE model_version = ?')
    .all(modelVersion) as unknown as TerritoryPathRow[]
  const visibleRows = pathRows.filter((r) => visibleBoundary(r.boundary_id))
  const tree = loadContainsTree(db, modelVersion as never)
  const lookup = resolveTerritory(tree, visibleRows, np.path)
  if (lookup.status === 'assigned' && lookup.boundaryId !== undefined) {
    return { status: 'resolved', winnerId: lookup.boundaryId as string, ambiguousBoundaryIds: [] }
  }
  if (lookup.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      ambiguousBoundaryIds: (lookup.ambiguousBoundaryIds ?? []).map(String)
    }
  }
  return { status: 'unassigned', ambiguousBoundaryIds: [] }
}

export function responsibilityLocate(
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  deps: DiscoveryDeps,
  payload: unknown
): LocateResult {
  const req = validateLocateRequest(payload)
  const mv = resolveModelVersion(db, req.projectId, req.modelVersion)

  const vis = makeVisibility(ctx, deps, 'responsibility.locate', mv.id, [
    target('project', req.projectId)
  ])
  vis.require()

  const repoRoot = projectRepositoryRoot(db, req.projectId)
  const items: LocatedPath[] = []
  for (const rawPath of req.paths) {
    const np: NormalizedPath | null =
      typeof rawPath === 'string' ? tryNormalizeRepoPath(rawPath, repoRoot) : null
    if (np === null) {
      items.push({
        path: String(rawPath),
        status: 'invalid',
        claimants: [],
        reason: 'not a valid repo-relative path (abs/NUL/.. escapes rejected)'
      })
      continue
    }

    // every claim, then drop the ones the caller cannot see
    const claims = claimantsForPath(db, mv.id, np)
    const visible: VisibleClaim[] = []
    for (const c of claims) {
      if (!vis.boundaryVisible(c.boundaryId)) continue
      const b = getBoundary(db, mv.id, c.boundaryId)
      if (b === undefined) continue
      visible.push({ ...c, boundaryName: b.name })
    }

    const owners = visible.filter((c) => c.claim === 'owns')
    const covers = visible.filter((c) => c.claim === 'covers')
    const territory = resolveVisibleTerritory(db, mv.id, np, (id) => vis.boundaryVisible(id))
    const winner =
      territory.status === 'resolved'
        ? (visible.find((c) => c.boundaryId === territory.winnerId) ??
          owners.find((c) => c.boundaryId === territory.winnerId))
        : undefined
    const tied =
      territory.status === 'ambiguous'
        ? visible.filter(
            (c) => c.claim === 'owns' && territory.ambiguousBoundaryIds.includes(c.boundaryId)
          )
        : []

    // deepest first, then stable id order — the shared claim listing
    const sorted = [...visible].sort(
      (a, b) => b.depth - a.depth || a.boundaryId.localeCompare(b.boundaryId)
    )
    const toClaimant = (c: VisibleClaim, relation: LocateClaimant['relation']): LocateClaimant => ({
      boundaryId: c.boundaryId,
      boundaryName: c.boundaryName,
      matchedPath: c.matchedPath,
      claim: c.claim,
      ...(relation !== undefined ? { relation } : {})
    })

    // An ambiguity is the tie between same-depth, non-ancestor claimants.
    // Shallower owners (ancestors/containers) are not part of the contest:
    // they are reported in ancestorClaimants instead of inflating the set.
    let claimants: LocateClaimant[]
    let ancestorClaimants: LocateClaimant[] | undefined
    if (winner !== undefined) {
      const winnerAncestors = new Set(ancestorsOf(db, mv.id, winner.boundaryId))
      claimants = sorted.map((c) =>
        toClaimant(
          c,
          c.claim !== 'owns'
            ? undefined
            : c.boundaryId === winner.boundaryId
              ? 'self'
              : winnerAncestors.has(c.boundaryId)
                ? 'ancestor'
                : 'unrelated'
        )
      )
    } else if (tied.length > 0) {
      const tiedIds = new Set(tied.map((c) => c.boundaryId))
      const tiedAncestors = new Set<string>()
      for (const t of tied)
        for (const a of ancestorsOf(db, mv.id, t.boundaryId)) tiedAncestors.add(a)
      claimants = sorted
        .filter((c) => tiedIds.has(c.boundaryId) || c.claim === 'covers')
        .map((c) => toClaimant(c, c.claim === 'owns' ? 'unrelated' : undefined))
      const shallower = sorted.filter(
        (c) => c.claim === 'owns' && !tiedIds.has(c.boundaryId) && tiedAncestors.has(c.boundaryId)
      )
      if (shallower.length > 0) ancestorClaimants = shallower.map((c) => toClaimant(c, 'ancestor'))
    } else {
      claimants = sorted.map((c) => toClaimant(c, undefined))
    }

    if (winner !== undefined) {
      items.push({
        path: np.path,
        status: 'resolved',
        boundaryId: winner.boundaryId,
        matchedPath: winner.matchedPath,
        claimants,
        roles: listRoles(db, mv.id, winner.boundaryId)
          .filter((r) => vis.roleVisible(r.id, r.boundary_id))
          .map(roleSummary)
      })
    } else if (tied.length > 0) {
      items.push({
        path: np.path,
        status: 'ambiguous',
        claimants,
        ...(ancestorClaimants !== undefined ? { ancestorClaimants } : {}),
        reason:
          'overlapping territory claims at the same depth — split or bind a contract, ' +
          'no automatic pick'
      })
    } else {
      items.push({
        path: np.path,
        status: 'unassigned',
        claimants,
        reason:
          covers.length > 0
            ? 'no boundary owns this path; descendant claims exist under it'
            : 'no boundary owns this path'
      })
    }
  }

  return {
    modelVersion: mv.id,
    snapshotRevision: eventHighWater(db),
    staleModel: mv.stale,
    items,
    visibility: {
      visibilityDigest: visibilityDigest(ctx, mv.id),
      grantRevisions: ctx.grantRevisions
    }
  }
}
