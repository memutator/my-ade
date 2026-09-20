// mahas-runtime / lifecycle — the C-RECOVERY operation handlers.
//
// registerRuntimeOps(registry, deps) is the boundary's public seam: IMP-30
// wires a real OperationRegistry + deps, the CLI/desktop reach these ops
// through connectRpc (IMP-12).
//
//   runtime.status    — read only; controller/host health, epochs, schema,
//                       reconciliation blockers. Always answered, even while
//                       unavailable for mutations (honesty ≠ silence).
//   runtime.reconcile — operator/recovery lever. Performs host probes and
//                       its own staged writes — registered mutation:false so
//                       the registry does NOT hold a write tx across network
//                       I/O (spec/storage.md §4). Idempotent by nature.
//   runtime.shutdown  — operator only. The in-tx half stops admissions and
//                       writes the durable runtime_shutdowns record; the
//                       drain stages run after the receipt commits.

import type { MahasError } from '../../../mahas-contracts/src/index.ts'
import type { OperationHandler, OperationSpec, TargetRef, TxnContext } from '../api/registry.ts'
import type { MahasdLifecycle } from './lifecycle.ts'
import { fail } from './readiness.ts'
import type { ReconcileScope } from './reconcile.ts'
import { mapRecoveryReconcileDecision } from './recovery-map.ts'
import type { RuntimeStatusReport, ReconcileReport } from './types.ts'

export interface RuntimeOpsDeps {
  lifecycle: MahasdLifecycle
  /** schedules post-commit work (drain stages). main.ts supplies setImmediate. */
  enqueueAfterCommit: (fn: () => void) => void
  /** IMP-22 probe+birth engine; optional so tests can register without recovery */
  reconcileExecutions?: (
    db: import('node:sqlite').DatabaseSync,
    ctx: import('../api/handler-ports.ts').TxnContext['ctx'],
    scope: ReconcileScope
  ) => Promise<unknown>
}

interface StatusPayload {
  detail?: 'summary' | 'full'
}

interface ReconcilePayload {
  scope?: ReconcileScope
  expectedEpoch?: number
}

/**
 * runtime.reconcile actual targets (F-005): the pass is scoped — either one
 * host, one execution, or the whole runtime (the caller's own controller
 * epoch as the runtime-instance anchor). Returned as real TargetRefs so the
 * pipeline's coverage check has something to evaluate instead of refusing the
 * op for lack of a resolver.
 */
function reconcileResolveTargets(txn: TxnContext, raw: unknown): TargetRef[] {
  const p = (raw ?? {}) as ReconcilePayload
  const scope = p.scope ?? {}
  const targets: TargetRef[] = []
  if (scope.hostId) targets.push({ kind: 'host', id: scope.hostId })
  if (scope.executionId) targets.push({ kind: 'execution', id: scope.executionId })
  if (targets.length === 0) {
    targets.push({ kind: 'runtimeInstance', id: String(txn.ctx.controllerEpoch ?? 0) })
  }
  return targets
}

interface ShutdownPayload {
  mode?: string
  targetedExecutionIds?: string[]
  timeoutBudgetMs?: number
  reason?: string
}

/** minimal registration port — IMP-11's full OperationRegistry satisfies it */
export interface RuntimeOpRegistry {
  register(spec: OperationSpec, handler: OperationHandler): void
}

export function registerRuntimeOps(registry: RuntimeOpRegistry, deps: RuntimeOpsDeps): void {
  const { lifecycle } = deps

  registry.register(
    { name: 'runtime.status', visibility: 'operator', mutation: false },
    (txn: TxnContext, payload: unknown): RuntimeStatusReport => {
      const report = lifecycle.statusReport(txn.db)
      const p = (payload ?? {}) as StatusPayload
      if (p.detail === 'summary' && report.reconciliation.lastReport) {
        // summary keeps the blockers but drops the full decision list
        return {
          ...report,
          reconciliation: {
            ...report.reconciliation,
            lastReport: { ...report.reconciliation.lastReport, decisions: [] }
          }
        }
      }
      return report
    }
  )

  registry.register(
    {
      name: 'runtime.reconcile',
      visibility: 'operator',
      mutation: true,
      summary: 'probe hosts/executions and apply restart reconciliation decisions',
      // F-005: the pass must be reachable over RPC. mutation:true makes the
      // pipeline hold a TRACKED write transaction (markTxOpen) so reconcile's
      // inner withTx() degrades to a SAVEPOINT instead of issuing a second
      // BEGIN on the same connection (ERR_SQLITE_ERROR). longPoll keeps the
      // host-probe network I/O out of that transaction — reconcile applies its
      // own staged withTx writes, exactly as spec/storage.md §4 requires.
      longPoll: true,
      inputSchema: {
        type: 'object',
        properties: {
          scope: {
            type: 'object',
            properties: { hostId: { type: 'string' }, executionId: { type: 'string' } }
          },
          expectedEpoch: { type: 'integer' }
        },
        additionalProperties: false
      },
      resolveTargets: reconcileResolveTargets
    },
    async (txn: TxnContext, payload: unknown): Promise<ReconcileReport> => {
      const p = (payload ?? {}) as ReconcilePayload
      if (p.expectedEpoch != null && p.expectedEpoch !== lifecycle.epoch) {
        fail({
          code: 'STALE_REVISION',
          message:
            `expectedEpoch ${p.expectedEpoch} != current controllerEpoch ${lifecycle.epoch} — ` +
            `reconcile against the current epoch only`,
          retry: 'reconcile'
        } satisfies MahasError)
      }
      if (lifecycle.reconcileState === 'running') {
        fail({
          code: 'OPERATION_CONFLICT',
          message: 'a reconcile pass is already running — poll runtime.status',
          retry: 'same-operation'
        } satisfies MahasError)
      }
      const scope = p.scope ?? {}
      const report = await lifecycle.reconcile(scope, txn.db)
      if (!deps.reconcileExecutions) return report
      const extra = (await deps.reconcileExecutions(txn.db, txn.ctx, scope)) as {
        decisions?: Array<{ executionId?: string; decision?: string; basis?: string }>
        orphans?: Array<{ executionId?: string; id?: string; detail?: string }>
        unreconciledEffects?: Array<{ effectId?: string; detail?: string }>
        nextAllowedActions?: string[]
      }
      const mapped: ReconcileReport['decisions'] = [...report.decisions]
      for (const d of extra.decisions ?? []) {
        if (!d.executionId) continue
        mapped.push({
          targetKind: 'execution',
          targetId: d.executionId,
          decision: mapRecoveryReconcileDecision(d.decision),
          evidence: d.basis ?? d.decision ?? ''
        })
      }
      const unresolved = [...report.unresolvedResources]
      for (const o of extra.orphans ?? []) {
        unresolved.push({
          kind: 'orphan',
          id: o.executionId ?? o.id ?? 'unknown',
          reason: o.detail ?? 'orphan process'
        })
      }
      for (const e of extra.unreconciledEffects ?? []) {
        unresolved.push({
          kind: 'effect',
          id: e.effectId ?? 'unknown',
          reason: e.detail ?? 'unreconciled effect'
        })
      }
      return {
        ...report,
        decisions: mapped,
        unresolvedResources: unresolved,
        nextAllowedActions: [
          ...new Set([...report.nextAllowedActions, ...(extra.nextAllowedActions ?? [])])
        ]
      }
    }
  )

  registry.register(
    { name: 'runtime.shutdown', visibility: 'operator', mutation: true },
    (
      txn: TxnContext,
      payload: unknown
    ): {
      operationId: string
      mode: string
      state: string
      stages: unknown
      residuals: unknown
    } => {
      const p = (payload ?? {}) as ShutdownPayload
      const { req, stages, residuals } = lifecycle.initiateShutdown(txn.db, p)
      // continuation runs after this receipt commits — see module header
      lifecycle.scheduleShutdown(req, stages, residuals, deps.enqueueAfterCommit)
      return {
        operationId: req.operationId,
        mode: req.mode,
        state: 'in-progress',
        stages,
        residuals
      }
    }
  )
}
