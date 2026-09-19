// Electron glue for agent lifecycle hooks:
//  - tails the NDJSON event file that harness hook scripts append to
//    (the Pack's hooks/mahas-hook.cjs and hooks/opencode-runtime.js) and
//    forwards each event to the renderer as agent:event
//  - hands every record to the durable ingest port first when one is attached,
//    so the renderer (attention/resume) only sees events the daemon persisted
//  - IPC for the Settings "Agent hooks" section: status / install / test
//
// Harness knowledge is not here: the Pack decides which installers exist, where
// their configs live, and which harnesses need a session-lock sweep.

import { type BrowserWindow, ipcMain } from 'electron'
import {
  AgentEventGate,
  EventLogTailer,
  appendCapped,
  appendEvent,
  attentionProjection,
  decisionsFilePath,
  eventsFilePath,
  type AgentEventIngestPort,
  type AgentEventRecord,
  type AgentHookEvent
} from './eventsFile'
import {
  hookStatuses,
  installHook,
  refreshHookTransportCopy,
  refreshInstalledHooks,
  type HookInstallerSources
} from './hookInstallers'
import { loadHarnessPack } from './harnessPack'
import { scheduleDeclaredLockSweep } from './devinLocks'
import { harnessesWithMaintenance } from '../../packages/mahas-harness-config/src/runtime-pack.ts'
import { createLiveRuntimeIngestPort, type RuntimeIngestClient } from './agentEventIngest'
import { runtimeHandle } from './runtimeClient'

let tailer: EventLogTailer | null = null
let gate: AgentEventGate | null = null
let configuredPort: AgentEventIngestPort | null = null

/** The loaded pack + the transport path every installer points at. */
export function hookSources(): HookInstallerSources {
  const loaded = loadHarnessPack()
  return { pack: loaded.pack ?? null, hookScriptPath: loaded.hookScriptPath ?? null }
}

/** True for the e2e run — global user configuration must stay untouched. */
function isTestRun(): boolean {
  return process.env.MAHAS_TEST === '1' || process.env.MAHAS_TEST === 'true'
}

/**
 * Attach a durable ingest port explicitly (tests, or a composition that owns a
 * different client). The default port below is already live — this only
 * overrides it.
 */
export function setAgentEventIngestPort(port: AgentEventIngestPort | null): void {
  configuredPort = port
}

/**
 * The default durable ingest port: it resolves the runtime handle on every call,
 * so it is non-null from the first event and still correct after a reconnect or
 * a lazily spawned daemon. Records wait for its verdict (the daemon's
 * session.hook.ingest) before the renderer sees them; when the daemon cannot
 * take hook events yet, the bounded gate retries and reports that delay.
 */
function defaultIngestPort(): AgentEventIngestPort {
  return createLiveRuntimeIngestPort(
    () => {
      const handle = runtimeHandle()
      return handle ? { client: handle.client as unknown as RuntimeIngestClient } : null
    },
    { locatorPath: eventsFilePath() }
  )
}

export interface EventIngestOptions {
  port?: AgentEventIngestPort | null
}

export function startEventIngest(
  getWindow: () => BrowserWindow | null,
  options: EventIngestOptions = {}
): void {
  const loaded = loadHarnessPack()
  // keep mahas-owned hook artifacts (the installed transport copy, grok's hook
  // document, cline event files, the opencode plugin set) in sync with the
  // shipped Pack revision before events start flowing.
  //
  // MAHAS_TEST skips only the GLOBAL harness installs: e2e isolates the event
  // channel through XDG_CONFIG_HOME, but harness configs (~/.codex/config.toml,
  // ~/.claude/settings.json, …) live in the real HOME — a test run must never
  // rewrite a developer's global harness configuration.
  //
  // The config-dir transport copy is a different thing and is refreshed either
  // way: it lives inside the (isolated) config dir, and every installed harness
  // hook command points at it. Skipping it leaves the Pack's own hook script
  // absent, so a test that emits through the real transport — the adopt
  // scenario does exactly that — has nothing to run.
  if (loaded.pack) {
    if (isTestRun()) {
      console.log('[hooks] MAHAS_TEST: global hook installs skipped; transport copy refreshed')
      refreshHookTransportCopy(hookSources())
    } else {
      refreshInstalledHooks(hookSources())
    }
  } else {
    console.error('[hooks] ' + (loaded.error ?? 'harness runtime Pack unavailable'))
  }

  tailer?.stop()
  gate?.stop()
  const port = options.port !== undefined ? options.port : (configuredPort ?? defaultIngestPort())
  gate = new AgentEventGate({
    port,
    onCommitted: (record) => deliver(getWindow, record),
    onError: (error) => console.error('[hooks] event ingest', error),
    onDropped: (record, reason) => {
      // the record stays in the durable file; only its attention delivery is lost
      appendCapped(decisionsFilePath(), {
        ts: Date.now(),
        phase: 'ingest',
        verdict: 'drop',
        record: record.sourceRecordKey,
        provider: record.event.provider,
        event: record.event.event,
        reason
      })
    }
  })
  tailer = new EventLogTailer(
    eventsFilePath(),
    () => {
      /* records always travel through the gate */
    },
    (e) => console.error('[hooks] event tail error', e),
    (record) => gate?.enqueue(record)
  )
  tailer.start()
}

/** Durable-ingest diagnostics for the Settings surface / decision log. */
export function eventIngestStats(): ReturnType<AgentEventGate['stats']> | null {
  return gate?.stats() ?? null
}

function deliver(getWindow: () => BrowserWindow | null, record: AgentEventRecord): void {
  const ev = attentionProjection(record.event)
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev)
  scheduleMaintenanceFor(ev)
}

/**
 * A session ending may mean a harness CLI died without unlinking its session
 * lock; sweep after a beat. Foreign events count too — the lock directory is
 * shared and the sweep only drops provably-dead holders.
 */
function scheduleMaintenanceFor(ev: AgentHookEvent): void {
  if (ev.event !== 'session-end') return
  const loaded = loadHarnessPack()
  if (!loaded.pack) return
  if (!harnessesWithMaintenance(loaded.pack, 'sweep-session-locks').includes(ev.provider)) return
  scheduleDeclaredLockSweep(1500, ev.provider)
}

export function registerHookIpc(): void {
  ipcMain.handle('hooks:status', () => hookStatuses(hookSources()))
  ipcMain.handle('hooks:install', (_e, provider: string) => {
    if (isTestRun()) {
      return {
        ok: false,
        error:
          'hook installation is disabled under MAHAS_TEST — a test run never modifies real harness configs'
      }
    }
    return installHook(provider, hookSources())
  })
  // Writes a synthetic event through the real file channel — end-to-end test.
  ipcMain.handle('hooks:test', (_e, provider: string) => {
    try {
      appendEvent({
        provider: typeof provider === 'string' && provider ? provider : 'unknown',
        event: 'turn-complete',
        cwd: process.cwd(),
        sessionId: 'mahas-test-' + Date.now(),
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
  // instance's session so the tailer marks them ours.
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
