// hostClient.ts — mahasd-side client for the reattachable execution-host
// (C-HOST, spec/contracts/execution-host.md). NDJSON over the host's unix
// socket; op names per spec/operations.md (host.hello / host.acquire /
// host.inventory / host.effect.get + IMP-16/18's host.process.*,
// host.terminal.*, host.workspace.*).
//
// Wire shape (mirrored in packages/mahas-execution-host/src/host.ts — the
// two sides each own their copy; this package may not import host code):
//   → {t:'call', id, op, protocolVersion, hostId?, expectedHostIncarnation?,
//      controllerEpoch?, leaseProof?, effectKey?, payloadFingerprint?, payload?}
//   ← {t:'result', id, ok:true, result} | {t:'result', id, ok:false, error:{code,message,retry,details?}}
//
// The endpoint file (`<endpoint>.endpoint.json`, mode 0600) is the
// discovery + credential channel: it carries hostId, incarnation, pid,
// birth evidence, launchNonce, endpointIncarnation, and the per-incarnation
// authToken a controller presents in host.hello — same-uid authentication
// per spec §transport, honest about the §6 boundary (a same-OS-user
// attacker with file access is out of scope for v1).

import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'

/** must match EXECUTION_HOST_PROTOCOL_VERSION on the host side */
export const HOST_PROTOCOL_VERSION = 0

export interface SpawnSpec {
  argv: string[]
  cwd: string
  env: Record<string, string>
  pty?: { cols: number; rows: number }
}

// host.process.spawn payload: { spawnNonce, executionId, generation, spec: SpawnSpec }
// host.process.spawn result:  { processIdentity, terminalId? }

/** C-HOST HostEnvelope fields a caller may attach to a single call. */
export interface HostCallOptions {
  expectedHostIncarnation?: string
  controllerEpoch?: number
  leaseProof?: string
  effectKey?: string
  payloadFingerprint?: string
}

export class HostCallError extends Error {
  readonly code: string
  readonly retry?: string
  readonly details?: unknown
  constructor(code: string, message: string, retry?: string, details?: unknown) {
    super(message)
    this.code = code
    this.retry = retry
    this.details = details
  }
}

export interface HostClient {
  call<T = unknown>(operation: string, payload?: unknown, opts?: HostCallOptions): Promise<T>
  close(): void
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export interface ConnectHostOptions {
  /** server-initiated stream events ({t:'push'} frames — e.g. terminal
   *  attach subscriptions). Absent → pushes are parsed and dropped. */
  onEvent?: (event: { connectionId?: string; event: unknown }) => void
}

/** Connect to the host socket. Does NOT hello — use `helloHost` or call
 * 'host.hello' yourself; a bare connection proves reachability only. */
export function connectHost(endpoint: string, opts?: ConnectHostOptions): Promise<HostClient> {
  return new Promise((resolve, reject) => {
    const sock = connect(endpoint)
    const pending = new Map<number, Pending>()
    let nextId = 1
    let closed = false
    let connected = false

    const failAll = (err: Error): void => {
      for (const p of pending.values()) p.reject(err)
      pending.clear()
    }

    sock.once('connect', () => {
      connected = true
      resolve({
        call<T>(operation: string, payload?: unknown, opts?: HostCallOptions): Promise<T> {
          if (closed)
            return Promise.reject(new HostCallError('CONTROL_UNAVAILABLE', 'host client closed'))
          const id = nextId++
          const frame = {
            t: 'call',
            id,
            op: operation,
            protocolVersion: HOST_PROTOCOL_VERSION,
            ...(opts?.expectedHostIncarnation !== undefined
              ? { expectedHostIncarnation: opts.expectedHostIncarnation }
              : {}),
            ...(opts?.controllerEpoch !== undefined
              ? { controllerEpoch: opts.controllerEpoch }
              : {}),
            ...(opts?.leaseProof !== undefined ? { leaseProof: opts.leaseProof } : {}),
            ...(opts?.effectKey !== undefined ? { effectKey: opts.effectKey } : {}),
            ...(opts?.payloadFingerprint !== undefined
              ? { payloadFingerprint: opts.payloadFingerprint }
              : {}),
            payload
          }
          return new Promise<T>((res, rej) => {
            pending.set(id, { resolve: res as (v: unknown) => void, reject: rej })
            sock.write(JSON.stringify(frame) + '\n')
          })
        },
        close() {
          if (closed) return
          closed = true
          sock.destroy()
          failAll(new HostCallError('CONTROL_UNAVAILABLE', 'host client closed'))
        }
      })
    })
    // persistent listener — a socket 'error' after connect must never be an
    // unhandled 'error' event; it fails in-flight calls, nothing more.
    sock.on('error', (err) => {
      const e = err instanceof Error ? err : new Error(String(err))
      if (!connected)
        reject(
          new HostCallError(
            'CONTROL_UNAVAILABLE',
            `cannot connect to execution-host at ${endpoint}: ${e.message}`
          )
        )
      else failAll(e)
    })
    sock.on('close', () => {
      closed = true
      failAll(new HostCallError('CONTROL_UNAVAILABLE', 'execution-host connection closed'))
    })

    const rl = createInterface({ input: sock, terminal: false })
    // F-006: readline re-emits the input socket's error on the Interface. With
    // no listener that is an unhandled 'error' event → the whole mahasd process
    // died on a stale endpoint file (dial ECONNREFUSED before
    // host-attach-failed could be logged). A transport fault fails in-flight
    // calls and nothing else.
    rl.on('error', (err) => {
      const e = err instanceof Error ? err : new Error(String(err))
      if (!connected) {
        reject(
          new HostCallError(
            'CONTROL_UNAVAILABLE',
            `cannot connect to execution-host at ${endpoint}: ${e.message}`
          )
        )
      } else {
        failAll(e)
      }
    })
    rl.on('line', (line) => {
      let m: {
        t?: string
        id?: number
        ok?: boolean
        result?: unknown
        error?: { code?: string; message?: string; retry?: string; details?: unknown }
        connectionId?: string
        event?: unknown
      }
      try {
        m = JSON.parse(line) as typeof m
      } catch {
        return // a non-JSON line is not part of the framed protocol — ignore
      }
      if (m.t === 'push') {
        opts?.onEvent?.({ connectionId: m.connectionId, event: m.event })
        return
      }
      if (m.t !== 'result' || typeof m.id !== 'number') return
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.ok) p.resolve(m.result)
      else
        p.reject(
          new HostCallError(
            m.error?.code ?? 'UNKNOWN',
            m.error?.message ?? 'host call failed',
            m.error?.retry,
            m.error?.details
          )
        )
    })
  })
}

/** the endpoint file the host publishes next to its socket (0600) */
export interface HostEndpointFile {
  service: 'mahas-execution-host'
  protocolVersion: number
  hostId: string
  hostIncarnation: string
  pid: number
  startedAt: number
  birthEvidence?: string
  bootId?: string
  launchNonce: string
  endpointIncarnation: string
  endpoint: string
  dbPath: string
  authToken: string
  publishedAt: number
}

/** Read `<endpoint>.endpoint.json`; null when absent or unparsable —
 * absence is evidence about the endpoint, not about the host's death. */
export function readHostEndpoint(endpoint: string): HostEndpointFile | null {
  try {
    return JSON.parse(readFileSync(`${endpoint}.endpoint.json`, 'utf8')) as HostEndpointFile
  } catch {
    return null
  }
}

export interface HostHelloResult {
  hostId: string
  hostIncarnation: string
  endpoint: string
  protocolVersion: number
  supportedVersions: number[]
  capabilities: string[]
  challengeResponse?: string
  lease: { epoch: number; revision: number; expiresAt: number } | null
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * The full authenticated attach: read the endpoint file for the token,
 * connect, host.hello with a nonce challenge, and VERIFY the challenge
 * response — mutual authentication, not just a password sent. Throws
 * HostCallError on any step; the caller distinguishes 'no host'
 * (CONTROL_UNAVAILABLE) from 'host present but rejected us'
 * (UNAUTHENTICATED) from 'stale endpoint file' (null endpoint → caller
 * decides, we never delete or kill anything).
 */
export async function helloHost(
  endpoint: string,
  opts: {
    controllerIdentity: { pid: number; birthEvidence?: string; bootId?: string; label?: string }
    supportedVersions?: number[]
    /** defaults to readHostEndpoint(endpoint) — injectable for tests */
    endpointFile?: HostEndpointFile | null
  }
): Promise<{ client: HostClient; hello: HostHelloResult }> {
  const published = opts.endpointFile === undefined ? readHostEndpoint(endpoint) : opts.endpointFile
  if (!published) {
    throw new HostCallError(
      'CONTROL_UNAVAILABLE',
      `no endpoint file at ${endpoint}.endpoint.json — nothing verifiably published`
    )
  }
  const challenge = randomUUID()
  const client = await connectHost(endpoint)
  try {
    const hello = await client.call<HostHelloResult>('host.hello', {
      supportedVersions: opts.supportedVersions ?? [HOST_PROTOCOL_VERSION],
      controllerIdentity: opts.controllerIdentity,
      challenge,
      credential: { token: published.authToken }
    })
    if (hello.challengeResponse !== sha256Hex(`${published.authToken}:${challenge}`)) {
      throw new HostCallError(
        'UNAUTHENTICATED',
        'host failed the nonce challenge — wrong token holder or a masquerading endpoint'
      )
    }
    if (!hello.supportedVersions.includes(HOST_PROTOCOL_VERSION)) {
      throw new HostCallError(
        'HOST_PROTOCOL_MISMATCH',
        `host supports [${hello.supportedVersions}] — we speak ${HOST_PROTOCOL_VERSION}`,
        'replan'
      )
    }
    // the endpoint file may be stale even though hello worked — the
    // socket's incarnation is the authoritative one (reattach rule: trust
    // the live host's identity, not a file that could be out of date).
    return { client, hello }
  } catch (err) {
    client.close()
    throw err
  }
}
