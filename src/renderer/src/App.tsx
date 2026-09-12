import { useEffect } from 'react'
import { TerminalSquare, Globe, Code2, ListTodo } from 'lucide-react'
import { leafPaneIds, useStore } from './store'
import { applyShortcut } from './shortcuts'
import { useT, translate } from './i18n'
import { agentProviders, agentLabel } from './agents'
import type { AgentHookEvent, Workspace } from './types'

import TopBar from './components/TopBar'
import SplitView from './components/SplitView'
import EmptyState from './components/EmptyState'
import Sidebar from './components/Sidebar'
import SettingsModal from './components/SettingsModal'

function WorkspaceEmpty({ wsId }: { wsId: string }): React.JSX.Element {
  const newPane = useStore((s) => s.newPane)
  const t = useT()
  return (
    <div className="empty-state">
      <div className="empty-actions">
        <button onClick={() => newPane('terminal', wsId)}>
          <TerminalSquare />
          {t('terminal')}
          <kbd>Alt+T</kbd>
        </button>
        <button onClick={() => newPane('browser', wsId)}>
          <Globe />
          {t('browser')}
          <kbd>Alt+B</kbd>
        </button>
        <button onClick={() => newPane('editor', wsId)}>
          <Code2 />
          {t('editor')}
          <kbd>Alt+E</kbd>
        </button>
        <button onClick={() => newPane('todo', wsId)}>
          <ListTodo />
          {t('todos')}
          <kbd>Alt+L</kbd>
        </button>
      </div>
    </div>
  )
}

// cwd → workspace/pane/tab resolution for harness hook events. Longest project
// path prefix wins; pane+tab hint only when a terminal tab's cwd matches
// exactly (background tabs count — the shell that emitted the event may not be
// the visible one).
function resolveHookTarget(
  st: ReturnType<typeof useStore.getState>,
  cwd: string | undefined
): { ws: Workspace | undefined; paneId: string | undefined; tabId: string | undefined } {
  const dir = (cwd ?? '').replace(/\/+$/, '')
  let ws: Workspace | undefined
  let best = -1
  if (dir) {
    for (const w of st.workspaces) {
      const proj = st.projects.find((p) => p.id === w.projectId)
      const pp = proj?.path.replace(/\/+$/, '') ?? ''
      if (pp && (dir === pp || dir.startsWith(pp + '/')) && pp.length > best) {
        ws = w
        best = pp.length
      }
    }
  }
  let paneId: string | undefined
  let tabId: string | undefined
  if (ws) {
    if (dir) {
      for (const p of Object.values(ws.panes)) {
        if (p.type !== 'terminal') continue
        const hit = (p.tabs ?? []).find((t) => (t.cwd ?? '').replace(/\/+$/, '') === dir)
        if (hit) {
          paneId = p.id
          tabId = hit.id
          break
        }
      }
    }
    // cwd didn't match a live terminal — still land on something sensible so
    // clicking the notification focuses the workspace's active pane
    paneId ??= ws.focusedPaneId ?? Object.keys(ws.panes)[0]
  }
  return { ws, paneId, tabId }
}

export default function App(): React.JSX.Element {
  const workspaces = useStore((s) => s.workspaces)
  const activeId = useStore((s) => s.activeWorkspaceId)
  const settings = useStore((s) => s.settings)
  const setResolvedTheme = useStore((s) => s.setResolvedTheme)

  // resolve 'system' theme and apply css vars
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const resolved =
        settings.theme === 'system' ? (mq.matches ? 'dark' : 'light') : settings.theme
      setResolvedTheme(resolved)
      document.documentElement.dataset.theme = resolved
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings.theme, setResolvedTheme])

  useEffect(() => {
    const el = document.documentElement
    el.style.setProperty('--accent', settings.accent)
    el.style.setProperty('--font-ui', settings.uiFont)
  }, [settings.accent, settings.uiFont])

  // push enabled-provider patterns to the pty host
  useEffect(() => {
    const manifest = agentProviders()
    const patterns: Record<string, string[]> = {}
    for (const [id, info] of Object.entries(manifest)) {
      if (settings.providers[id] !== false && info.match?.length) patterns[id] = info.match
    }
    if (Object.keys(patterns).length) window.ade.agents.configure?.(patterns)
  }, [settings.providers])

  // persist state (debounced)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = useStore.subscribe((s) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        window.ade.state.save({
          projects: s.projects,
          workspaces: s.workspaces,
          activeWorkspaceId: s.activeWorkspaceId,
          settings: s.settings,
          sidebarOpen: s.sidebarOpen,
          bookmarks: s.bookmarks,
          todos: s.todos
        })
      }, 400)
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [])

  // OS notification click → jump to workspace/pane/tab
  useEffect(() => {
    return window.ade.notify.onClicked((m) => {
      const st = useStore.getState()
      if (m.workspaceId && st.workspaces.some((w) => w.id === m.workspaceId)) {
        st.activateWorkspace(m.workspaceId)
        if (m.paneId) {
          st.focusPane(m.paneId, m.workspaceId)
          if (m.tabId) {
            const p = st.workspaces.find((w) => w.id === m.workspaceId)?.panes[m.paneId]
            if (p && 'tabs' in p && p.tabs.some((t) => t.id === m.tabId)) {
              st.updatePane(m.paneId, { activeTabId: m.tabId }, m.workspaceId)
            }
          }
        }
      }
    })
  }, [])

  // harness hook events (real turn-complete signals, not process-exit proxy)
  useEffect(() => {
    if (!window.ade.hooks?.onEvent) return
    return window.ade.hooks.onEvent((ev: AgentHookEvent) => {
      if (ev.event !== 'turn-complete' && ev.event !== 'needs-input') return
      const st = useStore.getState()
      if (st.settings.providers[ev.provider] === false) return
      const { ws, paneId, tabId } = resolveHookTarget(st, ev.cwd)
      // foreign sessions (hook ran outside ade — global hooks append here too):
      // notify only when the agent worked inside a registered project; agents
      // in unrelated dirs stay silent
      if (!ev.ours && !ws) return
      const wsId = ws?.id ?? st.activeWorkspaceId
      const label = agentLabel(ev.provider)
      const title = translate(
        st.settings.language,
        ev.event === 'needs-input' ? 'agentNeedsInput' : 'agentFinished',
        { agent: label }
      )
      const body = ev.message || ws?.name || ev.cwd || ''
      if (wsId) st.notify({ workspaceId: wsId, paneId, tabId, title, body, agent: ev.provider })
      if (st.settings.osNotifications) {
        window.ade.notify.show(title, body, { workspaceId: wsId ?? undefined, paneId, tabId })
      }
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (
        applyShortcut({
          key: e.key,
          alt: e.altKey,
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
          meta: e.metaKey
        })
      ) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="app">
      <TopBar />
      <div className="app-main">
        <Sidebar />
        <div className="workspace-area">
          {workspaces.length === 0 && <EmptyState />}
          {workspaces.map((w) => {
            // all leaves minimized → keep .layout mounted-but-hidden (terminals
            // keep running) and show the empty state; the dock still offers
            // the chips for restoring them
            const hasVisible = leafPaneIds(w.root).some((id) => !w.panes[id]?.minimized)
            return (
              <div key={w.id} className="ws-host" data-ws-id={w.id} hidden={w.id !== activeId}>
                {w.root && (
                  <div className="layout" hidden={!hasVisible}>
                    <SplitView node={w.root} wsId={w.id} />
                  </div>
                )}
                {!hasVisible && <WorkspaceEmpty wsId={w.id} />}
              </div>
            )
          })}
        </div>
      </div>
      <SettingsModal />
    </div>
  )
}
