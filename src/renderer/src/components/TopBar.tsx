import { useEffect, useRef } from 'react'
import { TerminalSquare, Globe, Code2, Minus, Square, X, Settings } from 'lucide-react'
import type { Project } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import Tooltip from './Tooltip'
import WorkspaceStrip from './WorkspaceStrip'
import NotificationBell from './NotificationBell'
import PaneDock from './PaneDock'
import FileTree from './FileTree'
import TreeRootMenu from './TreeRootMenu'
import AdeLogo from './AdeLogo'

// peek overlay tree — the header is a root picker (recents → projects →
// browse). It shares the sidebar's per-project root so the peek and the
// pinned tree always agree (and the pick survives the transient overlay).
function OverlayTree({ project }: { project: Project }): React.JSX.Element {
  const root = useStore((s) => s.sidebarRoots[project.id] ?? project.path)
  const setSidebarRoot = useStore((s) => s.setSidebarRoot)
  return (
    <>
      <div className="tree-overlay-head">
        <TreeRootMenu
          root={root}
          onPick={(p) => setSidebarRoot(project.id, p)}
          label={root === project.path ? project.name : root}
        />
      </div>
      <FileTree key={root} rootPath={root} />
    </>
  )
}

export default function TopBar(): React.JSX.Element {
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const { newBlock, setSidebarOpen, setSettingsOpen } = useStore()
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
            <OverlayTree key={activeProject.id} project={activeProject} />
          </div>
        )}
      </div>

      <Tooltip label={t('newTerminal')}>
        <button className="tbtn" onClick={() => newBlock('term')}>
          <TerminalSquare /> {t('terminal')}
        </button>
      </Tooltip>
      <Tooltip label={t('newBrowser')}>
        <button className="tbtn" onClick={() => newBlock('web')}>
          <Globe /> {t('browser')}
        </button>
      </Tooltip>
      <Tooltip label={t('newEditor')}>
        <button className="tbtn" onClick={() => newBlock('file')}>
          <Code2 /> {t('editor')}
        </button>
      </Tooltip>

      <WorkspaceStrip />

      <div className="spacer" />
      <PaneDock />
      {window.ade.dev && <span className="dev-badge">dev</span>}
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
