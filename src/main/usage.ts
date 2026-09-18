// Per-harness usage/quota probes for the 'usage' widget. Each provider reads
// the credentials its own CLI left on disk and calls the same (undocumented,
// read-only) endpoint the CLI's own usage display uses:
//
//   grok     ~/.grok/auth.json              → GET cli-chat-proxy.grok.com/v1/billing
//            (OIDC refresh via auth.x.ai; rotated tokens written back)
//   claude   ~/.claude/.credentials.json    → GET api.anthropic.com/api/oauth/usage
//   codex    ~/.codex/auth.json             → GET chatgpt.com/backend-api/wham/usage
//   gemini   ~/.gemini/oauth_creds.json     → POST cloudcode-pa.googleapis.com/…:retrieveUserQuota
//   copilot  gh/copilot token               → GET api.github.com/copilot_internal/user
//   zcode    ~/.zcode/v2/config.json apiKey → GET api.z.ai/api/monitor/usage/quota/limit
//            (env ZAI_API_KEY / ZHIPUAI_API_KEY still accepted)
//   opencode ~/.local/share/opencode/auth.json opencode-go.key
//                                           → GET opencode.ai/zen/go/v1/usage
//   devin    ~/.local/share/devin/credentials.toml windsurf_api_key
//                                           → POST server.codeium.com/…/GetUserStatus
//
// Everything degrades honestly: missing creds / expired tokens / unsupported
// providers return { ok:false, error } — the widget renders the reason.

import { ipcMain, net } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { readFile, writeFile } from 'fs/promises'
import { getLedger, type LedgerQuery, type LedgerResult } from './ledger'

export interface UsageWindow {
  id: string
  label: string
  usedPct?: number
  resetAt?: number
  detail?: string
}

export interface UsageResult {
  ok: boolean
  provider: string
  plan?: string
  windows: UsageWindow[]
  extra?: string
  error?: string
  fetchedAt: number
}

type Fetcher = () => Promise<Omit<UsageResult, 'ok' | 'provider' | 'fetchedAt'>>

const TIMEOUT_MS = 9000

// Cloudflare (opencode.ai, some gateways) 1010s Electron's default UA.
const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function fail(error: string): Omit<UsageResult, 'ok' | 'provider' | 'fetchedAt'> {
  return { windows: [], error }
}

function hdrs(extra: Record<string, string> = {}): Record<string, string> {
  return { Accept: 'application/json', 'User-Agent': CHROME_UA, ...extra }
}

async function readBody(res: Response): Promise<string> {
  return res.text().catch(() => '')
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await net.fetch(url, {
    headers: hdrs(headers),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) {
    const t = await readBody(res)
    throw httpError(res.status, t)
  }
  return res.json()
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const res = await net.fetch(url, {
    method: 'POST',
    headers: hdrs({ 'Content-Type': 'application/json', ...headers }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) {
    const t = await readBody(res)
    throw httpError(res.status, t)
  }
  return res.json()
}

function httpError(status: number, body: string): Error {
  const raw = body.trim()
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>
      const code = typeof j.code === 'string' ? j.code : undefined
      const msg = typeof j.message === 'string' ? j.message : undefined
      if (msg) {
        const short = msg.replace(/\s*\((?:error|trace) ID: [^)]+\)/gi, '').trim()
        return new Error(code && code !== 'unknown' ? `${code}: ${short}` : short)
      }
    } catch {
      /* fall through */
    }
  }
  return new Error(`HTTP ${status}${raw ? `: ${raw.slice(0, 120)}` : ''}`)
}

async function postForm(url: string, fields: Record<string, string>): Promise<unknown> {
  const res = await net.fetch(url, {
    method: 'POST',
    headers: hdrs({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) {
    const t = await readBody(res)
    throw new Error(`HTTP ${res.status}${t ? `: ${t.slice(0, 160)}` : ''}`)
  }
  return res.json()
}

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** Human plan label: SuperGrokPro → SuperGrok Pro, TEAMS_TIER_DEVIN_PRO → Devin Pro. */
function prettyPlan(v: unknown): string | undefined {
  const s = str(v)
  if (!s) return undefined
  const t = s.replace(/^TEAMS_TIER_/i, '')
  const snake = /[_-]/.test(t)
  const parts = snake
    ? t.split(/[_-]+/).filter(Boolean)
    : t
        .replace(/([a-z\d])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/\s+/)
        .filter(Boolean)
  return parts
    .map((w) => (w ? w[0].toUpperCase() + (snake ? w.slice(1).toLowerCase() : w.slice(1)) : w))
    .join(' ')
}

function isoMs(v: unknown): number | undefined {
  const s = str(v)
  if (!s) return undefined
  const n = Date.parse(s)
  return Number.isFinite(n) ? n : undefined
}

// ── grok ────────────────────────────────────────────────────────────────
// Same endpoints Grok Build's /usage modal hits (cli-chat-proxy). Access
// tokens last ~6h; we refresh via auth.x.ai OIDC and write the rotated
// pair back so the grok CLI keeps working (refresh tokens rotate).
async function grokAccessToken(): Promise<string | undefined> {
  const file = join(homedir(), '.grok', 'auth.json')
  const table = await readJson(file)
  if (!table) return undefined
  const scope = Object.keys(table)[0]
  const entry = (scope ? table[scope] : undefined) as Record<string, unknown> | undefined
  if (!entry) return undefined
  const exp = isoMs(entry.expires_at) ?? 0
  const cached = str(entry.key)
  if (cached && exp > Date.now() + 60_000) return cached
  const rt = str(entry.refresh_token)
  const cid = str(entry.oidc_client_id)
  if (!rt || !cid) return cached
  const r = (await postForm('https://auth.x.ai/oauth2/token', {
    grant_type: 'refresh_token',
    refresh_token: rt,
    client_id: cid
  }).catch(() => null)) as Record<string, unknown> | null
  const next = str(r?.access_token)
  if (!next) return cached
  const nrt = str(r?.refresh_token) ?? rt
  const ein = num(r?.expires_in) ?? 21_600
  const expiresAt = new Date(Date.now() + ein * 1000).toISOString()
  try {
    const updated = {
      ...table,
      [scope]: { ...entry, key: next, refresh_token: nrt, expires_at: expiresAt }
    }
    await writeFile(file, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 })
  } catch {
    /* disk is the CLI's file — a failed write still lets this fetch proceed */
  }
  return next
}

/** CLI display name — /user.subscriptionTier is a SKU enum (SuperGrokPro)
 *  that does not distinguish Heavy/Plus. Prefer subscription_tier_display. */
function grokDisplayOf(o: Record<string, unknown> | null | undefined): string | undefined {
  if (!o) return undefined
  const direct = prettyPlan(o.subscription_tier_display) ?? prettyPlan(o.subscriptionTierDisplay)
  if (direct) return direct
  const nested = o.settings
  if (nested && typeof nested === 'object' && !Array.isArray(nested) && nested !== o) {
    return grokDisplayOf(nested as Record<string, unknown>)
  }
  return undefined
}

async function grokCachedDisplay(): Promise<string | undefined> {
  const cache = await readJson(join(homedir(), '.grok', 'settings_cache.json'))
  let payload: unknown = cache?.payload
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload) as unknown
    } catch {
      payload = null
    }
  }
  const root = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  const settings =
    root?.settings && typeof root.settings === 'object'
      ? (root.settings as Record<string, unknown>)
      : root
  return grokDisplayOf(settings)
}

async function grokPlanLabel(
  liveSettings: Record<string, unknown> | null,
  user: Record<string, unknown> | null
): Promise<string | undefined> {
  const live = grokDisplayOf(liveSettings)
  if (live) return live
  const cached = await grokCachedDisplay()
  if (cached) return cached
  const sku = str(user?.subscriptionTier)
  // SuperGrokPro is the paid-family SKU, not the "Pro" product name.
  if (sku === 'SuperGrokPro') return 'SuperGrok'
  return prettyPlan(sku)
}

async function fetchGrok(): ReturnType<Fetcher> {
  const token = await grokAccessToken()
  if (!token) return fail('no Grok credentials (~/.grok/auth.json) — run `grok login`')
  const auth = { Authorization: `Bearer ${token}`, 'User-Agent': 'grok-shell' }
  const billing = (await getJson(
    'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
    auth
  )) as Record<string, unknown>
  const user = (await getJson(
    'https://cli-chat-proxy.grok.com/v1/user?include=subscription',
    auth
  ).catch(() => null)) as Record<string, unknown> | null
  const settings = (await getJson('https://cli-chat-proxy.grok.com/v1/settings', auth).catch(
    () => null
  )) as Record<string, unknown> | null
  const cfg = (billing.config as Record<string, unknown> | undefined) ?? billing
  const period = (cfg.currentPeriod as Record<string, unknown> | undefined) ?? {}
  const resetAt = isoMs(period.end) ?? isoMs(cfg.billingPeriodEnd)
  const windows: UsageWindow[] = []
  const overall = num(cfg.creditUsagePercent)
  if (overall !== undefined) {
    windows.push({
      id: 'week',
      label: 'Weekly allowance',
      usedPct: overall,
      resetAt
    })
  }
  const products = cfg.productUsage as Record<string, unknown>[] | undefined
  if (Array.isArray(products)) {
    for (const p of products) {
      const name = str(p.product)
      const pct = num(p.usagePercent)
      if (!name || pct === undefined) continue
      if (name === 'GrokBuild' && overall !== undefined && Math.abs(pct - overall) < 0.05) continue
      windows.push({ id: name.toLowerCase(), label: name, usedPct: pct, resetAt })
    }
  }
  const bits: string[] = []
  const od = cfg.onDemandUsed as Record<string, unknown> | undefined
  const cap = cfg.onDemandCap as Record<string, unknown> | undefined
  if (num(od?.val) !== undefined || num(cap?.val) !== undefined) {
    bits.push(`on-demand ${num(od?.val) ?? 0}/${num(cap?.val) ?? '?'}`)
  }
  const prepaid = cfg.prepaidBalance as Record<string, unknown> | undefined
  if (num(prepaid?.val)) bits.push(`prepaid ${num(prepaid?.val)}`)
  if (!windows.length) return fail('empty billing response')
  return {
    plan: await grokPlanLabel(settings, user),
    windows,
    extra: bits.join(' · ') || undefined
  }
}

// ── claude ──────────────────────────────────────────────────────────────
// The same endpoint Claude Code's /usage renders. The `anthropic-beta` +
// claude-code User-Agent headers are required — without them the request
// lands in an aggressively rate-limited bucket (persistent 429).
async function fetchClaude(): ReturnType<Fetcher> {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const creds = await readJson(join(dir, '.credentials.json'))
  const oauth = creds?.claudeAiOauth as Record<string, unknown> | undefined
  const token = str(oauth?.accessToken)
  if (!token) return fail('no Claude OAuth credentials (~/.claude/.credentials.json)')
  const r = (await getJson('https://api.anthropic.com/api/oauth/usage', {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': 'claude-code/2.0.0',
    Accept: 'application/json'
  })) as Record<string, unknown>
  const win = (v: unknown, id: string, label: string): UsageWindow | null => {
    const w = v as Record<string, unknown> | null | undefined
    if (!w) return null
    return {
      id,
      label,
      usedPct: num(w.utilization),
      resetAt: str(w.resets_at) ? Date.parse(str(w.resets_at)!) : undefined
    }
  }
  const windows = [
    win(r.five_hour, '5h', '5-hour window'),
    win(r.seven_day, '7d', 'Weekly (all models)'),
    win(r.seven_day_opus, '7d-opus', 'Weekly · Opus'),
    win(r.seven_day_sonnet, '7d-sonnet', 'Weekly · Sonnet')
  ].filter((w): w is UsageWindow => !!w)
  const eu = r.extra_usage as Record<string, unknown> | undefined
  const extra =
    eu && eu.is_enabled
      ? `extra usage: $${num(eu.used_credits) ?? '?'}${
          eu.monthly_limit ? ` / $${num(eu.monthly_limit)}` : ''
        }`
      : undefined
  if (!windows.length) return fail('empty usage response')
  return { windows, extra }
}

// ── codex ───────────────────────────────────────────────────────────────
// ChatGPT backend quota endpoint (what the Codex app itself calls).
async function fetchCodex(): ReturnType<Fetcher> {
  const auth = await readJson(join(homedir(), '.codex', 'auth.json'))
  const tokens = auth?.tokens as Record<string, unknown> | undefined
  const token = str(tokens?.access_token) ?? str(auth?.access_token)
  if (!token) return fail('no Codex credentials (~/.codex/auth.json)')
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': 'mahas'
  }
  const accountId = str(tokens?.account_id)
  if (accountId) headers['ChatGPT-Account-Id'] = accountId
  const r = (await getJson('https://chatgpt.com/backend-api/wham/usage', headers)) as Record<
    string,
    unknown
  >
  const rl = r.rate_limit as Record<string, unknown> | undefined
  const win = (v: unknown, id: string, label: string): UsageWindow | null => {
    const w = v as Record<string, unknown> | undefined
    if (!w) return null
    return {
      id,
      label,
      usedPct: num(w.used_percent),
      resetAt: num(w.reset_at) ? num(w.reset_at)! * 1000 : undefined
    }
  }
  const cr = r.code_review_rate_limit as Record<string, unknown> | undefined
  const windows = [
    win(rl?.primary_window, '5h', '5-hour window'),
    win(rl?.secondary_window, '7d', 'Weekly'),
    win(cr?.primary_window, 'review', 'Code review · weekly')
  ].filter((w): w is UsageWindow => !!w)
  const credits = r.credits as Record<string, unknown> | undefined
  const bits: string[] = []
  if (credits?.has_credits && !credits.unlimited && num(credits.balance) !== undefined) {
    bits.push(`credits: ${Math.round(num(credits.balance)!)}`)
  }
  const resets = r.rate_limit_reset_credits as Record<string, unknown> | undefined
  if (num(resets?.available_count)) bits.push(`${num(resets?.available_count)} reset credit(s)`)
  if (!windows.length) return fail('empty usage response')
  return { plan: prettyPlan(r.plan_type), windows, extra: bits.join(' · ') || undefined }
}

// ── gemini ──────────────────────────────────────────────────────────────
// Cloud Code Assist internal RPC — the quota view gemini-cli backs. The
// oauth_creds.json access token expires (~1h); refresh in-memory with the
// file's refresh_token using gemini-cli's public installed-app client
// (never written back — the CLI owns the file).
const GEMINI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com'
const GEMINI_CLIENT_SECRET = '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'

async function fetchGemini(): ReturnType<Fetcher> {
  const creds = await readJson(join(homedir(), '.gemini', 'oauth_creds.json'))
  if (!creds) return fail('no Gemini credentials (~/.gemini/oauth_creds.json)')
  let token = str(creds.access_token)
  const expiry = num(creds.expiry_date)
  if ((!token || (expiry !== undefined && expiry < Date.now() + 60_000)) && creds.refresh_token) {
    const r = (await postJson(
      'https://oauth2.googleapis.com/token',
      {},
      {
        client_id: GEMINI_CLIENT_ID,
        client_secret: GEMINI_CLIENT_SECRET,
        refresh_token: creds.refresh_token,
        grant_type: 'refresh_token'
      }
    ).catch(() => null)) as Record<string, unknown> | null
    token = str(r?.access_token) ?? token
  }
  if (!token) return fail('Gemini access token missing/expired — run `gemini` once')
  const auth = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  const project = str(process.env.GOOGLE_CLOUD_PROJECT) ?? str(process.env.GOOGLE_CLOUD_PROJECT_ID)
  const body = project ? { project } : {}
  const r = (await postJson(
    'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
    auth,
    body
  )) as Record<string, unknown>
  const buckets = (r.buckets ?? r.quotaBuckets) as Record<string, unknown>[] | undefined
  if (!Array.isArray(buckets) || !buckets.length) return fail('no quota buckets in response')
  const windows: UsageWindow[] = buckets.map((b, i) => {
    const frac = num(b.remainingFraction)
    return {
      id: `b${i}`,
      label: str(b.displayName) ?? str(b.modelId) ?? `bucket ${i + 1}`,
      usedPct: frac !== undefined ? Math.max(0, Math.min(100, (1 - frac) * 100)) : undefined,
      detail:
        num(b.remainingAmount) !== undefined ? `${num(b.remainingAmount)} remaining` : undefined
    }
  })
  return { windows }
}

// ── copilot ─────────────────────────────────────────────────────────────
// api.github.com/copilot_internal/user — what VS Code's Copilot badge calls.
// Token: copilot CLI's apps.json first, then the gh CLI's hosts.yml.
async function copilotToken(): Promise<string | undefined> {
  const apps = await readJson(join(homedir(), '.config', 'github-copilot', 'apps.json'))
  if (apps) {
    for (const v of Object.values(apps)) {
      const t = str((v as Record<string, unknown>)?.oauth_token)
      if (t) return t
    }
  }
  try {
    const hosts = await readFile(join(homedir(), '.config', 'gh', 'hosts.yml'), 'utf8')
    const block = /github\.com:\s*\n((?:[ \t]+[^\n]*\n?)+)/.exec(hosts)
    const tok = /oauth_token:\s*(\S+)/.exec(block?.[1] ?? hosts)
    return tok?.[1]
  } catch {
    return undefined
  }
}

async function fetchCopilot(): ReturnType<Fetcher> {
  const token = await copilotToken()
  if (!token) return fail('no GitHub token (github-copilot apps.json / gh hosts.yml)')
  const r = (await getJson('https://api.github.com/copilot_internal/user', {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mahas'
  })) as Record<string, unknown>
  const snaps = r.quota_snapshots as Record<string, Record<string, unknown>> | undefined
  const resetAt = str(r.quota_reset_date) ? Date.parse(str(r.quota_reset_date)!) : undefined
  const pretty = (id: string): string => id.replaceAll('_', ' ')
  const windows: UsageWindow[] = Object.entries(snaps ?? {}).map(([id, s]) => {
    const pctRem = num(s.percent_remaining)
    const ent = num(s.entitlement)
    const rem = num(s.quota_remaining) ?? num(s.remaining)
    return {
      id,
      label: pretty(id),
      usedPct: s.unlimited ? undefined : pctRem !== undefined ? 100 - pctRem : undefined,
      resetAt: num(s.quota_reset_at) ? num(s.quota_reset_at)! * 1000 : resetAt,
      detail: s.unlimited
        ? 'unlimited'
        : rem !== undefined && ent !== undefined && ent > 0
          ? `${Math.round(rem)} / ${Math.round(ent)} left`
          : num(s.overage_count)
            ? `+${num(s.overage_count)} overage`
            : undefined
    }
  })
  // premium interactions is the bucket that bites — hoist it first
  windows.sort((a, b) =>
    a.id === 'premium_interactions' ? -1 : b.id === 'premium_interactions' ? 1 : 0
  )
  if (!windows.length) return fail('no quota snapshots (copilot plan may not expose quotas)')
  return { plan: prettyPlan(r.copilot_plan), windows }
}

// ── zcode / z.ai ────────────────────────────────────────────────────────
// GLM coding-plan monitor endpoint. ZCode persists the key on the provider
// entry in ~/.zcode/v2/config.json; env vars still win when set.
async function zaiCreds(): Promise<{ key: string; base: string } | null> {
  const envKey = process.env.ZAI_API_KEY ?? process.env.ZHIPUAI_API_KEY
  if (envKey) {
    const base =
      process.env.ZHIPUAI_API_KEY && !process.env.ZAI_API_KEY
        ? 'https://open.bigmodel.cn'
        : 'https://api.z.ai'
    return { key: envKey, base }
  }
  const prefer = [
    'builtin:zai-coding-plan',
    'builtin:bigmodel-coding-plan',
    'builtin:zai',
    'zai',
    'builtin:bigmodel'
  ]
  for (const rel of [join('.zcode', 'v2', 'config.json'), join('.zcode', 'cli', 'config.json')]) {
    const cfg = await readJson(join(homedir(), rel))
    const prov = cfg?.provider as Record<string, Record<string, unknown>> | undefined
    if (!prov) continue
    const ids = [...prefer.filter((k) => prov[k]), ...Object.keys(prov)]
    for (const id of ids) {
      const opts = (prov[id]?.options ?? {}) as Record<string, unknown>
      const key = str(opts.apiKey)
      if (!key) continue
      const bu = str(opts.baseURL) ?? ''
      const base = bu.includes('bigmodel.cn') ? 'https://open.bigmodel.cn' : 'https://api.z.ai'
      return { key, base }
    }
  }
  return null
}

async function fetchZai(): ReturnType<Fetcher> {
  const creds = await zaiCreds()
  if (!creds) return fail('no Z.AI key (~/.zcode/v2/config.json or ZAI_API_KEY)')
  const { key, base } = creds
  const r = (await getJson(`${base}/api/monitor/usage/quota/limit`, {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json'
  })) as Record<string, unknown>
  const data = (r.data as Record<string, unknown> | undefined) ?? r
  const limits = data.limits as Record<string, unknown>[] | undefined
  const windows: UsageWindow[] = []
  if (Array.isArray(limits)) {
    for (const l of limits) {
      const type = str(l.type)
      const unit = num(l.unit)
      const number = num(l.number)
      const pct = num(l.percentage)
      const reset = num(l.nextResetTime)
      if (type === 'CREDIT_LIMIT' || type === 'TOKENS_LIMIT') {
        if (unit === 3 && number === 5)
          windows.push({ id: '5h', label: '5-hour window', usedPct: pct, resetAt: reset })
        else if (unit === 6)
          windows.push({ id: '7d', label: 'Weekly', usedPct: pct, resetAt: reset })
      } else if (type === 'TIME_LIMIT') {
        windows.push({ id: 'mcp', label: 'MCP tools · monthly', usedPct: pct, resetAt: reset })
      }
    }
  }
  // legacy flat shape fallback
  if (!windows.length) {
    if (num(data.fiveHourPercent) !== undefined)
      windows.push({ id: '5h', label: '5-hour window', usedPct: num(data.fiveHourPercent) })
    if (num(data.weeklyPercent) !== undefined)
      windows.push({ id: '7d', label: 'Weekly', usedPct: num(data.weeklyPercent) })
    if (num(data.monthlyMCPUsage) !== undefined)
      windows.push({ id: 'mcp', label: 'MCP tools · monthly', usedPct: num(data.monthlyMCPUsage) })
  }
  if (!windows.length) return fail('no coding-plan quota (pay-as-you-go or free tier)')
  return { plan: prettyPlan(data.level), windows }
}

// ── opencode (Go plan) ──────────────────────────────────────────────────
// Official GET /zen/go/v1/usage — same numbers as the Zen dashboard.
async function opencodeGoKey(): Promise<string | undefined> {
  const env = process.env.OPENCODE_API_KEY ?? process.env.OPENCODE_GO_API_KEY
  if (env) return env
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const auth = await readJson(join(xdg, 'opencode', 'auth.json'))
  if (!auth) return undefined
  for (const id of ['opencode-go', 'opencode']) {
    const rec = auth[id] as Record<string, unknown> | undefined
    const key = str(rec?.key)
    if (key) return key
  }
  return undefined
}

async function fetchOpencode(): ReturnType<Fetcher> {
  const key = await opencodeGoKey()
  if (!key) return fail('no OpenCode Go key (~/.local/share/opencode/auth.json)')
  const r = (await getJson('https://opencode.ai/zen/go/v1/usage', {
    Authorization: `Bearer ${key}`
  })) as Record<string, unknown>
  const usage = (r.usage as Record<string, unknown> | undefined) ?? r
  const win = (v: unknown, id: string, label: string): UsageWindow | null => {
    const w = v as Record<string, unknown> | undefined
    if (!w) return null
    const status = str(w.status)
    if (status && status !== 'ok') return null
    const pct = num(w.percent) ?? num(w.usagePercent)
    const resetAt =
      isoMs(w.resetsAt) ??
      (num(w.resetInSec) !== undefined ? Date.now() + num(w.resetInSec)! * 1000 : undefined)
    if (pct === undefined && resetAt === undefined) return null
    return { id, label, usedPct: pct, resetAt }
  }
  const windows = [
    win(usage.rolling ?? usage.rollingUsage, '5h', '5-hour window'),
    win(usage.weekly ?? usage.weeklyUsage, '7d', 'Weekly'),
    win(usage.monthly ?? usage.monthlyUsage, '30d', 'Monthly')
  ].filter((w): w is UsageWindow => !!w)
  if (!windows.length) return fail('empty OpenCode Go usage response')
  return { plan: prettyPlan('Go'), windows }
}

// ── devin ───────────────────────────────────────────────────────────────
// Connect-RPC GetUserStatus — the same call the CLI / desktop quota UI uses.
// Percentages arrive as remaining; we flip them to used. Unix resets are
// seconds. A credit of -1 is the vendor "unlimited" sentinel.
function parseTomlStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/\\"/g, '"')
  }
  return out
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function pick(o: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!o) return undefined
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]
  return undefined
}

function unixMs(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() ? Number(v) : num(v)
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined
  return n < 1e12 ? n * 1000 : n
}

function usedFromRemaining(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() ? Number(v) : num(v)
  if (n === undefined || !Number.isFinite(n)) return undefined
  return Math.max(0, Math.min(100, 100 - n))
}

async function fetchDevin(): ReturnType<Fetcher> {
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  let toml = ''
  try {
    toml = await readFile(join(xdg, 'devin', 'credentials.toml'), 'utf8')
  } catch {
    return fail(
      'no Devin credentials (~/.local/share/devin/credentials.toml) — run `devin auth login`'
    )
  }
  const kv = parseTomlStrings(toml)
  const key = kv.windsurf_api_key
  if (!key) return fail('Devin credentials.toml has no windsurf_api_key — run `devin auth login`')
  const host = (kv.api_server_url || 'https://server.codeium.com').replace(/\/+$/, '')
  // SeatManagementService is the Windsurf/Codeium endpoint. ideName "devin"
  // 500s ("unknown" internal error); vscode/windsurf identities succeed.
  const r = (await postJson(
    `${host}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
    { 'Connect-Protocol-Version': '1' },
    {
      metadata: {
        api_key: key,
        ide_name: 'vscode',
        ide_version: '1.96.0',
        extension_name: 'windsurf',
        extension_version: '1.0.0',
        locale: 'en'
      }
    }
  )) as Record<string, unknown>
  const user = rec(pick(r, 'userStatus', 'user_status')) ?? r
  const plan = rec(pick(user, 'planStatus', 'plan_status')) ?? {}
  const info =
    rec(pick(plan, 'planInfo', 'plan_info')) ?? rec(pick(r, 'planInfo', 'plan_info')) ?? {}
  const hideDaily = !!pick(info, 'hideDailyQuota', 'hide_daily_quota')
  const windows: UsageWindow[] = []
  const dailyUsed = usedFromRemaining(
    pick(plan, 'dailyQuotaRemainingPercent', 'daily_quota_remaining_percent')
  )
  const dailyReset = unixMs(pick(plan, 'dailyQuotaResetAtUnix', 'daily_quota_reset_at_unix'))
  if (!hideDaily && dailyUsed !== undefined) {
    windows.push({ id: 'day', label: 'Daily quota', usedPct: dailyUsed, resetAt: dailyReset })
  }
  const weekRem = pick(plan, 'weeklyQuotaRemainingPercent', 'weekly_quota_remaining_percent')
  const weekReset = unixMs(pick(plan, 'weeklyQuotaResetAtUnix', 'weekly_quota_reset_at_unix'))
  const weekUsed = usedFromRemaining(weekRem)
  if (weekUsed !== undefined) {
    windows.push({ id: 'week', label: 'Weekly quota', usedPct: weekUsed, resetAt: weekReset })
  } else if (weekReset !== undefined) {
    windows.push({ id: 'week', label: 'Weekly quota', usedPct: 100, resetAt: weekReset })
  }
  const acuUsed = num(pick(plan, 'acuConsumed', 'acu_consumed'))
  const acuLimit = num(pick(plan, 'acuLimit', 'acu_limit'))
  if (acuUsed !== undefined && acuLimit !== undefined && acuLimit > 0) {
    windows.push({
      id: 'acu',
      label: 'ACU',
      usedPct: Math.max(0, Math.min(100, (acuUsed / acuLimit) * 100)),
      detail: `${Math.round(acuUsed)} / ${Math.round(acuLimit)}`,
      resetAt: isoMs(pick(plan, 'planEnd', 'plan_end'))
    })
  }
  const bits: string[] = []
  const credit = (avail: unknown, used: unknown, label: string): void => {
    const a = num(avail)
    const u = num(used)
    if (a === -1 || u === -1) return
    if (a !== undefined && u !== undefined)
      bits.push(`${label} ${Math.round(u)}/${Math.round(a + u)}`)
    else if (a !== undefined) bits.push(`${label} ${Math.round(a)} left`)
  }
  credit(
    pick(plan, 'availablePromptCredits', 'available_prompt_credits'),
    pick(plan, 'usedPromptCredits', 'used_prompt_credits'),
    'prompt'
  )
  credit(
    pick(plan, 'availableFlowCredits', 'available_flow_credits'),
    pick(plan, 'usedFlowCredits', 'used_flow_credits'),
    'flow'
  )
  credit(
    pick(plan, 'availableFlexCredits', 'available_flex_credits'),
    pick(plan, 'usedFlexCredits', 'used_flex_credits'),
    'on-demand'
  )
  const micros = num(pick(plan, 'overageBalanceMicros', 'overage_balance_micros'))
  if (micros !== undefined && micros !== 0) bits.push(`extra $${(micros / 1_000_000).toFixed(2)}`)
  if (!windows.length && !bits.length) return fail('empty Devin usage response')
  return {
    plan:
      prettyPlan(pick(info, 'planName', 'plan_name')) ??
      prettyPlan(pick(user, 'teamsTier', 'teams_tier')),
    windows,
    extra: bits.join(' · ') || undefined
  }
}

const FETCHERS: Record<string, Fetcher> = {
  grok: fetchGrok,
  claude: fetchClaude,
  codex: fetchCodex,
  gemini: fetchGemini,
  copilot: fetchCopilot,
  zcode: fetchZai,
  opencode: fetchOpencode,
  devin: fetchDevin
}

export function registerUsageIpc(): void {
  ipcMain.handle('usage:fetch', async (_e, provider: string): Promise<UsageResult> => {
    const fetcher = FETCHERS[provider]
    const base = { provider, fetchedAt: Date.now() }
    if (!fetcher) return { ...base, ok: false, windows: [], error: 'unsupported' }
    try {
      const r = await fetcher()
      return { ...base, ok: !r.error, ...r }
    } catch (e) {
      return { ...base, ok: false, windows: [], error: String(e instanceof Error ? e.message : e) }
    }
  })
  ipcMain.handle(
    'usage:ledger',
    async (_e, tracked: LedgerQuery[], force?: boolean): Promise<LedgerResult> => {
      const list = Array.isArray(tracked)
        ? tracked.filter((t) => t && typeof t.sessionId === 'string')
        : []
      try {
        return await getLedger(list, !!force)
      } catch {
        return {
          profiles: [],
          sessions: list.map((t) => ({
            sessionId: t.sessionId,
            provider: t.provider,
            title: t.name,
            cwd: t.cwd,
            tokens: { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 },
            found: false
          })),
          fetchedAt: Date.now()
        }
      }
    }
  )
}
