// mahas-runtime/launch — C-LAUNCH boundary entrypoint (IMP-19/20).
//
// registerLaunchOps wires worker.prepare / worker.start / worker.inspect;
// registerJoinOps (execution.join / execution.heartbeat / task.accept) lives
// in join.ts and is re-exported here so the composition root has one path.
//
// The launch planners perform durable intent commits BETWEEN external
// effects (S-LIFECYCLE §3 spawn cut points). The registry's admission
// wrapper keeps those handlers OUTSIDE a single enclosing transaction —
// see deps.ts §tx for the integration note.

import type { OperationRegistry, TargetRef, TxnContext } from '../api/registry.ts'
import { workerPrepare } from './planner.ts'
import { workerStart, workerInspect } from './start-coordinator.ts'
import { resolveDeps, type LaunchDeps, type ResolvedDeps } from './deps.ts'

export function registerLaunchOps(
  registry: OperationRegistry,
  deps: LaunchDeps = {}
): ResolvedDeps {
  const d = resolveDeps(deps)

  const launchTargets = (txn: TxnContext, payload: unknown): TargetRef[] => {
    const p = (payload ?? {}) as { assignmentId?: string; launchPlanId?: string; executionId?: string }
    const targets: TargetRef[] = []
    if (typeof p.assignmentId === 'string' && p.assignmentId) {
      targets.push({ kind: 'assignment', id: p.assignmentId })
    }
    if (typeof p.launchPlanId === 'string' && p.launchPlanId) {
      targets.push({ kind: 'launchPlan', id: p.launchPlanId })
      const row = txn.db
        .prepare('SELECT pins_json FROM launch_plans WHERE id=?')
        .get(p.launchPlanId) as { pins_json?: string } | undefined
      try {
        const pins = row?.pins_json ? (JSON.parse(row.pins_json) as { run?: { id?: string }; member?: { id?: string } }) : {}
        if (pins.run?.id) targets.push({ kind: 'run', id: pins.run.id })
        if (pins.member?.id) targets.push({ kind: 'member', id: pins.member.id })
      } catch {
        /* pins are advisory for auth */
      }
    }
    if (typeof p.executionId === 'string' && p.executionId) {
      targets.push({ kind: 'execution', id: p.executionId })
    }
    return targets
  }
  registry.register(
    {
      name: 'worker.prepare',
      visibility: 'member',
      mutation: true,
      summary: 'resolve implementation/bundle/surface/inputs and pin a LaunchPlan (no process yet)',
      resolveTargets: launchTargets
    },
    (txn, payload) => workerPrepare(txn, payload, d)
  )
  registry.register(
    {
      name: 'worker.start',
      visibility: 'member',
      mutation: true,
      longPoll: true,
      summary: 'commit the Dispatch and drive materialize/spawn/attach through stage receipts',
      resolveTargets: launchTargets
    },
    (txn, payload) => workerStart(txn, payload, d)
  )
  registry.register(
    {
      name: 'worker.inspect',
      visibility: 'member',
      mutation: false,
      summary: 'execution/launch-plan projection with honest unknown states'
    },
    (txn, payload) => workerInspect(txn, payload, d)
  )

  return d
}

export { registerJoinOps } from './join.ts'
export type { JoinOpsDeps } from './join.ts'
export { workerPrepare } from './planner.ts'
export { workerStart, workerInspect } from './start-coordinator.ts'
export type { LaunchDeps, ResolvedDeps } from './deps.ts'
export { resolveDeps } from './deps.ts'
