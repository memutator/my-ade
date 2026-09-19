// mahas-contracts — domain entity id vocabulary (IMP-02).
//
// spec/common.md §1: `Id` is an opaque UTF-8 identifier, distinct from a
// label, a path, or a provider-native id. The common.md §1 version/digest/
// epoch identities that must NEVER be interassigned are the branded types
// in ./common.ts (ModelVersionId, RoleInterfaceDigest, ImplementationRevision,
// BundleDigest, TaskRevision, PlanRevision, ExecutionGeneration,
// ControllerEpoch, HostIncarnation).
//
// Entity-id aliases below are plain strings — the same convention
// ./identity.ts already established for MemberId/ExecutionId/TerminalId/
// TaskId/DispatchId/NativeConversationId/ViewId/HostId/OperationId: the
// honesty rule is structural (separate fields, separate tables), not
// nominal. Reuse those identity.ts aliases instead of redefining them here.

/** epoch-milliseconds — the DB representation of an instant (S-COMMON §1:
 *  RFC3339 on the wire, integer epoch-ms in storage, authority clock for
 *  expiry decisions) */
export type EpochMillis = number

/* ── RDD domain (spec/domains/rdd.md) ─────────────────────────────────── */
export type ProjectId = string
export type BoundaryId = string
export type CriterionId = string
export type RoleId = string
export type RddContextId = string
export type RddContractId = string
export type NonGoalId = string
export type ModelChangeId = string

/* ── role realization (spec/domains/role-realization.md) ──────────────── */
export type ImplementationId = string
export type HarnessProfileId = string
export type ComponentId = string
export type ClauseId = string

/* ── access (spec common §2 + REQ-09/REQ-10) ──────────────────────────── */
export type PrincipalId = string
export type RolePolicyId = string
export type GrantId = string
export type AuthorizationDecisionId = string

/* ── work/coordination (spec/domains/work.md) ─────────────────────────── */
export type RunId = string
export type AssignmentId = string
export type PlanCandidateId = string
export type RuntimeInstanceId = string
export type LaunchPlanId = string
export type ExecutionCredentialId = string
export type HandoffId = string

/* ── mail/artifacts (spec/domains/messaging-outcomes.md) ──────────────── */
export type MessageId = string
export type DeliveryId = string
export type WakeRequestId = string
export type ArtifactId = string
export type OutcomeId = string
export type SettlementId = string
export type RunDecisionId = string

/* ── resources (spec/domains/resources-observation.md §1) ─────────────── */
export type ResourceId = string
export type CheckoutId = string
export type WorkspaceId = string
export type ResourceClaimId = string
export type ResourceTransferId = string
export type RetentionPinId = string

/* ── observation/maintenance (spec/domains/resources-observation.md §2–3) */
export type ObservationId = string
export type InterventionId = string
export type ClientId = string
export type ClientViewBindingId = string
export type ResumeCandidateId = string
export type ImpactCandidateId = string
export type BackupSetId = string
export type SupportAttestationId = string
export type MigrationReceiptId = string
export type SubscriptionStreamId = string
