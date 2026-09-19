// mahas-contracts/operations/workbench — C-WORK DTOs used by the desktop
// workbench.
//
// These are wire projections, deliberately separate from the persisted
// domain records. IDs and revisions are plain JSON values here; runtime owns
// branding, row mapping, authorization, and command receipt handling.

// ── assignment.preview / team.assign ─────────────────────────────────────

export type AssignmentKind = 'coordination' | 'task'

export interface AssignmentPreviewRequest {
  runId: string
  selectionToken: string
  implementationId?: string
  implementationRevision: number
  assignmentKind: AssignmentKind
  mandateText: string
  taskId?: string
  taskRevision?: number
  placementIntent?: Record<string, unknown>
}

export interface TeamAssignRequest extends AssignmentPreviewRequest {
  expectedPlanRevision?: number
}

export interface AssignmentPreviewResult {
  proposedMember: {
    runId: string
    roleId: string
    implementationId: string
    implementationRevision: number
    state: 'pending'
  }
  proposedAssignment: {
    kind: AssignmentKind
    mandateText: string
    taskId?: string
    taskRevision?: number
  }
  requiredActions: string[]
  grantCoverage: {
    grantId: string | null
    actions: string[]
    policyId?: string
    policyRevision?: number
    missing: string[]
  }
  contextBlockers: string[]
  resourceConditions: string[]
}

export interface TeamAssignResult {
  memberId: string
  assignmentId: string
  state: string
  effectiveGrantBinding: {
    grantId: string
    actions: string[]
    policyId?: string
    policyRevision?: number
  }
}

// ── plan.prepare / plan.commit ────────────────────────────────────────────

/** Exact PlanPatch grammar accepted by plan.prepare. Omitted fields carry
 * forward from the base plan; a task revision is selected server-side. */
export interface InputBindingWire {
  slot: string
  kind: 'artifact' | 'task-output' | 'contract'
  required?: boolean
  artifactId?: string
  artifactRevision?: number
  taskId?: string
  taskRevision?: number
  outputSlot?: string
  contractId?: string
  contractRevision?: number
  modelVersion?: string
}

export interface OutputSlotWire {
  slot: string
  description?: string
  contractId?: string
  required?: boolean
}

export interface TaskSpecPatch {
  taskId?: string
  title?: string
  requirementText?: string
  ownerRoleId?: string
  assignedMemberId?: string | null
  inputs?: InputBindingWire[]
  outputs?: OutputSlotWire[]
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
  action: 'keep' | 'revoke' | 'replace'
}

export interface PlanPatch {
  basePlanRevision?: number
  tasks?: TaskSpecPatch[]
  edges?: EdgePatch[]
  retireTaskIds?: string[]
  activeAttemptDisposition?: AttemptDisposition[]
}

export interface PlanPrepareRequest {
  runId: string
  patch: PlanPatch
}

export interface PendingInput {
  slot: string
  kind: string
  reason: string
}

export interface PlanPrepareResult {
  candidatePlanId: string
  digest: string
  structuralErrors: string[]
  unresolvedInputs: PendingInput[]
}

export interface PlanCommitRequest {
  candidatePlanId: string
  digest: string
  expectedPlanRevision: number
}

export interface TaskEligibility {
  taskId: string
  taskRevision: number
  state: 'unassigned' | 'blocked' | 'eligible' | 'active' | 'reported' | 'accepted' | 'failed' | 'cancelled'
  assignedMemberId?: string
  blockedReasons: string[]
  pendingInputs: PendingInput[]
  resolvedInputs: {
    slot: string
    kind: string
    artifact?: { artifactId: string; revision: number; digest: string }
    contractId?: string
  }[]
}

export interface PlanCommitResult {
  runId: string
  planRevision: number
  digest: string
  eligibility: TaskEligibility[]
}

// ── run.get coordinator projection ───────────────────────────────────────

export interface RunGetRequest {
  runId: string
  projection: 'coordinator' | 'member'
}

export interface RunProjection {
  id: string
  projectId: string
  modelVersion: string
  goalText: string
  purpose: 'work' | 'verification'
  coordinatorMemberId?: string
  state: 'draft' | 'active' | 'settled' | 'archived'
  currentPlanRevision?: number
  revision: number
}

export interface PlanProjection {
  runId: string
  revision: number
  digest: string
  dispositions: unknown
}

export interface MemberProjection {
  id: string
  runId: string
  modelVersion: string
  roleId: string
  implementationId: string
  implementationRevision: number
  generation: number
  currentExecutionId?: string
  state: 'pending' | 'assigned' | 'active' | 'retired'
  revision: number
}

export interface AssignmentProjection {
  id: string
  revision: number
  memberId: string
  kind: AssignmentKind
  mandateText: string
  grantId: string
  taskId?: string
  taskRevision?: number
  scope: unknown
}

/** TaskSpec values persist flexible JSON for inputs/outputs/policy. The
 * workbench maps that JSON into editable draft rows explicitly. */
export interface TaskSpecProjection {
  taskId: string
  revision: number
  title: string
  requirementText: string
  ownerRoleId: string
  assignedMemberId?: string
  inputs: unknown
  outputs: unknown
  settlementPolicy: unknown
  inputBindings?: unknown
  outputSlots?: unknown
}

export interface TaskEdgeProjection {
  runId: string
  planRevision: number
  predecessorTaskId: string
  successorTaskId: string
  requiredOutputNames: string[]
  settlementRequirement: string
}

export interface CoordinatorRunProjection {
  run: RunProjection
  plan: PlanProjection | null
  planTasks: TaskSpecProjection[]
  planEdges: TaskEdgeProjection[]
  members: MemberProjection[]
  assignments: AssignmentProjection[]
  eligibility: TaskEligibility[]
}
