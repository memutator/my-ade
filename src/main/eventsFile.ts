// Event ingest channel: harness hook scripts append one NDJSON line per event
// to a plain file; the main process tails it and forwards parsed events to the
// renderer. Chosen over a socket/HTTP endpoint: zero ports, survives app
// restarts (events are never lost while mahas is closed — they are drained on
// next launch), and needs no extra permissions.
//
// Two responsibilities live here, and they are ordered deliberately:
//
//   1. DURABLE RECORD — every line becomes an AgentEventRecord with a stable key
//      (file + byte offset) that keeps the *native identity* the harness
//      reported: nativeEvent, sessionId, parentSessionId, child, internalRun,
//      external, pane/tab. Nothing is deleted to express an exclusion.
//   2. ATTENTION PROJECTION — the renderer-facing event applies the policy the
//      transport recorded (subagent/internal runs demote to "other" and drop
//      the session claim) exactly as the previous transport did, so notification
//      and resume behavior is unchanged.
//
// Between those two steps sits an optional AgentEventIngestPort: when a control
// plane is attached, a record is handed to the daemon and the renderer sees it
// only after the daemon reports it durably ingested (see
// src/main/agentEventIngest.ts for the proposed operation contract).
//
// Kept free of electron imports so the whole pipeline can be exercised with
// plain node.

import fs from 'fs'
import os from 'os'
import path from 'path'
import type {
  AgentHookEvent,
  AgentHookIngestRecord
} from '../../packages/mahas-contracts/src/index.ts'
import { resolveMahasConfigDir } from '../../packages/mahas-runtime/src/rpc/endpoints.ts'

// the wire type is a contract now — main, preload and renderer re-export it
export type {
  AgentHookEvent,
  AgentHookIngestRecord
} from '../../packages/mahas-contracts/src/index.ts'

export function mahasConfigDir(home: string = os.homedir()): string {
  return resolveMahasConfigDir(process.env, home)
}

export function eventsFilePath(home?: string): string {
  return process.env.MAHAS_EVENTS_FILE || path.join(mahasConfigDir(home), 'agent-events.log')
}

export function appendEvent(ev: AgentHookEvent, file: string = eventsFilePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify({ v: 2, ...ev, ts: ev.ts ?? Date.now() }) + '\n')
}

// Renderer-side verdicts land here — third leg of the observability story
// (hook-raw.log → agent-events.log → notify-decisions.log), so "why did/didn't
// this ping" is answerable without reproducing.
export function decisionsFilePath(home?: string): string {
  return process.env.MAHAS_NOTIFY_LOG || path.join(mahasConfigDir(home), 'notify-decisions.log')
}

// Append one JSON line, keeping the file under the cap by rewriting the newest
// half when it overflows. Logging must never throw into a caller.
export function appendCapped(file: string, rec: unknown, cap = 512 * 1024): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      const size = fs.statSync(file).size
      if (size > cap) {
        const keep = Buffer.alloc(cap >> 1)
        const fd = fs.openSync(file, 'r')
        const n = fs.readSync(fd, keep, 0, keep.length, size - keep.length)
        fs.closeSync(fd)
        fs.writeFileSync(file, keep.subarray(0, n))
      }
    } catch {
      /* fresh file */
    }
    fs.appendFileSync(file, JSON.stringify(rec) + '\n')
  } catch {
    /* never break notifications on logging */
  }
}

/* ----------------------------------------------------------- durable record */

/**
 * One durable record inside the hook stream. The key carries the stream, the
 * generation and the byte offset: an offset alone collides after a rotation or
 * truncation, which would make a retry of a new record look like a replay of an
 * old one.
 */
export type AgentEventRecord = AgentHookIngestRecord & { file: string }

export function agentEventRecordKey(file: string, generation: number, offset: number): string {
  return file + '#' + generation + ':' + offset
}

/**
 * Apply the recorded notification policy for consumers that only care about
 * user-facing signals (the renderer's attention/resume path). Child and internal
 * runs keep their identity in the durable record; what changes here is only what
 * the user sees: the kind demotes to "other" and the event no longer claims a
 * resume record — the behavior the previous transport produced by deleting the
 * session id at the source.
 */
export function attentionProjection(ev: AgentHookEvent): AgentHookEvent {
  const policy = ev.policy ?? {}
  const childLike = ev.child === true || ev.internalRun === true
  if (!childLike && policy.demote !== true && policy.stripSession !== true) return ev
  const projected: AgentHookEvent = { ...ev }
  if (policy.demote === true || (childLike && ev.event !== 'other')) projected.event = 'other'
  if (policy.stripSession === true || ev.child === true || ev.internalRun === true) {
    delete projected.sessionId
  }
  return projected
}

/* ------------------------------------------------------------- ingest port */

export type AgentEventIngestAck =
  | { committed: true; recordKeys?: readonly string[] }
  | { committed: false; retryable?: boolean; reason: string }
  /** the daemon answered that it cannot take hook events yet (operation absent
   *  or contract rejected). This is NOT a commit: the gate keeps retrying and
   *  the renderer never sees the event without a durable ack. */
  | { committed: false; unavailable: true; reason: string }

export interface AgentEventIngestPort {
  readonly name: string
  /** Durably commit these records; resolve only when they survive a restart. */
  ingest(records: readonly AgentEventRecord[]): Promise<AgentEventIngestAck>
}

export interface AgentEventGateOptions {
  port: AgentEventIngestPort | null
  /** called for each record the daemon confirmed (or immediately without a port) */
  onCommitted: (record: AgentEventRecord) => void
  onError?: (error: unknown) => void
  /** a record that will never reach attention — it stays in the durable file */
  onDropped?: (record: AgentEventRecord, reason: string) => void
  maxQueue?: number
  batchSize?: number
  retryDelaysMs?: number[]
}

/**
 * Orders durable ingest before attention.
 *
 * Records commit strictly in order and *only* on a durable ack: a batch is
 * retried with backoff while the daemon is unreachable or answers that it cannot
 * take hook events yet, and nothing is forwarded to the attention path before
 * that ack. There is deliberately no "commit locally anyway" path — a
 * notification that the ledger never saw is worse than a late one. The queue is
 * bounded; overflow drops the *oldest* record with an explicit reason rather
 * than reordering or silently forgetting a newer one, and a non-retryable
 * rejection (the daemon refused the record) also drops only the attention
 * delivery — the line stays in the NDJSON file either way.
 *
 * Without a port the gate is in local-only mode (tests and any host without a
 * control plane): the NDJSON file is the durable record and records commit
 * immediately. The app always attaches a port (see src/main/hooks.ts).
 */
export class AgentEventGate {
  private readonly queue: AgentEventRecord[] = []
  private flushing = false
  private attempt = 0
  private timer: NodeJS.Timeout | null = null
  private readonly options: AgentEventGateOptions
  private readonly maxQueue: number
  private readonly batchSize: number
  private readonly retryDelays: number[]
  private dropped = 0
  private committedCount = 0

  constructor(options: AgentEventGateOptions) {
    this.options = options
    this.maxQueue = options.maxQueue ?? 512
    this.batchSize = options.batchSize ?? 32
    this.retryDelays = options.retryDelaysMs ?? [250, 500, 1000, 2000, 5000]
  }

  enqueue(record: AgentEventRecord): void {
    if (!this.options.port) {
      this.committedCount++
      this.options.onCommitted(record)
      return
    }
    this.queue.push(record)
    while (this.queue.length > this.maxQueue) {
      const droppedRecord = this.queue.shift()!
      this.dropped++
      this.options.onDropped?.(droppedRecord, 'queue-overflow')
    }
    void this.flush()
  }

  /** records waiting for a durable-ingest verdict */
  pending(): number {
    return this.queue.length
  }

  stats(): {
    pending: number
    committed: number
    dropped: number
    port: string | null
  } {
    return {
      pending: this.queue.length,
      committed: this.committedCount,
      dropped: this.dropped,
      port: this.options.port?.name ?? null
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, delayMs)
    this.timer.unref?.()
  }

  /** Overflow may remove an in-flight record while its call is pending. Only
   * remove the records still queued; newly enqueued records keep their slots. */
  private removeBatch(batch: readonly AgentEventRecord[]): AgentEventRecord[] {
    return batch.filter((record) => {
      const index = this.queue.indexOf(record)
      if (index < 0) return false
      this.queue.splice(index, 1)
      return true
    })
  }

  private async flush(): Promise<void> {
    if (this.flushing) return
    const port = this.options.port
    if (!port) return
    this.flushing = true
    try {
      while (this.queue.length) {
        const batch = this.queue.slice(0, this.batchSize)
        let ack: AgentEventIngestAck
        try {
          ack = await port.ingest(batch)
        } catch (error) {
          this.options.onError?.(error)
          ack = { committed: false, retryable: true, reason: String(error) }
        }
        if (ack.committed && ack.recordKeys) {
          const confirmed = new Set(ack.recordKeys)
          if (batch.some((record) => !confirmed.has(record.sourceRecordKey))) {
            ack = { committed: false, retryable: true, reason: 'incomplete record acknowledgement' }
          }
        }
        if (ack.committed) {
          this.attempt = 0
          for (const record of this.removeBatch(batch)) {
            this.committedCount++
            this.options.onCommitted(record)
          }
          continue
        }
        const failure = ack as {
          committed: false
          retryable?: boolean
          unavailable?: boolean
          reason: string
        }
        if (failure.retryable === false) {
          for (const record of this.removeBatch(batch)) {
            this.dropped++
            this.options.onDropped?.(record, failure.reason)
          }
          this.attempt = 0
          continue
        }
        const delay = this.retryDelays[Math.min(this.attempt, this.retryDelays.length - 1)] ?? 5000
        this.attempt++
        this.options.onError?.(
          new Error(
            (failure.unavailable === true
              ? 'event ingest unavailable: '
              : 'event ingest deferred: ') + failure.reason
          )
        )
        this.schedule(delay)
        return
      }
    } finally {
      this.flushing = false
    }
  }
}

/* ------------------------------------------------------------------ tailer */

const MAX_FILE_BYTES = 2 * 1024 * 1024

// Notifying events dedupe on provider+session+cwd+kind+message: compat-loaded
// hooks (grok/devin also read ~/.claude/settings.json) re-emit the identical
// payload ~0 ms apart, while genuinely distinct turns/prompts carry different
// messages and must not collapse. Windows only need to span re-emit latency —
// two real turns CAN legitimately end within seconds of each other.
const DEDUPE_MS: Record<string, number> = {
  'turn-complete': 10_000,
  'needs-input': 10_000,
  error: 10_000
}

export interface EventLogTailerOptions {
  /** cursor file; `null` disables replay and persistence */
  cursorFile?: string | null
  /** resume from the stored cursor (default true) */
  replay?: boolean
}

interface TailerCursor {
  path: string
  inode: number
  generation: number
  offset: number
  savedAt: number
}

export class EventLogTailer {
  private readonly file: string
  private readonly onEvent: (ev: AgentHookEvent) => void
  private readonly onError?: (e: unknown) => void
  private readonly onRecord?: (record: AgentEventRecord) => void
  private readonly cursorFile: string | null
  private readonly replay: boolean
  private generation = 1
  private inode = 0
  private cursorDirty = false
  private cursorWrittenAt = 0
  private offset = 0
  private pending = ''
  private consumed = 0
  private watcher: fs.FSWatcher | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private recent = new Map<string, number>()

  constructor(
    file: string,
    onEvent: (ev: AgentHookEvent) => void,
    onError?: (e: unknown) => void,
    /** when set, records go here instead of straight to onEvent (ingest gate) */
    onRecord?: (record: AgentEventRecord) => void,
    options: EventLogTailerOptions = {}
  ) {
    this.file = file
    this.onEvent = onEvent
    this.onError = onError
    this.onRecord = onRecord
    this.cursorFile =
      options.cursorFile === undefined
        ? path.join(mahasConfigDir(), 'hook-tail-cursor.json')
        : options.cursorFile
    this.replay = options.replay !== false
  }

  start(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '')
      const stat = fs.statSync(this.file)
      const size = stat.size
      this.inode = stat.ino
      const cursor = this.readCursor()
      if (
        this.replay &&
        cursor &&
        cursor.path === this.file &&
        cursor.inode === stat.ino &&
        size >= cursor.offset
      ) {
        // resume where this instance left off: events written while mahas was
        // closed (crash, restart) are delivered instead of being skipped
        this.offset = cursor.offset
        this.consumed = cursor.offset
        this.generation = cursor.generation
      } else {
        // no usable cursor (first run, rotated or replaced stream): start at the
        // end so an upgrade never replays the whole history as fresh signals,
        // and keep the generation monotonic so keys stay unique
        this.offset = size
        this.consumed = size
        this.generation = cursor && cursor.path === this.file ? cursor.generation + 1 : 1
      }
      if (size > MAX_FILE_BYTES) {
        fs.truncateSync(this.file, 0)
        this.offset = 0
        this.consumed = 0
        this.generation += 1
      }
      this.writeCursor(true)
    } catch (e) {
      this.onError?.(e)
      return
    }
    try {
      this.watcher = fs.watch(this.file, () => this.drain())
      this.watcher.on('error', (e) => {
        this.onError?.(e)
        this.fallbackPoll()
      })
    } catch (e) {
      // inotify exhausted etc. — fall back to stat polling
      this.onError?.(e)
      this.fallbackPoll()
    }
    // a resumed cursor has a backlog to read right now — waiting for the next
    // file change would delay it until the harness happens to write again
    this.drain()
  }

  private fallbackPoll(): void {
    if (this.pollTimer) return
    try {
      this.watcher?.close()
    } catch {
      /* noop */
    }
    this.watcher = null
    this.pollTimer = setInterval(() => this.drain(), 1000)
    this.pollTimer.unref?.()
  }

  private readCursor(): TailerCursor | null {
    if (!this.cursorFile) return null
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cursorFile, 'utf8')) as TailerCursor
      if (
        !parsed ||
        typeof parsed.path !== 'string' ||
        !Number.isFinite(parsed.offset) ||
        !Number.isFinite(parsed.generation)
      ) {
        return null
      }
      return parsed
    } catch {
      return null
    }
  }

  /** Persist the position so a crash replays at most the events since the last save. */
  private writeCursor(force = false): void {
    if (!this.cursorFile) return
    const now = Date.now()
    if (!force && now - this.cursorWrittenAt < 250) return
    this.cursorWrittenAt = now
    this.cursorDirty = false
    try {
      fs.mkdirSync(path.dirname(this.cursorFile), { recursive: true })
      const tmp = this.cursorFile + '.tmp'
      const cursor: TailerCursor = {
        path: this.file,
        inode: this.inode,
        generation: this.generation,
        offset: this.offset,
        savedAt: now
      }
      fs.writeFileSync(tmp, JSON.stringify(cursor) + '\n')
      fs.renameSync(tmp, this.cursorFile)
    } catch (e) {
      this.onError?.(e)
    }
  }

  private drain(): void {
    let st: fs.Stats
    try {
      st = fs.statSync(this.file)
    } catch {
      return
    }
    if (st.size < this.offset || (this.inode !== 0 && st.ino !== this.inode)) {
      // truncated, rotated or replaced: offsets restart, so the generation moves
      this.offset = 0
      this.consumed = 0
      this.pending = ''
      this.inode = st.ino
      this.generation += 1
    }
    if (st.size === this.offset) {
      if (this.cursorDirty) this.writeCursor()
      return
    }
    const fd = fs.openSync(this.file, 'r')
    try {
      const len = st.size - this.offset
      const buf = Buffer.alloc(len)
      const n = fs.readSync(fd, buf, 0, len, this.offset)
      this.offset += n
      this.consume(buf.subarray(0, n).toString('utf8'))
      this.cursorDirty = true
      this.writeCursor()
    } catch (e) {
      this.onError?.(e)
    } finally {
      fs.closeSync(fd)
    }
  }

  private consume(chunk: string): void {
    const text = this.pending + chunk
    const lines = text.split('\n')
    this.pending = lines.pop() ?? ''
    for (const line of lines) {
      const offset = this.consumed
      this.consumed += Buffer.byteLength(line) + 1
      this.handleLine(line, offset)
    }
  }

  private handleLine(line: string, offset: number): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let ev: AgentHookEvent
    try {
      ev = JSON.parse(trimmed)
    } catch {
      return
    }
    if (!ev || typeof ev.provider !== 'string' || typeof ev.event !== 'string') return
    // hooks are installed globally, so agents launched in other terminals (or
    // another mahas instance) also append here — the renderer drops everything
    // that is not ours (foreign sessions never notify)
    ev.ours = !!process.env.MAHAS_SESSION && ev.mahasSession === process.env.MAHAS_SESSION
    if (ev.external === undefined) ev.external = !ev.mahasSession
    const ts = typeof ev.ts === 'number' ? ev.ts : Date.now()
    const window = DEDUPE_MS[ev.event]
    if (window) {
      const key = [ev.provider, ev.sessionId || '', ev.cwd || '', ev.event, ev.message || ''].join(
        '|'
      )
      const last = this.recent.get(key)
      if (last !== undefined && ts - last < window) return
      this.recent.set(key, ts)
      if (this.recent.size > 500) {
        const cutoff = ts - window
        for (const [k, t] of this.recent) if (t < cutoff) this.recent.delete(k)
      }
    }
    const record: AgentEventRecord = {
      sourceRecordKey: agentEventRecordKey(this.file, this.generation, offset),
      file: this.file,
      offset,
      generation: this.generation,
      raw: trimmed,
      event: ev
    }
    ev.sourceRecordKey = record.sourceRecordKey
    if (this.onRecord) this.onRecord(record)
    else this.onEvent(ev)
  }

  stop(): void {
    this.writeCursor(true)
    try {
      this.watcher?.close()
    } catch {
      /* noop */
    }
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.watcher = null
    this.pollTimer = null
  }
}
