// coordination/internal.ts — shared helpers for the IMP-13 work boundary.
//
// Scope (instruction §5): runtime/coordination — Run, Member, Assignment,
// META DAG (PlanRevision), eligibility projection. Execution-process
// creation/reporting is NOT here (IMP-19/20/21).
//
// Conventions (packages/SHARED-APIS.md): strict NodeNext, `.ts`-extension
// relative imports, `import type` for type-only use. Kernel helpers come
// from the promised module paths (IMP-03 storage/db.ts, IMP-10
// access/authorize.ts, IMP-11 api/registry.ts); canonical domain type
// names come from mahas-contracts (IMP-02). Row→type mapping follows the
// spec/storage.md §3 column names converted to camelCase.

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  Id,
  Revision,
  MahasError,
  ErrorCode,
  ErrorRetry,
  AuthenticatedContext
} from '../../../mahas-contracts/src/common.ts'
import type {
  Run,
  Member,
  Assignment,
  Plan,
  PlanCandidate,
  Task,
  TaskSpec,
  TaskEdge,
  Dispatch,
  ExecutionRecord,
  WorkerJoin
} from '../../../mahas-contracts/src/work.ts'
import type { Message, Delivery } from '../../../mahas-contracts/src/mail.ts'
import type { Grant } from '../../../mahas-contracts/src/access.ts'
import type { Role } from '../../../mahas-contracts/src/rdd.ts'
import type { RoleImplementation, RoleInterface } from '../../../mahas-contracts/src/role.ts'
import { sha256Hex } from '../storage/db.ts'

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Throws a MahasError that is also an `Error` instance so any dispatcher
 * brand-check (`instanceof Error` or structural `code` match) recognises it.
 */
export function fail(
  code: ErrorCode,
  message: string,
  retry: ErrorRetry = 'none',
  details?: unknown
): never {
  const e = new Error(message) as Error & MahasError
  e.code = code
  e.retry = retry
  if (details !== undefined) e.details = details
  throw e
}

/** a request payload field is missing/malformed — see handoff note: the */
/** common ErrorCode list has no BAD_INPUT; MODEL_INVALID is the closest. */
export function badInput(message: string, details?: unknown): never {
  return fail('MODEL_INVALID', message, 'none', details)
}

/* ------------------------------------------------------------------ */
/* ids / time / canonical json                                         */
/* ------------------------------------------------------------------ */

export function newId(prefix: string): Id {
  return `${prefix}_${randomUUID()}` as Id
}

export function nowMs(): number {
  return Date.now()
}

/** deterministic JSON (sorted object keys) for digests stored in plans/  */
/** plan_candidates and compared against caller-supplied digests.         */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o).sort()) out[k] = sortDeep(o[k])
    return out
  }
  return v
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

export function parseJson<T>(raw: unknown, what: string): T {
  if (typeof raw !== 'string') fail('MODEL_INVALID', `${what}: expected JSON text column`)
  try {
    return JSON.parse(raw as string) as T
  } catch {
    return fail('MODEL_INVALID', `${what}: stored JSON is not parseable`)
  }
}

/* ------------------------------------------------------------------ */
/* payload validation                                                  */
/* ------------------------------------------------------------------ */

export function asObject(payload: unknown, op: string): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    badInput(`${op}: payload must be an object`)
  }
  return payload as Record<string, unknown>
}

export function reqStr(o: Record<string, unknown>, key: string, op: string): string {
  const v = o[key]
  if (typeof v !== 'string' || v.length === 0)
    badInput(`${op}: '${key}' must be a non-empty string`)
  return v as string
}

export function optStr(o: Record<string, unknown>, key: string, op: string): string | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') badInput(`${op}: '${key}' must be a string`)
  return v as string
}

export function reqInt(o: Record<string, unknown>, key: string, op: string): number {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isInteger(v)) badInput(`${op}: '${key}' must be an integer`)
  return v as number
}

export function optInt(o: Record<string, unknown>, key: string, op: string): number | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v)) badInput(`${op}: '${key}' must be an integer`)
  return v as number
}

export function reqArr(o: Record<string, unknown>, key: string, op: string): unknown[] {
  const v = o[key]
  if (!Array.isArray(v)) badInput(`${op}: '${key}' must be an array`)
  return v as unknown[]
}

export function optArr(o: Record<string, unknown>, key: string, op: string): unknown[] {
  const v = o[key]
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) badInput(`${op}: '${key}' must be an array`)
  return v as unknown[]
}

export function optObj(
  o: Record<string, unknown>,
  key: string,
  op: string
): Record<string, unknown> | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (v === null || typeof v !== 'object' || Array.isArray(v))
    badInput(`${op}: '${key}' must be an object`)
  return v as Record<string, unknown>
}

/* ------------------------------------------------------------------ */
/* row helpers — node:sqlite returns plain objects keyed by column     */
/* ------------------------------------------------------------------ */

export function one(
  db: DatabaseSync,
  sql: string,
  ...params: (string | number | null)[]
): Record<string, unknown> | null {
  const row = db.prepare(sql).get(...params)
  return (row as Record<string, unknown> | undefined) ?? null
}

export function all(
  db: DatabaseSync,
  sql: string,
  ...params: (string | number | null)[]
): Record<string, unknown>[] {
  return db.prepare(sql).all(...params) as Record<string, unknown>[]
}

export function run(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): number {
  const r = db.prepare(sql).run(...params)
  return Number(r.changes)
}

function num(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : (v as number)
}

/* ------------------------------------------------------------------ */
/* row → domain type mappers (storage.md §3 snake_case → camelCase)    */
/* ------------------------------------------------------------------ */

export function toRun(r: Record<string, unknown>): Run {
  return {
    id: r.id as Id,
    projectId: r.project_id as Id,
    modelVersion: r.model_version as Run['modelVersion'],
    goalText: r.goal_text as string,
    purpose: r.purpose as Run['purpose'],
    coordinatorMemberId: (r.coordinator_member_id as Id | null) ?? undefined,
    state: r.state as Run['state'],
    currentPlanRevision: (r.current_plan_revision as number | null) ?? undefined,
    revision: num(r.revision) as Revision
  } as Run
}

export function toMember(r: Record<string, unknown>): Member {
  return {
    id: r.id as Id,
    runId: r.run_id as Id,
    modelVersion: r.model_version as Member['modelVersion'],
    roleId: r.role_id as Id,
    implementationId: r.implementation_id as Id,
    implementationRevision: num(r.implementation_revision) as Member['implementationRevision'],
    generation: num(r.generation) as Member['generation'],
    currentExecutionId: (r.current_execution_id as Id | null) ?? undefined,
    state: r.state as Member['state'],
    revision: num(r.revision) as Revision
  } as Member
}

export function toAssignment(r: Record<string, unknown>): Assignment {
  return {
    id: r.id as Id,
    revision: num(r.revision) as Revision,
    memberId: r.member_id as Id,
    kind: r.kind as Assignment['kind'],
    mandateText: r.mandate_text as string,
    grantId: r.grant_id as Id,
    taskId: (r.task_id as Id | null) ?? undefined,
    taskRevision: (r.task_revision as number | null) ?? undefined,
    scope: parseJson(r.scope_json, `assignments(${r.id}).scope_json`)
  } as Assignment
}

export function toPlan(r: Record<string, unknown>): Plan {
  return {
    runId: r.run_id as Id,
    revision: num(r.revision) as Plan['revision'],
    digest: r.digest as string,
    dispositions: parseJson(
      r.dispositions_json,
      `plans(${r.run_id},${r.revision}).dispositions_json`
    )
  } as Plan
}

export function toPlanCandidate(r: Record<string, unknown>): PlanCandidate {
  return {
    id: r.id as Id,
    runId: r.run_id as Id,
    baseRevision: (r.base_revision as number | null) ?? undefined,
    digest: r.digest as string,
    patch: parseJson(r.patch_json, `plan_candidates(${r.id}).patch_json`),
    diagnostics: parseJson(r.diagnostics_json, `plan_candidates(${r.id}).diagnostics_json`)
  } as PlanCandidate
}

export function toTask(r: Record<string, unknown>): Task {
  return {
    id: r.id as Id,
    runId: r.run_id as Id,
    currentRevision: num(r.current_revision) as Task['currentRevision'],
    currentDispatchId: (r.current_dispatch_id as Id | null) ?? undefined
  } as Task
}

export function toTaskSpec(r: Record<string, unknown>): TaskSpec {
  return {
    taskId: r.task_id as Id,
    revision: num(r.revision) as TaskSpec['revision'],
    title: r.title as string,
    requirementText: r.requirement_text as string,
    ownerRoleId: r.owner_role_id as Id,
    assignedMemberId: (r.assigned_member_id as Id | null) ?? undefined,
    inputs: parseJson(r.inputs_json, `task_specs(${r.task_id},${r.revision}).inputs_json`),
    outputs: parseJson(r.outputs_json, `task_specs(${r.task_id},${r.revision}).outputs_json`),
    settlementPolicy: parseJson(
      r.settlement_policy_json,
      `task_specs(${r.task_id},${r.revision}).settlement_policy_json`
    )
  } as TaskSpec
}

export function toTaskEdge(r: Record<string, unknown>): TaskEdge {
  const req = parseJson<{
    requiredOutputNames?: string[]
    requiredOutputs?: string[]
    settlementRequirement?: string
  }>(r.requirements_json, `task_edges(${r.from_task}->${r.to_task}).requirements_json`)
  return {
    runId: r.run_id as Id,
    planRevision: num(r.plan_revision) as TaskEdge['planRevision'],
    predecessorTaskId: r.from_task as Id,
    successorTaskId: r.to_task as Id,
    requiredOutputNames: req.requiredOutputNames ?? req.requiredOutputs ?? [],
    settlementRequirement: req.settlementRequirement ?? 'accepted'
  } as TaskEdge
}

export function toDispatch(r: Record<string, unknown>): Dispatch {
  return {
    id: r.id as Id,
    taskId: r.task_id as Id,
    taskRevision: num(r.task_revision) as Dispatch['taskRevision'],
    memberId: r.member_id as Id,
    executionId: r.execution_id as Id,
    generation: num(r.generation) as Dispatch['generation'],
    envelopeDigest: r.envelope_digest as Dispatch['envelopeDigest'],
    phase: r.phase as Dispatch['phase'],
    authorityState: r.authority_state as Dispatch['authorityState'],
    assignmentDeliveryId: (r.assignment_delivery_id as Id | null) ?? undefined,
    revision: num(r.revision) as Revision
  } as Dispatch
}

export function toMessage(r: Record<string, unknown>): Message {
  return {
    id: r.id as Id,
    runId: r.run_id as Id,
    senderPrincipalId: r.sender_principal_id as Id,
    senderMemberId: (r.sender_member_id as Id | null) ?? undefined,
    kind: r.kind as Message['kind'],
    body: r.body as string,
    links: parseJson(r.links_json, `messages(${r.id}).links_json`),
    createdAt: num(r.created_at)
  } as Message
}

export function toDelivery(r: Record<string, unknown>): Delivery {
  return {
    id: r.id as Id,
    messageId: r.message_id as Id,
    recipientMemberId: r.recipient_member_id as Id,
    consumerGeneration: num(r.consumer_generation) as Delivery['consumerGeneration'],
    status: r.status as Delivery['status'],
    revision: num(r.revision) as Revision,
    ackedAt: (r.acked_at as number | null) ?? undefined,
    handling: parseJson(r.handling_json, `deliveries(${r.id}).handling_json`)
  } as Delivery
}

export function toGrant(r: Record<string, unknown>): Grant {
  return {
    id: r.id as Id,
    revision: num(r.revision) as Revision,
    kind: r.kind as Grant['kind'],
    principalId: r.principal_id as Id,
    parentGrantId: (r.parent_grant_id as Id | null) ?? undefined,
    policyId: (r.policy_id as Id | null) ?? undefined,
    policyRevision: (r.policy_revision as number | null) ?? undefined,
    expiresAt: (r.expires_at as number | null) ?? undefined,
    revokedAt: (r.revoked_at as number | null) ?? undefined,
    scope: parseJson(r.scope_json, `grants(${r.id}).scope_json`),
    actions: parseJson(r.actions_json, `grants(${r.id}).actions_json`)
  } as Grant
}

export function toRole(r: Record<string, unknown>): Role {
  return {
    modelVersion: r.model_version as Role['modelVersion'],
    id: r.id as Id,
    name: r.name as string,
    description: r.description as string,
    boundaryId: r.boundary_id as Id,
    horizontalRoleName: r.horizontal_role_name as string
  } as Role
}

export function toRoleImplementation(r: Record<string, unknown>): RoleImplementation {
  return {
    id: r.id as Id,
    revision: num(r.revision) as RoleImplementation['revision'],
    interfaceDigest: r.interface_digest as RoleImplementation['interfaceDigest'],
    profileId: r.profile_id as Id,
    profileRevision: num(r.profile_revision) as RoleImplementation['profileRevision'],
    status: r.status as RoleImplementation['status'],
    maintainerRoleId: r.maintainer_role_id as Id,
    semanticDecision: (r.semantic_decision as string | null) ?? undefined
  } as RoleImplementation
}

export function toRoleInterface(r: Record<string, unknown>): RoleInterface {
  return {
    digest: r.digest as RoleInterface['digest'],
    modelVersion: r.model_version as RoleInterface['modelVersion'],
    roleId: r.role_id as Id,
    requirements: parseJson(r.requirements_json, `role_interfaces(${r.digest}).requirements_json`),
    judgmentScope: parseJson(
      r.judgment_scope_json,
      `role_interfaces(${r.digest}).judgment_scope_json`
    )
  } as RoleInterface
}

export function toExecutionRecord(r: Record<string, unknown>): ExecutionRecord {
  return {
    id: r.id as Id,
    memberId: r.member_id as Id,
    generation: num(r.generation) as ExecutionRecord['generation'],
    hostId: r.host_id as Id,
    launchPlanId: r.launch_plan_id as Id,
    state: r.state as ExecutionRecord['state'],
    liveness: r.liveness as ExecutionRecord['liveness'],
    terminalId: (r.terminal_id as Id | null) ?? undefined,
    processIdentity: parseJson(
      r.process_identity_json,
      `executions(${r.id}).process_identity_json`
    ),
    nativeConversation: parseJson(
      r.native_conversation_json,
      `executions(${r.id}).native_conversation_json`
    ),
    revision: num(r.revision) as Revision
  } as ExecutionRecord
}

export function toWorkerJoin(r: Record<string, unknown>): WorkerJoin {
  return {
    executionId: r.execution_id as Id,
    generation: num(r.generation) as WorkerJoin['generation'],
    bundleDigest: r.bundle_digest as WorkerJoin['bundleDigest'],
    surfaceDigest: r.surface_digest as WorkerJoin['surfaceDigest'],
    envelopeDigest: r.envelope_digest as WorkerJoin['envelopeDigest'],
    joinedAt: num(r.joined_at)
  } as WorkerJoin
}

/* ------------------------------------------------------------------ */
/* entity loaders (null → typed failure)                               */
/* ------------------------------------------------------------------ */

export function loadRun(db: DatabaseSync, runId: string): Run {
  const r = one(db, 'SELECT * FROM runs WHERE id=?', runId)
  if (!r) fail('SCOPE_DENIED', `run ${runId} is not visible`) // no existence leak pre-auth
  return toRun(r!)
}

export function loadMember(db: DatabaseSync, memberId: string): Member {
  const r = one(db, 'SELECT * FROM members WHERE id=?', memberId)
  if (!r) fail('SCOPE_DENIED', `member ${memberId} is not visible`)
  return toMember(r!)
}

export function loadTask(db: DatabaseSync, taskId: string): Task {
  const r = one(db, 'SELECT * FROM tasks WHERE id=?', taskId)
  if (!r) fail('INPUT_NOT_READY', `task ${taskId} does not exist`)
  return toTask(r!)
}

export function loadTaskSpec(db: DatabaseSync, taskId: string, revision: number): TaskSpec | null {
  const r = one(db, 'SELECT * FROM task_specs WHERE task_id=? AND revision=?', taskId, revision)
  return r ? toTaskSpec(r) : null
}

export function activeDispatchForTask(db: DatabaseSync, taskId: string): Dispatch | null {
  const r = one(db, "SELECT * FROM dispatches WHERE task_id=? AND authority_state='active'", taskId)
  return r ? toDispatch(r) : null
}

export function activeDispatchForExecution(db: DatabaseSync, executionId: string): Dispatch | null {
  const r = one(
    db,
    "SELECT * FROM dispatches WHERE execution_id=? AND authority_state='active'",
    executionId
  )
  return r ? toDispatch(r) : null
}

/* ------------------------------------------------------------------ */
/* grant re-verification inside the write tx                           */
/* ------------------------------------------------------------------ */

/**
 * D-ACCESS §4: a DB mutation re-reads the caller's current grant revisions
 * inside the same transaction — the admission-time snapshot is not enough.
 */
export function recheckCallerGrants(db: DatabaseSync, ctx: AuthenticatedContext, at: number): void {
  for (const [grantId, rev] of Object.entries(ctx.grantRevisions ?? {})) {
    const r = one(db, 'SELECT revision, revoked_at, expires_at FROM grants WHERE id=?', grantId)
    if (!r) fail('GRANT_REVOKED', `grant ${grantId} no longer exists`, 'reconcile')
    if (num(r!.revision) !== rev) {
      fail(
        'GRANT_REVOKED',
        `grant ${grantId} moved to revision ${num(r!.revision)}`,
        'same-operation'
      )
    }
    if (r!.revoked_at !== null) fail('GRANT_REVOKED', `grant ${grantId} was revoked`, 'replan')
    if (r!.expires_at !== null && num(r!.expires_at) <= at) {
      fail('GRANT_REVOKED', `grant ${grantId} expired`, 'replan')
    }
  }
}

/** the caller's live, unexpired grants of one kind — ProvisioningGrant scan */
export function callerGrantsOfKind(
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  kind: string,
  at: number
): Grant[] {
  const out: Grant[] = []
  for (const grantId of Object.keys(ctx.grantRevisions ?? {})) {
    const r = one(
      db,
      'SELECT * FROM grants WHERE id=? AND kind=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)',
      grantId,
      kind,
      at
    )
    if (r) out.push(toGrant(r))
  }
  return out
}

/* ------------------------------------------------------------------ */
/* run state gates                                                     */
/* ------------------------------------------------------------------ */

/** mutations that add work to a Run require it to be open */
export function requireOpenRun(run: Run, op: string): void {
  if (run.state === 'settled' || run.state === 'archived') {
    fail('INVALID_TRANSITION', `${op}: run ${run.id} is ${run.state}`, 'replan')
  }
}

/** draft→active on the first real work mutation (assign / plan commit). */
export function activateRunIfDraft(db: DatabaseSync, runRow: Run): void {
  if (runRow.state === 'draft') {
    run(
      db,
      "UPDATE runs SET state='active', revision=revision+1 WHERE id=? AND state='draft'",
      runRow.id as string
    )
  }
}
