// mahas-runtime / lifecycle — the MahasdLifecycle orchestrator.
//
// Owns the startup readiness sequence and the operator-facing levers the
// runtime.* operations call:
//   open DB → schema check → new controller epoch → prior-instance honesty
//   → endpoint publication (main.ts) → host-lease reconcile pass → pending
//   effect/claim 대조 → only THEN writable readiness.
//
// Everything that could outlive a dispatch transaction (a drain, a running
// reconcile) lives here as explicit state — never inside a handler.

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { MahasError } from '../../../mahas-contracts/src/index.ts'
import type {
  ExecutionHostRow,
  HostStatusItem,
  LifecycleDeps,
  ProcessIdentity,
  ReconcileReport,
  RuntimeInstanceRow,
  RuntimeShutdownRow,
  RuntimeStatusReport,
  ShutdownMode
} from './types.ts'
import { ReadinessTracker, fail } from './readiness.ts'
import {
  loadHosts,
  loadLeases,
  loadOpenShutdowns,
  loadPendingEffects,
  markPriorInstancesStopped,
  runReconcile,
  type ReconcileScope
} from './reconcile.ts'
import {
  beginShutdownRecord,
  latestShutdown,
  runShutdownStages,
  type ShutdownRequest
} from './shutdown.ts'
import type { verdictForProcess } from './service-bootstrap.ts'

export interface LifecycleOptions extends LifecycleDeps {
  controllerIdentity: ProcessIdentity
  endpointIncarnation: string
  /** host probe round timeout; keeps startup bounded */
  hostProbeTimeoutMs?: number
}

export class MahasdLifecycle {
  readonly readiness = new ReadinessTracker()
  readonly deps: LifecycleOptions
  epoch = 0
  instanceId: string | null = null
  reconcileState: 'never-run' | 'running' | 'completed' | 'blocked' = 'never-run'
  lastReconcile: ReconcileReport | null = null
  readonly startedAt: number
  private draining = false
  private teardownHook: ((operationId: string) => void | Promise<void>) | null = null

  constructor(deps: LifecycleOptions) {
    this.deps = deps
    this.startedAt = deps.now()
  }

  // -- startup ---------------------------------------------------------------

  /**
   * Insert this process's runtime_instances row with a fresh monotonically
   * increasing controller epoch. The UNIQUE epoch column is the fence that
   * keeps a zombie prior controller's writes out — a prior process cannot
   * have a higher epoch, and every old ack/report carries its stale one.
   */
  acquireControllerEpoch(endpointIncarnation: string): number {
    const row = this.deps.withTx(this.deps.db, (tx) => {
      const max = tx.prepare(`SELECT MAX(controller_epoch) AS m FROM runtime_instances`).get() as {
        m: number | null
      }
      const epoch = (max.m ?? 0) + 1
      const id = `rt-${randomUUID()}`
      tx.prepare(
        `INSERT INTO runtime_instances(id, controller_epoch, state, process_identity_json, endpoint_incarnation)
         VALUES(?,?,?,?,?)`
      ).run(
        id,
        epoch,
        'starting',
        JSON.stringify(this.deps.controllerIdentity),
        endpointIncarnation
      )
      return { id, epoch }
    })
    this.instanceId = row.id
    this.epoch = row.epoch
    this.readiness.mark('epoch-acquired')
    return row.epoch
  }

  /** mark prior non-terminal instances + interrupted shutdowns (spec restart step 2) */
  markPriors(
    verdictFor: (identity: {
      pid: number
      birthEvidence?: string
      bootId?: string
    }) => ReturnType<typeof verdictForProcess>
  ): void {
    if (!this.instanceId) throw new Error('acquireControllerEpoch must run first')
    const decisions: ReconcileReport['decisions'] = []
    markPriorInstancesStopped(
      this.deps.db,
      this.deps.withTx,
      this.instanceId,
      verdictFor,
      decisions
    )
    for (const d of decisions) {
      this.deps.log({ t: 'reconcile.prior', ...d })
    }
  }

  /**
   * The startup reconcile pass — its COMPLETION (not its verdict) is what
   * opens writable readiness. Unresolved scopes stay listed as blockers;
   * ops touching them fail on their own lease/epoch checks.
   */
  async startupReconcile(): Promise<ReconcileReport> {
    this.readiness.setState('reconciling')
    try {
      return await this.reconcile({})
    } catch (err) {
      // a reconcile pass that cannot even run (DB read failure etc.) must
      // NOT publish writable readiness — the plane stays honestly blocked
      this.readiness.addBlocker(
        `startup reconcile failed: ${err instanceof Error ? err.message : String(err)}`
      )
      throw err
    }
  }

  // -- reconcile (also backs runtime.reconcile) --------------------------------

  /**
   * Run a reconcile pass over an optional scope. `txDb` lets the operation
   * handler fall back to the dispatch transaction's own connection when the
   * registry has already opened it — the apply phase can then write through
   * that tx instead of nesting a second one.
   */
  async reconcile(scope: ReconcileScope, txDb?: DatabaseSync): Promise<ReconcileReport> {
    this.reconcileState = 'running'
    let report: ReconcileReport
    try {
      report = await runReconcile(
        {
          db: this.deps.db,
          withTx: this.deps.withTx,
          connectHost: this.deps.connectHost,
          controllerEpoch: this.epoch,
          controllerIdentity: this.deps.controllerIdentity,
          hostEndpoint: this.deps.hostEndpoint ?? defaultHostEndpoint,
          hostProbeTimeoutMs: this.deps.hostProbeTimeoutMs ?? 5_000,
          now: this.deps.now,
          log: this.deps.log
        },
        scope
      )
    } catch (err) {
      this.reconcileState = 'blocked'
      throw err
    }
    void txDb // nested-tx fallback reserved for the op handler path
    this.reconcileState = 'completed'
    this.lastReconcile = report
    for (const u of report.unresolvedResources) {
      this.readiness.addBlocker(`${u.kind} ${u.id}: ${u.reason}`)
    }
    // a completed pass — startup's or an operator's — is what opens writable
    // readiness. The pass must FINISH; its unresolved list may be non-empty.
    if (
      this.readiness.snapshot().state === 'reconciling' ||
      this.readiness.snapshot().state === 'starting'
    ) {
      this.readiness.mark('reconcile-pass')
      this.readiness.mark('writable')
      this.readiness.setState('ready')
      if (this.instanceId) {
        this.deps.withTx(this.deps.db, (tx) => {
          tx.prepare(`UPDATE runtime_instances SET state = 'ready' WHERE id = ?`).run(
            this.instanceId
          )
        })
      }
    }
    this.deps.log({
      t: 'reconcile.pass',
      epoch: this.epoch,
      decisions: report.decisions.length,
      unresolved: report.unresolvedResources.length
    })
    return report
  }

  // -- runtime.status ----------------------------------------------------------

  statusReport(db: DatabaseSync): RuntimeStatusReport {
    const snap = this.readiness.snapshot()
    const hosts = loadHosts(db)
    const leases = new Map(loadLeases(db).map((l) => [l.host_id, l]))
    const probe = this.lastReconcile
    const hostItems: HostStatusItem[] = hosts.map((h: ExecutionHostRow) => {
      const lease = leases.get(h.id)
      const decision = probe?.decisions.find((d) => d.targetKind === 'host' && d.targetId === h.id)
      return {
        hostId: h.id,
        incarnation: h.incarnation,
        reachable:
          h.state === 'leased' || h.state === 'reachable'
            ? true
            : h.state === 'unreachable'
              ? false
              : 'unverifiable',
        leaseEpoch: lease?.epoch ?? null,
        leaseState: lease?.state ?? null,
        detail: decision?.evidence
      }
    })
    const pending = loadPendingEffects(db).length
    const shutdown = latestShutdown(db)
    const openShutdowns = loadOpenShutdowns(db)
    let schemaVersion: number | null = null
    try {
      const row = db
        .prepare(
          `SELECT value FROM schema_meta WHERE key IN ('schema_version','schemaVersion','version') LIMIT 1`
        )
        .get() as { value: string } | undefined
      schemaVersion = row ? Number(row.value) : null
    } catch {
      schemaVersion = null
    }
    return {
      service: 'mahasd',
      state: snap.state,
      writableReady: snap.writableReady,
      controllerEpoch: this.epoch,
      runtimeInstance: this.instanceId
        ? {
            id: this.instanceId,
            pid: this.deps.controllerIdentity.pid,
            startedAt: this.deps.controllerIdentity.startedAt,
            endpointIncarnation: this.deps.endpointIncarnation
          }
        : null,
      schemaVersion,
      hosts: hostItems,
      reconciliation: {
        state: this.reconcileState,
        lastReport: this.lastReconcile ?? undefined,
        blockers: snap.blockers
      },
      pendingEffects: pending,
      unresolvedResources: this.lastReconcile?.unresolvedResources.length ?? 0,
      shutdown: {
        inProgress: openShutdowns.length > 0,
        operationId: shutdown?.operation_id,
        mode: shutdown?.mode,
        state: shutdown?.state
      },
      uptimeMs: this.deps.now() - this.startedAt
    }
  }

  // -- runtime.shutdown --------------------------------------------------------

  /**
   * In-transaction half of runtime.shutdown: stop admissions + write the
   * durable record. The drain itself is scheduled by scheduleShutdown AFTER
   * the receipt commits (network stays out of the tx).
   */
  initiateShutdown(
    db: DatabaseSync,
    payload: {
      mode?: string
      targetedExecutionIds?: string[]
      timeoutBudgetMs?: number
      reason?: string
    }
  ): {
    req: ShutdownRequest
    stages: ReturnType<typeof beginShutdownRecord>['stages']
    residuals: ReturnType<typeof beginShutdownRecord>['residuals']
  } {
    if (this.draining) {
      fail({
        code: 'OPERATION_CONFLICT',
        message: 'a runtime shutdown is already in progress',
        retry: 'none'
      } satisfies MahasError)
    }
    const mode = payload.mode
    if (mode !== 'drain-and-stop' && mode !== 'leave-executions') {
      fail({
        code: 'INVALID_TRANSITION',
        message: `runtime.shutdown mode must be 'drain-and-stop' or 'leave-executions' — got '${String(mode)}'`,
        retry: 'none'
      } satisfies MahasError)
    }
    const req: ShutdownRequest = {
      operationId: `shutdown-${randomUUID()}`,
      mode: mode as ShutdownMode,
      targetedExecutionIds: payload.targetedExecutionIds,
      timeoutBudgetMs: payload.timeoutBudgetMs,
      reason: payload.reason
    }
    this.draining = true
    this.readiness.beginDrain()
    const { stages, residuals } = beginShutdownRecord(db, req, this.deps.now())
    if (this.instanceId) {
      db.prepare(`UPDATE runtime_instances SET state = 'draining' WHERE id = ?`).run(
        this.instanceId
      )
    }
    return { req, stages, residuals }
  }

  /** post-commit continuation — drains, finalizes the record, tears down */
  scheduleShutdown(
    req: ShutdownRequest,
    stages: ReturnType<typeof beginShutdownRecord>['stages'],
    residuals: ReturnType<typeof beginShutdownRecord>['residuals'],
    schedule: (fn: () => void) => void
  ): void {
    schedule(() => {
      void runShutdownStages(
        {
          db: this.deps.db,
          withTx: this.deps.withTx,
          caller: this.deps.caller,
          now: this.deps.now,
          log: this.deps.log,
          onTeardown: this.teardownHook ?? undefined
        },
        req,
        stages,
        residuals
      ).catch((err) => {
        this.deps.log({
          t: 'shutdown.error',
          operationId: req.operationId,
          error: err instanceof Error ? err.message : String(err)
        })
      })
    })
  }

  setTeardownHook(hook: (operationId: string) => void | Promise<void>): void {
    this.teardownHook = hook
  }

  get isDraining(): boolean {
    return this.draining
  }
}

function defaultHostEndpoint(host: ExecutionHostRow): string | null {
  try {
    const id = JSON.parse(host.identity_json) as { endpoint?: string; socket?: string }
    return id.endpoint ?? id.socket ?? null
  } catch {
    return null
  }
}

export type { RuntimeShutdownRow, RuntimeInstanceRow }
