// Electron glue for agent lifecycle hooks:
//  - tails the NDJSON event file that harness hook scripts append to
//    (resources/ade-hook.cjs, resources/ade-opencode-plugin.js) and forwards
//    each event to the renderer as `agent:event`
//  - IPC for the Settings "Agent hooks" section: status / install / test

import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { EventLogTailer, eventsFilePath, appendEvent, AgentHookEvent } from './eventsFile'
import { hookStatuses, installHook } from './hookInstallers'

function resourceFile(name: string): string {
  if (is.dev) return join(app.getAppPath(), 'resources', name)
  return join(process.resourcesPath, name)
}

let tailer: EventLogTailer | null = null

export function startEventIngest(getWindow: () => BrowserWindow | null): void {
  tailer?.stop()
  tailer = new EventLogTailer(
    eventsFilePath(),
    (ev: AgentHookEvent) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev)
    },
    (e) => console.error('[hooks] event tail error', e)
  )
  tailer.start()
}

export function registerHookIpc(): void {
  ipcMain.handle('hooks:status', () =>
    hookStatuses(resourceFile('ade-hook.cjs'), resourceFile('ade-opencode-plugin.js'))
  )
  ipcMain.handle('hooks:install', (_e, provider: string) =>
    installHook(provider, resourceFile('ade-hook.cjs'), resourceFile('ade-opencode-plugin.js'))
  )
  // Writes a synthetic event through the real file channel — end-to-end test.
  ipcMain.handle('hooks:test', (_e, provider: string) => {
    try {
      appendEvent({
        provider: typeof provider === 'string' && provider ? provider : 'unknown',
        event: 'turn-complete',
        cwd: process.cwd(),
        sessionId: `ade-test-${Date.now()}`,
        adeSession: process.env.ADE_SESSION,
        message: 'test notification from ade'
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) }
    }
  })
}
