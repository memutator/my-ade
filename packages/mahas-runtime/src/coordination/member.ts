// coordination/member.ts — team.assign / team.retire / task.dispatch.
//
// team.assign atomically creates Member + Assignment revision + the
// AssignmentGrant binding in one tx after re-checking the selectionToken
// pins, current model/role/implementation, and the caller's provisioning
// grant (C-WORK team.assign, REQ-10 least delegation: a member can never be
// promoted into spawning other roles — its grant carries only the actions
// its assignment kind needs).
//
// team.retire fences the member's mailbox and prevents new assignment;
// in-flight work is never silently dropped — dispositions are explicit.
//
// task.dispatch pins the next Task onto an already-joined execution: new
// WorkEnvelope + Dispatch + assignment Message/Delivery in one tx. It
// creates no process and calls no provider turn API (D-WORK §3).

import type { DatabaseSync } from 'node:sqlite'
import { authorize, issueGrant } from '../access/authorize.ts'
import { appendDomainEvent, putContentBlob, sha256Hex } from '../storage/db.ts'
import type { TxnContext } from '../api/registry.ts'
import type { Id, ArtifactRef } from '../../../mahas-contracts/src/common.ts'
import type { InputBinding, Member } from '../../../mahas-contracts/src/work.ts'
import type { Grant } from '../../../mahas-contracts/src/access.ts'
import {
  asObject,
  reqStr,
  optStr,
  optInt,
  optObj,
  badInput,
  fail,
  newId,
  nowMs,
  one,
  all,
  run as exec,
  toMember,
  toAssignment,
  toRole,
  toRoleImplementation,
  toRoleInterface,
  toExecutionRecord,
  toWorkerJoin,
  loadRun,
  loadMember,
  loadTask,
  loadTaskSpec,
  activeDispatchForTask,
  activeDispatchForExecution,
  recheckCallerGrants,
  callerGrantsOfKind,
  requireOpenRun,
  activateRunIfDraft,
  canonicalJson,
  parseJson
} from './internal.ts'
import { resolveInputBindings, type ResolvedInput } from './eligibility.ts'
import type { VerifySelectionToken, SelectionTokenPins } from './index.ts'

/* ------------------------------------------------------------------ */
/* payloads                                                            */
/* ------------------------------------------------------------------ */

export type AssignmentKind = 'coordination' | 'task'

export interface TeamAssignInput {
  runId: string
  selectionToken: string
  implementationRevision: number
  assignmentKind: AssignmentKind
  mandateText: string
  taskId?: string
  taskRevision?: number
  placementIntent?: Record<string, unknown>
  expectedPlanRevision?: number
}

export interface TeamAssignResult {
  memberId: Id
  assignmentId: Id
  state: string
  effectiveGrantBinding: {
    grantId: Id
    actions: string[]
    policyId?: string
    policyRevision?: number
  }
}

export interface TeamRetireInput {
  memberId: string
  expectedRevision: number
  pendingDeliveryDisposition: 'fence' | 'keep'
  activeExecutionDisposition: 'keep' | 'request-stop' | 'revoke-dispatch'
}

export interface TeamRetireResult {
  member: Member
  fencedDeliveries: string[]
  residualExecutions: string[]
  effectIntentIds: string[]
}

export interface TaskDispatchInput {
  taskId: string
  taskRevision: number
  memberId: string
  expectedExecutionId: string
  expectedExecutionGeneration: number
  expectedPlanRevision: number
  inputBindings?: {
    slot: string
    artifactId?: string
    artifactRevision?: number
    digest?: string
  }[]
}

export interface TaskDispatchResult {
  dispatchId: Id
  envelopeDigest: string
  messageId: Id
  deliveryId: Id
  accepted: false
}

/* ------------------------------------------------------------------ */
/* action vocabulary per assignment kind (member-side least privilege)  */
/* ------------------------------------------------------------------ */

/**
 * Provisional action vocabulary (spec/operations.md names). The grant
 * stores only what the assignment kind needs — a task member never
 * receives coordination ops (no spawn-escalation, REQ-10).
 */
export function requiredActionsFor(kind: AssignmentKind): string[] {
  const base = [
    'surface.describe',
    'operation.get',
    'assignment.show',
    'inbox.check',
    'inbox.wait',
    'delivery.ack',
    'message.send',
    'message.replyAndAck',
    'artifact.read'
  ]
  if (kind === 'coordination') {
    return [
      ...base,
      'responsibility.search',
      'responsibility.inspect',
      'responsibility.locate',
      'responsibility.collaborators',
      'role.implementations',
      'assignment.preview',
      'run.get',
      'run.close',
      'plan.prepare',
      'plan.commit',
      'team.assign',
      'team.retire',
      'task.dispatch',
      'worker.prepare',
      'worker.start',
      'worker.inspect',
      'worker.stop',
      'worker.resume',
      'worker.release',
      'execution.wake',
      'outcome.decide',
      'model.impact.list'
    ]
  }
  return [
    ...base,
    'execution.join',
    'execution.heartbeat',
    'task.accept',
    'task.report',
    'artifact.publish'
  ]
}

/* ------------------------------------------------------------------ */
/* selectionToken + provisioning re-checks (shared with preview)        */
/* ------------------------------------------------------------------ */

export function decodeAndCheckToken(
  verify: VerifySelectionToken | undefined,
  token: string,
  run: { id: string; projectId: string; modelVersion: unknown },
  op: string
): SelectionTokenPins {
  if (!verify) {
    // fail closed — no substitute verification path is invented (IMP-06 dep)
    fail(
      'CONTROL_UNAVAILABLE',
      `${op}: selectionToken verifier not wired (IMP-06 handoff missing)`,
      'reconcile'
    )
  }
  const pins = verify(token)
  if (!pins) {
    fail('STALE_REVISION', `${op}: selectionToken failed integrity verification`, 'replan')
  }
  const p = pins as SelectionTokenPins
  if (p.projectId !== undefined && p.projectId !== (run.projectId as string)) {
    fail(
      'STALE_REVISION',
      `${op}: token project ${p.projectId} ≠ run project ${run.projectId}`,
      'replan'
    )
  }
  if (p.modelVersion !== (run.modelVersion as string)) {
    // 검색→preview→assign은 동일 model version에서만 진행된다
    fail(
      'STALE_REVISION',
      `${op}: token model ${p.modelVersion} ≠ run model ${run.modelVersion}`,
      'replan'
    )
  }
  return p
}

export interface ImplementationCheck {
  implementationId: string
  implementationRevision: number
  interfaceDigest: string
  profileId: string
  profileRevision: number
  profileVerified: boolean
}

/** current implementation row must exist, be live, and serve the token's role */
export function recheckImplementation(
  db: DatabaseSync,
  pins: SelectionTokenPins,
  implementationRevision: number,
  run: { modelVersion: unknown },
  op: string
): ImplementationCheck {
  const implRow = one(
    db,
    'SELECT * FROM role_implementations WHERE id=? AND revision=?',
    pins.implementationId,
    implementationRevision
  )
  if (!implRow) {
    fail(
      'IMPLEMENTATION_MISSING',
      `${op}: implementation ${pins.implementationId}@${implementationRevision} does not exist`,
      'replan'
    )
  }
  const impl = toRoleImplementation(implRow!)
  const iface = toRoleInterface(
    one(db, 'SELECT * FROM role_interfaces WHERE digest=?', impl.interfaceDigest as string)!
  )
  if (
    !iface ||
    (iface.roleId as string) !== (pins.roleId as string) ||
    (iface.modelVersion as string) !== (run.modelVersion as string)
  ) {
    fail(
      'INTERFACE_STALE',
      `${op}: implementation ${pins.implementationId} does not serve role ${pins.roleId} at model ${run.modelVersion}`,
      'replan'
    )
  }
  const status = (impl.status as string) ?? ''
  if (status === 'retired' || status === 'withdrawn' || status === 'disabled') {
    fail(
      'IMPLEMENTATION_MISSING',
      `${op}: implementation ${pins.implementationId}@${implementationRevision} is ${status}`,
      'replan'
    )
  }
  if (pins.implementationCandidateDigest !== undefined) {
    const currentDigest = sha256Hex(
      canonicalJson({
        id: impl.id,
        revision: impl.revision,
        interfaceDigest: impl.interfaceDigest,
        profileId: impl.profileId,
        profileRevision: impl.profileRevision,
        status: impl.status
      })
    )
    // the token pins the candidate digest seen at search time; a changed
    // implementation invalidates the selection (검색→배정 동일 version)
    if (
      pins.implementationCandidateDigest !== currentDigest &&
      pins.implementationCandidateDigest !==
        sha256Hex(canonicalJson({ id: impl.id, revision: impl.revision }))
    ) {
      fail('STALE_REVISION', `${op}: implementation candidate digest moved since search`, 'replan')
    }
  }
  const att = one(
    db,
    "SELECT decision FROM support_attestations WHERE profile_id=? AND profile_revision=? AND decision='admitted'",
    impl.profileId as string,
    impl.profileRevision as number
  )
  const prof = one(
    db,
    'SELECT state FROM harness_profiles WHERE id=? AND revision=?',
    impl.profileId as string,
    impl.profileRevision as number
  )
  const profState = (prof?.state as string) ?? ''
  const profileVerified =
    att !== null || profState === 'verified' || profState === 'admitted' || profState === 'active'
  return {
    implementationId: impl.id as string,
    implementationRevision: impl.revision as number,
    interfaceDigest: impl.interfaceDigest as string,
    profileId: impl.profileId as string,
    profileRevision: impl.profileRevision as number,
    profileVerified
  }
}

/* provisioning grant scope_json shape (D-ACCESS §1 ProvisioningGrant).
   IMP-10 owns the authoritative JSON — fields follow the domain spec. */
export interface ProvisioningScope {
  allowedRoleIds?: string[]
  placementScope?: { hostIds?: string[]; labels?: string[]; checkoutIds?: string[] }
  maxMembers?: number
  allowedPolicyRevision?: { policyId?: string; id?: string; revision?: number } | string
  profileAdmission?: 'verified-only' | 'documented-in-verification-run'
  [k: string]: unknown
}

export interface ProvisioningCheck {
  coveringGrant: Grant | null
  missing: string[]
  ceilingActions: string[] | null
  policyPin: { policyId?: string; policyRevision?: number }
}

export function checkProvisioning(
  db: DatabaseSync,
  ctx: TxnContext['ctx'],
  run: { id: string; purpose: string },
  roleId: string,
  placementIntent: Record<string, unknown> | undefined,
  kind: AssignmentKind,
  impl: ImplementationCheck | null,
  at: number
): ProvisioningCheck {
  const grants = callerGrantsOfKind(db, ctx, 'provisioning', at)
  const missing: string[] = []
  let covering: Grant | null = null
  let coveringScope: ProvisioningScope | null = null

  for (const g of grants) {
    const scope = (g.scope ?? {}) as ProvisioningScope
    const allowed = scope.allowedRoleIds
    if (Array.isArray(allowed) && !allowed.includes(roleId)) continue
    if (scope.maxMembers !== undefined) {
      const used = one(
        db,
        'SELECT COUNT(*) AS n FROM grants WHERE parent_grant_id=?',
        g.id as string
      )
      if (((used?.n as number) ?? 0) >= scope.maxMembers) continue
    }
    if (scope.placementScope && placementIntent) {
      const ps = scope.placementScope
      const host = placementIntent.hostId as string | undefined
      if (host && Array.isArray(ps.hostIds) && !ps.hostIds.includes(host)) continue
      const checkout = placementIntent.checkoutId as string | undefined
      if (checkout && Array.isArray(ps.checkoutIds) && !ps.checkoutIds.includes(checkout)) continue
    }
    covering = g
    coveringScope = scope
    break
  }

  if (!covering) {
    missing.push(`no live provisioning grant covers role ${roleId} for this placement`)
    return { coveringGrant: null, missing, ceilingActions: null, policyPin: {} }
  }
  const scope = coveringScope!

  // profile admission: purpose=work needs verified profiles; a
  // 'documented-in-verification-run' grant only works in verification runs
  if (impl) {
    const admission = scope.profileAdmission ?? 'verified-only'
    if (admission === 'documented-in-verification-run' && run.purpose !== 'verification') {
      missing.push(`provisioning grant ${covering.id} is limited to verification runs`)
    }
    if (admission !== 'documented-in-verification-run' && !impl.profileVerified) {
      missing.push(`profile ${impl.profileId}@${impl.profileRevision} is not verified/admitted`)
    }
  }

  // role policy ceiling → effective grant actions = required ∩ ceiling
  let ceilingActions: string[] | null = null
  const policyPin: { policyId?: string; policyRevision?: number } = {}
  const pin = scope.allowedPolicyRevision
  if (pin !== undefined) {
    const pid = typeof pin === 'string' ? pin : (pin.policyId ?? pin.id)
    const prev = typeof pin === 'string' ? undefined : pin.revision
    if (pid) {
      const pol =
        prev !== undefined
          ? one(db, 'SELECT * FROM role_policies WHERE id=? AND revision=?', pid, prev)
          : one(db, 'SELECT * FROM role_policies WHERE id=? ORDER BY revision DESC LIMIT 1', pid)
      if (!pol) {
        missing.push(`allowedPolicyRevision ${pid}@${prev ?? 'latest'} not found`)
      } else {
        ceilingActions = parseJson<string[]>(
          pol.action_ceiling_json,
          `role_policies(${pid}).action_ceiling_json`
        )
        policyPin.policyId = pid
        policyPin.policyRevision = pol.revision as number
      }
    }
  }

  const required = requiredActionsFor(kind)
  if (ceilingActions !== null) {
    const ceil = new Set(ceilingActions)
    for (const a of required) {
      if (!ceil.has(a)) missing.push(`required action '${a}' exceeds role policy ceiling`)
    }
  }
  void kind
  return { coveringGrant: covering, missing, ceilingActions, policyPin }
}

/* ------------------------------------------------------------------ */
/* team.assign                                                         */
/* ------------------------------------------------------------------ */

export function teamAssign(
  txn: TxnContext,
  payload: unknown,
  deps: { verifySelectionToken?: VerifySelectionToken }
): TeamAssignResult {
  const op = 'team.assign'
  const p = asObject(payload, op)
  const input: TeamAssignInput = {
    runId: reqStr(p, 'runId', op),
    selectionToken: reqStr(p, 'selectionToken', op),
    implementationRevision: optInt(p, 'implementationRevision', op) ?? -1,
    assignmentKind: reqStr(p, 'assignmentKind', op) as AssignmentKind,
    mandateText: reqStr(p, 'mandateText', op),
    taskId: optStr(p, 'taskId', op),
    taskRevision: optInt(p, 'taskRevision', op),
    placementIntent: optObj(p, 'placementIntent', op),
    expectedPlanRevision: optInt(p, 'expectedPlanRevision', op)
  }
  if (input.assignmentKind !== 'coordination' && input.assignmentKind !== 'task') {
    badInput(`${op}: assignmentKind must be coordination|task`)
  }
  if (input.implementationRevision < 1) badInput(`${op}: implementationRevision must be ≥1`)
  if (input.assignmentKind === 'coordination' && input.taskId !== undefined) {
    badInput(`${op}: a coordination assignment takes no Task (D-WORK §2)`)
  }
  if (input.taskId !== undefined && input.taskRevision === undefined) {
    badInput(`${op}: taskRevision required with taskId`)
  }

  const at = nowMs()
  recheckCallerGrants(txn.db, txn.ctx, at)
  const runRow = loadRun(txn.db, input.runId)
  authorize(txn.ctx, op, [{ kind: 'run', id: input.runId }])
  requireOpenRun(runRow, op)

  const expected = input.expectedPlanRevision ?? 0
  const current = runRow.currentPlanRevision ?? 0
  if (expected !== current) {
    fail(
      'STALE_REVISION',
      `${op}: expected plan ${expected} but current is ${current}`,
      'same-operation'
    )
  }

  // 1) token pins + current model/implementation re-check
  const pins = decodeAndCheckToken(deps.verifySelectionToken, input.selectionToken, runRow, op)
  const impl = recheckImplementation(txn.db, pins, input.implementationRevision, runRow, op)
  const roleRow = one(
    txn.db,
    'SELECT * FROM rdd_roles WHERE model_version=? AND id=?',
    runRow.modelVersion as string,
    pins.roleId
  )
  if (!roleRow)
    fail('MODEL_INVALID', `${op}: role ${pins.roleId} not in run model ${runRow.modelVersion}`)
  const role = toRole(roleRow!)

  // 2) provisioning grant re-check (role allowlist, placement, maxMembers,
  //    policy ceiling, profile admission) — the token is never authority
  const prov = checkProvisioning(
    txn.db,
    txn.ctx,
    { id: runRow.id, purpose: runRow.purpose },
    pins.roleId,
    input.placementIntent,
    input.assignmentKind,
    impl,
    at
  )
  if (prov.missing.length > 0 || !prov.coveringGrant) {
    fail('SCOPE_DENIED', `${op}: provisioning coverage failed`, 'replan', prov.missing)
  }

  // 3) task pin (kind='task'): in-plan at pinned revision + owner-role match
  if (input.taskId !== undefined) {
    const pt = one(
      txn.db,
      'SELECT task_revision FROM plan_tasks WHERE run_id=? AND plan_revision=? AND task_id=?',
      input.runId,
      current,
      input.taskId
    )
    if (!pt || (pt.task_revision as number) !== input.taskRevision) {
      fail(
        'STALE_REVISION',
        `${op}: task ${input.taskId}@${input.taskRevision} is not pinned in plan ${current}`,
        'same-operation'
      )
    }
    const spec = loadTaskSpec(txn.db, input.taskId, input.taskRevision!)
    if (spec && (spec.ownerRoleId as string) !== (pins.roleId as string)) {
      fail(
        'SCOPE_DENIED',
        `${op}: task ${input.taskId} is owned by role ${spec.ownerRoleId}, not ${pins.roleId}`,
        'replan'
      )
    }
  }

  // 4) single coordination owner per run
  if (input.assignmentKind === 'coordination' && runRow.coordinatorMemberId !== undefined) {
    fail(
      'INVALID_TRANSITION',
      `${op}: run ${input.runId} already has coordinator member ${runRow.coordinatorMemberId}`,
      'replan'
    )
  }

  const memberId = newId('mem')
  const assignmentId = newId('asg')
  const required = requiredActionsFor(input.assignmentKind)
  const grantedActions =
    prov.ceilingActions !== null
      ? required.filter((a) => prov.ceilingActions!.includes(a))
      : required

  // member principal (member IS its own principal — server-constructed,
  // never payload-chosen)
  exec(txn.db, "INSERT INTO principals(id,kind,status) VALUES(?,'member','active')", memberId)

  const scope = {
    runId: input.runId,
    roleId: pins.roleId,
    boundaryId: role.boundaryId,
    taskIds: input.taskId ? [input.taskId] : [],
    placement: input.placementIntent ?? {},
    parentProvisioningGrant: prov.coveringGrant!.id
  }
  const grant = issueGrant(txn.db, {
    kind: 'assignment',
    principalId: memberId,
    parentGrantId: prov.coveringGrant!.id,
    policyId: prov.policyPin.policyId,
    policyRevision: prov.policyPin.policyRevision,
    scope,
    actions: grantedActions
  } as Parameters<typeof issueGrant>[1])
  const grantId = ((grant as Grant).id ?? (grant as { grantId?: string }).grantId) as Id

  exec(
    txn.db,
    "INSERT INTO members(id,run_id,model_version,role_id,implementation_id,implementation_revision,generation,current_execution_id,state,revision) VALUES(?,?,?,?,?,?,1,NULL,'assigned',1)",
    memberId,
    input.runId,
    runRow.modelVersion as string,
    pins.roleId,
    pins.implementationId,
    input.implementationRevision
  )
  exec(
    txn.db,
    'INSERT INTO assignments(id,revision,member_id,kind,mandate_text,grant_id,task_id,task_revision,scope_json) VALUES(?,1,?,?,?,?,?,?,?)',
    assignmentId,
    memberId,
    input.assignmentKind,
    input.mandateText,
    grantId,
    input.taskId ?? null,
    input.taskRevision ?? null,
    canonicalJson(scope)
  )
  if (input.assignmentKind === 'coordination') {
    exec(txn.db, 'UPDATE members SET state=? WHERE id=?', 'assigned', memberId)
    exec(
      txn.db,
      'UPDATE runs SET coordinator_member_id=?, revision=revision+1 WHERE id=?',
      memberId,
      input.runId
    )
  }

  activateRunIfDraft(txn.db, runRow)
  appendDomainEvent(
    txn.db,
    input.runId,
    runRow.revision + 1,
    'member.assigned',
    { runId: input.runId },
    {
      memberId,
      assignmentId,
      kind: input.assignmentKind,
      roleId: pins.roleId,
      taskId: input.taskId
    }
  )

  return {
    memberId,
    assignmentId,
    state: 'assigned',
    effectiveGrantBinding: {
      grantId,
      actions: grantedActions,
      policyId: prov.policyPin.policyId,
      policyRevision: prov.policyPin.policyRevision
    }
  }
}

/* ------------------------------------------------------------------ */
/* team.retire                                                         */
/* ------------------------------------------------------------------ */

export function teamRetire(txn: TxnContext, payload: unknown): TeamRetireResult {
  const op = 'team.retire'
  const p = asObject(payload, op)
  const input: TeamRetireInput = {
    memberId: reqStr(p, 'memberId', op),
    expectedRevision: optInt(p, 'expectedRevision', op) ?? -1,
    pendingDeliveryDisposition: reqStr(p, 'pendingDeliveryDisposition', op) as 'fence' | 'keep',
    activeExecutionDisposition: reqStr(p, 'activeExecutionDisposition', op) as
      'keep' | 'request-stop' | 'revoke-dispatch'
  }
  if (input.pendingDeliveryDisposition !== 'fence' && input.pendingDeliveryDisposition !== 'keep') {
    badInput(`${op}: pendingDeliveryDisposition must be fence|keep`)
  }
  if (!['keep', 'request-stop', 'revoke-dispatch'].includes(input.activeExecutionDisposition)) {
    badInput(`${op}: activeExecutionDisposition must be keep|request-stop|revoke-dispatch`)
  }

  const at = nowMs()
  recheckCallerGrants(txn.db, txn.ctx, at)
  const member = loadMember(txn.db, input.memberId)
  authorize(txn.ctx, op, [
    { kind: 'member', id: input.memberId },
    { kind: 'run', id: member.runId as string }
  ])

  if (member.state === 'retired') {
    fail('INVALID_TRANSITION', `${op}: member ${input.memberId} is already retired`, 'replan')
  }
  if (input.expectedRevision !== (member.revision as number)) {
    fail(
      'STALE_REVISION',
      `${op}: expected member revision ${input.expectedRevision}, current ${member.revision}`,
      'same-operation'
    )
  }

  // mailbox fencing — generation bump invalidates the consumer epoch and
  // outstanding deliveries are explicitly fenced when so disposed
  const outstanding = all(
    txn.db,
    "SELECT * FROM deliveries WHERE recipient_member_id=? AND status='outstanding'",
    input.memberId
  )
  const fenced: string[] = []
  if (input.pendingDeliveryDisposition === 'fence') {
    for (const d of outstanding) {
      exec(
        txn.db,
        "UPDATE deliveries SET status='fenced', revision=revision+1 WHERE id=?",
        d.id as string
      )
      fenced.push(d.id as string)
    }
  }

  const liveExecs = all(
    txn.db,
    "SELECT * FROM executions WHERE member_id=? AND liveness<>'exited'",
    input.memberId
  )
  const effectIntentIds: string[] = []
  if (input.activeExecutionDisposition === 'revoke-dispatch') {
    for (const e of liveExecs) {
      const ad = activeDispatchForExecution(txn.db, e.id as string)
      if (ad) {
        exec(
          txn.db,
          "UPDATE dispatches SET authority_state='revoked', revision=revision+1 WHERE id=?",
          ad.id as string
        )
        appendDomainEvent(
          txn.db,
          ad.id as string,
          0,
          'dispatch.revoked',
          { runId: member.runId },
          { by: op }
        )
      }
    }
  }
  if (input.activeExecutionDisposition === 'request-stop') {
    for (const e of liveExecs) {
      const intentId = newId('eff')
      exec(
        txn.db,
        "INSERT INTO effect_intents(id,operation_key,kind,fingerprint,host_id,state,payload_json,receipt_json,residuals_json) VALUES(?,?,'worker.stop',?,?,'prepared',?,'{}','{}')",
        intentId,
        `${op}:${input.memberId}:${e.id}`,
        e.host_id as string | null,
        canonicalJson({
          executionId: e.id,
          generation: e.generation,
          reason: 'team.retire disposition'
        })
      )
      effectIntentIds.push(intentId)
    }
  }

  exec(
    txn.db,
    "UPDATE members SET state='retired', generation=generation+1, revision=revision+1 WHERE id=?",
    input.memberId
  )
  appendDomainEvent(
    txn.db,
    input.memberId,
    (member.revision as number) + 1,
    'member.retired',
    { runId: member.runId },
    {
      memberId: input.memberId,
      fencedDeliveries: fenced.length,
      keptDeliveries: input.pendingDeliveryDisposition === 'keep' ? outstanding.length : 0,
      executionDisposition: input.activeExecutionDisposition,
      effectIntentIds
    }
  )

  const retired = toMember(one(txn.db, 'SELECT * FROM members WHERE id=?', input.memberId)!)
  return {
    member: retired,
    fencedDeliveries: fenced,
    residualExecutions: liveExecs.map((e) => e.id as string),
    effectIntentIds
  }
}

/* ------------------------------------------------------------------ */
/* task.dispatch — pin the next Task onto a joined execution            */
/* ------------------------------------------------------------------ */

export function taskDispatch(txn: TxnContext, payload: unknown): TaskDispatchResult {
  const op = 'task.dispatch'
  const p = asObject(payload, op)
  const input: TaskDispatchInput = {
    taskId: reqStr(p, 'taskId', op),
    taskRevision: optInt(p, 'taskRevision', op) ?? -1,
    memberId: reqStr(p, 'memberId', op),
    expectedExecutionId: reqStr(p, 'expectedExecutionId', op),
    expectedExecutionGeneration: optInt(p, 'expectedExecutionGeneration', op) ?? -1,
    expectedPlanRevision: optInt(p, 'expectedPlanRevision', op) ?? -1,
    inputBindings:
      optObj(p, 'unused', op) === undefined
        ? (p.inputBindings as TaskDispatchInput['inputBindings'])
        : undefined
  }
  if (
    input.taskRevision < 1 ||
    input.expectedExecutionGeneration < 0 ||
    input.expectedPlanRevision < 0
  ) {
    badInput(
      `${op}: taskRevision, expectedExecutionGeneration and expectedPlanRevision are required integers`
    )
  }

  const at = nowMs()
  recheckCallerGrants(txn.db, txn.ctx, at)
  const member = loadMember(txn.db, input.memberId)
  const task = loadTask(txn.db, input.taskId)
  if ((task.runId as string) !== (member.runId as string)) {
    fail(
      'SCOPE_DENIED',
      `${op}: task ${input.taskId} and member ${input.memberId} are in different runs`
    )
  }
  const runRow = loadRun(txn.db, member.runId as string)
  authorize(txn.ctx, op, [
    { kind: 'run', id: runRow.id as string },
    { kind: 'task', id: input.taskId },
    { kind: 'member', id: input.memberId }
  ])
  requireOpenRun(runRow, op)

  const current = runRow.currentPlanRevision ?? 0
  if (input.expectedPlanRevision !== current) {
    fail(
      'STALE_REVISION',
      `${op}: expected plan ${input.expectedPlanRevision}, current ${current}`,
      'same-operation'
    )
  }
  const pt = one(
    txn.db,
    'SELECT task_revision FROM plan_tasks WHERE run_id=? AND plan_revision=? AND task_id=?',
    runRow.id as string,
    current,
    input.taskId
  )
  if (!pt || (pt.task_revision as number) !== input.taskRevision) {
    fail(
      'STALE_REVISION',
      `${op}: task ${input.taskId}@${input.taskRevision} is not pinned in plan ${current}`,
      'same-operation'
    )
  }
  const spec = loadTaskSpec(txn.db, input.taskId, input.taskRevision)
  if (!spec)
    fail('STALE_REVISION', `${op}: task spec ${input.taskId}@${input.taskRevision} missing`)

  // same role/interface/bundle — a different role needs a fresh execution
  if ((spec!.ownerRoleId as string) !== (member.roleId as string)) {
    fail(
      'INVALID_TRANSITION',
      `${op}: task owner role ${spec!.ownerRoleId} ≠ member role ${member.roleId} — fresh worker.prepare/start required`,
      'replan'
    )
  }
  if (member.state === 'retired') {
    fail('INVALID_TRANSITION', `${op}: member ${input.memberId} is retired`, 'replan')
  }
  if ((member.currentExecutionId as string | undefined) !== input.expectedExecutionId) {
    fail(
      'STALE_EXECUTION',
      `${op}: member current execution is ${member.currentExecutionId ?? 'none'}, not ${input.expectedExecutionId}`,
      'reconcile'
    )
  }

  const execRow = one(txn.db, 'SELECT * FROM executions WHERE id=?', input.expectedExecutionId)
  if (!execRow || (execRow.member_id as string) !== input.memberId) {
    fail(
      'STALE_EXECUTION',
      `${op}: execution ${input.expectedExecutionId} is not bound to member ${input.memberId}`,
      'reconcile'
    )
  }
  const execution = toExecutionRecord(execRow!)
  if ((execution.generation as number) !== input.expectedExecutionGeneration) {
    fail(
      'STALE_EXECUTION',
      `${op}: execution generation moved (expected ${input.expectedExecutionGeneration}, current ${execution.generation})`,
      'reconcile'
    )
  }
  if ((execution.liveness as string) !== 'live') {
    fail(
      'STALE_EXECUTION',
      `${op}: execution ${input.expectedExecutionId} liveness is ${execution.liveness} — unverifiable executions need fresh worker.prepare/start`,
      'reconcile'
    )
  }

  // joined & same implementation/bundle as the member's pin
  const joinRow = one(
    txn.db,
    'SELECT * FROM worker_joins WHERE execution_id=? AND generation=?',
    input.expectedExecutionId,
    input.expectedExecutionGeneration
  )
  if (!joinRow) {
    fail(
      'STALE_EXECUTION',
      `${op}: execution ${input.expectedExecutionId}@${input.expectedExecutionGeneration} has no worker join`,
      'reconcile'
    )
  }
  const join = toWorkerJoin(joinRow!)
  const bundle = one(
    txn.db,
    'SELECT implementation_id, implementation_revision FROM context_bundles WHERE digest=?',
    join.bundleDigest as string
  )
  if (
    bundle &&
    ((bundle.implementation_id as string) !== (member.implementationId as string) ||
      (bundle.implementation_revision as number) !== (member.implementationRevision as number))
  ) {
    fail(
      'STALE_EXECUTION',
      `${op}: execution bundle implementation ${bundle.implementation_id}@${bundle.implementation_revision} ≠ member pin ${member.implementationId}@${member.implementationRevision}`,
      'reconcile'
    )
  }

  // one authoritative attempt per task and per execution
  if (activeDispatchForTask(txn.db, input.taskId)) {
    fail(
      'INVALID_TRANSITION',
      `${op}: task ${input.taskId} already has an active dispatch`,
      'replan'
    )
  }
  if (activeDispatchForExecution(txn.db, input.expectedExecutionId)) {
    fail(
      'INVALID_TRANSITION',
      `${op}: execution ${input.expectedExecutionId} already carries an active dispatch`,
      'replan'
    )
  }

  // member's assignment grant must still be live
  const asgRow = one(
    txn.db,
    'SELECT * FROM assignments WHERE member_id=? ORDER BY revision DESC LIMIT 1',
    input.memberId
  )
  if (!asgRow) fail('SCOPE_DENIED', `${op}: member ${input.memberId} has no assignment`)
  const asg = toAssignment(asgRow!)
  const grant = one(txn.db, 'SELECT * FROM grants WHERE id=?', asg.grantId as string)
  if (
    !grant ||
    grant.revoked_at !== null ||
    (grant.expires_at !== null && (grant.expires_at as number) <= at)
  ) {
    fail('GRANT_REVOKED', `${op}: member assignment grant ${asg.grantId} is not live`, 'replan')
  }

  // input bindings: resolved NOW to immutable artifact pins
  const specInputs = (spec!.inputs as InputBinding[] | null | undefined) ?? []
  const { resolved, pending } = resolveInputBindings(
    txn.db,
    runRow.id as string,
    runRow.modelVersion as string,
    specInputs
  )
  const pinsBySlot = new Map<string, ResolvedInput>()
  for (const r of resolved) pinsBySlot.set(r.slot, r)
  if (input.inputBindings) {
    for (const b of input.inputBindings) {
      if (b.artifactId !== undefined) {
        const art = one(
          txn.db,
          'SELECT id, revision, digest FROM artifacts WHERE id=? AND revision=?',
          b.artifactId,
          b.artifactRevision ?? -1
        )
        if (!art)
          fail(
            'ARTIFACT_MISMATCH',
            `${op}: supplied binding ${b.artifactId}@${b.artifactRevision} not found`
          )
        if (b.digest !== undefined && (art!.digest as string) !== b.digest) {
          fail('ARTIFACT_MISMATCH', `${op}: supplied binding digest mismatch for ${b.artifactId}`)
        }
        pinsBySlot.set(b.slot, {
          slot: b.slot,
          kind: 'artifact',
          artifact: {
            artifactId: art!.id as Id,
            revision: art!.revision as ArtifactRef['revision'],
            digest: art!.digest as string
          }
        })
      }
    }
  }
  const specSlots = new Set(specInputs.map((b) => b.slot))
  for (const s of pinsBySlot.keys()) {
    if (!specSlots.has(s)) pinsBySlot.delete(s)
  }
  const stillPending = pending.filter((pi) => !pinsBySlot.has(pi.slot))
  const requiredPending = stillPending.filter((pi) => {
    const b = specInputs.find((x) => x.slot === pi.slot)
    return (b?.required ?? true) === true
  })
  if (requiredPending.length > 0) {
    fail('INPUT_NOT_READY', `${op}: required inputs unresolved`, 'same-operation', requiredPending)
  }

  const assignmentId = asg.id as Id
  const assignmentRevision = asg.revision as number

  // WorkEnvelope — immutable work-order body pinned by digest
  const envelopeBody = {
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    memberId: input.memberId,
    runId: runRow.id,
    title: spec!.title,
    requirementText: spec!.requirementText,
    mandateText: asg.mandateText,
    inputs: [...pinsBySlot.values()],
    issuedAt: at
  }
  const bodyRef = putContentBlob(
    txn.db,
    new TextEncoder().encode(canonicalJson(envelopeBody)),
    'application/json'
  )
  const bindings = {
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    inputs: [...pinsBySlot.values()],
    assignmentId,
    assignmentRevision,
    executionId: input.expectedExecutionId,
    executionGeneration: input.expectedExecutionGeneration
  }
  const envelopeDigest = sha256Hex(
    canonicalJson({
      assignmentId,
      assignmentRevision,
      kind: 'task',
      bodyDigest: bodyRef.digest,
      bindings
    })
  )
  exec(
    txn.db,
    'INSERT INTO work_envelopes(digest,assignment_id,assignment_revision,kind,body_digest,bindings_json) VALUES(?,?,?,?,?,?)',
    envelopeDigest,
    assignmentId,
    assignmentRevision,
    'task',
    bodyRef.digest,
    canonicalJson(bindings)
  )

  const dispatchId = newId('dsp')
  const messageId = newId('msg')
  const deliveryId = newId('dlv')

  exec(
    txn.db,
    'INSERT INTO messages(id,run_id,sender_principal_id,sender_member_id,kind,body,links_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
    messageId,
    runRow.id as string,
    txn.ctx.principalId as string,
    (txn.ctx.memberId as string | null) ?? null,
    'assignment',
    `task ${spec!.title} (dispatch ${dispatchId})`,
    canonicalJson({
      dispatchId,
      taskId: input.taskId,
      taskRevision: input.taskRevision,
      envelopeDigest
    }),
    at
  )
  exec(
    txn.db,
    "INSERT INTO deliveries(id,message_id,recipient_member_id,consumer_generation,status,revision,acked_at,handling_json) VALUES(?,?,?,?,'outstanding',1,NULL,?)",
    deliveryId,
    messageId,
    input.memberId,
    member.generation as number,
    canonicalJson({
      kind: 'assignment',
      dispatchId,
      envelopeDigest,
      taskId: input.taskId,
      taskRevision: input.taskRevision
    })
  )
  exec(
    txn.db,
    "INSERT INTO dispatches(id,task_id,task_revision,member_id,execution_id,generation,envelope_digest,phase,authority_state,assignment_delivery_id,revision) VALUES(?,?,?,?,?,?,?,'awaiting_accept','active',?,1)",
    dispatchId,
    input.taskId,
    input.taskRevision,
    input.memberId,
    input.expectedExecutionId,
    input.expectedExecutionGeneration,
    envelopeDigest,
    deliveryId
  )
  exec(txn.db, 'UPDATE tasks SET current_dispatch_id=? WHERE id=?', dispatchId, input.taskId)

  appendDomainEvent(
    txn.db,
    input.taskId,
    input.taskRevision,
    'dispatch.created',
    { runId: runRow.id },
    {
      dispatchId,
      taskId: input.taskId,
      taskRevision: input.taskRevision,
      memberId: input.memberId,
      executionId: input.expectedExecutionId,
      generation: input.expectedExecutionGeneration,
      envelopeDigest,
      deliveryId
    }
  )

  // NOTE: enqueue success is NOT task acceptance — the member reads the
  // envelope from its inbox and declares task.accept against this digest.
  return { dispatchId, envelopeDigest, messageId, deliveryId, accepted: false }
}
