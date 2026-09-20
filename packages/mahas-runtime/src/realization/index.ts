// realization/index.ts — C-REALIZATION boundary composition root (IMP-07).
//
// Registers the seven owned operations on the OperationRegistry and
// re-exports the authoring API downstream tasks consume (IMP-06 discovery
// listing, IMP-08 context.build, IMP-24/25 native formatters, IMP-27 stale
// analysis). This module is the ONLY file other boundaries import — they
// never reach into repository internals, and mahasd composition wires it via
// registerRealizationOps(registry, deps); the shared barrel src/index.ts is
// untouched per task scope.

import type { OperationRegistry } from '../api/registry.ts'
import { interfaceGet } from './interfaces.ts'
import { implementationPrepare, implementationPublish, implementationRetire } from './publisher.ts'
import {
  harnessProfileAdmit,
  harnessProfileInspect,
  harnessProfileRegister,
  type RealizationDeps
} from './profile-registry.ts'

export type {
  RealizationDeps,
  InstallationObservation,
  InstallationProbe
} from './profile-registry.ts'

/**
 * Wire the C-REALIZATION operations. Visibility follows spec/operations.md
 * default subjects; authorize() inside each handler still performs the real
 * grant check against the actual targets — visibility only shapes which
 * surfaces advertise the op.
 *
 *   member   — role-scoped work a delegated member performs
 *   operator — arbitrary-executable admission; workers never reach it
 */
export function registerRealizationOps(
  registry: OperationRegistry,
  deps: RealizationDeps = {}
): void {
  registry.register({ name: 'interface.get', visibility: 'member', mutation: true }, interfaceGet)
  registry.register(
    { name: 'implementation.prepare', visibility: 'member', mutation: true },
    implementationPrepare
  )
  registry.register(
    { name: 'implementation.publish', visibility: 'member', mutation: true },
    implementationPublish
  )
  registry.register(
    { name: 'implementation.retire', visibility: 'member', mutation: true },
    implementationRetire
  )
  registry.register(
    { name: 'harness.profile.register', visibility: 'operator', mutation: true },
    (txn, payload) => harnessProfileRegister(txn, payload, deps)
  )
  registry.register(
    { name: 'harness.profile.inspect', visibility: 'member', mutation: true },
    (txn, payload) => harnessProfileInspect(txn, payload, deps)
  )
  registry.register(
    { name: 'harness.profile.admit', visibility: 'operator', mutation: true },
    (txn, payload) => harnessProfileAdmit(txn, payload, deps)
  )
}

/* public authoring API — interfaces */
export {
  deriveInterface,
  interfaceDigestOf,
  interfaceGet,
  loadInterfaceByDigest,
  storeInterfaceSnapshot,
  toRoleInterface,
  type DerivedInterface,
  type DerivedRequirement,
  type InterfaceGetInput,
  type InterfaceGetResult,
  type InterfaceJudgmentScope,
  type InterfaceMaintenanceRef
} from './interfaces.ts'

/* public authoring API — component graph + clause coverage model */
export {
  COMPONENT_KINDS,
  bindingsByComponent,
  componentFromRow,
  componentBindingJson,
  evaluateCoverage,
  parseComponentGraph,
  parseCoverageBinding,
  parseMaintenanceBinding,
  validateComponentGraph,
  type ActivationPhase,
  type ClauseCoverage,
  type ClauseCoverageStatus,
  type ComponentGraphInput,
  type ComponentInput,
  type ComponentKind,
  type CoverageBindingInput,
  type CoverageReport,
  type MaintenanceBindingInput
} from './component-graph.ts'

/* public authoring API — implementation repository */
export {
  activateCandidate,
  implementationContentDigest,
  listByInterface,
  listImplementationRevisions,
  loadImplementation,
  markRetired,
  referencingExecutions,
  storeCandidate,
  toRoleImplementation,
  type ImplementationStatus,
  type ReferencingExecution,
  type StoreCandidateInput,
  type StoredImplementation
} from './implementation-repository.ts'

/* public authoring API — publication lifecycle handlers */
export {
  implementationPrepare,
  implementationPublish,
  implementationRetire,
  type ImplementationPrepareInput,
  type ImplementationPrepareResult,
  type ImplementationPublishInput,
  type ImplementationPublishResult,
  type ImplementationRetireInput,
  type ImplementationRetireResult
} from './publisher.ts'

/* public authoring API — harness profile registry */
export {
  EVIDENCE_KINDS,
  INJECTION_ROUTES,
  harnessProfileAdmit,
  harnessProfileInspect,
  harnessProfileRegister,
  listAttestations,
  loadProfile,
  type AttestationEvidence,
  type AttestationEvidenceKind,
  type ExecutableIdentity,
  type HarnessProfileAdmitInput,
  type HarnessProfileAdmitResult,
  type HarnessProfileInspectInput,
  type HarnessProfileInspectResult,
  type HarnessProfileRegisterInput,
  type HarnessProfileRegisterResult,
  type ProfileAdmissionDecision,
  type ProfileAdmissionState,
  type ProfileCapabilities,
  type ProfileRecipe,
  type StoredProfile
} from './profile-registry.ts'

/* boundary helpers consumers may need for digest parity */
export { canonicalJson, digestOf } from './util.ts'
