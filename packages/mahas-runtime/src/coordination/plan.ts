// coordination/plan.ts — plan.prepare / plan.commit (C-WORK META DAG).
//
// A PlanRevision is an immutable DAG of TaskSpec pins + TaskEdges.
// plan.prepare stores a candidate with diagnostics only; plan.commit CASes
// the run's active-plan pointer and publishes the revision atomically.
// Cycle, cross-run endpoint, and missing active-attempt disposition are
// rejected (instruction §4.4): they surface as structuralErrors at prepare
// and hard-refuse publication at commit.

import type { DatabaseSync } from 'node:sqlite'
import { authorize } from '../access/authorize.ts'
import { appendDomainEvent } from '../storage/db.ts'
import type { TxnContext } from '../api/registry.ts'
import type { Id, Revision } from '../../../mahas-contracts/src/common.ts'
import type {
  Plan,
  TaskSpec,
  TaskEdge,
  InputBinding,
  OutputSlot
} from '../../../mahas-contracts/src/work.ts'
import {
  asObject,
  reqStr,
  optStr,
  optInt,
  optArr,
  badInput,
  fail,
  newId,
  nowMs,
  one,
  all,
  run as exec,
  toPlan,
  toPlanCandidate,
  toTaskSpec,
  toTaskEdge,
  loadRun,
  recheckCallerGrants,
  requireOpenRun,
  activateRunIfDraft,
  digestOf,
  canonicalJson,
  parseJson
} from './internal.ts'
import {
  computeEligibility,
  resolveInputBindings,
  type TaskEligibility,
  type PendingInput
} from './eligibility.ts'

/* ------------------------------------------------------------------ */
/* payloads (C-WORK PlanPatch grammar)                                 */
/* ------------------------------------------------------------------ */

export interface TaskSpecPatch {
  taskId?: string
  title?: string
  requirementText?: string
  ownerRoleId?: string
  assignedMemberId?: string | null
  inputs?: InputBinding[]
  outputs?: OutputSlot[]
  settlementPolicy?: unknown
}

export interface EdgePatch {
  fromTask: string
  toTask: string
  requiredOutputs?: string[]
  settlementRequirement?: string
}

export interface AttemptDisposition {
  taskId: string
  dispatchId?: string
  /** keep = attempt continues under its pinned spec; revoke = revoked now;
      replace = revoked and the task is re-dispatchable under the new spec */
  action: 'keep' | 'revoke' | 'replace'
}

export interface PlanPatch {
  basePlanRevision?: number
  tasks?: TaskSpecPatch[]
  edges?: EdgePatch[]
  retireTaskIds?: string[]
  activeAttemptDisposition?: AttemptDisposition[]
}

export interface PlanPrepareInput {
  runId: string
  patch: PlanPatch
}

export interface PlanPrepareResult {
  candidatePlanId: Id
  digest: string
  structuralErrors: string[]
  unresolvedInputs: PendingInput[]
}

export interface PlanCommitInput {
  candidatePlanId: string
  digest: string
  expectedPlanRevision: number
}

export interface PlanCommitResult {
  runId: Id
  planRevision: Revision
  digest: string
  eligibility: TaskEligibility[]
}

/* ------------------------------------------------------------------ */
/* shared plan readers                                                 */
/* ------------------------------------------------------------------ */

export function planOf(db: DatabaseSync, runId: string, revision: number): Plan | null {
  const r = one(db, 'SELECT * FROM plans WHERE run_id=? AND revision=?', runId, revision)
  return r ? toPlan(r) : null
}

export function loadPlanTasks(db: DatabaseSync, runId: string, planRevision: number): TaskSpec[] {
  return all(
    db,
    'SELECT s.* FROM plan_tasks pt JOIN task_specs s ON s.task_id=pt.task_id AND s.revision=pt.task_revision WHERE pt.run_id=? AND pt.plan_revision=? ORDER BY pt.task_id',
    runId,
    planRevision
  ).map(toTaskSpec)
}

export function loadPlanEdges(db: DatabaseSync, runId: string, planRevision: number): TaskEdge[] {
  return all(
    db,
    'SELECT * FROM task_edges WHERE run_id=? AND plan_revision=? ORDER BY from_task,to_task',
    runId,
    planRevision
  ).map(toTaskEdge)
}

/* ------------------------------------------------------------------ */
/* patch validation + merge                                            */
/* ------------------------------------------------------------------ */

interface ResolvedTask {
  taskId: string
  revision: number
  isNew: boolean
  spec: {
    title: string
    requirementText: string
    ownerRoleId: string
    assignedMemberId: string | null
    inputs: unknown[]
    outputs: unknown[]
    settlementPolicy: unknown
  }
}

interface ResolvedPlan {
  baseRevision: number
  tasks: ResolvedTask[]
  edges: {
    fromTask: string
    toTask: string
    requiredOutputs: string[]
    settlementRequirement: string
  }[]
  retireTaskIds: string[]
  dispositions: AttemptDisposition[]
}

function validatePatch(raw: Record<string, unknown>, op: string): PlanPatch {
  const p = raw.patch !== undefined ? asObject(raw.patch, op) : raw
  const tasks = optArr(p, 'tasks', op).map((t): TaskSpecPatch => {
    const o = asObject(t, op)
    return {
      taskId: optStr(o, 'taskId', op),
      title: optStr(o, 'title', op),
      requirementText: optStr(o, 'requirementText', op),
      ownerRoleId: optStr(o, 'ownerRoleId', op),
      assignedMemberId: o.assignedMemberId === null ? null : optStr(o, 'assignedMemberId', op),
      inputs: o.inputs as InputBinding[] | undefined,
      outputs: o.outputs as OutputSlot[] | undefined,
      settlementPolicy: o.settlementPolicy
    }
  })
  const edges = optArr(p, 'edges', op).map((t): EdgePatch => {
    const o = asObject(t, op)
    const requiredOutputs = (o.requiredOutputs ?? o.requiredOutputNames) as string[] | undefined
    if (requiredOutputs !== undefined && !Array.isArray(requiredOutputs)) {
      badInput(`${op}: edge.requiredOutputs must be an array`)
    }
    return {
      fromTask: reqStr(o, 'fromTask', op),
      toTask: reqStr(o, 'toTask', op),
      requiredOutputs,
      settlementRequirement: optStr(o, 'settlementRequirement', op)
    }
  })
  const dispositions = optArr(p, 'activeAttemptDisposition', op).map((t): AttemptDisposition => {
    const o = asObject(t, op)
    const action = reqStr(o, 'action', op)
    if (action !== 'keep' && action !== 'revoke' && action !== 'replace') {
      badInput(`${op}: activeAttemptDisposition.action must be keep|revoke|replace`)
    }
    return { taskId: reqStr(o, 'taskId', op), dispatchId: optStr(o, 'dispatchId', op), action }
  })
  return {
    basePlanRevision: optInt(p, 'basePlanRevision', op),
    tasks,
    edges,
    retireTaskIds: optArr(p, 'retireTaskIds', op).map((t) => {
      if (typeof t !== 'string') badInput(`${op}: retireTaskIds entries must be strings`)
      return t as string
    }),
    activeAttemptDisposition: dispositions
  }
}

/**
 * Merges a PlanPatch onto the base plan revision and returns the resolved
 * (publishable) content plus structuralErrors. Pure read+compute — callers
 * decide whether the errors refuse commit.
 */
function resolvePatch(
  db: DatabaseSync,
  runId: string,
  modelVersion: string,
  currentPlanRevision: number | undefined,
  patch: PlanPatch
): { resolved: ResolvedPlan; structuralErrors: string[]; unresolvedInputs: PendingInput[] } {
  const errors: string[] = []
  const base = patch.basePlanRevision ?? currentPlanRevision ?? 0
  if (
    patch.basePlanRevision !== undefined &&
    currentPlanRevision !== undefined &&
    patch.basePlanRevision !== currentPlanRevision
  ) {
    errors.push(
      `base-not-current: patch bases on plan ${patch.basePlanRevision} but current is ${currentPlanRevision}`
    )
  }

  const surviving = new Map<string, number>() // taskId -> pinned revision in merged plan
  if (base > 0) {
    const baseTasks = all(
      db,
      'SELECT task_id, task_revision FROM plan_tasks WHERE run_id=? AND plan_revision=?',
      runId,
      base
    )
    if (baseTasks.length === 0 && planOf(db, runId, base) === null) {
      errors.push(`missing-base: plan revision ${base} does not exist for run ${runId}`)
    }
    for (const t of baseTasks) surviving.set(t.task_id as string, t.task_revision as number)
  }

  const retired = new Set(patch.retireTaskIds ?? [])
  for (const rt of retired) {
    if (!surviving.has(rt))
      errors.push(`retire-task-not-in-plan: ${rt} is not in base plan ${base}`)
    surviving.delete(rt)
  }

  // dispositions required for any task whose spec moves or is retired while
  // an active dispatch pins it (D-WORK §3 — attempts are never silently orphaned)
  const dispositionByTask = new Map<string, AttemptDisposition>()
  for (const d of patch.activeAttemptDisposition ?? []) dispositionByTask.set(d.taskId, d)
  const needsDisposition = (taskId: string): void => {
    const ad = one(
      db,
      "SELECT id FROM dispatches WHERE task_id=? AND authority_state='active'",
      taskId
    )
    if (ad && !dispositionByTask.has(taskId)) {
      errors.push(
        `missing-attempt-disposition: task ${taskId} has active dispatch ${ad.id} — activeAttemptDisposition required`
      )
    }
  }
  for (const rt of retired) needsDisposition(rt)

  const tasks: ResolvedTask[] = []
  const seenPatch = new Set<string>()

  for (const entry of patch.tasks ?? []) {
    const existing =
      entry.taskId !== undefined ? one(db, 'SELECT * FROM tasks WHERE id=?', entry.taskId) : null
    const taskId = entry.taskId ?? newId('tsk')
    if (seenPatch.has(taskId as string)) {
      errors.push(`duplicate-task: ${taskId} appears twice in patch.tasks`)
      continue
    }
    seenPatch.add(taskId as string)

    if (existing && (existing.run_id as string) !== runId) {
      errors.push(`cross-run-endpoint: task ${taskId} belongs to run ${existing.run_id}`)
      continue
    }

    const prior = existing
      ? toTaskSpec(
          one(
            db,
            'SELECT * FROM task_specs WHERE task_id=? AND revision=?',
            taskId as string,
            existing.current_revision as number
          )!
        )
      : null
    const ownerRoleId = entry.ownerRoleId ?? prior?.ownerRoleId
    const title = entry.title ?? prior?.title
    const requirementText = entry.requirementText ?? prior?.requirementText
    if (!ownerRoleId || !title || !requirementText) {
      errors.push(`incomplete-task-spec: ${taskId} needs title, requirementText and ownerRoleId`)
      continue
    }
    const role = one(
      db,
      'SELECT id FROM rdd_roles WHERE model_version=? AND id=?',
      modelVersion,
      ownerRoleId as string
    )
    if (!role)
      errors.push(`unknown-role: ownerRoleId ${ownerRoleId} is not a role of model ${modelVersion}`)

    const assignedMemberId =
      entry.assignedMemberId !== undefined
        ? entry.assignedMemberId
        : (prior?.assignedMemberId ?? null)
    if (assignedMemberId) {
      const m = one(db, 'SELECT id, run_id FROM members WHERE id=?', assignedMemberId as string)
      if (!m || (m.run_id as string) !== runId)
        errors.push(
          `unknown-member: assignedMemberId ${assignedMemberId} is not a member of run ${runId}`
        )
    }

    const revision = existing ? (existing.current_revision as number) + 1 : 1
    tasks.push({
      taskId: taskId as string,
      revision,
      isNew: !existing,
      spec: {
        title: title as string,
        requirementText: requirementText as string,
        ownerRoleId: ownerRoleId as string,
        assignedMemberId: (assignedMemberId ?? null) as string | null,
        inputs: (entry.inputs ?? prior?.inputs ?? []) as unknown[],
        outputs: (entry.outputs ?? prior?.outputs ?? []) as unknown[],
        settlementPolicy: entry.settlementPolicy ?? prior?.settlementPolicy ?? {}
      }
    })
    surviving.set(taskId as string, revision)
    if (existing) needsDisposition(taskId as string)
  }

  // merged edges: carried base edges (both endpoints survive) + patch edges
  const edges: ResolvedPlan['edges'] = []
  const edgeKey = (f: string, t: string): string => `${f}→${t}`
  const seenEdge = new Set<string>()
  if (base > 0) {
    for (const e of loadPlanEdges(db, runId, base)) {
      if (
        surviving.has(e.predecessorTaskId as string) &&
        surviving.has(e.successorTaskId as string)
      ) {
        edges.push({
          fromTask: e.predecessorTaskId as string,
          toTask: e.successorTaskId as string,
          requiredOutputs: [...(e.requiredOutputNames ?? [])],
          settlementRequirement: e.settlementRequirement ?? 'accepted'
        })
        seenEdge.add(edgeKey(e.predecessorTaskId as string, e.successorTaskId as string))
      }
    }
  }
  for (const e of patch.edges ?? []) {
    for (const endpoint of [e.fromTask, e.toTask]) {
      if (!surviving.has(endpoint)) {
        errors.push(`edge-endpoint-not-in-plan: ${endpoint} (edge ${e.fromTask}→${e.toTask})`)
      } else {
        const t = one(db, 'SELECT run_id FROM tasks WHERE id=?', endpoint)
        if (t && (t.run_id as string) !== runId) {
          errors.push(`cross-run-endpoint: task ${endpoint} belongs to run ${t.run_id}`)
        }
      }
    }
    if (e.fromTask === e.toTask) errors.push(`self-edge: ${e.fromTask}`)
    if (seenEdge.has(edgeKey(e.fromTask, e.toTask))) continue
    seenEdge.add(edgeKey(e.fromTask, e.toTask))
    edges.push({
      fromTask: e.fromTask,
      toTask: e.toTask,
      requiredOutputs: [...(e.requiredOutputs ?? [])],
      settlementRequirement: e.settlementRequirement ?? 'accepted'
    })
  }

  // cycle detection on the merged edge set
  const cycle = findCycle(edges)
  if (cycle) errors.push(`cycle: ${cycle.join(' → ')}`)

  // unresolved inputs are informational (INPUT_NOT_READY is a normal pending state)
  const unresolvedInputs: PendingInput[] = []
  for (const rt of tasks) {
    const { pending } = resolveInputBindings(
      db,
      runId,
      modelVersion,
      (rt.spec.inputs as InputBinding[]) ?? []
    )
    for (const pi of pending)
      unresolvedInputs.push({ slot: `${rt.taskId}:${pi.slot}`, kind: pi.kind, reason: pi.reason })
  }

  return {
    resolved: {
      baseRevision: base,
      tasks,
      edges,
      retireTaskIds: [...retired],
      dispositions: patch.activeAttemptDisposition ?? []
    },
    structuralErrors: errors,
    unresolvedInputs
  }
}

/** DFS cycle check over merged edges; returns the cycle path if any. */
function findCycle(edges: { fromTask: string; toTask: string }[]): string[] | null {
  const adj = new Map<string, string[]>()
  for (const e of edges) adj.set(e.fromTask, [...(adj.get(e.fromTask) ?? []), e.toTask])
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2
  const color = new Map<string, number>()
  const stack: string[] = []
  let found: string[] | null = null
  const visit = (n: string): void => {
    if (found) return
    color.set(n, GRAY)
    stack.push(n)
    for (const m of adj.get(n) ?? []) {
      const c = color.get(m) ?? WHITE
      if (c === GRAY) {
        found = [...stack.slice(stack.indexOf(m)), m]
        return
      }
      if (c === WHITE) visit(m)
      if (found) return
    }
    stack.pop()
    color.set(n, BLACK)
  }
  for (const n of adj.keys()) {
    if ((color.get(n) ?? WHITE) === WHITE) visit(n)
    if (found) break
  }
  return found
}

/* ------------------------------------------------------------------ */
/* plan.prepare                                                        */
/* ------------------------------------------------------------------ */

export function planPrepare(txn: TxnContext, payload: unknown): PlanPrepareResult {
  const op = 'plan.prepare'
  const p = asObject(payload, op)
  const input: PlanPrepareInput = {
    runId: reqStr(p, 'runId', op),
    patch: validatePatch(p, op)
  }

  const at = nowMs()
  recheckCallerGrants(txn.db, txn.ctx, at)
  const runRow = loadRun(txn.db, input.runId)
  authorize(txn.ctx, op, [
    { kind: 'run', id: input.runId },
    { kind: 'modelVersion', id: runRow.modelVersion as string }
  ])
  requireOpenRun(runRow, op)

  const { resolved, structuralErrors, unresolvedInputs } = resolvePatch(
    txn.db,
    input.runId,
    runRow.modelVersion as string,
    runRow.currentPlanRevision,
    input.patch
  )

  const digest = digestOf({ runId: input.runId, resolved })
  const candidateId = newId('planc')
  exec(
    txn.db,
    'INSERT INTO plan_candidates(id,run_id,base_revision,digest,patch_json,diagnostics_json) VALUES(?,?,?,?,?,?)',
    candidateId,
    input.runId,
    resolved.baseRevision === 0 ? null : resolved.baseRevision,
    digest,
    canonicalJson({ patch: input.patch, resolved }),
    canonicalJson({ structuralErrors, unresolvedInputs })
  )
  appendDomainEvent(
    txn.db,
    input.runId,
    0,
    'plan.prepared',
    { runId: input.runId },
    {
      candidatePlanId: candidateId,
      digest,
      structuralErrorCount: structuralErrors.length
    }
  )
  return { candidatePlanId: candidateId, digest, structuralErrors, unresolvedInputs }
}

/* ------------------------------------------------------------------ */
/* plan.commit                                                         */
/* ------------------------------------------------------------------ */

export function planCommit(txn: TxnContext, payload: unknown): PlanCommitResult {
  const op = 'plan.commit'
  const p = asObject(payload, op)
  const input: PlanCommitInput = {
    candidatePlanId: reqStr(p, 'candidatePlanId', op),
    digest: reqStr(p, 'digest', op),
    expectedPlanRevision: optInt(p, 'expectedPlanRevision', op) ?? 0
  }

  const at = nowMs()
  recheckCallerGrants(txn.db, txn.ctx, at)

  const candRow = one(txn.db, 'SELECT * FROM plan_candidates WHERE id=?', input.candidatePlanId)
  if (!candRow)
    fail('STALE_REVISION', `${op}: candidate ${input.candidatePlanId} does not exist`, 'replan')
  const candidate = toPlanCandidate(candRow)
  const runRow = loadRun(txn.db, candidate.runId as string)
  authorize(txn.ctx, op, [{ kind: 'run', id: candidate.runId as string }])
  requireOpenRun(runRow, op)

  if (candidate.digest !== input.digest) {
    fail(
      'STALE_REVISION',
      `${op}: candidate digest mismatch (expected ${candidate.digest})`,
      'replan'
    )
  }
  const stored = parseJson<{ structuralErrors?: string[] }>(
    candRow.diagnostics_json,
    'plan_candidates.diagnostics_json'
  )
  if ((stored.structuralErrors ?? []).length > 0) {
    fail(
      'INVALID_TRANSITION',
      `${op}: candidate has structural errors — not publishable`,
      'replan',
      stored.structuralErrors
    )
  }
  const current = runRow.currentPlanRevision ?? 0
  if (current !== input.expectedPlanRevision) {
    fail(
      'STALE_REVISION',
      `${op}: expected plan ${input.expectedPlanRevision} but current is ${current}`,
      'same-operation'
    )
  }

  const storedPatch = parseJson<{ resolved: ResolvedPlan }>(
    candRow.patch_json,
    'plan_candidates.patch_json'
  )
  const resolved = storedPatch.resolved

  // re-verify attempt dispositions at commit time — dispatch state may have
  // moved between prepare and commit even though the plan pointer did not
  const dispositionByTask = new Map<string, AttemptDisposition>()
  for (const d of resolved.dispositions) dispositionByTask.set(d.taskId, d)
  const changedTasks = new Set(resolved.tasks.filter((t) => !t.isNew).map((t) => t.taskId))
  for (const tid of [...changedTasks, ...resolved.retireTaskIds]) {
    const ad = one(
      txn.db,
      "SELECT id FROM dispatches WHERE task_id=? AND authority_state='active'",
      tid
    )
    if (ad && !dispositionByTask.has(tid)) {
      fail(
        'INVALID_TRANSITION',
        `${op}: task ${tid} gained an active dispatch since prepare — disposition required`,
        'replan'
      )
    }
  }

  const newRevision = current + 1
  const runId = candidate.runId as string

  // CAS the active-plan pointer first — contention fails before writes land
  const cas = exec(
    txn.db,
    'UPDATE runs SET current_plan_revision=?, revision=revision+1 WHERE id=? AND COALESCE(current_plan_revision,0)=?',
    newRevision,
    runId,
    input.expectedPlanRevision
  )
  if (cas !== 1) {
    fail('STALE_REVISION', `${op}: run ${runId} plan pointer moved`, 'same-operation')
  }

  exec(
    txn.db,
    'INSERT INTO plans(run_id,revision,digest,dispositions_json) VALUES(?,?,?,?)',
    runId,
    newRevision,
    candidate.digest,
    canonicalJson(resolved.dispositions)
  )

  // task/spec writes: new task identities + new immutable spec revisions
  for (const t of resolved.tasks) {
    if (t.isNew) {
      exec(
        txn.db,
        'INSERT INTO tasks(id,run_id,current_revision,current_dispatch_id) VALUES(?,?,1,NULL)',
        t.taskId,
        runId
      )
    } else {
      exec(txn.db, 'UPDATE tasks SET current_revision=? WHERE id=?', t.revision, t.taskId)
    }
    exec(
      txn.db,
      'INSERT INTO task_specs(task_id,revision,title,requirement_text,owner_role_id,assigned_member_id,inputs_json,outputs_json,settlement_policy_json) VALUES(?,?,?,?,?,?,?,?,?)',
      t.taskId,
      t.revision,
      t.spec.title,
      t.spec.requirementText,
      t.spec.ownerRoleId,
      t.spec.assignedMemberId,
      canonicalJson(t.spec.inputs ?? []),
      canonicalJson(t.spec.outputs ?? []),
      canonicalJson(t.spec.settlementPolicy ?? {})
    )
    exec(
      txn.db,
      'INSERT INTO plan_tasks(run_id,plan_revision,task_id,task_revision) VALUES(?,?,?,?)',
      runId,
      newRevision,
      t.taskId,
      t.revision
    )
  }
  // carried-forward tasks keep their pinned revisions
  const patchedIds = new Set(resolved.tasks.map((t) => t.taskId))
  if (resolved.baseRevision > 0) {
    for (const bt of all(
      txn.db,
      'SELECT task_id, task_revision FROM plan_tasks WHERE run_id=? AND plan_revision=?',
      runId,
      resolved.baseRevision
    )) {
      const tid = bt.task_id as string
      if (patchedIds.has(tid) || resolved.retireTaskIds.includes(tid)) continue
      exec(
        txn.db,
        'INSERT INTO plan_tasks(run_id,plan_revision,task_id,task_revision) VALUES(?,?,?,?)',
        runId,
        newRevision,
        tid,
        bt.task_revision as number
      )
    }
  }

  for (const e of resolved.edges) {
    exec(
      txn.db,
      'INSERT INTO task_edges(run_id,plan_revision,from_task,to_task,requirements_json) VALUES(?,?,?,?,?)',
      runId,
      newRevision,
      e.fromTask,
      e.toTask,
      canonicalJson({
        requiredOutputNames: e.requiredOutputs,
        settlementRequirement: e.settlementRequirement
      })
    )
  }

  // apply declared dispositions to active attempts
  for (const d of resolved.dispositions) {
    if (d.action === 'keep') continue
    const ad = one(
      txn.db,
      "SELECT id FROM dispatches WHERE task_id=? AND authority_state='active'",
      d.taskId
    )
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
        { runId },
        { by: op, disposition: d.action }
      )
    }
  }

  activateRunIfDraft(txn.db, runRow)
  const newRev = runRow.revision + 1
  appendDomainEvent(
    txn.db,
    runId,
    newRev,
    'plan.committed',
    { runId },
    {
      planRevision: newRevision,
      digest: candidate.digest,
      taskCount: resolved.tasks.length,
      edgeCount: resolved.edges.length
    }
  )

  return {
    runId: runId as Id,
    planRevision: newRevision as Revision,
    digest: candidate.digest,
    eligibility: computeEligibility(txn.db, runId, newRevision)
  }
}
