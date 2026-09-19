// mahas-contracts — access: principals, policies, grants, surfaces (IMP-02).
//
// REQ-09/REQ-10: non-exposure is not authorization — the server re-checks
// the CURRENT grant/execution/target on every call, including raw RPC. Role
// ceiling, AssignmentGrant and ProvisioningGrant are different things; a
// role name or parent boundary mints no permission by itself.
//
// Every grant kind is a discriminated member of the Grant union on `kind`
// (storage.md §3 grants.kind CHECK). scope/actions keep their JSON shape —
// C-ACCESS owns the semantics of what they admit.

import type {
  EpochMillis,
  AuthorizationDecisionId,
  GrantId,
  PrincipalId,
  RolePolicyId
} from './ids.ts'
import type { JsonObject, Revision } from './common.ts'

/** principals — who a credential belongs to. 'service' covers system
 *  issuers (e.g. assignment deliveries), 'member' a Member's own
 *  principal, 'operator' a human operator (D-MAIL §1, operations.md) */
export type PrincipalKind = 'operator' | 'member' | 'service' | (string & {})

export interface Principal {
  id: PrincipalId
  kind: PrincipalKind
  status: string
}

/* ── RolePolicy — role_policies table ─────────────────────────────────── */

/** selector_json — which roles/boundaries/principals the policy applies to */
export interface PolicySelector {
  roleIds?: string[]
  boundaryIds?: string[]
  principalIds?: PrincipalId[]
  [key: string]: unknown
}

/** action_ceiling_json — the role's ceiling: no grant may exceed it and a
 *  ceiling exists independent of any grant (REQ-10) */
export interface ActionCeiling {
  /** operation names this role may ever invoke */
  operations?: string[]
  /** operation names this role may ever delegate/grant */
  delegatableOperations?: string[]
  [key: string]: unknown
}

/** projection_policy_json — how much of the model/surfaces this role sees */
export interface ProjectionPolicy {
  [key: string]: unknown
}

export interface RolePolicy {
  id: RolePolicyId
  revision: Revision
  selector: PolicySelector
  actionCeiling: ActionCeiling
  projectionPolicy: ProjectionPolicy
}

/* ── Grant — grants table (discriminated on kind) ─────────────────────── */

export type GrantKind = 'assignment' | 'provisioning' | 'continuation'

/** scope_json — what the grant actually reaches: operations × targets.
 *  Payload intent is never the authorization basis (targets are resolved
 *  from server state at admission). */
export interface GrantScope {
  operations?: string[]
  targets?: AuthorizationTarget[]
  runId?: string
  memberId?: string
  provisioning?: unknown
  continuation?: unknown
}

/** one entry of actions_json — an admitted action plus any narrowing */
export interface GrantAction {
  operation: string
  constraints?: JsonObject
  [key: string]: unknown
}

interface GrantBase {
  id: GrantId
  revision: Revision
  principalId: PrincipalId
  /** delegation chain — a grant may only narrow its parent (REQ-10) */
  parentGrantId?: GrantId | null
  policyId?: RolePolicyId | null
  policyRevision?: Revision | null
  /** authority-clock expiry; expiry alone never proves death */
  expiresAt?: EpochMillis | null
  revokedAt?: EpochMillis | null
  scope: GrantScope
  actions: string[]
}

/** kind 'assignment' — binds a Member to its assigned mandate */
export interface AssignmentGrant extends GrantBase {
  kind: 'assignment'
}

/** kind 'provisioning' — lets a coordinator spawn/assign within limits */
export interface ProvisioningGrant extends GrantBase {
  kind: 'provisioning'
}

/** kind 'continuation' — the narrow wake/resume authority (REQ-19) */
export interface ContinuationGrant extends GrantBase {
  kind: 'continuation'
}

export type Grant = AssignmentGrant | ProvisioningGrant | ContinuationGrant

/* ── CommandSurface — command_surfaces table ──────────────────────────── */

/** actions_and_schemas_json — the visible op set plus its schemas */
export interface SurfaceActionsAndSchemas {
  effectiveActions: string[]
  schemas: Record<string, unknown>
  [key: string]: unknown
}

/** policy_pins_json — grant/policy evidence pinned with the projection */
export interface SurfacePolicyPins {
  rolePolicyRevision?: unknown
  visibilityScope?: unknown
  policyPins?: unknown
  [key: string]: unknown
}

/**
 * command_surfaces — the digest-covered projection of what a credential may
 * see. LaunchPlan/WorkerJoin pin `surfaceDigest` against exactly this.
 * `effectiveActions`/`schemas` mirror actionsAndSchemas for direct readers.
 */
export interface CommandSurface {
  digest: string
  /** the operation names this credential may see (REQ-09: hidden ops never appear) */
  effectiveActions: string[]
  /** per-operation descriptors keyed by operation name */
  schemas: Record<string, unknown>
  /** grant/policy evidence pinned with the projection */
  rolePolicyRevision?: unknown
  visibilityScope?: unknown
  /** the persisted JSON document form (command_surfaces row) */
  actionsAndSchemas?: SurfaceActionsAndSchemas
  policyPins?: SurfacePolicyPins
}

/* ── AuthorizationDecision — authorization_decisions table ────────────── */

/** one resolved actual target (kind + id), decided from server state */
export interface AuthorizationTarget {
  kind: string
  id: string
}

export interface AuthorizationDecision {
  id: AuthorizationDecisionId
  /** transport session that requested the decision (audit correlation) */
  requestId?: string
  principalId: PrincipalId
  /** the resolved operation name (`operation_key` in storage) */
  operation: string
  allow: boolean
  reason?: string
  actualTargets: AuthorizationTarget[]
  grantRevisions?: Record<string, number>
  policyRevisions?: Record<string, number>
  policyEvidence?: JsonObject
  decidedAt?: number
}
