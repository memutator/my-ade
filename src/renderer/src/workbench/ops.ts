// workbench/ops.ts — the workbench's typed operation surface.
//
// Every call is an OPERATION NAME through the OpCaller seam (SHARED-APIS:
// cross-domain work goes by op name, never by sibling internals). Names are
// the spec/operations.md index — IMP-06 owns responsibility.*/role.*,
// IMP-13 owns assignment.preview/team.assign/plan.*/run.get, IMP-26 owns
// runtime.snapshot/subscribe. Mutations carry a fresh operationId (REQ-14);
// expectedRevisions rides the CommandRequest envelope.

import type { OpCaller } from './client.ts'
import { newOperationId } from './client.ts'
import type {
  AssignRequest,
  AssignResult,
  AssignmentPreview,
  CollaboratorsRequest,
  CollaboratorsResponse,
  CommitPlanRequest,
  CommitPlanResult,
  ImplementationsRequest,
  ImplementationsResponse,
  InspectRequest,
  InspectResult,
  LocateRequest,
  LocateResponse,
  PlanPatch,
  PreviewRequest,
  PreparePlanResult,
  RunGetRequest,
  RunProjection,
  RuntimeSnapshot,
  SearchRequest,
  SearchResponse,
  SnapshotRequest
} from './contracts.ts'

/** spec/operations.md — the exact operation names */
export const OP = {
  responsibilitySearch: 'responsibility.search',
  responsibilityInspect: 'responsibility.inspect',
  responsibilityLocate: 'responsibility.locate',
  responsibilityCollaborators: 'responsibility.collaborators',
  roleImplementations: 'role.implementations',
  assignmentPreview: 'assignment.preview',
  runGet: 'run.get',
  planPrepare: 'plan.prepare',
  planCommit: 'plan.commit',
  teamAssign: 'team.assign',
  runtimeSnapshot: 'runtime.snapshot',
  runtimeSubscribe: 'runtime.subscribe'
} as const

// ── queries (no operationId — reads, not mutations) ─────────────

/** C-DISCOVERY — candidates for a human/coordinator to READ, never to
 //  auto-confirm (REQ-04). At least a query or one structural filter is
 //  required by the contract; we send the request verbatim. */
export function searchResponsibilities(
  call: OpCaller,
  req: SearchRequest
): Promise<SearchResponse> {
  return call(OP.responsibilitySearch, req) as Promise<SearchResponse>
}

/** coordination | owner resolution — authored view only; a missing one is
 //  reported as missing, not synthesized (REQ-06). */
export function inspectResponsibility(call: OpCaller, req: InspectRequest): Promise<InspectResult> {
  return call(OP.responsibilityInspect, req) as Promise<InspectResult>
}

export function locateResponsibility(call: OpCaller, req: LocateRequest): Promise<LocateResponse> {
  return call(OP.responsibilityLocate, req) as Promise<LocateResponse>
}

export function listCollaborators(
  call: OpCaller,
  req: CollaboratorsRequest
): Promise<CollaboratorsResponse> {
  return call(OP.responsibilityCollaborators, req) as Promise<CollaboratorsResponse>
}

export function listImplementations(
  call: OpCaller,
  req: ImplementationsRequest
): Promise<ImplementationsResponse> {
  return call(OP.roleImplementations, req) as Promise<ImplementationsResponse>
}

export function getRun(call: OpCaller, req: RunGetRequest): Promise<RunProjection> {
  return call(OP.runGet, req) as Promise<RunProjection>
}

export function runtimeSnapshot(call: OpCaller, req: SnapshotRequest): Promise<RuntimeSnapshot> {
  return call(OP.runtimeSnapshot, req) as Promise<RuntimeSnapshot>
}

// ── preview → assign (receipt-bearing mutations) ────────────────

/** assignment.preview — reads relations/grant coverage/blockers and
 //  stamps a preview receipt; creates NO Member/Dispatch/process/grant. */
export function previewAssignment(call: OpCaller, req: PreviewRequest): Promise<AssignmentPreview> {
  return call(OP.assignmentPreview, req, {
    operationId: newOperationId()
  }) as Promise<AssignmentPreview>
}

/** team.assign — the explicit commit. The server re-checks the
 //  selectionToken's modelVersion/role/implementation against CURRENT
 //  grants and ceiling; STALE_REVISION is a normal answer. */
export function assignTeam(call: OpCaller, req: AssignRequest): Promise<AssignResult> {
  const { expectedPlanRevision, ...payload } = req
  return call(OP.teamAssign, payload, {
    operationId: newOperationId(),
    expectedRevisions:
      expectedPlanRevision !== undefined ? { plan: expectedPlanRevision } : undefined
  }) as Promise<AssignResult>
}

// ── META DAG edit — prepare → commit, always a new revision ─────

export function preparePlan(
  call: OpCaller,
  runId: string,
  patch: PlanPatch
): Promise<PreparePlanResult> {
  return call(
    OP.planPrepare,
    { runId, patch },
    { operationId: newOperationId() }
  ) as Promise<PreparePlanResult>
}

export function commitPlan(call: OpCaller, req: CommitPlanRequest): Promise<CommitPlanResult> {
  const { expectedPlanRevision, ...payload } = req
  return call(OP.planCommit, payload, {
    operationId: newOperationId(),
    expectedRevisions: { plan: expectedPlanRevision }
  }) as Promise<CommitPlanResult>
}
