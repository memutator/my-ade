// Local token ledger — reads each harness's on-disk session records (the same
// files the CLIs themselves write) and returns per-provider totals plus
// lookups for mahas-tracked session ids. Never talks to the network.
//
//   grok     ~/.grok/sessions/**/usage.json
//   claude   ~/.claude/projects/**/<sessionId>.jsonl  (sum assistant.usage)
//   codex    ~/.codex/sessions/**/rollout-*-<id>.jsonl  (last token_count)
//   opencode ~/.local/share/opencode/opencode.db session row
//   zcode    ~/.zcode/cli/db/db.sqlite  SUM(model_usage); turn_usage fallback
//   devin    ~/.local/share/devin/cli/sessions.db  message_nodes.metrics
//            (ATIF transcripts/final_metrics is a compacted export and
//            undercounts cache_read by ~10×; do not use it as the total)
//   cline    ~/.cline/data/sessions/<id>/*.messages.json  (sum metrics)

import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { closeSync, existsSync, openSync, readSync, statSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, extname, join } from 'path'

export interface TokenUse {
  input: number
  output: number
  cached: number
  reasoning: number
  total: number
  costUsd?: number
}

export interface LedgerQuery {
  sessionId: string
  provider: string
  cwd?: string
  name?: string
}

export interface LedgerSession {
  sessionId: string
  provider: string
  title?: string
  cwd?: string
  tokens: TokenUse
  found: boolean
}

export interface LedgerProfile {
  provider: string
  sessionCount: number
  tokens: TokenUse
}

export interface LedgerResult {
  profiles: LedgerProfile[]
  sessions: LedgerSession[]
  fetchedAt: number
}

const empty = (): TokenUse => ({ input: 0, output: 0, cached: 0, reasoning: 0, total: 0 })

function add(a: TokenUse, b: TokenUse): TokenUse {
  const cost =
    a.costUsd !== undefined || b.costUsd !== undefined
      ? (a.costUsd ?? 0) + (b.costUsd ?? 0)
      : undefined
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cached: a.cached + b.cached,
    reasoning: a.reasoning + b.reasoning,
    total: a.total + b.total,
    costUsd: cost
  }
}

function fromFields(
  o: Record<string, unknown> | undefined,
  map: Record<string, string[]>,
  cacheExtra = false
): TokenUse {
  const pick = (keys: string[]): number => {
    if (!o) return 0
    for (const k of keys) {
      const v = o[k]
      if (typeof v === 'number' && Number.isFinite(v)) return v
      if (typeof v === 'bigint') return Number(v)
      if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
    }
    return 0
  }
  const rawIn = pick(map.input)
  const output = pick(map.output)
  const rawCached = pick(map.cached)
  const reasoning = pick(map.reasoning)
  const explicit = pick(map.total)
  const ticks = pick(map.ticks)
  const cost = pick(map.cost) || (ticks ? ticks / 10_000_000_000 : 0)
  // subset (Grok/Codex/Claude/ZCode/ATIF): cached is already inside input.
  // extra (OpenCode, Devin sessions.db): cache_read is on top of uncached
  // input even when cache < input — do not guess from the magnitudes.
  const cached = rawCached
  const input = rawIn
  const extra = cacheExtra || rawCached > rawIn
  const total = explicit || (extra ? rawIn + rawCached + output + reasoning : rawIn + output)
  const t: TokenUse = { input, output, cached, reasoning, total }
  if (cost) t.costUsd = cost
  return t
}

const ANTHRO = {
  input: ['inputTokens', 'input_tokens'],
  output: ['outputTokens', 'output_tokens'],
  cached: [
    'cachedReadTokens',
    'cache_read_input_tokens',
    'cache_read_tokens',
    'cached_input_tokens',
    'cached_tokens'
  ],
  reasoning: ['reasoningTokens', 'reasoning_output_tokens', 'tokens_reasoning'],
  total: ['totalTokens', 'total_tokens'],
  ticks: ['costUsdTicks'],
  cost: ['cost']
}

async function walkFiles(
  root: string,
  match: (name: string) => boolean,
  cap = 4000
): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= cap) return
    let ents
    try {
      ents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (out.length >= cap) return
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile() && match(e.name)) out.push(p)
    }
  }
  if (existsSync(root)) await walk(root)
  return out
}

function tailUtf8(file: string, bytes: number): string {
  try {
    const st = statSync(file)
    const len = Math.min(bytes, st.size)
    const buf = Buffer.alloc(len)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buf, 0, len, st.size - len)
    } finally {
      closeSync(fd)
    }
    return buf.toString('utf8')
  } catch {
    return ''
  }
}

function sqliteJson(db: string, sql: string): Record<string, unknown>[] {
  if (!existsSync(db)) return []
  try {
    const database = new DatabaseSync(db, { readOnly: true })
    try {
      try {
        database.exec('PRAGMA busy_timeout = 5000')
      } catch {
        /* pragma may be blocked on some read-only connections */
      }
      return database.prepare(sql).all() as Record<string, unknown>[]
    } finally {
      database.close()
    }
  } catch {
    return []
  }
}

export type Hit = { tokens: TokenUse; title?: string; cwd?: string }

interface Store {
  byId: Map<string, Hit>
  profile: TokenUse
  count: number
}

function emptyStore(): Store {
  return { byId: new Map(), profile: empty(), count: 0 }
}

function put(st: Store, id: string, hit: Hit, inProfile = true): void {
  if (!id || st.byId.has(id)) return
  st.byId.set(id, hit)
  if (!inProfile) return
  st.profile = add(st.profile, hit.tokens)
  st.count++
}

async function scanGrok(): Promise<Store> {
  const st = emptyStore()
  const files = await walkFiles(join(homedir(), '.grok', 'sessions'), (n) => n === 'usage.json')
  for (const f of files) {
    try {
      const d = JSON.parse(await readFile(f, 'utf8')) as Record<string, unknown>
      const sess = (d.session as Record<string, unknown>) ?? d
      const id = String(d.sessionId ?? d.session_id ?? basename(f.replace(/\/usage\.json$/, '')))
      put(st, id, { tokens: fromFields(sess, ANTHRO) })
    } catch {
      /* skip */
    }
  }
  return st
}

async function scanClaude(): Promise<Store> {
  const st = emptyStore()
  const files = await walkFiles(join(homedir(), '.claude', 'projects'), (n) => n.endsWith('.jsonl'))
  for (const f of files) {
    let id = basename(f, '.jsonl')
    let acc = empty()
    try {
      const text = await readFile(f, 'utf8')
      for (const line of text.split('\n')) {
        if (!line) continue
        let d: Record<string, unknown>
        try {
          d = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (typeof d.sessionId === 'string') id = d.sessionId
        if (d.type !== 'assistant') continue
        const msg = d.message as Record<string, unknown> | undefined
        const u = msg?.usage as Record<string, unknown> | undefined
        if (!u) continue
        acc = add(acc, fromFields(u, ANTHRO))
      }
      if (acc.total || acc.input || acc.output) put(st, id, { tokens: acc })
    } catch {
      /* skip */
    }
  }
  return st
}

function parseCodexTail(text: string): TokenUse | null {
  let count: TokenUse | null = null
  let record: TokenUse | null = null
  for (const line of text.split('\n')) {
    const i = line.indexOf('{')
    if (i < 0) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(line.slice(i)) as Record<string, unknown>
    } catch {
      continue
    }
    const p = d.payload as Record<string, unknown> | undefined
    if (!p) continue
    if (d.type === 'event_msg' && p.type === 'token_count') {
      const info = p.info as Record<string, unknown> | undefined
      const u = (info?.total_token_usage ?? p.total_token_usage) as
        Record<string, unknown> | undefined
      if (u) count = fromFields(u, ANTHRO)
    } else if (d.type === 'token_usage_record') {
      const u = p.usage as Record<string, unknown> | undefined
      if (u) record = fromFields(u, ANTHRO)
    }
  }
  return count ?? record
}

async function scanCodex(): Promise<Store> {
  const st = emptyStore()
  const files = await walkFiles(join(homedir(), '.codex', 'sessions'), (n) => n.endsWith('.jsonl'))
  for (const f of files) {
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(f)
    const id = m?.[1]
    if (!id) continue
    const tok = parseCodexTail(tailUtf8(f, 512_000))
    if (tok) put(st, id, { tokens: tok })
  }
  return st
}

function scanOpencode(): Store {
  const st = emptyStore()
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const db = join(xdg, 'opencode', 'opencode.db')
  const rows = sqliteJson(
    db,
    'SELECT id, parent_id, title, directory, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost FROM session'
  )
  for (const r of rows) {
    const id = String(r.id ?? '')
    const tokens = fromFields(
      {
        input_tokens: r.tokens_input,
        output_tokens: r.tokens_output,
        tokens_reasoning: r.tokens_reasoning,
        cache_read_input_tokens: r.tokens_cache_read,
        cost: r.cost
      },
      ANTHRO,
      true
    )
    put(st, id, {
      tokens,
      title: typeof r.title === 'string' ? r.title : undefined,
      cwd: typeof r.directory === 'string' ? r.directory : undefined
    })
  }
  return st
}

function scanZcode(): Store {
  const st = emptyStore()
  const db = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
  // model_usage is the per-request log (main_turn, subagent, compact,
  // verification). turn_usage is a per-turn rollup that drops some of
  // those rows (~3% locally). Same lesson as Devin transcripts vs db.
  const sql = (from: string): string =>
    `SELECT t.session_id AS id, s.title AS title, s.directory AS directory,
            SUM(t.input_tokens) AS input_tokens,
            SUM(t.output_tokens) AS output_tokens,
            SUM(t.cache_read_input_tokens) AS cache_read_input_tokens,
            SUM(t.reasoning_tokens) AS reasoning_tokens
     FROM ${from} t
     LEFT JOIN session s ON s.id = t.session_id
     GROUP BY t.session_id`
  const rows = sqliteJson(db, sql('model_usage'))
  const src = rows.length ? rows : sqliteJson(db, sql('turn_usage'))
  for (const r of src) {
    const id = String(r.id ?? '')
    put(st, id, {
      tokens: fromFields(r, ANTHRO),
      title: typeof r.title === 'string' ? r.title : undefined,
      cwd: typeof r.directory === 'string' ? r.directory : undefined
    })
  }
  return st
}

function scanDevinDb(): Store {
  const st = emptyStore()
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const db = join(xdg, 'devin', 'cli', 'sessions.db')
  // Per-inference usage lives on assistant chat_message.metadata.metrics.
  // Streaming/retry nodes reuse message_id with the same metrics — group
  // first so we don't multiply a turn. cache_read_tokens is extra (often
  // >> input), same shape as OpenCode tokens_cache_read.
  const rows = sqliteJson(
    db,
    `SELECT COALESCE(s.id, u.session_id) AS id,
            s.title AS title,
            s.working_directory AS directory,
            SUM(u.input_tokens) AS input_tokens,
            SUM(u.output_tokens) AS output_tokens,
            SUM(u.cache_read_tokens) AS cache_read_input_tokens
     FROM (
       SELECT session_id,
              CAST(json_extract(chat_message, '$.metadata.metrics.input_tokens') AS INTEGER)
                AS input_tokens,
              CAST(json_extract(chat_message, '$.metadata.metrics.output_tokens') AS INTEGER)
                AS output_tokens,
              CAST(json_extract(chat_message, '$.metadata.metrics.cache_read_tokens') AS INTEGER)
                AS cache_read_tokens
       FROM message_nodes
       WHERE json_extract(chat_message, '$.metadata.metrics.input_tokens') IS NOT NULL
       GROUP BY session_id, json_extract(chat_message, '$.message_id')
     ) u
     LEFT JOIN sessions s ON s.id = u.session_id
     GROUP BY u.session_id`
  )
  for (const r of rows) {
    const id = String(r.id ?? '')
    const tokens = fromFields(r, ANTHRO, true)
    if (tokens.total || tokens.input || tokens.cached) {
      put(st, id, {
        tokens,
        title: typeof r.title === 'string' ? r.title : undefined,
        cwd: typeof r.directory === 'string' ? r.directory : undefined
      })
    }
  }
  return st
}

async function scanDevinTranscripts(): Promise<Store> {
  const st = emptyStore()
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const dir = join(xdg, 'devin', 'cli', 'transcripts')
  const files = await walkFiles(dir, (n) => n.endsWith('.json'))
  for (const f of files) {
    try {
      const d = JSON.parse(await readFile(f, 'utf8')) as Record<string, unknown>
      const id = String(d.session_id ?? basename(f, extname(f)))
      const m = (d.final_metrics as Record<string, unknown>) ?? {}
      const tokens = fromFields(
        {
          input_tokens: m.total_prompt_tokens,
          output_tokens: m.total_completion_tokens,
          cached_tokens: m.total_cached_tokens
        },
        ANTHRO
      )
      if (tokens.total || tokens.input) put(st, id, { tokens })
    } catch {
      /* skip */
    }
  }
  return st
}

async function scanDevin(): Promise<Store> {
  const fromDb = scanDevinDb()
  if (fromDb.count) return fromDb
  return scanDevinTranscripts()
}

// cline records every session under its own dir: <id>/<id>.json (manifest —
// cwd, prompt) plus one <name>.messages.json per conversation (main run and
// team/sub-agent runs alike). Each assistant message carries per-request
// metrics{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens} where the
// cache fields sit inside inputTokens — sum them across every conversation in
// the session dir.
async function scanCline(): Promise<Store> {
  const st = emptyStore()
  const dataDir = process.env.CLINE_DATA_DIR || join(homedir(), '.cline', 'data')
  const root = join(dataDir, 'sessions')
  let dirs: string[] = []
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => join(root, e.name))
  } catch {
    return st
  }
  for (const dir of dirs) {
    const id = basename(dir)
    let acc = empty()
    let title: string | undefined
    let cwd: string | undefined
    try {
      const manifest = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as Record<
        string,
        unknown
      >
      cwd =
        (typeof manifest.cwd === 'string' && manifest.cwd) ||
        (typeof manifest.workspace_root === 'string' ? manifest.workspace_root : undefined) ||
        undefined
      // prompt arrives wrapped in <user_input …> tags — unwrap the text
      const prompt = typeof manifest.prompt === 'string' ? manifest.prompt : ''
      title =
        prompt
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80) || undefined
    } catch {
      /* manifest optional — tokens still count */
    }
    const files = await walkFiles(dir, (n) => n.endsWith('.messages.json'))
    for (const f of files) {
      try {
        const d = JSON.parse(await readFile(f, 'utf8')) as Record<string, unknown>
        const msgs = Array.isArray(d.messages) ? d.messages : []
        for (const m of msgs) {
          const u = (m as Record<string, unknown>).metrics as Record<string, unknown> | undefined
          if (!u) continue
          acc = add(
            acc,
            fromFields(
              {
                input_tokens: u.inputTokens,
                output_tokens: u.outputTokens,
                cache_read_input_tokens:
                  (typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0) +
                  (typeof u.cacheWriteTokens === 'number' ? u.cacheWriteTokens : 0)
              },
              ANTHRO
            )
          )
        }
      } catch {
        /* skip */
      }
    }
    if (acc.total || acc.input || acc.output) put(st, id, { tokens: acc, title, cwd })
  }
  return st
}

const SCANNERS: Record<string, () => Promise<Store>> = {
  grok: scanGrok,
  claude: scanClaude,
  codex: scanCodex,
  opencode: async () => scanOpencode(),
  zcode: async () => scanZcode(),
  devin: scanDevin,
  cline: scanCline
}

export type WireStore = {
  byId: Record<string, Hit>
  profile: TokenUse
  count: number
}

function toWire(st: Store): WireStore {
  const byId: Record<string, Hit> = {}
  for (const [id, hit] of st.byId) byId[id] = hit
  return { byId, profile: st.profile, count: st.count }
}

function lookupWire(st: WireStore, sessionId: string): Hit | undefined {
  const hit = st.byId[sessionId]
  if (hit) return hit
  for (const [id, h] of Object.entries(st.byId)) {
    if (id === sessionId || id.endsWith(sessionId) || sessionId.endsWith(id)) return h
  }
  return undefined
}

/** Sequential on-disk scan. Runs inside the worker so sqlite/jsonl I/O
 *  cannot freeze the Electron UI. Sequential to avoid opening the 5GB
 *  OpenCode db and the Devin sessions db at the same time. */
export async function scanStores(): Promise<Record<string, WireStore>> {
  const out: Record<string, WireStore> = {}
  for (const p of Object.keys(SCANNERS)) {
    try {
      out[p] = toWire(await SCANNERS[p]())
    } catch {
      out[p] = toWire(emptyStore())
    }
  }
  return out
}

export function assembleLedger(
  stores: Record<string, WireStore>,
  tracked: LedgerQuery[] = []
): LedgerResult {
  const profiles: LedgerProfile[] = []
  for (const [provider, st] of Object.entries(stores)) {
    if (!st.count) continue
    profiles.push({ provider, sessionCount: st.count, tokens: st.profile })
  }
  profiles.sort((a, b) => b.tokens.total - a.tokens.total)
  const sessions: LedgerSession[] = tracked.map((q) => {
    const st = stores[q.provider]
    const hit = st ? lookupWire(st, q.sessionId) : undefined
    return {
      sessionId: q.sessionId,
      provider: q.provider,
      title: hit?.title ?? q.name,
      cwd: hit?.cwd ?? q.cwd,
      tokens: hit?.tokens ?? empty(),
      found: !!hit
    }
  })
  return { profiles, sessions, fetchedAt: Date.now() }
}

let cache: Record<string, WireStore> | null = null
let cacheAt = 0
let inflight: Promise<Record<string, WireStore>> | null = null

function workerPath(): string | null {
  const here = join(__dirname, 'ledger-worker.js')
  const unpacked = here.replace(`${join('app.asar')}${join('/')}`, `app.asar.unpacked${join('/')}`)
  if (unpacked !== here && existsSync(unpacked)) return unpacked
  if (existsSync(here) && !here.includes(`${join('app.asar')}${join('/')}`)) return here
  return null
}

function scanStoresOffThread(): Promise<Record<string, WireStore>> {
  const file = workerPath()
  if (!file) return scanStores()
  return new Promise((resolve, reject) => {
    const w = new Worker(file)
    let settled = false
    const t = setTimeout(() => {
      fail(new Error('ledger scan timed out'))
    }, 120_000)
    const finish = (): void => {
      clearTimeout(t)
      void w.terminate()
    }
    const fail = (e: Error): void => {
      if (settled) return
      settled = true
      finish()
      reject(e)
    }
    w.once(
      'message',
      (msg: { ok?: boolean; stores?: Record<string, WireStore>; error?: string }) => {
        if (settled) return
        settled = true
        finish()
        if (msg?.ok && msg.stores) resolve(msg.stores)
        else reject(new Error(msg?.error || 'ledger worker failed'))
      }
    )
    w.once('error', (e) => fail(e instanceof Error ? e : new Error(String(e))))
    w.once('exit', (code) => {
      if (!settled && code !== 0) fail(new Error(`ledger worker exit ${code}`))
    })
    w.postMessage(null)
  })
}

function loadStores(force: boolean): Promise<Record<string, WireStore>> {
  if (!force && cache) return Promise.resolve(cache)
  if (inflight) return inflight
  inflight = scanStoresOffThread()
    .catch(() => scanStores())
    .then((s) => {
      cache = s
      cacheAt = Date.now()
      return s
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export async function getLedger(tracked: LedgerQuery[] = [], force = false): Promise<LedgerResult> {
  const stores = await loadStores(force)
  const result = assembleLedger(stores, tracked)
  if (cacheAt) result.fetchedAt = cacheAt
  return result
}

export async function scanLedger(tracked: LedgerQuery[] = []): Promise<LedgerResult> {
  return getLedger(tracked)
}
