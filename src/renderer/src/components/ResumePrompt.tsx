import { useState, useSyncExternalStore } from 'react'
import { History, X } from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'
import { agentLabel } from '../agents'
import { shortPath } from '../utils'
import {
  candidateName,
  resumeCandidates,
  resumeWorkspaceSessions,
  subscribeResume,
  resumeSnapshotVersion
} from '../resume'
import AgentIcon from './AgentIcon'
import Tooltip from './Tooltip'

// Post-restart "복구하시겠습니까?" — when the active workspace still holds
// sessions that were live at last shutdown, offer to reopen them in one
// click. Each workspace asks at most once per run: dismiss or resume closes
// it for good (records dropped on resume re-register via their own hooks, so
// a declined set is simply offered again on the next launch).
export default function ResumePrompt(): React.JSX.Element | null {
  const activeId = useStore((s) => s.activeWorkspaceId)
  useSyncExternalStore(subscribeResume, resumeSnapshotVersion)
  useStore((s) => s.resumeSessions) // re-render when records land or drop
  const workspaces = useStore((s) => s.workspaces)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const t = useT()

  const cands =
    activeId && !closed.has(activeId) ? resumeCandidates(useStore.getState(), activeId) : []
  if (!activeId || !cands.length) return null
  const ws = workspaces.find((w) => w.id === activeId)

  const close = (): void => setClosed((s) => new Set(s).add(activeId))
  const resume = (): void => {
    resumeWorkspaceSessions(activeId)
    close()
  }

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="resume-title">
            <History size={14} />
            {t('resumeTitle')}
          </span>
          <Tooltip label={t('close')}>
            <button className="pbtn" onClick={close}>
              <X size={14} />
            </button>
          </Tooltip>
        </div>
        <div className="modal-body">
          <div className="resume-hint">
            {t('resumeHint', { name: ws?.name ?? '', n: String(cands.length) })}
          </div>
          <div className="resume-list">
            {cands.map((c) => (
              <div className="resume-row" key={c.rec.sessionId}>
                <AgentIcon id={c.rec.provider} size={18} />
                <div className="resume-info">
                  <div className="resume-name">
                    {agentLabel(c.rec.provider)} — {candidateName(c.rec, c.tab)}
                  </div>
                  <div className="resume-sub">
                    {c.rec.cwd ? shortPath(c.rec.cwd) + ' · ' : ''}
                    {c.cmd}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="resume-actions">
            <button className="sbtn" onClick={close}>
              {t('resumeLater')}
            </button>
            <button className="sbtn accent" onClick={resume}>
              {t('resumeAll', { n: String(cands.length) })}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
