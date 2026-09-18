import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import type { LedgerQuery, LedgerResult, TokenUse, UsageResult, WidgetTab } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import { agentColor, agentLabel, agentProviders } from '../agents'
import { fmtTok, fmtUsd, shortPath } from '../utils'
import AgentIcon from './AgentIcon'
import AgentsPanel from './AgentsPanel'
import Tooltip from './Tooltip'
import { Select } from './Menu'

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
  'copilot'
]

// module-level cache: every usage widget shares a provider's snapshot
const usageCache = new Map<string, UsageResult>()
const inflight = new Map<string, Promise<UsageResult>>()

function fetchUsage(provider: string): Promise<UsageResult> {
  let p = inflight.get(provider)
  if (!p) {
    p = window.mahas.usage
      .fetch(provider)
      .then((res) => {
        usageCache.set(provider, res)
        return res
      })
      .catch((e) => ({ ok: false, provider, windows: [], error: String(e), fetchedAt: Date.now() }))
      .finally(() => inflight.delete(provider))
    inflight.set(provider, p)
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

function usageCatalog(): string[] {
  const manifest = agentProviders()
  return [
    ...USAGE_PROVIDERS.filter((id) => manifest[id]),
    ...Object.keys(manifest).filter((id) => !USAGE_PROVIDERS.includes(id))
  ]
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

function UsageBody({
  providers,
  onProviders
}: {
  providers: string[] | undefined
  onProviders: (ids: string[]) => void
}): React.JSX.Element {
  const t = useT()
  const catalog = usageCatalog()
  const catalogKey = catalog.join('|')
  const selected = providers ? providers.filter((id) => catalog.includes(id)) : catalog
  const selectedKey = selected.join('|')
  const [rows, setRows] = useState<Record<string, UsageResult>>(() => {
    const init: Record<string, UsageResult> = {}
    for (const id of selected) {
      const hit = usageCache.get(id)
      if (hit) init[id] = hit
    }
    return init
  })
  const [busy, setBusy] = useState(false)

  // old tabs only stored `provider`; open them as the full dashboard once
  // the catalog is known. after the user toggles, `providers` is the source.
  useEffect(() => {
    if (providers) return
    if (!catalogKey) return
    onProviders(catalogKey.split('|'))
  }, [providers, catalogKey, onProviders])

  const pull = (ids: string[]): Promise<void> =>
    Promise.all(ids.map((id) => fetchUsage(id))).then((list) => {
      setRows((prev) => {
        const next = { ...prev }
        for (const r of list) next[r.provider] = r
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
      void Promise.all(selected.map((id) => fetchUsage(id))).then((list) => {
        if (!on) return
        setRows((prev) => {
          const next = { ...prev }
          for (const r of list) next[r.provider] = r
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

  const options = catalog.map((id) => ({
    value: id,
    label: (
      <span className="sel-agent">
        <AgentIcon id={id} size={12} />
        {agentLabel(id)}
      </span>
    )
  }))
  const summary =
    selected.length === 0 ? (
      t('usageNone')
    ) : selected.length === 1 ? (
      <span className="sel-agent">
        <AgentIcon id={selected[0]} size={12} />
        {agentLabel(selected[0])}
      </span>
    ) : (
      <span className="sel-agent">
        {selected.slice(0, 3).map((id) => (
          <AgentIcon key={id} id={id} size={12} />
        ))}
        {t('usageSelected', { n: String(selected.length) })}
      </span>
    )

  const shown = selected.map((id) => rows[id]).filter(Boolean)
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
        </div>
        {!selected.length ? (
          <div className="usage-note">{t('usageNone')}</div>
        ) : (
          <>
            <div className="dash-kpis">
              <div className="dash-kpi">
                <span className="dash-kpi-l">{t('agents')}</span>
                <span className="dash-kpi-v">{selected.length}</span>
              </div>
              <div className="dash-kpi">
                <span className="dash-kpi-l">{t('usageReporting')}</span>
                <span className="dash-kpi-v">
                  {ok.length}/{selected.length}
                </span>
              </div>
              <div className="dash-kpi">
                <span className="dash-kpi-l">{t('usagePeak')}</span>
                <span className="dash-kpi-v">{peak < 0 ? '—' : `${Math.round(peak)}%`}</span>
              </div>
            </div>
            <div className="dash-grid">
              {selected.map((id) => {
                const res = rows[id]
                return (
                  <div key={id} className="dash-card">
                    <div className="dash-card-h">
                      <AgentIcon id={id} size={16} />
                      <span className="dash-card-n">{agentLabel(id)}</span>
                      {res?.plan && <span className="dash-card-s">{res.plan}</span>}
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

  const all = res ? sumTokens(res.profiles.map((p) => p.tokens)) : null
  const sessN = res ? res.profiles.reduce((n, p) => n + p.sessionCount, 0) : 0
  const shareMax = res ? Math.max(1, ...res.profiles.map((p) => p.tokens.total)) : 1
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
            {res.profiles.length ? (
              <div className="dash-share">
                {res.profiles.map((p) => {
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
              {res.profiles.map((p) => (
                <span key={p.provider} className="dash-leg">
                  <i style={{ background: agentColor(p.provider) ?? 'var(--accent)' }} />
                  {agentLabel(p.provider)}
                </span>
              ))}
            </div>

            <div className="dash-sec">{t('tokensProfile')}</div>
            {res.profiles.length ? (
              <div className="dash-grid">
                {res.profiles.map((p) => {
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
            x.id === tabId ? ({ ...x, providers: ids, provider: ids[0] } as typeof x) : x
          )
        },
        wsId
      )
    },
    [wsId, paneId, tabId]
  )

  return (
    <div className="widget">
      {tab.widget === 'usage' ? (
        <UsageBody providers={tab.providers} onProviders={onProviders} />
      ) : tab.widget === 'tokens' ? (
        <TokensBody />
      ) : (
        <AgentsPanel wsId={wsId} />
      )}
    </div>
  )
}
