import assert from 'node:assert/strict'
import test from 'node:test'
import { ProviderAuthCoordinator } from './auth.mjs'

class MemorySecrets {
  records = new Map()
  sequence = 0
  async put({ material }) {
    const ref = `secret:${++this.sequence}`
    this.records.set(ref, { revision: 1, material })
    return { ref, revision: 1 }
  }
  async read(ref) {
    return this.records.get(ref) ?? null
  }
  async compareAndSwap(ref, expected, material) {
    const row = this.records.get(ref)
    if (row.revision !== expected) return { ok: false, revision: row.revision }
    const revision = expected + 1
    this.records.set(ref, { revision, material })
    return { ok: true, revision }
  }
}

const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`
const response = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

test('api key travels only into secret storage', async () => {
  const secrets = new MemorySecrets(),
    auth = new ProviderAuthCoordinator({ secretStore: secrets, randomId: () => 'flow-key' })
  const start = await auth.start({ offeringId: 'zai/coding-plan' })
  assert.equal(start.requiredInput.kind, 'secret')
  const done = await auth.submitSecret(start.flowId, 'highly-secret')
  assert.equal(JSON.stringify(done).includes('highly-secret'), false)
  assert.equal(
    secrets.records.get(done.credentialChange.materialRef).material.apiKey,
    'highly-secret'
  )
})

test('manual PKCE validates state and stores tokens without returning them', async () => {
  const secrets = new MemorySecrets(),
    idToken = jwt({ email: 'person@example.test' })
  const auth = new ProviderAuthCoordinator({
    secretStore: secrets,
    randomId: () => 'flow-code',
    fetch: async () =>
      response({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        id_token: idToken,
        expires_in: 100
      })
  })
  const start = await auth.start({ offeringId: 'anthropic/claude', connectionId: 'connection-1' })
  await assert.rejects(auth.submitCode(start.flowId, 'code#wrong'), /state mismatch/)
  const done = await auth.submitCode(start.flowId, `code#${start.requiredInput.state}`)
  assert.equal(done.state, 'complete')
  assert.equal(JSON.stringify(done).includes('access-secret'), false)
})

test('device polling and serialized refresh use revision CAS', async () => {
  const secrets = new MemorySecrets()
  let calls = 0
  const requested = []
  const fetch = async (url) => {
    requested.push(String(url))
    if (String(url).includes('/device/code'))
      return response({
        device_code: 'dev',
        user_code: 'ABCD',
        verification_uri: 'https://verify.test',
        interval: 0,
        expires_in: 60
      })
    if (String(url).includes('/access_token')) {
      calls++
      return response(
        calls === 1 ? { error: 'authorization_pending' } : { access_token: 'device-secret' }
      )
    }
    if (String(url).endsWith('/user')) return response({ login: 'octocat' })
    if (String(url).includes('googleapis.com/token'))
      return response({
        access_token: 'new-' + calls++,
        refresh_token: 'next-refresh',
        expires_in: 100
      })
    return response({}, 404)
  }
  let now = 1000
  const auth = new ProviderAuthCoordinator({
    secretStore: secrets,
    fetch,
    now: () => now,
    randomId: () => 'flow-device'
  })
  const start = await auth.start({ offeringId: 'github/copilot' })
  assert.equal((await auth.poll(start.flowId)).state, 'needs-input')
  now += 6000
  const done = await auth.poll(start.flowId)
  assert.equal(done.state, 'complete')

  const seeded = await secrets.put({ material: { refreshToken: 'old' } })
  const [a, b] = await Promise.all([
    auth.refresh({
      credentialRef: seeded.ref,
      expectedMaterialRevision: 1,
      offeringId: 'google/cloud-code',
      connectionId: 'c'
    }),
    auth.refresh({
      credentialRef: seeded.ref,
      expectedMaterialRevision: 1,
      offeringId: 'google/cloud-code',
      connectionId: 'c'
    })
  ])
  assert.deepEqual([a.state, b.state].sort(), ['complete', 'failed'])
  assert.ok(a.conflict || b.conflict)
  assert.ok(
    requested.includes('https://oauth2.googleapis.com/token'),
    'refresh must call the provider token endpoint'
  )
})

test('device polling slows down, then reports expiry as a failure', async () => {
  let now = 1_000
  const fetch = async (url) => {
    if (String(url).includes('/device/code'))
      return response({
        device_code: 'dev',
        user_code: 'ABCD',
        verification_uri: 'https://verify.test',
        interval: 5,
        expires_in: 30
      })
    if (String(url).includes('/access_token'))
      return response({ error: 'slow_down', error_description: 'polling too fast' }, 200)
    return response({}, 404)
  }
  const auth = new ProviderAuthCoordinator({
    secretStore: new MemorySecrets(),
    fetch,
    now: () => now,
    randomId: () => 'flow-slow'
  })
  const start = await auth.start({ offeringId: 'github/copilot' })
  const first = await auth.poll(start.flowId)
  assert.equal(first.state, 'needs-input')
  const retryAfter = first.requiredInput.retryAt
  assert.equal(retryAfter - now, 10_000, 'slow_down adds five seconds to the interval')
  now = retryAfter + 1
  const second = await auth.poll(start.flowId)
  assert.equal(second.requiredInput.retryAt - now, 15_000)
  now = start.expiresAt + 1
  const expired = await auth.poll(start.flowId)
  assert.equal(expired.state, 'failed')
  assert.match(expired.error, /timed out/)
})

test('callbackSpec describes loopback shape without exposing material', async () => {
  const auth = new ProviderAuthCoordinator({ secretStore: new MemorySecrets() })
  const codex = auth.callbackSpec('openai/chatgpt')
  assert.equal(codex.mode, 'provider-registered')
  assert.equal(codex.redirect, 'http://localhost:1455/auth/callback')
  assert.equal(codex.port, 1455)
  const gemini = auth.callbackSpec('google/cloud-code')
  assert.equal(gemini.mode, 'dynamic')
  assert.equal(gemini.path, '/oauth2callback')
  assert.equal(auth.callbackSpec('anthropic/claude'), null)
  assert.equal(auth.callbackSpec('zai/coding-plan'), null)
  assert.equal(JSON.stringify([codex, gemini]).includes('secret'), false)
})

test('api-key flows complete without any provider round trip', async () => {
  const secrets = new MemorySecrets()
  const auth = new ProviderAuthCoordinator({
    secretStore: secrets,
    randomId: () => 'flow-key-only',
    fetch: async () => {
      throw new Error('api-key flows must not call the network')
    }
  })
  const start = await auth.start({ offeringId: 'windsurf/account' })
  const done = await auth.submitSecret(start.flowId, 'fixture-key')
  assert.equal(done.state, 'complete')
  assert.equal(done.identityClaims.length, 0)
  assert.equal(JSON.stringify(done).includes('fixture-key'), false)
})
