// mahas-runtime/src/discovery/inspect.ts — responsibility.inspect
//
// Returns the boundary's own responsibility/criteria, its direct children
// at statement resolution, contract tensions crossing the subtree,
// non-goals and roles — the 팀장 read of a responsibility (REQ-06).
//
// perspective='coordination' additionally reads the AUTHORED coordination
// view: clauses that role-interface writers marked for coordination
// readers (ContextRequirement.readerPerspective) on this boundary's role
// interfaces. When no such authored view exists the result says
// 'missing' — this service never substitutes an on-the-fly summary and
// never ships child context bodies to cover the gap (contract: "즉석
// 요약으로 missing 은폐 금지", "모든 자식 context 본문 제외").
//
// perspective='owner' returns the boundary's own linked context refs
// (paths only — bodies are a separate read permission).

import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import type { DiscoveryDeps } from './deps.ts'
import {
  boundaryContextPaths,
  boundarySubtree,
  childrenOf,
  eventHighWater,
  getBoundary,
  interfaceRequirementsForBoundaryRoles,
  listContractRelations,
  listNonGoals,
  listRoles,
  boundarySummary,
  resolveModelVersion,
  roleSummary
} from './model-read.ts'
import { discoveryError, target } from './types.ts'
import { makeVisibility } from './visibility.ts'
import type { BoundaryRow } from './model-read.ts'
import type { ContractTension, CoordinationView, InspectRequest, InspectResult } from './types.ts'

/** readerPerspective values treated as the authored coordination view */
const COORDINATION_PERSPECTIVES = new Set(['coordination', 'coordinator', 'parent', '팀장'])

/**
 * Whether a boundary carries a responsibility statement of its own at 팀장
 * resolution. An empty statement is never a statement. A boundary with
 * sub-boundaries, unassigned (roleless) territory, or authored detail
 * (context/non-goal/interface) speaks for itself. A completely bare
 * contract-only leaf does not — it is already read through contract
 * tension, so its own descendants stand in its place (none, typically).
 */
function hasOwnStatement(db: DatabaseSync, modelVersion: string, boundary: BoundaryRow): boolean {
  if (boundary.responsibility_statement.trim().length === 0) return false
  if (childrenOf(db, modelVersion, boundary.id).length > 0) return true
  if (listRoles(db, modelVersion, boundary.id).length === 0) return true
  if (boundaryContextPaths(db, modelVersion, boundary.id).length > 0) return true
  if (listNonGoals(db, modelVersion, boundary.id).length > 0) return true
  if (interfaceRequirementsForBoundaryRoles(db, modelVersion, boundary.id).length > 0) return true
  let provides = false
  let consumes = false
  for (const rel of listContractRelations(db, modelVersion)) {
    if (rel.contract.provider_boundary_id === boundary.id) provides = true
    if (rel.consumerBoundaryIds.includes(boundary.id)) consumes = true
  }
  return provides || !consumes
}

/**
 * Direct children at statement resolution: a child without its own
 * statement is transparent and its direct children take its place,
 * recursively. Visibility and cycle safety are enforced on the walk.
 */
function statementChildren(
  db: DatabaseSync,
  modelVersion: string,
  boundaryId: string,
  visible: (id: string) => boolean
): BoundaryRow[] {
  const out: BoundaryRow[] = []
  const seen = new Set<string>([boundaryId])
  const walk = (parentId: string): void => {
    for (const childId of childrenOf(db, modelVersion, parentId)) {
      if (seen.has(childId)) continue
      seen.add(childId)
      if (!visible(childId)) continue
      const boundary = getBoundary(db, modelVersion, childId)
      if (boundary === undefined) continue
      if (hasOwnStatement(db, modelVersion, boundary)) out.push(boundary)
      else walk(childId)
    }
  }
  walk(boundaryId)
  return out
}

export function validateInspectRequest(payload: unknown): InspectRequest {
  const p = payload as Partial<InspectRequest>
  if (typeof p?.projectId !== 'string' || p.projectId.length === 0)
    throw discoveryError('MODEL_INVALID', 'responsibility.inspect requires projectId')
  if (typeof p?.modelVersion !== 'string' || p.modelVersion.length === 0)
    throw discoveryError('MODEL_INVALID', 'responsibility.inspect requires modelVersion')
  if (typeof p?.boundaryId !== 'string' || p.boundaryId.length === 0)
    throw discoveryError('MODEL_INVALID', 'responsibility.inspect requires boundaryId')
  if (p?.perspective !== 'coordination' && p?.perspective !== 'owner')
    throw discoveryError('MODEL_INVALID', "perspective must be 'coordination' or 'owner'")
  return {
    projectId: p.projectId,
    modelVersion: p.modelVersion,
    boundaryId: p.boundaryId,
    perspective: p.perspective
  }
}

function coordinationView(
  db: DatabaseSync,
  modelVersion: string,
  boundaryId: string
): CoordinationView {
  const clauses: NonNullable<CoordinationView['clauses']> = []
  const sources: string[] = []
  for (const iface of interfaceRequirementsForBoundaryRoles(db, modelVersion, boundaryId)) {
    for (const req of iface.requirements) {
      const r = req as {
        clauseId?: unknown
        contextId?: unknown
        criterionRef?: unknown
        requiredMeaning?: unknown
        deliveryClass?: unknown
        readerPerspective?: unknown
      }
      if (typeof r !== 'object' || r === null) continue
      if (
        typeof r.readerPerspective !== 'string' ||
        !COORDINATION_PERSPECTIVES.has(r.readerPerspective)
      )
        continue
      clauses.push({
        clauseId: typeof r.clauseId === 'string' ? r.clauseId : '',
        ...(typeof r.contextId === 'string' ? { contextId: r.contextId } : {}),
        ...(typeof r.criterionRef === 'string' ? { criterionRef: r.criterionRef } : {}),
        requiredMeaning: typeof r.requiredMeaning === 'string' ? r.requiredMeaning : '',
        ...(typeof r.deliveryClass === 'string' ? { deliveryClass: r.deliveryClass } : {})
      })
      if (!sources.includes(iface.digest)) sources.push(iface.digest)
    }
  }
  if (clauses.length === 0) return { status: 'missing' }
  return { status: 'authored', clauses, sourceInterfaces: sources }
}

export function responsibilityInspect(
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  deps: DiscoveryDeps,
  payload: unknown
): InspectResult {
  const req = validateInspectRequest(payload)

  // pinned snapshot required — a superseded pin is stale for coordination
  const mv = resolveModelVersion(db, req.projectId, req.modelVersion)
  if (mv.stale && req.perspective === 'coordination')
    throw discoveryError(
      'INTERFACE_STALE',
      'modelVersion is superseded; re-query the active snapshot for coordination',
      { modelVersion: mv.id },
      'replan'
    )

  const vis = makeVisibility(ctx, deps, 'responsibility.inspect', mv.id, [
    target('project', req.projectId)
  ])
  vis.require([target('boundary', req.boundaryId)])

  const boundary = getBoundary(db, mv.id, req.boundaryId)
  if (boundary === undefined)
    throw discoveryError('MODEL_INVALID', 'boundary not in model snapshot', {
      modelVersion: mv.id,
      boundaryId: req.boundaryId
    })
  if (!vis.boundaryVisible(req.boundaryId))
    throw discoveryError('SCOPE_DENIED', 'boundary outside the granted scope', {
      boundaryId: req.boundaryId
    })

  // children at 팀장 resolution — statement + criteria only, only the ones
  // inside the caller's visible scope, with transparent children resolved
  // through to their descendants
  const children = statementChildren(db, mv.id, req.boundaryId, (id) =>
    vis.boundaryVisible(id)
  ).map((b) => boundarySummary(db, mv.id, b))

  // contract tensions across the inspected subtree
  const subtree = boundarySubtree(db, mv.id, req.boundaryId)
  const contractTensions: ContractTension[] = []
  for (const rel of listContractRelations(db, mv.id)) {
    const providerIn = subtree.has(rel.contract.provider_boundary_id)
    const consumersIn = rel.consumerBoundaryIds.filter((c) => subtree.has(c))
    if (!providerIn && consumersIn.length === 0) continue
    const consumersOut = rel.consumerBoundaryIds.filter((c) => !subtree.has(c))
    let crossing: ContractTension['crossing']
    if (providerIn && consumersOut.length > 0) crossing = 'outbound'
    else if (!providerIn && consumersIn.length > 0) crossing = 'inbound'
    else crossing = 'internal'
    // tension endpoints the caller cannot see stay out of the listing
    const visibleConsumers = consumersIn.concat(consumersOut).filter((c) => vis.boundaryVisible(c))
    if (!vis.boundaryVisible(rel.contract.provider_boundary_id)) continue
    contractTensions.push({
      contractId: rel.contract.id,
      name: rel.contract.name,
      providerBoundaryId: rel.contract.provider_boundary_id,
      consumerBoundaryIds: visibleConsumers,
      crossing
    })
  }

  const roles = listRoles(db, mv.id, req.boundaryId)
    .filter((r) => vis.roleVisible(r.id, r.boundary_id))
    .map(roleSummary)

  return {
    modelVersion: mv.id,
    snapshotRevision: eventHighWater(db),
    perspective: req.perspective,
    boundary: boundarySummary(db, mv.id, boundary),
    children,
    contractTensions,
    nonGoals: listNonGoals(db, mv.id, req.boundaryId),
    roles,
    coordinationView:
      req.perspective === 'coordination'
        ? coordinationView(db, mv.id, req.boundaryId)
        : { status: 'not-requested' },
    contextRefs: boundaryContextPaths(db, mv.id, req.boundaryId)
  }
}
