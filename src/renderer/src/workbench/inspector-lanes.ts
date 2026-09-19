// workbench/inspector-lanes.ts — inspector projection rows.
//
// These mappers read the canonical operation DTOs (mahas-contracts/operations/
// inspector.ts) exactly as the runtime handlers return them: interface.get
// carries `contextRequirements` + `modelStatus`, surface.describe carries the
// projected descriptor list, access.inspect carries the inspected subject with
// one row per grant, and worker.inspect carries the flattened execution view.
// No alias reading and no fallback names: a field the contract does not define
// does not exist, and a lane with nothing to show says so.

import type {
  AccessInspectResult,
  ContextInspectResult,
  ContextRequirement,
  GrantInspectSummary,
  InheritedInput,
  InterfaceGetPayload,
  InterfaceGetResult,
  JudgmentScope,
  PlannedComponent,
  StageReceipt,
  SurfaceDescribeResult,
  WorkerInspectResult
} from './contracts.ts'

/* ── interface.get ─────────────────────────────────────────────────────── */

/**
 * interface.get is the one inspector payload whose ids are branded
 * (ModelVersionId / Id) — the server's identity guarantee. A workbench only
 * holds the strings a 팀장 typed or an earlier response carried, so the
 * conversion is written once, here, instead of being spelled as a cast inside
 * every view.
 */
export function toInterfaceGetPayload(modelVersion: string, roleId: string): InterfaceGetPayload {
  return {
    modelVersion: modelVersion as InterfaceGetPayload['modelVersion'],
    roleId: roleId as InterfaceGetPayload['roleId']
  }
}

export interface ClauseRow {
  clauseId: string
  requiredMeaning: string
  deliveryClass: string
  readerPerspective: string
  source: string
}

export function toClauseRows(requirements: ContextRequirement[]): ClauseRow[] {
  return requirements.map((r) => ({
    clauseId: r.clauseId,
    requiredMeaning: r.requiredMeaning,
    deliveryClass: r.deliveryClass,
    readerPerspective: r.readerPerspective,
    source: r.contextId
      ? 'context ' + r.contextId
      : r.criterionRef
        ? 'criterion ' + r.criterionRef
        : '—'
  }))
}

export interface InterfaceLaneView {
  digest: string
  modelVersion: string
  roleId: string
  modelStatus: string
  judgmentScope: JudgmentScope
  responsibilityRefs: string[]
  requirements: ClauseRow[]
  maintenanceRefs: InterfaceGetResult['maintenanceRefs']
}

export function toInterfaceLane(result: InterfaceGetResult): InterfaceLaneView {
  return {
    digest: result.digest,
    modelVersion: result.interface.modelVersion,
    roleId: result.interface.roleId,
    modelStatus: result.modelStatus,
    judgmentScope: result.interface.judgmentScope,
    responsibilityRefs: result.interface.requirements.responsibilityRefs.map((r) => String(r)),
    requirements: toClauseRows(result.contextRequirements),
    maintenanceRefs: result.maintenanceRefs
  }
}

/* ── context.inspect ───────────────────────────────────────────────────── */

export interface ComponentRow {
  componentId: string
  kind: string
  path: string
  scope: string
  digest: string
  activation: string
}

export function toComponentRows(components: PlannedComponent[]): ComponentRow[] {
  return components.map((c) => ({
    componentId: c.componentId,
    kind: c.kind,
    path: c.path,
    scope: c.scope,
    digest: c.digest,
    activation: c.activation ?? c.loadPhase ?? '—'
  }))
}

export interface InheritanceRow {
  scope: string
  path: string
  status: string
  digest: string
  note: string
}

export function toInheritanceRows(inputs: InheritedInput[]): InheritanceRow[] {
  return inputs.map((i) => ({
    scope: i.scope,
    path: i.path ?? '—',
    status: i.status,
    digest: i.digest ?? '—',
    note: i.note ?? ''
  }))
}

/** the bundle pins this projection was resolved against */
export function toPinRows(pins: ContextInspectResult['pins']): string[] {
  const rows = [
    'interface ' + pins.interfaceDigest,
    'implementation ' + pins.implementationId + '@' + pins.implementationRevision,
    'surface ' + pins.surfaceDigest,
    'required text ' + pins.requiredTextDigest
  ]
  if (pins.harnessProfileId) rows.push('harness profile ' + pins.harnessProfileId)
  return rows
}

/* ── surface.describe ──────────────────────────────────────────────────── */

export interface SurfaceOperationRow {
  name: string
  mutation: boolean
  visibility: string
  summary: string
}

export interface SurfaceLaneView {
  digest: string
  stale: boolean
  operations: SurfaceOperationRow[]
}

export function toSurfaceLane(result: SurfaceDescribeResult): SurfaceLaneView {
  return {
    digest: result.surfaceDigest,
    stale: result.stale,
    operations: result.operations.map((op) => ({
      name: op.name,
      mutation: op.mutation,
      visibility: op.visibility,
      summary: op.summary ?? ''
    }))
  }
}

/* ── access.inspect ────────────────────────────────────────────────────── */

export interface AccessGrantRow {
  grantId: string
  kind: string
  revision: number
  actions: string[]
  status: GrantInspectSummary['status']
  expiresAt: number | null
  revokedAt: number | null
  targets: string[]
  provisioning: string
}

function scopeRow(g: GrantInspectSummary): { targets: string[]; provisioning: string } {
  const targets = g.scopeSummary.targets.map((t) => t.kind + ':' + t.id)
  const p = g.scopeSummary.provisioning
  const provisioning = p
    ? 'roles ' +
      p.allowedRoleIds.join(', ') +
      (p.profileAdmission ? ' · ' + p.profileAdmission : '')
    : ''
  return { targets, provisioning }
}

export interface AccessLaneView {
  /** the inspected subject — exactly one of these is set */
  subject: string
  policy: string
  effectiveActions: string[]
  grants: AccessGrantRow[]
  /** every grant behind the subject is revoked or expired (or none exists) */
  revoked: boolean
}

export function toAccessLane(result: AccessInspectResult): AccessLaneView {
  const grants: AccessGrantRow[] = result.grants.map((g) => {
    const scope = scopeRow(g)
    return {
      grantId: g.grantId,
      kind: g.kind,
      revision: g.revision,
      actions: g.actions,
      status: g.status,
      expiresAt: g.expiresAt,
      revokedAt: g.revokedAt,
      targets: scope.targets,
      provisioning: scope.provisioning
    }
  })
  return {
    subject: result.memberId
      ? 'member ' + result.memberId
      : result.grantId
        ? 'grant ' + result.grantId
        : '—',
    policy: result.policy?.policyId
      ? result.policy.policyId + '@' + (result.policy.policyRevision ?? '—')
      : '—',
    effectiveActions: result.effectiveActions,
    grants,
    revoked: grants.length > 0 && grants.every((g) => g.status !== 'active')
  }
}

/* ── worker.inspect ────────────────────────────────────────────────────── */

export interface StageRow {
  stage: string
  state: string
  at?: number
}

export function toStageRows(receipt: StageReceipt | null): StageRow[] {
  return (receipt?.stages ?? []).map((s) => ({
    stage: s.stage,
    state: s.state ?? '—',
    at: s.at
  }))
}

export interface WorkerLaneView {
  executionId: string
  memberId: string
  generation: number
  hostId: string
  launchPlanId: string
  planDigest: string
  terminalId: string
  phase: string
  liveness: string
  authority: string
  /** the cumulative stage receipt — evidence, never a completion verdict */
  receipt: StageReceipt | null
  failedStage: string
  nextAllowedActions: string[]
  residuals: string[]
  join: string
  injectionReceipts: string[]
  /** the process identity the runtime recorded (ProcessIncarnation-shaped) */
  processEvidence: unknown
  /** present only when this call asked the host to probe */
  probe: unknown
}

export function toWorkerLane(result: WorkerInspectResult): WorkerLaneView {
  const authority = result.taskAuthority
  return {
    executionId: result.executionId,
    memberId: result.memberId,
    generation: result.generation,
    hostId: result.hostId,
    launchPlanId: result.launchPlanId,
    planDigest: result.planDigest ?? '—',
    terminalId: result.terminalId ?? '—',
    phase: result.phase,
    liveness: result.liveness,
    authority: authority
      ? [
          authority.dispatchId ? 'dispatch ' + authority.dispatchId : '',
          authority.taskId
            ? 'task ' + authority.taskId + '@' + (authority.taskRevision ?? '—')
            : 'no task authority',
          authority.phase ? 'phase ' + authority.phase : '',
          authority.authorityState ? 'authority ' + authority.authorityState : ''
        ]
          .filter(Boolean)
          .join(' · ')
      : 'no dispatch authority recorded',
    receipt: result.stageReceipt,
    failedStage: result.failedStage ?? '',
    nextAllowedActions: result.nextAllowedActions,
    residuals: result.residuals.map((r) => {
      const label = r.kind ?? r.resourceRef ?? r.effectId ?? 'residual'
      return r.state ? label + ' · ' + r.state : label
    }),
    join: result.joined ? 'joined ' + (result.joined.joinedAt ?? '—') : 'no join recorded',
    injectionReceipts: result.injectionReceipts.map((r) => r.phase + '@' + r.revision),
    processEvidence: result.processEvidence,
    probe: result.probe
  }
}
