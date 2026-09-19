/** Durable user-channel completion: synthetic secrets, no provider requests. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { serializeDatabase } from '../../api/admission.ts'
import { seedBuiltinCatalog } from '../../catalog/seed.ts'
import { CONTROL_MIGRATIONS, applyMigrations } from '../../storage/migrations.ts'
import { ensureLocalMachine } from '../local.ts'
import { AuthService } from './service.ts'
import { FileManagedSecretStore } from './secret-store.ts'
import type { AuthFlowView, ProviderAuthDriver } from './coordinator.ts'
import type { AuthCallbackResult } from './callback.ts'

const root = mkdtempSync(join(tmpdir(), 'mahas-channel-workflow-'))
const db = new DatabaseSync(':memory:')
applyMigrations(db, CONTROL_MIGRATIONS, 'control')
seedBuiltinCatalog(db)
const machine = ensureLocalMachine(db, { configDir: root, observedAt: 1 }).value
const secrets = new FileManagedSecretStore(join(root, 'secrets'))
let sequence = 0
const flows = new Map<string, AuthFlowView>()
let callbackResolve: (result: AuthCallbackResult) => void = () => {}
const callbackResult = new Promise<AuthCallbackResult>((resolve) => {
  callbackResolve = resolve
})
const driver: ProviderAuthDriver = {
  async start() {
    assert.equal(db.isTransaction, false)
    const view: AuthFlowView = {
      flowId: 'synthetic-' + ++sequence,
      state: 'effect-required',
      effect: { kind: 'open-browser', url: 'https://example.test' }
    }
    flows.set(view.flowId, view)
    return view
  },
  async submitCode(flowId) {
    assert.equal(db.isTransaction, false)
    const stored = await secrets.put({
      offeringId: 'zai/coding-plan',
      ownership: 'mahas',
      material: { apiKey: 'fixture-only-secret' }
    })
    const view: AuthFlowView = {
      flowId,
      state: 'complete',
      credentialChange: {
        kind: 'create',
        materialRef: stored.ref,
        materialRevision: stored.revision
      }
    }
    flows.set(flowId, view)
    return view
  },
  submitSecret(flowId, secret) {
    return this.submitCode(flowId, secret)
  },
  async poll(flowId) {
    return this.status(flowId)
  },
  cancel(flowId) {
    const view: AuthFlowView = { flowId, state: 'failed', error: 'cancelled' }
    flows.set(flowId, view)
    return view
  },
  status(flowId) {
    return flows.get(flowId) ?? { flowId, state: 'unknown' }
  },
  async refresh() {
    throw new Error('not used')
  },
  callbackSpec() {
    return { mode: 'dynamic', path: '/callback' }
  },
  list() {
    return [...flows.values()]
  }
}
const service = new AuthService({
  db,
  database: (work) => serializeDatabase(db, work),
  secrets,
  driver,
  machineId: machine.id,
  catalog: { candidates: () => [], parseMaterial: () => ({}) },
  roots: { home: root, configHome: root, dataHome: root },
  callback: {
    async open() {
      return {
        redirect: 'http://127.0.0.1/callback',
        closed: false,
        awaitResult: () => callbackResult,
        close() {
          /* synthetic callback has no socket */
        }
      }
    }
  }
})
try {
  await service.boot()
  const channel = service.durableChannelHandlers()
  // Explicit redirect bypasses listener for the commit-failure scenario.
  const first = await channel.start({
    offeringId: 'zai/coding-plan',
    callbackRedirect: 'http://127.0.0.1/fixture'
  })
  db.exec(
    "CREATE TRIGGER fail_connection BEFORE INSERT ON inventory_provider_connections BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END"
  )
  await assert.rejects(
    channel.submitCode({ flowId: first.flowId, code: 'fixture-code' }),
    /fixture commit failure/
  )
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_provider_credentials').get()?.n, 0)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM auth_intents WHERE state='complete'").get()?.n, 0)
  db.exec('DROP TRIGGER fail_connection')
  const retried = await channel.status({ flowId: first.flowId })
  assert.equal(retried.state, 'complete')
  assert.equal(typeof retried.connectionId, 'string')
  await channel.poll({ flowId: first.flowId })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_provider_connections').get()?.n, 1)
  // A browser callback completes and persists without any UI poll/submit.
  await channel.start({ offeringId: 'zai/coding-plan' })
  callbackResolve({ code: 'fixture-callback-code', state: null })
  const deadline = Date.now() + 2000
  while (db.prepare('SELECT COUNT(*) n FROM inventory_provider_connections').get()?.n !== 2) {
    assert(Date.now() < deadline, 'callback completion must persist inventory without UI')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const rows = db.prepare('SELECT machine_id FROM inventory_provider_credentials').all()
  assert(rows.every((row) => row.machine_id === machine.id))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory_harness_provider_bindings').get()?.n, 0)
  console.log(
    'auth channel workflow smoke: atomic completion rollback/retry, idempotence, autonomous callback and local machine pass'
  )
} finally {
  await service.shutdown()
  db.close()
  rmSync(root, { recursive: true, force: true })
}
