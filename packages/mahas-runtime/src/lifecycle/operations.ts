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
import type { OperationHandler, OperationSpec, TxnContext } from '../api/registry.ts'
import type { MahasdLifecycle } from './lifecycle.ts'
import { fail } from './readiness.ts'
import type { ReconcileScope } from './reconcile.ts'
import type { RuntimeStatusReport, ReconcileReport } from './types.ts'

export interface RuntimeOpsDeps {
  lifecycle: MahasdLifecycle
  /** schedules post-commit work (drain stages). main.ts supplies setImmediate. */
  enqueueAfterCommit: (fn: () => void) => void
}

interface StatusPayload {
  detail?: 'summary' | 'full'
}

interface ReconcilePayload {
  scope?: ReconcileScope
  expectedEpoch?: number
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
    { name: 'runtime.reconcile', visibility: 'operator', mutation: false },
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
      const report = await lifecycle.reconcile(p.scope ?? {}, txn.db)
      return report
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
