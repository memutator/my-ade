import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, FolderTree, Minus, Pin, PinOff, Square, X } from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'
import type { PaneState } from '../types'
import { PaneFor } from './SplitView'
import Tooltip from './Tooltip'
import FileTree from './FileTree'

// A detached pane lives here: its own frameless OS window with a minimal bar
// (drag anywhere, reattach, window controls). The pane keeps its wsId/paneId
// identity in the main store — this window is just another view onto it.
// Local edits (tab ops, renames) sync up via pane:syncUp; close goes through
// pane:cmd so the main store stays the single source of truth.
export default function DetachedApp({
  wsId,
  paneId
}: {
  wsId: string
  paneId: string
}): React.JSX.Element {
  const pane = useStore((s) => s.workspaces.find((w) => w.id === wsId)?.panes[paneId])
  const project = useStore((s) => {
    const w = s.workspaces.find((x) => x.id === wsId)
    return s.projects.find((p) => p.id === w?.projectId)
  })
  const settings = useStore((s) => s.settings)
  const setResolvedTheme = useStore((s) => s.setResolvedTheme)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const setSidebarOpen = useStore((s) => s.setSidebarOpen)
  const treeOverlay = useStore((s) => s.treeOverlayOpen)
  const setTreeOverlay = useStore((s) => s.setTreeOverlayOpen)
  const t = useT()
  const [pinned, setPinned] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isEditor = pane?.type === 'editor'

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

  // claim the fresh pane snapshot the main window captured at detach — it
  // carries live pty session ids and newest tabs the disk-hydrated copy may
  // lack. The local copy must also carry `detached` — terminal cleanup keys
  // off it (keep the pty alive when this view unmounts) and sync-up echoes
  // the whole pane object, which would otherwise clear the flag in main
  useEffect(() => {
    void window.ade?.win.hello().then((h) => {
      if (h?.pane) {
        useStore
          .getState()
          .updatePane(h.paneId, { ...(h.pane as PaneState), detached: true }, h.wsId)
      } else {
        useStore.getState().updatePane(paneId, { detached: true }, wsId)
      }
    })
  }, [wsId, paneId])

  // push local pane-state edits (tab renames, cwd/agent patches, closes) up
  // to the main window's store — it's the single source of truth
  useEffect(() => {
    let last: unknown
    const unsub = useStore.subscribe((s) => {
      const p = s.workspaces.find((w) => w.id === wsId)?.panes[paneId]
      if (p !== last) {
        last = p
        if (p) window.ade.win.paneSyncUp({ wsId, paneId, pane: p })
      }
    })
    return unsub
  }, [wsId, paneId])

  // sidebar (Alt+X) + tree overlay (Alt+O) shortcuts, same keys as the main
  // window — the store is per-window so toggles here stay local
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'x') {
        setSidebarOpen(!useStore.getState().sidebarOpen)
        e.preventDefault()
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'o') {
        setTreeOverlay(!useStore.getState().treeOverlayOpen)
        e.preventDefault()
      } else if (e.key === 'Escape' && useStore.getState().treeOverlayOpen) {
        setTreeOverlay(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [setSidebarOpen, setTreeOverlay])

  const onIconEnter = (): void => {
    hoverTimer.current = setTimeout(() => setTreeOverlay(true), 200)
  }
  const onIconLeave = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
  }
  const closeOverlay = (): void => setTreeOverlay(false)

  // files open into THIS pane — the store default would hunt for the
  // focused/first editor in the (stale) workspace copy and could land on a
  // pane that actually lives in the main window
  const openHere = useCallback(
    (path: string, name: string): void => {
      const st = useStore.getState()
      const p = st.workspaces.find((w) => w.id === wsId)?.panes[paneId]
      if (p?.type !== 'editor') return
      const existing = p.tabs.find((x) => x.path === path)
      const tab = existing ?? { id: crypto.randomUUID(), path, name }
      st.updatePane(
        paneId,
        { tabs: existing ? p.tabs : [...p.tabs, tab], activeTabId: tab.id },
        wsId
      )
    },
    [wsId, paneId]
  )

  const togglePin = (): void => {
    const next = !pinned
    setPinned(next)
    window.ade.win.setAlwaysOnTop?.(next)
  }

  return (
    <div className="app detached">
      <div className="detached-bar">
        {isEditor && project && (
          <div
            className="app-icon det-tree-btn"
            onMouseEnter={onIconEnter}
            onMouseLeave={onIconLeave}
          >
            <Tooltip label={t('filesPeek')}>
              <button
                className={`tbtn icon-btn${sidebarOpen ? ' on' : ''}`}
                onClick={() => setSidebarOpen(!sidebarOpen)}
              >
                <FolderTree />
              </button>
            </Tooltip>
          </div>
        )}
        <span className="dt-title">{pane?.title ?? ''}</span>
        <div className="dt-actions">
          <Tooltip label={t(pinned ? 'unpinTop' : 'alwaysOnTop')}>
            <button className={`pbtn${pinned ? ' on' : ''}`} onClick={togglePin}>
              {pinned ? <PinOff /> : <Pin />}
            </button>
          </Tooltip>
          <Tooltip label={t('reattachPane')}>
            <button className="pbtn" onClick={() => window.ade.win.reattach()}>
              <ArrowDownToLine />
            </button>
          </Tooltip>
          <Tooltip label={t('minimize')}>
            <button className="pbtn" onClick={() => window.ade.win.minimize()}>
              <Minus />
            </button>
          </Tooltip>
          <Tooltip label={t('maximize')}>
            <button className="pbtn" onClick={() => window.ade.win.maximize()}>
              <Square />
            </button>
          </Tooltip>
          <Tooltip label={t('reattachPane')}>
            <button className="pbtn" onClick={() => window.ade.win.reattach()}>
              <X />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="detached-body">
        {sidebarOpen && project && (
          <aside className="sidebar det-side">
            <div className="sidebar-head">
              <div className="sidebar-title-row">
                <span className="sidebar-title">{project.name}</span>
              </div>
              <span className="sidebar-path">{project.path}</span>
            </div>
            <FileTree key={project.path} rootPath={project.path} onOpenFile={openHere} />
          </aside>
        )}
        {pane ? <PaneFor paneId={paneId} wsId={wsId} /> : null}
      </div>
      {treeOverlay && project && (
        <div className="tree-overlay det-tree-overlay" onMouseLeave={closeOverlay}>
          <div className="tree-overlay-head">{project.name}</div>
          <FileTree key={`ov-${project.path}`} rootPath={project.path} onOpenFile={openHere} />
        </div>
      )}
    </div>
  )
}
