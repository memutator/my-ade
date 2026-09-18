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
  ancestorsOf,
  claimantsForPath,
  eventHighWater,
  getBoundary,
  listRoles,
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

/**
 * Pick the deepest owning boundary among visible claims.
 * Returns the winner, or the tied winners when the deepest claim is held
 * by several boundaries that are NOT in an ancestor relation (territory
 * overlap → ambiguous, never silently tie-broken).
 */
function resolveDeepest(
  db: DatabaseSync,
  modelVersion: string,
  owners: VisibleClaim[]
): { winner?: VisibleClaim; tied: VisibleClaim[] } {
  if (owners.length === 0) return { tied: [] }
  const maxDepth = Math.max(...owners.map((c) => c.depth))
  const deepest = owners.filter((c) => c.depth === maxDepth)
  if (deepest.length === 1) return { winner: deepest[0], tied: [] }

  // ancestor-related ties resolve to the tree-descendant (more specific
  // responsibility); only non-ancestor overlap is ambiguous
  const ancestorCache = new Map<string, Set<string>>()
  const anc = (id: string): Set<string> => {
    let s = ancestorCache.get(id)
    if (s === undefined) {
      s = new Set(ancestorsOf(db, modelVersion, id))
      ancestorCache.set(id, s)
    }
    return s
  }
  const descendants = deepest.filter((d) =>
    deepest.every((o) => o === d || anc(d.boundaryId).has(o.boundaryId))
  )
  if (descendants.length === 1) return { winner: descendants[0], tied: [] }
  return { tied: deepest }
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

  const items: LocatedPath[] = []
  for (const rawPath of req.paths) {
    const np: NormalizedPath | null =
      typeof rawPath === 'string' ? tryNormalizeRepoPath(rawPath) : null
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
    const { winner, tied } = resolveDeepest(db, mv.id, owners)

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
