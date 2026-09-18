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

import type { OperationRegistry, OperationHandler } from '../api/registry.ts'
import { mahasError } from '../api/handler-ports.ts'
import { runCreate, runGet, runClose } from './run.ts'
import { planPrepare, planCommit } from './plan.ts'
import { assignmentPreview, teamAssign, teamRetire, taskDispatch } from './member.ts'
import { registerDispatchOps } from './dispatch-ops.ts'

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

/**
 * Register run.*, plan.*, team.*, assignment.show and task.dispatch.
 * Visibility follows spec/operations.md: run.create is operator-scope, the
 * rest are member-scope (the handlers re-check grants per target).
 */
export function registerCoordinationOps(
  registry: OperationRegistry,
  deps: CoordinationDeps = {}
): void {
  const memberOp = (name: string, mutation: boolean, handler: OperationHandler): void =>
    registry.register({ name, visibility: 'member', mutation }, handler)
  const operatorOp = (name: string, mutation: boolean, handler: OperationHandler): void =>
    registry.register({ name, visibility: 'operator', mutation }, handler)

  operatorOp('run.create', true, runCreate)
  memberOp('run.get', false, runGet)
  memberOp('run.close', true, runClose)
  memberOp('plan.prepare', false, planPrepare)
  memberOp('plan.commit', true, planCommit)
  memberOp('team.assign', true, (txn, payload) =>
    teamAssign(txn, payload, { verifySelectionToken: deps.verifySelectionToken })
  )
  memberOp('team.retire', true, teamRetire)
  memberOp('assignment.preview', false, (txn, payload) =>
    assignmentPreview(txn, payload, { verifySelectionToken: deps.verifySelectionToken }))
  memberOp('assignment.show', false, () => {
    // assignment.show is bootstrap/self-scoped; the concrete projection lives
    // with the launch boundary (IMP-20). Until wired, refuse honestly.
    throw mahasError(
      'UNAVAILABLE_OPERATION',
      'assignment.show is not implemented in this composition',
      'none'
    )
  })
  memberOp('task.dispatch', true, taskDispatch)
}

// dispatch-authority half of the coordination boundary (IMP-14)
export { registerDispatchOps }

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
  settleDispatch,
  checkAttemptAuthority
} from './dispatch-authority.ts'
export type { ReserveDispatchInput, AttemptCheck } from './dispatch-authority.ts'

export { ACCEPTING_DECISIONS } from './input-resolver.ts'
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
