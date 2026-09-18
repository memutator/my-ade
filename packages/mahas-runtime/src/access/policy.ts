// policy.ts — RolePolicy store: the per-role action CEILING
// (spec/domains/access.md §1–2, spec/storage.md §3 `role_policies`,
// C-ACCESS `access.policy.publish`).
//
// A RolePolicy caps what a role may EVER do — it is a maximum, not an
// assignment: ceiling ∩ grant is the effective authority. Policies are
// versioned and immutable once written; publish appends revision N+1 with an
// expectedRevision compare (STALE_REVISION on drift) and emits the
// invalidation event in the same transaction.
//
// Selector matching is explicit-field AND matching against the member's
// resolved (model_version, role, boundary, horizontalRole) — role NAME and
// containment never auto-promote (REQ-10).

import type { DatabaseSync } from 'node:sqlite'
import { appendDomainEvent, sha256Hex } from '../storage/db.ts'
import { ensureTx, fail, stableStringify } from './internal.ts'

export interface RoleSelector {
  roleId?: string
  modelVersion?: string
  boundaryId?: string
  horizontalRoleName?: string
}

/** Normalized row of `role_policies`. */
export interface RolePolicyRow {
  id: string
  revision: number
  selector: RoleSelector
  actionCeiling: string[]
  projectionPolicy: unknown
}

export interface RolePolicyPublishInput {
  policyId?: string
  roleSelector: RoleSelector
  expectedRevision?: number
  actionCeiling: string[]
  projectionPolicy?: unknown
}

export interface RolePolicyPublishResult {
  policy: RolePolicyRow
  affectedRoleIds: { modelVersion: string; roleId: string }[]
  affectedMemberIds: string[]
}

interface RolePolicySqlRow {
  id: string
  revision: number
  selector_json: string
  action_ceiling_json: string
  projection_policy_json: string
}

function rowFromSql(r: RolePolicySqlRow): RolePolicyRow {
  return {
    id: r.id,
    revision: r.revision,
    selector: JSON.parse(r.selector_json) as RoleSelector,
    actionCeiling: JSON.parse(r.action_ceiling_json) as string[],
    projectionPolicy: JSON.parse(r.projection_policy_json)
  }
}

/** Deterministic id for a selector — makes first publish of a policy nameable. */
export function derivePolicyId(selector: RoleSelector): string {
  return `pol_${sha256Hex(stableStringify(selector)).slice(0, 24)}`
}

export function getRolePolicyRow(
  db: DatabaseSync,
  policyId: string,
  revision?: number
): RolePolicyRow | null {
  const row = (
    revision == null
      ? db
          .prepare('SELECT * FROM role_policies WHERE id = ? ORDER BY revision DESC LIMIT 1')
          .get(policyId)
      : db
          .prepare('SELECT * FROM role_policies WHERE id = ? AND revision = ?')
          .get(policyId, revision)
  ) as RolePolicySqlRow | undefined
  return row ? rowFromSql(row) : null
}

/** Current published revision for a policy; 0 when it does not exist yet. */
export function currentPolicyRevision(db: DatabaseSync, policyId: string): number {
  const row = db
    .prepare('SELECT MAX(revision) AS rev FROM role_policies WHERE id = ?')
    .get(policyId) as { rev: number | null } | undefined
  return row?.rev ?? 0
}

/**
 * Publish a new policy revision. expectedRevision must equal the current
 * max (or 0/undefined for first publish) — CAS, never blind overwrite.
 * Emits `access.policy.published` + `access.invalidated` in the same tx.
 */
export function publishRolePolicy(
  db: DatabaseSync,
  input: RolePolicyPublishInput,
  at: number = Date.now()
): RolePolicyPublishResult {
  const selector = input.roleSelector
  if (!selector || Object.values(selector).every((v) => v == null)) {
    fail('INPUT_NOT_READY', 'roleSelector must name at least one match field')
  }
  if (
    !Array.isArray(input.actionCeiling) ||
    input.actionCeiling.some((a) => typeof a !== 'string')
  ) {
    fail('INPUT_NOT_READY', 'actionCeiling must be an array of action names')
  }
  const policyId = input.policyId ?? derivePolicyId(selector)
  return ensureTx(db, (tx) => {
    const current = currentPolicyRevision(tx, policyId)
    const expected = input.expectedRevision ?? current
    if (expected !== current) {
      fail('STALE_REVISION', `policy '${policyId}' is at revision ${current}, expected ${expected}`)
    }
    const revision = current + 1
    tx.prepare(
      'INSERT INTO role_policies (id, revision, selector_json, action_ceiling_json, projection_policy_json) VALUES (?, ?, ?, ?, ?)'
    ).run(
      policyId,
      revision,
      JSON.stringify(selector),
      JSON.stringify(input.actionCeiling),
      JSON.stringify(input.projectionPolicy ?? {})
    )
    const affectedRoleIds = roleIdsForSelector(tx, selector)
    const affectedMemberIds = memberIdsForRoles(tx, affectedRoleIds)
    appendDomainEvent(
      tx,
      policyId,
      revision,
      'access.policy.published',
      { domain: 'access', policyId },
      {
        revision,
        selector,
        actionCeiling: input.actionCeiling,
        affectedRoleIds,
        affectedMemberIds,
        at
      }
    )
    appendDomainEvent(
      tx,
      policyId,
      revision,
      'access.invalidated',
      { domain: 'access', scope: 'surface' },
      { reason: 'policy-published', policyId, policyRevision: revision }
    )
    return {
      policy: {
        id: policyId,
        revision,
        selector,
        actionCeiling: [...input.actionCeiling],
        projectionPolicy: input.projectionPolicy ?? {}
      },
      affectedRoleIds,
      affectedMemberIds
    }
  })
}

/** AND-match: every set selector field must equal the role's resolved context. */
export function selectorMatchesRole(
  selector: RoleSelector,
  role: {
    roleId: string
    modelVersion?: string | null
    boundaryId?: string | null
    horizontalRoleName?: string | null
  }
): boolean {
  if (selector.roleId != null && selector.roleId !== role.roleId) return false
  if (selector.modelVersion != null && selector.modelVersion !== role.modelVersion) return false
  if (selector.boundaryId != null && selector.boundaryId !== role.boundaryId) return false
  if (
    selector.horizontalRoleName != null &&
    selector.horizontalRoleName !== role.horizontalRoleName
  )
    return false
  return true
}

function selectorSpecificity(selector: RoleSelector): number {
  return (
    (selector.roleId != null ? 8 : 0) +
    (selector.boundaryId != null ? 4 : 0) +
    (selector.horizontalRoleName != null ? 2 : 0) +
    (selector.modelVersion != null ? 1 : 0)
  )
}

/** Roles matching a selector, resolved against rdd_roles. */
export function roleIdsForSelector(
  db: DatabaseSync,
  selector: RoleSelector
): { modelVersion: string; roleId: string }[] {
  const rows = db
    .prepare('SELECT model_version, id, boundary_id, horizontal_role_name FROM rdd_roles')
    .all() as {
    model_version: string
    id: string
    boundary_id: string
    horizontal_role_name: string
  }[]
  return rows
    .filter((r) =>
      selectorMatchesRole(selector, {
        roleId: r.id,
        modelVersion: r.model_version,
        boundaryId: r.boundary_id,
        horizontalRoleName: r.horizontal_role_name
      })
    )
    .map((r) => ({ modelVersion: r.model_version, roleId: r.id }))
}

export function memberIdsForRoles(
  db: DatabaseSync,
  roles: { modelVersion: string; roleId: string }[]
): string[] {
  const out = new Set<string>()
  const stmt = db.prepare('SELECT id FROM members WHERE model_version = ? AND role_id = ?')
  for (const r of roles) {
    for (const m of stmt.all(r.modelVersion, r.roleId) as { id: string }[]) out.add(m.id)
  }
  return [...out]
}

/** Member's role context resolved through members → rdd_roles. */
export function roleContextForMember(
  db: DatabaseSync,
  memberId: string
): {
  memberId: string
  runId: string
  modelVersion: string
  roleId: string
  boundaryId: string | null
  horizontalRoleName: string | null
} | null {
  const m = db
    .prepare('SELECT id, run_id, model_version, role_id FROM members WHERE id = ?')
    .get(memberId) as
    { id: string; run_id: string; model_version: string; role_id: string } | undefined
  if (!m) return null
  const role = db
    .prepare(
      'SELECT boundary_id, horizontal_role_name FROM rdd_roles WHERE model_version = ? AND id = ?'
    )
    .get(m.model_version, m.role_id) as
    { boundary_id: string; horizontal_role_name: string } | undefined
  return {
    memberId,
    runId: m.run_id,
    modelVersion: m.model_version,
    roleId: m.role_id,
    boundaryId: role?.boundary_id ?? null,
    horizontalRoleName: role?.horizontal_role_name ?? null
  }
}

/**
 * Best current policy for a role: all policies' latest revisions, filtered
 * by selector match; deterministic pick = highest specificity, then highest
 * revision, then lowest id. Null when no policy selects this role — an
 * UNPUBLISHED ceiling (no extra restriction; grants still required).
 */
export function policyForRole(
  db: DatabaseSync,
  role: {
    roleId: string
    modelVersion?: string | null
    boundaryId?: string | null
    horizontalRoleName?: string | null
  }
): RolePolicyRow | null {
  const latest = db
    .prepare(
      `SELECT p.id, p.revision, p.selector_json, p.action_ceiling_json, p.projection_policy_json
       FROM role_policies p
       JOIN (SELECT id, MAX(revision) AS rev FROM role_policies GROUP BY id) l
         ON l.id = p.id AND l.rev = p.revision`
    )
    .all() as unknown as RolePolicySqlRow[]
  const matches = latest.map(rowFromSql).filter((p) => selectorMatchesRole(p.selector, role))
  if (matches.length === 0) return null
  matches.sort(
    (a, b) =>
      selectorSpecificity(b.selector) - selectorSpecificity(a.selector) ||
      b.revision - a.revision ||
      a.id.localeCompare(b.id)
  )
  return matches[0] ?? null
}

/** The action ceiling binding a member right now, or null when unpublished. */
export function ceilingForMember(
  db: DatabaseSync,
  memberId: string
): { policy: RolePolicyRow; ceiling: string[] } | null {
  const ctx = roleContextForMember(db, memberId)
  if (!ctx) return null
  const policy = policyForRole(db, ctx)
  if (!policy) return null
  return { policy, ceiling: policy.actionCeiling }
}
