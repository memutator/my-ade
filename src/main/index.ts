// mahas main — composition root.
//
// This file wires the app together and nothing else: profile/paths, the
// window registry, then the per-feature IPC registrations. The bodies live in
// their own modules (state/store.ts for persistence, platform/* for windows,
// files, agents and notifications); what stays here is the order they run in
// and the one place that knows which window is canonical.

import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { existsSync, renameSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { startPtyHost, registerPtyIpc, configureAgents, stopPtyHost } from './pty'
import {
  initDesktopRuntime,
  registerRuntimeIpc,
  disconnectDesktopRuntime,
  runtimeHandle
} from './runtimeClient'
import { startEventIngest, registerHookIpc } from './hooks'
import { createLiveRuntimeIngestPort } from './agentEventIngest'
import { sweepDevinSessionLocks, devinLocksPresent } from './devinLocks'
import { registerFileWatchIpc } from './filewatch'
import { registerFsOpsIpc } from './fsops'
import { registerDirWatchIpc } from './dirwatch'
import { registerWorktreeIpc } from './worktree'
import { registerUsageIpc } from './usage'
import { registerUsageAuthIpc } from './usageAuth'
import { registerDomainIpc } from './runtime/domainIpc'
import { registerStateIpc } from './state/store'
import { createWindowRegistry } from './platform/windows'
import { registerFileIpc, registerFsIpc } from './platform/fileIpc'
import { registerAgentIpc, pushAgentConfig } from './platform/agentIpc'

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

// MAHAS_TEST runs the full app headlessly — window never maps, can't steal
// focus (focusable:false), and doesn't blink in the taskbar. Used by
// tools/e2e.mjs; combine with MAHAS_FAKE_FOCUS to pin the win:state verdict.
const testMode = !!process.env.MAHAS_TEST

const windows = createWindowRegistry({ icon, testMode })

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

  // feature IPC — each registration owns one boundary's channels
  registerPtyIpc()
  registerRuntimeIpc()
  registerFileIpc({ main: windows.main })
  registerFileWatchIpc()
  registerFsOpsIpc()
  registerDirWatchIpc()
  registerWorktreeIpc()
  registerFsIpc({ main: windows.main })
  windows.registerIpc()
  // only the main window persists — a detached pane's renderer shares the same
  // store API but must not clobber the canonical state file
  registerStateIpc((sender) => sender === windows.main()?.webContents)
  registerAgentIpc({
    focusMain: windows.focusMain,
    mainWindow: windows.main,
    icon,
    configureAgents
  })
  registerHookIpc()
  registerUsageIpc()
  registerUsageAuthIpc()
  // domain read/action channels — the canonical store is the daemon's, this
  // adapter only maps its answers into wire DTOs (owned by the usage worker)
  registerDomainIpc()

  windows.createMain()
  // control-plane attachment (IMP-01 seam): resolves the mahasd endpoint and
  // reports honest readiness — no daemon spawn/lease until IMP-17/23
  initDesktopRuntime()
  startPtyHost()
  // Hook events commit durably through the control plane before the renderer
  // sees them. The port resolves the runtime handle per call, so it works
  // whether the daemon answers immediately or seconds after startup — until
  // then the gate queues and retries, and the NDJSON file stays the durable
  // record (nothing is forwarded to attention uncommitted).
  startEventIngest(() => windows.main(), {
    port: createLiveRuntimeIngestPort(() => runtimeHandle())
  })
  pushAgentConfig(configureAgents)
  // dropped devin session locks from crashes/reboots/last quit — the CLI
  // refuses a session whose lock file exists, even when its holder is dead
  sweepDevinSessionLocks()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windows.createMain()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// take the pty-host down with us — its shell/agent children die with it
// (SIGHUP on master close) instead of lingering as orphans after every quit
let quitSweepDone = false
app.on('will-quit', (e) => {
  // UI close = detach (spec §5): drop the runtime client only — never a
  // drain-and-stop. The pty-host is still app-owned and dies as before.
  disconnectDesktopRuntime()
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
