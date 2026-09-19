// F-064 resource-gate regression: a committed workspace.prepare operation is
// not enough to authorize spawn.  The nested workspace/effect verdicts must
// be ready/confirmed, and a held claim remains visible on rejected/unknown
// outcomes.
//
// Run: node packages/mahas-runtime/src/launch/workspace-gate.smoke.ts

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IDS, seedFixture } from '../access/f062-assignment-service.smoke.ts'
import { composeRuntime } from '../composition.ts'
import { openControlDb } from '../storage/db.ts'
import { workerStart } from './start-coordinator.ts'
import { resolveDeps } from './deps.ts'
import type { TxnContext } from '../api/registry.ts'

type GateVerdict = 'rejected' | 'unknown'

interface Fixture {
  db: ReturnType<typeof openControlDb>
  plan: { launchPlanId: string; digest: string }
  start: () => ReturnType<typeof workerStart>
  calls: () => number
  materializations: () => number
  spawns: () => number
  close: () => void
}

async function fixture(verdict: GateVerdict): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'mahas-workspace-gate-'))
  const db = openControlDb(join(root, 'control.sqlite'))
  const runtime = await composeRuntime({
    db,
    configDir: join(root, 'config'),
    endpoint: join(root, 'mahasd.sock'),
    controllerEpoch: 1,
    controllerIdentity: { pid: process.pid, label: 'workspace-gate-smoke' }
  })
  seedFixture(db)

  const ctx = {
    principalId: IDS.member,
    memberId: IDS.member,
    controllerEpoch: 1,
    grantRevisions: { [IDS.grant]: 1 },
    transportSessionId: 'workspace-gate-smoke'
  } as never
  const prepared = await runtime.registry.dispatch(ctx, {
    protocolVersion: 'workspace-gate/1',
    operation: 'worker.prepare',
    operationId: 'workspace-gate-prepare',
    payload: {
      assignmentId: IDS.assignment,
      assignmentRevision: 1,
      implementationRevision: 1,
      harnessProfileRevision: 1,
      purpose: 'work',
      placementIntent: { hostId: IDS.host, kind: 'folder', targetPath: root }
    }
  } as never)
  assert.equal(prepared.status, 'committed', JSON.stringify(prepared, null, 2))
  const plan = prepared.result as { launchPlanId: string; digest: string }

  let calls = 0
  let materializations = 0
  let spawns = 0
  const resourceResult = {
    workspace: {
      id: `workspace-${verdict}`,
      state: verdict === 'rejected' ? 'failed' : 'prepare-unknown'
    },
    checkout: {
      id: `checkout-${verdict}`,
      // Deliberately not an existing directory: the coordinator must reject
      // before materialize/spawn ever receives this path.
      canonicalPath: join(root, 'not-created')
    },
    claim: { id: `claim-${verdict}`, resourceId: `resource-${verdict}` },
    effect: {
      state: verdict === 'rejected' ? 'rejected' : 'unknown',
      receipt:
        verdict === 'rejected'
          ? { reason: { code: 'INPUT_NOT_READY', message: 'projectRoot was not supplied' } }
          : { reason: { code: 'START_UNKNOWN', message: 'host response was lost' } },
      residuals: [{ resourceRef: `checkout-${verdict}`, reason: 'preserve-until-reconciled' }]
    }
  }
  const deps = resolveDeps({
    call: async () => {
      calls++
      // makeCaller unwraps the outer command receipt.  The resource verdict
      // still lives in these nested workspace/effect fields; no outer
      // committed status is consulted by the launch stage.
      return resourceResult
    },
    materialize: async (): Promise<never> => {
      materializations++
      throw new Error('materialize must not run after a rejected/unknown workspace')
    },
    host: async () => ({
      close(): void {
        void 0
      },
      async call<T>(): Promise<T> {
        spawns++
        throw new Error('spawn must not run after a rejected/unknown workspace')
      }
    })
  })
  const start = (): ReturnType<typeof workerStart> =>
    workerStart(
      { db, ctx } as unknown as TxnContext,
      { launchPlanId: plan.launchPlanId, planDigest: plan.digest },
      deps
    )

  return {
    db,
    plan,
    start,
    calls: () => calls,
    materializations: () => materializations,
    spawns: () => spawns,
    close: () => {
      runtime.close()
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

async function run(): Promise<void> {
  {
    const f = await fixture('rejected')
    try {
      const result = await f.start()
      assert.equal(result.stageReceipt.failedStage, 'resources_claimed')
      assert.equal(
        result.stageReceipt.stages.find((s) => s.stage === 'resources_claimed')?.status,
        'failed'
      )
      assert.equal(
        result.stageReceipt.stages.find((s) => s.stage === 'resources_claimed')?.error?.code,
        'INPUT_NOT_READY'
      )
      assert.equal(f.calls(), 1)
      assert.equal(f.materializations(), 0)
      assert.equal(f.spawns(), 0)
      assert.equal(
        f.db
          .prepare('SELECT state FROM effect_intents WHERE id=?')
          .get(`${f.plan.launchPlanId}:effect:resources`)?.state,
        'rejected'
      )
      const residuals = result.stageReceipt.residuals as Array<{ kind?: string; ref?: string }>
      assert.ok(residuals.some((r) => r.kind === 'checkout' && r.ref === 'checkout-rejected'))
      assert.ok(residuals.some((r) => r.kind === 'resource-claim' && r.ref === 'claim-rejected'))
      console.log('PASS rejected workspace never reaches spawn and preserves claim residuals')
    } finally {
      f.close()
    }
  }

  {
    const f = await fixture('unknown')
    try {
      const result = await f.start()
      assert.equal(result.joinState, 'resources_claimed:unknown')
      assert.equal(
        result.stageReceipt.stages.find((s) => s.stage === 'resources_claimed')?.error?.code,
        'START_UNKNOWN'
      )
      assert.equal(f.calls(), 1)
      assert.equal(f.materializations(), 0)
      assert.equal(f.spawns(), 0)
      const residuals = result.stageReceipt.residuals as Array<{ kind?: string; ref?: string }>
      assert.ok(residuals.some((r) => r.kind === 'checkout' && r.ref === 'checkout-unknown'))
      assert.ok(residuals.some((r) => r.kind === 'resource-claim' && r.ref === 'claim-unknown'))

      // The persisted unknown stage is reconcile-only; replay cannot invoke
      // workspace.prepare a second time under a fresh operation.
      const replay = await f.start()
      assert.equal(replay.joinState, 'resources_claimed:unknown')
      assert.equal(f.calls(), 1)
      assert.equal(f.materializations(), 0)
      assert.equal(f.spawns(), 0)
      console.log('PASS unknown workspace preserves uncertainty/claims and forbids replay')
    } finally {
      f.close()
    }
  }
}

await run()
