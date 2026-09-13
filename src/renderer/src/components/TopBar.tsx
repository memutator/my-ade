import { useEffect, useRef } from 'react'
import { TerminalSquare, Globe, Code2, ListTodo, Minus, Square, X, Settings } from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'
import Tooltip from './Tooltip'
import WorkspaceStrip from './WorkspaceStrip'
import NotificationBell from './NotificationBell'
import PaneDock from './PaneDock'
import FileTree from './FileTree'
import AdeLogo from './AdeLogo'

export default function TopBar(): React.JSX.Element {
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const { newPane, setSidebarOpen, setSettingsOpen } = useStore()
  const activeWs = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId))
  const activeProject = useStore((s) => s.projects.find((p) => p.id === activeWs?.projectId))
  const t = useT()

  const treeOverlay = useStore((s) => s.treeOverlayOpen)
  const setTreeOverlay = useStore((s) => s.setTreeOverlayOpen)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onIconEnter = (): void => {
    hoverTimer.current = setTimeout(() => setTreeOverlay(true), 200)
  }
  const onIconLeave = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
  }
  const closeOverlay = (): void => setTreeOverlay(false)

  useEffect(() => {
    if (!treeOverlay) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeOverlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // closeOverlay is a stable setter — re-running on its identity would be noise
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeOverlay])

  return (
    <div className="topbar">
      <div className="app-icon" onMouseEnter={onIconEnter} onMouseLeave={onIconLeave}>
        {/* no tooltip — hovering already pops the file-tree overlay */}
        <button
          className="tbtn icon-btn"
          onClick={() => {
            setTreeOverlay(false)
            setSidebarOpen(!sidebarOpen)
          }}
        >
          <AdeLogo />
        </button>
        {treeOverlay && activeProject && (
          <div className="tree-overlay" onMouseLeave={closeOverlay}>
            <div className="tree-overlay-head">{activeProject.name}</div>
            <FileTree key={activeProject.path} rootPath={activeProject.path} />
          </div>
        )}
      </div>

      <Tooltip label={t('newTerminal')}>
        <button className="tbtn" onClick={() => newPane('terminal')}>
          <TerminalSquare /> {t('terminal')}
        </button>
      </Tooltip>
      <Tooltip label={t('newBrowser')}>
        <button className="tbtn" onClick={() => newPane('browser')}>
          <Globe /> {t('browser')}
        </button>
      </Tooltip>
      <Tooltip label={t('newEditor')}>
        <button className="tbtn" onClick={() => newPane('editor')}>
          <Code2 /> {t('editor')}
        </button>
      </Tooltip>
      <Tooltip label={t('newTodo')}>
        <button className="tbtn" onClick={() => newPane('todo')}>
          <ListTodo /> {t('todos')}
        </button>
      </Tooltip>

      <WorkspaceStrip />

      <div className="spacer" />
      <PaneDock />
      <NotificationBell />
      <Tooltip label={t('settingsTooltip')}>
        <button className="tbtn" onClick={() => setSettingsOpen(true)}>
          <Settings />
        </button>
      </Tooltip>
      {/* theme toggle lives in the settings page (Alt+M shortcut still works) */}
      <div className="win-controls">
        <Tooltip label={t('minimize')}>
          <button className="tbtn" onClick={() => window.ade.win.minimize()}>
            <Minus />
          </button>
        </Tooltip>
        <Tooltip label={t('maximize')}>
          <button className="tbtn" onClick={() => window.ade.win.maximize()}>
            <Square />
          </button>
        </Tooltip>
        <Tooltip label={t('close')}>
          <button className="tbtn" onClick={() => window.ade.win.close()}>
            <X />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
