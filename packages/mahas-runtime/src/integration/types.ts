import type { DatabaseSync } from 'node:sqlite'
import type {
  AdapterPack,
  AdapterPackRevision,
  IntegrationCapability,
  IntegrationCheckResult,
  IntegrationContract,
  IntegrationDiagnostic
} from '../../../mahas-contracts/src/integration/index.ts'

export const INTEGRATION_CAPABILITIES = [
  'identify',
  'launch',
  'resume',
  'wake',
  'events',
  'sessions',
  'usage',
  'bindings',
  'maintenance',
  'auth',
  'quota'
] as const satisfies readonly IntegrationCapability[]

export type PackSupportStatus = 'implemented' | 'unsupported' | 'undeclared'

/** On-disk transport. The nested objects are canonical contract values. */
export interface PackManifestFile {
  schemaVersion: 1
  pack: AdapterPack
  revision: AdapterPackRevision
}

export interface RegisteredPackRevision {
  packId: string
  revision: number
  contentDigest: string
  snapshotPath: string
  manifest: PackManifestFile
  registeredAt: number
}

/**
 * A registration whose filesystem half is done: manifest validated, content
 * hashed, immutable snapshot materialized and verified. Carries no DB write —
 * commitRegistration() applies the rows inside the caller's transaction.
 *
 * `existing` is set when this exact revision+content is already registered, in
 * which case commitRegistration() is a no-op that returns the stored record.
 */
export interface PreparedPackRegistration {
  /** the manifest as read from the source directory (contentDigest may be '') */
  manifest: PackManifestFile
  /** the manifest as it will be stored, with the computed contentDigest */
  storedManifest: PackManifestFile
  digest: string
  snapshotPath: string
  existing: RegisteredPackRevision | null
  registeredAt: number
}

export interface CapabilityState {
  packId: string
  packRevision: number
  capability: IntegrationCapability
  support: PackSupportStatus
  supportReason?: string
  implementationId?: string
  contractRevision?: number
  check: IntegrationCheckResult
  checkedAt?: number
  semanticsVerified: boolean
  diagnostics: readonly IntegrationDiagnostic[]
}

export interface PackRegistryOptions {
  db: DatabaseSync
  contentRoot: string
  now?: () => number
}

export interface ConformanceCaseRunner {
  loadFixture(reference: string): unknown
  assert?(contract: IntegrationContract, fixture: unknown, result: unknown): boolean | string
}

export type {
  AdapterPack,
  AdapterPackRevision,
  CapabilityImplementation,
  IntegrationCapability,
  IntegrationCheckResult,
  IntegrationContract,
  IntegrationDiagnostic
} from '../../../mahas-contracts/src/integration/index.ts'
