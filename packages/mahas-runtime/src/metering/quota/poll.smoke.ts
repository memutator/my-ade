import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { CONTROL_MIGRATIONS, applyMigrations } from '../../storage/migrations.ts'
import { serializeDatabase } from '../../api/admission.ts'
import { seedBuiltinCatalog } from '../../catalog/seed.ts'
import {
  putMachine,
  putProviderConnection,
  registerCredential
} from '../../inventory/repository.ts'
import { QuotaPoller } from './poll.ts'

// Real common collection/ledger schema, synthetic material and probes only.
const db = new DatabaseSync(':memory:')
applyMigrations(db, CONTROL_MIGRATIONS, 'control')
seedBuiltinCatalog(db)
putMachine(db, {
  id: 'fixture-machine',
  label: 'Fixture',
  firstSeenAt: 1,
  lastSeenAt: 1,
  metadata: {}
})
for (let i = 0; i < 3; i++) {
  registerCredential(db, {
    id: `credential-${i}`,
    machineId: 'fixture-machine',
    materialRef: `fixture:${i}`,
    materialRevision: 1,
    ownership: 'unknown',
    availability: 'available',
    firstSeenAt: 1,
    lastSeenAt: 1
  })
  putProviderConnection(db, {
    id: `connection-${i}`,
    offeringId: i === 1 ? 'anthropic/claude' : 'openai/chatgpt',
    credentialId: `credential-${i}`,
    firstSeenAt: 1,
    availability: 'available',
    origin: 'registered'
  })
}
const database = <T>(work: () => T | Promise<T>): Promise<T> => serializeDatabase(db, work)
let fail = false
let materialRevision = 1
let materialError = false
let release: (() => void) | undefined
let began: (() => void) | undefined
let hold = false
let probes = 0
const poller = new QuotaPoller({
  db,
  database,
  batchSize: 1,
  now: () => 10_000,
  pack: { packId: 'unused-fallback', revision: 1, contentDigest: 'unused' },
  packFor: async (offeringId) => ({
    packId: `pack:${offeringId}`,
    revision: 2,
    contentDigest: 'fixture-digest'
  }),
  material: {
    readManaged: async () => {
      if (materialError) throw new SyntaxError('invalid JSON: fixture-secret-must-not-escape')
      return { revision: materialRevision, material: {} }
    },
    readLocator: async () => assert.fail('unexpected locator')
  },
  probe: {
    async probe() {
      probes++
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve
          began?.()
        })
      if (fail) throw new Error('synthetic quota outage')
      return { status: 'success', payload: { meters: [] } }
    }
  }
})
try {
  const visited: string[] = []
  for (let i = 0; i < 6; i++) visited.push(...(await poller.tick()).connections)
  assert.deepEqual(visited, [
    'connection-0',
    'connection-1',
    'connection-2',
    'connection-0',
    'connection-1',
    'connection-2'
  ])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM quota_reading_facets').get()?.n, 6)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM collection_sources').get()?.n, 3)
  assert.equal(
    db
      .prepare(
        `SELECT COUNT(*) n FROM observation_collection_facets f
    JOIN collection_batches b ON b.id=f.batch_id JOIN collection_sources s ON s.id=f.source_id
    JOIN quota_reading_facets q ON q.observation_id=f.observation_id WHERE f.facet='quota'`
      )
      .get()?.n,
    6
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM collection_coverage WHERE interval_json IS NOT NULL').get()
      ?.n,
    0
  )
  const sourceEvidence = poller.current('connection-1').latest?.payload.sourceEvidence
  assert.equal(sourceEvidence?.packId, 'pack:anthropic/claude')
  assert.equal(sourceEvidence?.materialRevision, 1)

  fail = true
  await poller.tick() // connection-0, same wall-clock millisecond
  const current = poller.current('connection-0')
  assert.equal(current.latest?.payload.status, 'failure')
  assert.equal(current.lastSuccess?.payload.status, 'success')
  assert.notEqual(current.latest?.observationId, current.lastSuccess?.observationId)
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM collection_coverage WHERE completeness='gap'").get()?.n,
    1
  )

  // Probe I/O must not hold the serialized DB queue. Concurrent manual/timer
  // calls share a pass, and stop awaits it before the DB may close.
  fail = false
  hold = true
  const started = new Promise<void>((resolve) => {
    began = resolve
  })
  const first = poller.tick()
  await started
  assert.equal(poller.tick(), first)
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    assert.equal(
      await Promise.race([
        database(() => 42),
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('provider I/O blocked the database')), 1000)
        })
      ]),
      42
    )
  } finally {
    clearTimeout(deadline)
  }
  let stopped = false
  const stop = poller.stop().then(() => {
    stopped = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stopped, false)
  release?.()
  await Promise.all([first, stop])
  assert.equal(probes, 8)

  hold = false
  const before = db.prepare('SELECT COUNT(*) n FROM quota_reading_facets').get()?.n
  db.exec(`CREATE TRIGGER fail_coverage BEFORE INSERT ON collection_coverage
    BEGIN SELECT RAISE(ABORT, 'synthetic commit failure'); END`)
  await assert.rejects(poller.tick(), /synthetic commit failure/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM quota_reading_facets').get()?.n, before)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM collection_batches').get()?.n, before)
  db.exec('DROP TRIGGER fail_coverage')
  const probedBefore = probes
  materialRevision = 2
  const stale = await poller.tick()
  assert.equal(stale.failed, 1)
  assert.equal(probes, probedBefore, 'new material cannot carry an old inventory revision')
  materialError = true
  const malformed = await poller.tick()
  assert.equal(malformed.failed, 1)
  assert.equal(
    JSON.stringify(poller.current(malformed.connections[0])).includes(
      'fixture-secret-must-not-escape'
    ),
    false
  )
  console.log(
    'quota poll smoke: rotation, same-time observations, pinned provenance, null time coverage, unlocked I/O, single flight, shutdown and atomic failure pass'
  )
} finally {
  release?.()
  await poller.stop()
  db.close()
}
