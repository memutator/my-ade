// The tokens widget: stored usage per harness, per session, plus the stored
// weekly/hourly statistics.
//
// What changed from the scanner version is not the look but the source of
// truth: totals come from the daemon's persisted aggregate rows and ledger
// entries, so closing the widget (or deleting the transcripts) does not change
// them, and every number carries the coverage it was computed under. The widget
// never reads a transcript, and the only sum it performs is over PERSISTED rows
// for presentation — flagged with ≈ when any component the store knows is
// missing.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import { agentColor, agentLabel } from '../../agents'
import { fmtTok, fmtUsd } from '../../utils'
import AgentIcon from '../../components/AgentIcon'
import Tooltip from '../../components/Tooltip'
import SessionsPanel from '../sessions/SessionsPanel'
import {
  loadSessionDetails,
  loadStoredSessions,
  storedSessionRows,
  type SessionDetailView
} from '../sessions/domain'
import {
  loadUsageLedger,
  loadUsageStatistics,
  loadUsageSummaries,
  requestCollection
} from './domain'
import { MixBar, UnknownMark } from './MixBar'
import StatisticsPanel from './StatisticsPanel'
import UsageBreakdowns from './UsageBreakdowns'
import {
  coverageLabelKey,
  displayTotal,
  harnessTotals,
  sessionUsageRows,
  statisticCards,
  globalSummary,
  emptyValues,
  usageLabel,
  usageNumber,
  type HarnessTotalsView
} from './view-model'
import type {
  DomainSessionsResult,
  DomainUsageLedgerResult,
  DomainUsageStatisticsResult,
  DomainUsageSummariesResult
} from '../../../../preload/domain'

export default function TokensWidget(): React.JSX.Element {
  const t = useT()
  const agentSessions = useStore((s) => s.agentSessions)

  const [summaries, setSummaries] = useState<DomainUsageSummariesResult | null>(null)
  const [ledger, setLedger] = useState<DomainUsageLedgerResult | null>(null)
  const [statistics, setStatistics] = useState<DomainUsageStatisticsResult[]>([])
  const [sessions, setSessions] = useState<DomainSessionsResult | null>(null)
  const [details, setDetails] = useState<Record<string, SessionDetailView>>({})
  const [headline, setHeadline] = useState<DomainUsageSummariesResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string>()

  /** every stored read the widget needs, in one round */
  const fetchAll = useCallback(async (): Promise<{
    stored: Awaited<ReturnType<typeof loadStoredSessions>>
    summaries: Awaited<ReturnType<typeof loadUsageSummaries>>
    ledger: Awaited<ReturnType<typeof loadUsageLedger>>
    weekly: Awaited<ReturnType<typeof loadUsageStatistics>>
    hourly: Awaited<ReturnType<typeof loadUsageStatistics>>
    hourOfDay: Awaited<ReturnType<typeof loadUsageStatistics>>
    headline: Awaited<ReturnType<typeof loadUsageSummaries>>
  }> => {
    const [
      stored,
      summaryResult,
      ledgerResult,
      weeklyResult,
      hourlyResult,
      hourOfDayResult,
      headlineResult
    ] = await Promise.all([
      loadStoredSessions({ limit: 200 }),
      loadUsageSummaries({ grain: 'all-time' }),
      loadUsageLedger({ limit: 2_000 }),
      loadUsageStatistics({ metric: 'weekly-average' }),
      loadUsageStatistics({ metric: 'hourly-by-date' }),
      loadUsageStatistics({ metric: 'hour-of-day-distribution' }),
      loadUsageSummaries({ grain: 'all-time', dimensionKeys: [], limit: 1 })
    ])
    return {
      stored,
      summaries: summaryResult,
      ledger: ledgerResult,
      weekly: weeklyResult,
      hourly: hourlyResult,
      hourOfDay: hourOfDayResult,
      headline: headlineResult
    }
  }, [])

  const apply = useCallback((data: Awaited<ReturnType<typeof fetchAll>>): void => {
    if (data.stored.ok) setSessions(data.stored.value)
    if (data.summaries.ok) setSummaries(data.summaries.value)
    if (data.ledger.ok) setLedger(data.ledger.value)
    const stats: DomainUsageStatisticsResult[] = []
    if (data.weekly.ok) stats.push(data.weekly.value)
    if (data.hourly.ok) stats.push(data.hourly.value)
    if (data.hourOfDay.ok) stats.push(data.hourOfDay.value)
    setStatistics(stats)
    if (data.headline.ok) setHeadline(data.headline.value)
  }, [])

  useEffect(() => {
    let live = true
    void fetchAll().then((data) => {
      if (live) apply(data)
    })
    return () => {
      live = false
    }
  }, [fetchAll, apply])

  const refresh = async (): Promise<void> => {
    setBusy(true)
    setNote(undefined)
    const requested = await requestCollection({ capability: 'usage', reason: 'tokens-widget' })
    if (!requested.ok) setNote(t('usageCollectUnavailable', { error: requested.error.message }))
    else if (requested.value.detail) setNote(requested.value.detail)
    apply(await fetchAll())
    setBusy(false)
  }

  const totals: HarnessTotalsView[] = useMemo(
    () => (summaries ? harnessTotals(summaries.items) : []),
    [summaries]
  )
  const sessionRows = useMemo(() => (ledger ? sessionUsageRows(ledger.items) : []), [ledger])
  const storedRows = useMemo(() => (sessions ? storedSessionRows(sessions) : []), [sessions])
  const statCards = useMemo(
    () => statistics.flatMap((result) => statisticCards(result.items)),
    [statistics]
  )

  // The independent {} rollup covers the entire store, regardless of which
  // pages are loaded for the breakdown or session list.
  const grand = useMemo(() => (headline ? globalSummary(headline.items) : undefined), [headline])
  const grandValues = grand?.totals ?? emptyValues()
  const grandTotal = displayTotal(grandValues)
  const grandTotalNumber = usageNumber(grandTotal)
  const grandPartial =
    !!grand && (grand.totals.total === null || grand.coverage.completeness !== 'complete')
  const liveKey = Object.entries(agentSessions)
    .map(([id, info]) => [id, info.provider, info.wsId, info.paneId, info.tabId].join(':'))
    .sort()
    .join('|')
  useEffect(() => {
    let active = true
    void loadSessionDetails(storedRows, { live: useStore.getState().agentSessions }).then(
      (result) => {
        if (active) setDetails(result.byId)
      }
    )
    return () => {
      active = false
    }
  }, [storedRows, liveKey])

  const more = !!(summaries?.nextCursor || sessions?.nextCursor || ledger?.nextCursor)
  const loadMore = async (): Promise<void> => {
    setBusy(true)
    const [summaryPage, sessionPage, ledgerPage] = await Promise.all([
      summaries?.nextCursor
        ? loadUsageSummaries({ grain: 'all-time', cursor: summaries.nextCursor })
        : null,
      sessions?.nextCursor
        ? loadStoredSessions({ afterId: sessions.nextCursor, limit: 200 })
        : null,
      ledger?.nextCursor ? loadUsageLedger({ afterId: ledger.nextCursor, limit: 2_000 }) : null
    ])
    if (summaryPage?.ok) {
      const next = summaryPage.value
      // A new publication invalidates prior pages. Refresh before combining
      // them, and keep asynchronous effects outside React state updaters.
      if (summaries && next.aggregateGeneration !== summaries.aggregateGeneration) {
        apply(await fetchAll())
        setBusy(false)
        return
      }
      setSummaries((previous) => ({
        ...next,
        items: [
          ...new Map(
            [...(previous?.items ?? []), ...next.items].map((row) => [row.key, row])
          ).values()
        ]
      }))
    }
    if (sessionPage?.ok)
      setSessions((previous) => ({
        ...sessionPage.value,
        items: [
          ...new Map(
            [...(previous?.items ?? []), ...sessionPage.value.items].map((row) => [row.id, row])
          ).values()
        ]
      }))
    if (ledgerPage?.ok)
      setLedger((previous) => ({
        ...ledgerPage.value,
        items: [
          ...new Map(
            [...(previous?.items ?? []), ...ledgerPage.value.items].map((row) => [
              row.entry.id,
              row
            ])
          ).values()
        ]
      }))
    const errors = [summaryPage, sessionPage, ledgerPage].flatMap((result) =>
      result && !result.ok ? [result.error.message] : []
    )
    if (errors.length) setNote(errors.join(' · '))
    setBusy(false)
  }
  const cost = sessionRows.reduce(
    (sum, row) => (row.costUsd === undefined ? sum : sum + row.costUsd),
    0
  )
  const hasCost = sessionRows.some((row) => row.costUsd !== undefined)
  const newest = Math.max(
    summaries?.freshness.asOf ?? 0,
    ledger?.freshness.asOf ?? 0,
    ...statistics.map((result) => result.freshness.asOf)
  )
  const diagnostics = [
    ...(summaries?.readiness.diagnostics ?? []),
    ...(headline?.readiness.diagnostics ?? []),
    ...(ledger?.readiness.diagnostics ?? []),
    ...statistics.flatMap((result) => result.readiness.diagnostics),
    ...(sessions?.readiness.diagnostics ?? [])
  ]
  const storeDown = summaries?.readiness.state === 'unavailable' && !summaries.items.length
  // only the aggregate projection reports "stored rows not yet aggregated"; the
  // ledger envelope carries asOf/lastSuccessfulCollectionAt instead
  const pending = summaries?.pending ?? false

  const jump = (sessionId: string): void => {
    const info = useStore.getState().agentSessions[sessionId]
    if (!info?.wsId || !info.paneId) return
    const store = useStore.getState()
    const pane = store.workspaces.find((workspace) => workspace.id === info.wsId)?.panes[
      info.paneId
    ]
    if (!pane) return
    if (pane.minimized) store.restorePane(pane.id, info.wsId)
    if (info.tabId)
      store.updatePane(
        pane.id,
        {
          activeTabId: info.tabId,
          tabs: pane.tabs.map((tab) => (tab.id === info.tabId ? { ...tab, minimized: false } : tab))
        },
        info.wsId
      )
    if (pane.detached) {
      window.mahas.win.focusDetached(info.wsId, pane.id)
      return
    }
    if (info.wsId !== store.activeWorkspaceId) store.activateWorkspace(info.wsId)
    store.focusPane(pane.id, info.wsId)
  }

  // geometry only: the widest harness bar, where an unknown total contributes 0
  const shareMax = Math.max(1, ...totals.map((entry) => usageNumber(displayTotal(entry.totals))))

  return (
    <div className="dash">
      <div className="dash-inner">
        <div className="dash-head">
          <span className="dash-title">{t('widgetTokens')}</span>
          <Tooltip label={t('usageRefreshStored')}>
            <button className="pbtn" onClick={() => void refresh()} disabled={busy}>
              <RefreshCw className={busy ? 'spin' : ''} />
            </button>
          </Tooltip>
        </div>

        {note && <div className="usage-note">{note}</div>}
        {storeDown && (
          <div className="usage-note err">
            {t('usageStoreUnavailable', { error: summaries.readiness.diagnostics[0] ?? '' })}
          </div>
        )}
        {!summaries && (
          <div className="dash-loading">
            <Loader2 className="spin" />
            <span>{t('loading')}</span>
          </div>
        )}

        {summaries && (
          <>
            <div className="dash-kpis">
              <div className="dash-kpi">
                <span className="dash-kpi-l">{t('tokensTotal')}</span>
                <span
                  className="dash-kpi-v"
                  title={grandPartial ? t('tokensLowerBound') : undefined}
                >
                  {grandPartial ? <em className="cov-unknown">≈</em> : null}
                  {usageLabel(grandTotal)}
                </span>
              </div>
              <div className="dash-kpi">
                <span className="dash-kpi-l">{t('tokensLoadedSessions')}</span>
                <span className="dash-kpi-v">
                  {sessions?.nextCursor ? '≥' : ''}
                  {storedRows.length}
                </span>
              </div>
              <div className="dash-kpi">
                <span className="dash-kpi-l">{t('tokensCached')}</span>
                <span className="dash-kpi-v">{usageLabel(grandValues.cacheReadInput)}</span>
              </div>
              {hasCost && (
                <div className="dash-kpi">
                  <span className="dash-kpi-l">{t('tokensLoadedCost')}</span>
                  <span className="dash-kpi-v">{fmtUsd(cost) || '—'}</span>
                </div>
              )}
            </div>

            <div className="dash-sec">{t('tokensShare')}</div>
            {totals.length ? (
              <div className="dash-share">
                {totals.map((entry) => {
                  const harnessTotal = displayTotal(entry.totals)
                  // a harness with an unknown total is omitted from the share
                  // rather than drawn as 0%
                  const share =
                    harnessTotal !== null && grandTotalNumber > 0
                      ? (harnessTotal / grandTotalNumber) * 100
                      : 0
                  if (share < 0.4) return null
                  return (
                    <span
                      key={entry.id}
                      className="dash-share-seg"
                      style={{
                        width: `${share}%`,
                        background: agentColor(entry.id) ?? 'var(--accent)'
                      }}
                      title={`${agentLabel(entry.id)} ${Math.round(share)}%`}
                    />
                  )
                })}
              </div>
            ) : null}
            <div className="dash-legend">
              {totals.map((entry) => (
                <span key={entry.id} className="dash-leg">
                  <i style={{ background: agentColor(entry.id) ?? 'var(--accent)' }} />
                  {agentLabel(entry.id)}
                </span>
              ))}
            </div>

            <div className="dash-sec">{t('tokensProfile')}</div>
            {totals.length ? (
              <div className="dash-grid">
                {totals.map((entry) => (
                  <div key={entry.id} className="dash-card">
                    <div className="dash-card-h">
                      <AgentIcon id={entry.id} size={16} />
                      <span className="dash-card-n">{agentLabel(entry.id)}</span>
                      <span className="dash-card-s">{fmtTok(entry.coverage.knownTokens)}</span>
                      {entry.coverage.completeness !== 'complete' && (
                        <span className="cov-chip warn">{t('tokensPartial')}</span>
                      )}
                      {entry.pending && <span className="cov-chip warn">{t('usagePending')}</span>}
                    </div>
                    <div className="dash-card-v">
                      <UnknownMark values={entry.totals} />
                      {usageLabel(displayTotal(entry.totals))}
                    </div>
                    <MixBar values={entry.totals} />
                    <div
                      className="dash-share-mini"
                      style={{
                        width: `${(usageNumber(displayTotal(entry.totals)) / shareMax) * 100}%`,
                        background: agentColor(entry.id) ?? 'var(--accent)'
                      }}
                    />
                    <div className="dash-stats">
                      <span>
                        <b className="in">{usageLabel(entry.totals.inputTotal)}</b>
                        {t('tokensIn')}
                      </span>
                      <span>
                        <b className="out">{usageLabel(entry.totals.outputTotal)}</b>
                        {t('tokensOut')}
                      </span>
                      <span>
                        <b className="cache">{usageLabel(entry.totals.cacheReadInput)}</b>
                        {t('tokensCached')}
                      </span>
                      <span>
                        <b className="think">{usageLabel(entry.totals.reasoningOutput)}</b>
                        {t('tokensThink')}
                      </span>
                    </div>
                    <div className="dash-covline">
                      {entry.coverage.unknownTokens !== null &&
                        entry.coverage.unknownTokens > 0 && (
                          <span className="cov-unknown">{t('tokensUnknownComponents')}</span>
                        )}
                      {entry.coverage.unallocatedTimeTokens > 0 && (
                        <span className="cov-unknown">
                          {t('statsUnallocated', {
                            n: fmtTok(entry.coverage.unallocatedTimeTokens)
                          })}
                        </span>
                      )}
                      {entry.attribution.unattributedTokens > 0 && (
                        <span className="cov-unknown">
                          {t('tokensUnattributed', {
                            n: fmtTok(entry.attribution.unattributedTokens)
                          })}
                        </span>
                      )}
                      <span>{t(coverageLabelKey(entry.coverage.completeness))}</span>
                      <span>
                        {t('tokensComputed', { at: new Date(entry.computedAt).toLocaleString() })}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="usage-note">{t('tokensEmpty')}</div>
            )}

            <UsageBreakdowns
              summaries={
                grand
                  ? [grand, ...summaries.items.filter((row) => row.key !== grand.key)]
                  : summaries.items
              }
              partial={!!summaries.nextCursor}
            />
            <div className="dash-sec">{t('statsTitle')}</div>
            <StatisticsPanel cards={statCards} />

            <div className="dash-sec">{t('tokensTracked')}</div>
            <SessionsPanel
              stored={storedRows}
              usage={sessionRows}
              live={agentSessions}
              onOpen={jump}
              details={details}
              truncated={!!sessions?.nextCursor}
            />

            {storedRows.length > Object.keys(details).length && (
              <div className="usage-note">
                {t('tokensDetailsLoaded', {
                  n: String(Object.keys(details).length),
                  total: String(storedRows.length)
                })}
              </div>
            )}
            {more && (
              <div className="usage-note">
                {t('tokensPartialLists')}{' '}
                <button className="pbtn" onClick={() => void loadMore()} disabled={busy}>
                  {t('tokensLoadMore')}
                </button>
              </div>
            )}

            <div className="dash-fresh">
              {newest > 0 && (
                <span>{t('usageStoredAt', { at: new Date(newest).toLocaleString() })}</span>
              )}
              {pending && <span className="cov-chip warn">{t('usagePending')}</span>}
              {diagnostics.length > 0 && (
                <span className="cov-chip unknown" title={diagnostics.join('\n')}>
                  {t('usagePartial')}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
