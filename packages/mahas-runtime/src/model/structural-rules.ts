// mahas-runtime/model — publish-time structural rules (D-RDD §1–3, REQ-03).
//
// These are the STRUCTURAL gates on a candidate snapshot before it may be
// published. They are deliberately separated from semantic review: a
// structural error is machine-checkable and blocks commit; trade-off judgment
// between criteria is the maintainer's call and is never reduced to a numeric
// gate ("기준 사이 trade-off를 수치 gate로 만들지 않는다").
//
// Rules enforced here:
//   1. exactly one root (published model has a single parentless boundary)
//   2. contains = connected acyclic single-parent tree (child→parent map is
//      single-valued by construction; we verify reachability + no cycles +
//      every parent reference resolves)
//   3. referential integrity of every relation the DDL expresses as an FK —
//      retired targets must have been detached/remapped in the same change,
//      otherwise their references dangle here
//   4. every boundary carries ≥1 criterion (ordinal order, no pass threshold)
//   5. path formats — boundary paths, context paths and contract schema paths
//      are repo-relative anchors: non-empty, no NUL, not absolute, no `..`
//   6. territory overlap between non-ancestor boundaries is NOT a publish
//      error — it is reported as an `ambiguous` review diagnostic so the
//      maintainer can re-judge split/contract instead of one boundary being
//      silently preferred (D-RDD §2)

import type { TargetRef } from '../access/authorize.ts'
// (no contract imports needed — operates on the in-memory snapshot shape)
import type { ModelSnapshot } from './repository.ts'

export type DiagnosticSeverity = 'error' | 'review'

export interface Diagnostic {
  severity: DiagnosticSeverity
  /** machine-readable rule id, e.g. MULTIPLE_ROOTS, DANGLING_ROLE_BOUNDARY */
  code: string
  message: string
  target?: TargetRef
}

const err = (code: string, message: string, target?: TargetRef): Diagnostic => ({
  severity: 'error',
  code,
  message,
  target
})

const review = (code: string, message: string, target?: TargetRef): Diagnostic => ({
  severity: 'review',
  code,
  message,
  target
})

const bTarget = (id: string): TargetRef => ({ kind: 'boundary', id })

/**
 * Repo-relative anchor validation (S-COMMON §1 PathRef rules applied to the
 * RDD path columns): non-empty, no NUL, not absolute (posix or drive), no
 * `..` segments. `.` normalizes to the project root and is allowed only as
 * the root prefix itself? No — `.` segments are rejected to keep anchors
 * canonical; callers should store the normalized form.
 */
export function isValidAnchorPath(path: string): boolean {
  if (path.length === 0) return false
  if (path.includes('')) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  if (/^[A-Za-z]:[\\/]/.test(path)) return false
  const segments = path.split('/')
  for (const seg of segments) {
    if (seg === '..') return false
    if (seg === '') return false // empty segment = `//` or trailing `/`
    if (seg === '.') return false
  }
  return true
}

/**
 * Validate a candidate snapshot for publication. Returns every diagnostic —
 * callers split on severity: `error` blocks commit (MODEL_INVALID), `review`
 * is returned to the maintainer as a semantic-review item.
 */
export function validateCandidate(snapshot: ModelSnapshot): Diagnostic[] {
  const out: Diagnostic[] = []
  checkRoot(snapshot, out)
  checkTree(snapshot, out)
  checkBoundaries(snapshot, out)
  checkRoles(snapshot, out)
  checkContexts(snapshot, out)
  checkContracts(snapshot, out)
  checkNonGoals(snapshot, out)
  checkPathOverlaps(snapshot, out)
  return out
}

/* ---- 1: exactly one root ---- */
function checkRoot(s: ModelSnapshot, out: Diagnostic[]): void {
  const roots = [...s.boundaries.values()].filter((b) => b.parentId === null)
  if (s.boundaries.size === 0) {
    out.push(err('EMPTY_MODEL', 'published model requires at least one boundary'))
    return
  }
  if (roots.length === 0) {
    out.push(err('NO_ROOT', 'no root boundary — exactly one boundary must be parentless'))
  } else if (roots.length > 1) {
    for (const r of roots) {
      out.push(
        err(
          'MULTIPLE_ROOTS',
          `boundary "${r.id}" is parentless; published model requires exactly one root`,
          bTarget(r.id)
        )
      )
    }
  }
}

/* ---- 2: connected acyclic tree ---- */
function checkTree(s: ModelSnapshot, out: Diagnostic[]): void {
  for (const b of s.boundaries.values()) {
    if (b.parentId !== null && !s.boundaries.has(b.parentId)) {
      out.push(
        err(
          'DANGLING_PARENT',
          `boundary "${b.id}" contains-parent "${b.parentId}" does not exist in this version`,
          bTarget(b.id)
        )
      )
    }
  }
  // cycle walk: follow each boundary's parent chain marking the path
  for (const start of s.boundaries.keys()) {
    const seen = new Set<string>()
    let cur: string | null = start
    while (cur !== null) {
      if (seen.has(cur)) {
        out.push(
          err('CONTAINS_CYCLE', `contains cycle detected through boundary "${cur}"`, bTarget(cur))
        )
        break
      }
      seen.add(cur)
      cur = s.boundaries.get(cur)?.parentId ?? null
      if (cur !== null && !s.boundaries.has(cur)) break // dangling already reported
    }
  }
  // connectivity: walk down from the single root; everything must be reached
  const roots = [...s.boundaries.values()].filter((b) => b.parentId === null).map((b) => b.id)
  if (roots.length === 1) {
    const children = new Map<string, string[]>()
    for (const b of s.boundaries.values()) {
      if (b.parentId !== null) {
        const list = children.get(b.parentId) ?? []
        list.push(b.id)
        children.set(b.parentId, list)
      }
    }
    const reached = new Set<string>()
    const stack = [roots[0]!]
    while (stack.length > 0) {
      const id = stack.pop()!
      if (reached.has(id)) continue
      reached.add(id)
      for (const c of children.get(id) ?? []) stack.push(c)
    }
    for (const b of s.boundaries.values()) {
      if (!reached.has(b.id)) {
        out.push(
          err(
            'DISCONNECTED_BOUNDARY',
            `boundary "${b.id}" is not reachable from root "${roots[0]}" — contains must form one connected tree`,
            bTarget(b.id)
          )
        )
      }
    }
  }
}

/* ---- 4/5: boundary content — responsibility, ≥1 criterion, path format ---- */
function checkBoundaries(s: ModelSnapshot, out: Diagnostic[]): void {
  for (const b of s.boundaries.values()) {
    if (b.name.trim().length === 0) {
      out.push(err('EMPTY_NAME', `boundary "${b.id}" has an empty name`, bTarget(b.id)))
    }
    if (b.responsibilityStatement.trim().length === 0) {
      out.push(
        err(
          'EMPTY_RESPONSIBILITY',
          `boundary "${b.id}" must declare exactly one responsibility — the statement is empty`,
          bTarget(b.id)
        )
      )
    }
    if (b.criteria.length === 0) {
      out.push(
        err(
          'MISSING_CRITERION',
          `boundary "${b.id}" has no criterion — every boundary needs at least one criterion-description`,
          bTarget(b.id)
        )
      )
    }
    const critIds = new Set<string>()
    for (const c of b.criteria) {
      if (critIds.has(c.id)) {
        out.push(
          err(
            'DUPLICATE_CRITERION',
            `boundary "${b.id}" repeats criterion id "${c.id}"`,
            bTarget(b.id)
          )
        )
      }
      critIds.add(c.id)
      if (c.criterion.trim().length === 0 || c.description.trim().length === 0) {
        out.push(
          err(
            'EMPTY_CRITERION',
            `boundary "${b.id}" criterion "${c.id}" needs both criterion and description text`,
            bTarget(b.id)
          )
        )
      }
    }
    for (const p of b.paths) {
      if (!isValidAnchorPath(p.path)) {
        out.push(
          err(
            'INVALID_PATH',
            `boundary "${b.id}" path "${p.path}" must be a non-empty repo-relative anchor without NUL/absolute/.. segments`,
            bTarget(b.id)
          )
        )
      }
    }
  }
}

/* ---- 3: role FKs — boundary + horizontalRole must resolve ---- */
function checkRoles(s: ModelSnapshot, out: Diagnostic[]): void {
  for (const r of s.roles.values()) {
    if (!s.boundaries.has(r.boundaryId)) {
      out.push(
        err(
          'DANGLING_ROLE_BOUNDARY',
          `role "${r.id}" references boundary "${r.boundaryId}" which does not exist — a retired boundary needs its roles detached/remapped in the same change`,
          { kind: 'role', id: r.id }
        )
      )
    }
    if (!s.horizontalRoles.has(r.horizontalRoleName)) {
      out.push(
        err(
          'DANGLING_ROLE_HORIZONTAL',
          `role "${r.id}" references horizontalRole "${r.horizontalRoleName}" which is not declared in this version`,
          { kind: 'role', id: r.id }
        )
      )
    }
    if (r.name.trim().length === 0 || r.description.trim().length === 0) {
      out.push(
        err('EMPTY_ROLE', `role "${r.id}" needs both name and duty description`, {
          kind: 'role',
          id: r.id
        })
      )
    }
  }
}

/* ---- 3/5: contexts — path only; link targets must resolve ---- */
function checkContexts(s: ModelSnapshot, out: Diagnostic[]): void {
  for (const c of s.contexts.values()) {
    if (!isValidAnchorPath(c.path)) {
      out.push(
        err(
          'INVALID_CONTEXT_PATH',
          `context "${c.id}" path "${c.path}" must be a repo-relative anchor — contexts store path only, the body stays in the file`,
          { kind: 'context', id: c.id }
        )
      )
    }
  }
  for (const b of s.boundaries.values()) {
    for (const cx of b.contextIds) {
      if (!s.contexts.has(cx)) {
        out.push(
          err(
            'DANGLING_BOUNDARY_CONTEXT',
            `boundary "${b.id}" links context "${cx}" which does not exist in this version`,
            bTarget(b.id)
          )
        )
      }
    }
  }
  for (const h of s.horizontalRoles.values()) {
    for (const cx of h.contextIds) {
      if (!s.contexts.has(cx)) {
        out.push(
          err(
            'DANGLING_HORIZONTAL_CONTEXT',
            `horizontalRole "${h.name}" links context "${cx}" which does not exist in this version`,
            { kind: 'horizontal-role', id: h.name }
          )
        )
      }
    }
  }
}

/* ---- 3/5: contracts — provider + ≥1 resolvable consumer, schema anchor ---- */
function checkContracts(s: ModelSnapshot, out: Diagnostic[]): void {
  for (const c of s.contracts.values()) {
    if (!s.boundaries.has(c.providerBoundaryId)) {
      out.push(
        err(
          'DANGLING_CONTRACT_PROVIDER',
          `contract "${c.id}" provider boundary "${c.providerBoundaryId}" does not exist — a retired provider needs the contract remapped or retired in the same change`,
          { kind: 'contract', id: c.id }
        )
      )
    }
    if (c.consumerBoundaryIds.length === 0) {
      out.push(
        err(
          'CONTRACT_WITHOUT_CONSUMER',
          `contract "${c.id}" has no consumer — a contract needs at least one consuming boundary`,
          { kind: 'contract', id: c.id }
        )
      )
    }
    for (const consumer of c.consumerBoundaryIds) {
      if (!s.boundaries.has(consumer)) {
        out.push(
          err(
            'DANGLING_CONTRACT_CONSUMER',
            `contract "${c.id}" consumer boundary "${consumer}" does not exist — a retired consumer needs its dependency detached/remapped in the same change`,
            { kind: 'contract', id: c.id }
          )
        )
      }
      if (consumer === c.providerBoundaryId) {
        out.push(
          review(
            'SELF_CONTRACT',
            `contract "${c.id}" lists its provider boundary "${consumer}" as a consumer — confirm this is a real external dependency`,
            { kind: 'contract', id: c.id }
          )
        )
      }
    }
    if (!isValidAnchorPath(c.schemaPath)) {
      out.push(
        err(
          'INVALID_SCHEMA_PATH',
          `contract "${c.id}" schemaPath "${c.schemaPath}" must be a repo-relative anchor to the schema file`,
          { kind: 'contract', id: c.id }
        )
      )
    }
    if (c.name.trim().length === 0) {
      out.push(
        err('EMPTY_NAME', `contract "${c.id}" has an empty name`, { kind: 'contract', id: c.id })
      )
    }
  }
}

/* ---- 3: non-goals live on a real boundary ---- */
function checkNonGoals(s: ModelSnapshot, out: Diagnostic[]): void {
  for (const n of s.nonGoals.values()) {
    if (!s.boundaries.has(n.boundaryId)) {
      out.push(
        err(
          'DANGLING_NON_GOAL',
          `non-goal "${n.id}" is anchored to boundary "${n.boundaryId}" which does not exist — non-goals sit on real boundaries, not an unassigned label`,
          { kind: 'non-goal', id: n.id }
        )
      )
    }
    if (n.statement.trim().length === 0) {
      out.push(
        err('EMPTY_NON_GOAL', `non-goal "${n.id}" has an empty statement`, {
          kind: 'non-goal',
          id: n.id
        })
      )
    }
  }
}

/* ---- 6: non-ancestor territory overlap → ambiguous review note ---- */
function checkPathOverlaps(s: ModelSnapshot, out: Diagnostic[]): void {
  const owns: { boundaryId: string; path: string; kind: 'file' | 'directory' }[] = []
  for (const b of s.boundaries.values()) {
    for (const p of b.paths) owns.push({ boundaryId: b.id, path: p.path, kind: p.kind })
  }
  const ancestorsOf = (id: string): Set<string> => {
    const chain = new Set<string>()
    let cur = s.boundaries.get(id)?.parentId ?? null
    while (cur !== null && !chain.has(cur)) {
      chain.add(cur)
      cur = s.boundaries.get(cur)?.parentId ?? null
    }
    return chain
  }
  const covered = (a: string, b: string): boolean => a === b || a.startsWith(b + '/')
  const reported = new Set<string>()
  for (let i = 0; i < owns.length; i++) {
    for (let j = i + 1; j < owns.length; j++) {
      const x = owns[i]!
      const y = owns[j]!
      if (x.boundaryId === y.boundaryId) continue
      const xa = ancestorsOf(x.boundaryId)
      const ya = ancestorsOf(y.boundaryId)
      // ancestor/descendant path nesting is allowed (child prefix wins on lookup)
      if (xa.has(y.boundaryId) || ya.has(x.boundaryId)) continue
      const overlap =
        covered(x.path, y.path) || covered(y.path, x.path)
          ? x.kind === 'directory' || y.kind === 'directory' || x.path === y.path
          : false
      if (!overlap) continue
      const key = [x.boundaryId, y.boundaryId, x.path, y.path].sort().join('|')
      if (reported.has(key)) continue
      reported.add(key)
      out.push(
        review(
          'AMBIGUOUS_TERRITORY',
          `paths "${x.path}" (${x.boundaryId}) and "${y.path}" (${y.boundaryId}) overlap across non-ancestor boundaries — territory lookup will report ambiguity rather than pick one; consider split or contract`,
          bTarget(x.boundaryId)
        )
      )
    }
  }
}

export function errorsOnly(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d) => d.severity === 'error')
}

export function reviewOnly(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d) => d.severity === 'review')
}
