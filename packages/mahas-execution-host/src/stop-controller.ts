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
//     confirmation is lost is STOP_UNKNOWN, never assumed dead; but a pid
//     absent (ESRCH) at re-verify time with the pre-signal birth identity
//     held IS positive exit evidence (natural death under our signal), and
//     a zombie (stat state Z) is dead too — only a present-but-reborn pid
//     (starttime mismatch) is PROCESS_UNVERIFIABLE, never signalled

import type { ProcessIncarnation } from '../../mahas-contracts/src/index.ts'
import { readFileSync } from 'node:fs'
import { platform } from 'node:os'
import { parsePgid, pidExists, readProcStat, verifyIncarnation } from './process-identity.ts'
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

  const send = (signal: 'SIGTERM' | 'SIGKILL'): boolean => {
    const pid = inc.pid!
    // re-verify immediately before signalling — a stop running concurrent
    // with an exit+reuse window must not hit the wrong process. A missing
    // stat is split three ways, never conflated (F-043):
    //   pid gone (ESRCH)      → false: the incarnation is dead — with the
    //                           pre-signal birth identity held, absence IS
    //                           positive exit evidence (natural death)
    //   stat present, reborn  → throw: genuine pid reuse, never signalled
    //   pid present, unreadable → throw: unverifiable, as before
    const stat = readProcStat(pid)
    if (!stat) {
      if (!pidExists(pid)) return false
      throw new HostOpError(
        'PROCESS_UNVERIFIABLE',
        `cannot verify pid ${pid} before signal — birth evidence unreadable`,
        'reconcile'
      )
    }
    if (stat.startTime !== inc.birthEvidence) {
      throw new HostOpError(
        'PROCESS_UNVERIFIABLE',
        inc.birthEvidence === undefined
          ? `no birth evidence for pid ${pid} — aborting stop`
          : `pid ${pid} reused before signal — aborting stop`,
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
    try {
      if (scope === 'group') {
        process.kill(-stat.pgrp, signal)
      } else {
        process.kill(stat.pid, signal)
      }
    } catch (e) {
      // exit squeezed between the stat read and the kill — same natural
      // death as the pid-gone path above, not a signalling failure
      if ((e as NodeJS.ErrnoException).code === 'ESRCH' && !pidExists(pid)) return false
      throw e
    }
    steps.push({
      at: now(),
      signal,
      scope,
      verified: { startTime: stat.startTime, pgrp: stat.pgrp }
    })
    return true
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
      if (v.verdict === 'live' && typeof inc.pid === 'number' && isZombiePid(inc.pid)) {
        // zombie = terminated, awaiting reap — positive exit evidence even
        // though the starttime still matches (the oracle reads 'live').
        // Prefer the owned handle's exit record, fall back to the kernel fact.
        const observed = target.waitExit ? await target.waitExit(0) : null
        return observed ?? { at: now() }
      }
      await sleep(Math.min(TERM_WAIT_POLL_MS, Math.max(1, deadline - now())))
    }
    return null
  }

  // ---- graceful phase -----------------------------------------------------
  // send() returning false means the pid is absent at (re-)verify time —
  // natural death with the pre-signal birth identity held: report exited,
  // never STOP_UNKNOWN (F-043)
  const reportGone = async (reason: string): Promise<StopReceipt> => {
    const observed = target.waitExit ? await target.waitExit(0) : null
    return {
      outcome: 'exited',
      steps,
      observedExit: normalizeExit(observed ?? { at: now() }, now),
      evidence: { groupVerified, reason }
    }
  }
  if (mode !== 'immediate') {
    if (!send('SIGTERM')) return reportGone('pid-absent-before-signal')
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
  // a pid absent here died under (or just after) our SIGTERM — the signal
  // did its job, so this is exited, not kill-unconfirmed (F-043)
  if (!send('SIGKILL')) return reportGone('pid-absent-after-signal')
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

/**
 * Linux zombie check — /proc/<pid>/stat field 3 (state). Local to this
 * controller, not the shared identity oracle: a zombie's starttime still
 * matches, so verifyIncarnation honestly reads 'live'; the kernel state is
 * the cheaper positive death evidence. Non-Linux always answers false.
 */
function isZombiePid(pid: number): boolean {
  if (platform() !== 'linux') return false
  let raw: string
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return false
  }
  const close = raw.lastIndexOf(')')
  if (close < 0) return false
  return raw.slice(close + 1).trim().split(/\s+/)[0] === 'Z'
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
