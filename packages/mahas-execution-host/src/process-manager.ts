// mahas-execution-host — process spawn/probe/stop + the op-registration
// seam for the whole IMP-18 surface (IMP-18).
//
// Contracts honoured here:
//   spec/contracts/execution-host.md — effect intent is journaled BEFORE
//     the OS call through IMP-17's HostEffectStore; same effectKey+payload
//     replays the stored receipt; a conflicting nonce is refused; the
//     spawn→commit gap stays 'attempting'/'unknown', never guessed
//   spec/domains/execution.md §1/§4/§5 — ProcessIncarnation identity
//     (pid + birthEvidence + processGroupIdentity), direct executable+argv
//     spawn (no shell interpolation, no typing into an existing TUI),
//     verified group stop
//   spec/storage.md §4 — host_processes / host_terminals rows
//   spec/execution-lifecycle.md §4 — output and control never share a
//     queue: output is a bounded ring + push events, stop runs on a
//     per-process serialized lane
//
// Seam (IMP-17 owns host.ts): registerProcessOps(register, deps) is called
// once at bootstrap with service.registerHostOp — it registers all eight
// IMP-18 ops:
//     host.process.spawn / host.process.probe / host.process.stop
//     host.terminal.attach / host.terminal.input / host.terminal.resize
//     host.terminal.snapshot / host.terminal.detach
// Handlers receive IMP-17's HostCallContext (db, identity, envelope,
// session, effects, requireControllerLease). The dispatcher already
// enforces authentication, protocol-major gating, expectedHostIncarnation
// and — for ops marked requiresLease — the epoch+fence proof; handlers
// still check the exact ProcessIncarnation / InputLease they act on.

import type { DatabaseSync } from 'node:sqlite'
import type { ProcessIncarnation } from '../../mahas-contracts/src/index.ts'
import type { HostCallContext, HostOpContext, HostOpSpec } from './host.ts'
import { HostOpError, fingerprintPayload } from './lease.ts'
import { withTx } from './storage.ts'
import {
  spawnProcess,
  ptyAvailable,
  SpawnReject,
  type SpawnedChild,
  type SpawnSpec
} from './pty-manager.ts'
import { captureIncarnation, verifyIncarnation } from './process-identity.ts'
import { stopProcess, type StopMode, type StopReceipt } from './stop-controller.ts'
import {
  TerminalRegistry,
  type TerminalRuntime,
  type TerminalStreamEvent
} from './terminal-stream.ts'

export { SpawnReject, HostOpError }
export type { SpawnSpec }

// ---------------------------------------------------------------------------
// seam types
// ---------------------------------------------------------------------------

/**
 * IMP-17's service.registerHostOp — (name, handler, spec?) => void.
 * Handlers are (payload, ctx) per the seam contract; IMP-17's dispatch
 * always passes the full HostCallContext, so sibling ops may rely on its
 * db/effects/identity fields (structural superset of HostOpContext).
 */
export type RegisterHostOp = (
  name: string,
  handler: (payload: Record<string, unknown>, ctx: HostCallContext) => unknown | Promise<unknown>,
  spec?: HostOpSpec
) => void

export interface ProcessOpsDeps {
  /** execution-host.sqlite — the same handle HostCallContext.db carries;
   *  needed at construction to recover surviving rows */
  db: DatabaseSync
  hostId: string
  hostIncarnation: string
  now?: () => number
  /** IMP-17's HostService.pushEvent — routes a stream event to the
   *  connection that attached the subscription */
  pushEvent?: (connectionId: string, event: TerminalStreamEvent) => void
  /** IMP-17's HostService.assertMutationAllowed — epoch+fence+incarnation
   *  re-check inside the handler (dispatch's requiresLease fences first) */
  assertMutationAllowed?: (op: string, ctx: HostOpContext) => void
  /** authoritative InputLease check (IMP-17 lease machinery). Absent →
   *  input/resize receipts report leaseVerified:false — never a fake pass */
  verifyInputLease?: (terminalId: string, inputLeaseRevision: number) => boolean
  maxBufferBytes?: number
  maxBufferChunks?: number
}

// ---------------------------------------------------------------------------
// row shapes (spec/storage.md §4)
// ---------------------------------------------------------------------------

interface ProcessRow {
  spawn_nonce: string
  execution_id: string
  generation: number
  pid: number | null
  state: string
  identity_json: string
  process_spec_json: string
}

type ManagedState =
  'attempting' | 'running' | 'stopping' | 'exited' | 'stop_unknown' | 'spawn_rejected' | 'unknown'

interface ManagedProcess {
  spawnNonce: string
  executionId: string
  generation: number
  spec: SpawnSpec
  /** live handle — absent for rows recovered after a host restart */
  child?: SpawnedChild
  incarnation: ProcessIncarnation
  state: ManagedState
  terminalId?: string
  /** bounded pipes-output tail (in-memory diagnostics, not a transcript) */
  outputTail: Uint8Array[]
  outputTailBytes: number
  exit?: { exitCode?: number; signal?: string; at: number }
  /** serialized lifecycle lane — one mutation at a time per process */
  queue: Promise<unknown>
}

const OUTPUT_TAIL_CAP = 256 * 1024

// ---------------------------------------------------------------------------
// ProcessManager
// ---------------------------------------------------------------------------

export class ProcessManager {
  private procs = new Map<string, ManagedProcess>()
  private runtimes = new Map<string, TerminalRuntime>()
  readonly terminals: TerminalRegistry

  private readonly deps: ProcessOpsDeps

  constructor(deps: ProcessOpsDeps) {
    this.deps = deps
    this.terminals = new TerminalRegistry({
      now: deps.now,
      // only advertise push when the transport actually wired pushEvent —
      // attach must not claim streaming it can't deliver
      push: deps.pushEvent
        ? (event) => {
            if (event.connectionId) deps.pushEvent!(event.connectionId, event)
          }
        : undefined,
      verifyInputLease: deps.verifyInputLease,
      resolve: (terminalId) => this.runtimes.get(terminalId),
      persist: (terminalId, patch) => this.persistTerminal(terminalId, patch),
      maxBufferBytes: deps.maxBufferBytes,
      maxBufferChunks: deps.maxBufferChunks
    })
    this.recover()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** load surviving rows — recovered processes are probe-able, never adopted */
  private recover(): void {
    let rows: ProcessRow[] = []
    try {
      rows = this.deps.db.prepare('SELECT * FROM host_processes').all() as unknown as ProcessRow[]
    } catch {
      return // table absent — storage layer not migrated yet; run empty
    }
    for (const r of rows) {
      const identity = safeJson<ProcessIncarnation>(r.identity_json) ?? {}
      const spec = safeJson<SpawnSpec>(r.process_spec_json) ?? { argv: [] }
      this.procs.set(r.spawn_nonce, {
        spawnNonce: r.spawn_nonce,
        executionId: r.execution_id,
        generation: r.generation,
        spec,
        incarnation: identity,
        state: (r.state || 'unknown') as ManagedState,
        outputTail: [],
        outputTailBytes: 0,
        queue: Promise.resolve()
      })
    }
    let termRows: Array<{
      id: string
      spawn_nonce: string
      pty_id: string
      output_epoch: string
      last_sequence: number
      state: string
    }> = []
    try {
      termRows = this.deps.db.prepare('SELECT * FROM host_terminals').all() as never[]
    } catch {
      return
    }
    for (const r of termRows) {
      // recovered terminals keep identity+cursor; their byte buffer is
      // volatile and honestly empty after a host restart
      const t = this.terminals.register(r.id, r.spawn_nonce, r.pty_id, 80, 24)
      t.buffer.outputEpoch = r.output_epoch
      t.buffer.lastSequence = r.last_sequence
      t.buffer.droppedThrough = r.last_sequence // nothing retained — honest gap
      if (r.state === 'exited' || r.state === 'closed') {
        t.state = 'exited'
      }
    }
  }

  private persistProcess(db: DatabaseSync, mp: ManagedProcess): void {
    withTx(db, (tx) => {
      tx.prepare(
        `INSERT INTO host_processes(spawn_nonce,execution_id,generation,pid,state,identity_json,process_spec_json)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(spawn_nonce) DO UPDATE SET
           pid=excluded.pid, state=excluded.state, identity_json=excluded.identity_json`
      ).run(
        mp.spawnNonce,
        mp.executionId,
        mp.generation,
        mp.incarnation.pid ?? null,
        mp.state,
        JSON.stringify(mp.incarnation),
        JSON.stringify(mp.spec)
      )
    })
  }

  private persistTerminal(
    terminalId: string,
    patch: { outputEpoch?: string; lastSequence?: number; state?: string }
  ): void {
    try {
      withTx(this.deps.db, (tx) => {
        tx.prepare(
          `UPDATE host_terminals SET
             last_sequence = COALESCE(?, last_sequence),
             output_epoch = COALESCE(?, output_epoch),
             state = COALESCE(?, state)
           WHERE id = ?`
        ).run(
          patch.lastSequence ?? null,
          patch.outputEpoch ?? null,
          patch.state ?? null,
          terminalId
        )
      })
    } catch {
      /* persistence mirror failure must not crash the stream */
    }
  }

  /** per-process serialized mutation lane (C-HOST lifecycle serialization) */
  private enqueue<T>(mp: ManagedProcess, fn: () => Promise<T> | T): Promise<T> {
    const next = mp.queue.then(fn, fn)
    mp.queue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  // ---- host.process.spawn -------------------------------------------------

  async spawn(payload: Record<string, unknown>, ctx: HostCallContext): Promise<unknown> {
    this.deps.assertMutationAllowed?.('host.process.spawn', ctx)
    const spawnNonce = str(payload.spawnNonce)
    const executionId = str(payload.executionId) ?? ''
    const generation = num(payload.generation) ?? 0
    const spec = payload.spec as SpawnSpec | undefined
    if (!spawnNonce) throw new HostOpError('INVALID_ARGUMENT', 'spawnNonce required')
    if (!spec || !Array.isArray(spec.argv) || spec.argv.length === 0) {
      throw new HostOpError('INVALID_ARGUMENT', 'spec.argv must be a non-empty array')
    }
    if (!String(spec.argv[0]).startsWith('/')) {
      throw new HostOpError('INVALID_ARGUMENT', 'spec.argv[0] must be an absolute path')
    }
    if (spec.pty && !ptyAvailable()) {
      throw new HostOpError(
        'UNAVAILABLE_OPERATION',
        'pty requested but the node-pty binding is unavailable on this host'
      )
    }
    // the envelope's effectKey wins (C-HOST); a stable derived key is the
    // fallback so direct op calls stay idempotent
    const effectKey = str(payload.effectKey) ?? str(ctx.envelope.effectKey) ?? `spawn:${spawnNonce}`
    const fingerprint = fingerprintPayload({ spawnNonce, executionId, generation, spec })

    const { effect: prior, replayed } = ctx.effects.begin({
      effectKey,
      kind: 'process.spawn',
      fingerprint,
      intent: { spawnNonce, executionId, generation, spec }
    })
    if (replayed) {
      const existing = this.procs.get(spawnNonce)
      return {
        processIncarnation: existing?.incarnation ?? null,
        terminalId: existing?.terminalId,
        replayed: true,
        spawn: prior.receipt
      }
    }
    const existingNonce = this.procs.get(spawnNonce)
    if (existingNonce && existingNonce.executionId !== executionId) {
      throw new HostOpError(
        'OPERATION_CONFLICT',
        `spawnNonce ${spawnNonce} already bound to a different execution`
      )
    }

    // intent journaled (prepared) → mark the OS call in-flight. If the host
    // dies between spawn and commit the row stays 'attempting' — the crash
    // gap is 'unknown' by contract, never rewritten.
    ctx.effects.record(effectKey, 'attempting', { attemptingAt: this.now() })

    // stamp the child for downstream attribution (hook/observation evidence)
    const stampedSpec: SpawnSpec = {
      ...spec,
      env: { ...(spec.env ?? {}), MAHAS_SPAWN_NONCE: spawnNonce }
    }

    let child: SpawnedChild
    try {
      child = await spawnProcess(stampedSpec)
    } catch (e) {
      const receipt = {
        state: 'rejected' as const,
        errno: e instanceof SpawnReject ? e.errno : undefined,
        message: String((e as Error).message ?? e),
        at: this.now()
      }
      ctx.effects.record(effectKey, 'rejected', receipt)
      const mp: ManagedProcess = {
        spawnNonce,
        executionId,
        generation,
        spec,
        incarnation: { hostId: this.deps.hostId, spawnNonce },
        state: 'spawn_rejected',
        outputTail: [],
        outputTailBytes: 0,
        queue: Promise.resolve()
      }
      this.procs.set(spawnNonce, mp)
      this.persistProcess(ctx.db, mp)
      return { processIncarnation: null, spawn: receipt }
    }

    const incarnation = captureIncarnation(this.deps.hostId, spawnNonce, child.pid)
    const mp: ManagedProcess = {
      spawnNonce,
      executionId,
      generation,
      spec,
      child,
      incarnation,
      state: 'running',
      outputTail: [],
      outputTailBytes: 0,
      queue: Promise.resolve()
    }
    this.procs.set(spawnNonce, mp)

    let terminalId: string | undefined
    if (child.kind === 'pty' && spec.pty) {
      const tid = `term-${spawnNonce}`
      terminalId = tid
      const ptyId = `pty-${spawnNonce}`
      this.terminals.register(tid, spawnNonce, ptyId, spec.pty.cols, spec.pty.rows)
      this.runtimes.set(tid, { child, cols: spec.pty.cols, rows: spec.pty.rows })
      try {
        withTx(ctx.db, (tx) => {
          tx.prepare(
            `INSERT INTO host_terminals(id,spawn_nonce,pty_id,output_epoch,last_sequence,state,buffer_ref)
             VALUES(?,?,?,?,?,'open','volatile:mem')`
          ).run(tid, spawnNonce, ptyId, this.terminals.get(tid)!.buffer.outputEpoch, 0)
        })
      } catch (e) {
        // terminal row failed but the process is live — record honestly
        ctx.effects.record(effectKey, 'unknown', {
          state: 'unknown',
          reason: `terminal row failed after spawn: ${String((e as Error).message ?? e)}`,
          processIncarnation: incarnation
        })
        this.persistProcess(ctx.db, mp)
        return {
          processIncarnation: incarnation,
          spawn: ctx.effects.get(effectKey)?.receipt
        }
      }
    }

    child.onData((bytes) => {
      if (terminalId) {
        this.terminals.feed(terminalId, bytes)
      } else {
        mp.outputTail.push(bytes)
        mp.outputTailBytes += bytes.byteLength
        while (mp.outputTailBytes > OUTPUT_TAIL_CAP && mp.outputTail.length > 1) {
          mp.outputTailBytes -= mp.outputTail.shift()!.byteLength
        }
      }
    })
    child.onExit((e) => {
      mp.exit = { exitCode: e.exitCode, signal: e.signal, at: this.now() }
      mp.incarnation.observedExit = mp.exit
      if (mp.state === 'running' || mp.state === 'stopping' || mp.state === 'stop_unknown') {
        mp.state = 'exited'
      }
      this.persistProcess(this.deps.db, mp)
      if (terminalId) this.terminals.markExited(terminalId, e)
    })

    const receipt = {
      state: 'confirmed' as const,
      effectKey,
      processIncarnation: incarnation,
      terminalId,
      pid: child.pid,
      birthEvidence: incarnation.birthEvidence ?? null,
      groupIdentity: incarnation.processGroupIdentity ?? null,
      pty: child.kind === 'pty',
      at: this.now()
    }
    ctx.effects.record(effectKey, 'confirmed', receipt)
    this.persistProcess(ctx.db, mp)
    return { processIncarnation: incarnation, terminalId, spawn: receipt }
  }

  // ---- host.process.probe -------------------------------------------------

  probe(payload: Record<string, unknown>): unknown {
    const inc = expectedIncarnation(payload)
    const mp = this.procs.get(inc.spawnNonce ?? '')
    if (!mp) {
      return {
        liveness: 'unverifiable',
        evidence: { reason: 'no-host-record', note: 'absence is not proof of non-existence' }
      }
    }
    // the caller's expectation must match the stored incarnation — probing a
    // different pid/birth under the same nonce is a conflict, not a lookup
    if (
      (inc.pid !== undefined && inc.pid !== mp.incarnation.pid) ||
      (inc.birthEvidence !== undefined && inc.birthEvidence !== mp.incarnation.birthEvidence)
    ) {
      throw new HostOpError(
        'PROCESS_UNVERIFIABLE',
        'expected incarnation does not match the stored identity',
        'reconcile'
      )
    }
    const check = verifyIncarnation(mp.incarnation)
    let liveness = check.verdict
    if (mp.state === 'exited' && liveness !== 'live') liveness = 'exited'
    return {
      liveness,
      spawnNonce: mp.spawnNonce,
      state: mp.state,
      evidence: check.evidence,
      observedExit: mp.incarnation.observedExit ?? mp.exit,
      identity: mp.incarnation
    }
  }

  // ---- host.process.stop --------------------------------------------------

  async stop(payload: Record<string, unknown>, ctx: HostCallContext): Promise<unknown> {
    this.deps.assertMutationAllowed?.('host.process.stop', ctx)
    const inc = expectedIncarnation(payload)
    const mp = this.procs.get(inc.spawnNonce ?? '')
    if (!mp) {
      throw new HostOpError('PROCESS_UNVERIFIABLE', 'no host record for this incarnation')
    }
    if (
      (inc.pid !== undefined && inc.pid !== mp.incarnation.pid) ||
      (inc.birthEvidence !== undefined && inc.birthEvidence !== mp.incarnation.birthEvidence)
    ) {
      throw new HostOpError(
        'PROCESS_UNVERIFIABLE',
        'expected incarnation does not match the stored identity — refusing to signal',
        'reconcile'
      )
    }
    const mode: StopMode =
      payload.mode === 'immediate'
        ? 'immediate'
        : payload.mode === 'graceful'
          ? 'graceful'
          : 'escalate'
    const graceBudget = Math.max(0, num(payload.graceBudget) ?? 3000)
    const effectKey =
      str(payload.effectKey) ??
      str(ctx.envelope.effectKey) ??
      `stop:${mp.spawnNonce}:${mp.incarnation.pid ?? 'nopid'}`
    const fingerprint = fingerprintPayload({
      spawnNonce: mp.spawnNonce,
      incarnation: mp.incarnation,
      mode
    })
    const { effect: prior, replayed } = ctx.effects.begin({
      effectKey,
      kind: 'process.stop',
      fingerprint,
      intent: { spawnNonce: mp.spawnNonce, incarnation: mp.incarnation, mode, graceBudget }
    })
    if (replayed) {
      return { replayed: true, stop: prior.receipt }
    }
    ctx.effects.record(effectKey, 'attempting', { attemptingAt: this.now() })

    return this.enqueue(mp, async () => {
      if (mp.state === 'exited') {
        const receipt: StopReceipt = {
          outcome: 'exited',
          steps: [],
          observedExit: mp.exit,
          evidence: { groupVerified: false, reason: 'already-exited' }
        }
        ctx.effects.record(effectKey, 'confirmed', receipt)
        return { stop: receipt }
      }
      mp.state = 'stopping'
      this.persistProcess(ctx.db, mp)
      let receipt: StopReceipt
      try {
        receipt = await stopProcess(
          {
            incarnation: mp.incarnation,
            waitExit: async () => mp.exit ?? null
          },
          mode,
          graceBudget,
          () => this.now()
        )
      } catch (e) {
        mp.state = 'stop_unknown'
        this.persistProcess(ctx.db, mp)
        ctx.effects.record(effectKey, 'unknown', {
          state: 'unknown',
          reason: String((e as Error).message ?? e)
        })
        if (e instanceof HostOpError) throw e
        throw new HostOpError('STOP_UNKNOWN', String((e as Error).message ?? e), 'reconcile')
      }
      if (receipt.outcome === 'exited') {
        mp.state = 'exited'
        mp.exit = receipt.observedExit ?? mp.exit
        mp.incarnation.observedExit = mp.exit
        ctx.effects.record(effectKey, 'confirmed', receipt)
      } else {
        mp.state = 'stop_unknown'
        ctx.effects.record(effectKey, 'unknown', receipt)
      }
      this.persistProcess(ctx.db, mp)
      return { stop: receipt }
    })
  }

  /** extra liveness data host.inventory can merge (IMP-17 owns that op) */
  inventoryDetail(): unknown {
    const processes = [...this.procs.values()].map((mp) => ({
      spawnNonce: mp.spawnNonce,
      executionId: mp.executionId,
      generation: mp.generation,
      state: mp.state,
      pid: mp.incarnation.pid,
      handleLive: mp.child !== undefined && !mp.child.exited,
      terminalId: mp.terminalId
    }))
    const terminals = [...this.procs.values()]
      .filter((mp) => mp.terminalId)
      .map((mp) => {
        const t = this.terminals.get(mp.terminalId!)
        return {
          terminalId: mp.terminalId,
          spawnNonce: mp.spawnNonce,
          state: t?.state,
          lastSequence: t?.buffer.lastSequence,
          outputEpoch: t?.buffer.outputEpoch
        }
      })
    return { processes, terminals, ptyAvailable: ptyAvailable() }
  }

  /** daemon shutdown — subscriptions/timers drop; owned processes are NOT
   *  killed (host-owned lifetime: a controller restart must be able to
   *  reattach — killing them is a drain-and-stop decision, IMP-17's). */
  dispose(): void {
    this.terminals.dispose()
  }
}

// ---------------------------------------------------------------------------
// payload helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function safeJson<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T
  } catch {
    return undefined
  }
}
function asRec(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

/** callers may pass {spawnNonce} or a full {processIncarnation} */
function expectedIncarnation(payload: Record<string, unknown>): ProcessIncarnation {
  const pi = payload.processIncarnation as ProcessIncarnation | undefined
  if (pi) return pi
  const inc: ProcessIncarnation = {}
  if (str(payload.spawnNonce)) inc.spawnNonce = str(payload.spawnNonce)
  if (num(payload.pid)) inc.pid = num(payload.pid)
  if (str(payload.birthEvidence)) inc.birthEvidence = str(payload.birthEvidence)
  return inc
}

/** payload-level re-check for ops that carry expectedHostIncarnation inline
 *  (host.terminal.input per C-HOST) — the envelope field is already
 *  enforced by IMP-17's dispatch; this covers the payload mirror. */
function requirePayloadIncarnation(
  payload: Record<string, unknown>,
  hostIncarnation: string
): void {
  const expected = str(payload.expectedHostIncarnation)
  if (expected && expected !== hostIncarnation) {
    throw new HostOpError('STALE_EXECUTION', 'stale expectedHostIncarnation', 'reconcile', {
      currentIncarnation: hostIncarnation
    })
  }
}

// ---------------------------------------------------------------------------
// the registration seam — IMP-17 plugs this into service.registerHostOp
// ---------------------------------------------------------------------------

export interface ProcessOpsHandle {
  manager: ProcessManager
  /** subscriptions/timers drop; owned processes are deliberately left
   *  running for reattach — killing them is a drain-and-stop decision
   *  (IMP-17's shutdown path), never a side effect of dispose() */
  dispose(): void
}

export function registerProcessOps(
  register: RegisterHostOp,
  deps: ProcessOpsDeps
): ProcessOpsHandle {
  const manager = new ProcessManager(deps)

  register('host.process.spawn', (payload, ctx) => manager.spawn(payload, ctx), {
    mutation: true,
    requiresLease: true
  })
  register('host.process.probe', (payload) => manager.probe(payload), {
    mutation: false,
    requiresLease: false
  })
  register('host.process.stop', (payload, ctx) => manager.stop(payload, ctx), {
    mutation: true,
    requiresLease: true
  })

  register(
    'host.terminal.attach',
    (payload, ctx) => {
      const p = asRec(payload)
      return manager.terminals.attach({
        terminalId: String(p.terminalId ?? ''),
        outputEpoch: str(p.outputEpoch),
        lastSequence: num(p.lastSequence),
        connectionId: ctx.connectionId
      })
    },
    // a subscription is host state — serialize it; but a view subscribe is
    // not a controller-leased effect (client proxies may attach)
    { mutation: true, requiresLease: false }
  )
  register(
    'host.terminal.input',
    (payload, ctx) => {
      deps.assertMutationAllowed?.('host.terminal.input', ctx)
      const p = asRec(payload)
      requirePayloadIncarnation(p, deps.hostIncarnation)
      return manager.terminals.input({
        terminalId: String(p.terminalId ?? ''),
        inputLeaseRevision: num(p.inputLeaseRevision),
        inputBytes: String(p.inputBytes ?? ''),
        expectedHostIncarnation: str(p.expectedHostIncarnation)
      })
    },
    { mutation: true, requiresLease: true }
  )
  register(
    'host.terminal.resize',
    (payload, ctx) => {
      deps.assertMutationAllowed?.('host.terminal.resize', ctx)
      const p = asRec(payload)
      requirePayloadIncarnation(p, deps.hostIncarnation)
      return manager.terminals.resize({
        terminalId: String(p.terminalId ?? ''),
        inputLeaseRevision: num(p.inputLeaseRevision),
        columns: Number(p.columns ?? p.cols ?? 0),
        rows: Number(p.rows ?? 0)
      })
    },
    { mutation: true, requiresLease: true }
  )
  register(
    'host.terminal.snapshot',
    (payload) => {
      const p = asRec(payload)
      return manager.terminals.snapshotOp({
        terminalId: String(p.terminalId ?? ''),
        expectedOutputEpoch: str(p.expectedOutputEpoch)
      })
    },
    { mutation: false, requiresLease: false }
  )
  register(
    'host.terminal.detach',
    (payload, ctx) =>
      manager.terminals.detach({
        subscriptionId: String(asRec(payload).subscriptionId ?? ''),
        connectionId: ctx.connectionId
      }),
    { mutation: true, requiresLease: false }
  )

  return {
    manager,
    dispose: () => manager.dispose()
  }
}
