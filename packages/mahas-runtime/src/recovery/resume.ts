// recovery/resume.ts — worker.resume (C-LAUNCH) and the three resume kinds
// of C-RECOVERY kept as SEPARATE functions: reattach (same process proof,
// no spawn), native-resume (verified native conversation handle on a new
// generation), fresh (new role/interface ⇒ new conversation, never an
// inherited one). Task retry is deliberately NOT here — a new Dispatch is
// an authorized decider's explicit task.dispatch, never something the
// recovery loop chooses silently (instruction §4.2, C-RECOVERY table).
//
// native-resume preconditions (C-LAUNCH + C-RECOVERY):
//   · old process dead or in controlled quiescence — exit evidence, not a
//     timeout and not a resume-candidate's say-so
//   · same role/interface/bundle pins as the prior attempt — a changed role
//     can never inherit a past conversation (INTERFACE_STALE → fresh)
//   · a verified resume recipe: resume_candidates row whose support_state
//     is positive AND whose native handle matches what the caller presents
// Effects on admission: prior generation's credentials revoked, inbox
// fencing for the old consumer generation, new generation reserved and the
// SAME launch plan returned for a subsequent worker.start — resume itself
// spawns nothing.

import type { ErrorCode, ProcessIncarnation } from '../../../mahas-contracts/src/index.ts'
import type { TxnContext } from '../api/registry.ts' // IMP-11 — type only
import {
  failure,
  loadExecution,
  loadHost,
  loadLaunchPlan,
  loadMember,
  requireString,
  resumeCandidatesFor,
  type DatabaseSync,
  type ExecutionRow,
  type LaunchPlanRow,
  type MemberRow,
  type NativeConversation,
  type RecoveryDeps,
  type ResumeCandidateRow
} from './ports.ts'
import { assertCurrentControllerEpoch, probeProcess } from './identity-probe.ts'
import { applyProbeVerdict, reattachExecution, type ReattachResult } from './reattach.ts'

export interface WorkerResumePayload {
  memberId: string
  priorExecutionId: string
  resumeKind: 'reattach' | 'native-resume' | 'fresh'
  newAssignment?: { assignmentId: string; assignmentRevision: number }
  nativeHandle?: NativeConversation
  expectedPins?: {
    launchPlanId?: string
    bundleDigest?: string
    interfaceDigest?: string
    implementationId?: string
    implementationRevision?: number
  }
}

export interface WorkerResumeResult {
  resumeKind: 'reattach' | 'native-resume' | 'fresh'
  /** connected = existing execution re-bound · verified = admission passed, start pending · rejected/unknown = honest negatives */
  admission: 'connected' | 'verified' | 'rejected' | 'unknown'
  code?: ErrorCode
  memberId: string
  priorExecutionId: string
  execution?: { id: string; generation: number; state: string; liveness: string }
  newGeneration?: number
  launchPlanId?: string
  planDigest?: string
  planReusable?: boolean
  nativeHandle?: NativeConversation
  fencedDeliveryIds?: string[]
  basis: string
  nextAllowedActions: string[]
}

function readResumePayload(payload: unknown): WorkerResumePayload {
  const p = (payload ?? {}) as Record<string, unknown>
  const kind = p.resumeKind
  if (kind !== 'reattach' && kind !== 'native-resume' && kind !== 'fresh') {
    throw failure(
      'INVALID_TRANSITION',
      "resumeKind must be 'reattach' | 'native-resume' | 'fresh'",
      'none'
    )
  }
  const newAssignment =
    typeof p.newAssignment === 'object' && p.newAssignment !== null
      ? (p.newAssignment as { assignmentId: string; assignmentRevision: number })
      : undefined
  const nativeHandle =
    typeof p.nativeHandle === 'object' && p.nativeHandle !== null
      ? (p.nativeHandle as NativeConversation)
      : undefined
  const expectedPins =
    typeof p.expectedPins === 'object' && p.expectedPins !== null
      ? (p.expectedPins as WorkerResumePayload['expectedPins'])
      : undefined
  return {
    memberId: requireString(p.memberId, 'memberId'),
    priorExecutionId: requireString(p.priorExecutionId, 'priorExecutionId'),
    resumeKind: kind,
    newAssignment,
    nativeHandle,
    expectedPins
  }
}

// ---------------------------------------------------------------------------
// shared guards
// ---------------------------------------------------------------------------

function loadPriorForMember(
  db: DatabaseSync,
  member: MemberRow,
  priorExecutionId: string
): ExecutionRow {
  const exec = loadExecution(db, priorExecutionId)
  if (!exec) {
    throw failure(
      'INVALID_TRANSITION',
      `prior execution ${priorExecutionId} does not exist`,
      'none'
    )
  }
  if (exec.memberId !== member.id) {
    throw failure(
      'STALE_EXECUTION',
      `execution ${priorExecutionId} belongs to member ${exec.memberId}, not ${member.id} — resume cannot cross member identity`,
      'replan'
    )
  }
  // a newer generation already current for this member → resuming the old
  // one would regress the current target (REQ-15)
  if (member.currentExecutionId && member.currentExecutionId !== exec.id) {
    const current = loadExecution(db, member.currentExecutionId)
    if (current && current.generation > exec.generation) {
      throw failure(
        'STALE_EXECUTION',
        `member ${member.id} already has generation ${current.generation} as current — generation ${exec.generation} may not be re-pointed`,
        'replan',
        { memberId: member.id, currentExecutionId: current.id }
      )
    }
  }
  return exec
}

/** fence the old consumer generation's outstanding deliveries — rows kept, ack authority dropped */
function fenceInboxForOldGeneration(
  db: DatabaseSync,
  member: MemberRow,
  throughGeneration: number
): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM deliveries
       WHERE recipient_member_id=? AND status='outstanding' AND consumer_generation<=?`
    )
    .all(member.id, throughGeneration) as Array<{ id: string }>
  const fenced: string[] = []
  for (const r of rows) {
    db.prepare(`UPDATE deliveries SET status='fenced', revision=revision+1 WHERE id=?`).run(r.id)
    fenced.push(r.id)
  }
  return fenced
}

function revokeGenerationCredentials(
  deps: RecoveryDeps,
  db: DatabaseSync,
  exec: ExecutionRow
): void {
  db.prepare(
    `UPDATE execution_credentials SET revoked_at=?, revision=revision+1
     WHERE execution_id=? AND generation=? AND revoked_at IS NULL`
  ).run(deps.now(), exec.id, exec.generation)
}

// ---------------------------------------------------------------------------
// kind: reattach — same process proof, zero spawn
// ---------------------------------------------------------------------------

async function resumeByReattach(
  deps: RecoveryDeps,
  db: DatabaseSync,
  member: MemberRow,
  exec: ExecutionRow
): Promise<WorkerResumeResult> {
  if (exec.state === 'exited' && exec.processIdentity.observedExit) {
    return {
      resumeKind: 'reattach',
      admission: 'rejected',
      code: 'INVALID_TRANSITION',
      memberId: member.id,
      priorExecutionId: exec.id,
      execution: {
        id: exec.id,
        generation: exec.generation,
        state: exec.state,
        liveness: exec.liveness
      },
      basis:
        'prior execution is already recorded exited with exit evidence — reattach cannot resurrect it; use native-resume or fresh',
      nextAllowedActions: ['worker.resume', 'worker.release']
    }
  }
  const host = loadHost(db, exec.hostId)
  if (!host) {
    throw failure(
      'CONTROL_UNAVAILABLE',
      `execution host ${exec.hostId} has no control mirror`,
      'reconcile'
    )
  }
  const r: ReattachResult = await reattachExecution(deps, db, exec, host)
  if (r.reattached) {
    return {
      resumeKind: 'reattach',
      admission: 'connected',
      memberId: member.id,
      priorExecutionId: exec.id,
      execution: {
        id: r.executionId,
        generation: r.generation,
        state: r.state,
        liveness: r.liveness
      },
      basis: r.basis,
      nextAllowedActions: r.nextAllowedActions
    }
  }
  return {
    resumeKind: 'reattach',
    admission: r.liveness === 'unverifiable' ? 'unknown' : 'rejected',
    code: r.liveness === 'unverifiable' ? 'PROCESS_UNVERIFIABLE' : 'INVALID_TRANSITION',
    memberId: member.id,
    priorExecutionId: exec.id,
    execution: {
      id: r.executionId,
      generation: r.generation,
      state: r.state,
      liveness: r.liveness
    },
    basis: r.basis,
    nextAllowedActions: r.nextAllowedActions
  }
}

// ---------------------------------------------------------------------------
// kind: native-resume — verified handle on a NEW generation
// ---------------------------------------------------------------------------

const SUPPORTED_RESUME_STATES: ReadonlySet<string> = new Set(['supported', 'verified'])

function findResumeCandidate(
  candidates: ResumeCandidateRow[],
  handle: NativeConversation,
  plan: LaunchPlanRow
): ResumeCandidateRow | null {
  for (const c of candidates) {
    if (!SUPPORTED_RESUME_STATES.has(c.supportState)) continue
    if (c.nativeHandle.nativeId !== handle.nativeId) continue
    if (c.nativeHandle.harnessProfileId !== handle.harnessProfileId) continue
    // the recipe must belong to the SAME profile pin family as the launch plan
    const planProfile = plan.pins['harnessProfileId'] ?? plan.pins['profileId']
    if (typeof planProfile === 'string' && planProfile !== c.nativeHandle.harnessProfileId) continue
    return c
  }
  return null
}

function assertSameRoleInterfaceBundle(
  member: MemberRow,
  plan: LaunchPlanRow,
  pins: WorkerResumePayload['expectedPins']
): void {
  // the member's CURRENT implementation pin must still be the plan's pin —
  // a changed role/interface may not inherit a past conversation
  const pinImpl = plan.pins['implementationId']
  const pinImplRev = plan.pins['implementationRevision']
  if (typeof pinImpl === 'string' && pinImpl !== member.implementationId) {
    throw failure(
      'INTERFACE_STALE',
      `member implementation moved from plan pin ${pinImpl} to ${member.implementationId} — changed role requires a fresh resume, not conversation inheritance`,
      'replan'
    )
  }
  if (typeof pinImplRev === 'number' && pinImplRev !== member.implementationRevision) {
    throw failure(
      'INTERFACE_STALE',
      `member implementation revision ${member.implementationRevision} no longer matches plan pin ${pinImplRev} — changed role requires a fresh resume`,
      'replan'
    )
  }
  if (pins?.launchPlanId && pins.launchPlanId !== plan.id) {
    throw failure(
      'INTERFACE_STALE',
      `expectedPins.launchPlanId ${pins.launchPlanId} is not the prior plan ${plan.id}`,
      'replan'
    )
  }
  if (pins?.bundleDigest && pins.bundleDigest !== plan.bundleDigest) {
    throw failure(
      'INTERFACE_STALE',
      `bundle digest mismatch — ${pins.bundleDigest} vs plan ${plan.bundleDigest}`,
      'replan'
    )
  }
  if (pins?.interfaceDigest) {
    const pinned = plan.pins['interfaceDigest']
    if (typeof pinned === 'string' && pinned !== pins.interfaceDigest) {
      throw failure(
        'INTERFACE_STALE',
        `interface digest mismatch — ${pins.interfaceDigest} vs plan pin ${pinned}`,
        'replan'
      )
    }
  }
}

async function resumeByNativeHandle(
  deps: RecoveryDeps,
  db: DatabaseSync,
  member: MemberRow,
  exec: ExecutionRow,
  input: WorkerResumePayload
): Promise<WorkerResumeResult> {
  const base = {
    resumeKind: 'native-resume' as const,
    memberId: member.id,
    priorExecutionId: exec.id
  }

  const handle = input.nativeHandle
  if (!handle || typeof handle.nativeId !== 'string' || handle.nativeId.length === 0) {
    throw failure(
      'INJECTION_UNSUPPORTED',
      'native-resume requires a nativeHandle with a nativeId',
      'none'
    )
  }
  const plan = loadLaunchPlan(db, exec.launchPlanId)
  if (!plan) {
    throw failure(
      'CONTROL_UNAVAILABLE',
      `launch plan ${exec.launchPlanId} missing — cannot verify resume recipe`,
      'reconcile'
    )
  }
  assertSameRoleInterfaceBundle(member, plan, input.expectedPins)

  const candidates = resumeCandidatesFor(db, exec.id)
  const candidate = findResumeCandidate(candidates, handle, plan)
  if (!candidate) {
    throw failure(
      'INJECTION_UNSUPPORTED',
      `no supported resume recipe for execution ${exec.id} with nativeId ${handle.nativeId} — native resume requires a verified route`,
      'none',
      { candidateCount: candidates.length }
    )
  }

  // old process must be dead or in controlled quiescence — evidence, not timeout
  let workingExec = exec
  if (exec.state !== 'exited') {
    const host = loadHost(db, exec.hostId)
    if (!host) {
      return {
        ...base,
        admission: 'unknown',
        code: 'PROCESS_UNVERIFIABLE',
        basis: `execution host ${exec.hostId} has no control mirror — the old process cannot be proven dead`,
        nextAllowedActions: ['runtime.reconcile']
      }
    }
    const verdict = await probeProcess(deps, db, host, exec)
    const applied = applyProbeVerdict(deps, db, exec, verdict)
    workingExec = applied.exec
    if (verdict.liveness === 'live') {
      return {
        ...base,
        admission: 'rejected',
        code: 'OPERATION_CONFLICT',
        execution: {
          id: exec.id,
          generation: exec.generation,
          state: workingExec.state,
          liveness: 'live'
        },
        basis:
          'old process verified LIVE — native-resume needs dead/quiescent; use reattach for the same process',
        nextAllowedActions: ['worker.resume']
      }
    }
    if (verdict.liveness === 'unverifiable') {
      return {
        ...base,
        admission: 'unknown',
        code: 'PROCESS_UNVERIFIABLE',
        execution: {
          id: exec.id,
          generation: exec.generation,
          state: workingExec.state,
          liveness: 'unverifiable'
        },
        basis: `old process could not be proven dead: ${verdict.unverifiableReason ?? 'no verdict'} — native-resume does not proceed on a maybe-live process`,
        nextAllowedActions: ['runtime.reconcile']
      }
    }
  }

  // admission verified — new generation + credential fence + inbox fence
  const newGeneration = workingExec.generation + 1
  revokeGenerationCredentials(deps, db, workingExec)
  const fencedDeliveryIds = fenceInboxForOldGeneration(db, member, workingExec.generation)
  if (member.currentExecutionId === workingExec.id) {
    db.prepare('UPDATE members SET current_execution_id=NULL, revision=revision+1 WHERE id=?').run(
      member.id
    )
  }
  if (member.generation < newGeneration) {
    db.prepare('UPDATE members SET generation=?, revision=revision+1 WHERE id=?').run(
      newGeneration,
      member.id
    )
  }
  deps.appendDomainEvent(
    db,
    member.id,
    member.revision + 1,
    'execution.native-resume-admitted',
    { operation: 'worker.resume', priorExecutionId: workingExec.id },
    {
      newGeneration,
      nativeHandle: handle,
      resumeCandidateId: candidate.id,
      launchPlanId: plan.id,
      fencedDeliveries: fencedDeliveryIds.length
    }
  )

  const planReusable = plan.state === 'prepared' || plan.state === 'committed'
  return {
    ...base,
    admission: 'verified',
    execution: {
      id: workingExec.id,
      generation: workingExec.generation,
      state: workingExec.state,
      liveness: workingExec.liveness
    },
    newGeneration,
    launchPlanId: plan.id,
    planDigest: plan.digest,
    planReusable,
    nativeHandle: handle,
    fencedDeliveryIds,
    basis:
      'old process proven dead, resume recipe verified against the same role/interface/bundle pins — ' +
      'the native handle is admitted for a NEW process generation (separate start intent + new credential); ' +
      'resume itself spawns nothing',
    nextAllowedActions: planReusable ? ['worker.start'] : ['worker.prepare', 'worker.start']
  }
}

// ---------------------------------------------------------------------------
// kind: fresh — new role/interface ⇒ new conversation, never inherited
// ---------------------------------------------------------------------------

function resumeFresh(
  deps: RecoveryDeps,
  db: DatabaseSync,
  member: MemberRow,
  exec: ExecutionRow,
  input: WorkerResumePayload
): WorkerResumeResult {
  if (input.nativeHandle) {
    throw failure(
      'INVALID_TRANSITION',
      'a fresh resume does not accept nativeHandle — carrying a past conversation into a changed role is exactly what fresh forbids',
      'none'
    )
  }
  // new consumer generation ⇒ the old attempt's ack authority is fenced here
  const fencedDeliveryIds = fenceInboxForOldGeneration(db, member, exec.generation)
  const newGeneration = exec.generation + 1
  if (member.generation < newGeneration) {
    db.prepare('UPDATE members SET generation=?, revision=revision+1 WHERE id=?').run(
      newGeneration,
      member.id
    )
  }
  deps.appendDomainEvent(
    db,
    member.id,
    member.revision + 1,
    'execution.fresh-resume-admitted',
    { operation: 'worker.resume', priorExecutionId: exec.id },
    { newGeneration, newAssignment: input.newAssignment ?? null }
  )
  return {
    resumeKind: 'fresh',
    admission: 'verified',
    memberId: member.id,
    priorExecutionId: exec.id,
    execution: {
      id: exec.id,
      generation: exec.generation,
      state: exec.state,
      liveness: exec.liveness
    },
    newGeneration,
    fencedDeliveryIds,
    basis:
      'fresh start admitted — new conversation, new bundle, new credential. ' +
      'The prior conversation is NOT inherited (no reviewed migration exists in v1); ' +
      'a new assignment/plan must select the new role/interface explicitly',
    nextAllowedActions: input.newAssignment
      ? ['worker.prepare', 'worker.start']
      : ['team.assign', 'worker.prepare']
  }
}

// ---------------------------------------------------------------------------
// the operation handler
// ---------------------------------------------------------------------------

export function makeResumeHandler(deps: RecoveryDeps) {
  return async function workerResume(
    txn: TxnContext,
    payload: unknown
  ): Promise<WorkerResumeResult> {
    const { db, ctx } = txn
    const input = readResumePayload(payload)

    deps.authorize(ctx, 'worker.resume', [{ kind: 'member', id: input.memberId }])
    assertCurrentControllerEpoch(db, ctx)

    const member = loadMember(db, input.memberId)
    if (!member) {
      throw failure('INVALID_TRANSITION', `member ${input.memberId} does not exist`, 'none')
    }
    // a stale-generation credential may not drive resume decisions for the member
    if (
      ctx.memberId === member.id &&
      ctx.executionGeneration !== undefined &&
      ctx.executionGeneration < member.generation
    ) {
      throw failure(
        'STALE_EXECUTION',
        `caller generation ${ctx.executionGeneration} predates member generation ${member.generation} — stale ack authority cannot steer resume`,
        'replan'
      )
    }
    const exec = loadPriorForMember(db, member, input.priorExecutionId)

    switch (input.resumeKind) {
      case 'reattach':
        return resumeByReattach(deps, db, member, exec)
      case 'native-resume':
        return resumeByNativeHandle(deps, db, member, exec, input)
      case 'fresh':
        return resumeFresh(deps, db, member, exec, input)
    }
  }
}

// ProcessIncarnation re-export for handler consumers that validate expected incarnations
export type { ProcessIncarnation }
