// mahas-execution-host — process identity and birth evidence (IMP-18).
//
// D-EXEC §1: ProcessIncarnation = {hostId, spawnNonce, pid, birthEvidence,
// bootId?, processGroupIdentity, observedExit?}. A pid alone is NOT an
// identity — Linux reuses pids aggressively, so every admission that acts
// on a process must re-prove pid+birth (+ bootId + process group) before
// signalling or claiming liveness (spec/contracts/execution-host.md
// host.process.probe/stop, spec/execution-lifecycle.md §5).
//
// Evidence strength is platform-dependent and recorded honestly:
//   Linux  — /proc/<pid>/stat starttime (clock ticks since boot) + pgrp.
//            starttime distinguishes same-pid incarnations across reuse.
//   other  — no birth evidence implemented here; probes answer
//            'unverifiable' rather than pretending certainty.

import { readFileSync } from 'node:fs'
import { platform } from 'node:os'
import type { ProcessIncarnation } from '../../mahas-contracts/src/index.ts'

/** parsed /proc/<pid>/stat evidence — the fields identity checks need */
export interface ProcStatEvidence {
  pid: number
  /** field 5 — process group id; equals pid when the child is a group leader */
  pgrp: number
  /** field 6 — session id */
  session: number
  /** field 22 — jiffies since boot; distinguishes incarnations of a reused pid */
  startTime: string
  comm: string
}

/**
 * Read /proc/<pid>/stat. comm may contain spaces/parens — the only robust
 * parse is to split at the LAST ')' and take fields after it.
 * Returns null when the pid is absent or the stat is unreadable.
 */
export function readProcStat(pid: number): ProcStatEvidence | null {
  if (platform() !== 'linux') return null
  let raw: string
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return null
  }
  const close = raw.lastIndexOf(')')
  if (close < 0) return null
  const comm = raw.slice(raw.indexOf('(') + 1, close)
  // fields after comm start at field 3 (state)
  const rest = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const pgrp = Number(rest[2]) // field 5
  const session = Number(rest[3]) // field 6
  const startTime = rest[19] // field 22
  if (!startTime || !Number.isFinite(pgrp) || !Number.isFinite(session)) return null
  return { pid, pgrp, session, startTime, comm }
}

/** kernel boot id — constant per boot, ties birth evidence to this boot */
export function readBootId(): string | undefined {
  if (platform() !== 'linux') return undefined
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Is there ANY process with this pid right now? kill(pid, 0) is the cheap
 * probe — EPERM still means it exists.
 */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type IdentityVerdict = 'live' | 'exited' | 'unverifiable'

export interface IdentityCheck {
  verdict: IdentityVerdict
  /** what the host actually observed — carried into probe/stop receipts */
  evidence: {
    pidPresent: boolean
    startTimeMatch?: boolean
    pgrpMatch?: boolean
    observedStartTime?: string
    observedPgrp?: number
    reason?: string
  }
}

/**
 * Verify a stored ProcessIncarnation against the live OS. This is the ONLY
 * liveness oracle process/terminal ops may use — a stored state column or
 * a heartbeat timestamp is never death evidence (REQ-11/REQ-15).
 *
 *   pid absent                          → 'exited' (positive: nothing to reuse)
 *   pid present, starttime matches      → 'live'
 *   pid present, starttime differs      → 'exited' — the pid was reused by an
 *                                         unrelated process; our incarnation
 *                                         is gone (never 'unverifiable', and
 *                                         NEVER signalled)
 *   no /proc birth evidence available   → 'unverifiable'
 */
export function verifyIncarnation(inc: ProcessIncarnation): IdentityCheck {
  const pid = inc.pid
  if (typeof pid !== 'number' || pid <= 0) {
    return { verdict: 'unverifiable', evidence: { pidPresent: false, reason: 'no-pid' } }
  }
  if (!pidExists(pid)) {
    return {
      verdict: 'exited',
      evidence: { pidPresent: false, reason: 'pid-absent' }
    }
  }
  const stat = readProcStat(pid)
  if (!stat) {
    // pid exists but birth evidence is unreadable (non-linux / proc race)
    return {
      verdict: 'unverifiable',
      evidence: { pidPresent: true, reason: 'birth-evidence-unavailable' }
    }
  }
  const expectedStart = inc.birthEvidence
  const startTimeMatch = expectedStart !== undefined && stat.startTime === expectedStart
  const ev: IdentityCheck['evidence'] = {
    pidPresent: true,
    startTimeMatch,
    observedStartTime: stat.startTime,
    observedPgrp: stat.pgrp
  }
  if (expectedStart !== undefined && stat.startTime !== expectedStart) {
    ev.reason = 'pid-reused'
    return { verdict: 'exited', evidence: ev }
  }
  if (expectedStart === undefined) {
    ev.reason = 'no-stored-birth-evidence'
    return { verdict: 'unverifiable', evidence: ev }
  }
  // birth matches — also compare the process group when one was recorded
  if (inc.processGroupIdentity !== undefined) {
    const expectedPgrp = parsePgid(inc.processGroupIdentity)
    ev.pgrpMatch = expectedPgrp === undefined ? undefined : stat.pgrp === expectedPgrp
    if (expectedPgrp !== undefined && stat.pgrp !== expectedPgrp) {
      // same pid+starttime but a different group — process re-parented its
      // group (setpgid) after spawn; identity holds, group claims do not
      ev.reason = 'pgrp-changed'
    }
  }
  return { verdict: 'live', evidence: ev }
}

/** encode/decode processGroupIdentity — 'pgid:<n>' keeps the field opaque */
export function formatPgid(pgid: number): string {
  return `pgid:${pgid}`
}
export function parsePgid(identity: string): number | undefined {
  const m = /^pgid:(\d+)$/.exec(identity)
  return m ? Number(m[1]) : undefined
}

/**
 * Build the incarnation to persist right after a successful OS spawn.
 * birthEvidence is undefined (honestly absent) on platforms without /proc —
 * probes of such incarnations can only ever answer 'unverifiable'.
 */
export function captureIncarnation(
  hostId: string,
  spawnNonce: string,
  pid: number
): ProcessIncarnation {
  const stat = readProcStat(pid)
  return {
    hostId,
    spawnNonce,
    pid,
    birthEvidence: stat?.startTime,
    bootId: readBootId(),
    // a detached child is its own group leader — record what the OS says,
    // never assume pgid == pid
    processGroupIdentity: stat ? formatPgid(stat.pgrp) : undefined
  }
}
