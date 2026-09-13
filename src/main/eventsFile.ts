// Event ingest channel: harness hook scripts append one NDJSON line per event
// to a plain file; the main process tails it and forwards parsed events to the
// renderer. Chosen over a socket/HTTP endpoint: zero ports, survives app
// restarts (events are never lost while ade is closed — they are drained on
// next launch), and needs no extra permissions.
//
// Kept free of electron imports so the whole pipeline can be exercised with
// plain node (see tests in the commit).

import fs from 'fs'
import os from 'os'
import path from 'path'

export interface AgentHookEvent {
  v?: number
  provider: string
  event: string
  cwd?: string
  sessionId?: string
  message?: string
  adeSession?: string
  /** set by the tailer: true when the event carries this instance's session */
  ours?: boolean
  /** session-rename payload: the new session name */
  name?: string
  ts?: number
}

export function adeConfigDir(home: string = os.homedir()): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  return process.env.ADE_CONFIG_DIR || path.join(base, 'ade')
}

export function eventsFilePath(home?: string): string {
  return process.env.ADE_EVENTS_FILE || path.join(adeConfigDir(home), 'agent-events.log')
}

export function appendEvent(ev: AgentHookEvent, file: string = eventsFilePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify({ v: 1, ...ev, ts: ev.ts ?? Date.now() }) + '\n')
}

const MAX_FILE_BYTES = 2 * 1024 * 1024

// Notifying events dedupe on provider+session+cwd+kind+message: compat-loaded
// hooks (grok/devin also read ~/.claude/settings.json) re-emit the identical
// payload ~0 ms apart, while genuinely distinct turns/prompts carry different
// messages and must not collapse. turn-complete keeps a wide window — a turn
// can never legitimately end twice in 45 s; needs-input/error stay short so a
// re-asked permission or a retried failure still surfaces.
const DEDUPE_MS: Record<string, number> = {
  'turn-complete': 45_000,
  'needs-input': 10_000,
  error: 10_000
}

export class EventLogTailer {
  private offset = 0
  private pending = ''
  private watcher: fs.FSWatcher | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private recent = new Map<string, number>()

  constructor(
    private file: string,
    private onEvent: (ev: AgentHookEvent) => void,
    private onError?: (e: unknown) => void
  ) {}

  start(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '')
      const size = fs.statSync(this.file).size
      this.offset = size // only new events; history is not replayed
      if (size > MAX_FILE_BYTES) {
        fs.truncateSync(this.file, 0)
        this.offset = 0
      }
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

  private drain(): void {
    let st: fs.Stats
    try {
      st = fs.statSync(this.file)
    } catch {
      return
    }
    if (st.size < this.offset) {
      this.offset = 0 // truncated/rotated
      this.pending = ''
    }
    if (st.size === this.offset) return
    const fd = fs.openSync(this.file, 'r')
    try {
      const len = st.size - this.offset
      const buf = Buffer.alloc(len)
      const n = fs.readSync(fd, buf, 0, len, this.offset)
      this.offset += n
      this.consume(buf.subarray(0, n).toString('utf8'))
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
    for (const line of lines) this.handleLine(line)
  }

  private handleLine(line: string): void {
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
    // another ade instance) also append here — the renderer drops everything
    // that isn't `ours` (foreign sessions never notify)
    ev.ours = !!process.env.ADE_SESSION && ev.adeSession === process.env.ADE_SESSION
    const ts = typeof ev.ts === 'number' ? ev.ts : Date.now()
    const window = DEDUPE_MS[ev.event]
    if (window) {
      const key = `${ev.provider}|${ev.sessionId || ''}|${ev.cwd || ''}|${ev.event}|${ev.message || ''}`
      const last = this.recent.get(key)
      if (last !== undefined && ts - last < window) return
      this.recent.set(key, ts)
      if (this.recent.size > 500) {
        const cutoff = ts - window
        for (const [k, t] of this.recent) if (t < cutoff) this.recent.delete(k)
      }
    }
    this.onEvent(ev)
  }

  stop(): void {
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
