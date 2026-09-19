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
// shared operation DTOs
// ---------------------------------------------------------------------------
//
// The renderer-safe payloads/results live in mahas-contracts. This runtime
// module keeps its historical re-export so existing handlers continue to
// import one local seam while contracts stay independent of runtime.

export type {
  AmbiguityGroup,
  AvailabilityBlocker,
  BoundarySummary,
  CandidateCard,
  Collaborator,
  CollaboratorReason,
  CollaboratorsRequest,
  CollaboratorsResult,
  ContractTension,
  CoordinationView,
  CriterionSummary,
  ImplementationAvailability,
  ImplementationsRequest,
  ImplementationsResult,
  InspectPerspective,
  InspectRequest,
  InspectResult,
  LocateClaimant,
  LocatedPath,
  LocateRequest,
  LocateResult,
  MatchReason,
  MemberAvailability,
  RelationshipRef,
  RoleSummary,
  ScopeCoverage,
  SearchRequest,
  SearchResult,
  SearchStatus,
  UnmatchedPath
} from '../../../mahas-contracts/src/operations/discovery.ts'

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
