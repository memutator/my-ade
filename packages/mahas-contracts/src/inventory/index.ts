import type { JsonObject } from '../common.ts'
import type { EpochMillis } from '../ids.ts'
import type { HarnessId, OfferingId } from '../catalog/index.ts'

export type MachineId = string
export type HarnessInstallationId = string
export type InstallationRevisionId = string
export type ProviderCredentialId = string
export type ProviderConnectionId = string
export type HarnessProviderBindingId = string
export type IdentityClaimId = string
export type QuotaPoolClaimId = string

export interface InventoryEvidenceRef {
  observationId?: string
  sourceId?: string
  sourceRecordKey?: string
  description?: string
}

export interface Machine {
  id: MachineId
  label: string
  firstSeenAt: EpochMillis
  lastSeenAt: EpochMillis
  metadata: JsonObject
}

export type InstallationPresence = 'present' | 'absent' | 'unknown'

export interface HarnessInstallation {
  id: HarnessInstallationId
  machineId: MachineId
  harnessId: HarnessId
  executableLocator?: string | null
  configNamespace: string
  dataNamespace: string
  firstSeenAt: EpochMillis
  lastSeenAt: EpochMillis
  presence: InstallationPresence
  origin: 'discovered' | 'registered'
}

/** Immutable evidence of an installation shape; secret/config values are excluded. */
export interface InstallationRevision {
  id: InstallationRevisionId
  installationId: HarnessInstallationId
  revision: number
  executableIdentity: JsonObject
  version?: string | null
  configStructureDigest?: string | null
  observedAt: EpochMillis
  evidence: readonly InventoryEvidenceRef[]
}

export type CredentialOwnership = 'user' | 'machine' | 'external' | 'unknown'
export type InventoryAvailability = 'available' | 'unavailable' | 'unknown'

/** Logical locator for secret material. The material itself never belongs here. */
export interface ProviderCredential {
  id: ProviderCredentialId
  machineId: MachineId
  materialRef: string
  materialRevision: number
  ownership: CredentialOwnership
  availability: InventoryAvailability
  firstSeenAt: EpochMillis
  lastSeenAt: EpochMillis
}

export interface ProviderConnection {
  id: ProviderConnectionId
  offeringId: OfferingId
  credentialId: ProviderCredentialId
  authScope?: readonly string[] | null
  firstSeenAt: EpochMillis
  observedUntil?: EpochMillis | null
  availability: InventoryAvailability
  origin: 'discovered' | 'registered'
}

export type IdentityClaimKind =
  | 'provider-account-id'
  | 'email'
  | 'billing-organization-id'
  | 'realm'
  | (string & {})

/** A sourced observation, never a merge key by itself. */
export interface ProviderIdentityClaim {
  id: IdentityClaimId
  connectionId: ProviderConnectionId
  kind: IdentityClaimKind
  value: string
  observedAt: EpochMillis
  validUntil?: EpochMillis | null
  confidence: 'declared' | 'observed' | 'verified'
  evidence: readonly InventoryEvidenceRef[]
}

export interface QuotaPoolClaim {
  id: QuotaPoolClaimId
  connectionId: ProviderConnectionId
  providerPoolKey: string
  scope: string
  observedAt: EpochMillis
  validUntil?: EpochMillis | null
  evidence: readonly InventoryEvidenceRef[]
}

/** Time-bounded config observation; it is not proof that traffic used the connection. */
export interface HarnessProviderBinding {
  id: HarnessProviderBindingId
  installationId: HarnessInstallationId
  connectionId: ProviderConnectionId
  configSlot: string
  selector?: JsonObject | null
  origin: 'discovered' | 'registered'
  observedFrom: EpochMillis
  observedUntil?: EpochMillis | null
  evidence: readonly InventoryEvidenceRef[]
  revision: number
}
