/** Assembled daemon + built-in Pack + real auth socket, with synthetic secrets.
 * fetch is replaced before boot; no request can leave this process. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  connectRpc,
  resolveOperatorConnection,
  type RpcClient
} from '../../mahas-client/src/index.ts'
import { startMahasd, type MahasdHandle } from './main.ts'

const root = mkdtempSync(join(tmpdir(), 'mahas-domain-auth-'))
const configDir = join(root, 'config')
const legacyRoot = join(root, 'legacy-usage-accounts')
const home = join(configDir, 'test-home')
const keys = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'MAHAS_TEST',
  'MAHAS_CONFIG_DIR',
  'MAHAS_LEGACY_USAGE_ACCOUNTS_ROOT',
  'MAHAS_EVENTS_FILE',
  'MAHAS_NOTIFY_LOG',
  'MAHAS_AUTH_PACK_ID',
  'MAHAS_AUTH_PACK_REVISION'
]
const original = new Map(keys.map((key) => [key, process.env[key]]))
const realFetch = globalThis.fetch
const logs: Record<string, unknown>[] = []
const calls: string[] = []
let failQuota = false
let daemon: MahasdHandle | undefined
let auth: RpcClient | undefined
let ordinary: RpcClient | undefined
let reader: DatabaseSync | undefined

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 15_000
  while (!check()) {
    if (Date.now() > end) assert.fail(`${label}: ${JSON.stringify(logs)}`)
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}
async function channel(
  method: string,
  input: Record<string, unknown> = {},
  scope?: string
): Promise<Record<string, unknown>> {
  const reply = await auth!.call(method, {
    protocolVersion: 'mahas.auth.channel/v1',
    method,
    input,
    ...(scope ? { scope } : {})
  })
  assert.equal(reply.status, 'committed', JSON.stringify(reply.error))
  const response = reply.result as { status: string; result?: unknown; deposit?: unknown }
  assert.equal(response.status, 'ok', JSON.stringify(response))
  return (response.result ?? response.deposit) as Record<string, unknown>
}

try {
  for (const directory of [
    home,
    configDir,
    join(root, 'xdg-config'),
    join(root, 'xdg-data'),
    join(legacyRoot, 'codex', 'fixture-account')
  ])
    mkdirSync(directory, { recursive: true })
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    MAHAS_TEST: '1',
    MAHAS_CONFIG_DIR: configDir,
    MAHAS_LEGACY_USAGE_ACCOUNTS_ROOT: legacyRoot,
    MAHAS_EVENTS_FILE: join(configDir, 'events.log'),
    MAHAS_NOTIFY_LOG: join(configDir, 'decisions.log')
  })
  delete process.env.MAHAS_AUTH_PACK_ID
  delete process.env.MAHAS_AUTH_PACK_REVISION
  writeFileSync(
    join(legacyRoot, 'codex', 'fixture-account', 'auth.json'),
    JSON.stringify({
      tokens: { access_token: 'fixture-only-codex-token', account_id: 'fixture-account' }
    }),
    { mode: 0o600 }
  )
  globalThis.fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (failQuota) return new Response('{}', { status: 503 })
    if (url === 'https://chatgpt.com/backend-api/wham/usage')
      return Response.json({ rate_limit: { primary_window: { used_percent: 25 } } })
    if (url === 'https://api.z.ai/api/monitor/usage/quota/limit')
      return Response.json({ data: { fiveHourPercent: 10 } })
    throw new Error('unexpected synthetic provider request: ' + url)
  }
  daemon = await startMahasd({
    configDir,
    packsRoot: resolve('integrations/packs'),
    collectionEnabled: false,
    installSignalHandlers: false,
    exitProcess: () => {},
    log: (line) => logs.push(line)
  })
  assert(!logs.some((line) => line.t === 'auth.unavailable'), JSON.stringify(logs))
  const operator = await resolveOperatorConnection({ configDir })
  ordinary = await connectRpc(operator.endpoint, operator.credential)
  auth = await connectRpc(join(configDir, 'mahasd-auth.sock'), operator.credential)
  const unknown = await channel('auth.flow.status', { flowId: 'fixture-unknown' })
  assert.equal(
    unknown.state,
    'unknown',
    'assembled operator identity is accepted by dedicated auth channel'
  )
  reader = new DatabaseSync(join(configDir, 'mahas.sqlite'), { readOnly: true })
  await waitFor(
    () =>
      Number(
        reader!
          .prepare(
            'SELECT COUNT(*) n FROM inventory_provider_credentials WHERE material_ref LIKE ?'
          )
          .get('locator://file/' + legacyRoot + '/%')?.n
      ) === 1,
    'legacy account imported automatically by assembled startup'
  )
  const legacy = reader
    .prepare('SELECT id,ownership FROM inventory_provider_credentials WHERE material_ref LIKE ?')
    .get('locator://file/' + legacyRoot + '/%')!
  assert.equal(legacy.ownership, 'external')
  const legacyConnection = reader
    .prepare('SELECT id FROM inventory_provider_connections WHERE credential_id=?')
    .get(legacy.id)!
  await waitFor(
    () => calls.includes('https://chatgpt.com/backend-api/wham/usage'),
    'automatic built-in quota probe'
  )
  await waitFor(
    () =>
      Number(
        reader!.prepare("SELECT COUNT(*) n FROM quota_reading_facets WHERE status='success'").get()
          ?.n
      ) > 0,
    'quota persisted'
  )

  const flow = await channel('auth.flow.start', { offeringId: 'zai/coding-plan' })
  assert.equal(flow.state, 'needs-input')
  const flowId = String(flow.flowId),
    scope = 'flow:' + flowId
  const deposit = await channel(
    'auth.secret.deposit',
    { secret: 'fixture-only-zai-key', scope },
    scope
  )
  const completed = await channel('auth.flow.submitSecret', { flowId, handle: deposit.handle })
  assert.equal(completed.state, 'complete')
  assert.equal(JSON.stringify(completed).includes('fixture-only-zai-key'), false)
  const managed = reader
    .prepare(
      "SELECT material_ref,ownership FROM inventory_provider_credentials WHERE material_ref LIKE 'mahas-secret:%'"
    )
    .get()!
  assert(managed, 'sign-in stores a managed credential locator')
  assert.equal(managed.ownership, 'machine')
  const record = reader.prepare('SELECT COUNT(*) n FROM inventory_harness_provider_bindings').get()!
  assert.equal(record.n, 0, 'sign-in does not invent a harness binding')
  const second = await channel('auth.flow.start', { offeringId: 'zai/coding-plan' })
  const cancelled = await channel('auth.flow.cancel', { flowId: second.flowId })
  assert.equal(cancelled.state, 'failed')
  assert.equal(cancelled.error, 'cancelled')
  assert.equal((await channel('auth.flow.status', { flowId: second.flowId })).state, 'unknown')
  assert.equal(
    reader.prepare('SELECT state FROM auth_intents WHERE flow_id=?').get(String(second.flowId))
      ?.state,
    'cancelled'
  )
  const listed = await channel('auth.flow.list')
  assert(Array.isArray(listed) && listed.some((flow) => flow.flowId === flowId))
  assert(!listed.some((flow) => flow.flowId === second.flowId))
  assert.equal(typeof completed.connectionId, 'string')
  await channel('auth.flow.status', { flowId })
  await channel('auth.flow.poll', { flowId })
  assert.equal(
    reader
      .prepare(
        "SELECT COUNT(*) n FROM inventory_provider_credentials WHERE material_ref LIKE 'mahas-secret:%'"
      )
      .get()?.n,
    1,
    'repeated completion does not create another account'
  )

  // A user-selected file outside all discovery roots uses the same deferred import.
  const selectedFile = join(root, 'selected-credential.json')
  writeFileSync(
    selectedFile,
    JSON.stringify({ tokens: { access_token: 'fixture-selected-secret' } })
  )
  const importSelected = (): ReturnType<RpcClient['call']> =>
    ordinary!.call('auth.locator.import', {
      offeringId: 'openai/chatgpt',
      path: selectedFile
    })
  const selected = await importSelected()
  assert.equal(selected.status, 'committed', JSON.stringify(selected.error))
  const importedIds = (selected.result as { imported: string[] }).imported
  assert.equal(importedIds.length, 1)
  assert.equal(
    reader
      .prepare('SELECT machine_id FROM inventory_provider_credentials WHERE id=?')
      .get(importedIds[0])?.machine_id,
    reader
      .prepare('SELECT machine_id FROM inventory_provider_credentials WHERE id=?')
      .get(legacy.id)?.machine_id
  )
  const selectedConnection = reader
    .prepare(
      'SELECT id FROM inventory_provider_connections WHERE credential_id=? AND observed_until IS NULL'
    )
    .get(importedIds[0])!
  const repeatedImport = await importSelected()
  assert.equal(repeatedImport.status, 'committed')
  assert.deepEqual((repeatedImport.result as { unchanged: string[] }).unchanged, importedIds)
  for (const payload of [
    { offeringId: 'fixture/unknown', path: selectedFile },
    { offeringId: 'openai/chatgpt', path: 'relative.json' },
    { offeringId: 'openai/chatgpt', path: selectedFile, machineId: 'foreign-machine' },
    { offeringId: '', path: '' }
  ])
    assert.notEqual((await ordinary.call('auth.locator.import', payload)).status, 'committed')
  assert.equal(
    (
      await ordinary.call('inventory.observation.record', {
        id: 'fixture-selected-removal',
        subjectKind: 'connection',
        subjectId: selectedConnection.id,
        outcome: 'removed',
        observedAt: Date.now(),
        sourceRef: 'fixture-file-import'
      })
    ).status,
    'committed'
  )
  assert.equal((await importSelected()).status, 'committed')
  assert.equal(
    reader
      .prepare(
        'SELECT COUNT(*) n FROM inventory_provider_connections WHERE credential_id=? AND observed_until IS NULL'
      )
      .get(importedIds[0])?.n,
    0
  )
  assert.equal(
    reader.prepare('SELECT COUNT(*) n FROM inventory_harness_provider_bindings').get()?.n,
    0
  )

  failQuota = true
  const signalled = await ordinary.call('auth.quota.collect', {})
  assert.equal(signalled.status, 'committed')
  await waitFor(
    () =>
      Number(
        reader!
          .prepare(
            "SELECT COUNT(*) n FROM quota_reading_facets WHERE status='failure' AND connection_id=?"
          )
          .get(legacyConnection.id)?.n
      ) > 0,
    'manual request persists quota failure'
  )
  const current = await ordinary.call('metering.quota.current', {
    connectionId: legacyConnection.id
  })
  const value = current.result as {
    latest: { payload: { status: string } }
    lastSuccess: { payload: { status: string } }
  }
  assert.equal(value.latest.payload.status, 'failure')
  assert.equal(value.lastSuccess.payload.status, 'success')
  assert.equal(
    reader
      .prepare('SELECT COUNT(*) n FROM collection_coverage WHERE interval_json IS NOT NULL')
      .get()?.n,
    0
  )
  for (const suffix of ['', '-wal']) {
    let data: Buffer
    try {
      data = readFileSync(join(configDir, 'mahas.sqlite') + suffix)
    } catch {
      continue
    }
    for (const secret of [
      'fixture-only-zai-key',
      'fixture-only-codex-token',
      'fixture-selected-secret'
    ])
      assert.equal(data.includes(Buffer.from(secret)), false)
  }
  assert.equal(JSON.stringify(logs).includes('fixture-only-zai-key'), false)
  assert.equal(
    statSync(join(legacyRoot, 'codex', 'fixture-account', 'auth.json')).mode & 0o777,
    0o600
  )
  console.log(
    'domain auth smoke: assembled operator channel, built-in login/cancel/list, automatic legacy import, managed ownership, quota provenance and secret-free receipts pass'
  )
} finally {
  auth?.close()
  ordinary?.close()
  reader?.close()
  await daemon?.close()
  globalThis.fetch = realFetch
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
}
