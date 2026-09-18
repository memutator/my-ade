import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  dialog,
  clipboard,
  Notification,
  net,
  screen
} from 'electron'
import { join, basename, extname, isAbsolute, resolve } from 'path'
import { pathToFileURL } from 'url'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { readFile, writeFile, stat, readdir } from 'fs/promises'
import { readFileSync, mkdirSync, existsSync, writeFileSync, renameSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { startPtyHost, registerPtyIpc, configureAgents, stopPtyHost } from './pty'
import { startEventIngest, registerHookIpc } from './hooks'
import { sweepDevinSessionLocks, devinLocksPresent } from './devinLocks'
import { appendCapped, decisionsFilePath } from './eventsFile'
import { registerFileWatchIpc } from './filewatch'
import { registerFsOpsIpc } from './fsops'
import { registerDirWatchIpc } from './dirwatch'
import { registerWorktreeIpc } from './worktree'
import { registerUsageIpc } from './usage'
import { windowStateFor, trackWindowState } from './windowState'

app.commandLine.appendSwitch('ozone-platform-hint', 'auto')

// productName is the display name (Mahas); userData doubles as the agent
// event-channel dir (~/.config/mahas). The ade → mahas rename adopts the old
// profile dir wholesale so state, window geometry, icon caches and hook
// plumbing all survive.
// Dev runs get a fully isolated profile — own userData (state file, window
// geometry, webview sessions, icon cache) AND own MAHAS_CONFIG_DIR (event
// channel, hook script copy, decision log) — so `npm run dev` never fights
// the installed app over live session state. Hook scripts resolve
// MAHAS_CONFIG_DIR from the spawned agent's env, so dev-terminal agents emit
// into the dev channel while the user's real harness configs stay shared.
// MAHAS_TEST (e2e) keeps the stock layout — its isolation is XDG_CONFIG_HOME.
const devProfile = is.dev && !process.env.MAHAS_TEST
const userDataDir = join(app.getPath('appData'), devProfile ? 'mahas-dev' : 'mahas')
try {
  const legacy = join(app.getPath('appData'), devProfile ? 'ade-dev' : 'ade')
  if (!existsSync(userDataDir) && existsSync(legacy)) {
    renameSync(legacy, userDataDir)
    const st = join(userDataDir, 'ade-state.json')
    if (existsSync(st)) renameSync(st, join(userDataDir, 'mahas-state.json'))
  }
} catch {
  /* first-boot migration is best-effort */
}
app.setPath('userData', userDataDir)
if (devProfile && !process.env.MAHAS_CONFIG_DIR) {
  const cfgBase = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  process.env.MAHAS_CONFIG_DIR = join(cfgBase, 'mahas-dev')
}
// renderers inherit the env — the titlebar shows a red dev badge on it
if (devProfile) process.env.MAHAS_DEV = '1'

// Per-run session tag: pty-host inherits it, every spawned shell and agent
// CLI carries it, and hook scripts stamp it onto each event. The tailer drops
// events from foreign sessions (agents running outside mahas, or another mahas
// instance) so notifications only fire for OUR terminals.
process.env.MAHAS_SESSION ??= randomUUID()

const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.bmp',
  '.avif'
])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.m4v', '.mov', '.ogv'])
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac', '.opus'])
const MAX_FILE_BYTES = 20 * 1024 * 1024

let mainWindow: BrowserWindow | null = null

// detached pane windows, keyed `${wsId}:${paneId}` — closing one reattaches
// the pane in the main window (renderer listens for `pane:reattach`)
const detachedWins = new Map<string, BrowserWindow>()

// pane snapshots handed to detached windows at creation — the detached
// renderer hydrates from the (possibly stale) state file, then `pane:hello`
// claims this fresh copy (keeps live pty session ids, newest tabs, etc.)
const pendingPanes = new Map<string, unknown>()
const winKeyByWebContents = new Map<number, string>()

// the renderer vets every main-window close (live-terminal confirm); set once
// the user confirms so the close actually lands
let quitConfirmed = false

function createDetachedWindow(key: string): void {
  if (detachedWins.get(key)?.isDestroyed() === false) {
    detachedWins.get(key)?.focus()
    return
  }
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const st = windowStateFor('detached', wa)
  const width = st.width ?? Math.min(920, wa.width)
  const height = st.height ?? Math.min(640, wa.height)
  const win = new BrowserWindow({
    width,
    height,
    x: st.x ?? wa.x + Math.round((wa.width - width) / 2),
    y: st.y ?? wa.y + Math.round((wa.height - height) / 2),
    minWidth: 320,
    minHeight: 200,
    show: false,
    frame: false,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
    }
  })
  detachedWins.set(key, win)
  const wcId = win.webContents.id
  winKeyByWebContents.set(wcId, key)
  trackWindowState('detached', win)

  win.on('ready-to-show', () => {
    if (st.maximized) win.maximize()
    win.show()
  })
  win.on('closed', () => {
    // webContents is already destroyed here — only use values captured above
    const [wsId, paneId] = key.split(':')
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pane:reattach', { wsId, paneId })
    }
    if (detachedWins.get(key) === win) detachedWins.delete(key)
    pendingPanes.delete(key)
    winKeyByWebContents.delete(wcId)
  })
  win.webContents.setWindowOpenHandler((details) => {
    // links open in-app: bounce the url back so the renderer routes it to a
    // browser pane; oddball schemes still go to the system handler
    if (/^https?:\/\//.test(details.url)) win.webContents.send('open-url', details.url)
    else shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?detached=${encodeURIComponent(key)}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { detached: key }
    })
  }
}

function createWindow(): void {
  // clamp to the display the window will live on — the fixed 1440×900 default
  // is wider than a portrait/secondary monitor's work area (e.g. 1080×1920),
  // and on Wayland the oversize initial configure race left the renderer laid
  // out at a stale size until the first resize (titlebar content drifting to
  // the middle, clipped tabs). x/y are honored on X11 and ignored on Wayland.
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const st = windowStateFor('main', wa)
  const width = st.width ?? Math.min(1440, wa.width)
  const height = st.height ?? Math.min(900, wa.height)
  // MAHAS_TEST runs the full app headlessly — window never maps, can't steal
  // focus (focusable:false), and doesn't blink in the taskbar. Used by
  // tools/e2e.mjs; combine with MAHAS_FAKE_FOCUS to pin the win:state verdict.
  const testMode = !!process.env.MAHAS_TEST
  mainWindow = new BrowserWindow({
    width,
    height,
    x: st.x ?? wa.x + Math.round((wa.width - width) / 2),
    y: st.y ?? wa.y + Math.round((wa.height - height) / 2),
    minWidth: 480,
    minHeight: 320,
    show: false,
    frame: false,
    focusable: !testMode,
    skipTaskbar: testMode,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
    }
  })
  trackWindowState('main', mainWindow)

  mainWindow.on('ready-to-show', () => {
    if (testMode) return
    if (st.maximized) mainWindow?.maximize()
    mainWindow?.show()
  })
  // closing the main window = quitting the app — let the renderer veto with
  // an in-app confirm while live terminals would be killed. A crashed/hung
  // renderer can't veto (it would never answer), and MAHAS_TEST bypasses so
  // e2e can quit with live agents on purpose
  mainWindow.on('close', (e) => {
    if (testMode || quitConfirmed) return
    const wc = mainWindow?.webContents
    if (!wc || wc.isDestroyed() || wc.isCrashed()) return
    e.preventDefault()
    wc.send('win:close-request')
  })
  mainWindow.on('closed', () => (mainWindow = null))

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//.test(details.url)) mainWindow?.webContents.send('open-url', details.url)
    else shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerFileIpc(): void {
  ipcMain.handle('file:openDialog', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? mainWindow
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile']
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('file:read', async (_e, filePath: string) => {
    try {
      const st = await stat(filePath)
      if (!st.isFile()) return { ok: false, error: 'not a file' }
      if (st.size > MAX_FILE_BYTES) return { ok: false, error: 'file too large' }
      const buf = await readFile(filePath)
      const ext = extname(filePath).toLowerCase()
      const head = buf.subarray(0, 8192)
      const kind = IMAGE_EXTS.has(ext)
        ? 'image'
        : VIDEO_EXTS.has(ext)
          ? 'video'
          : AUDIO_EXTS.has(ext)
            ? 'audio'
            : ext === '.pdf'
              ? 'pdf'
              : head.includes(0)
                ? 'binary'
                : 'text'
      return {
        ok: true,
        name: basename(filePath),
        path: filePath,
        ext,
        size: st.size,
        kind,
        mtimeMs: st.mtimeMs,
        data: buf.toString('base64')
      }
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) }
    }
  })

  ipcMain.handle('file:write', async (_e, filePath: string, content: string) => {
    try {
      if (typeof filePath !== 'string' || typeof content !== 'string')
        return { ok: false, error: 'invalid args' }
      await writeFile(filePath, content, 'utf8')
      // the save-guard in FileView records this mtime so a later external
      // edit still detects the divergence
      try {
        const st = await stat(filePath)
        return { ok: true, mtimeMs: st.mtimeMs }
      } catch {
        return { ok: true }
      }
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) }
    }
  })

  ipcMain.handle('file:stat', async (_e, filePath: string) => {
    try {
      const st = await stat(filePath)
      return { ok: true, exists: st.isFile(), mtimeMs: st.mtimeMs }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, exists: false }
      return { ok: false, error: String(e instanceof Error ? e.message : e) }
    }
  })
}

function registerWindowIpc(): void {
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
    quitConfirmed = true
    app.quit()
  })
  ipcMain.on('win:alwaysOnTop', (e, flag: boolean) => {
    BrowserWindow.fromWebContents(e.sender)?.setAlwaysOnTop(!!flag)
  })

  ipcMain.on('win:detach', (_e, m: { wsId: string; paneId: string; pane?: unknown }) => {
    if (!m?.wsId || !m?.paneId) return
    const key = `${m.wsId}:${m.paneId}`
    if (m.pane) pendingPanes.set(key, m.pane)
    createDetachedWindow(key)
  })
  // a booting detached renderer claims its fresh pane snapshot here
  ipcMain.handle('pane:hello', (e) => {
    const key = winKeyByWebContents.get(e.sender.id)
    if (!key) return null
    const [wsId, paneId] = key.split(':')
    const pane = pendingPanes.get(key) ?? null
    pendingPanes.delete(key)
    return { wsId, paneId, pane }
  })
  // detached window asks to go home — closing it triggers the 'closed'
  // handler above which notifies the main window to reattach the pane
  ipcMain.on('win:reattach', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('win:closeDetached', (_e, m: { wsId: string; paneId: string }) => {
    detachedWins.get(`${m?.wsId}:${m?.paneId}`)?.close()
  })
  ipcMain.on('win:focusDetached', (_e, m: { wsId: string; paneId: string }) => {
    const win = detachedWins.get(`${m?.wsId}:${m?.paneId}`)
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
    const win = m?.detached ? detachedWins.get(`${m.wsId}:${m.paneId}`) : mainWindow
    if (!win || win.isDestroyed()) return 'hidden'
    if (win.isMinimized()) return 'minimized'
    if (win.isFocused()) return 'focused'
    return 'visible'
  })
  // detached renderer → main window store actions (close pane etc.)
  ipcMain.on('pane:cmd', (_e, m) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pane:cmd', m)
  })
  // detached renderer pushes its local pane state up to the main store
  ipcMain.on('pane:syncUp', (_e, m) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pane:applySync', m)
  })

  ipcMain.on('shell:openExternal', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url)
  })
}

function registerFsIpc(): void {
  ipcMain.handle('fs:list', async (_e, dirPath: string) => {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries
        .map((d) => ({
          name: d.name,
          path: join(dirPath, d.name),
          isDir: d.isDirectory()
        }))
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
        .slice(0, 500)
    } catch {
      return []
    }
  })

  // Resolve a possibly-relative or ~ path (terminal link clicks) to absolute.
  ipcMain.handle('fs:resolve', (_e, p: string, cwd?: string) => {
    if (typeof p !== 'string' || !p) return null
    if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(2))
    return isAbsolute(p) ? resolve(p) : resolve(cwd || homedir(), p)
  })

  ipcMain.handle('dialog:pickDirectory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? mainWindow
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // terminal copy/paste — the renderer can't rely on navigator.clipboard on
  // file:// (non-secure context), so it goes through the main process
  ipcMain.handle('clipboard:write', (_e, t: string) => {
    if (typeof t === 'string') clipboard.writeText(t)
  })
  ipcMain.handle('clipboard:read', () => clipboard.readText())
}

const STATE_FILE = (): string => join(app.getPath('userData'), 'mahas-state.json')

function registerStateIpc(): void {
  ipcMain.handle('state:load', async () => {
    try {
      return JSON.parse(await readFile(STATE_FILE(), 'utf8'))
    } catch {
      return null
    }
  })
  ipcMain.handle('state:save', async (e, state: unknown) => {
    // only the main window persists — a detached pane's renderer shares the
    // same store API but must not clobber the canonical state file
    if (e.sender !== mainWindow?.webContents) return
    try {
      await writeFile(STATE_FILE(), JSON.stringify(state), 'utf8')
    } catch (e) {
      console.error('state save failed', e)
    }
  })
  // the debounced save can't be trusted on shutdown — the renderer's pending
  // timer dies with the window. beforeunload calls this sendSync variant so
  // the last snapshot (resume records, last-second session-ends) lands on
  // disk before the process exits.
  ipcMain.on('state:saveSync', (e, state: unknown) => {
    if (e.sender !== mainWindow?.webContents) {
      e.returnValue = false
      return
    }
    try {
      writeFileSync(STATE_FILE(), JSON.stringify(state), 'utf8')
      e.returnValue = true
    } catch {
      e.returnValue = false
    }
  })
}

function registerNotifyIpc(): void {
  ipcMain.on('notify:show', (_e, m: { title: string; body?: string }) => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: m.title, body: m.body ?? '', icon })
    n.on('click', () => {
      mainWindow?.show()
      mainWindow?.focus()
      mainWindow?.webContents.send('notify:clicked', m)
    })
    n.show()
  })
  // renderer notification-policy verdicts — see docs/notifications.md
  ipcMain.on('notify:decision', (_e, rec: unknown) => {
    appendCapped(decisionsFilePath(), rec)
  })
}

const AGENTS_DIR = (): string =>
  is.dev ? join(app.getAppPath(), 'resources', 'agents') : join(process.resourcesPath, 'agents')

function registerAgentIpc(): void {
  ipcMain.handle('agents:manifest', async () => {
    try {
      return JSON.parse(readFileSync(join(AGENTS_DIR(), 'manifest.json'), 'utf8'))
    } catch {
      return {}
    }
  })
  ipcMain.on('agents:config', (_e, patterns: Record<string, string[]>) => {
    if (patterns && typeof patterns === 'object') configureAgents(patterns)
  })
  // Provider icon — Chrome's favicon model: manifest domain → fetch once →
  // disk cache in userData/agent-icons → data URL. s2 favicons normalizes
  // everything to PNG; the site's own /favicon.ico is the fallback source.
  ipcMain.handle('agents:icon', async (_e, id: string) => {
    try {
      const manifest = JSON.parse(
        readFileSync(join(AGENTS_DIR(), 'manifest.json'), 'utf8')
      ) as Record<string, { domain?: string }>
      const domain = manifest[id]?.domain
      if (!domain || !/^[\w.-]+\.[a-z]{2,}$/.test(domain)) return null
      const dir = join(app.getPath('userData'), 'agent-icons')
      const file = join(dir, `${id}.img`)
      const sniff = (b: Buffer): string | null => {
        if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) return 'image/png'
        if (b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 1) return 'image/x-icon'
        if (b.length > 2 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
        if (b.length > 6 && b.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
        if (b.length > 12 && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
        return null
      }
      if (existsSync(file)) {
        const buf = readFileSync(file)
        return `data:${sniff(buf) ?? 'image/png'};base64,` + buf.toString('base64')
      }
      for (const url of [
        `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
        `https://${domain}/favicon.ico`
      ]) {
        try {
          const res = await net.fetch(url, { signal: AbortSignal.timeout(5000) })
          if (!res.ok) continue
          const buf = Buffer.from(await res.arrayBuffer())
          const mime = sniff(buf)
          if (!mime || buf.length > 512 * 1024) continue
          mkdirSync(dir, { recursive: true })
          writeFileSync(file, buf)
          return `data:${mime};base64,` + buf.toString('base64')
        } catch {
          /* try next source */
        }
      }
      return null
    } catch {
      return null
    }
  })
}

async function pushAgentConfig(): Promise<void> {
  try {
    const manifest = JSON.parse(
      readFileSync(join(AGENTS_DIR(), 'manifest.json'), 'utf8')
    ) as Record<string, { match?: string[] }>
    const patterns: Record<string, string[]> = {}
    for (const [id, info] of Object.entries(manifest)) {
      if (Array.isArray(info.match) && info.match.length) patterns[id] = info.match
    }
    if (Object.keys(patterns).length) configureAgents(patterns)
  } catch {
    /* manifest missing — host uses fallback patterns */
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId(devProfile ? 'com.mahas.app.dev' : 'com.mahas.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // A focused <webview> guest keeps its own keydown events — the host
  // document never sees them, which would kill every app shortcut while
  // typing in a browser pane. resources/webview-preload.cjs forwards
  // Alt+* / Ctrl+Tab to the host via ipc-message; this hands the renderer
  // the file:// path to give the webview's `preload` attribute.
  ipcMain.handle(
    'webview:preloadPath',
    () =>
      pathToFileURL(
        is.dev
          ? join(app.getAppPath(), 'resources', 'webview-preload.cjs')
          : join(process.resourcesPath, 'webview-preload.cjs')
      ).href
  )

  registerPtyIpc()
  registerFileIpc()
  registerFileWatchIpc()
  registerFsOpsIpc()
  registerDirWatchIpc()
  registerWorktreeIpc()
  registerWindowIpc()
  registerFsIpc()
  registerStateIpc()
  registerNotifyIpc()
  registerAgentIpc()
  registerHookIpc()
  registerUsageIpc()
  createWindow()
  startPtyHost()
  startEventIngest(() => mainWindow)
  pushAgentConfig()
  // dropped devin session locks from crashes/reboots/last quit — the CLI
  // refuses a session whose lock file exists, even when its holder is dead
  sweepDevinSessionLocks()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// take the pty-host down with us — its shell/agent children die with it
// (SIGHUP on master close) instead of lingering as orphans after every quit
let quitSweepDone = false
app.on('will-quit', (e) => {
  stopPtyHost()
  // the killed agents' devin locks go stale here — but they die async, so a
  // synchronous sweep would still find them alive. Hold quit for a beat to
  // let the sweep land; skipped entirely when no lock files exist so a
  // devin-free quit stays instant.
  if (!quitSweepDone && devinLocksPresent()) {
    quitSweepDone = true
    e.preventDefault()
    setTimeout(() => {
      sweepDevinSessionLocks()
      app.quit()
    }, 400)
  }
})
