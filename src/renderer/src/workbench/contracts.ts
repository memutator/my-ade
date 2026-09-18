// workbench/contracts.ts — wire shapes for the 팀장 workbench (IMP-31).
//
// These are the OPERATION PAYLOAD shapes the workbench sends/reads for
// C-DISCOVERY (IMP-06), C-WORK preview/assign/plan (IMP-13) and
// C-OBSERVATION snapshot/subscribe (IMP-26). The contracts fix the field
// lists (spec/contracts/discovery-assignment.md, work.md,
// observation-client.md); the operation OWNERS fix the envelope — this file
// codes against the documented shapes, never against peer internals.
//
// Entity types are the SHARED-APIS canonical names from mahas-contracts
// (IMP-02, landing in parallel): `import type` from the promised modules so
// this surface converges on the real model when it lands — nothing local
// redefines them. Until IMP-02 lands the type imports below are unresolved
// on purpose; tsc settles then. Ids/revisions are plain strings/numbers on
// the wire (identity.ts convention — branding is deliberately not applied).

import type {
  Boundary,
  Criterion,
  NonGoal,
  Role
} from '../../../../packages/mahas-contracts/src/rdd.ts'
import type {
  Assignment,
  InputBinding,
  Member,
  OutputSlot,
  Run,
  TaskEdge,
  TaskSpec
} from '../../../../packages/mahas-contracts/src/work.ts'
import type { RoleImplementation } from '../../../../packages/mahas-contracts/src/role.ts'
import type { DomainEvent } from '../../../../packages/mahas-contracts/src/observation.ts'

// re-export the canonical names the views consume — one import site carries
// the pending-IMP-02 resolution instead of every component
export type {
  Assignment,
  Boundary,
  Criterion,
  DomainEvent,
  InputBinding,
  Member,
  NonGoal,
  OutputSlot,
  Role,
  RoleImplementation,
  Run,
  TaskEdge,
  TaskSpec
}

// ── C-DISCOVERY · responsibility.search ─────────────────────────
// Contract: SearchRequest = projectId, modelVersion?, query?, paths[],
// contractIds[], horizontalRoleNames[], scopeBoundaryId?, cursor?, limit.
// At least a query OR one structural filter is required.

export interface SearchRequest {
  projectId: string
  modelVersion?: string
  query?: string
  paths?: string[]
  contractIds?: string[]
  horizontalRoleNames?: string[]
  scopeBoundaryId?: string
  cursor?: string
  limit?: number
}

/** contract projection: boundary{id,name,responsibility,criteria} */
export interface CardBoundary {
  id: string
  name: string
  responsibility: string
  criteria: Criterion[]
}

/** contract projection: role{id,name,description,horizontalRole} */
export interface CardRole {
  id: string
  name: string
  description: string
  horizontalRole: string
}

/** one match explanation — path / contract / text hit (lexical aid, never
 //  an expertise score: REQ-04, C-DISCOVERY §검색 표현) */
export interface MatchReason {
  kind?: string
  detail?: string
  path?: string
  contractId?: string
}

/** a contract/contains/same-boundary relation worth showing the 팀장 */
export interface RelationshipRef {
  kind?: string
  reason?: string
  boundaryId?: string
  roleId?: string
  contractId?: string
  direction?: string
  detail?: string
}

/** observed availability — implementation OR member. Carries an observation
 //  time; it is current information, never a future-execution guarantee. */
export interface AvailabilityEntry {
  state?: string
  summary?: string
  detail?: string
  observedAt?: number
  memberId?: string
  memberState?: string
  implementationId?: string
  implementationRevision?: number
  profile?: string
}

export interface ScopeCoverage {
  covered?: string[]
  uncovered?: string[]
  summary?: string
}

/** C-DISCOVERY CandidateCard — note what is NOT here: implementation file
 //  contents (REQ-06) and any assign action. selectionToken is opaque
 //  integrity data for preview/assign, not bearer authorization. */
export interface CandidateCard {
  boundary: CardBoundary
  role: CardRole
  matchReasons: MatchReason[]
  relationshipRefs: RelationshipRef[]
  implementationAvailability: AvailabilityEntry[]
  memberAvailability: AvailabilityEntry[]
  scopeCoverage?: ScopeCoverage
  selectionToken: string
}

export interface AmbiguityGroup {
  reason?: string
  paths?: string[]
  candidateRoleIds?: string[]
  [k: string]: unknown
}

export interface SearchResponse {
  candidates: CandidateCard[]
  unmatchedPaths: string[]
  ambiguityGroups: AmbiguityGroup[]
  nextCursor?: string
  modelVersion: string
}

// ── C-DISCOVERY · responsibility.inspect ────────────────────────

export type InspectPerspective = 'coordination' | 'owner'

export interface InspectRequest {
  projectId: string
  modelVersion: string
  boundaryId: string
  perspective: InspectPerspective
}

/** coordination resolution: 책임·기준·직접 자식 책임·contract 긴장·
 //  non-goals·role 목록. An authored upper view may be absent — the server
 //  says so explicitly; the UI must not paper it over with a fresh summary
 //  (REQ-06, C-DISCOVERY inspect). */
export interface InspectResult {
  responsibility: string
  criteria: Criterion[]
  children: Boundary[]
  contractTensions: RelationshipRef[]
  nonGoals: NonGoal[]
  roles: Role[]
  /** authored coordination view text; absent/null = missing-view */
  coordinationView?: string | null
  viewStatus?: 'present' | 'missing'
}

// ── C-DISCOVERY · responsibility.locate ─────────────────────────

export interface LocateRequest {
  projectId: string
  modelVersion?: string
  paths: string[]
}

export type LocateStatus = 'assigned' | 'ambiguous' | 'unassigned'

export interface LocateResult {
  path: string
  status: LocateStatus
  boundaryId?: string
  boundaryName?: string
  roles?: CardRole[]
  /** competing territories when ambiguous — never silently tie-broken */
  candidates?: CardBoundary[]
}

export interface LocateResponse {
  results: LocateResult[]
  modelVersion?: string
}

// ── C-DISCOVERY · responsibility.collaborators ──────────────────

export interface CollaboratorsRequest {
  projectId: string
  modelVersion: string
  roleId: string
  runId?: string
}

export type RelationReason = 'same-boundary' | 'contract' | 'contains'

/** a related role, resolved to a Run member address ONLY when a real Member
 //  exists — unassigned relations return the role alone (no invented
 //  address, C-DISCOVERY collaborators). */
export interface Collaborator {
  roleId: string
  roleName?: string
  memberId?: string
  memberState?: string
  relationReason: RelationReason | string
  contractId?: string
  direction?: string
}

export interface CollaboratorsResponse {
  collaborators: Collaborator[]
}

// ── C-DISCOVERY · role.implementations ──────────────────────────

export interface ImplementationsRequest {
  modelVersion: string
  roleId: string
  hostId?: string
  componentNeeds?: string[]
}

/** implementationRevision/interfaceDigest/profile/support/blockers —
 //  'documented' vs 'verified' support stays distinct; a missing
 //  implementation is a result state, not a fallback (C-DISCOVERY). */
export interface ImplementationOffer {
  implementationId: string
  implementationRevision: number
  interfaceDigest?: string
  profile?: string
  support?: string
  blockers?: string[]
}

export interface ImplementationsResponse {
  implementations: ImplementationOffer[]
}

// ── C-WORK · assignment.preview / team.assign ───────────────────

export type AssignmentKind = 'coordination' | 'task'

export interface PreviewRequest {
  runId: string
  selectionToken: string
  implementationRevision: number
  assignmentKind: AssignmentKind
  mandateText: string
  taskId?: string
  taskRevision?: number
  placementIntent?: string
}

/** preview receipt — shows relations/feasibility BEFORE commit; no Member,
 //  Dispatch, process or grant is created by asking (C-DISCOVERY preview). */
export interface AssignmentPreview {
  proposedMember?: Member
  proposedAssignment?: Assignment
  requiredActions: string[]
  grantCoverage?: unknown
  contextBlockers: string[]
  resourceConditions: string[]
}

export interface AssignRequest extends PreviewRequest {
  expectedPlanRevision?: number
}

export interface AssignResult {
  memberId: string
  assignmentId: string
  effectiveGrantBinding?: unknown
  state?: string
}

// ── C-WORK · plan.prepare / plan.commit / run.get ───────────────

/** a TaskSpecRevision payload inside a PlanPatch — taskId absent = a new
 //  task in the draft; revision identifies the spec version being replaced. */
export interface PlanTaskDraft {
  taskId?: string
  revision?: number
  title: string
  requirementText: string
  ownerRoleId?: string
  assignedMemberId?: string
  inputBindings: InputBinding[]
  outputSlots: OutputSlot[]
  settlementPolicy?: unknown
}

/** execution-order edge only — 'talking to each other' is NEVER an edge
 //  (work.md Plan 문법). requiredOutputs names the predecessor slots the
 //  successor waits on. */
export interface PlanEdgeDraft {
  fromTask: string
  toTask: string
  requiredOutputs: string[]
  settlementRequirement?: string
}

/** what happens to an existing attempt when its TaskSpec is revised —
 //  required for active attempts; never implied (work.md). */
export interface AttemptDisposition {
  taskId: string
  dispatchId?: string
  disposition: 'keep' | 'stop' | string
}

/** work.md: PlanPatch = {basePlanRevision, tasks, edges, retireTaskIds,
 //  activeAttemptDisposition} — all endpoints in the same Run. */
export interface PlanPatch {
  basePlanRevision: number
  tasks: PlanTaskDraft[]
  edges: PlanEdgeDraft[]
  retireTaskIds?: string[]
  activeAttemptDisposition?: AttemptDisposition[]
}

export interface PreparePlanRequest {
  runId: string
  patch: PlanPatch
}

export interface PreparePlanResult {
  candidatePlanId: string
  digest: string
  structuralErrors: string[]
  unresolvedInputs: string[]
}

export interface CommitPlanRequest {
  candidatePlanId: string
  digest: string
  expectedPlanRevision: number
}

export interface CommitPlanResult {
  planRevision: number
  eligibility?: unknown
}

export interface RunGetRequest {
  runId: string
  projection: 'coordinator' | 'member'
}

/** coordinator projection of a Run — the contract returns Run/Plan state
 //  plus allowed relation views; the workbench reads tasks/edges/members
 //  tolerantly (whatever the run.get owner projects). */
export interface RunProjection {
  run?: Run
  planRevision?: number
  tasks?: TaskSpec[]
  edges?: TaskEdge[]
  members?: Member[]
  [k: string]: unknown
}

// ── C-OBSERVATION · runtime.snapshot / runtime.subscribe ────────

export interface SnapshotRequest {
  scope?: unknown
  projectionPurpose?: string
}

/** epoch+sequence cursor and the visible entity projection — a snapshot is
 //  replayable state for UI recovery, never a completion verdict
 //  (C-OBSERVATION, REQ-23). */
export interface RuntimeSnapshot {
  epoch: number
  sequence: number
  visibilityDigest?: string
  entities: Record<string, unknown[]>
}

export interface SubscribeRequest {
  scope?: unknown
  epoch: number
  afterSequence: number
  visibilityDigest?: string
}

/** one pushed runtime event — cursor fields let the client detect a gap
 //  (SNAPSHOT_REQUIRED → re-snapshot, never silently resync). */
export interface RuntimeEvent {
  sequence: number
  epoch?: number
  kind?: string
  entity?: unknown
  snapshotRequired?: boolean
}
