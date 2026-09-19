// Stored sessions with their stored usage, live state, and parent/child shape.
//
// The rows come from the daemon (session rows + ledger entries), so a session
// that ran weeks ago still lists after its transcript is gone. Row building is
// `joinSessions` — a stored row merges with a live registry entry only on
// exact harness+native identity backed by positive stored/namespace evidence,
// and a session the store has not collected yet stands alone as a live-only
// row — never as a zero-token session.
//
// `onOpen` receives the LIVE REGISTRY key (the native session id
// `agentSessions` is keyed by), not the canonical session id — the consumer's
// lookup is into that same registry.

import { useMemo } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { agentLabel } from '../../agents'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import { shortPath } from '../../utils'
import AgentIcon from '../../components/AgentIcon'
import type { AgentSessionInfo } from '../../types'
import type { SessionUsageRowView } from '../usage/view-model'
import { displayTotal, usageLabel, usageNumber } from '../usage/view-model'
import type { ResumeSupport, StoredSessionRow } from './domain'
import type { SessionDetailView, SessionRowView } from './view-model'
import { joinSessions } from './view-model'
import { MixBar } from '../usage/MixBar'

export interface SessionsPanelProps {
  stored: StoredSessionRow[]
  usage: SessionUsageRowView[]
  live: Record<string, AgentSessionInfo>
  /** called with the live registry key of the session to jump to */
  onOpen: (sessionId: string) => void
  /** resume support keyed by canonical id — superseded by `details` */
  support?: Record<string, ResumeSupport>
  /** bounded canonical details (`loadSessionDetails`), keyed by canonical id */
  details?: Record<string, SessionDetailView>
  /** the list read paged — more stored rows exist beyond this page */
  truncated?: boolean
}

export default function SessionsPanel({
  stored,
  usage,
  live,
  onOpen,
  support,
  details,
  truncated
}: SessionsPanelProps): React.JSX.Element {
  const t = useT()
  const workspaces = useStore((s) => s.workspaces)
  const rows = useMemo(
    () => joinSessions({ stored, usage, live, workspaces, ...(details ? { details } : {}) }),
    [stored, usage, live, workspaces, details]
  )

  const max = Math.max(
    1,
    ...rows.flatMap((row) =>
      [row, ...row.children].map((entry) =>
        entry.usage ? usageNumber(displayTotal(entry.usage.totals)) : 0
      )
    )
  )

  if (!rows.length)
    return (
      <div className="dash-table">
        <div className="usage-note">{t('tokensNone')}</div>
        {truncated && <div className="usage-note">{t('sessionsMore')}</div>}
      </div>
    )

  const renderRow = (row: SessionRowView, child: boolean): React.JSX.Element => {
    const total = row.usage ? displayTotal(row.usage.totals) : null
    const jumpable = !!row.liveTarget
    const resume = row.resumeSupport ?? (row.sessionId ? support?.[row.sessionId] : undefined)
    return (
      <button
        key={row.key}
        className={child ? 'dash-sess child' : 'dash-sess'}
        onClick={() => row.liveNativeId && jumpable && onOpen(row.liveNativeId)}
        disabled={!jumpable}
      >
        <AgentIcon id={row.harnessId} size={14} />
        <span className="dash-sess-t">
          <span className="dash-sess-n">
            {child && <span className="dash-sess-sub">↳ </span>}
            {row.title}
            {row.liveTarget && <span className="cov-chip live">{t('sessionsLive')}</span>}
            {row.orphanChild && (
              <span className="cov-chip" title={row.parentSessionId}>
                {t('sessionsChild')}
              </span>
            )}
            {row.childCount > 0 && (
              <span className="cov-chip">
                {t('sessionsChildren', { n: String(row.childCount) })}
              </span>
            )}
            {row.stored && !row.usage && (
              <span className="cov-chip unknown">{t('sessionsNoUsage')}</span>
            )}
            {row.usage?.attribution === 'unknown' && (
              <span className="cov-chip unknown">{t('sessionsNoAttribution')}</span>
            )}
          </span>
          <span className="dash-sess-c">
            {row.cwd ? shortPath(row.cwd) : agentLabel(row.harnessId)}
            {row.stored && (
              <>
                {' · '}
                {t('sessionsSeen', {
                  at: new Date(row.stored.lastObservedAt).toLocaleDateString()
                })}
              </>
            )}
            {resume && <> · {resumeLabel(t, resume)}</>}
          </span>
        </span>
        <span className="dash-sess-bar">
          {row.usage && total !== null ? (
            <>
              <span className="dash-sess-track">
                <span
                  className="dash-sess-fill"
                  style={{ width: `${(usageNumber(total) / max) * 100}%` }}
                >
                  <MixBar values={row.usage.totals} height={6} />
                </span>
              </span>
              <span className="dash-sess-v">
                {row.usage.unknownComponents.length || row.usage.partialComponents.length ? (
                  <em className="cov-unknown" title={t('tokensLowerBound')}>
                    ≥
                  </em>
                ) : null}
                {usageLabel(total)}
              </span>
            </>
          ) : (
            <span className="dash-sess-miss">{t('tokensUnknown')}</span>
          )}
          {jumpable && <ArrowUpRight className="dash-sess-go" />}
        </span>
      </button>
    )
  }

  return (
    <div className="dash-table">
      {rows.map((row) => (
        <div key={row.key} className="dash-sess-group">
          {renderRow(row, false)}
          {row.children.length > 0 && (
            <div className="dash-sess-kids">{row.children.map((kid) => renderRow(kid, true))}</div>
          )}
        </div>
      ))}
      {truncated && <div className="usage-note">{t('sessionsMore')}</div>}
    </div>
  )
}

function resumeLabel(
  t: (
    key: 'sessionsResumeSupported' | 'sessionsResumeUnsupported' | 'sessionsResumeUnknown'
  ) => string,
  support: ResumeSupport
): string {
  if (support === 'supported') return t('sessionsResumeSupported')
  if (support === 'unsupported') return t('sessionsResumeUnsupported')
  return t('sessionsResumeUnknown')
}
