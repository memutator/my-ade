// mahas-runtime/src/discovery/types.ts — C-DISCOVERY wire types.
//
// Contract: spec/contracts/discovery-assignment.md (assignment.preview
// excluded — IMP-13). These shapes are the operation payloads of the five
// owned operations: responsibility.search / responsibility.inspect /
// responsibility.locate / responsibility.collaborators /
// role.implementations.
//
// Rules honored here (REQ-04/06/09):
//  - search results are candidates and relations for a 팀장 to read, never
//    an auto-selected assignee and never a spawn.
//  - nothing hidden by the visibility filter is represented — no hidden
//    counts, no hidden snippets, no "something exists here" markers.
//  - implementation cards carry publication metadata only — component
//    bodies, secret launch data and internal file contents never appear.
//  - availability is an observation stamped with observedAt; it is not a
//    promise about a future execution.

import type {
  AuthenticatedContext,
  ErrorCode,
  MahasError
} from '../../../mahas-contracts/src/common.ts'

/** operations owned by this boundary (spec/operations.md C-DISCOVERY block) */
export const DISCOVERY_OPERATIONS = [
  'responsibility.search',
  'responsibility.inspect',
  'responsibility.locate',
  'responsibility.collaborators',
  'role.implementations'
] as const
export type DiscoveryOperation = (typeof DISCOVERY_OPERATIONS)[number]

/**
 * Authorization target handed to IMP-10's authorize/decide. Structurally
 * identical to `TargetRef` from ../access/authorize.ts — declared here so
 * the query internals never import the access module (deps.ts binds the
 * promised name at the seam).
 */
export interface DiscoveryTarget {
  /** 'project' | 'modelVersion' | 'boundary' | 'role' | 'run' | 'contract' */
  kind: string
  id: string
}

export function target(kind: string, id: string): DiscoveryTarget {
  return { kind, id }
}

/** build a MahasError the registry can place on the receipt */
export function discoveryError(
  code: ErrorCode,
  message: string,
  details?: unknown,
  retry: MahasError['retry'] = 'none'
): MahasError {
  return { code, message, retry, details }
}

export function isMahasError(e: unknown): e is MahasError {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as MahasError).code === 'string' &&
    typeof (e as MahasError).message === 'string'
  )
}

// ---------------------------------------------------------------------------
// shared card vocabulary
// ---------------------------------------------------------------------------

export interface CriterionSummary {
  id: string
  criterion: string
  description: string
  ordinal: number
}

export interface BoundarySummary {
  id: string
  name: string
  /** responsibility.statement — the single responsibility of the boundary */
  responsibility: string
  criteria: CriterionSummary[]
}

export interface RoleSummary {
  id: string
  name: string
  /** professional 책무 for shared responsibility, NOT a task instruction */
  description: string
  horizontalRole: string
}

/** why a candidate matched the request — reasons, never scores */
export interface MatchReason {
  kind:
    | 'path-exact' // boundary declares this exact normalized path
    | 'path-prefix' // boundary directory is an ancestor of the path
    | 'path-covered' // boundary paths live under the queried directory
    | 'contract' // boundary provides or consumes a requested contract
    | 'horizontal-role' // role carries a requested horizontal role name
    | 'text' // free-text hit on responsibility/role/criterion text
    | 'scope' // candidate lies inside the requested scopeBoundaryId
  path?: string
  matchedPath?: string
  contractId?: string
  direction?: 'provides' | 'consumes'
  field?: 'responsibility' | 'criterion' | 'role-name' | 'role-description' | 'search-text'
  match?: 'fts' | 'substring'
  horizontalRoleName?: string
}

/** related responsibility/role context — static relations only */
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
  kind:
    | 'profile-admission' // harness profile not in a usable admission state
    | 'host-unverified' // no evidence the profile is admitted on hostId
    | 'component-unsupported' // componentNeeds not covered
    | 'interface-ambiguous' // role has multiple stored interface digests
  detail: string
}

/**
 * Publication metadata for one role implementation — never component
 * bodies, binding_json internals or launch secrets.
 */
export interface ImplementationAvailability {
  implementationId: string
  revision: number
  interfaceDigest: string
  profileId: string
  profileRevision: number
  /** publication lifecycle — new selection only lists `published` */
  status: string
  /** harness profile admissionState as stored (draft/documented/verified/disabled) */
  profileState: string
  /** effective support: support_attestations decision else profile state */
  support: 'verified' | 'documented' | 'draft' | 'disabled' | 'unknown'
  blockers: AvailabilityBlocker[]
  observedAt: number
}

/** current assignment status of a role — observation, not a promise */
export interface MemberAvailability {
  memberId: string
  runId: string
  state: string
  generation: number
  assignmentKind?: 'coordination' | 'task'
  observedAt: number
}

/** how much of the request's structural scope this card covers */
export interface ScopeCoverage {
  matchedPaths: string[]
  matchedContractIds: string[]
  /** true when no scopeBoundaryId was requested or the card is inside it */
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
  /** integrity-protected opaque pin — NOT bearer authorization (spec §14) */
  selectionToken: string
}

// ---------------------------------------------------------------------------
// responsibility.search
// ---------------------------------------------------------------------------

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

export type SearchStatus =
  | 'ok' // ≥1 candidate card
  | 'no-match' // nothing matched the filters
  | 'ambiguous' // no clean result because of territory/role ambiguity
  | 'unassigned' // territory resolved but nothing assignable is visible

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

/** echoes QueryResult — snapshot-pinned, cursor-continued */
export interface SearchResult {
  modelVersion: string
  snapshotRevision: number
  /** true when the pinned modelVersion is no longer the project's active one */
  staleModel: boolean
  status: SearchStatus
  items: CandidateCard[]
  unmatchedPaths: UnmatchedPath[]
  ambiguityGroups: AmbiguityGroup[]
  diagnostics: {
    /** visible boundaries that matched filters but own no role */
    rolelessBoundaryIds: string[]
    /** requested contractIds absent from this model snapshot */
    unmatchedContractIds: string[]
  }
  nextCursor?: string
  visibility: {
    visibilityDigest: string
    grantRevisions: Record<string, number>
  }
}

// ---------------------------------------------------------------------------
// responsibility.inspect
// ---------------------------------------------------------------------------

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
  /**
   * 'internal' — both ends inside the inspected subtree
   * 'inbound'  — provider outside, at least one consumer inside
   * 'outbound' — provider inside, at least one consumer outside
   */
  crossing: 'internal' | 'inbound' | 'outbound'
}

/**
 * The authored coordination view: clauses the role-interface authors wrote
 * for coordination readers (ContextRequirement.readerPerspective), at
 * 팀장 resolution. 'missing' is an honest answer — this service never
 * fabricates a view by summarizing child documents.
 */
export interface CoordinationView {
  status: 'authored' | 'missing' | 'not-requested'
  clauses?: {
    clauseId: string
    contextId?: string
    criterionRef?: string
    requiredMeaning: string
    deliveryClass?: string
  }[]
  /** interface digests the clauses were read from */
  sourceInterfaces?: string[]
}

export interface InspectResult {
  modelVersion: string
  snapshotRevision: number
  perspective: InspectPerspective
  boundary: BoundarySummary
  /** direct children at statement/criteria resolution — no context bodies */
  children: BoundarySummary[]
  contractTensions: ContractTension[]
  nonGoals: { id: string; statement: string }[]
  roles: RoleSummary[]
  coordinationView: CoordinationView
  /** paths of contexts linked to THIS boundary (refs only, never bodies) */
  contextRefs: string[]
}

// ---------------------------------------------------------------------------
// responsibility.locate
// ---------------------------------------------------------------------------

export interface LocateRequest {
  projectId: string
  modelVersion?: string
  paths: string[]
}

export interface LocateClaimant {
  boundaryId: string
  boundaryName: string
  /** the declared boundary path that matched */
  matchedPath: string
  /**
   * 'owns' — exact/ancestor-directory claim that competes for deepest
   * 'covers' — boundary's declared paths sit under the queried directory
   */
  claim: 'owns' | 'covers'
  /** tree relation to the resolved boundary: ancestor | self | unrelated */
  relation?: 'ancestor' | 'self' | 'unrelated'
}

export interface LocatedPath {
  path: string
  status: 'resolved' | 'ambiguous' | 'unassigned' | 'invalid'
  /** deepest owning boundary when status='resolved' */
  boundaryId?: string
  matchedPath?: string
  /**
   * The claim set that decides the resolution, deepest first — for an
   * ambiguous path this is exactly the tied non-ancestor claimants (plus
   * informational 'covers'), never the shallower container owners.
   */
  claimants: LocateClaimant[]
  /**
   * Shallower owner claims (ancestors/containers of an ambiguous tie),
   * reported separately so a container is never counted as a competing
   * claimant of the ambiguity. Only present when status='ambiguous'.
   */
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

// ---------------------------------------------------------------------------
// responsibility.collaborators
// ---------------------------------------------------------------------------

export interface CollaboratorsRequest {
  projectId: string
  modelVersion: string
  roleId: string
  runId?: string
}

export interface CollaboratorReason {
  kind: 'same-boundary' | 'contract' | 'contains'
  contractId?: string
  /**
   * from the REQUESTING role's perspective:
   * 'provides' — requesting boundary provides the contract the peer consumes
   * 'consumes' — requesting boundary consumes a contract the peer provides
   * 'parent'/'child' — contains direction
   */
  direction?: 'provides' | 'consumes' | 'parent' | 'child'
}

export interface Collaborator {
  role: RoleSummary
  boundaryId: string
  relationReasons: CollaboratorReason[]
  /**
   * Run Member addresses — only present when runId was given and visible.
   * Empty/absent means unassigned-in-run; an address is never invented.
   */
  members: { memberId: string; state: string }[]
}

export interface CollaboratorsResult {
  modelVersion: string
  snapshotRevision: number
  roleId: string
  runId?: string
  items: Collaborator[]
}

// ---------------------------------------------------------------------------
// role.implementations
// ---------------------------------------------------------------------------

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
  /** stored interface digests for this role in this model (usually one) */
  interfaceDigests: string[]
  /** IMPLEMENTATION_MISSING is a result state, not a thrown error */
  status: 'ok' | 'implementation-missing'
  implementations: ImplementationAvailability[]
  /** implementations dropped by the componentNeeds filter, with why */
  excluded: { implementationId: string; revision: number; missingNeeds: string[] }[]
}

// ---------------------------------------------------------------------------
// selectionToken
// ---------------------------------------------------------------------------

/**
 * Claims pinned inside a selectionToken: project/modelVersion/role pins +
 * the role/interface digest + the structural scope seen at search time.
 * Integrity-protected opaque value — the verifier treats it as evidence
 * of what was shown, never as authorization (spec C-DISCOVERY §14).
 */
export interface SelectionTokenClaims {
  v: 1
  tokenId: string
  projectId: string
  modelVersion: string
  roleId: string
  /** sha256 of the role row as shown — the "roleRevision" pin */
  roleDigest: string
  /** the interface digest an implementation must satisfy (when known) */
  interfaceDigest?: string
  /** exact implementation shown when the card listed exactly one */
  implementationId?: string
  implementationRevision?: number
  implementationDigest?: string
  /** digest of the shown implementation, or of the published candidate set */
  implementationCandidateDigest?: string
  scope?: { scopeBoundaryId?: string; runId?: string }
  issuedAt: number
  keyId?: string
}

export type SelectionTokenVerification =
  | { ok: true; claims: SelectionTokenClaims }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'unsupported-version' }

// ---------------------------------------------------------------------------
// handler plumbing (kept loose — OperationRegistry is IMP-11's promised API)
// ---------------------------------------------------------------------------

/** what every handler receives from the registry's transaction wrapper */
export interface DiscoveryTxn {
  db: unknown // node:sqlite DatabaseSync — typed at the impl sites
  ctx: AuthenticatedContext
}

export const SEARCH_DEFAULT_LIMIT = 20
export const SEARCH_MAX_LIMIT = 100
