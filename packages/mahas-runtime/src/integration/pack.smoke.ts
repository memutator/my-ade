// integration/pack.smoke.ts — Pack registry / runner / conformance / operations
// self-check over synthetic Pack fixtures.
//
// Run:  node packages/mahas-runtime/src/integration/pack.smoke.ts
//
// Everything here is synthesized in a temp directory: manifests written by this
// file, a toy collector script, conformance fixtures. No real harness data, no
// provider API, no credentials. The last section drives the REAL
// OperationRegistry (real storage boundary, real control DB) so the
// outside-transaction admission path of `integration.pack.register` /
// `integration.capability.check` is exercised end to end.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext, CommandRequest } from '../../../mahas-contracts/src/index.ts'
import { OperationRegistry } from '../api/registry.ts'
import type { AccessBoundary, StorageBoundary } from '../api/handler-ports.ts'
import { serializeDatabase } from '../api/admission.ts'
import * as controlStorage from '../storage/db.ts'
import { openControlDb, withTx } from '../storage/db.ts'
import { evaluateCapabilityCheck, recordCapabilityCheck } from './conformance.ts'
import { createCanonicalContractRegistry } from './contracts.ts'
import { discoverPackRoots, registerCanonicalCollectorPacks } from './index.ts'
import { INTEGRATION_SCHEMA_SQL } from './migration.ts'
import { registerIntegrationOperations, INTEGRATION_OPERATION_NAMES } from './operations.ts'
import { PackRegistry, PackRegistryError } from './registry.ts'
import { runPack, type PackRunRequest } from './runner.ts'
import type { RegisteredPackRevision } from './types.ts'

const scratch = mkdtempSync(join(tmpdir(), 'mahas-pack-smoke-'))
let checks = 0
function ok(name: string): void {
  checks++
  process.stdout.write(`  ok ${name}\n`)
}

// ── fixture authoring ───────────────────────────────────────────────────────

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relative, body] of Object.entries(files)) {
    const target = join(root, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
  }
}

const COLLECTOR = `
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', async () => {
  const request = JSON.parse(input)
  const startedAt = Date.now()
  const operationId = String(request.operationId || '')
  if (operationId.startsWith('slow')) await new Promise((resolve) => setTimeout(resolve, 300))
  const common = {
    protocolVersion: request.protocolVersion,
    operationId: request.operationId,
    status: 'success',
    diagnostics: [],
    startedAt,
    completedAt: Date.now()
  }
  let out
  if (request.action === 'discover-sources') {
    out = { ...common, action: 'discover-sources', payload: { sources: [
      { sourceKey: 'fixture-source', kind: 'file', locator: { path: '/fixture' }, generation: 'fixture-gen-1', identityEvidence: {} }
    ] } }
    if (operationId.startsWith('lie-target')) out.target = { kind: 'installation', installationId: 'liar' }
  } else if (request.action === 'collect') {
    out = { ...common, action: 'collect', payload: {
      observations: [], sessions: [], handles: [], attachments: [], events: [],
      usageReadings: [], usageAttributionHints: [], quotaReadings: [],
      exhausted: true, coverage: { completeness: 'complete' }, diagnostics: []
    } }
  } else if (request.capability === 'identify') {
    out = {
      ...common,
      capability: request.capability,
      target: operationId.startsWith('lie-target') ? { kind: 'installation', installationId: 'liar' } : request.target,
      contract: request.contract,
      pack: request.pack,
      payload: operationId.startsWith('bad-payload') ? { installations: 'not-an-array' } : { installations: [] }
    }
  } else {
    out = { ...common, status: 'failed', diagnostics: [{ code: 'fixture.unsupported', severity: 'error', message: 'capability not implemented by the fixture' }] }
  }
  process.stdout.write(JSON.stringify(out))
})
`

function manifestFor(packId: string, revision: number, implementations: unknown[]): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      pack: {
        id: packId,
        name: `fixture ${packId}`,
        publisher: 'mahas.smoke',
        description: 'synthetic conformance fixture',
        createdAt: 1770000000000,
        metadata: { fixture: true }
      },
      revision: {
        packId,
        revision,
        contentDigest: '',
        runnerProtocol: '1',
        subjectRefs: [{ kind: 'harness', harnessId: 'fixture' }],
        implementations,
        requirements: [{ kind: 'platform', key: 'node', required: true }],
        createdAt: 1770000000000,
        releaseNotes: 'synthetic'
      }
    },
    null,
    2
  )
}

function scriptImplementation(capability: string, contractId: string): unknown {
  return {
    id: `${capability}.fixture.v1`,
    capability,
    contract: { id: contractId, revision: 1 },
    entrypoint: { mode: 'script', resource: 'collector.mjs', runtime: 'node' },
    support: { state: 'implemented' },
    limits: { timeoutMs: 5000, maxOutputBytes: 262144, maxBatchRecords: 10 },
    supportDetails: { fixture: true }
  }
}

function writeFixturePack(
  root: string,
  overrides: { packId?: string; extraFile?: string } = {}
): void {
  const packId = overrides.packId ?? 'mahas.fixture.alpha'
  writeFiles(root, {
    'manifest.json': manifestFor(packId, 1, [
      scriptImplementation('identify', 'mahas.integration.identify'),
      scriptImplementation('sessions', 'mahas.integration.sessions'),
      {
        id: 'events.fixture.v1',
        capability: 'events',
        contract: { id: 'mahas.integration.events', revision: 1 },
        support: { state: 'unsupported', reason: 'the fixture harness emits no events' },
        limits: { timeoutMs: 5000, maxOutputBytes: 262144 },
        supportDetails: { fixture: true }
      }
    ]),
    'collector.mjs': COLLECTOR,
    'fixtures/identify-accept.json': JSON.stringify({
      request: {
        protocolVersion: '1',
        operationId: 'case-accept',
        capability: 'identify',
        payload: { machineId: 'machine-fixture', candidateLocators: [] }
      },
      expectedPayload: { installations: [] }
    }),
    'fixtures/identify-reject.json': JSON.stringify({
      request: {
        protocolVersion: '1',
        operationId: 'case-reject',
        capability: 'identify',
        payload: { candidateLocators: [] }
      }
    }),
    'fixtures/identify-slow.json': JSON.stringify({
      request: {
        protocolVersion: '1',
        operationId: 'slow-case',
        capability: 'identify',
        payload: { machineId: 'machine-fixture', candidateLocators: [] }
      },
      expectedPayload: { installations: [] }
    }),
    ...(overrides.extraFile ? { 'notes.txt': overrides.extraFile } : {})
  })
}

function openPackDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(INTEGRATION_SCHEMA_SQL)
  return db
}

function envelope(
  revision: RegisteredPackRevision,
  request: Record<string, unknown>
): PackRunRequest {
  return {
    protocolVersion: '1',
    capability: 'identify',
    target: { kind: 'installation', installationId: 'fixture-installation' },
    contract: { id: 'mahas.integration.identify', revision: 1 },
    pack: {
      packId: revision.packId,
      revision: revision.revision,
      contentDigest: revision.contentDigest
    },
    ...request
  } as unknown as PackRunRequest
}

async function main(): Promise<void> {
  const packsRoot = join(scratch, 'packs')
  const contentRoot = join(scratch, 'snapshots')
  writeFixturePack(join(packsRoot, 'alpha'))

  // ── 1. registry: snapshot, dedupe, immutability, drift ────────────────────
  const registryDb = openPackDb()
  const registry = new PackRegistry({ db: registryDb, contentRoot })
  const alpha = registry.registerDirectory(join(packsRoot, 'alpha'))
  assert.equal(alpha.packId, 'mahas.fixture.alpha')
  assert.match(alpha.contentDigest, /^[0-9a-f]{64}$/)
  assert.equal(registry.list().length, 1)
  ok('registerDirectory snapshots a revision with a content digest')

  const again = registry.registerDirectory(join(packsRoot, 'alpha'))
  assert.equal(again.contentDigest, alpha.contentDigest)
  assert.equal(registry.list().length, 1)
  ok('re-registering identical content is idempotent')

  const changedRoot = join(packsRoot, 'alpha-changed')
  writeFixturePack(changedRoot, { extraFile: 'different bytes' })
  assert.throws(
    () => registry.registerDirectory(changedRoot),
    (error: unknown) => error instanceof PackRegistryError && error.code === 'IMMUTABLE_REVISION'
  )
  assert.equal(registry.list().length, 1)
  ok('a different payload for the same revision is IMMUTABLE_REVISION')

  const tampered = join(alpha.snapshotPath, 'collector.mjs')
  const original = readFileSync(tampered, 'utf8')
  writeFileSync(tampered, `${original}\n// tampered\n`)
  assert.throws(
    () => registry.resolve(alpha.packId, alpha.revision),
    (error: unknown) => error instanceof PackRegistryError && error.code === 'CONTENT_DRIFT'
  )
  writeFileSync(tampered, original)
  assert.equal(registry.resolve(alpha.packId, alpha.revision).contentDigest, alpha.contentDigest)
  ok('a tampered snapshot is CONTENT_DRIFT, and restoring it resolves again')

  assert.equal(
    registry.capabilityState(alpha.packId, alpha.revision, 'identify').check,
    'unchecked'
  )
  assert.equal(
    registry.capabilityState(alpha.packId, alpha.revision, 'usage').support,
    'undeclared'
  )
  ok('capability state starts unchecked / undeclared')

  assert.throws(
    () => registry.prepareRegistration(join(scratch, 'no-such-pack')),
    (error: unknown) => error instanceof PackRegistryError && error.code === 'INVALID_MANIFEST'
  )
  ok('an unreadable source directory is an INVALID_MANIFEST business failure')

  // ── 2. recursive built-in manifest discovery ──────────────────────────────
  const discoveryRoot = join(scratch, 'discovery')
  writeFixturePack(join(discoveryRoot, 'alpha'))
  writeFixturePack(join(discoveryRoot, 'providers', 'beta'), { packId: 'mahas.fixture.beta' })
  writeFixturePack(join(discoveryRoot, 'gamma'), { packId: 'mahas.fixture.gamma' })
  // a manifest INSIDE a pack root is pack content, not a pack of its own
  writeFiles(join(discoveryRoot, 'gamma', 'inner'), {
    'manifest.json': manifestFor('mahas.fixture.inner', 1, [])
  })
  const roots = discoverPackRoots(discoveryRoot).map((path) => path.slice(discoveryRoot.length + 1))
  assert.deepEqual(roots, ['alpha', 'gamma', 'providers/beta'])
  ok('discovery finds nested Pack roots and skips Pack content')

  const discoveryDb = openPackDb()
  const discoveryRegistry = new PackRegistry({
    db: discoveryDb,
    contentRoot: join(scratch, 'snapshots-2')
  })
  const discovered = registerCanonicalCollectorPacks(discoveryRegistry, discoveryRoot)
  assert.deepEqual(
    discovered.map((entry) => entry.packId),
    ['mahas.fixture.alpha', 'mahas.fixture.gamma', 'mahas.fixture.beta']
  )
  assert.equal(discoveryRegistry.list().length, 3)
  ok('registerCanonicalCollectorPacks registers every discovered Pack')
  discoveryDb.close()

  // ── 3. runner: action identity echo ───────────────────────────────────────
  const discovery = await runPack(
    registry,
    envelope(alpha, {
      action: 'discover-sources',
      operationId: 'case-discover',
      payload: {
        installationId: 'fixture-installation',
        configNamespace: join(scratch, 'config'),
        dataNamespace: join(scratch, 'data'),
        capability: 'identify'
      }
    })
  )
  assert.equal(discovery.status, 'success')
  assert.equal('action' in discovery ? discovery.action : null, 'discover-sources')
  assert.deepEqual('target' in discovery ? discovery.target : null, {
    kind: 'installation',
    installationId: 'fixture-installation'
  })
  assert.equal('pack' in discovery ? discovery.pack.contentDigest : null, alpha.contentDigest)
  assert.equal('capability' in discovery ? discovery.capability : null, 'identify')
  ok('an action result carries the pinned identity echo')

  const lying = await runPack(
    registry,
    envelope(alpha, {
      action: 'discover-sources',
      operationId: 'lie-target-case',
      payload: {
        installationId: 'fixture-installation',
        configNamespace: join(scratch, 'config'),
        dataNamespace: join(scratch, 'data'),
        capability: 'identify'
      }
    })
  )
  assert.equal(lying.status, 'failed')
  assert.match(lying.diagnostics[0]?.code ?? '', /pack\.invalid-result/)
  // even a failed invocation reports the PINNED identity, never the Pack's claim
  assert.deepEqual('target' in lying ? lying.target : null, {
    kind: 'installation',
    installationId: 'fixture-installation'
  })
  ok('a Pack that echoes a different target fails the invocation')

  const collect = await runPack(
    registry,
    envelope(alpha, {
      action: 'collect',
      operationId: 'case-collect',
      payload: {
        installationId: 'fixture-installation',
        source: {
          sourceKey: 's1',
          kind: 'file',
          locator: { path: '/x' },
          generation: 'g1',
          identityEvidence: {}
        },
        cursor: {},
        maxRecords: 5,
        maxBytes: 4096,
        deadlineAt: Date.now() + 5000
      }
    })
  )
  assert.equal(collect.status, 'success')
  assert.equal('action' in collect ? collect.action : null, 'collect')
  assert.equal(
    'payload' in collect ? (collect.payload as { exhausted?: boolean }).exhausted : null,
    true
  )
  ok('a collect result is schema-checked and identity-echoed')

  const badPayload = await runPack(
    registry,
    envelope(alpha, {
      operationId: 'bad-payload-case',
      payload: { machineId: 'machine-fixture', candidateLocators: [] }
    })
  )
  assert.equal(badPayload.status, 'failed')
  assert.match(badPayload.diagnostics[0]?.code ?? '', /pack\.invalid-result/)
  ok('a response payload outside the canonical schema fails the invocation')

  // ── 4. conformance ────────────────────────────────────────────────────────
  const contracts = createCanonicalContractRegistry()
  const identify = contracts.resolve('mahas.integration.identify', 1)
  assert.ok(identify)
  // the legacy spelling some early manifests use resolves to the same schemas
  const legacy = contracts.resolve('integration.identify', 1)
  assert.equal(legacy?.schemaDigest, identify.schemaDigest)
  assert.equal(legacy?.id, 'integration.identify')
  ok('canonical and legacy contract spellings resolve with identical schemas')

  const acceptCase = {
    id: 'identify-accept',
    fixtureRef: 'fixtures/identify-accept.json',
    expected: 'accept' as const,
    description: 'empty candidate list yields an empty installation list'
  }
  const withCases = { ...identify, conformanceCases: [acceptCase] }
  const pass = await evaluateCapabilityCheck(
    registry,
    alpha.packId,
    alpha.revision,
    'identify',
    withCases,
    { runCases: true }
  )
  assert.equal(pass.result, 'compatible')
  assert.equal(pass.semanticsVerified, true)
  assert.equal(pass.issueReason, null)
  const recorded = recordCapabilityCheck(registry, pass)
  assert.equal(
    registry.capabilityState(alpha.packId, alpha.revision, 'identify').check,
    'compatible'
  )
  assert.equal(
    registry.capabilityState(alpha.packId, alpha.revision, 'identify').semanticsVerified,
    true
  )
  assert.equal(
    (registryDb.prepare('SELECT COUNT(*) c FROM integration_checks').get() as { c: number }).c,
    1
  )
  assert.equal(recorded.issueId, undefined)
  ok('a matching contract with a passing fixture is compatible + semantics verified')

  const badSemantics = await evaluateCapabilityCheck(
    registry,
    alpha.packId,
    alpha.revision,
    'identify',
    {
      ...withCases,
      semanticsDigest: ''
    }
  )
  assert.equal(badSemantics.result, 'incompatible')
  const badSchema = await evaluateCapabilityCheck(
    registry,
    alpha.packId,
    alpha.revision,
    'identify',
    {
      ...withCases,
      schemaDigest: 'not-the-schema-digest'
    }
  )
  assert.equal(badSchema.result, 'incompatible')
  assert.equal(badSchema.issueReason, 'schema-violation')
  const issue = recordCapabilityCheck(registry, badSchema)
  assert.ok(issue.issueId)
  assert.equal(
    (
      registryDb.prepare("SELECT COUNT(*) c FROM integration_issues WHERE status='open'").get() as {
        c: number
      }
    ).c,
    1
  )
  assert.equal(
    registry.capabilityState(alpha.packId, alpha.revision, 'identify').check,
    'incompatible'
  )
  ok('a schema/semantics mismatch is incompatible and opens an issue')

  const unsupported = await evaluateCapabilityCheck(
    registry,
    alpha.packId,
    alpha.revision,
    'events',
    contracts.resolve('mahas.integration.events', 1)!
  )
  assert.equal(unsupported.result, 'compatible')
  assert.equal(unsupported.semanticsVerified, true)
  ok('an explicitly unsupported capability is compatible without invoking the Pack')

  const undeclared = await evaluateCapabilityCheck(
    registry,
    alpha.packId,
    alpha.revision,
    'usage',
    contracts.resolve('mahas.integration.usage', 1)!
  )
  assert.equal(undeclared.result, 'incompatible')
  assert.match(undeclared.diagnostics.map((d) => d.code).join(','), /conformance\.undeclared/)
  ok('an undeclared capability is incompatible')

  const rejectOnly = await evaluateCapabilityCheck(
    registry,
    alpha.packId,
    alpha.revision,
    'identify',
    {
      ...identify,
      conformanceCases: [
        {
          id: 'identify-reject',
          fixtureRef: 'fixtures/identify-reject.json',
          expected: 'reject' as const,
          description: 'missing machineId is rejected by the request schema'
        }
      ]
    },
    { runCases: true }
  )
  assert.equal(rejectOnly.result, 'compatible')
  assert.equal(rejectOnly.semanticsVerified, false)
  assert.match(
    rejectOnly.diagnostics.map((d) => d.code).join(','),
    /conformance\.semantics-unverified/
  )
  ok('a reject-only case set leaves semantics unverified')

  // ── 5. operations through admission (durable admit → effect → completion) ─
  const db = openControlDb(':memory:')
  // the operations own their registry on the CONTROL DB: Pack rows and the
  // operation receipt must land in the same database, committed together
  const controlPacks = new PackRegistry({
    db,
    contentRoot: join(scratch, 'snapshots-control')
  })
  const opContracts = createCanonicalContractRegistry({
    conformanceCases: {
      identify: [
        acceptCase,
        {
          id: 'identify-slow',
          fixtureRef: 'fixtures/identify-slow.json',
          expected: 'accept' as const,
          description: 'slow fixture that keeps the effect phase observably long'
        }
      ]
    }
  })
  const opsRegistry = new OperationRegistry({
    db,
    access: accessDouble(),
    storage: controlStorage as unknown as StorageBoundary
  })
  registerIntegrationOperations(opsRegistry, {
    packs: controlPacks,
    resolveContract: (id, revision) => opContracts.resolve(id, revision)
  })

  const ctx = context()
  const registerReceipt = await opsRegistry.dispatch(
    ctx,
    request(INTEGRATION_OPERATION_NAMES.packRegister, 'reg-1', {
      directory: join(packsRoot, 'alpha')
    })
  )
  assert.equal(registerReceipt.status, 'committed')
  assert.equal(
    (registerReceipt.result as { contentDigest: string }).contentDigest,
    alpha.contentDigest
  )
  assert.equal(
    (db.prepare('SELECT COUNT(*) c FROM integration_pack_revisions').get() as { c: number }).c,
    1
  )
  assert.equal(
    (
      db.prepare('SELECT COUNT(*) c FROM integration_capability_implementations').get() as {
        c: number
      }
    ).c,
    3
  )
  const registerEffect = db
    .prepare('SELECT state, receipt_json FROM effect_intents WHERE operation_key=?')
    .get(`principal-1/${INTEGRATION_OPERATION_NAMES.packRegister}/reg-1`) as
    { state: string; receipt_json: string } | undefined
  assert.equal(registerEffect?.state, 'confirmed')
  assert.equal(JSON.parse(String(registerEffect?.receipt_json)).status, 'committed')
  assert.equal(
    (db.prepare('SELECT COUNT(*) c FROM operation_receipts').get() as { c: number }).c,
    1
  )
  ok('integration.pack.register commits rows + receipt with a confirmed durable admission')

  const replay = await opsRegistry.dispatch(
    ctx,
    request(INTEGRATION_OPERATION_NAMES.packRegister, 'reg-1', {
      directory: join(packsRoot, 'alpha')
    })
  )
  assert.deepEqual(replay.result, registerReceipt.result)
  assert.equal((db.prepare('SELECT COUNT(*) c FROM effect_intents').get() as { c: number }).c, 1)
  ok('replaying the registration returns the stored receipt without a second effect')

  const checkPromise = opsRegistry.dispatch(
    ctx,
    request(INTEGRATION_OPERATION_NAMES.capabilityCheck, 'check-1', {
      packId: alpha.packId,
      revision: alpha.revision,
      capability: 'identify',
      contractId: 'mahas.integration.identify',
      contractRevision: 1,
      runCases: true
    })
  )
  // the fixture collector sleeps 300ms; the durable row state is the evidence
  // that the effect phase is running right now
  const running = await waitFor(
    () =>
      (
        db.prepare("SELECT COUNT(*) c FROM effect_intents WHERE state='attempting'").get() as {
          c: number
        }
      ).c === 1,
    10_000
  )
  assert.equal(running, true)
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) c FROM operation_receipts WHERE operation_id='check-1'")
        .get() as { c: number }
    ).c,
    0
  )
  ok('conformance is admitted durably before its effect starts, with no receipt yet')

  // no transaction and no serialization slot are held during the child run: an
  // independent writer can take the SQLite write lock right now
  let lockFree = false
  try {
    db.exec('BEGIN IMMEDIATE')
    db.exec('ROLLBACK')
    lockFree = true
  } catch {
    lockFree = false
  }
  assert.equal(lockFree, true)
  ok('the conformance child invocation runs with no transaction held')

  // a collector-style short commit (the scheduler's DB port) lands while the
  // child is still running: the effect holds neither the transaction nor the
  // connection slot, so the two do not interleave inside one BEGIN
  let collectorCommitted = false
  await serializeDatabase(db, () => {
    withTx(db, (tx) => {
      tx.prepare(
        'INSERT INTO domain_events(aggregate_id, aggregate_revision, event_type, scope_json, payload_json) ' +
          "VALUES ('collector-row', 1, 'CollectorRow', '{}', '{}')"
      ).run()
    })
    collectorCommitted = true
  })
  assert.equal(collectorCommitted, true)
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) c FROM domain_events WHERE aggregate_id='collector-row'")
        .get() as { c: number }
    ).c,
    1
  )
  ok('a concurrent collector commit lands while the effect is in flight')

  const checkReceipt = await checkPromise
  assert.equal(checkReceipt.status, 'committed')
  assert.equal((checkReceipt.result as { result: string }).result, 'compatible')
  assert.equal((checkReceipt.result as { semanticsVerified: boolean }).semanticsVerified, true)
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) c FROM operation_receipts WHERE operation_id='check-1'")
        .get() as { c: number }
    ).c,
    1
  )
  assert.equal(
    (
      db
        .prepare('SELECT state FROM effect_intents WHERE operation_key=?')
        .get(`principal-1/${INTEGRATION_OPERATION_NAMES.capabilityCheck}/check-1`) as {
        state: string
      }
    ).state,
    'confirmed'
  )
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) c FROM domain_events WHERE event_type='integration.capability.checked'"
        )
        .get() as { c: number }
    ).c,
    1
  )
  ok('conformance completion writes the check, the event and the receipt atomically')

  const invoke = await opsRegistry.dispatch(
    ctx,
    request(INTEGRATION_OPERATION_NAMES.capabilityInvoke, 'invoke-1', {
      request: envelope(alpha, {
        operationId: 'invoke-case',
        payload: { machineId: 'machine-fixture', candidateLocators: [] }
      })
    })
  )
  assert.equal(invoke.status, 'committed')
  assert.deepEqual((invoke.result as { payload: unknown }).payload, { installations: [] })
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) c FROM operation_receipts WHERE operation_id='invoke-1'")
        .get() as { c: number }
    ).c,
    0
  )
  ok('integration.capability.invoke returns Pack output without persisting a receipt')

  const missing = await opsRegistry.dispatch(
    ctx,
    request(INTEGRATION_OPERATION_NAMES.packRegister, 'reg-missing', {
      directory: join(scratch, 'does-not-exist')
    })
  )
  assert.equal(missing.status, 'rejected')
  assert.equal(missing.error?.code, 'MODEL_INVALID')
  assert.equal(
    (
      db
        .prepare('SELECT COUNT(*) c FROM effect_intents WHERE operation_key=?')
        .get(`principal-1/${INTEGRATION_OPERATION_NAMES.packRegister}/reg-missing`) as {
        c: number
      }
    ).c,
    0
  )
  ok('a failed registration releases its durable admission (no retry trap)')

  const unknownContract = await opsRegistry.dispatch(
    ctx,
    request(INTEGRATION_OPERATION_NAMES.capabilityCheck, 'check-unknown-contract', {
      packId: alpha.packId,
      revision: alpha.revision,
      capability: 'identify',
      contractId: 'mahas.integration.nope',
      contractRevision: 1
    })
  )
  assert.equal(unknownContract.status, 'rejected')
  assert.equal(unknownContract.error?.code, 'MODEL_INVALID')
  ok('an unregistered contract is rejected')

  const missingPack = await opsRegistry.dispatch(
    ctx,
    request(INTEGRATION_OPERATION_NAMES.capabilityCheck, 'check-missing-pack', {
      packId: 'mahas.fixture.absent',
      revision: 9,
      capability: 'identify',
      contractId: 'mahas.integration.identify',
      contractRevision: 1
    })
  )
  assert.equal(missingPack.status, 'rejected')
  assert.equal(missingPack.error?.code, 'IMPLEMENTATION_MISSING')
  ok('an unregistered Pack revision is IMPLEMENTATION_MISSING')

  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) c FROM effect_intents WHERE state IN ('prepared','attempting','unknown')"
        )
        .get() as {
        c: number
      }
    ).c,
    0
  )
  ok('every rejected admission left no pending durable effect behind')

  registryDb.close()
  db.close()
}

// ── helpers for the admission section ───────────────────────────────────────

function context(): AuthenticatedContext {
  return {
    principalId: 'principal-1' as AuthenticatedContext['principalId'],
    controllerEpoch: 1 as AuthenticatedContext['controllerEpoch'],
    grantRevisions: {},
    transportSessionId: 'session-fixture'
  }
}

function request(operation: string, operationId: string, payload: unknown): CommandRequest {
  return { protocolVersion: 'fixture/1', operation, operationId, payload }
}

function accessDouble(): AccessBoundary {
  return {
    authorize: () => undefined,
    surfaceFor: () =>
      ({
        digest: 'fixture-surface',
        rolePolicyRevision: 1,
        effectiveActions: [
          INTEGRATION_OPERATION_NAMES.packRegister,
          INTEGRATION_OPERATION_NAMES.packList,
          INTEGRATION_OPERATION_NAMES.capabilityState,
          INTEGRATION_OPERATION_NAMES.capabilityCheck,
          INTEGRATION_OPERATION_NAMES.capabilityInvoke
        ],
        schemas: {},
        visibilityScope: 'fixture'
      }) as never,
    isOperationVisible: (surface, operation) =>
      (surface as unknown as { effectiveActions: string[] }).effectiveActions.includes(operation)
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

void main()
  .then(() => {
    rmSync(scratch, { recursive: true, force: true })
    process.stdout.write(`\n${checks} checks passed\n`)
  })
  .catch((error: unknown) => {
    process.stdout.write(`FAILED: ${error instanceof Error ? error.stack : String(error)}\n`)
    rmSync(scratch, { recursive: true, force: true })
    process.exit(1)
  })
