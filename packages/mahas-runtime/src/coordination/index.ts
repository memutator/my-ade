// mahas-runtime/coordination — C-WORK boundary entrypoint (IMP-13/14).
//
// registerCoordinationOps wires the Task/Member/Plan/Run operations into
// IMP-11's OperationRegistry. The dispatch-authority ops (task.accept's
// dispatch half, attempt authority) live in ./dispatch-ops.ts (IMP-14) and
// are registered by the same composition root.
//
// The selection-token port is defined here so team.assign/team.preview share
// one type without importing IMP-06's discovery internals: the composition
// root adapts discovery's verified claims into these pins. The token states
// what was SHOWN; it is never the authorization basis (C-DISCOVERY §14).

import type { OperationHandler, OperationRegistry, TargetRef, TxnContext } from '../api/registry.ts'
import { runCreate, runGet, runClose } from './run.ts'
import { planPrepare, planCommit } from './plan.ts'
import { assignmentPreview, assignmentShow, teamAssign, teamRetire, taskDispatch } from './member.ts'
import { registerDispatchOps } from './dispatch-ops.ts'
import { asObject, optStr, one } from './internal.ts'
import { registerSettlementOps } from './settlement-ops.ts'

/* ── selection token port (implemented by the composition root) ───────── */

/** what a verified selection token pins about the shown candidate */
export interface SelectionTokenPins {
  tokenId?: string
  projectId?: string
  modelVersion: string
  roleId: string
  /** the role row digest as shown (stale-model detection) */
  roleDigest?: string
  /** the implementation chosen by the caller (payload may carry it when the
   *  token only pinned the role candidate set) */
  implementationId?: string
  implementationRevision?: number
  implementationDigest?: string
  interfaceDigest?: string
  /** digest of the exact implementation candidate shown, when pinned */
  implementationCandidateDigest?: string
  scope?: { scopeBoundaryId?: string; runId?: string }
  issuedAt?: number
  [key: string]: unknown
}

/** verify signature/integrity; return the pins or null (never a fake pass) */
export type VerifySelectionToken = (token: string) => SelectionTokenPins | null

/* ── C-WORK registration ─────────────────────────────────────────────── */

export interface CoordinationDeps {
  verifySelectionToken?: VerifySelectionToken
  now?: () => number
}

function payloadTargets(txn: TxnContext, payload: unknown): TargetRef[] {
  const p = asObject(payload ?? {}, 'resolveTargets')
  const out: TargetRef[] = []
  const runId = optStr(p, 'runId', 'resolveTargets')
  const taskId = optStr(p, 'taskId', 'resolveTargets')
  const memberId = optStr(p, 'memberId', 'resolveTargets')
  if (runId) out.push({ kind: 'run', id: runId })
  if (taskId) out.push({ kind: 'task', id: taskId })
  if (memberId) out.push({ kind: 'member', id: memberId })
  const candidatePlanId = optStr(p, 'candidatePlanId', 'resolveTargets')
  if (candidatePlanId) {
    const row = one(txn.db, 'SELECT run_id FROM plan_candidates WHERE id=?', candidatePlanId)
    if (row) out.push({ kind: 'run', id: row.run_id as string })
  }
  return out
}

function resolveWorkRevisions(
  txn: TxnContext,
  entityIds: readonly string[],
  axis: 'plan' | 'run'
): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {}
  for (const id of entityIds) {
    const run = one(
      txn.db,
      'SELECT id, revision, current_plan_revision FROM runs WHERE id=?',
      id
    )
    if (run) {
      out[id] =
        axis === 'plan'
          ? ((run.current_plan_revision as number | null) ?? 0)
          : (run.revision as number)
      continue
    }
    const member = one(txn.db, 'SELECT revision FROM members WHERE id=?', id)
    if (member) {
      out[id] = member.revision as number
      continue
    }
    const task = one(txn.db, 'SELECT current_revision FROM tasks WHERE id=?', id)
    if (task) out[id] = task.current_revision as number
  }
  return out
}

/**
 * Register run.*, plan.*, team.*, assignment.show and task.dispatch.
 * Visibility follows spec/operations.md: run.create is operator-scope, the
 * rest are member-scope (the handlers re-check grants per target).
 */
export function registerCoordinationOps(
  registry: OperationRegistry,
  deps: CoordinationDeps = {}
): void {
  const memberOp = (
    name: string,
    mutation: boolean,
    handler: OperationHandler,
    axis: 'plan' | 'run' = 'run'
  ): void =>
    registry.register(
      {
        name,
        visibility: 'member',
        mutation,
        resolveTargets: payloadTargets,
        resolveRevisions: (txn, ids) => resolveWorkRevisions(txn, ids, axis)
      },
      handler
    )
  const operatorOp = (name: string, mutation: boolean, handler: OperationHandler): void =>
    registry.register(
      {
        name,
        visibility: 'operator',
        mutation,
        resolveTargets: payloadTargets,
        resolveRevisions: (txn, ids) => resolveWorkRevisions(txn, ids, 'run')
      },
      handler
    )

  operatorOp('run.create', true, runCreate)
  memberOp('run.get', false, runGet, 'run')
  memberOp('run.close', true, runClose, 'plan')
  memberOp('plan.prepare', true, planPrepare, 'plan')
  memberOp('plan.commit', true, planCommit, 'plan')
  memberOp(
    'team.assign',
    true,
    (txn, payload) => teamAssign(txn, payload, { verifySelectionToken: deps.verifySelectionToken }),
    'plan'
  )
  memberOp('team.retire', true, teamRetire, 'run')
  memberOp(
    'assignment.preview',
    false,
    (txn, payload) =>
      assignmentPreview(txn, payload, { verifySelectionToken: deps.verifySelectionToken }),
    'plan'
  )
  memberOp('assignment.show', false, assignmentShow, 'run')
  memberOp('task.dispatch', true, taskDispatch, 'plan')
  registerSettlementOps(registry)
}

// dispatch-authority half of the coordination boundary (IMP-14)
export { registerDispatchOps }
export { registerSettlementOps } from './settlement-ops.ts'

/* ── public surface ──────────────────────────────────────────────────── */

export { runCreate, runGet, runClose } from './run.ts'
export type {
  RunCreateInput,
  RunCreateResult,
  RunGetInput,
  RunCloseInput,
  RunCloseResult
} from './run.ts'

export { planOf, loadPlanTasks, loadPlanEdges, planPrepare, planCommit } from './plan.ts'
export type {
  TaskSpecPatch,
  EdgePatch,
  AttemptDisposition,
  PlanPatch,
  PlanPrepareInput,
  PlanPrepareResult,
  PlanCommitInput,
  PlanCommitResult
} from './plan.ts'

export {
  teamAssign,
  teamRetire,
  taskDispatch,
  assignmentShow,
  decodeAndCheckToken,
  recheckImplementation,
  checkProvisioning,
  requiredActionsFor
} from './member.ts'
export type {
  AssignmentPreviewResult,
  TeamAssignInput,
  TeamAssignResult,
  TeamRetireInput,
  TeamRetireResult,
  TaskDispatchInput,
  TaskDispatchResult,
  ImplementationCheck,
  ProvisioningScope,
  ProvisioningCheck
} from './member.ts'

export { computeEligibility, resolveInputBindings, edgeSettlementSatisfied } from './eligibility.ts'
export type { TaskEligibility, PendingInput } from './eligibility.ts'

export { createDispatch, DISPATCH_OPS } from './dispatch-ops.ts'
export type {
  CreateDispatchInput,
  CreateDispatchResult,
  DispatchServiceDeps
} from './dispatch-ops.ts'

export {
  createTask,
  getTask,
  getTaskSpec,
  getCurrentTaskSpec,
  putTaskSpecRevision
} from './task-spec.ts'
export type { TaskSpecContent } from './task-spec.ts'

export {
  buildTaskEnvelope,
  buildCoordinationEnvelope,
  getWorkEnvelope,
  ENVELOPE_MEDIA_TYPE
} from './work-envelope.ts'
export type { PeerRef, StoredEnvelope } from './work-envelope.ts'

export {
  getDispatch,
  getActiveDispatchForTask,
  getActiveDispatchForExecution,
  reserveDispatch,
  linkAssignmentDelivery,
  advanceDispatchPhase,
  acceptDispatch,
  fenceDispatch,
  revokeDispatchAuthority,
  settleDispatch,
  checkAttemptAuthority
} from './dispatch-authority.ts'
export type { ReserveDispatchInput, AttemptCheck } from './dispatch-authority.ts'

export { ACCEPTING_DECISIONS } from './input-resolver.ts'
export {
  insertOutcomeRevision,
  loadOutcome,
  policyOf,
  isOwnerDeclaration,
  isDesignatedAcceptance
} from './outcome.ts'
export { insertSettlement, normalizeDecision, loadSettlement } from './settlement.ts'
export { recordAcceptedHandoff } from './handoff.ts'
export type { BindingSpec, PinnedInput, UnresolvedInput } from './input-resolver.ts'

export {
  toRun,
  toMember,
  toAssignment,
  toPlan,
  toTask,
  toTaskSpec,
  toTaskEdge,
  toDispatch,
  toGrant
} from './internal.ts'
