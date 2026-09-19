import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandReceipt } from '../../mahas-contracts/src/index.ts'
import { createMahasClient, receiptToControl } from './client.ts'
import type { RpcClient, RpcConnector } from './rpc.ts'

function receipt(
  operationId: string,
  status: CommandReceipt['status'],
  result?: unknown
): CommandReceipt {
  return {
    operationId,
    fingerprint: `fp-${operationId}`,
    status,
    result,
    effects: [],
    domainRevision: 1,
    eventCursor: 1
  }
}

const directory = await mkdtemp(join(tmpdir(), 'mahas-client-'))
try {
  const connectionFile = join(directory, 'operator-connection.json')
  await writeFile(
    connectionFile,
    JSON.stringify({
      endpoint: join(directory, 'test.sock'),
      credential: { kind: 'operator', secret: 'test-only' }
    })
  )
  await chmod(connectionFile, 0o600)

  let connects = 0
  let failNext = false
  const calls: Array<{ operation: string; operationId?: string }> = []
  const connector: RpcConnector = async (endpoint, credential) => {
    connects++
    assert.equal(endpoint, join(directory, 'test.sock'))
    assert.deepEqual(credential, { kind: 'operator', secret: 'test-only' })
    const rpc: RpcClient = {
      endpoint,
      principalId: 'operator:test',
      transportSessionId: `session-${connects}`,
      protocolVersion: 1,
      async call(operation, _payload, options) {
        calls.push({ operation, operationId: options?.operationId })
        if (failNext) {
          failNext = false
          throw new Error('mock socket lost')
        }
        if (operation === 'runtime.status') {
          return receipt(options?.operationId ?? 'status', 'committed', {
            service: 'mahasd',
            state: 'serving',
            writableReady: true
          })
        }
        if (operation === 'custom.unknown') return receipt('unknown-1', 'unknown')
        if (operation === 'runtime.snapshot') {
          return receipt(options?.operationId ?? 'snapshot', 'committed', {
            entities: {
              executions: [
                {
                  id: 'execution-1',
                  memberId: 'member-1',
                  state: 'ready',
                  liveness: 'live'
                }
              ]
            }
          })
        }
        return receipt(options?.operationId ?? 'query', 'committed', { id: 'execution-1' })
      },
      close() {
        void connects
      }
    }
    return rpc
  }

  const client = createMahasClient({ configDir: directory, connector })
  assert.equal((await client.refresh()).readiness, 'ready')
  assert.equal(connects, 1)

  const generic = receiptToControl(await client.call('custom.unknown', {}, { operationId: 'u1' }))
  assert.equal(generic.ok, false)
  if (!generic.ok) assert.match(generic.error.message, /^unknown:/)
  const refused = receiptToControl({
    ...receipt('refused-1', 'rejected'),
    error: {
      code: 'UNAVAILABLE_OPERATION',
      message: 'not registered',
      retry: 'none'
    }
  })
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.equal(refused.error.code, 'UNAVAILABLE_OPERATION')

  const created = await client.createExecution({
    operationId: 'create-1',
    process: { argv: ['mock-command'] }
  })
  assert.equal(created.ok, true)
  assert.equal(connects, 1, 'typed and generic calls share the authenticated session')
  const listed = await client.listExecutions({ memberId: 'member-1' })
  assert.equal(listed.ok, true)
  if (listed.ok) assert.equal(listed.value[0]?.id, 'execution-1')

  failNext = true
  const ambiguous = await client.bindView({
    operationId: 'bind-ambiguous',
    viewId: 'view-1',
    executionId: 'execution-1'
  })
  assert.equal(ambiguous.ok, false)
  assert.equal(
    calls.filter((call) => call.operationId === 'bind-ambiguous').length,
    1,
    'an ambiguous mutation is never replayed'
  )
  await client.call('operation.get', { operationId: 'bind-ambiguous' })
  assert.equal(connects, 2, 'the next independent call reconnects')
  await client.disconnect()
} finally {
  await rm(directory, { recursive: true, force: true })
}

console.log('mahas-client smoke: ok')
