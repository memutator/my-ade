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
  Collaborator,
  CollaboratorsRequest,
  CollaboratorsResponse,
  CommitPlanRequest,
  CommitPlanResult,
  ImplementationOffer,
  ImplementationsRequest,
  ImplementationsResponse,
  InspectRequest,
  InspectResult,
  LocateRequest,
  LocateResponse,
  LocateResult,
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
export async function searchResponsibilities(
  call: OpCaller,
  req: SearchRequest
): Promise<SearchResponse> {
  const raw = (await call(OP.responsibilitySearch, req)) as SearchResponse & {
    items?: SearchResponse['candidates']
  }
  const items = raw.items ?? raw.candidates ?? []
  return { ...raw, items, candidates: items }
}

/** coordination | owner resolution — authored view only; a missing one is
 //  reported as missing, not synthesized (REQ-06). */
export async function inspectResponsibility(
  call: OpCaller,
  req: InspectRequest
): Promise<InspectResult> {
  const raw = (await call(OP.responsibilityInspect, req)) as InspectResult & {
    boundary?: { responsibility?: string; criteria?: InspectResult['criteria'] }
  }
  const boundary = raw.boundary
  return {
    ...raw,
    responsibility: raw.responsibility ?? boundary?.responsibility ?? '',
    criteria: raw.criteria ?? boundary?.criteria ?? [],
    viewStatus:
      raw.viewStatus ??
      (typeof raw.coordinationView === 'object' && raw.coordinationView !== null
        ? (raw.coordinationView as { status?: string }).status === 'missing'
          ? 'missing'
          : 'present'
        : raw.coordinationView == null
          ? 'missing'
          : 'present')
  }
}

export async function locateResponsibility(
  call: OpCaller,
  req: LocateRequest
): Promise<LocateResponse> {
  const raw = (await call(OP.responsibilityLocate, req)) as LocateResponse & {
    items?: LocateResult[]
  }
  const items = (raw.items ?? raw.results ?? []).map((r) => ({
    ...r,
    status: r.status === 'resolved' ? 'assigned' : r.status
  })) as LocateResult[]
  return { ...raw, items, results: items }
}

export async function listCollaborators(
  call: OpCaller,
  req: CollaboratorsRequest
): Promise<CollaboratorsResponse> {
  const raw = (await call(OP.responsibilityCollaborators, req)) as CollaboratorsResponse & {
    items?: Array<{
      role?: { id?: string; name?: string }
      relationReasons?: Array<{ kind?: string; contractId?: string; direction?: string }>
      members?: Array<{ memberId?: string; state?: string }>
    }>
  }
  const items = raw.items
  if (!items) return raw
  const collaborators: Collaborator[] = []
  for (const it of items) {
    const roleId = it.role?.id ?? ''
    const roleName = it.role?.name
    const reasons = it.relationReasons ?? []
    const members = it.members ?? []
    if (members.length === 0) {
      collaborators.push({
        roleId,
        roleName,
        relationReason: reasons[0]?.kind ?? 'same-boundary',
        contractId: reasons[0]?.contractId,
        direction: reasons[0]?.direction
      })
    } else {
      for (const m of members) {
        collaborators.push({
          roleId,
          roleName,
          memberId: m.memberId,
          memberState: m.state,
          relationReason: reasons[0]?.kind ?? 'same-boundary',
          contractId: reasons[0]?.contractId,
          direction: reasons[0]?.direction
        })
      }
    }
  }
  return { ...raw, collaborators }
}

export async function listImplementations(
  call: OpCaller,
  req: ImplementationsRequest
): Promise<ImplementationsResponse> {
  const raw = (await call(OP.roleImplementations, req)) as ImplementationsResponse & {
    implementations?: Array<ImplementationOffer & { revision?: number; profileId?: string; profile?: string }>
  }
  return {
    ...raw,
    implementations: (raw.implementations ?? []).map((im) => ({
      ...im,
      implementationRevision: im.implementationRevision ?? im.revision ?? 0,
      profile: im.profile ?? im.profileId
    }))
  }
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
  return call(OP.teamAssign, req, {
    operationId: newOperationId()
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
  return call(OP.planCommit, req, {
    operationId: newOperationId()
  }) as Promise<CommitPlanResult>
}
