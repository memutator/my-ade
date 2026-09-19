import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectionPayload,
  discoveryPayload,
  fixtureEnvelope,
  identifyPayload,
  registerFixturePack,
  runFixture,
  watermarkOf
} from '../../fixture-support.ts'
import type { PackRunResult } from '../../fixture-support.ts'

// Synthetic fixture only: temporary snapshot files under the system temp
// directory. No real Grok installation, session log or credential is read.
const scratch = mkdtempSync(join(tmpdir(), 'mahas-grok-pack-'))
const { registry, pack, close } = registerFixturePack(
  join(scratch, 'packs'),
  new URL('.', import.meta.url).pathname
)
try {
  const configRoot = join(scratch, 'config', '.grok')
  const dataRoot = join(configRoot, 'sessions')
  const sessionDir = join(dataRoot, 'sess-1')
  mkdirSync(sessionDir, { recursive: true })
  const snapshot = join(sessionDir, 'usage.json')
  const write = (input: number, output: number, cached: number, reasoning: number): void => {
    writeFileSync(
      snapshot,
      JSON.stringify({
        sessionId: 'sess-1',
        updatedAt: '2026-03-03T09:00:00.000Z',
        session: {
          model: 'grok-4',
          inputTokens: input,
          outputTokens: output,
          cachedReadTokens: cached,
          reasoningTokens: reasoning
        }
      })
    )
  }
  write(10, 5, 3, 1)

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
  assert.equal(source.kind, 'file')

  const collect = (cursor: Record<string, unknown>, operationId: string): Promise<PackRunResult> =>
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
        { action: 'collect' }
      )
    )

  const first = collectionPayload(await collect({}, 'first'))
  const reading = first.usageReadings[0]!
  assert.equal(reading.mode, 'cumulative')
  assert.equal(reading.values.inputTotal, 10)
  assert.equal(reading.values.total, 15)
  // Cache read is contained in input on this source.
  assert.equal(reading.semantics.componentRelations[0]!.relation, 'includes')
  assert.equal(reading.semantics.componentRelations[1]!.relation, 'unknown')
  assert.equal(typeof reading.counterScope, 'string')
  assert.equal(typeof reading.counterEpoch, 'string')
  assert.equal(first.sessions[0]!.nativeSessionKey, 'sess-1')
  assert.equal(first.handles[0]!.resumeSupport, 'supported')
  assert.equal(first.usageAttributionHints[0]!.servedModel?.nativeName, 'grok-4')

  // An unchanged snapshot is a no-op sweep: nothing is re-emitted.
  const unchanged = collectionPayload(await collect(first.nextCursor ?? {}, 'unchanged'))
  assert.equal(unchanged.usageReadings.length, 0)
  assert.equal(watermarkOf(unchanged).status, 'unchanged')
  assert.equal(unchanged.exhausted, true)

  // A rewritten snapshot re-emits the same record key under the same counter
  // scope/epoch with a new revision, which the ledger records as a correction.
  write(20, 9, 3, 1)
  const updated = collectionPayload(await collect(unchanged.nextCursor ?? {}, 'updated'))
  assert.equal(updated.usageReadings.length, 1)
  assert.equal(updated.usageReadings[0]!.values.inputTotal, 20)
  assert.equal(updated.usageReadings[0]!.sourceRecordKey, reading.sourceRecordKey)
  assert.equal(updated.usageReadings[0]!.counterEpoch, reading.counterEpoch)
  assert.notEqual(updated.usageReadings[0]!.sourceRecordRevision, reading.sourceRecordRevision)

  // An unreadable snapshot holds the cursor instead of advancing past it.
  writeFileSync(snapshot, '{broken')
  const broken = collectionPayload(await collect(updated.nextCursor ?? {}, 'broken'))
  assert.equal(broken.coverage.gapReason, 'snapshot.invalid-json')
  assert.deepEqual(broken.nextCursor, updated.nextCursor)

  // Deleting the source reports a coverage gap without rewriting the ledger.
  rmSync(snapshot)
  const deleted = collectionPayload(await collect(broken.nextCursor ?? {}, 'deleted'))
  assert.equal(deleted.coverage.gapReason, 'source.deleted')
  assert.equal(deleted.exhausted, true)

  // A recreated file is a new generation and requires rediscovery.
  write(1, 1, 0, 0)
  const rotated = collectionPayload(await collect(deleted.nextCursor ?? {}, 'rotated'))
  assert.equal(rotated.coverage.gapReason, 'source.generation-changed')

  // Identify collapses the config root and the data root of one installation.
  const identified = await runFixture(
    registry,
    fixtureEnvelope(
      pack,
      { machineId: 'fixture', candidateLocators: [configRoot, dataRoot] },
      'identify',
      { capability: 'identify' }
    )
  )
  assert.equal(identified.status, 'success')
  const installations = identifyPayload(identified).installations
  assert.equal(installations.length, 1)
  assert.equal(installations[0]!.configNamespace, configRoot)
  assert.equal(installations[0]!.dataNamespace, dataRoot)
} finally {
  close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log('grok pack conformance: ok')
