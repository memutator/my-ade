// coordination/run.ts — run.create / run.get / run.close (C-WORK).
//
// A Run records the chosen ModelVersion, goal text and coordination
// mandate. It is NOT a scheduler (D-WORK §1, REQ-17): these operations
// create/inspect/settle the run aggregate only — no dispatching, no
// process effects. worker kill/GC on close happens only through explicit
// approved effect intents, never inline.

import type { DatabaseSync } from 'node:sqlite'
import { authorize } from '../access/authorize.ts'
import { appendDomainEvent } from '../storage/db.ts'
import type { TxnContext } from '../api/registry.ts'
import type { Id, PlanRevision, Revision } from '../../../mahas-contracts/src/common.ts'
import type { Run } from '../../../mahas-contracts/src/work.ts'
import type { RunDecision } from '../../../mahas-contracts/src/mail.ts'
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
  toRun,
  toMember,
  toAssignment,
  toDispatch,
  toTaskSpec,
  loadRun,
  recheckCallerGrants,
  digestOf
} from './internal.ts'
import { computeEligibility, type TaskEligibility } from './eligibility.ts'
import { loadPlanTasks, loadPlanEdges, planOf } from './plan.ts'

/* ------------------------------------------------------------------ */
/* payloads                                                            */
/* ------------------------------------------------------------------ */

export interface RunCreateInput {
  projectId: string
  modelVersion: string
  goalText: string
  coordinatorRoleId: string
  purpose: 'work' | 'verification'
}

export interface RunCreateResult {
  runId: Id
  revision: Revision
  coordinatorRoleId: string
}

export interface RunGetInput {
  runId: string
  projection: 'coordinator' | 'member'
}

export interface RunCloseInput {
  runId: string
  expectedPlanRevision: number
  decision: string
  compositionRationale: string
  resourceDisposition: {
    /** required when dispatches are still active: keep | revoke */
    activeDispatches?: string
    /** required when executions are still live: keep | request-stop */
    executions?: string
    /** required when deliveries outstanding: keep | fence */
    deliveries?: string
    /** required when resource claims held: keep | release-requested */
    claims?: string
    [k: string]: unknown
  }
}

export interface RunCloseResult {
  decision: RunDecision
  runRevision: Revision
  unresolved: {
    activeDispatches: string[]
    liveExecutions: string[]
    outstandingDeliveries: string[]
    heldClaims: string[]
    nonRetiredMembers: string[]
  }
  effectIntentIds: string[]
}

/* ------------------------------------------------------------------ */
/* run.create                                                          */
/* ------------------------------------------------------------------ */

export function runCreate(txn: TxnContext, payload: unknown): RunCreateResult {
  const op = 'run.create'
  const p = asObject(payload, op)
  const input: RunCreateInput = {
    projectId: reqStr(p, 'projectId', op),
    modelVersion: reqStr(p, 'modelVersion', op),
    goalText: reqStr(p, 'goalText', op),
    coordinatorRoleId: reqStr(p, 'coordinatorRoleId', op),
    purpose: (optStr(p, 'purpose', op) ?? 'work') as 'work' | 'verification'
  }
  if (input.purpose !== 'work' && input.purpose !== 'verification') {
    badInput(`${op}: purpose must be 'work' or 'verification'`)
  }

  const at = nowMs()
  recheckCallerGrants(txn.db, txn.ctx, at)
  authorize(txn.ctx, op, [{ kind: 'project', id: input.projectId }])

  // contract: 프로젝트 및 coordinator role 범위, 공개 model version
  const project = one(txn.db, 'SELECT id FROM projects WHERE id=?', input.projectId)
  if (!project) fail('MODEL_INVALID', `${op}: project ${input.projectId} does not exist`)

  const mv = one(
    txn.db,
    'SELECT id, project_id, status FROM model_versions WHERE id=?',
    input.modelVersion
  )
  if (!mv || (mv.project_id as string) !== input.projectId) {
    fail(
      'MODEL_INVALID',
      `${op}: modelVersion ${input.modelVersion} is not a version of project ${input.projectId}`
    )
  }
  if ((mv.status as string) !== 'published') {
    fail(
      'MODEL_INVALID',
      `${op}: modelVersion ${input.modelVersion} is ${mv.status} — only a published model authorizes runs`
    )
  }

  const role = one(
    txn.db,
    'SELECT id FROM rdd_roles WHERE model_version=? AND id=?',
    input.modelVersion,
    input.coordinatorRoleId
  )
  if (!role) {
    fail(
      'MODEL_INVALID',
      `${op}: coordinatorRoleId ${input.coordinatorRoleId} is not a role of model ${input.modelVersion}`
    )
  }

  const runId = newId('run')
  exec(
    txn.db,
    "INSERT INTO runs(id,project_id,model_version,goal_text,purpose,coordinator_member_id,state,current_plan_revision,revision) VALUES(?,?,?,?,?,NULL,'draft',NULL,1)",
    runId,
    input.projectId,
    input.modelVersion,
    input.goalText,
    input.purpose
  )
  appendDomainEvent(
    txn.db,
    runId,
    1,
    'run.created',
    { runId, projectId: input.projectId },
    {
      modelVersion: input.modelVersion,
      goalText: input.goalText,
      purpose: input.purpose,
      coordinatorRoleId: input.coordinatorRoleId
    }
  )
  // NOTE: runs DDL has no coordinator_role_id column — the declared role is
  // validated here, carried in the result + event, and pinned for real when
  // the coordination member is created by team.assign (see handoff).
  return { runId, revision: 1 as Revision, coordinatorRoleId: input.coordinatorRoleId }
}

/* ------------------------------------------------------------------ */
/* run.get                                                             */
/* ------------------------------------------------------------------ */

export function runGet(txn: TxnContext, payload: unknown): unknown {
  const op = 'run.get'
  const p = asObject(payload, op)
  const input: RunGetInput = {
    runId: reqStr(p, 'runId', op),
    projection: (optStr(p, 'projection', op) ?? 'member') as 'coordinator' | 'member'
  }
  if (input.projection !== 'coordinator' && input.projection !== 'member') {
    badInput(`${op}: projection must be 'coordinator' or 'member'`)
  }

  const run = loadRun(txn.db, input.runId)
  authorize(txn.ctx, op, [{ kind: 'run', id: input.runId }])

  if (input.projection === 'coordinator') {
    // a member credential may take the coordination view only for the run it coordinates
    if (txn.ctx.memberId !== undefined && txn.ctx.memberId !== run.coordinatorMemberId) {
      fail(
        'SCOPE_DENIED',
        `${op}: member ${txn.ctx.memberId} is not the coordinator of run ${input.runId}`
      )
    }
    return coordinatorView(txn.db, run)
  }
  return memberView(txn, run)
}

function coordinatorView(db: DatabaseSync, run: Run): unknown {
  const planRev = run.currentPlanRevision ?? null
  const plan = planRev !== null ? planOf(db, run.id as string, planRev) : null
  const members = all(db, 'SELECT * FROM members WHERE run_id=?', run.id as string).map(toMember)
  const assignments = all(
    db,
    'SELECT a.* FROM assignments a JOIN members m ON a.member_id=m.id WHERE m.run_id=? ORDER BY a.id,a.revision',
    run.id as string
  ).map(toAssignment)
  const eligibility = planRev !== null ? computeEligibility(db, run.id as string, planRev) : []
  return {
    run,
    plan,
    planTasks: planRev !== null ? loadPlanTasks(db, run.id as string, planRev) : [],
    planEdges: planRev !== null ? loadPlanEdges(db, run.id as string, planRev) : [],
    members,
    assignments,
    eligibility
    // full event history intentionally not shipped (C-WORK run.get)
  }
}

function memberView(txn: TxnContext, run: Run): unknown {
  const db = txn.db
  const memberId = txn.ctx.memberId
  if (memberId === undefined) {
    // operator without member identity asking for the member projection
    fail('SCOPE_DENIED', 'run.get: member projection requires a member credential')
  }
  const row = one(
    db,
    'SELECT * FROM members WHERE id=? AND run_id=?',
    memberId as string,
    run.id as string
  )
  if (!row)
    fail('SCOPE_DENIED', `run.get: member ${memberId} is not a participant of run ${run.id}`)
  const self = toMember(row)

  const selfAssignments = all(
    db,
    'SELECT * FROM assignments WHERE member_id=? ORDER BY revision',
    memberId as string
  ).map(toAssignment)

  // own work: tasks this member is named on or has a dispatch for
  const myDispatchRows = all(
    db,
    'SELECT * FROM dispatches WHERE member_id=? AND authority_state=?',
    memberId as string,
    'active'
  ).map(toDispatch)
  const myTaskIds = new Set<string>(myDispatchRows.map((d) => d.taskId as string))
  for (const a of selfAssignments) if (a.taskId) myTaskIds.add(a.taskId as string)
  const specRows = all(
    db,
    'SELECT s.* FROM task_specs s JOIN tasks t ON s.task_id=t.id AND s.revision=t.current_revision WHERE t.run_id=?',
    run.id as string
  ).map(toTaskSpec)
  const myTasks = specRows.filter(
    (s) => myTaskIds.has(s.taskId as string) || s.assignedMemberId === memberId
  )

  const peers = all(
    db,
    'SELECT id, role_id, state FROM members WHERE run_id=? AND id<>?',
    run.id as string,
    memberId as string
  ).map((r) => ({
    memberId: r.id as string,
    roleId: r.role_id as string,
    state: r.state as string
  }))

  const eligibility: TaskEligibility[] =
    run.currentPlanRevision !== undefined
      ? computeEligibility(db, run.id as string, run.currentPlanRevision)
      : []
  const myEligibility = eligibility.filter(
    (e) => myTaskIds.has(e.taskId as string) || e.assignedMemberId === memberId
  )

  return {
    run: {
      id: run.id,
      projectId: run.projectId,
      modelVersion: run.modelVersion,
      goalText: run.goalText,
      purpose: run.purpose,
      state: run.state,
      currentPlanRevision: run.currentPlanRevision
    },
    self,
    selfAssignments,
    myTasks,
    myDispatches: myDispatchRows,
    myEligibility,
    peers
  }
}

/* ------------------------------------------------------------------ */
/* run.close                                                           */
/* ------------------------------------------------------------------ */

export function runClose(txn: TxnContext, payload: unknown): RunCloseResult {
  const op = 'run.close'
  const p = asObject(payload, op)
  const input: RunCloseInput = {
    runId: reqStr(p, 'runId', op),
    expectedPlanRevision: optInt(p, 'expectedPlanRevision', op) ?? 0,
    decision: reqStr(p, 'decision', op),
    compositionRationale: reqStr(p, 'compositionRationale', op),
    resourceDisposition: optObj(p, 'resourceDisposition', op) ?? {}
  }

  const at = nowMs()
  recheckCallerGrants(txn.db, txn.ctx, at)
  const run0 = loadRun(txn.db, input.runId)
  authorize(txn.ctx, op, [{ kind: 'run', id: input.runId }])

  // composition judgement belongs to the Run's coordination owner (or operator)
  if (txn.ctx.memberId !== undefined && txn.ctx.memberId !== run0.coordinatorMemberId) {
    fail(
      'SCOPE_DENIED',
      `${op}: member ${txn.ctx.memberId} is not the coordination owner of run ${input.runId}`
    )
  }
  if (run0.state === 'settled' || run0.state === 'archived') {
    fail('INVALID_TRANSITION', `${op}: run ${input.runId} is already ${run0.state}`, 'replan')
  }

  // residuals the caller must dispose of explicitly
  const activeDispatches = all(
    txn.db,
    "SELECT d.id FROM dispatches d JOIN tasks t ON d.task_id=t.id WHERE t.run_id=? AND d.authority_state='active'",
    input.runId
  ).map((r) => r.id as string)
  const liveExecutions = all(
    txn.db,
    "SELECT e.id FROM executions e JOIN members m ON e.member_id=m.id WHERE m.run_id=? AND e.liveness<>'exited'",
    input.runId
  ).map((r) => r.id as string)
  const outstandingDeliveries = all(
    txn.db,
    "SELECT dv.id FROM deliveries dv JOIN members m ON dv.recipient_member_id=m.id WHERE m.run_id=? AND dv.status='outstanding'",
    input.runId
  ).map((r) => r.id as string)
  const heldClaims = all(
    txn.db,
    "SELECT c.id FROM resource_claims c JOIN members m ON c.owner_id=m.id WHERE m.run_id=? AND c.owner_kind='member' AND c.state IN ('held','transferring','unknown')",
    input.runId
  ).map((r) => r.id as string)
  const nonRetiredMembers = all(
    txn.db,
    "SELECT id FROM members WHERE run_id=? AND state<>'retired'",
    input.runId
  ).map((r) => r.id as string)

  const rd = input.resourceDisposition
  if (activeDispatches.length > 0 && rd.activeDispatches === undefined) {
    badInput(
      `${op}: ${activeDispatches.length} active dispatch(es) — resourceDisposition.activeDispatches required`
    )
  }
  if (liveExecutions.length > 0 && rd.executions === undefined) {
    badInput(
      `${op}: ${liveExecutions.length} live execution(s) — resourceDisposition.executions required`
    )
  }
  if (outstandingDeliveries.length > 0 && rd.deliveries === undefined) {
    badInput(
      `${op}: ${outstandingDeliveries.length} outstanding delivery(ies) — resourceDisposition.deliveries required`
    )
  }
  if (heldClaims.length > 0 && rd.claims === undefined) {
    badInput(`${op}: ${heldClaims.length} held claim(s) — resourceDisposition.claims required`)
  }

  const effectIntentIds: string[] = []

  // apply declared dispositions — effects are recorded intents only;
  // no worker is killed here (C-WORK run.close stored effect rule)
  if (rd.activeDispatches === 'revoke') {
    for (const dId of activeDispatches) {
      exec(
        txn.db,
        "UPDATE dispatches SET authority_state='revoked', revision=revision+1 WHERE id=?",
        dId
      )
      appendDomainEvent(txn.db, dId, 0, 'dispatch.revoked', { runId: input.runId }, { by: op })
    }
  }
  if (rd.deliveries === 'fence') {
    for (const dvId of outstandingDeliveries) {
      exec(txn.db, "UPDATE deliveries SET status='fenced', revision=revision+1 WHERE id=?", dvId)
    }
  }
  if (rd.executions === 'request-stop') {
    for (const eId of liveExecutions) {
      const intentId = newId('eff')
      exec(
        txn.db,
        "INSERT INTO effect_intents(id,operation_key,kind,fingerprint,host_id,state,payload_json,receipt_json,residuals_json) VALUES(?,?,'worker.stop',?,NULL,'prepared',?,'{}','{}')",
        intentId,
        `${op}:${input.runId}:${eId}`,
        digestOf({ op, runId: input.runId, executionId: eId }),
        JSON.stringify({ executionId: eId, reason: 'run.close disposition' })
      )
      effectIntentIds.push(intentId)
    }
  }
  if (rd.claims === 'release-requested') {
    for (const cId of heldClaims) {
      const intentId = newId('eff')
      exec(
        txn.db,
        "INSERT INTO effect_intents(id,operation_key,kind,fingerprint,host_id,state,payload_json,receipt_json,residuals_json) VALUES(?,?,'claim.release',?,NULL,'prepared',?,'{}','{}')",
        intentId,
        `${op}:${input.runId}:${cId}`,
        digestOf({ op, runId: input.runId, claimId: cId }),
        JSON.stringify({ claimId: cId, reason: 'run.close disposition' })
      )
      effectIntentIds.push(intentId)
    }
  }

  // run_decisions.plan_revision is NOT NULL + FK → a run closed before any
  // committed plan gets an explicit empty plan revision 1 first.
  let planRevision = run0.currentPlanRevision
  if (planRevision === undefined) {
    planRevision = 1 as PlanRevision
    const digest = digestOf({
      runId: input.runId,
      revision: 1,
      tasks: [],
      edges: [],
      dispositions: []
    })
    exec(
      txn.db,
      'INSERT INTO plans(run_id,revision,digest,dispositions_json) VALUES(?,?,?,?)',
      input.runId,
      1,
      digest,
      '[]'
    )
  }

  // CAS on the plan pointer
  const changed = exec(
    txn.db,
    "UPDATE runs SET state='settled', current_plan_revision=?, revision=revision+1 WHERE id=? AND COALESCE(current_plan_revision,0)=? AND state IN ('draft','active')",
    planRevision,
    input.runId,
    input.expectedPlanRevision
  )
  if (changed !== 1) {
    fail(
      'STALE_REVISION',
      `${op}: run ${input.runId} plan pointer moved (expected ${input.expectedPlanRevision})`,
      'same-operation'
    )
  }

  // run_decisions.coordinator_member_id → members(id): the decision must be
  // attributable to a Member — a coordinator-less run closed by a principal
  // with no member identity cannot be recorded honestly.
  const coordinator = run0.coordinatorMemberId ?? txn.ctx.memberId
  if (coordinator === undefined) {
    fail(
      'INVALID_TRANSITION',
      `${op}: run ${input.runId} has no coordinator member to attribute the RunDecision to`,
      'replan'
    )
  }
  const decisionId = newId('rdec')
  exec(
    txn.db,
    'INSERT INTO run_decisions(id,run_id,plan_revision,coordinator_member_id,decision,rationale) VALUES(?,?,?,?,?,?)',
    decisionId,
    input.runId,
    planRevision,
    coordinator as string,
    input.decision,
    input.compositionRationale
  )
  const decision: RunDecision = {
    id: decisionId,
    runId: input.runId as Id,
    planRevision: planRevision as RunDecision['planRevision'],
    coordinatorMemberId: coordinator,
    decision: input.decision,
    rationale: input.compositionRationale
  } as RunDecision

  // (unresolved lists are reported to the caller; residual cleanup is the
  // caller's explicit follow-up, never implicit GC)

  const closedRun = toRun(one(txn.db, 'SELECT * FROM runs WHERE id=?', input.runId)!)
  appendDomainEvent(
    txn.db,
    input.runId,
    closedRun.revision,
    'run.closed',
    { runId: input.runId },
    {
      decision: input.decision,
      planRevision,
      resourceDisposition: rd,
      effectIntentIds
    }
  )

  return {
    decision,
    runRevision: closedRun.revision,
    unresolved: {
      activeDispatches,
      liveExecutions,
      outstandingDeliveries,
      heldClaims,
      nonRetiredMembers
    },
    effectIntentIds
  }
}
