// Stored usage statistics: weekly averages and hourly distributions.
//
// These numbers are computed by the daemon from the persisted ledger and stored
// with their own coverage, denominator and asOf stamp — the UI only displays
// them, and always shows the three facts a reader needs to judge them:
//
//   · the DENOMINATOR (how many completed weeks/buckets the value is over) and
//     how many of the expected periods the store could actually cover;
//   · COVERAGE completeness plus the tokens/time the statistic could not place
//     (`unknownTokens`, `unallocatedTimeTokens`) — an interval that crosses a
//     bucket boundary is reported as unallocated, never smeared across hours;
//   · the WATERMARK/asOf time, so a stale result reads as stale.

import { useT } from '../../i18n'
import { fmtTok } from '../../utils'
import {
  coverageLabelKey,
  displayTotal,
  usageLabel,
  usageNumber,
  type StatisticCardView
} from './view-model'

function fmtBucketLabel(
  card: StatisticCardView,
  bucket: { startUtc?: number; endUtc?: number; key: string }
): string {
  const at = bucket.startUtc ?? bucket.endUtc
  if (!at) return bucket.key
  const formatter = new Intl.DateTimeFormat(undefined, {
    timeZone: card.timeZone,
    ...(card.metric === 'hourly-by-date' || card.metric === 'hour-of-day-distribution'
      ? { hour: '2-digit' }
      : { month: 'short', day: 'numeric' })
  })
  return formatter.format(new Date(at))
}

function CoverageChip({ completeness }: { completeness: string }): React.JSX.Element {
  const t = useT()
  const label = t(coverageLabelKey(completeness as 'complete' | 'partial' | 'unknown'))
  const cls = completeness === 'complete' ? 'ok' : completeness === 'partial' ? 'warn' : 'unknown'
  return <span className={`cov-chip ${cls}`}>{label}</span>
}

function StatisticCard({ card }: { card: StatisticCardView }): React.JSX.Element {
  const t = useT()
  const value = displayTotal(card.value ?? card.numerator)
  const denominator = card.denominator
  const isAverage = card.metric === 'weekly-average' || card.metric === 'daily-average-within-week'
  const periodLabel =
    card.metric === 'weekly-average'
      ? t('statsPerWeek')
      : card.metric === 'daily-average-within-week'
        ? t('statsPerDay')
        : card.metric === 'hour-of-day-average'
          ? t('statsPerHour')
          : t('statsTotal')
  const maxBucket = card.buckets.reduce(
    (max, bucket) => Math.max(max, usageNumber(displayTotal(bucket.value))),
    1
  )
  return (
    <div className="dash-card stats-card">
      <div className="dash-card-h">
        <span className="dash-card-n">
          {card.metric === 'weekly-average'
            ? t('statsWeekly')
            : card.metric === 'hourly-by-date'
              ? t('statsHourly')
              : card.metric === 'hour-of-day-distribution'
                ? t('statsHourOfDay')
                : card.metric}
        </span>
        <CoverageChip completeness={card.completeness} />
      </div>
      <div className="dash-card-v">
        {usageLabel(value)}
        <em className="stats-per">{periodLabel}</em>
      </div>
      <div className="dash-covline">
        {isAverage && denominator !== null && (
          <span>{t('statsDenominator', { n: String(denominator) })}</span>
        )}
        {isAverage && card.expectedPeriods !== null && card.validPeriods !== null && (
          <span>
            {t('statsPeriods', {
              valid: String(card.validPeriods),
              expected: String(card.expectedPeriods)
            })}
          </span>
        )}
        {card.unknownTokens !== null && card.unknownTokens > 0 && (
          <span className="cov-unknown">
            {t('statsUnknownTokens', { n: fmtTok(card.unknownTokens) })}
          </span>
        )}
        {card.unallocatedTimeTokens > 0 && (
          <span className="cov-unknown">
            {t('statsUnallocated', { n: fmtTok(card.unallocatedTimeTokens) })}
          </span>
        )}
        {card.exclusions.length > 0 && (
          <span>{t('statsExcluded', { n: String(card.exclusions.length) })}</span>
        )}
        <span>{t('statsAsOf', { at: new Date(card.asOf).toLocaleString() })}</span>
      </div>
      {card.buckets.length > 0 && (
        <div className="stats-buckets">
          {card.buckets.map((bucket) => {
            const bucketTotal = displayTotal(bucket.value)
            return (
              <div key={bucket.key} className="stats-bucket">
                <span className="stats-bucket-l">{fmtBucketLabel(card, bucket)}</span>
                <span className="stats-bucket-track">
                  <span
                    className="stats-bucket-fill"
                    style={{
                      width: `${Math.min(100, (usageNumber(bucketTotal) / maxBucket) * 100)}%`
                    }}
                  />
                </span>
                <span className="stats-bucket-v">{usageLabel(bucketTotal)}</span>
                {bucket.unknownTokens !== null && bucket.unknownTokens > 0 && (
                  <em
                    className="cov-unknown"
                    title={t('statsUnknownTokens', { n: fmtTok(bucket.unknownTokens) })}
                  >
                    ≈
                  </em>
                )}
                {bucket.unallocatedTimeTokens > 0 && (
                  <em
                    className="cov-unknown"
                    title={t('statsUnallocated', { n: fmtTok(bucket.unallocatedTimeTokens) })}
                  >
                    ⧖
                  </em>
                )}
              </div>
            )
          })}
        </div>
      )}
      {card.value === null && !card.buckets.length && (
        <div className="usage-note">{t('statsNoResult')}</div>
      )}
    </div>
  )
}

export default function StatisticsPanel({
  cards
}: {
  cards: StatisticCardView[]
}): React.JSX.Element {
  const t = useT()
  if (!cards.length) {
    return <div className="usage-note">{t('statsNone')}</div>
  }
  return (
    <div className="dash-grid stats-grid">
      {cards.map((card) => (
        <StatisticCard key={card.id} card={card} />
      ))}
    </div>
  )
}
