// mahas-runtime/launch — worker.start staged coordinator + worker.inspect
// (IMP-19, C-LAUNCH + S-LIFECYCLE §1/§3 + REQ-13/14).
//
// worker.start runs the fixed stage chain with a durable receipt per
// stage. Each external effect is committed as an effect_intents row BEFORE
// the host/op call under a stable effect key (`<planId>:effect:<name>`), so
// a lost response resumes as 'unknown' — never silently re-spawned, never
// silently cleaned. A stage that fails leaves failedStage + effects +
// residualResources + nextAllowedActions for IMP-22 reconcile.
//
// join/accept stay SEPARATE states (instruction §4.4): the coordinator
// ends at 'awaiting_join'/'coordination_ready'; execution.join and
// task.accept are the agent's own ops (IMP-20). A lost initial-attachment
// response is never re-sent as a fresh prompt.

import type { DatabaseSync } from 'node:sqlite'
import type { ExecutionLiveness, ExecutionState } from '../../../mahas-contracts/src/identity.ts'
import type { TxnContext } from '../api/registry.ts'
import type { HostClient } from '../hostClient.ts'
import { mahasdWorkerEndpoint } from '../rpc/endpoints.ts'
import { getContentBlob } from '../storage/db.ts'
import { issueBootstrapCredential } from './bootstrap-credential.ts'
import {
  asMahasError,
  describeError,
  emitEvent,
  getRow,
  mahasError,
  runSql,
  tx,
  type MaterializedFile,
  type ResolvedDeps
} from './deps.ts'
import type { LaunchPins } from './planner.ts'
import {
  buildSpawnSpec,
  writeInjectionReceipt,
  joinRoot,
  type AttachEvidence,
  type PlannedProcessSpec
} from './initial-attachment.ts'
import { writeWorkerConnection } from './worker-connection.ts'
import {
  addResiduals,
  DRIVEN_STAGES,
  effectId,
  getEffect,
  loadReceipt,
  newReceipt,
  putEffect,
  recordStage,
  residual,
  saveReceipt,
  setEffectState,
  type DrivenStageName,
  type LaunchReceipt
} from './stage-receipts.ts'

// ---------------------------------------------------------------------------
// storage projections

interface LaunchPlanRow {
  id: string
  assignment_id: string
  assignment_revision: number
  digest: string
  bundle_digest: string
  envelope_digest: string
  surface_digest: string
  state: string
  process_spec_json: string
  pins_json: string
  reservations_json: string
}
interface ExecutionRow {
  id: string
  member_id: string
  generation: number
  host_id: string
  launch_plan_id: string
  state: ExecutionState
  liveness: ExecutionLiveness
  terminal_id: string | null
  process_identity_json: string
  native_conversation_json: string
  revision: number
}
interface GrantRow {
  id: string
  revoked_at: number | null
  expires_at: number | null
}
interface MemberRow {
  id: string
  generation: number
  current_execution_id: string | null
  state: string
  revision: number
}

/** thrown-host errors that prove the spawn was never admitted → definitive
 *  negative, NOT unknown. GRANT_REVOKED is omitted: after the OS call is
 *  in-flight a revoked grant is not proof the process never started. */
const SPAWN_NEVER_ADMITTED = new Set([
  'HOST_PROTOCOL_MISMATCH',
  'UNAUTHENTICATED',
  'SCOPE_DENIED',
  'STALE_EXECUTION'
])

/** worker socket stamped into the connection file — never the operator path */
function workerEndpointFrom(deps: ResolvedDeps): string {
  const ep = deps.endpoint
  if (typeof ep === 'string' && ep.length > 0) {
    return ep.replace(/mahasd\.sock$/, 'mahasd-worker.sock')
  }
  return mahasdWorkerEndpoint('.')
}

// ---------------------------------------------------------------------------
// shared stage context — hydrated from confirmed stage receipts on resume

interface Shared {
  executionId?: string
  generation?: number
  dispatchId?: string
  deliveryId?: string
  principalId?: string
  secret?: string
  checkoutId?: string
  checkoutPath?: string
  workspaceId?: string
  claims?: unknown[]
  executionRoot?: string
  manifestDigest?: string
  files: Map<string, MaterializedFile>
  spawnNonce?: string
  processIdentity?: unknown
  terminalId?: string
  attachEvidence?: AttachEvidence[]
  stdinBytes?: Uint8Array
}

interface StageCtx {
  db: DatabaseSync
  txn: TxnContext
  deps: ResolvedDeps
  plan: LaunchPlanRow
  pins: LaunchPins
  spec: PlannedProcessSpec
  receipt: LaunchReceipt
  shared: Shared
}

interface StageOutcome {
  receipt?: unknown
  residuals?: unknown[]
}

// ---------------------------------------------------------------------------
// worker.start

export interface StartInput {
  launchPlanId: string
  planDigest: string
  operationId?: string
}

export interface StartResult {
  launchPlanId: string
  executionId?: string
  generation?: number
  dispatchId?: string
  joinState: string
  stageReceipt: LaunchReceipt
}

export async function workerStart(
  txn: TxnContext,
  payload: unknown,
  deps: ResolvedDeps
): Promise<StartResult> {
  const db = txn.db
  const p = payload as Partial<StartInput>
  if (typeof p.launchPlanId !== 'string' || typeof p.planDigest !== 'string') {
    throw mahasError('INPUT_NOT_READY', 'worker.start: launchPlanId and planDigest are required')
  }
  const operationId = p.operationId ?? ''
  const plan = getRow<LaunchPlanRow>(db, 'SELECT * FROM launch_plans WHERE id=?', p.launchPlanId)
  if (!plan) {
    throw mahasError('INPUT_NOT_READY', `launch plan ${p.launchPlanId} not found`, 'replan')
  }
  if (plan.digest !== p.planDigest) {
    throw mahasError(
      'STALE_REVISION',
      `planDigest mismatch: stored ${plan.digest} vs supplied ${p.planDigest}`,
      'replan'
    )
  }
  const pins = JSON.parse(plan.pins_json) as LaunchPins
  const spec = JSON.parse(plan.process_spec_json) as PlannedProcessSpec

  let receipt = loadReceipt(db, plan.id)
  if (!receipt) {
    if (plan.state !== 'planned' && plan.state !== 'used') {
      throw mahasError(
        'INVALID_TRANSITION',
        `launch plan state '${plan.state}' cannot start`,
        'replan'
      )
    }
    receipt = newReceipt(plan.id, plan.digest, pins.assignment.kind, operationId, deps.now())
  } else if (operationId && !receipt.operationIds.includes(operationId)) {
    receipt.operationIds.push(operationId)
  }

  // same plan already driven to its terminal stage → replay that receipt
  // unless this call is a new generation (native-resume/fresh).
  const requestedGen =
    typeof (p as { generation?: number }).generation === 'number'
      ? (p as { generation: number }).generation
      : undefined
  if (receipt.terminal) {
    const priorGen = receipt.generation
    const newGen = requestedGen !== undefined && (priorGen === undefined || requestedGen > priorGen)
    if (!newGen) return result(receipt)
    receipt = newReceipt(plan.id, plan.digest, pins.assignment.kind, operationId, deps.now())
    receipt.generation = requestedGen
  }

  const ctx: StageCtx = { db, txn, deps, plan, pins, spec, receipt, shared: { files: new Map() } }
  hydrateShared(ctx)

  if (receipt.admissionReleased) return result(receipt)

  for (const stage of DRIVEN_STAGES) {
    const entry = receipt.stages.find((s) => s.stage === stage)!
    if (entry.status === 'confirmed') continue

    if (entry.status === 'unknown') {
      // ambiguous — never auto-retry; reconcile path only (REQ-14)
      if (stage === 'admitted' && recoverAdmission(ctx)) {
        recordStage(receipt, stage, { status: 'confirmed' }, deps.now())
        saveReceipt(db, deps, receipt)
        continue
      }
      receipt.failedStage = stage
      receipt.nextAllowedActions = entry.nextAllowedActions?.length
        ? entry.nextAllowedActions
        : ['worker.inspect', 'reconcile', 'worker.stop:authorized']
      saveReceipt(db, deps, receipt)
      return result(receipt)
    }

    if (entry.status === 'failed') {
      const execution = sharedExecution(ctx)
      const retryable =
        (entry.nextAllowedActions?.includes('retry:same-operation') ?? false) &&
        execution?.state !== 'exited'
      if (!retryable) {
        // Repair receipts written before definitive failures released their
        // admission. This only uses durable evidence that no spawn exists.
        tx(db, () => {
          releaseDefinitivePreSpawnAdmission(ctx, stage)
          receipt.failedStage = stage
          receipt.nextAllowedActions = failureActions(
            receipt,
            (entry.nextAllowedActions ?? ['replan']).filter(
              (action) => action !== 'retry:same-operation'
            )
          )
          if (!receipt.nextAllowedActions.includes('replan'))
            receipt.nextAllowedActions.push('replan')
          entry.nextAllowedActions = receipt.nextAllowedActions
          saveReceipt(db, deps, receipt)
        })
        return result(receipt)
      }
    }

    recordStage(receipt, stage, { status: 'attempting', error: undefined }, deps.now())
    saveReceipt(db, deps, receipt)

    try {
      const outcome = await STAGE_HANDLERS[stage](ctx)
      recordStage(
        receipt,
        stage,
        { status: 'confirmed', receipt: outcome.receipt, residuals: outcome.residuals },
        deps.now()
      )
      addResiduals(receipt, outcome.residuals)
      if (receipt.failedStage === stage) delete receipt.failedStage
      saveReceipt(db, deps, receipt)
    } catch (e) {
      const verdict = stageFailure(stage, e)
      tx(db, () => {
        // A retry continues this very execution/dispatch. Releasing admission
        // here would let another launch take its member while a later retry
        // revives the old generation.
        const shouldRelease =
          verdict.status === 'failed' && !verdict.next.includes('retry:same-operation')
        const released = shouldRelease ? releaseDefinitivePreSpawnAdmission(ctx, stage) : false
        if (verdict.executionState && !released)
          transitionExecution(ctx, verdict.executionState, verdict.liveness)
        const next = failureActions(receipt, verdict.next)
        recordStage(
          receipt,
          stage,
          {
            status: verdict.status,
            error: verdict.error,
            residuals: verdict.residuals,
            nextAllowedActions: next
          },
          deps.now()
        )
        addResiduals(receipt, verdict.residuals)
        receipt.failedStage = stage
        receipt.nextAllowedActions = next
        saveReceipt(db, deps, receipt)
      })
      return result(receipt)
    }
  }

  // coordinator's work ends at awaiting_join — join/accept are the agent's
  // own operations (IMP-20); coordination ends at coordination_ready.
  const joins = getRow<{ execution_id: string }>(
    db,
    'SELECT execution_id FROM worker_joins WHERE execution_id=? AND generation=?',
    ctx.shared.executionId ?? '',
    ctx.shared.generation ?? -1
  )
  if (joins) {
    recordStage(
      receipt,
      'joined',
      { status: 'confirmed', receipt: { observed: 'worker_joins' } },
      deps.now()
    )
  }
  receipt.terminal = 'awaiting_join'
  receipt.nextAllowedActions =
    pins.assignment.kind === 'task'
      ? ['execution.join', 'task.accept', 'worker.inspect', 'worker.stop:authorized']
      : ['execution.join', 'coordination-mandate', 'worker.inspect', 'worker.stop:authorized']
  saveReceipt(db, deps, receipt)
  return result(receipt)
}

function sharedExecution(ctx: StageCtx): ExecutionRow | null {
  return ctx.shared.executionId
    ? getRow<ExecutionRow>(ctx.db, 'SELECT * FROM executions WHERE id=?', ctx.shared.executionId)
    : null
}

function failureActions(receipt: LaunchReceipt, next: string[]): string[] {
  return receipt.residuals.length > 0 && !next.includes('worker.release')
    ? [...next, 'worker.release']
    : next
}

/** A definitive failure before a process can exist must not leave the member
 * permanently bound to a dead `preparing` execution. Fence the dispatch and
 * generation authority, release the member pointer, and retain claims as
 * explicit residuals for worker.release. Unknown/ambiguous spawn outcomes do
 * not enter this path. */
function releaseDefinitivePreSpawnAdmission(ctx: StageCtx, stage: DrivenStageName): boolean {
  const { db, deps, shared } = ctx
  if (!shared.executionId) return false
  const preSpawn = new Set<DrivenStageName>([
    'inputs_pinned',
    'resources_claimed',
    'components_materialized',
    'process_attempting'
  ])
  if (!preSpawn.has(stage)) return false
  const execution = getRow<{
    state: string
    member_id: string
    generation: number
    process_identity_json: string
  }>(
    db,
    'SELECT state, member_id, generation, process_identity_json FROM executions WHERE id=?',
    shared.executionId
  )
  if (!execution || !['preparing', 'starting', 'exited'].includes(execution.state)) return false
  const spawn = getEffect(db, effectId(ctx.plan.id, 'spawn'))
  if (spawn && spawn.state !== 'rejected') return false
  // Never clear authority for an execution that has observed process identity,
  // even if a stale/invalid receipt claims an earlier stage failed.
  if (execution.process_identity_json !== '{}') return false

  tx(db, () => {
    const dispatch = getRow<{ id: string; task_id: string }>(
      db,
      "SELECT id, task_id FROM dispatches WHERE execution_id=? AND authority_state='active'",
      shared.executionId
    )
    if (dispatch) {
      runSql(
        db,
        "UPDATE dispatches SET authority_state='revoked', phase='revoked', revision=revision+1 WHERE id=?",
        dispatch.id
      )
      runSql(
        db,
        'UPDATE tasks SET current_dispatch_id=NULL WHERE id=? AND current_dispatch_id=?',
        dispatch.task_id,
        dispatch.id
      )
    }
    runSql(
      db,
      "UPDATE executions SET state='exited', liveness='exited', revision=revision+1 WHERE id=?",
      shared.executionId
    )
    runSql(
      db,
      'UPDATE members SET current_execution_id=NULL, revision=revision+1 WHERE id=? AND current_execution_id=?',
      execution.member_id,
      shared.executionId
    )
    runSql(
      db,
      `UPDATE execution_credentials SET revoked_at=?, revision=revision+1
       WHERE execution_id=? AND generation=? AND revoked_at IS NULL`,
      deps.now(),
      shared.executionId,
      execution.generation
    )
    emitEvent(
      db,
      deps,
      shared.executionId!,
      currentRevision(db, shared.executionId!),
      'execution.start_failed',
      { launchPlanId: ctx.plan.id, failedStage: stage },
      { definitiveNoProcess: true, residualResources: ctx.receipt.residuals }
    )
    ctx.receipt.admissionReleased = true
  })
  return true
}

function result(r: LaunchReceipt): StartResult {
  const failed = r.stages.find((s) => s.stage === r.failedStage)
  return {
    launchPlanId: r.launchPlanId,
    ...(r.executionId ? { executionId: r.executionId } : {}),
    ...(r.generation !== undefined ? { generation: r.generation } : {}),
    ...(r.dispatchId ? { dispatchId: r.dispatchId } : {}),
    joinState:
      r.terminal ??
      (r.failedStage ? `${r.failedStage}:${failed?.status ?? 'failed'}` : 'in-progress'),
    stageReceipt: r
  }
}

// ---------------------------------------------------------------------------
// failure classification — definitive vs ambiguous (never collapse to one
// boolean; residuals are preserved either way)

interface StageVerdict {
  status: 'failed' | 'unknown'
  error: { code: string; message: string; retry?: string }
  residuals?: unknown[]
  next: string[]
  executionState?: ExecutionState
  liveness?: ExecutionLiveness
}

function stageFailure(stage: DrivenStageName, e: unknown): StageVerdict {
  const error = describeError(e)
  // F-046: classify through the makeCaller wrapper — a cross-domain
  // validation refusal (INPUT_NOT_READY/…) is definitive (failed/replan),
  // never ambiguous (unknown/reconcile).
  const m = asMahasError(e)

  switch (stage) {
    case 'admitted':
      // pure control-plane tx — all-or-nothing, a throw means nothing stored
      return {
        status: 'failed',
        error,
        next:
          m?.code === 'GRANT_REVOKED' || m?.code === 'OPERATION_CONFLICT'
            ? ['replan']
            : ['retry:same-operation', 'replan']
      }
    case 'inputs_pinned':
      return {
        status: 'failed',
        error,
        next:
          m?.code === 'INTERFACE_STALE' ||
          m?.code === 'INPUT_NOT_READY' ||
          m?.code === 'GRANT_REVOKED'
            ? ['replan']
            : ['retry:same-operation', 'replan']
      }
    case 'resources_claimed':
      if (m?.code === 'START_UNKNOWN' || m?.code === 'CONTROL_UNAVAILABLE') {
        return { status: 'unknown', error, next: ['worker.inspect', 'reconcile'] }
      }
      if (m) {
        return {
          status: 'failed',
          error,
          next: m.code === 'RESOURCE_BUSY' ? ['retry:same-operation', 'replan'] : ['replan']
        }
      }
      return { status: 'unknown', error, next: ['worker.inspect', 'reconcile'] }
    case 'components_materialized':
      if (m) {
        return {
          status: 'failed',
          error,
          next: m.code === 'CONTROL_UNAVAILABLE' ? ['retry:same-operation', 'replan'] : ['replan']
        }
      }
      return { status: 'unknown', error, next: ['worker.inspect', 'reconcile'] }
    case 'process_attempting':
      if (m && SPAWN_NEVER_ADMITTED.has(m.code)) {
        return {
          status: 'failed',
          error,
          next: ['replan', 'worker.release'],
          executionState: 'exited',
          liveness: 'exited'
        }
      }
      if (m && m.code === 'MANDATORY_COMPONENT_MISSING') {
        return {
          status: 'failed',
          error,
          next: ['replan'],
          executionState: 'exited',
          liveness: 'exited'
        }
      }
      // timeout / connection drop / START_UNKNOWN — a process may exist
      return {
        status: 'unknown',
        error,
        next: ['host.effect.get', 'host.process.probe', 'worker.inspect', 'worker.stop:authorized'],
        executionState: 'start_unknown',
        liveness: 'unverifiable'
      }
    case 'process_confirmed':
    case 'initial_attached':
      // the process exists; attach/commit evidence is what is in doubt
      return m
        ? { status: 'failed', error, next: ['worker.inspect', 'worker.stop:authorized', 'replan'] }
        : { status: 'unknown', error, next: ['worker.inspect', 'reconcile'] }
    case 'awaiting_join':
      return { status: 'failed', error, next: ['retry:same-operation'] }
  }
}

// ---------------------------------------------------------------------------
// stage handlers

const STAGE_HANDLERS: Record<DrivenStageName, (ctx: StageCtx) => Promise<StageOutcome>> = {
  admitted: stageAdmitted,
  inputs_pinned: stageInputsPinned,
  resources_claimed: stageResourcesClaimed,
  components_materialized: stageComponentsMaterialized,
  process_attempting: stageProcessAttempting,
  process_confirmed: stageProcessConfirmed,
  initial_attached: stageInitialAttached,
  awaiting_join: stageAwaitingJoin
}

/** admission transaction — execution + principal + dispatch/current
 *  pointer + assignment Message/Delivery committed atomically (C-LAUNCH
 *  worker.start storage effect). Idempotent on the executions row for
 *  this launch plan. */
async function stageAdmitted(ctx: StageCtx): Promise<StageOutcome> {
  const { db, deps, plan, pins, receipt, shared } = ctx
  const outcome = tx(db, () => {
    const existing = getRow<ExecutionRow>(
      db,
      'SELECT * FROM executions WHERE launch_plan_id=?',
      plan.id
    )
    if (existing) {
      // resume: admission already committed once
      shared.executionId = existing.id
      shared.generation = existing.generation
      receipt.executionId = existing.id
      receipt.generation = existing.generation
      return { resumed: true, executionId: existing.id, generation: existing.generation }
    }

    // current authority re-check (C-LAUNCH worker.start precondition)
    const grant = getRow<GrantRow>(db, 'SELECT * FROM grants WHERE id=?', pins.grant.id)
    if (!grant)
      throw mahasError('GRANT_REVOKED', `grant ${pins.grant.id} no longer exists`, 'replan')
    if (grant.revoked_at != null)
      throw mahasError('GRANT_REVOKED', `grant ${grant.id} revoked`, 'replan')
    if (grant.expires_at != null && grant.expires_at <= deps.now()) {
      throw mahasError('GRANT_REVOKED', `grant ${grant.id} expired`, 'replan')
    }
    const host = getRow<{ incarnation: string }>(
      db,
      'SELECT incarnation FROM execution_hosts WHERE id=?',
      pins.host.id
    )
    if (!host || host.incarnation !== pins.host.incarnation) {
      throw mahasError(
        'INTERFACE_STALE',
        `host ${pins.host.id} incarnation changed since plan`,
        'replan'
      )
    }
    const member = getRow<MemberRow>(db, 'SELECT * FROM members WHERE id=?', pins.member.id)
    if (!member) throw mahasError('INPUT_NOT_READY', `member ${pins.member.id} gone`, 'replan')
    if (member.current_execution_id != null) {
      throw mahasError(
        'OPERATION_CONFLICT',
        `member ${member.id} already bound to execution ${member.current_execution_id}`,
        'replan'
      )
    }

    const maxGen = getRow<{ g: number }>(
      db,
      'SELECT COALESCE(MAX(generation),0) AS g FROM executions WHERE member_id=?',
      member.id
    )!.g
    const generation = maxGen + 1
    const executionId = deps.newId('execution')
    const principalId = `principal-${executionId}`

    runSql(
      db,
      'INSERT INTO principals(id,kind,status) VALUES (?,?,?)',
      principalId,
      'worker',
      'active'
    )
    runSql(
      db,
      `INSERT INTO executions(id,member_id,generation,host_id,launch_plan_id,state,liveness,terminal_id,process_identity_json,native_conversation_json,revision)
       VALUES (?,?,?,?,?,'preparing','unverifiable',NULL,'{}','{}',1)`,
      executionId,
      member.id,
      generation,
      pins.host.id,
      plan.id
    )
    runSql(
      db,
      'UPDATE members SET current_execution_id=?, generation=?, revision=revision+1 WHERE id=?',
      executionId,
      generation,
      member.id
    )
    runSql(db, "UPDATE launch_plans SET state='used' WHERE id=?", plan.id)

    let dispatchId: string | undefined
    let deliveryId: string | undefined
    if (pins.assignment.kind === 'task' && pins.task) {
      const admission = admitDispatch(ctx, member.id, executionId, generation)
      dispatchId = admission.dispatchId
      deliveryId = admission.deliveryId
    }

    receipt.executionId = executionId
    receipt.generation = generation
    if (dispatchId) receipt.dispatchId = dispatchId

    shared.executionId = executionId
    shared.generation = generation
    shared.principalId = principalId
    if (dispatchId) shared.dispatchId = dispatchId
    if (deliveryId) shared.deliveryId = deliveryId

    emitEvent(
      db,
      deps,
      executionId,
      1,
      'execution.admitted',
      { launchPlanId: plan.id, memberId: member.id },
      { generation, dispatchId }
    )
    saveReceipt(db, deps, receipt)
    return { resumed: false, executionId, generation, principalId, dispatchId, deliveryId }
  })
  return { receipt: outcome }
}

/** Dispatch reservation + assignment Message/Delivery in the same txn.
 *  Inline per C-LAUNCH (worker.start owns this storage effect); when
 *  handoff:IMP-14 fixes reserveDispatch's signature this is the seam to
 *  swap — flagged in the IMP-19 handoff. */
function admitDispatch(
  ctx: StageCtx,
  memberId: string,
  executionId: string,
  generation: number
): { dispatchId: string; deliveryId: string } {
  const { db, deps, pins } = ctx
  const task = pins.task!
  const active = getRow<{ id: string; execution_id: string }>(
    db,
    "SELECT id,execution_id FROM dispatches WHERE task_id=? AND authority_state='active'",
    task.id
  )
  if (active && active.execution_id !== executionId) {
    throw mahasError(
      'OPERATION_CONFLICT',
      `task ${task.id} already has active dispatch ${active.id}`,
      'replan'
    )
  }
  if (active) return { dispatchId: active.id, deliveryId: '' }

  const systemPrincipal = ensureSystemPrincipal(ctx)
  const messageId = deps.newId('message')
  const deliveryId = deps.newId('delivery')
  const dispatchId = deps.newId('dispatch')

  runSql(
    db,
    'INSERT INTO messages(id,run_id,sender_principal_id,sender_member_id,kind,body,links_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
    messageId,
    pins.run.id,
    systemPrincipal,
    null,
    'assignment',
    `assignment ${pins.assignment.id}@${pins.assignment.revision}`,
    JSON.stringify({
      envelopeDigest: pins.envelope.digest,
      dispatchId,
      taskId: task.id,
      taskRevision: task.revision
    }),
    deps.now()
  )
  runSql(
    db,
    "INSERT INTO deliveries(id,message_id,recipient_member_id,consumer_generation,status,revision,handling_json) VALUES (?,?,?,?,'outstanding',1,'{}')",
    deliveryId,
    messageId,
    memberId,
    generation
  )
  runSql(
    db,
    `INSERT INTO dispatches(id,task_id,task_revision,member_id,execution_id,generation,envelope_digest,phase,authority_state,assignment_delivery_id,revision)
     VALUES (?,?,?,?,?,?,?,'awaiting_join','active',?,1)`,
    dispatchId,
    task.id,
    task.revision,
    memberId,
    executionId,
    generation,
    pins.envelope.digest,
    deliveryId
  )
  runSql(db, 'UPDATE tasks SET current_dispatch_id=? WHERE id=?', dispatchId, task.id)
  return { dispatchId, deliveryId }
}

function ensureSystemPrincipal(ctx: StageCtx): string {
  const { db } = ctx
  const row = getRow<{ id: string }>(db, "SELECT id FROM principals WHERE kind='system' LIMIT 1")
  if (row) return row.id
  const id = 'principal-system'
  runSql(db, 'INSERT INTO principals(id,kind,status) VALUES (?,?,?)', id, 'system', 'active')
  return id
}

/** admission committed but receipt write was lost — recover by evidence */
function recoverAdmission(ctx: StageCtx): boolean {
  const { db, plan, receipt, shared } = ctx
  const existing = getRow<ExecutionRow>(
    db,
    'SELECT * FROM executions WHERE launch_plan_id=?',
    plan.id
  )
  if (!existing) return false
  shared.executionId = existing.id
  shared.generation = existing.generation
  shared.principalId = `principal-${existing.id}`
  receipt.executionId = existing.id
  receipt.generation = existing.generation
  const dsp = getRow<{ id: string }>(
    db,
    'SELECT id FROM dispatches WHERE execution_id=?',
    existing.id
  )
  if (dsp) {
    shared.dispatchId = dsp.id
    receipt.dispatchId = dsp.id
  }
  return true
}

/** every pinned input must still resolve; the route plan must still cover
 *  the required deliveries before any process work begins (instruction §4.3) */
async function stageInputsPinned(ctx: StageCtx): Promise<StageOutcome> {
  const { db, deps, pins } = ctx
  const missing: string[] = []
  if (
    !getRow<{ digest: string }>(
      db,
      'SELECT digest FROM context_bundles WHERE digest=?',
      pins.bundle.digest
    )
  ) {
    missing.push(`context bundle ${pins.bundle.digest}`)
  }
  if (
    !getRow<{ digest: string }>(
      db,
      'SELECT digest FROM work_envelopes WHERE digest=?',
      pins.envelope.digest
    )
  ) {
    missing.push(`work envelope ${pins.envelope.digest}`)
  }
  if (
    !getRow<{ digest: string }>(
      db,
      'SELECT digest FROM command_surfaces WHERE digest=?',
      pins.surface.digest
    )
  ) {
    missing.push(`command surface ${pins.surface.digest}`)
  }
  if (missing.length) {
    throw mahasError(
      'INPUT_NOT_READY',
      `pinned inputs no longer resolvable: ${missing.join(', ')}`,
      'replan'
    )
  }
  const grant = getRow<GrantRow>(db, 'SELECT * FROM grants WHERE id=?', pins.grant.id)
  if (!grant || grant.revoked_at != null)
    throw mahasError('GRANT_REVOKED', `grant ${pins.grant.id} revoked`, 'replan')
  if (grant.expires_at != null && grant.expires_at <= deps.now()) {
    throw mahasError('GRANT_REVOKED', `grant ${grant.id} expired`, 'replan')
  }
  const routed = new Set(pins.routes.map((r) => r.source))
  const unrouted = ['role/mandatory.md', 'task/initial.txt'].filter((s) => !routed.has(s))
  if (unrouted.length) {
    throw mahasError(
      'INJECTION_UNSUPPORTED',
      `no explicit route for ${unrouted.join(', ')}`,
      'replan'
    )
  }
  return {
    receipt: {
      verifiedPins: {
        bundle: pins.bundle.digest,
        envelope: pins.envelope.digest,
        surface: pins.surface.digest,
        interface: pins.interfaceDigest,
        implementation: pins.implementation,
        harnessProfile: pins.harnessProfile,
        task: pins.task
      },
      routes: pins.routes.length
    }
  }
}

/** resource claim via the C-RESOURCE workspace.prepare operation */
async function stageResourcesClaimed(ctx: StageCtx): Promise<StageOutcome> {
  const { db, deps, txn, plan, pins, receipt, shared } = ctx
  const eid = effectId(plan.id, 'resources')
  const prior = getEffect(db, eid)

  type PrepareResult = {
    workspace?: { id?: string; state?: string }
    checkout?: { id?: string; canonicalPath?: string }
    claim?: unknown
    claims?: unknown[]
    effect?: { state?: string; receipt?: unknown; residuals?: unknown[] }
  }
  type MappedClaim = {
    checkoutId?: string
    checkoutPath?: string
    workspaceId?: string
    claims: unknown[]
    effectResiduals: unknown[]
  }

  const mapPrepare = (out: PrepareResult): MappedClaim => ({
    checkoutId: out.checkout?.id,
    checkoutPath: out.checkout?.canonicalPath,
    workspaceId: out.workspace?.id,
    claims: out.claims ?? (out.claim ? [out.claim] : []),
    effectResiduals: out.effect?.residuals ?? []
  })

  if (prior?.state === 'confirmed') {
    const mapped = prior.receipt as MappedClaim
    hydrateClaim(mapped, shared)
    const workspaceState = mapped.workspaceId
      ? getRow<{ state: string }>(db, 'SELECT state FROM workspaces WHERE id=?', mapped.workspaceId)
          ?.state
      : undefined
    if (
      workspaceState !== 'ready' ||
      !mapped.checkoutPath ||
      !mapped.checkoutId ||
      !mapped.workspaceId
    ) {
      throw mahasError(
        'START_UNKNOWN',
        'confirmed workspace.prepare effect has no ready workspace',
        'reconcile',
        { workspaceState, effectState: prior.state }
      )
    }
    return {
      receipt: mapped,
      residuals: [...(mapped.effectResiduals ?? []), ...claimResiduals(shared)]
    }
  }

  if (!deps.call) {
    throw mahasError(
      'CONTROL_UNAVAILABLE',
      'workspace.prepare caller not wired (handoff:IMP-11/IMP-16 pending)'
    )
  }
  // F-046: the payload must match the workspace.prepare contract
  // ({projectId, placementIntent, ownerReservation}) — the old shape
  // ({reservationId, owner, memberId, runId, …}) was rejected INPUT_NOT_READY
  // on every shipped worker.start. projectId comes from the run row; the
  // claim owner is this launch's execution.
  const runRow = getRow<{ project_id: string }>(
    db,
    'SELECT project_id FROM runs WHERE id=?',
    pins.run.id
  )
  if (!runRow?.project_id) {
    throw mahasError('INPUT_NOT_READY', `run ${pins.run.id} not found for placement`, 'replan')
  }
  if (!shared.executionId) {
    throw mahasError(
      'INPUT_NOT_READY',
      'execution identity not issued before resources_claimed',
      'replan'
    )
  }
  const payload = {
    projectId: runRow.project_id,
    placementIntent: pins.placementIntent,
    ownerReservation: {
      ownerKind: 'execution',
      ownerId: shared.executionId,
      ...(shared.generation !== undefined ? { generation: shared.generation } : {})
    }
  }
  tx(db, () => {
    putEffect(db, deps, {
      id: eid,
      operationKey: `worker.start:${plan.id}`,
      kind: 'workspace.prepare',
      hostId: pins.host.id,
      state: 'attempting',
      payload
    })
    recordStage(receipt, 'resources_claimed', { status: 'attempting', effectId: eid }, deps.now())
    saveReceipt(db, deps, receipt)
  })
  let observed: MappedClaim | undefined
  try {
    const out = (await deps.call(txn.ctx, 'workspace.prepare', payload)) as PrepareResult
    const mapped = mapPrepare(out)
    observed = mapped
    hydrateClaim(mapped, shared)

    const workspaceState = out.workspace?.state
    const effectState = out.effect?.state
    if (workspaceState === 'failed' || effectState === 'rejected') {
      const nestedReceipt = out.effect?.receipt
      const reason =
        nestedReceipt && typeof nestedReceipt === 'object' && 'reason' in nestedReceipt
          ? (nestedReceipt as { reason?: unknown }).reason
          : nestedReceipt
      throw (
        asMahasError(reason) ??
        mahasError('INPUT_NOT_READY', 'workspace.prepare was rejected', 'replan', reason)
      )
    }
    if (workspaceState !== 'ready' || effectState !== 'confirmed') {
      throw mahasError(
        'START_UNKNOWN',
        'workspace.prepare did not confirm a ready workspace',
        'reconcile',
        { workspaceState, effectState }
      )
    }
    if (!mapped.checkoutPath || !mapped.checkoutId || !mapped.workspaceId) {
      throw mahasError(
        'CONTROL_UNAVAILABLE',
        'workspace.prepare confirmed readiness without a canonical checkout path',
        'reconcile',
        { workspaceState, effectState }
      )
    }
    tx(db, () => {
      const residuals = [...mapped.effectResiduals, ...claimResiduals(shared)]
      setEffectState(db, eid, 'confirmed', mapped, residuals)
      hydrateClaim(mapped, shared)
    })
    return { receipt: mapped, residuals: [...mapped.effectResiduals, ...claimResiduals(shared)] }
  } catch (e) {
    // Keep any claim returned with a rejected/unknown workspace result.  The
    // residual is the handoff for worker.release/reconcile; dropping it here
    // would make a failed launch look clean while its writer still blocks the
    // checkout.
    const m = asMahasError(e)
    const state =
      !m || m.code === 'CONTROL_UNAVAILABLE' || m.code === 'START_UNKNOWN' ? 'unknown' : 'rejected'
    const residuals = observed
      ? [...observed.effectResiduals, ...claimResiduals(shared)]
      : claimResiduals(shared)
    addResiduals(receipt, residuals)
    tx(db, () => {
      setEffectState(
        db,
        eid,
        state,
        { error: describeError(e), ...(observed ? { result: observed } : {}) },
        residuals
      )
    })
    throw e
  }
}

function hydrateClaim(out: unknown, shared: Shared): void {
  const o = out as {
    checkoutId?: string
    checkoutPath?: string
    workspaceId?: string
    claims?: unknown[]
  }
  shared.checkoutId = o.checkoutId
  shared.checkoutPath = o.checkoutPath
  shared.workspaceId = o.workspaceId
  shared.claims = o.claims ?? []
}

function claimResiduals(shared: Shared): unknown[] {
  const out: unknown[] = []
  if (shared.checkoutId)
    out.push(
      residual('checkout', shared.checkoutId, 'held', `workspace ${shared.workspaceId ?? '?'}`)
    )
  for (const c of shared.claims ?? []) {
    const claim = c as { id?: string; resourceId?: string }
    if (claim.id) out.push(residual('resource-claim', claim.id, 'held', claim.resourceId))
  }
  return out
}

/** component materialization via the IMP-09 materializer port — plus the
 *  bootstrap credential secret file (never manifested, never logged) and
 *  the execution_credentials row (secret hash only). */
async function stageComponentsMaterialized(ctx: StageCtx): Promise<StageOutcome> {
  const { db, deps, plan, pins, spec, receipt, shared } = ctx
  const eid = effectId(plan.id, 'materialize')
  const prior = getEffect(db, eid)
  if (prior?.state === 'confirmed') {
    const rec = prior.receipt as { executionRoot?: string; manifestDigest?: string }
    shared.executionRoot = rec.executionRoot
    shared.manifestDigest = rec.manifestDigest
    await refillBytes(ctx)
    return { receipt: prior.receipt }
  }
  if (!deps.materialize) {
    throw mahasError(
      'CONTROL_UNAVAILABLE',
      'component materializer port not wired (handoff:IMP-09 pending)'
    )
  }
  if (!shared.checkoutPath)
    throw mahasError('INPUT_NOT_READY', 'no claimed checkout path', 'same-operation')

  const envelope = loadMaterializationEnvelope(ctx)

  const wantBytes = textSources(spec)
  const payload = {
    executionId: shared.executionId,
    bundleDigest: pins.bundle.digest,
    checkoutPath: shared.checkoutPath,
    workspaceId: shared.workspaceId,
    memberId: pins.member.id,
    launchPlanId: plan.id,
    operationKey: eid,
    envelope,
    wantBytes
  }
  tx(db, () => {
    putEffect(db, deps, {
      id: eid,
      operationKey: `worker.start:${plan.id}`,
      kind: 'components.materialize',
      state: 'attempting',
      payload
    })
    recordStage(
      receipt,
      'components_materialized',
      { status: 'attempting', effectId: eid },
      deps.now()
    )
    saveReceipt(db, deps, receipt)
  })
  try {
    const out = await deps.materialize({
      executionId: shared.executionId!,
      bundleDigest: pins.bundle.digest,
      checkoutPath: shared.checkoutPath!,
      ...(shared.workspaceId ? { workspaceId: shared.workspaceId } : {}),
      memberId: pins.member.id,
      launchPlanId: plan.id,
      operationKey: eid,
      envelope,
      wantBytes
    })
    shared.executionRoot = out.executionRoot
    shared.manifestDigest = out.manifestDigest
    shared.files = new Map(out.files.map((f) => [f.path, f]))
    const publicReceipt = {
      executionRoot: out.executionRoot,
      manifestDigest: out.manifestDigest,
      files: out.files.map((f) => ({ path: f.path, digest: f.digest, byteLength: f.byteLength })),
      receipts: out.receipts
    }
    const principalId = shared.principalId ?? `principal-${shared.executionId}`
    shared.principalId = principalId
    const at = deps.now()
    const issued = tx(db, () => {
      runSql(
        db,
        `UPDATE execution_credentials SET revoked_at=?, revision=revision+1
         WHERE execution_id=? AND generation=? AND revoked_at IS NULL`,
        at,
        shared.executionId,
        shared.generation
      )
      return issueBootstrapCredential(db, {
        executionId: shared.executionId!,
        generation: shared.generation!,
        principalId,
        at
      })
    })
    writeWorkerConnection(out.executionRoot, {
      endpoint: workerEndpointFrom(deps),
      credentialId: issued.credentialId,
      secret: issued.secret,
      executionId: issued.executionId,
      generation: issued.generation,
      issuedAt: at
    })
    tx(db, () => {
      setEffectState(db, eid, 'confirmed', publicReceipt, out.residuals ?? [])
    })
    return { receipt: publicReceipt, residuals: out.residuals }
  } catch (e) {
    tx(db, () => {
      setEffectState(db, eid, asMahasError(e) ? 'rejected' : 'unknown', { error: describeError(e) })
    })
    throw e
  }
}

/** Resolve the pinned WorkEnvelope into the actual bytes materialized as
 * task/initial.txt. The envelope row only stores content-addressed body
 * bytes, so launch must join the blob instead of forwarding a digest/path. */
function loadMaterializationEnvelope(ctx: StageCtx): {
  digest: string
  initialText: string
  envelopeJson: unknown
} {
  const { db, pins, shared } = ctx
  const envelopeDigest = pins.envelope.digest
  const row = getRow<{
    digest: string
    kind: string
    assignment_id: string
    assignment_revision: number
    bindings_json: string
    body_digest: string
  }>(
    db,
    `SELECT e.digest, e.kind, e.assignment_id, e.assignment_revision,
            e.bindings_json, e.body_digest
       FROM work_envelopes e
      WHERE e.digest = ?`,
    envelopeDigest
  )
  if (!row) {
    throw mahasError(
      'INPUT_NOT_READY',
      `work envelope ${envelopeDigest} body is not resolvable`,
      'replan'
    )
  }
  let body: unknown
  let bindings: unknown
  const blob = getContentBlob(db, row.body_digest)
  if (!blob) {
    throw mahasError('INPUT_NOT_READY', `work envelope ${envelopeDigest} body is missing`, 'replan')
  }
  try {
    body = JSON.parse(new TextDecoder().decode(blob.bytes))
    bindings = JSON.parse(row.bindings_json)
  } catch {
    throw mahasError('MODEL_INVALID', `work envelope ${envelopeDigest} is malformed`, 'replan')
  }
  const envelopeJson = {
    digest: row.digest,
    kind: row.kind,
    assignmentId: row.assignment_id,
    assignmentRevision: row.assignment_revision,
    body,
    bindings
  }
  const bootstrap = {
    connection: 'Use MAHAS_CONNECTION_FILE to authenticate. Never print or forward its contents.',
    join: {
      operation: 'execution.join',
      payload: {
        executionId: shared.executionId,
        generation: shared.generation,
        bundleDigest: pins.bundle.digest,
        surfaceDigest: pins.surface.digest,
        envelopeDigest
      }
    },
    ...(pins.assignment.kind === 'task' && pins.task && shared.dispatchId
      ? {
          accept: {
            operation: 'task.accept',
            payload: {
              dispatchId: shared.dispatchId,
              taskRevision: pins.task.revision,
              envelopeDigest
            }
          }
        }
      : {}),
    instructions:
      'Call join with these exact pins first; after it commits, call accept if present. A same-operation retry may be needed while launch reaches awaiting_join.'
  }
  return {
    digest: row.digest,
    // The complete pinned payload is supplied, not merely requirementText:
    // inputs, peers and report/settlement terms live in bindings.
    initialText: JSON.stringify({ ...envelopeJson, bootstrap }, null, 2),
    envelopeJson
  }
}

/** sources whose bytes must be available at spawn for text/stdin routes */
function textSources(spec: PlannedProcessSpec): string[] {
  const out = new Set<string>()
  for (const entry of spec.argv) {
    if ('slot' in entry && (entry.slot === 'fileText' || entry.slot === 'configText'))
      out.add(entry.source)
    if ('slot' in entry && entry.slot === 'file') out.add(entry.source)
  }
  if (spec.stdin) out.add(spec.stdin.source)
  return [...out]
}

/** on resume after a confirmed materialize, re-pull file bytes through the
 *  idempotent materializer port (bytes are not stored in receipts) */
async function refillBytes(ctx: StageCtx): Promise<void> {
  const { deps, shared, pins } = ctx
  const want = textSources(ctx.spec).filter((s) => !shared.files.has(s))
  if (!want.length) return
  if (!deps.materialize || !shared.executionRoot) return
  const out = await deps.materialize({
    executionId: shared.executionId!,
    bundleDigest: pins.bundle.digest,
    checkoutPath: shared.checkoutPath!,
    ...(shared.workspaceId ? { workspaceId: shared.workspaceId } : {}),
    memberId: pins.member.id,
    launchPlanId: ctx.plan.id,
    operationKey: effectId(ctx.plan.id, 'materialize'),
    envelope: loadMaterializationEnvelope(ctx),
    wantBytes: textSources(ctx.spec)
  })
  for (const f of out.files) shared.files.set(f.path, f)
}

/** spawn via the execution host — intent row committed BEFORE the call
 *  under the plan-stable effect key + deterministic spawnNonce */
async function stageProcessAttempting(ctx: StageCtx): Promise<StageOutcome> {
  const { db, deps, plan, pins, spec, receipt, shared } = ctx
  const eid = effectId(plan.id, 'spawn')
  const prior = getEffect(db, eid)
  if (prior?.state === 'confirmed') {
    const rec = prior.receipt as {
      processIdentity?: unknown
      terminalId?: string
      evidence?: AttachEvidence[]
    }
    shared.processIdentity = rec.processIdentity
    shared.terminalId = rec.terminalId
    shared.attachEvidence = rec.evidence
    return { receipt: prior.receipt }
  }
  if (prior?.state === 'attempting' || prior?.state === 'unknown') {
    // a prior call's response was lost — NEVER spawn again under a new key
    setEffectState(db, eid, 'unknown', prior.receipt, prior.residuals)
    throw mahasError(
      'START_UNKNOWN',
      'prior host.process.spawn outcome is ambiguous — reconcile, do not respawn',
      'reconcile'
    )
  }
  if (!deps.host)
    throw mahasError(
      'CONTROL_UNAVAILABLE',
      'execution host client not wired (handoff:IMP-17 pending)'
    )
  if (!shared.executionRoot || !shared.checkoutPath) {
    throw mahasError(
      'MANDATORY_COMPONENT_MISSING',
      'execution root / checkout path not materialized',
      'replan'
    )
  }

  // A resumed call hydrates the receipt's paths, not its file bytes.
  // Refill through the idempotent materializer before resolving argv/stdin.
  await refillBytes(ctx)

  // F-053: an execution that already left the start window (start_unknown
  // after a previous ambiguous attempt, awaiting_join after a confirmed-but-
  // unrecorded spawn, …) must never be transitioned back to 'starting' and
  // never be respawned. Normalize the retry to START_UNKNOWN (reconcile)
  // instead of letting transitionExecution throw INVALID_TRANSITION — a
  // wedged-looking code that hides the ambiguity classification.
  const execRow = getRow<{ state: string }>(
    db,
    'SELECT state FROM executions WHERE id=?',
    shared.executionId ?? ''
  )
  if (execRow && execRow.state !== 'preparing' && execRow.state !== 'starting') {
    throw mahasError(
      'START_UNKNOWN',
      `execution ${shared.executionId} is '${execRow.state}' — prior spawn outcome is ambiguous, reconcile via host.effect.get/host.process.probe, do not respawn`,
      'reconcile'
    )
  }

  transitionExecution(ctx, 'starting')

  const launchEnv: Record<string, string> = {
    MAHAS_EXECUTION_ID: shared.executionId!,
    MAHAS_MEMBER_ID: pins.member.id,
    MAHAS_GENERATION: String(shared.generation!),
    MAHAS_CONNECTION_FILE: joinRoot(shared.executionRoot, 'connection/worker')
  }
  const resolveCtx = {
    executionRoot: shared.executionRoot,
    checkoutPath: shared.checkoutPath,
    fileBytes: shared.files,
    digest: deps.digest
  }
  const built = buildSpawnSpec(spec, resolveCtx, launchEnv) // throws ResolveFailure pre-spawn
  const spawnNonce = deps.digest(`spawn:${plan.id}:${shared.executionId}:${shared.generation}`)
  const spawnPayload: Record<string, unknown> = {
    effectKey: eid,
    spawnNonce,
    executionId: shared.executionId,
    generation: shared.generation,
    spec: built.spec
  }
  shared.spawnNonce = spawnNonce
  shared.attachEvidence = built.evidence
  shared.stdinBytes = built.stdinBytes

  // admission wraps worker.start in one IMMEDIATE tx, so this nested tx
  // cannot COMMIT the attempting row before the host call. Do not map a
  // later GRANT_REVOKED onto never-started/rejected — the process may exist.
  tx(db, () => {
    putEffect(db, deps, {
      id: eid,
      operationKey: `worker.start:${plan.id}`,
      kind: 'host.process.spawn',
      hostId: pins.host.id,
      state: 'attempting',
      payload: spawnPayload
    })
    recordStage(receipt, 'process_attempting', { status: 'attempting', effectId: eid }, deps.now())
    saveReceipt(db, deps, receipt)
  })

  const host: HostClient = await deps.host(pins.host.id)
  try {
    const out = (await host.call('host.process.spawn', spawnPayload)) as {
      state?: string
      spawn?: { state?: string; message?: string; error?: { code?: string; message?: string } }
      processIdentity?: unknown
      processIncarnation?: unknown
      terminalId?: string
      error?: { code?: string; message?: string }
    }
    const identity = out?.processIdentity ?? out?.processIncarnation
    const spawnState = out?.spawn?.state ?? out?.state
    if (out && spawnState === 'rejected') {
      tx(db, () => setEffectState(db, eid, 'rejected', out))
      throw mahasError(
        'MANDATORY_COMPONENT_MISSING',
        `host rejected spawn: ${out.spawn?.message ?? out.spawn?.error?.message ?? out.error?.message ?? 'no detail'}`,
        'replan'
      )
    }
    if (!out || !identity) {
      // resolved response with no process identity — ambiguous
      tx(db, () => setEffectState(db, eid, 'unknown', out ?? {}))
      throw mahasError(
        'START_UNKNOWN',
        'host.process.spawn returned no process identity',
        'reconcile'
      )
    }
    shared.processIdentity = identity
    shared.terminalId = out.terminalId
    tx(db, () => {
      setEffectState(db, eid, 'confirmed', {
        processIdentity: identity,
        terminalId: out.terminalId,
        spawnNonce,
        evidence: shared.attachEvidence
      })
    })
    return {
      receipt: { processIdentity: identity, terminalId: out.terminalId, spawnNonce }
    }
  } catch (e) {
    // F-046: same wrapper-aware classification as stageFailure.
    const m = asMahasError(e)
    if (m && (m.code === 'START_UNKNOWN' || m.code === 'MANDATORY_COMPONENT_MISSING')) {
      throw e // already recorded above with the right verdict
    }
    tx(db, () => {
      setEffectState(db, eid, m && SPAWN_NEVER_ADMITTED.has(m.code) ? 'rejected' : 'unknown', {
        error: describeError(e)
      })
    })
    throw e
  }
}

/** commit confirmed process evidence onto the executions row
 *  (cut point: process 확인 후 control DB commit 전) */
async function stageProcessConfirmed(ctx: StageCtx): Promise<StageOutcome> {
  const { db, deps, plan, shared, receipt } = ctx
  if (!shared.processIdentity) {
    const eff = getEffect(db, effectId(plan.id, 'spawn'))
    const rec = eff?.receipt as
      { processIdentity?: unknown; terminalId?: string; evidence?: AttachEvidence[] } | undefined
    if (eff?.state !== 'confirmed' || !rec?.processIdentity) {
      throw mahasError('START_UNKNOWN', 'no confirmed spawn evidence to commit', 'reconcile')
    }
    shared.processIdentity = rec.processIdentity
    shared.terminalId = rec.terminalId
    shared.attachEvidence = rec.evidence
  }
  tx(db, () => {
    runSql(
      db,
      'UPDATE executions SET process_identity_json=?, terminal_id=?, revision=revision+1 WHERE id=?',
      JSON.stringify(shared.processIdentity),
      shared.terminalId ?? null,
      shared.executionId
    )
    emitEvent(
      db,
      deps,
      shared.executionId!,
      currentRevision(db, shared.executionId!),
      'execution.process_confirmed',
      { launchPlanId: plan.id },
      { spawnNonce: shared.spawnNonce, terminalId: shared.terminalId }
    )
    void receipt
  })
  return { receipt: { processIdentity: shared.processIdentity, terminalId: shared.terminalId } }
}

/** injection receipt + transition to awaiting_join. A lost response here
 *  keeps 'unknown' — the same prompt is NEVER re-submitted as a new turn. */
async function stageInitialAttached(ctx: StageCtx): Promise<StageOutcome> {
  const { db, deps, plan, pins, shared, receipt } = ctx
  if (!shared.attachEvidence) {
    const eff = getEffect(db, effectId(plan.id, 'spawn'))
    const rec = eff?.receipt as { evidence?: AttachEvidence[] } | undefined
    shared.attachEvidence = rec?.evidence ?? []
  }
  const evidence = shared.attachEvidence
  const requiredSources = new Set(pins.routes.filter((r) => r.required).map((r) => r.source))
  const attached = new Set(
    evidence.filter((e) => e.byteDigest || e.actualPath).map((e) => e.source)
  )
  const missing = [...requiredSources].filter((s) => !attached.has(s))

  const revision = tx(db, () =>
    writeInjectionReceipt(db, {
      executionId: shared.executionId!,
      phase: 'initial-attachment',
      components: evidence,
      inherited: {
        // S-INJECTION §4: native hidden prompt bytes we cannot read stay
        // unknown — never claimed as fully verified context
        nativeHiddenPrompt: 'unknown',
        note: 'organization/user/project inherited instructions are reported by context.inspect, not re-verified here'
      },
      evidence: {
        launchPlanId: plan.id,
        planDigest: plan.digest,
        spawnNonce: shared.spawnNonce,
        manifestDigest: shared.manifestDigest,
        missingRequiredRoutes: missing
      }
    })
  )

  transitionExecution(ctx, 'awaiting_join')
  recordStage(receipt, 'initial_attached', { status: 'attempting' }, deps.now())

  if (missing.length) {
    // our own attach produced no evidence for a required route — definitive
    // attach failure; the process exists (awaiting_join) but the input
    // verdict is preserved, never silently called delivered
    throw mahasError(
      'MANDATORY_COMPONENT_MISSING',
      `no attach evidence for required routes: ${missing.join(', ')}`,
      'none'
    )
  }
  return {
    receipt: {
      injectionReceiptRevision: revision,
      attached: evidence.length,
      unknownInherited: ['nativeHiddenPrompt']
    }
  }
}

/** terminal coordinator stage — the process is up and awaiting the
 *  agent's own execution.join; nothing left for worker.start to do */
async function stageAwaitingJoin(ctx: StageCtx): Promise<StageOutcome> {
  const { db, shared } = ctx
  const row = getRow<{ state: string }>(
    db,
    'SELECT state FROM executions WHERE id=?',
    shared.executionId!
  )
  return {
    receipt: { joinState: row?.state ?? 'awaiting_join', executionId: shared.executionId }
  }
}

// ---------------------------------------------------------------------------
// execution state transitions (S-LIFECYCLE §1 table)

const ALLOWED: Record<ExecutionState, ExecutionState[]> = {
  preparing: ['starting', 'exited', 'abandoned'],
  starting: ['awaiting_join', 'start_unknown', 'exited'],
  start_unknown: ['awaiting_join', 'exited'], // probe/reconcile only; no re-start
  awaiting_join: ['ready', 'exited', 'stopping'],
  ready: ['ready', 'stopping', 'exited'],
  stopping: ['exited', 'stop_unknown'],
  stop_unknown: ['exited'],
  exited: [],
  abandoned: []
}

function transitionExecution(
  ctx: StageCtx,
  to: ExecutionState,
  liveness?: ExecutionLiveness
): void {
  const { db, deps, shared } = ctx
  if (!shared.executionId) return
  tx(db, () => {
    const row = getRow<ExecutionRow>(db, 'SELECT * FROM executions WHERE id=?', shared.executionId)
    if (!row) return
    if (row.state === to && (!liveness || row.liveness === liveness)) return
    if (!ALLOWED[row.state]?.includes(to)) {
      throw mahasError(
        'INVALID_TRANSITION',
        `execution ${row.state} → ${to} not allowed`,
        'reconcile'
      )
    }
    runSql(
      db,
      'UPDATE executions SET state=?, liveness=?, revision=revision+1 WHERE id=?',
      to,
      liveness ?? row.liveness,
      shared.executionId
    )
    emitEvent(
      db,
      deps,
      shared.executionId!,
      row.revision + 1,
      `execution.${to}`,
      { from: row.state },
      {}
    )
  })
}

function currentRevision(db: DatabaseSync, executionId: string): number {
  return (
    getRow<{ revision: number }>(db, 'SELECT revision FROM executions WHERE id=?', executionId)
      ?.revision ?? 1
  )
}

/** restore shared context from already-confirmed stage receipts */
function hydrateShared(ctx: StageCtx): void {
  const { db, plan, receipt, shared } = ctx
  for (const s of receipt.stages) {
    if (s.status !== 'confirmed') continue
    switch (s.stage) {
      case 'admitted': {
        const r = s.receipt as {
          executionId?: string
          generation?: number
          dispatchId?: string
          deliveryId?: string
          principalId?: string
        }
        shared.executionId = r?.executionId ?? shared.executionId
        shared.generation = r?.generation ?? shared.generation
        shared.principalId =
          r?.principalId ??
          shared.principalId ??
          (shared.executionId ? `principal-${shared.executionId}` : undefined)
        if (r?.dispatchId) shared.dispatchId = r.dispatchId
        if (r?.deliveryId) shared.deliveryId = r.deliveryId
        break
      }
      case 'resources_claimed':
        hydrateClaim(s.receipt, shared)
        break
      case 'components_materialized': {
        const r = s.receipt as { executionRoot?: string; manifestDigest?: string }
        shared.executionRoot = r?.executionRoot ?? shared.executionRoot
        shared.manifestDigest = r?.manifestDigest ?? shared.manifestDigest
        break
      }
      case 'process_attempting': {
        const eff = getEffect(db, effectId(plan.id, 'spawn'))
        const r = (eff?.receipt ?? s.receipt) as {
          processIdentity?: unknown
          terminalId?: string
          spawnNonce?: string
          evidence?: AttachEvidence[]
        }
        shared.processIdentity = r?.processIdentity ?? shared.processIdentity
        shared.terminalId = r?.terminalId ?? shared.terminalId
        shared.spawnNonce = r?.spawnNonce ?? shared.spawnNonce
        shared.attachEvidence = r?.evidence ?? shared.attachEvidence
        break
      }
      default:
        break
    }
  }
}

// ---------------------------------------------------------------------------
// worker.inspect — read-only view + optional explicit host probe

export interface InspectInput {
  executionId?: string
  memberId?: string
  /** explicitly ask the host for live process evidence (C-LAUNCH: 명시 probe) */
  probe?: boolean
}

export async function workerInspect(
  txn: TxnContext,
  payload: unknown,
  deps: ResolvedDeps
): Promise<unknown> {
  const db = txn.db
  const p = payload as InspectInput
  let exec: ExecutionRow | null = null
  if (typeof p.executionId === 'string') {
    exec = getRow<ExecutionRow>(db, 'SELECT * FROM executions WHERE id=?', p.executionId)
  } else if (typeof p.memberId === 'string') {
    exec = getRow<ExecutionRow>(
      db,
      'SELECT * FROM executions WHERE member_id=? ORDER BY generation DESC LIMIT 1',
      p.memberId
    )
  }
  if (!exec) {
    throw mahasError('INPUT_NOT_READY', 'no execution found for the given executionId/memberId')
  }
  const plan = getRow<LaunchPlanRow>(
    db,
    'SELECT * FROM launch_plans WHERE id=?',
    exec.launch_plan_id
  )
  const receipt = plan ? loadReceipt(db, plan.id) : null
  const dispatch = getRow<{
    id: string
    task_id: string
    task_revision: number
    phase: string
    authority_state: string
    assignment_delivery_id: string | null
  }>(db, 'SELECT * FROM dispatches WHERE execution_id=?', exec.id)
  const join = getRow<{ joined_at: number }>(
    db,
    'SELECT joined_at FROM worker_joins WHERE execution_id=? AND generation=?',
    exec.id,
    exec.generation
  )
  const injectionPhases = db
    .prepare(
      'SELECT phase,revision FROM injection_receipts WHERE execution_id=? ORDER BY phase,revision'
    )
    .all(exec.id) as unknown as { phase: string; revision: number }[]

  let liveness: ExecutionLiveness = exec.liveness
  let probeEvidence: unknown = null
  if (p.probe && deps.host) {
    try {
      const host = await deps.host(exec.host_id)
      const processIdentity = JSON.parse(exec.process_identity_json) as unknown
      probeEvidence = await host.call('host.process.probe', {
        processIncarnation: processIdentity,
        expectedProcessIncarnation: processIdentity
      })
      const pl = (probeEvidence as { liveness?: string })?.liveness
      if (pl === 'live' || pl === 'exited' || pl === 'unverifiable') liveness = pl
    } catch (e) {
      // PROCESS_UNVERIFIABLE is a valid state — never a thrown inspect
      liveness = 'unverifiable'
      probeEvidence = { error: describeError(e) }
    }
  } else if (p.probe && !deps.host) {
    probeEvidence = { error: { code: 'CONTROL_UNAVAILABLE', message: 'host client not wired' } }
  }

  return {
    executionId: exec.id,
    memberId: exec.member_id,
    generation: exec.generation,
    hostId: exec.host_id,
    launchPlanId: exec.launch_plan_id,
    planDigest: plan?.digest,
    phase: exec.state,
    liveness,
    terminalId: exec.terminal_id,
    processEvidence: JSON.parse(exec.process_identity_json),
    probe: probeEvidence,
    joined: join ? { joinedAt: join.joined_at } : null,
    taskAuthority: dispatch
      ? {
          dispatchId: dispatch.id,
          taskId: dispatch.task_id,
          taskRevision: dispatch.task_revision,
          phase: dispatch.phase,
          authorityState: dispatch.authority_state,
          assignmentDeliveryId: dispatch.assignment_delivery_id
        }
      : null,
    injectionReceipts: injectionPhases,
    stageReceipt: receipt,
    residuals: receipt?.residuals ?? [],
    failedStage: receipt?.failedStage,
    nextAllowedActions: receipt?.nextAllowedActions ?? []
  }
}
