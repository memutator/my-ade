// mahas-runtime/launch — stage adapters.
//
// worker.start is two responsibilities stacked in one function: deciding
// WHERE in the stage chain to be (progress, receipts, resume, failure
// classification) and actually DOING the work of one stage (call the host,
// write the effect row, commit evidence). The first is the coordinator; the
// second is a set of adapters over three ports — the control DB, the
// execution host, and the cross-domain caller.
//
// This module is that second half's shared vocabulary: the effect lifecycle
// (intent row committed BEFORE the call, verdict written after), the spawn
// refusal set that distinguishes a definitive "never started" from an
// ambiguous outcome, and the execution-state transition guard. Keeping these
// in one place is what makes the coordinator's failure paths auditable: every
// place that turns an exception into 'rejected' vs 'unknown' is using the same
// rule, and that rule is written down once.
//
// The receipts/unknown semantics this preserves (REQ-14, S-LIFECYCLE §3):
//   - an effect row exists before the external call, so a lost response
//     resumes as 'unknown' and is NEVER silently retried or cleaned;
//   - only errors that prove the host never admitted the request may mark an
//     effect 'rejected' (definitive negative); everything else is 'unknown';
//   - a transition the lifecycle table forbids is an error, never a silent
//     state write.

import type { DatabaseSync } from 'node:sqlite'
import type { ExecutionLiveness, ExecutionState } from '../../../mahas-contracts/src/identity.ts'
import { getRow, type ExecutionRow } from './rows.ts'

/**
 * Thrown-host errors that prove the spawn was never admitted → definitive
 * negative, NOT unknown. GRANT_REVOKED is deliberately absent: after the OS
 * call is in flight a revoked grant is not proof the process never started.
 */
export const SPAWN_NEVER_ADMITTED: ReadonlySet<string> = new Set([
  'HOST_PROTOCOL_MISMATCH',
  'UNAUTHENTICATED',
  'SCOPE_DENIED',
  'STALE_EXECUTION'
])

/**
 * The execution lifecycle table (S-LIFECYCLE §1). Two things it encodes that
 * are easy to lose in a refactor:
 *   - `start_unknown` is a real state, not a failure flag: it means a process
 *     MAY exist and the only exits are probe/reconcile outcomes. There is no
 *     edge back to `starting`, so a coordinator retry can never respawn;
 *   - `ready` lists itself, because a liveness-only update is a legal write.
 */
export const EXECUTION_TRANSITIONS: Record<ExecutionState, ExecutionState[]> = {
  preparing: ['starting', 'exited', 'abandoned'],
  starting: ['awaiting_join', 'start_unknown', 'exited'],
  start_unknown: ['awaiting_join', 'exited'], // probe/reconcile only; no re-start
  awaiting_join: ['ready', 'exited', 'stopping'],
  ready: ['ready', 'stopping', 'exited'],
  stopping: ['exited', 'stop_unknown'],
  stop_unknown: ['exited'],
  exited: [],
  abandoned: []
}

export class ExecutionTransitionError extends Error {
  readonly from: string
  readonly to: string
  // no parameter properties: mahasd boots from source under Node's strip-only
  // type support, which rejects them before any other work can run
  constructor(from: string, to: string) {
    super(`execution transition ${from} → ${to} is not allowed`)
    this.name = 'ExecutionTransitionError'
    this.from = from
    this.to = to
  }
}

/**
 * Move an execution to `next` under the lifecycle table, emitting the state
 * event at the new revision. Idempotent for a same-state call (a resumed
 * stage must not blow up on an already-applied transition).
 */
export function transitionExecution(
  db: DatabaseSync,
  executionId: string,
  next: ExecutionState,
  liveness: ExecutionLiveness | undefined,
  emit: (executionId: string, revision: number, eventType: string, payload: unknown) => void
): void {
  const row = getRow<ExecutionRow>(db, 'SELECT * FROM executions WHERE id=?', executionId)
  if (!row) throw new Error(`execution ${executionId} not found`)
  if (row.state === next) return
  const allowed = EXECUTION_TRANSITIONS[row.state]
  if (!allowed || !allowed.includes(next)) {
    throw new ExecutionTransitionError(row.state, next)
  }
  const revision = row.revision + 1
  if (liveness === undefined) {
    db.prepare('UPDATE executions SET state=?, revision=? WHERE id=?').run(
      next,
      revision,
      executionId
    )
  } else {
    db.prepare('UPDATE executions SET state=?, liveness=?, revision=? WHERE id=?').run(
      next,
      liveness,
      revision,
      executionId
    )
  }
  emit(executionId, revision, `execution.${next}`, { from: row.state, to: next })
}

/** current revision of an execution row, for events emitted beside it */
export function currentRevision(db: DatabaseSync, executionId: string): number {
  return (
    getRow<{ revision: number }>(db, 'SELECT revision FROM executions WHERE id=?', executionId)
      ?.revision ?? 0
  )
}

/**
 * Classification of an effect failure. 'rejected' means the durable record may
 * say the effect definitively did not happen; 'unknown' means it may have.
 * The caller has already decided the effect's kind — spawn refusals are the
 * only case where a specific error code proves a negative.
 */
export type EffectVerdict = 'rejected' | 'unknown'

export function spawnFailureVerdict(code: string | undefined): EffectVerdict {
  return code && SPAWN_NEVER_ADMITTED.has(code) ? 'rejected' : 'unknown'
}
