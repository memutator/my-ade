// inventory/auth/driver.ts — the Pack-backed auth driver.
//
// Provider-specific sign-in knowledge (endpoints, client ids, PKCE shape, device
// polling, which file holds the credentials) lives in a provider Pack. The runtime loads
// that Pack's coordinator FROM THE REGISTERED SNAPSHOT and gives it the managed secret
// store (material never leaves the daemon) plus the loopback callback shape the Pack
// declares.
//
// SCOPE: the driver routes per OFFERING. Every flow resolves the registered Pack revision
// that declares its offering (see resolveProviderPack), so adding an external auth Pack
// never disables the built-in offerings — it only claims the offerings it declares. An
// explicit selection still pins every offering to one revision (the composition
// MAHAS_AUTH_PACK_ID/REVISION override, and the way out of a genuinely ambiguous
// offering). Flow-following methods (submit/poll/cancel/status) dispatch to the Pack that
// started the flow, so two live coordinators never see each other flow ids.
//
// The generic Pack runner cannot carry sign-in material — runPack refuses effectful
// auth capabilities on purpose (EFFECTFUL_CHECK_FORBIDDEN) and its envelopes are
// schema-checked, receipted data. Auth therefore travels through the dedicated channel
// (transport.ts), and this driver is the adapter behind it.

import { PackRegistry, packEntrypoint } from '../../integration/registry.ts'
import { dirname, join } from 'node:path'
import type { IntegrationCapability } from '../../../../mahas-contracts/src/integration/index.ts'
import type { ManagedSecretStore } from './secret-store.ts'
import { AuthTransportError } from './transport.ts'
import type { AuthCallbackSpec, AuthFlowView, ProviderAuthDriver } from './coordinator.ts'

export const AUTH_PACK_CAPABILITY: IntegrationCapability = 'auth'
export const QUOTA_PACK_CAPABILITY: IntegrationCapability = 'quota'

/**
 * Which registered Pack revision serves the auth/quota capabilities. There is no built-in
 * default: the runtime never names a vendor Pack, and composition either pins one explicitly
 * or lets the resolver pick when exactly ONE registered revision implements the capability.
 */
export interface ProviderPackSelection {
  packId: string
  revision: number
}

/** A Pack revision that implements the requested capability. */
export interface CapabilityProvider {
  packId: string
  revision: number
  contentDigest: string
  /** offerings this revision declares support for, when it declares any */
  declaredOfferings: readonly string[]
}

/**
 * The registry half the resolver needs. Kept structural so tests and the composition can
 * supply it without constructing a full PackRegistry.
 */
export interface CapabilityProviderSource {
  list(): readonly {
    packId: string
    revision: number
    contentDigest: string
    manifest: {
      revision: {
        subjectRefs: readonly { kind: string; offeringId?: string }[]
        implementations: readonly {
          capability: IntegrationCapability
          support: { state: 'implemented' | 'unsupported' }
        }[]
      }
    }
  }[]
}

function declaredOfferingsOf(revision: {
  subjectRefs: readonly { kind: string; offeringId?: string }[]
}): string[] {
  return revision.subjectRefs
    .filter((subject) => subject.kind === 'offering' && typeof subject.offeringId === 'string')
    .map((subject) => subject.offeringId as string)
}

/** Every registered revision that implements \`capability\`, newest revision per Pack id first. */
export function capabilityProviders(
  registry: CapabilityProviderSource,
  capability: IntegrationCapability
): CapabilityProvider[] {
  const providers: CapabilityProvider[] = []
  for (const registered of registry.list()) {
    const implementation = registered.manifest.revision.implementations.find(
      (candidate) =>
        candidate.capability === capability && candidate.support.state === 'implemented'
    )
    if (!implementation) continue
    providers.push({
      packId: registered.packId,
      revision: registered.revision,
      contentDigest: registered.contentDigest,
      declaredOfferings: declaredOfferingsOf(registered.manifest.revision)
    })
  }
  return providers.sort(
    (left, right) => left.packId.localeCompare(right.packId) || right.revision - left.revision
  )
}

/**
 * The newest registered revision per Pack identity. capabilityProviders sorts by Pack id
 * then descending revision, so the first occurrence of each id is its newest.
 */
function newestPerPack(providers: readonly CapabilityProvider[]): CapabilityProvider[] {
  const seen = new Set<string>()
  return providers.filter((provider) => {
    if (seen.has(provider.packId)) return false
    seen.add(provider.packId)
    return true
  })
}

export class ProviderPackSelectionError extends Error {
  readonly code: 'NO_PROVIDER_PACK' | 'AMBIGUOUS_PROVIDER_PACK' | 'OFFERING_UNSUPPORTED'
  readonly candidates: readonly string[]

  constructor(
    code: 'NO_PROVIDER_PACK' | 'AMBIGUOUS_PROVIDER_PACK' | 'OFFERING_UNSUPPORTED',
    message: string,
    candidates: readonly string[] = []
  ) {
    super(message)
    this.name = 'ProviderPackSelectionError'
    this.code = code
    this.candidates = candidates
  }
}

/**
 * Resolve which Pack revision serves \`capability\`.
 *
 *   • an explicit selection always wins (composition pins it, and every flow then pins that
 *     exact revision);
 *   • otherwise exactly one registered revision must implement the capability. Several
 *     DISTINCT Pack identities implementing it is an error, never a silent pick — that is how
 *     adding an unrelated external auth Pack would otherwise hide the built-in offerings;
 *   • \`offeringId\`, when given, additionally requires the revision to declare that offering,
 *     so a Pack that implements the capability for other products is not chosen for this one.
 */
export function resolveProviderPack(
  registry: CapabilityProviderSource,
  capability: IntegrationCapability,
  input: { selection?: ProviderPackSelection; offeringId?: string } = {}
): ProviderPackSelection {
  if (input.selection) {
    const pinned = registry
      .list()
      .find(
        (registered) =>
          registered.packId === input.selection?.packId &&
          registered.revision === input.selection.revision
      )
    if (!pinned) {
      throw new ProviderPackSelectionError(
        'NO_PROVIDER_PACK',
        'Pack ' + input.selection.packId + '@' + input.selection.revision + ' is not registered'
      )
    }
    const implementation = pinned.manifest.revision.implementations.find(
      (candidate) =>
        candidate.capability === capability && candidate.support.state === 'implemented'
    )
    if (!implementation) {
      throw new ProviderPackSelectionError(
        'NO_PROVIDER_PACK',
        'Pack ' +
          input.selection.packId +
          '@' +
          input.selection.revision +
          ' does not implement ' +
          capability
      )
    }
    if (input.offeringId) {
      const declared = declaredOfferingsOf(pinned.manifest.revision)
      if (declared.length > 0 && !declared.includes(input.offeringId)) {
        throw new ProviderPackSelectionError(
          'OFFERING_UNSUPPORTED',
          'Pack ' + input.selection.packId + ' does not declare offering ' + input.offeringId,
          declared
        )
      }
    }
    return { packId: pinned.packId, revision: pinned.revision }
  }

  let candidates = capabilityProviders(registry, capability)
  if (input.offeringId) {
    const offeringId = input.offeringId
    const declaring = candidates.filter((candidate) =>
      candidate.declaredOfferings.includes(offeringId)
    )
    // Candidates that declare offerings are judged by them. A candidate that declares none
    // cannot be judged, so it only counts when no candidate declares any offering at all —
    // otherwise a Pack that says nothing would silently absorb an offering another Pack owns.
    const silent = candidates.filter((candidate) => candidate.declaredOfferings.length === 0)
    const judged = declaring.length > 0 ? declaring : silent
    if (judged.length === 0) {
      throw new ProviderPackSelectionError(
        'OFFERING_UNSUPPORTED',
        'no registered Pack revision declares offering ' + offeringId,
        candidates.map((candidate) => candidate.packId + '@' + candidate.revision)
      )
    }
    candidates = judged
  }
  const identities = [...new Set(candidates.map((candidate) => candidate.packId))]
  if (identities.length === 0) {
    throw new ProviderPackSelectionError(
      'NO_PROVIDER_PACK',
      'no registered Pack revision implements ' + capability
    )
  }
  if (identities.length > 1) {
    throw new ProviderPackSelectionError(
      'AMBIGUOUS_PROVIDER_PACK',
      'several Pack identities implement ' + capability + '; composition must pin one',
      identities
    )
  }
  const newest = candidates
    .filter((candidate) => candidate.packId === identities[0])
    .sort((left, right) => right.revision - left.revision)[0]
  return { packId: newest.packId, revision: newest.revision }
}

export interface LoadedProviderPack {
  packId: string
  revision: number
  contentDigest: string
  runnerProtocol: string
  entrypoint: string
  module: Record<string, unknown>
}

const MODULE_CACHE = new Map<string, Record<string, unknown>>()

/**
 * Load a Pack module from the digest-verified snapshot, never from the working tree: an
 * edited checkout cannot change the behavior of an already-registered revision. Cached
 * per (digest, capability).
 */
export async function loadProviderPackModule(
  registry: PackRegistry,
  capability: IntegrationCapability,
  selection: ProviderPackSelection
): Promise<LoadedProviderPack> {
  const revision = registry.resolve(selection.packId, selection.revision)
  const implementation = registry.implementation(selection.packId, selection.revision, capability)
  if (!implementation) {
    throw new AuthTransportError(
      'DRIVER_FAILED',
      'Pack ' + selection.packId + '@' + selection.revision + ' does not declare ' + capability
    )
  }
  if (implementation.support.state !== 'implemented' || !implementation.entrypoint) {
    throw new AuthTransportError(
      'DRIVER_FAILED',
      'Pack ' + selection.packId + ' does not implement ' + capability
    )
  }
  if (implementation.entrypoint.mode !== 'script') {
    throw new AuthTransportError(
      'DRIVER_FAILED',
      capability + ' must be implemented by a script entrypoint'
    )
  }
  const entrypoint = packEntrypoint(revision, implementation.entrypoint.resource)
  const key = revision.contentDigest + ':' + capability
  const cached = MODULE_CACHE.get(key)
  const module =
    cached ??
    ((await import(entrypoint).catch((error: unknown) => {
      throw new AuthTransportError(
        'DRIVER_FAILED',
        'cannot load ' + capability + ' implementation from the Pack snapshot',
        error instanceof Error ? error.message : String(error)
      )
    })) as Record<string, unknown>)
  if (!cached) MODULE_CACHE.set(key, module)
  return {
    packId: revision.packId,
    revision: revision.revision,
    contentDigest: revision.contentDigest,
    runnerProtocol: revision.manifest.revision.runnerProtocol,
    entrypoint,
    module
  }
}

/**
 * Read the Pack's declarative provider catalog (offering -> kind/locator/callback). The
 * Pack authors it, so the runtime knows which offerings have an existing credential file
 * without naming a vendor itself.
 */
export function providerCatalogFromPack(module: Record<string, unknown>): Record<string, unknown> {
  const catalog = module.PROVIDER_LOCATORS ?? module.PROVIDER_CATALOG ?? module.AUTH_OFFERINGS
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return {}
  return catalog as Record<string, unknown>
}

/**
 * Load the Pack's locator companion module. The Pack declares the resource in the auth
 * implementation's supportDetails ("locators"), so the runtime finds it without
 * hard-coding a filename; a Pack that exports the locator surface from its auth
 * entrypoint needs no companion at all.
 */
export async function loadProviderLocatorModule(
  registry: PackRegistry,
  selection: ProviderPackSelection
): Promise<Record<string, unknown>> {
  const loaded = await loadProviderPackModule(registry, AUTH_PACK_CAPABILITY, selection)
  const implementation = registry.implementation(
    selection.packId,
    selection.revision,
    AUTH_PACK_CAPABILITY
  )
  const declared = implementation?.supportDetails?.locators
  const resource = typeof declared === 'string' && declared.trim() ? declared : 'locators.mjs'
  if (
    typeof loaded.module.locatorCandidates === 'function' &&
    typeof loaded.module.readLocatorMaterial === 'function'
  ) {
    return loaded.module
  }
  const path = join(dirname(loaded.entrypoint), resource)
  try {
    return (await import(path)) as Record<string, unknown>
  } catch (error) {
    throw new AuthTransportError(
      'DRIVER_FAILED',
      'the providers Pack declares a locator module that cannot be loaded',
      error instanceof Error ? error.message : String(error)
    )
  }
}

/** The Pack's coordinator surface the driver delegates to. */
interface PackAuthCoordinator {
  start(input: {
    offeringId: string
    connectionId?: string
    callbackRedirect?: string
  }): Promise<AuthFlowView>
  submitCode(flowId: string, code: string): Promise<AuthFlowView>
  submitSecret(flowId: string, secret: string): Promise<AuthFlowView>
  poll(flowId: string): Promise<AuthFlowView>
  cancel(flowId: string, reason?: string): AuthFlowView
  status(flowId: string): AuthFlowView
  refresh(input: {
    credentialRef: string
    expectedMaterialRevision: number
    offeringId: string
    connectionId: string
  }): Promise<AuthFlowView>
  list?(): readonly AuthFlowView[]
  callbackSpec?(offeringId: string): AuthCallbackSpec | null
}

type CoordinatorFactory = new (options: {
  secretStore: ManagedSecretStore
  now?: () => number
}) => PackAuthCoordinator

export interface ProviderPackAuthDriverOptions {
  registry: PackRegistry
  secrets: ManagedSecretStore
  /**
   * Explicit pin: every offering resolves to this exact revision (the composition
   * MAHAS_AUTH_PACK_ID/REVISION override, or the way out of a genuinely ambiguous
   * offering). Without it each flow resolves the Pack that declares its offering.
   */
  selection?: ProviderPackSelection
  /** test seam: injected transport for Pack coordinators that accept one */
  fetch?: typeof globalThis.fetch
  now?: () => number
}

/**
 * Delegates to each Pack's own ProviderAuthCoordinator, constructed with the runtime's
 * secret store. The Pack keeps every provider endpoint and token shape; the runtime
 * keeps the material. One coordinator instance serves one Pack revision; flow ids are
 * routed back to the coordinator that owns them.
 */
export class ProviderPackAuthDriver implements ProviderAuthDriver {
  readonly #registry: PackRegistry
  readonly #secrets: ManagedSecretStore
  readonly #selection?: ProviderPackSelection
  readonly #fetch?: typeof globalThis.fetch
  readonly #now: () => number
  readonly #modules = new Map<string, LoadedProviderPack>()
  readonly #moduleErrors = new Map<string, unknown>()
  readonly #coordinators = new Map<string, PackAuthCoordinator>()
  readonly #pending = new Map<string, Promise<{ key: string; coordinator: PackAuthCoordinator }>>()
  readonly #flowOwners = new Map<string, string>()
  readonly #ambiguousFlows = new Set<string>()
  #loadedAll = false

  constructor(options: ProviderPackAuthDriverOptions) {
    this.#registry = options.registry
    this.#secrets = options.secrets
    this.#selection = options.selection
    this.#fetch = options.fetch
    this.#now = options.now ?? Date.now
  }

  /**
   * Preload every Pack revision this driver can route to: the pinned revision, or the
   * newest registered revision per auth-capable Pack identity. A Pack that fails to load
   * is remembered — its offerings fail explicitly at call time instead of taking the
   * whole auth domain down with it.
   */
  async load(): Promise<readonly LoadedProviderPack[]> {
    if (this.#loadedAll) return [...this.#modules.values()]
    this.#loadedAll = true
    const selections = this.#selection
      ? [resolveProviderPack(this.#registry, AUTH_PACK_CAPABILITY, { selection: this.#selection })]
      : newestPerPack(capabilityProviders(this.#registry, AUTH_PACK_CAPABILITY)).map(
          (provider) => ({ packId: provider.packId, revision: provider.revision })
        )
    for (const selection of selections) {
      await this.#loadOne(selection).catch(() => undefined)
    }
    return [...this.#modules.values()]
  }

  /** Every Pack module the driver has loaded, for diagnostics. */
  loaded(): readonly LoadedProviderPack[] {
    return [...this.#modules.values()]
  }

  #key(selection: ProviderPackSelection): string {
    return selection.packId + '@' + String(selection.revision)
  }

  #resolve(offeringId: string): ProviderPackSelection {
    return resolveProviderPack(this.#registry, AUTH_PACK_CAPABILITY, {
      ...(this.#selection ? { selection: this.#selection } : {}),
      offeringId
    })
  }

  async #loadOne(selection: ProviderPackSelection): Promise<LoadedProviderPack> {
    const key = this.#key(selection)
    const cached = this.#modules.get(key)
    if (cached) return cached
    const prior = this.#moduleErrors.get(key)
    if (prior) throw prior
    try {
      const loaded = await loadProviderPackModule(this.#registry, AUTH_PACK_CAPABILITY, selection)
      this.#modules.set(key, loaded)
      return loaded
    } catch (error) {
      this.#moduleErrors.set(key, error)
      throw error
    }
  }

  /** The coordinator serving this offering, resolved and constructed on first use. */
  async #coordinatorFor(offeringId: string): Promise<{ key: string; coordinator: PackAuthCoordinator }> {
    const selection = this.#resolve(offeringId)
    const key = this.#key(selection)
    const existing = this.#coordinators.get(key)
    if (existing) return { key, coordinator: existing }
    // Singleflight per Pack revision: two concurrent starts for the same Pack must not
    // construct two coordinators — the loser would be overwritten in the map while still
    // owning the first flow, stranding it.
    let pending = this.#pending.get(key)
    if (!pending) {
      pending = this.#loadOne(selection)
        .then((loaded) => {
          const raced = this.#coordinators.get(key)
          if (raced) return { key, coordinator: raced }
          const Factory = loaded.module.ProviderAuthCoordinator as CoordinatorFactory | undefined
          if (typeof Factory !== 'function') {
            throw new AuthTransportError(
              'DRIVER_FAILED',
              'Pack ' + selection.packId + ' must export ProviderAuthCoordinator for the dedicated auth channel'
            )
          }
          const coordinator = new Factory({
            secretStore: this.#secrets,
            ...(this.#fetch ? { fetch: this.#fetch } : {}),
            now: this.#now
          })
          this.#coordinators.set(key, coordinator)
          return { key, coordinator }
        })
        .finally(() => {
          if (this.#pending.get(key) === pending) this.#pending.delete(key)
        })
      this.#pending.set(key, pending)
    }
    return pending
  }

  #recordOwner(flowId: string, key: string): void {
    if (!flowId) return
    const existing = this.#flowOwners.get(flowId)
    if (existing !== undefined && existing !== key) {
      // Two Packs produced the same flow id. Refuse the NEW flow immediately — returning
      // it would let the service overwrite the intent/channel map entry the first flow
      // still owns. The first registration keeps the id; the colliding flow stays
      // unreachable inside its own coordinator.
      throw new AuthTransportError(
        'DRIVER_FAILED',
        'auth flow id ' + flowId + ' collides across Packs; the new flow is refused'
      )
    }
    if (this.#ambiguousFlows.has(flowId)) {
      throw new AuthTransportError(
        'DRIVER_FAILED',
        'auth flow ' + flowId + ' is claimed by several Packs'
      )
    }
    this.#flowOwners.set(flowId, key)
    // Bounded: a completed flow keeps its entry so late status/cancel calls still route,
    // but a long-lived daemon cannot grow the map without limit. An evicted owner is
    // recovered by the status scan below.
    if (this.#flowOwners.size > 5_000) {
      const oldest = this.#flowOwners.keys().next().value
      if (oldest !== undefined) {
        this.#flowOwners.delete(oldest)
        this.#ambiguousFlows.delete(oldest)
      }
    }
  }

  /**
   * The coordinator that owns this flow id. The owner map is authoritative; the scan is
   * the fallback for an evicted entry or a flow a coordinator created on its own — a
   * coordinator answers 'unknown' for a flow it does not own, so the first non-unknown
   * status adopts ownership.
   */
  #ownerOf(
    flowId: string
  ):
    | { kind: 'owned'; coordinator: PackAuthCoordinator }
    | { kind: 'ambiguous' }
    | { kind: 'missing' } {
    if (this.#ambiguousFlows.has(flowId)) return { kind: 'ambiguous' }
    const key = this.#flowOwners.get(flowId)
    if (key !== undefined) {
      const owned = this.#coordinators.get(key)
      if (owned) return { kind: 'owned', coordinator: owned }
    }
    const claimants: [string, PackAuthCoordinator][] = []
    for (const [candidateKey, coordinator] of this.#coordinators) {
      try {
        if (coordinator.status(flowId).state !== 'unknown') claimants.push([candidateKey, coordinator])
      } catch {
        // A coordinator that cannot answer status does not own the flow.
      }
    }
    if (claimants.length === 1) {
      this.#recordOwner(flowId, claimants[0][0])
      return { kind: 'owned', coordinator: claimants[0][1] }
    }
    // Several coordinators claim the id — as unsafe to dispatch as a recorded collision.
    if (claimants.length > 1) {
      this.#ambiguousFlows.add(flowId)
      return { kind: 'ambiguous' }
    }
    return { kind: 'missing' }
  }

  async start(input: {
    offeringId: string
    connectionId?: string
    callbackRedirect?: string
  }): Promise<AuthFlowView> {
    const { key, coordinator } = await this.#coordinatorFor(input.offeringId)
    const view = await coordinator.start(input)
    this.#recordOwner(view.flowId, key)
    return view
  }

  async submitCode(flowId: string, code: string): Promise<AuthFlowView> {
    const owner = this.#ownerOf(flowId)
    if (owner.kind === 'ambiguous')
      throw new AuthTransportError(
        'DRIVER_FAILED',
        'auth flow ' + flowId + ' is claimed by several Packs'
      )
    if (owner.kind === 'missing')
      throw new AuthTransportError('DRIVER_FAILED', 'unknown auth flow ' + flowId)
    return owner.coordinator.submitCode(flowId, code)
  }

  async submitSecret(flowId: string, secret: string): Promise<AuthFlowView> {
    const owner = this.#ownerOf(flowId)
    if (owner.kind === 'ambiguous')
      throw new AuthTransportError(
        'DRIVER_FAILED',
        'auth flow ' + flowId + ' is claimed by several Packs'
      )
    if (owner.kind === 'missing')
      throw new AuthTransportError('DRIVER_FAILED', 'unknown auth flow ' + flowId)
    return owner.coordinator.submitSecret(flowId, secret)
  }

  async poll(flowId: string): Promise<AuthFlowView> {
    const owner = this.#ownerOf(flowId)
    if (owner.kind === 'ambiguous')
      throw new AuthTransportError(
        'DRIVER_FAILED',
        'auth flow ' + flowId + ' is claimed by several Packs'
      )
    if (owner.kind === 'missing')
      throw new AuthTransportError('DRIVER_FAILED', 'unknown auth flow ' + flowId)
    return owner.coordinator.poll(flowId)
  }

  cancel(flowId: string, reason?: string): AuthFlowView {
    const owner = this.#ownerOf(flowId)
    if (owner.kind !== 'owned') return { flowId, state: 'unknown' }
    return owner.coordinator.cancel(flowId, reason)
  }

  status(flowId: string): AuthFlowView {
    const owner = this.#ownerOf(flowId)
    if (owner.kind !== 'owned') return { flowId, state: 'unknown' }
    return owner.coordinator.status(flowId)
  }

  async refresh(input: {
    credentialRef: string
    expectedMaterialRevision: number
    offeringId: string
    connectionId: string
  }): Promise<AuthFlowView> {
    const { key, coordinator } = await this.#coordinatorFor(input.offeringId)
    const view = await coordinator.refresh(input)
    this.#recordOwner(view.flowId, key)
    return view
  }

  list(): readonly AuthFlowView[] {
    const flows: AuthFlowView[] = []
    for (const coordinator of this.#coordinators.values()) {
      if (typeof coordinator.list !== 'function') continue
      flows.push(...coordinator.list())
    }
    return flows
  }

  /**
   * Loopback shape for this offering. The Pack answers when it can (it owns the
   * provider's registered redirect); otherwise the runtime's catalog entry is used.
   */
  callbackSpec(offeringId: string): AuthCallbackSpec | null {
    let selection: ProviderPackSelection
    try {
      selection = this.#resolve(offeringId)
    } catch {
      // The start() call that follows reports the resolution failure; the callback
      // question itself has no answer for an unroutable offering.
      return null
    }
    const coordinator = this.#coordinators.get(this.#key(selection))
    if (coordinator && typeof coordinator.callbackSpec === 'function') {
      return coordinator.callbackSpec(offeringId)
    }
    const loaded = this.#modules.get(this.#key(selection))
    if (!loaded) return null
    const entry = providerCatalogFromPack(loaded.module)[offeringId]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const spec = (entry as Record<string, unknown>).callback
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null
    const record = spec as Record<string, unknown>
    return {
      mode: record.mode === 'dynamic' ? 'dynamic' : 'provider-registered',
      path: typeof record.path === 'string' ? record.path : '/callback',
      ...(typeof record.host === 'string' ? { host: record.host } : {}),
      ...(typeof record.port === 'number' ? { port: record.port } : {}),
      ...(typeof record.redirect === 'string' ? { redirect: record.redirect } : {})
    }
  }
}
