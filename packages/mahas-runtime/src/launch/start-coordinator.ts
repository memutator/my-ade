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
import {
  describeError,
  emitEvent,
  getRow,
  isMahasError,
  mahasError,
  newCredentialSecret,
  runSql,
  tx,
  type MaterializedFile,
  type ResolvedDeps
} from './deps.ts'
import type { LaunchPins } from './planner.ts'
import {
  buildConnectionFile,
  buildSpawnSpec,
  stdinDigest,
  writeInjectionReceipt,
  joinRoot,
  type AttachEvidence,
  type PlannedProcessSpec
} from './initial-attachment.ts'
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
 *  negative, NOT unknown. Everything else thrown is ambiguous. */
const SPAWN_NEVER_ADMITTED = new Set([
  'HOST_PROTOCOL_MISMATCH',
  'UNAUTHENTICATED',
  'SCOPE_DENIED',
  'GRANT_REVOKED',
  'STALE_EXECUTION'
])

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

  // same plan already driven to its terminal stage → the same receipt
  if (receipt.terminal) return result(receipt)

  const ctx: StageCtx = { db, txn, deps, plan, pins, spec, receipt, shared: { files: new Map() } }
  hydrateShared(ctx)

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
      const retryable = entry.nextAllowedActions?.includes('retry:same-operation') ?? false
      if (!retryable) {
        receipt.failedStage = stage
        receipt.nextAllowedActions = entry.nextAllowedActions ?? ['replan']
        saveReceipt(db, deps, receipt)
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
      saveReceipt(db, deps, receipt)
    } catch (e) {
      const verdict = stageFailure(stage, e)
      recordStage(
        receipt,
        stage,
        {
          status: verdict.status,
          error: verdict.error,
          residuals: verdict.residuals,
          nextAllowedActions: verdict.next
        },
        deps.now()
      )
      addResiduals(receipt, verdict.residuals)
      if (verdict.executionState) transitionExecution(ctx, verdict.executionState, verdict.liveness)
      receipt.failedStage = stage
      receipt.nextAllowedActions = verdict.next
      saveReceipt(db, deps, receipt)
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

function result(r: LaunchReceipt): StartResult {
  const last = r.stages.filter((s) => s.status === 'confirmed').at(-1)
  return {
    launchPlanId: r.launchPlanId,
    ...(r.executionId ? { executionId: r.executionId } : {}),
    ...(r.generation !== undefined ? { generation: r.generation } : {}),
    ...(r.dispatchId ? { dispatchId: r.dispatchId } : {}),
    joinState:
      r.terminal ??
      (r.failedStage ? `${r.failedStage}:${last?.status ?? 'failed'}` : 'in-progress'),
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
  const m = isMahasError(e) ? e : null

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
          m?.code === 'INTERFACE_STALE' || m?.code === 'INPUT_NOT_READY'
            ? ['replan']
            : ['retry:same-operation', 'replan']
      }
    case 'resources_claimed':
      if (m) {
        return {
          status: 'failed',
          error,
          next:
            m.code === 'RESOURCE_BUSY' || m.code === 'CONTROL_UNAVAILABLE'
              ? ['retry:same-operation', 'replan']
              : ['replan']
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
    const principalId = deps.newId('principal')

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
     VALUES (?,?,?,?,?,?,?,'assigned','active',?,1)`,
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
  if (prior?.state === 'confirmed') {
    hydrateClaim(prior.receipt, shared)
    return { receipt: prior.receipt, residuals: claimResiduals(shared) }
  }
  if (!deps.call) {
    throw mahasError(
      'CONTROL_UNAVAILABLE',
      'workspace.prepare caller not wired (handoff:IMP-11/IMP-16 pending)'
    )
  }
  const payload = {
    reservationId: `${plan.id}:checkout`,
    placementIntent: pins.placementIntent,
    owner: { kind: 'execution', id: shared.executionId },
    memberId: pins.member.id,
    runId: pins.run.id,
    purpose: pins.purpose,
    mode: 'write'
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
  try {
    const out = (await deps.call(txn.ctx, 'workspace.prepare', payload)) as {
      checkoutId?: string
      checkoutPath?: string
      workspaceId?: string
      claims?: unknown[]
    }
    if (!out || typeof out.checkoutPath !== 'string') {
      throw mahasError(
        'CONTROL_UNAVAILABLE',
        'workspace.prepare returned no canonical checkout path'
      )
    }
    tx(db, () => {
      setEffectState(db, eid, 'confirmed', out, out.claims ?? [])
      hydrateClaim(out, shared)
    })
    return { receipt: out, residuals: claimResiduals(shared) }
  } catch (e) {
    tx(db, () => {
      setEffectState(db, eid, isMahasError(e) ? 'rejected' : 'unknown', { error: describeError(e) })
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

  const wantBytes = textSources(spec)
  const secret = newCredentialSecret()
  shared.secret = secret
  const secretFiles = [
    {
      path: 'connection/worker',
      bytes: buildConnectionFile({
        ...(deps.endpoint ? { endpoint: deps.endpoint } : {}),
        executionId: shared.executionId!,
        generation: shared.generation!,
        token: secret
      })
    }
  ]
  const payload = {
    executionId: shared.executionId,
    bundleDigest: pins.bundle.digest,
    checkoutPath: shared.checkoutPath,
    workspaceId: shared.workspaceId,
    wantBytes,
    secretFiles: secretFiles.map((f) => f.path) // effect payload lists paths, never bytes
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
      wantBytes,
      secretFiles
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
    tx(db, () => {
      setEffectState(db, eid, 'confirmed', publicReceipt, out.residuals ?? [])
      // bootstrap credential — secret HASH only; raw secret stays in the
      // connection file bytes and in memory, never in this DB
      runSql(
        db,
        `INSERT INTO execution_credentials(id,secret_hash,principal_id,execution_id,generation,mode,revoked_at,revision)
         VALUES (?,?,?,?,?,'bootstrap',NULL,1)`,
        deps.newId('credential'),
        deps.digest(secret),
        shared.principalId,
        shared.executionId,
        shared.generation
      )
    })
    return { receipt: publicReceipt, residuals: out.residuals }
  } catch (e) {
    tx(db, () => {
      setEffectState(db, eid, isMahasError(e) ? 'rejected' : 'unknown', { error: describeError(e) })
    })
    throw e
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

  transitionExecution(ctx, 'starting')

  const launchEnv: Record<string, string> = {
    MAHAS_EXECUTION_ID: shared.executionId!,
    MAHAS_MEMBER_ID: pins.member.id,
    MAHAS_GENERATION: String(shared.generation!),
    MAHAS_CONNECTION_FILE: joinRoot(shared.executionRoot, 'connection/worker'),
    ...(deps.endpoint ? { MAHAS_ENDPOINT: deps.endpoint } : {})
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
  if (built.stdinBytes) {
    // stdin route — bytes ride the spawn payload because the host cannot
    // read control-plane content_blobs (payload extension reconciles with
    // handoff:IMP-18; documented in the IMP-19 handoff)
    spawnPayload.initialStdin = {
      digest: stdinDigest(built.stdinBytes),
      mediaType: 'text/plain',
      sizeBytes: built.stdinBytes.byteLength,
      bytesB64: Buffer.from(built.stdinBytes).toString('base64')
    }
  }
  shared.spawnNonce = spawnNonce
  shared.attachEvidence = built.evidence
  shared.stdinBytes = built.stdinBytes

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
      processIdentity?: unknown
      processIncarnation?: unknown
      terminalId?: string
      error?: { code?: string; message?: string }
    }
    const identity = out?.processIdentity ?? out?.processIncarnation
    if (out && out.state === 'rejected') {
      tx(db, () => setEffectState(db, eid, 'rejected', out))
      throw mahasError(
        'MANDATORY_COMPONENT_MISSING',
        `host rejected spawn: ${out.error?.message ?? 'no detail'}`,
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
    if (
      isMahasError(e) &&
      (e.code === 'START_UNKNOWN' || e.code === 'MANDATORY_COMPONENT_MISSING')
    ) {
      throw e // already recorded above with the right verdict
    }
    tx(db, () => {
      setEffectState(
        db,
        eid,
        isMahasError(e) && SPAWN_NEVER_ADMITTED.has(e.code) ? 'rejected' : 'unknown',
        { error: describeError(e) }
      )
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
        shared.principalId = r?.principalId ?? shared.principalId
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
      probeEvidence = await host.call('host.process.probe', { processIncarnation: processIdentity })
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
