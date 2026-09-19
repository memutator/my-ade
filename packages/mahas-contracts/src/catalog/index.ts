import type { EpochMillis } from '../ids.ts'
import type { JsonObject } from '../common.ts'

export type OrganizationId = string
export type HarnessId = string
export type ProviderId = string
export type OfferingId = string
export type InferenceModelId = string
export type NativeModelAliasId = string
export type ModelAliasResolutionId = string

export interface Organization {
  id: OrganizationId
  name: string
  metadata: JsonObject
}

/** A kind of agent-facing tool, independent of any installation or provider. */
export interface Harness {
  id: HarnessId
  publisherOrganizationId?: OrganizationId | null
  label: string
  identityMetadata: JsonObject
}

/** An account/authentication realm operated as a service. */
export interface Provider {
  id: ProviderId
  operatorOrganizationId?: OrganizationId | null
  label: string
  realm: string
  metadata: JsonObject
}

/** A product inside a provider realm; current plan and balance are readings. */
export interface Offering {
  id: OfferingId
  providerId: ProviderId
  key: string
  label: string
  metadata: JsonObject
}

/** Model identity, deliberately independent of harnesses and offerings. */
export interface InferenceModel {
  id: InferenceModelId
  publisherOrganizationId?: OrganizationId | null
  label: string
  version?: string | null
  metadata: JsonObject
}

export type ModelAliasNamespaceKind = 'harness' | 'offering'

/** Native spelling retained even when no canonical model is known. */
export interface NativeModelAlias {
  id: NativeModelAliasId
  namespaceKind: ModelAliasNamespaceKind
  namespaceId: HarnessId | OfferingId
  nativeName: string
  firstObservedAt: EpochMillis
  lastObservedAt: EpochMillis
  metadata: JsonObject
}

export type CatalogEvidenceRef = {
  observationId?: string
  sourceId?: string
  sourceRecordKey?: string
  description?: string
}

/** Time-scoped claim; a new mapping never rewrites historical attribution. */
export interface ModelAliasResolution {
  id: ModelAliasResolutionId
  aliasId: NativeModelAliasId
  modelId: InferenceModelId
  validFrom: EpochMillis
  validUntil?: EpochMillis | null
  confidence: 'declared' | 'observed' | 'verified'
  evidence: readonly CatalogEvidenceRef[]
  revision: number
}
