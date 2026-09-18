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
//   · `runtime:status` IPC — the honest readiness verdict of the mahasd
//     endpoint (packages/mahas-runtime/src/bootstrap.ts probes it for real)
//   · `exec:*` IPC — the ONLY route managed executions may flow through
//     (feature boundary): create/query/bind all go handle.client → the
//     runtime client, never through pty:*. Until IMP-17/23 land the service
//     every call answers CONTROL_UNAVAILABLE — that is the truth, not a
//     stub pretending to work.
//   · `requestRuntimeShutdown` — the shutdown-request forwarding port an
//     operator surface can call. No UI path reaches it (UI close = detach);
//     mode is limited to the spec's two honest modes.
//
// What is NOT here: daemon spawn, ControllerLease, DB — injected by
// IMP-17/IMP-23 behind bootstrapRuntime's sessionFactory.

import { ipcMain } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { bootstrapRuntime } from '../../packages/mahas-runtime/src/index.ts'
import type { RuntimeHandle } from '../../packages/mahas-runtime/src/index.ts'
import { connectRpc } from '../../packages/mahas-runtime/src/rpc/index.ts'
import type { RpcClient } from '../../packages/mahas-runtime/src/rpc/index.ts'
import type {
  BindViewRequest,
  CommandReceipt,
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

let handle: RuntimeHandle | null = null

/**
 * The desktop's generic command session (IMP-30 wiring). The renderer's
 * workbench routes every domain op here; the main process owns the single
 * authenticated RPC connection to mahasd. A failed connect/call drops the
 * cached client so the next call retries the handshake — a lost socket is
 * never remembered as a dead service forever, and no call is auto-resent
 * (REQ-14: the operationId reconciles via operation.get).
 */
let rpc: RpcClient | null = null
let rpcConnecting: Promise<RpcClient | null> | null = null

async function rpcClient(): Promise<RpcClient | null> {
  if (rpc) return rpc
  if (rpcConnecting) return rpcConnecting
  rpcConnecting = (async () => {
    if (!handle) return null
    try {
      const client = await connectRpc(handle.endpoint.address, { kind: 'operator' })
      rpc = client
      return client
    } catch {
      return null
    } finally {
      rpcConnecting = null
    }
  })()
  return rpcConnecting
}

function dropRpc(): void {
  try {
    rpc?.close()
  } catch {
    /* already gone */
  }
  rpc = null
}

function receiptToControl(receipt: CommandReceipt): ControlResult<unknown> {
  if (receipt.status === 'committed') return { ok: true, value: receipt.result }
  const code = (receipt.error?.code ?? 'UNKNOWN') as ControlError['code']
  const retry = receipt.error?.retry
  return {
    ok: false,
    error: {
      code,
      message: receipt.error?.message ?? `operation ended with status ${receipt.status}`,
      retryable: retry === 'same-operation' || retry === 'reconcile'
    }
  }
}

// daemon sockets namespace with the same config dir the hook/event channel
// uses (MAHAS_CONFIG_DIR; dev runs already get mahas-dev — see index.ts)
function runtimeConfigDir(): string {
  return process.env.MAHAS_CONFIG_DIR ?? join(homedir(), '.config', 'mahas')
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

/** called once from app.whenReady — composes the control-plane attachment */
export function initDesktopRuntime(): void {
  if (handle) return
  handle = bootstrapRuntime({ configDir: runtimeConfigDir() })
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
    const client = await rpcClient()
    if (!client) return refuse(`mahasd at ${handle.endpoint.address} is unavailable`)
    try {
      const receipt = await client.call(req.operation, req.payload, {
        operationId: req.operationId,
        expectedRevisions: req.expectedRevisions
      })
      return receiptToControl(receipt)
    } catch (err) {
      // transport-level failure — session is no longer trustworthy
      dropRpc()
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
