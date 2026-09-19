// authorize.ts — the access kernel (IMP-10). Fixed SHARED-APIS surface:
//
//   authorize(ctx, operation, targets): void — throws MahasError
//     (SCOPE_DENIED / GRANT_REVOKED / UNAUTHENTICATED / STALE_EXECUTION)
//   decide(ctx, operation, targets) → { allow, decision } — records
//     authorization_decisions
//   surfaceFor(ctx, db) → CommandSurface; isOperationVisible(surface, op)
//   issueGrant(db, GrantInput) → Grant; revokeGrant(db, grantId, at)
//   verifySecret(secret, secretHash) — scrypt (see below)
//
// authorize/decide take no db handle by contract: the kernel binds a control
// DB through bindAccessDb(db) (process-wide default, what serveRpc/dispatch
// wiring uses) or makeAccessKernel(db) (explicit handle — used by the
// access.* operation handlers and by tests). An unbound call fails
// CONTROL_UNAVAILABLE — it never silently allows.
//
// Authorization formula (spec/domains/access.md §2):
//   active principal ∩ role ceiling ∩ real active grant ∩ current
//   execution generation ∩ actual-target coverage.
// A MISSING GRANT DENIES — non-exposure is never the enforcement mechanism
// and role names/requiredActions mint no authority (REQ-09/REQ-10).

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AuthenticatedContext,
  AuthorizationDecision,
  CommandSurface,
  ErrorCode,
  Id,
  Revision
} from '../../../mahas-contracts/src/index.ts'
import { sha256Hex } from '../storage/db.ts'
import { AccessError, fail, newId, nowMs, stableStringify } from './internal.ts'
import { getPrincipalRow, PRINCIPAL_STATUS_ACTIVE } from './principal.ts'
import { ceilingForMember, currentPolicyRevision } from './policy.ts'
import {
  activeGrantRecordsForPrincipal,
  getGrantRecord,
  scopeCoversTargets,
  type GrantRecord
} from './grant.ts'
import {
  continuationAdmission,
  provisioningAdmission,
  type AdmissionVerdict
} from './provisioning.ts'
import { resolveActualTargets, type ResolvedTargets, type TargetRef } from './actual-targets.ts'

export type { TargetRef } from './actual-targets.ts'
export type {
  ContinuationScope,
  GrantInput,
  GrantRecord,
  GrantScope,
  ProvisioningScope
} from './grant.ts'
export { issueGrant } from './grant.ts'
export { revokeGrant, revokeGrantTree } from './revocation.ts'
export type { RevocationResult } from './revocation.ts'
export { AccessError } from './internal.ts'

/**
 * The only operations a bootstrap (pre-join) credential may invoke
 * (spec/domains/access.md §3). The full role surface activates after join.
 */
export const BOOTSTRAP_OPERATIONS: readonly string[] = [
  'execution.join',
  'assignment.show',
  'surface.describe',
  'operation.get'
]

/** Always surface-listed: the self-describing ops every credential needs. */
export const ALWAYS_SURFACE_OPERATIONS: readonly string[] = ['surface.describe', 'operation.get']

// ---------------------------------------------------------------------------
// secrets — execution_credentials.secret_hash (raw secrets are never stored,
// never placed in context/argv/logs; workers receive them privately).
// Format: 'scrypt:N:r:p:saltHex:derivedHex' (owner's choice per SHARED-APIS).
// 'sha256:<hex>' is accepted for interop with pre-KDF stores.
// ---------------------------------------------------------------------------

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 32

export function hashSecret(secret: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(secret, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${derived.toString('hex')}`
}

export function verifySecret(secret: string, secretHash: string): boolean {
  try {
    const parts = secretHash.split(':')
    if (parts[0] === 'scrypt' && parts.length === 6) {
      const n = Number(parts[1])
      const r = Number(parts[2])
      const p = Number(parts[3])
      const salt = Buffer.from(parts[4] as string, 'hex')
      const expected = Buffer.from(parts[5] as string, 'hex')
      const derived = scryptSync(secret, salt, expected.length, { N: n, r, p })
      return derived.length === expected.length && timingSafeEqual(derived, expected)
    }
    if (parts[0] === 'sha256' && parts.length === 2) {
      const expected = Buffer.from(parts[1] as string, 'hex')
      const actual = createHash('sha256').update(secret).digest()
      return actual.length === expected.length && timingSafeEqual(actual, expected)
    }
    return false
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// domain rows consulted by the formula (read-only; owned by other domains)
// ---------------------------------------------------------------------------

interface MemberRow {
  id: string
  run_id: string
  model_version: string
  role_id: string
  generation: number
  current_execution_id: string | null
  state: string
}

interface ExecutionRow {
  id: string
  member_id: string
  generation: number
  state: string
  liveness: string
}

function getMemberRow(db: DatabaseSync, id: string): MemberRow | null {
  const row = db
    .prepare(
      'SELECT id, run_id, model_version, role_id, generation, current_execution_id, state FROM members WHERE id = ?'
    )
    .get(id) as MemberRow | undefined
  return row ?? null
}

function getExecutionRow(db: DatabaseSync, id: string): ExecutionRow | null {
  const row = db
    .prepare('SELECT id, member_id, generation, state, liveness FROM executions WHERE id = ?')
    .get(id) as ExecutionRow | undefined
  return row ?? null
}

/** Joined = a worker_joins row exists for (execution, generation). */
function isJoined(db: DatabaseSync, executionId: string, generation: number): boolean {
  const row = db
    .prepare('SELECT 1 AS ok FROM worker_joins WHERE execution_id = ? AND generation = ?')
    .get(executionId, generation)
  return row != null
}

// ---------------------------------------------------------------------------
// F-018 — member ↔ principal binding (the identity claim must be one person)
// ---------------------------------------------------------------------------

/**
 * A member is its own principal (`members.id = principals.id` — the convention
 * team.assign uses when it issues the assignment grant to the memberId), or the
 * worker principal launch minted for that member's execution
 * (`principal-<executionId>`, launch/start-coordinator.ts). Anything else is a
 * forged pairing: `principalId=worker` + `memberId=reviewer` would otherwise let
 * one principal borrow another member's grants and member-scoped ops (VER-03
 * s3-bypass). This is checked at the kernel edge so every in-process and
 * socket ctx assembly path is covered.
 */
export function memberPrincipalBound(
  db: DatabaseSync,
  principalId: string,
  memberId: string
): boolean {
  if (principalId === memberId) return true
  const execution = db
    .prepare("SELECT 1 AS ok FROM executions WHERE member_id = ? AND ? = ('principal-' || id)")
    .get(memberId, principalId)
  return execution != null
}

/** fail closed when the ctx pairs a member with a principal that is not its own */
function requireMemberPrincipalBinding(
  db: DatabaseSync,
  ctx: AuthenticatedContext
): ErrorCode | null {
  if (ctx.memberId == null) return null
  return memberPrincipalBound(db, String(ctx.principalId), String(ctx.memberId))
    ? null
    : 'UNAUTHENTICATED'
}

/**
 * Every grant the caller may act with — the principal's active grants, the
 * active grants of the principal's bound member (team.assign issues the
 * assignment grant to the memberId, while the worker authenticates as the
 * member's principal), and any attested grant id whose owning principal is the
 * caller's principal or its bound member. Attested ids never widen the set
 * beyond owned rows (F-022).
 */
function callerGrantRecords(db: DatabaseSync, ctx: AuthenticatedContext, at: number): GrantRecord[] {
  const out = new Map<string, GrantRecord>()
  const principalId = String(ctx.principalId)
  for (const g of activeGrantRecordsForPrincipal(db, principalId, at)) out.set(g.id, g)
  const memberId = ctx.memberId != null ? String(ctx.memberId) : null
  if (memberId != null && memberId !== principalId) {
    for (const g of activeGrantRecordsForPrincipal(db, memberId, at)) out.set(g.id, g)
  }
  const owners = new Set<string>([principalId])
  if (memberId != null) owners.add(memberId)
  for (const [id, attestedRevision] of Object.entries(ctx.grantRevisions ?? {})) {
    const g = getGrantRecord(db, id)
    if (!g || !owners.has(String(g.principalId))) continue
    if (g.revokedAt != null) continue
    if (attestedRevision != null && g.revision !== attestedRevision) continue
    out.set(g.id, g)
  }
  return [...out.values()]
}

// ---------------------------------------------------------------------------
// decide — the formula + the durable AuthorizationDecision record
// ---------------------------------------------------------------------------

export interface DecideEvidence {
  reasonCode: ErrorCode | null
  reason: string | null
  grantId: string | null
  grantRevision: number | null
  policyId: string | null
  policyRevision: number | null
  ceilingApplied: boolean
  bootstrap: boolean
  /** false when the principal row does not exist — the FK blocks persistence */
  persisted: boolean
  checkedGrantIds: string[]
  unresolvedTargets: TargetRef[]
  decidedAt: number
}

export interface DecideOutcome {
  allow: boolean
  decision: AuthorizationDecision
  evidence: DecideEvidence
}

/**
 * Evaluate the authorization formula on `db`. Always produces a decision
 * object; persists to authorization_decisions whenever the principal row
 * exists (FK-bound attribution — see handoff note).
 */
export function decideOn(
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  operation: string,
  targets: TargetRef[]
): DecideOutcome {
  const at = nowMs()
  const resolved = resolveActualTargets(db, targets)
  const evidence: DecideEvidence = {
    reasonCode: null,
    reason: null,
    grantId: null,
    grantRevision: null,
    policyId: null,
    policyRevision: null,
    ceilingApplied: false,
    bootstrap: false,
    persisted: false,
    checkedGrantIds: [],
    unresolvedTargets: resolved.unresolved,
    decidedAt: at
  }
  const finish = (allow: boolean, code: ErrorCode | null, reason: string | null): DecideOutcome => {
    evidence.reasonCode = code
    evidence.reason = reason
    return {
      allow,
      decision: recordDecision(db, ctx, operation, allow, resolved, evidence),
      evidence
    }
  }

  // 1. currently valid principal
  const principal = getPrincipalRow(db, ctx.principalId)
  if (!principal || principal.status !== PRINCIPAL_STATUS_ACTIVE) {
    return finish(
      false,
      'UNAUTHENTICATED',
      principal ? `principal status '${principal.status}'` : 'unknown principal'
    )
  }

  // 1b. F-018 — the member this ctx claims must belong to that principal.
  //     Without this, an arbitrary memberId pairs with an arbitrary
  //     principal's authority (VER-03 s3 forged binding).
  const bindingError = requireMemberPrincipalBinding(db, ctx)
  if (bindingError) {
    return finish(
      false,
      bindingError,
      `member '${ctx.memberId}' is not bound to principal '${ctx.principalId}'`
    )
  }

  // 2. current execution generation — past generations change nothing
  if (ctx.executionId != null) {
    const execution = getExecutionRow(db, ctx.executionId)
    if (!execution)
      return finish(false, 'STALE_EXECUTION', `unknown execution '${ctx.executionId}'`)
    if (ctx.executionGeneration != null && execution.generation !== ctx.executionGeneration) {
      return finish(
        false,
        'STALE_EXECUTION',
        `execution generation is ${execution.generation}, credential attests ${ctx.executionGeneration}`
      )
    }
    if (ctx.memberId != null && execution.member_id !== ctx.memberId) {
      return finish(false, 'STALE_EXECUTION', 'execution belongs to a different member')
    }
    if (execution.liveness === 'exited') {
      return finish(false, 'STALE_EXECUTION', 'execution has exited')
    }
    evidence.bootstrap =
      ctx.executionGeneration != null && !isJoined(db, ctx.executionId, ctx.executionGeneration)
  }
  let member: MemberRow | null = null
  if (ctx.memberId != null) {
    member = getMemberRow(db, ctx.memberId)
    if (!member) return finish(false, 'UNAUTHENTICATED', `unknown member '${ctx.memberId}'`)
    if (ctx.executionGeneration != null && member.generation !== ctx.executionGeneration) {
      return finish(
        false,
        'STALE_EXECUTION',
        `member generation is ${member.generation}, credential attests ${ctx.executionGeneration}`
      )
    }
  }

  // 3. every grant the credential attested must still be standing — and it
  //    must belong to this principal (or its bound member) at the revision
  //    that was attested.
  //    F-022: an id alone is not proof of ownership (grant-id borrowing).
  //    F-024: a stale revision must fence reads too, not only the mutation
  //    boundary re-check (recheckCallerGrants).
  const owners = new Set<string>([String(ctx.principalId)])
  if (ctx.memberId != null) owners.add(String(ctx.memberId))
  for (const [grantId, attestedRevision] of Object.entries(ctx.grantRevisions ?? {})) {
    const grant = getGrantRecord(db, grantId)
    if (!grant || grant.revokedAt != null) {
      return finish(false, 'GRANT_REVOKED', `grant '${grantId}' is revoked`)
    }
    if (!owners.has(String(grant.principalId))) {
      return finish(
        false,
        'UNAUTHENTICATED',
        `grant '${grantId}' belongs to principal '${grant.principalId}', not '${ctx.principalId}'`
      )
    }
    if (attestedRevision != null && grant.revision !== attestedRevision) {
      return finish(
        false,
        'GRANT_REVOKED',
        `grant '${grantId}' moved to revision ${grant.revision} (attested ${attestedRevision})`
      )
    }
  }

  // 3b. F-002 — self-describing operations are listed on EVERY surface
  //     (ALWAYS_SURFACE_OPERATIONS) and must therefore be invocable without a
  //     grant: listed-but-denied would make the surface a name oracle.
  if (ALWAYS_SURFACE_OPERATIONS.includes(operation)) {
    return finish(true, null, 'always-surface operation')
  }

  // 4. bootstrap scope — the pre-join credential has its own narrow surface
  if (evidence.bootstrap) {
    if (BOOTSTRAP_OPERATIONS.includes(operation)) {
      return finish(true, null, 'bootstrap credential scope')
    }
    return finish(
      false,
      'SCOPE_DENIED',
      `bootstrap scope allows only ${BOOTSTRAP_OPERATIONS.join(', ')}`
    )
  }

  // 5. role ceiling — the maximum a member may ever do; an unpublished
  //    policy means NO extra restriction (grants still required)
  if (member) {
    const ceiling = ceilingForMember(db, member.id)
    if (ceiling) {
      evidence.policyId = ceiling.policy.id
      evidence.policyRevision = ceiling.policy.revision
      evidence.ceilingApplied = true
      if (!ceiling.ceiling.includes(operation)) {
        return finish(false, 'SCOPE_DENIED', `operation '${operation}' exceeds role policy ceiling`)
      }
    }
  }

  // 6. real grants — missing grant denies. The candidate set is the principal's
  //    active grants plus the grants of its bound member (team.assign keys the
  //    assignment grant to the memberId) and the attested ones (already verified
  //    principal/member-owned in step 3).
  const grants = callerGrantRecords(db, ctx, at)
  for (const grant of grants) {
    evidence.checkedGrantIds.push(grant.id)
    if (!grant.actions.includes(operation)) continue
    const verdict = admissionFor(db, grant, ctx, operation, resolved)
    if (!verdict.ok) continue
    evidence.grantId = grant.id
    evidence.grantRevision = grant.revision
    return finish(true, null, null)
  }
  return finish(
    false,
    'SCOPE_DENIED',
    'no active grant covers this operation on the actual targets'
  )
}

function admissionFor(
  db: DatabaseSync,
  grant: GrantRecord,
  ctx: AuthenticatedContext,
  operation: string,
  resolved: ResolvedTargets
): AdmissionVerdict {
  switch (grant.kind) {
    case 'provisioning':
      return provisioningAdmission(db, grant, resolved)
    case 'continuation':
      return continuationAdmission(db, grant, ctx, operation, resolved)
    default: {
      const coverage = scopeCoversTargets(db, grant.scope, resolved.primary)
      return coverage.covers
        ? { ok: true }
        : { ok: false, reason: 'grant scope does not cover the actual targets' }
    }
  }
}

/**
 * Persist + build the AuthorizationDecision. Contract fields follow
 * access.md §1 (requestId / actualTargets / policy & grant revisions /
 * allow-deny / reason) and the authorization_decisions columns.
 */
function recordDecision(
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  operation: string,
  allow: boolean,
  resolved: ResolvedTargets,
  evidence: DecideEvidence
): AuthorizationDecision {
  const id = newId('dec')
  const grantRevisions: Record<string, number> = {}
  for (const grantId of evidence.checkedGrantIds) {
    const g = getGrantRecord(db, grantId)
    if (g) grantRevisions[g.id] = g.revision
  }
  if (evidence.grantId) {
    const g = getGrantRecord(db, evidence.grantId)
    if (g) grantRevisions[g.id] = g.revision
  }
  const policyRevisions: Record<string, number> = {}
  if (evidence.policyId) policyRevisions[evidence.policyId] = evidence.policyRevision ?? 0
  const policyEvidence = {
    reasonCode: evidence.reasonCode,
    reason: evidence.reason,
    grantId: evidence.grantId,
    grantRevisions,
    policyRevisions,
    ceilingApplied: evidence.ceilingApplied,
    bootstrap: evidence.bootstrap,
    unresolvedTargets: evidence.unresolvedTargets,
    relations: resolved.relations,
    transportSessionId: ctx.transportSessionId,
    decidedAt: evidence.decidedAt
  }
  if (getPrincipalRow(db, ctx.principalId) != null) {
    db.prepare(
      `INSERT INTO authorization_decisions
         (id, principal_id, operation_key, allow, actual_targets_json, policy_evidence_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      ctx.principalId,
      operation,
      allow ? 1 : 0,
      JSON.stringify(resolved.all),
      JSON.stringify(policyEvidence)
    )
    evidence.persisted = true
  }
  const decision: AuthorizationDecision = {
    id: id as Id,
    requestId: ctx.transportSessionId,
    principalId: ctx.principalId,
    operation,
    allow,
    reason: evidence.reason ?? evidence.reasonCode ?? 'allowed',
    actualTargets: resolved.all,
    grantRevisions,
    policyRevisions,
    decidedAt: evidence.decidedAt
  }
  return decision
}

// ---------------------------------------------------------------------------
// authorize — decide + throw on deny (SHARED-APIS)
// ---------------------------------------------------------------------------

/** Explicit-handle authorize (instruction §6 `authorizeTargets`). */
export function authorizeTargets(
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  operation: string,
  targets: TargetRef[]
): void {
  const outcome = decideOn(db, ctx, operation, targets)
  if (!outcome.allow) {
    throw new AccessError(
      outcome.evidence.reasonCode ?? 'SCOPE_DENIED',
      outcome.evidence.reason ?? `authorization denied for '${operation}'`,
      {
        // worker-facing: operation + opaque decision id only (D-ACCESS §1).
        // actualTargets / grantRevisions stay on the authorization_decisions row.
        details: { operation, decisionId: String(outcome.decision.id) }
      }
    )
  }
}

// ---------------------------------------------------------------------------
// grantSnapshot / recheck — re-read CURRENT grant revision·expiry·revocation
// before a side effect (common.md §3, access.md §4)
// ---------------------------------------------------------------------------

export interface GrantSnapshotEntry {
  revision: number
  expiresAt: number | null
  revokedAt: number | null
}

export interface GrantSnapshot {
  principalId: string
  memberId: string | null
  executionId: string | null
  executionGeneration: number | null
  takenAt: number
  grants: Record<string, GrantSnapshotEntry>
  policy: { id: string; revision: number } | null
}

/** Capture the grant/policy/generation state a plan was authorized under. */
export function grantSnapshot(db: DatabaseSync, ctx: AuthenticatedContext): GrantSnapshot {
  const at = nowMs()
  const grants: Record<string, GrantSnapshotEntry> = {}
  // F-022: only grants owned by this principal (or its bound member) may enter
  // the snapshot — a snapshot is a proof set, and a foreign grant id is not.
  for (const g of callerGrantRecords(db, ctx, at)) {
    grants[g.id] = { revision: g.revision, expiresAt: g.expiresAt, revokedAt: g.revokedAt }
  }
  let policy: GrantSnapshot['policy'] = null
  if (ctx.memberId != null) {
    const ceiling = ceilingForMember(db, ctx.memberId)
    if (ceiling) policy = { id: ceiling.policy.id, revision: ceiling.policy.revision }
  }
  return {
    principalId: ctx.principalId,
    memberId: ctx.memberId != null ? String(ctx.memberId) : null,
    executionId: ctx.executionId != null ? String(ctx.executionId) : null,
    executionGeneration: ctx.executionGeneration != null ? Number(ctx.executionGeneration) : null,
    takenAt: at,
    grants,
    policy
  }
}

/**
 * Re-verify a snapshot immediately before an external effect. Revocation
 * and generation drift fail closed — the already-started effect is the
 * caller's problem to report, never to un-happen (access.md §4).
 */
export function recheckGrantSnapshot(
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  snapshot: GrantSnapshot
): void {
  const at = nowMs()
  if (ctx.principalId !== snapshot.principalId) {
    fail('UNAUTHENTICATED', 'snapshot belongs to a different principal')
  }
  // F-018 — a member/principal pair that drifted apart cannot keep acting on
  // the snapshot's authority.
  const bindingError = requireMemberPrincipalBinding(db, ctx)
  if (bindingError) {
    fail(bindingError, `member '${ctx.memberId}' is not bound to principal '${ctx.principalId}'`)
  }
  const owners = new Set<string>([String(ctx.principalId)])
  if (ctx.memberId != null) owners.add(String(ctx.memberId))
  for (const [grantId, prev] of Object.entries(snapshot.grants)) {
    const grant = getGrantRecord(db, grantId)
    if (!grant) fail('GRANT_REVOKED', `grant '${grantId}' no longer exists`)
    // F-022 — foreign grant ids never authorized anything (defensive: a
    // snapshot could have been minted before this check existed).
    if (!owners.has(String(grant.principalId))) {
      fail(
        'UNAUTHENTICATED',
        `grant '${grantId}' belongs to principal '${grant.principalId}', not '${ctx.principalId}'`
      )
    }
    if (grant.revokedAt != null) fail('GRANT_REVOKED', `grant '${grantId}' was revoked`)
    if (grant.revision !== prev.revision) {
      fail(
        'STALE_REVISION',
        `grant '${grantId}' moved from revision ${prev.revision} to ${grant.revision}`
      )
    }
    if (grant.expiresAt != null && grant.expiresAt <= at) {
      fail('SCOPE_DENIED', `grant '${grantId}' expired`)
    }
  }
  if (snapshot.policy) {
    const current = currentPolicyRevision(db, snapshot.policy.id)
    if (current !== snapshot.policy.revision) {
      fail('STALE_REVISION', `policy '${snapshot.policy.id}' moved to revision ${current}`)
    }
  }
  if (snapshot.executionId && snapshot.executionGeneration != null) {
    const execution = getExecutionRow(db, snapshot.executionId)
    if (
      !execution ||
      execution.generation !== snapshot.executionGeneration ||
      execution.liveness === 'exited'
    ) {
      fail('STALE_EXECUTION', 'execution generation changed since the snapshot was taken')
    }
  }
  if (snapshot.memberId && snapshot.executionGeneration != null) {
    const member = getMemberRow(db, snapshot.memberId)
    if (!member || member.generation !== snapshot.executionGeneration) {
      fail('STALE_EXECUTION', 'member generation changed since the snapshot was taken')
    }
  }
}

// ---------------------------------------------------------------------------
// command surface — the non-exposure projection (spec §3, REQ-09)
// ---------------------------------------------------------------------------

/**
 * Effective visible actions for a context: bootstrap scope for pre-join
 * credentials; otherwise the union of active-grant actions clipped by the
 * member's role ceiling, plus the always-self-describing ops.
 */
export function effectiveActionsFor(
  db: DatabaseSync,
  ctx: AuthenticatedContext
): { actions: string[]; policyId: string | null; policyRevision: number | null } {
  const at = nowMs()
  const principal = getPrincipalRow(db, ctx.principalId)
  if (!principal || principal.status !== PRINCIPAL_STATUS_ACTIVE) {
    return { actions: [], policyId: null, policyRevision: null }
  }
  // F-018 — surface projection must not honour a forged member↔principal pair
  // either (it is the same identity claim the decision path rejects).
  if (requireMemberPrincipalBinding(db, ctx)) {
    return { actions: [], policyId: null, policyRevision: null }
  }
  if (
    ctx.executionId != null &&
    ctx.executionGeneration != null &&
    !isJoined(db, ctx.executionId, ctx.executionGeneration)
  ) {
    return {
      actions: [...new Set([...BOOTSTRAP_OPERATIONS, ...ALWAYS_SURFACE_OPERATIONS])].sort(),
      policyId: null,
      policyRevision: null
    }
  }
  const grants = callerGrantRecords(db, ctx, at)
  const set = new Set<string>()
  for (const g of grants) for (const a of g.actions) set.add(a)
  let policyId: string | null = null
  let policyRevision: number | null = null
  if (ctx.memberId != null) {
    const ceiling = ceilingForMember(db, ctx.memberId)
    if (ceiling) {
      policyId = ceiling.policy.id
      policyRevision = ceiling.policy.revision
      for (const a of [...set]) {
        if (!ceiling.ceiling.includes(a)) set.delete(a)
      }
    }
  }
  for (const a of ALWAYS_SURFACE_OPERATIONS) set.add(a)
  return { actions: [...set].sort(), policyId, policyRevision }
}

/**
 * Build + persist (dedup by digest) the immutable CommandSurface snapshot.
 * `schemas` is empty here — IMP-11's OperationRegistry attaches the canonical
 * schemas for the same action set so help/schema/completion/MCP/UI share one
 * projection.
 */
export function surfaceForOn(db: DatabaseSync, ctx: AuthenticatedContext): CommandSurface {
  const { actions, policyId, policyRevision } = effectiveActionsFor(db, ctx)
  const bootstrap =
    ctx.executionId != null &&
    ctx.executionGeneration != null &&
    !isJoined(db, ctx.executionId, ctx.executionGeneration)
  const pins = {
    policyId,
    policyRevision,
    principalId: ctx.principalId,
    memberId: ctx.memberId ?? null,
    bootstrap
  }
  const schemas: Record<string, unknown> = {}
  const digest = sha256Hex(stableStringify({ actions, schemas, pins }))
  db.prepare(
    'INSERT OR IGNORE INTO command_surfaces (digest, actions_and_schemas_json, policy_pins_json) VALUES (?, ?, ?)'
  ).run(digest, JSON.stringify({ actions, schemas }), JSON.stringify(pins))
  const surface: CommandSurface = {
    digest,
    effectiveActions: actions,
    schemas,
    visibilityScope: {
      principalId: ctx.principalId,
      memberId: ctx.memberId ?? null,
      bootstrap
    },
    rolePolicyRevision: (policyRevision ?? undefined) as Revision | undefined
  }
  return surface
}

export function isOperationVisible(surface: CommandSurface, operation: string): boolean {
  return surface.effectiveActions.includes(operation)
}

// ---------------------------------------------------------------------------
// kernel binding — how authorize/decide get a DB without taking one
// ---------------------------------------------------------------------------

export interface AccessKernel {
  readonly db: DatabaseSync
  authorize(ctx: AuthenticatedContext, operation: string, targets: TargetRef[]): void
  decide(
    ctx: AuthenticatedContext,
    operation: string,
    targets: TargetRef[]
  ): { allow: boolean; decision: AuthorizationDecision }
  authorizeTargets(ctx: AuthenticatedContext, operation: string, targets: TargetRef[]): void
  decideOn(ctx: AuthenticatedContext, operation: string, targets: TargetRef[]): DecideOutcome
  grantSnapshot(ctx: AuthenticatedContext): GrantSnapshot
  recheckGrantSnapshot(ctx: AuthenticatedContext, snapshot: GrantSnapshot): void
  surfaceFor(ctx: AuthenticatedContext): CommandSurface
  isOperationVisible(surface: CommandSurface, operation: string): boolean
}

/** Explicit-handle kernel — no process-wide state. */
export function makeAccessKernel(db: DatabaseSync): AccessKernel {
  return {
    db,
    authorize: (ctx, operation, targets) => authorizeTargets(db, ctx, operation, targets),
    decide: (ctx, operation, targets) => {
      const outcome = decideOn(db, ctx, operation, targets)
      return { allow: outcome.allow, decision: outcome.decision }
    },
    authorizeTargets: (ctx, operation, targets) => authorizeTargets(db, ctx, operation, targets),
    decideOn: (ctx, operation, targets) => decideOn(db, ctx, operation, targets),
    grantSnapshot: (ctx) => grantSnapshot(db, ctx),
    recheckGrantSnapshot: (ctx, snapshot) => recheckGrantSnapshot(db, ctx, snapshot),
    surfaceFor: (ctx) => surfaceForOn(db, ctx),
    isOperationVisible
  }
}

let boundKernel: AccessKernel | null = null

/** Bind the process-wide kernel used by the parameter-less SHARED-APIS fns. */
export function bindAccessDb(db: DatabaseSync): AccessKernel {
  boundKernel = makeAccessKernel(db)
  return boundKernel
}

export function unbindAccessDb(): void {
  boundKernel = null
}

export function getAccessKernel(): AccessKernel {
  if (!boundKernel) {
    fail(
      'CONTROL_UNAVAILABLE',
      'access kernel is not bound to a control DB — call bindAccessDb at service start'
    )
  }
  return boundKernel
}

// ---- fixed SHARED-APIS signatures ----

export function authorize(
  ctx: AuthenticatedContext,
  operation: string,
  targets: TargetRef[]
): void {
  getAccessKernel().authorize(ctx, operation, targets)
}

export function decide(
  ctx: AuthenticatedContext,
  operation: string,
  targets: TargetRef[]
): { allow: boolean; decision: AuthorizationDecision } {
  return getAccessKernel().decide(ctx, operation, targets)
}

export function surfaceFor(ctx: AuthenticatedContext, db: DatabaseSync): CommandSurface {
  return surfaceForOn(db, ctx)
}
