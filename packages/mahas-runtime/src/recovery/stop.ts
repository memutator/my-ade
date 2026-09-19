// recovery/stop.ts — worker.stop (C-LAUNCH) + the stop-effect apply path
// shared with the reconciler.
//
// Contract (launch.md worker.stop): input {executionId, expectedGeneration,
// expectedProcessIncarnation, mode: graceful|escalate, reason} → stop effect
// receipt + liveness + residual resources. "stop intent commit → host stop →
// positive exit 확인"; 권한 fence와 물리 stop은 구별된다.
//
// Honesty rules enforced here:
//  - fencing first: generation + incarnation are verified BEFORE any write;
//    a stale-generation stop is thrown STALE_EXECUTION and mutates nothing
//    (REQ-15, "새 process/turn에 과거 stop 재적용 금지").
//  - the stop effect key is incarnation-scoped, so a retry of the same stop
//    re-reads the same host receipt rather than signalling a second time.
//  - an ambiguous host answer is recorded: executions.state='stop_unknown',
//    liveness='unverifiable', effect intent 'unknown', resource claims
//    retained. STOP_UNKNOWN is returned in the result (not thrown) so the
//    unknown state commits atomically — throwing would roll it back.
//  - timeout/lease expiry alone never means death (PROCESS_UNVERIFIABLE is
//    a verdict, not a suspicion).

import type { ProcessIncarnation } from '../../../mahas-contracts/src/index.ts'
import type { TxnContext } from '../api/registry.ts' // IMP-11 — type only
import {
  claimsOwnedBy,
  controllerLeaseFor,
  failure,
  isMahasError,
  loadEffectIntent,
  loadExecution,
  loadHost,
  optionalString,
  requireString,
  requireNumber,
  withTimeout,
  type DatabaseSync,
  type EffectIntentRow,
  type ExecutionHostRow,
  type ExecutionRow,
  type RecoveryDeps,
  type ResidualResourceResult
} from './ports.ts'
import {
  assertCallerNotStaleForExecution,
  assertCurrentControllerEpoch,
  assertExecutionFencing,
  expectedHostIncarnationFor,
  parseObservedExit,
  probeProcess,
  stopEffectKey
} from './identity-probe.ts'

export interface WorkerStopPayload {
  executionId: string
  expectedGeneration: number
  expectedProcessIncarnation?: ProcessIncarnation
  mode: 'graceful' | 'escalate'
  reason?: string
  graceBudgetMs?: number
}

export interface WorkerStopResult {
  outcome: 'exited' | 'already-exited' | 'stop_unknown'
  /** STOP_UNKNOWN surfaces in the result — the unknown state committed */
  code?: 'STOP_UNKNOWN'
  executionId: string
  generation: number
  state: string
  liveness: string
  stopEffectKey: string
  evidence?: unknown
  residuals: ResidualResourceResult[]
  nextAllowedActions: string[]
}

// ---------------------------------------------------------------------------
// payload + intent
// ---------------------------------------------------------------------------

function readStopPayload(payload: unknown): WorkerStopPayload {
  const p = (payload ?? {}) as Record<string, unknown>
  const mode = p.mode === 'escalate' ? 'escalate' : 'graceful'
  return {
    executionId: requireString(p.executionId, 'executionId'),
    expectedGeneration: requireNumber(p.expectedGeneration, 'expectedGeneration'),
    expectedProcessIncarnation:
      typeof p.expectedProcessIncarnation === 'object' && p.expectedProcessIncarnation !== null
        ? (p.expectedProcessIncarnation as ProcessIncarnation)
        : undefined,
    mode,
    reason: optionalString(p.reason),
    graceBudgetMs: typeof p.graceBudgetMs === 'number' ? p.graceBudgetMs : undefined
  }
}

/** states from which a stop intent may begin (S-LIFECYCLE §1) */
const STOPPABLE: ReadonlySet<string> = new Set([
  'starting',
  'start_unknown',
  'awaiting_join',
  'ready'
])

function ensureStopIntent(
  deps: RecoveryDeps,
  db: DatabaseSync,
  exec: ExecutionRow,
  host: ExecutionHostRow,
  input: WorkerStopPayload
): EffectIntentRow {
  const key = stopEffectKey(exec)
  const existing = loadEffectIntent(db, key)
  if (existing) return existing // same incarnation → same effect; never a second signal

  const fingerprint = deps.sha256Hex(
    JSON.stringify({
      operation: 'worker.stop',
      executionId: exec.id,
      generation: exec.generation,
      spawnNonce: exec.processIdentity.spawnNonce ?? null,
      mode: input.mode,
      reason: input.reason ?? null
    })
  )
  const intentPayload = {
    executionId: exec.id,
    generation: exec.generation,
    expectedProcessIncarnation: exec.processIdentity,
    mode: input.mode,
    reason: input.reason ?? null,
    graceBudgetMs: input.graceBudgetMs ?? null
  }
  db.prepare(
    `INSERT INTO effect_intents (id, operation_key, kind, fingerprint, host_id, state, payload_json, receipt_json, residuals_json)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    key,
    'worker.stop',
    'process.stop',
    fingerprint,
    host.id,
    'attempting',
    JSON.stringify(intentPayload),
    JSON.stringify({}),
    JSON.stringify([])
  )
  db.prepare(
    'INSERT OR IGNORE INTO effect_outbox (effect_id, state, next_attempt_at) VALUES (?,?,?)'
  ).run(key, 'pending', null)
  const row = loadEffectIntent(db, key)
  if (!row)
    throw failure('CONTROL_UNAVAILABLE', 'effect intent insert did not materialize', 'reconcile')
  return row
}

// ---------------------------------------------------------------------------
// outcome application — shared with reconciler/drain (same code path so a
// host receipt found later applies exactly the mutation the live call would)
// ---------------------------------------------------------------------------

export interface StopOutcomeVerdict {
  kind: 'exited' | 'unknown'
  evidence?: unknown
  observedExit?: { code?: number; signal?: string; at: number }
  reason?: string
  /** residual resources reported by the host receipt, if any */
  hostResiduals?: unknown[]
}

/**
 * Apply a definitive stop outcome. On positive exit evidence: execution →
 * exited, credential fence drops (the dead process's credentials are
 * revoked — Task/Dispatch authority is untouched, settlement is a separate
 * operation), the input lease is released and the terminal mirror closes.
 * On unknown: execution → stop_unknown, liveness unverifiable, the intent
 * stays 'unknown', the outbox row remains pending and EVERY resource claim
 * is retained — an unresolved stop releases nothing (instruction §4.3,
 * D-EXEC §5).
 */
export function applyStopOutcome(
  deps: RecoveryDeps,
  db: DatabaseSync,
  exec: ExecutionRow,
  intent: EffectIntentRow,
  verdict: StopOutcomeVerdict
): ExecutionRow {
  const now = deps.now()
  if (verdict.kind === 'exited') {
    const identity = { ...exec.processIdentity }
    if (verdict.observedExit) identity.observedExit = verdict.observedExit
    const nextRevision = exec.revision + 1
    db.prepare(
      `UPDATE executions SET state='exited', liveness='exited', process_identity_json=?, revision=? WHERE id=?`
    ).run(JSON.stringify(identity), nextRevision, exec.id)
    db.prepare(`UPDATE effect_intents SET state='confirmed', receipt_json=? WHERE id=?`).run(
      JSON.stringify({ outcome: 'exited', evidence: verdict.evidence ?? null, at: now }),
      intent.id
    )
    db.prepare('DELETE FROM effect_outbox WHERE effect_id=?').run(intent.id)

    // authority fence for the dead generation — physical stop and permission
    // fence are distinct, but a confirmed-dead process may not keep live creds
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
      {
        operation: 'worker.stop',
        effectId: intent.id
      },
      {
        generation: exec.generation,
        observedExit: verdict.observedExit ?? null,
        evidence: verdict.evidence ?? null
      }
    )
    return {
      ...exec,
      state: 'exited',
      liveness: 'exited',
      processIdentity: identity,
      revision: nextRevision
    }
  }

  // unknown — preserve everything, resolve nothing
  const nextRevision = exec.revision + 1
  db.prepare(
    `UPDATE executions SET state='stop_unknown', liveness='unverifiable', revision=? WHERE id=?`
  ).run(nextRevision, exec.id)
  db.prepare(`UPDATE effect_intents SET state='unknown', receipt_json=? WHERE id=?`).run(
    JSON.stringify({
      outcome: 'unknown',
      reason: verdict.reason ?? null,
      evidence: verdict.evidence ?? null,
      at: now
    }),
    intent.id
  )
  db.prepare(
    `INSERT INTO effect_outbox (effect_id, state, next_attempt_at) VALUES (?,?,?)
     ON CONFLICT(effect_id) DO UPDATE SET state='pending', next_attempt_at=excluded.next_attempt_at`
  ).run(intent.id, 'pending', now + 30_000)
  deps.appendDomainEvent(
    db,
    exec.id,
    nextRevision,
    'execution.stop_unknown',
    { operation: 'worker.stop', effectId: intent.id },
    { generation: exec.generation, reason: verdict.reason ?? null }
  )
  return { ...exec, state: 'stop_unknown', liveness: 'unverifiable', revision: nextRevision }
}

function residualsFor(exec: ExecutionRow, db: DatabaseSync): ResidualResourceResult[] {
  return claimsOwnedBy(db, 'execution', exec.id).map((c) => ({
    claimId: c.id,
    resourceId: c.resourceId,
    mode: c.mode,
    outcome: 'retained' as const,
    reason: 'resource claims are never released by stop — worker.release is a separate operation'
  }))
}

// ---------------------------------------------------------------------------
// host stop call
// ---------------------------------------------------------------------------

async function callHostStop(
  deps: RecoveryDeps,
  db: DatabaseSync,
  host: ExecutionHostRow,
  exec: ExecutionRow,
  intent: EffectIntentRow,
  input: WorkerStopPayload
): Promise<StopOutcomeVerdict> {
  const endpoint = host.identity.endpoint
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    return { kind: 'unknown', reason: 'host row carries no endpoint' }
  }
  const lease = controllerLeaseFor(db, host.id)
  const timeout = deps.hostCallTimeoutMs ?? 10_000
  let client
  try {
    client = await withTimeout(deps.connectHost(endpoint), timeout)
  } catch (e) {
    return {
      kind: 'unknown',
      reason: `host unreachable: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  try {
    const res = await withTimeout(
      client.call<Record<string, unknown>>('host.process.stop', {
        effectKey: intent.id,
        processIncarnation: exec.processIdentity,
        expectedProcessIncarnation: exec.processIdentity,
        expectedHostIncarnation: expectedHostIncarnationFor(db, exec),
        mode: input.mode,
        graceBudget: input.graceBudgetMs,
        reason: input.reason,
        executionId: exec.id,
        generation: exec.generation,
        controllerEpoch: lease?.epoch,
        leaseProof: lease?.proof
      }),
      timeout
    )
    const outcome = hostStopOutcome(res)
    if (
      outcome === 'exited' ||
      outcome === 'already-exited' ||
      outcome === 'stopped' ||
      outcome === 'confirmed'
    ) {
      return {
        kind: 'exited',
        evidence: res?.evidence ?? res?.receipt ?? res,
        observedExit: parseObservedExit(
          res?.observedExit ??
            res?.exit ??
            nestedRecord(res, 'stop')?.observedExit ??
            nestedRecord(nestedRecord(res, 'stop'), 'receipt')?.observedExit
        )
      }
    }
    return {
      kind: 'unknown',
      reason:
        typeof res?.reason === 'string' ? res.reason : 'host returned no positive exit evidence',
      evidence: res
    }
  } catch (e) {
    return {
      kind: 'unknown',
      reason: isMahasError(e)
        ? `${e.code}: ${e.message}`
        : `stop call failed: ${e instanceof Error ? e.message : String(e)}`,
      evidence: isMahasError(e) ? e.details : undefined
    }
  }
}

function nestedRecord(
  raw: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  const v = raw?.[key]
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
}

function hostStopOutcome(res: Record<string, unknown> | undefined): unknown {
  const stop = nestedRecord(res, 'stop')
  const receipt = nestedRecord(stop, 'receipt')
  const effect = nestedRecord(res, 'effect')
  return (
    stop?.outcome ??
    receipt?.outcome ??
    effect?.state ??
    res?.outcome ??
    res?.result ??
    res?.state
  )
}

// ---------------------------------------------------------------------------
// the operation handler
// ---------------------------------------------------------------------------

export function makeStopHandler(deps: RecoveryDeps) {
  return async function workerStop(txn: TxnContext, payload: unknown): Promise<WorkerStopResult> {
    const { db, ctx } = txn
    const input = readStopPayload(payload)

    deps.authorize(ctx, 'worker.stop', [{ kind: 'execution', id: input.executionId }])
    if (input.mode === 'escalate') {
      // escalation is a separate authority (launch.md: "escalation 별도 권한")
      deps.authorize(ctx, 'worker.stop.escalate', [{ kind: 'execution', id: input.executionId }])
    }
    assertCurrentControllerEpoch(db, ctx)

    let exec = loadExecution(db, input.executionId)
    if (!exec) {
      throw failure('INVALID_TRANSITION', `execution ${input.executionId} does not exist`, 'none')
    }
    assertCallerNotStaleForExecution(ctx, exec)
    assertExecutionFencing(exec, input.expectedGeneration, input.expectedProcessIncarnation)

    const host = loadHost(db, exec.hostId)
    if (!host) {
      throw failure(
        'CONTROL_UNAVAILABLE',
        `execution host ${exec.hostId} has no control mirror`,
        'reconcile'
      )
    }

    const key = stopEffectKey(exec)

    if (exec.state === 'exited') {
      return {
        outcome: 'already-exited',
        executionId: exec.id,
        generation: exec.generation,
        state: exec.state,
        liveness: exec.liveness,
        stopEffectKey: key,
        evidence: exec.processIdentity.observedExit ?? null,
        residuals: residualsFor(exec, db),
        nextAllowedActions: ['worker.release', 'worker.resume']
      }
    }
    if (!STOPPABLE.has(exec.state) && exec.state !== 'stopping' && exec.state !== 'stop_unknown') {
      throw failure(
        'INVALID_TRANSITION',
        `worker.stop is not admissible from execution state '${exec.state}'`,
        'none',
        { executionId: exec.id, state: exec.state }
      )
    }

    // mark stopping (idempotent when already stopping/stop_unknown)
    if (exec.state !== 'stopping' && exec.state !== 'stop_unknown') {
      const nextRevision = exec.revision + 1
      db.prepare(`UPDATE executions SET state='stopping', revision=? WHERE id=?`).run(
        nextRevision,
        exec.id
      )
      deps.appendDomainEvent(
        db,
        exec.id,
        nextRevision,
        'execution.stopping',
        { operation: 'worker.stop' },
        { generation: exec.generation, mode: input.mode, reason: input.reason ?? null }
      )
      exec = { ...exec, state: 'stopping', revision: nextRevision }
    }

    const intent = ensureStopIntent(deps, db, exec, host, input)
    if (intent.state === 'confirmed') {
      // a prior attempt of THIS incarnation's stop already landed — return it
      return {
        outcome: 'already-exited',
        executionId: exec.id,
        generation: exec.generation,
        state: exec.state,
        liveness: exec.liveness,
        stopEffectKey: key,
        evidence: intent.receipt,
        residuals: residualsFor(exec, db),
        nextAllowedActions: ['worker.release', 'worker.resume']
      }
    }

    const verdict = await callHostStop(deps, db, host, exec, intent, input)
    const after = applyStopOutcome(deps, db, exec, intent, verdict)

    if (verdict.kind === 'exited') {
      return {
        outcome: 'exited',
        executionId: after.id,
        generation: after.generation,
        state: after.state,
        liveness: after.liveness,
        stopEffectKey: key,
        evidence: verdict.evidence ?? null,
        residuals: residualsFor(after, db),
        nextAllowedActions: ['worker.release', 'worker.resume']
      }
    }
    return {
      outcome: 'stop_unknown',
      code: 'STOP_UNKNOWN',
      executionId: after.id,
      generation: after.generation,
      state: after.state,
      liveness: after.liveness,
      stopEffectKey: key,
      evidence: verdict.evidence ?? null,
      residuals: residualsFor(after, db),
      nextAllowedActions: ['runtime.reconcile', 'worker.stop']
    }
  }
}

// re-exported so reconciler can fold a host-side probe into the same verdict
export { probeProcess }
