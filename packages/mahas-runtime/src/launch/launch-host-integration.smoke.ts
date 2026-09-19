// Real deterministic integration: composeRuntime -> execution-host -> OS
// child -> worker-only RPC -> join -> accept -> compute -> report/settle ->
// stop/release -> physical checkout cleanup. No model calls.
// Run: node packages/mahas-runtime/src/launch/launch-host-integration.smoke.ts

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthenticatedContext, CommandReceipt } from '../../../mahas-contracts/src/index.ts'
import { bootstrapHost } from '../../../mahas-execution-host/src/host.ts'
import { registerProcessOps } from '../../../mahas-execution-host/src/process-manager.ts'
import { registerWorkspaceHostOps } from '../../../mahas-execution-host/src/workspace.ts'
import { IDS, seedFixture } from '../access/f062-assignment-service.smoke.ts'
import { composeRuntime } from '../composition.ts'
import { requiredActionsFor } from '../coordination/index.ts'
import { bindingToContextFields, authenticateWorkerCredential } from './bootstrap-credential.ts'
import { serveRpc, mahasdWorkerEndpoint } from '../rpc/index.ts'
import { openControlDb } from '../storage/db.ts'

const TASK_ID = 'task-f065'
const REQUIREMENT = 'Compute 17 + 25 and report the result after joining and accepting this task.'

function operatorContext(): AuthenticatedContext {
  return {
    principalId: 'operator-local' as never,
    controllerEpoch: 1 as never,
    grantRevisions: {},
    transportSessionId: 'f065-operator'
  }
}

function request(
  operation: string,
  operationId: string,
  payload: unknown
): { protocolVersion: string; operation: string; operationId: string; payload: unknown } {
  return { protocolVersion: '1', operation, operationId, payload }
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'mahas-launch-host-integration-'))
  const hostEndpoint = join(root, 'execution-host.sock')
  const workerEndpoint = mahasdWorkerEndpoint(root)
  const operatorEndpoint = join(root, 'mahasd.sock')
  const checkout = join(root, 'checkout')
  const barrier = join(root, 'worker-go.json')
  const workerResult = join(root, 'worker-result.json')
  const workerScript = join(
    dirname(fileURLToPath(import.meta.url)),
    'launch-host-integration-worker.ts'
  )
  const db = openControlDb(join(root, 'control.sqlite'))
  const host = await bootstrapHost({ endpoint: hostEndpoint, dbPath: join(root, 'host.sqlite') })
  const processes = registerProcessOps(host.registerHostOp, {
    db: host.db,
    hostId: host.identity.hostId,
    hostIncarnation: host.identity.hostIncarnation,
    pushEvent: (connectionId, event) => host.pushEvent({ ...event, connectionId }),
    assertMutationAllowed: (op, ctx) => host.assertMutationAllowed(op, ctx)
  })
  host.setDropConnection((connectionId) => processes.manager.terminals.dropConnection(connectionId))
  registerWorkspaceHostOps(
    (spec, handler) =>
      host.registerHostOp(
        spec.name,
        (payload, ctx) => handler({ db: ctx.db, envelope: ctx.envelope }, payload),
        { mutation: spec.mutation, requiresLease: spec.mutation }
      ),
    {}
  )

  const runtime = await composeRuntime({
    db,
    configDir: root,
    endpoint: operatorEndpoint,
    hostEndpoint,
    controllerEpoch: 1,
    controllerIdentity: { pid: process.pid, label: 'launch-host-integration' }
  })
  const workerRpc = serveRpc(runtime.registry, workerEndpoint, (credential) => {
    const c = credential as { kind?: string; credentialId?: string; secret?: string }
    if (c.kind !== 'worker' || !c.credentialId || !c.secret)
      throw { code: 'UNAUTHENTICATED', message: 'bad worker credential' }
    const binding = authenticateWorkerCredential(db, c.credentialId, c.secret)
    if (!binding) throw { code: 'UNAUTHENTICATED', message: 'bad worker credential' }
    return { ...bindingToContextFields(binding), transportSessionId: 'server-overrides-this' }
  })
  await workerRpc.ready

  try {
    seedFixture(db)
    // composeRuntime receives an already-acquired epoch in production.
    // This in-process fixture supplies that durable bootstrap precondition;
    // recovery's real controller-epoch checks remain enabled.
    db.prepare(
      `INSERT INTO runtime_instances(id,controller_epoch,state,process_identity_json,endpoint_incarnation)
      VALUES('lifecycle-test-runtime',1,'ready',?,'lifecycle-test-endpoint')`
    ).run(JSON.stringify({ pid: process.pid }))
    db.prepare('UPDATE projects SET repository_root=? WHERE id=?').run(root, IDS.project)
    db.prepare(
      'INSERT INTO tasks(id,run_id,current_revision,current_dispatch_id) VALUES(?,?,1,NULL)'
    ).run(TASK_ID, IDS.run)
    db.prepare(
      `INSERT INTO task_specs
       (task_id,revision,title,requirement_text,owner_role_id,assigned_member_id,inputs_json,outputs_json,settlement_policy_json)
       VALUES(?,1,?,?,?,?,'[]','[]','{}')`
    ).run(TASK_ID, 'Real launch-host integration', REQUIREMENT, IDS.role, IDS.member)
    db.prepare("UPDATE assignments SET kind='task',task_id=?,task_revision=1 WHERE id=?").run(
      TASK_ID,
      IDS.assignment
    )
    // The exported F-062 fixture intentionally uses a synthetic plaintext
    // blob key. Remove that coordination envelope so worker.prepare builds a
    // real task envelope with canonical JSON and a verified content digest.
    db.prepare('DELETE FROM work_envelopes WHERE assignment_id=?').run(IDS.assignment)
    db.prepare('UPDATE grants SET actions_json=? WHERE id=?').run(
      JSON.stringify(requiredActionsFor('task')),
      IDS.grant
    )
    db.prepare('UPDATE harness_profiles SET recipe_json=? WHERE id=?').run(
      JSON.stringify({
        process: {
          executable: process.execPath,
          argv: [{ literal: workerScript }, { slot: 'fileText', source: 'role/mandatory.md' }],
          env: { MAHAS_TEST_BARRIER: barrier, MAHAS_TEST_RESULT: workerResult },
          envAllowlist: ['PATH'],
          stdio: 'pipes'
        },
        routes: [
          { source: 'role/mandatory.md', kind: 'argv-text', required: true },
          { source: 'task/initial.txt', kind: 'stdin', required: true }
        ]
      }),
      IDS.profile
    )

    const hostId = runtime.localHost?.hostId
    assert.ok(hostId, 'composeRuntime must attach the bootstrapped host')
    const prepared = (await runtime.registry.dispatch(
      operatorContext(),
      request('worker.prepare', 'launch-host-prepare', {
        assignmentId: IDS.assignment,
        assignmentRevision: 1,
        implementationRevision: 1,
        harnessProfileRevision: 1,
        purpose: 'work',
        placementIntent: { hostId, kind: 'folder', targetPath: checkout }
      }) as never
    )) as CommandReceipt
    assert.equal(prepared.status, 'committed', JSON.stringify(prepared, null, 2))
    const plan = prepared.result as {
      launchPlanId: string
      digest: string
      pins: {
        bundle: { digest: string }
        surface: { digest: string }
        envelope: { digest: string }
      }
    }

    const started = (await runtime.registry.dispatch(
      operatorContext(),
      request('worker.start', 'launch-host-start', {
        launchPlanId: plan.launchPlanId,
        planDigest: plan.digest
      }) as never
    )) as CommandReceipt
    assert.equal(started.status, 'committed', JSON.stringify(started, null, 2))
    const startResult = started.result as {
      executionId: string
      generation: number
      dispatchId?: string
      joinState: string
    }
    assert.equal(startResult.joinState, 'awaiting_join', JSON.stringify(started, null, 2))
    const dispatch = db
      .prepare('SELECT id,task_revision,envelope_digest FROM dispatches WHERE execution_id=?')
      .get(startResult.executionId) as {
      id: string
      task_revision: number
      envelope_digest: string
    }
    // Readiness only: all authority-bearing join/accept pins must come from
    // the actual task/initial.txt bytes delivered over child stdin.
    writeFileSync(barrier, '{}')

    await waitForFile(workerResult)
    const result = JSON.parse(readFileSync(workerResult, 'utf8')) as {
      error?: string
      initialStdin: string
      join: CommandReceipt
      accept: CommandReceipt
      replay: CommandReceipt
      answer: number
      report: CommandReceipt
      reportReplay: CommandReceipt
    }
    assert.equal(result.error, undefined, result.error)
    assert.match(
      result.initialStdin,
      new RegExp(REQUIREMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    )
    const materializedStage = (
      startResult as unknown as {
        stageReceipt: { stages: Array<{ stage: string; receipt?: { executionRoot?: string } }> }
      }
    ).stageReceipt.stages.find((stage) => stage.stage === 'components_materialized')
    const executionRoot = materializedStage?.receipt?.executionRoot
    assert.ok(executionRoot, 'materialization receipt must expose executionRoot')
    assert.equal(result.initialStdin, readFileSync(join(executionRoot, 'task/initial.txt'), 'utf8'))
    assert.equal(result.join.status, 'committed')
    assert.equal(result.accept.status, 'committed')
    assert.deepEqual(result.replay.result, result.accept.result)
    assert.equal(result.replay.eventCursor, result.accept.eventCursor)
    assert.equal(
      db
        .prepare('SELECT count(*) AS n FROM worker_joins WHERE execution_id=?')
        .get(startResult.executionId)?.['n'],
      1
    )
    assert.equal(
      db.prepare('SELECT phase FROM dispatches WHERE id=?').get(dispatch.id)?.['phase'],
      'settled'
    )
    assert.equal(result.answer, 42)
    assert.equal(result.report.status, 'committed')
    assert.equal((result.report.result as { settlementState: string }).settlementState, 'accepted')
    assert.deepEqual(result.reportReplay.result, result.report.result)
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM outcomes WHERE dispatch_id=?').get(dispatch.id)?.['n'],
      1
    )
    const outcome = db
      .prepare('SELECT id,revision,result,rationale FROM outcomes WHERE dispatch_id=?')
      .get(dispatch.id)!
    assert.equal(outcome.result, 'succeeded')
    assert.equal(outcome.rationale, 'Computed result: 42')
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM settlements WHERE outcome_id=? AND outcome_revision=? AND decision='accepted'"
        )
        .get(outcome.id, outcome.revision)?.['n'],
      1
    )
    assert.equal(
      db.prepare('SELECT authority_state FROM dispatches WHERE id=?').get(dispatch.id)?.[
        'authority_state'
      ],
      'settled'
    )
    assert.equal(
      host.db
        .prepare('SELECT count(*) AS n FROM host_processes WHERE execution_id=?')
        .get(startResult.executionId)?.['n'],
      1
    )
    const exitDeadline = Date.now() + 5_000
    while (
      host.db
        .prepare('SELECT state FROM host_processes WHERE execution_id=?')
        .get(startResult.executionId)?.['state'] !== 'exited'
    ) {
      if (Date.now() > exitDeadline)
        throw new Error('fake worker did not exit after writing its receipts')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const replayStart = (await runtime.registry.dispatch(
      operatorContext(),
      request('worker.start', 'launch-host-start', {
        launchPlanId: plan.launchPlanId,
        planDigest: plan.digest
      }) as never
    )) as CommandReceipt
    assert.equal(
      (replayStart.result as { executionId?: string }).executionId,
      startResult.executionId
    )
    assert.equal((replayStart.result as { joinState?: string }).joinState, startResult.joinState)
    assert.equal(replayStart.eventCursor, started.eventCursor)
    assert.equal(
      host.db
        .prepare('SELECT count(*) AS n FROM host_processes WHERE execution_id=?')
        .get(startResult.executionId)?.['n'],
      1
    )

    const execution = db
      .prepare('SELECT generation,process_identity_json FROM executions WHERE id=?')
      .get(startResult.executionId)!
    const stopped = (await runtime.registry.dispatch(
      operatorContext(),
      request('worker.stop', 'launch-host-stop', {
        executionId: startResult.executionId,
        expectedGeneration: execution.generation,
        expectedProcessIncarnation: JSON.parse(String(execution.process_identity_json)),
        mode: 'graceful',
        reason: 'task settled; lifecycle test cleanup'
      }) as never
    )) as CommandReceipt
    assert.equal(stopped.status, 'committed', JSON.stringify(stopped))
    assert.equal((stopped.result as { state: string }).state, 'exited', JSON.stringify(stopped))
    assert.equal(
      db.prepare('SELECT liveness FROM executions WHERE id=?').get(startResult.executionId)?.[
        'liveness'
      ],
      'exited'
    )
    assert.equal(
      db
        .prepare(
          'SELECT count(*) AS n FROM execution_credentials WHERE execution_id=? AND revoked_at IS NULL'
        )
        .get(startResult.executionId)?.['n'],
      0
    )
    const claims = db
      .prepare(
        "SELECT id,revision FROM resource_claims WHERE owner_kind='execution' AND owner_id=? AND state!='released'"
      )
      .all(startResult.executionId)
    assert.ok(claims.length > 0, 'cleanup must exercise a real held workspace claim')
    const released = (await runtime.registry.dispatch(
      operatorContext(),
      request('worker.release', 'launch-host-release', {
        executionId: startResult.executionId,
        resourceDisposition: 'release',
        dirtyDecision: 'discard',
        expectedClaims: claims.map((c) => ({ claimId: c.id, expectedRevision: c.revision }))
      }) as never
    )) as CommandReceipt
    assert.equal(released.status, 'committed', JSON.stringify(released))
    const disposition = released.result as {
      overallOutcome: string
      results: Array<{ outcome: string }>
    }
    assert.equal(disposition.overallOutcome, 'complete', JSON.stringify(released))
    assert.ok(
      disposition.results.every((r) => r.outcome === 'released'),
      JSON.stringify(released)
    )
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM resource_claims WHERE owner_kind='execution' AND owner_id=? AND state!='released'"
        )
        .get(startResult.executionId)?.['n'],
      0
    )
    assert.equal(
      db.prepare('SELECT current_execution_id FROM members WHERE id=?').get(IDS.member)?.[
        'current_execution_id'
      ],
      null
    )
    assert.equal(
      db.prepare('SELECT current_dispatch_id FROM tasks WHERE id=?').get(TASK_ID)?.[
        'current_dispatch_id'
      ],
      null
    )
    assert.equal(
      db
        .prepare(
          'SELECT state FROM workspaces WHERE checkout_id IN (SELECT id FROM checkouts WHERE canonical_path=?)'
        )
        .get(checkout)?.['state'],
      'released'
    )
    assert.equal(existsSync(checkout), false, 'host must physically remove the disposable checkout')

    console.log('PASS real host/runtime task lifecycle integration')
    console.log('  actual: workspace prepare -> process spawn -> initial stdin bytes')
    console.log(
      '  worker RPC: bootstrap auth -> join -> accept -> compute 42 -> report -> accepted settlement'
    )
    console.log('  replay: start/accept/report did not duplicate process or outcome')
    console.log(
      '  cleanup: process exited -> worker.stop -> worker.release; no held claims/member/task binding'
    )
  } finally {
    // dispose() deliberately preserves workers for production reattach. A
    // smoke test owns its children, so drain any survivor before removing its
    // execution root (including assertion/timeout paths).
    const survivors = host.db
      .prepare(
        "SELECT spawn_nonce,identity_json FROM host_processes WHERE state NOT IN ('exited','spawn_rejected')"
      )
      .all() as Array<{ spawn_nonce: string; identity_json: string }>
    if (survivors.length > 0) {
      const client = await runtime.hostClient(host.identity.hostId).catch(() => null)
      for (const survivor of survivors) {
        if (!client) break
        let processIncarnation: unknown = { spawnNonce: survivor.spawn_nonce }
        try {
          processIncarnation = JSON.parse(survivor.identity_json)
        } catch {
          /* use nonce */
        }
        await client
          .call('host.process.stop', {
            effectKey: `launch-host-test-cleanup:${survivor.spawn_nonce}`,
            processIncarnation,
            mode: 'immediate',
            graceBudget: 100
          })
          .catch(() => undefined)
      }
    }
    await workerRpc.close()
    runtime.close()
    processes.dispose()
    await host.close()
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
}

await main()
