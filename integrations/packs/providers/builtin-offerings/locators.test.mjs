import assert from 'node:assert/strict'
import test from 'node:test'
import { PROVIDER_LOCATORS, locatorCandidates, readLocatorMaterial } from './locators.mjs'

const roots = { home: '/home/u', configHome: '/home/u/.config', dataHome: '/home/u/.local/share' }

/** Offering entries are the canonical ids the manifest declares; 'comment' is prose. */
const offeringEntries = Object.entries(PROVIDER_LOCATORS).filter(([key]) => key.includes('/'))

test('the catalog covers every offering the pack implements, with a parseable format', () => {
  assert.equal(offeringEntries.length, 9)
  for (const [offeringId, entry] of offeringEntries) {
    assert.ok(entry.format, offeringId + ' must declare a credential format')
    assert.ok(
      ['user', 'external'].includes(entry.ownership),
      offeringId + ' must declare read-only ownership'
    )
    assert.ok(
      Array.isArray(entry.fileNames) && entry.fileNames.length > 0,
      offeringId + ' must name its files'
    )
  }
})

test('candidates resolve to absolute paths under the supplied roots', () => {
  const candidates = locatorCandidates(PROVIDER_LOCATORS, roots)
  assert.ok(candidates.length >= 9)
  for (const candidate of candidates) {
    assert.ok(
      candidate.path.startsWith('/home/u/'),
      candidate.path + ' must be absolute and rooted'
    )
    assert.equal(candidate.ownership, 'user')
  }
  const codex = candidates.find((candidate) => candidate.offeringId === 'openai/chatgpt')
  assert.equal(codex.path, '/home/u/.codex/auth.json')
  const copilot = candidates.find((candidate) => candidate.offeringId === 'github/copilot')
  assert.equal(
    copilot.path,
    '/home/u/.config/github-copilot/apps.json',
    'config-rooted locations use configHome'
  )
  const opencode = candidates.find((candidate) => candidate.offeringId === 'opencode/go')
  assert.equal(
    opencode.path,
    '/home/u/.local/share/opencode/auth.json',
    'data-rooted locations use dataHome'
  )
})

test('each declared format parses a realistic file into shared material', () => {
  const cases = [
    [
      'codex-auth-json',
      { tokens: { access_token: 'a', refresh_token: 'r', account_id: 'acc' } },
      { accessToken: 'a', refreshToken: 'r', accountId: 'acc' }
    ],
    [
      'grok-auth-json',
      {
        'https://auth.x.ai::client': {
          key: 'a',
          refresh_token: 'r',
          expires_at: '2030-01-01T00:00:00Z'
        }
      },
      { accessToken: 'a', refreshToken: 'r' }
    ],
    [
      'gemini-oauth-json',
      { access_token: 'a', refresh_token: 'r', expiry_date: 1_800_000_000_000 },
      { accessToken: 'a', refreshToken: 'r', expiresAt: 1_800_000_000_000 }
    ],
    [
      'claude-credentials-json',
      { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', scopes: ['s'] } },
      { accessToken: 'a', refreshToken: 'r', scopes: ['s'] }
    ],
    ['github-apps-json', { 'github.com': { oauth_token: 'a' } }, { accessToken: 'a' }],
    [
      'cline-providers-json',
      { providers: { cline: { settings: { auth: { accessToken: 'a', refreshToken: 'r' } } } } },
      { accessToken: 'a', refreshToken: 'r' }
    ],
    ['opencode-auth-json', { 'opencode-go': { key: 'k' } }, { apiKey: 'k' }],
    [
      'zai-config-json',
      { providers: { 'builtin:zai': { options: { apiKey: 'k' } } } },
      { apiKey: 'k' }
    ],
    ['windsurf-credentials-toml', 'windsurf_api_key = "k"\n', { apiKey: 'k' }]
  ]
  for (const [format, input, expected] of cases) {
    const parsed = readLocatorMaterial(
      format,
      typeof input === 'string' ? input : JSON.stringify(input)
    )
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(parsed[key], value, format + ' must map ' + key)
    }
    assert.equal(
      JSON.stringify(parsed).includes('undefined'),
      false,
      format + ' must not emit undefined fields'
    )
  }
})

test('a file that carries nothing usable is refused rather than silently empty', () => {
  assert.deepEqual(readLocatorMaterial('opencode-auth-json', JSON.stringify({})), {})
  assert.throws(
    () => readLocatorMaterial('nobody-format', '{}'),
    /unsupported credential material format/
  )
  assert.throws(() => readLocatorMaterial('codex-auth-json', 'not json'), /JSON/)
})

test('the callback shapes match the provider registrations the auth module uses', () => {
  assert.deepEqual(PROVIDER_LOCATORS['openai/chatgpt'].callback, {
    mode: 'provider-registered',
    host: 'localhost',
    port: 1455,
    path: '/auth/callback',
    redirect: 'http://localhost:1455/auth/callback'
  })
  assert.equal(PROVIDER_LOCATORS['google/cloud-code'].callback.mode, 'dynamic')
  assert.equal(PROVIDER_LOCATORS['anthropic/claude'].callback, null)
  assert.equal(PROVIDER_LOCATORS['zai/coding-plan'].callback, null)
})

test('the desktop usage-accounts root is offered only when composition supplies it', () => {
  const without = locatorCandidates(PROVIDER_LOCATORS, roots)
  assert.equal(
    without.some((candidate) => candidate.fanout),
    false,
    'no root means no desktop candidates'
  )

  const withRoot = locatorCandidates(PROVIDER_LOCATORS, {
    ...roots,
    usageAccountsRoot: '/desktop/usage-accounts'
  })
  const fanout = withRoot.filter((candidate) => candidate.fanout)
  assert.ok(fanout.length >= 1, 'the explicit root contributes per-account directories')
  for (const candidate of fanout) {
    assert.equal(candidate.ownership, 'external', 'another application owns those copies')
    assert.equal(
      candidate.directory,
      '/desktop/usage-accounts/' + candidate.directory.split('/').pop()
    )
    assert.ok(candidate.fileName, 'the runtime needs the file name to expand the account level')
  }
  const codex = fanout.find((candidate) => candidate.offeringId === 'openai/chatgpt')
  assert.equal(codex.directory, '/desktop/usage-accounts/codex')
  assert.equal(codex.fileName, 'auth.json')
})
