import { useEffect } from 'react'
import { TerminalSquare, Globe, Code2 } from 'lucide-react'
import { useStore } from './store'
import { agentProviders, agentLabel } from './agents'
import type { AgentHookEvent, Workspace } from './types'
import TopBar from './components/TopBar'
import SplitView from './components/SplitView'
import EmptyState from './components/EmptyState'
import Sidebar from './components/Sidebar'
import SettingsModal from './components/SettingsModal'

function WorkspaceEmpty({ wsId }: { wsId: string }): React.JSX.Element {
  const newPane = useStore((s) => s.newPane)
  return (
    <div className="empty-state">
      <div className="empty-actions">
        <button onClick={() => newPane('terminal', wsId)}>
          <TerminalSquare />
          terminal
          <kbd>Alt+T</kbd>
        </button>
        <button onClick={() => newPane('browser', wsId)}>
          <Globe />
          browser
          <kbd>Alt+B</kbd>
        </button>
        <button onClick={() => newPane('editor', wsId)}>
          <Code2 />
          editor
          <kbd>Alt+E</kbd>
        </button>
      </div>
    </div>
  )
}

// cwd → workspace/pane resolution for harness hook events. Longest project
// path prefix wins; pane hint only when a terminal's cwd matches exactly.
function resolveHookTarget(
  st: ReturnType<typeof useStore.getState>,
  cwd: string | undefined
): { ws: Workspace | undefined; paneId: string | undefined } {
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
  if (ws && dir) {
    paneId = Object.values(ws.panes).find((p) => p.type === 'terminal' && p.cwd === dir)?.id
  }
  return { ws, paneId }
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
          sidebarOpen: s.sidebarOpen
        })
      }, 400)
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [])

  // OS notification click → jump to workspace/pane
  useEffect(() => {
    return window.ade.notify.onClicked((m) => {
      const st = useStore.getState()
      if (m.workspaceId && st.workspaces.some((w) => w.id === m.workspaceId)) {
        st.activateWorkspace(m.workspaceId)
        if (m.paneId) st.focusPane(m.paneId, m.workspaceId)
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
      const { ws, paneId } = resolveHookTarget(st, ev.cwd)
      const wsId = ws?.id ?? st.activeWorkspaceId
      const label = agentLabel(ev.provider)
      const title = ev.event === 'needs-input' ? `${label} needs input` : `${label} finished`
      const body = ev.message || ws?.name || ev.cwd || ''
      if (wsId) st.notify({ workspaceId: wsId, paneId, title, body })
      if (st.settings.osNotifications) {
        window.ade.notify.show(title, body, { workspaceId: wsId ?? undefined, paneId })
      }
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey) return
      const st = useStore.getState()
      const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId)
      const key = e.key.toLowerCase()
      switch (key) {
        case 't':
          st.newPane('terminal')
          break
        case 'b':
          st.newPane('browser')
          break
        case 'e':
          st.newPane('editor')
          break
        case 'd':
          if (ws?.focusedPaneId) st.splitPane(ws.focusedPaneId, 'row', 'terminal')
          else st.newPane('terminal')
          break
        case 's':
          if (ws?.focusedPaneId) st.splitPane(ws.focusedPaneId, 'col', 'terminal')
          else st.newPane('terminal')
          break
        case 'w':
          if (ws?.focusedPaneId) st.closePane(ws.focusedPaneId)
          break
        case ']':
          st.cycleFocus(1)
          break
        case '[':
          st.cycleFocus(-1)
          break
        case 'm':
          st.updateSettings({ theme: st.resolvedTheme === 'dark' ? 'light' : 'dark' })
          break
        default:
          return
      }
      e.preventDefault()
      e.stopPropagation()
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
          {workspaces.map((w) => (
            <div key={w.id} className="ws-host" hidden={w.id !== activeId}>
              {w.root ? (
                <div className="layout">
                  <SplitView node={w.root} wsId={w.id} />
                </div>
              ) : (
                <WorkspaceEmpty wsId={w.id} />
              )}
            </div>
          ))}
        </div>
      </div>
      <SettingsModal />
    </div>
  )
}
