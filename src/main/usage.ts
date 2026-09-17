// Per-harness usage/quota probes for the 'usage' widget. Each provider reads
// the credentials its own CLI left on disk and calls the same (undocumented,
// read-only) endpoint the CLI's own usage display uses:
//
//   claude  ~/.claude/.credentials.json   → GET api.anthropic.com/api/oauth/usage
//   codex   ~/.codex/auth.json            → GET chatgpt.com/backend-api/wham/usage
//   gemini  ~/.gemini/oauth_creds.json    → POST cloudcode-pa.googleapis.com/…:retrieveUserQuota
//   copilot gh/copilot token              → GET api.github.com/copilot_internal/user
//   zcode   ZAI_API_KEY env               → GET api.z.ai/api/monitor/usage/quota/limit
//
// Everything degrades honestly: missing creds / expired tokens / unsupported
// providers return { ok:false, error } — the widget renders the reason.

import { ipcMain, net } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { readFile } from 'fs/promises'

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

function fail(error: string): Omit<UsageResult, 'ok' | 'provider' | 'fetchedAt'> {
  return { windows: [], error }
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await net.fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const res = await net.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
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

// ── claude ──────────────────────────────────────────────────────────────
// The same endpoint Claude Code's /usage renders. The `anthropic-beta` +
// claude-code User-Agent headers are required — without them the request
// lands in an aggressively rate-limited bucket (persistent 429).
async function fetchClaude(): ReturnType<Fetcher> {
  const creds = await readJson(join(homedir(), '.claude', '.credentials.json'))
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
    'User-Agent': 'ade'
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
  return { plan: str(r.plan_type), windows, extra: bits.join(' · ') || undefined }
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
    'User-Agent': 'ade'
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
  return { plan: str(r.copilot_plan), windows }
}

// ── zcode / z.ai ────────────────────────────────────────────────────────
// GLM coding-plan monitor endpoint; keyed by the ZAI_API_KEY env var (zcode
// stores no reusable token file of its own).
async function fetchZai(): ReturnType<Fetcher> {
  const key = process.env.ZAI_API_KEY ?? process.env.ZHIPUAI_API_KEY
  if (!key) return fail('no ZAI_API_KEY / ZHIPUAI_API_KEY env')
  const base =
    process.env.ZHIPUAI_API_KEY && !process.env.ZAI_API_KEY
      ? 'https://open.bigmodel.cn'
      : 'https://api.z.ai'
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
  return { plan: str(data.level), windows }
}

const FETCHERS: Record<string, Fetcher> = {
  claude: fetchClaude,
  codex: fetchCodex,
  gemini: fetchGemini,
  copilot: fetchCopilot,
  zcode: fetchZai
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
}
