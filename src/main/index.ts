import { app, shell, BrowserWindow, ipcMain, dialog, Notification } from 'electron'
import { join, basename, extname, isAbsolute, resolve } from 'path'
import { homedir } from 'os'
import { readFile, writeFile, stat, readdir } from 'fs/promises'
import { readFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { startPtyHost, registerPtyIpc, configureAgents } from './pty'

app.commandLine.appendSwitch('ozone-platform-hint', 'auto')

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 480,
    minHeight: 320,
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

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerFileIpc(): void {
  ipcMain.handle('file:openDialog', async () => {
    if (!mainWindow) return null
    const r = await dialog.showOpenDialog(mainWindow, {
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
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) }
    }
  })
}

function registerWindowIpc(): void {
  ipcMain.on('win:minimize', () => mainWindow?.minimize())
  ipcMain.on('win:maximize', () => {
    if (!mainWindow) return
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  })
  ipcMain.on('win:close', () => mainWindow?.close())
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

  ipcMain.handle('dialog:pickDirectory', async () => {
    if (!mainWindow) return null
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })
}

const STATE_FILE = (): string => join(app.getPath('userData'), 'ade-state.json')

function registerStateIpc(): void {
  ipcMain.handle('state:load', async () => {
    try {
      return JSON.parse(await readFile(STATE_FILE(), 'utf8'))
    } catch {
      return null
    }
  })
  ipcMain.handle('state:save', async (_e, state: unknown) => {
    try {
      await writeFile(STATE_FILE(), JSON.stringify(state), 'utf8')
    } catch (e) {
      console.error('state save failed', e)
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
  electronApp.setAppUserModelId('com.ade.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerPtyIpc()
  registerFileIpc()
  registerWindowIpc()
  registerFsIpc()
  registerStateIpc()
  registerNotifyIpc()
  registerAgentIpc()
  createWindow()
  startPtyHost(() => mainWindow)
  pushAgentConfig()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
