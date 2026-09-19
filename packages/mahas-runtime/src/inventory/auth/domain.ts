// inventory/auth/domain.ts — the auth domain factory.
//
// One call assembles everything the daemon needs for provider connections:
//
//   const auth = await createAuthDomain({ db, database, configDir, machineId, packs, authenticate })
//   const { endpoint, status } = await auth.start()
//   await auth.stop()
//
// The factory owns:
//   • the providers Pack resolution (driver + locator catalog) from the registered snapshot;
//   • the managed secret store under <configDir>/provider-secrets;
//   • the dedicated auth socket (<configDir>/mahasd-auth.sock), operator-only;
//   • the bounded quota polling loop over stored connections (interval, no UI required);
//   • every commit through the injected serialized database port.
//
// It performs no DDL: AUTH_SCHEMA_SQL belongs to the control migration, and nothing here
// guesses a desktop path — legacy credential locations come in through options.legacy.

import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { PackRegistry } from '../../integration/registry.ts'
import { FileManagedSecretStore, type ManagedSecretStore } from './secret-store.ts'
import {
  AUTH_PACK_CAPABILITY,
  ProviderPackAuthDriver,
  QUOTA_PACK_CAPABILITY,
  capabilityProviders,
  loadProviderLocatorModule,
  loadProviderPackModule,
  providerCatalogFromPack,
  resolveProviderPack,
  type LoadedProviderPack,
  type ProviderPackSelection
} from './driver.ts'
import { LoopbackAuthCallback, UnavailableAuthCallback, type AuthCallbackPort } from './callback.ts'
import { mahasError } from '../../api/handler-ports.ts'
import {
  nodeLocatorFileIo,
  type CredentialMaterialFormat,
  type LocatorCandidate,
  type LocatorFileIo,
  type LocatorRoots,
  type ProviderLocatorCatalog
} from './locators.ts'
import { AuthService, type AuthServiceStatus, type SerializedDatabase } from './service.ts'
import type { AuthOperationPorts } from './operations.ts'
import {
  DedicatedAuthTransport,
  type AuthChannelAuditSink,
  type AuthChannelHandlers
} from './transport.ts'
import { serveAuthChannel, type AuthChannelServer } from './channel-server.ts'
import {
  QuotaPoller,
  createCredentialMaterialResolver,
  type QuotaPackIdentity,
  type QuotaPollTickResult,
  type QuotaPollerStatus,
  type QuotaProbeRequest,
  type QuotaProbeResponse
} from '../../metering/quota/poll.ts'
import type { QuotaCurrent } from '../../metering/quota/store.ts'
import type { ProviderAuthDriver } from './coordinator.ts'
import type { RpcAuthenticate } from '../../rpc/framing.ts'

/**
 * The Pack locator catalog, adapted to the runtime vendor-neutral port. Every vendor fact
 * (paths, formats, parsers) stays inside the Pack; this only forwards.
 */
export function packLocatorCatalog(module: Record<string, unknown>): ProviderLocatorCatalog {
  const catalog = providerCatalogFromPack(module)
  const listCandidates = module.locatorCandidates
  const parseMaterial = module.readLocatorMaterial
  if (typeof listCandidates !== 'function' || typeof parseMaterial !== 'function') {
    throw new Error('the providers Pack must export locatorCandidates() and readLocatorMaterial()')
  }
  const list = listCandidates as (
    catalog: unknown,
    roots: LocatorRoots
  ) => readonly LocatorCandidate[]
  const parse = parseMaterial as (
    format: CredentialMaterialFormat,
    content: string
  ) => Record<string, unknown>
  return {
    candidates: (roots) => list(catalog, roots),
    parseMaterial: (format, content) => parse(format, content)
  }
}

/** Credential format declared by the Pack for one offering. */
export function packFormatFor(
  module: Record<string, unknown>
): (offeringId: string) => string | null {
  const catalog = providerCatalogFromPack(module)
  return (offeringId) => {
    const entry = catalog[offeringId]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const format = (entry as Record<string, unknown>).format
    return typeof format === 'string' ? format : null
  }
}

export interface AuthDomainOptions {
  db: DatabaseSync
  /** serializeDatabase(db, fn) from the composition root — every commit uses this. */
  database: SerializedDatabase
  configDir: string
  /** local machine id; credentials/connections are registered against it */
  machineId: string
  /** registered Pack registry to resolve the provider implementations from */
  packs: PackRegistry
  selection?: ProviderPackSelection
  /** operator credential check for the dedicated socket (operator-only channel) */
  authenticate?: RpcAuthenticate
  /** principal ids the channel accepts (the operator authenticator's own ids) */
  allowedPrincipals?: readonly string[]
  /** explicit legacy credential roots; the factory never guesses a desktop path */
  legacy?: { home?: string; configHome?: string; dataHome?: string; usageAccountsRoot?: string }
  /** import existing credential files on start() (read-only locator refs) */
  importLocatorsOnStart?: boolean
  quotaIntervalMs?: number
  quotaBatchSize?: number
  /** test seam: the fetch the Pack probe uses instead of the global one */
  fetch?: typeof globalThis.fetch
  callback?: AuthCallbackPort
  fileIo?: LocatorFileIo
  audit?: AuthChannelAuditSink
  log?: (line: Record<string, unknown>) => void
  now?: () => number
  id?: () => string
}

export interface AuthDomainStartResult {
  /** dedicated socket endpoint; '' when no operator authenticator was supplied */
  endpoint: string
  status: AuthServiceStatus
  quota: QuotaPollerStatus
}

export interface AuthDomain {
  service: AuthService
  transport: DedicatedAuthTransport
  handlers: AuthChannelHandlers
  driver: ProviderAuthDriver
  catalog: ProviderLocatorCatalog
  secrets: ManagedSecretStore
  roots: LocatorRoots
  quota: QuotaPoller
  /** the auth Pack revisions the domain loaded, for diagnostics */
  packs(): readonly { packId: string; revision: number; contentDigest: string }[]
  channelEndpoint(): string | null
  status(): AuthServiceStatus
  start(): Promise<AuthDomainStartResult>
  stop(reason?: string): Promise<AuthServiceStatus>
  /**
   * One quota tick on demand (fixtures, manual refresh from the settings UI). The
   * daemon loop uses the same path; no caller supplies credential material.
   */
  collectQuota(): Promise<QuotaPollTickResult>
  quotaCurrent(connectionId: string): QuotaCurrent
  /** the secret-free operation surface (UI/CLI); register it from composition */
  operations(): AuthOperationPorts
}

export async function createAuthDomain(options: AuthDomainOptions): Promise<AuthDomain> {
  // An explicit pin is validated up front — a bad MAHAS_AUTH_PACK_* value must fail the
  // domain, not the first flow. Without a pin there is nothing to resolve here: every
  // flow resolves the Pack that declares its offering at call time, so a second
  // registered auth Pack no longer makes the domain ambiguous.
  const pinned: ProviderPackSelection | undefined = options.selection
    ? resolveProviderPack(options.packs, AUTH_PACK_CAPABILITY, {
        selection: options.selection
      })
    : undefined
  const now = options.now ?? Date.now
  const secrets = new FileManagedSecretStore(join(options.configDir, 'provider-secrets'))
  const driver = new ProviderPackAuthDriver({
    registry: options.packs,
    secrets,
    ...(pinned ? { selection: pinned } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now
  })
  const loaded: readonly LoadedProviderPack[] = await driver.load()
  // The locator catalog is merged across every auth Pack the driver can route to (the
  // pinned revision, or the newest revision per auth-capable Pack identity). A Pack
  // whose locator module cannot be loaded contributes nothing — its offerings fail at
  // call time rather than stripping candidates the other Packs own.
  const authProviders: readonly ProviderPackSelection[] = pinned
    ? [pinned]
    : (() => {
        const seen = new Set<string>()
        return capabilityProviders(options.packs, AUTH_PACK_CAPABILITY)
          .filter((provider) => {
            if (seen.has(provider.packId)) return false
            seen.add(provider.packId)
            return true
          })
          .map((provider) => ({ packId: provider.packId, revision: provider.revision }))
      })()
  const catalogs: ProviderLocatorCatalog[] = []
  const formatOwners = new Map<string, ProviderLocatorCatalog>()
  const ambiguousFormats = new Set<string>()
  const offeringFormats = new Map<string, string>()
  for (const provider of authProviders) {
    let locatorModule: Record<string, unknown>
    let catalog: ProviderLocatorCatalog
    try {
      locatorModule = await loadProviderLocatorModule(options.packs, provider)
      catalog = packLocatorCatalog(locatorModule)
    } catch (error) {
      options.log?.({
        t: 'auth.pack.locators-unavailable',
        packId: provider.packId,
        revision: provider.revision,
        error: error instanceof Error ? error.message : String(error)
      })
      continue
    }
    catalogs.push(catalog)
    for (const [offeringId, entry] of Object.entries(providerCatalogFromPack(locatorModule))) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const format = (entry as Record<string, unknown>).format
      if (typeof format !== 'string') continue
      const prior = formatOwners.get(format)
      if (prior && prior !== catalog) {
        // Two Packs claim the same format string and parseMaterial gets no offering to
        // disambiguate by — the format is refused rather than routed to the wrong parser.
        ambiguousFormats.add(format)
      } else if (!prior) {
        formatOwners.set(format, catalog)
      }
      if (!offeringFormats.has(offeringId)) offeringFormats.set(offeringId, format)
    }
  }
  const catalog: ProviderLocatorCatalog = {
    candidates: (roots) => catalogs.flatMap((entry) => entry.candidates(roots)),
    parseMaterial: (format, content) => {
      if (ambiguousFormats.has(format)) {
        throw new Error(
          'credential format ' + format + ' is declared by several Packs and cannot be routed'
        )
      }
      const owner = formatOwners.get(format)
      if (owner) return owner.parseMaterial(format, content)
      // One Pack keeps the historical behavior exactly: its parser decides what it can
      // read, including formats its catalog does not declare.
      if (catalogs.length === 1) return catalogs[0].parseMaterial(format, content)
      throw new Error('no registered Pack declares credential format ' + format)
    }
  }
  const formatFor = (offeringId: string): string | null =>
    offeringFormats.get(offeringId) ?? null
  /** One Pack-catalog candidate for an explicit file pick: the offering resolves the
   *  credential format (never the bytes), and the file stays user-owned read-only
   *  material. An offering the registered Packs do not declare is refused rather than
   *  routed to a guessed parser. */
  const explicitLocatorCandidate = (input: {
    offeringId?: string
    path: string
  }): LocatorCandidate => {
    if (!input.offeringId) {
      throw mahasError(
        'MODEL_INVALID',
        'an explicit file import names its offeringId',
        'none'
      )
    }
    resolveProviderPack(options.packs, AUTH_PACK_CAPABILITY, { offeringId: input.offeringId, ...(pinned ? { selection: pinned } : {}) })
    const format = formatFor(input.offeringId)
    if (!format) {
      throw mahasError(
        'MODEL_INVALID',
        'no registered Pack declares a credential format for offering ' + input.offeringId,
        'none'
      )
    }
    return {
      offeringId: input.offeringId,
      format,
      ownership: 'user',
      path: input.path,
      label: 'explicit file import'
    }
  }
  const home = options.legacy?.home ?? process.env.HOME ?? ''
  const roots: LocatorRoots = {
    home,
    configHome: options.legacy?.configHome ?? process.env.XDG_CONFIG_HOME ?? join(home, '.config'),
    dataHome: options.legacy?.dataHome ?? process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'),
    ...(options.legacy?.usageAccountsRoot ? { usageAccountsRoot: options.legacy.usageAccountsRoot } : {})
  }
  const fileIo = options.fileIo ?? nodeLocatorFileIo
  const callback = options.callback ?? new LoopbackAuthCallback()
  const service = new AuthService({
    db: options.db,
    database: options.database,
    machineId: options.machineId,
    secrets,
    driver,
    catalog,
    roots,
    callback,
    fileIo,
    now,
    ...(options.id ? { id: options.id } : {})
  })
  const material = createCredentialMaterialResolver({
    secrets,
    catalog,
    formatFor,
    readLocatorFile: (ref) => fileIo.read(ref.slice('locator://file/'.length))
  })
  // The offering on the connection row is authoritative: it picks the quota Pack the
  // same way the auth driver picks the sign-in Pack — an explicit pin when one was
  // supplied, otherwise the registered revision declaring that offering.
  const resolveQuotaPack = (offeringId?: string): ProviderPackSelection =>
    resolveProviderPack(options.packs, QUOTA_PACK_CAPABILITY, {
      ...(pinned ? { selection: pinned } : {}),
      ...(offeringId ? { offeringId } : {})
    })
  const quotaIdentity = (selection: ProviderPackSelection): QuotaPackIdentity => {
    const registered = options.packs.find(selection.packId, selection.revision)
    const implementation = options.packs.implementation(
      selection.packId,
      selection.revision,
      QUOTA_PACK_CAPABILITY
    )
    return {
      packId: selection.packId,
      revision: selection.revision,
      contentDigest: registered?.contentDigest ?? '',
      ...(implementation?.contract
        ? {
            contractId: implementation.contract.id,
            contractRevision: implementation.contract.revision
          }
        : {})
    }
  }
  // Fallback identity for the poller's `pack` option: used only when no `packFor`
  // resolver runs. Unresolvable stays honestly unresolved — never an invented Pack.
  let fallbackPack: QuotaPackIdentity
  try {
    fallbackPack = quotaIdentity(resolveQuotaPack())
  } catch {
    fallbackPack = { packId: 'unresolved', revision: 0, contentDigest: 'unresolved' }
  }
  const quota = new QuotaPoller({
    db: options.db,
    database: options.database,
    probe: {
      async probe(request: QuotaProbeRequest): Promise<QuotaProbeResponse> {
        const quotaModule = await loadProviderPackModule(
          options.packs,
          QUOTA_PACK_CAPABILITY,
          // The poller resolved and recorded this exact pin BEFORE the material read,
          // so the probe loads the same revision the evidence names — never a
          // re-resolution that could drift if the registry changed in between.
          { packId: request.pack.packId, revision: request.pack.revision }
        )
        const probeQuota = quotaModule.module.probeQuota
        if (typeof probeQuota !== 'function') {
          throw new Error('Pack ' + quotaModule.packId + ' must export probeQuota()')
        }
        const result = await (
          probeQuota as (envelope: unknown, io: unknown) => Promise<Record<string, unknown>>
        )(
          {
            protocolVersion: quotaModule.runnerProtocol,
            operationId: 'quota-' + String(request.requestedAt) + '-' + request.connectionId,
            capability: 'quota',
            // The target stays contract-exact (a connection target is {kind, connectionId}).
            target: { kind: 'connection', connectionId: request.connectionId },
            contract: { id: 'mahas.integration.quota', revision: 1 },
            pack: {
              packId: quotaModule.packId,
              revision: quotaModule.revision,
              contentDigest: quotaModule.contentDigest
            },
            payload: {
              connectionId: request.connectionId,
              requestedAt: request.requestedAt,
              // The OFFERING is authoritative domain context taken from the connection row: a
              // managed token set or a user's file carries no offering identity of its own, so
              // the runtime scopes the material with it before the Pack ever sees it.
              credentialMaterial: { ...request.credentialMaterial, offeringId: request.offeringId }
            }
          },
          // The Pack owns its transport; tests inject one here to drive the real Pack module
          // through the real factory route without a network.
          options.fetch ? { fetch: options.fetch } : {}
        )
        // Built-in in-process probes return their typed payload; script-shaped
        // adapters may already wrap it. Normalize the adapter boundary once.
        return result.payload && typeof result.payload === 'object'
          ? (result as unknown as QuotaProbeResponse)
          : {
              status: (result.status === 'partial' || result.status === 'failure'
                ? result.status
                : 'success') as QuotaProbeResponse['status'],
              payload: result,
              diagnostics: result.diagnostics as QuotaProbeResponse['diagnostics']
            }
      }
    },
    material,
    pack: fallbackPack,
    packFor: async (offeringId) => quotaIdentity(resolveQuotaPack(offeringId)),
    ...(options.quotaIntervalMs !== undefined ? { intervalMs: options.quotaIntervalMs } : {}),
    ...(options.quotaBatchSize !== undefined ? { batchSize: options.quotaBatchSize } : {}),
    now,
    ...(options.log ? { log: options.log } : {})
  })
  const transport = new DedicatedAuthTransport({
    handlers: service.durableChannelHandlers({
      importLocators: (input) => service.importLocators({ machineId: input.machineId }),
      adoptLocator: (input) =>
        service.adoptLocator({
          machineId: input.machineId,
          offeringId: input.offeringId,
          credentialId: input.credentialId,
          accountContinuity: 'confirmed-same',
          format: input.format
        }),
      collectQuota: () => quota.tick()
    }),
    deposits: service.deposits,
    ...(options.audit ? { audit: options.audit } : {}),
    now
  })
  let channel: AuthChannelServer | null = null

  return {
    service,
    transport,
    handlers: service.channelHandlers(),
    driver,
    catalog,
    secrets,
    roots,
    quota,
    packs: () =>
      loaded.map((pack) => ({
        packId: pack.packId,
        revision: pack.revision,
        contentDigest: pack.contentDigest
      })),
    channelEndpoint: () => channel?.endpoint ?? null,
    status: () => service.status(),
    async start() {
      const status = await service.boot()
      if (options.importLocatorsOnStart) {
        try {
          const imported = await service.importLocators({ machineId: options.machineId })
          options.log?.({
            t: 'auth.locators.imported',
            imported: imported.imported.length,
            unchanged: imported.unchanged.length,
            unavailable: imported.unavailable.length
          })
        } catch (error) {
          options.log?.({
            t: 'auth.locators.import-failed',
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
      quota.start()
      if (!options.authenticate) {
        // Without an operator authenticator the channel is not bound: a socket nobody can
        // authenticate to would be a weaker path, not a convenience.
        return { endpoint: '', status, quota: quota.status() }
      }
      channel = serveAuthChannel({
        configDir: options.configDir,
        transport,
        authenticate: options.authenticate,
        allowedPrincipals: options.allowedPrincipals ?? [],
        ...(options.audit ? { audit: options.audit } : {})
      })
      await channel.ready
      return { endpoint: channel.endpoint, status, quota: quota.status() }
    },
    async stop(reason) {
      const closed = channel
      channel = null
      await quota.stop()
      if (closed) await closed.close()
      return service.shutdown(reason)
    },
    collectQuota: () => quota.tick(),
    quotaCurrent: (connectionId) => quota.current(connectionId),
    operations: () => ({
      status: () => service.status(),
      beginIntent: (input) => service.beginIntent(input),
      getIntent: (intentId) => service.getIntent(intentId),
      listIntents: (filter) => service.listIntents(filter),
      recordFlow: (intentId, view) => service.recordFlow(intentId, view),
      completeIntent: (intentId) => service.completeIntent(intentId),
      listFlows: () => service.list(),
      flowStatus: (flowId) => service.flowStatus({ flowId }),
      cancelFlow: (flowId, reason) => service.cancel({ flowId, ...(reason ? { reason } : {}) }),
      refresh: (input) => service.refresh(input),
      inventory: () => inventoryRows(options.db),
      importLocators: (input) => service.importLocators(input),
      adoptLocator: (input) => service.adoptLocator(input),
      collectQuota: () => quota.tick(),
      quotaCurrent: (connectionId) => quota.current(connectionId),
      // Deferred halves: the effect phase does the IO, the completion phase is DB only.
      prepareLocatorImport: (input) => {
        if (input.machineId !== undefined && input.machineId !== options.machineId)
          throw mahasError('MODEL_INVALID', 'local credential files belong to the daemon machine', 'none')
        return service.prepareLocatorImport({
          machineId: options.machineId,
          ...(input.path !== undefined
            ? { candidates: [explicitLocatorCandidate({ offeringId: input.offeringId, path: input.path })] }
            : {})
        })
      },
      commitLocatorImportInTransaction: (db, prepared) =>
        service.commitLocatorImportInTransaction(db, prepared as never),
      prepareAdoption: (input) => service.prepareAdoption(input as never),
      commitAdoptionInTransaction: (db, prepared) =>
        service.commitAdoptionInTransaction(db, prepared as never),
      flowViewForIntent: (intentId) => {
        const intent = service.getIntent(intentId)
        if (!intent) return null
        return intent.flowId
          ? service.flowStatus({ flowId: intent.flowId })
          : {
              flowId: '',
              state: intent.state === 'complete' ? 'complete' : 'unknown'
            }
      },
      commitCompletionInTransaction: (db, intentId, view) =>
        service.commitCompletionInTransaction(db, intentId, view),
      // A signal, not a probe: the daemon loop owns the provider call and its own
      // serialization section, so a UI refresh cannot hold the write lock on a network wait.
      signalQuotaCollect: () => {
        // Scheduled after the caller's transaction closes: a probe must never run while the
        // signal's transaction is open, and the loop takes its own serialization section.
        setImmediate(() => {
          void quota.tick().catch(() => undefined)
        })
        return { signalled: true, running: quota.status().running }
      }
    })
  }
}

/**
 * Credentials/connections with their provenance, for the settings UI. The material ref is
 * included (it is a reference, not a secret) so the UI can label a connection as managed
 * or as pointing at a file the user owns.
 */
function inventoryRows(db: DatabaseSync): ReturnType<AuthOperationPorts['inventory']> {
  const credentials = db
    .prepare(
      'SELECT p.id,p.material_ref,p.material_revision,p.ownership,p.availability,' +
        ' c.offering_id, v.origin, v.locator_ref' +
        ' FROM inventory_provider_credentials p' +
        ' LEFT JOIN inventory_provider_connections c ON c.credential_id=p.id AND c.observed_until IS NULL' +
        ' LEFT JOIN auth_credential_provenance v ON v.credential_id=p.id' +
        ' ORDER BY p.first_seen_at DESC'
    )
    .all() as unknown as Array<Record<string, unknown>>
  const connections = db
    .prepare(
      'SELECT id,offering_id,credential_id,availability FROM inventory_provider_connections' +
        ' WHERE observed_until IS NULL ORDER BY first_seen_at DESC'
    )
    .all() as unknown as Array<Record<string, unknown>>
  return {
    credentials: credentials.map((row) => ({
      id: String(row.id),
      offeringId: row.offering_id == null ? null : String(row.offering_id),
      materialRef: String(row.material_ref),
      materialRevision: Number(row.material_revision),
      ownership: String(row.ownership),
      availability: String(row.availability),
      origin: row.origin == null ? null : String(row.origin),
      locatorRef: row.locator_ref == null ? null : String(row.locator_ref)
    })),
    connections: connections.map((row) => ({
      id: String(row.id),
      offeringId: String(row.offering_id),
      credentialId: String(row.credential_id),
      availability: String(row.availability)
    }))
  }
}

/** Headless variant: manual-code/device flows only, no loopback listener. */
export function headlessAuthCallback(): AuthCallbackPort {
  return new UnavailableAuthCallback()
}
