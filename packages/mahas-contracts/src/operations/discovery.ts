// mahas-contracts/operations/discovery — C-DISCOVERY wire DTOs.
//
// These are renderer-safe operation payloads and projections. Runtime code
// owns validation, authorization, database rows, cursor sealing, and handler
// plumbing; consumers should not need any of those implementation details to
// make or display a discovery request.

/** contract projection for a boundary shown on a discovery card */
export interface CriterionSummary {
  id: string
  criterion: string
  description: string
  ordinal: number
}

export interface BoundarySummary {
  id: string
  name: string
  /** responsibility.statement — the boundary's single responsibility */
  responsibility: string
  criteria: CriterionSummary[]
}

export interface RoleSummary {
  id: string
  name: string
  /** professional responsibility, never a task instruction */
  description: string
  horizontalRole: string
}

/** why a card matched a query — an explanation, never a ranking score */
export interface MatchReason {
  kind:
    | 'path-exact'
    | 'path-prefix'
    | 'path-covered'
    | 'contract'
    | 'horizontal-role'
    | 'text'
    | 'scope'
  path?: string
  matchedPath?: string
  contractId?: string
  direction?: 'provides' | 'consumes'
  field?: 'responsibility' | 'criterion' | 'role-name' | 'role-description' | 'search-text'
  match?: 'fts' | 'substring'
  horizontalRoleName?: string
}

/** static relation context shown next to a candidate */
export interface RelationshipRef {
  kind: 'same-boundary' | 'contract' | 'contains'
  roleId?: string
  boundaryId?: string
  boundaryName?: string
  contractId?: string
  contractName?: string
  direction?: 'provides' | 'consumes' | 'parent' | 'child'
}

export interface AvailabilityBlocker {
  kind: 'profile-admission' | 'host-unverified' | 'component-unsupported' | 'interface-ambiguous'
  detail: string
}

/** published implementation metadata; component bodies and launch data stay private */
export interface ImplementationAvailability {
  implementationId: string
  revision: number
  interfaceDigest: string
  profileId: string
  profileRevision: number
  status: string
  profileState: string
  support: 'verified' | 'documented' | 'draft' | 'disabled' | 'unknown'
  blockers: AvailabilityBlocker[]
  observedAt: number
}

/** current role occupancy, which is an observation rather than a promise */
export interface MemberAvailability {
  memberId: string
  runId: string
  state: string
  generation: number
  assignmentKind?: 'coordination' | 'task'
  observedAt: number
}

/** structural filters from the request that this card actually covered */
export interface ScopeCoverage {
  matchedPaths: string[]
  matchedContractIds: string[]
  /** true when no scope boundary was requested or the card lies within it */
  coversScope: boolean
}

export interface CandidateCard {
  boundary: BoundarySummary
  role: RoleSummary
  matchReasons: MatchReason[]
  relationshipRefs: RelationshipRef[]
  implementationAvailability: ImplementationAvailability[]
  memberAvailability: MemberAvailability[]
  scopeCoverage: ScopeCoverage
  /** opaque integrity pin, never authorization */
  selectionToken: string
}

// ── responsibility.search ────────────────────────────────────────────────

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

export type SearchStatus = 'ok' | 'no-match' | 'ambiguous' | 'unassigned'

/** an input path that did not become a candidate; it carries its own reason */
export interface UnmatchedPath {
  path: string
  status: 'unassigned' | 'ambiguous' | 'invalid' | 'no-responsible-role'
  boundaryIds?: string[]
  reason?: string
}

export interface AmbiguityGroup {
  kind: 'territory-overlap'
  paths: string[]
  boundaryIds: string[]
}

export interface SearchResult {
  modelVersion: string
  snapshotRevision: number
  staleModel: boolean
  status: SearchStatus
  items: CandidateCard[]
  unmatchedPaths: UnmatchedPath[]
  ambiguityGroups: AmbiguityGroup[]
  diagnostics: {
    rolelessBoundaryIds: string[]
    unmatchedContractIds: string[]
  }
  nextCursor?: string
  visibility: {
    visibilityDigest: string
    grantRevisions: Record<string, number>
  }
}

// ── responsibility.inspect ───────────────────────────────────────────────

export type InspectPerspective = 'coordination' | 'owner'

export interface InspectRequest {
  projectId: string
  modelVersion: string
  boundaryId: string
  perspective: InspectPerspective
}

export interface ContractTension {
  contractId: string
  name: string
  providerBoundaryId: string
  consumerBoundaryIds: string[]
  crossing: 'internal' | 'inbound' | 'outbound'
}

/** authored coordination context. Missing stays explicit and is never synthesized. */
export interface CoordinationView {
  status: 'authored' | 'missing' | 'not-requested'
  clauses?: {
    clauseId: string
    contextId?: string
    criterionRef?: string
    requiredMeaning: string
    deliveryClass?: string
  }[]
  sourceInterfaces?: string[]
}

export interface InspectResult {
  modelVersion: string
  snapshotRevision: number
  perspective: InspectPerspective
  boundary: BoundarySummary
  children: BoundarySummary[]
  contractTensions: ContractTension[]
  nonGoals: { id: string; statement: string }[]
  roles: RoleSummary[]
  coordinationView: CoordinationView
  contextRefs: string[]
}

// ── responsibility.locate ────────────────────────────────────────────────

export interface LocateRequest {
  projectId: string
  modelVersion?: string
  paths: string[]
}

export interface LocateClaimant {
  boundaryId: string
  boundaryName: string
  matchedPath: string
  claim: 'owns' | 'covers'
  relation?: 'ancestor' | 'self' | 'unrelated'
}

export interface LocatedPath {
  path: string
  status: 'resolved' | 'ambiguous' | 'unassigned' | 'invalid'
  boundaryId?: string
  matchedPath?: string
  claimants: LocateClaimant[]
  ancestorClaimants?: LocateClaimant[]
  roles?: RoleSummary[]
  reason?: string
}

export interface LocateResult {
  modelVersion: string
  snapshotRevision: number
  staleModel: boolean
  items: LocatedPath[]
  visibility: {
    visibilityDigest: string
    grantRevisions: Record<string, number>
  }
}

// ── responsibility.collaborators ─────────────────────────────────────────

export interface CollaboratorsRequest {
  projectId: string
  modelVersion: string
  roleId: string
  runId?: string
}

export interface CollaboratorReason {
  kind: 'same-boundary' | 'contract' | 'contains'
  contractId?: string
  direction?: 'provides' | 'consumes' | 'parent' | 'child'
}

export interface Collaborator {
  role: RoleSummary
  boundaryId: string
  relationReasons: CollaboratorReason[]
  /** empty means this peer has no visible member in the requested run */
  members: { memberId: string; state: string }[]
}

export interface CollaboratorsResult {
  modelVersion: string
  snapshotRevision: number
  roleId: string
  runId?: string
  items: Collaborator[]
}

// ── role.implementations ─────────────────────────────────────────────────

export interface ImplementationsRequest {
  modelVersion: string
  roleId: string
  hostId?: string
  componentNeeds?: string[]
}

export interface ImplementationsResult {
  modelVersion: string
  snapshotRevision: number
  roleId: string
  interfaceDigests: string[]
  status: 'ok' | 'implementation-missing'
  implementations: ImplementationAvailability[]
  excluded: { implementationId: string; revision: number; missingNeeds: string[] }[]
}
