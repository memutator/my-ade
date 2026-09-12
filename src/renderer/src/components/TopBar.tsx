import { useEffect, useRef, useState } from 'react'
import {
  TerminalSquare,
  Globe,
  Code2,
  Sun,
  Moon,
  Minus,
  Square,
  X,
  Settings
} from 'lucide-react'
import { useStore } from '../store'
import WorkspaceStrip from './WorkspaceStrip'
import NotificationBell from './NotificationBell'
import FileTree from './FileTree'
import AdeLogo from './AdeLogo'

export default function TopBar(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const { newPane, updateSettings, setSidebarOpen, setSettingsOpen } = useStore()
  const activeWs = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId))
  const activeProject = useStore((s) => s.projects.find((p) => p.id === activeWs?.projectId))

  const resolvedTheme = useStore((s) => s.resolvedTheme)
  const [treeOverlay, setTreeOverlay] = useState(false)
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
  }, [treeOverlay])

  return (
    <div className="topbar">
      <div className="app-icon" onMouseEnter={onIconEnter} onMouseLeave={onIconLeave}>
        <button
          className="tbtn icon-btn"
          title="Files — hover to peek, click to pin"
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
            <FileTree rootPath={activeProject.path} />
          </div>
        )}
      </div>

      <button className="tbtn" title="New terminal (Alt+T)" onClick={() => newPane('terminal')}>
        <TerminalSquare /> terminal
      </button>
      <button className="tbtn" title="New browser (Alt+B)" onClick={() => newPane('browser')}>
        <Globe /> browser
      </button>
      <button className="tbtn" title="New editor (Alt+E)" onClick={() => newPane('editor')}>
        <Code2 /> editor
      </button>

      <WorkspaceStrip />

      <div className="spacer" />
      <NotificationBell />
      <button className="tbtn" title="Settings" onClick={() => setSettingsOpen(true)}>
        <Settings />
      </button>
      <button
        className="tbtn"
        title="Toggle theme (Alt+M)"
        onClick={() =>
          updateSettings({
            theme: settings.theme === 'dark' ? 'light' : 'dark'
          })
        }
      >
        {resolvedTheme === 'dark' ? <Sun /> : <Moon />}
      </button>
      <div className="win-controls">
        <button className="tbtn" onClick={() => window.ade.win.minimize()}>
          <Minus />
        </button>
        <button className="tbtn" onClick={() => window.ade.win.maximize()}>
          <Square />
        </button>
        <button className="tbtn" onClick={() => window.ade.win.close()}>
          <X />
        </button>
      </div>
    </div>
  )
}
