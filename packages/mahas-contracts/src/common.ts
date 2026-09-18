// mahas-contracts — common envelope/identity kernel (spec/common.md §1–2).
//
// Coordinator-seeded so parallel IMP tasks share real type names; IMP-02
// owns the full domain model and may extend (not contradict) these names.

/** opaque UTF-8 identifier — never a label/path/provider-native id */
export type Id = string & { readonly __id: unique symbol }
/** monotonically increasing per-entity revision, starts at 1 */
export type Revision = number & { readonly __rev: unique symbol }

export type ModelVersionId = Id & { readonly __modelVersion: unique symbol }
export type RoleInterfaceDigest = string & { readonly __roleInterfaceDigest: unique symbol }
export type ImplementationRevision = Revision & { readonly __implRev: unique symbol }
export type BundleDigest = string & { readonly __bundleDigest: unique symbol }
export type TaskRevision = Revision & { readonly __taskRev: unique symbol }
export type PlanRevision = Revision & { readonly __planRev: unique symbol }
export type ExecutionGeneration = number & { readonly __execGen: unique symbol }
export type ControllerEpoch = number & { readonly __epoch: unique symbol }
export type HostIncarnation = string & { readonly __hostInc: unique symbol }

export interface ContentRef {
  digest: string
  mediaType: string
  sizeBytes: number
}

export interface ArtifactRef {
  artifactId: Id
  revision: Revision
  digest: string
}

export interface PathRef {
  projectId: Id
  checkoutId?: Id
  /** repo-relative; no NUL, no absolute paths, no .. escapes */
  repoRelativePath: string
}

export interface CommandRequest {
  protocolVersion: string
  operation: string
  operationId: string
  expectedRevisions?: Record<string, number>
  payload?: unknown
}

/** server-constructed from the credential — payload never overrides these */
export interface AuthenticatedContext {
  principalId: Id
  roleBindingId?: Id
  memberId?: Id
  executionId?: Id
  executionGeneration?: ExecutionGeneration
  controllerEpoch: ControllerEpoch
  grantRevisions: Record<string, number>
  transportSessionId: string
}

export type ReceiptStatus = 'committed' | 'rejected' | 'pending' | 'unknown'

export interface CommandReceipt {
  operationId: string
  fingerprint: string
  status: ReceiptStatus
  result?: unknown
  error?: MahasError
  effects: EffectIntent[]
  domainRevision: number
  eventCursor: number
}

export type ErrorRetry = 'none' | 'same-operation' | 'reconcile' | 'replan'

export interface MahasError {
  code: ErrorCode
  message: string
  retry: ErrorRetry
  details?: unknown
}

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'UNAVAILABLE_OPERATION'
  | 'SCOPE_DENIED'
  | 'GRANT_REVOKED'
  | 'STALE_REVISION'
  | 'STALE_EXECUTION'
  | 'OPERATION_CONFLICT'
  | 'MODEL_INVALID'
  | 'AMBIGUOUS_TERRITORY'
  | 'NO_RESPONSIBLE_ROLE'
  | 'IMPLEMENTATION_MISSING'
  | 'INTERFACE_STALE'
  | 'MANDATORY_COMPONENT_MISSING'
  | 'INJECTION_UNSUPPORTED'
  | 'INPUT_NOT_READY'
  | 'RESOURCE_BUSY'
  | 'PROCESS_UNVERIFIABLE'
  | 'START_UNKNOWN'
  | 'STOP_UNKNOWN'
  | 'HOST_PROTOCOL_MISMATCH'
  | 'CONTROL_UNAVAILABLE'
  | 'ARTIFACT_MISMATCH'
  | 'INVALID_TRANSITION'
  | 'REQUIRED_ACTION_DENIED'
  | 'SNAPSHOT_REQUIRED'

export interface QueryResult<T = unknown> {
  snapshotRevision: number
  items: T[]
  nextCursor?: string
  visibility: unknown
}

export type EffectState = 'prepared' | 'attempting' | 'confirmed' | 'rejected' | 'unknown'

export interface EffectIntent {
  id: Id
  operationKey: string
  kind: string
  fingerprint: string
  hostId?: Id
  state: EffectState
  payload: unknown
}

export interface EffectReceipt {
  effectId: Id
  state: EffectState
  evidence?: unknown
  at: number
}
