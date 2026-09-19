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
  type FixtureSource
} from '../../fixture-support.ts'
import type { PackRunResult } from '../../fixture-support.ts'

// Synthetic fixture only: a temporary SQLite database under the system temp
// directory. No real Devin installation, database or credential is read.
const scratch = mkdtempSync(join(tmpdir(), 'mahas-devin-pack-'))
const { registry, pack, close } = registerFixturePack(
  join(scratch, 'packs'),
  new URL('.', import.meta.url).pathname
)
try {
  const dataRoot = join(scratch, 'data', 'devin')
  mkdirSync(join(dataRoot, 'cli'), { recursive: true })
  const native = new DatabaseSync(join(dataRoot, 'cli', 'sessions.db'))
  native.exec(
    'CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT, working_directory TEXT)'
  )
  native.exec(
    'CREATE TABLE message_nodes(id INTEGER PRIMARY KEY, session_id TEXT, chat_message TEXT)'
  )
  native
    .prepare('INSERT INTO sessions VALUES (?,?,?,?)')
    .run('s-1', null, 'Devin task', '/work/devin')
  native
    .prepare('INSERT INTO sessions VALUES (?,?,?,?)')
    .run('s-2', 's-1', 'child run', '/work/devin/sub')
  const node = native.prepare('INSERT INTO message_nodes VALUES (?,?,?)')
  const chat = (
    messageId: string | null,
    metrics: Record<string, number>,
    extra: Record<string, string> = {}
  ): string =>
    JSON.stringify({
      ...(messageId ? { message_id: messageId } : {}),
      metadata: { metrics, ...extra }
    })
  // Two rows for one message id (streaming/retry): the latest row is the
  // representative, so the first row's smaller output must not be counted.
  node.run(
    1,
    's-1',
    chat(
      'msg-1',
      { input_tokens: 100, output_tokens: 20, cache_read_tokens: 300, reasoning_tokens: 5 },
      { model: 'swe-1.5', provider: 'cognition' }
    )
  )
  node.run(
    2,
    's-1',
    chat('msg-1', {
      input_tokens: 100,
      output_tokens: 25,
      cache_read_tokens: 300,
      reasoning_tokens: 5
    })
  )
  node.run(
    3,
    's-2',
    chat(
      'msg-2',
      { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0 },
      { model: 'swe-1.5' }
    )
  )

  const discoverSource = async (
    capability: 'sessions' | 'usage',
    operationId: string
  ): Promise<FixtureSource> => {
    const result = await runFixture(
      registry,
      fixtureEnvelope(
        pack,
        {
          installationId: 'fixture',
          configNamespace: join(scratch, 'config', 'devin'),
          dataNamespace: dataRoot,
          capability
        },
        `${operationId}-discover`,
        { action: 'discover-sources', capability }
      )
    )
    assert.equal(result.status, 'success')
    const source = discoveryPayload(result).sources[0]
    assert.ok(source)
    return source
  }
  const collect = async (
    capability: 'sessions' | 'usage',
    source: FixtureSource,
    cursor: Record<string, unknown>,
    maxRecords: number,
    operationId: string
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
        { action: 'collect', capability }
      )
    )
    assert.equal(result.status === 'success' || result.status === 'partial', true)
    return result
  }

  const usageSource = await discoverSource('usage', 'usage')
  assert.equal(usageSource.locator.table, 'message_nodes')
  assert.equal(usageSource.locator.keyColumn, 'session_id+message_id')
  const u1 = collectionPayload(await collect('usage', usageSource, {}, 1, 'u1'))
  assert.equal(u1.usageReadings.length, 1)
  assert.equal(u1.usageReadings[0]!.values.outputTotal, 25)
  assert.equal(u1.usageReadings[0]!.values.cacheReadInput, 300)
  // cache read is additional to input on this source, so it enters the total.
  assert.equal(u1.usageReadings[0]!.values.total, 425)
  assert.equal(u1.usageReadings[0]!.semantics.componentRelations[0]!.relation, 'excludes')
  // The representative row for msg-1 is the latest one, which carries no model
  // metadata, so no attribution is invented for it.
  assert.equal(u1.usageAttributionHints.length, 0)
  const u2 = collectionPayload(await collect('usage', usageSource, u1.nextCursor ?? {}, 5, 'u2'))
  assert.equal(u2.exhausted, true)
  assert.deepEqual(
    u2.usageReadings.map((row) => row.sessionNativeKey),
    ['s-2']
  )
  assert.equal(u2.usageAttributionHints[0]!.servedModel?.nativeName, 'swe-1.5')

  // A row without a message id keeps its own row identity instead of being
  // merged into a neighbouring message.
  node.run(4, 's-2', chat(null, { input_tokens: 4, output_tokens: 1, cache_read_tokens: 2 }))
  const replay = collectionPayload(
    await collect('usage', usageSource, u2.nextCursor ?? {}, 10, 'u3')
  )
  assert.equal(replay.usageReadings.length, 3)
  assert.deepEqual(
    replay.usageReadings.map((row) => row.sourceEvidence.messageIdUnavailable === true),
    [false, false, true]
  )
  const stable = collectionPayload(
    await collect('usage', usageSource, replay.nextCursor ?? {}, 10, 'u4')
  )
  assert.deepEqual(
    stable.usageReadings.map((row) => [row.sourceRecordKey, row.sourceRecordRevision]),
    replay.usageReadings.map((row) => [row.sourceRecordKey, row.sourceRecordRevision])
  )

  const sessionsSource = await discoverSource('sessions', 'sessions')
  const s1 = collectionPayload(await collect('sessions', sessionsSource, {}, 1, 's1'))
  assert.equal(s1.sessions.length, 1)
  const s2 = collectionPayload(
    await collect('sessions', sessionsSource, s1.nextCursor ?? {}, 5, 's2')
  )
  assert.deepEqual(
    s2.sessions.map((row) => [row.nativeSessionKey, row.parentNativeSessionKey ?? null, row.title]),
    [['s-2', 's-1', 'child run']]
  )

  // Both the config root and the data root arrive as candidates; the pack
  // reports one installation for the single database it found.
  const identified = await runFixture(
    registry,
    fixtureEnvelope(
      pack,
      {
        machineId: 'fixture',
        candidateLocators: [dataRoot, join(dataRoot, 'cli'), join(scratch, 'data')]
      },
      'identify',
      { capability: 'identify' }
    )
  )
  assert.equal(identified.status, 'success')
  const installations = identifyPayload(identified).installations
  assert.equal(installations.length, 1)
  assert.equal(installations[0]!.configNamespace, dataRoot)
  assert.equal(installations[0]!.dataNamespace, dataRoot)
  native.close()
} finally {
  close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log('devin pack conformance: ok')
