// Interactive sign-in flows for the usage widget's multi-account support.
// Ports phroner's credential/oauth.ts (PKCE + localhost callback + device
// flow) to Electron's net.fetch. A finished flow writes the provider's own
// credential file under userData/usage-accounts/<provider>/<slug>/ so the
// plain cred-path probes in usage.ts read it unchanged.
//
//   codex    PKCE → localhost:1455/auth/callback        → auth.json (codex shape)
//   grok     PKCE → 127.0.0.1:56121/callback            → auth.json (grok table)
//   gemini   PKCE → localhost:<free>/oauth2callback     → oauth_creds.json
//   claude   hosted callback shows `code#state`         → .credentials.json
//            (Anthropic's client registers no localhost redirect — the user
//            pastes the code back; its authorize page needs hex-only state)
//   copilot  GitHub device flow                         → apps.json
//   cline    WorkOS device flow → cline /auth/register   → providers.json
//   zcode / opencode / devin — API key input            → native file

import { app, ipcMain, net, shell } from 'electron'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'

const TIMEOUT_MS = 15_000
const FLOW_TTL_MS = 10 * 60 * 1000

const OPENAI = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorize: 'https://auth.openai.com/oauth/authorize',
  token: 'https://auth.openai.com/oauth/token',
  redirect: 'http://localhost:1455/auth/callback',
  scope: 'openid profile email offline_access'
}
const XAI = {
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  authorize: 'https://auth.x.ai/oauth2/authorize',
  token: 'https://auth.x.ai/oauth2/token',
  redirect: 'http://127.0.0.1:56121/callback',
  scope: 'openid profile email offline_access grok-cli:access api:access'
}
const GOOGLE = {
  // gemini-cli's public installed-app client (same pair usage.ts refreshes with)
  clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  clientSecret: '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',
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  scope:
    'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cloud-platform',
  path: '/oauth2callback'
}
const ANTHROPIC = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorize: 'https://claude.ai/oauth/authorize',
  token: 'https://console.anthropic.com/v1/oauth/token',
  redirect: 'https://console.anthropic.com/oauth/code/callback',
  scope: 'org:create_api_key user:profile user:inference'
}
const GITHUB = {
  // the "GitHub Copilot" OAuth app the editor plugins authenticate through
  clientId: 'Iv1.b507a08c87ecfe98',
  device: 'https://github.com/login/device/code',
  token: 'https://github.com/login/oauth/access_token',
  scope: 'read:user'
}
const CLINE = {
  // WorkOS device authorization → the pair is exchanged for Cline account
  // tokens at api.cline.bot/api/v1/auth/register (same path the CLI takes)
  workosClientId: 'client_01K3A541FN8TA3EPPHTD2325AR',
  workos: 'https://api.workos.com',
  api: 'https://api.cline.bot'
}

export type AuthMode = 'browser' | 'code' | 'device'
export interface AuthStart {
  flowId: string
  mode: AuthMode
  /** the authorize/verification page — already opened in the browser; kept
   *  for manual copy when the open fails */
  url?: string
  userCode?: string
  verificationUri?: string
}
export interface AuthDone {
  ok: boolean
  path?: string
  account?: string
  error?: string
}

type Flow = {
  provider: string
  mode: AuthMode
  url?: string
  userCode?: string
  verificationUri?: string
  at: number
  cancel: () => void
  /** browser/device flows resolve on their own; 'code' waits for the paste */
  finish: (code?: string) => Promise<{ path: string; account?: string }>
}
const flows = new Map<string, Flow>()

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function postForm(
  url: string,
  fields: Record<string, string>
): Promise<Record<string, unknown>> {
  const res = await net.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`)
  return JSON.parse(text) as Record<string, unknown>
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await net.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`)
  return JSON.parse(text) as Record<string, unknown>
}

async function getJson(
  url: string,
  headers: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  const res = await net.fetch(url, {
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`)
  return JSON.parse(text) as Record<string, unknown>
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** `{success, data}` envelope several provider APIs wrap results in */
const unwrap = (r: unknown): Record<string, unknown> | undefined => {
  if (!r || typeof r !== 'object') return undefined
  const o = r as Record<string, unknown>
  const d = o.data as Record<string, unknown> | undefined
  return d && typeof d === 'object' ? d : o
}

function jwtClaims(token: string | undefined): Record<string, unknown> {
  const part = token?.split('.')[1]
  if (!part) return {}
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

// ── cred-file writers (userData/usage-accounts/<provider>/<slug>/) ──────

function slug(v: string | undefined): string {
  const s = (v ?? '').replace(/[^a-zA-Z0-9._@-]+/g, '_').replace(/^_+|_+$/g, '')
  return s.slice(0, 64)
}

async function writeCred(
  provider: string,
  hint: string | undefined,
  files: Record<string, string>
): Promise<string> {
  const dir = join(
    app.getPath('userData'),
    'usage-accounts',
    provider,
    slug(hint) || `acct-${randomUUID().slice(0, 8)}`
  )
  await mkdir(dir, { recursive: true, mode: 0o700 })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, { mode: 0o600 })
  }
  return dir
}

const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n'

function writeCodex(tokens: Record<string, unknown>): { path: Promise<string>; account?: string } {
  const claims = jwtClaims(str(tokens.id_token))
  const accountId = str(
    (claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined)
      ?.chatgpt_account_id
  )
  return {
    account: str(claims.email),
    path: writeCred('codex', str(claims.email), {
      'auth.json': json({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: str(tokens.id_token),
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          account_id: accountId
        },
        last_refresh: new Date().toISOString()
      })
    })
  }
}

function writeGrok(tokens: Record<string, unknown>): { path: Promise<string>; account?: string } {
  const claims = jwtClaims(str(tokens.id_token))
  const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 21_600
  return {
    account: str(claims.email),
    path: writeCred('grok', str(claims.email), {
      'auth.json': json({
        [`https://auth.x.ai::${XAI.clientId}`]: {
          key: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
          oidc_issuer: 'https://auth.x.ai',
          oidc_client_id: XAI.clientId,
          email: str(claims.email)
        }
      })
    })
  }
}

function writeGemini(tokens: Record<string, unknown>): { path: Promise<string>; account?: string } {
  const claims = jwtClaims(str(tokens.id_token))
  const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600
  const email = str(claims.email)
  return {
    account: email,
    path: writeCred('gemini', email, {
      'oauth_creds.json': json({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: Date.now() + expiresIn * 1000,
        token_type: 'Bearer',
        scope: GOOGLE.scope
      }),
      // gemini-cli records the signed-in identity here — the fetcher reads it
      // back for the account label
      ...(email ? { 'google_accounts.json': json({ active: email, old: [] }) } : {})
    })
  }
}

function writeClaude(tokens: Record<string, unknown>): Promise<string> {
  const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 28_800
  return writeCred('claude', undefined, {
    '.credentials.json': json({
      claudeAiOauth: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + expiresIn * 1000,
        scopes: ANTHROPIC.scope.split(' ')
      }
    })
  })
}

function writeCopilot(token: string, user?: string): Promise<string> {
  return writeCred('copilot', user, {
    'apps.json': json({ 'github.com': { oauth_token: token } })
  })
}

/** cline's providers.json — the auth node is what usage.ts's cline reader
 *  digs out of providers.cline.settings.auth */
function writeCline(auth: Record<string, unknown>, email?: string): Promise<string> {
  return writeCred('cline', email, {
    'providers.json': json({
      version: 1,
      lastUsedProvider: 'cline',
      modes: {},
      providers: {
        cline: {
          settings: { provider: 'cline', auth },
          updatedAt: new Date().toISOString(),
          tokenSource: 'device'
        }
      }
    })
  })
}

/** API-key providers — the key lands in the provider's native file layout so
 *  the cred-path readers in usage.ts pick it up without special cases. */
export async function saveApiKey(
  provider: string,
  key: string,
  label?: string
): Promise<{ path?: string; error?: string }> {
  const k = key.trim()
  if (!k) return { error: 'empty key' }
  switch (provider) {
    case 'zcode':
      return {
        path: await writeCred('zcode', label, {
          'config.json': json({ provider: { zai: { options: { apiKey: k } } } })
        })
      }
    case 'opencode':
      return {
        path: await writeCred('opencode', label, {
          'auth.json': json({ 'opencode-go': { type: 'api', key: k } })
        })
      }
    case 'devin':
      return {
        path: await writeCred('devin', label, {
          'credentials.toml': `windsurf_api_key = "${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`
        })
      }
    case 'copilot':
      return { path: await writeCopilot(k, label) }
    default:
      return { error: 'provider has no api-key method' }
  }
}

// ── localhost callback (phroner waitForCallback port) ────────────────────

function listenCallback(
  redirectUrl: string,
  expectedState: string
): { code: Promise<{ code: string }>; port: Promise<number>; close: (reason?: string) => void } {
  const url = new URL(redirectUrl)
  const wantPath = url.pathname
  let settle!: (r: { code: string }) => void
  let fail!: (e: Error) => void
  const code = new Promise<{ code: string }>((res, rej) => {
    settle = res
    fail = rej
  })
  let settlePort!: (p: number) => void
  let failPort!: (e: Error) => void
  const boundPort = new Promise<number>((res, rej) => {
    settlePort = res
    failPort = rej
  })
  const server = createServer((req, res) => {
    try {
      const got = new URL(req.url ?? '/', `http://${url.hostname}`)
      if (got.pathname !== wantPath) {
        res.statusCode = 404
        res.end()
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end('<html><body>mahas sign-in complete. You can close this window.</body></html>')
      server.close()
      const err = got.searchParams.get('error')
      const gotCode = got.searchParams.get('code')
      if (err) fail(new Error(`authorize error: ${err}`))
      else if (got.searchParams.get('state') !== expectedState)
        fail(new Error('oauth state mismatch'))
      else if (!gotCode) fail(new Error('missing code'))
      else settle({ code: gotCode })
    } catch (e) {
      server.close()
      fail(e instanceof Error ? e : new Error(String(e)))
    }
  })
  server.once('error', (e) => {
    failPort(e)
    fail(e)
  })
  /* no host arg → dual-stack bind: browsers may reach 'localhost' over ::1
     while node resolved it to 127.0.0.1 (or vice versa) — the callback is
     gated by path+state either way */
  server.listen(Number(url.port) || 0, () => {
    const addr = server.address()
    settlePort(typeof addr === 'object' && addr ? addr.port : 0)
  })
  return {
    code,
    port: boundPort,
    close: (reason = 'cancelled') => {
      try {
        server.close()
      } catch {
        /* not listening */
      }
      fail(new Error(reason))
    }
  }
}

async function exchangePkce(
  conf: { token: string; redirect: string; clientId: string; clientSecret?: string },
  code: string,
  verifier: string
): Promise<Record<string, unknown>> {
  const fields: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: conf.redirect,
    client_id: conf.clientId,
    code_verifier: verifier
  }
  if (conf.clientSecret) fields.client_secret = conf.clientSecret
  return postForm(conf.token, fields)
}

/* await the callback port before opening the browser — a fixed-port clash
   (another login in flight) fails the start instead of stranding the user
   on an authorize page whose callback can't land */
async function startOpenai(): Promise<Flow> {
  const { verifier, challenge } = pkce()
  const state = b64url(randomBytes(16))
  const url = new URL(OPENAI.authorize)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', OPENAI.clientId)
  url.searchParams.set('redirect_uri', OPENAI.redirect)
  url.searchParams.set('scope', OPENAI.scope)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', 'mahas')
  const cb = listenCallback(OPENAI.redirect, state)
  await cb.port
  void shell.openExternal(url.toString()).catch(() => {})
  return {
    provider: 'codex',
    mode: 'browser',
    url: url.toString(),
    at: Date.now(),
    cancel: () => cb.close(),
    finish: async () => {
      const { code } = await cb.code
      const tokens = await exchangePkce(
        { token: OPENAI.token, redirect: OPENAI.redirect, clientId: OPENAI.clientId },
        code,
        verifier
      )
      const w = writeCodex(tokens)
      return { path: await w.path, account: w.account }
    }
  }
}

async function startXai(): Promise<Flow> {
  const { verifier, challenge } = pkce()
  const state = b64url(randomBytes(16))
  const url = new URL(XAI.authorize)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', XAI.clientId)
  url.searchParams.set('redirect_uri', XAI.redirect)
  url.searchParams.set('scope', XAI.scope)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('plan', 'generic')
  url.searchParams.set('referrer', 'mahas')
  const cb = listenCallback(XAI.redirect, state)
  await cb.port
  void shell.openExternal(url.toString()).catch(() => {})
  return {
    provider: 'grok',
    mode: 'browser',
    url: url.toString(),
    at: Date.now(),
    cancel: () => cb.close(),
    finish: async () => {
      const { code } = await cb.code
      const tokens = await exchangePkce(
        { token: XAI.token, redirect: XAI.redirect, clientId: XAI.clientId },
        code,
        verifier
      )
      const w = writeGrok(tokens)
      return { path: await w.path, account: w.account }
    }
  }
}

/** google installed-app flow — any free localhost port is a valid redirect */
async function startGoogle(): Promise<Flow> {
  const { verifier, challenge } = pkce()
  const state = b64url(randomBytes(16))
  const cb = listenCallback(`http://localhost${GOOGLE.path}`, state)
  const redirect = `http://localhost:${await cb.port}${GOOGLE.path}`
  const url = new URL(GOOGLE.authorize)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', GOOGLE.clientId)
  url.searchParams.set('redirect_uri', redirect)
  url.searchParams.set('scope', GOOGLE.scope)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  void shell.openExternal(url.toString()).catch(() => {})
  return {
    provider: 'gemini',
    mode: 'browser',
    url: url.toString(),
    at: Date.now(),
    cancel: () => cb.close(),
    finish: async () => {
      const { code } = await cb.code
      const tokens = await exchangePkce(
        {
          token: GOOGLE.token,
          redirect,
          clientId: GOOGLE.clientId,
          clientSecret: GOOGLE.clientSecret
        },
        code,
        verifier
      )
      const w = writeGemini(tokens)
      return { path: await w.path, account: w.account }
    }
  }
}

/** claude — hosted callback shows `<code>#<state>`; the user pastes it back */
function startClaude(): Flow {
  const { verifier, challenge } = pkce()
  const state = randomBytes(16).toString('hex')
  const url = new URL(ANTHROPIC.authorize)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', ANTHROPIC.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', ANTHROPIC.redirect)
  url.searchParams.set('scope', ANTHROPIC.scope)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  void shell.openExternal(url.toString()).catch(() => {})
  return {
    provider: 'claude',
    mode: 'code',
    url: url.toString(),
    at: Date.now(),
    cancel: () => {},
    finish: async (pasted) => {
      const [code, st] = (pasted ?? '').trim().split('#')
      if (!code) throw new Error('paste the code shown on the page')
      if (st && st !== state) throw new Error('state mismatch — restart the sign-in')
      const tokens = await postJson(ANTHROPIC.token, {
        grant_type: 'authorization_code',
        code,
        state,
        redirect_uri: ANTHROPIC.redirect,
        client_id: ANTHROPIC.clientId,
        code_verifier: verifier
      })
      return { path: await writeClaude(tokens) }
    }
  }
}

/** RFC 8628 device-token polling — shared by GitHub and WorkOS flavors */
async function pollDeviceToken(
  tokenUrl: string,
  fields: Record<string, string>,
  expiresInSec: number,
  intervalSec: number,
  isAborted: () => boolean
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + Math.max(60, expiresInSec) * 1000
  let interval = Math.max(3, intervalSec) * 1000
  while (Date.now() < deadline && !isAborted()) {
    await sleep(interval)
    let r: Record<string, unknown>
    try {
      r = await postForm(tokenUrl, fields)
    } catch (e) {
      // GitHub reports pending/slow_down inside a 200 body; WorkOS reports
      // them as 4xx JSON — either way they mean keep polling. Everything
      // else that also carries an error code is a real failure.
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('authorization_pending')) continue
      if (msg.includes('slow_down')) {
        interval += 5000
        continue
      }
      if (/"error"/.test(msg)) throw e
      continue // transient transport error — keep polling
    }
    if (str(r.access_token)) return r
    const err = str(r.error)
    if (err === 'slow_down') {
      interval += 5000
      continue
    }
    if (err && err !== 'authorization_pending') throw new Error(`device: ${err}`)
  }
  throw new Error(isAborted() ? 'cancelled' : 'device authorization timed out')
}

async function startCopilot(): Promise<Flow> {
  const dev = await postForm(GITHUB.device, {
    client_id: GITHUB.clientId,
    scope: GITHUB.scope
  })
  const deviceCode = str(dev.device_code)
  const userCode = str(dev.user_code)
  const verificationUri = str(dev.verification_uri)
  if (!deviceCode || !userCode || !verificationUri)
    throw new Error('github device code response incomplete')
  let aborted = false
  void shell.openExternal(verificationUri).catch(() => {})
  return {
    provider: 'copilot',
    mode: 'device',
    userCode,
    verificationUri,
    at: Date.now(),
    cancel: () => {
      aborted = true
    },
    finish: async () => {
      const r = await pollDeviceToken(
        GITHUB.token,
        {
          client_id: GITHUB.clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        },
        num(dev.expires_in) ?? 900,
        num(dev.interval) ?? 5,
        () => aborted
      )
      const token = str(r.access_token)!
      const login = await getJson('https://api.github.com/user', {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json'
      })
        .then((u) => str(u.login))
        .catch(() => undefined)
      return { path: await writeCopilot(token, login), account: login }
    }
  }
}

/** cline — WorkOS device authorization, then the token pair is exchanged
 *  for Cline account credentials at /api/v1/auth/register (mirrors the CLI) */
async function startCline(): Promise<Flow> {
  const dev = await postForm(`${CLINE.workos}/user_management/authorize/device`, {
    client_id: CLINE.workosClientId
  })
  const deviceCode = str(dev.device_code)
  const userCode = str(dev.user_code)
  const verificationUri = str(dev.verification_uri_complete) ?? str(dev.verification_uri)
  if (!deviceCode || !userCode || !verificationUri)
    throw new Error('workos device code response incomplete')
  let aborted = false
  void shell.openExternal(verificationUri).catch(() => {})
  return {
    provider: 'cline',
    mode: 'device',
    userCode,
    verificationUri,
    at: Date.now(),
    cancel: () => {
      aborted = true
    },
    finish: async () => {
      const r = await pollDeviceToken(
        `${CLINE.workos}/user_management/authenticate`,
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: CLINE.workosClientId
        },
        num(dev.expires_in) ?? 300,
        num(dev.interval) ?? 5,
        () => aborted
      )
      const accessToken = str(r.access_token)!
      const refreshToken = str(r.refresh_token)
      // WorkOS user pair → Cline account tokens (register tolerates a
      // {success, data} envelope either way)
      const reg = await postJson(`${CLINE.api}/api/v1/auth/register`, {
        accessToken,
        refreshToken
      })
      const d = unwrap(reg)
      const email = str((r.user as Record<string, unknown> | undefined)?.email) ?? str(d?.email)
      const expiresAt =
        num(d?.expiresAt) ??
        (num(d?.expires_in) !== undefined ? Date.now() + num(d?.expires_in)! * 1000 : undefined)
      const auth = {
        accessToken: str(d?.accessToken) ?? str(d?.access_token) ?? accessToken,
        refreshToken: str(d?.refreshToken) ?? str(d?.refresh_token) ?? refreshToken,
        expiresAt,
        accountId: str(d?.accountId) ?? str(d?.account_id),
        email,
        metadata: { provider: 'cline' }
      }
      return { path: await writeCline(auth, email), account: email }
    }
  }
}

const OAUTH_PROVIDERS = new Set(['codex', 'grok', 'gemini', 'claude', 'copilot', 'cline'])

// ── ipc ──────────────────────────────────────────────────────────────────

export function registerUsageAuthIpc(): void {
  ipcMain.handle('usage:authStart', async (_e, provider: string): Promise<AuthStart> => {
    if (!OAUTH_PROVIDERS.has(provider)) throw new Error(`no oauth flow for ${provider}`)
    const flow =
      provider === 'copilot'
        ? await startCopilot()
        : provider === 'cline'
          ? await startCline()
          : provider === 'claude'
            ? startClaude()
            : provider === 'codex'
              ? await startOpenai()
              : provider === 'grok'
                ? await startXai()
                : await startGoogle()
    const flowId = randomUUID()
    flows.set(flowId, flow)
    return {
      flowId,
      mode: flow.mode,
      url: flow.url,
      userCode: flow.userCode,
      verificationUri: flow.verificationUri
    }
  })

  ipcMain.handle(
    'usage:authFinish',
    async (_e, flowId: string, code?: string): Promise<AuthDone> => {
      const flow = flows.get(flowId)
      if (!flow) return { ok: false, error: 'flow not found or expired' }
      try {
        const r = await flow.finish(code)
        flows.delete(flowId)
        return { ok: true, path: r.path, account: r.account }
      } catch (e) {
        return { ok: false, error: String(e instanceof Error ? e.message : e) }
      }
    }
  )

  ipcMain.handle('usage:authCancel', (_e, flowId: string) => {
    const flow = flows.get(flowId)
    if (flow) {
      flow.cancel()
      flows.delete(flowId)
    }
    return { ok: true }
  })

  ipcMain.handle('usage:saveKey', async (_e, provider: string, key: string, label?: string) =>
    saveApiKey(provider, String(key ?? ''), typeof label === 'string' ? label : undefined)
  )

  /* account removal — delete the cred dir, but ONLY when it lives under the
     managed usage-accounts root; user-imported paths elsewhere stay put */
  ipcMain.handle('usage:discardCred', async (_e, path: string) => {
    const root = join(app.getPath('userData'), 'usage-accounts') + sep
    const p = String(path ?? '')
    if (!p.startsWith(root)) return { ok: false }
    await rm(p, { recursive: true, force: true })
    return { ok: true }
  })

  // stale flows (window closed mid-sign-in, abandoned browser tab) die on a timer
  setInterval(() => {
    const now = Date.now()
    for (const [id, f] of flows) {
      if (now - f.at > FLOW_TTL_MS) {
        f.cancel()
        flows.delete(id)
      }
    }
  }, 60_000).unref()
}
