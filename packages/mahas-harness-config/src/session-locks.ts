// Session-lock safety core.
//
// A harness can leave a session-lock file behind when its CLI is killed: the
// lock file records the holder pid and the harness refuses to reopen that
// session while the file exists, even though nothing holds it. Sweeping those
// files is destructive only if we guess wrong, so the decision is a pure
// function of two independent facts — "does anything hold this inode" and "is
// the recorded pid alive and actually the harness" — and every IO dependency is
// injected. That makes the whole rule set testable with synthetic locks, with no
// real process table, flock or home directory involved.
//
// Declaration comes from the Pack (harness lockDir/lockPattern/lockHolder), so
// the core contains no harness name.

export interface SessionLockDeclaration {
  harnessId: string
  lockDir: string
  lockPattern: string
  holder: string
}

export interface SessionLockSweepIo {
  /** names inside lockDir (an unreadable directory yields []) */
  list(lockDir: string): string[]
  /** inode of a lock file, or null when it vanished */
  inode(file: string): number | null
  /** contents of the lock file (the recorded pid), or null */
  read(file: string): string | null
  /** true when any process holds an flock on this inode */
  flockHeld(inode: number): boolean
  /** true when the pid is alive and its cmdline identifies the harness */
  pidIsLiveHolder(pid: number): boolean
  unlink(file: string): void
}

export interface SessionLockVerdict {
  file: string
  action: 'removed' | 'kept'
  reason:
    'flock-held' | 'holder-alive' | 'pid-dead-or-other-process' | 'no-usable-pid' | 'unreadable'
}

/** The whole safety rule, as one pure decision. */
export function decideSessionLock(input: {
  flockHeld: boolean
  pid: number | null
  holderAlive: boolean
}): 'keep' | 'remove' {
  if (input.flockHeld) return 'keep'
  if (input.pid !== null && input.pid > 0 && input.holderAlive) return 'keep'
  return 'remove'
}

export function sweepSessionLocks(
  declaration: SessionLockDeclaration,
  io: SessionLockSweepIo
): SessionLockVerdict[] {
  const verdicts: SessionLockVerdict[] = []
  const names = io.list(declaration.lockDir)
  for (const name of names) {
    if (!matchesPattern(name, declaration.lockPattern)) continue
    const file = declaration.lockDir.replace(/\/+$/, '') + '/' + name
    const inode = io.inode(file)
    if (inode === null) continue
    const detail = io.read(file)
    if (detail === null) {
      verdicts.push({ file, action: 'kept', reason: 'unreadable' })
      continue
    }
    const parsed = Number.parseInt(detail.trim(), 10)
    const pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null
    const held = io.flockHeld(inode)
    const alive = pid !== null ? io.pidIsLiveHolder(pid) : false
    const decision = decideSessionLock({ flockHeld: held, pid, holderAlive: alive })
    if (decision === 'keep') {
      verdicts.push({ file, action: 'kept', reason: held ? 'flock-held' : 'holder-alive' })
      continue
    }
    if (pid === null) {
      // a lock with no usable pid is removed only when nothing holds its inode
      verdicts.push({ file, action: 'removed', reason: 'no-usable-pid' })
    } else {
      verdicts.push({ file, action: 'removed', reason: 'pid-dead-or-other-process' })
    }
    io.unlink(file)
  }
  return verdicts
}

function matchesPattern(name: string, pattern: string): boolean {
  if (!pattern || pattern === '*') return true
  if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1))
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1))
  return name === pattern
}
