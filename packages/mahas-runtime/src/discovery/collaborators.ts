// mahas-runtime/src/discovery/collaborators.ts —
// responsibility.collaborators
//
// Static relation read for one role: same-boundary siblings, contains
// neighbors (direct parent + direct children), and contract peers with
// direction. When runId is given and visible, each related role is
// resolved to its current Run Member addresses — a role with no Member
// comes back as role-only (미배정이면 role만 반환); an address is never
// invented for a Member that does not exist.
//
// Authorization: the role's read scope gates the whole op; each related
// boundary/role then passes the same visibility filter, and member
// resolution additionally requires the Run's participation scope.

import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import type { DiscoveryDeps } from './deps.ts'
import {
  childrenOf,
  eventHighWater,
  getRole,
  getRun,
  listContractRelations,
  listRoles,
  membersForRoleInRun,
  parentOf,
  resolveModelVersion,
  roleSummary
} from './model-read.ts'
import { discoveryError, target } from './types.ts'
import { makeVisibility } from './visibility.ts'
import type {
  Collaborator,
  CollaboratorReason,
  CollaboratorsRequest,
  CollaboratorsResult
} from './types.ts'

export function validateCollaboratorsRequest(payload: unknown): CollaboratorsRequest {
  const p = payload as Partial<CollaboratorsRequest>
  if (typeof p?.projectId !== 'string' || p.projectId.length === 0)
    throw discoveryError('MODEL_INVALID', 'responsibility.collaborators requires projectId')
  if (typeof p?.modelVersion !== 'string' || p.modelVersion.length === 0)
    throw discoveryError('MODEL_INVALID', 'responsibility.collaborators requires modelVersion')
  if (typeof p?.roleId !== 'string' || p.roleId.length === 0)
    throw discoveryError('MODEL_INVALID', 'responsibility.collaborators requires roleId')
  if (p?.runId !== undefined && typeof p.runId !== 'string')
    throw discoveryError('MODEL_INVALID', 'runId must be a string')
  return {
    projectId: p.projectId,
    modelVersion: p.modelVersion,
    roleId: p.roleId,
    ...(p.runId !== undefined ? { runId: p.runId } : {})
  }
}

export function responsibilityCollaborators(
  db: DatabaseSync,
  ctx: AuthenticatedContext,
  deps: DiscoveryDeps,
  payload: unknown
): CollaboratorsResult {
  const req = validateCollaboratorsRequest(payload)
  const mv = resolveModelVersion(db, req.projectId, req.modelVersion)

  const role = getRole(db, mv.id, req.roleId)
  if (role === undefined)
    throw discoveryError('NO_RESPONSIBLE_ROLE', 'role not found in model snapshot', {
      modelVersion: mv.id,
      roleId: req.roleId
    })

  const vis = makeVisibility(ctx, deps, 'responsibility.collaborators', mv.id, [
    target('project', req.projectId)
  ])
  vis.require([target('role', req.roleId), target('boundary', role.boundary_id)])

  // run resolution is an explicit extra scope — participation check first
  let runOk = false
  if (req.runId !== undefined) {
    const run = getRun(db, req.runId)
    if (run === undefined || run.project_id !== req.projectId)
      throw discoveryError('MODEL_INVALID', 'runId does not belong to project', {
        projectId: req.projectId,
        runId: req.runId
      })
    runOk = vis.runVisible(req.runId)
    if (!runOk)
      throw discoveryError('SCOPE_DENIED', 'run outside the participation scope', {
        runId: req.runId
      })
  }

  const byRole = new Map<string, Collaborator>()
  const add = (roleId: string, boundaryId: string, reason: CollaboratorReason): void => {
    if (roleId === req.roleId) return
    if (!vis.roleVisible(roleId, boundaryId)) return
    let c = byRole.get(roleId)
    if (c === undefined) {
      const r = getRole(db, mv.id, roleId)
      if (r === undefined) return
      c = { role: roleSummary(r), boundaryId, relationReasons: [], members: [] }
      byRole.set(roleId, c)
    }
    if (
      !c.relationReasons.some(
        (x) =>
          x.kind === reason.kind &&
          x.contractId === reason.contractId &&
          x.direction === reason.direction
      )
    )
      c.relationReasons.push(reason)
  }

  // same-boundary siblings
  for (const r of listRoles(db, mv.id, role.boundary_id))
    add(r.id, r.boundary_id, { kind: 'same-boundary' })

  // contains neighbors — direct parent and direct children only
  const parent = parentOf(db, mv.id, role.boundary_id)
  if (parent !== undefined)
    for (const r of listRoles(db, mv.id, parent))
      add(r.id, parent, { kind: 'contains', direction: 'parent' })
  for (const child of childrenOf(db, mv.id, role.boundary_id))
    for (const r of listRoles(db, mv.id, child))
      add(r.id, child, { kind: 'contains', direction: 'child' })

  // contract peers — direction from the REQUESTING boundary's perspective
  for (const rel of listContractRelations(db, mv.id)) {
    const provider = rel.contract.provider_boundary_id
    const consumers = rel.consumerBoundaryIds
    if (provider === role.boundary_id)
      for (const c of consumers)
        for (const r of listRoles(db, mv.id, c))
          add(r.id, c, { kind: 'contract', contractId: rel.contract.id, direction: 'provides' })
    if (consumers.includes(role.boundary_id)) {
      for (const r of listRoles(db, mv.id, provider))
        add(r.id, provider, {
          kind: 'contract',
          contractId: rel.contract.id,
          direction: 'consumes'
        })
      // co-consumers share the dependency (symmetric peer relation — no
      // direction invented); the requester's own role is skipped by `add`
      for (const co of consumers)
        for (const r of listRoles(db, mv.id, co))
          add(r.id, co, { kind: 'contract', contractId: rel.contract.id })
    }
  }

  // resolve to Run Member addresses only inside a visible run
  if (req.runId !== undefined && runOk)
    for (const c of byRole.values())
      c.members = membersForRoleInRun(db, req.runId, c.role.id).map((m) => ({
        memberId: m.id,
        state: m.state
      }))

  const items = [...byRole.values()].sort(
    (a, b) => a.role.name.localeCompare(b.role.name) || a.role.id.localeCompare(b.role.id)
  )

  return {
    modelVersion: mv.id,
    snapshotRevision: eventHighWater(db),
    roleId: req.roleId,
    ...(req.runId !== undefined ? { runId: req.runId } : {}),
    items
  }
}
