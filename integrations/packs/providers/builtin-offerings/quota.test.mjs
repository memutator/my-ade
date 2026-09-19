import assert from 'node:assert/strict'
import test from 'node:test'
import { probeQuota, SUPPORTED_OFFERING_IDS } from './quota.mjs'

const payloads = {
  'api.anthropic.com': { five_hour: { utilization: 20, resets_at: '2026-01-01T00:00:00Z' } },
  'chatgpt.com': {
    rate_limit: { primary_window: { used_percent: 30, reset_at: 1770000000 } },
    plan_type: 'plus'
  },
  'cloudcode-pa.googleapis.com': { buckets: [{ modelId: 'gemini', remainingFraction: 0.6 }] },
  'api.github.com/copilot_internal': {
    quota_snapshots: {
      premium_interactions: { percent_remaining: 50, entitlement: 100, quota_remaining: 50 }
    }
  },
  'cli-chat-proxy.grok.com/v1/billing': { config: { creditUsagePercent: 40 } },
  'cli-chat-proxy.grok.com/v1/user': { subscriptionTier: 'SuperGrokPro' },
  'api.z.ai': { data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 12 }] } },
  'opencode.ai': { usage: { rolling: { status: 'ok', percent: 10 } } },
  'server.codeium.com': {
    userStatus: {
      email: 'devin@example.test',
      planStatus: { weeklyQuotaRemainingPercent: 75 },
      planInfo: { planName: 'pro' }
    }
  },
  'api.cline.bot/api/v1/users/me/plan': { data: { name: 'pro' } },
  'api.cline.bot/api/v1/users/me': { data: { id: 'usr-1', email: 'cline@example.test' } },
  'api.cline.bot/api/v1/users/usr-1/balance': { data: { balance: 2500000 } }
}

const fetch = async (url) => {
  const key = Object.keys(payloads).find((candidate) => String(url).includes(candidate))
  if (!key) return new Response('{}', { status: 404 })
  return Response.json(payloads[key])
}

test('all canonical built-in offerings return concrete typed quota payloads', async () => {
  assert.equal(SUPPORTED_OFFERING_IDS.length, 9)
  for (const offeringId of SUPPORTED_OFFERING_IDS) {
    const credentialMaterial =
      offeringId.includes('zai') ||
      offeringId.includes('opencode') ||
      offeringId.includes('windsurf')
        ? { apiKey: 'fixture-key' }
        : { accessToken: 'fixture-token' }
    const result = await probeQuota(
      {
        target: { kind: 'offering', offeringId },
        payload: {
          connectionId: `connection:${offeringId}`,
          requestedAt: 1760000000000,
          credentialMaterial
        }
      },
      { fetch }
    )
    assert.ok(['success', 'partial'].includes(result.status), offeringId)
    assert.ok(Array.isArray(result.meters), offeringId)
    assert.ok(result.meters.length > 0, offeringId)
    for (const meter of result.meters) {
      assert.equal(typeof meter.key, 'string')
      assert.ok(['known', 'unknown', 'unlimited'].includes(meter.availability))
    }
  }
})

test('shared pool claims use provider pool keys, never email as a merge key', async () => {
  payloads['api.cline.bot/api/v1/users/me'] = {
    data: {
      id: 'usr-1',
      email: 'same@example.test',
      organizations: [{ active: true, organizationId: 'org-pool-1' }]
    }
  }
  payloads['api.cline.bot/api/v1/organizations/org-pool-1/balance'] = { data: { balance: 1000000 } }
  const result = await probeQuota(
    {
      target: { kind: 'offering', offeringId: 'cline/account' },
      payload: {
        connectionId: 'connection-1',
        requestedAt: 1,
        credentialMaterial: { accessToken: 'x' }
      }
    },
    { fetch }
  )
  assert.equal(
    result.meters.find((meter) => meter.key === 'organization-credits')?.sharedPoolKey,
    'org-pool-1'
  )
  assert.ok(!result.meters.some((meter) => meter.sharedPoolKey === 'same@example.test'))
})

test('probe payloads never repeat credential material', async () => {
  const result = await probeQuota(
    {
      target: { kind: 'offering', offeringId: 'anthropic/claude' },
      payload: {
        connectionId: 'connection-1',
        requestedAt: 1760000000000,
        credentialMaterial: { accessToken: 'fixture-token' }
      }
    },
    { fetch }
  )
  assert.equal(JSON.stringify(result).includes('fixture-token'), false)
  assert.ok(
    result.meters.every((meter) => !Object.values(meter).some((value) => value === 'fixture-token'))
  )
})

test('a provider failure is thrown for the caller to record as a failure observation', async () => {
  const failing = async (url) => {
    if (String(url).includes('api.anthropic.com')) return new Response('nope', { status: 500 })
    return Response.json({})
  }
  await assert.rejects(
    probeQuota(
      {
        target: { kind: 'offering', offeringId: 'anthropic/claude' },
        payload: {
          connectionId: 'connection-1',
          requestedAt: 1,
          credentialMaterial: { accessToken: 'fixture-token' }
        }
      },
      { fetch: failing }
    ),
    /HTTP 500/
  )
})

test('material that names an unknown offering is refused instead of guessed', async () => {
  await assert.rejects(
    probeQuota(
      {
        target: { kind: 'offering', offeringId: 'nobody/unknown' },
        payload: { connectionId: 'c', requestedAt: 1, credentialMaterial: { apiKey: 'x' } }
      },
      { fetch }
    ),
    /supported offeringId/
  )
})
