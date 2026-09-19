// mahas-runtime/inspector — projections from op envelopes to view models.
//
// IMP-32 §4 semantics this file encodes — all of them are DISPLAY honesty
// rules, never state synthesis:
//   · coverage joins interface clauses → bindings → components; a clause
//     realized ONLY through a conditional-load route is flagged
//     'conditional-only' and never hidden (S-INJECTION §1–2)
//   · component kind support is read off the real HarnessProfile; no
//     profile observation → 'unknown', never assumed supported
//   · context evidence lanes (planned / materialized / attached /
//     worker_joined / inherited unknown) show exactly what the receipt
//     records — a manifest entry alone is never "injected" (IMP-32 §4.4)
//   · allowed commands (surface) and actual grants are kept as separate
//     sections — editing requiredActions is not granting (IMP-32 §4.3)
//   · the launch ladder shows the receipt's recorded stages; absent
//     evidence → 'unknown', never an implied 'done' (C-LAUNCH)
//
// Pure functions over the envelopes in protocol.ts — the desktop main and
// the operator CLI both consume them so every client shows the same truth.

import type {
  CoverageBinding,
  HarnessProfile,
  ImplementationComponent,
  InterfaceMaintenanceRef,
  RoleImplementation,
  ContextRequirement,
  RoleInterface
} from '../../../mahas-contracts/src/role.ts'
import type { ResidualResource } from '../../../mahas-contracts/src/work.ts'
import type { DomainEvent } from '../../../mahas-contracts/src/observation.ts'
import type {
  AccessInspectResult,
  AttachedPhase,
  ContextInspectResult,
  ContextUnknown,
  GrantInspectSummary,
  HarnessProfileInspectResult,
  ImplementationOffer,
  ImplementationPrepareResult,
  ImplementationPublishResult,
  ImplementationRetireResult,
  InheritedInput,
  InterfaceGetResult,
  LaunchBlocker,
  LaunchPin,
  PlannedComponent,
  RuntimeSnapshotResult,
  RuntimeSubscribeResult,
  SnapshotEntity,
  StageReceipt,
  StageRecord,
  SurfaceDescribeResult,
  SurfaceOperationDescriptor,
  WorkerInspectResult,
  WorkerInspectTaskAuthority,
  WorkerJoinEvidence,
  WorkerPrepareResult
} from './protocol.ts'

// ── tolerant readers (op results are JSON; IMP-02 pins the exact schema) ──

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** the authoritative spawn stage chain (C-LAUNCH §"스폰의 권위 있는 stage") —
 *  coordination assignments end at coordination_ready instead of
 *  task_accepted; both terminals are shown, the receipt marks its own */
export const LAUNCH_STAGES: readonly string[] = [
  'admitted',
  'inputs_pinned',
  'resources_claimed',
  'components_materialized',
  'process_attempting',
  'process_confirmed',
  'initial_attached',
  'awaiting_join',
  'joined',
  'task_accepted',
  'coordination_ready'
]

// ── role implementation editor view ───────────────────────────────────────

/** component kind support read off the observed HarnessProfile.
 *  null = no profile observation → every kind shows 'unknown' */
export function supportedKindsOf(profile: unknown): Set<string> | null {
  const p = rec(profile)
  if (!p) return null
  const raw = p['supportedComponents']
  if (!Array.isArray(raw)) return null
  const kinds = new Set<string>()
  for (const e of raw) {
    const k = str(e) ?? str(rec(e)?.['kind'])
    if (k) kinds.add(k)
  }
  return kinds
}

function activationLabel(c: ImplementationComponent | null): string | undefined {
  if (!c) return undefined
  const a = (c as unknown as Record<string, unknown>)['activation']
  return str(a) ?? str(rec(a)?.['phase']) ?? str(rec(a)?.['when'])
}

function loadPhaseOf(b: CoverageBinding | null): string | undefined {
  if (!b) return undefined
  const p = (b as unknown as Record<string, unknown>)['requiredLoadPhase']
  return str(p) ?? str(rec(p)?.['phase'])
}

export type CoverageGap = 'none' | 'uncovered' | 'conditional-only'

export interface CoverageRow {
  clauseId: string
  contextRef?: string
  requiredMeaning?: string
  deliveryClass?: string
  readerPerspective?: string
  binding: CoverageBinding | null
  component: ImplementationComponent | null
  /** verbatim | reexpressed — the author's chosen resolution (REQ-06) */
  realization?: string
  requiredLoadPhase?: string
  componentKind?: string
  componentActivation?: string
  support: 'supported' | 'unsupported' | 'unknown'
  gap: CoverageGap
}

/**
 * Join required clauses to their coverage. A binding that reaches the
 * clause only through a conditional load (binding phase or component
 * activation marked conditional) is a 'conditional-only' gap — an
 * initial requirement needs an initial route (role-realization §4–5).
 */
export function coverageRows(
  requirements: readonly ContextRequirement[],
  bindings: readonly CoverageBinding[],
  components: readonly ImplementationComponent[],
  supportedKinds: Set<string> | null
): CoverageRow[] {
  const byClause = new Map<string, CoverageBinding>()
  for (const b of bindings) {
    const cid = str((b as unknown as Record<string, unknown>)['clauseId'])
    if (cid && !byClause.has(cid)) byClause.set(cid, b)
  }
  const byId = new Map<string, ImplementationComponent>()
  for (const c of components) {
    const id = str((c as unknown as Record<string, unknown>)['componentId'])
    if (id && !byId.has(id)) byId.set(id, c)
  }
  return requirements.map((req) => {
    const rr = req as unknown as Record<string, unknown>
    const clauseId = str(rr['clauseId']) ?? '(unlabeled clause)'
    const binding = byClause.get(clauseId) ?? null
    const componentId = str((binding as Record<string, unknown> | null)?.['componentId'])
    const component = componentId ? (byId.get(componentId) ?? null) : null
    const phase = loadPhaseOf(binding)
    const activation = activationLabel(component)
    const kind = str((component as Record<string, unknown> | null)?.['kind'])
    const support: CoverageRow['support'] = !component
      ? 'unknown'
      : supportedKinds === null
        ? 'unknown'
        : kind && supportedKinds.has(kind)
          ? 'supported'
          : 'unsupported'
    const deliveryClass = str(rr['deliveryClass'])
    const conditionalRoute =
      (phase !== undefined && phase !== 'initial') || activation === 'conditional'
    const gap: CoverageGap = !binding
      ? 'uncovered'
      : deliveryClass === 'initial' && conditionalRoute
        ? 'conditional-only'
        : 'none'
    return {
      clauseId,
      contextRef: str(rr['contextId']) ?? str(rr['criterionRef']),
      requiredMeaning: str(rr['requiredMeaning']),
      deliveryClass,
      readerPerspective: str(rr['readerPerspective']),
      binding,
      component,
      realization: str((binding as Record<string, unknown> | null)?.['realization']),
      requiredLoadPhase: phase,
      componentKind: kind,
      componentActivation: activation,
      support,
      gap
    }
  })
}

export interface ComponentSupportRow {
  componentId: string
  kind?: string
  activation?: string
  supported: 'supported' | 'unsupported' | 'unknown'
  /** actions the component ASKS for — displayed as requests, never as
   *  granted permissions (IMP-32 §4.3; C-ACCESS decides real grants) */
  requiredActions: string[]
}

export function componentSupportRows(
  components: readonly ImplementationComponent[],
  supportedKinds: Set<string> | null
): ComponentSupportRow[] {
  return components.map((c) => {
    const cr = c as unknown as Record<string, unknown>
    const kind = str(cr['kind'])
    const req = arr(cr['permissionRequirements'])
      .map((p) => str(p) ?? str(rec(p)?.['action']) ?? str(rec(p)?.['name']))
      .filter((x): x is string => typeof x === 'string')
    return {
      componentId: str(cr['componentId']) ?? '(unnamed)',
      kind,
      activation: activationLabel(c),
      supported:
        supportedKinds === null
          ? 'unknown'
          : kind && supportedKinds.has(kind)
            ? 'supported'
            : 'unsupported',
      requiredActions: req
    }
  })
}

export interface InterfaceEditorView {
  iface: RoleInterface
  requirements: ContextRequirement[]
  digest: string
  /** model-derived staleness refs (InterfaceMaintenanceRef, not a binding) */
  maintenanceRefs: InterfaceMaintenanceRef[]
  /** published implementation candidates for this interface (real rows) */
  offers: ImplementationOffer[]
  /** the observed profile + its supported component kinds (null = unknown) */
  profile: HarnessProfile | null
  admissionState?: string
  supportedKinds: string[] | null
}

export function projectInterface(
  ifaceRes: InterfaceGetResult,
  impls: ImplementationOffer[] | undefined,
  profile: HarnessProfileInspectResult | undefined
): InterfaceEditorView {
  const kinds = supportedKindsOf(profile?.profile)
  return {
    iface: ifaceRes.interface,
    requirements: ifaceRes.contextRequirements,
    digest: String(ifaceRes.digest),
    maintenanceRefs: ifaceRes.maintenanceRefs,
    offers: impls ?? [],
    profile: profile?.profile ?? null,
    admissionState: profile?.admissionState,
    supportedKinds: kinds ? [...kinds] : null
  }
}

// ── context inspector view (IMP-32 §4.4) ──────────────────────────────────

/** one load-evidence row read VERBATIM from the receipt — its phase/route
 *  strings stay exactly as recorded so the UI can never overstate them */
export interface LoadEvidenceRow {
  componentId: string
  phase?: string
  route?: string
  target?: string
  byteDigest?: string
  raw?: unknown
}

/** pull componentId-bearing records out of a receipt of any depth */
function evidenceRows(receipt: unknown): LoadEvidenceRow[] {
  const out: LoadEvidenceRow[] = []
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit)
      return
    }
    const r = rec(v)
    if (!r) return
    const cid = str(r['componentId']) ?? str(r['component'])
    if (cid) {
      const target =
        str(r['actualPath']) ??
        (r['argvIndex'] !== undefined ? `argv[${String(r['argvIndex'])}]` : undefined) ??
        str(r['configKey']) ??
        str(r['target'])
      out.push({
        componentId: cid,
        phase: str(r['loadingPhase']) ?? str(r['phase']) ?? str(r['stage']),
        route: str(r['route']) ?? str(r['kind']),
        target,
        byteDigest: str(r['byteDigest']) ?? str(r['digest']),
        raw: r
      })
      return
    }
    for (const val of Object.values(r)) {
      if (isObj(val)) visit(val)
    }
  }
  visit(receipt)
  return out
}
function isObj(v: unknown): boolean {
  return (typeof v === 'object' && v !== null) || Array.isArray(v)
}

export interface ContextInspectView {
  bundleDigest?: string
  executionId?: string
  /** the requested resolution level — own | composition | maintenance */
  detail?: string
  /** manifest-declared components — a plan, NOT injection evidence */
  planned: PlannedComponent[]
  /** load evidence recorded in the real receipt (empty when none) */
  evidence: LoadEvidenceRow[]
  /** recorded delivery evidence exists at all (one row per receipt revision) */
  hasReceipt: boolean
  /** the recorded receipt revisions, verbatim */
  attached: AttachedPhase[]
  /** planned componentIds with no materialized-phase evidence */
  missing: string[]
  inherited: InheritedInput[]
  /** explicitly unknown inherited inputs — shown, never filled in */
  unknowns: ContextUnknown[]
  /** the pins this execution/bundle was resolved against */
  pins: ContextInspectResult['pins']
  manifestDigest?: string
}

export function projectContextInspect(res: ContextInspectResult): ContextInspectView {
  return {
    bundleDigest: str(res.bundleDigest),
    executionId: str(res.executionId),
    planned: res.planned,
    evidence: evidenceRows(res.attached),
    hasReceipt: res.attached.length > 0,
    attached: res.attached,
    missing: res.missing,
    inherited: res.inherited,
    pins: res.pins,
    manifestDigest: res.manifestDigest,
    unknowns: res.unknowns ?? []
  }
}

// ── access inspector view (IMP-32 §4.3) ───────────────────────────────────

export interface SurfaceOperationRow {
  operation: string
  summary?: string
  schema?: unknown
}

/**
 * the visible command descriptors, verbatim. The surface.describe result IS
 * the projected surface — the descriptor list already holds exactly the
 * allowed set, so nothing here re-derives or filters it.
 */
export function surfaceOperations(
  operations: SurfaceOperationDescriptor[] | undefined
): SurfaceOperationRow[] {
  return (operations ?? []).map((op) => ({
    operation: op.name,
    summary: op.summary ?? undefined,
    schema: op.inputSchema
  }))
}

export interface AccessInspectView {
  /** section 1 — the surface's ALLOWED command list (surface.describe) */
  allowedOperations: SurfaceOperationRow[]
  surfaceDigest?: string
  /** section 2 — what CURRENT grants actually permit (access.inspect) */
  /** the inspected subject: member id or the single inspected grant id */
  memberId?: string
  grantId?: string
  policy?: { policyId?: string; policyRevision?: number } | null
  effectiveActions: string[]
  /** one row per grant behind the subject — each with its own status */
  grants: GrantInspectSummary[]
  /** true when every grant row behind the subject is revoked or expired */
  revoked: boolean
}

export function projectAccessInspect(
  surfaceRes: SurfaceDescribeResult | undefined,
  accessRes: AccessInspectResult | undefined
): AccessInspectView {
  const grants = accessRes?.grants ?? []
  return {
    allowedOperations: surfaceOperations(surfaceRes?.operations),
    surfaceDigest: surfaceRes?.surfaceDigest,
    memberId: accessRes?.memberId,
    grantId: accessRes?.grantId,
    policy: accessRes?.policy,
    effectiveActions: accessRes?.effectiveActions ?? [],
    grants,
    // "revoked" is only claimed when there IS a grant row and none is live
    revoked: grants.length > 0 && grants.every((g) => g.status !== 'active')
  }
}

// ── launch plan view (worker.prepare — IMP-32 §4.5) ───────────────────────

export interface LaunchPlanView {
  /** the pinned plan identity + digest (the plan row's own key) */
  launchPlanId: string
  planDigest?: string
  state: string
  /** true when identical pins were already planned (idempotent re-prepare) */
  existing: boolean
  /** exact pins the plan fixes — shown verbatim, never re-resolved */
  pins: LaunchPin[]
  /** argv array verbatim — a process spec is never a shell string */
  processArgv?: string[]
  processSpecRaw: unknown
  blockers: LaunchBlocker[]
  /** paths/ids of components the plan requires */
  requiredComponents: string[]
  /** the surface the plan pins: digest + the actions it exposes */
  plannedSurface: { digest: string; actions: string[] }
  reservations: { reservationId: string; kind: string; mode: string }[]
}

function pinsOf(pins: unknown): LaunchPin[] {
  if (Array.isArray(pins)) {
    return pins.map((p) => {
      const r = rec(p)
      if (!r) return { name: 'pin', value: String(p) }
      const name = str(r['name']) ?? str(r['key']) ?? 'pin'
      const raw = r['value'] ?? r['digest'] ?? r['revision'] ?? r
      return { name, value: typeof raw === 'string' ? raw : JSON.stringify(raw) }
    })
  }
  const m = rec(pins)
  if (m) {
    return Object.entries(m).map(([k, v]) => ({
      name: k,
      value: typeof v === 'string' ? v : JSON.stringify(v)
    }))
  }
  return []
}

export function projectWorkerPrepare(res: WorkerPrepareResult): LaunchPlanView {
  const spec = rec(res.processSpec)
  const argv = spec
    ? arr(spec['argv']).filter((a): a is string => typeof a === 'string')
    : undefined
  return {
    launchPlanId: res.launchPlanId,
    planDigest: res.digest,
    state: res.state,
    existing: res.existing,
    pins: pinsOf(res.pins),
    processArgv: argv && argv.length ? argv : undefined,
    processSpecRaw: res.processSpec,
    blockers: res.blockers,
    requiredComponents: res.requiredComponents,
    plannedSurface: res.plannedSurface,
    reservations: res.reservations
  }
}

// ── worker inspect view (worker.inspect — IMP-32 §4.5) ────────────────────

export interface StageRow {
  stage: string
  state: 'reached' | 'failed' | 'current' | 'unreached' | 'unknown'
  at?: number
  evidence?: unknown
}

/**
 * Order the cumulative receipt over the authoritative stage chain. Stages
 * are 'reached' only when the receipt records them; anything after the
 * failed/current stage is 'unreached'; with no receipt every stage is
 * 'unknown' — a recorded phase is never expanded into implied progress.
 */
export function stageRows(receipt: StageReceipt | null | undefined, phase?: string): StageRow[] {
  const reached = new Map<string, StageRecord>()
  for (const s of receipt?.stages ?? []) {
    if (str(s.stage)) reached.set(s.stage, s)
  }
  const failed = receipt?.failedStage
  const current = receipt?.currentStage ?? phase
  const rows: StageRow[] = []
  let pastCurrent = false
  for (const stage of LAUNCH_STAGES) {
    const recd = reached.get(stage)
    if (stage === failed) {
      pastCurrent = true
      rows.push({ stage, state: 'failed', at: recd?.at, evidence: recd?.evidence })
      continue
    }
    if (recd) {
      rows.push({ stage, state: 'reached', at: recd.at, evidence: recd.evidence })
      continue
    }
    if (stage === current) {
      pastCurrent = true
      rows.push({ stage, state: 'current' })
      continue
    }
    if (pastCurrent) {
      rows.push({ stage, state: 'unreached' })
      continue
    }
    rows.push({ stage, state: receipt ? 'unknown' : 'unknown' })
  }
  // stages the receipt names outside the canonical chain are appended
  // verbatim — unknown names are still real evidence
  for (const s of receipt?.stages ?? []) {
    if (str(s.stage) && !LAUNCH_STAGES.includes(s.stage)) {
      rows.push({ stage: s.stage, state: 'reached', at: s.at, evidence: s.evidence })
    }
  }
  return rows
}

export interface WorkerInspectView {
  executionId: string
  memberId: string
  generation: number
  hostId: string
  launchPlanId: string
  planDigest?: string
  terminalId: string | null
  /** the reported phase — verbatim; not expanded into implied stages */
  phase: string
  liveness: string
  stages: StageRow[]
  failedStage?: string
  residuals: ResidualResource[]
  nextAllowedActions: string[]
  processEvidence: unknown
  /** present only when the caller asked the host to probe */
  probe?: unknown
  taskAuthority: WorkerInspectTaskAuthority | null
  /** the join evidence recorded for this execution's current generation */
  joined: WorkerJoinEvidence | null
  /** recorded injection receipt revisions, verbatim */
  injectionReceipts: { phase: string; revision: number }[]
  /** the cumulative stage receipt — evidence, never a completion verdict */
  stageReceipt: StageReceipt | null
}

export function projectWorkerInspect(res: WorkerInspectResult): WorkerInspectView {
  return {
    executionId: res.executionId,
    memberId: res.memberId,
    generation: res.generation,
    hostId: res.hostId,
    launchPlanId: res.launchPlanId,
    planDigest: res.planDigest,
    terminalId: res.terminalId,
    phase: res.phase,
    liveness: res.liveness,
    stages: stageRows(res.stageReceipt, res.phase),
    failedStage: res.failedStage,
    residuals: res.residuals,
    nextAllowedActions: res.nextAllowedActions,
    processEvidence: res.processEvidence,
    probe: res.probe,
    taskAuthority: res.taskAuthority,
    joined: res.joined,
    injectionReceipts: res.injectionReceipts,
    stageReceipt: res.stageReceipt
  }
}

// ── mutation outcome views ────────────────────────────────────────────────

export interface ImplementationPrepareView {
  candidate: RoleImplementation
  candidateId?: string
  digest: string
  /** structural diagnostics the server computed — shown verbatim, and
   *  never presented as a semantic sufficiency proof (C-REALIZATION) */
  uncoveredClauses: string[]
  unsupportedComponents: ImplementationComponent[]
}

export function projectImplementationPrepare(
  res: ImplementationPrepareResult
): ImplementationPrepareView {
  return {
    candidate: res.candidate,
    candidateId: str(res.candidateId),
    digest: res.digest,
    uncoveredClauses: res.uncoveredClauses ?? [],
    unsupportedComponents: res.unsupportedComponents ?? []
  }
}

export interface ImplementationPublishView {
  implementationId?: string
  revision?: number | string
}

export function projectImplementationPublish(
  res: ImplementationPublishResult
): ImplementationPublishView {
  return {
    implementationId: str(res.implementationId),
    revision: res.revision !== undefined ? String(res.revision) : undefined
  }
}

export interface ImplementationRetireView {
  status: string
  referencingExecutions: string[]
}

export function projectImplementationRetire(
  res: ImplementationRetireResult
): ImplementationRetireView {
  return {
    status: res.status,
    referencingExecutions: (res.referencingExecutions ?? []).map(String)
  }
}

export interface HarnessProfileView {
  profile: HarnessProfile
  supportedKinds: string[] | null
  admissionState?: string
  observedExecutableIdentity?: string
  capabilities?: unknown
}

export function projectHarnessProfile(res: HarnessProfileInspectResult): HarnessProfileView {
  const kinds = supportedKindsOf(res.profile)
  return {
    profile: res.profile,
    supportedKinds: kinds ? [...kinds] : null,
    admissionState: res.admissionState ?? str(rec(res.profile)?.['admissionState']),
    observedExecutableIdentity: res.observedExecutableIdentity,
    capabilities: res.capabilities
  }
}

export interface SurfaceView {
  operations: SurfaceOperationRow[]
  surfaceDigest: string
  /** true when the caller pinned a different digest — the fresh one is returned */
  stale: boolean
}

export function projectSurfaceDescribe(res: SurfaceDescribeResult): SurfaceView {
  return {
    operations: surfaceOperations(res.operations),
    surfaceDigest: res.surfaceDigest,
    stale: res.stale
  }
}

export interface RoleImplementationsView {
  implementations: ImplementationOffer[]
}

// ── runtime snapshot/subscribe views (C-OBSERVATION) ──────────────────────

export interface RuntimeSnapshotView {
  epoch?: number
  sequence?: number
  visibilityDigest?: string
  entities: SnapshotEntity[]
}

export function projectRuntimeSnapshot(res: RuntimeSnapshotResult): RuntimeSnapshotView {
  return {
    epoch: num(res.epoch),
    sequence: num(res.sequence),
    visibilityDigest: res.visibilityDigest,
    entities: res.entities ?? []
  }
}

export interface RuntimeSubscribeView {
  events: DomainEvent[]
  nextSequence?: number
  visibilityDigest?: string
}

export function projectRuntimeSubscribe(res: RuntimeSubscribeResult): RuntimeSubscribeView {
  return {
    events: res.events ?? [],
    nextSequence: res.nextSequence,
    visibilityDigest: res.visibilityDigest
  }
}
