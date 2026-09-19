/** A real external Pack -> scheduler -> atomic ledger -> stored query fixture.
 * Uses only a temporary home/config/database and never a native provider account. */
import assert from 'node:assert/strict'
import { createDomainPackFixture } from './domain-pack.fixture.ts'
import { mkdtempSync, appendFileSync, rmSync, statSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { composeIntegrationDomains } from './composition-domains.ts'
import { applyMigrations, CONTROL_MIGRATIONS } from './storage/migrations.ts'
import { createOperationRegistry } from './api/registry.ts'
import { bindAccessDb, unbindAccessDb } from './access/authorize.ts'
import { INTEGRATION_DOMAIN_OPERATIONS } from '../../mahas-contracts/src/operations/domains.ts'
import type { AuthenticatedContext } from '../../mahas-contracts/src/index.ts'
import {
  queryUsageSummaries,
  usageLedgerAggregateSource,
  rebuildUsageAggregates
} from './metering/index.ts'

const root = mkdtempSync(join(tmpdir(), 'mahas-domain-pipeline-'))
const { home, configDir, packsRoot, sourcePath } = createDomainPackFixture(root)
const dbPath = join(configDir, 'mahas.sqlite')
let db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys=ON')
applyMigrations(db, CONTROL_MIGRATIONS, 'control')
db.prepare('INSERT INTO principals(id,kind,status) VALUES(?,?,?)').run(
  'fixture.operator',
  'operator',
  'active'
)
db.prepare(
  `INSERT INTO grants(id,revision,kind,principal_id,scope_json,actions_json) VALUES(?,1,'assignment',?,?,?)`
).run(
  'fixture.grant',
  'fixture.operator',
  JSON.stringify({ targets: [{ kind: '*', id: '*' }] }),
  JSON.stringify(['surface.describe', ...INTEGRATION_DOMAIN_OPERATIONS.map((entry) => entry.name)])
)
bindAccessDb(db)
const registry = await createOperationRegistry(db)
const diagnostics: Record<string, unknown>[] = []
const domains = await composeIntegrationDomains({
  db,
  registry,
  configDir,
  packsRoot,
  home,
  timeZone: 'UTC',
  collectionEnabled: false,
  log: (line) => diagnostics.push(line)
})
const ctx: AuthenticatedContext = {
  principalId: 'fixture.operator' as AuthenticatedContext['principalId'],
  controllerEpoch: 1 as AuthenticatedContext['controllerEpoch'],
  grantRevisions: { 'fixture.grant': 1 },
  transportSessionId: 'fixture'
}
let sequence = 0
const call = async (operation: string, payload: unknown = {}): Promise<unknown> => {
  const receipt = await registry.dispatch(ctx, {
    protocolVersion: 'internal/1',
    operation,
    operationId: `fixture-${++sequence}`,
    payload
  })
  assert.equal(receipt.status, 'committed', JSON.stringify(receipt.error))
  return receipt.result
}
const total = (): unknown =>
  db
    .prepare(
      `SELECT SUM(json_extract(normalized_tokens_json,'$.total')) AS total FROM usage_entries e
  WHERE revision=(SELECT MAX(revision) FROM usage_entries n WHERE n.id=e.id) AND accounting_status='counted'`
    )
    .get()?.total
try {
  assert.equal(domains.packs.list().length, 1, JSON.stringify(diagnostics))
  await domains.scheduler.tick()
  assert.equal(
    total(),
    100,
    JSON.stringify(db.prepare('SELECT diagnostics_json FROM integration_checks').all())
  )
  const sourceId = String(db.prepare('SELECT id FROM collection_sources').get()?.id)
  const cursorBefore = db
    .prepare('SELECT checkpoint_revision FROM collection_cursors')
    .get()?.checkpoint_revision
  await call('collection.request', { sourceId, capability: 'usage', maxRecords: 1 })
  await domains.scheduler.tick()
  assert.equal(total(), 100, 'replay must not duplicate usage')
  assert.ok(
    Number(
      db.prepare('SELECT checkpoint_revision FROM collection_cursors').get()?.checkpoint_revision
    ) > Number(cursorBefore)
  )
  assert.equal(db.prepare('SELECT status FROM collection_requests').get()?.status, 'processed')

  appendFileSync(sourcePath, JSON.stringify({ id: 'b', tokens: 50, at: 1789261200000 }))
  await domains.scheduler.tick()
  assert.equal(total(), 100, 'partial line must not be consumed')
  appendFileSync(sourcePath, '\n')
  await domains.scheduler.tick()
  assert.equal(total(), 150)
  const entries = (await call('usage.entry.list')) as { items: unknown[] }
  assert.equal(entries.items.length, 2)
  const beforeQuery = db.prepare('SELECT COUNT(*) AS count FROM collection_batches').get()?.count
  await call('catalog.snapshot')
  await call('inventory.snapshot')
  await call('metering.summary.query', { filter: { grain: 'alltime' } })
  // operation-level exact-shape read: dimensionKeys travels the registered op
  // (payload -> queryOptions -> walkSummaries SQL), not just the service call
  const globalPage = (await call('metering.summary.query', {
    filter: { grain: 'alltime' },
    dimensionKeys: [],
    limit: 1
  })) as { items: { dimensions: Record<string, unknown>; totals: { total: number | null } }[] }
  assert.equal(globalPage.items.length, 1, 'dimensionKeys:[] selects exactly the {} row')
  assert.deepEqual(Object.keys(globalPage.items[0]!.dimensions), [])
  assert.equal(globalPage.items[0]!.totals.total, 150)
  const sessionPage = (await call('metering.summary.query', {
    filter: { grain: 'alltime' },
    dimensionKeys: ['sessionId'],
    limit: 50
  })) as { items: { dimensions: Record<string, unknown> }[] }
  assert.ok(
    sessionPage.items.every((item) => Object.keys(item.dimensions).join(',') === 'sessionId'),
    'every returned row has exactly the requested shape'
  )
  await assert.rejects(
    registry.dispatch(ctx, {
      protocolVersion: 'internal/1',
      operation: 'metering.summary.query',
      operationId: `fixture-${++sequence}`,
      payload: { dimensionKeys: ['bogus-axis'] }
    }),
    /unsupported dimension axis/,
    'an unknown axis name is a caller error'
  )
  await call('metering.statistic.list')
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM collection_batches').get()?.count,
    beforeQuery,
    'queries do not collect'
  )
  const sizeBeforeFailure = statSync(sourcePath).size
  const checkpointBeforeFailure = db
    .prepare('SELECT checkpoint_revision FROM collection_cursors')
    .get()?.checkpoint_revision
  appendFileSync(sourcePath, 'malformed complete record\n')
  await call('collection.request', { sourceId, capability: 'usage' })
  await domains.scheduler.tick()
  assert.equal(total(), 150, 'collector failure cannot corrupt retained totals')
  assert.equal(
    db.prepare('SELECT checkpoint_revision FROM collection_cursors').get()?.checkpoint_revision,
    checkpointBeforeFailure
  )
  assert.equal(db.prepare('SELECT status FROM collection_sources').get()?.status, 'unavailable')
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM collection_requests WHERE status='failed'").get()?.n,
    1
  )
  truncateSync(sourcePath, sizeBeforeFailure)
  await domains.scheduler.tick()
  assert.equal(db.prepare('SELECT status FROM collection_sources').get()?.status, 'active')
  await call('collection.request', { sourceId, capability: 'usage' })
  rmSync(sourcePath)
  await domains.scheduler.tick()
  assert.equal(total(), 150, 'source deletion does not erase the ledger')
  assert.equal(db.prepare('SELECT status FROM collection_sources').get()?.status, 'missing')
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM collection_requests WHERE status='failed'").get()?.n,
    2,
    'missing source settles its queued request'
  )
  await call('collection.request', { sourceId, capability: 'usage' })
  await domains.scheduler.tick()
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM collection_requests WHERE status='failed'").get()?.n,
    3,
    'a new request for an already missing source also settles'
  )
  await domains.close()
  unbindAccessDb()
  db.close()
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys=ON')
  assert.deepEqual(applyMigrations(db, CONTROL_MIGRATIONS, 'control'), [])
  assert.equal(total(), 150, 'daemon reopen preserves usage without the native file')
  rebuildUsageAggregates(db, usageLedgerAggregateSource(db), { timeZone: 'UTC' })
  const summaries = queryUsageSummaries(db, { grain: 'alltime' })
  assert.ok(
    summaries.page.summaries.some((summary) => summary.totals.total === 150),
    'rebuild reads the retained ledger'
  )
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  console.log(
    'domain pipeline smoke: external Pack, bounded ingest, replay, partial line, queue, stored queries, deletion and restart/rebuild passed'
  )
} finally {
  await domains.close()
  unbindAccessDb()
  db.close()
  rmSync(root, { recursive: true, force: true })
}
