import type { JsonObject, JsonValue } from '../common.ts'
import type { EpochMillis } from '../ids.ts'
import type { HarnessId, OfferingId, ProviderId } from '../catalog/index.ts'
import type { HarnessInstallationId, ProviderConnectionId } from '../inventory/index.ts'
import type {
  CapabilityRequestPayload,
  CapabilityResponsePayload,
  IntegrationCapability,
  IntegrationSchema,
  PackCollectionRequest,
  PackCollectionResult,
  PackSourceDiscoveryRequest,
  PackSourceDiscoveryResult,
  SchemaValidationIssue
} from './schema.ts'

export type IntegrationContractId = string
export type AdapterPackId = string
export type CapabilityImplementationId = string
export type IntegrationCheckId = string
export type IntegrationIssueId = string

export interface IntegrationContractRef {
  id: IntegrationContractId
  revision: number
}

export interface AdapterPackRevisionRef {
  packId: AdapterPackId
  revision: number
  contentDigest: string
}

export interface IntegrationContract {
  id: IntegrationContractId
  revision: number
  capability: IntegrationCapability
  requestSchema: IntegrationSchema
  responseSchema: IntegrationSchema
  schemaDigest: string
  semanticsDigest: string
  compatibility: {
    minimumRunnerProtocol: string
    backwardCompatibleWith: readonly number[]
  }
  conformanceCases: readonly {
    id: string
    fixtureRef: string
    expected: 'accept' | 'reject'
    description: string
  }[]
  publishedAt: EpochMillis
}

export type IntegrationSubjectRef =
  | { kind: 'harness'; harnessId: HarnessId }
  | { kind: 'provider'; providerId: ProviderId }
  | { kind: 'offering'; offeringId: OfferingId }

/** Stable Pack identity. Executable content exists only on immutable revisions. */
export interface AdapterPack {
  id: AdapterPackId
  name: string
  publisher: string
  description?: string | null
  createdAt: EpochMillis
  metadata: JsonObject
}

export type CapabilitySupportDeclaration =
  | { state: 'implemented' }
  | { state: 'unsupported'; reason: string }

export type CapabilityEntrypoint =
  | { mode: 'declarative'; resource: string }
  | { mode: 'script'; resource: string; runtime: string }

export interface CapabilityImplementation {
  id: CapabilityImplementationId
  capability: IntegrationCapability
  contract: IntegrationContractRef
  entrypoint?: CapabilityEntrypoint | null
  support: CapabilitySupportDeclaration
  limits: {
    timeoutMs: number
    maxOutputBytes: number
    maxBatchRecords?: number | null
  }
  /** Capability-specific support precision, e.g. usage attribution axes. */
  supportDetails: JsonObject
}

export interface AdapterPackRequirement {
  kind: 'platform' | 'executable' | 'permission' | 'feature' | (string & {})
  key: string
  constraint?: string | null
  required: boolean
}

export interface AdapterPackRevision {
  packId: AdapterPackId
  revision: number
  contentDigest: string
  runnerProtocol: string
  subjectRefs: readonly IntegrationSubjectRef[]
  implementations: readonly CapabilityImplementation[]
  requirements: readonly AdapterPackRequirement[]
  createdAt: EpochMillis
  releaseNotes?: string | null
}

export type IntegrationTargetRef =
  | { kind: 'installation'; installationId: HarnessInstallationId; installationRevision?: number }
  | { kind: 'connection'; connectionId: ProviderConnectionId }
  | IntegrationSubjectRef

export type IntegrationCheckResult = 'unchecked' | 'compatible' | 'incompatible' | 'degraded'

export interface IntegrationDiagnostic {
  code: string
  severity: 'info' | 'warning' | 'error'
  message: string
  details?: JsonObject
  schemaIssues?: readonly SchemaValidationIssue[]
}

/** A check is scoped to one capability; failure cannot disable its siblings. */
export interface IntegrationCheck {
  id: IntegrationCheckId
  pack: AdapterPackRevisionRef
  implementationId: CapabilityImplementationId
  target: IntegrationTargetRef
  contract: IntegrationContractRef
  capability: IntegrationCapability
  checkedAt: EpochMillis
  result: IntegrationCheckResult
  evidence: readonly { kind: string; ref?: string; data?: JsonObject }[]
  diagnostics: readonly IntegrationDiagnostic[]
}

export type IntegrationIssueStatus = 'open' | 'acknowledged' | 'resolved' | 'obsolete'

export interface IntegrationIssue {
  id: IntegrationIssueId
  target: IntegrationTargetRef | AdapterPackRevisionRef
  capability: IntegrationCapability
  reason:
    | 'revision-change'
    | 'schema-violation'
    | 'conformance-failure'
    | 'invocation-failure'
    | 'semantic-incompatibility'
    | (string & {})
  detectedAt: EpochMillis
  status: IntegrationIssueStatus
  evidence: readonly { kind: string; ref?: string; data?: JsonObject }[]
  diagnostics: readonly IntegrationDiagnostic[]
  resolvedAt?: EpochMillis | null
  resolvedByRevision?: AdapterPackRevisionRef | null
}

export interface CapabilityRequestEnvelope<C extends IntegrationCapability = IntegrationCapability> {
  protocolVersion: string
  operationId: string
  capability: C
  target: IntegrationTargetRef
  contract: IntegrationContractRef
  pack: AdapterPackRevisionRef
  cursor?: JsonValue
  deadlineAt?: EpochMillis
  payload: CapabilityRequestPayload<C>
}

export type CapabilityInvocationStatus = 'success' | 'partial' | 'failed' | 'cancelled' | 'timed-out'

export interface CapabilityResultEnvelope<C extends IntegrationCapability = IntegrationCapability> {
  protocolVersion: string
  operationId: string
  capability: C
  target: IntegrationTargetRef
  contract: IntegrationContractRef
  pack: AdapterPackRevisionRef
  status: CapabilityInvocationStatus
  payload?: CapabilityResponsePayload<C>
  nextCursor?: JsonValue
  diagnostics: readonly IntegrationDiagnostic[]
  startedAt: EpochMillis
  completedAt: EpochMillis
}

export interface PackSourceDiscoveryEnvelope {
  protocolVersion: string
  operationId: string
  action: 'discover-sources'
  capability: IntegrationCapability
  target: Extract<IntegrationTargetRef, { kind: 'installation' }>
  contract: IntegrationContractRef
  pack: AdapterPackRevisionRef
  payload: PackSourceDiscoveryRequest
}

export interface PackCollectionRequestEnvelope {
  protocolVersion: string
  operationId: string
  action: 'collect'
  capability: Extract<IntegrationCapability, 'events' | 'sessions' | 'usage' | 'quota'>
  target: Extract<IntegrationTargetRef, { kind: 'installation' | 'connection' }>
  contract: IntegrationContractRef
  pack: AdapterPackRevisionRef
  payload: PackCollectionRequest
}

export interface PackSourceDiscoveryResultEnvelope {
  protocolVersion: string
  operationId: string
  action: 'discover-sources'
  status: CapabilityInvocationStatus
  payload?: PackSourceDiscoveryResult
  diagnostics: readonly IntegrationDiagnostic[]
  startedAt: EpochMillis
  completedAt: EpochMillis
}

export interface PackCollectionResultEnvelope {
  protocolVersion: string
  operationId: string
  action: 'collect'
  status: CapabilityInvocationStatus
  payload?: PackCollectionResult
  diagnostics: readonly IntegrationDiagnostic[]
  startedAt: EpochMillis
  completedAt: EpochMillis
}

export type {
  CapabilityRequestPayload,
  CapabilityResponsePayload,
  IntegrationCapability,
  IntegrationSchema,
  PackCollectionRequest,
  PackCollectionResult,
  PackQuotaReadingObservation,
  PackSessionAttachmentObservation,
  PackSessionEventObservation,
  PackSessionHandleObservation,
  PackSessionObservation,
  PackSourceDiscoveryRequest,
  PackSourceDiscoveryResult,
  PackUsageReadingObservation,
  PackUsageAttributionHint,
  SchemaValidationIssue
} from './schema.ts'
export {
  CAPABILITY_PAYLOAD_SCHEMAS,
  PACK_BOUNDARY_NEGATIVE_CASES,
  PACK_BOUNDARY_SCHEMAS,
  validateCapabilityPayload,
  validateIntegrationSchema,
  validatePackBoundaryPayload
} from './schema.ts'
