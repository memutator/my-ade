const OFFERINGS = {
  'anthropic/claude': 'claude',
  'openai/chatgpt': 'codex',
  'google/cloud-code': 'gemini',
  'github/copilot': 'copilot',
  'xai/grok': 'grok',
  'zai/coding-plan': 'zai',
  'opencode/go': 'opencode',
  'windsurf/account': 'windsurf',
  'cline/account': 'cline'
}

export const SUPPORTED_OFFERING_IDS = Object.freeze(Object.keys(OFFERINGS))

const str = (v) => (typeof v === 'string' && v ? v : undefined)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const rec = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined)
const pick = (o, ...keys) => keys.map((k) => o?.[k]).find((v) => v !== undefined && v !== null)
const isoMs = (v) =>
  typeof v === 'number'
    ? v < 1e12
      ? v * 1000
      : v
    : typeof v === 'string' && v
      ? Number.isFinite(Number(v))
        ? isoMs(Number(v))
        : Date.parse(v)
      : undefined
const clamp = (v) => Math.max(0, Math.min(100, v))
const evidence = (description) => [{ description }]
const claim = (connectionId, kind, value, at, confidence = 'observed') => ({
  id: `quota:${connectionId}:${kind}:${encodeURIComponent(value)}`,
  connectionId,
  kind,
  value,
  observedAt: at,
  confidence,
  evidence: evidence('provider quota response')
})
const plan = (key, value, at, label) => ({
  key,
  value: String(value),
  observedAt: at,
  ...(label ? { label } : {}),
  evidence: evidence('provider quota response')
})
const period = (resetAt, kind = 'rolling') => (resetAt ? { kind, resetAt } : { kind })
const ratioMeter = (key, label, usedPct, scope, resetAt, sharedPoolKey) => ({
  key,
  label,
  resource: 'provider-quota',
  scope,
  unit: 'ratio',
  utilization: usedPct / 100,
  remaining: (100 - usedPct) / 100,
  availability: 'known',
  period: period(resetAt),
  ...(sharedPoolKey ? { sharedPoolKey } : {})
})
const amountMeter = (key, label, unit, scope, values = {}) => ({
  key,
  label,
  resource: 'provider-quota',
  scope,
  unit,
  availability: 'known',
  ...values
})

async function json(fetchImpl, url, options = {}) {
  const res = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(14000) })
  const text = await res.text()
  if (!res.ok) throw new Error(`provider HTTP ${res.status}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('provider returned invalid JSON')
  }
}
const bearer = (token, extra = {}) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
  ...extra
})
function requireSecret(material, key) {
  const value = str(material[key])
  if (!value) throw new Error(`credential material is missing ${key}`)
  return value
}
function identityClaims(connectionId, material, at, extra = []) {
  const values = [
    material.accountId &&
      claim(connectionId, 'provider-account-id', String(material.accountId), at),
    material.email && claim(connectionId, 'email', String(material.email), at),
    material.organizationId &&
      claim(connectionId, 'billing-organization-id', String(material.organizationId), at),
    ...extra
  ]
  return values.filter(Boolean)
}

async function claude(request, material, fetchImpl) {
  const token = requireSecret(material, 'accessToken')
  const r = await json(fetchImpl, 'https://api.anthropic.com/api/oauth/usage', {
    headers: bearer(token, {
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.0.0'
    })
  })
  const specs = [
    ['five_hour', '5h', '5-hour window'],
    ['seven_day', '7d', 'Weekly (all models)'],
    ['seven_day_opus', '7d-opus', 'Weekly · Opus'],
    ['seven_day_sonnet', '7d-sonnet', 'Weekly · Sonnet']
  ]
  const meters = specs.flatMap(([field, key, label]) => {
    const w = rec(r[field])
    const pct = num(w?.utilization)
    return pct === undefined ? [] : [ratioMeter(key, label, pct, key, isoMs(w.resets_at))]
  })
  const extra = rec(r.extra_usage)
  if (extra?.is_enabled && num(extra.used_credits) !== undefined)
    meters.push(
      amountMeter('extra-usage', 'Extra usage', 'currency', 'monthly', {
        used: num(extra.used_credits),
        limit: num(extra.monthly_limit),
        period: { kind: 'calendar' }
      })
    )
  return {
    identityClaims: identityClaims(request.connectionId, material, request.requestedAt),
    planClaims: [],
    meters,
    entitlements: [],
    status: meters.length ? 'success' : 'partial'
  }
}

async function codex(request, material, fetchImpl) {
  const token = requireSecret(material, 'accessToken')
  const headers = bearer(token, { 'User-Agent': 'mahas' })
  if (material.accountId) headers['ChatGPT-Account-Id'] = String(material.accountId)
  const r = await json(fetchImpl, 'https://chatgpt.com/backend-api/wham/usage', { headers })
  const rl = rec(r.rate_limit) ?? {},
    cr = rec(r.code_review_rate_limit) ?? {}
  const specs = [
    [rl.primary_window, '5h', '5-hour window'],
    [rl.secondary_window, '7d', 'Weekly'],
    [cr.primary_window, 'review', 'Code review · weekly']
  ]
  const meters = specs.flatMap(([w, key, label]) =>
    num(w?.used_percent) === undefined
      ? []
      : [ratioMeter(key, label, num(w.used_percent), key, isoMs(w.reset_at))]
  )
  const credits = rec(r.credits)
  if (credits?.has_credits && !credits.unlimited && num(credits.balance) !== undefined) {
    meters.push(
      amountMeter('credits', 'Credits', 'credits', 'account', {
        remaining: num(credits.balance),
        period: { kind: 'unknown' }
      })
    )
  }
  return {
    identityClaims: identityClaims(request.connectionId, material, request.requestedAt),
    planClaims: r.plan_type ? [plan('plan', r.plan_type, request.requestedAt)] : [],
    meters,
    entitlements: credits?.unlimited
      ? [
          {
            key: 'credits-unlimited',
            scope: 'account',
            value: true,
            evidence: evidence('ChatGPT quota response')
          }
        ]
      : [],
    status: meters.length ? 'success' : 'partial'
  }
}

async function gemini(request, material, fetchImpl) {
  const token = requireSecret(material, 'accessToken')
  const body = material.projectId ? { project: String(material.projectId) } : {}
  const r = await json(
    fetchImpl,
    'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
    {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }
  )
  const buckets = Array.isArray(r.buckets)
    ? r.buckets
    : Array.isArray(r.quotaBuckets)
      ? r.quotaBuckets
      : []
  const meters = buckets.map((b, i) => {
    const remaining = num(b.remainingFraction)
    return {
      key: str(b.modelId) ?? `bucket-${i + 1}`,
      label: str(b.displayName) ?? str(b.modelId) ?? `Bucket ${i + 1}`,
      resource: str(b.modelId) ?? 'model',
      scope: 'account',
      unit: remaining === undefined ? 'requests' : 'ratio',
      ...(remaining === undefined
        ? { remaining: num(b.remainingAmount) }
        : { remaining, utilization: 1 - remaining }),
      availability: 'known',
      period: { kind: 'unknown' }
    }
  })
  return {
    identityClaims: identityClaims(request.connectionId, material, request.requestedAt),
    planClaims: [],
    meters,
    entitlements: [],
    status: meters.length ? 'success' : 'partial'
  }
}

async function copilot(request, material, fetchImpl) {
  const token = requireSecret(material, 'accessToken')
  const headers = bearer(token, { 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mahas' })
  const r = await json(fetchImpl, 'https://api.github.com/copilot_internal/user', { headers })
  const reset = isoMs(r.quota_reset_date),
    snapshots = rec(r.quota_snapshots) ?? {}
  const meters = Object.entries(snapshots).map(([key, raw]) => {
    const s = rec(raw) ?? {},
      unlimited = s.unlimited === true,
      entitlement = num(s.entitlement)
    const remaining = num(s.quota_remaining) ?? num(s.remaining),
      percent = num(s.percent_remaining)
    return {
      key,
      label: key.replaceAll('_', ' '),
      resource: key,
      scope: 'account',
      unit: 'requests',
      ...(remaining === undefined ? {} : { remaining }),
      ...(entitlement === undefined ? {} : { limit: entitlement }),
      ...(percent === undefined ? {} : { utilization: (100 - percent) / 100 }),
      availability: unlimited ? 'unlimited' : 'known',
      period: period(isoMs(s.quota_reset_at) ?? reset, 'calendar')
    }
  })
  return {
    identityClaims: identityClaims(request.connectionId, material, request.requestedAt),
    planClaims: r.copilot_plan ? [plan('plan', r.copilot_plan, request.requestedAt)] : [],
    meters,
    entitlements: [],
    status: meters.length ? 'success' : 'partial'
  }
}

async function grok(request, material, fetchImpl) {
  const token = requireSecret(material, 'accessToken'),
    headers = bearer(token, { 'User-Agent': 'grok-shell' })
  const [billing, user] = await Promise.all([
    json(fetchImpl, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits', { headers }),
    json(fetchImpl, 'https://cli-chat-proxy.grok.com/v1/user?include=subscription', {
      headers
    }).catch(() => ({}))
  ])
  const cfg = rec(billing.config) ?? billing,
    reset = isoMs(rec(cfg.currentPeriod)?.end) ?? isoMs(cfg.billingPeriodEnd)
  const meters = []
  if (num(cfg.creditUsagePercent) !== undefined)
    meters.push(
      ratioMeter('week', 'Weekly allowance', num(cfg.creditUsagePercent), 'account', reset)
    )
  for (const p of Array.isArray(cfg.productUsage) ? cfg.productUsage : [])
    if (str(p.product) && num(p.usagePercent) !== undefined) {
      meters.push(
        ratioMeter(
          str(p.product).toLowerCase(),
          str(p.product),
          num(p.usagePercent),
          'product',
          reset
        )
      )
    }
  const prepaid = num(rec(cfg.prepaidBalance)?.val)
  if (prepaid !== undefined)
    meters.push(
      amountMeter('prepaid', 'Prepaid balance', 'credits', 'account', { remaining: prepaid })
    )
  return {
    identityClaims: identityClaims(request.connectionId, material, request.requestedAt),
    planClaims: user.subscriptionTier
      ? [plan('subscription', user.subscriptionTier, request.requestedAt)]
      : [],
    meters,
    entitlements: [],
    status: meters.length ? 'success' : 'partial'
  }
}

async function zai(request, material, fetchImpl) {
  const key = requireSecret(material, 'apiKey'),
    base = str(material.baseUrl) ?? 'https://api.z.ai'
  const r = await json(fetchImpl, `${base.replace(/\/$/, '')}/api/monitor/usage/quota/limit`, {
    headers: bearer(key)
  })
  const data = rec(r.data) ?? r,
    meters = []
  for (const l of Array.isArray(data.limits) ? data.limits : []) {
    const type = str(l.type),
      pct = num(l.percentage),
      reset = isoMs(l.nextResetTime)
    if (pct === undefined) continue
    if (
      (type === 'CREDIT_LIMIT' || type === 'TOKENS_LIMIT') &&
      num(l.unit) === 3 &&
      num(l.number) === 5
    )
      meters.push(ratioMeter('5h', '5-hour window', pct, 'account', reset))
    else if ((type === 'CREDIT_LIMIT' || type === 'TOKENS_LIMIT') && num(l.unit) === 6)
      meters.push(ratioMeter('7d', 'Weekly', pct, 'account', reset))
    else if (type === 'TIME_LIMIT')
      meters.push(ratioMeter('mcp', 'MCP tools · monthly', pct, 'account', reset))
  }
  if (!meters.length) {
    if (num(data.fiveHourPercent) !== undefined)
      meters.push(ratioMeter('5h', '5-hour window', num(data.fiveHourPercent), 'account'))
    if (num(data.weeklyPercent) !== undefined)
      meters.push(ratioMeter('7d', 'Weekly', num(data.weeklyPercent), 'account'))
    if (num(data.monthlyMCPUsage) !== undefined)
      meters.push(ratioMeter('mcp', 'MCP tools · monthly', num(data.monthlyMCPUsage), 'account'))
  }
  return {
    identityClaims: identityClaims(request.connectionId, material, request.requestedAt),
    planClaims: data.level ? [plan('level', data.level, request.requestedAt)] : [],
    meters,
    entitlements: [],
    status: meters.length ? 'success' : 'partial'
  }
}

async function opencode(request, material, fetchImpl) {
  const key = requireSecret(material, 'apiKey')
  const r = await json(fetchImpl, 'https://opencode.ai/zen/go/v1/usage', { headers: bearer(key) })
  const usage = rec(r.usage) ?? r,
    meters = []
  for (const [raw, key, label] of [
    [usage.rolling ?? usage.rollingUsage, '5h', '5-hour window'],
    [usage.weekly ?? usage.weeklyUsage, '7d', 'Weekly'],
    [usage.monthly ?? usage.monthlyUsage, '30d', 'Monthly']
  ]) {
    const w = rec(raw),
      pct = num(w?.percent) ?? num(w?.usagePercent)
    if (w && (!w.status || w.status === 'ok') && pct !== undefined)
      meters.push(
        ratioMeter(
          key,
          label,
          pct,
          'account',
          isoMs(w.resetsAt) ??
            (num(w.resetInSec) === undefined
              ? undefined
              : request.requestedAt + num(w.resetInSec) * 1000)
        )
      )
  }
  return {
    identityClaims: identityClaims(request.connectionId, material, request.requestedAt),
    planClaims: [plan('plan', 'Go', request.requestedAt)],
    meters,
    entitlements: [],
    status: meters.length ? 'success' : 'partial'
  }
}

async function windsurf(request, material, fetchImpl) {
  const key = requireSecret(material, 'apiKey'),
    base = (str(material.baseUrl) ?? 'https://server.codeium.com').replace(/\/$/, '')
  const r = await json(
    fetchImpl,
    `${base}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: JSON.stringify({
        metadata: {
          api_key: key,
          ide_name: 'vscode',
          ide_version: '1.96.0',
          extension_name: 'windsurf',
          extension_version: '1.0.0',
          locale: 'en'
        }
      })
    }
  )
  const user = rec(pick(r, 'userStatus', 'user_status')) ?? r
  const ps = rec(pick(user, 'planStatus', 'plan_status')) ?? {},
    info = rec(pick(ps, 'planInfo', 'plan_info')) ?? {}
  const meters = []
  const addRemaining = (key, label, value, reset) => {
    const remaining = num(value) ?? (typeof value === 'string' ? Number(value) : undefined)
    if (Number.isFinite(remaining))
      meters.push(ratioMeter(key, label, clamp(100 - remaining), 'account', isoMs(reset)))
  }
  if (!pick(info, 'hideDailyQuota', 'hide_daily_quota'))
    addRemaining(
      'day',
      'Daily quota',
      pick(ps, 'dailyQuotaRemainingPercent', 'daily_quota_remaining_percent'),
      pick(ps, 'dailyQuotaResetAtUnix', 'daily_quota_reset_at_unix')
    )
  addRemaining(
    'week',
    'Weekly quota',
    pick(ps, 'weeklyQuotaRemainingPercent', 'weekly_quota_remaining_percent'),
    pick(ps, 'weeklyQuotaResetAtUnix', 'weekly_quota_reset_at_unix')
  )
  if (
    !meters.some((meter) => meter.key === 'week') &&
    isoMs(pick(ps, 'weeklyQuotaResetAtUnix', 'weekly_quota_reset_at_unix'))
  ) {
    meters.push(
      ratioMeter(
        'week',
        'Weekly quota',
        100,
        'account',
        isoMs(pick(ps, 'weeklyQuotaResetAtUnix', 'weekly_quota_reset_at_unix'))
      )
    )
  }
  const used = num(pick(ps, 'acuConsumed', 'acu_consumed')),
    limit = num(pick(ps, 'acuLimit', 'acu_limit'))
  if (used !== undefined && limit !== undefined)
    meters.push(
      amountMeter('acu', 'ACU', 'credits', 'plan', {
        used,
        limit,
        remaining: Math.max(0, limit - used),
        utilization: limit > 0 ? used / limit : undefined
      })
    )
  const email = str(pick(user, 'email')),
    extra = email ? [claim(request.connectionId, 'email', email, request.requestedAt)] : []
  return {
    identityClaims: identityClaims(request.connectionId, material, request.requestedAt, extra),
    planClaims: pick(info, 'planName', 'plan_name')
      ? [plan('plan', pick(info, 'planName', 'plan_name'), request.requestedAt)]
      : [],
    meters,
    entitlements: [],
    status: meters.length ? 'success' : 'partial'
  }
}

const unwrap = (v) => rec(v?.data) ?? v
async function cline(request, material, fetchImpl) {
  const token = requireSecret(material, 'accessToken'),
    headers = bearer(token)
  const me = unwrap(await json(fetchImpl, 'https://api.cline.bot/api/v1/users/me', { headers }))
  const uid = str(me.id) ?? str(material.accountId),
    meters = [],
    identities = []
  if (uid)
    identities.push(claim(request.connectionId, 'provider-account-id', uid, request.requestedAt))
  if (str(me.email))
    identities.push(claim(request.connectionId, 'email', str(me.email), request.requestedAt))
  if (uid) {
    const bal = unwrap(
      await json(
        fetchImpl,
        `https://api.cline.bot/api/v1/users/${encodeURIComponent(uid)}/balance`,
        { headers }
      )
    )
    if (num(bal.balance) !== undefined)
      meters.push(
        amountMeter('credits', 'Credit balance', 'credits', 'account', {
          remaining: num(bal.balance) / 1e6
        })
      )
  }
  const org = (Array.isArray(me.organizations) ? me.organizations : []).find(
    (o) => o.active === true
  )
  if (str(org?.organizationId)) {
    const id = str(org.organizationId),
      bal = unwrap(
        await json(
          fetchImpl,
          `https://api.cline.bot/api/v1/organizations/${encodeURIComponent(id)}/balance`,
          { headers }
        )
      )
    identities.push(claim(request.connectionId, 'billing-organization-id', id, request.requestedAt))
    if (num(bal.balance) !== undefined)
      meters.push(
        amountMeter(
          'organization-credits',
          'Organization credit balance',
          'credits',
          'organization',
          { remaining: num(bal.balance) / 1e6, sharedPoolKey: id }
        )
      )
  }
  const p = unwrap(
    await json(fetchImpl, 'https://api.cline.bot/api/v1/users/me/plan', { headers }).catch(
      () => ({})
    )
  )
  const pv = str(p.name) ?? str(p.planName) ?? str(p.plan)
  return {
    identityClaims: identityClaims(request.connectionId, material, request.requestedAt, identities),
    planClaims: pv ? [plan('plan', pv, request.requestedAt)] : [],
    meters,
    entitlements: [],
    status: meters.length ? 'success' : 'partial'
  }
}

const PROBES = { claude, codex, gemini, copilot, grok, zai, opencode, windsurf, cline }
export async function probeQuota(envelope, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const material = envelope.payload.credentialMaterial
  const offeringId =
    envelope.target?.kind === 'offering'
      ? str(envelope.target.offeringId)
      : str(material.offeringId)
  const adapter = OFFERINGS[offeringId]
  if (!adapter) throw new Error('credential material must name a supported offeringId')
  return PROBES[adapter](envelope.payload, material, fetchImpl)
}

function result(envelope, status, payload, diagnostics, startedAt) {
  return {
    protocolVersion: envelope.protocolVersion,
    operationId: envelope.operationId,
    capability: envelope.capability,
    target: envelope.target,
    contract: envelope.contract,
    pack: envelope.pack,
    status,
    ...(payload ? { payload } : {}),
    diagnostics,
    startedAt,
    completedAt: Date.now()
  }
}

async function main() {
  const startedAt = Date.now(),
    chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8').trim())
  try {
    const payload = await probeQuota(envelope)
    process.stdout.write(
      JSON.stringify(
        result(
          envelope,
          payload.status === 'partial' ? 'partial' : 'success',
          payload,
          [],
          startedAt
        )
      ) + '\n'
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'provider quota probe failed'
    const payload = {
      identityClaims: [],
      planClaims: [],
      meters: [],
      entitlements: [],
      status: 'failure'
    }
    process.stdout.write(
      JSON.stringify(
        result(
          envelope,
          'failed',
          payload,
          [{ code: 'quota-probe-failed', severity: 'error', message }],
          startedAt
        )
      ) + '\n'
    )
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main()
