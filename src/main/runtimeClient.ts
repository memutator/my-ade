// Desktop runtime composition seam (IMP-01).
//
// The desktop is a CLIENT of the control plane (spec/architecture.md §1):
// this module is the single place the app's runtime attachment lives.
// `initDesktopRuntime` composes it next to `startPtyHost` in the existing
// bootstrap; `disconnectDesktopRuntime` is called from `will-quit` — UI
// close = detach (spec §5), so the app drops its client connection and
// deliberately leaves any daemons alone. The pty-host is still app-owned
// and still dies with the app, unchanged.
//
// What this makes real today:
//   · `runtime:status` IPC — the last authenticated runtime.status verdict
//   · `exec:*` IPC — the ONLY route managed executions may flow through
//     (feature boundary): create/query/bind all go handle.client → the
//     runtime client, never through pty:*. Until IMP-17/23 land the service
//     every call uses the same authenticated mahas-client session.
//   · `requestRuntimeShutdown` — the shutdown-request forwarding port an
//     operator surface can call. No UI path reaches it (UI close = detach);
//     mode is limited to the spec's two honest modes.
//
// What is NOT here: ControllerLease, DB, or execution fabrication. Those
// remain service responsibilities reached through the operation registry.

import { app, ipcMain } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { bootstrapRuntime, receiptToControl } from '../../packages/mahas-client/src/index.ts'
import type { RuntimeHandle } from '../../packages/mahas-client/src/index.ts'
import type {
  BindViewRequest,
  ControlError,
  ControlResult,
  CreateExecutionRequest,
  Execution,
  ExecutionQuery,
  ClientViewBinding,
  ServiceStatus,
  ShutdownAck,
  ShutdownRequest,
  UnbindViewRequest
} from '../../packages/mahas-contracts/src/index.ts'
import type { ExecOpRequest, RuntimeSubscribeRequest } from '../preload/index.ts'
import {
  logServiceBootstrap,
  resolveServiceBootstrapPaths,
  spawnControlPlane
} from './runtime/serviceBootstrap.ts'
import { LEGACY_USAGE_ACCOUNTS_ROOT_ENV, legacyUsageAccountsRoot } from './runtime/authClient.ts'

let handle: RuntimeHandle | null = null

/**
 * The desktop's generic command session (IMP-30 wiring). The renderer's
 * workbench routes every domain op here; the main process owns the single
 * authenticated RPC connection to mahasd. A failed connect/call drops the
 * cached client so the next call retries the handshake — a lost socket is
 * never remembered as a dead service forever, and no call is auto-resent
 * (REQ-14: the operationId reconciles via operation.get).
 */
// Daemon sockets namespace with the same config dir the hook/event channel
// uses. This must agree with eventsFile.mahasConfigDir() EXACTLY, including the
// XDG_CONFIG_HOME fallback: if the daemon resolved a different root than the
// hook channel, its event ingest would write into one profile while the desktop
// read events from another. MAHAS_CONFIG_DIR still wins (dev runs set it to
// mahas-dev; the e2e harness sets it to its scratch dir).
function runtimeConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return process.env.MAHAS_CONFIG_DIR || join(base, 'mahas')
}

function offline(detail: string): ServiceStatus {
  return { service: 'mahasd', readiness: 'unavailable', detail, checkedAt: Date.now() }
}

function refuse<T>(detail: string): Promise<ControlResult<T>> {
  const error: ControlError = { code: 'CONTROL_UNAVAILABLE', message: detail, retryable: true }
  return Promise.resolve({ ok: false, error })
}

function invalid<T>(message: string): Promise<ControlResult<T>> {
  const error: ControlError = { code: 'INVALID_ARGUMENT', message }
  return Promise.resolve({ ok: false, error })
}

/**
 * When an authenticated runtime.status cannot be obtained, start the service
 * entrypoints under system Node and keep polling the authenticated client.
 * A reachable socket alone never disables bootstrap or reports readiness.
 *
 * stdin is /dev/zero, not 'ignore': the host treats stdin EOF as "launcher
 * gone" and exits, which is correct for pty-host but wrong for a detached
 * service that must survive UI closes (spec §5).
 *
 * MAHAS_TEST does NOT skip this: the desktop's real startup path is what e2e
 * must exercise, and hook events now require a durable daemon ack before the
 * renderer sees them. Test isolation comes from the config root instead — the
 * harness pins MAHAS_CONFIG_DIR/XDG_CONFIG_HOME to a scratch dir, and the
 * runtime composition isolates scanner/auth roots under <configDir>/test-home.
 * The services are detached on purpose, so a fixture must stop the children it
 * started (tools/e2e.mjs stopFixtureDaemons) rather than relying on UI exit.
 */
async function ensureControlPlane(h: RuntimeHandle): Promise<void> {
  const current = await h.refresh()
  if (current.readiness === 'ready' || current.readiness === 'degraded') return

  const configDir = runtimeConfigDir()
  const paths = resolveServiceBootstrapPaths({
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    configDir,
    // The auth domain adopts the credential files this profile registered
    // before the inventory domain existed. It must never guess a desktop
    // userData path — dev runs and an installed app keep different roots — so
    // the desktop resolves its own and hands it over through the spawn env.
    legacyUsageAccountsRoot: legacyUsageAccountsRoot()
  })
  if (!paths) {
    logServiceBootstrap(
      configDir,
      `cannot start services: Node 24+ or service entrypoints were not found ` +
        `(packaged=${app.isPackaged}, appPath=${app.getAppPath()}, ` +
        `resourcesPath=${process.resourcesPath})`
    )
    return
  }
  try {
    spawnControlPlane(paths, configDir, process.env, LEGACY_USAGE_ACCOUNTS_ROOT_ENV)
  } catch (error) {
    logServiceBootstrap(configDir, `service spawn failed: ${String(error)}`)
    return
  }
  // give the daemons a bounded window to publish + answer
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300))
    const s = await h.refresh()
    if (s.readiness === 'ready' || s.readiness === 'degraded') return
  }
}

/** called once from app.whenReady — composes the control-plane attachment */
export function initDesktopRuntime(): void {
  if (handle) return
  handle = bootstrapRuntime({ configDir: runtimeConfigDir() })
  const h = handle
  void ensureControlPlane(h).catch(() => {
    /* status stays honestly unavailable */
  })
}

/** the composed handle — for main-process consumers (IMP-17/23 wiring) */
export function runtimeHandle(): RuntimeHandle | null {
  return handle
}

/**
 * Shutdown-request forwarding port (spec §5). Operator-only by design:
 * 'drain-and-stop' and 'leave-executions' are explicit lifecycle choices a
 * window close must never imply. Nothing in the renderer reaches this —
 * it exists for the future operator surface and IMP-23's wiring.
 */
export function requestRuntimeShutdown(req: ShutdownRequest): Promise<ControlResult<ShutdownAck>> {
  if (!handle) return refuse('runtime not bootstrapped')
  if (req.mode !== 'drain-and-stop' && req.mode !== 'leave-executions') {
    return invalid(`unknown shutdown mode: ${String(req.mode)}`)
  }
  return handle.requestShutdown(req)
}

/** will-quit path: detach the client; services keep living without us */
export function disconnectDesktopRuntime(): void {
  const h = handle
  handle = null
  void h?.disconnect()
}

export function registerRuntimeIpc(): void {
  ipcMain.handle('runtime:status', (): ServiceStatus => {
    return handle?.status() ?? offline('runtime not bootstrapped')
  })

  // ── managed executions — the feature boundary ─────────────────────────
  // These are the only IPC channels a managed Execution/Terminal may be
  // created or looked up through. Plain terminals keep their existing
  // pty:* path; nothing here turns an unmanaged shell into an Execution.
  ipcMain.handle(
    'exec:create',
    (_e, req: CreateExecutionRequest): Promise<ControlResult<Execution>> => {
      if (!req || typeof req.operationId !== 'string' || !req.operationId) {
        return invalid('exec:create requires operationId')
      }
      if (!Array.isArray(req.process?.argv) || req.process.argv.length === 0) {
        return invalid('exec:create requires process.argv[]')
      }
      if (!handle) return refuse('runtime not bootstrapped')
      return handle.client.createExecution(req)
    }
  )
  ipcMain.handle(
    'exec:get',
    (_e, executionId: string): Promise<ControlResult<Execution | null>> => {
      if (typeof executionId !== 'string' || !executionId) {
        return invalid('exec:get requires an executionId')
      }
      if (!handle) return refuse('runtime not bootstrapped')
      return handle.client.getExecution(executionId)
    }
  )
  ipcMain.handle('exec:list', (_e, query?: ExecutionQuery): Promise<ControlResult<Execution[]>> => {
    if (!handle) return refuse('runtime not bootstrapped')
    return handle.client.listExecutions(query)
  })

  // ── view ↔ execution/terminal binding (C-CLIENT client.view.bind) ──────
  ipcMain.handle(
    'exec:bindView',
    (_e, req: BindViewRequest): Promise<ControlResult<ClientViewBinding>> => {
      if (!req || typeof req.viewId !== 'string' || !req.viewId) {
        return invalid('exec:bindView requires a viewId')
      }
      if (req.executionId === undefined && req.terminalId === undefined) {
        return invalid('exec:bindView requires executionId or terminalId')
      }
      if (!handle) return refuse('runtime not bootstrapped')
      return handle.client.bindView(req)
    }
  )
  ipcMain.handle('exec:unbindView', (_e, req: UnbindViewRequest): Promise<ControlResult<null>> => {
    if (!req || typeof req.viewId !== 'string' || !req.viewId) {
      return invalid('exec:unbindView requires a viewId')
    }
    if (!handle) return refuse('runtime not bootstrapped')
    return handle.client.unbindView(req)
  })

  // ── generic command route (workbench / 임의 domain op) ──────────────────
  // The renderer never opens a socket: this handler forwards the envelope
  // through the authenticated RPC session and returns the receipt verdict
  // unwrapped, keeping rejected/unknown/pending distinct (common.md §2).
  ipcMain.handle('exec:op', async (_e, req: ExecOpRequest): Promise<ControlResult<unknown>> => {
    if (!req || typeof req.operation !== 'string' || !req.operation) {
      return invalid('exec:op requires an operation name')
    }
    if (!handle) return refuse('runtime not bootstrapped')
    try {
      const receipt = await handle.client.call(req.operation, req.payload, {
        operationId: req.operationId,
        expectedRevisions: req.expectedRevisions
      })
      return receiptToControl(receipt)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return refuse(`mahasd call ${req.operation} failed: ${message}`)
    }
  })

  // ── C-OBSERVATION runtime.subscribe ─────────────────────────────────────
  // The versioned RPC transport is request/response — no push channel exists
  // yet, so this answers honestly. The workbench falls back to snapshot
  // refresh; events are a convenience, never required for correctness.
  ipcMain.handle(
    'exec:subscribe',
    (_e, req: RuntimeSubscribeRequest): Promise<ControlResult<string>> => {
      if (!req || typeof req.epoch !== 'number' || typeof req.afterSequence !== 'number') {
        return invalid('exec:subscribe requires {epoch, afterSequence}')
      }
      return refuse(
        'event streaming is not negotiated over this transport yet — poll runtime.snapshot'
      )
    }
  )
  // unsubscribe is a no-op locally (no server-side subscription was opened);
  // success is honest here because nothing remains to detach.
  ipcMain.handle('exec:unsubscribe', (_e, subscriptionId: string): ControlResult<null> => {
    void subscriptionId
    return { ok: true, value: null }
  })
}
