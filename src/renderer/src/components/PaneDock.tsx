import { Code2, Globe, ListTodo, TerminalSquare, X } from 'lucide-react'
import type { PaneState, PaneType } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import Tooltip from './Tooltip'

const ICONS: Record<PaneType, typeof TerminalSquare> = {
  terminal: TerminalSquare,
  browser: Globe,
  editor: Code2,
  todo: ListTodo
}

// same compaction TerminalPane's titlebar uses
function shortPath(p: string): string {
  const home = '/home/'
  if (p.startsWith(home)) return '~/' + p.slice(home.length).split('/').slice(1).join('/')
  return p
}

// What the chip shows: terminals get their live `shell · cwd` title like the
// pane titlebar, browser/editor chips show the active tab when there is one.
function chipTitle(p: PaneState): string {
  if (p.type === 'terminal' && p.cwd) return `${p.shell ?? 'sh'} · ${shortPath(p.cwd)}`
  if (p.type === 'browser' || p.type === 'editor') {
    const tab = p.tabs.find((t) => t.id === p.activeTabId)
    if (tab && 'title' in tab && tab.title) return tab.title
    if (tab && 'name' in tab && tab.name) return tab.name
  }
  return p.title
}

// Slim strip at the bottom of a workspace listing its minimized panes. The
// panes themselves stay mounted (hidden) in the layout — clicking a chip just
// clears the flag; the × actually closes the pane (kills the pty etc.).
export default function PaneDock({ wsId }: { wsId: string }): React.JSX.Element | null {
  const panes = useStore((s) => s.workspaces.find((w) => w.id === wsId)?.panes)
  const restorePane = useStore((s) => s.restorePane)
  const closePane = useStore((s) => s.closePane)
  const t = useT()

  const minimized = Object.values(panes ?? {}).filter((p) => p.minimized)
  if (minimized.length === 0) return null

  return (
    <div className="pane-dock">
      {minimized.map((p) => {
        const Icon = ICONS[p.type]
        return (
          <Tooltip key={p.id} label={t('restorePane')}>
            <div className="dock-chip" onClick={() => restorePane(p.id, wsId)}>
              <Icon />
              {p.type === 'terminal' &&
                (p.agent ? (
                  <span className="dock-dot agent" />
                ) : p.exited ? (
                  <span className="dock-dot exited" />
                ) : null)}
              <span className="dock-chip-title">{chipTitle(p)}</span>
              <button
                className="dock-chip-close"
                onClick={(e) => {
                  e.stopPropagation()
                  closePane(p.id, wsId)
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
