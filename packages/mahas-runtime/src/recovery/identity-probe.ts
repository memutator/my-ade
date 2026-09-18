// recovery/identity-probe.ts — process identity verification + stale-generation fencing.
//
// REQ-15 / S-LIFECYCLE §5 / D-EXEC §3: every recovery decision that names a
// process must verify controllerEpoch + executionGeneration + hostIncarnation
// + process birth identity + spawnNonce. A result, ack or stop issued against
// a past generation NEVER mutates the current target — fencing is a throw
// before any write, so a rolled-back transaction is the correct outcome.
//
// Probe honesty: liveness is 'live' | 'exited' | 'unverifiable'. An
// unreachable host, a missing endpoint, a refused connection or a malformed
// answer all map to 'unverifiable' — never assumed dead, never assumed alive
// (REQ-11/REQ-14, "timeout never means death").

import type { ExecutionLiveness, ProcessIncarnation } from '../../../mahas-contracts/src/index.ts'
import {
  controllerLeaseFor,
  currentRuntimeInstance,
  failure,
  isMahasError,
  loadTerminal,
  withTimeout,
  type AuthenticatedContext,
  type DatabaseSync,
  type ExecutionHostRow,
  type ExecutionRow,
  type RecoveryDeps
} from './ports.ts'

// ---------------------------------------------------------------------------
// incarnation comparison
// ---------------------------------------------------------------------------

export type IdentityMatch = 'match' | 'partial' | 'mismatch'

export interface IdentityVerdict {
  match: IdentityMatch
  /** fields whose values provably differ */
  mismatches: string[]
  /** evidence fields absent on at least one side — weaker proof, not a conflict */
  missing: string[]
}

/**
 * Compare an expected ProcessIncarnation (what the control DB believes) with
 * an observed one (what a host reports). spawnNonce and pid are the required
 * anchors — a nonce match is the anti-replay boundary, a pid alone is never
 * identity (reuse is real). birthEvidence / bootId / processGroupIdentity
 * strengthen the verdict; absent on either side they degrade to 'partial'.
 */
export function compareProcessIncarnation(
  expected: ProcessIncarnation,
  observed: ProcessIncarnation
): IdentityVerdict {
  const mismatches: string[] = []
  const missing: string[] = []

  if (!expected.spawnNonce || !observed.spawnNonce) {
    missing.push('spawnNonce')
  } else if (expected.spawnNonce !== observed.spawnNonce) {
    mismatches.push('spawnNonce')
  }

  if (expected.pid === undefined || observed.pid === undefined) {
    missing.push('pid')
  } else if (expected.pid !== observed.pid) {
    mismatches.push('pid')
  }

  for (const field of ['birthEvidence', 'bootId', 'processGroupIdentity'] as const) {
    const e = expected[field]
    const o = observed[field]
    if (e === undefined || o === undefined) {
      missing.push(field)
    } else if (e !== o) {
      mismatches.push(field)
    }
  }

  if (mismatches.length > 0) return { match: 'mismatch', mismatches, missing }
  if (missing.includes('spawnNonce') || missing.includes('pid'))
    return { match: 'partial', mismatches, missing }
  return missing.length > 0
    ? { match: 'partial', mismatches, missing }
    : { match: 'match', mismatches, missing }
}

// ---------------------------------------------------------------------------
// fencing — throws BEFORE any mutation; a stale caller changes nothing
// ---------------------------------------------------------------------------

/**
 * The generation + incarnation a caller claims to target must equal the
 * execution's current values. Any divergence is STALE_EXECUTION — the past
 * generation's stop/ack/report may not touch the current target (REQ-15).
 */
export function assertExecutionFencing(
  exec: ExecutionRow,
  expectedGeneration: number,
  expectedProcessIncarnation: ProcessIncarnation | undefined
): void {
  if (expectedGeneration !== exec.generation) {
    throw failure(
      'STALE_EXECUTION',
      `generation ${expectedGeneration} is not the current generation ${exec.generation} of execution ${exec.id} — a stale-generation request cannot mutate the current target`,
      'replan',
      {
        executionId: exec.id,
        currentGeneration: exec.generation,
        requestedGeneration: expectedGeneration
      }
    )
  }
  if (expectedProcessIncarnation !== undefined) {
    const verdict = compareProcessIncarnation(exec.processIdentity, expectedProcessIncarnation)
    if (verdict.match === 'mismatch') {
      throw failure(
        'STALE_EXECUTION',
        `process incarnation mismatch on ${verdict.mismatches.join(', ')} — refusing to apply an operation aimed at a different process birth`,
        'replan',
        { executionId: exec.id, verdict }
      )
    }
    // 'partial' is admissible: the caller may legitimately not know every
    // evidence field; the anchors (spawnNonce+pid) still had to agree.
    if (verdict.missing.includes('spawnNonce')) {
      throw failure(
        'STALE_EXECUTION',
        'expectedProcessIncarnation lacks spawnNonce — the anti-replay anchor is mandatory for a fencing check',
        'replan',
        { executionId: exec.id, verdict }
      )
    }
  }
}

/**
 * The ctx's controller epoch must be the current single-writer epoch.
 * A stale mahasd (or a forged context) gets CONTROL_UNAVAILABLE — its
 * mutations would fence-split the control plane (D-EXEC §3).
 */
export function assertCurrentControllerEpoch(
  db: DatabaseSync,
  ctx: AuthenticatedContext
): { controllerEpoch: number; runtimeInstanceId: string } {
  const rt = currentRuntimeInstance(db)
  if (!rt) {
    throw failure(
      'CONTROL_UNAVAILABLE',
      'no runtime_instances row — this control DB has no recorded writer epoch',
      'reconcile'
    )
  }
  if (ctx.controllerEpoch !== rt.controllerEpoch) {
    throw failure(
      'CONTROL_UNAVAILABLE',
      `context epoch ${ctx.controllerEpoch} is not the current controller epoch ${rt.controllerEpoch} — stale writers may not mutate`,
      'reconcile',
      { currentEpoch: rt.controllerEpoch, contextEpoch: ctx.controllerEpoch }
    )
  }
  return { controllerEpoch: rt.controllerEpoch, runtimeInstanceId: rt.id }
}

/**
 * A member credential bound to an older generation must not act on the
 * current execution — the stale-ack case of REQ-15. Operator contexts carry
 * no execution binding and pass.
 */
export function assertCallerNotStaleForExecution(
  ctx: AuthenticatedContext,
  exec: ExecutionRow
): void {
  if (ctx.executionId === undefined || ctx.executionGeneration === undefined) return
  if (ctx.executionId !== exec.id) return // acting on a different target; fencing handles it
  if (ctx.executionGeneration !== exec.generation) {
    throw failure(
      'STALE_EXECUTION',
      `credential is bound to generation ${ctx.executionGeneration} but execution ${exec.id} is at generation ${exec.generation} — stale-generation acks cannot mutate the current target`,
      'replan',
      { executionId: exec.id }
    )
  }
}

// ---------------------------------------------------------------------------
// host incarnation + probe
// ---------------------------------------------------------------------------

/**
 * Best-effort extraction of the host incarnation that spawned this process.
 * The spawn-time incarnation is recorded on the terminal mirror when one
 * exists (PTY path); pipes executions carry no terminal, so the probe is the
 * sole authority there — absence degrades confidence, never blocks it.
 */
export function expectedHostIncarnationFor(
  db: DatabaseSync,
  exec: ExecutionRow
): string | undefined {
  if (exec.terminalId) {
    const term = loadTerminal(db, exec.terminalId)
    if (term?.hostIncarnation) return term.hostIncarnation
  }
  return undefined
}

export interface HostProbeVerdict {
  liveness: ExecutionLiveness
  evidence?: unknown
  observedExit?: { code?: number; signal?: string; at: number }
  /** why a verdict could not be obtained — diagnostic only, not a state */
  unverifiableReason?: string
}

/**
 * host.process.probe — observation only, never a state change on its own.
 * Every failure path lands on 'unverifiable'.
 */
export async function probeProcess(
  deps: RecoveryDeps,
  db: DatabaseSync,
  host: ExecutionHostRow,
  exec: ExecutionRow
): Promise<HostProbeVerdict> {
  const endpoint = host.identity.endpoint
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    return { liveness: 'unverifiable', unverifiableReason: 'host row carries no endpoint' }
  }
  const lease = controllerLeaseFor(db, host.id)
  const payload = {
    expectedProcessIncarnation: exec.processIdentity,
    expectedHostIncarnation: expectedHostIncarnationFor(db, exec),
    executionId: exec.id,
    generation: exec.generation,
    controllerEpoch: lease?.epoch,
    leaseProof: lease?.proof
  }
  let client
  try {
    client = await withTimeout(deps.connectHost(endpoint), deps.hostCallTimeoutMs ?? 10_000)
  } catch (e) {
    return {
      liveness: 'unverifiable',
      unverifiableReason: `host unreachable: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  try {
    const res = await withTimeout(
      client.call<Record<string, unknown>>('host.process.probe', payload),
      deps.hostCallTimeoutMs ?? 10_000
    )
    return normalizeProbeResult(res)
  } catch (e) {
    return {
      liveness: 'unverifiable',
      unverifiableReason: `probe failed: ${isMahasError(e) ? `${e.code} ${e.message}` : e instanceof Error ? e.message : String(e)}`,
      evidence: isMahasError(e) ? e.details : undefined
    }
  } finally {
    try {
      client.close()
    } catch {
      /* a refused close does not change the verdict */
    }
  }
}

function normalizeProbeResult(res: Record<string, unknown>): HostProbeVerdict {
  const raw = res?.liveness ?? res?.state ?? res?.verdict
  const observedExit = parseObservedExit(res?.observedExit ?? res?.exit)
  if (raw === 'live') return { liveness: 'live', evidence: res?.evidence }
  if (raw === 'exited') return { liveness: 'exited', evidence: res?.evidence, observedExit }
  return {
    liveness: 'unverifiable',
    unverifiableReason:
      typeof res?.reason === 'string' ? res.reason : 'host returned no definitive verdict',
    evidence: res?.evidence
  }
}

export function parseObservedExit(
  raw: unknown
): { code?: number; signal?: string; at: number } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  return {
    code: typeof o.code === 'number' ? o.code : undefined,
    signal: typeof o.signal === 'string' ? o.signal : undefined,
    at: typeof o.at === 'number' ? o.at : 0
  }
}

// ---------------------------------------------------------------------------
// effect keys — stable across retries, incarnation-scoped
// ---------------------------------------------------------------------------

/**
 * The stop effect key binds (execution, generation, spawnNonce): a retry of
 * the same stop looks up the same host receipt, and a respawned process is a
 * different key — a past stop can never be re-applied to a new process birth
 * ("새 process/turn에 과거 stop 재적용 금지").
 */
export function stopEffectKey(exec: ExecutionRow): string {
  const nonce = exec.processIdentity.spawnNonce ?? 'unspawned'
  return `worker.stop/${exec.id}/${exec.generation}/${nonce}`
}

export function spawnEffectKey(
  executionId: string,
  generation: number,
  spawnNonce: string
): string {
  return `host.process.spawn/${executionId}/${generation}/${spawnNonce}`
}
