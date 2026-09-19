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

// Synthetic fixture only: temporary session snapshots under the system temp
// directory. No real Cline installation, session log or credential is read.
const scratch = mkdtempSync(join(tmpdir(), 'mahas-cline-pack-'))
const { registry, pack, close } = registerFixturePack(
  join(scratch, 'packs'),
  new URL('.', import.meta.url).pathname
)
interface ClineMetric {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}
interface ClineMessage {
  id: string
  timestamp: string
  model?: string
  metrics: ClineMetric
}
try {
  const configRoot = join(scratch, 'config', '.cline')
  const dataRoot = join(configRoot, 'data', 'sessions')
  const sessionDir = join(dataRoot, 'sess-cline-1')
  mkdirSync(sessionDir, { recursive: true })
  const conversation = join(sessionDir, 'api_conversation_history.messages.json')
  const messages: ClineMessage[] = [
    {
      id: 'm1',
      timestamp: '2026-04-04T08:00:00.000Z',
      model: 'claude-sonnet-4-5',
      metrics: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10 }
    },
    {
      id: 'm2',
      timestamp: '2026-04-04T08:01:00.000Z',
      metrics: { inputTokens: 50, outputTokens: 8 }
    },
    {
      id: 'm3',
      timestamp: '2026-04-04T08:02:00.000Z',
      metrics: { inputTokens: 10, outputTokens: 2 }
    }
  ]
  const write = (value: ClineMessage[]): void => {
    writeFileSync(conversation, JSON.stringify({ sessionId: 'sess-cline-1', messages: value }))
  }
  write(messages)
  writeFileSync(
    join(sessionDir, 'sess-cline-1.json'),
    JSON.stringify({
      cwd: '/work/cline',
      prompt: '<user_input mode="act">Fix the build</user_input>'
    })
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
    maxRecords = 2
  ): Promise<PackRunResult> =>
    runFixture(
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

  // A page is bounded by maxRecords and continues from the message index.
  const page1 = collectionPayload(await collect({}, 'page-1'))
  assert.equal(page1.usageReadings.length, 2)
  assert.equal(page1.exhausted, false)
  const reading = page1.usageReadings[0]!
  assert.equal(reading.mode, 'delta')
  assert.equal(reading.values.inputTotal, 100)
  assert.equal(reading.values.total, 120)
  // cache read/write are contained in input on this source.
  assert.equal(reading.semantics.componentRelations[0]!.relation, 'includes')
  assert.equal(reading.semantics.componentRelations[1]!.relation, 'includes')
  assert.equal(page1.sessions[0]!.title, 'Fix the build')
  assert.equal(page1.sessions[0]!.metadata.workingDirectory, '/work/cline')
  assert.equal(page1.handles[0]!.resumeSupport, 'unknown')
  const page2 = collectionPayload(await collect(page1.nextCursor ?? {}, 'page-2'))
  assert.equal(page2.usageReadings.length, 1)
  assert.equal(page2.exhausted, true)
  const swept = collectionPayload(await collect(page2.nextCursor ?? {}, 'swept'))
  assert.equal(swept.usageReadings.length, 0)
  assert.equal(watermarkOf(swept).status, 'swept')

  // Rewriting one message re-emits the same record key with a new revision, so
  // the ledger sees a correction rather than a second independent usage.
  const before = page1.usageReadings[1]!
  assert.equal(before.sourceRecordKey, 'cline:message:m2')
  messages[1]!.metrics.outputTokens = 12
  write(messages)
  const corrected = collectionPayload(await collect(swept.nextCursor ?? {}, 'corrected', 10))
  const after = corrected.usageReadings.find(
    (row) => row.sourceRecordKey === before.sourceRecordKey
  )
  assert.ok(after)
  assert.equal(after.values.outputTotal, 12)
  assert.notEqual(after.sourceRecordRevision, before.sourceRecordRevision)
  assert.equal(after.sessionNativeKey, before.sessionNativeKey)

  // A missing conversation file is a coverage gap, not a silent zero.
  rmSync(conversation)
  const deleted = collectionPayload(await collect(corrected.nextCursor ?? {}, 'deleted'))
  assert.equal(deleted.coverage.gapReason, 'source.deleted')
  assert.deepEqual(deleted.usageReadings, [])

  // The config-relative data candidate and the config root describe the same
  // installation and must not be reported twice.
  const identified = await runFixture(
    registry,
    fixtureEnvelope(
      pack,
      {
        machineId: 'fixture',
        candidateLocators: [configRoot, dataRoot, join(configRoot, 'data')]
      },
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

console.log('cline pack conformance: ok')
