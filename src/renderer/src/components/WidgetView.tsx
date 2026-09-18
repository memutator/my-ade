import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { UsageResult, WidgetTab } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import { agentLabel, agentProviders } from '../agents'
import AgentIcon from './AgentIcon'
import AgentsPanel from './AgentsPanel'
import Tooltip from './Tooltip'
import { Select } from './Menu'

/* A 'widget' block — chromeless mini-tools stacked in a leaf like any other
   tab. Two kinds today: 'agents' (the workspace's per-pane session list,
   same view as the sidebar section) and 'usage' (a per-harness rate-limit
   dashboard fed by the `usage:fetch` IPC — each CLI's own credentials and
   read-only usage endpoint). */

const POLL_MS = 180_000 // claude's usage endpoint is safe at ~3min cadence

// providers main knows how to probe — the select lists them first
const USAGE_PROVIDERS = ['claude', 'codex', 'gemini', 'copilot', 'zcode']

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

function UsageBody({
  provider,
  onProvider
}: {
  provider: string | undefined
  onProvider: (p: string) => void
}): React.JSX.Element {
  const t = useT()
  const manifest = agentProviders()
  // default to the first probeable provider actually running here, else
  // the first one the manifest lists
  const current =
    provider ??
    (() => {
      const running = new Set<string>()
      for (const w of useStore.getState().workspaces) {
        for (const p of Object.values(w.panes)) {
          for (const tab of p.tabs) {
            if (tab.kind === 'term' && tab.agent) running.add(tab.agent)
          }
        }
      }
      return (
        USAGE_PROVIDERS.find((id) => running.has(id)) ??
        USAGE_PROVIDERS.find((id) => manifest[id]) ??
        'claude'
      )
    })()
  const [res, setRes] = useState<UsageResult | null>(usageCache.get(current) ?? null)
  const [busy, setBusy] = useState(false)
  // never render a stale result for another provider — while a fetch is in
  // flight, fall back to the cached snapshot for the current provider
  const shown = res && res.provider === current ? res : (usageCache.get(current) ?? null)

  const refresh = (): void => {
    setBusy(true)
    void fetchUsage(current)
      .then(setRes)
      .finally(() => setBusy(false))
  }

  // fetch on provider switch + a slow poll while mounted (the endpoint's own
  // budget is per-token; 3min is comfortably under it)
  useEffect(() => {
    const run = (): void => {
      void fetchUsage(current).then(setRes)
    }
    run()
    const id = setInterval(run, POLL_MS)
    return () => clearInterval(id)
  }, [current])

  const options = [
    ...USAGE_PROVIDERS.filter((id) => manifest[id]),
    ...Object.keys(manifest).filter((id) => !USAGE_PROVIDERS.includes(id))
  ].map((id) => ({
    value: id,
    label: (
      <span className="sel-agent">
        <AgentIcon id={id} size={12} />
        {agentLabel(id)}
      </span>
    )
  }))

  return (
    <div className="usage">
      <div className="usage-ctl">
        <Select value={current} options={options} onChange={onProvider} className="usage-sel" />
        <Tooltip label={t('refresh')}>
          <button className="pbtn" onClick={refresh} disabled={busy}>
            <RefreshCw className={busy ? 'spin' : ''} />
          </button>
        </Tooltip>
      </div>
      {!shown && <div className="usage-note">{t('loading')}</div>}
      {shown && !shown.ok && (
        <div className="usage-note err">
          {shown.error === 'unsupported'
            ? t('usageUnsupported', { agent: agentLabel(current) })
            : shown.error}
        </div>
      )}
      {shown?.plan && <div className="usage-plan">{shown.plan}</div>}
      {shown?.windows.map((w) => (
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
      {shown?.extra && <div className="usage-sub">{shown.extra}</div>}
      {shown && <div className="usage-foot">{new Date(shown.fetchedAt).toLocaleTimeString()}</div>}
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
  // the only mutable field is the usage widget's provider selection, which
  // rides the tab record so it persists like every other tab field
  const onProvider = (provider: string): void => {
    const st = useStore.getState()
    const p = st.workspaces.find((w) => w.id === wsId)?.panes[paneId]
    if (!p) return
    st.updatePane(
      paneId,
      { tabs: p.tabs.map((x) => (x.id === tab.id ? ({ ...x, provider } as typeof x) : x)) },
      wsId
    )
  }

  return (
    <div className="widget">
      {tab.widget === 'usage' ? (
        <UsageBody provider={tab.provider} onProvider={onProvider} />
      ) : (
        <AgentsPanel wsId={wsId} />
      )}
    </div>
  )
}
