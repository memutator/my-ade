import { createHash, randomBytes, randomUUID } from 'node:crypto'

// The locator surface lives in locators.mjs; re-exported here so a runtime that loads
// the auth entrypoint alone still finds the Pack's vendor catalog and parsers.
export { PROVIDER_LOCATORS, locatorCandidates, readLocatorMaterial } from './locators.mjs'

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
  clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  clientSecret: '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',
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  redirectPath: '/oauth2callback',
  scope:
    'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cloud-platform'
}
const ANTHROPIC = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorize: 'https://claude.ai/oauth/authorize',
  token: 'https://console.anthropic.com/v1/oauth/token',
  redirect: 'https://console.anthropic.com/oauth/code/callback',
  scope: 'org:create_api_key user:profile user:inference'
}
const GITHUB = {
  clientId: 'Iv1.b507a08c87ecfe98',
  device: 'https://github.com/login/device/code',
  token: 'https://github.com/login/oauth/access_token',
  scope: 'read:user'
}
const CLINE = {
  clientId: 'client_01K3A541FN8TA3EPPHTD2325AR',
  workos: 'https://api.workos.com',
  api: 'https://api.cline.bot'
}

export const AUTH_OFFERINGS = Object.freeze({
  'openai/chatgpt': { kind: 'pkce', config: OPENAI },
  'xai/grok': { kind: 'pkce', config: XAI },
  'google/cloud-code': { kind: 'pkce-dynamic', config: GOOGLE },
  'anthropic/claude': { kind: 'manual-code', config: ANTHROPIC },
  'github/copilot': { kind: 'device', config: GITHUB },
  'cline/account': { kind: 'cline-device', config: CLINE },
  'zai/coding-plan': { kind: 'api-key' },
  'opencode/go': { kind: 'api-key' },
  'windsurf/account': { kind: 'api-key' }
})

const str = (v) => (typeof v === 'string' && v ? v : undefined)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined)
const b64url = (value) => Buffer.from(value).toString('base64url')
const pkce = () => {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}
const jwt = (token) => {
  try {
    return (
      record(JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))) ??
      {}
    )
  } catch {
    return {}
  }
}
const unwrap = (value) => record(value?.data) ?? record(value) ?? {}

async function responseJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(15000)
  })
  const text = await response.text()
  let value
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`provider returned invalid JSON (HTTP ${response.status})`)
  }
  if (!response.ok) {
    const code = str(value.error) ?? str(value.code)
    const description = str(value.error_description) ?? str(value.message)
    const error = new Error(
      code ? `${code}${description ? `: ${description}` : ''}` : `provider HTTP ${response.status}`
    )
    error.providerCode = code
    throw error
  }
  return record(value) ?? {}
}

const form = (fetchImpl, url, fields, signal) =>
  responseJson(fetchImpl, url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    signal
  })
const json = (fetchImpl, url, body, signal, headers = {}) =>
  responseJson(fetchImpl, url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal
  })

function identityFromTokens(tokens) {
  const claims = jwt(tokens.id_token)
  const auth = record(claims['https://api.openai.com/auth'])
  return {
    email: str(claims.email),
    accountId: str(auth?.chatgpt_account_id) ?? str(tokens.account_id)
  }
}

function materialFor(offeringId, tokens, now) {
  const identity = identityFromTokens(tokens)
  const expiresIn = num(tokens.expires_in)
  if (offeringId === 'openai/chatgpt')
    return {
      material: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        accountId: identity.accountId,
        expiresAt: expiresIn ? now + expiresIn * 1000 : undefined
      },
      identity
    }
  if (offeringId === 'xai/grok')
    return {
      material: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        expiresAt: now + (expiresIn ?? 21600) * 1000,
        clientId: XAI.clientId
      },
      identity
    }
  if (offeringId === 'google/cloud-code')
    return {
      material: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: now + (expiresIn ?? 3600) * 1000,
        tokenType: 'Bearer',
        scope: GOOGLE.scope
      },
      identity
    }
  if (offeringId === 'anthropic/claude')
    return {
      material: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: now + (expiresIn ?? 28800) * 1000,
        scopes: ANTHROPIC.scope.split(' ')
      },
      identity
    }
  throw new Error(`unsupported token material for ${offeringId}`)
}

function claims(connectionId, identity, now) {
  return [
    identity.accountId && {
      id: `auth:${connectionId}:account:${encodeURIComponent(identity.accountId)}`,
      connectionId,
      kind: 'provider-account-id',
      value: identity.accountId,
      observedAt: now,
      confidence: 'observed',
      evidence: [{ description: 'authentication token claims' }]
    },
    identity.email && {
      id: `auth:${connectionId}:email:${encodeURIComponent(identity.email)}`,
      connectionId,
      kind: 'email',
      value: identity.email,
      observedAt: now,
      confidence: 'observed',
      evidence: [{ description: 'authentication token claims' }]
    }
  ].filter(Boolean)
}

function authorizeUrl(offeringId, config, redirect, challenge, state) {
  const url = new URL(config.authorize)
  if (offeringId === 'anthropic/claude') url.searchParams.set('code', 'true')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', redirect)
  url.searchParams.set('scope', config.scope)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  if (offeringId === 'openai/chatgpt') {
    url.searchParams.set('id_token_add_organizations', 'true')
    url.searchParams.set('codex_cli_simplified_flow', 'true')
    url.searchParams.set('originator', 'mahas')
  }
  if (offeringId === 'xai/grok') {
    url.searchParams.set('plan', 'generic')
    url.searchParams.set('referrer', 'mahas')
  }
  if (offeringId === 'google/cloud-code') {
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
  }
  return url.toString()
}

/**
 * Long-lived, in-memory coordinator. Secret values enter only through the
 * dedicated methods and are handed directly to secretStore.put/CAS; status
 * responses contain refs and identity claims, never material.
 */
export class ProviderAuthCoordinator {
  constructor({
    secretStore,
    fetch: fetchImpl = globalThis.fetch,
    now = Date.now,
    randomId = randomUUID,
    ttlMs = 600000
  } = {}) {
    if (!secretStore?.put || !secretStore?.compareAndSwap || !secretStore?.read)
      throw new Error('a secretStore with put/read/compareAndSwap is required')
    this.secretStore = secretStore
    this.fetch = fetchImpl
    this.now = now
    this.randomId = randomId
    this.ttlMs = ttlMs
    this.flows = new Map()
    this.refreshes = new Map()
  }

  async start({ offeringId, connectionId = 'pending', callbackRedirect }) {
    this.sweep()
    const definition = AUTH_OFFERINGS[offeringId]
    if (!definition) throw new Error(`unsupported offering ${offeringId}`)
    const id = this.randomId(),
      createdAt = this.now(),
      controller = new AbortController()
    const flow = {
      id,
      offeringId,
      connectionId,
      kind: definition.kind,
      createdAt,
      updatedAt: createdAt,
      status: 'pending',
      controller
    }
    if (definition.kind === 'api-key') {
      flow.status = 'needs-secret'
      this.flows.set(id, flow)
      return {
        flowId: id,
        state: 'needs-input',
        requiredInput: { kind: 'secret', label: 'API key' },
        expiresAt: createdAt + this.ttlMs
      }
    }
    if (definition.kind === 'device' || definition.kind === 'cline-device') {
      const config = definition.config
      const dev =
        definition.kind === 'device'
          ? await form(
              this.fetch,
              config.device,
              { client_id: config.clientId, scope: config.scope },
              controller.signal
            )
          : await form(
              this.fetch,
              `${config.workos}/user_management/authorize/device`,
              { client_id: config.clientId },
              controller.signal
            )
      flow.deviceCode = str(dev.device_code)
      flow.interval = num(dev.interval) ?? 5
      flow.expiresIn = num(dev.expires_in) ?? 900
      if (
        !flow.deviceCode ||
        !str(dev.user_code) ||
        !(str(dev.verification_uri_complete) ?? str(dev.verification_uri))
      )
        throw new Error('device authorization response incomplete')
      this.flows.set(id, flow)
      return {
        flowId: id,
        state: 'effect-required',
        effect: {
          kind: 'open-browser',
          url: str(dev.verification_uri_complete) ?? str(dev.verification_uri)
        },
        requiredInput: {
          kind: 'device',
          userCode: str(dev.user_code),
          verificationUri: str(dev.verification_uri)
        },
        expiresAt: createdAt + Math.min(this.ttlMs, flow.expiresIn * 1000)
      }
    }
    const config = definition.config,
      pair = pkce(),
      state =
        offeringId === 'anthropic/claude'
          ? randomBytes(16).toString('hex')
          : b64url(randomBytes(16))
    const redirect = definition.kind === 'pkce-dynamic' ? callbackRedirect : config.redirect
    if (!redirect) throw new Error('callbackRedirect is required for Google PKCE')
    flow.verifier = pair.verifier
    flow.oauthState = state
    flow.redirect = redirect
    this.flows.set(id, flow)
    const url = authorizeUrl(offeringId, config, redirect, pair.challenge, state)
    return {
      flowId: id,
      state: 'effect-required',
      effect: { kind: 'open-browser', url },
      ...(definition.kind === 'manual-code'
        ? { requiredInput: { kind: 'authorization-code', separator: '#', state } }
        : { requiredInput: { kind: 'localhost-callback', redirect, state } }),
      expiresAt: createdAt + this.ttlMs
    }
  }

  async submitCode(flowId, submitted) {
    const flow = this.#flow(flowId)
    if (!['pkce', 'pkce-dynamic', 'manual-code'].includes(flow.kind))
      throw new Error('flow does not accept an authorization code')
    const value = String(submitted ?? '').trim(),
      [code, pastedState] = value.split('#')
    if (!code) throw new Error('authorization code is required')
    if (pastedState && pastedState !== flow.oauthState) throw new Error('oauth state mismatch')
    const definition = AUTH_OFFERINGS[flow.offeringId],
      config = definition.config
    const body = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: flow.redirect,
      client_id: config.clientId,
      code_verifier: flow.verifier
    }
    if (config.clientSecret) body.client_secret = config.clientSecret
    const tokens =
      flow.kind === 'manual-code'
        ? await json(
            this.fetch,
            config.token,
            { ...body, state: flow.oauthState },
            flow.controller.signal
          )
        : await form(this.fetch, config.token, body, flow.controller.signal)
    return this.#completeTokens(flow, tokens)
  }

  async submitSecret(flowId, secret) {
    const flow = this.#flow(flowId)
    if (flow.kind !== 'api-key') throw new Error('flow does not accept a secret')
    const apiKey = String(secret ?? '').trim()
    if (!apiKey) throw new Error('API key is empty')
    return this.#persist(flow, { apiKey }, {})
  }

  async poll(flowId) {
    const flow = this.#flow(flowId)
    if (flow.status === 'complete') return flow.publicResult
    if (!['device', 'cline-device'].includes(flow.kind))
      return { flowId, state: flow.status === 'pending' ? 'needs-input' : flow.status }
    const definition = AUTH_OFFERINGS[flow.offeringId],
      elapsed = this.now() - flow.createdAt
    if (elapsed > Math.min(this.ttlMs, flow.expiresIn * 1000))
      return this.cancel(flowId, 'device authorization timed out')
    if (flow.nextPollAt && this.now() < flow.nextPollAt)
      return {
        flowId,
        state: 'needs-input',
        requiredInput: { kind: 'device-poll', retryAt: flow.nextPollAt }
      }
    flow.nextPollAt = this.now() + flow.interval * 1000
    try {
      const config = definition.config
      const tokens =
        flow.kind === 'device'
          ? await form(
              this.fetch,
              config.token,
              {
                client_id: config.clientId,
                device_code: flow.deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
              },
              flow.controller.signal
            )
          : await form(
              this.fetch,
              `${config.workos}/user_management/authenticate`,
              {
                client_id: config.clientId,
                device_code: flow.deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
              },
              flow.controller.signal
            )
      // GitHub's device endpoint reports pending/slow-down in a 200 body rather
      // than a status code; both shapes must behave the same or the poll spins.
      const pending = str(tokens.error)
      if (pending === 'authorization_pending')
        return {
          flowId,
          state: 'needs-input',
          requiredInput: { kind: 'device-poll', retryAt: flow.nextPollAt }
        }
      if (pending === 'slow_down') {
        flow.interval += 5
        flow.nextPollAt = this.now() + flow.interval * 1000
        return {
          flowId,
          state: 'needs-input',
          requiredInput: { kind: 'device-poll', retryAt: flow.nextPollAt }
        }
      }
      if (pending) {
        const description = str(tokens.error_description)
        throw Object.assign(new Error(description ? pending + ': ' + description : pending), {
          providerCode: pending
        })
      }
      if (!str(tokens.access_token))
        return {
          flowId,
          state: 'needs-input',
          requiredInput: { kind: 'device-poll', retryAt: flow.nextPollAt }
        }
      if (flow.kind === 'device') {
        const user = await responseJson(this.fetch, 'https://api.github.com/user', {
          headers: {
            accept: 'application/vnd.github+json',
            Authorization: `Bearer ${tokens.access_token}`
          },
          signal: flow.controller.signal
        }).catch(() => ({}))
        return this.#persist(
          flow,
          { accessToken: tokens.access_token },
          { accountId: str(user.login) }
        )
      }
      const registration = unwrap(
        await json(
          this.fetch,
          `${config.api}/api/v1/auth/register`,
          { accessToken: tokens.access_token, refreshToken: tokens.refresh_token },
          flow.controller.signal
        )
      )
      const user = record(tokens.user) ?? {}
      const identity = {
        email: str(user.email) ?? str(registration.email),
        accountId: str(registration.accountId) ?? str(registration.account_id)
      }
      return this.#persist(
        flow,
        {
          accessToken:
            str(registration.accessToken) ?? str(registration.access_token) ?? tokens.access_token,
          refreshToken:
            str(registration.refreshToken) ??
            str(registration.refresh_token) ??
            tokens.refresh_token,
          expiresAt:
            num(registration.expiresAt) ??
            (num(registration.expires_in)
              ? this.now() + num(registration.expires_in) * 1000
              : undefined),
          accountId: identity.accountId,
          email: identity.email
        },
        identity
      )
    } catch (error) {
      const code = error?.providerCode
      if (code === 'authorization_pending')
        return {
          flowId,
          state: 'needs-input',
          requiredInput: { kind: 'device-poll', retryAt: flow.nextPollAt }
        }
      if (code === 'slow_down') {
        flow.interval += 5
        flow.nextPollAt = this.now() + flow.interval * 1000
        return {
          flowId,
          state: 'needs-input',
          requiredInput: { kind: 'device-poll', retryAt: flow.nextPollAt }
        }
      }
      throw error
    }
  }

  cancel(flowId, reason = 'cancelled') {
    const flow = this.flows.get(flowId)
    if (!flow) return { flowId, state: 'unknown' }
    flow.controller.abort()
    flow.status = 'cancelled'
    this.flows.delete(flowId)
    return { flowId, state: 'failed', error: reason }
  }

  status(flowId) {
    const flow = this.flows.get(flowId)
    if (!flow) return { flowId, state: 'unknown' }
    return (
      flow.publicResult ?? {
        flowId,
        state: flow.status === 'pending' ? 'needs-input' : flow.status,
        expiresAt: flow.createdAt + this.ttlMs
      }
    )
  }

  async refresh({ credentialRef, expectedMaterialRevision, offeringId, connectionId }) {
    if (!credentialRef || !Number.isSafeInteger(expectedMaterialRevision))
      throw new Error('credentialRef and expectedMaterialRevision are required')
    const prior = this.refreshes.get(credentialRef) ?? Promise.resolve()
    const work = prior
      .catch(() => {})
      .then(async () => {
        const current = await this.secretStore.read(credentialRef)
        if (!current || current.revision !== expectedMaterialRevision)
          return { state: 'failed', conflict: true, currentRevision: current?.revision }
        const material = current.material,
          refreshToken = str(material.refreshToken)
        if (!refreshToken) throw new Error('credential has no refresh token')
        let tokens
        if (offeringId === 'cline/account')
          tokens = unwrap(
            await json(this.fetch, `${CLINE.api}/api/v1/auth/refresh`, {
              refreshToken,
              grantType: 'refresh_token'
            })
          )
        else {
          const definition = AUTH_OFFERINGS[offeringId],
            config = definition?.config
          if (!config?.token) throw new Error(`offering ${offeringId} has no refresh flow`)
          const fields = {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: config.clientId
          }
          if (config.clientSecret) fields.client_secret = config.clientSecret
          tokens = await form(this.fetch, config.token, fields)
        }
        const next =
          offeringId === 'cline/account'
            ? {
                ...material,
                accessToken: str(tokens.accessToken) ?? str(tokens.access_token),
                refreshToken: str(tokens.refreshToken) ?? str(tokens.refresh_token) ?? refreshToken,
                expiresAt:
                  num(tokens.expiresAt) ??
                  (num(tokens.expires_in)
                    ? this.now() + num(tokens.expires_in) * 1000
                    : material.expiresAt)
              }
            : {
                ...material,
                ...materialFor(offeringId, tokens, this.now()).material,
                refreshToken: str(tokens.refresh_token) ?? refreshToken
              }
        const changed = await this.secretStore.compareAndSwap(
          credentialRef,
          expectedMaterialRevision,
          next
        )
        return changed.ok
          ? {
              state: 'complete',
              credentialChange: {
                kind: 'refresh',
                materialRef: credentialRef,
                previousRevision: expectedMaterialRevision,
                materialRevision: changed.revision
              },
              identityClaims: claims(connectionId, identityFromTokens(tokens), this.now())
            }
          : { state: 'failed', conflict: true, currentRevision: changed.revision }
      })
    this.refreshes.set(credentialRef, work)
    try {
      return await work
    } finally {
      if (this.refreshes.get(credentialRef) === work) this.refreshes.delete(credentialRef)
    }
  }

  sweep() {
    for (const [id, flow] of this.flows)
      if (this.now() - flow.createdAt > this.ttlMs) this.cancel(id, 'expired')
  }

  /**
   * Loopback shape for this offering: the daemon's service binds the listener.
   * null means the flow never receives a browser redirect (manual code, device,
   * api key) and the caller must not open a socket for it.
   */
  callbackSpec(offeringId) {
    const definition = AUTH_OFFERINGS[offeringId]
    if (!definition?.config) return null
    const config = definition.config
    if (definition.kind === 'pkce-dynamic') {
      return { mode: 'dynamic', host: '127.0.0.1', path: config.redirectPath }
    }
    if (definition.kind !== 'pkce' || !config.redirect) return null
    const url = new URL(config.redirect)
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
    return {
      mode: 'provider-registered',
      host: url.hostname,
      port,
      path: url.pathname,
      redirect: config.redirect
    }
  }

  /** Live flows for the service status projection; never carries material. */
  list() {
    return [...this.flows.values()].map(
      (flow) =>
        flow.publicResult ?? {
          flowId: flow.id,
          state: flow.status === 'pending' ? 'needs-input' : flow.status,
          expiresAt: flow.createdAt + this.ttlMs
        }
    )
  }

  #flow(id) {
    this.sweep()
    const flow = this.flows.get(id)
    if (!flow) throw new Error('flow not found or expired')
    return flow
  }
  async #completeTokens(flow, tokens) {
    const { material, identity } = materialFor(flow.offeringId, tokens, this.now())
    return this.#persist(flow, material, identity)
  }
  async #persist(flow, material, identity) {
    const saved = await this.secretStore.put({
      offeringId: flow.offeringId,
      material,
      ownership: 'mahas'
    })
    flow.status = 'complete'
    flow.publicResult = {
      flowId: flow.id,
      state: 'complete',
      credentialChange: {
        kind: 'create',
        materialRef: saved.ref,
        materialRevision: saved.revision,
        ownership: 'mahas'
      },
      identityClaims: claims(flow.connectionId, identity, this.now())
    }
    return flow.publicResult
  }
}

// The generic Pack runner deliberately cannot transport auth secrets. The
// runtime imports ProviderAuthCoordinator and exposes dedicated start/submit/
// poll/cancel methods; an accidental generic invocation returns no material.
async function main() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const now = Date.now()
  process.stdout.write(
    JSON.stringify({
      protocolVersion: request.protocolVersion,
      operationId: request.operationId,
      capability: request.capability,
      target: request.target,
      contract: request.contract,
      pack: request.pack,
      status: 'failed',
      diagnostics: [
        {
          code: 'auth.dedicated-channel-required',
          severity: 'error',
          message: 'Authentication must use the persistent dedicated auth coordinator'
        }
      ],
      startedAt: now,
      completedAt: now
    }) + '\n'
  )
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main()
