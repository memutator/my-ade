import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn, spawnSync, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

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
  if (process.env.ADE_NODE) return process.env.ADE_NODE
  if (process.env.NODE_BINARY) return process.env.NODE_BINARY
  if (!spawnSync('node', ['--version'], { stdio: 'ignore' }).error) return 'node'
  const home = homedir()
  for (const p of [
    '/usr/bin/node',
    '/usr/local/bin/node',
    '/snap/bin/node',
    '/home/linuxbrew/.linuxbrew/bin/node',
    join(home, '.volta/bin/node'),
    join(home, '.local/bin/node'),
    join(home, '.asdf/shims/node')
  ]) {
    if (existsSync(p)) return p
  }
  for (const base of [
    join(home, '.nvm/versions/node'),
    join(home, '.local/share/mise/installs/node'),
    join(home, '.local/share/fnm/node-versions'),
    join(home, '.asdf/installs/nodejs')
  ]) {
    const found = newestNodeUnder(base)
    if (found) return found
  }
  return 'node'
}

function newestNodeUnder(base: string): string | null {
  try {
    const dirs = readdirSync(base)
      .map((v) => ({ v, m: v.match(/^v?(\d+)\.(\d+)\.(\d+)/) }))
      .filter((x): x is { v: string; m: RegExpMatchArray } => !!x.m)
      .sort((a, b) => [1, 2, 3].reduce((d, i) => d || Number(b.m[i]) - Number(a.m[i]), 0))
    for (const { v } of dirs) {
      for (const c of [
        join(base, v, 'bin', 'node'),
        join(base, v, 'installation', 'bin', 'node')
      ]) {
        if (existsSync(c)) return c
      }
    }
  } catch {
    /* dir absent */
  }
  return null
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
    env: { ...process.env, ADE_PTY_HOST: '1' }
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
