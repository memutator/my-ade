// Opt-in real Codex interactive PTY spawn probe. Requires installed/logged-in
// Codex; may start a model turn. Stops as soon as the TUI frame is observed.
// Intentionally fails if managed launch cannot reach awaiting_join.
// Run: node packages/mahas-runtime/src/launch/real-codex-pty.manual.ts

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { AttachResult } from '../../../mahas-execution-host/src/terminal-stream.ts'
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
const REQUIREMENT =
  'This is a TUI spawn smoke test. Do not use tools or call any operations. Reply only PTY-TUI-OK.'

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

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'mahas-launch-host-integration-'))
  const hostEndpoint = join(root, 'execution-host.sock')
  const workerEndpoint = mahasdWorkerEndpoint(root)
  const operatorEndpoint = join(root, 'mahasd.sock')
  const checkout = join(root, 'checkout')
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
          executable: execFileSync('which', ['codex'], { encoding: 'utf8' }).trim(),
          argv: [
            { literal: '--no-alt-screen' },
            { literal: '-s' },
            { literal: 'read-only' },
            { literal: '-a' },
            { literal: 'never' },
            { literal: '-c' },
            { literal: 'check_for_update_on_startup=false' },
            { literal: '-c' },
            { literal: 'developer_instructions="Only verify TUI startup. Do not use tools."' },
            { literal: '-c' },
            { literal: 'projects.' + JSON.stringify(checkout) + '.trust_level="trusted"' },
            {
              slot: 'configText',
              key: 'user_instructions',
              format: 'toml-basic-string',
              source: 'role/mandatory.md'
            },
            { slot: 'fileText', source: 'task/initial.txt' }
          ],
          env: { TERM: 'xterm-256color', MAHAS_CONFIG_DIR: root },
          envAllowlist: ['PATH', 'HOME', 'TERM', 'LANG'],
          stdio: 'pty',
          terminalSize: { cols: 110, rows: 32 }
        },
        routes: [
          { source: 'role/mandatory.md', kind: 'argv-config-text', required: true },
          { source: 'task/initial.txt', kind: 'argv-text', required: true }
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
    console.log('MANAGED_START', startResult.joinState)
    console.log(
      'FAILED_STAGE',
      JSON.stringify(
        (
          started.result as { stageReceipt: { stages: Array<{ status: string }> } }
        ).stageReceipt.stages.filter((s) => s.status === 'failed')
      )
    )

    const proc = host.db
      .prepare('SELECT * FROM host_processes WHERE execution_id=?')
      .get(startResult.executionId)!
    const terminal = host.db
      .prepare('SELECT id FROM host_terminals WHERE spawn_nonce=?')
      .get(proc.spawn_nonce)!
    assert.ok(terminal?.id, 'actual PTY must have a terminal record')
    const client = await runtime.hostClient(host.identity.hostId)
    let screen = ''
    let raw = ''
    let replied = false
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const attached = await client.call<AttachResult>('host.terminal.attach', {
        terminalId: terminal.id
      })
      screen = attached.snapshot.screen.lines.join('\n')
      raw = attached.replay.map((c) => Buffer.from(c.d, 'base64').toString('utf8')).join('')
      if (!replied && raw.includes('\x1b[6n')) {
        await client.call('host.terminal.input', {
          terminalId: terminal.id,
          inputBytes: Buffer.from('\x1b[1;1R').toString('base64'),
          inputLeaseRevision: 1,
          expectedHostIncarnation: host.identity.hostIncarnation,
          effectKey: 'tui-cursor-query'
        })
        replied = true
      }
      if (/OpenAI Codex|Welcome to Codex|Codex \(v/.test(screen)) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    console.log('TUI_SCREEN_BEGIN\n' + screen + '\nTUI_SCREEN_END')
    assert.match(screen, /OpenAI Codex|Welcome to Codex|Codex \(v/)
    const identity = JSON.parse(String(proc.identity_json))
    const stdinTarget = readFileSync('/proc/' + identity.pid + '/stat', 'utf8')
    assert.ok(stdinTarget.length > 0, 'real process must be alive')
    console.log('PASS host spawned actual Codex interactive PTY TUI')
    console.log(
      JSON.stringify({
        executionId: startResult.executionId,
        terminalId: terminal.id,
        pid: identity.pid,
        joinState: startResult.joinState
      })
    )
    assert.equal(
      startResult.joinState,
      'awaiting_join',
      'managed launch must finish registering the real PTY'
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
