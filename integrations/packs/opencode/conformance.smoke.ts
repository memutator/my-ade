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

// Synthetic fixture only: a temporary SQLite database in the system temp
// directory. No real OpenCode installation, database or credential is read.
const scratch = mkdtempSync(join(tmpdir(), 'mahas-opencode-pack-'))
const { registry, pack, close } = registerFixturePack(
  join(scratch, 'packs'),
  new URL('.', import.meta.url).pathname
)
try {
  const dataRoot = join(scratch, 'data', 'opencode')
  mkdirSync(dataRoot, { recursive: true })
  const native = new DatabaseSync(join(dataRoot, 'opencode.db'))
  native.exec(`CREATE TABLE session(
    id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT,
    tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
    tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost REAL
  )`)
  const insert = native.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?)')
  insert.run('a', null, 'one', '/one', 10, 2, 1, 4, 3, 0.1)
  insert.run('b', 'a', 'two', '/two', 20, 5, null, 6, null, null)
  insert.run('c', null, 'three', '/three', 30, 7, 2, 8, 4, 0.2)

  const discovered = await runFixture(
    registry,
    fixtureEnvelope(
      pack,
      {
        installationId: 'fixture',
        configNamespace: join(scratch, 'config', 'opencode'),
        dataNamespace: dataRoot,
        capability: 'usage'
      },
      'discover',
      { action: 'discover-sources' }
    )
  )
  assert.equal(discovered.status, 'success')
  const source = discoveryPayload(discovered).sources[0]!
  assert.ok(source)

  const collect = (
    sourceValue: FixtureSource,
    cursor: Record<string, unknown>,
    operationId: string,
    maxRecords = 2
  ): Promise<PackRunResult> =>
    runFixture(
      registry,
      fixtureEnvelope(
        pack,
        {
          installationId: 'fixture',
          source: sourceValue,
          cursor,
          maxRecords,
          maxBytes: 1_000_000,
          deadlineAt: Date.now() + 10_000
        },
        operationId,
        { action: 'collect' }
      )
    )

  const page1 = collectionPayload(await collect(source, {}, 'page-1'))
  assert.equal(page1.exhausted, false)
  assert.equal(page1.usageReadings[0]!.values.total, 17)
  assert.equal(page1.usageReadings[0]!.semantics.componentRelations[1]!.relation, 'unknown')
  assert.equal(page1.usageReadings[1]!.values.total, null)
  // The ledger resolves sessions from the same batch, so sessions accompany usage.
  assert.equal(page1.sessions.length, 2)
  const page2 = collectionPayload(await collect(source, page1.nextCursor ?? {}, 'page-2'))
  assert.equal(page2.exhausted, true)
  assert.equal(page2.usageReadings.length, 1)
  assert.equal(watermarkOf(page2).keyspaceWrapped, true)

  native.prepare('UPDATE session SET tokens_output=? WHERE id=?').run(9, 'a')
  native.prepare('DELETE FROM session WHERE id=?').run('b')
  const replay = collectionPayload(await collect(source, page2.nextCursor ?? {}, 'replay', 10))
  assert.equal(replay.usageReadings.length, 2)
  assert.equal(replay.usageReadings[0]!.values.total, 24)
  assert.deepEqual(
    replay.usageReadings.map((row) => row.sessionNativeKey),
    ['a', 'c']
  )
  assert.equal(watermarkOf(replay).deletionCoverage, 'complete-sweep-absence')
  const stable = collectionPayload(await collect(source, replay.nextCursor ?? {}, 'stable', 10))
  assert.deepEqual(
    stable.usageReadings.map((row) => [row.sourceRecordKey, row.sourceRecordRevision]),
    replay.usageReadings.map((row) => [row.sourceRecordKey, row.sourceRecordRevision])
  )

  // A schema change moves the generation (rediscovery) without opening a new
  // counter epoch, because the stored counters did not restart.
  const epochBefore = replay.usageReadings[0]!.counterEpoch
  native.exec('ALTER TABLE session ADD COLUMN updated_at INTEGER')
  const stale = await collect(source, {}, 'stale-generation')
  assert.equal(stale.status, 'failed')
  const rediscovered = await runFixture(
    registry,
    fixtureEnvelope(
      pack,
      {
        installationId: 'fixture',
        configNamespace: join(scratch, 'config', 'opencode'),
        dataNamespace: dataRoot,
        capability: 'usage'
      },
      'rediscover',
      { action: 'discover-sources' }
    )
  )
  const freshSource = discoveryPayload(rediscovered).sources[0]!
  assert.notEqual(freshSource.generation, source.generation)
  const afterAlter = collectionPayload(await collect(freshSource, {}, 'after-alter', 10))
  assert.equal(afterAlter.usageReadings[0]!.counterEpoch, epochBefore)

  // Both the data root and a parent candidate describe one installation.
  const identified = await runFixture(
    registry,
    fixtureEnvelope(
      pack,
      { machineId: 'fixture', candidateLocators: [dataRoot, join(scratch, 'data')] },
      'identify',
      { capability: 'identify' }
    )
  )
  assert.equal(identified.status, 'success')
  assert.equal(identifyPayload(identified).installations.length, 1)
  native.close()
} finally {
  close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log('opencode pack conformance: ok')
