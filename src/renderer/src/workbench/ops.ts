// workbench/ops.ts — the workbench's typed operation calls.
//
// One transport (client.ts), one request DTO and one result DTO per
// operation, both taken from the shared contracts. Reads that the views
// render as more than a raw payload pass through the explicit projections in
// view-model.ts; everything else is returned as the canonical DTO so a view
// reads exactly the field the server sent.

import type { OpCaller } from './client.ts'
import { newOperationId } from './client.ts'
import type {
  AccessInspectPayload,
  AccessInspectResult,
  CollaboratorsResult,
  CollaboratorsRequest,
  ContextInspectPayload,
  ContextInspectResult,
  ImplementationsRequest,
  ImplementationsResult,
  InspectRequest,
  InspectResult,
  InterfaceGetPayload,
  InterfaceGetResult,
  LocateRequest,
  LocateResult,
  PlanCommitRequest,
  PlanCommitResult,
  PlanPrepareRequest,
  PlanPrepareResult,
  SearchRequest,
  SearchResult,
  SurfaceDescribePayload,
  SurfaceDescribeResult,
  TeamAssignRequest,
  TeamAssignResult,
  WorkerInspectPayload,
  WorkerInspectResult
} from './contracts.ts'
import type {
  AssignmentPreviewRequest,
  AssignmentPreviewResult,
  CoordinatorRunProjection,
  RunGetRequest
} from './contracts.ts'
import {
  toCollaboratorsViewModel,
  toImplementationsViewModel,
  toInspectViewModel,
  toLocateViewModel,
  toSearchViewModel,
  type CollaboratorsViewModel,
  type ImplementationsViewModel,
  type InspectViewModel,
  type LocateViewModel,
  type SearchViewModel
} from './view-model.ts'

/** the operation names this workbench consumes (spec/operations.md) */
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
  interfaceGet: 'interface.get',
  contextInspect: 'context.inspect',
  surfaceDescribe: 'surface.describe',
  accessInspect: 'access.inspect',
  workerInspect: 'worker.inspect'
} as const

/* ── C-DISCOVERY reads ─────────────────────────────────────────────────── */

export async function searchResponsibilities(
  call: OpCaller,
  request: SearchRequest
): Promise<SearchViewModel> {
  const result = await call<SearchResult>(OP.responsibilitySearch, request)
  return toSearchViewModel(result)
}

export async function inspectResponsibility(
  call: OpCaller,
  request: InspectRequest
): Promise<InspectViewModel> {
  const result = await call<InspectResult>(OP.responsibilityInspect, request)
  return toInspectViewModel(result)
}

export async function locateResponsibility(
  call: OpCaller,
  request: LocateRequest
): Promise<LocateViewModel> {
  const result = await call<LocateResult>(OP.responsibilityLocate, request)
  return toLocateViewModel(result)
}

export async function listCollaborators(
  call: OpCaller,
  request: CollaboratorsRequest
): Promise<CollaboratorsViewModel> {
  const result = await call<CollaboratorsResult>(OP.responsibilityCollaborators, request)
  return toCollaboratorsViewModel(result)
}

export async function listImplementations(
  call: OpCaller,
  request: ImplementationsRequest
): Promise<ImplementationsViewModel> {
  const result = await call<ImplementationsResult>(OP.roleImplementations, request)
  return toImplementationsViewModel(result)
}

/* ── C-WORK: preview → explicit assign / plan ──────────────────────────── */

/** preview creates nothing — REQ-14 idempotency still rides every mutation */
export function previewAssignment(
  call: OpCaller,
  request: AssignmentPreviewRequest
): Promise<AssignmentPreviewResult> {
  return call<AssignmentPreviewResult>(OP.assignmentPreview, request, {
    operationId: newOperationId()
  })
}

export function assignTeam(call: OpCaller, request: TeamAssignRequest): Promise<TeamAssignResult> {
  return call<TeamAssignResult>(OP.teamAssign, request, { operationId: newOperationId() })
}

export function getRun(call: OpCaller, request: RunGetRequest): Promise<CoordinatorRunProjection> {
  return call<CoordinatorRunProjection>(OP.runGet, request)
}

export function preparePlan(
  call: OpCaller,
  request: PlanPrepareRequest
): Promise<PlanPrepareResult> {
  return call<PlanPrepareResult>(OP.planPrepare, request, { operationId: newOperationId() })
}

export function commitPlan(call: OpCaller, request: PlanCommitRequest): Promise<PlanCommitResult> {
  return call<PlanCommitResult>(OP.planCommit, request, { operationId: newOperationId() })
}

/* ── inspector reads ───────────────────────────────────────────────────── */

/**
 * interface.get by {modelVersion, roleId} — the canonical payload and result.
 * `contextRequirements` is the flattened clause list the handler returns
 * alongside `interface.requirements`; both are in the shared DTO.
 */
export function getRoleInterface(
  call: OpCaller,
  request: InterfaceGetPayload
): Promise<InterfaceGetResult> {
  return call<InterfaceGetResult>(OP.interfaceGet, request, {
    operationId: newOperationId()
  })
}

export function inspectContext(
  call: OpCaller,
  request: ContextInspectPayload
): Promise<ContextInspectResult> {
  return call<ContextInspectResult>(OP.contextInspect, request)
}

export function describeSurface(
  call: OpCaller,
  request: SurfaceDescribePayload
): Promise<SurfaceDescribeResult> {
  return call<SurfaceDescribeResult>(OP.surfaceDescribe, request)
}

export function inspectAccess(
  call: OpCaller,
  request: AccessInspectPayload
): Promise<AccessInspectResult> {
  return call<AccessInspectResult>(OP.accessInspect, request)
}

export function inspectWorker(
  call: OpCaller,
  request: WorkerInspectPayload
): Promise<WorkerInspectResult> {
  return call<WorkerInspectResult>(OP.workerInspect, request)
}
