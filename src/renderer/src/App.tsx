import { useEffect } from 'react'
import { TerminalSquare, Globe, Code2, ListTodo } from 'lucide-react'
import { useStore, visibleLeafIds } from './store'
import { applyShortcut } from './shortcuts'
import { useT } from './i18n'
import { agentProviders } from './agents'
import {
  handleHookEvent,
  reportProcessIdle,
  refreshHookInstalled,
  sweepAttended
} from './attention'
import { initResumeTracking } from './resume'

import TopBar from './components/TopBar'
import SplitView, { PanePortals } from './components/SplitView'
import FloatLayer from './components/FloatLayer'
import EmptyState from './components/EmptyState'
import Sidebar from './components/Sidebar'
import SettingsPage from './components/SettingsPage'
import ResumePrompt from './components/ResumePrompt'
import Toasts from './components/Toasts'

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

  // persist state (debounced) + a synchronous flush on unload — the pending
  // debounce dies with the window, so without it the final snapshot (last
  // session events, resume records) silently never reaches disk
  useEffect(() => {
    const snapshot = (s: ReturnType<typeof useStore.getState>): Record<string, unknown> => ({
      stateVersion: 2,
      projects: s.projects,
      workspaces: s.workspaces,
      activeWorkspaceId: s.activeWorkspaceId,
      settings: s.settings,
      sidebarOpen: s.sidebarOpen,
      bookmarks: s.bookmarks,
      todos: s.todos,
      agentSessions: s.agentSessions,
      resumeSessions: s.resumeSessions,
      treeRoots: s.treeRoots,
      sidebarRoots: s.sidebarRoots
    })
    const flush = (): void => {
      window.ade.state.saveNow?.(snapshot(useStore.getState()))
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = useStore.subscribe((s) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void window.ade.state.save(snapshot(s))
      }, 400)
    })
    window.addEventListener('beforeunload', flush)
    return () => {
      unsub()
      window.removeEventListener('beforeunload', flush)
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
          const target = st.workspaces.find((w) => w.id === m.workspaceId)?.panes[m.paneId]
          // detached panes live in their own OS window — bring it forward
          if (target?.detached) {
            window.ade.win.focusDetached(m.workspaceId, m.paneId)
          } else {
            st.focusPane(m.paneId, m.workspaceId)
          }
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

  // harness hook events (real turn-complete signals, not process-exit proxy).
  // Policy lives in attention.ts — one choke point for every agent signal.
  useEffect(() => {
    void refreshHookInstalled()
    if (!window.ade.hooks?.onEvent) return
    return window.ade.hooks.onEvent((ev) => void handleHookEvent(ev))
  }, [])

  // live-session bookkeeping for restart-resume (pty exit / agent loss drop
  // records; pending resume commands drain on spawn)
  useEffect(() => initResumeTracking(), [])

  // window.open from this renderer (markdown link tooltips) arrives as
  // 'open-url' — open it as an in-app browser pane, ADE-first
  useEffect(() => window.ade.win.onOpenUrl((url) => useStore.getState().openUrlInBrowser(url)), [])

  // read-on-view: unread pings for whatever the user is attending clear
  // without a click. Runs on store changes (workspace switch, tab activate,
  // pane layout, new ping) and when the window gains focus.
  useEffect(() => {
    const unsub = useStore.subscribe(sweepAttended)
    window.addEventListener('focus', sweepAttended)
    return () => {
      unsub()
      window.removeEventListener('focus', sweepAttended)
    }
  }, [])

  // restore detached windows across restarts — the flag persists but the
  // windows themselves are runtime-only
  useEffect(() => {
    const st = useStore.getState()
    for (const w of st.workspaces) {
      for (const p of Object.values(w.panes)) {
        if (p.detached) window.ade.win.detach(w.id, p.id)
      }
    }
  }, [])

  // detached-pane window coordination
  useEffect(() => {
    const offReattach = window.ade.win.onPaneReattach?.((m) => {
      useStore.getState().attachPane(m.paneId, m.wsId)
    })
    const offCmd = window.ade.win.onPaneCmd?.((m) => {
      if (m.action === 'closePane') useStore.getState().closePane(m.paneId, m.wsId)
      // a detached terminal saw its agent process leave — relay into the main
      // store's attention policy (the detached store's notifications are
      // invisible; only this renderer owns the bell)
      if (m.action === 'agentIdle' && m.provider && m.tabId)
        reportProcessIdle(m.provider, m.wsId, m.paneId, m.tabId)
      // a detached window is attending its pane — clear pings aimed at it
      if (m.action === 'attended')
        useStore.getState().markAttendedRead({ wsId: m.wsId, paneId: m.paneId, tabId: m.tabId })
      // detached windows can't own panes — a link opened there lands in the
      // main store's workspace
      if (m.action === 'openUrl' && m.url) useStore.getState().openUrlInBrowser(m.url, m.wsId)
    })
    const offSync = window.ade.win.onPaneSync?.((m) => {
      const st = useStore.getState()
      const cur = st.workspaces.find((w) => w.id === m.wsId)?.panes[m.paneId]
      if (!cur || !m.pane || typeof m.pane !== 'object') return
      // content fields come from the detached window; presentation flags
      // (detached/minimized/floating) stay owned by the main store
      const synced = m.pane as Record<string, unknown>
      st.updatePane(
        m.paneId,
        {
          ...synced,
          detached: cur.detached,
          minimized: cur.minimized,
          floating: cur.floating
        } as never,
        m.wsId
      )
    })
    return () => {
      offReattach?.()
      offCmd?.()
      offSync?.()
    }
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
            // all leaves minimized/detached → keep .layout mounted-but-hidden
            // (terminals keep running) and show the empty state; the dock
            // still offers the chips for restoring them. Floating panes are
            // an overlay on top — they don't count toward hasVisible (the
            // tree may be empty behind them).
            const hasVisible = visibleLeafIds(w.root, w.panes).length > 0
            return (
              <div key={w.id} className="ws-host" data-ws-id={w.id} hidden={w.id !== activeId}>
                {w.root && (
                  <div className="layout" hidden={!hasVisible}>
                    <SplitView node={w.root} wsId={w.id} />
                  </div>
                )}
                {!hasVisible && <WorkspaceEmpty wsId={w.id} />}
                <FloatLayer wsId={w.id} />
                <PanePortals wsId={w.id} />
              </div>
            )
          })}
        </div>
      </div>
      <SettingsPage />
      <ResumePrompt />
      <Toasts />
    </div>
  )
}
