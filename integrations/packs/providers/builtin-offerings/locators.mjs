// locators.mjs — the vendor half of credential discovery.
//
// Which file an offering already has, who owns it, and how to read it are vendor
// facts, so they live here next to the quota/auth implementations instead of in the
// runtime. The runtime passes in a file-io port and gets back plain material; it
// never learns a path pattern or a provider's JSON shape.

import providerLocators from './providers.json' with { type: 'json' }

export const PROVIDER_LOCATORS = providerLocators

const rec = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const str = (v) => (typeof v === 'string' && v.trim() ? v : undefined)
const pick = (o, ...keys) => {
  if (!o) return undefined
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]
  return undefined
}
const epoch = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    if (Number.isFinite(n)) return epoch(n)
    const parsed = Date.parse(v)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}
const defined = (values) => {
  const out = {}
  for (const [k, v] of Object.entries(values)) if (v !== undefined) out[k] = v
  return out
}
const jsonOf = (raw) => {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  const object = rec(parsed)
  if (!object) throw new Error('credential file must contain a JSON object')
  return object
}

function zaiProvider(providers) {
  for (const key of ['builtin:zai-coding-plan', 'builtin:zai', 'zai', 'z.ai', 'zai-coding-plan']) {
    const candidate = rec(pick(providers, key))
    if (!candidate) continue
    const options = rec(pick(candidate, 'options')) ?? candidate
    if (str(pick(options, 'apiKey', 'api_key', 'key'))) {
      return defined({
        ...options,
        baseUrl: str(pick(candidate, 'baseURL', 'baseUrl', 'base_url'))
      })
    }
  }
  return null
}

/**
 * Translate one provider-owned file into the shared credential material shape.
 * Throws when the file does not carry what the offering needs.
 */
export function readLocatorMaterial(format, raw) {
  switch (format) {
    case 'codex-auth-json': {
      const root = jsonOf(raw)
      const tokens = rec(root.tokens) ?? root
      return defined({
        accessToken: str(pick(tokens, 'access_token', 'accessToken')),
        refreshToken: str(pick(tokens, 'refresh_token', 'refreshToken')),
        idToken: str(pick(tokens, 'id_token', 'idToken')),
        accountId: str(pick(tokens, 'account_id', 'accountId'))
      })
    }
    case 'grok-auth-json': {
      const root = jsonOf(raw)
      const entry =
        rec(pick(root, 'https://auth.x.ai', 'auth.x.ai', 'xai')) ??
        Object.values(root)
          .map(rec)
          .find((value) => !!str(pick(value, 'key', 'access_token'))) ??
        null
      return defined({
        accessToken: str(pick(entry, 'key', 'access_token', 'accessToken')),
        refreshToken: str(pick(entry, 'refresh_token', 'refreshToken')),
        expiresAt: epoch(pick(entry, 'expires_at', 'expiresAt')),
        clientId: str(pick(entry, 'oidc_client_id', 'clientId')),
        email: str(pick(entry, 'email'))
      })
    }
    case 'gemini-oauth-json': {
      const root = jsonOf(raw)
      return defined({
        accessToken: str(pick(root, 'access_token', 'accessToken')),
        refreshToken: str(pick(root, 'refresh_token', 'refreshToken')),
        expiresAt: epoch(pick(root, 'expiry_date', 'expiresAt')),
        scope: str(pick(root, 'scope'))
      })
    }
    case 'claude-credentials-json': {
      const root = jsonOf(raw)
      const oauth = rec(pick(root, 'claudeAiOauth', 'claudeAiOauthTokens')) ?? root
      const scopes = pick(oauth, 'scopes', 'scope')
      return defined({
        accessToken: str(pick(oauth, 'accessToken', 'access_token')),
        refreshToken: str(pick(oauth, 'refreshToken', 'refresh_token')),
        expiresAt: epoch(pick(oauth, 'expiresAt', 'expires_at')),
        scopes: Array.isArray(scopes)
          ? scopes.filter((value) => typeof value === 'string')
          : undefined
      })
    }
    case 'github-apps-json': {
      const root = jsonOf(raw)
      const host = rec(pick(root, 'github.com')) ?? rec(Object.values(root).map(rec)[0]) ?? null
      return defined({
        accessToken: str(pick(host, 'oauth_token', 'access_token', 'token')),
        providerOrigin: 'github.com'
      })
    }
    case 'cline-providers-json': {
      const root = jsonOf(raw)
      const cline = rec(pick(rec(pick(root, 'providers')), 'cline')) ?? root
      const settings = rec(pick(cline, 'settings')) ?? cline
      const auth = rec(pick(settings, 'auth')) ?? settings
      return defined({
        accessToken: str(pick(auth, 'accessToken', 'access_token')),
        refreshToken: str(pick(auth, 'refreshToken', 'refresh_token')),
        accountId: str(pick(auth, 'accountId', 'account_id', 'id')),
        email: str(pick(auth, 'email')),
        expiresAt: epoch(pick(auth, 'expiresAt', 'expires_at'))
      })
    }
    case 'opencode-auth-json': {
      const root = jsonOf(raw)
      const entry = rec(pick(root, 'opencode-go', 'opencode')) ?? root
      return defined({
        apiKey: str(pick(entry, 'key', 'apiKey', 'api_key')),
        baseUrl: str(pick(entry, 'baseUrl', 'base_url', 'url'))
      })
    }
    case 'zai-config-json': {
      const root = jsonOf(raw)
      const candidate = zaiProvider(rec(pick(root, 'providers'))) ?? root
      return defined({
        apiKey: str(pick(candidate, 'apiKey', 'api_key', 'key', 'apiKeyValue')),
        baseUrl: str(pick(candidate, 'baseUrl', 'base_url', 'base', 'url'))
      })
    }
    case 'windsurf-credentials-toml': {
      const strings = {}
      for (const line of String(raw).split('\n')) {
        const match = /^\s*([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/.exec(line)
        if (match) strings[match[1]] = match[2].replace(/\\"/g, '"')
      }
      const apiKey =
        strings.windsurf_api_key ?? strings.api_key ?? strings.apiKey ?? Object.values(strings)[0]
      return defined({ apiKey })
    }
    default:
      throw new Error('unsupported credential material format: ' + String(format))
  }
}

function normalizeSlashes(path) {
  return path
    .split('/')
    .filter((part) => part !== '')
    .join('/') === path
    ? path
    : path
        .split('/')
        .filter((part, index) => part !== '' || index === 0)
        .join('/')
}

function baseDirectory(base, roots) {
  if (base === 'config') return roots.configHome
  if (base === 'data') return roots.dataHome
  if (base === 'usage-accounts') return roots.usageAccountsRoot
  return roots.home
}

/**
 * The desktop keeps its own per-account copies under
 * <userData>/usage-accounts/<provider>/<slug>/<file>. That directory is not guessable from
 * the daemon, so it only contributes when composition passes the explicit root; without it
 * these entries are skipped entirely rather than approximated.
 */
const USAGE_ACCOUNT_DIRECTORIES = {
  'openai/chatgpt': 'codex',
  'xai/grok': 'grok',
  'google/cloud-code': 'gemini',
  'anthropic/claude': 'claude',
  'github/copilot': 'copilot',
  'cline/account': 'cline',
  'opencode/go': 'opencode'
}

/**
 * Credential files that already exist for this catalog. Each entry carries the
 * absolute path, the format to parse it with, and the ownership that decides who may
 * rewrite it: a harness-owned file stays read-only.
 */
export function locatorCandidates(catalog, roots) {
  const candidates = []
  for (const [offeringId, entry] of Object.entries(catalog)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (!Array.isArray(entry.locations) || !Array.isArray(entry.fileNames)) continue
    for (const location of entry.locations) {
      const directory = [baseDirectory(location.base, roots), String(location.path ?? '')]
        .filter((part) => part !== undefined && part !== '')
        .join('/')
      for (const fileName of entry.fileNames) {
        candidates.push({
          offeringId,
          format: entry.format,
          ownership: entry.ownership === 'external' ? 'external' : 'user',
          label: String(entry.label ?? offeringId),
          path: normalizeSlashes(directory + '/' + fileName)
        })
      }
    }
  }
  if (roots.usageAccountsRoot) {
    for (const [offeringId, directory] of Object.entries(USAGE_ACCOUNT_DIRECTORIES)) {
      const entry = catalog[offeringId]
      if (!entry || !Array.isArray(entry.fileNames)) continue
      for (const fileName of entry.fileNames) {
        candidates.push({
          offeringId,
          format: entry.format,
          // Another application owns these copies: read-only, and never the rotation target.
          ownership: 'external',
          label: 'desktop usage-accounts / ' + directory,
          // One directory per account, so the runtime expands the account level itself
          // (the Pack has no filesystem port and cannot list directories).
          directory: normalizeSlashes(roots.usageAccountsRoot + '/' + directory),
          fileName,
          fanout: true
        })
      }
    }
  }
  return candidates
}
