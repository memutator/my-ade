// workbench/plan-drafts.ts — the PlanPatch grammar, in both directions.
//
// readPlanDrafts turns the canonical CoordinatorRunProjection into editable
// rows; toPlanPatch turns those rows back into the exact PlanPatch grammar
// plan.prepare accepts. Fields the editor does not model are carried back
// untouched (InputBindingDraft.raw), fields the contract does not define are
// never sent, and an existing task keeps text the 팀장 cleared instead of
// erasing a requirement the plan still holds.

import type {
  AttemptDisposition,
  CoordinatorRunProjection,
  EdgePatch,
  InputBindingWire,
  OutputSlotWire,
  PlanPatch,
  TaskSpecPatch,
  TaskSpecProjection
} from './contracts.ts'

/* ── C-WORK: plan drafts <-> PlanPatch ─────────────────────────────────── */

/** one input binding row. `raw` keeps the wire fields this editor does not
 //  model so a partial edit round-trips them instead of dropping them. */
export interface InputBindingDraft {
  raw?: InputBindingWire
  slot: string
  kind: InputBindingWire['kind'] | string
  required: boolean
  taskId: string
  taskRevision: string
  outputSlot: string
  artifactId: string
  artifactRevision: string
  contractId: string
  contractRevision: string
  modelVersion: string
}

export interface OutputSlotDraft {
  raw?: OutputSlotWire
  slot: string
  description: string
  contractId: string
  required: boolean
}

export interface TaskSpecDraft {
  /** client-side key; never sent */
  key: string
  /** '' = a NEW task in the draft (the patch omits taskId) */
  taskId: string
  title: string
  requirementText: string
  ownerRoleId: string
  assignedMemberId: string
  /** loaded assignment — clearing it sends an explicit null */
  assignedMemberIdWas: string
  retired: boolean
  disposition: AttemptDisposition['action']
  inputs: InputBindingDraft[]
  outputs: OutputSlotDraft[]
  settlementText: string
  /** stringified loaded policy — unchanged text round-trips the value as-is */
  settlementTextWas: string
}

export interface EdgeDraft {
  key: string
  fromTask: string
  toTask: string
  /** comma-separated slots — split on send */
  requiredOutputs: string
  settlementRequirement: string
}

export interface PlanDraftModel {
  baseRevision?: number
  planDigest?: string
  tasks: TaskSpecDraft[]
  edges: EdgeDraft[]
}

function draftKey(): string {
  return crypto.randomUUID()
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function asRows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(asRecord).filter((r): r is Record<string, unknown> => !!r) : []
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
}

/** TaskSpecProjection.inputs is flexible JSON — read the documented fields */
function toInputDraft(row: Record<string, unknown>): InputBindingDraft {
  return {
    raw: row as unknown as InputBindingWire,
    slot: text(row['slot']),
    kind: text(row['kind']) || 'task-output',
    required: row['required'] !== false,
    taskId: text(row['taskId']),
    taskRevision: text(row['taskRevision']),
    outputSlot: text(row['outputSlot']),
    artifactId: text(row['artifactId']),
    artifactRevision: text(row['artifactRevision']),
    contractId: text(row['contractId']),
    contractRevision: text(row['contractRevision']),
    modelVersion: text(row['modelVersion'])
  }
}

function toOutputDraft(row: Record<string, unknown>): OutputSlotDraft {
  return {
    raw: row as unknown as OutputSlotWire,
    slot: text(row['slot']),
    description: text(row['description']),
    contractId: text(row['contractId']),
    required: row['required'] !== false
  }
}

function toTaskDraft(spec: TaskSpecProjection): TaskSpecDraft {
  const policy = spec.settlementPolicy
  return {
    key: spec.taskId,
    taskId: spec.taskId,
    title: spec.title,
    requirementText: spec.requirementText,
    ownerRoleId: spec.ownerRoleId,
    assignedMemberId: spec.assignedMemberId ?? '',
    assignedMemberIdWas: spec.assignedMemberId ?? '',
    retired: false,
    disposition: 'keep',
    inputs: asRows(spec.inputs ?? spec.inputBindings).map(toInputDraft),
    outputs: asRows(spec.outputs ?? spec.outputSlots).map(toOutputDraft),
    settlementText: typeof policy === 'string' ? policy : policy ? JSON.stringify(policy) : '',
    settlementTextWas: typeof policy === 'string' ? policy : policy ? JSON.stringify(policy) : ''
  }
}

/** an empty draft row for a task the plan does not have yet */
export function newTaskDraft(): TaskSpecDraft {
  return {
    key: draftKey(),
    taskId: '',
    title: '',
    requirementText: '',
    ownerRoleId: '',
    assignedMemberId: '',
    assignedMemberIdWas: '',
    retired: false,
    disposition: 'keep',
    inputs: [],
    outputs: [],
    settlementText: '',
    settlementTextWas: ''
  }
}

export function newInputDraft(): InputBindingDraft {
  return {
    slot: '',
    kind: 'task-output',
    required: true,
    taskId: '',
    taskRevision: '',
    outputSlot: '',
    artifactId: '',
    artifactRevision: '',
    contractId: '',
    contractRevision: '',
    modelVersion: ''
  }
}

export function newOutputDraft(): OutputSlotDraft {
  return { slot: '', description: '', contractId: '', required: true }
}

export function newEdgeDraft(): EdgeDraft {
  return {
    key: draftKey(),
    fromTask: '',
    toTask: '',
    requiredOutputs: '',
    settlementRequirement: ''
  }
}

/**
 * Coordinator run projection -> editable drafts. The plan revision shown is
 * the published one (plan.revision) and falls back to the run's current plan
 * pointer only when the projection carries no plan row.
 */
export function readPlanDrafts(projection: CoordinatorRunProjection): PlanDraftModel {
  return {
    baseRevision: projection.plan?.revision ?? projection.run.currentPlanRevision,
    planDigest: projection.plan?.digest,
    tasks: projection.planTasks.map(toTaskDraft),
    edges: projection.planEdges.map((edge) => ({
      key: draftKey(),
      fromTask: edge.predecessorTaskId,
      toTask: edge.successorTaskId,
      requiredOutputs: edge.requiredOutputNames.join(','),
      settlementRequirement: edge.settlementRequirement
    }))
  }
}

export function numeric(v: string): number | undefined {
  if (!v.trim()) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function trimmed(v: string): string | undefined {
  const s = v.trim()
  return s ? s : undefined
}

function toInputWire(draft: InputBindingDraft): InputBindingWire {
  // start from the loaded wire row (unknown fields survive) and overwrite
  // every field this editor owns, including the ones the 팀장 cleared
  const wire: InputBindingWire = {
    ...(draft.raw ?? {}),
    slot: draft.slot,
    kind: draft.kind as InputBindingWire['kind']
  }
  delete wire.taskId
  delete wire.taskRevision
  delete wire.outputSlot
  delete wire.artifactId
  delete wire.artifactRevision
  delete wire.contractId
  delete wire.contractRevision
  delete wire.modelVersion
  if (draft.kind === 'task-output') {
    const taskId = trimmed(draft.taskId)
    if (taskId) wire.taskId = taskId
    const outputSlot = trimmed(draft.outputSlot)
    if (outputSlot) wire.outputSlot = outputSlot
    const taskRevision = numeric(draft.taskRevision)
    if (taskRevision !== undefined) wire.taskRevision = taskRevision
  } else if (draft.kind === 'artifact') {
    const artifactId = trimmed(draft.artifactId)
    if (artifactId) wire.artifactId = artifactId
    const artifactRevision = numeric(draft.artifactRevision)
    if (artifactRevision !== undefined) wire.artifactRevision = artifactRevision
  } else if (draft.kind === 'contract') {
    const contractId = trimmed(draft.contractId)
    if (contractId) wire.contractId = contractId
    const contractRevision = numeric(draft.contractRevision)
    if (contractRevision !== undefined) wire.contractRevision = contractRevision
    const modelVersion = trimmed(draft.modelVersion)
    if (modelVersion) wire.modelVersion = modelVersion
  }
  if (draft.required) wire.required = true
  else delete wire.required
  return wire
}

function toOutputWire(draft: OutputSlotDraft): OutputSlotWire {
  const wire: OutputSlotWire = { ...(draft.raw ?? {}), slot: draft.slot }
  delete wire.description
  delete wire.contractId
  delete wire.required
  const description = trimmed(draft.description)
  if (description) wire.description = description
  const contractId = trimmed(draft.contractId)
  if (contractId) wire.contractId = contractId
  if (draft.required) wire.required = true
  return wire
}

/**
 * settlementPolicy is deliberately unknown JSON on the wire. The draft shows
 * it as text: unchanged text returns the loaded value untouched; edited text
 * is parsed as JSON when it is JSON and kept as a string otherwise.
 */
export function toSettlementPolicy(draft: TaskSpecDraft, loaded: unknown): unknown {
  const source = draft.settlementText
  if (!source.trim()) return undefined
  if (source === draft.settlementTextWas) return loaded
  const parsed = ((): unknown => {
    try {
      return JSON.parse(source)
    } catch {
      return undefined
    }
  })()
  return parsed === undefined ? source : parsed
}

function toTaskSpecPatch(draft: TaskSpecDraft, loaded: unknown): TaskSpecPatch {
  const patch: TaskSpecPatch = {}
  // taskId absent = a new task in this draft; the server mints the id
  if (draft.taskId) patch.taskId = draft.taskId
  // empty text on an existing task means "leave it as it was" — sending ''
  // would erase a requirement the plan still holds
  if (draft.taskId) {
    const title = trimmed(draft.title)
    if (title) patch.title = title
    const requirementText = trimmed(draft.requirementText)
    if (requirementText) patch.requirementText = requirementText
    const ownerRoleId = trimmed(draft.ownerRoleId)
    if (ownerRoleId) patch.ownerRoleId = ownerRoleId
  } else {
    patch.title = draft.title
    patch.requirementText = draft.requirementText
    patch.ownerRoleId = draft.ownerRoleId
  }
  if (draft.assignedMemberId) patch.assignedMemberId = draft.assignedMemberId
  // clearing a member is an explicit null, never an omission
  else if (draft.assignedMemberIdWas) patch.assignedMemberId = null
  patch.inputs = draft.inputs.map(toInputWire)
  patch.outputs = draft.outputs.map(toOutputWire)
  const policy = toSettlementPolicy(draft, loaded)
  if (policy !== undefined) patch.settlementPolicy = policy
  return patch
}

function toEdgePatch(draft: EdgeDraft): EdgePatch {
  const requiredOutputs = draft.requiredOutputs
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const patch: EdgePatch = { fromTask: draft.fromTask, toTask: draft.toTask }
  if (requiredOutputs.length) patch.requiredOutputs = requiredOutputs
  const settlement = trimmed(draft.settlementRequirement)
  if (settlement) patch.settlementRequirement = settlement
  return patch
}

/**
 * Drafts -> the exact PlanPatch grammar plan.prepare accepts:
 * {basePlanRevision, tasks, edges, retireTaskIds, activeAttemptDisposition}.
 * Edges with an endpoint the plan does not have are dropped locally — the
 * server's edge-endpoint error is for edges the 팀장 actually meant to send.
 *
 * A disposition row is sent for every task that already exists (including
 * retired ones): an attempt is never silently orphaned, and 'keep' is a
 * statement rather than an omission.
 */
export function toPlanPatch(
  model: PlanDraftModel,
  loadedTaskSpecs: Map<string, TaskSpecProjection>
): PlanPatch {
  const live = model.tasks.filter((t) => !t.retired)
  const knownTaskIds = new Set(model.tasks.map((t) => t.taskId).filter(Boolean))
  return {
    ...(model.baseRevision !== undefined ? { basePlanRevision: model.baseRevision } : {}),
    tasks: live.map((draft) =>
      toTaskSpecPatch(
        draft,
        draft.taskId ? loadedTaskSpecs.get(draft.taskId)?.settlementPolicy : undefined
      )
    ),
    edges: model.edges
      .filter((e) => e.fromTask && e.toTask && e.fromTask !== e.toTask)
      .filter((e) => knownTaskIds.has(e.fromTask) && knownTaskIds.has(e.toTask))
      .map(toEdgePatch),
    retireTaskIds: model.tasks.filter((t) => t.retired && t.taskId).map((t) => t.taskId),
    activeAttemptDisposition: model.tasks
      .filter((t) => t.taskId)
      .map((t) => ({ taskId: t.taskId, action: t.disposition }))
  }
}
