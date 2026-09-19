// Seven-Pack acceptance smoke: registers every initial collector Pack through
// the real registry, resolves each manifest's declarative discovery roots the
// way the scheduler does, runs identify + discover-sources + collect through
// `runPack`, and commits one usage batch into the real collection/usage ledger.
//
// Everything here is synthetic: temporary directories, JSONL fixtures and
// SQLite fixtures under the system temp directory. No real installation,
// session log, database or credential is read, and no network call is made.
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { INTEGRATION_SCHEMA_SQL } from '../packages/mahas-runtime/src/integration/migration.ts'
import { registerCanonicalCollectorPacks } from '../packages/mahas-runtime/src/integration/index.ts'
import { PackRegistry } from '../packages/mahas-runtime/src/integration/registry.ts'
import { runPack } from '../packages/mahas-runtime/src/integration/runner.ts'
import { COLLECTION_SCHEMA_SQL } from '../packages/mahas-runtime/src/observation/collection/migrations.ts'
import { commitPackCollectionResult } from '../packages/mahas-runtime/src/observation/collection/commit.ts'
import { collectionCandidates } from '../packages/mahas-runtime/src/observation/collection/scheduler.ts'
import { INVENTORY_SCHEMA_SQL } from '../packages/mahas-runtime/src/inventory/migration.ts'
import { CATALOG_SCHEMA_SQL } from '../packages/mahas-runtime/src/catalog/migration.ts'
import { SESSION_SCHEMA_SQL } from '../packages/mahas-runtime/src/sessions/migrations.ts'
import { USAGE_SCHEMA_SQL } from '../packages/mahas-runtime/src/metering/usage/migrations.ts'
import { listUsageEntries } from '../packages/mahas-runtime/src/metering/usage/ledger.ts'
import type {
  CollectionBatch,
  CollectionSource
} from '../packages/mahas-contracts/src/metering/index.ts'
import type { PackCollectionResult } from '../packages/mahas-contracts/src/integration/index.ts'

const packsRoot = new URL('./packs', import.meta.url).pathname
const scratch = mkdtempSync(join(tmpdir(), 'mahas-all-packs-'))
const control = new DatabaseSync(':memory:')
control.exec('PRAGMA foreign_keys=ON')
// `observations` is owned by the core control migration, so the fixture
// declares the same minimal shape the collection commit writes through.
control.exec(`
CREATE TABLE executions (id TEXT PRIMARY KEY);
CREATE TABLE dispatches (id TEXT PRIMARY KEY);
CREATE TABLE observations (
  id TEXT PRIMARY KEY, execution_id TEXT, dispatch_id TEXT, source TEXT NOT NULL,
  fact_type TEXT NOT NULL, observed_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  identity_evidence_json TEXT NOT NULL CHECK(json_valid(identity_evidence_json))
);
`)
control.exec(CATALOG_SCHEMA_SQL)
control.exec(INVENTORY_SCHEMA_SQL)
control.exec(SESSION_SCHEMA_SQL)
control.exec(COLLECTION_SCHEMA_SQL)
control.exec(USAGE_SCHEMA_SQL)
control.exec(INTEGRATION_SCHEMA_SQL)

interface DiscoveryRoot {
  role: 'config' | 'data'
  base: 'home' | 'xdg-config-home' | 'xdg-data-home' | 'environment' | 'config'
  path: string
  variable?: string
}

interface DiscoveryMetadata {
  roots: DiscoveryRoot[]
  executableCandidates: string[]
  capabilities: string[]
}

/** The resolver the scheduler owns; this fixture mirrors it to prove the
 *  declarative metadata is resolvable without any vendor switch. */
function resolveRoots(
  discovery: DiscoveryMetadata,
  environment: {
    home: string
    xdgConfigHome: string
    xdgDataHome: string
    variables: Record<string, string>
  }
): { config: string | null; data: string | null; all: string[] } {
  const all: string[] = []
  let config: string | null = null
  let data: string | null = null
  for (const root of discovery.roots) {
    let base: string
    if (root.base === 'home') base = environment.home
    else if (root.base === 'xdg-config-home') base = environment.xdgConfigHome
    else if (root.base === 'xdg-data-home') base = environment.xdgDataHome
    else if (root.base === 'environment') base = environment.variables[root.variable ?? ''] ?? ''
    else base = config ?? environment.home
    if (!base) continue
    const resolved = root.path ? join(base, root.path) : base
    all.push(resolved)
    if (root.role === 'config' && !config) config = resolved
    if (root.role === 'data' && !data) data = resolved
  }
  return { config, data, all }
}

try {
  const registry = new PackRegistry({ db: control, contentRoot: join(scratch, 'snapshots') })
  const registered = registerCanonicalCollectorPacks(registry, packsRoot)
  // Other initial Packs (provider offerings, harness runtime) may also be
  // registered; this smoke owns the seven local collectors.
  const collectorPackIds = [
    'mahas.claude.files',
    'mahas.cline.files',
    'mahas.codex.files',
    'mahas.devin',
    'mahas.grok.files',
    'mahas.opencode',
    'mahas.zcode'
  ]
  const registeredIds = registered.map((revision) => revision.packId)
  for (const packId of collectorPackIds) {
    assert.ok(registeredIds.includes(packId), `${packId} registered`)
  }
  const collectors = registered.filter((revision) => collectorPackIds.includes(revision.packId))

  // Every manifest declares the same discovery shape, and it is resolvable
  // from a synthetic environment without touching the real home directory.
  const environment = {
    home: join(scratch, 'home'),
    xdgConfigHome: join(scratch, 'home', '.config'),
    xdgDataHome: join(scratch, 'home', '.local', 'share'),
    variables: { CLINE_DATA_DIR: join(scratch, 'home', '.config', '.cline', 'data') }
  }
  const resolved: Record<string, { config: string | null; data: string | null; all: string[] }> = {}
  for (const revision of collectors) {
    const discovery = (revision.manifest.pack.metadata as { discovery?: DiscoveryMetadata })
      .discovery
    assert.ok(discovery, `${revision.packId} declares discovery metadata`)
    assert.ok(discovery.roots.length > 0, `${revision.packId} declares at least one root`)
    for (const root of discovery.roots) {
      assert.ok(
        ['config', 'data'].includes(root.role),
        `${revision.packId} root role is declarative`
      )
      assert.ok(
        ['home', 'xdg-config-home', 'xdg-data-home', 'environment', 'config'].includes(root.base),
        `${revision.packId} root base is declarative`
      )
      if (root.base === 'environment')
        assert.ok(root.variable, `${revision.packId} environment root names a variable`)
    }
    assert.ok(discovery.capabilities.includes('usage'), `${revision.packId} declares usage`)
    resolved[revision.packId] = resolveRoots(discovery, environment)
  }
  // config-relative data roots only resolve against a config root, and the
  // environment-rooted Cline candidate keeps its own data root.
  assert.equal(resolved['mahas.codex.files']!.data, join(environment.home, '.codex', 'sessions'))
  assert.equal(resolved['mahas.opencode']!.data, join(environment.xdgDataHome, 'opencode'))
  assert.equal(
    resolved['mahas.cline.files']!.data,
    environment.variables['CLINE_DATA_DIR'] + '/sessions'
  )

  // Build one synthetic installation per Pack at its resolved data root.
  const install = (path: string): void => {
    mkdirSync(path, { recursive: true })
  }
  const codexRoot = resolved['mahas.codex.files']!.data!
  install(codexRoot)
  const codexSessionId = '11111111-2222-3333-4444-555555555555'
  const codexFile = join(codexRoot, `rollout-${codexSessionId}.jsonl`)
  writeFileSync(
    codexFile,
    `${JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T00:00:00.000Z', payload: { id: codexSessionId } })}\n`
  )
  appendFileSync(
    codexFile,
    `${JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01T00:00:05.000Z', payload: { type: 'token_count', model: 'gpt-5', info: { total_token_usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, cached_input_tokens: 6 } } } })}\n`
  )

  const claudeRoot = resolved['mahas.claude.files']!.data!
  install(claudeRoot)
  const claudeSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  writeFileSync(
    join(claudeRoot, `${claudeSessionId}.jsonl`),
    `${JSON.stringify({ type: 'assistant', uuid: 'a1', sessionId: claudeSessionId, timestamp: '2026-02-02T10:00:02.000Z', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 100, output_tokens: 20 } } })}\n`
  )

  const grokRoot = resolved['mahas.grok.files']!.data!
  install(join(grokRoot, 'sess-1'))
  writeFileSync(
    join(grokRoot, 'sess-1', 'usage.json'),
    JSON.stringify({
      sessionId: 'sess-1',
      session: { model: 'grok-4', inputTokens: 10, outputTokens: 5 }
    })
  )

  const clineRoot = resolved['mahas.cline.files']!.data!
  install(join(clineRoot, 'sess-cline-1'))
  writeFileSync(
    join(clineRoot, 'sess-cline-1', 'api_conversation_history.messages.json'),
    JSON.stringify({
      sessionId: 'sess-cline-1',
      messages: [{ id: 'm1', metrics: { inputTokens: 10, outputTokens: 2 } }]
    })
  )

  const opencodeRoot = resolved['mahas.opencode']!.data!
  install(opencodeRoot)
  const opencodeDb = new DatabaseSync(join(opencodeRoot, 'opencode.db'))
  opencodeDb.exec(
    'CREATE TABLE session(id TEXT PRIMARY KEY, tokens_input INTEGER, tokens_output INTEGER)'
  )
  opencodeDb.prepare('INSERT INTO session VALUES (?,?,?)').run('a', 10, 2)

  const zcodeRoot = resolved['mahas.zcode']!.data!
  install(join(zcodeRoot, 'cli', 'db'))
  const zcodeDb = new DatabaseSync(join(zcodeRoot, 'cli', 'db', 'db.sqlite'))
  zcodeDb.exec(
    'CREATE TABLE model_usage(id INTEGER PRIMARY KEY, session_id TEXT, input_tokens INTEGER, output_tokens INTEGER, created_at INTEGER)'
  )
  zcodeDb.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?)').run(1, 's1', 10, 2, 1_700_000_000)

  const devinRoot = resolved['mahas.devin']!.data!
  install(join(devinRoot, 'cli'))
  const devinDb = new DatabaseSync(join(devinRoot, 'cli', 'sessions.db'))
  devinDb.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY)')
  devinDb.exec(
    'CREATE TABLE message_nodes(id INTEGER PRIMARY KEY, session_id TEXT, chat_message TEXT)'
  )
  devinDb.prepare('INSERT INTO sessions VALUES (?)').run('s-1')
  devinDb.prepare('INSERT INTO message_nodes VALUES (?,?,?)').run(
    1,
    's-1',
    JSON.stringify({
      message_id: 'msg-1',
      metadata: { metrics: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 3 } }
    })
  )

  // Register the machine + installations the ledger commit requires.
  control
    .prepare(
      'INSERT INTO inventory_machines(id,label,first_seen_at,last_seen_at,metadata_json,revision) VALUES (?,?,?,?,?,?)'
    )
    .run('machine-1', 'fixture', 1, 1, '{}', 1)
  // The installation references the catalog harness, so the fixture declares
  // the harness rows the same way a seeded catalog would.
  const harnessIds = collectors
    .map((revision) => revision.manifest.revision.subjectRefs[0])
    .filter((subject) => subject?.kind === 'harness')
    .map((subject) => subject.harnessId)
  for (const harnessId of harnessIds) {
    control
      .prepare(
        'INSERT OR IGNORE INTO catalog_harnesses(id,publisher_organization_id,label,identity_metadata_json,revision) VALUES (?,?,?,?,?)'
      )
      .run(harnessId, null, harnessId, '{}', 1)
  }
  const installationIdFor = (harnessId: string, dataNamespace: string): string => {
    const id = `inst-${harnessId}`
    control
      .prepare(
        'INSERT INTO inventory_installations(id,machine_id,harness_id,config_namespace,data_namespace,first_seen_at,last_seen_at,presence,origin,revision) VALUES (?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        id,
        'machine-1',
        harnessId,
        dataNamespace,
        dataNamespace,
        1,
        1,
        'present',
        'discovered',
        1
      )
    return id
  }

  // One collect pass per Pack through the real runner, then one real ledger
  // commit for the Codex batch.
  const observed: Record<string, { readings: number; sessions: number; coverage: string }> = {}
  let committed: PackCollectionResult | null = null
  let committedSource: CollectionSource | null = null
  for (const revision of collectors) {
    const roots = resolved[revision.packId]!
    const candidates = collectionCandidates(revision.manifest.pack, { home: environment.home,
      configHome: environment.xdgConfigHome, dataHome: environment.xdgDataHome, environment: environment.variables })
    assert.deepEqual(candidates, [...new Set(roots.all)], `${revision.packId} uses production discovery roots`)
    const installationId = installationIdFor(
      revision.manifest.revision.subjectRefs[0]!.kind === 'harness'
        ? revision.manifest.revision.subjectRefs[0]!.harnessId
        : revision.packId,
      roots.data ?? ''
    )
    const pack = {
      packId: revision.packId,
      revision: revision.revision,
      contentDigest: revision.contentDigest
    }
    const identified = await runPack(registry, {
      protocolVersion: '1',
      operationId: `${revision.packId}-identify`,
      capability: 'identify',
      target: { kind: 'installation', installationId },
      contract: { id: 'mahas.integration.identify', revision: 1 },
      pack,
      payload: { machineId: 'machine-1', candidateLocators: candidates }
    })
    assert.equal(identified.status, 'success', `${revision.packId} identify`)
    const identifiedPayload = (
      identified as { payload?: { installations: { dataNamespace: string }[] } }
    ).payload
    assert.ok(identifiedPayload)
    // Candidate roots may include the config root and the data root of one
    // installation; the Pack must report the installation once.
    assert.equal(
      new Set(identifiedPayload.installations.map((row) => row.dataNamespace)).size,
      identifiedPayload.installations.length,
      `${revision.packId} identify reports no duplicate installation`
    )

    const discovered = await runPack(registry, {
      protocolVersion: '1',
      operationId: `${revision.packId}-discover`,
      action: 'discover-sources',
      capability: 'usage',
      target: { kind: 'installation', installationId },
      contract: { id: 'mahas.integration.usage', revision: 1 },
      pack,
      payload: {
        installationId,
        configNamespace: roots.config ?? '',
        dataNamespace: roots.data ?? '',
        capability: 'usage'
      }
    })
    assert.equal(discovered.status, 'success', `${revision.packId} discover-sources`)
    const sources = (discovered as { payload?: { sources: CollectionSource['locator'][] } })
      .payload!.sources
    assert.ok(sources.length > 0, `${revision.packId} discovered a source`)

    const collected = await runPack(registry, {
      protocolVersion: '1',
      operationId: `${revision.packId}-collect`,
      action: 'collect',
      capability: 'usage',
      target: { kind: 'installation', installationId },
      contract: { id: 'mahas.integration.usage', revision: 1 },
      pack,
      payload: {
        installationId,
        source: sources[0],
        cursor: {},
        maxRecords: 50,
        maxBytes: 1_000_000,
        deadlineAt: Date.now() + 10_000
      }
    })
    assert.ok(
      collected.status === 'success' || collected.status === 'partial',
      `${revision.packId} collect: ${JSON.stringify(collected.diagnostics)}`
    )
    const payload = (collected as { payload?: PackCollectionResult }).payload!
    assert.ok(payload.usageReadings.length > 0, `${revision.packId} emitted a usage reading`)
    // Every usage reading must be attributable to a session in the same batch,
    // because the ledger resolves session identity from the batch.
    const batchSessions = new Set(payload.sessions.map((row) => row.nativeSessionKey))
    for (const reading of payload.usageReadings) {
      assert.ok(
        reading.sessionNativeKey && batchSessions.has(reading.sessionNativeKey),
        `${revision.packId} reading ${reading.sourceRecordKey} carries its session`
      )
    }
    // Hints must not claim a catalog identity the Pack cannot know.
    for (const hint of payload.usageAttributionHints) {
      assert.equal(hint.providerId, undefined, `${revision.packId} does not assert a provider id`)
      assert.equal(hint.offeringId, undefined, `${revision.packId} does not assert an offering id`)
      assert.equal(
        hint.connectionId,
        undefined,
        `${revision.packId} does not assert a connection id`
      )
    }
    observed[revision.packId] = {
      readings: payload.usageReadings.length,
      sessions: payload.sessions.length,
      coverage: payload.coverage.completeness
    }
    if (revision.packId === 'mahas.codex.files') {
      committed = payload
      committedSource = {
        id: 'src-codex',
        machineId: 'machine-1',
        subject: { kind: 'installation', installationId },
        locator: sources[0],
        kind: 'file',
        sourceGeneration: (sources[0] as { generation: string }).generation,
        identityEvidence: { fixture: true },
        status: 'active',
        firstObservedAt: 1,
        lastObservedAt: 1
      }
    }
  }

  // The Codex batch must survive the strict ledger path: this is the contract
  // the scheduler depends on, not just the Pack schema.
  assert.ok(committed && committedSource)
  const envelope = {
    protocolVersion: '1',
    operationId: 'codex-collect',
    action: 'collect' as const,
    status: 'success' as const,
    payload: committed,
    diagnostics: [],
    startedAt: 1,
    completedAt: 2
  }
  const batch: CollectionBatch = {
    id: 'batch-codex-1',
    sourceId: committedSource.id,
    sourceGeneration: committedSource.sourceGeneration,
    adapterPackId: 'mahas.codex.files',
    adapterPackRevision: 1,
    integrationContractId: 'mahas.integration.usage',
    contractRevision: 1,
    cursorBefore: null,
    cursorAfter: null,
    startedAt: 1,
    committedAt: 2,
    result: 'committed',
    diagnostics: []
  }
  const result = commitPackCollectionResult(control, {
    result: envelope,
    source: committedSource,
    batch,
    expectedCheckpointRevision: null,
    installationId: 'inst-codex'
  })
  assert.equal(result.insertedObservations, committed.usageReadings.length)
  const entries = listUsageEntries(control)
  assert.equal(entries.length, committed.usageReadings.length)
  assert.equal(entries[0]!.normalizedTokens.total, 14)
  assert.equal(entries[0]!.normalizedTokens.cacheReadInput, 6)
  assert.equal(entries[0]!.accountingStatus, 'counted')
  // The first cumulative observation is an all-time baseline: its real usage
  // time is unknown, so it is not assigned to the collection time.
  assert.equal(entries[0]!.usageTime.kind, 'unknown')

  // Replaying the identical batch must not double count.
  const replay = commitPackCollectionResult(control, {
    result: envelope,
    source: committedSource,
    batch,
    expectedCheckpointRevision: null,
    installationId: 'inst-codex'
  })
  assert.equal(replay.replayed, true)
  assert.equal(listUsageEntries(control).length, entries.length)

  console.log('all-pack acceptance:', JSON.stringify(observed))
  console.log(`home=${homedir() ? 'present' : 'absent'} (never read by this fixture)`)
  opencodeDb.close()
  zcodeDb.close()
  devinDb.close()
} finally {
  control.close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log('all-pack acceptance smoke: ok')
