import { useEffect, useRef, useState } from 'react'
import {
  TerminalSquare,
  Globe,
  Code2,
  ListTodo,
  Sun,
  Moon,
  Minus,
  Square,
  X,
  Settings
} from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'
import Tooltip from './Tooltip'
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
  const t = useT()

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
        <Tooltip label={t('filesPeek')}>
          <button
            className="tbtn icon-btn"
            onClick={() => {
              setTreeOverlay(false)
              setSidebarOpen(!sidebarOpen)
            }}
          >
            <AdeLogo />
          </button>
        </Tooltip>
        {treeOverlay && activeProject && (
          <div className="tree-overlay" onMouseLeave={closeOverlay}>
            <div className="tree-overlay-head">{activeProject.name}</div>
            <FileTree rootPath={activeProject.path} />
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
      <NotificationBell />
      <Tooltip label={t('settingsTooltip')}>
        <button className="tbtn" onClick={() => setSettingsOpen(true)}>
          <Settings />
        </button>
      </Tooltip>
      <Tooltip label={t('toggleTheme')}>
        <button
          className="tbtn"
          onClick={() =>
            updateSettings({
              theme: settings.theme === 'dark' ? 'light' : 'dark'
            })
          }
        >
          {resolvedTheme === 'dark' ? <Sun /> : <Moon />}
        </button>
      </Tooltip>
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
