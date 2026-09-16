import { Code2, Globe, TerminalSquare, X } from 'lucide-react'
import type { PaneState, PaneTab } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import { blockLabel, shortPath } from '../utils'
import Tooltip from './Tooltip'
import AgentIcon from './AgentIcon'

// a chip reads the leaf's ACTIVE block — the leaf has no type of its own
function activeTab(p: PaneState): PaneTab | undefined {
  return p.tabs.find((t) => t.id === p.activeTabId) ?? p.tabs[0]
}

const KIND_ICONS = { term: TerminalSquare, web: Globe, file: Code2 } as const

// Minimized/detached pane chips in the title bar (right side), scoped to the
// active workspace. Minimized panes stay mounted (hidden) — clicking a chip
// clears the flag; detached panes live in their own OS window — clicking
// brings that window forward. The × actually closes the pane (kills the pty
// etc.).
export default function PaneDock(): React.JSX.Element | null {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId))
  const restorePane = useStore((s) => s.restorePane)
  const closePane = useStore((s) => s.closePane)
  const language = useStore((s) => s.settings.language)
  const t = useT()

  const chips = Object.values(ws?.panes ?? {}).filter((p) => p.minimized || p.detached)
  if (!ws || chips.length === 0) return null

  return (
    <div className="pane-dock">
      {chips.map((p) => {
        const tab = activeTab(p)
        const Icon = KIND_ICONS[tab?.kind ?? 'term']
        // term status reads the active block (pty state lives per-tab):
        // running agent → provider icon; exited shell → status dot
        const agent = tab?.kind === 'term' ? (tab.agent ?? undefined) : undefined
        const exited = tab?.kind === 'term' ? tab.exited : undefined
        // a term block shows its live `shell · cwd`; others the block label
        const title =
          tab?.kind === 'term' && tab.cwd
            ? `${tab.shell ?? 'sh'} · ${shortPath(tab.cwd)}`
            : tab
              ? blockLabel(tab, language)
              : ''
        return (
          <Tooltip key={p.id} label={t(p.detached ? 'focusDetached' : 'restorePane')}>
            <div
              className={`dock-chip${p.detached ? ' detached' : ''}`}
              onClick={() =>
                p.detached ? window.ade.win.focusDetached(ws.id, p.id) : restorePane(p.id, ws.id)
              }
            >
              <Icon />
              {agent ? (
                <AgentIcon id={agent} size={10} />
              ) : (
                exited && <span className="dock-dot exited" />
              )}
              <span className="dock-chip-title">{title}</span>
              <button
                className="dock-chip-close"
                onClick={(e) => {
                  e.stopPropagation()
                  closePane(p.id, ws.id)
                }}
              >
                <X />
              </button>
            </div>
          </Tooltip>
        )
      })}
    </div>
  )
}
