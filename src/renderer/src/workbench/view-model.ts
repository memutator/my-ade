// workbench/view-model.ts — explicit projections from canonical operation
// DTOs onto what the views render and what the workbench sends back.
//
// Rules this file exists to enforce:
//  - the renderer never mutates a wire record, and never fills a missing
//    field in with a plausible alias. A field the DTO does not define is
//    read as itself (rendered as "—"), not guessed from a peer name.
//  - every send is assembled from the contract's request DTO. Fields the
//    contract does not define are not sent "for luck"; fields the contract
//    does define keep their meaning (omitted ≠ null).
//  - the draft <-> patch mappers round-trip wire fields they do not model
//    (see InputBindingDraft.raw) so editing one column of a binding cannot
//    silently drop another.

import type {
  AmbiguityGroup,
  CandidateCard,
  Collaborator,
  CollaboratorsResult,
  ContractTension,
  CoordinationView,
  ImplementationAvailability,
  ImplementationsResult,
  InspectResult,
  LocateResult,
  MatchReason,
  MemberAvailability,
  RelationshipRef,
  SearchResult,
  UnmatchedPath
} from './contracts.ts'

/* ── discovery: search ─────────────────────────────────────────────────── */

export interface SearchViewModel {
  modelVersion: string
  snapshotRevision: number
  staleModel: boolean
  status: SearchResult['status']
  /** canonical candidate records — cards are queued and previewed by token,
   //  so the wire record travels intact instead of through a look-alike */
  candidates: CandidateCard[]
  unmatchedPaths: SearchResult['unmatchedPaths']
  ambiguityGroups: SearchResult['ambiguityGroups']
  diagnostics: SearchResult['diagnostics']
  nextCursor?: string
}

export function toSearchViewModel(result: SearchResult): SearchViewModel {
  return {
    modelVersion: result.modelVersion,
    snapshotRevision: result.snapshotRevision,
    staleModel: result.staleModel,
    status: result.status,
    candidates: result.items,
    unmatchedPaths: result.unmatchedPaths,
    ambiguityGroups: result.ambiguityGroups,
    diagnostics: result.diagnostics,
    nextCursor: result.nextCursor
  }
}

/** one readable line per match explanation (never a rank, never a score) */
export function matchReasonText(r: MatchReason): string {
  const where = r.matchedPath ?? r.path
  switch (r.kind) {
    case 'path-exact':
    case 'path-prefix':
    case 'path-covered':
      return `${r.kind} ${where ?? '—'}`
    case 'contract':
      return `contract ${r.contractId ?? '—'}${r.direction ? ` (${r.direction})` : ''}`
    case 'horizontal-role':
      return `horizontal role ${r.horizontalRoleName ?? '—'}`
    case 'text':
      return `text match in ${r.field ?? '—'}${r.match ? ` (${r.match})` : ''}`
    case 'scope':
      return 'inside the requested scope'
    default:
      return r.kind
  }
}

export function relationshipRefText(r: RelationshipRef): string {
  const parts: string[] = [r.kind]
  if (r.boundaryName ?? r.boundaryId) parts.push(r.boundaryName ?? r.boundaryId!)
  if (r.contractName ?? r.contractId) parts.push(r.contractName ?? r.contractId!)
  if (r.roleId) parts.push(r.roleId)
  if (r.direction) parts.push(`(${r.direction})`)
  return parts.join(' · ')
}

export function unmatchedPathText(u: UnmatchedPath): string {
  const where = u.boundaryIds?.length ? ` → ${u.boundaryIds.join(', ')}` : ''
  const why = u.reason ? ` — ${u.reason}` : ''
  return `${u.path} · ${u.status}${where}${why}`
}

export function ambiguityGroupText(g: AmbiguityGroup): string {
  return `${g.kind}: ${g.paths.join(', ')} → ${g.boundaryIds.join(', ')}`
}

/* ── discovery: availability and tension rows ──────────────────────────── */

export interface AvailabilityRow {
  id: string
  label: string
  detail: string
  support?: string
  state?: string
  blockers: string[]
  observedAt?: number
}

/** published implementation metadata — never a component body or launch pin */
export function implementationAvailabilityRow(i: ImplementationAvailability): AvailabilityRow {
  return {
    id: `${i.implementationId}@${i.revision}`,
    label: `${i.implementationId}@${i.revision}`,
    detail: `${i.profileId}@${i.profileRevision} · ${i.status}/${i.profileState}`,
    support: i.support,
    blockers: i.blockers.map((b) => `${b.kind}: ${b.detail}`),
    observedAt: i.observedAt
  }
}

/** current occupancy — an observation, never a promise about a future run */
export function memberAvailabilityRow(m: MemberAvailability): AvailabilityRow {
  return {
    id: m.memberId,
    label: m.memberId,
    detail: `${m.state} · run ${m.runId} · gen ${m.generation}${m.assignmentKind ? ` · ${m.assignmentKind}` : ''}`,
    state: m.state,
    blockers: [],
    observedAt: m.observedAt
  }
}

export function contractTensionText(t: ContractTension): string {
  return `${t.name} (${t.contractId}) · ${t.crossing} · ${t.providerBoundaryId} → ${t.consumerBoundaryIds.join(', ')}`
}

/* ── discovery: inspect / locate / collaborators / implementations ─────── */

export interface InspectViewModel {
  modelVersion: string
  snapshotRevision: number
  perspective: InspectResult['perspective']
  boundary: InspectResult['boundary']
  children: InspectResult['children']
  contractTensions: InspectResult['contractTensions']
  nonGoals: InspectResult['nonGoals']
  roles: InspectResult['roles']
  coordinationView: CoordinationView
  contextRefs: string[]
}

export function toInspectViewModel(result: InspectResult): InspectViewModel {
  return {
    modelVersion: result.modelVersion,
    snapshotRevision: result.snapshotRevision,
    perspective: result.perspective,
    boundary: result.boundary,
    children: result.children,
    contractTensions: result.contractTensions,
    nonGoals: result.nonGoals,
    roles: result.roles,
    coordinationView: result.coordinationView,
    contextRefs: result.contextRefs
  }
}

export interface LocatedPathView {
  path: string
  status: LocateResult['items'][number]['status']
  boundaryId?: string
  matchedPath?: string
  claimants: LocateResult['items'][number]['claimants']
  ancestorClaimants: LocateResult['items'][number]['ancestorClaimants']
  roles: LocateResult['items'][number]['roles']
  reason?: string
}

export interface LocateViewModel {
  modelVersion: string
  snapshotRevision: number
  staleModel: boolean
  items: LocatedPathView[]
}

export function toLocateViewModel(result: LocateResult): LocateViewModel {
  return {
    modelVersion: result.modelVersion,
    snapshotRevision: result.snapshotRevision,
    staleModel: result.staleModel,
    items: result.items.map((item) => ({
      path: item.path,
      status: item.status,
      boundaryId: item.boundaryId,
      matchedPath: item.matchedPath,
      claimants: item.claimants,
      ancestorClaimants: item.ancestorClaimants,
      roles: item.roles,
      reason: item.reason
    }))
  }
}

export interface CollaboratorView {
  roleId: string
  roleName: string
  boundaryId: string
  relationReasons: Collaborator['relationReasons']
  /** [] means the peer has no visible member in the requested run */
  members: Collaborator['members']
}

export interface CollaboratorsViewModel {
  modelVersion: string
  snapshotRevision: number
  roleId: string
  runId?: string
  collaborators: CollaboratorView[]
}

export function toCollaboratorsViewModel(result: CollaboratorsResult): CollaboratorsViewModel {
  return {
    modelVersion: result.modelVersion,
    snapshotRevision: result.snapshotRevision,
    roleId: result.roleId,
    runId: result.runId,
    collaborators: result.items.map((item) => ({
      roleId: item.role.id,
      roleName: item.role.name,
      boundaryId: item.boundaryId,
      relationReasons: item.relationReasons,
      members: item.members
    }))
  }
}

export interface ImplementationOfferView {
  implementationId: string
  implementationRevision: number
  interfaceDigest: string
  profileId: string
  profileRevision: number
  status: string
  profileState: string
  support: ImplementationAvailability['support']
  blockers: ImplementationAvailability['blockers']
  observedAt: number
}

export interface ImplementationsViewModel {
  modelVersion: string
  snapshotRevision: number
  roleId: string
  status: ImplementationsResult['status']
  interfaceDigests: string[]
  implementations: ImplementationOfferView[]
  excluded: ImplementationsResult['excluded']
}

export function toImplementationOfferView(
  implementation: ImplementationAvailability
): ImplementationOfferView {
  return {
    implementationId: implementation.implementationId,
    implementationRevision: implementation.revision,
    interfaceDigest: implementation.interfaceDigest,
    profileId: implementation.profileId,
    profileRevision: implementation.profileRevision,
    status: implementation.status,
    profileState: implementation.profileState,
    support: implementation.support,
    blockers: implementation.blockers,
    observedAt: implementation.observedAt
  }
}

/** the same rows for a mapped offer (the inspector lane renders offers) */
export function toImplementationOfferRow(offer: ImplementationOfferView): AvailabilityRow {
  return {
    id: `${offer.implementationId}@${offer.implementationRevision}`,
    label: `${offer.implementationId}@${offer.implementationRevision}`,
    detail: `${offer.profileId}@${offer.profileRevision} · ${offer.status}/${offer.profileState}`,
    support: offer.support,
    blockers: offer.blockers.map((b) => `${b.kind}: ${b.detail}`),
    observedAt: offer.observedAt
  }
}

export function toImplementationsViewModel(
  result: ImplementationsResult
): ImplementationsViewModel {
  return {
    modelVersion: result.modelVersion,
    snapshotRevision: result.snapshotRevision,
    roleId: result.roleId,
    status: result.status,
    interfaceDigests: result.interfaceDigests,
    implementations: result.implementations.map(toImplementationOfferView),
    excluded: result.excluded
  }
}
