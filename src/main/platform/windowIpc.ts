// mahas main — `win:*` IPC (window controls, detach/reattach, attention).
//
// Split from the window registry because the two answer different questions:
// the registry decides which windows exist, this decides what the renderer is
// allowed to ask of them. Every control targets the SENDER's own window, so a
// detached pane's titlebar buttons act on its own OS window and never on the
// main one.

import { app, ipcMain, BrowserWindow } from 'electron'

export interface WindowIpcDeps {
  main: () => BrowserWindow | null
  detached: (wsId: string, paneId: string) => BrowserWindow | undefined
  openDetached: (wsId: string, paneId: string, pane?: unknown) => void
  focusMain: () => void
  confirmQuit: () => void
  /** detached key by webContents id — a booting detached renderer claims its pane */
  winKeyByWebContents: Map<number, string>
  pendingPanes: Map<string, unknown>
}

export function registerWindowIpc(deps: WindowIpcDeps): void {
  // window controls target the sender's own window (main or a detached pane)
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  // renderer confirmed the quit (or nothing was running) — close for real,
  // taking any detached windows down with it
  ipcMain.on('win:force-close', () => {
    deps.confirmQuit()
    app.quit()
  })
  ipcMain.on('win:alwaysOnTop', (e, flag: boolean) => {
    BrowserWindow.fromWebContents(e.sender)?.setAlwaysOnTop(!!flag)
  })

  ipcMain.on('win:detach', (_e, m: { wsId: string; paneId: string; pane?: unknown }) => {
    if (!m?.wsId || !m?.paneId) return
    deps.openDetached(m.wsId, m.paneId, m.pane)
  })
  // a booting detached renderer claims its fresh pane snapshot here
  ipcMain.handle('pane:hello', (e) => {
    const key = deps.winKeyByWebContents.get(e.sender.id)
    if (!key) return null
    const [wsId, paneId] = key.split(':')
    const pane = deps.pendingPanes.get(key) ?? null
    deps.pendingPanes.delete(key)
    return { wsId, paneId, pane }
  })
  // detached window asks to go home — closing it triggers the registry's
  // 'closed' handler which notifies the main window to reattach the pane
  ipcMain.on('win:reattach', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('win:closeDetached', (_e, m: { wsId: string; paneId: string }) => {
    deps.detached(m?.wsId, m?.paneId)?.close()
  })
  ipcMain.on('win:focusDetached', (_e, m: { wsId: string; paneId: string }) => {
    const win = deps.detached(m?.wsId, m?.paneId)
    if (win && !win.isDestroyed()) {
      win.show()
      win.focus()
    }
  })
  // attention state of the window HOSTING a pane (detached panes live in
  // their own window) — the renderer's notify policy keys off this:
  // 'focused' can be attended/ambient, anything else is 'away'
  ipcMain.handle('win:state', (_e, m: { wsId?: string; paneId?: string; detached?: boolean }) => {
    // test seam: MAHAS_FAKE_FOCUS pins the verdict so e2e can exercise every
    // attention level deterministically — a hidden window can never hold
    // real OS focus (Wayland won't let an app self-focus anyway)
    if (process.env.MAHAS_FAKE_FOCUS && !m?.detached) return process.env.MAHAS_FAKE_FOCUS
    const win = m?.detached ? deps.detached(m.wsId ?? '', m.paneId ?? '') : deps.main()
    if (!win || win.isDestroyed()) return 'hidden'
    if (win.isMinimized()) return 'minimized'
    if (win.isFocused()) return 'focused'
    return 'visible'
  })
  // detached renderer → main window store actions (close pane etc.)
  ipcMain.on('pane:cmd', (_e, m) => {
    const main = deps.main()
    if (main && !main.isDestroyed()) main.webContents.send('pane:cmd', m)
  })
  // detached renderer pushes its local pane state up to the main store
  ipcMain.on('pane:syncUp', (_e, m) => {
    const main = deps.main()
    if (main && !main.isDestroyed()) main.webContents.send('pane:applySync', m)
  })
}
