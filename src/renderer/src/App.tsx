import { useEffect } from 'react'
import { TerminalSquare, Globe, Code2, ListTodo } from 'lucide-react'
import { useStore } from './store'
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
  if (ws) {
    if (dir) {
      paneId = Object.values(ws.panes).find((p) => p.type === 'terminal' && p.cwd === dir)?.id
    }
    // cwd didn't match a live terminal — still land on something sensible so
    // clicking the notification focuses the workspace's active pane
    paneId ??= ws.focusedPaneId ?? Object.keys(ws.panes)[0]
  }
  return { ws, paneId }
}

// Directional focus move: among the active workspace's rendered .pane rects,
// pick the pane whose center lies in `dir` from the focused pane's center,
// scored by axial + orthogonal distance. Null when nothing lies that way.
function paneIdInDirection(
  st: ReturnType<typeof useStore.getState>,
  dir: 'left' | 'right' | 'up' | 'down'
): string | null {
  const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId)
  const host = document.querySelector('.ws-host:not([hidden])')
  if (!ws?.focusedPaneId || !host) return null
  const els = [...host.querySelectorAll<HTMLElement>('.pane[data-pane-id]')]
  const from = els.find((el) => el.dataset.paneId === ws.focusedPaneId)
  if (!from) return null
  const fr = from.getBoundingClientRect()
  const fx = fr.left + fr.width / 2
  const fy = fr.top + fr.height / 2
  let best: { id: string; score: number } | null = null
  for (const el of els) {
    if (el === from) continue
    const r = el.getBoundingClientRect()
    const dx = r.left + r.width / 2 - fx
    const dy = r.top + r.height / 2 - fy
    const axial = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy
    if (axial <= 0) continue
    const score = axial + Math.abs(dir === 'left' || dir === 'right' ? dy : dx)
    const id = el.dataset.paneId
    if (id && (!best || score < best.score)) best = { id, score }
  }
  return best?.id ?? null
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
      const title = translate(
        st.settings.language,
        ev.event === 'needs-input' ? 'agentNeedsInput' : 'agentFinished',
        { agent: label }
      )
      const body = ev.message || ws?.name || ev.cwd || ''
      if (wsId) st.notify({ workspaceId: wsId, paneId, title, body })
      if (st.settings.osNotifications) {
        window.ade.notify.show(title, body, { workspaceId: wsId ?? undefined, paneId })
      }
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey) return
      const st = useStore.getState()

      // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs inside the focused pane.
      // Deliberately window-level (not gated on target): inputs, CodeMirror and
      // xterm must not keep it; panes without internal tabs simply no-op.
      if (e.ctrlKey && !e.altKey && e.key === 'Tab') {
        st.cyclePaneTab(e.shiftKey ? -1 : 1)
        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (!e.altKey) return
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
        case 'l':
          st.newPane('todo')
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
        case 'arrowright':
        case 'arrowleft':
        case 'arrowdown':
        case 'arrowup': {
          const dir = key.slice('arrow'.length) as 'right' | 'left' | 'down' | 'up'
          if (e.ctrlKey) {
            // Ctrl+Alt+←/→ = previous/next workspace; up/down stays unbound
            if (dir === 'up' || dir === 'down') return
            st.cycleWorkspace(dir === 'right' ? 1 : -1)
          } else {
            const paneId = paneIdInDirection(st, dir)
            if (paneId) st.focusPane(paneId)
          }
          break
        }
        default:
          // Alt+1 … Alt+9 → workspace N, clamped to the last existing one
          if (key >= '1' && key <= '9' && st.workspaces.length > 0) {
            const i = Math.min(Number(key) - 1, st.workspaces.length - 1)
            st.activateWorkspace(st.workspaces[i].id)
            break
          }
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
