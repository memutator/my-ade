// Devin CLI session-lock sweeper.
//
// `devin` creates $XDG_DATA_HOME/devin/cli/session_locks/<session>.lock when a
// session opens — the holder's pid inside, an flock held for the process
// lifetime — and unlinks it on clean exit. A killed/crashed CLI leaves the
// file behind and the next open of that session is refused with
// `session_locked` even though nothing holds it: the CLI never reclaims a
// dead pid's lock (observed on 3000.10.31). mahas terminals kill agents by
// closing their pane, so stale locks accumulate fast.
//
// A lock is stale iff no flock is held on its inode AND the recorded pid is
// dead or isn't a devin process (recycled pid). Both checks keep the sweep
// safe — pid-alive covers the open()→flock() race window, flock-absence is
// the authoritative "nobody holds it".

import fs from 'fs'
import os from 'os'
import path from 'path'

function locksDir(): string {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(data, 'devin', 'cli', 'session_locks')
}

export function devinLocksPresent(): boolean {
  try {
    return fs.readdirSync(locksDir()).some((n) => n.endsWith('.lock'))
  } catch {
    return false
  }
}

// /proc/locks row: "1: FLOCK  ADVISORY  WRITE 1776092 08:02:5242889 0 EOF" —
// column 5 is <maj>:<min>:<ino>. Inode-only matching can false-positive on a
// cross-filesystem collision, which merely keeps a stale file — safe side.
function flockHeld(ino: number): boolean {
  const suffix = ':' + ino
  try {
    for (const line of fs.readFileSync('/proc/locks', 'utf8').split('\n')) {
      if (line.split(/\s+/)[5]?.endsWith(suffix)) return true
    }
  } catch {
    /* /proc unreadable — treat as unlocked */
  }
  return false
}

function pidIsLiveDevin(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  // alive — confirm it's actually devin (guards against pid reuse). An
  // unreadable cmdline can't prove otherwise → assume live, safe direction.
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('devin')
  } catch {
    return true
  }
}

export function sweepDevinSessionLocks(): number {
  let names: string[] = []
  try {
    names = fs.readdirSync(locksDir()).filter((n) => n.endsWith('.lock'))
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const file = path.join(locksDir(), name)
    try {
      const st = fs.statSync(file)
      const pid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
      if (flockHeld(st.ino)) continue
      if (Number.isInteger(pid) && pid > 0 && pidIsLiveDevin(pid)) continue
      fs.unlinkSync(file)
      removed++
    } catch {
      /* vanished mid-sweep or unreadable — skip */
    }
  }
  if (removed) console.log(`[devin-locks] removed ${removed} stale session lock(s)`)
  return removed
}

let timer: NodeJS.Timeout | null = null

// Debounced sweep — fired when a devin may have just died (its SessionEnd
// hook, a pty exit, app quit). The delay lets a cleanly-ending process remove
// its own lock first.
export function scheduleDevinLockSweep(delayMs = 1500): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    try {
      sweepDevinSessionLocks()
    } catch {
      /* cleanup must never break the caller */
    }
  }, delayMs)
  timer.unref?.()
}
