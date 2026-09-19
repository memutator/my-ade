// mahas terminal — the transport a terminal block talks to.
//
// There are two ways a terminal-shaped thing can exist in mahas, and they are
// NOT interchangeable (IMP-01 feature boundary, AGENTS.md):
//
//   · a SHELL terminal — a `kind: 'term'` block, spawned through the app-owned
//     pty host. Its session id is `paneId:tabId:uuid`, its lifetime is the tab
//     record's, and it needs no authorization because it is just a shell the
//     user already has. This module is that transport.
//
//   · a MANAGED execution — a runtime-domain Execution with a member, grant
//     and receipts, reached only through `window.mahas.exec.*`. It is never
//     spawned as an anonymous pty, and a shell terminal never silently becomes
//     one.
//
// Naming the shell transport here is what keeps that distinction checkable:
// a caller reading `shellTransport.spawn(...)` knows which world it is in, and
// nothing in the terminal feature reaches for `window.mahas.exec` — a managed
// launch has its own lifecycle (worker.start → join) that this view cannot
// drive.

export interface SpawnOptions {
  /** `paneId:tabId:uuid` — stable per tab mount, so a remount re-attaches */
  id: string
  cols: number
  rows: number
  cwd?: string
}

export interface ShellTransport {
  spawn: (opts: SpawnOptions) => void
  /** false when the session is gone — the caller spawns a fresh one */
  attach: (id: string, cols: number, rows: number) => Promise<boolean>
  write: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  kill: (id: string) => void
  onEvent: (cb: (e: ShellEvent) => void) => () => void
}

/**
 * The pty host's event union as this view consumes it. Structurally the
 * preload bridge's `PtyEvent` — declared here as the terminal feature's own
 * input contract so the view depends on the shape it reads, not on the
 * preload module (which the renderer must not import).
 */
export interface ShellEvent {
  t: 'spawned' | 'attached' | 'attach-failed' | 'data' | 'exit' | 'cwd' | 'agent' | 'error'
  id: string
  /** base64 */
  d?: string
  pid?: number
  shell?: string
  code?: number
  cwd?: string
  agent?: string | null
  msg?: string
}

/**
 * The unmanaged shell transport: the app's own pty host.
 *
 * spawn is fire-and-forget because the session's existence is confirmed by the
 * `spawned`/`attached` event, not by the invoke — the view must render before
 * the shell is up (the shell may never come up at all, and that is a state the
 * tab shows rather than an exception it throws).
 */
export function shellTransport(): ShellTransport {
  return {
    spawn: (opts) => {
      void window.mahas.pty.spawn(opts)
    },
    attach: (id, cols, rows) => window.mahas.pty.attach(id, cols, rows),
    write: (id, data) => window.mahas.pty.write(id, data),
    resize: (id, cols, rows) => window.mahas.pty.resize(id, cols, rows),
    kill: (id) => window.mahas.pty.kill(id),
    onEvent: (cb) => window.mahas.pty.onEvent(cb)
  }
}

/**
 * Session id for a tab mount. Derived from the tab's identity plus a fresh
 * UUID, so a stale `exit` from a killed session (StrictMode remount, HMR, tab
 * restart) can never land on a new session under the same id.
 */
export function newSessionId(paneId: string, tabId: string): string {
  return `${paneId}:${tabId}:${crypto.randomUUID()}`
}
