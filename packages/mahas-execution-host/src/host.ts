// host.ts — execution-host service: identity/bootstrap, endpoint claim and
// publication, the NDJSON RPC server, session authentication, the op
// registry seam, and the IMP-17-owned ops (host.hello / host.acquire /
// host.inventory / host.effect.get).
//
// Contract: spec/contracts/execution-host.md (C-HOST) — versioned framed
// RPC over a local socket; HostEnvelope =
//   {protocolVersion, hostId, expectedHostIncarnation, controllerEpoch,
//    leaseProof, effectKey, payloadFingerprint, payload}
// carried inside a {t:'call', id, op, ...envelope} NDJSON line so parallel
// calls on one connection correlate by `id`. Server-initiated stream
// events go out as {t:'push', ...event} lines on the owning connection.
//
// Bootstrap/reattach rules (spec/execution-lifecycle.md §5, REQ-12/15):
//   * endpoint file carries protocolVersion, serviceId(hostId), pid,
//     birth evidence, bootId when available, launchNonce,
//     endpointIncarnation — published via exclusive claim + temp-file +
//     atomic rename; cleanup deletes it only while its recorded identity
//     is still ours.
//   * a live host already answering on the endpoint is NEVER killed or
//     adopted — we refuse to start (ENDPOINT_IN_USE). A stale socket file
//     is claimed only after a connect probe fails; if the stale endpoint
//     file's recorded process still verifies alive, we refuse takeover.
//   * reconnect re-VERIFIES recorded processes — inventory reports stored
//     rows as unprobed; nothing respawns or adopts them (IMP-18 owns the
//     process managers that upgrade liveness).

import { createServer, connect, type Server, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { openHostDb, sha256Hex, withTx } from './storage.ts'
import {
  acquireControllerLease,
  ownProcessIdentity,
  probeProcessIdentity,
  readLease,
  requireCurrentIncarnation,
  requireLeaseProof,
  HostOpError,
  type ControllerProcessIdentity
} from './lease.ts'
import { openEffectStore, type HostEffectStore } from './effects.ts'

/** wire-format version — bump on incompatible envelope/semantic changes */
export const EXECUTION_HOST_PROTOCOL_VERSION = 0

const SUPPORTED_VERSIONS: readonly number[] = [EXECUTION_HOST_PROTOCOL_VERSION]
const MAX_LINE_BYTES = 8 * 1024 * 1024

/**
 * F-045 backpressure: per-connection queued-output ceiling. A consumer that
 * stops draining (or a dead peer whose FIN we haven't processed yet) must not
 * let the daemon buffer unboundedly or spin on writes — past this mark the
 * connection is destroyed (close owns cleanup: conns.delete + the F-041 sub
 * drop) and the producer sees pushEvent() === false. 2MiB sits inside the
 * 1–4MiB tuning band; it is a transport constant, not a protocol shape.
 */
const PUSH_BUFFER_HIGH_WATER_BYTES = 2 * 1024 * 1024

/**
 * F-041 seam — TerminalRegistry.dropConnection threaded in from IMP-18.
 * IMP-18 owns the registry (ProcessManager.terminals); it hands
 * `(id) => manager.terminals.dropConnection(id)` to the bootstrap opts or to
 * service.setDropConnection(). Scoped: only that connection's subs drop.
 */
export type ConnectionDropHandler = (connectionId: string) => unknown

/** process/endpoint identity evidence (spec/execution-lifecycle.md §5) */
export interface HostProcessIdentity {
  pid: number
  startedAt: number
  birthEvidence?: string
  bootId?: string
  launchNonce: string
  endpointIncarnation: string
}

export interface HostIdentity {
  service: 'mahas-execution-host'
  hostId: string
  /** fresh per process — reattach equality is (hostId, hostIncarnation) */
  hostIncarnation: string
  protocolVersion: number
  endpoint: string
  dbPath: string
  processIdentity: HostProcessIdentity
}

/** C-HOST HostEnvelope fields as they arrive on the wire. */
export interface HostEnvelope {
  op: string
  protocolVersion?: number
  hostId?: string
  expectedHostIncarnation?: string
  controllerEpoch?: number
  leaseProof?: string
  effectKey?: string
  payloadFingerprint?: string
  payload?: unknown
}

/** per-connection state — exported because HostCallContext exposes it */
export interface Session {
  authenticated: boolean
  protocolMismatch: boolean
  controllerIdentity?: ControllerProcessIdentity
}

/**
 * THE REGISTRATION SEAM — the exact shape IMP-18 (host.process.*,
 * host.terminal.*) and IMP-16 (host.workspace.*) plug into via their
 * registerProcessOps(register, deps)-style adapters. Do not change without
 * consulting them: handler arg order is (payload, ctx).
 */
export interface HostOpContext {
  /** this call's connection — terminal.attach subscriptions route pushes by it */
  connectionId?: string
  controllerEpoch?: number
  leaseProof?: string
  /** HostEnvelope.expectedHostIncarnation, when the transport parsed it */
  expectedHostIncarnation?: string
}

/**
 * The context the dispatcher actually builds per call — a structural
 * superset of HostOpContext. Ops registered through the public seam see
 * the HostOpContext fields; ops that need the store ports get them here.
 */
export interface HostCallContext extends HostOpContext {
  db: DatabaseSync
  identity: HostIdentity
  envelope: HostEnvelope
  session: Session
  effects: HostEffectStore
  /** throws unless envelope carries the current epoch + fence proof */
  requireControllerLease(): void
  /** server→client event on THIS connection ({t:'push', ...} frame) */
  push(event: unknown): void
}

/**
 * Handler signature the dispatch invokes. ctx is always the full
 * HostCallContext at runtime; handlers may declare it as the narrower
 * HostOpContext (structurally assignable — they just don't see the store
 * ports). Identical to IMP-18's RegisterHostOp handler shape so
 * registerProcessOps(service.registerHostOp, deps) wires without adapters.
 */
export type HostOpHandler = (
  payload: Record<string, unknown>,
  ctx: HostCallContext
) => unknown | Promise<unknown>

/**
 * registerHostOp(name, handler, spec?) — spec defaults keep registrations
 * honest: `mutation: true` serializes the call on the host's mutation
 * queue and refuses it under a protocol-major mismatch; `requiresLease`
 * defaults to `mutation` (a mutation without lease fencing is the
 * exception — host.acquire being the only one built in); `visibility` is
 * advisory metadata for capability listing.
 */
export interface HostOpSpec {
  mutation?: boolean
  requiresLease?: boolean
  visibility?: string
}

export interface HostService {
  readonly identity: HostIdentity
  readonly endpoint: string
  readonly endpointFile: string
  readonly db: DatabaseSync
  readonly effects: HostEffectStore
  /** the seam — throws on duplicate names; ops are owned, never overridden */
  registerHostOp(name: string, handler: HostOpHandler, spec?: HostOpSpec): void
  /**
   * Route a server-initiated event to the connection recorded on it
   * (`event.connectionId` — the attach-time ctx value IMP-18's stream
   * events carry). Signature is directly assignable to their
   * `deps.push: (event) => void` hook. Returns false when the connection
   * is gone — a dead subscriber, never a reason to fail the producer.
   */
  pushEvent(event: { connectionId?: string }): boolean
  /**
   * F-041 seam — register TerminalRegistry.dropConnection (or equivalent) so
   * a socket close drops that connection's subscriptions. Until wired, close
   * only forgets the socket (orphan subs persist — see the close handler's
   * residual note). Replaces any previous handler; pass undefined to clear.
   */
  setDropConnection(handler: ConnectionDropHandler | undefined): void
  /** IMP-18's deps.assertMutationAllowed hook — epoch+proof+incarnation */
  assertMutationAllowed(op: string, ctx: HostOpContext): void
  close(): Promise<void>
}

export interface BootstrapOptions {
  endpoint: string
  dbPath: string
  /** defaults to `${endpoint}.endpoint.json` */
  endpointFile?: string
  /** authentication token published in the 0600 endpoint file; generated if absent */
  authToken?: string
  /**
   * F-041 seam — same as service.setDropConnection(); when provided, the
   * socket-close path calls it with the dead connectionId. IMP-18 passes
   * `(id) => processManager.terminals.dropConnection(id)`.
   */
  dropConnection?: ConnectionDropHandler
}

// ---------------------------------------------------------------------------
// endpoint claim + publication
// ---------------------------------------------------------------------------

interface EndpointFileBody {
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
  /** same-uid credential: readable only because the file is mode 0600 */
  authToken: string
  publishedAt: number
}

/** Is a live host answering on this socket path right now? */
function probeLiveEndpoint(path: string, timeoutMs: number): Promise<'alive' | 'stale' | 'absent'> {
  return new Promise((resolve) => {
    if (!existsSync(path)) return resolve('absent')
    let settled = false
    const done = (v: 'alive' | 'stale'): void => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    const timer = setTimeout(() => {
      sock.destroy()
      done('stale')
    }, timeoutMs)
    const sock = connect(path)
    sock.once('error', () => {
      clearTimeout(timer)
      sock.destroy()
      done('stale') // ECONNREFUSED/ENOENT — nobody listening: stale file
    })
    sock.once('connect', () => {
      try {
        sock.write(JSON.stringify({ t: 'hello' }) + '\n', () => {
          /* probe is best-effort — the error listener owns the verdict */
        })
      } catch {
        /* sync write failure — the error/close path settles the probe */
      }
    })
    sock.once('data', () => {
      clearTimeout(timer)
      sock.destroy()
      done('alive') // any answer = a live host holds this endpoint
    })
  })
}

function readEndpointFile(path: string): EndpointFileBody | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as EndpointFileBody
  } catch {
    return null
  }
}

/** temp-file + atomic rename publication, mode 0600 (carries authToken) */
function publishEndpointFile(path: string, body: EndpointFileBody): void {
  const tmp = `${path}.${body.launchNonce}.tmp`
  writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
}

/** error → wire error: both this package's and sibling modules'
 * HostOpError-shaped classes serialize by their public fields. */
function wireError(err: unknown): {
  code: string
  message: string
  retry?: string
  details?: unknown
} {
  const e = err as { code?: unknown; message?: unknown; retry?: unknown; details?: unknown }
  if (typeof e?.code === 'string' && typeof e?.message === 'string') {
    return {
      code: e.code,
      message: e.message,
      retry: typeof e.retry === 'string' ? e.retry : undefined,
      details: e.details
    }
  }
  return { code: 'UNKNOWN', message: String(err), retry: 'reconcile' }
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

export async function bootstrapHost(opts: BootstrapOptions): Promise<HostService> {
  const endpoint = opts.endpoint
  const endpointFile = opts.endpointFile ?? `${endpoint}.endpoint.json`
  const authToken = opts.authToken ?? randomUUID()

  // --- endpoint claim: never kill/adopt a live host, never blindly unlink ---
  const liveness = await probeLiveEndpoint(endpoint, 500)
  if (liveness === 'alive') {
    throw new HostOpError(
      'ENDPOINT_IN_USE',
      `a live execution-host already answers on ${endpoint} — refusing to start a second one`,
      'none'
    )
  }
  if (liveness === 'stale') {
    const stale = readEndpointFile(endpointFile)
    if (stale) {
      const verdict = probeProcessIdentity({ pid: stale.pid, birthEvidence: stale.birthEvidence })
      if (verdict === 'alive') {
        throw new HostOpError(
          'ENDPOINT_IN_USE',
          `stale socket but endpoint file's recorded host pid ${stale.pid} verifies alive — refusing takeover (operator action required)`,
          'none'
        )
      }
      // dead or unverifiable publisher + dead socket: claim the path. We
      // never touch the recorded host's processes — only its dead endpoint.
      try {
        unlinkSync(endpointFile)
      } catch {
        /* gone already */
      }
    }
    try {
      unlinkSync(endpoint)
    } catch {
      /* raced away */
    }
  }

  // --- DB + host identity (stable hostId, fresh incarnation per process) ---
  const db = openHostDb(opts.dbPath)
  const own = ownProcessIdentity()
  const launchNonce = randomUUID()
  const endpointIncarnation = randomUUID()
  const processIdentity: HostProcessIdentity = {
    pid: process.pid,
    startedAt: Date.now(),
    birthEvidence: own.birthEvidence,
    bootId: own.bootId,
    launchNonce,
    endpointIncarnation
  }

  const identity: HostIdentity = withTx(db, (tx) => {
    const prior = tx.prepare('SELECT id FROM host_identity LIMIT 1').get() as
      { id: string } | undefined
    const hostId = prior?.id ?? `host-${hostname()}`
    const hostIncarnation = randomUUID()
    const processIdentityJson = JSON.stringify(processIdentity)
    if (prior) {
      tx.prepare(
        'UPDATE host_identity SET incarnation=?, protocol_version=?, process_identity_json=? WHERE id=?'
      ).run(hostIncarnation, String(EXECUTION_HOST_PROTOCOL_VERSION), processIdentityJson, hostId)
    } else {
      tx.prepare(
        'INSERT INTO host_identity(id, incarnation, protocol_version, process_identity_json) VALUES(?,?,?,?)'
      ).run(hostId, hostIncarnation, String(EXECUTION_HOST_PROTOCOL_VERSION), processIdentityJson)
    }
    return {
      service: 'mahas-execution-host',
      hostId,
      hostIncarnation,
      protocolVersion: EXECUTION_HOST_PROTOCOL_VERSION,
      endpoint,
      dbPath: opts.dbPath,
      processIdentity
    }
  })

  const effects = openEffectStore(db)

  // --- op registry ------------------------------------------------------------
  type StoredHandler = (
    payload: Record<string, unknown>,
    ctx: HostCallContext
  ) => unknown | Promise<unknown>
  const ops = new Map<
    string,
    {
      spec: Required<Pick<HostOpSpec, 'mutation' | 'requiresLease'>> & HostOpSpec
      handler: StoredHandler
    }
  >()

  const addOp = (name: string, spec: HostOpSpec, handler: StoredHandler): void => {
    if (!name.startsWith('host.')) {
      throw new HostOpError('INVALID_ARGUMENT', `op name must live under host.*: ${name}`, 'none')
    }
    if (ops.has(name)) {
      throw new HostOpError('INVALID_ARGUMENT', `op already registered: ${name}`, 'none')
    }
    const mutation = spec.mutation === true
    ops.set(name, {
      spec: { ...spec, mutation, requiresLease: spec.requiresLease ?? mutation },
      handler
    })
  }

  /** the public seam — IMP-18/IMP-16 handlers see whatever of
   *  HostCallContext they declare (HostOpContext subset suffices) */
  const registerHostOp = (name: string, handler: HostOpHandler, spec: HostOpSpec = {}): void => {
    addOp(name, spec, handler)
  }

  // serialize all mutations — per-process lifecycle mutation ordering is a
  // spec requirement; a single queue is the honest v1 granularity (IMP-18
  // may refine per spawnNonce inside its handlers).
  let mutationChain: Promise<unknown> = Promise.resolve()
  const runMutation = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const next = mutationChain.then(fn)
    mutationChain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  const assertMutationAllowed = (op: string, ctx: HostOpContext): void => {
    requireCurrentIncarnation(ctx.expectedHostIncarnation, identity.hostIncarnation)
    requireLeaseProof(db, ctx.controllerEpoch, ctx.leaseProof)
    void op
  }

  // --- per-connection write guards (F-052 daemon crash, F-045 wedge) ---------
  // safeWrite is the ONLY response-path writer: it never throws, never emits
  // an unhandled socket error, and never feeds a flooded consumer. Failures
  // are per-connection (false) — other connections and the daemon are
  // unaffected. Wire shapes are untouched: same {t:'result'|'push'|...} lines.
  function isSocketDead(conn: Socket): boolean {
    const closed = (conn as Socket & { closed?: unknown }).closed === true
    return conn.destroyed || closed || conn.writableEnded || conn.writable !== true
  }

  function safeWrite(conn: Socket, msg: object): boolean {
    // (1) never write toward a destroyed/closed socket (F-045.1, F-052)
    if (isSocketDead(conn)) return false
    // (2) high-water mark: a consumer this far behind is flooded or dead —
    // destroy it (close owns cleanup: conns.delete + the F-041 sub drop)
    // instead of buffering unboundedly / spinning on writes (F-045.2). Any
    // terminal byte loss is already accounted honestly by
    // TerminalBuffer.droppedThrough in terminal-stream.ts — the next attach
    // replays from the retention floor with an explicit gap; host.ts only
    // stops the spin and drops the consumer.
    if (conn.writableLength > PUSH_BUFFER_HIGH_WATER_BYTES) {
      try {
        conn.destroy()
      } catch {
        /* already gone — close will settle it */
      }
      return false
    }
    let line: string
    try {
      line = JSON.stringify(msg) + '\n'
    } catch {
      return false // unserializable frame — per-connection failure, never fatal
    }
    try {
      // the write callback captures EPIPE/ECONNRESET here (F-052: no 'error'
      // emission, no throw) — the conn 'error' listener below is the second net.
      conn.write(line, () => {})
      return true
    } catch {
      return false
    }
  }

  function makeCtx(
    envelope: HostEnvelope,
    session: Session,
    connectionId: string,
    conn: Socket
  ): HostCallContext {
    return {
      connectionId,
      controllerEpoch: envelope.controllerEpoch,
      leaseProof: envelope.leaseProof,
      expectedHostIncarnation: envelope.expectedHostIncarnation,
      db,
      identity,
      envelope,
      session,
      effects,
      requireControllerLease() {
        requireLeaseProof(db, envelope.controllerEpoch, envelope.leaseProof)
      },
      push(event: unknown) {
        // best-effort by contract — safeWrite isolates dead/flooded peers (F-052/F-045)
        safeWrite(conn, { t: 'push', connectionId, event })
      }
    }
  }

  async function dispatch(
    envelope: HostEnvelope,
    session: Session,
    connectionId: string,
    conn: Socket
  ): Promise<unknown> {
    const entry = envelope.op ? ops.get(envelope.op) : undefined
    if (!entry) {
      throw new HostOpError(
        'UNAVAILABLE_OPERATION',
        `unknown host op: ${String(envelope.op)}`,
        'none'
      )
    }
    const { spec, handler } = entry
    const payload = (envelope.payload ?? {}) as Record<string, unknown>

    // every op except host.hello requires an authenticated session
    if (envelope.op !== 'host.hello' && !session.authenticated) {
      throw new HostOpError(
        'UNAUTHENTICATED',
        'host.hello with a valid credential is required before other ops',
        'none'
      )
    }

    // protocol-major mismatch: mutations refused, reads still answered
    const wireVersion = envelope.protocolVersion
    const mismatch =
      (wireVersion !== undefined && wireVersion !== EXECUTION_HOST_PROTOCOL_VERSION) ||
      session.protocolMismatch
    if (mismatch && spec.mutation) {
      throw new HostOpError(
        'HOST_PROTOCOL_MISMATCH',
        `protocolVersion ${String(wireVersion)} vs host ${EXECUTION_HOST_PROTOCOL_VERSION} — mutations refused`,
        'replan',
        { supportedVersions: SUPPORTED_VERSIONS }
      )
    }

    // stale host incarnation / wrong hostId is a named refusal on non-hello ops
    if (envelope.op !== 'host.hello') {
      requireCurrentIncarnation(envelope.expectedHostIncarnation, identity.hostIncarnation)
      if (envelope.hostId !== undefined && envelope.hostId !== identity.hostId) {
        throw new HostOpError(
          'INVALID_ARGUMENT',
          `envelope hostId ${envelope.hostId} is not this host (${identity.hostId})`,
          'none'
        )
      }
    }

    if (spec.requiresLease) {
      requireLeaseProof(db, envelope.controllerEpoch, envelope.leaseProof)
    }

    const ctx = makeCtx(envelope, session, connectionId, conn)
    return spec.mutation ? runMutation(() => handler(payload, ctx)) : handler(payload, ctx)
  }

  // --- owned ops (registered internally — they see the full HostCallContext) --

  addOp(
    'host.hello',
    { mutation: false, requiresLease: false, visibility: 'service' },
    (payload, ctx) => {
      const p = payload as {
        supportedVersions?: number[]
        controllerIdentity?: ControllerProcessIdentity
        challenge?: string
        credential?: { token?: string }
      }
      if (!p.credential?.token || p.credential.token !== authToken) {
        throw new HostOpError(
          'UNAUTHENTICATED',
          'missing or invalid credential — present the endpoint-file token',
          'none'
        )
      }
      ctx.session.authenticated = true
      ctx.session.controllerIdentity = p.controllerIdentity
      const versions = Array.isArray(p.supportedVersions) ? p.supportedVersions : SUPPORTED_VERSIONS
      ctx.session.protocolMismatch = !versions.includes(EXECUTION_HOST_PROTOCOL_VERSION)
      const lease = readLease(db)
      return {
        hostId: identity.hostId,
        hostIncarnation: identity.hostIncarnation,
        endpoint: identity.endpoint,
        protocolVersion: EXECUTION_HOST_PROTOCOL_VERSION,
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: [...ops.keys()].sort(),
        challengeResponse: p.challenge ? sha256Hex(`${authToken}:${p.challenge}`) : undefined,
        lease: lease
          ? { epoch: lease.epoch, revision: lease.revision, expiresAt: lease.expiresAt }
          : null
      }
    }
  )

  addOp(
    'host.acquire',
    { mutation: true, requiresLease: false, visibility: 'service' },
    (payload, ctx) => {
      const p = payload as {
        controllerEpoch: number
        controllerProcessIdentity: ControllerProcessIdentity
        takeoverProof?: {
          kind: 'dead-evidence' | 'explicit-handoff'
          handoffToken?: string
          note?: string
        }
        priorLeaseRevision?: number
        ttlMs?: number
      }
      return acquireControllerLease(ctx.db, ctx.identity.hostId, {
        controllerEpoch: p.controllerEpoch,
        controllerProcessIdentity: p.controllerProcessIdentity,
        takeoverProof: p.takeoverProof,
        priorLeaseRevision: p.priorLeaseRevision,
        ttlMs: p.ttlMs
      })
    }
  )

  addOp(
    'host.inventory',
    { mutation: false, requiresLease: false, visibility: 'service' },
    (payload, ctx) => {
      const p = payload as { hostId?: string; incarnation?: string; cursor?: string }
      if (p.hostId !== undefined && p.hostId !== identity.hostId) {
        throw new HostOpError(
          'INVALID_ARGUMENT',
          `inventory for host ${p.hostId} — this is ${identity.hostId}`,
          'none'
        )
      }
      if (p.incarnation !== undefined) {
        requireCurrentIncarnation(p.incarnation, identity.hostIncarnation)
      }
      const processes = (
        ctx.db
          .prepare(
            'SELECT spawn_nonce, execution_id, generation, pid, state, identity_json FROM host_processes ORDER BY spawn_nonce'
          )
          .all() as Array<{
          spawn_nonce: string
          execution_id: string
          generation: number
          pid: number | null
          state: string
          identity_json: string
        }>
      ).map((r) => ({
        spawnNonce: r.spawn_nonce,
        executionId: r.execution_id,
        generation: r.generation,
        pid: r.pid,
        state: r.state,
        identity: JSON.parse(r.identity_json) as unknown,
        // reattach honesty: a stored row is a claim, not a liveness proof.
        // IMP-18's process manager upgrades this after a real OS probe.
        liveness: 'unverifiable' as const,
        verification: { probed: false, basis: 'stored row only — no OS probe at this snapshot' }
      }))
      const terminals = ctx.db
        .prepare(
          'SELECT id, spawn_nonce, pty_id, output_epoch, last_sequence, state, buffer_ref FROM host_terminals ORDER BY id'
        )
        .all() as Array<{
        id: string
        spawn_nonce: string
        pty_id: string
        output_epoch: string
        last_sequence: number
        state: string
        buffer_ref: string | null
      }>
      const workspaces = ctx.db
        .prepare(
          'SELECT id, effect_key, canonical_path, identity_json, state FROM host_workspaces ORDER BY id'
        )
        .all() as Array<{
        id: string
        effect_key: string
        canonical_path: string
        identity_json: string
        state: string
      }>
      const lease = readLease(ctx.db)
      return {
        hostId: identity.hostId,
        hostIncarnation: identity.hostIncarnation,
        evidenceTime: Date.now(),
        processes,
        terminals: terminals.map((t) => ({
          id: t.id,
          spawnNonce: t.spawn_nonce,
          ptyId: t.pty_id,
          outputEpoch: t.output_epoch,
          lastSequence: t.last_sequence,
          state: t.state,
          bufferRef: t.buffer_ref
        })),
        workspaces: workspaces.map((w) => ({
          id: w.id,
          effectKey: w.effect_key,
          canonicalPath: w.canonical_path,
          identity: JSON.parse(w.identity_json) as unknown,
          state: w.state
        })),
        effectKeys: ctx.effects.listKeys(),
        lease: lease
          ? {
              epoch: lease.epoch,
              revision: lease.revision,
              expiresAt: lease.expiresAt,
              holderPid: lease.proof.controllerIdentity.pid
            }
          : null,
        nextCursor: null // cursor accepted; v1 returns the full inventory unpaged
      }
    }
  )

  addOp(
    'host.effect.get',
    { mutation: false, requiresLease: false, visibility: 'service' },
    (payload, ctx) => {
      const p = payload as { effectKey?: string }
      const effectKey = p.effectKey ?? ctx.envelope.effectKey
      if (!effectKey) {
        throw new HostOpError('INVALID_ARGUMENT', 'effectKey is required', 'none')
      }
      const effect = ctx.effects.get(effectKey)
      if (!effect) {
        // not-found carries the limits of its negative evidence (C-HOST)
        return {
          found: false,
          effectKey,
          negativeEvidence: {
            hostId: ctx.identity.hostId,
            hostIncarnation: ctx.identity.hostIncarnation,
            checkedAt: Date.now(),
            basis: 'no host_effects row for this key in the current host DB',
            limitation:
              'positive absence covers only receipts this DB generation recorded — a reset or restored DB loses history; absence is not proof an effect never ran'
          }
        }
      }
      return { found: true, effect }
    }
  )

  // --- socket server ------------------------------------------------------------

  const conns = new Map<string, Socket>()
  let nextConnId = 1
  // F-041: TerminalRegistry.dropConnection threaded in via the opts/service
  // seam (IMP-18 owns the registry) — invoked with the dead id on close.
  let dropConnectionHandler: ConnectionDropHandler | undefined = opts.dropConnection

  function publicIdentity(): object {
    // what the unauthenticated liveness probe may see — identity only
    return {
      service: identity.service,
      hostId: identity.hostId,
      hostIncarnation: identity.hostIncarnation,
      protocolVersion: identity.protocolVersion,
      endpoint: identity.endpoint,
      pid: identity.processIdentity.pid,
      startedAt: identity.processIdentity.startedAt,
      endpointIncarnation: identity.processIdentity.endpointIncarnation
    }
  }

  async function onLine(
    conn: Socket,
    session: Session,
    connectionId: string,
    line: string
  ): Promise<void> {
    const write = (msg: object): boolean => safeWrite(conn, msg)
    if (line.length > MAX_LINE_BYTES) {
      write({ t: 'error', code: 'INVALID_ARGUMENT', message: 'frame too large' })
      conn.destroy()
      return
    }
    let m: { t?: string; id?: number } & Partial<HostEnvelope>
    try {
      m = JSON.parse(line) as typeof m
    } catch {
      write({ t: 'error', code: 'BAD_JSON' })
      return
    }

    // legacy liveness probe (IMP-01 wire shape) — public identity, no auth
    if (m.t === 'hello') {
      write({ t: 'hello', ...publicIdentity() })
      return
    }
    if (m.t === 'quit') {
      if (!session.authenticated) {
        write({ t: 'error', code: 'UNAUTHENTICATED' })
        return
      }
      write({ t: 'bye' })
      void service.close().then(() => process.exit(0))
      return
    }
    if (m.t !== 'call') {
      write({ t: 'error', code: 'UNAVAILABLE_OPERATION', op: m.t ?? null })
      return
    }
    if (typeof m.id !== 'number') {
      write({ t: 'error', code: 'INVALID_ARGUMENT', message: 'call requires numeric id' })
      return
    }
    try {
      const result = await dispatch(
        m as unknown as HostEnvelope & { id: number },
        session,
        connectionId,
        conn
      )
      write({ t: 'result', id: m.id, ok: true, result })
    } catch (err) {
      write({ t: 'result', id: m.id, ok: false, error: wireError(err) })
    }
  }

  const server: Server = createServer((conn) => {
    const connectionId = `conn-${nextConnId++}`
    const session: Session = { authenticated: false, protocolMismatch: false }
    conns.set(connectionId, conn)
    conn.on('close', () => {
      conns.delete(connectionId)
      // F-041: subscriptions owned by this connection die with it — scoped to
      // this id only. Until IMP-18 threads TerminalRegistry.dropConnection
      // through the seam above, close only forgets the socket (residual gap).
      try {
        dropConnectionHandler?.(connectionId)
      } catch {
        /* cleanup never fails a close — the socket is already forgotten */
      }
    })
    conn.on('error', () => {
      /* F-052: peer went away — connection-scoped, never fatal; close owns cleanup */
    })
    const rl = createInterface({ input: conn, terminal: false })
    rl.on('line', (line) => {
      // onLine never rejects by construction; the catch is dead-peer insurance
      // (a floating rejection on Node 24 would take the daemon down).
      void onLine(conn, session, connectionId, line).catch(() => {})
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err) =>
      reject(new HostOpError('LISTEN_FAILED', String(err.message ?? err), 'none'))
    )
    server.listen(endpoint, () => resolve())
  })
  try {
    chmodSync(endpoint, 0o600)
  } catch {
    /* best effort — the endpoint file's 0600 token is the real gate */
  }

  publishEndpointFile(endpointFile, {
    service: 'mahas-execution-host',
    protocolVersion: EXECUTION_HOST_PROTOCOL_VERSION,
    hostId: identity.hostId,
    hostIncarnation: identity.hostIncarnation,
    pid: process.pid,
    startedAt: processIdentity.startedAt,
    birthEvidence: own.birthEvidence,
    bootId: own.bootId,
    launchNonce,
    endpointIncarnation,
    endpoint,
    dbPath: opts.dbPath,
    authToken,
    publishedAt: Date.now()
  })

  const service: HostService = {
    identity,
    endpoint,
    endpointFile,
    db,
    effects,
    registerHostOp,
    pushEvent(event) {
      const conn = event.connectionId ? conns.get(event.connectionId) : undefined
      if (!conn) return false
      // false = dead/flooded subscriber (flooded conns are destroyed by
      // safeWrite, so the producer stops feeding them) — never a producer failure
      return safeWrite(conn, { t: 'push', connectionId: event.connectionId, event })
    },
    setDropConnection(handler) {
      dropConnectionHandler = handler
    },
    assertMutationAllowed,
    close() {
      return new Promise<void>((resolve) => {
        for (const c of conns.values()) c.destroy()
        server.close(() => {
          // identity-matched cleanup: delete only what is still ours
          try {
            const published = readEndpointFile(endpointFile)
            if (
              published &&
              published.endpointIncarnation === endpointIncarnation &&
              published.pid === process.pid
            ) {
              unlinkSync(endpointFile)
            }
          } catch {
            /* leave it — next boot treats it as evidence */
          }
          try {
            if (existsSync(endpoint)) unlinkSync(endpoint)
          } catch {
            /* next start probes again */
          }
          try {
            db.close()
          } catch {
            /* closing twice / already closed */
          }
          resolve()
        })
        setTimeout(resolve, 1500).unref()
      })
    }
  }
  return service
}
