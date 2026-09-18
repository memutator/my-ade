// mahas-runtime/src/discovery/index.ts — discovery boundary entrypoint.
//
// registerDiscoveryOps(registry, deps) wires the five owned C-DISCOVERY
// operations into IMP-11's OperationRegistry. Handlers run inside the
// registry's operation transaction (TxnContext {db, ctx}); authorization
// is IMP-10's authorize/decide, injected via deps — this boundary never
// imports sibling service internals.
//
// Operations are all reads (mutation: false). Visibility is 'member':
// 팀장 members and operators reach them; the per-call scope checks inside
// decide what each caller may actually see. assignment.preview and the
// actual Member/Dispatch creation belong to IMP-13 — a search result is
// never an assignment.

import type { OperationRegistry, TxnContext } from '../api/registry.ts'
import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import { requireDeps } from './deps.ts'
import type { DiscoveryDeps } from './deps.ts'
import { responsibilitySearch } from './search.ts'
import { responsibilityInspect } from './inspect.ts'
import { responsibilityLocate } from './locate.ts'
import { responsibilityCollaborators } from './collaborators.ts'
import { roleImplementations } from './implementation-availability.ts'

export function registerDiscoveryOps(registry: OperationRegistry, deps: DiscoveryDeps): void {
  const d = requireDeps(deps)
  const op = (
    name: string,
    handler: (
      db: DatabaseSync,
      ctx: AuthenticatedContext,
      deps: DiscoveryDeps,
      payload: unknown
    ) => unknown
  ): void =>
    registry.register(
      { name, visibility: 'member', mutation: false },
      (txn: TxnContext, payload: unknown) => handler(txn.db as DatabaseSync, txn.ctx, d, payload)
    )

  op('responsibility.search', responsibilitySearch)
  op('responsibility.inspect', responsibilityInspect)
  op('responsibility.locate', responsibilityLocate)
  op('responsibility.collaborators', responsibilityCollaborators)
  op('role.implementations', roleImplementations)
}

// --- public surface ---------------------------------------------------------

export type { DiscoveryDeps } from './deps.ts'
export { requireDeps } from './deps.ts'

export {
  DISCOVERY_OPERATIONS,
  discoveryError,
  isMahasError,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT
} from './types.ts'
export type {
  DiscoveryOperation,
  DiscoveryTarget,
  SearchRequest,
  SearchResult,
  SearchStatus,
  CandidateCard,
  BoundarySummary,
  RoleSummary,
  CriterionSummary,
  MatchReason,
  RelationshipRef,
  ImplementationAvailability,
  MemberAvailability,
  AvailabilityBlocker,
  ScopeCoverage,
  UnmatchedPath,
  AmbiguityGroup,
  InspectRequest,
  InspectResult,
  InspectPerspective,
  ContractTension,
  CoordinationView,
  LocateRequest,
  LocateResult,
  LocatedPath,
  LocateClaimant,
  CollaboratorsRequest,
  CollaboratorsResult,
  Collaborator,
  CollaboratorReason,
  ImplementationsRequest,
  ImplementationsResult,
  SelectionTokenClaims,
  SelectionTokenVerification
} from './types.ts'

// selectionToken issue/verify — IMP-13's team.assign consumes the verifier;
// it treats the token as integrity evidence of what was shown, never as
// authorization (C-DISCOVERY §14)
export {
  issueSelectionToken,
  verifySelectionToken,
  readSelectionTokenUnsafe,
  sealPageCursor,
  openPageCursor,
  sealOpaque,
  openOpaque
} from './selection-token.ts'
export type { IssueSelectionTokenInput, PageCursorClaims } from './selection-token.ts'

// operation implementations — direct-call entrypoints for tests and for
// composition roots that drive handlers without the full registry
export { responsibilitySearch } from './search.ts'
export { responsibilityInspect } from './inspect.ts'
export { responsibilityLocate } from './locate.ts'
export { responsibilityCollaborators } from './collaborators.ts'
export { roleImplementations, availabilityForRole } from './implementation-availability.ts'
