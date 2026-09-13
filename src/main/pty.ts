import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { existsSync } from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

let host: ChildProcess | null = null
let hostReady = false
const queue: string[] = []

function hostScriptPath(): string {
  if (is.dev) return join(app.getAppPath(), 'resources', 'pty-host.cjs')
  return join(process.resourcesPath, 'pty-host.cjs')
}

function nodeBinary(): string {
  if (process.env.ADE_NODE) return process.env.ADE_NODE
  // Prefer the node on PATH (nvm etc.); fall back to common locations.
  return process.env.NODE_BINARY || 'node'
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
  host = spawn(nodeBinary(), [script], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ADE_PTY_HOST: '1' }
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
