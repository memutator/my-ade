// recovery/reattach.ts — same-process reattach: verify an existing process
// is alive and re-bind control to it. Reattach NEVER spawns (C-RECOVERY:
// "동일하게 유지 = execution generation, process, native conversation;
// 새로 만드는 것 = client transport/observation binding").
//
// Proof required: host/process incarnation 일치 — the stored
// ProcessIncarnation (spawnNonce + pid + birth evidence) is sent to the
// host's own probe; only the host that owns the process can vouch for the
// birth. A controller restart changes no generation and no credential; the
// same process's credential binding is revalidated against the new epoch
// (D-EXEC §3), while a NEW process would have required generation+1.
//
// Probe outcomes map honestly:
//   live          → repair the execution state (join row ⇒ ready else
//                   awaiting_join), revalidate credentials, repoint member
//   exited        → record the exit evidence; do NOT reattach
//   unverifiable  → liveness only; the execution state is untouched and the
//                   caller gets PROCESS_UNVERIFIABLE, never a fabricated
//                   reconnect

import type { ExecutionState } from '../../../mahas-contracts/src/index.ts'
import {
  failure,
  type DatabaseSync,
  type ExecutionHostRow,
  type ExecutionRow,
  type RecoveryDeps
} from './ports.ts'
import { probeProcess, type HostProbeVerdict } from './identity-probe.ts'

export interface ReattachResult {
  reattached: boolean
  executionId: string
  generation: number
  state: ExecutionState
  liveness: 'live' | 'unverifiable' | 'exited'
  basis: string
  evidence?: unknown
  nextAllowedActions: string[]
}

export type ProbeApplyDecision = 'reattached' | 'exited' | 'unverifiable' | 'stopping-outstanding'

export interface ProbeApplyResult {
  exec: ExecutionRow
  decision: ProbeApplyDecision
}

function hasWorkerJoin(db: DatabaseSync, exec: ExecutionRow): boolean {
  const r = db
    .prepare('SELECT 1 AS j FROM worker_joins WHERE execution_id=? AND generation=? LIMIT 1')
    .get(exec.id, exec.generation) as { j?: number } | undefined
  return r?.j === 1
}

function hasOutstandingStopIntent(db: DatabaseSync, exec: ExecutionRow): boolean {
  const r = db
    .prepare(
      `SELECT 1 AS s FROM effect_intents
       WHERE kind='process.stop' AND state IN ('attempting','unknown')
         AND json_extract(payload_json,'$.executionId')=? AND json_extract(payload_json,'$.generation')=?
       LIMIT 1`
    )
    .get(exec.id, exec.generation) as { s?: number } | undefined
  return r?.s === 1
}

/** credential binding revalidation for a SAME process — revision bump, no new secrets */
function revalidateCredentials(db: DatabaseSync, exec: ExecutionRow): void {
  db.prepare(
    `UPDATE execution_credentials SET revision=revision+1
     WHERE execution_id=? AND generation=? AND revoked_at IS NULL`
  ).run(exec.id, exec.generation)
}

function repointMember(db: DatabaseSync, exec: ExecutionRow): void {
  db.prepare(
    `UPDATE members SET current_execution_id=?, revision=revision+1 WHERE id=? AND (current_execution_id IS NULL OR current_execution_id<>?)`
  ).run(exec.id, exec.memberId, exec.id)
}

/**
 * Fold a host probe verdict into the control mirror. Shared by reattach and
 * the reconciler so evidence always produces the same transition.
 */
export function applyProbeVerdict(
  deps: RecoveryDeps,
  db: DatabaseSync,
  exec: ExecutionRow,
  verdict: HostProbeVerdict
): ProbeApplyResult {
  const now = deps.now()

  if (verdict.liveness === 'exited') {
    const identity = { ...exec.processIdentity }
    if (verdict.observedExit) identity.observedExit = verdict.observedExit
    const nextRevision = exec.revision + 1
    db.prepare(
      `UPDATE executions SET state='exited', liveness='exited', process_identity_json=?, revision=? WHERE id=?`
    ).run(JSON.stringify(identity), nextRevision, exec.id)
    db.prepare(
      `UPDATE execution_credentials SET revoked_at=?, revision=revision+1
       WHERE execution_id=? AND generation=? AND revoked_at IS NULL`
    ).run(now, exec.id, exec.generation)
    if (exec.terminalId) {
      db.prepare('DELETE FROM terminal_input_leases WHERE terminal_id=?').run(exec.terminalId)
      db.prepare(`UPDATE terminal_records SET state='closed' WHERE id=?`).run(exec.terminalId)
    }
    db.prepare(
      `UPDATE members SET current_execution_id=NULL, revision=revision+1
       WHERE id=? AND current_execution_id=?`
    ).run(exec.memberId, exec.id)
    deps.appendDomainEvent(
      db,
      exec.id,
      nextRevision,
      'execution.exited',
      { operation: 'recovery.probe' },
      {
        generation: exec.generation,
        observedExit: verdict.observedExit ?? null,
        evidence: verdict.evidence ?? null
      }
    )
    return {
      exec: {
        ...exec,
        state: 'exited',
        liveness: 'exited',
        processIdentity: identity,
        revision: nextRevision
      },
      decision: 'exited'
    }
  }

  if (verdict.liveness === 'live') {
    if (hasOutstandingStopIntent(db, exec)) {
      // a stop for THIS incarnation is still in flight — the process is
      // verifiably alive, so liveness is honest, but the execution stays in
      // its stopping/stop_unknown state until the stop effect resolves.
      const nextRevision = exec.liveness === 'live' ? exec.revision : exec.revision + 1
      if (exec.liveness !== 'live') {
        db.prepare(`UPDATE executions SET liveness='live', revision=? WHERE id=?`).run(
          nextRevision,
          exec.id
        )
      }
      return {
        exec: { ...exec, liveness: 'live', revision: nextRevision },
        decision: 'stopping-outstanding'
      }
    }
    const repaired: ExecutionState = hasWorkerJoin(db, exec) ? 'ready' : 'awaiting_join'
    const changed = exec.state !== repaired || exec.liveness !== 'live'
    const nextRevision = changed ? exec.revision + 1 : exec.revision
    if (changed) {
      db.prepare(`UPDATE executions SET state=?, liveness='live', revision=? WHERE id=?`).run(
        repaired,
        nextRevision,
        exec.id
      )
    }
    revalidateCredentials(db, exec)
    repointMember(db, exec)
    deps.appendDomainEvent(
      db,
      exec.id,
      nextRevision,
      'execution.reattached',
      { operation: 'worker.resume' },
      { generation: exec.generation, repairedState: repaired, evidence: verdict.evidence ?? null }
    )
    return {
      exec: { ...exec, state: repaired, liveness: 'live', revision: nextRevision },
      decision: 'reattached'
    }
  }

  // unverifiable — liveness only; the execution's state claim is untouched
  const nextRevision = exec.liveness === 'unverifiable' ? exec.revision : exec.revision + 1
  if (exec.liveness !== 'unverifiable') {
    db.prepare(`UPDATE executions SET liveness='unverifiable', revision=? WHERE id=?`).run(
      nextRevision,
      exec.id
    )
    deps.appendDomainEvent(
      db,
      exec.id,
      nextRevision,
      'execution.probe-unverifiable',
      { operation: 'recovery.probe' },
      { generation: exec.generation, reason: verdict.unverifiableReason ?? null }
    )
  }
  return {
    exec: { ...exec, liveness: 'unverifiable', revision: nextRevision },
    decision: 'unverifiable'
  }
}

/**
 * The reattach path of worker.resume and the reconciler's matching-process
 * branch. Requires the execution's OWN host row — a host is the only party
 * that can prove its child's birth.
 */
export async function reattachExecution(
  deps: RecoveryDeps,
  db: DatabaseSync,
  exec: ExecutionRow,
  host: ExecutionHostRow
): Promise<ReattachResult> {
  if (host.id !== exec.hostId) {
    throw failure(
      'STALE_EXECUTION',
      `execution ${exec.id} belongs to host ${exec.hostId}, not ${host.id} — reattach across hosts is adoption, which is never implicit`,
      'replan'
    )
  }
  const verdict = await probeProcess(deps, db, host, exec)
  const applied = applyProbeVerdict(deps, db, exec, verdict)

  switch (applied.decision) {
    case 'reattached':
      return {
        reattached: true,
        executionId: applied.exec.id,
        generation: applied.exec.generation,
        state: applied.exec.state,
        liveness: 'live',
        basis: 'host probe verified the stored ProcessIncarnation — same process, no spawn',
        evidence: verdict.evidence,
        nextAllowedActions: [
          'execution.heartbeat',
          'execution.wake',
          'worker.stop',
          'worker.inspect'
        ]
      }
    case 'stopping-outstanding':
      return {
        reattached: false,
        executionId: applied.exec.id,
        generation: applied.exec.generation,
        state: applied.exec.state,
        liveness: 'live',
        basis:
          'process verified live but an outstanding stop intent exists for this incarnation — the stop effect must resolve first',
        evidence: verdict.evidence,
        nextAllowedActions: ['runtime.reconcile', 'worker.stop']
      }
    case 'exited':
      return {
        reattached: false,
        executionId: applied.exec.id,
        generation: applied.exec.generation,
        state: 'exited',
        liveness: 'exited',
        basis:
          'host returned positive exit evidence — the old process is gone; use native-resume or fresh instead',
        evidence: verdict.evidence,
        nextAllowedActions: ['worker.resume', 'worker.release']
      }
    default:
      return {
        reattached: false,
        executionId: applied.exec.id,
        generation: applied.exec.generation,
        state: applied.exec.state,
        liveness: 'unverifiable',
        basis: `process could not be verified: ${verdict.unverifiableReason ?? 'no definitive verdict'} — not dead, not reattached`,
        evidence: verdict.evidence,
        nextAllowedActions: ['runtime.reconcile', 'worker.resume']
      }
  }
}
