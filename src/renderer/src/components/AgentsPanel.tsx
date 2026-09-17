import { Minus, PictureInPicture2, SquareArrowOutUpRight } from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'
import { paneTitle } from '../utils'
import { useAgentGroups, type AgentGroup, type AgentRow } from '../agentGroups'
import AgentIcon from './AgentIcon'
import Tooltip from './Tooltip'

/* Per-pane agent session list — the tab status lights made legible at the
   workspace level. Shared by the sidebar's bottom section and the 'agents'
   widget block. Clicking a row jumps to the pane+tab (detached panes focus
   their own window; minimized ones restore via focusPane). */

export default function AgentsPanel({ wsId }: { wsId: string }): React.JSX.Element {
  const groups = useAgentGroups(wsId)
  const language = useStore((s) => s.settings.language)
  const t = useT()

  const jump = (g: AgentGroup, row: AgentRow): void => {
    const st = useStore.getState()
    const pane = g.pane
    if (pane.detached) {
      window.ade.win.focusDetached(wsId, pane.id)
      return
    }
    st.focusPane(pane.id, wsId) // restores a minimized pane too
    if (pane.activeTabId !== row.tab.id) {
      st.updatePane(pane.id, { activeTabId: row.tab.id }, wsId)
    }
  }

  if (!groups.length) return <div className="ag-empty">{t('noAgents')}</div>
  return (
    <div className="ag-list">
      {groups.map((g) => (
        <div key={g.pane.id} className="ag-group">
          <div className="ag-pane">
            <span className="ag-pane-name">{paneTitle(g.pane, language)}</span>
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
          {g.rows.map((r) => (
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
              {r.status && <span className={`ctab-st ${r.status}`} />}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
