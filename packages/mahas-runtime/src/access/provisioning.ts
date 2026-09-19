// provisioning.ts — admission rules for the ProvisioningGrant and
// ContinuationGrant kinds (spec/domains/access.md §1–2, REQ-10/REQ-19).
//
// A provisioning grant is a SEPARATE authority from assignment grants: it
// only authorizes placement/assignment-class operations for the listed
// roles inside its placement scope — so a strong role cannot be spawned to
// bypass authorization. `requiredActions` on components and role names are
// inputs, never authority.
//
// A continuation grant authorizes processing the current delegation's
// outstanding messages only: it is bound to one member, optionally one wake
// route, and a task/coordination scope — never new Tasks or automatic
// retries.

import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/index.ts'
import type { ResolvedTargets } from './actual-targets.ts'
import { targetKey } from './actual-targets.ts'
import { scopeCoversTargets, type GrantRecord, type GrantScope } from './grant.ts'

export interface AdmissionVerdict {
  ok: boolean
  reason?: string
}

/** Bare the role id of a possibly-qualified `modelVersion:roleId` ref. */
function bareRoleId(id: string): string {
  const idx = id.indexOf(':')
  return idx > 0 ? id.slice(idx + 1) : id
}

/**
 * Provisioning-grant admission: every `role`-kind request target must be in
 * allowedRoleIds; every other target must be covered by the placement /
 * general scope. maxMembers / allowedPolicyRevision / profileAdmission are
 * carried for the work-domain operations to enforce at dispatch time — they
 * are recorded in decision evidence, not double-checked here.
 */
export function provisioningAdmission(
  db: DatabaseSync,
  grant: GrantRecord,
  resolved: ResolvedTargets
): AdmissionVerdict {
  const ps = grant.scope.provisioning
  if (!ps) return { ok: false, reason: 'provisioning grant carries no provisioning scope' }
  const roleTargets = resolved.primary.filter((t) => t.kind === 'role')
  for (const rt of roleTargets) {
    if (!ps.allowedRoleIds.includes(rt.id) && !ps.allowedRoleIds.includes(bareRoleId(rt.id))) {
      return { ok: false, reason: `role '${rt.id}' is outside provisioning allowedRoleIds` }
    }
  }
  const nonRoleTargets = resolved.primary.filter((t) => t.kind !== 'role')
  const scope: GrantScope = {
    ...grant.scope,
    targets: [...(grant.scope.targets ?? []), ...(ps.placementScope ?? [])]
  }
  const coverage = scopeCoversTargets(db, scope, nonRoleTargets)
  if (!coverage.covers) {
    return {
      ok: false,
      reason: `targets outside provisioning placement: ${coverage.uncovered.map(targetKey).join(', ')}`
    }
  }
  return { ok: true }
}

/**
 * Continuation-grant admission: bound member only, optional single wake
 * route, and targets inside the task/coordination scope. New-Task or
 * unrelated work never passes through a continuation grant.
 */
export function continuationAdmission(
  db: DatabaseSync,
  grant: GrantRecord,
  ctx: AuthenticatedContext,
  operation: string,
  resolved: ResolvedTargets
): AdmissionVerdict {
  const cs = grant.scope.continuation
  if (!cs) return { ok: false, reason: 'continuation grant carries no continuation scope' }
  if (ctx.memberId == null || String(ctx.memberId) !== cs.memberId) {
    return { ok: false, reason: `continuation grant is bound to member '${cs.memberId}'` }
  }
  if (cs.allowedWakeRoute != null && operation !== cs.allowedWakeRoute) {
    return {
      ok: false,
      reason: `operation '${operation}' is not the allowed wake route '${cs.allowedWakeRoute}'`
    }
  }
  const scope: GrantScope = {
    runId: grant.scope.runId,
    memberId: cs.memberId,
    targets: [...(grant.scope.targets ?? []), ...(cs.taskScope ?? [])]
  }
  const coverage = scopeCoversTargets(db, scope, resolved.primary)
  if (!coverage.covers) {
    return {
      ok: false,
      reason: `targets outside continuation scope: ${coverage.uncovered.map(targetKey).join(', ')}`
    }
  }
  return { ok: true }
}
