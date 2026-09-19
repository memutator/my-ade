import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectionPayload,
  discoveryPayload,
  fixtureEnvelope,
  identifyPayload,
  payloadDiagnosticCodes,
  registerFixturePack,
  runFixture,
  watermarkOf
} from '../../fixture-support.ts'
import type { PackRunResult } from '../../fixture-support.ts'

// Synthetic fixture only: a temporary directory of rollout JSONL files. No real
// Codex installation, session log or credential is read.
const scratch = mkdtempSync(join(tmpdir(), 'mahas-codex-pack-'))
const { registry, pack, close } = registerFixturePack(
  join(scratch, 'packs'),
  new URL('.', import.meta.url).pathname
)
try {
  const configRoot = join(scratch, 'config', '.codex')
  const dataRoot = join(configRoot, 'sessions', '2026', '01')
  mkdirSync(dataRoot, { recursive: true })
  const sessionId = '11111111-2222-3333-4444-555555555555'
  const rollout = join(dataRoot, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`)
  writeFileSync(
    rollout,
    `${JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T00:00:00.000Z', payload: { id: sessionId, cwd: '/work' } })}\n`
  )
  appendFileSync(
    rollout,
    `${JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-01-01T00:00:05.000Z',
      payload: {
        type: 'token_count',
        model: 'gpt-5',
        info: {
          total_token_usage: {
            input_tokens: 10,
            output_tokens: 4,
            total_tokens: 14,
            cached_input_tokens: 6
          }
        }
      }
    })}\n`
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
  const sources = discoveryPayload(discovered).sources
  assert.equal(sources.length, 1)
  const source = sources[0]!
  assert.equal(source.locator.format, 'jsonl')

  const collect = (cursor: Record<string, unknown>, operationId: string): Promise<PackRunResult> =>
    runFixture(
      registry,
      fixtureEnvelope(
        pack,
        {
          installationId: 'fixture',
          source,
          cursor,
          maxRecords: 10,
          maxBytes: 1_000_000,
          deadlineAt: Date.now() + 10_000
        },
        operationId,
        { action: 'collect' }
      )
    )

  const page1 = await collect({}, 'page-1')
  assert.equal(page1.status, 'success')
  const payload1 = collectionPayload(page1)
  const reading = payload1.usageReadings[0]!
  assert.equal(reading.mode, 'cumulative')
  assert.equal(reading.values.inputTotal, 10)
  assert.equal(reading.values.cacheReadInput, 6)
  assert.equal(reading.values.total, 14)
  // Cache read is contained in input, so it never enters the total again.
  assert.equal(reading.semantics.componentRelations[0]!.relation, 'includes')
  assert.equal(reading.semantics.componentRelations[1]!.relation, 'unknown')
  assert.equal(typeof reading.counterScope, 'string')
  assert.equal(typeof reading.counterEpoch, 'string')
  assert.equal(payload1.sessions.length, 1)
  assert.equal(payload1.handles[0]!.resumeSupport, 'supported')

  // Re-reading the same confirmed range emits nothing: the checkpoint already
  // covers it, so a retried batch cannot double count.
  const replay = await collect(payload1.nextCursor ?? {}, 'replay')
  assert.equal(collectionPayload(replay).usageReadings.length, 0)
  assert.equal(collectionPayload(replay).exhausted, true)

  // A decreasing cumulative counter opens a new epoch; the reset record is the
  // new baseline instead of a negative delta.
  appendFileSync(
    rollout,
    `${JSON.stringify({
      type: 'event_msg',
      id: 'evt-reset',
      timestamp: '2026-01-01T00:01:05.000Z',
      payload: {
        type: 'token_count',
        model: 'gpt-5',
        info: {
          total_token_usage: {
            input_tokens: 3,
            output_tokens: 1,
            total_tokens: 4,
            cached_input_tokens: 0
          }
        }
      }
    })}\n`
  )
  const afterReset = await collect(collectionPayload(replay).nextCursor ?? {}, 'after-reset')
  const resetPayload = collectionPayload(afterReset)
  assert.equal(resetPayload.usageReadings.length, 1)
  assert.notEqual(resetPayload.usageReadings[0]!.counterEpoch, reading.counterEpoch)
  assert.equal(resetPayload.usageReadings[0]!.values.total, 4)
  assert.deepEqual(payloadDiagnosticCodes(resetPayload), ['counter.reset'])

  // An incomplete trailing record holds the cursor: the offset must not pass a
  // record whose terminating newline was never observed.
  appendFileSync(
    rollout,
    '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":99'
  )
  const partial = await collect(resetPayload.nextCursor ?? {}, 'partial')
  assert.equal(partial.status, 'partial')
  const partialPayload = collectionPayload(partial)
  assert.equal(partialPayload.coverage.completeness, 'partial')
  assert.deepEqual(partialPayload.nextCursor, resetPayload.nextCursor)
  appendFileSync(rollout, ',"output_tokens":1,"total_tokens":100}}}}\n')
  const completed = await collect(partialPayload.nextCursor ?? {}, 'completed')
  assert.equal(collectionPayload(completed).usageReadings[0]!.values.total, 100)

  // A complete but unreadable record is a gap while the cursor advances past
  // it, so one bad line cannot wedge collection.
  appendFileSync(rollout, '{not json}\n')
  const malformed = await collect(collectionPayload(completed).nextCursor ?? {}, 'malformed')
  const malformedPayload = collectionPayload(malformed)
  assert.equal(malformedPayload.coverage.completeness, 'gap')
  assert.equal(malformedPayload.coverage.gapReason, 'record.invalid-json')
  assert.deepEqual(watermarkOf(malformedPayload).strategy, 'append-only-byte-cursor')

  // Deleting the source updates coverage only; already collected usage stays.
  rmSync(rollout)
  const deleted = await collect(malformedPayload.nextCursor ?? {}, 'deleted')
  const deletedPayload = collectionPayload(deleted)
  assert.equal(deleted.status, 'partial')
  assert.equal(deletedPayload.coverage.completeness, 'gap')
  assert.equal(deletedPayload.coverage.gapReason, 'source.deleted')
  assert.equal(deletedPayload.exhausted, true)
  assert.deepEqual(deletedPayload.usageReadings, [])

  // A recreated file is a new generation and fails closed until rediscovery.
  writeFileSync(
    rollout,
    `${JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T00:00:00.000Z', payload: { id: sessionId } })}\n`
  )
  const recreated = await collect(
    { collectorRevision: '1', sourceGeneration: source.generation, offset: 9999 },
    'recreated'
  )
  assert.equal(collectionPayload(recreated).coverage.gapReason, 'source.generation-changed')

  // Identify collapses the config root and the data root of one installation.
  const identified = await runFixture(
    registry,
    fixtureEnvelope(
      pack,
      { machineId: 'fixture', candidateLocators: [configRoot, join(configRoot, 'sessions')] },
      'identify',
      { capability: 'identify' }
    )
  )
  assert.equal(identified.status, 'success')
  const installations = identifyPayload(identified).installations
  assert.equal(installations.length, 1)
  assert.equal(installations[0]!.configNamespace, configRoot)
  assert.equal(installations[0]!.dataNamespace, join(configRoot, 'sessions'))
} finally {
  close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log('codex pack conformance: ok')
