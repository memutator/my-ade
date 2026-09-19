// mahas-execution-host — terminal output stream, bounded buffer, screen
// model, and the host.terminal.* op bodies (IMP-18).
//
// Contract (spec/contracts/execution-host.md, spec/execution-lifecycle.md
// §4):
//   * output has a per-terminal sequence and an outputEpoch; the retained
//     buffer is BOUNDED — overflow preserves a truncation boundary
//     (droppedThrough) instead of lying about completeness
//   * attach is a VIEW subscription only — never spawns anything; a
//     client whose lastSequence is still retained gets a tail replay,
//     otherwise a snapshot + explicit gap
//   * input/resize require the current InputLease — the lease proof is
//     verified through deps.verifyInputLease (IMP-17's lease machinery);
//     when no verifier is wired the op still runs but its receipt says
//     leaseVerified:false — never a silent claim of enforcement
//   * "bytes admitted" is a pipe receipt, NOT task/turn acceptance
//   * control receipts never queue behind output: this module only keeps
//     a bounded in-memory ring and emits discrete push events, so output
//     volume cannot starve control ops on a buffer

import type { SpawnedChild } from './pty-manager.ts'
import { HostOpError } from './lease.ts'

// ---------------------------------------------------------------------------
// wire types (payload → result shapes registered against IMP-17's dispatcher)
// ---------------------------------------------------------------------------

export interface TerminalSnapshot {
  terminalId: string
  outputEpoch: string
  lastSequence: number
  /** bounded screen view — a vt-subset emulation, see VtScreen */
  screen: {
    cols: number
    rows: number
    cursorX: number
    cursorY: number
    lines: string[]
    model: 'vt-subset'
  }
  /** retention window honestly reported */
  retained: { firstSequence: number; lastSequence: number; droppedThrough: number; bytes: number }
  truncated: boolean
  state: 'open' | 'exited'
}

export interface OutputChunkView {
  sequence: number
  /** base64 payload bytes */
  d: string
}

export interface AttachResult {
  subscriptionId: string
  terminalId: string
  outputEpoch: string
  lastSequence: number
  snapshot: TerminalSnapshot
  /** retained chunks after the caller's cursor (may be empty) */
  replay: OutputChunkView[]
  /** set when the caller's cursor predates the retention floor */
  gap?: { droppedThrough: number }
  /** 'push' when the transport wired deps.push; 'snapshot-only' otherwise */
  stream: 'push' | 'snapshot-only'
}

export interface TerminalStreamEvent {
  t: 'terminal.data' | 'terminal.exit' | 'terminal.resized'
  subscriptionId: string
  terminalId: string
  /** the attach-time connection — HostService.pushEvent's route key */
  connectionId?: string
  sequence?: number
  d?: string
  cols?: number
  rows?: number
  exitCode?: number
  signal?: string
}

export interface TerminalRuntime {
  /** the spawned child this terminal wraps (pty kind only) */
  child: SpawnedChild
  cols: number
  rows: number
}

export interface TerminalStreamDeps {
  now?: () => number
  /** IMP-17 wires this to push stream events to the requesting connection */
  push?: (event: TerminalStreamEvent) => void
  /** IMP-17's authoritative InputLease check. Absent → leaseVerified:false */
  verifyInputLease?: (terminalId: string, inputLeaseRevision: number) => boolean
  /** persistence callback — process-manager mirrors rows into host_terminals */
  persist?: (
    terminalId: string,
    patch: { outputEpoch?: string; lastSequence?: number; state?: string }
  ) => void
  /** resolve a terminalId to its live child + size */
  resolve: (terminalId: string) => TerminalRuntime | undefined
  maxBufferBytes?: number
  maxBufferChunks?: number
}

// ---------------------------------------------------------------------------
// VtScreen — a vt-subset screen emulator.
//
// Real grid/cursor/scroll-region handling for the common escape vocabulary
// (CUP/ED/EL/IL/DL/ICH/DCH/DECSTBM/RI/NEL/IND/RIS, DECAWM, alt-buffer,
// CR/LF/BS/TAB, UTF-8). SGR attrs and charsets are parsed and intentionally
// dropped — the snapshot ships TEXT ONLY, which is what C-HOST's
// "screen/history" means here. Unknown sequences are skipped, never
// guessed. Consumers needing byte-exact truth replay the chunk stream.
// ---------------------------------------------------------------------------

// parser states — plain consts, not enum: `node file.ts` type-stripping
// (this package's runtime mode) rejects enum syntax
const P = { Ground: 0, Esc: 1, Csi: 2, Osc: 3, OscEsc: 4 } as const
type P = (typeof P)[keyof typeof P]

export class VtScreen {
  cols: number
  rows: number
  private grid: string[][]
  private cx = 0
  private cy = 0
  private scrollTop = 0
  private scrollBottom: number
  private state: P = P.Ground
  private csiBuf = ''
  private decawm = true
  private saved: { x: number; y: number } = { x: 0, y: 0 }
  private decoder = new TextDecoder('utf8', { fatal: false })

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, cols)
    this.rows = Math.max(1, rows)
    this.scrollBottom = this.rows - 1
    this.grid = Array.from({ length: this.rows }, () => new Array<string>(this.cols).fill(' '))
  }

  feed(bytes: Uint8Array): void {
    const text = this.decoder.decode(bytes, { stream: true })
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      const code = text.charCodeAt(i)
      switch (this.state) {
        case P.Ground:
          if (code === 0x1b) this.state = P.Esc
          else this.putControlOrChar(ch, code)
          break
        case P.Esc:
          this.state = P.Ground
          if (ch === '[') {
            this.csiBuf = ''
            this.state = P.Csi
          } else if (ch === ']') {
            this.state = P.Osc
          } else if (ch === 'c') this.reset()
          else if (ch === 'D') this.index()
          else if (ch === 'E') {
            this.cx = 0
            this.index()
          } else if (ch === 'M') this.reverseIndex()
          else if (ch === '7') this.saved = { x: this.cx, y: this.cy }
          else if (ch === '8') {
            this.cx = this.saved.x
            this.cy = this.saved.y
          }
          // ( ) # % = > and friends: charset/keypad — parsed, dropped
          break
        case P.Csi:
          if (code >= 0x40 && code <= 0x7e) {
            this.dispatchCsi(ch)
            this.state = P.Ground
          } else {
            this.csiBuf += ch
            if (this.csiBuf.length > 64) this.state = P.Ground // runaway — drop
          }
          break
        case P.Osc:
          if (code === 0x07) this.state = P.Ground
          else if (code === 0x1b) this.state = P.OscEsc
          break
        case P.OscEsc:
          this.state = ch === '\\' ? P.Ground : P.Osc
          break
      }
    }
  }

  private putControlOrChar(ch: string, code: number): void {
    if (ch === '\r') {
      this.cx = 0
      return
    }
    if (ch === '\n' || code === 0x0b || code === 0x0c) {
      this.index()
      return
    }
    if (code === 0x08) {
      this.cx = Math.max(0, this.cx - 1)
      return
    }
    if (ch === '\t') {
      this.cx = Math.min(this.cols - 1, (Math.floor(this.cx / 8) + 1) * 8)
      return
    }
    if (code < 0x20 || code === 0x7f) return // C0/C1 controls — skipped
    const w = code >= 0x1100 && wideChar(code) ? 2 : 1
    if (this.cx + w > this.cols) {
      if (this.decawm) {
        this.cx = 0
        this.index()
      } else {
        this.cx = this.cols - 1
      }
    }
    this.grid[this.cy][this.cx] = ch
    if (w === 2 && this.cx + 1 < this.cols) this.grid[this.cy][this.cx + 1] = ''
    this.cx += w
  }

  private index(): void {
    if (this.cy === this.scrollBottom) {
      const g = this.grid
      for (let r = this.scrollTop; r < this.scrollBottom; r++) g[r] = g[r + 1]
      g[this.scrollBottom] = new Array<string>(this.cols).fill(' ')
    } else if (this.cy < this.rows - 1) {
      this.cy++
    }
  }

  private reverseIndex(): void {
    if (this.cy === this.scrollTop) {
      const g = this.grid
      for (let r = this.scrollBottom; r > this.scrollTop; r--) g[r] = g[r - 1]
      g[this.scrollTop] = new Array<string>(this.cols).fill(' ')
    } else if (this.cy > 0) {
      this.cy--
    }
  }

  private csiParams(def: number[]): number[] {
    const body = this.csiBuf.replace(/^[^0-9;]*/, '')
    if (body === '') return def
    return body.split(';').map((s, i) => (s === '' ? (def[i] ?? 0) : Number(s)))
  }

  private dispatchCsi(final: string): void {
    const p = this.csiParams([0])
    const n = (v: number | undefined, d: number): number => (v === undefined || v === 0 ? d : v)
    switch (final) {
      case 'H':
      case 'f':
        this.cy = clamp(n(p[0], 1) - 1, 0, this.rows - 1)
        this.cx = clamp(n(p[1], 1) - 1, 0, this.cols - 1)
        break
      case 'A':
        this.cy = clamp(
          this.cy - n(p[0], 1),
          this.scrollTop === 0 ? 0 : this.scrollTop,
          this.rows - 1
        )
        break
      case 'B':
        this.cy = clamp(this.cy + n(p[0], 1), 0, this.scrollBottom)
        break
      case 'C':
        this.cx = clamp(this.cx + n(p[0], 1), 0, this.cols - 1)
        break
      case 'D':
        this.cx = clamp(this.cx - n(p[0], 1), 0, this.cols - 1)
        break
      case 'E':
        this.cy = clamp(this.cy + n(p[0], 1), 0, this.scrollBottom)
        this.cx = 0
        break
      case 'F':
        this.cy = clamp(this.cy - n(p[0], 1), 0, this.rows - 1)
        this.cx = 0
        break
      case 'G':
      case '`':
        this.cx = clamp(n(p[0], 1) - 1, 0, this.cols - 1)
        break
      case 'd':
        this.cy = clamp(n(p[0], 1) - 1, 0, this.rows - 1)
        break
      case 'J': {
        const mode = p[0] ?? 0
        if (mode === 0) {
          this.clearRange(this.cy, this.cx, this.rows - 1, this.cols - 1)
        } else if (mode === 1) {
          this.clearRange(0, 0, this.cy, this.cx)
        } else if (mode === 2 || mode === 3) {
          this.clearRange(0, 0, this.rows - 1, this.cols - 1)
        }
        break
      }
      case 'K': {
        const mode = p[0] ?? 0
        if (mode === 0) this.clearRange(this.cy, this.cx, this.cy, this.cols - 1)
        else if (mode === 1) this.clearRange(this.cy, 0, this.cy, this.cx)
        else if (mode === 2) this.clearRange(this.cy, 0, this.cy, this.cols - 1)
        break
      }
      case 'L': {
        const count = n(p[0], 1)
        for (let i = 0; i < count; i++) {
          this.grid.splice(this.cy, 1)
          this.grid.splice(this.scrollBottom + 1, 0, new Array<string>(this.cols).fill(' '))
        }
        break
      }
      case 'M': {
        const count = n(p[0], 1)
        for (let i = 0; i < count; i++) {
          this.grid.splice(this.scrollBottom + 1, 1)
          this.grid.splice(this.cy, 0, new Array<string>(this.cols).fill(' '))
        }
        break
      }
      case '@': {
        const count = n(p[0], 1)
        const row = this.grid[this.cy]
        row.splice(this.cx, 0, ...new Array<string>(count).fill(' '))
        row.length = this.cols
        break
      }
      case 'P': {
        const count = n(p[0], 1)
        const row = this.grid[this.cy]
        row.splice(this.cx, count)
        row.push(...new Array<string>(Math.min(count, this.cols - row.length)).fill(' '))
        row.length = this.cols
        break
      }
      case 'X': {
        const count = n(p[0], 1)
        for (let i = 0; i < count && this.cx + i < this.cols; i++)
          this.grid[this.cy][this.cx + i] = ' '
        break
      }
      case 'r':
        this.scrollTop = clamp(n(p[0], 1) - 1, 0, this.rows - 1)
        this.scrollBottom = clamp(n(p[1], this.rows) - 1, 0, this.rows - 1)
        if (this.scrollBottom <= this.scrollTop) {
          this.scrollTop = 0
          this.scrollBottom = this.rows - 1
        }
        this.cx = 0
        this.cy = 0
        break
      case 'h':
      case 'l': {
        const enable = final === 'h'
        const dec = this.csiBuf.startsWith('?')
        const vals = this.csiBuf.replace(/^\?/, '').split(';')
        for (const v of vals) {
          const mode = Number(v)
          if (dec && mode === 7) this.decawm = enable
          if (dec && (mode === 1049 || mode === 1047 || mode === 47)) {
            // alternate buffer: this subset keeps ONE grid — entering the
            // alt buffer clears it (matches the common fullscreen-app case)
            this.clearRange(0, 0, this.rows - 1, this.cols - 1)
            this.cx = 0
            this.cy = 0
          }
        }
        break
      }
      // 'm' SGR / 's' save / 'u' restore / everything else: parsed, dropped
      case 's':
        this.saved = { x: this.cx, y: this.cy }
        break
      case 'u':
        this.cx = this.saved.x
        this.cy = this.saved.y
        break
    }
  }

  private clearRange(r0: number, c0: number, r1: number, c1: number): void {
    for (let r = r0; r <= r1; r++) {
      const row = this.grid[r]
      const from = r === r0 ? c0 : 0
      const to = r === r1 ? c1 : this.cols - 1
      for (let c = from; c <= to; c++) row[c] = ' '
    }
  }

  private reset(): void {
    this.grid = Array.from({ length: this.rows }, () => new Array<string>(this.cols).fill(' '))
    this.cx = 0
    this.cy = 0
    this.scrollTop = 0
    this.scrollBottom = this.rows - 1
    this.decawm = true
  }

  resize(cols: number, rows: number): void {
    cols = Math.max(1, cols)
    rows = Math.max(1, rows)
    if (cols === this.cols && rows === this.rows) return
    const next = Array.from({ length: rows }, (_, r) => {
      const row = new Array<string>(cols).fill(' ')
      if (r < this.rows) {
        const src = this.grid[r]
        for (let c = 0; c < Math.min(cols, this.cols); c++) row[c] = src[c]
      }
      return row
    })
    this.cols = cols
    this.rows = rows
    this.grid = next
    this.cx = clamp(this.cx, 0, cols - 1)
    this.cy = clamp(this.cy, 0, rows - 1)
    this.scrollTop = 0
    this.scrollBottom = rows - 1
  }

  snapshotLines(): { lines: string[]; cursorX: number; cursorY: number } {
    return {
      lines: this.grid.map((row) => row.join('').replace(/\s+$/, '')),
      cursorX: this.cx,
      cursorY: this.cy
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** minimal East-Asian wide check — enough for grid width honesty */
function wideChar(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

// ---------------------------------------------------------------------------
// TerminalBuffer — the bounded, sequenced output ring
// ---------------------------------------------------------------------------

interface OutputChunk {
  seq: number
  bytes: Uint8Array
  at: number
}

export class TerminalBuffer {
  /** incremented when the buffer identity resets (currently: never mid-life) */
  outputEpoch: string
  lastSequence = 0
  /** every chunk with seq ≤ droppedThrough is gone — the truncation boundary */
  droppedThrough = 0
  private chunks: OutputChunk[] = []
  private bytes = 0
  private readonly maxBytes: number
  private readonly maxChunks: number

  constructor(outputEpoch: string, opts?: { maxBytes?: number; maxChunks?: number }) {
    this.outputEpoch = outputEpoch
    this.maxBytes = opts?.maxBytes ?? 512 * 1024
    this.maxChunks = opts?.maxChunks ?? 8192
  }

  get firstSequence(): number {
    return this.chunks.length ? this.chunks[0].seq : this.lastSequence + 1
  }

  get retainedBytes(): number {
    return this.bytes
  }

  append(bytes: Uint8Array, at: number): OutputChunk {
    const chunk: OutputChunk = { seq: ++this.lastSequence, bytes, at }
    this.chunks.push(chunk)
    this.bytes += bytes.byteLength
    while (
      this.chunks.length > this.maxChunks ||
      (this.bytes > this.maxBytes && this.chunks.length > 1)
    ) {
      const dropped = this.chunks.shift()!
      this.bytes -= dropped.bytes.byteLength
      this.droppedThrough = dropped.seq
    }
    return chunk
  }

  /** chunks with seq > cursor; caller checks the gap boundary first */
  after(cursor: number): OutputChunk[] {
    return this.chunks.filter((c) => c.seq > cursor)
  }
}

// ---------------------------------------------------------------------------
// TerminalRegistry — live terminals, subscriptions, the five op bodies
// ---------------------------------------------------------------------------

export interface ManagedTerminal {
  terminalId: string
  spawnNonce: string
  ptyId: string
  buffer: TerminalBuffer
  screen: VtScreen
  state: 'open' | 'exited'
  sizeRevision: number
  /** authoritative lease learned via setInputLease when deps lacks a verifier */
  inputLeaseRevision?: number
  inputLeasePrincipal?: string
  createdAt: number
  exitedAt?: number
  exit?: { exitCode?: number; signal?: string }
}

interface Subscription {
  id: string
  terminalId: string
  connectionId?: string
  createdAt: number
}

export class TerminalRegistry {
  private terminals = new Map<string, ManagedTerminal>()
  private subs = new Map<string, Subscription>()
  private counter = 0

  private readonly deps: TerminalStreamDeps

  constructor(deps: TerminalStreamDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** push must never let a dead connection take the output path down */
  private emit(event: TerminalStreamEvent): void {
    try {
      this.deps.push?.(event)
    } catch {
      /* subscriber cleanup is the transport's concern */
    }
  }

  /** called by process-manager when a pty child is spawned */
  register(
    terminalId: string,
    spawnNonce: string,
    ptyId: string,
    cols: number,
    rows: number
  ): ManagedTerminal {
    const t: ManagedTerminal = {
      terminalId,
      spawnNonce,
      ptyId,
      buffer: new TerminalBuffer(randomSeq(), {
        maxBytes: this.deps.maxBufferBytes,
        maxChunks: this.deps.maxBufferChunks
      }),
      screen: new VtScreen(cols, rows),
      state: 'open',
      sizeRevision: 1,
      createdAt: this.now()
    }
    this.terminals.set(terminalId, t)
    return t
  }

  /** feed one output chunk — sequence, bound, screen, persist, push */
  feed(terminalId: string, bytes: Uint8Array): void {
    const t = this.terminals.get(terminalId)
    if (!t || t.state !== 'open') return
    const chunk = t.buffer.append(bytes, this.now())
    t.screen.feed(bytes)
    // persist lazily — the DB row is a cursor mirror, not the buffer itself
    if (chunk.seq % 64 === 0) this.deps.persist?.(terminalId, { lastSequence: chunk.seq })
    const d = Buffer.from(bytes).toString('base64')
    for (const s of this.subs.values()) {
      if (s.terminalId === terminalId) {
        this.emit({
          t: 'terminal.data',
          subscriptionId: s.id,
          terminalId,
          connectionId: s.connectionId,
          sequence: chunk.seq,
          d
        })
      }
    }
  }

  markExited(terminalId: string, exit: { exitCode?: number; signal?: string }): void {
    const t = this.terminals.get(terminalId)
    if (!t || t.state === 'exited') return
    t.state = 'exited'
    t.exitedAt = this.now()
    t.exit = exit
    this.deps.persist?.(terminalId, { lastSequence: t.buffer.lastSequence, state: 'exited' })
    for (const s of this.subs.values()) {
      if (s.terminalId === terminalId) {
        this.emit({
          t: 'terminal.exit',
          subscriptionId: s.id,
          terminalId,
          connectionId: s.connectionId,
          exitCode: exit.exitCode,
          signal: exit.signal
        })
      }
    }
  }

  get(terminalId: string): ManagedTerminal | undefined {
    return this.terminals.get(terminalId)
  }

  /** authoritative lease sync port — IMP-17/23 pushes lease state here */
  setInputLease(terminalId: string, revision: number, principalId?: string): void {
    const t = this.terminals.get(terminalId)
    if (!t) return
    t.inputLeaseRevision = revision
    t.inputLeasePrincipal = principalId
  }

  private snapshot(t: ManagedTerminal): TerminalSnapshot {
    const s = t.screen.snapshotLines()
    return {
      terminalId: t.terminalId,
      outputEpoch: t.buffer.outputEpoch,
      lastSequence: t.buffer.lastSequence,
      screen: {
        cols: t.screen.cols,
        rows: t.screen.rows,
        cursorX: s.cursorX,
        cursorY: s.cursorY,
        lines: s.lines,
        model: 'vt-subset'
      },
      retained: {
        firstSequence: t.buffer.firstSequence,
        lastSequence: t.buffer.lastSequence,
        droppedThrough: t.buffer.droppedThrough,
        bytes: t.buffer.retainedBytes
      },
      truncated: t.buffer.droppedThrough > 0,
      state: t.state
    }
  }

  // -- the five op bodies ---------------------------------------------------

  /** host.terminal.attach — view subscription only; gap is explicit */
  attach(payload: {
    terminalId: string
    outputEpoch?: string
    lastSequence?: number
    connectionId?: string
  }): AttachResult {
    const t = this.terminals.get(payload.terminalId)
    if (!t) throw new HostOpError('NOT_FOUND', `unknown terminal ${payload.terminalId}`)
    const epochMatches =
      payload.outputEpoch === undefined || payload.outputEpoch === t.buffer.outputEpoch
    const cursor =
      epochMatches && typeof payload.lastSequence === 'number' ? payload.lastSequence : undefined
    let replay: OutputChunk[] = []
    let gap: { droppedThrough: number } | undefined
    if (cursor !== undefined) {
      if (cursor >= t.buffer.droppedThrough) {
        replay = t.buffer.after(cursor)
      } else {
        // caller's cursor predates the retention floor — snapshot + honest gap
        gap = { droppedThrough: t.buffer.droppedThrough }
        replay = t.buffer.after(t.buffer.droppedThrough)
      }
    } else {
      replay = t.buffer.after(t.buffer.droppedThrough)
      if (!epochMatches) gap = { droppedThrough: t.buffer.droppedThrough }
    }
    const sub: Subscription = {
      id: `sub-${++this.counter}-${Math.random().toString(36).slice(2, 10)}`,
      terminalId: t.terminalId,
      connectionId: payload.connectionId,
      createdAt: this.now()
    }
    this.subs.set(sub.id, sub)
    return {
      subscriptionId: sub.id,
      terminalId: t.terminalId,
      outputEpoch: t.buffer.outputEpoch,
      lastSequence: t.buffer.lastSequence,
      snapshot: this.snapshot(t),
      replay: replay.map((c) => ({ sequence: c.seq, d: Buffer.from(c.bytes).toString('base64') })),
      ...(gap ? { gap } : {}),
      stream: this.deps.push ? 'push' : 'snapshot-only'
    }
  }

  /** host.terminal.input — bytes admitted, never a processing receipt */
  input(payload: {
    terminalId: string
    inputLeaseRevision?: number
    inputBytes: string
    expectedHostIncarnation?: string
  }): { bytesAdmitted: number; leaseVerified: boolean; lastSequence: number } {
    const t = this.terminals.get(payload.terminalId)
    if (!t) throw new HostOpError('NOT_FOUND', `unknown terminal ${payload.terminalId}`)
    if (t.state !== 'open') {
      throw new HostOpError('INVALID_TRANSITION', 'terminal exited — input refused', 'reconcile')
    }
    const rt = this.deps.resolve(payload.terminalId)
    if (!rt) {
      throw new HostOpError(
        'PROCESS_UNVERIFIABLE',
        'terminal has no live process handle in this host incarnation',
        'reconcile'
      )
    }
    const leaseVerified = this.checkLease(payload.terminalId, t, payload.inputLeaseRevision)
    const bytes = Buffer.from(payload.inputBytes, 'base64')
    try {
      rt.child.write(new Uint8Array(bytes))
    } catch (e) {
      // a write that throws cannot be confirmed delivered or undelivered
      throw new HostOpError(
        'PROCESS_UNVERIFIABLE',
        `input write failed: ${String((e as Error).message ?? e)}`,
        'reconcile'
      )
    }
    return { bytesAdmitted: bytes.byteLength, leaseVerified, lastSequence: t.buffer.lastSequence }
  }

  /** host.terminal.resize — current size owner only, pty only */
  resize(payload: {
    terminalId: string
    inputLeaseRevision?: number
    columns: number
    rows: number
  }): { sizeRevision: number; columns: number; rows: number; leaseVerified: boolean } {
    const t = this.terminals.get(payload.terminalId)
    if (!t) throw new HostOpError('NOT_FOUND', `unknown terminal ${payload.terminalId}`)
    const rt = this.deps.resolve(payload.terminalId)
    if (!rt || rt.child.kind !== 'pty') {
      throw new HostOpError('UNAVAILABLE_OPERATION', 'resize requires a pty-backed terminal')
    }
    if (t.state !== 'open' || rt.child.exited) {
      throw new HostOpError('INVALID_TRANSITION', 'process exited — resize refused', 'reconcile')
    }
    const leaseVerified = this.checkLease(payload.terminalId, t, payload.inputLeaseRevision)
    const cols = Math.max(1, Math.floor(payload.columns))
    const rows = Math.max(1, Math.floor(payload.rows))
    rt.child.resize?.(cols, rows)
    rt.cols = cols
    rt.rows = rows
    t.screen.resize(cols, rows)
    t.sizeRevision++
    for (const s of this.subs.values()) {
      if (s.terminalId === t.terminalId) {
        this.emit({
          t: 'terminal.resized',
          subscriptionId: s.id,
          terminalId: t.terminalId,
          connectionId: s.connectionId,
          cols,
          rows
        })
      }
    }
    return { sizeRevision: t.sizeRevision, columns: cols, rows, leaseVerified }
  }

  /** host.terminal.snapshot — bounded read; never claims native history */
  snapshotOp(payload: { terminalId: string; expectedOutputEpoch?: string }): TerminalSnapshot & {
    epochMismatch: boolean
  } {
    const t = this.terminals.get(payload.terminalId)
    if (!t) throw new HostOpError('NOT_FOUND', `unknown terminal ${payload.terminalId}`)
    const snap = this.snapshot(t)
    return {
      ...snap,
      epochMismatch:
        payload.expectedOutputEpoch !== undefined &&
        payload.expectedOutputEpoch !== t.buffer.outputEpoch
    }
  }

  /** host.terminal.detach — idempotent subscription release; only the
   *  subscription's own connection (or an unbound sub) may detach it */
  detach(payload: { subscriptionId: string; connectionId?: string }): { detached: boolean } {
    const s = this.subs.get(payload.subscriptionId)
    if (!s) return { detached: true } // already gone — idempotent
    if (s.connectionId && payload.connectionId && s.connectionId !== payload.connectionId) {
      throw new HostOpError('SCOPE_DENIED', 'subscription belongs to another connection')
    }
    this.subs.delete(payload.subscriptionId)
    return { detached: true }
  }

  /** drop every subscription a dead connection owned — IMP-17 calls this
   *  from its conn-close path so detached viewers don't leak subs */
  dropConnection(connectionId: string): number {
    let dropped = 0
    for (const [id, s] of this.subs) {
      if (s.connectionId === connectionId) {
        this.subs.delete(id)
        dropped++
      }
    }
    return dropped
  }

  private checkLease(
    terminalId: string,
    t: ManagedTerminal,
    presented: number | undefined
  ): boolean {
    if (presented === undefined) {
      throw new HostOpError('SCOPE_DENIED', 'inputLeaseRevision required')
    }
    if (this.deps.verifyInputLease) {
      const ok = this.deps.verifyInputLease(terminalId, presented)
      if (!ok) {
        throw new HostOpError('STALE_REVISION', 'stale or foreign input lease', 'reconcile')
      }
      return true
    }
    if (t.inputLeaseRevision !== undefined && presented !== t.inputLeaseRevision) {
      throw new HostOpError('STALE_REVISION', 'stale input lease revision', 'reconcile')
    }
    // no authoritative verifier wired — reported honestly in the receipt
    return false
  }

  /** drop all subscriptions (daemon shutdown — records stay) */
  dispose(): void {
    this.subs.clear()
  }
}

let epochCounter = 0
function randomSeq(): string {
  return `e${Date.now().toString(36)}-${++epochCounter}`
}
