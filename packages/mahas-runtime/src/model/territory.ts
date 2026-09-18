// mahas-runtime — model/discovery: code-path territory (spec/domains/rdd.md §2,
// spec/contracts/discovery-assignment.md `responsibility.locate`).
//
// Boundary paths are a responsibility-location INDEX, not a security ACL.
// Ancestor/descendant path containment is allowed and resolves to the most
// specific (deepest) claim; overlapping claims by boundaries that are NOT in
// a contains ancestor relation are returned as ambiguous — never silently
// tie-broken (rdd.md §2: "비조상 경계의 같은 파일 소유는 모호성으로 반환",
// "같은 깊이의 동률은 숨기지 않는다"). Unmatched paths stay `unassigned`.

import type { DatabaseSync } from 'node:sqlite'
import type { ModelVersionId, PathRef } from '../../../mahas-contracts/src/common.ts'
import type { BoundaryId } from '../../../mahas-contracts/src/ids.ts'

/* ------------------------------------------------------------------ *
 * path normalization (PathRef invariants: repo-relative, no NUL,
 * no absolute paths, no .. escapes — spec/common.md §1)
 * ------------------------------------------------------------------ */

export type NormalizedPath =
  | { ok: true; normalized: string }
  | { ok: false; reason: 'empty' | 'nul' | 'malformed-uri' | 'escape' | 'outside-repository' }

/**
 * Normalize a caller-supplied path/URI into the canonical repo-relative form
 * used by `boundary_paths`. Absolute paths and file:// URIs are accepted only
 * when they resolve inside `repositoryRoot` (lexical containment — symlink
 * verification is the caller's responsibility per C-DISCOVERY locate).
 */
export function normalizeRepoPath(input: string, repositoryRoot?: string): NormalizedPath {
  if (input.length === 0) return { ok: false, reason: 'empty' }
  if (input.includes('\0')) return { ok: false, reason: 'nul' }

  let p = input
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(new URL(p).pathname)
    } catch {
      return { ok: false, reason: 'malformed-uri' }
    }
  }
  // Treat both separators uniformly, then resolve '.'/'..' lexically.
  p = p.replace(/\\/g, '/')

  const isAbsolute = p.startsWith('/') || /^[A-Za-z]:\//.test(p)
  if (isAbsolute) {
    if (repositoryRoot === undefined) return { ok: false, reason: 'outside-repository' }
    const root = normalizeSegments(repositoryRoot.replace(/\\/g, '/'), '/')
    const abs = normalizeSegments(p, '/')
    if (abs === root) {
      p = ''
    } else if (abs.startsWith(root === '/' ? '/' : root + '/')) {
      p = abs.slice(root === '/' ? 1 : root.length + 1)
    } else {
      return { ok: false, reason: 'outside-repository' }
    }
  }

  const segments: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (segments.length === 0) return { ok: false, reason: 'escape' }
      segments.pop()
    } else {
      segments.push(seg)
    }
  }
  if (segments.length === 0) return { ok: false, reason: 'empty' }
  return { ok: true, normalized: segments.join('/') }
}

function normalizeSegments(p: string, leading = ''): string {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return leading + out.join('/')
}

/** Canonical form for a path about to be stored or compared as a claim. */
export function normalizeClaimPath(path: string): string | null {
  const r = normalizeRepoPath(path)
  return r.ok ? r.normalized : null
}

/* ------------------------------------------------------------------ *
 * contains-tree helpers (boundary_edges — shared by indices/impact)
 * ------------------------------------------------------------------ */

export interface ContainsTree {
  /** childId -> parentId (single parent per child, root excluded) */
  parentOf: Map<string, string>
  /** parentId -> childIds */
  childrenOf: Map<string, string[]>
}

export function loadContainsTree(db: DatabaseSync, modelVersion: ModelVersionId): ContainsTree {
  const rows = db
    .prepare('SELECT child_id, parent_id FROM boundary_edges WHERE model_version = ?')
    .all(modelVersion) as unknown as { child_id: string; parent_id: string }[]
  const parentOf = new Map<string, string>()
  const childrenOf = new Map<string, string[]>()
  for (const r of rows) {
    parentOf.set(r.child_id, r.parent_id)
    const kids = childrenOf.get(r.parent_id)
    if (kids) kids.push(r.child_id)
    else childrenOf.set(r.parent_id, [r.child_id])
  }
  return { parentOf, childrenOf }
}

/** Transitive ancestors of `boundaryId`, nearest parent first. Cycle-safe. */
export function ancestorChain(tree: ContainsTree, boundaryId: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([boundaryId])
  let cur = tree.parentOf.get(boundaryId)
  while (cur !== undefined && !seen.has(cur)) {
    out.push(cur)
    seen.add(cur)
    cur = tree.parentOf.get(cur)
  }
  return out
}

/** True when `a` is a transitive ancestor of `b` (strict — a !== b). */
export function isAncestorOf(tree: ContainsTree, a: string, b: string): boolean {
  return ancestorChain(tree, b).includes(a)
}

/** True when the two boundaries stand in a contains ancestor relation. */
export function areAncestorRelated(tree: ContainsTree, a: string, b: string): boolean {
  return isAncestorOf(tree, a, b) || isAncestorOf(tree, b, a)
}

/** `boundaryId` plus every transitive descendant (inclusive subtree). */
export function subtreeBoundaryIds(tree: ContainsTree, boundaryId: string): Set<string> {
  const out = new Set<string>()
  const stack = [boundaryId]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (out.has(cur)) continue
    out.add(cur)
    const kids = tree.childrenOf.get(cur)
    if (kids) stack.push(...kids)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * territory lookup
 * ------------------------------------------------------------------ */

export interface TerritoryClaim {
  boundaryId: BoundaryId
  /** normalized repo-relative claim path */
  path: string
  kind: 'file' | 'directory'
  /** path segment count — larger is more specific */
  depth: number
}

export type TerritoryStatus = 'assigned' | 'ambiguous' | 'unassigned'

export interface TerritoryLookup {
  /** normalized repo-relative input (echo of what was actually matched) */
  path: string
  status: TerritoryStatus
  /** present iff status === 'assigned' — the deepest claimant */
  boundaryId?: BoundaryId
  /** every stored claim covering the input, deepest first */
  claimants: TerritoryClaim[]
  /** boundaries involved in a non-ancestor overlap or a same-depth tie */
  ambiguousBoundaryIds?: BoundaryId[]
  /** per-path diagnostic for malformed/out-of-repo input */
  diagnostic?: string
}

/** raw boundary_paths row (storage.md §3 columns) */
export interface BoundaryPathRow {
  boundary_id: string
  path: string
  kind: string
}

/** All stored claims that cover `normalizedPath`, deepest claim first. */
function coveringClaims(rows: BoundaryPathRow[], normalizedPath: string): TerritoryClaim[] {
  const claims: TerritoryClaim[] = []
  for (const r of rows) {
    const claimPath = normalizeClaimPath(r.path)
    if (claimPath === null) continue
    const covers =
      r.kind === 'file'
        ? claimPath === normalizedPath
        : claimPath === normalizedPath || normalizedPath.startsWith(claimPath + '/')
    if (!covers) continue
    claims.push({
      boundaryId: r.boundary_id as BoundaryId,
      path: claimPath,
      kind: r.kind as 'file' | 'directory',
      depth: claimPath.split('/').length
    })
  }
  claims.sort((a, b) => b.depth - a.depth || a.boundaryId.localeCompare(b.boundaryId))
  return claims
}

/**
 * Resolve one normalized path against `boundary_paths` for a model version.
 *
 * Decision order (rdd.md §2):
 *  1. no covering claim            -> unassigned
 *  2. any pair of claimant boundaries not in a contains ancestor relation
 *                                  -> ambiguous (all claimants reported)
 *  3. several claims at max depth  -> ambiguous (same-depth tie, not hidden)
 *  4. unique deepest claimant      -> assigned
 */
export function resolveTerritory(
  tree: ContainsTree,
  pathRows: BoundaryPathRow[],
  normalizedPath: string
): TerritoryLookup {
  const claimants = coveringClaims(pathRows, normalizedPath)
  if (claimants.length === 0) {
    return { path: normalizedPath, status: 'unassigned', claimants }
  }

  const boundaryIds = [...new Set(claimants.map((c) => c.boundaryId as string))]
  const unrelated = new Set<string>()
  for (let i = 0; i < boundaryIds.length; i++) {
    for (let j = i + 1; j < boundaryIds.length; j++) {
      if (!areAncestorRelated(tree, boundaryIds[i]!, boundaryIds[j]!)) {
        unrelated.add(boundaryIds[i]!)
        unrelated.add(boundaryIds[j]!)
      }
    }
  }
  if (unrelated.size > 0) {
    return {
      path: normalizedPath,
      status: 'ambiguous',
      claimants,
      ambiguousBoundaryIds: [...unrelated].sort() as BoundaryId[]
    }
  }

  const maxDepth = claimants[0]!.depth
  const deepest = claimants.filter((c) => c.depth === maxDepth)
  const deepestBoundaryIds = [...new Set(deepest.map((c) => c.boundaryId as string))]
  if (deepestBoundaryIds.length > 1) {
    return {
      path: normalizedPath,
      status: 'ambiguous',
      claimants,
      ambiguousBoundaryIds: deepestBoundaryIds.sort() as BoundaryId[],
      diagnostic: 'same-depth-claim-tie'
    }
  }
  return {
    path: normalizedPath,
    status: 'assigned',
    boundaryId: deepestBoundaryIds[0] as BoundaryId,
    claimants
  }
}

/**
 * `responsibility.locate` backbone: normalize each input and resolve it against
 * the version's path claims. One DB pass per call; inputs keep their order.
 */
export function locatePaths(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  paths: readonly string[],
  opts: { repositoryRoot?: string } = {}
): TerritoryLookup[] {
  const tree = loadContainsTree(db, modelVersion)
  const pathRows = db
    .prepare('SELECT boundary_id, path, kind FROM boundary_paths WHERE model_version = ?')
    .all(modelVersion) as unknown as BoundaryPathRow[]

  return paths.map((raw) => {
    const n = normalizeRepoPath(raw, opts.repositoryRoot)
    if (!n.ok) {
      return {
        path: raw,
        status: 'unassigned' as const,
        claimants: [],
        diagnostic: `invalid-path:${n.reason}`
      }
    }
    const found = resolveTerritory(tree, pathRows, n.normalized)
    return { ...found, path: n.normalized }
  })
}

/** Convenience single-path form of {@link locatePaths}. */
export function locatePath(
  db: DatabaseSync,
  modelVersion: ModelVersionId,
  path: PathRef['repoRelativePath'] | string,
  opts: { repositoryRoot?: string } = {}
): TerritoryLookup {
  return locatePaths(db, modelVersion, [path], opts)[0]!
}
