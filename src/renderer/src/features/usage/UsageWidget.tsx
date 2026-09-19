// The usage widget: provider quota as the domain store knows it.
//
// Every card here is a stored QuotaReading. Opening the widget, refreshing the
// list or switching its selection performs NO credential I/O, no provider HTTP
// and no file scan — those moved to the daemon's collection scheduler. What the
// UI can additionally do is ASK for collection (`requestCollection`), which is a
// separate operation with its own result: if the scheduler is unavailable the
// stored numbers stay on screen and the request is reported as unhandled.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link2, Plus, RefreshCw, UserPlus, X } from 'lucide-react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import { agentLabel, agentProviders } from '../../agents'
import AgentIcon from '../../components/AgentIcon'
import Tooltip from '../../components/Tooltip'
import { Dropdown, Select } from '../../components/Menu'
import UsageAuthPanel from './AuthPanel'
import { legacyAccountRecords, toLegacySource } from './compat'
import { importAuthFile, loadUsageSources, removeUsageSource, requestCollection } from './domain'
import { quotaCards, type QuotaCardView } from './view-model'
import type { DomainAuthOutcome, DomainUsageSourcesResult } from '../../../../preload/domain'
import type { UsageAccount } from '../../types'

/** stored reads are cheap, but polling keeps a long-open widget in step with
 *  background collection without hammering the daemon */
const POLL_MS = 120_000

const NO_ACCOUNTS: UsageAccount[] = []

function fmtReset(resetAt: number): string {
  const delta = resetAt - Date.now()
  if (delta <= 0) return 'now'
  const minutes = Math.round(delta / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function stamp(at: number | undefined): string {
  return at ? new Date(at).toLocaleString() : '—'
}

/** one card's quota meters — an unknown meter prints as unknown, never 0% */
function QuotaWindows({ card }: { card: QuotaCardView }): React.JSX.Element {
  const t = useT()
  if (!card.windows.length) {
    return (
      <div className={card.state === 'failed' ? 'usage-note err' : 'usage-note'}>
        {card.state === 'failed'
          ? (card.failureMessage ?? t('usageStoreEmpty'))
          : card.state === 'legacy'
            ? t('usageLegacyNote')
            : t('usageStoreEmpty')}
      </div>
    )
  }
  return (
    <>
      {card.windows.map((window) => (
        <div key={window.id} className="usage-row">
          <div className="usage-row-head">
            <span className="usage-label">{window.label}</span>
            <span className="usage-nums">
              {window.usedPct !== undefined
                ? `${Math.round(window.usedPct)}%`
                : (window.detail ?? t('usageUnknown'))}
              {window.resetAt !== undefined && (
                <em className="usage-reset"> · {fmtReset(window.resetAt)}</em>
              )}
            </span>
          </div>
          {window.usedPct !== undefined && (
            <div className="u-bar">
              <div
                className={`u-fill${window.usedPct >= 90 ? ' crit' : window.usedPct >= 70 ? ' warn' : ''}`}
                style={{ width: `${Math.min(100, Math.max(0, window.usedPct))}%` }}
              />
            </div>
          )}
          {window.usedPct !== undefined && window.detail && (
            <div className="usage-sub">{window.detail}</div>
          )}
        </div>
      ))}
      {card.failureMessage && <div className="usage-note err">{card.failureMessage}</div>}
    </>
  )
}

function QuotaCard({
  card,
  label,
  onRemove
}: {
  card: QuotaCardView
  label: string
  onRemove?: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="dash-card">
      <div className="dash-card-h">
        <span className="dash-card-n">{label}</span>
        {card.planLabel && <span className="dash-card-s">{card.planLabel}</span>}
        {card.origin === 'legacy' && (
          <span className="cov-chip unknown">{t('usageLegacyChip')}</span>
        )}
        {onRemove && (
          <Tooltip label={t('usageRemoveAccount')}>
            <button className="pbtn dash-card-x" onClick={onRemove}>
              <X />
            </button>
          </Tooltip>
        )}
      </div>
      <QuotaWindows card={card} />
      {card.state === 'ready' && (
        <div className="dash-covline">
          {card.lastSuccessAt !== undefined && (
            <span>{t('usageLastSuccess', { at: stamp(card.lastSuccessAt) })}</span>
          )}
          {card.providerMeasuredAt !== undefined && (
            <span>{t('usageMeasured', { at: stamp(card.providerMeasuredAt) })}</span>
          )}
          {card.observedAt !== undefined && (
            <span>{t('usageObserved', { at: stamp(card.observedAt) })}</span>
          )}
        </div>
      )}
    </div>
  )
}

export default function UsageWidget({
  providers,
  onProviders
}: {
  providers: string[] | undefined
  onProviders: (ids: string[]) => void
}): React.JSX.Element {
  const t = useT()
  const accounts = useStore((s) => s.settings.usageAccounts ?? NO_ACCOUNTS)
  const legacy = useMemo(() => legacyAccountRecords(accounts), [accounts])
  const legacyKey = legacy.map((record) => `${record.harnessId}:${record.account.path}`).join('|')

  const [data, setData] = useState<DomainUsageSourcesResult | null>(null)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string>()
  const [authHarness, setAuthHarness] = useState<string | null>(null)

  const fetchSources = useCallback(async () => {
    const records = legacyAccountRecords(useStore.getState().settings.usageAccounts ?? [])
    return loadUsageSources({ legacySources: records.map(toLegacySource) })
  }, [])

  const apply = useCallback((result: Awaited<ReturnType<typeof fetchSources>>): void => {
    if (result.ok) {
      setData(result.value)
      setError(undefined)
      return
    }
    setError(result.error.message)
  }, [])

  useEffect(() => {
    let live = true
    void fetchSources().then((result) => {
      if (live) apply(result)
    })
    return () => {
      live = false
    }
  }, [fetchSources, apply, legacyKey])

  useEffect(() => {
    const id = setInterval(() => {
      void fetchSources().then(apply)
    }, POLL_MS)
    return () => clearInterval(id)
  }, [fetchSources, apply])

  const cards = useMemo(
    () => (data ? quotaCards(data.sources, data.quota, data.readiness.diagnostics) : []),
    [data]
  )
  const cardByKey = useMemo(() => new Map(cards.map((card) => [card.key, card])), [cards])
  const catalogKey = cards.map((card) => card.key).join('|')
  const selected = providers
    ? providers.filter((key) => cardByKey.has(key))
    : cards.map((card) => card.key)

  // Old tabs stored harness names (`provider`, `provider@accountId`). Those
  // keys never match connection keys, so such a tab opens as the full list.
  useEffect(() => {
    if (providers) return
    if (!catalogKey) return
    onProviders(catalogKey.split('|'))
  }, [providers, catalogKey, onProviders])

  const visible = selected
    .map((key) => cardByKey.get(key))
    .filter((card): card is QuotaCardView => !!card)
  // cheap grouping of the selected cards — derived on every render so it can
  // never go stale against `selected`
  const groups: { harnessId?: string; cards: QuotaCardView[] }[] = []
  for (const card of visible) {
    const group = groups.find((entry) => entry.harnessId === card.harnessId)
    if (group) group.cards.push(card)
    else groups.push({ harnessId: card.harnessId, cards: [card] })
  }

  const manifest = agentProviders()
  const addable = Array.from(
    new Set([
      ...Object.keys(manifest),
      ...cards.flatMap((card) => (card.harnessId ? [card.harnessId] : [])),
      ...legacy.map((record) => record.harnessId)
    ])
  ).sort((a, b) => agentLabel(a).localeCompare(agentLabel(b)))

  const refresh = async (): Promise<void> => {
    if (!cards.length) return
    setBusy(true)
    setNote(undefined)
    const requested = await requestCollection({ capability: 'quota', reason: 'usage-widget' })
    if (!requested.ok) setNote(t('usageCollectUnavailable', { error: requested.error.message }))
    else if (requested.value.detail) setNote(requested.value.detail)
    apply(await fetchSources())
    setBusy(false)
  }

  /** Canonical file import: the daemon registers the picked file as a read-only
   *  locator connection for the chosen offering — the card is a real connection,
   *  not a desktop-only settings record. */
  const registerImported = async (offeringId: string, path: string): Promise<void> => {
    setNote(undefined)
    const result = await importAuthFile({ offeringId, path })
    if (!result.ok) {
      setNote(result.error.message)
      return
    }
    setAuthHarness(null)
    const refreshed = await fetchSources()
    apply(refreshed)
    if (refreshed.ok) {
      const key = `connection:${result.value.connectionId}`
      if (!selected.includes(key)) onProviders([...selected, key])
    }
  }

  const signedIn = (outcome: DomainAuthOutcome): void => {
    setAuthHarness(null)
    setNote(
      outcome.account ? t('usageSignedIn', { account: outcome.account }) : t('usageSignedInPlain')
    )
    void fetchSources().then((result) => {
      apply(result)
      if (!result.ok) return
      const added = result.value.sources
        .filter((source) => !cardByKey.has(source.key))
        .map((source) => source.key)
      if (added.length) onProviders([...selected, ...added])
    })
  }

  const removeLegacy = (card: QuotaCardView): void => {
    const store = useStore.getState()
    const records = legacyAccountRecords(store.settings.usageAccounts ?? [])
    const match = records.find((record) => `legacy:${record.account.id}` === card.key)
    if (!match) return
    store.updateSettings({
      usageAccounts: (store.settings.usageAccounts ?? []).filter(
        (account) => account.id !== match.account.id
      )
    })
    if (selected.includes(card.key)) onProviders(selected.filter((key) => key !== card.key))
  }

  /** canonical removal: the daemon records the connection as removed (its
   *  bindings end, stored usage stays). The desktop never deletes a credential
   *  file for a stored connection. */
  const removeCanonical = (card: QuotaCardView): void => {
    if (!card.connectionId) return
    setError(undefined)
    void removeUsageSource(card.connectionId).then((result) => {
      if (!result.ok) {
        setNote(t('usageRemoveUnavailable', { error: result.error.message }))
        return
      }
      if (selected.includes(card.key)) onProviders(selected.filter((key) => key !== card.key))
      void fetchSources().then(apply)
    })
  }

  const reporting = visible.filter((card) => card.state === 'ready').length
  // "cannot reach the store" and "the store answered only in part" are
  // different states: the first replaces the list, the second is a footer chip.
  const storeWarning = error
    ? t('usageStoreUnavailable', { error })
    : data?.readiness.state === 'unavailable'
      ? t('usageStoreUnavailable', {
          error: data.readiness.diagnostics[0] ?? ''
        })
      : undefined
  const peak = visible.reduce(
    (max, card) =>
      card.windows.reduce(
        (inner, window) => (window.usedPct === undefined ? inner : Math.max(inner, window.usedPct)),
        max
      ),
    -1
  )
  const options = cards.map((card) => ({
    value: card.key,
    label: (
      <span className="sel-agent">
        {card.harnessId ? <AgentIcon id={card.harnessId} size={12} /> : <Link2 size={12} />}
        {harnessTitle(
          card,
          card.harnessId ? agentLabel(card.harnessId) : t('usageUnboundConnections'),
          t('usageDefault')
        )}
        {card.origin === 'legacy' && (
          <span className="cov-chip unknown">{t('usageLegacyChip')}</span>
        )}
      </span>
    )
  }))
  const summary =
    selected.length === 0 ? (
      t('usageNone')
    ) : selected.length === 1 ? (
      <span className="sel-agent">
        {visible[0]?.harnessId ? (
          <AgentIcon id={visible[0].harnessId} size={12} />
        ) : (
          <Link2 size={12} />
        )}
        {visible[0]
          ? harnessTitle(
              visible[0],
              visible[0].harnessId
                ? agentLabel(visible[0].harnessId)
                : t('usageUnboundConnections'),
              t('usageDefault')
            )
          : ''}
      </span>
    ) : (
      <span className="sel-agent">
        {visible
          .slice(0, 3)
          .map((card) =>
            card.harnessId ? (
              <AgentIcon key={card.key} id={card.harnessId} size={12} />
            ) : (
              <Link2 key={card.key} size={12} />
            )
          )}
        {t('usageSelected', { n: String(selected.length) })}
      </span>
    )

  const authPanel = (harnessId: string): React.JSX.Element => (
    <UsageAuthPanel
      harnessId={harnessId}
      offerings={data?.offerings ?? []}
      preferredOfferingIds={data?.offeringsByHarness[harnessId] ?? []}
      onSignedIn={signedIn}
      onImported={(offeringId, path) => void registerImported(offeringId, path)}
      onClose={() => setAuthHarness(null)}
    />
  )

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
          <Tooltip label={t('usageRefreshStored')}>
            <button
              className="pbtn"
              onClick={() => void refresh()}
              disabled={busy || !cards.length}
            >
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
              <button key={id} className="sel-item" onClick={() => setAuthHarness(id)}>
                <span className="sel-agent">
                  <AgentIcon id={id} size={12} />
                  {agentLabel(id)}
                </span>
              </button>
            ))}
          </Dropdown>
        </div>

        {authHarness &&
          !groups.some((group) => group.harnessId === authHarness) &&
          authPanel(authHarness)}

        {note && <div className="usage-note">{note}</div>}
        {storeWarning && <div className="usage-note err">{storeWarning}</div>}

        {!cards.length ? (
          <div className="usage-note">{data ? t('usageSourcesEmpty') : t('loading')}</div>
        ) : (
          <>
            <div className="dash-kpis">
              <div className="dash-kpi">
                <span className="dash-kpi-l">{t('agents')}</span>
                <span className="dash-kpi-v">{visible.length}</span>
              </div>
              <div className="dash-kpi">
                <span className="dash-kpi-l">{t('usageReporting')}</span>
                <span className="dash-kpi-v">
                  {reporting}/{visible.length}
                </span>
              </div>
              <div className="dash-kpi">
                <span className="dash-kpi-l">{t('usagePeak')}</span>
                <span className="dash-kpi-v">{peak < 0 ? '—' : `${Math.round(peak)}%`}</span>
              </div>
            </div>

            <div className="dash-groups">
              {groups.map((group) => (
                <section key={group.harnessId ?? 'unbound-connections'} className="dash-group">
                  <div className="dash-grp-h">
                    {group.harnessId ? (
                      <AgentIcon id={group.harnessId} size={13} />
                    ) : (
                      <Link2 size={13} />
                    )}
                    <span className="dash-grp-t">
                      {group.harnessId ? agentLabel(group.harnessId) : t('usageUnboundConnections')}
                    </span>
                    {group.harnessId && (
                      <Tooltip label={t('usageAddAccount')}>
                        <button
                          className="pbtn dash-grp-add"
                          onClick={() =>
                            setAuthHarness(
                              authHarness === group.harnessId ? null : (group.harnessId ?? null)
                            )
                          }
                        >
                          <Plus />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                  {authHarness === group.harnessId && authPanel(authHarness)}
                  <div className="dash-grid">
                    {group.cards.map((card) => (
                      <QuotaCard
                        key={card.key}
                        card={card}
                        label={harnessTitle(
                          card,
                          card.harnessId
                            ? agentLabel(card.harnessId)
                            : t('usageUnboundConnections'),
                          t('usageDefault')
                        )}
                        {...(card.origin === 'legacy'
                          ? { onRemove: () => removeLegacy(card) }
                          : card.connectionId
                            ? { onRemove: () => removeCanonical(card) }
                            : {})}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>

            <div className="dash-fresh">
              <span>{t('usageStoredAt', { at: stamp(data?.freshness.asOf) })}</span>
              {data?.freshness.pending && (
                <span className="cov-chip warn">{t('usagePending')}</span>
              )}
              {data?.readiness.state === 'partial' && (
                <span className="cov-chip unknown">{t('usagePartial')}</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function harnessTitle(card: QuotaCardView, agentName: string, fallback: string): string {
  agentName = card.serviceLabel ?? agentName
  const account = card.accountLabel ?? card.identityClaims[0]?.value
  return account
    ? `${agentName} · ${account}`
    : card.origin === 'legacy'
      ? `${agentName} · ${fallback}`
      : agentName
}
