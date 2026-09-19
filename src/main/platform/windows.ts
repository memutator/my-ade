// mahas main — window lifecycle.
//
// Two kinds of window exist: the main window (which owns the shell state and
// quits the app) and one detached window per detached pane. Both are
// frameless and share the preload; the differences that matter are all here:
//
//   - the main window vetoes its own close so the renderer can confirm when
//     live terminals would be killed (`win:close-request`), unless the user
//     already confirmed or the renderer is gone (a crashed renderer can never
//     answer, and holding the app open on it would trap the user);
//   - a detached window's close hands the pane back (`pane:reattach`);
//   - detached windows are keyed `${wsId}:${paneId}` and boot with a pane
//     snapshot the main window captured at detach time, which the booting
//     renderer claims via `pane:hello` (the disk copy can be stale).
//
// Window geometry persistence stays in windowState.ts; this module only asks
// it for a rect.

import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { trackWindowState, windowStateFor } from '../windowState'
import { registerWindowIpc } from './windowIpc'

export interface WindowRegistry {
  main: () => BrowserWindow | null
  detached: (wsId: string, paneId: string) => BrowserWindow | undefined
  /** window hosting a pane — the detached one, or main when it is docked */
  hostingPane: (m: { wsId?: string; paneId?: string; detached?: boolean }) => BrowserWindow | null
  /** create (or focus) the window for a detached pane */
  openDetached: (wsId: string, paneId: string, pane?: unknown) => void
  /** focus the main window (OS notification click) */
  focusMain: () => void
  /** create the main window (called once at boot, and on macOS activate) */
  createMain: () => void
  /** set once the renderer confirmed a close that would kill live terminals */
  confirmQuit: () => void
  /** true when the renderer already confirmed the close */
  quitConfirmed: () => boolean
  /** register the `win:*` IPC — window controls, detach/reattach, attention state */
  registerIpc: () => void
}

export interface WindowHostOptions {
  icon?: string
  /** MAHAS_TEST: never map the main window, never let it take focus */
  testMode: boolean
}

export function createWindowRegistry(opts: WindowHostOptions): WindowRegistry {
  let mainWindow: BrowserWindow | null = null
  const detachedWins = new Map<string, BrowserWindow>()
  const winKeyByWebContents = new Map<number, string>()
  // pane snapshots handed to detached windows at creation — the detached
  // renderer hydrates from the (possibly stale) state file, then `pane:hello`
  // claims this fresh copy (keeps live pty session ids, newest tabs, etc.)
  const pendingPanes = new Map<string, unknown>()
  let quitConfirmed = false

  const workArea = (): Electron.Rectangle =>
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea

  const commonWebPreferences = (): Electron.WebPreferences => ({
    preload: join(__dirname, '../preload/index.js'),
    sandbox: false,
    webviewTag: true
  })

  // links open in-app: bounce the url back so the renderer routes it to a
  // browser pane; oddball schemes still go to the system handler
  const installWindowOpenHandler = (win: BrowserWindow): void => {
    win.webContents.setWindowOpenHandler((details) => {
      if (/^https?:\/\//.test(details.url)) win.webContents.send('open-url', details.url)
      else shell.openExternal(details.url)
      return { action: 'deny' }
    })
  }

  const openDetached = (wsId: string, paneId: string, pane?: unknown): void => {
    const key = `${wsId}:${paneId}`
    const existing = detachedWins.get(key)
    if (existing?.isDestroyed() === false) {
      existing.focus()
      return
    }
    if (pane) pendingPanes.set(key, pane)

    const wa = workArea()
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
      ...(process.platform === 'linux' && opts.icon ? { icon: opts.icon } : {}),
      webPreferences: commonWebPreferences()
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
      const [ws, pane] = key.split(':')
      const main = mainWindow
      if (main && !main.isDestroyed()) {
        main.webContents.send('pane:reattach', { wsId: ws, paneId: pane })
      }
      if (detachedWins.get(key) === win) detachedWins.delete(key)
      pendingPanes.delete(key)
      winKeyByWebContents.delete(wcId)
    })
    installWindowOpenHandler(win)

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?detached=${encodeURIComponent(key)}`)
    } else {
      win.loadFile(join(__dirname, '../renderer/index.html'), { query: { detached: key } })
    }
  }

  const createMain = (): void => {
    // clamp to the display the window will live on — the fixed 1440×900 default
    // is wider than a portrait/secondary monitor's work area (e.g. 1080×1920),
    // and on Wayland the oversize initial configure race left the renderer laid
    // out at a stale size until the first resize (titlebar content drifting to
    // the middle, clipped tabs). x/y are honored on X11 and ignored on Wayland.
    const wa = workArea()
    const st = windowStateFor('main', wa)
    const width = st.width ?? Math.min(1440, wa.width)
    const height = st.height ?? Math.min(900, wa.height)
    const testMode = opts.testMode
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
      ...(process.platform === 'linux' && opts.icon ? { icon: opts.icon } : {}),
      webPreferences: commonWebPreferences()
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
    installWindowOpenHandler(mainWindow)

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  return {
    main: () => mainWindow,
    detached: (wsId, paneId) => detachedWins.get(`${wsId}:${paneId}`),
    hostingPane: (m) => {
      if (!m?.detached) return mainWindow
      return detachedWins.get(`${m.wsId}:${m.paneId}`) ?? null
    },
    openDetached,
    focusMain: () => {
      mainWindow?.show()
      mainWindow?.focus()
    },
    createMain,
    confirmQuit: () => {
      quitConfirmed = true
    },
    quitConfirmed: () => quitConfirmed,
    registerIpc: () => {
      registerWindowIpc({
        main: () => mainWindow,
        detached: (wsId, paneId) => detachedWins.get(`${wsId}:${paneId}`),
        openDetached,
        focusMain: () => {
          mainWindow?.show()
          mainWindow?.focus()
        },
        confirmQuit: () => {
          quitConfirmed = true
        },
        winKeyByWebContents,
        pendingPanes
      })
    }
  }
}
