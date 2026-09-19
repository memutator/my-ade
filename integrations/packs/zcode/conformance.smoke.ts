import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  collectionPayload,
  discoveryPayload,
  fixtureEnvelope,
  identifyPayload,
  registerFixturePack,
  runFixture,
  watermarkOf,
  type FixtureSource
} from '../../fixture-support.ts'
import type { PackRunResult } from '../../fixture-support.ts'

// Synthetic fixture only: temporary SQLite databases under the system temp
// directory. No real ZCode installation, database or credential is read.
const scratch = mkdtempSync(join(tmpdir(), 'mahas-zcode-pack-'))
const { registry, pack, close } = registerFixturePack(
  join(scratch, 'packs'),
  new URL('.', import.meta.url).pathname
)
try {
  const discoverSource = async (dataRoot: string, operationId: string): Promise<FixtureSource> => {
    const result = await runFixture(
      registry,
      fixtureEnvelope(
        pack,
        {
          installationId: 'fixture',
          configNamespace: join(scratch, 'config', 'zcode'),
          dataNamespace: dataRoot,
          capability: 'usage'
        },
        `${operationId}-discover`,
        { action: 'discover-sources' }
      )
    )
    assert.equal(result.status, 'success')
    const source = discoveryPayload(result).sources[0]
    assert.ok(source)
    return source
  }
  const collect = async (
    source: FixtureSource,
    cursor: Record<string, unknown>,
    operationId: string,
    maxRecords = 2
  ): Promise<PackRunResult> => {
    const result = await runFixture(
      registry,
      fixtureEnvelope(
        pack,
        {
          installationId: 'fixture',
          source,
          cursor,
          maxRecords,
          maxBytes: 1_000_000,
          deadlineAt: Date.now() + 10_000
        },
        operationId,
        { action: 'collect' }
      )
    )
    assert.equal(result.status === 'success' || result.status === 'partial', true)
    return result
  }

  const primaryRoot = join(scratch, 'primary', '.zcode')
  mkdirSync(join(primaryRoot, 'cli', 'db'), { recursive: true })
  const primaryDb = new DatabaseSync(join(primaryRoot, 'cli', 'db', 'db.sqlite'))
  primaryDb.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT);
    CREATE TABLE model_usage(id INTEGER PRIMARY KEY, session_id TEXT, input_tokens INTEGER,
      output_tokens INTEGER, cache_read_input_tokens INTEGER, reasoning_tokens INTEGER,
      model TEXT, provider TEXT, created_at INTEGER, kind TEXT);
    CREATE TABLE turn_usage(id INTEGER PRIMARY KEY, session_id TEXT, input_tokens INTEGER,
      output_tokens INTEGER, cache_read_input_tokens INTEGER, reasoning_tokens INTEGER);
  `)
  const insert = primaryDb.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?)')
  insert.run(
    1,
    's1',
    10,
    2,
    4,
    1,
    'observed-model',
    'observed-provider',
    1_700_000_000,
    'main_turn'
  )
  insert.run(2, 's1', 20, 5, null, null, null, null, null, 'subagent')
  insert.run(3, 's2', 30, 7, 8, 2, 'other-model', null, 1_700_000_010, 'compact')
  primaryDb
    .prepare('INSERT INTO turn_usage VALUES (1,?,?,?,?,?)')
    .run('wrong-fallback', 999, 999, 999, 999)
  const primarySource = await discoverSource(primaryRoot, 'primary')
  assert.equal(primarySource.locator.table, 'model_usage')
  assert.equal(typeof primarySource.locator.counterEpoch, 'string')
  const page1 = collectionPayload(await collect(primarySource, {}, 'primary-page-1'))
  assert.equal(page1.exhausted, false)
  assert.equal(page1.usageReadings[0]!.values.total, 12)
  assert.equal(page1.usageReadings[0]!.semantics.componentRelations[0]!.relation, 'includes')
  assert.equal(page1.usageAttributionHints[0]!.servedModel?.nativeName, 'observed-model')
  // The native provider string is preserved as evidence; a Pack cannot assert a
  // canonical Provider id, which only the catalog may define.
  assert.equal(page1.usageAttributionHints[0]!.providerId, undefined)
  assert.equal(
    page1.usageAttributionHints[0]!.evidence[0]!.data?.nativeProviderName,
    'observed-provider'
  )
  assert.equal(page1.usageAttributionHints.length, 1)
  assert.equal(page1.usageReadings[1]!.values.cacheReadInput, null)
  const page2 = collectionPayload(
    await collect(primarySource, page1.nextCursor ?? {}, 'primary-page-2')
  )
  assert.equal(page2.exhausted, true)
  assert.equal(watermarkOf(page2).keyspaceWrapped, true)

  primaryDb.prepare('UPDATE model_usage SET output_tokens=? WHERE id=?').run(9, 1)
  primaryDb.prepare('DELETE FROM model_usage WHERE id=?').run(2)
  const replay = collectionPayload(
    await collect(primarySource, page2.nextCursor ?? {}, 'primary-replay', 10)
  )
  assert.deepEqual(
    replay.usageReadings.map((row) => row.sessionNativeKey),
    ['s1', 's2']
  )
  assert.equal(replay.usageReadings[0]!.values.total, 19)
  assert.equal(watermarkOf(replay).streamRole, 'primary')
  assert.equal(watermarkOf(replay).deletionCoverage, 'complete-sweep-absence')
  const stable = collectionPayload(
    await collect(primarySource, replay.nextCursor ?? {}, 'primary-stable', 10)
  )
  assert.deepEqual(
    stable.usageReadings.map((row) => row.sourceRecordRevision),
    replay.usageReadings.map((row) => row.sourceRecordRevision)
  )
  primaryDb.close()

  // The fallback stream is used only when model_usage is absent, and coverage
  // says so instead of silently reporting an equivalent stream.
  const fallbackRoot = join(scratch, 'fallback', '.zcode')
  mkdirSync(join(fallbackRoot, 'cli', 'db'), { recursive: true })
  const fallbackDb = new DatabaseSync(join(fallbackRoot, 'cli', 'db', 'db.sqlite'))
  fallbackDb.exec(`CREATE TABLE turn_usage(id INTEGER PRIMARY KEY, session_id TEXT, input_tokens INTEGER,
    output_tokens INTEGER, cache_read_input_tokens INTEGER, reasoning_tokens INTEGER)`)
  fallbackDb
    .prepare('INSERT INTO turn_usage VALUES (1,?,?,?,?,?)')
    .run('fallback-session', 4, 2, 1, 0)
  const fallbackSource = await discoverSource(fallbackRoot, 'fallback')
  assert.equal(fallbackSource.locator.table, 'turn_usage')
  const fallback = collectionPayload(await collect(fallbackSource, {}, 'fallback-collect', 10))
  assert.equal(fallback.usageReadings[0]!.sessionNativeKey, 'fallback-session')
  assert.equal(watermarkOf(fallback).streamRole, 'fallback')
  assert.equal(fallback.diagnostics[0]!.code, 'usage.fallback-stream')
  fallbackDb.close()

  // A stale checkpoint against a changed stream fails closed instead of reusing
  // another stream's position.
  const stale = await runFixture(
    registry,
    fixtureEnvelope(
      pack,
      {
        installationId: 'fixture',
        source: { ...fallbackSource, locator: { ...fallbackSource.locator, table: 'model_usage' } },
        cursor: {},
        maxRecords: 10,
        maxBytes: 1_000_000,
        deadlineAt: Date.now() + 10_000
      },
      'stale-stream',
      { action: 'collect' }
    )
  )
  assert.equal(stale.status, 'failed')
  assert.equal(stale.diagnostics[0]!.code, 'collector.failed')

  // Both the config root and the data root arrive as candidates; the pack
  // reports one installation per database, under the enclosing config root.
  const identified = await runFixture(
    registry,
    fixtureEnvelope(
      pack,
      {
        machineId: 'fixture',
        candidateLocators: [primaryRoot, join(primaryRoot, 'cli', 'db'), fallbackRoot]
      },
      'identify',
      { capability: 'identify' }
    )
  )
  assert.equal(identified.status, 'success')
  const installations = identifyPayload(identified).installations
  assert.equal(installations.length, 2)
  assert.deepEqual(
    installations.map((row) => row.configNamespace).sort(),
    [primaryRoot, fallbackRoot].sort()
  )
  assert.deepEqual(
    installations.map((row) => row.dataNamespace).sort(),
    [primaryRoot, fallbackRoot].sort()
  )
} finally {
  close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log('zcode pack conformance: ok')
