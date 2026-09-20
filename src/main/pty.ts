import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { existsSync } from 'fs'
import { join } from 'path'
import { findNodeBinary } from './platform/nodeBinary.ts'
import { is } from '@electron-toolkit/utils'
import { scheduleDevinLockSweep } from './devinLocks'

let host: ChildProcess | null = null
let hostReady = false
const queue: string[] = []

function hostScriptPath(): string {
  if (is.dev) return join(app.getAppPath(), 'resources', 'pty-host.cjs')
  return join(process.resourcesPath, 'pty-host.cjs')
}

// Desktop-entry/launcher starts don't inherit interactive-shell PATH, so
// version-manager installs (nvm/volta/fnm/mise/…) disappear. Probe PATH first,
// then scan well-known install locations.
function nodeBinary(): string {
  return findNodeBinary() ?? 'node'
}

function sendToHost(msg: object): void {
  const line = JSON.stringify(msg) + '\n'
  if (host && hostReady && host.stdin && !host.stdin.destroyed) {
    host.stdin.write(line)
  } else {
    queue.push(line)
  }
}

// pending attach requests: session id -> resolve(ok). The host replies with
// `attached`/`attach-failed`; whichever arrives first resolves the invoke.
const pendingAttach = new Map<string, (ok: boolean) => void>()

export function startPtyHost(): void {
  const script = hostScriptPath()
  if (!existsSync(script)) {
    console.error('[pty-host] script not found:', script)
    return
  }
  const bin = nodeBinary()
  host = spawn(bin, [script], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, MAHAS_PTY_HOST: '1' }
  })
  host.on('error', (err) => {
    // e.g. node not found anywhere — keep the app alive, terminals just stay dead
    console.error('[pty-host] spawn failed:', bin, err.message)
    host = null
    hostReady = false
  })

  const rl = createInterface({ input: host.stdout!, terminal: false })
  rl.on('line', (line) => {
    let m: { t?: string; id?: string }
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m.t === 'ready') {
      hostReady = true
      while (queue.length) host!.stdin!.write(queue.shift()!)
      return
    }
    if ((m.t === 'attached' || m.t === 'attach-failed') && m.id) {
      const res = pendingAttach.get(m.id)
      if (res) {
        pendingAttach.delete(m.id)
        res(m.t === 'attached')
      }
    }
    // a closed pane kills the agent inside its shell — if that was devin,
    // its session lock just went stale (the CLI doesn't unlink on kill)
    if (m.t === 'exit') scheduleDevinLockSweep()
    // broadcast to every window — detached panes live in separate renderers
    // that need their session's live data too
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('pty:event', m)
    }
  })

  host.on('exit', (code) => {
    console.error('[pty-host] exited with code', code)
    host = null
    hostReady = false
  })
}

// Kill the host on app quit. Otherwise it outlives mahas as an orphan (its
// poll timers keep the event loop alive even after stdin EOF) — and the
// orphaned shells keep their agents running as zombies, so a restart would
// offer to "resume" sessions that are still alive somewhere invisible.
// The host kills its pty sessions on SIGTERM, so plain kill() is safe.
export function stopPtyHost(): void {
  try {
    sendToHost({ t: 'quit' })
  } catch {
    /* stdin already gone — fall through to the signal */
  }
  try {
    host?.kill()
  } catch {
    /* already gone */
  }
}

export function registerPtyIpc(): void {
  ipcMain.handle('pty:spawn', (_e, m) => sendToHost({ t: 'spawn', ...m }))
  ipcMain.handle(
    'pty:attach',
    (_e, m: { id: string; cols?: number; rows?: number }) =>
      new Promise<boolean>((resolve) => {
        pendingAttach.set(m.id, resolve)
        sendToHost({ t: 'attach', ...m })
        // host should reply instantly; bound the wait so a wedged host
        // doesn't hang the caller forever
        setTimeout(() => {
          if (pendingAttach.delete(m.id)) resolve(false)
        }, 3000)
      })
  )
  ipcMain.on('pty:write', (_e, m) => sendToHost({ t: 'write', ...m }))
  ipcMain.on('pty:resize', (_e, m) => sendToHost({ t: 'resize', ...m }))
  ipcMain.on('pty:kill', (_e, m) => sendToHost({ t: 'kill', ...m }))
}

export function configureAgents(patterns: Record<string, string[]>): void {
  sendToHost({ t: 'config', agents: patterns })
}
