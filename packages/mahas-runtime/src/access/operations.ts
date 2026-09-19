// operations.ts — the IMP-10-owned operations (spec/operations.md,
// C-ACCESS access-cli.md):
//
//   access.policy.publish — versioned RolePolicy publish (operator policy
//     administrator only; role maintenance does NOT imply policy admin)
//   access.grant          — issue assignment|provisioning|continuation grant
//   access.revoke         — revoke a grant tree; reports in-flight effects,
//     never marks them never-started
//   access.inspect        — self/admin view of effective actions + scope
//
// Handlers take {db, ctx} — the same shape IMP-11's TxnContext fixes — and
// are meant to run inside the registry's transaction so revision re-reads
// stay in the writer tx (common.md §3). Every handler re-authorizes through
// the kernel: operation visibility is never the enforcement.

import type { DatabaseSync } from 'node:sqlite'
import type {
  AuthenticatedContext,
  ControllerEpoch,
  Id
} from '../../../mahas-contracts/src/index.ts'
import { withTx } from '../storage/db.ts'
import { fail } from './internal.ts'
import {
  effectiveActionsFor,
  makeAccessKernel,
  type AccessKernel,
  type TargetRef
} from './authorize.ts'
import {
  getGrantRecord,
  grantLineage,
  grantRecordsForMember,
  issueGrant,
  scopeEntries,
  type GrantInput,
  type GrantKind,
  type GrantRecord,
  type GrantScope
} from './grant.ts'
import { getPrincipalRow, PRINCIPAL_STATUS_ACTIVE } from './principal.ts'
import { derivePolicyId, publishRolePolicy, type RoleSelector } from './policy.ts'
import { revokeGrantTree } from './revocation.ts'

/** Matches IMP-11 TxnContext structurally — no sibling import needed. */
export interface AccessOperationContext {
  db: DatabaseSync
  ctx: AuthenticatedContext
  /** present on the real admission pipeline; absent on direct call paths */
  exemptGrantRecheck?(grantId: string): void
}

export const ACCESS_OPERATION_NAMES = [
  'access.policy.publish',
  'access.grant',
  'access.revoke',
  'access.inspect'
] as const

/**
 * Advisory registration metadata for IMP-11's OperationRegistry. `visibility`
 * is the primary-subject class from spec/operations.md — the surface itself
 * is grant-driven, so a member delegator holding `access.grant` still sees
 * it; alignment of single-valued visibility with that is IMP-11's call.
 */
export interface AccessOperationSpec {
  name: string
  visibility: 'operator' | 'member' | 'service' | 'host'
  mutation: boolean
}

export const ACCESS_OPERATION_SPECS: AccessOperationSpec[] = [
  { name: 'access.policy.publish', visibility: 'operator', mutation: true },
  { name: 'access.grant', visibility: 'operator', mutation: true },
  { name: 'access.revoke', visibility: 'operator', mutation: true },
  { name: 'access.inspect', visibility: 'member', mutation: false }
]

// ---------------------------------------------------------------------------
// payload validation — no BAD_REQUEST exists in the fixed error list;
// malformed operation input fails INPUT_NOT_READY with field details.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asRecord(v: unknown, name: string): Record<string, unknown> {
  if (!isRecord(v)) fail('INPUT_NOT_READY', `${name} must be an object`)
  return v
}

function reqString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0)
    fail('INPUT_NOT_READY', `${name} must be a non-empty string`)
  return v
}

function optString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined
  return reqString(v, name)
}

function optInt(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v))
    fail('INPUT_NOT_READY', `${name} must be an integer`)
  return v
}

function reqStringArray(v: unknown, name: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    fail('INPUT_NOT_READY', `${name} must be an array of strings`)
  }
  return [...v] as string[]
}

function asTargetRef(v: unknown, name: string): TargetRef {
  const r = asRecord(v, name)
  return { kind: reqString(r.kind, `${name}.kind`), id: reqString(r.id, `${name}.id`) }
}

function optTargetRefArray(v: unknown, name: string): TargetRef[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) fail('INPUT_NOT_READY', `${name} must be an array of {kind,id}`)
  return v.map((t, i) => asTargetRef(t, `${name}[${i}]`))
}

function asRoleSelector(v: unknown): RoleSelector {
  const r = asRecord(v, 'roleSelector')
  const selector: RoleSelector = {
    roleId: optString(r.roleId, 'roleSelector.roleId'),
    modelVersion: optString(r.modelVersion, 'roleSelector.modelVersion'),
    boundaryId: optString(r.boundaryId, 'roleSelector.boundaryId'),
    horizontalRoleName: optString(r.horizontalRoleName, 'roleSelector.horizontalRoleName')
  }
  if (Object.values(selector).every((x) => x === undefined)) {
    fail('INPUT_NOT_READY', 'roleSelector must name at least one match field')
  }
  return selector
}

function asProfileAdmission(
  v: unknown
): 'verified-only' | 'documented-in-verification-run' | undefined {
  if (v === undefined || v === null) return undefined
  if (v !== 'verified-only' && v !== 'documented-in-verification-run') {
    fail(
      'INPUT_NOT_READY',
      'scope.provisioning.profileAdmission must be verified-only or documented-in-verification-run'
    )
  }
  return v
}

function asGrantScope(v: unknown): GrantScope {
  if (v === undefined || v === null) return {}
  const r = asRecord(v, 'scope')
  const scope: GrantScope = {
    runId: optString(r.runId, 'scope.runId'),
    memberId: optString(r.memberId, 'scope.memberId'),
    targets: optTargetRefArray(r.targets, 'scope.targets')
  }
  if (r.provisioning !== undefined && r.provisioning !== null) {
    const p = asRecord(r.provisioning, 'scope.provisioning')
    scope.provisioning = {
      allowedRoleIds: reqStringArray(p.allowedRoleIds, 'scope.provisioning.allowedRoleIds'),
      placementScope: optTargetRefArray(p.placementScope, 'scope.provisioning.placementScope'),
      maxMembers: optInt(p.maxMembers, 'scope.provisioning.maxMembers'),
      allowedPolicyRevision: optInt(
        p.allowedPolicyRevision,
        'scope.provisioning.allowedPolicyRevision'
      ),
      profileAdmission: asProfileAdmission(p.profileAdmission)
    }
  }
  if (r.continuation !== undefined && r.continuation !== null) {
    const c = asRecord(r.continuation, 'scope.continuation')
    scope.continuation = {
      memberId: reqString(c.memberId, 'scope.continuation.memberId'),
      taskScope: optTargetRefArray(c.taskScope, 'scope.continuation.taskScope'),
      allowedWakeRoute: optString(c.allowedWakeRoute, 'scope.continuation.allowedWakeRoute'),
      budget: optInt(c.budget, 'scope.continuation.budget')
    }
  }
  return scope
}

function asGrantKind(v: unknown): GrantKind {
  if (v !== 'assignment' && v !== 'provisioning' && v !== 'continuation') {
    fail(
      'INVALID_TRANSITION',
      `kind must be assignment|provisioning|continuation, got '${String(v)}'`
    )
  }
  return v
}

function kernelOf(db: DatabaseSync): AccessKernel {
  return makeAccessKernel(db)
}

// ---------------------------------------------------------------------------
// access.policy.publish
// ---------------------------------------------------------------------------

export interface PolicyPublishPayloadResult {
  policyId: string
  policyRevision: number
  affectedBindings: { roleIds: { modelVersion: string; roleId: string }[]; memberIds: string[] }
}

export function accessPolicyPublishOp(
  txn: AccessOperationContext,
  payload: unknown
): PolicyPublishPayloadResult {
  const { db, ctx } = txn
  const p = asRecord(payload, 'payload')
  const principal = getPrincipalRow(db, ctx.principalId)
  if (!principal || principal.status !== PRINCIPAL_STATUS_ACTIVE) {
    fail('UNAUTHENTICATED', 'inactive or unknown principal')
  }
  // role maintenance and policy administration are separate authorities —
  // a member (even a maintainer) is never an implicit policy admin
  if (principal.kind !== 'operator') {
    fail('SCOPE_DENIED', 'access.policy.publish is restricted to operator policy administrators')
  }
  const roleSelector = asRoleSelector(p.roleSelector)
  const actionCeiling = reqStringArray(p.actionCeiling, 'actionCeiling')
  const policyId = optString(p.policyId, 'policyId') ?? derivePolicyId(roleSelector)
  const kernel = kernelOf(db)
  const targets: TargetRef[] = [{ kind: 'policy', id: policyId }]
  if (roleSelector.roleId) targets.push({ kind: 'role', id: roleSelector.roleId })
  if (roleSelector.boundaryId) targets.push({ kind: 'boundary', id: roleSelector.boundaryId })
  kernel.authorize(ctx, 'access.policy.publish', targets)
  const { policy, affectedRoleIds, affectedMemberIds } = publishRolePolicy(db, {
    policyId,
    roleSelector,
    expectedRevision: optInt(p.expectedRevision, 'expectedRevision'),
    actionCeiling,
    projectionPolicy: p.projectionPolicy ?? {}
  })
  return {
    policyId: policy.id,
    policyRevision: policy.revision,
    affectedBindings: { roleIds: affectedRoleIds, memberIds: affectedMemberIds }
  }
}

// ---------------------------------------------------------------------------
// access.grant
// ---------------------------------------------------------------------------

export interface GrantOpResult {
  grantId: string
  revision: number
}

/**
 * Issuer rule: the caller must hold `access.grant` over everything being
 * delegated AND hold every delegated action over that scope — a grant is
 * derived authority, never minted. With a parentGrant the containment check
 * in issueGrant additionally bounds the child inside the parent envelope.
 */
export function accessGrantOp(txn: AccessOperationContext, payload: unknown): GrantOpResult {
  const { db, ctx } = txn
  const p = asRecord(payload, 'payload')
  const kind = asGrantKind(p.kind)
  const subject = isRecord(p.subject) ? p.subject : {}
  const principalId = reqString(
    subject.principalId ?? subject.principal ?? p.principalId ?? subject.memberId ?? p.memberId,
    'subject.principalId'
  )
  const scope = asGrantScope(p.scope)
  const actions = reqStringArray(p.actions ?? [], 'actions')
  const expiresAt = optInt(p.expiresAt ?? p.expiry, 'expiresAt')
  const parentGrantId = optString(p.parentGrant ?? p.parentGrantId, 'parentGrant')
  const kernel = kernelOf(db)
  const scopeTargets = [...scopeEntries(scope), { kind: 'principal', id: principalId } as TargetRef]
  kernel.authorize(ctx, 'access.grant', scopeTargets)
  for (const action of actions) {
    try {
      kernel.authorize(ctx, action, scopeEntries(scope))
    } catch (err) {
      fail(
        'SCOPE_DENIED',
        `issuer does not hold delegated action '${action}' over the grant scope`,
        {
          action,
          cause: err instanceof Error ? err.message : String(err)
        }
      )
    }
  }
  const input: GrantInput = {
    kind,
    principalId,
    scope,
    actions,
    expiresAt: expiresAt ?? null,
    parentGrantId: parentGrantId ?? null,
    policyId: optString(p.policyId, 'policyId') ?? null,
    policyRevision: optInt(p.policyRevision, 'policyRevision') ?? null
  }
  const grant = issueGrant(db, input)
  return { grantId: String(grant.id), revision: Number(grant.revision) }
}

// ---------------------------------------------------------------------------
// access.revoke
// ---------------------------------------------------------------------------

export interface RevokeOpResult {
  revocationRevision: number
  affectedExecutions: string[]
  inFlightEffects: string[]
}

/**
 * Revoker rule: `access.revoke` authority over the grant target, OR the
 * caller's principal owns an ancestor grant in the chain (the delegator can
 * withdraw what it delegated), OR voluntary self-revocation by the subject.
 */
export function accessRevokeOp(txn: AccessOperationContext, payload: unknown): RevokeOpResult {
  const { db, ctx } = txn
  const p = asRecord(payload, 'payload')
  const grantId = reqString(p.grantId, 'grantId')
  const expectedRevision = optInt(p.expectedRevision, 'expectedRevision')
  const reason = optString(p.reason, 'reason')
  const grant = getGrantRecord(db, grantId)
  if (!grant) fail('SCOPE_DENIED', 'grant not found or not visible')
  const kernel = kernelOf(db)
  let authorized = kernel.decide(ctx, 'access.revoke', [{ kind: 'grant', id: grantId }]).allow
  if (!authorized) {
    const lineage = grantLineage(db, grantId)
    authorized = lineage.some((g) => g.principalId === ctx.principalId)
  }
  if (!authorized) fail('SCOPE_DENIED', 'not an issuer/revoker of this grant')
  const result = revokeGrantTree(db, grantId, Date.now(), {
    expectedRevision: expectedRevision ?? undefined,
    reason
  })
  // F-019: this operation revoked these grants — the pre-commit re-check must
  // not fence the transaction on its own effect (spec: subject self-revocation).
  for (const revokedId of result.revokedGrantIds) txn.exemptGrantRecheck?.(revokedId)
  return {
    revocationRevision: result.revocationRevision,
    affectedExecutions: result.affectedExecutions,
    inFlightEffects: result.inFlightEffects
  }
}

// ---------------------------------------------------------------------------
// access.inspect
// ---------------------------------------------------------------------------

export interface InspectScopeSummary {
  runId?: string
  memberId?: string
  targets: TargetRef[]
  provisioning?: { allowedRoleIds: string[]; maxMembers?: number; profileAdmission?: string }
  continuation?: { memberId: string; allowedWakeRoute?: string; budget?: number }
}

export interface InspectGrantSummary {
  grantId: string
  kind: string
  revision: number
  actions: string[]
  scopeSummary: InspectScopeSummary
  expiresAt: number | null
  revokedAt: number | null
  status: 'active' | 'expired' | 'revoked'
}

function grantStatus(g: GrantRecord, at: number): 'active' | 'expired' | 'revoked' {
  if (g.revokedAt != null) return 'revoked'
  if (g.expiresAt != null && g.expiresAt <= at) return 'expired'
  return 'active'
}

function summarizeScope(scope: GrantScope): InspectScopeSummary {
  return {
    runId: scope.runId,
    memberId: scope.memberId,
    targets: [...(scope.targets ?? [])],
    provisioning: scope.provisioning
      ? {
          allowedRoleIds: [...scope.provisioning.allowedRoleIds],
          maxMembers: scope.provisioning.maxMembers,
          profileAdmission: scope.provisioning.profileAdmission
        }
      : undefined,
    continuation: scope.continuation
      ? {
          memberId: scope.continuation.memberId,
          allowedWakeRoute: scope.continuation.allowedWakeRoute,
          budget: scope.continuation.budget
        }
      : undefined
  }
}

function summarizeGrant(g: GrantRecord, at: number): InspectGrantSummary {
  return {
    grantId: g.id,
    kind: g.kind,
    revision: g.revision,
    actions: [...g.actions],
    scopeSummary: summarizeScope(g.scope),
    expiresAt: g.expiresAt,
    revokedAt: g.revokedAt,
    status: grantStatus(g, at)
  }
}

/**
 * Self (own binding / own grants) or `access.inspect`-scoped view. Returns
 * effective actions, scope summaries, expiry and revocation status — never
 * secret material or other principals' internals (C-ACCESS access.inspect).
 */
export function accessInspectOp(txn: AccessOperationContext, payload: unknown): unknown {
  const { db, ctx } = txn
  const p = asRecord(payload ?? {}, 'payload')
  const memberId = optString(p.memberId, 'memberId')
  const grantId = optString(p.grantId, 'grantId')
  if (!memberId && !grantId) fail('INPUT_NOT_READY', 'access.inspect requires memberId or grantId')
  const kernel = kernelOf(db)
  const at = Date.now()

  if (grantId) {
    const grant = getGrantRecord(db, grantId)
    if (!grant) fail('SCOPE_DENIED', 'grant not found or not visible')
    const self = grant.principalId === ctx.principalId
    const allowed =
      self || kernel.decide(ctx, 'access.inspect', [{ kind: 'grant', id: grantId }]).allow
    if (!allowed) fail('SCOPE_DENIED', 'cannot inspect a grant outside own bindings or admin scope')
    const summary = summarizeGrant(grant, at)
    return {
      grant: summary,
      effectiveActions: grantStatus(grant, at) === 'active' ? [...grant.actions] : [],
      expiry: grant.expiresAt,
      revocation: grant.revokedAt != null ? { revokedAt: grant.revokedAt } : null
    }
  }

  const mid = memberId as string
  const self = ctx.memberId === mid || ctx.principalId === mid
  const allowed = self || kernel.decide(ctx, 'access.inspect', [{ kind: 'member', id: mid }]).allow
  if (!allowed) fail('SCOPE_DENIED', 'cannot inspect a member outside own binding or admin scope')
  const grants = grantRecordsForMember(db, mid)
  const syntheticCtx: AuthenticatedContext = {
    principalId: mid as Id,
    memberId: mid as Id,
    controllerEpoch: ctx.controllerEpoch ?? (0 as ControllerEpoch),
    grantRevisions: {},
    transportSessionId: `inspect:${ctx.transportSessionId}`
  }
  const { actions, policyId, policyRevision } = effectiveActionsFor(db, syntheticCtx)
  return {
    memberId: mid,
    effectiveActions: actions,
    policy: policyId ? { policyId, policyRevision } : null,
    grants: grants.map((g) => summarizeGrant(g, at)),
    expiry: grants
      .filter((g) => g.expiresAt != null)
      .map((g) => ({ grantId: g.id, expiresAt: g.expiresAt })),
    revocation: grants
      .filter((g) => g.revokedAt != null)
      .map((g) => ({ grantId: g.id, revokedAt: g.revokedAt }))
  }
}

/** Convenience map for IMP-11 registration. */
export const ACCESS_OPERATION_HANDLERS: Record<
  (typeof ACCESS_OPERATION_NAMES)[number],
  (txn: AccessOperationContext, payload: unknown) => unknown
> = {
  'access.policy.publish': accessPolicyPublishOp,
  'access.grant': accessGrantOp,
  'access.revoke': accessRevokeOp,
  'access.inspect': accessInspectOp
}

/**
 * Register all four handlers against an object exposing a register()
 * compatible with IMP-11's OperationRegistry — kept structural so this file
 * never imports the registry module.
 */
export function registerAccessOperations(registry: {
  register(
    spec: { name: string; visibility: string; mutation: boolean },
    handler: (txn: AccessOperationContext, payload: unknown) => unknown
  ): void
}): void {
  for (const spec of ACCESS_OPERATION_SPECS) {
    registry.register(
      spec,
      ACCESS_OPERATION_HANDLERS[spec.name as (typeof ACCESS_OPERATION_NAMES)[number]]
    )
  }
}

/** Run one of the access ops inside a writer transaction (test/seed path). */
export function callAccessOperation(
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  operation: (typeof ACCESS_OPERATION_NAMES)[number],
  payload: unknown
): unknown {
  const handler = ACCESS_OPERATION_HANDLERS[operation]
  if (!handler) fail('UNAVAILABLE_OPERATION', `unknown access operation '${operation}'`)
  return withTx(db, (tx) => handler({ db: tx, ctx }, payload))
}
