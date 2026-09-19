/** Real socket + daemon lifetime acceptance, with only a synthetic source. */
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { connectRpc, resolveOperatorConnection, type RpcClient } from '../../mahas-client/src/index.ts'
import { startMahasd, type MahasdHandle } from './main.ts'
import { createDomainPackFixture } from './domain-pack.fixture.ts'

const root = mkdtempSync(join(tmpdir(), 'mahas-domain-daemon-'))
const { configDir, packsRoot, sourcePath } = createDomainPackFixture(root)
const lines: Record<string, unknown>[] = []
let daemon: MahasdHandle | undefined
let client: RpcClient | undefined
let reader: DatabaseSync | undefined
async function waitFor(check: () => boolean, label: string, budget = 40_000): Promise<void> {
  const end = Date.now() + budget
  while (!check()) {
    if (Date.now() >= end) assert.fail(`${label}: ${JSON.stringify(lines)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
function storedTotal(): unknown {
  return reader?.prepare(`SELECT SUM(json_extract(normalized_tokens_json,'$.total')) total FROM usage_entries e
    WHERE revision=(SELECT MAX(revision) FROM usage_entries n WHERE n.id=e.id) AND accounting_status='counted'`).get()?.total
}
async function openClient(): Promise<RpcClient> {
  const connection = await resolveOperatorConnection({ configDir })
  return connectRpc(connection.endpoint, connection.credential)
}
try {
  daemon = await startMahasd({ configDir, packsRoot, installSignalHandlers: false,
    exitProcess: () => {}, log: (line) => lines.push(line) })
  reader = new DatabaseSync(join(configDir, 'mahas.sqlite'), { readOnly: true })
  await waitFor(() => storedTotal() === 100, 'automatic first collection')
  client = await openClient()
  const first = await client.call('usage.entry.list', {})
  assert.equal(first.status, 'committed', JSON.stringify(first.error))
  const before = reader.prepare('SELECT count(*) n FROM collection_batches').get()?.n
  await client.call('usage.entry.list', {})
  assert.equal(reader.prepare('SELECT count(*) n FROM collection_batches').get()?.n, before, 'a UI read must not collect')
  client.close()
  client = undefined
  appendFileSync(sourcePath, JSON.stringify({ id: 'b', tokens: 50, at: 1789257600001 }) + '\n')
  await waitFor(() => storedTotal() === 150, 'collection continues with no desktop client')
  client = await openClient()
  const reconnected = await client.call('usage.entry.list', {})
  assert.equal(reconnected.status, 'committed', JSON.stringify(reconnected.error))
  assert.equal((reconnected.result as { items: unknown[] }).items.length, 2)
  client.close()
  client = undefined
  reader.close()
  reader = undefined
  await daemon.close()
  daemon = undefined
  daemon = await startMahasd({ configDir, packsRoot, collectionEnabled: false, installSignalHandlers: false,
    exitProcess: () => {}, log: (line) => lines.push(line) })
  client = await openClient()
  const restarted = await client.call('usage.entry.list', {})
  assert.equal(restarted.status, 'committed', JSON.stringify(restarted.error))
  assert.equal((restarted.result as { items: unknown[] }).items.length, 2)
  console.log('domain daemon smoke: automatic collection, read-only UI query, disconnect, reconnect and daemon restart passed')
} finally {
  client?.close()
  reader?.close()
  await daemon?.close()
  rmSync(root, { recursive: true, force: true })
}
