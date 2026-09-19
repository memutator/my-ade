// mahas-runtime / lifecycle — operator shutdown: drain-and-stop vs
// leave-executions.
//
// spec/architecture.md §5 + spec/contracts/recovery-operations.md
// runtime.shutdown + spec/execution-lifecycle.md §6:
//   * shutdown mode is an EXPLICIT operator choice — UI close is a detach
//     and never reaches here;
//   * drain order: stop new admissions → worker stop intents → record
//     confirmations/unknowns → preserve needed resources → DB close;
//   * a timeout NEVER marks an execution un-executed or releases its
//     resources — leftovers are recorded as residuals with honest
//     dispositions (stop-confirmed / stop-unknown / stop-not-attempted /
//     left-running / claim-preserved);
//   * the runtime_shutdowns row is the durable receipt: created in the op
//     transaction, advanced stage-by-stage, closed by the final write —
//     a crash mid-shutdown leaves 'in-progress' which the next boot marks
//     'interrupted' (reconcile.markPriorInstancesStopped).

import type {
  CrossDomainCaller,
  DatabaseSync,
  ExecutionRow,
  RuntimeShutdownRow,
  ShutdownMode,
  ShutdownResidual,
  ShutdownStage,
  WithTxFn
} from './types.ts'
import { loadOpenClaims, loadOpenExecutions } from './reconcile.ts'

export interface ShutdownRequest {
  operationId: string
  mode: ShutdownMode
  targetedExecutionIds?: string[]
  timeoutBudgetMs?: number
  reason?: string
}

export interface ShutdownDeps {
  db: DatabaseSync
  withTx: WithTxFn
  /** cross-domain caller — worker.stop is IMP-22's operation */
  caller: CrossDomainCaller | null
  now: () => number
  log: (line: Record<string, unknown>) => void
  /** stage-order teardown hook supplied by the service bootstrap */
  onTeardown?: (operationId: string) => void | Promise<void>
}

// ---------------------------------------------------------------------------
// record helpers — the runtime_shutdowns row is the receipt
// ---------------------------------------------------------------------------

const DRAIN_STAGES: ShutdownStage['name'][] = [
  'admission-stopped',
  'stop-intents',
  'evidence-recorded',
  'resources-preserved',
  'db-checkpoint-close'
]

function freshStages(mode: ShutdownMode): ShutdownStage[] {
  return DRAIN_STAGES.map((name) => ({
    name,
    state:
      name === 'stop-intents' && mode === 'leave-executions'
        ? ('skipped' as const)
        : ('pending' as const),
    ...(name === 'stop-intents' && mode === 'leave-executions'
      ? { detail: 'leave-executions: executions keep running uncontested' }
      : {})
  }))
}

export function readShutdown(db: DatabaseSync, operationId: string): RuntimeShutdownRow | null {
  const row = db
    .prepare(
      `SELECT operation_id, mode, state, stages_json, residuals_json FROM runtime_shutdowns WHERE operation_id = ?`
    )
    .get(operationId) as RuntimeShutdownRow | undefined
  return row ?? null
}

export function latestShutdown(db: DatabaseSync): RuntimeShutdownRow | null {
  const row = db
    .prepare(
      `SELECT operation_id, mode, state, stages_json, residuals_json
       FROM runtime_shutdowns ORDER BY rowid DESC LIMIT 1`
    )
    .get() as RuntimeShutdownRow | undefined
  return row ?? null
}

function writeShutdown(
  db: DatabaseSync,
  operationId: string,
  state: string,
  stages: ShutdownStage[],
  residuals: ShutdownResidual[]
): void {
  db.prepare(
    `UPDATE runtime_shutdowns SET state = ?, stages_json = ?, residuals_json = ? WHERE operation_id = ?`
  ).run(state, JSON.stringify(stages), JSON.stringify(residuals), operationId)
}

/**
 * Stage 1 + record creation — runs INSIDE the operation's own transaction so
 * the admission stop, the receipt and the durable record commit atomically.
 * Returns the stage list the coordinator will keep advancing.
 */
export function beginShutdownRecord(
  db: DatabaseSync,
  req: ShutdownRequest,
  now: number
): { stages: ShutdownStage[]; residuals: ShutdownResidual[] } {
  const stages = freshStages(req.mode)
  stages[0] = {
    name: 'admission-stopped',
    state: 'completed',
    at: now,
    detail: 'new admissions refused'
  }
  const residuals: ShutdownResidual[] = []
  db.prepare(
    `INSERT INTO runtime_shutdowns(operation_id, mode, state, stages_json, residuals_json)
     VALUES(?,?,?,?,?)`
  ).run(req.operationId, req.mode, 'in-progress', JSON.stringify(stages), JSON.stringify(residuals))
  return { stages, residuals }
}

// ---------------------------------------------------------------------------
// stage execution (post-commit — host calls are network and stay out of tx)
// ---------------------------------------------------------------------------

interface StopOutcome {
  execution: ExecutionRow
  disposition: ShutdownResidual['disposition']
  detail: string
}

async function issueStopIntent(
  deps: ShutdownDeps,
  exec: ExecutionRow,
  req: ShutdownRequest,
  deadline: number
): Promise<StopOutcome> {
  if (!deps.caller) {
    return {
      execution: exec,
      disposition: 'stop-not-attempted',
      detail: 'no cross-domain caller wired (worker.stop is IMP-22) — intent not issued'
    }
  }
  const remaining = deadline - deps.now()
  if (remaining <= 0) {
    return {
      execution: exec,
      disposition: 'stop-unknown',
      detail: 'drain timeout budget exhausted before this stop intent was issued'
    }
  }
  try {
    const result = await Promise.race([
      deps.caller('worker.stop', {
        executionId: exec.id,
        generation: exec.generation,
        reason: req.reason ?? 'runtime-shutdown',
        mode: 'graceful-then-kill',
        graceBudgetMs: remaining
      }),
      new Promise((_r, rej) =>
        setTimeout(() => rej(new Error('stop intent timed out')), Math.max(1, remaining))
      )
    ])
    // interpret honestly: only an explicit exit verdict confirms the stop
    const r = result as { state?: string; liveness?: string; receipt?: { status?: string } } | null
    if (r?.liveness === 'exited' || r?.state === 'exited') {
      return {
        execution: exec,
        disposition: 'stop-confirmed',
        detail: 'worker.stop confirmed exit'
      }
    }
    return {
      execution: exec,
      disposition: 'stop-unknown',
      detail: `worker.stop returned without positive exit evidence (${JSON.stringify(r)?.slice(0, 200)})`
    }
  } catch (err) {
    return {
      execution: exec,
      disposition: 'stop-unknown',
      detail: `worker.stop failed/unknown: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/**
 * Advance the shutdown record through its remaining stages, then invoke the
 * teardown hook. Runs AFTER the op transaction committed — each stage's
 * record update is its own small tx so a crash always leaves a truthful
 * frontier.
 */
export async function runShutdownStages(
  deps: ShutdownDeps,
  req: ShutdownRequest,
  stages: ShutdownStage[],
  residuals: ShutdownResidual[]
): Promise<void> {
  const mark = (name: ShutdownStage['name'], patch: Partial<ShutdownStage>): void => {
    const s = stages.find((x) => x.name === name)
    if (s) Object.assign(s, patch, { at: deps.now() })
    deps.withTx(deps.db, (tx) =>
      writeShutdown(tx, req.operationId, 'in-progress', stages, residuals)
    )
  }

  const executions = loadOpenExecutions(deps.db).filter((e) => e.liveness !== 'exited')
  const targeted = req.targetedExecutionIds ? new Set(req.targetedExecutionIds) : null

  if (req.mode === 'drain-and-stop') {
    mark('stop-intents', { state: 'in-progress' })
    const budget = req.timeoutBudgetMs ?? 15_000
    const deadline = deps.now() + budget
    const outcomes: StopOutcome[] = []
    for (const exec of executions) {
      if (targeted && !targeted.has(exec.id)) continue
      outcomes.push(await issueStopIntent(deps, exec, req, deadline))
    }
    // record stop evidence — confirmed exits become exited; everything else
    // stays honest (unverifiable/stop_unknown), claims preserved
    deps.withTx(deps.db, (tx) => {
      for (const o of outcomes) {
        if (o.disposition === 'stop-confirmed') {
          tx.prepare(
            `UPDATE executions SET liveness='exited', state='exited', revision=revision+1 WHERE id=?`
          ).run(o.execution.id)
        } else if (o.disposition === 'stop-unknown' && o.execution.state !== 'stop_unknown') {
          tx.prepare(
            `UPDATE executions SET liveness='unverifiable', state='stop_unknown', revision=revision+1 WHERE id=?`
          ).run(o.execution.id)
        }
        residuals.push({
          kind: 'execution',
          id: o.execution.id,
          disposition: o.disposition,
          detail: o.detail
        })
      }
    })
    // targeted drain: anything deliberately not stopped is left-running —
    // recorded, never hidden
    for (const exec of executions) {
      if (targeted && !targeted.has(exec.id)) {
        residuals.push({
          kind: 'execution',
          id: exec.id,
          disposition: 'left-running',
          detail: 'outside targetedExecutionIds — intentionally not drained'
        })
      }
    }
    mark('stop-intents', {
      // the STAGE completed — unconfirmed outcomes are residuals, not stage failure
      state: 'completed',
      detail:
        `${outcomes.filter((o) => o.disposition === 'stop-confirmed').length} confirmed, ` +
        `${outcomes.filter((o) => o.disposition === 'stop-unknown').length} unknown, ` +
        `${outcomes.filter((o) => o.disposition === 'stop-not-attempted').length} not attempted`
    })
  } else {
    // leave-executions: enumerate what keeps running — the operator sees
    // exactly what collaboration-unavailable means
    for (const exec of executions) {
      residuals.push({
        kind: 'execution',
        id: exec.id,
        disposition: 'left-running',
        detail: `left on host ${exec.host_id} — process keeps running; control unavailable until next reconcile`
      })
    }
  }

  mark('evidence-recorded', { state: 'completed', detail: `${residuals.length} residual(s)` })

  // resources-preserved: open claims are KEPT, listed as residuals so the
  // next boot's reconcile/operator sees the preserved writer claims
  const claims = loadOpenClaims(deps.db)
  for (const c of claims) {
    residuals.push({
      kind: 'claim',
      id: c.id,
      disposition: 'claim-preserved',
      detail: `claim on ${c.resource_id} preserved (owner ${c.owner_kind}:${c.owner_id}, state ${c.state})`
    })
  }
  mark('resources-preserved', { state: 'completed', detail: `${claims.length} claim(s) preserved` })

  // final durable write BEFORE the teardown — 'completed' here means every
  // recorded stage is done; the teardown acts on a finished record
  deps.withTx(deps.db, (tx) => {
    const s = stages.find((x) => x.name === 'db-checkpoint-close')
    if (s) Object.assign(s, { state: 'completed', at: deps.now() })
    writeShutdown(tx, req.operationId, 'completed', stages, residuals)
  })
  deps.log({
    t: 'shutdown.recorded',
    operationId: req.operationId,
    mode: req.mode,
    residuals: residuals.length
  })

  if (deps.onTeardown) await deps.onTeardown(req.operationId)
}
