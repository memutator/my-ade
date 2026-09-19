// metering/quota/poll.ts — the quota polling loop.
//
// Quota is a provider-API observation, so it must keep running while the UI is closed:
// the daemon owns the loop, the interval is configurable, and every tick commits through
// the serialized database port. Nothing here names a vendor — the loop asks the pinned
// Offering Pack to probe, and the Pack returns typed meters or a diagnostic.
//
// One tick:
//   1. read the active connections (connection + offering + credential) from storage;
//   2. resolve each connection's material through its credential materialRef —
//      mahas-managed store first, generic locator reader (Pack parser) second. Raw
//      material never comes from a caller;
//   3. invoke the Pack probe with that material;
//   4. commit one observation + typed QuotaReading (a failure is an observation too, so a
//      bad tick never destroys the last successful reading);
//   5. reschedule without overlapping ticks.

import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { JsonObject } from '../../../../mahas-contracts/src/common.ts'
import type {
  CollectionDiagnostic,
  CollectionSource,
  QuotaReading
} from '../../../../mahas-contracts/src/metering/index.ts'
import { commitCollectionBatch, getCollectionCursor } from '../../observation/collection/commit.ts'
import { isManagedSecretRef, type ManagedSecretStore } from '../../inventory/auth/secret-store.ts'
import { locatorPathFrom, type ProviderLocatorCatalog } from '../../inventory/auth/locators.ts'
import {
  buildQuotaFailure,
  buildQuotaReading,
  decodeQuotaProbePayload,
  type QuotaProbePayload
} from './service.ts'
import { getQuotaCurrent, listQuotaReadings, type QuotaCurrent } from './store.ts'

export interface QuotaProbeRequest {
  connectionId: string
  offeringId: string
  requestedAt: number
  credentialMaterial: Record<string, unknown>
  /** Exact revision selected before material IO; also used by the provenance commit. */
  pack: QuotaPackIdentity
}

export interface QuotaProbeResponse {
  status: 'success' | 'partial' | 'failure'
  payload: Record<string, unknown>
  diagnostics?: readonly { code: string; severity?: string; message: string }[]
}

/** The Offering Pack probe port. Composition supplies it from the pinned revision. */
export interface QuotaProbePort {
  probe(request: QuotaProbeRequest): Promise<QuotaProbeResponse>
}

/** Material lookup for a stored credential reference. */
export interface CredentialMaterialSource {
  /** mahas-managed material; null when the ref is not managed by mahas */
  readManaged(ref: string): Promise<{ revision: number; material: Record<string, unknown> } | null>
  /** read-only access to a user/external file through the Pack parser */
  readLocator(input: { offeringId: string; ref: string }): Promise<Record<string, unknown>>
}

export interface CredentialMaterialResolverOptions {
  secrets: ManagedSecretStore
  catalog: ProviderLocatorCatalog
  /** which parser the Pack uses for this offering */
  formatFor(offeringId: string): string | null
  readLocatorFile(ref: string): Promise<string>
}

/**
 * Resolves a credential material without any caller-provided secret: managed refs go to
 * the secret store, locator refs go through the Pack parser. Anything else is an explicit
 * failure, never an empty material set.
 */
export function createCredentialMaterialResolver(
  options: CredentialMaterialResolverOptions
): CredentialMaterialSource {
  return {
    async readManaged(ref) {
      if (!isManagedSecretRef(ref)) return null
      const record = await options.secrets.read(ref)
      return record ? { revision: record.revision, material: record.material } : null
    },
    async readLocator(input) {
      if (!locatorPathFrom(input.ref)) {
        throw new Error('credential ' + input.ref + ' is neither managed nor a locator file')
      }
      const format = options.formatFor(input.offeringId)
      if (!format)
        throw new Error('offering ' + input.offeringId + ' has no declared credential format')
      return options.catalog.parseMaterial(format, await options.readLocatorFile(input.ref))
    }
  }
}

export interface QuotaPackIdentity {
  packId: string
  revision: number
  contentDigest: string
  contractId?: string
  contractRevision?: number
}

export interface QuotaPollerOptions {
  db: DatabaseSync
  /** serializeDatabase(db, fn) — every commit is queued, never a raw BEGIN */
  database: <T>(work: () => T | Promise<T>) => Promise<T>
  probe: QuotaProbePort
  material: CredentialMaterialSource
  /** provider pack revision the probe belongs to (recorded as source evidence) */
  pack: QuotaPackIdentity
  /** Resolve the exact quota capability pin for this offering before probing. */
  packFor?: (offeringId: string) => Promise<QuotaPackIdentity | null>
  intervalMs?: number
  /** cap on connections probed in one tick; the next tick resumes with the next batch */
  batchSize?: number
  now?: () => number
  log?: (line: Record<string, unknown>) => void
  onReading?: (reading: QuotaReading, replayed: boolean) => void
}

export interface QuotaPollTickResult {
  probed: number
  succeeded: number
  failed: number
  skipped: number
  connections: string[]
}

export interface QuotaPollerStatus {
  running: boolean
  intervalMs: number
  ticks: number
  lastTickAt: number | null
  lastResult: QuotaPollTickResult | null
  lastError: string | null
}

interface ConnectionRow {
  id: string
  machine_id: string
  material_revision: number
  offering_id: string
  credential_id: string
  material_ref: string
  ownership: string
  availability: string
  credential_availability: string
}

/**
 * The bounded polling loop. start() returns immediately; ticks are awaited one at a time
 * so a slow provider cannot stack requests. stop() awaits the in-flight tick.
 */
export class QuotaPoller {
  readonly #options: QuotaPollerOptions
  readonly #intervalMs: number
  readonly #batchSize: number
  readonly #now: () => number
  #timer: ReturnType<typeof setTimeout> | null = null
  #running = false
  #inFlight: Promise<QuotaPollTickResult> | null = null
  #afterConnection = ''
  #ticks = 0
  #lastTickAt: number | null = null
  #lastResult: QuotaPollTickResult | null = null
  #lastError: string | null = null

  constructor(options: QuotaPollerOptions) {
    this.#options = options
    this.#intervalMs = Math.max(1_000, options.intervalMs ?? 5 * 60 * 1000)
    this.#batchSize = Math.max(1, Math.min(options.batchSize ?? 25, 500))
    this.#now = options.now ?? Date.now
  }

  status(): QuotaPollerStatus {
    return {
      running: this.#running,
      intervalMs: this.#intervalMs,
      ticks: this.#ticks,
      lastTickAt: this.#lastTickAt,
      lastResult: this.#lastResult,
      lastError: this.#lastError
    }
  }

  /** Start the loop. The first tick runs immediately; a failed tick does not stop it. */
  start(): void {
    if (this.#running) return
    this.#running = true
    this.#schedule(0)
  }

  /** Stop the loop and await the in-flight tick. */
  async stop(): Promise<void> {
    this.#running = false
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    if (this.#inFlight) await this.#inFlight.catch(() => undefined)
  }

  #schedule(delayMs: number): void {
    if (!this.#running) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      const tick = this.tick().catch((error: unknown) => {
        this.#lastError = error instanceof Error ? error.message : String(error)
        this.#options.log?.({ t: 'quota.poll.failed', error: this.#lastError })
        return { probed: 0, succeeded: 0, failed: 0, skipped: 0, connections: [] }
      })
      void tick.finally(() => {
        this.#schedule(this.#intervalMs)
      })
    }, delayMs)
    this.#timer.unref?.()
  }

  /**
   * One tick: probe every active connection in the batch and commit the results. Safe to
   * call directly (manual refresh, fixtures) whether or not the loop is running.
   */
  tick(): Promise<QuotaPollTickResult> {
    if (this.#inFlight) return this.#inFlight
    const running = this.#runTick()
    this.#inFlight = running
    void running.then(
      () => {
        if (this.#inFlight === running) this.#inFlight = null
      },
      () => {
        if (this.#inFlight === running) this.#inFlight = null
      }
    )
    return running
  }

  async #runTick(): Promise<QuotaPollTickResult> {
    // Only storage work holds the database queue. Slow provider I/O cannot
    // prevent normal stored queries, credential changes or shutdown bookkeeping.
    const connections = await this.#options.database(
      () =>
        this.#options.db
          .prepare(
            'SELECT c.id,c.offering_id,c.credential_id,p.material_ref,p.material_revision,' +
              ' p.machine_id,p.ownership,c.availability,p.availability AS credential_availability' +
              ' FROM inventory_provider_connections c' +
              ' JOIN inventory_provider_credentials p ON p.id=c.credential_id' +
              ' WHERE c.observed_until IS NULL ORDER BY CASE WHEN c.id>? THEN 0 ELSE 1 END,c.id LIMIT ?'
          )
          .all(this.#afterConnection, this.#batchSize) as unknown as ConnectionRow[]
    )
    if (connections.length) this.#afterConnection = connections[connections.length - 1].id
    const requestedAt = this.#now()
    const tickId = randomUUID()
    const result: QuotaPollTickResult = {
      probed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      connections: []
    }
    for (const connection of connections) {
      result.connections.push(connection.id)
      let pack: QuotaPackIdentity | null = null
      let response: QuotaProbeResponse
      const unavailable =
        connection.availability === 'unavailable' ||
        connection.credential_availability === 'unavailable'
      try {
        pack = this.#options.packFor
          ? await this.#options.packFor(connection.offering_id)
          : this.#options.pack
        if (!pack) throw new Error('no unambiguous quota Pack for this offering')
        if (unavailable) throw new Error('stored credential material is unavailable')
        const material = await this.#materialFor(connection)
        response = await this.#options.probe.probe({
          connectionId: connection.id,
          offeringId: connection.offering_id,
          requestedAt,
          credentialMaterial: material,
          pack
        })
        if (
          !response.payload ||
          typeof response.payload !== 'object' ||
          Array.isArray(response.payload)
        )
          throw new Error('quota adapter returned no payload')
        decodeQuotaProbePayload({
          ...response.payload,
          status: response.status,
          diagnostics: response.diagnostics ?? []
        })
      } catch (error) {
        response = {
          status: 'failure',
          payload: {},
          diagnostics: [
            {
              code: unavailable ? 'quota.material-unavailable' : 'quota.probe-failed',
              severity: 'error',
              message: error instanceof Error ? error.message : String(error)
            }
          ]
        }
      }
      await this.#options.database(() =>
        this.#commit({
          connection,
          pack,
          batchId: `quota-poll:${tickId}:${connection.id}`,
          sourceRecordKey: `provider-api/${connection.offering_id}/${tickId}`,
          requestedAt,
          status: response.status,
          payload: response.payload,
          diagnostics: response.diagnostics ?? []
        })
      )
      if (unavailable) result.skipped += 1
      else {
        result.probed += 1
        if (response.status === 'failure') result.failed += 1
        else result.succeeded += 1
      }
    }
    this.#ticks += 1
    this.#lastTickAt = requestedAt
    this.#lastResult = result
    this.#lastError = null
    this.#options.log?.({ t: 'quota.poll.tick', ...result })
    return result
  }

  async #materialFor(connection: ConnectionRow): Promise<Record<string, unknown>> {
    try {
      const managed = await this.#options.material.readManaged(connection.material_ref)
      if (managed) {
        // A concurrent refresh can publish the file before its inventory commit.
        // Do not attach the older stored revision to material we did not probe.
        if (managed.revision !== connection.material_revision)
          throw new Error('credential material revision is not synchronized')
        return managed.material
      }
      return await this.#options.material.readLocator({
        offeringId: connection.offering_id,
        ref: connection.material_ref
      })
    } catch {
      // Parser errors can embed the source bytes (including an API key).
      // Material errors become persisted diagnostics, so expose a fixed message.
      throw new Error('credential material is unreadable or its revision is not synchronized')
    }
  }

  #commit(input: {
    connection: ConnectionRow
    pack: QuotaPackIdentity | null
    batchId: string
    sourceRecordKey: string
    requestedAt: number
    status: 'success' | 'partial' | 'failure'
    payload: Record<string, unknown>
    diagnostics: readonly { code: string; severity?: string; message: string }[]
  }): void {
    const sourceId =
      'quota-source.' +
      createHash('sha256')
        .update(JSON.stringify([input.connection.machine_id, input.connection.id]))
        .digest('hex')
        .slice(0, 40)
    const evidence = [
      { sourceId, sourceRecordKey: input.sourceRecordKey, description: 'provider quota probe' }
    ]
    const sourceEvidence: JsonObject = {
      offeringId: input.connection.offering_id,
      credentialId: input.connection.credential_id,
      credentialOwnership: input.connection.ownership,
      materialRevision: input.connection.material_revision,
      collectionSourceId: sourceId,
      ...(input.pack
        ? {
            packId: input.pack.packId,
            packRevision: input.pack.revision,
            packContentDigest: input.pack.contentDigest
          }
        : {})
    }
    const reading =
      input.status === 'failure'
        ? buildQuotaReading(
            buildQuotaFailure({
              connectionId: input.connection.id,
              batchId: input.batchId,
              sourceRecordKey: input.sourceRecordKey,
              observedAt: input.requestedAt,
              code: input.diagnostics[0]?.code ?? 'quota.probe-failed',
              message: input.diagnostics[0]?.message ?? 'quota probe failed',
              evidence,
              sourceEvidence
            })
          )
        : buildQuotaReading({
            connectionId: input.connection.id,
            batchId: input.batchId,
            sourceRecordKey: input.sourceRecordKey,
            observedAt: input.requestedAt,
            payload: decodeQuotaProbePayload({
              ...input.payload,
              sourceEvidence: {
                ...(input.payload.sourceEvidence as JsonObject),
                ...sourceEvidence
              },
              status: input.status,
              diagnostics: input.diagnostics
            }) as QuotaProbePayload,
            evidence
          })
    const diagnostics: CollectionDiagnostic[] = input.diagnostics.map((d) => ({
      code: d.code,
      message: d.message,
      severity: d.severity === 'info' || d.severity === 'warning' ? d.severity : 'error'
    }))
    const source: CollectionSource = {
      id: sourceId,
      machineId: input.connection.machine_id,
      subject: { kind: 'connection', connectionId: input.connection.id },
      locator: {
        kind: 'provider-quota',
        connectionId: input.connection.id,
        offeringId: input.connection.offering_id
      },
      kind: 'provider-api',
      sourceGeneration: input.connection.id,
      identityEvidence: { owner: 'auth-quota-poller', ...sourceEvidence },
      status: input.status === 'failure' ? 'unavailable' : 'active',
      firstObservedAt: input.requestedAt,
      lastObservedAt: input.requestedAt
    }
    const cursor = getCollectionCursor(this.#options.db, sourceId)
    const lastSuccess = getQuotaCurrent(this.#options.db, input.connection.id).lastSuccess
    const result = commitCollectionBatch(this.#options.db, {
      source,
      batch: {
        id: input.batchId,
        sourceId,
        sourceGeneration: source.sourceGeneration,
        adapterPackId: input.pack?.packId ?? 'unresolved',
        adapterPackRevision: input.pack?.revision ?? 0,
        integrationContractId: input.pack?.contractId ?? 'mahas.integration.quota',
        contractRevision: input.pack?.contractRevision ?? 1,
        cursorBefore: cursor,
        startedAt: input.requestedAt,
        committedAt: Math.max(input.requestedAt, this.#now()),
        result:
          input.status === 'failure'
            ? 'failed'
            : input.status === 'partial'
              ? 'partial'
              : 'committed',
        diagnostics
      },
      expectedCheckpointRevision: cursor?.checkpointRevision ?? null,
      quota: [reading],
      coverage: [
        {
          id: `coverage.${input.batchId}`,
          sourceId,
          subject: source.subject,
          // A quota snapshot proves no interval of token usage was collected.
          interval: null,
          completeness: input.status === 'failure' ? 'gap' : 'unknown',
          gapReason:
            input.status === 'failure' ? (diagnostics[0]?.message ?? 'quota probe failed') : null,
          lastSuccessAt:
            input.status === 'success' ? input.requestedAt : (lastSuccess?.observedAt ?? null)
        }
      ]
    })
    this.#options.onReading?.(reading, result.replayed)
  }

  /** Latest reading, last success and current failure for one connection. */
  current(connectionId: string): QuotaCurrent {
    return getQuotaCurrent(this.#options.db, connectionId)
  }

  history(input: { connectionId: string; limit?: number }): QuotaReading[] {
    return listQuotaReadings(this.#options.db, input)
  }
}
