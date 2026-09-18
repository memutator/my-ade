// grant.ts — AssignmentGrant / ProvisioningGrant / ContinuationGrant store
// (spec/domains/access.md §1, spec/storage.md §3 `grants` typed union,
// C-ACCESS `access.grant`).
//
// Invariants enforced at issue time (spec §2 + instruction §4.2):
//   - a child grant never widens its parent's actions, covered targets, or
//     validity period; expiry in the past is never issued;
//   - provisioning authority only chains from provisioning parents;
//     continuation grants derive from assignment/continuation parents only;
//   - kind-specific scope is validated (provisioning.allowedRoleIds,
//     continuation.memberId are mandatory for their kinds);
//   - a pinned policyId/policyRevision caps actions by that ceiling.
//
// Role names, boundary containment, and component `requiredActions` mint NO
// authority — only a row in this table does. A missing grant DENIES.

import type { DatabaseSync } from 'node:sqlite'
import type { Grant, Id, Revision } from '../../../mahas-contracts/src/index.ts'
import { appendDomainEvent } from '../storage/db.ts'
import { resolveActualTargets, targetKey, type TargetRef } from './actual-targets.ts'
import { ensureTx, fail, newId, nowMs } from './internal.ts'
import { currentPolicyRevision, getRolePolicyRow } from './policy.ts'

export type GrantKind = 'assignment' | 'provisioning' | 'continuation'
export const GRANT_KINDS: readonly GrantKind[] = ['assignment', 'provisioning', 'continuation']

/**
 * Covers every target — bootstrap/deployment seeding only. It is stored in
 * scope_json like any other entry and is fully auditable; nothing creates it
 * implicitly.
 */
export const WILDCARD_TARGET: TargetRef = { kind: '*', id: '*' }

/** ProvisioningGrant kind fields (access.md §1), carried in scope_json. */
export interface ProvisioningScope {
  allowedRoleIds: string[]
  placementScope?: TargetRef[]
  maxMembers?: number
  allowedPolicyRevision?: number
  profileAdmission?: 'verified-only' | 'documented-in-verification-run'
}

/** ContinuationGrant kind fields, carried in scope_json. */
export interface ContinuationScope {
  memberId: string
  taskScope?: TargetRef[]
  allowedWakeRoute?: string
  budget?: number
}

/** grants.scope_json shape — kind fields nest under `provisioning`/`continuation`. */
export interface GrantScope {
  runId?: string
  memberId?: string
  targets?: TargetRef[]
  provisioning?: ProvisioningScope
  continuation?: ContinuationScope
}

export interface GrantInput {
  id?: string
  kind: GrantKind
  principalId: string
  scope?: GrantScope
  actions: string[]
  expiresAt?: number | null
  parentGrantId?: string | null
  policyId?: string | null
  policyRevision?: number | null
  at?: number
}

/** Internal record — 1:1 with the `grants` row (JSON columns parsed). */
export interface GrantRecord {
  id: string
  revision: number
  kind: GrantKind
  principalId: string
  parentGrantId: string | null
  policyId: string | null
  policyRevision: number | null
  expiresAt: number | null
  revokedAt: number | null
  scope: GrantScope
  actions: string[]
}

interface GrantSqlRow {
  id: string
  revision: number
  kind: string
  principal_id: string
  parent_grant_id: string | null
  policy_id: string | null
  policy_revision: number | null
  expires_at: number | null
  revoked_at: number | null
  scope_json: string
  actions_json: string
}

export function recordFromSql(r: GrantSqlRow): GrantRecord {
  return {
    id: r.id,
    revision: r.revision,
    kind: r.kind as GrantKind,
    principalId: r.principal_id,
    parentGrantId: r.parent_grant_id,
    policyId: r.policy_id,
    policyRevision: r.policy_revision,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    scope: (JSON.parse(r.scope_json) as GrantScope) ?? {},
    actions: JSON.parse(r.actions_json) as string[]
  }
}

/**
 * Contract view. Field names follow the `grants` columns in camelCase per
 * packages/SHARED-APIS.md conventions — re-verify against IMP-02's Grant
 * union when it lands.
 */
export function recordToContract(rec: GrantRecord): Grant {
  return {
    id: rec.id as Id,
    revision: rec.revision as Revision,
    kind: rec.kind,
    principalId: rec.principalId as Id,
    parentGrantId: (rec.parentGrantId ?? undefined) as Id | undefined,
    policyId: (rec.policyId ?? undefined) as Id | undefined,
    policyRevision: (rec.policyRevision ?? undefined) as Revision | undefined,
    expiresAt: rec.expiresAt ?? undefined,
    revokedAt: rec.revokedAt ?? undefined,
    scope: rec.scope,
    actions: [...rec.actions]
  }
}

export function getGrantRecord(db: DatabaseSync, id: string): GrantRecord | null {
  const row = db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as GrantSqlRow | undefined
  return row ? recordFromSql(row) : null
}

export function getGrant(db: DatabaseSync, id: string): Grant | null {
  const rec = getGrantRecord(db, id)
  return rec ? recordToContract(rec) : null
}

/** Currently usable grants: standing (not revoked) and unexpired at `at`. */
export function activeGrantRecordsForPrincipal(
  db: DatabaseSync,
  principalId: string,
  at: number
): GrantRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM grants
       WHERE principal_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY id`
    )
    .all(principalId, at) as unknown as GrantSqlRow[]
  return rows.map(recordFromSql)
}

export function grantRecordsForPrincipal(db: DatabaseSync, principalId: string): GrantRecord[] {
  const rows = db
    .prepare('SELECT * FROM grants WHERE principal_id = ? ORDER BY id')
    .all(principalId) as unknown as GrantSqlRow[]
  return rows.map(recordFromSql)
}

/** Grants linked to a member: held by the member principal or member-scoped. */
export function grantRecordsForMember(db: DatabaseSync, memberId: string): GrantRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM grants
       WHERE principal_id = ?
          OR json_extract(scope_json, '$.memberId') = ?
          OR json_extract(scope_json, '$.continuation.memberId') = ?
       ORDER BY id`
    )
    .all(memberId, memberId, memberId) as unknown as GrantSqlRow[]
  return rows.map(recordFromSql)
}

/** Self + ancestors via parent_grant_id, cycle-guarded. */
export function grantLineage(db: DatabaseSync, grantId: string): GrantRecord[] {
  const out: GrantRecord[] = []
  const seen = new Set<string>()
  let current: GrantRecord | null = getGrantRecord(db, grantId)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    out.push(current)
    current = current.parentGrantId ? getGrantRecord(db, current.parentGrantId) : null
  }
  return out
}

export function dedupeTargets(targets: TargetRef[]): TargetRef[] {
  const seen = new Set<string>()
  const out: TargetRef[] = []
  for (const t of targets) {
    const k = targetKey(t)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(t)
    }
  }
  return out
}

/**
 * Normalized coverage entries of a scope: explicit targets plus the run /
 * member / placement / task-scope shorthands, flattened to TargetRefs.
 */
export function scopeEntries(scope: GrantScope | undefined): TargetRef[] {
  const s = scope ?? {}
  const out: TargetRef[] = [...(s.targets ?? [])]
  if (s.runId) out.push({ kind: 'run', id: s.runId })
  if (s.memberId) out.push({ kind: 'member', id: s.memberId })
  if (s.provisioning?.placementScope) out.push(...s.provisioning.placementScope)
  if (s.continuation?.taskScope) out.push(...s.continuation.taskScope)
  return dedupeTargets(out)
}

export interface CoverageResult {
  covers: boolean
  uncovered: TargetRef[]
}

/**
 * Does `scope` cover every target in `targets`? A scope entry covers a
 * required target iff it equals the target or appears among its resolved
 * ancestors (actual-targets.ts). `{kind:'*'}` covers all. Empty target list
 * is trivially covered; an empty scope covers nothing non-trivial.
 */
export function scopeCoversTargets(
  db: DatabaseSync,
  scope: GrantScope | undefined,
  targets: TargetRef[]
): CoverageResult {
  if (targets.length === 0) return { covers: true, uncovered: [] }
  const entries = scopeEntries(scope)
  if (entries.some((e) => e.kind === '*')) return { covers: true, uncovered: [] }
  const keys = new Set(entries.map(targetKey))
  const uncovered: TargetRef[] = []
  for (const t of targets) {
    if (keys.has(targetKey(t))) continue
    const resolved = resolveActualTargets(db, [t])
    const reachable = new Set(resolved.all.map(targetKey))
    let covered = false
    for (const k of reachable) {
      if (keys.has(k)) {
        covered = true
        break
      }
    }
    if (!covered) uncovered.push(t)
  }
  return { covers: uncovered.length === 0, uncovered }
}

/**
 * Validate a would-be grant: subject exists, kind scope is well-formed,
 * expiry is in the future, pinned policy caps actions, and — when a parent
 * is named — the child narrows it on every axis. Throws AccessError.
 */
export function assertGrantInput(db: DatabaseSync, input: GrantInput, at: number): void {
  if (!GRANT_KINDS.includes(input.kind)) {
    fail('INVALID_TRANSITION', `unknown grant kind '${String(input.kind)}'`)
  }
  if (typeof input.principalId !== 'string' || input.principalId.length === 0) {
    fail('INPUT_NOT_READY', 'grant requires a subject principalId')
  }
  const principal = db.prepare('SELECT id FROM principals WHERE id = ?').get(input.principalId)
  if (!principal) {
    fail('INPUT_NOT_READY', `grant subject principal '${input.principalId}' does not exist`)
  }
  if (
    !Array.isArray(input.actions) ||
    input.actions.some((a) => typeof a !== 'string' || a.length === 0)
  ) {
    fail('INPUT_NOT_READY', 'grant actions must be an array of non-empty action names')
  }
  if (input.expiresAt != null && input.expiresAt <= at) {
    fail('INVALID_TRANSITION', 'grant expiry is already in the past')
  }
  const scope = input.scope ?? {}
  if (input.kind === 'provisioning') {
    const ps = scope.provisioning
    if (!ps || !Array.isArray(ps.allowedRoleIds) || ps.allowedRoleIds.length === 0) {
      fail('INVALID_TRANSITION', 'provisioning grant requires scope.provisioning.allowedRoleIds')
    }
  }
  if (input.kind === 'continuation') {
    const cs = scope.continuation
    if (!cs || typeof cs.memberId !== 'string' || cs.memberId.length === 0) {
      fail('INVALID_TRANSITION', 'continuation grant requires scope.continuation.memberId')
    }
  }
  if (input.policyId != null) {
    const revision = input.policyRevision ?? currentPolicyRevision(db, input.policyId)
    const policy = getRolePolicyRow(db, input.policyId, revision)
    if (!policy) {
      fail('INPUT_NOT_READY', `policy '${input.policyId}' has no revision ${revision}`)
    }
    const outside = input.actions.filter((a) => !policy.actionCeiling.includes(a))
    if (outside.length > 0) {
      fail('SCOPE_DENIED', `grant actions exceed pinned policy ceiling: ${outside.join(', ')}`)
    }
    input.policyRevision = revision
  }
  if (input.parentGrantId != null) {
    const parent = getGrantRecord(db, input.parentGrantId)
    if (!parent) fail('INPUT_NOT_READY', `parent grant '${input.parentGrantId}' does not exist`)
    if (parent.revokedAt != null) fail('GRANT_REVOKED', `parent grant '${parent.id}' is revoked`)
    if (parent.expiresAt != null && parent.expiresAt <= at) {
      fail('SCOPE_DENIED', `parent grant '${parent.id}' is expired`)
    }
    assertChildWithinParent(db, input, parent)
  }
}

/**
 * Child-within-parent enforcement — the child may NARROW every axis, never
 * widen it (instruction §4.2, C-ACCESS access.grant precondition).
 */
export function assertChildWithinParent(
  db: DatabaseSync,
  child: GrantInput,
  parent: GrantRecord
): void {
  const extraActions = child.actions.filter((a) => !parent.actions.includes(a))
  if (extraActions.length > 0) {
    fail('SCOPE_DENIED', `child grant actions exceed parent: ${extraActions.join(', ')}`)
  }
  if (parent.expiresAt != null && (child.expiresAt == null || child.expiresAt > parent.expiresAt)) {
    fail('SCOPE_DENIED', 'child grant validity period exceeds parent expiry')
  }
  if (child.kind === 'provisioning' && parent.kind !== 'provisioning') {
    fail('SCOPE_DENIED', 'a provisioning grant cannot derive from a non-provisioning parent')
  }
  if (child.kind === 'continuation' && parent.kind === 'provisioning') {
    fail('SCOPE_DENIED', 'a continuation grant cannot derive from a provisioning parent')
  }
  const coverage = scopeCoversTargets(db, parent.scope, scopeEntries(child.scope))
  if (!coverage.covers) {
    fail(
      'SCOPE_DENIED',
      `child grant targets exceed parent scope: ${coverage.uncovered.map(targetKey).join(', ')}`
    )
  }
  if (child.kind === 'provisioning') {
    const cps = child.scope?.provisioning
    const pps = parent.scope.provisioning
    if (cps && pps) {
      const extraRoles = cps.allowedRoleIds.filter((r) => !pps.allowedRoleIds.includes(r))
      if (extraRoles.length > 0) {
        fail('SCOPE_DENIED', `child allowedRoleIds exceed parent: ${extraRoles.join(', ')}`)
      }
      if (pps.maxMembers != null && (cps.maxMembers == null || cps.maxMembers > pps.maxMembers)) {
        fail('SCOPE_DENIED', 'child maxMembers exceeds parent bound')
      }
      if (
        pps.allowedPolicyRevision != null &&
        cps.allowedPolicyRevision !== pps.allowedPolicyRevision
      ) {
        fail('SCOPE_DENIED', 'child allowedPolicyRevision differs from parent pin')
      }
      if (pps.profileAdmission === 'verified-only' && cps.profileAdmission !== 'verified-only') {
        fail('SCOPE_DENIED', 'child profileAdmission is looser than parent')
      }
    }
  }
}

/**
 * Issue a grant (SHARED-APIS signature). Validates + inserts + emits
 * `access.grant.issued` in one transaction. This is the mechanics layer —
 * caller-side authorization (issuer holds the delegated authority) is the
 * operation's job; structural containment is always enforced here.
 */
export function issueGrant(db: DatabaseSync, input: GrantInput): Grant {
  const at = input.at ?? nowMs()
  return ensureTx(db, (tx) => {
    assertGrantInput(tx, input, at)
    const record: GrantRecord = {
      id: input.id ?? newId('grt'),
      revision: 1,
      kind: input.kind,
      principalId: input.principalId,
      parentGrantId: input.parentGrantId ?? null,
      policyId: input.policyId ?? null,
      policyRevision: input.policyRevision ?? null,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      scope: input.scope ?? {},
      actions: [...new Set(input.actions)]
    }
    tx.prepare(
      `INSERT INTO grants
         (id, revision, kind, principal_id, parent_grant_id, policy_id, policy_revision, expires_at, revoked_at, scope_json, actions_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.revision,
      record.kind,
      record.principalId,
      record.parentGrantId,
      record.policyId,
      record.policyRevision,
      record.expiresAt,
      record.revokedAt,
      JSON.stringify(record.scope),
      JSON.stringify(record.actions)
    )
    appendDomainEvent(
      tx,
      record.id,
      record.revision,
      'access.grant.issued',
      { domain: 'access', principalId: record.principalId, kind: record.kind },
      {
        scope: record.scope,
        actions: record.actions,
        parentGrantId: record.parentGrantId,
        expiresAt: record.expiresAt,
        policyId: record.policyId,
        policyRevision: record.policyRevision
      }
    )
    return recordToContract(record)
  })
}
