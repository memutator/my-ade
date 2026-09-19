// Shared typed helpers for the initial collector Pack fixtures.
//
// The fixtures drive the real `PackRegistry` and `runPack` seam, so the result
// of a run is narrowed here once instead of every assertion casting an
// untyped payload. Nothing in this file touches a real installation: each
// fixture builds its own temporary directory or SQLite database.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { PackRegistry } from '../packages/mahas-runtime/src/integration/registry.ts'
import { INTEGRATION_SCHEMA_SQL } from '../packages/mahas-runtime/src/integration/migration.ts'
import {
  runPack,
  type PackRunRequest,
  type PackRunResult
} from '../packages/mahas-runtime/src/integration/runner.ts'

export type { PackRunRequest, PackRunResult }

export interface FixturePackRef {
  packId: string
  revision: number
  contentDigest: string
}

export interface FixtureInstallation {
  harnessId: string
  configNamespace: string
  dataNamespace: string
  presence: 'present' | 'absent' | 'unknown'
  evidence: readonly { description?: string; data?: unknown }[]
}

export interface FixtureSource {
  sourceKey: string
  kind: string
  locator: {
    path?: string
    namespace?: string
    table?: string
    keyColumn?: string
    counterEpoch?: string
    format?: string
  }
  generation: string
  identityEvidence: Record<string, unknown>
}

export interface FixtureUsageReading {
  sourceRecordKey: string
  sourceRecordRevision?: string
  sessionNativeKey?: string
  measurementKey: string
  mode: 'delta' | 'cumulative'
  counterScope?: string
  counterEpoch?: string
  values: Record<string, number | null>
  semantics: {
    unit: 'tokens'
    componentRelations: readonly { component: string; relation: string; other: string }[]
    completeness: string
  }
  timeCoverage: { kind: string; at?: number; reason?: string }
  sourceEvidence: Record<string, unknown>
}

export interface FixtureAttributionHint {
  sourceRecordKey: string
  providerId?: string
  servedModel?: { nativeName: string; namespace: string }
  basis: string
  confidence: string
  evidence: readonly {
    sourceRecordKey: string
    description?: string
    data?: Record<string, unknown>
  }[]
}

export interface FixtureSession {
  sourceRecordKey: string
  harnessId: string
  namespace: string
  nativeSessionKey: string
  parentNativeSessionKey?: string
  title?: string
  metadata: Record<string, unknown>
}

export interface FixtureHandle {
  sourceRecordKey: string
  sessionNativeKey: string
  nativeId: string
  resumeSupport: 'supported' | 'unsupported' | 'unknown'
  locator?: Record<string, unknown>
}

export interface FixtureCollectionPayload {
  observations: readonly unknown[]
  sessions: readonly FixtureSession[]
  handles: readonly FixtureHandle[]
  attachments: readonly unknown[]
  events: readonly unknown[]
  usageReadings: readonly FixtureUsageReading[]
  usageAttributionHints: readonly FixtureAttributionHint[]
  quotaReadings: readonly unknown[]
  nextCursor: Record<string, unknown> | null
  exhausted: boolean
  coverage: { completeness: string; gapReason?: string; watermark?: string }
  diagnostics: readonly { code: string; severity: string; message: string }[]
}

export interface FixtureDiscoveryPayload {
  sources: readonly FixtureSource[]
}

export interface FixtureIdentifyPayload {
  installations: readonly FixtureInstallation[]
}

export type FixtureCapability = 'identify' | 'sessions' | 'usage'

/** Open the real registry against an in-memory database and register one Pack. */
export function registerFixturePack(
  contentRoot: string,
  packDirectory: string
): {
  registry: PackRegistry
  pack: FixturePackRef
  close: () => void
} {
  const registryDb = new DatabaseSync(':memory:')
  registryDb.exec(INTEGRATION_SCHEMA_SQL)
  const registry = new PackRegistry({ db: registryDb, contentRoot })
  const revision = registry.registerDirectory(packDirectory)
  return {
    registry,
    pack: {
      packId: revision.packId,
      revision: revision.revision,
      contentDigest: revision.contentDigest
    },
    close: () => registryDb.close()
  }
}

export interface FixtureRequestOptions {
  installationId?: string
  capability?: FixtureCapability
  action?: 'discover-sources' | 'collect'
}

/** Build one runner envelope with the pinned Pack identity. */
export function fixtureEnvelope(
  pack: FixturePackRef,
  payload: Record<string, unknown>,
  operationId: string,
  options: FixtureRequestOptions = {}
): PackRunRequest {
  const capability = options.capability ?? 'usage'
  const installationId = options.installationId ?? 'fixture'
  const base = {
    protocolVersion: '1',
    operationId,
    capability,
    target: { kind: 'installation' as const, installationId },
    contract: { id: `mahas.integration.${capability}`, revision: 1 },
    pack
  }
  return (
    options.action ? { ...base, action: options.action, payload } : { ...base, payload }
  ) as PackRunRequest
}

/** Run one envelope and assert the runner correlated it to the request. */
export async function runFixture(
  registry: PackRegistry,
  request: PackRunRequest
): Promise<PackRunResult> {
  const result = await runPack(registry, request)
  assert.equal(result.operationId, request.operationId)
  assert.equal(result.protocolVersion, request.protocolVersion)
  return result
}

export function collectionPayload(result: PackRunResult): FixtureCollectionPayload {
  const payload = (result as { payload?: unknown }).payload
  assert.ok(payload, 'expected a collection payload')
  return payload as FixtureCollectionPayload
}

export function discoveryPayload(result: PackRunResult): FixtureDiscoveryPayload {
  const payload = (result as { payload?: unknown }).payload
  assert.ok(payload, 'expected a source discovery payload')
  return payload as FixtureDiscoveryPayload
}

export function identifyPayload(result: PackRunResult): FixtureIdentifyPayload {
  const payload = (result as { payload?: unknown }).payload
  assert.ok(payload, 'expected an identify payload')
  return payload as FixtureIdentifyPayload
}

/** Collector-level diagnostics live in the payload, not on the envelope. */
export function payloadDiagnosticCodes(payload: FixtureCollectionPayload): string[] {
  return payload.diagnostics.map((item) => item.code)
}

export function watermarkOf(payload: FixtureCollectionPayload): Record<string, unknown> {
  assert.ok(payload.coverage.watermark, 'expected a coverage watermark')
  return JSON.parse(payload.coverage.watermark) as Record<string, unknown>
}
