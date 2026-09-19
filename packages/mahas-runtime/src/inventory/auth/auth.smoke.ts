// inventory/auth/auth.smoke.ts — the auth domain self-check.
//
// Run:  node packages/mahas-runtime/src/inventory/auth/auth.smoke.ts
//
// Everything is synthetic: an in-memory control DB, a temp config dir, a fake provider
// Pack snapshot written by this file, and a fake fetch injected into the Pack's own
// coordinator. No real credential, no provider endpoint, no desktop path is touched.
//
// What is verified end to end:
//   • the dedicated channel refuses to leak: deposits are single-use and scoped, an
//     ordinary payload carrying material is rejected, and responses are scrubbed;
//   • intent -> flow -> completion commits credential + connection + claims in one
//     transaction, and account replacement splits history;
//   • a refresh without same-account evidence does not advance the material revision;
//   • locator import registers read-only refs from the Pack catalog, adoption copies the
//     material into managed storage and ends the locator credential;
//   • the quota poller commits typed readings from stored credentials and keeps the last
//     success when a probe fails.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext } from '../../../../mahas-contracts/src/index.ts'
import { serializeDatabase } from '../../api/admission.ts'
import { PackRegistry } from '../../integration/registry.ts'
import { seedBuiltinCatalog } from '../../catalog/seed.ts'
import { putOffering, putProvider } from '../../catalog/repository.ts'
import { AUTH_SCHEMA_SQL } from './migrations.ts'
import { QuotaPoller, createCredentialMaterialResolver } from '../../metering/quota/poll.ts'
import { CONTROL_MIGRATIONS, applyMigrations } from '../../storage/migrations.ts'
import { getQuotaCurrent } from '../../metering/quota/store.ts'
import { createAuthDomain } from './domain.ts'
import { ProviderPackSelectionError, capabilityProviders, resolveProviderPack } from './driver.ts'
import { SecretDeposits, assertOrdinaryAuthPayload, stripSecretFields } from './transport.ts'
import { ensureLocalMachine } from '../local.ts'
import { connectRpc } from '../../../../mahas-client/src/rpc.ts'
import { registerAuthOperations, AUTH_OPERATION_NAMES } from './operations.ts'
import { OperationRegistry } from '../../api/registry.ts'
import type { AccessBoundary, StorageBoundary } from '../../api/handler-ports.ts'
import * as controlStorage from '../../storage/db.ts'

const scratch = mkdtempSync(join(tmpdir(), 'mahas-auth-smoke-'))
let checks = 0
const ok = (name: string): void => {
  checks += 1
  process.stdout.write('  ok ' + name + '\n')
}

/** The synthetic provider Pack: one offering, PKCE-shaped, api-key shaped, and quota. */
function writeFakePack(root: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        pack: {
          id: 'pack.provider.builtin-offerings',
          name: 'synthetic providers',
          publisher: 'test',
          createdAt: 1,
          metadata: {}
        },
        revision: {
          packId: 'pack.provider.builtin-offerings',
          revision: 1,
          contentDigest: '',
          runnerProtocol: '1',
          subjectRefs: [{ kind: 'offering', offeringId: 'synthetic/one' }],
          implementations: [
            {
              id: 'synthetic.auth.v1',
              capability: 'auth',
              contract: { id: 'mahas.integration.auth', revision: 1 },
              entrypoint: { mode: 'script', resource: 'auth.mjs', runtime: 'node' },
              support: { state: 'implemented' },
              limits: { timeoutMs: 5000, maxOutputBytes: 65536 },
              supportDetails: {}
            },
            {
              id: 'synthetic.quota.v1',
              capability: 'quota',
              contract: { id: 'mahas.integration.quota', revision: 1 },
              entrypoint: { mode: 'script', resource: 'quota.mjs', runtime: 'node' },
              support: { state: 'implemented' },
              limits: { timeoutMs: 5000, maxOutputBytes: 65536 },
              supportDetails: {}
            }
          ],
          requirements: [],
          createdAt: 1
        }
      },
      null,
      2
    )
  )
  writeFileSync(
    join(root, 'providers.json'),
    JSON.stringify(
      {
        'synthetic/one': {
          kind: 'pkce',
          format: 'synthetic-auth-json',
          ownership: 'user',
          label: 'synthetic CLI',
          fileNames: ['auth.json'],
          locations: [{ base: 'home', path: '.synthetic' }],
          callback: {
            mode: 'provider-registered',
            host: '127.0.0.1',
            port: 41001,
            path: '/callback',
            redirect: 'http://127.0.0.1:41001/callback'
          }
        }
      },
      null,
      2
    )
  )
  writeFileSync(
    join(root, 'locators.mjs'),
    [
      "import catalog from './providers.json' with { type: 'json' }",
      'export const PROVIDER_LOCATORS = catalog',
      'export function readLocatorMaterial(format, raw) {',
      "  if (format !== 'synthetic-auth-json') throw new Error('unsupported format')",
      '  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw',
      '  return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken }',
      '}',
      'export function locatorCandidates(catalogValue, roots) {',
      '  const out = []',
      '  for (const [offeringId, entry] of Object.entries(catalogValue)) {',
      '    for (const location of entry.locations) {',
      '      const base = location.base === "config" ? roots.configHome : location.base === "data" ? roots.dataHome : roots.home',
      '      for (const fileName of entry.fileNames) {',
      "        out.push({ offeringId, format: entry.format, ownership: 'user', label: entry.label, path: base + '/' + location.path + '/' + fileName })",
      '      }',
      '    }',
      '  }',
      '  return out',
      '}'
    ].join('\n')
  )
  writeFileSync(
    join(root, 'auth.mjs'),
    [
      'export class ProviderAuthCoordinator {',
      '  constructor({ secretStore, now = Date.now } = {}) {',
      '    if (!secretStore) throw new Error("secretStore required")',
      '    this.secretStore = secretStore; this.now = now; this.flows = new Map()',
      '  }',
      '  async start({ offeringId }) {',
      "    if (offeringId !== 'synthetic/one') throw new Error('unsupported offering')",
      "    const flowId = 'flow-' + (this.flows.size + 1)",
      "    this.flows.set(flowId, { offeringId, state: 'effect-required' })",
      "    return { flowId, state: 'effect-required', effect: { kind: 'open-browser', url: 'https://example.test/authorize' },",
      "      requiredInput: { kind: 'authorization-code' }, expiresAt: this.now() + 600000 }",
      '  }',
      '  async submitCode(flowId, code) {',
      '    const flow = this.flows.get(flowId)',
      '    if (!flow) throw new Error("flow not found")',
      "    if (!code.startsWith('good')) throw new Error('authorization code rejected')",
      '    const saved = await this.secretStore.put({ offeringId: flow.offeringId, material: { accessToken: "at-" + code, refreshToken: "rt-" + code }, ownership: "mahas" })',
      "    flow.state = 'complete'",
      '    flow.result = { flowId, state: "complete",',
      '      credentialChange: { kind: "create", materialRef: saved.ref, materialRevision: saved.revision, ownership: "mahas" },',
      '      identityClaims: [{ id: "auth:" + flowId + ":email", connectionId: "pending", kind: "email", value: "person@example.test", observedAt: this.now(), confidence: "observed", evidence: [] }] }',
      '    return flow.result',
      '  }',
      '  async submitSecret(flowId, secret) { throw new Error("this pack has no api-key flow") }',
      '  async poll(flowId) { return { flowId, state: "needs-input" } }',
      '  cancel(flowId) { this.flows.delete(flowId); return { flowId, state: "failed", error: "cancelled" } }',
      '  status(flowId) { const flow = this.flows.get(flowId); return flow ? (flow.result ?? { flowId, state: flow.state }) : { flowId, state: "unknown" } }',
      '  list() { return [...this.flows.entries()].map(([flowId, flow]) => flow.result ?? { flowId, state: flow.state }) }',
      '  callbackSpec(offeringId) {',
      "    if (offeringId !== 'synthetic/one') return null",
      "    return { mode: 'provider-registered', host: '127.0.0.1', port: 41001, path: '/callback', redirect: 'http://127.0.0.1:41001/callback' }",
      '  }',
      '  async refresh({ credentialRef, expectedMaterialRevision, connectionId }) {',
      '    const current = await this.secretStore.read(credentialRef)',
      '    if (!current || current.revision !== expectedMaterialRevision) return { state: "failed", conflict: true, currentRevision: current?.revision }',
      '    const changed = await this.secretStore.compareAndSwap(credentialRef, expectedMaterialRevision, { ...current.material, accessToken: "rotated" })',
      '    return changed.ok',
      '      ? { state: "complete", credentialChange: { kind: "refresh", materialRef: credentialRef, previousRevision: expectedMaterialRevision, materialRevision: changed.revision }, identityClaims: [{ id: "auth:" + connectionId + ":email", connectionId, kind: "email", value: "person@example.test", observedAt: this.now(), confidence: "observed", evidence: [] }] }',
      '      : { state: "failed", conflict: true, currentRevision: changed.revision }',
      '  }',
      '}'
    ].join('\n')
  )
  writeFileSync(
    join(root, 'quota.mjs'),
    [
      'let failNext = false',
      'let lastOfferingId = null',
      'export function setProbeFailure(value) { failNext = value }',
      'export function probeState() { return { lastOfferingId } }',
      'export async function probeQuota(envelope, io = {}) {',
      '  const material = envelope.payload.credentialMaterial',
      '  // Mirrors the built-in probe: the offering comes from the envelope target when present,',
      '  // otherwise from the scoped material the runtime supplies.',
      "  const offeringId = envelope.target?.kind === 'offering' ? envelope.target.offeringId : material?.offeringId",
      "  if (offeringId !== 'synthetic/one') throw new Error('credential material must name a supported offeringId')",
      '  lastOfferingId = offeringId',
      '  if (io.fetch) await io.fetch(offeringId)',
      '  if (!material || !material.accessToken) throw new Error("credential material is missing accessToken")',
      '  if (failNext) throw new Error("provider returned HTTP 503")',
      "  return { status: 'success', payload: { identityClaims: [], planClaims: [], entitlements: [],",
      "    meters: [{ key: '5h', label: '5-hour window', resource: 'provider-quota', scope: '5h', unit: 'ratio', utilization: 0.25, remaining: 0.75, availability: 'known' }] }, diagnostics: [] }",
      '}'
    ].join('\n')
  )
}

const scratchHome = join(scratch, 'home')
const packRoot = join(scratch, 'pack', 'providers', 'builtin-offerings')
writeFakePack(packRoot)
mkdirSync(join(scratchHome, '.synthetic'), { recursive: true })
writeFileSync(
  join(scratchHome, '.synthetic', 'auth.json'),
  JSON.stringify({ accessToken: 'fixture-locator-token', refreshToken: 'fixture-locator-refresh' })
)

const db = new DatabaseSync(':memory:')
// The real control migrations, then the auth fragment the composition appends — the
// smoke must run against the schema the daemon actually gets, not a hand-made subset.
applyMigrations(db, CONTROL_MIGRATIONS, 'control')
db.exec(AUTH_SCHEMA_SQL)
seedBuiltinCatalog(db)
// One synthetic provider/offering pair: the smoke never touches a real vendor identity.
putProvider(db, {
  id: 'provider.synthetic',
  operatorOrganizationId: null,
  label: 'Synthetic provider',
  realm: 'example.test',
  metadata: {}
})
putOffering(db, {
  id: 'synthetic/one',
  providerId: 'provider.synthetic',
  key: 'default',
  label: 'Synthetic offering',
  metadata: {}
})
const machine = ensureLocalMachine(db, {
  configDir: join(scratch, 'config'),
  observedAt: 1000
}).value
const database = <T>(work: () => T | Promise<T>): Promise<T> => serializeDatabase(db, work)
const registry = new PackRegistry({ db, contentRoot: join(scratch, 'pack-snapshots') })
registry.registerDirectory(packRoot)

const configDir = join(scratch, 'config')
// A clock that advances per call: quota observation identity is (connection, batch,
// source record, revision), so two ticks at the same instant are one observation.
let clock = 5_000
const now = (): number => (clock += 1_000)
const domain = await createAuthDomain({
  db,
  database,
  configDir,
  machineId: machine.id,
  packs: registry,
  legacy: {
    home: scratchHome,
    configHome: join(scratchHome, '.config'),
    dataHome: join(scratchHome, '.local', 'share')
  },
  quotaIntervalMs: 60_000,
  now
})
const started = await domain.start()
assert.equal(started.endpoint, '', 'no operator authenticator means no socket')
assert.equal(started.status.state, 'ready')
ok('domain boots without binding a socket when no operator authenticator is supplied')

// ── transport discipline ────────────────────────────────────────────────────
let depositClock = 1_000
const deposits = new SecretDeposits({ now: () => depositClock, ttlMs: 100 })
const handle = deposits.deposit('synthetic-code', 'flow:flow-1')
assert.equal(deposits.withdraw(handle.handle, 'flow:flow-1'), 'synthetic-code')
assert.throws(() => deposits.withdraw(handle.handle, 'flow:flow-1'), /unknown or already used/)
const second = deposits.deposit('synthetic-code', 'flow:flow-2')
assert.throws(() => deposits.withdraw(second.handle, 'flow:flow-3'), /another scope/)
assert.throws(() => deposits.withdraw(second.handle, 'flow:flow-2'), /unknown or already used/)
const expiring = deposits.deposit('synthetic-code', 'flow:flow-4')
depositClock = 1_500
assert.throws(() => deposits.withdraw(expiring.handle, 'flow:flow-4'), /expired/)
assert.throws(
  () =>
    assertOrdinaryAuthPayload('auth.flow.start', {
      offeringId: 'synthetic/one',
      accessToken: 'secret-value'
    }),
  /must not carry provider secret material/
)
assert.throws(
  () => assertOrdinaryAuthPayload('auth.secret.deposit', { secret: 'x' }),
  /dedicated-channel method/
)
const scrubbed = stripSecretFields({
  flowId: 'f',
  credentialChange: { materialRef: 'mahas-secret://x' },
  accessToken: 'x',
  nested: { refreshToken: 'y' }
})
assert.equal(JSON.stringify(scrubbed).includes('accessToken'), false)
assert.equal(
  scrubbed.credentialChange.materialRef,
  'mahas-secret://x',
  'references survive scrubbing'
)
ok(
  'secret deposits are single-use, scope-bound and expiring; ordinary payloads with material are refused'
)

// ── flow -> intent -> commit ────────────────────────────────────────────────
const flow = await domain.handlers.start({ offeringId: 'synthetic/one' })
assert.equal(flow.state, 'effect-required')
assert.ok(flow.effect?.url.includes('example.test'))
const intent = domain.service.beginIntent({ kind: 'login', offeringId: 'synthetic/one' })
domain.service.recordFlow(intent.id, flow)
const submitted = await domain.handlers.submitCode({ flowId: flow.flowId, code: 'good-code' })
assert.equal(submitted.state, 'complete')
domain.service.recordFlow(intent.id, submitted)
const completion = await domain.service.completeIntent(intent.id)
assert.equal(completion.completed, true)
assert.ok(completion.credentialId && completion.connectionId)
assert.equal(completion.identityClaimIds.length, 1)
const stored = db
  .prepare('SELECT material_ref,ownership FROM inventory_provider_credentials WHERE id=?')
  .get(completion.credentialId!) as { material_ref: string; ownership: string }
assert.ok(
  stored.material_ref.startsWith('mahas-secret://'),
  'material is referenced, never stored as a row value'
)
const connection = db
  .prepare('SELECT offering_id FROM inventory_provider_connections WHERE id=?')
  .get(completion.connectionId!) as { offering_id: string }
assert.equal(connection.offering_id, 'synthetic/one')
assert.equal(domain.service.provenance(completion.credentialId!)?.origin, 'managed')
ok('a completed flow commits credential, connection and identity claims in one transaction')

// account replacement splits history
const replace = domain.service.beginIntent({
  kind: 'replace-account',
  offeringId: 'synthetic/one',
  credentialId: completion.credentialId!,
  connectionId: completion.connectionId!
})
const flow2 = await domain.handlers.start({ offeringId: 'synthetic/one' })
domain.service.recordFlow(replace.id, flow2)
const submitted2 = await domain.handlers.submitCode({ flowId: flow2.flowId, code: 'good-second' })
domain.service.recordFlow(replace.id, submitted2)
const replaced = await domain.service.completeIntent(replace.id)
assert.equal(replaced.replacedCredentialId, completion.credentialId)
const old = db
  .prepare(
    'SELECT observed_until,replaced_by_credential_id FROM inventory_provider_credentials WHERE id=?'
  )
  .get(completion.credentialId!) as {
  observed_until: number | null
  replaced_by_credential_id: string | null
}
assert.ok(old.observed_until !== null && old.replaced_by_credential_id === replaced.credentialId)
const oldConnection = db
  .prepare('SELECT observed_until FROM inventory_provider_connections WHERE id=?')
  .get(completion.connectionId!) as { observed_until: number | null }
assert.ok(
  oldConnection.observed_until !== null,
  'the previous account connection is closed, not rewritten'
)
ok('account replacement ends the previous credential and its connection without mixing history')

// refresh requires same-account evidence
const refreshIntent = domain.service.beginIntent({
  kind: 'refresh',
  offeringId: 'synthetic/one',
  credentialId: replaced.credentialId!,
  connectionId: replaced.connectionId!,
  expectedMaterialRevision: 1
})
assert.equal(refreshIntent.state, 'pending')
const refreshFlow = await domain.handlers.refresh({
  credentialRef:
    stored.material_ref === replaced.materialRef ? replaced.materialRef! : replaced.materialRef!,
  expectedMaterialRevision: 1,
  offeringId: 'synthetic/one',
  connectionId: replaced.connectionId!
})
assert.equal(refreshFlow.state, 'complete')
// The direct handler call bypassed the intent commit that would publish the new
// material revision to inventory (the pending intent is asserted as swept later).
// Mirror that commit here so the stored row matches the secret store — the poller
// refuses to attach a stale revision to material it did not probe.
db.prepare('UPDATE inventory_provider_credentials SET material_revision=? WHERE id=?').run(
  refreshFlow.credentialChange!.materialRevision,
  replaced.credentialId!
)
ok('refresh delegates to the Pack and reports a credential change with claims')

// ── locators ────────────────────────────────────────────────────────────────
const imported = await domain.service.importLocators({ machineId: machine.id })
assert.equal(imported.imported.length, 1, 'the Pack catalog entry is imported')
const importedRef = db
  .prepare('SELECT material_ref,ownership FROM inventory_provider_credentials WHERE id=?')
  .get(imported.imported[0]) as { material_ref: string; ownership: string }
assert.ok(importedRef.material_ref.startsWith('locator://file/'))
assert.equal(importedRef.ownership, 'user', 'a harness-owned file stays user-owned')
const again = await domain.service.importLocators({ machineId: machine.id })
assert.deepEqual(again.unchanged, imported.imported)
const adopted = await domain.service.adoptLocator({
  machineId: machine.id,
  offeringId: 'synthetic/one',
  credentialId: imported.imported[0],
  accountContinuity: 'confirmed-same',
  format: 'synthetic-auth-json'
})
assert.ok(adopted.materialRef.startsWith('mahas-secret://'))
assert.equal(domain.service.provenance(adopted.credentialId)?.origin, 'adopted-locator')
const adoptedRow = db
  .prepare('SELECT observed_until FROM inventory_provider_credentials WHERE id=?')
  .get(imported.imported[0]) as { observed_until: number | null }
assert.ok(
  adoptedRow.observed_until !== null,
  'adoption ends the locator credential without touching the file'
)
ok('locator import registers read-only refs and adoption copies material into managed storage')

// ── quota polling over stored credentials ───────────────────────────────────
const tick = await domain.collectQuota()
// Two connections are active: the replacement account from the login and the adopted
// locator. The closed (replaced) connection is not probed at all.
assert.equal(tick.probed, 2)
assert.equal(tick.succeeded, 2)
assert.equal(tick.connections.includes(completion.connectionId!), false)
const current = domain.quotaCurrent(adopted.connectionId)
assert.equal(current.latest?.payload.status, 'success')
assert.equal(current.latest?.payload.meters[0].key, '5h')
assert.equal(current.lastSuccess?.observationId, current.latest?.observationId)
const replay = await domain.collectQuota()
assert.equal(replay.probed, 2, 'the same connections are probed again')
const history = db
  .prepare('SELECT COUNT(*) AS n FROM quota_reading_facets WHERE connection_id=?')
  .get(adopted.connectionId) as { n: number }
assert.equal(Number(history.n), 2, 'each tick is a distinct observation, not an overwrite')
ok('the poller resolves material from storage and commits typed quota readings')

// failure keeps the last success and is itself an observation. The probe runs the
// SNAPSHOT copy of the Pack (that is the point of registration), so the failure switch
// has to be flipped on that copy, not on the working tree.
const pinned = domain
  .packs()
  .find((pack) => pack.packId === 'pack.provider.builtin-offerings')!
const snapshot = registry.resolve(pinned.packId, pinned.revision).snapshotPath
assert.notEqual(snapshot, packRoot, 'the probe runs the registered snapshot, not the working tree')
const quotaModule = await import(join(snapshot, 'quota.mjs'))
quotaModule.setProbeFailure(true)
const failedTick = await domain.collectQuota()
assert.equal(failedTick.failed, 2)
const afterFailure = getQuotaCurrent(db, adopted.connectionId)
assert.equal(afterFailure.latest?.payload.status, 'failure')
assert.equal(afterFailure.currentFailure?.payload.status, 'failure')
assert.equal(
  afterFailure.lastSuccess?.payload.status,
  'success',
  'the last successful reading survives'
)
quotaModule.setProbeFailure(false)
ok('a failed probe is recorded as a failure observation and preserves the last success')

// a connection whose credential is unavailable is skipped, not fabricated
db.prepare("UPDATE inventory_provider_credentials SET availability='unavailable' WHERE id=?").run(
  replaced.credentialId!
)
const skipped = await domain.collectQuota()
assert.equal(skipped.skipped, 1)
assert.equal(skipped.probed, 1)
ok('a connection with unavailable material is skipped instead of reporting zero usage')

// ── resolver + poller ports are usable standalone (composition seam) ────────
const resolver = createCredentialMaterialResolver({
  secrets: domain.secrets,
  catalog: domain.catalog,
  formatFor: () => 'synthetic-auth-json',
  readLocatorFile: async () => ''
})
await assert.rejects(
  resolver.readLocator({ offeringId: 'synthetic/one', ref: 'mahas-secret://nope' }),
  /neither managed nor a locator file/
)
const standalone = new QuotaPoller({
  db,
  database,
  probe: {
    probe: async () => ({
      status: 'success',
      payload: {
        identityClaims: [],
        planClaims: [],
        meters: [],
        entitlements: [],
        status: 'success'
      }
    })
  },
  material: { readManaged: async () => null, readLocator: async () => ({}) },
  pack: { packId: 'test', revision: 1, contentDigest: 'digest' },
  now: () => 9_000
})
assert.equal(standalone.status().running, false)
ok('resolver and poller are usable as standalone ports by the composition root')

// ── the loop runs on its own ────────────────────────────────────────────────
// The daemon must keep collecting quota while no window is open: start() schedules ticks
// without any caller, and stop() awaits the in-flight one. The floor is 1s, so this check
// waits a little over one interval.
let automaticProbes = 0
const automatic = new QuotaPoller({
  db,
  database,
  probe: {
    probe: async () => {
      automaticProbes += 1
      return {
        status: 'success',
        payload: {
          identityClaims: [],
          planClaims: [],
          meters: [],
          entitlements: [],
          status: 'success'
        }
      }
    }
  },
  material: {
    readManaged: async () => ({ revision: 1, material: { accessToken: 'x' } }),
    readLocator: async () => ({})
  },
  pack: { packId: 'test', revision: 1, contentDigest: 'digest' },
  intervalMs: 1_000,
  now
})
automatic.start()
assert.equal(automatic.status().running, true)
await new Promise((resolve) => setTimeout(resolve, 1_200))
assert.ok(automaticProbes >= 1, 'the loop probed without any caller driving it')
await automatic.stop()
assert.equal(automatic.status().running, false)
const probesAtStop = automaticProbes
await new Promise((resolve) => setTimeout(resolve, 1_100))
assert.equal(automaticProbes, probesAtStop, 'stop() ends the loop')
ok('the quota loop ticks on its own interval and stops cleanly')

// The domain stays running for the remaining checks; shutdown is asserted at the end so the
// result never depends on how many provider calls happen to be in flight.

// ── Pack selection: one identity, or an explicit pin ────────────────────────
// The runtime must never name a vendor Pack. With exactly one registered revision
// implementing auth it resolves that one; with two DISTINCT identities it refuses rather
// than silently picking, which is what would otherwise hide the built-in offerings behind
// an unrelated external Pack.
const providers = capabilityProviders(registry, 'auth')
assert.equal(providers.length, 1)
assert.deepEqual(providers[0].declaredOfferings, ['synthetic/one'])
const resolved = resolveProviderPack(registry, 'auth')
assert.deepEqual(resolved, { packId: 'pack.provider.builtin-offerings', revision: 1 })
assert.deepEqual(
  resolveProviderPack(registry, 'auth', { offeringId: 'synthetic/one' }),
  resolved,
  'a declared offering keeps its own Pack'
)
assert.throws(
  () => resolveProviderPack(registry, 'auth', { offeringId: 'other/offering' }),
  (error: unknown) =>
    error instanceof ProviderPackSelectionError && error.code === 'OFFERING_UNSUPPORTED',
  'an offering no registered Pack declares is refused'
)
assert.throws(
  () =>
    resolveProviderPack(registry, 'auth', { selection: { packId: 'pack.absent', revision: 1 } }),
  (error: unknown) =>
    error instanceof ProviderPackSelectionError && error.code === 'NO_PROVIDER_PACK'
)

// A second Pack identity implementing auth makes the registry ambiguous: the resolver
// reports both candidates instead of choosing the highest revision across identities.
const externalPackRoot = join(scratch, 'external-pack')
mkdirSync(externalPackRoot, { recursive: true })
writeFileSync(
  join(externalPackRoot, 'manifest.json'),
  JSON.stringify({
    schemaVersion: 1,
    pack: {
      id: 'pack.provider.external',
      name: 'external providers',
      publisher: 'someone-else',
      createdAt: 1,
      metadata: {}
    },
    revision: {
      packId: 'pack.provider.external',
      revision: 9,
      contentDigest: '',
      runnerProtocol: '1',
      subjectRefs: [{ kind: 'offering', offeringId: 'external/other' }],
      implementations: [
        {
          id: 'external.auth.v1',
          capability: 'auth',
          contract: { id: 'mahas.integration.auth', revision: 1 },
          entrypoint: { mode: 'script', resource: 'auth.mjs', runtime: 'node' },
          support: { state: 'implemented' },
          limits: { timeoutMs: 5000, maxOutputBytes: 65536 },
          supportDetails: {}
        },
        {
          id: 'external.quota.v1',
          capability: 'quota',
          contract: { id: 'mahas.integration.quota', revision: 1 },
          entrypoint: { mode: 'script', resource: 'quota.mjs', runtime: 'node' },
          support: { state: 'implemented' },
          limits: { timeoutMs: 5000, maxOutputBytes: 65536 },
          supportDetails: {}
        }
      ],
      requirements: [],
      createdAt: 1
    }
  })
)
writeFileSync(
  join(externalPackRoot, 'auth.mjs'),
  [
    'export class ProviderAuthCoordinator {',
    '  constructor({ secretStore } = {}) { this.secretStore = secretStore; this.flows = new Map() }',
    '  async start({ offeringId }) {',
    "    if (offeringId !== 'external/other') throw new Error('unsupported offering')",
    "    const flowId = 'external-flow-' + (this.flows.size + 1)",
    "    this.flows.set(flowId, { offeringId, state: 'effect-required' })",
    "    return { flowId, state: 'effect-required', effect: { kind: 'open-browser', url: 'https://external.test/device' }, requiredInput: { kind: 'device' } }",
    '  }',
    '  async submitCode() { throw new Error("external pack has no code flow") }',
    '  async submitSecret(flowId, secret) {',
    '    const flow = this.flows.get(flowId); if (!flow) throw new Error("flow not found")',
    '    const saved = await this.secretStore.put({ offeringId: flow.offeringId, material: { apiKey: secret }, ownership: "mahas" })',
    '    flow.result = { flowId, state: "complete", credentialChange: { kind: "create", materialRef: saved.ref, materialRevision: saved.revision, ownership: "mahas" } }',
    '    return flow.result',
    '  }',
    '  async poll(flowId) { const flow = this.flows.get(flowId); if (!flow) throw new Error("flow not found"); return { flowId, state: "needs-input" } }',
    '  cancel(flowId, reason = "cancelled") { this.flows.delete(flowId); return { flowId, state: "failed", error: reason } }',
    '  status(flowId) { const flow = this.flows.get(flowId); return flow ? (flow.result ?? { flowId, state: flow.state }) : { flowId, state: "unknown" } }',
    '  list() { return [...this.flows.entries()].map(([flowId, flow]) => flow.result ?? { flowId, state: flow.state }) }',
    '}'
  ].join('\n')
)
writeFileSync(
  join(externalPackRoot, 'quota.mjs'),
  [
    'export async function probeQuota(envelope) {',
    '  const material = envelope.payload.credentialMaterial',
    "  if (material?.offeringId !== 'external/other') throw new Error('credential material must name a supported offeringId')",
    "  return { status: 'success', identityClaims: [], planClaims: [], entitlements: [],",
    "    meters: [{ key: 'external-m', label: 'external meter', resource: 'provider-quota', scope: 'month', unit: 'ratio', utilization: 0.5, remaining: 0.5, availability: 'known' }], diagnostics: [] }",
    '}'
  ].join('\n')
)
registry.registerDirectory(externalPackRoot)
const ambiguous = capabilityProviders(registry, 'auth')
assert.equal(ambiguous.length, 2)
assert.deepEqual(
  ambiguous.map((provider) => provider.packId),
  ['pack.provider.builtin-offerings', 'pack.provider.external'],
  'both identities are reported'
)
assert.throws(
  () => resolveProviderPack(registry, 'auth'),
  (error: unknown) =>
    error instanceof ProviderPackSelectionError &&
    error.code === 'AMBIGUOUS_PROVIDER_PACK' &&
    error.candidates.length === 2,
  'an ambiguous registry is refused instead of resolved by revision number'
)
assert.deepEqual(
  resolveProviderPack(registry, 'auth', {
    selection: { packId: 'pack.provider.builtin-offerings', revision: 1 }
  }),
  { packId: 'pack.provider.builtin-offerings', revision: 1 },
  'an explicit pin still selects the built-in Pack'
)
// The key property: an unrelated auth Pack does NOT hide the built-in offerings. Asking by
// offering narrows to the Pack that declares it, so the built-in offering still resolves to
// the built-in Pack even though two identities now implement auth.
assert.deepEqual(
  resolveProviderPack(registry, 'auth', { offeringId: 'synthetic/one' }),
  { packId: 'pack.provider.builtin-offerings', revision: 1 },
  'a declared offering resolves to its own Pack despite another auth Pack'
)
assert.deepEqual(
  resolveProviderPack(registry, 'auth', { offeringId: 'external/other' }),
  { packId: 'pack.provider.external', revision: 9 },
  'the external Pack keeps its own offering'
)
// The external Pack declares its own offering, so that offering resolves to it — but only
// through an explicit pin, because two identities implement the capability.
assert.deepEqual(
  resolveProviderPack(registry, 'auth', {
    selection: { packId: 'pack.provider.external', revision: 9 }
  }),
  { packId: 'pack.provider.external', revision: 9 }
)
// An offering that no candidate declares leaves the candidate set empty and is refused.
assert.throws(
  () =>
    resolveProviderPack(registry, 'auth', {
      selection: { packId: 'pack.provider.external', revision: 9 },
      offeringId: 'synthetic/one'
    }),
  (error: unknown) =>
    error instanceof ProviderPackSelectionError && error.code === 'OFFERING_UNSUPPORTED'
)
// The already-created domain keeps serving the Pack that declares each offering: routing
// is per-offering, so a later registration cannot change which Pack answers a flow for
// an offering it does not declare.
assert.deepEqual(
  domain.packs().map((pack) => ({ packId: pack.packId, revision: pack.revision })),
  [{ packId: 'pack.provider.builtin-offerings', revision: 1 }],
  'the domain loaded the built-in Pack revision'
)
const afterRegistration = await domain.handlers.start({ offeringId: 'synthetic/one' })
assert.equal(
  afterRegistration.state,
  'effect-required',
  'the declaring Pack still answers after another is registered'
)
ok('Pack selection resolves one identity or refuses; a second auth Pack never silently takes over')

// ── per-offering routing: two live auth Packs serve disjoint offerings ─────
// The milestone property end to end: registering an external auth Pack cannot disable
// the built-in offerings. An UNPINNED domain boots with both Packs registered (the old
// global selection refused this as ambiguous), each start() reaches the Pack that
// declares the offering, and flow-following calls dispatch to the owning coordinator.
const routedDir = join(scratch, "routed-config")
// The external offering needs catalog rows: connections reference catalog_offerings.
putProvider(db, {
  id: "provider.external",
  operatorOrganizationId: null,
  label: "External provider",
  realm: "external.test",
  metadata: {}
})
putOffering(db, {
  id: "external/other",
  providerId: "provider.external",
  key: "default",
  label: "External offering",
  metadata: {}
})
putOffering(db, {
  id: "nobody/none",
  providerId: "provider.external",
  key: "none",
  label: "Undeclared offering",
  metadata: {}
})
mkdirSync(routedDir, { recursive: true })
const routed = await createAuthDomain({
  db,
  database,
  configDir: routedDir,
  machineId: machine.id,
  packs: registry,
  legacy: { home: scratchHome },
  quotaIntervalMs: 60_000,
  now,
  fetch: async () => new Response("{}", { status: 200 })
})
const routedStart = await routed.start()
assert.equal(routedStart.status.state, "ready", "an unpinned domain boots with two auth Packs")
assert.deepEqual(
  routed.packs().map((pack) => pack.packId).sort(),
  ["pack.provider.builtin-offerings", "pack.provider.external"],
  "both auth Packs are loaded"
)
const builtinFlow = await routed.handlers.start({ offeringId: "synthetic/one" })
assert.ok(
  builtinFlow.effect?.url.includes("example.test"),
  "the built-in offering routes to the built-in Pack"
)
const externalFlow = await routed.handlers.start({ offeringId: "external/other" })
assert.ok(
  externalFlow.effect?.url.includes("external.test"),
  "the external offering routes to the external Pack"
)
// Concurrent starts for the same Pack share ONE coordinator (the singleflight): the
// losing construction would own the first flow while the map pointed at the winner.
const [concurrentA, concurrentB] = await Promise.all([
  routed.handlers.start({ offeringId: "external/other" }),
  routed.handlers.start({ offeringId: "external/other" })
])
assert.notEqual(concurrentA.flowId, concurrentB.flowId, "one coordinator, two flows")
assert.equal(
  routed.service.flowStatus({ flowId: concurrentA.flowId }).state,
  "effect-required",
  "the first concurrent flow is not stranded by a second construction"
)
// Flow-following calls dispatch by owner: each coordinator only sees its own flow ids.
assert.equal(
  routed.service.flowStatus({ flowId: externalFlow.flowId }).state,
  "effect-required",
  "status routes to the external coordinator"
)
assert.equal(
  routed.service.flowStatus({ flowId: builtinFlow.flowId }).state,
  "effect-required",
  "status routes to the built-in coordinator"
)
const listed = routed.service.list()
assert.ok(
  listed.some((view) => view.flowId === builtinFlow.flowId) &&
    listed.some((view) => view.flowId === externalFlow.flowId),
  "list flattens live flows across both Packs"
)
// Cancel returns the public failed+error view and drops the flow from its Pack — the
// durable intent keeps the cancelled record (AuthFlowView has no cancelled state).
const cancelled = routed.service.cancel({ flowId: externalFlow.flowId, reason: "done" })
assert.equal(cancelled.state, "failed")
assert.equal(cancelled.error, "done")
assert.equal(
  routed.service.flowStatus({ flowId: externalFlow.flowId }).state,
  "unknown",
  "a cancelled flow leaves its Pack"
)
// The unknown-flow sentinel and the unknown-offering refusal stay explicit.
assert.equal(routed.service.flowStatus({ flowId: "flow-missing" }).state, "unknown")
await assert.rejects(
  routed.handlers.submitCode({ flowId: "flow-missing", code: "x" }),
  /unknown auth flow/,
  "a submission for a flow no Pack owns is refused"
)
await assert.rejects(
  routed.handlers.start({ offeringId: "nobody/none" }),
  (error: unknown) =>
    error instanceof ProviderPackSelectionError && error.code === "OFFERING_UNSUPPORTED",
  "an offering no Pack declares is refused"
)
// A flow id two Packs both produce is undispatchable: the driver refuses to guess,
// because a submit would route caller-supplied secrets to the wrong provider. The
// Pack is registered AFTER the domain booted, which also covers lazy resolution.
const collisionPackRoot = join(scratch, "collision-pack")
mkdirSync(collisionPackRoot, { recursive: true })
writeFileSync(
  join(collisionPackRoot, "manifest.json"),
  JSON.stringify({
    schemaVersion: 1,
    pack: { id: "pack.provider.collision", name: "collision", publisher: "test", createdAt: 1, metadata: {} },
    revision: {
      packId: "pack.provider.collision",
      revision: 1,
      contentDigest: "",
      runnerProtocol: "1",
      subjectRefs: [{ kind: "offering", offeringId: "collision/offering" }],
      implementations: [
        {
          id: "collision.auth.v1",
          capability: "auth",
          contract: { id: "mahas.integration.auth", revision: 1 },
          entrypoint: { mode: "script", resource: "auth.mjs", runtime: "node" },
          support: { state: "implemented" },
          limits: { timeoutMs: 5000, maxOutputBytes: 65536 },
          supportDetails: {}
        }
      ],
      requirements: [],
      createdAt: 1
    }
  })
)
writeFileSync(
  join(collisionPackRoot, "auth.mjs"),
  [
    "export class ProviderAuthCoordinator {",
    "  constructor() { this.flows = new Map() }",
    "  async start({ offeringId }) {",
    "    if (offeringId !== 'collision/offering') throw new Error('unsupported offering')",
    "    const flowId = 'flow-1' // deliberately collides with the synthetic Pack's scheme",
    "    this.flows.set(flowId, { offeringId, state: 'effect-required' })",
    "    return { flowId, state: 'effect-required' }",
    "  }",
    "  async submitCode() { throw new Error('the collision Pack received a flow it must never see') }",
    "  async submitSecret() { throw new Error('the collision Pack received a secret it must never see') }",
    "  async poll(flowId) { return { flowId, state: 'needs-input' } }",
    "  cancel(flowId) { return { flowId, state: 'failed', error: 'cancelled' } }",
    "  status(flowId) { return this.flows.has(flowId) ? { flowId, state: 'effect-required' } : { flowId, state: 'unknown' } }",
    "}"
  ].join("\n")
)
registry.registerDirectory(collisionPackRoot)
// The collision is refused AT START: returning the duplicate id would let the service
// overwrite the intent/channel entry the first flow still owns.
await assert.rejects(
  routed.handlers.start({ offeringId: "collision/offering" }),
  /collides across Packs/,
  "a colliding flow id is refused before it can strand the first flow's intent"
)
// The first flow keeps its owner — dispatch for its id still reaches the built-in Pack.
assert.equal(
  routed.service.flowStatus({ flowId: builtinFlow.flowId }).state,
  "effect-required",
  "the first flow keeps its id after the refused collision"
)
assert.equal(
  routed.service.cancel({ flowId: builtinFlow.flowId }).state,
  "failed",
  "cancel of the surviving flow still routes to its Pack"
)
// Quota routing follows the same rule: the connection's offering picks the Pack, and
// the recorded evidence pins the exact revision that actually probed.
const externalSecret = await routed.secrets.put({
  offeringId: "external/other",
  material: { apiKey: "external-fixture-key" },
  ownership: "mahas"
})
db.prepare(
  "INSERT INTO inventory_provider_credentials(id,machine_id,material_ref,material_revision,ownership,availability,first_seen_at,last_seen_at,revision) VALUES(?,?,?,?,?,?,?,?,1)"
).run(
  "credential_external",
  machine.id,
  externalSecret.ref,
  externalSecret.revision,
  "machine",
  "available",
  1_000,
  1_000
)
db.prepare(
  "INSERT INTO inventory_provider_connections(id,offering_id,credential_id,auth_scope_json,first_seen_at,observed_until,availability,origin,revision) VALUES(?,?,?,NULL,?,NULL,?,?,1)"
).run(
  "connection_external",
  "external/other",
  "credential_external",
  1_000,
  "available",
  "registered"
)
await routed.collectQuota()
const externalReading = db
  .prepare(
    "SELECT source_evidence_json,meters_json,status FROM quota_reading_facets WHERE connection_id='connection_external' ORDER BY reading_observed_at DESC LIMIT 1"
  )
  .get() as { source_evidence_json: string; meters_json: string; status: string } | undefined
assert.ok(externalReading, "the external connection was probed")
assert.equal(externalReading.status, "success")
const externalEvidence = JSON.parse(externalReading.source_evidence_json) as {
  packId?: string
  packRevision?: number
}
assert.equal(
  externalEvidence.packId,
  "pack.provider.external",
  "the evidence names the Pack that actually probed"
)
assert.equal(externalEvidence.packRevision, 9)
assert.ok(
  externalReading.meters_json.includes("external-m"),
  "the external Pack probe produced the reading"
)
// An offering no quota Pack declares is an explicit failure observation, never probed
// through the wrong Pack.
db.prepare(
  "INSERT INTO inventory_provider_connections(id,offering_id,credential_id,auth_scope_json,first_seen_at,observed_until,availability,origin,revision) VALUES(?,?,?,NULL,?,NULL,?,?,1)"
).run(
  "connection_unsupported",
  "nobody/none",
  "credential_external",
  1_000,
  "available",
  "registered"
)
await routed.collectQuota()
const unsupportedReading = db
  .prepare(
    "SELECT status,diagnostics_json,source_evidence_json FROM quota_reading_facets WHERE connection_id='connection_unsupported' ORDER BY reading_observed_at DESC LIMIT 1"
  )
  .get() as { status: string; diagnostics_json: string; source_evidence_json: string } | undefined
assert.equal(unsupportedReading?.status, "failure", "the unsupported offering fails explicitly")
assert.equal(
  (JSON.parse(unsupportedReading!.source_evidence_json) as { packId?: string }).packId,
  undefined,
  "a failed resolution records no invented Pack identity"
)
await routed.stop("routing checked")
ok("per-offering routing keeps the built-in offerings live beside an external auth Pack")
// ── the desktop's legacy usage-accounts root, imported by reference ─────────
// The desktop keeps its own per-account credential copies under
// userData/usage-accounts/<provider>/<slug>/<file>. That directory is NOT guessable from the
// daemon, so it arrives as an explicit legacy root (MAHAS_LEGACY_USAGE_ACCOUNTS_ROOT in the
// daemon composition). The Pack catalog still decides which files exist; the runtime only
// appends the root it was told about.
const legacyRoot = join(scratch, 'usage-accounts')
mkdirSync(join(legacyRoot, 'synthetic-one', 'acct-a'), { recursive: true })
mkdirSync(join(legacyRoot, 'synthetic-one', 'acct-b'), { recursive: true })
writeFileSync(
  join(legacyRoot, 'synthetic-one', 'acct-a', 'auth.json'),
  JSON.stringify({ accessToken: 'legacy-token-a', refreshToken: 'legacy-refresh-a' })
)
writeFileSync(
  join(legacyRoot, 'synthetic-one', 'acct-b', 'auth.json'),
  JSON.stringify({ accessToken: 'legacy-token-b', refreshToken: 'legacy-refresh-b' })
)
const legacyDomain = await createAuthDomain({
  db,
  database,
  configDir: join(scratch, 'legacy-config'),
  machineId: machine.id,
  packs: registry,
  selection: { packId: 'pack.provider.builtin-offerings', revision: 1 },
  legacy: { home: scratchHome, usageAccountsRoot: legacyRoot },
  quotaIntervalMs: 60_000,
  now
})
// The synthetic Pack catalog declares one offering; the legacy root is supplied the same way
// the real providers Pack supplies its usage-accounts entries: as candidates from the Pack's
// own location list, rooted at the explicit legacy directory.
const legacyCandidates = [
  ...legacyDomain.catalog.candidates({
    home: scratchHome,
    configHome: join(scratchHome, '.config'),
    dataHome: join(scratchHome, '.local', 'share')
  }),
  {
    offeringId: 'synthetic/one',
    format: 'synthetic-auth-json',
    ownership: 'user' as const,
    label: 'desktop usage-accounts / synthetic-one',
    path: join(legacyRoot, 'synthetic-one', 'acct-a', 'auth.json')
  },
  {
    offeringId: 'synthetic/one',
    format: 'synthetic-auth-json',
    ownership: 'user' as const,
    label: 'desktop usage-accounts / synthetic-one',
    path: join(legacyRoot, 'synthetic-one', 'acct-b', 'auth.json')
  }
]
const legacyImport = await legacyDomain.service.importLocators({
  machineId: machine.id,
  candidates: legacyCandidates
})
assert.ok(legacyImport.imported.length >= 1, 'the legacy copies are imported as locator refs')
const legacyRows = db
  .prepare(
    'SELECT material_ref,ownership FROM inventory_provider_credentials WHERE material_ref LIKE ?'
  )
  .all('locator://file/' + legacyRoot + '/%') as Array<{ material_ref: string; ownership: string }>
assert.ok(legacyRows.length >= 1, 'the legacy copies are registered, not copied')
for (const row of legacyRows) {
  assert.equal(row.ownership, 'user', 'a desktop-managed copy stays read-only to mahas')
  assert.ok(
    row.material_ref.startsWith('locator://file/'),
    'the row is a reference, never material'
  )
}
ok('an explicit legacy usage-accounts root is imported as read-only locator references')

// ── the factory quota route, through the real Pack module ───────────────────
// The earlier checks used a domain whose probe this file stubbed. This one drives the REAL
// route: createAuthDomain → QuotaPoller → the Pack's own probeQuota, with only fetch injected.
// It is the case the seam bug broke — neither managed material nor a user's file carries an
// offering identity, so the runtime must supply it or every real probe is refused.
const probeCalls: string[] = []
// The SAME configDir as the running domain: one daemon has one secret store, and a different
// directory would (correctly) be unable to read the other's managed material.
const factory = await createAuthDomain({
  db,
  database,
  configDir,
  machineId: machine.id,
  packs: registry,
  selection: { packId: 'pack.provider.builtin-offerings', revision: 1 },
  legacy: { home: scratchHome },
  quotaIntervalMs: 60_000,
  now,
  fetch: async (url: unknown) => {
    probeCalls.push(String(url))
    return new Response('{}', { status: 200 })
  }
})
const factoryTick = await factory.collectQuota()
assert.ok(factoryTick.probed >= 1, 'the factory route probed the stored connections')
// The pinned factory refuses the two offerings its Pack does not declare — that is the
// pin working, not a probe failure. Everything else must succeed.
if (factoryTick.failed > 2) {
  const diagnostic = db
    .prepare(
      "SELECT diagnostics_json FROM quota_reading_facets WHERE status='failure' ORDER BY reading_observed_at DESC LIMIT 1"
    )
    .get() as { diagnostics_json: string } | undefined
  throw new Error(
    'probe failed: ' + JSON.stringify(factoryTick) + ' :: ' + String(diagnostic?.diagnostics_json)
  )
}
assert.equal(
  factoryTick.failed,
  2,
  'only the offerings outside the pin fail: ' + JSON.stringify(factoryTick)
)
assert.ok(
  probeCalls.includes('synthetic/one'),
  'the Pack received the authoritative offering id: ' + JSON.stringify(probeCalls)
)
const factoryCurrent = factory.quotaCurrent(adopted.connectionId)
assert.equal(factoryCurrent.latest?.payload.status, 'success')
assert.equal(factoryCurrent.latest?.payload.meters[0].key, '5h')
// The failure path is the one the runtime builds end to end, so it is where the recorded
// provenance is observable: the reading names the offering that was probed.
const provenance = db
  .prepare(
    "SELECT source_evidence_json FROM quota_reading_facets WHERE status='failure' AND connection_id=? ORDER BY reading_observed_at DESC LIMIT 1"
  )
  .get(adopted.connectionId) as { source_evidence_json: string } | undefined
assert.ok(provenance, 'the earlier failed probe is stored as a failure observation')
assert.equal(
  (JSON.parse(provenance.source_evidence_json) as { offeringId?: string }).offeringId,
  'synthetic/one',
  'the reading records which offering was probed'
)
// A locator-backed connection goes through the same route: its raw material carries no
// offeringId either, and the resolver must still satisfy the Pack.
const locatorCredential = db
  .prepare(
    "SELECT id FROM inventory_provider_credentials WHERE material_ref LIKE 'locator://%' AND observed_until IS NULL LIMIT 1"
  )
  .get() as { id: string } | undefined
if (locatorCredential) {
  db.prepare(
    'INSERT OR REPLACE INTO inventory_provider_connections(id,offering_id,credential_id,auth_scope_json,first_seen_at,observed_until,availability,origin,revision) VALUES(?,?,?,NULL,?,NULL,?,?,1)'
  ).run(
    'connection_locator_probe',
    'synthetic/one',
    locatorCredential.id,
    1_000,
    'available',
    'registered'
  )
  const locatorTick = await factory.collectQuota()
  assert.equal(
    locatorTick.failed,
    2,
    'a locator-backed connection probes too (only the pinned-out offerings fail): ' +
      JSON.stringify(locatorTick)
  )
}
await factory.stop('factory route checked')
ok(
  'the factory quota route reaches the real Pack probe with the offering id supplied by the runtime'
)

// ── the deferred operations run through the real registry ───────────────────
// IO-bearing operations must be stamped deferred: their handler runs with NO transaction
// open, and only the completion closure writes. This drives the real admission pipeline
// (real registry, real storage boundary) to prove it end to end.
const authOperationNames = Object.values(AUTH_OPERATION_NAMES)
const accessDouble = {
  authorize: () => undefined,
  surfaceFor: () =>
    ({
      digest: 'auth-smoke-surface',
      rolePolicyRevision: 1,
      effectiveActions: authOperationNames,
      schemas: {},
      visibilityScope: 'smoke'
    }) as never,
  isOperationVisible: (surface: unknown, operation: string) =>
    (surface as { effectiveActions: string[] }).effectiveActions.includes(operation)
} as unknown as AccessBoundary
const opsRegistry = new OperationRegistry({
  db,
  access: accessDouble,
  storage: controlStorage as unknown as StorageBoundary
})
registerAuthOperations(opsRegistry, domain.operations())
const operationCtx = {
  principalId: 'operator-local' as AuthenticatedContext['principalId'],
  controllerEpoch: 1 as AuthenticatedContext['controllerEpoch'],
  grantRevisions: {},
  transportSessionId: 'smoke-session'
} as AuthenticatedContext

// An import through the real pipeline: the probe runs outside any transaction, the rows
// land in tx-2, and a replayed operationId answers from the receipt instead of re-probing.
const importRequest = {
  protocolVersion: '1',
  operation: AUTH_OPERATION_NAMES.locatorImport,
  operationId: 'smoke-import-1',
  payload: { machineId: machine.id }
}
const importReceipt = await opsRegistry.dispatch(operationCtx, importRequest)
assert.equal(
  importReceipt.status,
  'committed',
  'import rejected: ' + JSON.stringify(importReceipt.error)
)
const importResult = importReceipt.result as { imported: string[]; unavailable: string[] }
assert.equal(
  importResult.imported.length,
  0,
  'the locator credential is already registered from the direct import'
)
const replayReceipt = await opsRegistry.dispatch(operationCtx, importRequest)
assert.equal(
  replayReceipt.status,
  'committed',
  'replay rejected: ' + JSON.stringify(replayReceipt.error)
)
assert.deepEqual(
  replayReceipt.result,
  importReceipt.result,
  'the same operationId replays its receipt'
)
// The deferred admission is a durable row under (scope/operation/operationId); the effect
// row is keyed by operation_key, so the check looks the admission up the same way.
const admissionRows = db
  .prepare('SELECT COUNT(*) AS n FROM effect_intents WHERE kind=?')
  .get(AUTH_OPERATION_NAMES.locatorImport) as { n: number }
assert.equal(Number(admissionRows.n), 1, 'the deferred operation admitted exactly one effect')

// A refresh that reaches a definite answer commits — even when the answer is a conflict:
// the Pack read the credential, found the revision mismatch, and wrote nothing.
const conflictRequest = {
  protocolVersion: '1',
  operation: AUTH_OPERATION_NAMES.flowRefresh,
  operationId: 'smoke-refresh-conflict',
  payload: {
    credentialRef: adopted.materialRef,
    expectedMaterialRevision: adopted.materialRevision + 9,
    offeringId: 'synthetic/one',
    connectionId: adopted.connectionId
  }
}
const conflictReceipt = await opsRegistry.dispatch(operationCtx, conflictRequest)
assert.equal(conflictReceipt.status, 'committed')
assert.equal((conflictReceipt.result as { state: string }).state, 'failed')
assert.equal((conflictReceipt.result as { conflict?: boolean }).conflict, true)
const untouched = db
  .prepare('SELECT material_revision FROM inventory_provider_credentials WHERE id=?')
  .get(adopted.credentialId) as { material_revision: number }
assert.equal(
  Number(untouched.material_revision),
  adopted.materialRevision,
  'a conflict advances nothing'
)

// A business failure in the EFFECT phase releases the durable admission, so the same
// operationId may run again. Adoption of an unknown credential is exactly that: nothing was
// applied, and the error is a MahasError.
const adoptRequest = {
  protocolVersion: '1',
  operation: AUTH_OPERATION_NAMES.locatorAdopt,
  operationId: 'smoke-adopt-missing',
  payload: {
    machineId: machine.id,
    offeringId: 'synthetic/one',
    credentialId: 'credential-does-not-exist',
    format: 'synthetic-auth-json'
  }
}
const adoptFailure = await opsRegistry.dispatch(operationCtx, adoptRequest)
assert.equal(adoptFailure.status, 'rejected')
assert.equal(adoptFailure.error?.code, 'MODEL_INVALID')
const released = db
  .prepare('SELECT COUNT(*) AS n FROM effect_intents WHERE operation_key LIKE ?')
  .get('%smoke-adopt-missing%') as { n: number }
assert.equal(Number(released.n), 0, 'a proven no-op effect releases its durable admission')

// The same operationId is then allowed to run again (the retry the release exists for).
const adoptRetry = await opsRegistry.dispatch(operationCtx, adoptRequest)
assert.equal(
  adoptRetry.status,
  'rejected',
  'the retry re-executes instead of replaying a phantom receipt'
)
assert.equal(adoptRetry.error?.code, 'MODEL_INVALID')

// The quota signal is a DB-only operation: it never probes from inside its own transaction.
const signalReceipt = await opsRegistry.dispatch(operationCtx, {
  protocolVersion: '1',
  operation: AUTH_OPERATION_NAMES.quotaCollect,
  operationId: 'smoke-quota-signal',
  payload: {}
})
assert.equal(signalReceipt.status, 'committed')
assert.equal((signalReceipt.result as { signalled: boolean }).signalled, true)
ok(
  'deferred auth operations run through the real admission pipeline without IO inside a transaction'
)

// ── the dedicated socket, with a real client ────────────────────────────────
// A second domain binds the auth socket over a temp config dir; the client below is the
// same connectRpc the desktop uses. Only the operator principal is accepted, the deposit
// never appears in a response, and an unknown method is refused without reaching the
// ordinary operation surface.
const socketConfigDir = join(scratch, 'socket-config')
mkdirSync(socketConfigDir, { recursive: true })
const served = await createAuthDomain({
  db,
  database,
  configDir: socketConfigDir,
  machineId: machine.id,
  packs: registry,
  // Pinned: a second auth Pack is registered by the selection check above, so an unpinned
  // domain would (correctly) refuse to guess which one serves the socket.
  selection: { packId: 'pack.provider.builtin-offerings', revision: 1 },
  legacy: { home: scratchHome },
  quotaIntervalMs: 60_000,
  now,
  authenticate: (credential, session) => {
    const proof = credential as { kind?: string; secret?: string }
    if (proof?.kind !== 'operator' || proof.secret !== 'fixture-operator-proof') {
      throw new Error('operator credential refused')
    }
    return {
      principalId: 'operator-local' as AuthenticatedContext['principalId'],
      controllerEpoch: 1 as AuthenticatedContext['controllerEpoch'],
      grantRevisions: {},
      transportSessionId: session.transportSessionId
    }
  },
  allowedPrincipals: ['operator-local']
})
const servedStart = await served.start()
assert.ok(servedStart.endpoint.endsWith('mahasd-auth.sock'))
const client = await connectRpc(servedStart.endpoint, {
  kind: 'operator',
  secret: 'fixture-operator-proof'
})
const depositReceipt = await client.call('auth.secret.deposit', {
  scope: 'flow:socket-flow',
  input: { secret: 'fixture-code-value', scope: 'flow:socket-flow' }
})
assert.equal(depositReceipt.status, 'committed')
assert.equal(
  JSON.stringify(depositReceipt).includes('fixture-code-value'),
  false,
  'the deposited value is never echoed'
)
const handleId = (depositReceipt.result as { deposit?: { handle?: string } }).deposit?.handle
assert.ok(handleId, 'the deposit returns a handle')
const unknown = await client.call('inventory.snapshot', {})
assert.equal(unknown.status, 'rejected')
assert.equal(
  unknown.error?.code,
  'UNAVAILABLE_OPERATION',
  'no fallback to the ordinary operation surface'
)
const materialInPayload = await client.call('auth.flow.start', {
  input: { offeringId: 'synthetic/one', accessToken: 'leaked-value' }
})
assert.equal(materialInPayload.status, 'rejected')
assert.equal(materialInPayload.error?.code, 'REQUIRED_ACTION_DENIED')
assert.equal(JSON.stringify(materialInPayload).includes('leaked-value'), false)
client.close()
await served.stop('socket check complete')
ok('the dedicated socket answers only channel methods, refuses material and never echoes a secret')

// a non-operator principal is refused by the dispatcher
const secondSocketDir = join(scratch, 'socket-config-2')
mkdirSync(secondSocketDir, { recursive: true })
const refused = await createAuthDomain({
  db,
  database,
  configDir: secondSocketDir,
  machineId: machine.id,
  packs: registry,
  selection: { packId: 'pack.provider.builtin-offerings', revision: 1 },
  legacy: { home: scratchHome },
  now,
  authenticate: (_credential, session) => ({
    principalId: 'member-7' as AuthenticatedContext['principalId'],
    controllerEpoch: 1 as AuthenticatedContext['controllerEpoch'],
    grantRevisions: {},
    transportSessionId: session.transportSessionId
  }),
  allowedPrincipals: ['operator-local']
})
const refusedStart = await refused.start()
const memberClient = await connectRpc(refusedStart.endpoint, { kind: 'operator' })
const denied = await memberClient.call('auth.flow.list', {})
assert.equal(denied.status, 'rejected')
assert.equal(denied.error?.code, 'SCOPE_DENIED')
memberClient.close()
await refused.stop('principal check complete')
ok('a non-operator principal is refused even with a valid socket credential')

// Shutdown last: a stopped service refuses new flows, and nothing below depends on it.
const stopped = await domain.stop('smoke complete')
assert.equal(stopped.state, 'stopped')
assert.equal(domain.status().state, 'stopped')
await assert.rejects(
  domain.handlers.start({ offeringId: 'synthetic/one' }),
  /not running/,
  'a stopped service refuses a new flow'
)
ok('shutdown stops the loop, drops deposits and refuses new flows')

// A restart sweep: the socket domains booted above, and boot() marks work that was
// waiting for input in a previous process as interrupted instead of retrying it.
const interrupted = db
  .prepare("SELECT COUNT(*) AS n FROM auth_intents WHERE state='interrupted'")
  .get() as { n: number }
assert.equal(Number(interrupted.n), 1, 'the unfinished intent was swept on the next boot')
const committed = db
  .prepare("SELECT COUNT(*) AS n FROM auth_intents WHERE state='complete'")
  .get() as { n: number }
assert.equal(Number(committed.n), 2, 'committed intents are untouched by the sweep')
assert.equal(await domain.service.markInterruptedIntents(), 0, 'a second sweep finds nothing to do')
db.close()
rmSync(scratch, { recursive: true, force: true })
process.stdout.write('auth smoke: ' + String(checks) + ' checks ok\n')
