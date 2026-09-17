import { useEffect, useState } from 'react'
import { Minus, PictureInPicture2, SquareArrowOutUpRight } from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'
import { fmtAge, fmtElapsed, paneTitle } from '../utils'
import { useAgentGroups, type AgentGroup, type AgentRow } from '../agentGroups'
import AgentIcon from './AgentIcon'
import Tooltip from './Tooltip'

/* Per-pane agent session list — the tab status lights made legible. Shared
   by the sidebar's bottom section and the 'agents' widget block. The scope
   toggle narrows the list to this workspace or widens it to every
   workspace (group headers then carry the workspace name). Rows show a
   live elapsed timer while the session is working and the age of its last
   finished turn after. Clicking a row jumps to the pane+tab — activating
   its workspace first when the row lives elsewhere; detached panes focus
   their own window; minimized ones restore via focusPane. */

export default function AgentsPanel({ wsId }: { wsId: string }): React.JSX.Element {
  const groups = useAgentGroups(wsId)
  const scope = useStore((s) => s.agentsScope)
  const setAgentsScope = useStore((s) => s.setAgentsScope)
  const language = useStore((s) => s.settings.language)
  const t = useT()

  // ticking clock for the row timers — 1s while a session is working
  // (seconds tick visibly), 30s otherwise so '… ago' labels stay fresh
  const hasWorking = groups.some((g) => g.rows.some((r) => r.status === 'working'))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!groups.length) return
    const id = setInterval(() => setNow(Date.now()), hasWorking ? 1000 : 30000)
    return () => clearInterval(id)
  }, [groups.length, hasWorking])

  const jump = (g: AgentGroup, row: AgentRow): void => {
    const st = useStore.getState()
    const pane = g.pane
    if (pane.detached) {
      window.ade.win.focusDetached(g.ws.id, pane.id)
      return
    }
    if (g.ws.id !== st.activeWorkspaceId) st.activateWorkspace(g.ws.id)
    st.focusPane(pane.id, g.ws.id) // restores a minimized pane too
    if (pane.activeTabId !== row.tab.id) {
      st.updatePane(pane.id, { activeTabId: row.tab.id }, g.ws.id)
    }
  }

  const rowTime = (r: AgentRow): string | undefined => {
    if (r.status === 'working' && r.tab.workingSince) {
      return fmtElapsed(now - r.tab.workingSince)
    }
    if (r.tab.turnEndedAt) return t('ago', { t: fmtAge(now - r.tab.turnEndedAt) })
    return undefined
  }

  return (
    <div className="ag-wrap">
      <div className="ag-scope">
        <button className={scope === 'ws' ? 'on' : ''} onClick={() => setAgentsScope('ws')}>
          {t('agentsWs')}
        </button>
        <button className={scope === 'all' ? 'on' : ''} onClick={() => setAgentsScope('all')}>
          {t('agentsAll')}
        </button>
      </div>
      {groups.length ? (
        <div className="ag-list">
          {groups.map((g) => (
            <div key={g.pane.id} className="ag-group">
              <div className="ag-pane">
                <span className="ag-pane-name">
                  {scope === 'all'
                    ? `${g.ws.name} · ${paneTitle(g.pane, language)}`
                    : paneTitle(g.pane, language)}
                </span>
                {!!g.pane.minimized && (
                  <Tooltip label={t('minimizePane')}>
                    <Minus className="ag-flag" />
                  </Tooltip>
                )}
                {!!g.pane.floating && (
                  <Tooltip label={t('floatPane')}>
                    <PictureInPicture2 className="ag-flag" />
                  </Tooltip>
                )}
                {!!g.pane.detached && (
                  <Tooltip label={t('focusDetached')}>
                    <SquareArrowOutUpRight className="ag-flag" />
                  </Tooltip>
                )}
              </div>
              {g.rows.map((r) => {
                const time = rowTime(r)
                return (
                  <button
                    key={r.tab.id}
                    className="ag-row"
                    onClick={() => jump(g, r)}
                    title={r.sub ? `${r.label} — ${r.sub}` : r.label}
                  >
                    <AgentIcon id={r.tab.agent ?? ''} size={13} />
                    <span className="ag-text">
                      <span className="ag-name">{r.label}</span>
                      {r.sub && <span className="ag-sub">{r.sub}</span>}
                    </span>
                    {time && <span className="ag-time">{time}</span>}
                    {r.status && <span className={`ctab-st ${r.status}`} />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      ) : (
        <div className="ag-empty">{t('noAgents')}</div>
      )}
    </div>
  )
}
