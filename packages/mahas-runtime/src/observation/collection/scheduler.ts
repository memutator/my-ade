import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { JsonObject, JsonValue } from '../../../../mahas-contracts/src/common.ts'
import type { HarnessInstallation } from '../../../../mahas-contracts/src/inventory/index.ts'
import type {
  AdapterPack,
  AdapterPackRevision,
  CapabilityImplementation,
  CapabilityRequestEnvelope,
  CapabilityResponsePayload,
  CapabilityResultEnvelope,
  PackCollectionRequestEnvelope,
  PackCollectionResultEnvelope,
  PackSourceDiscoveryEnvelope,
  PackSourceDiscoveryResult,
  PackSourceDiscoveryResultEnvelope
} from '../../../../mahas-contracts/src/integration/index.ts'
import type {
  CollectionBatch,
  CollectionSource
} from '../../../../mahas-contracts/src/metering/index.ts'
import { commitCollectionBatch, commitPackCollectionResult, getCollectionCursor } from './commit.ts'
import { getCollectionSource } from './query.ts'
import { claimCollectionRequests, completeCollectionRequest } from './requests.ts'
import { withTx } from '../../storage/transaction.ts'

type Request =
  | CapabilityRequestEnvelope<'identify'>
  | PackSourceDiscoveryEnvelope
  | PackCollectionRequestEnvelope
type Result =
  | CapabilityResultEnvelope<'identify'>
  | PackSourceDiscoveryResultEnvelope
  | PackCollectionResultEnvelope
type NativeSource = PackSourceDiscoveryResult['sources'][number]
export interface CollectionPack {
  pack: AdapterPack
  revision: AdapterPackRevision
}

/** Domain ports supplied by the composition root. Pack effects never hold a DB transaction. */
export interface CollectionSchedulerOptions {
  db: DatabaseSync
  machineId: string
  home: string
  configHome?: string
  dataHome?: string
  environment?: Readonly<Record<string, string | undefined>>
  packs(): Promise<readonly CollectionPack[]>
  invoke(request: Request, signal: AbortSignal): Promise<Result>
  saveInstallation(
    value: CapabilityResponsePayload<'identify'>['installations'][number]
  ): Promise<HarnessInstallation>
  installations(harnessId: string): Promise<readonly HarnessInstallation[]>
  /** Share admission's per-connection queue, including query reads. */
  database<T>(work: () => T): Promise<T>
  refresh(): Promise<void>
  onDiagnostic?(
    pack: CollectionPack,
    implementation: CapabilityImplementation,
    message: string
  ): Promise<void>
  log?(line: Record<string, unknown>): void
  intervalMs?: number
  maxBatches?: number
  now?: () => number
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const stableId = (...parts: string[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex')

/** Candidate paths are declarative Pack data, never a vendor switch in the daemon. */
export function collectionCandidates(
  pack: AdapterPack,
  env: Pick<CollectionSchedulerOptions, 'home' | 'configHome' | 'dataHome' | 'environment'>
): string[] {
  const discovery = object(object(pack.metadata).discovery)
  const bases: Record<string, string> = {
    home: env.home,
    'home-relative': env.home,
    'xdg-config-home': env.configHome ?? join(env.home, '.config'),
    'xdg-data-home': env.dataHome ?? join(env.home, '.local/share')
  }
  const paths = new Set<string>()
  let configRoot: string | undefined
  for (const field of [
    'roots',
    'configRoots',
    'configDirectories',
    'dataRoots',
    'dataDirectories'
  ]) {
    for (const raw of Array.isArray(discovery[field]) ? (discovery[field] as unknown[]) : []) {
      const row = object(raw)
      const kind = String(row.kind ?? row.base)
      const base =
        kind === 'environment' && typeof row.variable === 'string'
          ? (env.environment ?? process.env)[row.variable]
          : kind === 'config' || kind === 'config-relative'
            ? configRoot
            : bases[kind]
      if (base && typeof row.path === 'string') {
        const path = resolve(base, row.path)
        paths.add(path)
        if (
          !configRoot &&
          (row.role === 'config' || field === 'configRoots' || field === 'configDirectories')
        )
          configRoot = path
      }
    }
  }
  return [...paths]
}

/** A single bounded pass can be resumed after interruption from committed cursors.
 * The timer belongs to mahasd; a UI disconnect does not stop it. */
export class CollectionScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private stopped = true
  private abort = new AbortController()
  private rotation = 0
  private readonly claimId = `collector.${randomUUID()}`
  private readonly now: () => number
  private readonly options: CollectionSchedulerOptions
  // no parameter property: mahasd runs from source under Node's strip-only
  // type support, which rejects them (boot fails before anything else)
  constructor(options: CollectionSchedulerOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.abort = new AbortController()
    this.schedule(0)
  }
  request(): void {
    if (!this.stopped) this.schedule(0)
  }
  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick()
        .catch((error: unknown) => {
          this.options.log?.({
            t: 'collection.pass-failed',
            error: error instanceof Error ? error.message : String(error)
          })
        })
        .finally(() => {
          if (!this.stopped) this.schedule(this.options.intervalMs ?? 30_000)
        })
    }, delay)
    this.timer.unref()
  }
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.abort.abort()
    await this.running?.catch(() => {})
  }
  /** Explicit one-pass seam for conformance fixtures. */
  tick(): Promise<void> {
    if (this.running) return this.running
    this.running = this.pass().finally(() => {
      this.running = undefined
    })
    return this.running
  }
  private async pass(): Promise<void> {
    const jobs: Array<{
      pack: CollectionPack
      implementation: CapabilityImplementation
      installation: HarnessInstallation
      source: NativeSource
    }> = []
    for (const pack of await this.options.packs()) {
      if (this.abort.signal.aborted) return
      const identify = pack.revision.implementations.find(
        (i) => i.capability === 'identify' && i.support.state === 'implemented'
      )
      const implementation = (['usage', 'sessions', 'events'] as const)
        .map((capability) =>
          pack.revision.implementations.find(
            (i) => i.capability === capability && i.support.state === 'implemented'
          )
        )
        .find((i) => i !== undefined)
      const harness = pack.revision.subjectRefs.find((s) => s.kind === 'harness')
      const candidates = collectionCandidates(pack.pack, this.options)
      if (
        !identify ||
        !implementation ||
        !harness ||
        harness.kind !== 'harness' ||
        candidates.length === 0
      )
        continue
      try {
        const result = (await this.options.invoke(
          {
            ...this.envelope(pack, identify),
            capability: 'identify',
            target: harness,
            payload: { machineId: this.options.machineId, candidateLocators: candidates }
          },
          this.abort.signal
        )) as CapabilityResultEnvelope<'identify'>
        if (result.status !== 'success' || !result.payload)
          throw new Error('installation discovery did not complete')
        const installations = new Map(
          (await this.options.installations(harness.harnessId)).map((installation) => [
            installation.id,
            installation
          ])
        )
        for (const discovered of result.payload.installations) {
          if (discovered.harnessId !== harness.harnessId)
            throw new Error('Pack returned a different harness identity')
          const installation = await this.options.saveInstallation(discovered)
          installations.set(installation.id, installation)
        }
        for (const installation of installations.values()) {
          if (installation.presence !== 'present') continue
          const discovery = (await this.options.invoke(
            {
              ...this.envelope(pack, implementation),
              action: 'discover-sources',
              target: { kind: 'installation', installationId: installation.id },
              payload: {
                installationId: installation.id,
                configNamespace: installation.configNamespace,
                dataNamespace: installation.dataNamespace,
                capability: implementation.capability
              }
            },
            this.abort.signal
          )) as PackSourceDiscoveryResultEnvelope
          if (discovery.status !== 'success' || !discovery.payload)
            throw new Error('source discovery did not complete')
          for (const source of discovery.payload.sources)
            jobs.push({ pack, implementation, installation, source })
          // Only a completed discovery can witness absence. Missing sources retain every ledger row.
          await this.markMissing(pack, implementation, installation, discovery.payload.sources)
        }
      } catch (error) {
        if (this.abort.signal.aborted) return
        await this.options.onDiagnostic?.(
          pack,
          implementation,
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    jobs.sort((a, b) =>
      this.sourceId(a.pack, a.installation, a.source).localeCompare(
        this.sourceId(b.pack, b.installation, b.source)
      )
    )
    const requested = await this.options.database(
      () =>
        new Set(
          this.options.db
            .prepare(
              `SELECT source_id FROM collection_requests
      WHERE status='pending' OR (status='claimed' AND claim_expires_at<=?)`
            )
            .all(this.now())
            .map((row) => String(row.source_id))
        )
    )
    // Queue requests get a slot promptly; rotating the remainder keeps backfills fair.
    const rotated = [...jobs.slice(this.rotation), ...jobs.slice(0, this.rotation)]
    rotated.sort(
      (a, b) =>
        Number(requested.has(this.sourceId(b.pack, b.installation, b.source))) -
        Number(requested.has(this.sourceId(a.pack, a.installation, a.source)))
    )
    const limit = Math.min(jobs.length, this.options.maxBatches ?? 32)
    for (let offset = 0; offset < limit; offset++) {
      if (this.abort.signal.aborted) return
      const job = rotated[offset]!
      try {
        await this.collect(job)
      } catch (error) {
        if (this.abort.signal.aborted) return
        await this.options.onDiagnostic?.(
          job.pack,
          job.implementation,
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    this.rotation = jobs.length ? (this.rotation + limit) % jobs.length : 0
    if (!this.abort.signal.aborted) {
      await this.options.refresh()
    }
  }
  private envelope(
    pack: CollectionPack,
    implementation: CapabilityImplementation
  ): {
    protocolVersion: AdapterPackRevision['runnerProtocol']
    operationId: string
    capability: CapabilityImplementation['capability']
    contract: CapabilityImplementation['contract']
    pack: { packId: string; revision: number; contentDigest: string }
  } {
    return {
      protocolVersion: pack.revision.runnerProtocol,
      operationId: randomUUID(),
      capability: implementation.capability,
      contract: implementation.contract,
      pack: {
        packId: pack.pack.id,
        revision: pack.revision.revision,
        contentDigest: pack.revision.contentDigest
      }
    }
  }
  private sourceId(
    pack: CollectionPack,
    installation: HarnessInstallation,
    source: NativeSource
  ): string {
    return `source.${stableId(installation.id, pack.pack.id, source.sourceKey)}`
  }
  private async collect(job: {
    pack: CollectionPack
    implementation: CapabilityImplementation
    installation: HarnessInstallation
    source: NativeSource
  }): Promise<void> {
    const { pack, implementation, installation, source: native } = job
    const id = this.sourceId(pack, installation, native)
    const startedAt = this.now()
    const before = await this.options.database(() => getCollectionCursor(this.options.db, id))
    const queued = await this.options.database(() =>
      withTx(
        this.options.db,
        () =>
          claimCollectionRequests(this.options.db, {
            claimId: this.claimId,
            now: this.now(),
            sourceId: id,
            limit: 1,
            leaseMs: implementation.limits.timeoutMs + 10_000
          })[0]
      )
    )
    if (queued && queued.capability !== implementation.capability) {
      await this.options.database(() =>
        completeCollectionRequest(this.options.db, {
          id: queued.id,
          claimId: this.claimId,
          outcome: 'failed',
          processedAt: this.now(),
          diagnostics: [
            {
              code: 'collection.capability-mismatch',
              severity: 'error',
              message: `This source is collected through ${implementation.capability}; request that capability.`
            }
          ]
        })
      )
      return
    }
    const source: CollectionSource = {
      id,
      machineId: installation.machineId,
      subject: { kind: 'installation', installationId: installation.id },
      locator: native.locator as JsonObject,
      kind: native.kind,
      sourceGeneration: native.generation,
      identityEvidence: {
        ...(native.identityEvidence as JsonObject),
        packId: pack.pack.id,
        nativeSourceKey: native.sourceKey
      },
      status: 'active',
      firstObservedAt: startedAt,
      lastObservedAt: startedAt
    }
    const request: PackCollectionRequestEnvelope = {
      ...this.envelope(pack, implementation),
      action: 'collect',
      capability: implementation.capability as PackCollectionRequestEnvelope['capability'],
      target: { kind: 'installation', installationId: installation.id },
      payload: {
        installationId: installation.id,
        source: native,
        // Generation and collector compatibility belong to the Pack; do not silently discard its cursor.
        ...(before ? { cursor: object(before.position) } : {}),
        maxRecords: Math.min(
          queued?.maxRecords ?? 1000,
          implementation.limits.maxBatchRecords ?? 1000
        ),
        maxBytes: Math.min(
          queued?.maxBytes ?? 4 * 1024 * 1024,
          implementation.limits.maxOutputBytes
        ),
        deadlineAt: startedAt + implementation.limits.timeoutMs
      }
    }
    let result: PackCollectionResultEnvelope
    try {
      result = (await this.options.invoke(
        request,
        this.abort.signal
      )) as PackCollectionResultEnvelope
    } catch (error) {
      if (this.abort.signal.aborted) return
      const completedAt = this.now()
      const diagnostics = [
        {
          code: 'collection.invocation-failed',
          severity: 'error' as const,
          message: error instanceof Error ? error.message : String(error)
        }
      ]
      await this.options.database(() =>
        withTx(this.options.db, () => {
          const batchId = `batch.${request.operationId}`
          const current = getCollectionCursor(this.options.db, id)
          commitCollectionBatch(this.options.db, {
            source: { ...source, status: 'unavailable' },
            batch: {
              id: batchId,
              sourceId: id,
              sourceGeneration: native.generation,
              adapterPackId: pack.pack.id,
              adapterPackRevision: pack.revision.revision,
              integrationContractId: implementation.contract.id,
              contractRevision: implementation.contract.revision,
              cursorBefore: current,
              startedAt,
              committedAt: completedAt,
              result: 'failed',
              diagnostics
            },
            expectedCheckpointRevision: current?.checkpointRevision ?? null,
            coverage: [
              {
                id: `coverage.${batchId}`,
                sourceId: id,
                subject: source.subject,
                completeness: 'gap',
                gapReason: 'collector invocation failed; checkpoint retained'
              }
            ]
          })
          if (queued)
            completeCollectionRequest(this.options.db, {
              id: queued.id,
              claimId: this.claimId,
              outcome: 'failed',
              batchId,
              processedAt: completedAt,
              diagnostics
            })
        })
      )
      throw error
    }
    if (this.abort.signal.aborted) return
    const successful =
      (result.status === 'success' || result.status === 'partial') && !!result.payload
    const completedAt = this.now()
    const batch: CollectionBatch = {
      id: `batch.${request.operationId}`,
      sourceId: id,
      sourceGeneration: native.generation,
      adapterPackId: pack.pack.id,
      adapterPackRevision: pack.revision.revision,
      integrationContractId: implementation.contract.id,
      contractRevision: implementation.contract.revision,
      cursorBefore: before,
      startedAt,
      committedAt: completedAt,
      result:
        result.status === 'success'
          ? 'committed'
          : result.status === 'partial'
            ? 'partial'
            : 'failed',
      diagnostics: result.diagnostics,
      ...(successful && result.payload?.nextCursor
        ? {
            cursorAfter: {
              sourceId: id,
              sourceGeneration: native.generation,
              collectorRevision: `${pack.pack.id}@${pack.revision.revision}:${implementation.id}`,
              position: result.payload.nextCursor as JsonValue,
              checkpointRevision: (before?.checkpointRevision ?? 0) + 1,
              lastCommittedAt: completedAt
            }
          }
        : {})
    }
    await this.options.database(() =>
      withTx(this.options.db, () => {
        if (successful)
          commitPackCollectionResult(this.options.db, {
            result,
            source,
            batch,
            installationId: installation.id,
            expectedCheckpointRevision: before?.checkpointRevision ?? null
          })
        else
          commitCollectionBatch(this.options.db, {
            source: { ...source, status: 'unavailable' },
            batch,
            expectedCheckpointRevision: before?.checkpointRevision ?? null,
            coverage: [
              {
                id: `coverage.${batch.id}`,
                sourceId: id,
                subject: source.subject,
                completeness: 'gap',
                gapReason: 'collector failed; checkpoint retained'
              }
            ]
          })
        if (queued)
          completeCollectionRequest(this.options.db, {
            id: queued.id,
            claimId: this.claimId,
            outcome: successful ? 'processed' : 'failed',
            batchId: batch.id,
            processedAt: completedAt,
            diagnostics: batch.diagnostics
          })
      })
    )
  }
  private async markMissing(
    pack: CollectionPack,
    implementation: CapabilityImplementation,
    installation: HarnessInstallation,
    discovered: readonly NativeSource[]
  ): Promise<void> {
    const present = new Set(discovered.map((s) => this.sourceId(pack, installation, s)))
    await this.options.database(() => {
      const rows = this.options.db
        .prepare(
          `SELECT id FROM collection_sources s
        WHERE (status IN ('active','unavailable') OR (status='missing' AND EXISTS
          (SELECT 1 FROM collection_requests r WHERE r.source_id=s.id AND r.status IN ('pending','claimed'))))
        AND json_extract(subject_json,'$.installationId')=? AND json_extract(identity_evidence_json,'$.packId')=?`
        )
        .all(installation.id, pack.pack.id)
      for (const row of rows) {
        const id = String(row.id)
        if (present.has(id)) continue
        const source = getCollectionSource(this.options.db, id)
        if (!source) continue
        const at = this.now()
        const before = getCollectionCursor(this.options.db, id)
        const batch: CollectionBatch = {
          id: `batch.${randomUUID()}`,
          sourceId: id,
          sourceGeneration: source.sourceGeneration,
          adapterPackId: pack.pack.id,
          adapterPackRevision: pack.revision.revision,
          integrationContractId: implementation.contract.id,
          contractRevision: implementation.contract.revision,
          cursorBefore: before,
          startedAt: at,
          committedAt: at,
          result: 'partial',
          diagnostics: [
            {
              code: 'source.missing',
              severity: 'warning',
              message: 'Source absent from completed discovery; stored history retained.'
            }
          ]
        }
        withTx(this.options.db, () => {
          commitCollectionBatch(this.options.db, {
            source: { ...source, status: 'missing', lastObservedAt: at },
            batch,
            expectedCheckpointRevision: before?.checkpointRevision ?? null,
            coverage: [
              {
                id: `coverage.${batch.id}`,
                sourceId: id,
                subject: source.subject,
                completeness: 'gap',
                gapReason: 'source missing'
              }
            ]
          })
          for (const request of claimCollectionRequests(this.options.db, {
            claimId: this.claimId,
            now: at,
            sourceId: id,
            limit: 100
          })) {
            completeCollectionRequest(this.options.db, {
              id: request.id,
              claimId: this.claimId,
              outcome: 'failed',
              batchId: batch.id,
              processedAt: at,
              diagnostics: batch.diagnostics
            })
          }
        })
      }
    })
  }
}
