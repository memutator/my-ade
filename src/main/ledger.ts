// Local token ledger — reads each harness's on-disk session records (the same
// files the CLIs themselves write) and returns per-provider totals plus
// lookups for mahas-tracked session ids. Never talks to the network.
//
//   grok     ~/.grok/sessions/**/usage.json
//   claude   ~/.claude/projects/**/<sessionId>.jsonl  (sum assistant.usage)
//   codex    ~/.codex/sessions/**/rollout-*-<id>.jsonl  (last token_count)
//   opencode ~/.local/share/opencode/opencode.db session row
//   zcode    ~/.zcode/cli/db/db.sqlite  SUM(turn_usage)
//   devin    ~/.local/share/devin/cli/transcripts/<id>.json final_metrics

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
  map: Record<string, string[]>
): TokenUse {
  const pick = (keys: string[]): number => {
    if (!o) return 0
    for (const k of keys) {
      const v = o[k]
      if (typeof v === 'number' && Number.isFinite(v)) return v
    }
    return 0
  }
  const input = pick(map.input)
  const output = pick(map.output)
  const cached = pick(map.cached)
  const reasoning = pick(map.reasoning)
  const total = pick(map.total) || input + output
  const ticks = pick(map.ticks)
  const cost = pick(map.cost) || (ticks ? ticks / 10_000_000_000 : 0)
  const t: TokenUse = { input, output, cached, reasoning, total }
  if (cost) t.costUsd = cost
  return t
}

const ANTHRO = {
  input: ['inputTokens', 'input_tokens'],
  output: ['outputTokens', 'output_tokens'],
  cached: ['cachedReadTokens', 'cache_read_input_tokens', 'cached_input_tokens', 'cached_tokens'],
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
      return database.prepare(sql).all() as Record<string, unknown>[]
    } finally {
      database.close()
    }
  } catch {
    return []
  }
}

type Hit = { tokens: TokenUse; title?: string; cwd?: string }

interface Store {
  byId: Map<string, Hit>
  profile: TokenUse
  count: number
}

function emptyStore(): Store {
  return { byId: new Map(), profile: empty(), count: 0 }
}

function put(st: Store, id: string, hit: Hit): void {
  if (!id || st.byId.has(id)) return
  st.byId.set(id, hit)
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
    'SELECT id, title, directory, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost FROM session'
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
      ANTHRO
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
  const rows = sqliteJson(
    db,
    `SELECT t.session_id AS id, s.title AS title, s.directory AS directory,
            SUM(t.input_tokens) AS input_tokens,
            SUM(t.output_tokens) AS output_tokens,
            SUM(t.cache_read_input_tokens) AS cache_read_input_tokens,
            SUM(t.reasoning_tokens) AS reasoning_tokens
     FROM turn_usage t
     LEFT JOIN session s ON s.id = t.session_id
     GROUP BY t.session_id`
  )
  for (const r of rows) {
    const id = String(r.id ?? '')
    put(st, id, {
      tokens: fromFields(r, ANTHRO),
      title: typeof r.title === 'string' ? r.title : undefined,
      cwd: typeof r.directory === 'string' ? r.directory : undefined
    })
  }
  return st
}

async function scanDevin(): Promise<Store> {
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

const SCANNERS: Record<string, () => Promise<Store>> = {
  grok: scanGrok,
  claude: scanClaude,
  codex: scanCodex,
  opencode: async () => scanOpencode(),
  zcode: async () => scanZcode(),
  devin: scanDevin
}

function lookup(st: Store, sessionId: string): Hit | undefined {
  const hit = st.byId.get(sessionId)
  if (hit) return hit
  for (const [id, h] of st.byId) {
    if (id === sessionId || id.endsWith(sessionId) || sessionId.endsWith(id)) return h
  }
  return undefined
}

export async function scanLedger(tracked: LedgerQuery[] = []): Promise<LedgerResult> {
  const stores = new Map<string, Store>()
  const needed = new Set(tracked.map((t) => t.provider).filter((p) => p in SCANNERS))
  for (const id of Object.keys(SCANNERS)) needed.add(id)
  await Promise.all(
    [...needed].map(async (p) => {
      try {
        stores.set(p, await SCANNERS[p]())
      } catch {
        stores.set(p, emptyStore())
      }
    })
  )
  const profiles: LedgerProfile[] = []
  for (const [provider, st] of stores) {
    if (!st.count) continue
    profiles.push({ provider, sessionCount: st.count, tokens: st.profile })
  }
  profiles.sort((a, b) => b.tokens.total - a.tokens.total)
  const sessions: LedgerSession[] = tracked.map((q) => {
    const st = stores.get(q.provider)
    const hit = st ? lookup(st, q.sessionId) : undefined
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
