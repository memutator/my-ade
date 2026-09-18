import { useRef } from 'react'
import { ChevronRight, FilePlus2, FolderPlus, ListCollapse, RefreshCw } from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'
import { shortPath } from '../utils'
import Tooltip from './Tooltip'
import FileTree, { type FileTreeApi } from './FileTree'
import TreeRootMenu from './TreeRootMenu'
import AgentsPanel from './AgentsPanel'
import { agentCount, useAgentGroups } from '../agentGroups'

// The sidebar splits vertically: the file tree on top, the workspace's
// agent-session list on the bottom. The divider drags to resize (the agents
// fraction persists), and the section header toggles collapse.
export default function Sidebar(): React.JSX.Element | null {
  const open = useStore((s) => s.sidebarOpen)
  const activeWs = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId))
  const project = useStore((s) => s.projects.find((p) => p.id === activeWs?.projectId))
  // the tree root is per-project state — defaults to the project dir but the
  // header dropdown can re-point it at another project or an arbitrary dir
  const root = useStore((s) => (project ? (s.sidebarRoots[project.id] ?? project.path) : ''))
  const setSidebarRoot = useStore((s) => s.setSidebarRoot)
  const collapsed = useStore((s) => s.sideAgentsCollapsed)
  const frac = useStore((s) => s.sideAgentsFrac)
  const setCollapsed = useStore((s) => s.setSideAgentsCollapsed)
  const setFrac = useStore((s) => s.setSideAgentsFrac)
  const groups = useAgentGroups(activeWs?.id)
  const treeApi = useRef<FileTreeApi | null>(null)
  const splitRef = useRef<HTMLDivElement>(null)
  const t = useT()

  // drag the divider: agents height = pointer distance from the split's
  // bottom edge. Dragging while collapsed expands the section first.
  const onSepDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    const el = splitRef.current
    if (!el) return
    if (collapsed) setCollapsed(false)
    const move = (ev: PointerEvent): void => {
      const r = el.getBoundingClientRect()
      setFrac((r.bottom - ev.clientY) / r.height)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!open || !project) return null
  const count = agentCount(groups)
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-title-row">
          <span className="sidebar-title">{project.name}</span>
          <span className="side-actions">
            <Tooltip label={t('newFile')}>
              <button className="side-btn" onClick={() => treeApi.current?.newFile()}>
                <FilePlus2 size={13} />
              </button>
            </Tooltip>
            <Tooltip label={t('newFolder')}>
              <button className="side-btn" onClick={() => treeApi.current?.newFolder()}>
                <FolderPlus size={13} />
              </button>
            </Tooltip>
            <Tooltip label={t('refresh')}>
              <button className="side-btn" onClick={() => treeApi.current?.refresh()}>
                <RefreshCw size={12} />
              </button>
            </Tooltip>
            <Tooltip label={t('collapseAll')}>
              <button className="side-btn" onClick={() => treeApi.current?.collapseAll()}>
                <ListCollapse size={13} />
              </button>
            </Tooltip>
          </span>
        </div>
        <span className="sidebar-path">
          <TreeRootMenu
            root={root}
            onPick={(p) => setSidebarRoot(project.id, p)}
            label={shortPath(root)}
            className="rp-path"
          />
        </span>
      </div>
      <div className="side-split" ref={splitRef}>
        <div className="side-tree">
          <FileTree key={root} rootPath={root} apiRef={treeApi} />
        </div>
        <div className="side-sep" onPointerDown={onSepDown} />
        <section
          className={`side-agents${collapsed ? ' collapsed' : ''}`}
          style={collapsed ? undefined : { flexBasis: `${frac * 100}%` }}
        >
          <button className="side-sec" onClick={() => setCollapsed(!collapsed)}>
            <ChevronRight className={`side-sec-chev${collapsed ? '' : ' open'}`} />
            <span className="side-sec-name">{t('agents')}</span>
            {count > 0 && <span className="ag-count">{count}</span>}
          </button>
          {!collapsed && activeWs && <AgentsPanel wsId={activeWs.id} />}
        </section>
      </div>
    </aside>
  )
}
