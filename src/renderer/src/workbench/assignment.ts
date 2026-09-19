// workbench/assignment.ts — assignment request assembly.
//
// assignment.preview and team.assign share one payload shape except for the
// plan CAS: the preview creates nothing, so expectedPlanRevision rides on the
// commit only. Placement intent carries exactly the documented fields the 팀장
// filled in — never an empty object, never a guessed key.

import type { AssignmentKind, AssignmentPreviewRequest, TeamAssignRequest } from './contracts.ts'
import { numeric, trimmed } from './plan-drafts.ts'

/* ── C-WORK: assignment request assembly ───────────────────────────────── */

export interface AssignmentForm {
  assignmentKind: AssignmentKind
  mandateText: string
  taskId: string
  taskRevision: string
  placementKind: '' | 'folder' | 'worktree'
  placementHostId: string
  placementTargetPath: string
  placementProjectRoot: string
  placementCheckoutId: string
  expectedPlanRevision: string
}

export function emptyAssignmentForm(): AssignmentForm {
  return {
    assignmentKind: 'task',
    mandateText: '',
    taskId: '',
    taskRevision: '',
    placementKind: '',
    placementHostId: '',
    placementTargetPath: '',
    placementProjectRoot: '',
    placementCheckoutId: '',
    expectedPlanRevision: ''
  }
}

/** the documented placement intent fields — nothing invented, nothing empty */
export function toPlacementIntent(form: AssignmentForm): Record<string, unknown> | undefined {
  const intent: Record<string, unknown> = {}
  if (form.placementKind) intent['kind'] = form.placementKind
  const hostId = trimmed(form.placementHostId)
  if (hostId) intent['hostId'] = hostId
  const targetPath = trimmed(form.placementTargetPath)
  if (targetPath) intent['targetPath'] = targetPath
  const projectRoot = trimmed(form.placementProjectRoot)
  if (projectRoot) intent['projectRoot'] = projectRoot
  const checkoutId = trimmed(form.placementCheckoutId)
  if (checkoutId) intent['checkoutId'] = checkoutId
  return Object.keys(intent).length ? intent : undefined
}

function baseAssignment(
  runId: string,
  selectionToken: string,
  implementationId: string,
  implementationRevision: number,
  form: AssignmentForm
): AssignmentPreviewRequest {
  const request: AssignmentPreviewRequest = {
    runId,
    selectionToken,
    implementationId,
    implementationRevision,
    assignmentKind: form.assignmentKind,
    mandateText: form.mandateText
  }
  // a coordination assignment takes no Task — the server refuses the pair
  if (form.assignmentKind === 'task') {
    const taskId = trimmed(form.taskId)
    if (taskId) request.taskId = taskId
    const taskRevision = numeric(form.taskRevision)
    if (taskRevision !== undefined) request.taskRevision = taskRevision
  }
  const placementIntent = toPlacementIntent(form)
  if (placementIntent) request.placementIntent = placementIntent
  return request
}

/** assignment.preview payload — no expectedPlanRevision: preview creates nothing */
export function toPreviewRequest(
  runId: string,
  selectionToken: string,
  implementationId: string,
  implementationRevision: number,
  form: AssignmentForm
): AssignmentPreviewRequest {
  return baseAssignment(runId, selectionToken, implementationId, implementationRevision, form)
}

/** team.assign payload — the plan CAS rides only on the commit */
export function toAssignRequest(
  runId: string,
  selectionToken: string,
  implementationId: string,
  implementationRevision: number,
  form: AssignmentForm
): TeamAssignRequest {
  const request: TeamAssignRequest = baseAssignment(
    runId,
    selectionToken,
    implementationId,
    implementationRevision,
    form
  )
  const expectedPlanRevision = numeric(form.expectedPlanRevision)
  if (expectedPlanRevision !== undefined) request.expectedPlanRevision = expectedPlanRevision
  return request
}
