// mahas-contracts — role realization: interface, implementation, bundle (IMP-02).
//
// spec/domains/role-realization.md §1–2. The four objects are NEVER merged:
//   RoleInterface      = what must hold (role + required context, semantic)
//   RoleImplementation = how one harness is configured to satisfy it
//   ContextBundle      = the implementation revision's frozen bytes + manifest
//   LaunchPlan         = this spawn's execution plan (see ./work.ts)
//
// A published implementation revision and a built bundle are immutable
// (S-COMMON §6): changes mint new revisions/digests, never edits in place.

import type {
  BundleDigest,
  ContentRef,
  ImplementationRevision,
  JsonObject,
  ModelVersionId,
  Revision,
  RoleInterfaceDigest
} from './common.ts'
import type {
  BoundaryId,
  ClauseId,
  ComponentId,
  CriterionId,
  HarnessProfileId,
  ImplementationId,
  RddContextId,
  RoleId
} from './ids.ts'

/* ── RoleInterface — role_interfaces table ────────────────────────────── */

/** reference to one RDD criterion (version-boundary-scoped identity) */
export interface CriterionRef {
  boundaryId: BoundaryId
  criterionId: CriterionId
}

export type DeliveryClass = 'initial' | 'conditional'

/** one clause of the semantic contract — a requirement binding, NOT an
 *  extension of the Context object itself (role-realization.md §2) */
export interface ContextRequirement {
  clauseId: ClauseId
  /** exactly one of contextId / criterionRef identifies the required source */
  contextId?: RddContextId
  criterionRef?: CriterionRef
  requiredMeaning: string
  deliveryClass: DeliveryClass
  readerPerspective: string
}

/** requirements_json — the fixed semantic contract over role + context */
export interface RoleInterfaceRequirements {
  /** responsibilities (boundary refs) this role must hold together */
  responsibilityRefs: BoundaryId[]
  contextRequirements: ContextRequirement[]
}

/** judgment_scope_json — operational policy/grant is deliberately elsewhere */
export interface JudgmentScope {
  scopeOfJudgment: string
  invariantRefs: string[]
}

export interface RoleInterface {
  digest: RoleInterfaceDigest
  modelVersion: ModelVersionId
  roleId: RoleId
  requirements: RoleInterfaceRequirements
  judgmentScope: JudgmentScope
}

/* ── HarnessProfile — harness_profiles table ──────────────────────────── */

/** admission_state (role-realization.md §2): documented ≠ verified —
 *  a doc check never inflates into a tested verdict */
export type AdmissionState = 'draft' | 'documented' | 'verified' | 'disabled'

/** recipe_json — start/resume/wake recipes pinned to an installed version */
export interface HarnessRecipe {
  recipeVersion?: string
  start?: JsonObject
  resume?: JsonObject
  wake?: JsonObject
  [key: string]: unknown
}

/** capabilities_json — what this harness can actually do on this OS */
export interface HarnessCapabilities {
  supportedComponents?: ComponentKind[]
  injectionRoutes?: string[]
  resume?: boolean
  wake?: boolean
  [key: string]: unknown
}

/** executable_identity_json — installed binary identity + OS range */
export interface ExecutableIdentity {
  path?: string
  digest?: string
  version?: string
  osRange?: string
  [key: string]: unknown
}

export interface HarnessProfile {
  id: HarnessProfileId
  revision: Revision
  state: AdmissionState
  recipe: HarnessRecipe
  capabilities: HarnessCapabilities
  executableIdentity: ExecutableIdentity
}

/* ── RoleImplementation — role_implementations + components ───────────── */

export type ImplementationStatus = 'draft' | 'published' | 'retired'

export interface RoleImplementation {
  id: ImplementationId
  revision: ImplementationRevision
  interfaceDigest: RoleInterfaceDigest
  profileId: HarnessProfileId
  profileRevision: Revision
  status: ImplementationStatus
  /** the author responsible for this implementation's semantic fitness */
  maintainerRoleId: RoleId
  semanticDecision?: string | null
}

/** ImplementationComponent.kind — the five component classes of
 *  role-realization.md §4. Not every implementation needs every kind. */
export type ComponentKind = 'instruction' | 'skill' | 'subagent' | 'tool-config' | 'launch-config'

/** binding_json — contentBinding/config + declared outputs + the mahas-side
 *  permissions this component asks for (C-ACCESS enforces; the harness's
 *  native tool list is a separate matter — role-realization.md §4) */
export interface ComponentBinding {
  contentRef?: ContentRef
  contentDigest?: string
  config?: JsonObject
  outputs?: string[]
  permissionRequirements?: string[]
  [key: string]: unknown
}

export type Realization = 'verbatim' | 'reexpressed'

/**
 * coverage_json entry — which expression realizes each required clause.
 * The link's EXISTENCE is not mechanical proof of semantic fulfillment
 * (role-realization.md §2); 'reexpressed' names the injected phrasing —
 * the long original is not appended on top.
 */
export interface CoverageBinding {
  clauseId: ClauseId
  componentId: ComponentId
  sectionKey: string
  realization: Realization
  requiredLoadPhase: string
}

export interface ImplementationComponent {
  implementationId: ImplementationId
  implementationRevision: ImplementationRevision
  id: ComponentId
  kind: ComponentKind
  activation: string
  binding: ComponentBinding
  /** component ids this one consumes (componentGraph edge) */
  consumes: ComponentId[]
  coverage: CoverageBinding[]
}

/**
 * maintenance_bindings — which upstream source a rendered component was
 * derived from. This is a maintenance lookup, NOT a route to inject parent
 * originals into a child's runtime context (resources-observation.md §3).
 */
export interface MaintenanceBinding {
  implementationId: ImplementationId
  implementationRevision: ImplementationRevision
  id: string
  basisRef: JsonObject
  componentRef: JsonObject
}

/* ── ContextBundle — context_bundles table ────────────────────────────── */

/** manifest_json — what the bundle actually contains; consumed by the
 *  injection/attachment boundary (component digests, clause coverage,
 *  load routes) */
export interface BundleManifest {
  componentBlobRefs?: ContentRef[]
  attachedComponents?: ComponentId[]
  requiredTextDigest?: string
  [key: string]: unknown
}

/** source_observations_json entry — what was observed going INTO the build;
 *  timestamps/run ids/credentials never enter the reusable body (§2) */
export interface SourceObservation {
  componentId?: ComponentId
  digest?: string
  observedAt?: number
  source?: string
  [key: string]: unknown
}

/** context_bundles — immutable build artifact; digest covers bytes+manifest */
export interface ContextBundle {
  digest: BundleDigest
  implementationId: ImplementationId
  implementationRevision: ImplementationRevision
  interfaceDigest: RoleInterfaceDigest
  surfaceDigest: string
  requiredTextDigest: string
  manifest: BundleManifest
  sourceObservations: SourceObservation[]
}
