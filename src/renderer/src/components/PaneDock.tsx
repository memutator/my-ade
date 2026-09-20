import { Code2, Globe, Puzzle, TerminalSquare, X } from 'lucide-react'
import type { PaneState, PaneTab } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import { blockLabel, shortPath, statusForTab } from '../utils'
import Tooltip from './Tooltip'
import AgentIcon from './AgentIcon'

// a chip reads the leaf's ACTIVE block — the leaf has no type of its own
function activeTab(p: PaneState): PaneTab | undefined {
  return p.tabs.find((t) => t.id === p.activeTabId) ?? p.tabs[0]
}

const KIND_ICONS = { term: TerminalSquare, web: Globe, file: Code2, widget: Puzzle } as const

// Minimized/detached pane chips + minimized tab chips in the title bar (right
// side), scoped to the active workspace. Minimized panes stay mounted (hidden)
// — clicking a chip clears the flag; detached panes live in their own OS
// window — clicking brings that window forward. Minimized TABS leave their
// leaf's strip for this dock (the block keeps running) — clicking un-tucks
// and activates them, raising their pane when it isn't on screen. The ×
// closes the pane (kills the pty etc.) or just the one tab.
export default function PaneDock(): React.JSX.Element | null {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId))
  const restorePane = useStore((s) => s.restorePane)
  const closePane = useStore((s) => s.closePane)
  const updatePane = useStore((s) => s.updatePane)
  const notifications = useStore((s) => s.notifications)
  const language = useStore((s) => s.settings.language)
  const t = useT()

  const panes = Object.values(ws?.panes ?? {})
  const chips = panes.filter((p) => p.minimized || p.detached)
  const tucked = panes.flatMap((p) =>
    p.tabs.filter((tb) => tb.minimized).map((tb) => ({ pane: p, tab: tb }))
  )
  if (!ws || (chips.length === 0 && tucked.length === 0)) return null

  const restoreTab = (pane: PaneState, tabId: string): void => {
    updatePane(
      pane.id,
      {
        tabs: pane.tabs.map((x) => (x.id === tabId ? { ...x, minimized: undefined } : x)),
        activeTabId: tabId
      },
      ws.id
    )
    if (pane.detached) window.mahas.win.focusDetached(ws.id, pane.id)
    else if (pane.minimized) restorePane(pane.id, ws.id)
  }
  // same last-tab rule as LeafPane.applyTabs, including exec unbind/detach
  const closeTab = (pane: PaneState, tabId: string): void => {
    const tab = pane.tabs.find((x) => x.id === tabId)
    if (tab?.kind === 'term' && tab.binding) {
      const viewId = `${ws.id}:${pane.id}:${tabId}`
      void window.mahas.exec.unbindView({
        operationId: crypto.randomUUID(),
        viewId,
        expectedRevision: tab.binding.revision
      })
      if (tab.binding.terminalId) {
        void window.mahas.exec.op({
          operation: 'terminal.detach',
          payload: { terminalId: tab.binding.terminalId, viewId }
        })
      }
    }
    const next = pane.tabs.filter((x) => x.id !== tabId)
    if (!next.length) {
      closePane(pane.id, ws.id)
      return
    }
    const keep =
      pane.activeTabId && next.some((x) => x.id === pane.activeTabId && !x.minimized)
        ? pane.activeTabId
        : (next.filter((x) => !x.minimized).at(-1)?.id ?? next.at(-1)!.id)
    updatePane(pane.id, { tabs: next, activeTabId: keep }, ws.id)
  }

  const chipTitle = (p: PaneState, tab: PaneTab | undefined): string =>
    p.name ??
    (tab?.kind === 'term' && tab.cwd
      ? `${tab.shell ?? 'sh'} · ${shortPath(tab.cwd)}`
      : tab
        ? blockLabel(tab, language)
        : '')
  // a tab chip names the block itself — the pane's name describes its leaf,
  // not this tab
  const tabTitle = (tab: PaneTab): string =>
    tab.kind === 'term' && tab.cwd
      ? `${tab.shell ?? 'sh'} · ${shortPath(tab.cwd)}`
      : blockLabel(tab, language)

  return (
    <div className="pane-dock">
      {chips.map((p) => {
        const tab = activeTab(p)
        const Icon = KIND_ICONS[tab?.kind ?? 'term']
        // term status reads the active block (pty state lives per-tab):
        // running agent → provider icon; exited shell → status dot
        const agent = tab?.kind === 'term' ? (tab.agent ?? undefined) : undefined
        const exited = tab?.kind === 'term' ? tab.exited : undefined
        return (
          <Tooltip key={p.id} label={t(p.detached ? 'focusDetached' : 'restorePane')}>
            <div
              className={`dock-chip${p.detached ? ' detached' : ''}`}
              onClick={() =>
                p.detached ? window.mahas.win.focusDetached(ws.id, p.id) : restorePane(p.id, ws.id)
              }
            >
              <Icon />
              {agent ? (
                <AgentIcon id={agent} size={10} />
              ) : (
                exited && <span className="dock-dot exited" />
              )}
              <span className="dock-chip-title">{chipTitle(p, tab)}</span>
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
      {tucked.map(({ pane, tab }) => {
        const Icon = KIND_ICONS[tab.kind]
        const agent = tab.kind === 'term' ? (tab.agent ?? undefined) : undefined
        const exited = tab.kind === 'term' ? tab.exited : undefined
        const status = statusForTab(tab, notifications)
        return (
          <Tooltip key={tab.id} label={t('restoreTab')}>
            <div className="dock-chip tab" onClick={() => restoreTab(pane, tab.id)}>
              <Icon />
              {agent ? (
                <AgentIcon id={agent} size={10} />
              ) : (
                <>
                  {exited && <span className="dock-dot exited" />}
                  {(status === 'input' || status === 'error') && (
                    <span className={`dock-dot ${status}`} />
                  )}
                </>
              )}
              <span className="dock-chip-title">{tabTitle(tab)}</span>
              <button
                className="dock-chip-close"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(pane, tab.id)
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
