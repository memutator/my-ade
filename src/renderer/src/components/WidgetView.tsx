import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Plus, RefreshCw, UserPlus, X } from 'lucide-react'
import type {
  LedgerQuery,
  LedgerResult,
  TokenUse,
  UsageAccount,
  UsageResult,
  WidgetTab
} from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import { agentColor, agentLabel, agentProviders } from '../agents'
import { fmtTok, fmtUsd, shortPath, srcProvider } from '../utils'
import AgentIcon from './AgentIcon'
import AgentsPanel from './AgentsPanel'
import ResponsibilityView from '../workbench/ResponsibilityView'
import TeamView from '../workbench/TeamView'
import PlanView from '../workbench/PlanView'
import InspectorView from '../workbench/InspectorView'
import { useWorkbench } from '../workbench/store'
import Tooltip from './Tooltip'
import { Dropdown, Select } from './Menu'

/* A 'widget' block — chromeless mini-tools stacked in a leaf like any other
   tab. 'agents' mirrors the sidebar session list; 'usage' is the live
   rate-limit probe; 'tokens' sums on-disk session ledgers per harness and
   the sessions mahas is currently tracking. */

const POLL_MS = 180_000 // claude's usage endpoint is safe at ~3min cadence

// providers main knows how to probe — the select lists them first
const USAGE_PROVIDERS = [
  'grok',
  'codex',
  'zcode',
  'opencode',
  'devin',
  'claude',
  'gemini',
  'copilot',
  'cline'
]

// sign-in methods each provider supports — mirrors main/usageAuth.ts;
// every provider can also import an existing credential file
const OAUTH_PROVIDERS = new Set(['codex', 'grok', 'gemini', 'claude', 'copilot', 'cline'])
const KEY_PROVIDERS = new Set(['zcode', 'opencode', 'devin'])

/* A selectable probe target — a harness's default credential file, or an
   extra account registered in settings.usageAccounts. Selection keys ride
   tab.providers: `provider` for the default login, `provider@accountId`
   for a registered one. */
interface UsageSource {
  key: string
  provider: string
  path?: string
  label?: string
}

// module-level cache: every usage widget shares a source's snapshot
const usageCache = new Map<string, UsageResult>()
const inflight = new Map<string, Promise<UsageResult>>()
const NO_ACCOUNTS: UsageAccount[] = []

function fetchUsage(src: UsageSource): Promise<UsageResult> {
  let p = inflight.get(src.key)
  if (!p) {
    p = window.mahas.usage
      .fetch(src.provider, src.path)
      .then((res) => {
        usageCache.set(src.key, res)
        return res
      })
      .catch((e) => ({
        ok: false,
        provider: src.provider,
        windows: [],
        error: String(e),
        fetchedAt: Date.now()
      }))
      .finally(() => inflight.delete(src.key))
    inflight.set(src.key, p)
  }
  return p
}

function fmtReset(resetAt: number): string {
  const d = resetAt - Date.now()
  if (d <= 0) return 'now'
  const m = Math.round(d / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function usageCatalog(accounts: UsageAccount[]): UsageSource[] {
  const manifest = agentProviders()
  const providers = [
    ...USAGE_PROVIDERS.filter((id) => manifest[id]),
    ...Object.keys(manifest).filter((id) => !USAGE_PROVIDERS.includes(id)),
    // a registered account keeps its provider listed even off-manifest
    ...USAGE_PROVIDERS.filter((id) => !manifest[id] && accounts.some((a) => a.provider === id))
  ]
  const sources: UsageSource[] = []
  for (const id of providers) {
    sources.push({ key: id, provider: id })
    for (const a of accounts) {
      if (a.provider === id)
        sources.push({ key: `${a.provider}@${a.id}`, provider: id, path: a.path, label: a.label })
    }
  }
  return sources
}

// default label for a registered account: profile dirs name the account
// ('login-homes/amir/auth.json' → 'amir'); free-standing files fall back to
// their basename sans extension ('bob.json' → 'bob')
const KNOWN_CRED_FILES = new Set([
  'auth.json',
  '.credentials.json',
  'oauth_creds.json',
  'config.json',
  'credentials.toml',
  'apps.json',
  'hosts.yml'
])
function acctLabel(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  const base = parts[parts.length - 1] ?? path
  if (!KNOWN_CRED_FILES.has(base)) return base.replace(/\.[^.]+$/, '') || base
  return parts.length > 1 ? parts[parts.length - 2] : base
}

/** 'Codex' for unresolved sources, 'Codex · amir@x.com' once an identity is
 *  known — the credential-derived identity wins over the path fallback */
function srcTitle(src: UsageSource, res?: UsageResult): string {
  const acct = res?.account ?? (src.path ? src.label : undefined)
  return acct ? `${agentLabel(src.provider)} · ${acct}` : agentLabel(src.provider)
}

function UsageWindows({ res }: { res: UsageResult }): React.JSX.Element {
  const t = useT()
  if (!res.ok) {
    return (
      <div className="usage-note err">
        {res.error === 'unsupported'
          ? t('usageUnsupported', { agent: agentLabel(res.provider) })
          : (res.error ?? '')}
      </div>
    )
  }
  return (
    <>
      {res.windows.map((w) => (
        <div key={w.id} className="usage-row">
          <div className="usage-row-head">
            <span className="usage-label">{w.label}</span>
            <span className="usage-nums">
              {w.usedPct !== undefined ? `${Math.round(w.usedPct)}%` : (w.detail ?? '—')}
              {w.resetAt !== undefined && <em className="usage-reset"> · {fmtReset(w.resetAt)}</em>}
            </span>
          </div>
          {w.usedPct !== undefined && (
            <div className="u-bar">
              <div
                className={`u-fill${w.usedPct >= 90 ? ' crit' : w.usedPct >= 70 ? ' warn' : ''}`}
                style={{ width: `${Math.min(100, Math.max(0, w.usedPct))}%` }}
              />
            </div>
          )}
          {w.usedPct !== undefined && w.detail && <div className="usage-sub">{w.detail}</div>}
        </div>
      ))}
      {res.extra && <div className="usage-sub">{res.extra}</div>}
    </>
  )
}

interface AuthFlow {
  flowId: string
  mode: 'browser' | 'code' | 'device'
  url?: string
  userCode?: string
  verificationUri?: string
}

/* Per-provider sign-in card for multi-account add. OAuth providers start the
   flow in main (browser callback / pasted code / device poll), api-key
   providers save the key into a managed cred file, and any provider can
   still import an existing credential file. A finished method reports the
   written cred path up so UsageBody registers it like a picked file. */
function AuthPanel({
  provider,
  onDone,
  onClose
}: {
  provider: string
  onDone: (path: string, label?: string) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [flow, setFlow] = useState<AuthFlow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const liveFlow = useRef<string | null>(null)

  useEffect(
    () => () => {
      if (liveFlow.current) void window.mahas.usage.authCancel(liveFlow.current)
    },
    []
  )

  const settle = (r: { ok: boolean; path?: string; account?: string; error?: string }): void => {
    if (r.ok && r.path) onDone(r.path, r.account)
    else setError(r.error ?? 'sign-in failed')
  }

  const startOAuth = async (): Promise<void> => {
    setError(undefined)
    setBusy(true)
    try {
      const s = await window.mahas.usage.authStart(provider)
      liveFlow.current = s.flowId
      setFlow(s)
      setBusy(false)
      if (s.mode === 'code') return // waits for the pasted code below
      const r = await window.mahas.usage.authFinish(s.flowId)
      if (liveFlow.current !== s.flowId) return // cancelled meanwhile
      liveFlow.current = null
      setFlow(null)
      settle(r)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
      setBusy(false)
    }
  }

  const submitCode = async (): Promise<void> => {
    if (!flow) return
    setBusy(true)
    setError(undefined)
    const r = await window.mahas.usage.authFinish(flow.flowId, code.trim())
    if (liveFlow.current !== flow.flowId) return
    setBusy(false)
    if (r.ok) {
      liveFlow.current = null
      setFlow(null)
    }
    settle(r) // on failure the flow stays so a corrected paste can retry
  }

  const submitKey = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    const r = await window.mahas.usage.saveKey(provider, key, name.trim() || undefined)
    setBusy(false)
    if (r.path) onDone(r.path, name.trim() || undefined)
    else setError(r.error ?? 'could not save the key')
  }

  const importFile = async (): Promise<void> => {
    const path = await window.mahas.file.openDialog()
    if (path) onDone(path)
  }

  const close = (): void => {
    if (liveFlow.current) {
      void window.mahas.usage.authCancel(liveFlow.current)
      liveFlow.current = null
    }
    onClose()
  }

  return (
    <div className="dash-auth">
      <div className="dash-auth-h">
        <AgentIcon id={provider} size={14} />
        <span className="dash-auth-t">{agentLabel(provider)}</span>
        <button className="pbtn" onClick={close}>
          <X />
        </button>
      </div>
      {OAUTH_PROVIDERS.has(provider) && !flow && (
        <button className="sbtn accent" onClick={() => void startOAuth()} disabled={busy}>
          {busy ? <Loader2 className="spin" /> : null}
          {t('usageAuthSignIn')}
        </button>
      )}
      {flow?.mode === 'browser' && (
        <div className="dash-auth-msg">
          <Loader2 className="spin" />
          <span>{t('usageAuthWaiting')}</span>
          {flow.url && (
            <button className="sbtn" onClick={() => window.mahas.openExternal(flow.url!)}>
              {t('usageAuthOpenPage')}
            </button>
          )}
        </div>
      )}
      {flow?.mode === 'code' && (
        <>
          {flow.url && (
            <div className="dash-auth-msg">
              <span>{t('usageAuthCode')}</span>
              <button className="sbtn" onClick={() => window.mahas.openExternal(flow.url!)}>
                {t('usageAuthOpenPage')}
              </button>
            </div>
          )}
          <div className="dash-auth-form">
            <input
              className="sinput"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t('usageAuthCode')}
              spellCheck={false}
              autoFocus
            />
            <button
              className="sbtn accent"
              onClick={() => void submitCode()}
              disabled={busy || !code.trim()}
            >
              {busy ? <Loader2 className="spin" /> : t('usageAdd')}
            </button>
          </div>
        </>
      )}
      {flow?.mode === 'device' && (
        <div className="dash-auth-msg">
          <Loader2 className="spin" />
          <span>
            {t('usageAuthDevice', {
              code: flow.userCode ?? '',
              url: flow.verificationUri ?? ''
            })}
          </span>
        </div>
      )}
      {KEY_PROVIDERS.has(provider) && !flow && (
        <div className="dash-auth-form">
          <input
            className="sinput"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={t('usageApiKey')}
            spellCheck={false}
          />
          <input
            className="sinput"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('usageAcctName')}
            spellCheck={false}
          />
          <button
            className="sbtn accent"
            onClick={() => void submitKey()}
            disabled={busy || !key.trim()}
          >
            {busy ? <Loader2 className="spin" /> : t('usageAdd')}
          </button>
        </div>
      )}
      {!flow && (
        <button className="dash-auth-file" onClick={() => void importFile()}>
          {t('usageImportFile')}
        </button>
      )}
      {error && <div className="usage-note err">{error}</div>}
    </div>
  )
}

function UsageBody({
  providers,
  onProviders
}: {
  providers: string[] | undefined
  onProviders: (ids: string[]) => void
}): React.JSX.Element {
  const t = useT()
  const accounts = useStore((s) => s.settings.usageAccounts ?? NO_ACCOUNTS)
  const catalog = useMemo(() => usageCatalog(accounts), [accounts])
  const srcByKey = useMemo(() => new Map(catalog.map((s) => [s.key, s])), [catalog])
  const catalogKey = catalog.map((s) => s.key).join('|')
  const selected = providers ? providers.filter((k) => srcByKey.has(k)) : catalog.map((s) => s.key)
  const selectedKey = selected.join('|')
  const [rows, setRows] = useState<Record<string, UsageResult>>(() => {
    const init: Record<string, UsageResult> = {}
    for (const k of selected) {
      const hit = usageCache.get(k)
      if (hit) init[k] = hit
    }
    return init
  })
  const [busy, setBusy] = useState(false)
  const manifest = agentProviders()
  const addable = USAGE_PROVIDERS.filter((id) => manifest[id])

  /* collapse sources resolving to the same account — the system credential
     and a managed registration of the same login (e.g. the CLI was re-signed
     into the registered account) are ONE account and render once. The first
     source in catalog order wins, so the live system credential survives and
     the managed dup reappears the moment identities diverge. An unresolved
     fetch can't prove a dup, so its card stays. */
  const dupKeys = useMemo(() => {
    const seen = new Set<string>()
    const dups = new Set<string>()
    for (const s of catalog) {
      if (!selected.includes(s.key)) continue
      const acct = rows[s.key]?.account?.trim().toLowerCase()
      if (!acct) continue
      const id = `${s.provider}${acct}`
      if (seen.has(id)) dups.add(s.key)
      else seen.add(id)
    }
    return dups
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, selectedKey, rows])
  const visibleSel = useMemo(() => selected.filter((k) => !dupKeys.has(k)), [selected, dupKeys])
  // provider → visible source keys, in catalog order — each group renders a
  // provider header with its account cards stacked underneath
  const groups = useMemo(() => {
    const out: { provider: string; keys: string[] }[] = []
    for (const s of catalog) {
      if (!visibleSel.includes(s.key)) continue
      const g = out.find((g) => g.provider === s.provider)
      if (g) g.keys.push(s.key)
      else out.push({ provider: s.provider, keys: [s.key] })
    }
    return out
  }, [catalog, visibleSel])

  // old tabs only stored `provider`; open them as the full dashboard once
  // the catalog is known. after the user toggles, `providers` is the source.
  useEffect(() => {
    if (providers) return
    if (!catalogKey) return
    onProviders(catalogKey.split('|'))
  }, [providers, catalogKey, onProviders])

  const pull = (keys: string[]): Promise<void> =>
    Promise.all(
      keys.map((k) =>
        fetchUsage(srcByKey.get(k) ?? { key: k, provider: srcProvider(k) }).then(
          (res) => [k, res] as const
        )
      )
    ).then((list) => {
      setRows((prev) => {
        const next = { ...prev }
        for (const [k, r] of list) next[k] = r
        return next
      })
    })

  const refresh = (): void => {
    if (!selected.length) return
    setBusy(true)
    void pull(selected).finally(() => setBusy(false))
  }

  useEffect(() => {
    if (!selected.length) return
    let on = true
    const run = (): void => {
      void Promise.all(
        selected.map((k) =>
          fetchUsage(srcByKey.get(k) ?? { key: k, provider: srcProvider(k) }).then(
            (res) => [k, res] as const
          )
        )
      ).then((list) => {
        if (!on) return
        setRows((prev) => {
          const next = { ...prev }
          for (const [k, r] of list) next[k] = r
          return next
        })
      })
    }
    run()
    const id = setInterval(run, POLL_MS)
    return () => {
      on = false
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey])

  const [authProvider, setAuthProvider] = useState<string | null>(null)

  /* a sign-in/import reported back a credential path — register it (deduped
     by provider+path) and select the new source so its card shows up */
  const registerAccount = (provider: string, path: string, label?: string): void => {
    const st = useStore.getState()
    const cur = st.settings.usageAccounts ?? []
    let acct = cur.find((a) => a.provider === provider && a.path === path)
    if (!acct) {
      acct = { id: crypto.randomUUID(), provider, path, label: label ?? acctLabel(path) }
      st.updateSettings({ usageAccounts: [...cur, acct] })
    }
    const key = `${provider}@${acct.id}`
    if (!selected.includes(key)) onProviders([...selected, key])
    setAuthProvider(null)
  }

  const removeAccount = (src: UsageSource): void => {
    const st = useStore.getState()
    st.updateSettings({
      usageAccounts: (st.settings.usageAccounts ?? []).filter(
        (a) => `${a.provider}@${a.id}` !== src.key
      )
    })
    if (selected.includes(src.key)) onProviders(selected.filter((k) => k !== src.key))
    if (src.path) void window.mahas.usage.discardCred(src.path)
  }

  const options = catalog.map((s) => ({
    value: s.key,
    label: (
      <span className="sel-agent">
        <AgentIcon id={s.provider} size={12} />
        {srcTitle(s, rows[s.key])}
      </span>
    )
  }))
  const summary =
    selected.length === 0 ? (
      t('usageNone')
    ) : selected.length === 1 ? (
      <span className="sel-agent">
        <AgentIcon id={srcProvider(selected[0])} size={12} />
        {srcTitle(
          srcByKey.get(selected[0]) ?? { key: selected[0], provider: srcProvider(selected[0]) },
          rows[selected[0]]
        )}
      </span>
    ) : (
      <span className="sel-agent">
        {selected.slice(0, 3).map((k) => (
          <AgentIcon key={k} id={srcProvider(k)} size={12} />
        ))}
        {t('usageSelected', { n: String(selected.length) })}
      </span>
    )

  const shown = visibleSel.map((k) => rows[k]).filter(Boolean)
  const ok = shown.filter((r) => r.ok)
  const peak = ok.reduce((m, r) => {
    for (const w of r.windows) {
      if (w.usedPct !== undefined) m = Math.max(m, w.usedPct)
    }
    return m
  }, -1)
  const latest = shown.reduce((m, r) => Math.max(m, r.fetchedAt), 0)

  return (
    <div className="dash">
      <div className="dash-inner">
        <div className="dash-head">
          <Select
            multiple
            values={selected}
            options={options}
            onChangeValues={onProviders}
            summary={summary}
            selectAllLabel={t('agentsAll')}
            className="usage-sel"
          />
          <span className="dash-title">{t('widgetUsage')}</span>
          <Tooltip label={t('refresh')}>
            <button className="pbtn" onClick={refresh} disabled={busy || !selected.length}>
              <RefreshCw className={busy ? 'spin' : ''} />
            </button>
          </Tooltip>
          <Dropdown
            align="end"
            panelClassName="sel-pop"
            trigger={
              <Tooltip label={t('usageAddAccount')}>
                <button className="pbtn">
                  <UserPlus />
                </button>
              </Tooltip>
            }
          >
            {addable.map((id) => (
              <button key={id} className="sel-item" onClick={() => setAuthProvider(id)}>
                <span className="sel-agent">
                  <AgentIcon id={id} size={12} />
                  {agentLabel(id)}
                </span>
              </button>
            ))}
          </Dropdown>
        </div>
        {authProvider && !groups.some((g) => g.provider === authProvider) && (
          <AuthPanel
            provider={authProvider}
            onDone={(path, label) => registerAccount(authProvider, path, label)}
            onClose={() => setAuthProvider(null)}
          />
        )}
        {!selected.length ? (
          <div className="usage-note">{t('usageNone')}</div>
        ) : (
          <>
            <div className="dash-kpis">
              <div className="dash-kpi">
                <span className="dash-kpi-l">{t('agents')}</span>
                <span className="dash-kpi-v">{visibleSel.length}</span>
              </div>
              <div className="dash-kpi">
                <span className="dash-kpi-l">{t('usageReporting')}</span>
                <span className="dash-kpi-v">
                  {ok.length}/{visibleSel.length}
                </span>
              </div>
              <div className="dash-kpi">
                <span className="dash-kpi-l">{t('usagePeak')}</span>
                <span className="dash-kpi-v">{peak < 0 ? '—' : `${Math.round(peak)}%`}</span>
              </div>
            </div>
            <div className="dash-groups">
              {groups.map((g) => (
                <section key={g.provider} className="dash-group">
                  <div className="dash-grp-h">
                    <AgentIcon id={g.provider} size={13} />
                    <span className="dash-grp-t">{agentLabel(g.provider)}</span>
                    <Tooltip label={t('usageAddAccount')}>
                      <button
                        className="pbtn dash-grp-add"
                        onClick={() =>
                          setAuthProvider(authProvider === g.provider ? null : g.provider)
                        }
                      >
                        <Plus />
                      </button>
                    </Tooltip>
                  </div>
                  {authProvider === g.provider && (
                    <AuthPanel
                      provider={authProvider}
                      onDone={(path, label) => registerAccount(authProvider, path, label)}
                      onClose={() => setAuthProvider(null)}
                    />
                  )}
                  <div className="dash-grid">
                    {g.keys.map((key) => {
                      const src = srcByKey.get(key) ?? { key, provider: g.provider }
                      const res = rows[key]
                      return (
                        <div key={key} className="dash-card">
                          <div className="dash-card-h">
                            <span className="dash-card-n">
                              {res?.account ?? src.label ?? t('usageDefault')}
                            </span>
                            {res?.plan && <span className="dash-card-s">{res.plan}</span>}
                            {src.path && (
                              <Tooltip label={t('usageRemoveAccount')}>
                                <button
                                  className="pbtn dash-card-x"
                                  onClick={() => removeAccount(src)}
                                >
                                  <X />
                                </button>
                              </Tooltip>
                            )}
                          </div>
                          {!res ? (
                            <div className="usage-note">{t('loading')}</div>
                          ) : (
                            <UsageWindows res={res} />
                          )}
                        </div>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
            {latest > 0 && (
              <div className="usage-foot">{new Date(latest).toLocaleTimeString()}</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

let ledgerCache: LedgerResult | null = null
let ledgerInflight: Promise<LedgerResult> | null = null

function fetchLedger(tracked: LedgerQuery[], force = false): Promise<LedgerResult> {
  if (!force && ledgerCache) return Promise.resolve(ledgerCache)
  if (!force && ledgerInflight) return ledgerInflight
  const p = window.mahas.usage
    .ledger(tracked, force)
    .then((r) => {
      ledgerCache = r
      return r
    })
    .finally(() => {
      if (ledgerInflight === p) ledgerInflight = null
    })
  ledgerInflight = p
  return p
}

const emptyTok = (): TokenUse => ({ input: 0, output: 0, cached: 0, reasoning: 0, total: 0 })

function sumTokens(list: TokenUse[]): TokenUse {
  return list.reduce(
    (a, b) => ({
      input: a.input + b.input,
      output: a.output + b.output,
      cached: a.cached + b.cached,
      reasoning: a.reasoning + b.reasoning,
      total: a.total + b.total,
      costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) || undefined
    }),
    { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 }
  )
}

function mixParts(t: TokenUse): { cls: string; n: number }[] {
  const think = t.reasoning
  const out = think > 0 && think <= t.output ? t.output - think : t.output
  const cacheSlice = t.cached > 0 && t.cached <= t.input
  const fresh = cacheSlice ? t.input - t.cached : t.input
  const parts = [
    { cls: 'in', n: fresh },
    { cls: 'cache', n: t.cached },
    { cls: 'out', n: out },
    { cls: 'think', n: think }
  ]
  return parts.filter((p) => p.n > 0)
}

function MixBar({ t, height = 8 }: { t: TokenUse; height?: number }): React.JSX.Element {
  const parts = mixParts(t)
  const sum = parts.reduce((s, p) => s + p.n, 0) || 1
  return (
    <div className="dash-mix" style={{ height }}>
      {parts.map((p) => (
        <span
          key={p.cls}
          className={`dash-mix-seg ${p.cls}`}
          style={{ width: `${(p.n / sum) * 100}%` }}
        />
      ))}
    </div>
  )
}

function TokensBody(): React.JSX.Element {
  const t = useT()
  const agentSessions = useStore((s) => s.agentSessions)
  const tracked = useMemo<LedgerQuery[]>(() => {
    return Object.entries(agentSessions)
      .filter(([, info]) => !!info.provider)
      .map(([sessionId, info]) => ({
        sessionId,
        provider: info.provider ?? '',
        cwd: info.cwd,
        name: info.name
      }))
      .sort((a, b) => (agentSessions[b.sessionId]?.ts ?? 0) - (agentSessions[a.sessionId]?.ts ?? 0))
  }, [agentSessions])

  const [res, setRes] = useState<LedgerResult | null>(ledgerCache)
  const [busy, setBusy] = useState(false)
  const trackedRef = useRef(tracked)
  useEffect(() => {
    trackedRef.current = tracked
  }, [tracked])
  const load = (markBusy: boolean, force = false): void => {
    if (markBusy) setBusy(true)
    void fetchLedger(trackedRef.current, force)
      .then(setRes)
      .finally(() => {
        if (markBusy) setBusy(false)
      })
  }
  useEffect(() => {
    let on = true
    void fetchLedger(trackedRef.current).then((r) => {
      if (on) setRes(r)
    })
    return () => {
      on = false
    }
  }, [])
  const refresh = (): void => load(true, true)

  const jump = (sessionId: string): void => {
    const info = useStore.getState().agentSessions[sessionId]
    if (!info?.wsId || !info.paneId) return
    const st = useStore.getState()
    const pane = st.workspaces.find((w) => w.id === info.wsId)?.panes[info.paneId]
    if (!pane) return
    if (pane.detached) {
      window.mahas.win.focusDetached(info.wsId, pane.id)
      return
    }
    if (info.wsId !== st.activeWorkspaceId) st.activateWorkspace(info.wsId)
    st.focusPane(pane.id, info.wsId)
    if (info.tabId && pane.activeTabId !== info.tabId) {
      st.updatePane(pane.id, { activeTabId: info.tabId }, info.wsId)
    }
  }

  // Only sessions the app actually connected to (agentSessions — hook/pty
  // attributed) count: profiles aggregate from those, never the whole-disk
  // scan, so off-app harness usage stays out of the totals.
  const profiles = useMemo(() => {
    if (!res) return []
    const m = new Map<string, { provider: string; sessionCount: number; tokens: TokenUse }>()
    for (const s of res.sessions) {
      if (!s.found) continue
      const g = m.get(s.provider) ?? { provider: s.provider, sessionCount: 0, tokens: emptyTok() }
      g.sessionCount++
      g.tokens = sumTokens([g.tokens, s.tokens])
      m.set(s.provider, g)
    }
    return [...m.values()].sort((a, b) => b.tokens.total - a.tokens.total)
  }, [res])

  const all = useMemo(() => sumTokens(profiles.map((p) => p.tokens)), [profiles])
  const sessN = profiles.reduce((n, p) => n + p.sessionCount, 0)
  const shareMax = Math.max(1, ...profiles.map((p) => p.tokens.total))
  const sessMax = res
    ? Math.max(1, ...res.sessions.filter((s) => s.found).map((s) => s.tokens.total))
    : 1
  const cost = all?.costUsd && all.costUsd > 0 ? fmtUsd(all.costUsd) : ''

  return (
    <div className="dash">
      <div className="dash-inner">
        <div className="dash-head">
          <span className="dash-title">{t('widgetTokens')}</span>
          <Tooltip label={t('refresh')}>
            <button className="pbtn" onClick={refresh} disabled={busy}>
              <RefreshCw className={busy ? 'spin' : ''} />
            </button>
          </Tooltip>
        </div>
        {!res && (
          <div className="dash-loading">
            <Loader2 className="spin" />
            <span>{t('loading')}</span>
          </div>
        )}
        {res && all && (
          <>
            <div className="dash-kpis">
              <div className="dash-kpi">
                <span className="dash-kpi-l">{t('tokensTotal')}</span>
                <span className="dash-kpi-v">{fmtTok(all.total || all.input + all.output)}</span>
              </div>
              <div className="dash-kpi">
                <span className="dash-kpi-l">{t('tokensSessions')}</span>
                <span className="dash-kpi-v">{sessN}</span>
              </div>
              <div className="dash-kpi">
                <span className="dash-kpi-l">{t('tokensCached')}</span>
                <span className="dash-kpi-v">{fmtTok(all.cached)}</span>
              </div>
              {cost && (
                <div className="dash-kpi">
                  <span className="dash-kpi-l">{t('tokensCost')}</span>
                  <span className="dash-kpi-v">{cost}</span>
                </div>
              )}
            </div>

            <div className="dash-sec">{t('tokensShare')}</div>
            {profiles.length ? (
              <div className="dash-share">
                {profiles.map((p) => {
                  const tot = all.total || all.input + all.output || 1
                  const pct = ((p.tokens.total || p.tokens.input) / tot) * 100
                  if (pct < 0.4) return null
                  return (
                    <span
                      key={p.provider}
                      className="dash-share-seg"
                      style={{
                        width: `${pct}%`,
                        background: agentColor(p.provider) ?? 'var(--accent)'
                      }}
                      title={`${agentLabel(p.provider)} ${Math.round(pct)}%`}
                    />
                  )
                })}
              </div>
            ) : null}
            <div className="dash-legend">
              {profiles.map((p) => (
                <span key={p.provider} className="dash-leg">
                  <i style={{ background: agentColor(p.provider) ?? 'var(--accent)' }} />
                  {agentLabel(p.provider)}
                </span>
              ))}
            </div>

            <div className="dash-sec">{t('tokensProfile')}</div>
            {profiles.length ? (
              <div className="dash-grid">
                {profiles.map((p) => {
                  const tot = p.tokens.total || p.tokens.input + p.tokens.output
                  return (
                    <div key={p.provider} className="dash-card">
                      <div className="dash-card-h">
                        <AgentIcon id={p.provider} size={16} />
                        <span className="dash-card-n">{agentLabel(p.provider)}</span>
                        <span className="dash-card-s">{p.sessionCount}</span>
                      </div>
                      <div className="dash-card-v">{fmtTok(tot)}</div>
                      <MixBar t={p.tokens} />
                      <div
                        className="dash-share-mini"
                        style={{
                          width: `${(tot / shareMax) * 100}%`,
                          background: agentColor(p.provider) ?? 'var(--accent)'
                        }}
                      />
                      <div className="dash-stats">
                        <span>
                          <b className="in">{fmtTok(p.tokens.input)}</b>
                          {t('tokensIn')}
                        </span>
                        <span>
                          <b className="out">{fmtTok(p.tokens.output)}</b>
                          {t('tokensOut')}
                        </span>
                        <span>
                          <b className="cache">{fmtTok(p.tokens.cached)}</b>
                          {t('tokensCached')}
                        </span>
                        {p.tokens.reasoning > 0 && (
                          <span>
                            <b className="think">{fmtTok(p.tokens.reasoning)}</b>
                            {t('tokensThink')}
                          </span>
                        )}
                        {p.tokens.costUsd ? (
                          <span>
                            <b>{fmtUsd(p.tokens.costUsd)}</b>
                            {t('tokensCost')}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="usage-note">{t('tokensEmpty')}</div>
            )}

            <div className="dash-sec">{t('tokensTracked')}</div>
            {res.sessions.length ? (
              <div className="dash-table">
                {res.sessions.map((s) => {
                  const tot = s.found ? s.tokens.total || s.tokens.input + s.tokens.output : 0
                  return (
                    <button
                      key={`${s.provider}:${s.sessionId}`}
                      className="dash-sess"
                      onClick={() => jump(s.sessionId)}
                    >
                      <AgentIcon id={s.provider} size={14} />
                      <span className="dash-sess-t">
                        <span className="dash-sess-n">{s.title || s.sessionId.slice(0, 12)}</span>
                        {s.cwd && <span className="dash-sess-c">{shortPath(s.cwd)}</span>}
                      </span>
                      <span className="dash-sess-bar">
                        {s.found ? (
                          <>
                            <span className="dash-sess-track">
                              <span
                                className="dash-sess-fill"
                                style={{ width: `${(tot / sessMax) * 100}%` }}
                              >
                                <MixBar t={s.tokens} height={6} />
                              </span>
                            </span>
                            <span className="dash-sess-v">{fmtTok(tot)}</span>
                          </>
                        ) : (
                          <span className="dash-sess-miss">{t('tokensUnknown')}</span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="usage-note">{t('tokensNone')}</div>
            )}
            <div className="usage-foot">{new Date(res.fetchedAt).toLocaleTimeString()}</div>
          </>
        )}
      </div>
    </div>
  )
}

export default function WidgetTabView({
  wsId,
  paneId,
  tab
}: {
  wsId: string
  paneId: string
  tab: WidgetTab
}): React.JSX.Element {
  // the widget kind is fixed at creation (the + menu's widget submenu) —
  // the usage widget's harness selection rides the tab record so it persists
  const tabId = tab.id
  const onProviders = useCallback(
    (ids: string[]): void => {
      const st = useStore.getState()
      const p = st.workspaces.find((w) => w.id === wsId)?.panes[paneId]
      if (!p) return
      st.updatePane(
        paneId,
        {
          tabs: p.tabs.map((x) =>
            x.id === tabId
              ? ({
                  ...x,
                  providers: ids,
                  provider: ids[0] ? srcProvider(ids[0]) : undefined
                } as typeof x)
              : x
          )
        },
        wsId
      )
    },
    [wsId, paneId, tabId]
  )
  const projectId = useStore((s) => s.workspaces.find((w) => w.id === wsId)?.projectId)
  useEffect(() => {
    if (projectId) useWorkbench.getState().setContext({ projectId })
  }, [projectId])

  return (
    <div className="widget">
      {tab.widget === 'usage' ? (
        <UsageBody providers={tab.providers} onProviders={onProviders} />
      ) : tab.widget === 'tokens' ? (
        <TokensBody />
      ) : tab.widget === 'responsibility' ? (
        <ResponsibilityView />
      ) : tab.widget === 'team' ? (
        <TeamView />
      ) : tab.widget === 'plan' ? (
        <PlanView />
      ) : tab.widget === 'inspector' ? (
        <InspectorView />
      ) : (
        <AgentsPanel wsId={wsId} />
      )}
    </div>
  )
}
