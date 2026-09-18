// Electron glue for agent lifecycle hooks:
//  - tails the NDJSON event file that harness hook scripts append to
//    (resources/mahas-hook.cjs, resources/mahas-opencode-plugin.js) and forwards
//    each event to the renderer as `agent:event`
//  - IPC for the Settings "Agent hooks" section: status / install / test

import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { EventLogTailer, eventsFilePath, appendEvent, AgentHookEvent } from './eventsFile'
import { hookStatuses, installHook, refreshInstalledHooks } from './hookInstallers'
import { scheduleDevinLockSweep } from './devinLocks'

function resourceFile(name: string): string {
  if (is.dev) return join(app.getAppPath(), 'resources', name)
  return join(process.resourcesPath, name)
}

let tailer: EventLogTailer | null = null

export function startEventIngest(getWindow: () => BrowserWindow | null): void {
  // keep mahas-owned hook artifacts (script copy, grok hook file, opencode
  // plugin) in sync with the shipped version before events start flowing
  refreshInstalledHooks(resourceFile('mahas-hook.cjs'), resourceFile('mahas-opencode-plugin.js'))
  tailer?.stop()
  tailer = new EventLogTailer(
    eventsFilePath(),
    (ev: AgentHookEvent) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev)
      // a devin session ending may mean the CLI exited without unlinking its
      // session lock — sweep after a beat (foreign events count too: the lock
      // dir is shared, and the sweep only drops provably-dead holders)
      if (ev.provider === 'devin' && ev.event === 'session-end') scheduleDevinLockSweep()
    },
    (e) => console.error('[hooks] event tail error', e)
  )
  tailer.start()
}

export function registerHookIpc(): void {
  ipcMain.handle('hooks:status', () =>
    hookStatuses(resourceFile('mahas-hook.cjs'), resourceFile('mahas-opencode-plugin.js'))
  )
  ipcMain.handle('hooks:install', (_e, provider: string) =>
    installHook(provider, resourceFile('mahas-hook.cjs'), resourceFile('mahas-opencode-plugin.js'))
  )
  // Writes a synthetic event through the real file channel — end-to-end test.
  ipcMain.handle('hooks:test', (_e, provider: string) => {
    try {
      appendEvent({
        provider: typeof provider === 'string' && provider ? provider : 'unknown',
        event: 'turn-complete',
        cwd: process.cwd(),
        sessionId: `mahas-test-${Date.now()}`,
        mahasSession: process.env.MAHAS_SESSION,
        message: 'test notification from mahas',
        force: true
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) }
    }
  })
  // Renderer-originated events (e.g. session-rename after a tab rename) travel
  // the same file channel so every mahas instance sees them — stamped with this
  // instance's session so the tailer marks them `ours`.
  ipcMain.handle('hooks:emit', (_e, ev: AgentHookEvent) => {
    try {
      if (!ev || typeof ev.provider !== 'string' || typeof ev.event !== 'string') {
        return { ok: false, error: 'bad event' }
      }
      appendEvent({ ...ev, mahasSession: process.env.MAHAS_SESSION })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) }
    }
  })
}
