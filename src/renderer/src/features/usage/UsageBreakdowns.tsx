// Provider / offering / model / verified-pool breakdowns over the stored
// aggregate rows.
//
// Every number comes from the published summary rows the widget already
// fetched — this panel performs no read of its own. Each axis family selects
// its EXACT rollup shape (see './rollup'): a provider total never includes a
// connection row and a requested-model total never mixes in served-model
// rows, so nothing on screen is double-counted. Groups the store could not
// attribute stay visible as their own 'unattributed'/'not reported' rows —
// unknown is a group, never a 0.

import { useT } from '../../i18n'
import { agentLabel } from '../../agents'
import { fmtTok } from '../../utils'
import AgentIcon from '../../components/AgentIcon'
import type { UsageSummary } from '../../../../../packages/mahas-contracts/src/index.ts'
import {
  displayTotal,
  globalSummary,
  modelBreakdown,
  offeringTotals,
  poolShares,
  providerTotals,
  type GroupedTotalsView,
  type ModelTotalsView,
  type PoolShareView
} from './rollup'
import { usageLabel, usageNumber } from './view-model'

export interface UsageBreakdownsProps {
  /** all-time rows from the published generation (a partial page still shows:
   *  every group is computed from exactly the rows given) */
  summaries: readonly UsageSummary[]
  /** the page these rows came from is not exhausted: the group LIST may be
   *  incomplete (a whole axis value can sit beyond the page), so the pool
   *  remainder is withheld and each axis is marked partial */
  partial?: boolean
  /** catalog display names resolved by the daemon; raw ids show when absent */
  labels?: {
    providers?: Record<string, string>
    offerings?: Record<string, string>
  }
}

function AxisRows<Row extends GroupedTotalsView>({
  rows,
  labelOf,
  grand
}: {
  rows: readonly Row[]
  labelOf: (row: Row) => React.ReactNode
  grand: number
}): React.JSX.Element {
  const ordered = [...rows].sort(
    (a, b) => usageNumber(displayTotal(b.totals)) - usageNumber(displayTotal(a.totals))
  )
  return (
    <>
      {ordered.map((row, index) => {
        const total = displayTotal(row.totals)
        const share = total !== null && grand > 0 ? (total / grand) * 100 : null
        const lower = row.unknownComponents.length > 0 || row.partialComponents.length > 0
        return (
          <div className="dash-axis-row" key={row.id ?? index}>
            <span className="dash-axis-l">{labelOf(row)}</span>
            <span className="dash-axis-bar">
              <span
                className="dash-axis-fill"
                style={{ width: share === null ? '0%' : `${Math.min(100, share)}%` }}
              />
            </span>
            <span className="dash-axis-v">
              {lower ? <em className="cov-unknown">≥</em> : null}
              {usageLabel(total)}
              {share !== null && <em className="dash-axis-p">{Math.round(share)}%</em>}
            </span>
          </div>
        )
      })}
    </>
  )
}

function PoolCard({ view, grand }: { view: PoolShareView; grand: number }): React.JSX.Element {
  const t = useT()
  const share = view.denominator !== null && grand > 0 ? (view.denominator / grand) * 100 : null
  return (
    <div className="dash-card dash-pool">
      <div className="dash-card-h">
        <span className="dash-card-n">{view.pool.providerPoolKey}</span>
        <span className="dash-card-s">{view.pool.scope}</span>
        {view.denominatorCoverage !== 'complete' && (
          <span className="cov-chip warn">{t('tokensPartial')}</span>
        )}
        {view.pending && <span className="cov-chip warn">{t('usagePending')}</span>}
      </div>
      <div className="dash-axis-row">
        <span className="dash-axis-l">{t('tokensPoolTotal')}</span>
        <span className="dash-axis-bar">
          <span
            className="dash-axis-fill"
            style={{ width: share === null ? '0%' : `${Math.min(100, share)}%` }}
          />
        </span>
        <span className="dash-axis-v">{usageLabel(view.denominator)}</span>
      </div>
      {view.shares.map((entry) => (
        <div className="dash-axis-row" key={entry.harnessId}>
          <span className="dash-axis-l">
            <AgentIcon id={entry.harnessId} size={12} /> {agentLabel(entry.harnessId)}
          </span>
          <span className="dash-axis-bar">
            <span
              className="dash-axis-fill"
              style={{
                width: entry.share === null ? '0%' : `${Math.min(100, entry.share * 100)}%`
              }}
            />
          </span>
          <span className="dash-axis-v">
            {usageLabel(entry.numerator)}
            {entry.share !== null && (
              <em className="dash-axis-p">{Math.round(entry.share * 100)}%</em>
            )}
          </span>
        </div>
      ))}
      {!view.shares.length && <div className="usage-note">{t('tokensPoolNoShares')}</div>}
    </div>
  )
}

export default function UsageBreakdowns({
  summaries,
  partial = false,
  labels
}: UsageBreakdownsProps): React.JSX.Element | null {
  const t = useT()
  const global = globalSummary(summaries)
  const grand = usageNumber(global ? displayTotal(global.totals) : null)
  const providers = providerTotals(summaries)
  const offerings = offeringTotals(summaries)
  const models = modelBreakdown(summaries)
  const pools = poolShares(summaries)
  const hasAxes =
    providers.length > 0 ||
    offerings.length > 0 ||
    models.requested.length > 0 ||
    models.served.length > 0
  if (!hasAxes && pools.length === 0) return null

  const unattributed = t('tokensUnattributedGroup')
  const providerLabel = (id: string | null): string =>
    id === null ? unattributed : (labels?.providers?.[id] ?? id)
  const offeringLabel = (id: string | null): string =>
    id === null ? unattributed : (labels?.offerings?.[id] ?? id)
  // native identity is (namespace, nativeName): the namespace rides along as a
  // muted suffix so two native names that collide on text stay distinct
  const modelLabel = (row: ModelTotalsView): React.ReactNode =>
    row.ref ? (
      <>
        {row.ref.nativeName}{' '}
        <em className="dash-axis-ns" title={row.ref.namespace}>
          {row.ref.namespace}
        </em>
      </>
    ) : (
      t('tokensNoModel')
    )

  // usage observed outside every verified pool: the global total minus the
  // pool denominators — a remainder, never a share. Withheld on a partial
  // page: pools beyond the fetched rows would inflate it.
  const poolTotal = pools.reduce(
    (sum, view) => (view.denominator === null ? Number.NaN : sum + view.denominator),
    0
  )
  const outside =
    partial || Number.isNaN(poolTotal) || !global || displayTotal(global.totals) === null
      ? null
      : Math.max(0, (displayTotal(global.totals) ?? 0) - poolTotal)

  const axisTitle = (key: Parameters<typeof t>[0]): React.ReactNode => (
    <div className="dash-axis-t">
      {t(key)}
      {partial && <span className="cov-chip warn">{t('tokensPartial')}</span>}
    </div>
  )

  return (
    <>
      {hasAxes && (
        <>
          <div className="dash-sec">{t('tokensBreakdown')}</div>
          <div className="dash-axes">
            {providers.length > 0 && (
              <div className="dash-axis">
                {axisTitle('tokensProviders')}
                <AxisRows rows={providers} labelOf={(row) => providerLabel(row.id)} grand={grand} />
              </div>
            )}
            {offerings.length > 0 && (
              <div className="dash-axis">
                {axisTitle('tokensOfferings')}
                <AxisRows rows={offerings} labelOf={(row) => offeringLabel(row.id)} grand={grand} />
              </div>
            )}
            {models.requested.length > 0 && (
              <div className="dash-axis">
                {axisTitle('tokensModelsRequested')}
                <AxisRows rows={models.requested} labelOf={modelLabel} grand={grand} />
              </div>
            )}
            {models.served.length > 0 && (
              <div className="dash-axis">
                {axisTitle('tokensModelsServed')}
                <AxisRows rows={models.served} labelOf={modelLabel} grand={grand} />
              </div>
            )}
          </div>
        </>
      )}
      {pools.length > 0 && (
        <>
          <div className="dash-sec">{t('tokensPools')}</div>
          <div className="dash-grid">
            {pools.map((view) => (
              <PoolCard
                key={JSON.stringify([view.pool.scope, view.pool.providerPoolKey])}
                view={view}
                grand={grand}
              />
            ))}
          </div>
          {outside !== null && (
            <div className="dash-covline dash-pool-out">
              <span>{t('tokensPoolOutside', { n: fmtTok(outside) })}</span>
            </div>
          )}
        </>
      )}
    </>
  )
}
