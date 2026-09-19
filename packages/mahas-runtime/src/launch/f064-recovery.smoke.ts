// Deterministic coordinator fault injection. No provider/model calls.
// node packages/mahas-runtime/src/launch/f064-recovery.smoke.ts
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IDS, seedFixture } from '../access/f062-assignment-service.smoke.ts'
import { composeRuntime } from '../composition.ts'
import { openControlDb, putContentBlob, sha256Hex } from '../storage/db.ts'
import { workerStart } from './start-coordinator.ts'
import { resolveDeps, mahasError, type MaterializeRequest } from './deps.ts'
import type { TxnContext } from '../api/registry.ts'

type Fault = 'none' | 'retry-materialize' | 'reject-materialize' | 'unknown-spawn' | 'reject-spawn'
interface Fixture {
  db: ReturnType<typeof openControlDb>
  start: () => ReturnType<typeof workerStart>
  member: () => unknown
  plan: { launchPlanId: string; digest: string }
  spawns: number
  materializations: number
  setFault: (value: Fault) => void
  close: () => void
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'mahas-f064-'))
  const db = openControlDb(join(root, 'control.sqlite'))
  const runtime = await composeRuntime({
    db,
    configDir: root,
    endpoint: join(root, 'mahasd.sock'),
    controllerEpoch: 1,
    controllerIdentity: { pid: process.pid }
  })
  seedFixture(db)
  db.prepare(
    'INSERT INTO tasks(id,run_id,current_revision,current_dispatch_id) VALUES(?,?,1,NULL)'
  ).run('task-test', IDS.run)
  db.prepare(
    `INSERT INTO task_specs(task_id,revision,title,requirement_text,owner_role_id,assigned_member_id,inputs_json,outputs_json,settlement_policy_json)
    VALUES('task-test',1,'test','exact initial requirement',?,?,'[]','[]','{}')`
  ).run(IDS.role, IDS.member)
  db.prepare(
    "UPDATE assignments SET kind='task',task_id='task-test',task_revision=1 WHERE id=?"
  ).run(IDS.assignment)
  db.prepare("UPDATE work_envelopes SET kind='task' WHERE assignment_id=?").run(IDS.assignment)
  db.prepare('UPDATE harness_profiles SET recipe_json=? WHERE id=?').run(
    JSON.stringify({
      process: {
        executable: '/bin/true',
        argv: [{ literal: '/bin/true' }, { slot: 'fileText', source: 'role/mandatory.md' }],
        stdio: 'pipes'
      },
      routes: [
        { source: 'role/mandatory.md', kind: 'argv-text', required: true },
        { source: 'task/initial.txt', kind: 'stdin', required: true }
      ]
    }),
    IDS.profile
  )
  const blob = putContentBlob(
    db,
    Buffer.from(JSON.stringify({ mandateText: 'exact initial requirement' })),
    'application/json'
  )
  db.prepare('UPDATE work_envelopes SET body_digest=? WHERE assignment_id=?').run(
    blob.digest,
    IDS.assignment
  )
  const ctx = {
    principalId: 'operator-local',
    controllerEpoch: 1,
    grantRevisions: {},
    transportSessionId: 'f064'
  } as never
  const prepared = await runtime.registry.dispatch(ctx, {
    protocolVersion: '1',
    operation: 'worker.prepare',
    operationId: 'prepare',
    payload: {
      assignmentId: IDS.assignment,
      assignmentRevision: 1,
      implementationRevision: 1,
      harnessProfileRevision: 1,
      purpose: 'work',
      placementIntent: { hostId: IDS.host, kind: 'folder', targetPath: root }
    }
  } as never)
  assert.equal(prepared.status, 'committed', JSON.stringify(prepared))
  const plan = prepared.result as { launchPlanId: string; digest: string }
  let materializations = 0
  let spawns = 0
  let fault: Fault = 'none'
  const deps = resolveDeps({
    call: async () => ({
      workspace: { id: 'ws', state: 'ready' },
      checkout: { id: 'co', canonicalPath: root },
      effect: { state: 'confirmed' },
      claim: { id: 'claim-test', resourceId: 'resource-test' }
    }),
    materialize: async (req: MaterializeRequest) => {
      materializations++
      if (fault === 'retry-materialize')
        throw mahasError('CONTROL_UNAVAILABLE', 'injected temporary failure')
      if (fault === 'reject-materialize')
        throw mahasError('MANDATORY_COMPONENT_MISSING', 'injected missing component')
      assert.ok(req.envelope)
      assert.ok(req.envelope.initialText.includes('exact initial requirement'))
      const initialPayload = JSON.parse(req.envelope.initialText)
      assert.equal(initialPayload.bootstrap.join.payload.executionId, req.executionId)
      assert.equal(initialPayload.bootstrap.accept.payload.taskRevision, 1)
      assert.ok(initialPayload.bootstrap.accept.payload.dispatchId)
      const role = Buffer.from('required role')
      const initial = Buffer.from(req.envelope.initialText)
      return {
        executionRoot: join(root, req.executionId),
        manifestDigest: 'manifest',
        files: [
          {
            path: 'role/mandatory.md',
            digest: sha256Hex(role),
            byteLength: role.length,
            bytes: role,
            verified: true
          },
          {
            path: 'task/initial.txt',
            digest: sha256Hex(initial),
            byteLength: initial.length,
            bytes: initial,
            verified: true
          }
        ]
      }
    },
    host: async () => ({
      close() {
        /* No transport is allocated by this fault-injection double. */
      },
      async call<T>() {
        spawns++
        if (fault === 'unknown-spawn') throw new Error('injected response loss after spawn')
        if (fault === 'reject-spawn')
          return { spawn: { state: 'rejected', message: 'injected ENOENT' } } as T
        return { processIncarnation: { pid: 12345, spawnNonce: 'test-nonce' } } as T
      }
    })
  })
  const start = (): ReturnType<typeof workerStart> =>
    workerStart(
      { db, ctx } as unknown as TxnContext,
      { launchPlanId: plan.launchPlanId, planDigest: plan.digest },
      deps
    )
  const member = (): unknown =>
    db.prepare('SELECT current_execution_id FROM members WHERE id=?').get(IDS.member)!
      .current_execution_id
  return {
    db,
    start,
    member,
    plan,
    get spawns() {
      return spawns
    },
    get materializations() {
      return materializations
    },
    setFault(value: typeof fault) {
      fault = value
    },
    close() {
      runtime.close()
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

async function run(): Promise<void> {
  {
    const f = await fixture()
    try {
      f.setFault('retry-materialize')
      const first = await f.start()
      assert.equal(first.stageReceipt.failedStage, 'components_materialized')
      assert.equal(f.member(), first.executionId, 'retry must retain member binding')
      assert.equal(f.spawns, 0)
      f.setFault('none')
      const retried = await f.start()
      assert.equal(retried.executionId, first.executionId)
      assert.equal(retried.joinState, 'awaiting_join')
      assert.equal(retried.stageReceipt.failedStage, undefined)
      await f.start()
      assert.equal(f.spawns, 1, 'completed receipt replay must not respawn')
      console.log('PASS retryable failure preserves admission and resumes exactly once')
    } finally {
      f.close()
    }
  }
  for (const fault of ['reject-materialize', 'reject-spawn'] as const) {
    const f = await fixture()
    try {
      f.setFault(fault)
      const first = await f.start()
      assert.equal(f.member(), null)
      assert.equal(first.stageReceipt.admissionReleased, true)
      assert.equal(
        f.db
          .prepare('SELECT authority_state FROM dispatches WHERE execution_id=?')
          .get(first.executionId!)!.authority_state,
        'revoked'
      )
      assert.equal(
        f.db.prepare("SELECT current_dispatch_id FROM tasks WHERE id='task-test'").get()!
          .current_dispatch_id,
        null
      )
      assert.ok(first.stageReceipt.nextAllowedActions.includes('worker.release'))
      assert.equal(
        f.db
          .prepare('SELECT count(*) AS n FROM execution_credentials WHERE revoked_at IS NULL')
          .get()!.n,
        0
      )
      const count = f.spawns
      f.setFault('none')
      const replay = await f.start()
      assert.deepEqual(
        replay.stageReceipt.nextAllowedActions,
        first.stageReceipt.nextAllowedActions
      )
      assert.equal(f.spawns, count, 'definitive abort is replay only')
      console.log(`PASS ${fault}: admission released, credentials fenced, replay cannot spawn`)
    } finally {
      f.close()
    }
  }
  {
    const f = await fixture()
    try {
      f.setFault('unknown-spawn')
      const first = await f.start()
      assert.equal(first.joinState, 'process_attempting:unknown')
      assert.equal(f.member(), first.executionId)
      assert.equal(
        f.db
          .prepare('SELECT authority_state FROM dispatches WHERE execution_id=?')
          .get(first.executionId!)!.authority_state,
        'active'
      )
      assert.notEqual(first.stageReceipt.admissionReleased, true)
      f.setFault('none')
      await f.start()
      assert.equal(f.spawns, 1, 'unknown spawn must never be retried automatically')
      console.log('PASS lost spawn response preserves binding and forbids duplicate spawn')
    } finally {
      f.close()
    }
  }
  {
    const f = await fixture()
    try {
      f.setFault('reject-spawn')
      const first = await f.start()
      // Simulate a persisted pre-fix failure: confirmed no-spawn evidence,
      // but member still bound and no admissionReleased marker.
      const prior = first.stageReceipt
      delete prior.admissionReleased
      f.db
        .prepare('UPDATE effect_intents SET receipt_json=? WHERE id=?')
        .run(JSON.stringify(prior), `launch-progress:${f.plan.launchPlanId}`)
      f.db
        .prepare('UPDATE members SET current_execution_id=? WHERE id=?')
        .run(first.executionId!, IDS.member)
      await f.start()
      assert.equal(f.member(), null)
      assert.equal(f.spawns, 1)
      console.log('PASS legacy definitive failure receipt releases stranded member without respawn')
    } finally {
      f.close()
    }
  }
}
await run()
