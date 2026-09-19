/** Integration-domain assembly. Only this composition boundary joins domain implementations. */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import type { CapabilityResultEnvelope, PackCollectionResultEnvelope, PackSourceDiscoveryResultEnvelope } from '../../mahas-contracts/src/integration/index.ts'
import type { OperationRegistry } from './api/registry.ts'
import type { RpcAuthenticate } from './rpc/framing.ts'
import { loadHarnessRuntimePack, harnessResumeSupport, type HarnessRuntimePack } from '../../mahas-harness-config/src/runtime-pack.ts'
import { serializeDatabase } from './api/admission.ts'
import { withTx } from './storage/transaction.ts'
import { registerCatalogOperations, seedBuiltinCatalog } from './catalog/index.ts'
import { appendInstallationRevision, ensureHarnessInstallation, ensureLocalMachine, getInventorySnapshot, registerInventoryOperations } from './inventory/index.ts'
import { createAuthDomain, type AuthDomain } from './inventory/auth/domain.ts'
import { registerAuthOperations } from './inventory/auth/operations.ts'
import {
  createCanonicalContractRegistry, discoverPackRoots, PackRegistry, registerIntegrationOperations,
  runPack, canonicalJson, type RegisteredPackRevision, type PackRunRequest
} from './integration/index.ts'
import { CollectionScheduler } from './observation/collection/scheduler.ts'
import { registerCollectionOperations } from './observation/collection/operations.ts'
import { registerSessionOperations } from './sessions/operations.ts'
import { registerHookIngestOperation } from './sessions/hook-ingest.ts'
import { HookStreamReader } from './sessions/hook-stream.ts'
import { registerDesktopImportOperation } from './sessions/desktop-import.ts'
import { registerUsageOperations } from './metering/usage/operations.ts'
import { drainCounterRecomputeIntents } from './metering/usage/ledger.ts'
import {
  registerMeteringAggregateOps, registerQuotaOps, refreshUsageAggregates, usageLedgerAggregateSource,
  registerStatisticDefinition, registerCoverageSpan, refreshUsageStatistics
} from './metering/index.ts'

export interface IntegrationDomainOptions {
  db: DatabaseSync
  registry: OperationRegistry
  configDir: string
  packsRoot?: string
  home?: string
  timeZone?: string
  /** Tests can register/query the real domain without touching native source directories. */
  collectionEnabled?: boolean
  /** Bounded DB-only conversion after startup/discovery; no filesystem effects. */
  afterRefresh?(db: DatabaseSync, machineId: string, pack: HarnessRuntimePack | null): void
  /**
   * Principal ids the dedicated auth channel accepts — the identities the operator
   * authenticator actually mints. Composition owns that fact (it builds the authenticator),
   * so it passes the set here; an empty set means the channel is not bound at all.
   */
  operatorPrincipals?: readonly string[]
  log?: (line: Record<string, unknown>) => void
}
export interface IntegrationDomainRuntime {
  packs: PackRegistry
  scheduler: CollectionScheduler
  start(authenticate?: RpcAuthenticate): Promise<void>
  close(): Promise<void>
}

export function builtinPacksRoot(): string {
  return process.env.MAHAS_BUILTIN_PACKS_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../integrations/packs')
}

export async function composeIntegrationDomains(options: IntegrationDomainOptions): Promise<IntegrationDomainRuntime> {
  const { db, registry, configDir } = options
  const log = options.log ?? (() => {})
  const testHome = process.env.MAHAS_TEST ? join(configDir, 'test-home') : undefined
  const home = options.home ?? testHome ?? homedir()
  const configHome = testHome ? join(home, '.config') : process.env.XDG_CONFIG_HOME
  const dataHome = testHome ? join(home, '.local/share') : process.env.XDG_DATA_HOME
  const database = <T>(work: () => T | Promise<T>): Promise<T> => serializeDatabase(db, work)
  withTx(db, () => seedBuiltinCatalog(db))
  // File identity is prepared at boot before any RPC listener or collector can run.
  const machine = ensureLocalMachine(db, { configDir, observedAt: Date.now() }).value
  const packs = new PackRegistry({ db, contentRoot: join(configDir, 'integration-packs') })
  const root = options.packsRoot ?? builtinPacksRoot()
  if (existsSync(root)) {
    for (const directory of discoverPackRoots(root)) {
      try { packs.registerDirectory(directory) }
      catch (error) {
        // One failed vendor must not hide working integrations. No capability is fabricated.
        log({ t: 'integration.builtin-registration-failed', directory,
          error: error instanceof Error ? error.message : String(error) })
      }
    }
  } else log({ t: 'integration.packs-unavailable', root })
  registerCatalogOperations(registry)
  registerInventoryOperations(registry)
  const contracts = createCanonicalContractRegistry()
  registerIntegrationOperations(registry, { packs, resolveContract: contracts.resolve })
  registerQuotaOps(registry)
  registerMeteringAggregateOps(registry)
  registerSessionOperations(registry)
  const hookDecoder = packs.list().filter((pack) => typeof pack.manifest.pack.metadata?.hookTransport === 'string')
    .sort((a, b) => b.revision - a.revision)[0]
  const hookAdapter = hookDecoder ? { id: hookDecoder.packId, revision: hookDecoder.revision } : undefined
  const harnessPack = hookDecoder ? loadHarnessRuntimePack(hookDecoder.snapshotPath) : null
  const harnessResume = harnessPack ? harnessResumeSupport(harnessPack) : undefined
  options.afterRefresh?.(db, machine.id, harnessPack)
  registerDesktopImportOperation(registry, { machineId: machine.id, harnessResume })
  registerHookIngestOperation(registry, machine.id, hookAdapter, harnessResume)
  const hookStream = new HookStreamReader({ db, machineId: machine.id, database, adapterPack: hookAdapter, harnessResume,
    path: testHome ? join(configDir, 'agent-events.log') : process.env.MAHAS_EVENTS_FILE ?? join(configDir, 'agent-events.log'), log })
  registerUsageOperations(registry)
  registerCollectionOperations(registry)
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  for (const metric of ['weekly-average', 'hourly-by-date', 'hour-of-day-distribution'] as const) {
    registerStatisticDefinition(db, { id: `default.${metric}.${timeZone}`, definitionRevision: 1,
      metric, dimensions: {}, timeZone, weekStart: 1, completedPeriodsOnly: true,
      window: { kind: 'rolling-completed-weeks', count: 4 }, enabled: true })
  }

  const scheduler = new CollectionScheduler({
    db, machineId: machine.id, home, configHome, dataHome, environment: testHome ? {} : process.env,
    database, log,
    installations: (harnessId) => database(() => getInventorySnapshot(db).installations
      .map((entry) => entry.value).filter((installation) => installation.machineId === machine.id && installation.harnessId === harnessId)),
    packs: () => database(() => {
      const latest = new Map<string, RegisteredPackRevision>()
      for (const pack of packs.list()) {
        if ((latest.get(pack.packId)?.revision ?? 0) < pack.revision) latest.set(pack.packId, pack)
      }
      return [...latest.values()].map((pack) => pack.manifest)
    }),
    invoke: async (request, signal) => {
      // The scheduler uses a strict subset of the schema-derived union. Widen
      // once here to avoid recursive structural expansion of every capability.
      const result = await runPack(packs, request as unknown as PackRunRequest, { signal })
      return result as unknown as CapabilityResultEnvelope<'identify'> | PackSourceDiscoveryResultEnvelope | PackCollectionResultEnvelope
    },
    saveInstallation: (value) => database(() => withTx(db, () => {
      const installation = ensureHarnessInstallation(db, { machineId: machine.id,
        harnessId: value.harnessId, configNamespace: value.configNamespace, dataNamespace: value.dataNamespace,
        observedAt: Date.now(), executableLocator: value.executableLocator, presence: value.presence, origin: 'discovered' }).value
      const previous = db.prepare(`SELECT installation_revision,executable_identity_json,version
        FROM inventory_installation_revisions WHERE installation_id=? ORDER BY installation_revision DESC LIMIT 1`).get(installation.id)
      const identity = canonicalJson(value.executableIdentity ?? {})
      if (!previous || canonicalJson(JSON.parse(String(previous.executable_identity_json))) !== identity || previous.version !== (value.version ?? null)) {
        const revision = Number(previous?.installation_revision ?? 0) + 1
        appendInstallationRevision(db, { id: `${installation.id}.revision.${revision}`, installationId: installation.id,
          revision, executableIdentity: value.executableIdentity ?? {}, version: value.version,
          observedAt: Date.now(), evidence: value.evidence })
      }
      return installation
    })),
    onDiagnostic: (pack, implementation, message) => database(() => withTx(db, () => {
      const diagnostics = [{ code: 'collection.failed', severity: 'error' as const, message }]
      packs.recordCheck({ packId: pack.pack.id, packRevision: pack.revision.revision,
        implementationId: implementation.id, capability: implementation.capability,
        contractId: implementation.contract.id, contractRevision: implementation.contract.revision,
        target: { kind: 'machine', machineId: machine.id }, result: 'degraded', semanticsVerified: false, diagnostics })
      const existing = db.prepare(`SELECT id FROM integration_issues WHERE pack_id=? AND pack_revision=? AND capability=? AND reason='collection.failed' AND status='open'`)
        .get(pack.pack.id, pack.revision.revision, implementation.capability)
      if (!existing) packs.openIssue({ packId: pack.pack.id, packRevision: pack.revision.revision,
        capability: implementation.capability, target: { kind: 'machine', machineId: machine.id },
        reason: 'collection.failed', diagnostics })
    })),
    refresh: () => database(() => {
      drainCounterRecomputeIntents(db, { limit: 10, now: Date.now() })
      refreshUsageAggregates(db, usageLedgerAggregateSource(db), { timeZone, weekStart: 1, limit: 1000 })
      // Project only source-declared time coverage, never manufacture an interval from polling time.
      const coverage = db.prepare(`SELECT c.id,c.last_success_at FROM collection_coverage c
        WHERE c.interval_json IS NOT NULL AND NOT EXISTS (SELECT 1 FROM metering_coverage_spans s WHERE s.coverage_id=c.id AND s.dimensions_json='{}')
        ORDER BY c.id LIMIT 1000`).all()
      withTx(db, () => {
        for (const row of coverage) registerCoverageSpan(db, { id: `span.${String(row.id)}.all`, coverageId: String(row.id),
          dimensions: {}, revision: 1, observedAt: Number(row.last_success_at ?? Date.now()) })
        refreshUsageStatistics(db, { source: usageLedgerAggregateSource(db) })
      })
      options.afterRefresh?.(db, machine.id, harnessPack)
    })
  })
  let auth: AuthDomain | null = null
  return { packs, scheduler,
    async start(authenticate) {
      if (options.collectionEnabled !== false) {
        scheduler.start()
        hookStream.start()
      }
      if (!auth) {
        const available = packs.list().some((pack) => pack.manifest.revision.implementations
          .some((implementation) => implementation.capability === 'auth' && implementation.support.state === 'implemented'))
        if (!available) return
        try {
          const selectedId = process.env.MAHAS_AUTH_PACK_ID
          const selectedRevision = Number(process.env.MAHAS_AUTH_PACK_REVISION)
          if (selectedId && (!Number.isSafeInteger(selectedRevision) || selectedRevision < 1)) {
            throw new Error('MAHAS_AUTH_PACK_ID requires a positive MAHAS_AUTH_PACK_REVISION')
          }
          // The dedicated channel is operator-only: the accepted identities must be the ones
          // the authenticator actually mints, so composition supplies them rather than the
          // channel guessing a literal.
          const operatorPrincipals = options.operatorPrincipals ?? []
          auth = await createAuthDomain({ db, database, configDir, machineId: machine.id, packs,
            ...(selectedId ? { selection: { packId: selectedId, revision: selectedRevision } } : {}),
            authenticate, allowedPrincipals: operatorPrincipals, importLocatorsOnStart: true,
            legacy: { home, configHome, dataHome,
              usageAccountsRoot: process.env.MAHAS_LEGACY_USAGE_ACCOUNTS_ROOT }, log })
          await auth.start()
          registerAuthOperations(registry, auth.operations())
        } catch (error) {
          await auth?.stop('auth bootstrap failed')
          auth = null
          log({ t: 'auth.unavailable', error: error instanceof Error ? error.message : String(error) })
        }
      }
    },
    async close() {
      await scheduler.stop()
      await hookStream.stop()
      await auth?.stop()
      auth = null
    } }
}
