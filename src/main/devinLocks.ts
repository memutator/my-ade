// Declared session-lock sweep.
//
// The lock directory, its file pattern and the holder's executable name are Pack
// data (harnesses.json → lockDir/lockPattern/lockHolder); the safety rule lives
// in packages/mahas-harness-config/src/session-locks.ts and is exercised with
// synthetic locks by integrations/packs/harness-runtime/conformance.smoke.ts.
//
// Triggers are unchanged and owned by the app lifecycle: app start, a
// session-end event, a pty exit, and quit (delayed a beat so the dying CLI can
// unlink its own lock first). Keeping the trigger sites intact is deliberate —
// the Pack declarations decide *which* harnesses and *where*, never *whether*
// the sweep runs.

import fs from 'fs'
import os from 'os'
import {
  sweepSessionLocks,
  type SessionLockSweepIo,
  type SessionLockVerdict
} from '../../packages/mahas-harness-config/src/session-locks.ts'
import {
  expandInstallerPath,
  installerTokenContext,
  lockSweepDeclaration
} from '../../packages/mahas-harness-config/src/runtime-pack.ts'
import { loadHarnessPack } from './harnessPack.ts'

export interface LockSweepResult {
  harnessId: string
  lockDir: string
  removed: number
  verdicts: SessionLockVerdict[]
}

interface LockDeclaration {
  harnessId: string
  lockDir: string
  lockPattern: string
  holder: string
}

/** Real IO. Both safety checks are deliberately conservative. */
function realIo(holder: string): SessionLockSweepIo {
  return {
    list: (dir) => {
      try {
        return fs.readdirSync(dir)
      } catch {
        return []
      }
    },
    inode: (file) => {
      try {
        return fs.statSync(file).ino
      } catch {
        return null
      }
    },
    read: (file) => {
      try {
        return fs.readFileSync(file, 'utf8')
      } catch {
        return null
      }
    },
    // /proc/locks row: "1: FLOCK  ADVISORY  WRITE 1776092 08:02:5242889 0 EOF" —
    // column 5 is <maj>:<min>:<ino>. Inode-only matching can false-positive on a
    // cross-filesystem collision, which merely keeps a stale file — safe side.
    flockHeld: (inode) => {
      const suffix = ':' + inode
      try {
        for (const line of fs.readFileSync('/proc/locks', 'utf8').split('\n')) {
          if (line.split(/\s+/)[5]?.endsWith(suffix)) return true
        }
      } catch {
        /* /proc unreadable — treat as unlocked */
      }
      return false
    },
    pidIsLiveHolder: (pid) => {
      try {
        process.kill(pid, 0)
      } catch {
        return false
      }
      // alive — confirm it is actually the harness (guards against pid reuse).
      // An unreadable cmdline can't prove otherwise → assume live, safe direction.
      try {
        return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').includes(holder)
      } catch {
        return true
      }
    },
    unlink: (file) => {
      fs.unlinkSync(file)
    }
  }
}

function declarations(): LockDeclaration[] {
  const loaded = loadHarnessPack()
  if (!loaded.pack) return []
  const home = os.homedir()
  const ctx = installerTokenContext({ home, hookScriptPath: '', harnessId: 'mahas' })
  const out: LockDeclaration[] = []
  for (const id of Object.keys(loaded.pack.harnesses)) {
    const declared = lockSweepDeclaration(loaded.pack, id)
    if (!declared) continue
    out.push({
      harnessId: id,
      lockDir: expandInstallerPath(declared.lockDirTemplate, ctx),
      lockPattern: declared.lockPattern,
      holder: declared.holder
    })
  }
  return out
}

/**
 * MAHAS_TEST must not touch real user state. Lock files live under
 * $XDG_DATA_HOME — the real ~/.local/share when a test run did not isolate it —
 * so a test without an isolated data home skips the sweep entirely, while a test
 * that does isolate it keeps the real behavior.
 */
function testRunWithoutIsolatedDataHome(): boolean {
  const test = process.env.MAHAS_TEST === '1' || process.env.MAHAS_TEST === 'true'
  return test && !process.env.XDG_DATA_HOME
}

function sweep(declaration: LockDeclaration): LockSweepResult {
  const verdicts = sweepSessionLocks(declaration, realIo(declaration.holder))
  return {
    harnessId: declaration.harnessId,
    lockDir: declaration.lockDir,
    removed: verdicts.filter((v) => v.action === 'removed').length,
    verdicts
  }
}

/** True when any declared harness has lock files waiting to be swept. */
export function declaredLocksPresent(): boolean {
  if (testRunWithoutIsolatedDataHome()) return false
  for (const declaration of declarations()) {
    try {
      if (fs.readdirSync(declaration.lockDir).length > 0) return true
    } catch {
      /* no lock directory */
    }
  }
  return false
}

export function sweepDeclaredSessionLocks(): LockSweepResult[] {
  if (testRunWithoutIsolatedDataHome()) return []
  const results: LockSweepResult[] = []
  for (const declaration of declarations()) {
    try {
      results.push(sweep(declaration))
    } catch {
      /* cleanup must never break the caller */
    }
  }
  const removed = results.reduce((n, r) => n + r.removed, 0)
  if (removed) console.log('[session-locks] removed ' + removed + ' stale session lock(s)')
  return results
}

export function sweepDeclaredSessionLocksFor(harnessId: string): LockSweepResult | null {
  if (testRunWithoutIsolatedDataHome()) return null
  const declaration = declarations().find((d) => d.harnessId === harnessId)
  if (!declaration) return null
  try {
    return sweep(declaration)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ timers */

let timer: NodeJS.Timeout | null = null

// Debounced sweep — fired when a harness may have just died (its session-end
// hook, a pty exit, app quit). The delay lets a cleanly-ending process remove
// its own lock first.
export function scheduleDeclaredLockSweep(delayMs = 1500, harnessId?: string): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    try {
      if (harnessId) sweepDeclaredSessionLocksFor(harnessId)
      else sweepDeclaredSessionLocks()
    } catch {
      /* cleanup must never break the caller */
    }
  }, delayMs)
  timer.unref?.()
}

/* ---------------------------------------------- names the shell still calls
 * src/main/index.ts and src/main/pty.ts call these; they stay thin aliases so
 * the four trigger sites keep working while the Pack owns where and what.
 */

export function devinLocksPresent(): boolean {
  return declaredLocksPresent()
}

export function sweepDevinSessionLocks(): number {
  return sweepDeclaredSessionLocks().reduce((n, r) => n + r.removed, 0)
}

export function scheduleDevinLockSweep(delayMs = 1500): void {
  scheduleDeclaredLockSweep(delayMs, 'devin')
}
