// mahas-execution-host — verified process stop (IMP-18).
//
// spec/contracts/execution-host.md host.process.stop + spec/domains/
// execution.md §5 + spec/execution-lifecycle.md §4:
//   * the target is an EXACT ProcessIncarnation — pid + birthEvidence +
//     process group are re-proven against /proc before EVERY signal; a
//     stale or reused pid is never signalled
//   * graceful request first, then escalation inside graceBudget; every
//     step is recorded so the receipt shows what was actually sent
//   * group kill only when the recorded pgid still matches the live pgrp;
//     an unverifiable group is never blindly signalled — the fallback is a
//     verified-pid signal with scope honestly marked 'pid-only'
//   * outcome is positive exit evidence or 'unknown' — a stop whose
//     confirmation is lost is STOP_UNKNOWN, never assumed dead

import type { ProcessIncarnation } from '../../mahas-contracts/src/index.ts'
import { parsePgid, readProcStat, verifyIncarnation } from './process-identity.ts'
import { HostOpError } from './lease.ts'

export type StopMode = 'graceful' | 'escalate' | 'immediate'

export interface StopStep {
  at: number
  signal: string
  /** 'group' = kill(-pgid) after group proof; 'pid' = verified pid only */
  scope: 'group' | 'pid'
  /** the identity evidence that authorized THIS signal */
  verified: { startTime: string; pgrp: number }
}

export interface StopReceipt {
  outcome: 'exited' | 'unknown' | 'unverifiable'
  steps: StopStep[]
  observedExit?: { exitCode?: number; signal?: string; at: number }
  evidence: {
    pidReused?: boolean
    groupVerified: boolean
    reason?: string
  }
}

export interface StopTarget {
  /** the incarnation the caller expects to stop */
  incarnation: ProcessIncarnation
  /** live child handle when this daemon spawned it (for exit observation) */
  waitExit?: (timeoutMs: number) => Promise<{ exitCode?: number; signal?: string } | null>
}

const TERM_WAIT_POLL_MS = 50

/**
 * Run the verified stop. Throws HostOpError(PROCESS_UNVERIFIABLE) when the
 * target cannot be proven to be the expected incarnation — signalling an
 * unproven pid is the one thing this controller must never do.
 *
 * Serialized per-process by the caller (process-manager's per-nonce queue).
 */
export async function stopProcess(
  target: StopTarget,
  mode: StopMode,
  graceBudgetMs: number,
  now: () => number = Date.now
): Promise<StopReceipt> {
  const steps: StopStep[] = []
  const inc = target.incarnation
  const expectedPgid = inc.processGroupIdentity ? parsePgid(inc.processGroupIdentity) : undefined

  // ---- pre-check: prove the incarnation before any signal ----------------
  const check = verifyIncarnation(inc)
  if (check.verdict === 'exited') {
    return {
      outcome: 'exited',
      steps,
      observedExit: inc.observedExit,
      evidence: {
        pidReused: check.evidence.reason === 'pid-reused',
        groupVerified: false,
        reason: check.evidence.reason
      }
    }
  }
  if (check.verdict === 'unverifiable') {
    throw new HostOpError(
      'PROCESS_UNVERIFIABLE',
      `cannot stop pid ${inc.pid}: ${check.evidence.reason ?? 'identity unverifiable'}`,
      'reconcile'
    )
  }

  const liveStat = readProcStat(inc.pid!)
  const groupVerified =
    expectedPgid !== undefined && liveStat !== null && liveStat.pgrp === expectedPgid
  const scope: 'group' | 'pid' = groupVerified ? 'group' : 'pid'

  const send = (signal: 'SIGTERM' | 'SIGKILL'): void => {
    // re-verify immediately before signalling — a stop running concurrent
    // with an exit+reuse window must not hit the wrong process
    const stat = readProcStat(inc.pid!)
    if (!stat || stat.startTime !== inc.birthEvidence) {
      throw new HostOpError(
        'PROCESS_UNVERIFIABLE',
        'identity changed before signal — aborting stop',
        'reconcile'
      )
    }
    if (scope === 'group' && stat.pgrp !== expectedPgid) {
      throw new HostOpError(
        'PROCESS_UNVERIFIABLE',
        'process group changed before signal — group stop aborted',
        'reconcile'
      )
    }
    if (scope === 'group') {
      process.kill(-stat.pgrp, signal)
    } else {
      process.kill(stat.pid, signal)
    }
    steps.push({
      at: now(),
      signal,
      scope,
      verified: { startTime: stat.startTime, pgrp: stat.pgrp }
    })
  }

  const awaitExit = async (
    budgetMs: number
  ): Promise<{ exitCode?: number; signal?: string; at?: number } | null> => {
    const deadline = now() + budgetMs
    while (now() < deadline) {
      const v = verifyIncarnation(inc)
      if (v.verdict === 'exited') {
        return target.waitExit ? await target.waitExit(0) : { at: now() }
      }
      await sleep(Math.min(TERM_WAIT_POLL_MS, Math.max(1, deadline - now())))
    }
    return null
  }

  // ---- graceful phase -----------------------------------------------------
  if (mode !== 'immediate') {
    send('SIGTERM')
    const exited = await awaitExit(graceBudgetMs)
    if (exited) {
      return {
        outcome: 'exited',
        steps,
        observedExit: normalizeExit(exited, now),
        evidence: { groupVerified }
      }
    }
    if (mode === 'graceful') {
      // graceful budget exhausted; the process may still be alive or gone —
      // the honest answer is unknown, never assumed-dead
      return {
        outcome: 'unknown',
        steps,
        evidence: { groupVerified, reason: 'grace-budget-exhausted' }
      }
    }
  }

  // ---- escalation ----------------------------------------------------------
  send('SIGKILL')
  const exited = await awaitExit(Math.max(graceBudgetMs, 1000))
  if (exited) {
    return {
      outcome: 'exited',
      steps,
      observedExit: normalizeExit(exited, now),
      evidence: { groupVerified }
    }
  }
  return {
    outcome: 'unknown',
    steps,
    evidence: { groupVerified, reason: 'kill-unconfirmed' }
  }
}

function normalizeExit(
  e: { exitCode?: number; signal?: string; at?: number },
  now: () => number
): { exitCode?: number; signal?: string; at: number } {
  return { exitCode: e.exitCode, signal: e.signal, at: e.at ?? now() }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
