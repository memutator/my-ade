// mahas-runtime — service bootstrap and the desktop/CLI composition root.
//
// spec/architecture.md §1: desktop becomes an RPC client AFTER service
// bootstrap. This module is where that composition lives. What IMP-01
// provides is real: endpoint resolution (config-dir convention + env
// override), a genuine reachability probe, and an honest readiness verdict.
// What it deliberately does NOT do: spawn mahasd, negotiate the versioned
// protocol, hold a ControllerLease, or reconcile executions — IMP-17
// (service lifetime) and IMP-23 (recovery/reattach) inject those behind
// this same handle, so callers here never need reshaping.
//
// Lifetime semantics (spec §5) the caller must respect:
//   UI close = detach → handle.disconnect(), never requestShutdown().
//   'drain-and-stop' / 'leave-executions' are operator decisions only.

import { connect } from 'node:net'
import { join } from 'node:path'
import type {
  ControlResult,
  RuntimeClient,
  ServiceEndpoint,
  ServiceReadiness,
  ServiceStatus,
  ShutdownAck,
  ShutdownRequest
} from '../../mahas-contracts/src/index.ts'
import { unavailableClient } from './client.ts'

/** bumped when the negotiated wire format changes — clients must match */
export const MAHAS_RUNTIME_PROTOCOL_VERSION = 0

/** env override honoured by every bootstrap caller (desktop, CLI, tests) */
export const MAHASD_ENDPOINT_ENV = 'MAHASD_ENDPOINT'

export interface RuntimeBootstrapOptions {
  /** config dir that namespaces daemon sockets (MAHAS_CONFIG_DIR convention) */
  configDir: string
  /** explicit endpoint override — wins over the config-dir default */
  endpoint?: ServiceEndpoint
  /** probe connect timeout; keep small — status is a hint, not a gate */
  probeTimeoutMs?: number
  /**
   * INJECTION POINT (IMP-17/23): when a real transport exists it is given
   * here and its verdict drives readiness + the client. Absent = the
   * honest unavailable client below.
   */
  sessionFactory?: (endpoint: ServiceEndpoint) => Promise<RuntimeClient | null>
}

/**
 * The composed runtime attachment. `status()` is the last VERIFIED verdict;
 * `refresh()` performs a fresh probe. `client` is the only route managed
 * executions may flow through (feature boundary, IMP-01 §4.3).
 */
export interface RuntimeHandle {
  readonly service: 'mahasd'
  readonly endpoint: ServiceEndpoint
  status(): ServiceStatus
  refresh(): Promise<ServiceStatus>
  readonly client: RuntimeClient
  requestShutdown(req: ShutdownRequest): Promise<ControlResult<ShutdownAck>>
  disconnect(): Promise<void>
}

export function defaultMahasdEndpoint(configDir: string): ServiceEndpoint {
  return { kind: 'unix-socket', address: join(configDir, 'mahasd.sock'), service: 'mahasd' }
}

/** parse MAHASD_ENDPOINT: 'unix:/path.sock' | 'tcp:host:port' | bare path = unix socket */
export function parseEndpoint(raw: string): ServiceEndpoint | null {
  if (raw.startsWith('unix:')) {
    const address = raw.slice(5)
    return address ? { kind: 'unix-socket', address, service: 'mahasd' } : null
  }
  if (raw.startsWith('tcp:')) {
    const address = raw.slice(4)
    return address ? { kind: 'tcp', address, service: 'mahasd' } : null
  }
  return raw ? { kind: 'unix-socket', address: raw, service: 'mahasd' } : null
}

/** is anything accepting connections on this endpoint right now? */
function probeEndpoint(ep: ServiceEndpoint, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (!settled) {
        settled = true
        resolve(ok)
      }
    }
    try {
      const sock =
        ep.kind === 'unix-socket'
          ? connect(ep.address)
          : ep.kind === 'tcp'
            ? (() => {
                const i = ep.address.lastIndexOf(':')
                if (i <= 0) return null
                return connect({
                  host: ep.address.slice(0, i),
                  port: Number(ep.address.slice(i + 1))
                })
              })()
            : null
      if (!sock) return done(false)
      const timer = setTimeout(() => {
        sock.destroy()
        done(false)
      }, timeoutMs)
      sock.once('connect', () => {
        clearTimeout(timer)
        sock.destroy()
        done(true)
      })
      sock.once('error', () => {
        clearTimeout(timer)
        sock.destroy()
        done(false)
      })
    } catch {
      done(false)
    }
  })
}

export function bootstrapRuntime(opts: RuntimeBootstrapOptions): RuntimeHandle {
  const endpoint =
    opts.endpoint ??
    (process.env[MAHASD_ENDPOINT_ENV]
      ? (parseEndpoint(process.env[MAHASD_ENDPOINT_ENV]!) ?? defaultMahasdEndpoint(opts.configDir))
      : defaultMahasdEndpoint(opts.configDir))
  const probeTimeout = opts.probeTimeoutMs ?? 750

  // last VERIFIED verdict — never optimistic. 'unavailable' until a probe
  // or an injected session proves otherwise; a socket that accepts but has
  // no negotiated protocol is 'degraded', not 'ready'.
  let status: ServiceStatus = {
    service: 'mahasd',
    readiness: 'unavailable',
    endpoint,
    detail: 'no control-plane session negotiated yet (IMP-17/IMP-23 inject the transport)',
    checkedAt: Date.now()
  }
  let probing: Promise<ServiceStatus> | null = null
  let closed = false

  const setStatus = (readiness: ServiceReadiness, detail: string): ServiceStatus => {
    status = { service: 'mahasd', readiness, endpoint, detail, checkedAt: Date.now() }
    return status
  }

  async function refresh(): Promise<ServiceStatus> {
    if (closed) return setStatus('stopped', 'client disconnected')
    probing ??= (async () => {
      const reachable = await probeEndpoint(endpoint, probeTimeout)
      return reachable
        ? setStatus(
            'degraded',
            'endpoint accepts connections but no versioned protocol session is ' +
              'negotiated yet — not evidence of a serving control plane'
          )
        : setStatus(
            'unavailable',
            `endpoint ${endpoint.address} unreachable — mahasd is not running ` +
              '(service lifetime lands in IMP-17)'
          )
    })().finally(() => {
      probing = null
    })
    return probing
  }

  // an injected session factory (IMP-17/23) would swap this for the real
  // negotiated client; today the honest unavailable client stands in.
  const clientPromise: Promise<RuntimeClient> = opts.sessionFactory
    ? opts.sessionFactory(endpoint).then((c) => c ?? unavailableClient(() => status))
    : Promise.resolve(unavailableClient(() => status))
  // callers use `handle.client` synchronously — resolve the factory behind a
  // proxy so the sync surface stays stable once IMP-17 injects async session
  // setup. Until the promise resolves every op reports CONTROL_UNAVAILABLE.
  let resolvedClient: RuntimeClient = unavailableClient(() => status)
  void clientPromise.then((c) => {
    resolvedClient = c
  })

  const handle: RuntimeHandle = {
    service: 'mahasd',
    endpoint,
    status: () => status,
    refresh,
    client: {
      status: async () => ({ ok: true, value: await refresh() }),
      createExecution: (req) => resolvedClient.createExecution(req),
      getExecution: (id) => resolvedClient.getExecution(id),
      listExecutions: (q) => resolvedClient.listExecutions(q),
      bindView: (req) => resolvedClient.bindView(req),
      unbindView: (req) => resolvedClient.unbindView(req),
      requestShutdown: (req) => resolvedClient.requestShutdown(req),
      disconnect: () => handle.disconnect()
    },
    requestShutdown: (req) => resolvedClient.requestShutdown(req),
    disconnect: () => {
      closed = true
      setStatus('stopped', 'client disconnected')
      return resolvedClient.disconnect()
    }
  }

  // a first probe is fire-and-forget — status() never blocks callers on it
  void handle.refresh()
  return handle
}
