import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectionPayload,
  discoveryPayload,
  fixtureEnvelope,
  identifyPayload,
  registerFixturePack,
  runFixture,
  type FixtureCollectionPayload
} from '../../fixture-support.ts'
import type { PackRunResult } from '../../fixture-support.ts'

// Synthetic fixture only: temporary project JSONL files under the system temp
// directory. No real Claude installation, session log or credential is read.
const scratch = mkdtempSync(join(tmpdir(), 'mahas-claude-pack-'))
const { registry, pack, close } = registerFixturePack(
  join(scratch, 'packs'),
  new URL('.', import.meta.url).pathname
)
try {
  const configRoot = join(scratch, 'config', '.claude')
  const dataRoot = join(configRoot, 'projects', '-work-demo')
  mkdirSync(dataRoot, { recursive: true })
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const transcript = join(dataRoot, `${sessionId}.jsonl`)
  writeFileSync(
    transcript,
    [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        sessionId,
        timestamp: '2026-02-02T10:00:00.000Z',
        message: { role: 'user', content: 'hi' }
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        sessionId,
        timestamp: '2026-02-02T10:00:02.000Z',
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-4-5',
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 5
          }
        }
      })
    ].join('\n') + '\n'
  )

  const discovered = await runFixture(
    registry,
    fixtureEnvelope(
      pack,
      {
        installationId: 'fixture',
        configNamespace: configRoot,
        dataNamespace: configRoot,
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
    cursor: Record<string, unknown>,
    operationId: string,
    capability: 'sessions' | 'usage' = 'usage'
  ): Promise<PackRunResult> =>
    runFixture(
      registry,
      fixtureEnvelope(
        pack,
        {
          installationId: 'fixture',
          source,
          cursor,
          maxRecords: 100,
          maxBytes: 1_000_000,
          deadlineAt: Date.now() + 10_000
        },
        operationId,
        { action: 'collect', capability }
      )
    )

  const first = collectionPayload(await collect({}, 'first'))
  const reading = first.usageReadings[0]!
  assert.equal(reading.sourceRecordKey, 'a1')
  assert.equal(reading.mode, 'delta')
  assert.equal(reading.values.inputTotal, 100)
  assert.equal(reading.values.outputTotal, 20)
  assert.equal(reading.values.cacheReadInput, 40)
  assert.equal(reading.values.cacheWriteInput, 5)
  // cache read/creation are contained in input, so the total is input + output.
  assert.equal(reading.values.total, 120)
  assert.equal(reading.semantics.componentRelations[0]!.relation, 'includes')
  assert.equal(reading.semantics.componentRelations[1]!.relation, 'includes')
  assert.equal(reading.semantics.componentRelations[2]!.relation, 'unknown')
  assert.equal(reading.timeCoverage.at, Date.parse('2026-02-02T10:00:02.000Z'))
  assert.equal(first.sessions[0]!.nativeSessionKey, sessionId)
  assert.equal(first.handles[0]!.resumeSupport, 'supported')
  assert.equal(first.usageAttributionHints[0]!.servedModel?.nativeName, 'claude-sonnet-4-5')

  // The byte checkpoint makes a retried batch a no-op.
  const replay = collectionPayload(await collect(first.nextCursor ?? {}, 'replay'))
  assert.equal(replay.usageReadings.length, 0)
  assert.equal(replay.exhausted, true)

  // Only new records are read on the next pass.
  appendFileSync(
    transcript,
    `${JSON.stringify({
      type: 'assistant',
      uuid: 'a2',
      sessionId,
      timestamp: '2026-02-02T10:05:00.000Z',
      message: {
        id: 'msg_2',
        model: 'claude-haiku-4-5',
        usage: { input_tokens: 7, output_tokens: 3 }
      }
    })}\n`
  )
  const incremental = collectionPayload(await collect(replay.nextCursor ?? {}, 'incremental'))
  assert.equal(incremental.usageReadings.length, 1)
  assert.equal(incremental.usageReadings[0]!.values.total, 10)
  assert.equal(incremental.usageReadings[0]!.values.cacheReadInput, null)
  assert.equal(incremental.usageAttributionHints[0]!.servedModel?.nativeName, 'claude-haiku-4-5')

  // An incomplete trailing record holds the checkpoint at the last confirmed
  // newline, then resumes when the record is completed.
  appendFileSync(
    transcript,
    `{"type":"assistant","uuid":"a3","sessionId":"${sessionId}","message":{"usage":{"input_tokens":5`
  )
  const partial = collectionPayload(await collect(incremental.nextCursor ?? {}, 'partial'))
  assert.equal(partial.coverage.completeness, 'partial')
  assert.deepEqual(partial.nextCursor, incremental.nextCursor)
  appendFileSync(transcript, ',"output_tokens":5,"cache_read_input_tokens":1}}}\n')
  const completed = collectionPayload(await collect(partial.nextCursor ?? {}, 'completed'))
  assert.equal(completed.usageReadings.length, 1)
  assert.equal(completed.usageReadings[0]!.values.total, 10)

  // A complete but unreadable record is a reported gap, not a wedged cursor.
  appendFileSync(transcript, '{not json}\n')
  const malformed = collectionPayload(await collect(completed.nextCursor ?? {}, 'malformed'))
  assert.equal(malformed.coverage.completeness, 'gap')
  assert.equal(malformed.coverage.gapReason, 'record.invalid-json')

  // Sessions mode reads the same source without emitting usage readings.
  const sessionsOnly: FixtureCollectionPayload = collectionPayload(
    await collect({}, 'sessions-only', 'sessions')
  )
  assert.equal(sessionsOnly.sessions.length, 1)
  assert.deepEqual(sessionsOnly.usageReadings, [])

  rmSync(transcript)
  const deleted = collectionPayload(await collect(malformed.nextCursor ?? {}, 'deleted'))
  assert.equal(deleted.coverage.gapReason, 'source.deleted')

  // Identify collapses the config root and the data root of one installation.
  const identified = await runFixture(
    registry,
    fixtureEnvelope(
      pack,
      { machineId: 'fixture', candidateLocators: [configRoot, join(configRoot, 'projects')] },
      'identify',
      { capability: 'identify' }
    )
  )
  assert.equal(identified.status, 'success')
  const installations = identifyPayload(identified).installations
  assert.equal(installations.length, 1)
  assert.equal(installations[0]!.configNamespace, configRoot)
  assert.equal(installations[0]!.dataNamespace, join(configRoot, 'projects'))
} finally {
  close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log('claude pack conformance: ok')
