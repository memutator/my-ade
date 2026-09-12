import { Code2, Globe, ListTodo, TerminalSquare, X } from 'lucide-react'
import type { PaneState, PaneType } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import Tooltip from './Tooltip'
import AgentIcon from './AgentIcon'
import { shortPath } from '../utils'

const ICONS: Record<PaneType, typeof TerminalSquare> = {
  terminal: TerminalSquare,
  browser: Globe,
  editor: Code2,
  todo: ListTodo
}

// What the chip shows: terminals get the active tab's live `shell · cwd` like
// the pane titlebar, browser/editor chips show the active tab when there is
// one.
function chipTitle(p: PaneState): string {
  if (p.type === 'terminal') {
    const tab = p.tabs.find((t) => t.id === p.activeTabId) ?? p.tabs[0]
    if (tab?.cwd) return `${tab.shell ?? 'sh'} · ${shortPath(tab.cwd)}`
  }
  if (p.type === 'browser' || p.type === 'editor') {
    const tab = p.tabs.find((t) => t.id === p.activeTabId)
    if (tab && 'title' in tab && tab.title) return tab.title
    if (tab && 'name' in tab && tab.name) return tab.name
  }
  return p.title
}

// terminal status reads the active tab (pty state lives per-tab):
// running agent → provider icon; exited shell → status dot
function termStatus(p: PaneState): { agent?: string; exited?: boolean } {
  if (p.type !== 'terminal') return {}
  const tab = p.tabs.find((t) => t.id === p.activeTabId) ?? p.tabs[0]
  return { agent: tab?.agent ?? undefined, exited: tab?.exited }
}

// Minimized-pane chips in the title bar (right side), scoped to the active
// workspace. The panes themselves stay mounted (hidden) in the layout —
// clicking a chip just clears the flag; the × actually closes the pane (kills
// the pty etc.).
export default function PaneDock(): React.JSX.Element | null {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId))
  const restorePane = useStore((s) => s.restorePane)
  const closePane = useStore((s) => s.closePane)
  const t = useT()

  const minimized = Object.values(ws?.panes ?? {}).filter((p) => p.minimized)
  if (!ws || minimized.length === 0) return null

  return (
    <div className="pane-dock">
      {minimized.map((p) => {
        const Icon = ICONS[p.type]
        const status = termStatus(p)
        return (
          <Tooltip key={p.id} label={t('restorePane')}>
            <div className="dock-chip" onClick={() => restorePane(p.id, ws.id)}>
              <Icon />
              {status.agent ? (
                <AgentIcon id={status.agent} size={10} />
              ) : (
                status.exited && <span className="dock-dot exited" />
              )}
              <span className="dock-chip-title">{chipTitle(p)}</span>
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
