import assert from 'node:assert/strict'
import { AgentEventGate, type AgentEventIngestAck, type AgentEventRecord } from './eventsFile.ts'
import { createRuntimeIngestPort, interpretIngestReceipt } from './agentEventIngest.ts'

const record = (index: number): AgentEventRecord => ({
  file: '/synthetic/events.log',
  offset: index,
  generation: 1,
  sourceRecordKey: `fixture:1:${index}`,
  raw: '{}',
  event: { provider: 'fake', event: 'turn-complete' }
})
const batch = [record(1), record(2)]
for (const receipt of [
  { status: 'committed' },
  { status: 'committed', result: { committed: true } },
  { status: 'committed', result: { committed: true, recordKeys: ['fixture:1:1'] } },
  {
    status: 'unknown',
    result: { committed: true, recordKeys: batch.map((r) => r.sourceRecordKey) }
  }
])
  assert.equal(interpretIngestReceipt(receipt, batch).committed, false)

const largeBatch = Array.from({ length: 513 }, (_, i) => record(i))
const calls: number[] = []
const port = createRuntimeIngestPort({
  async call(_operation, payload) {
    const records = (payload as { records: AgentEventRecord[] }).records
    calls.push(records.length)
    return {
      status: 'committed',
      result: {
        committed: true,
        recordKeys: records.map((r) => r.sourceRecordKey)
      }
    }
  }
})
assert.deepEqual(await port.ingest(largeBatch), {
  committed: true,
  recordKeys: largeBatch.map((r) => r.sourceRecordKey)
})
assert.deepEqual(calls, [512, 1])
let rejectedCalls = 0
const rejectedPort = createRuntimeIngestPort({
  async call() {
    rejectedCalls++
    return { status: 'committed', result: { committed: true, recordKeys: [] } }
  }
})
assert.equal((await rejectedPort.ingest(largeBatch)).committed, false)
assert.equal(rejectedCalls, 1)

// An acknowledgement cannot consume records queued after an in-flight batch
// was evicted by overflow, nor forward the evicted record a second time.
let release!: (ack: AgentEventIngestAck) => void
const committed: string[] = []
const dropped: string[] = []
const gate = new AgentEventGate({
  maxQueue: 2,
  batchSize: 1,
  port: {
    name: 'synthetic',
    async ingest(records) {
      if (records[0].offset === 1)
        return new Promise((resolve) => {
          release = resolve
        })
      return { committed: true, recordKeys: records.map((r) => r.sourceRecordKey) }
    }
  },
  onCommitted: (r) => committed.push(r.sourceRecordKey),
  onDropped: (r) => dropped.push(r.sourceRecordKey)
})
gate.enqueue(record(1))
gate.enqueue(record(2))
gate.enqueue(record(3))
release({ committed: true, recordKeys: ['fixture:1:1'] })
await new Promise((resolve) => setImmediate(resolve))
assert.deepEqual(dropped, ['fixture:1:1'])
assert.deepEqual(committed, ['fixture:1:2', 'fixture:1:3'])
assert.deepEqual(gate.stats(), { pending: 0, committed: 2, dropped: 1, port: 'synthetic' })
gate.stop()

const partial = new AgentEventGate({
  retryDelaysMs: [60_000],
  port: {
    name: 'partial',
    async ingest() {
      return { committed: true, recordKeys: [] }
    }
  },
  onCommitted: () => assert.fail('unacknowledged event reached attention')
})
partial.enqueue(record(4))
await new Promise((resolve) => setImmediate(resolve))
assert.equal(partial.pending(), 1)
partial.stop()
console.log(
  'desktop event ingest smoke: partial/malformed receipts, chunk merge and in-flight overflow pass'
)
