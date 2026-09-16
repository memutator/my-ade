import { useRef } from 'react'
import { FilePlus2, FolderPlus, ListCollapse, RefreshCw } from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'
import { shortPath } from '../utils'
import Tooltip from './Tooltip'
import FileTree, { type FileTreeApi } from './FileTree'
import TreeRootMenu from './TreeRootMenu'

export default function Sidebar(): React.JSX.Element | null {
  const open = useStore((s) => s.sidebarOpen)
  const activeWs = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId))
  const project = useStore((s) => s.projects.find((p) => p.id === activeWs?.projectId))
  // the tree root is per-project state — defaults to the project dir but the
  // header dropdown can re-point it at another project or an arbitrary dir
  const root = useStore((s) => (project ? (s.sidebarRoots[project.id] ?? project.path) : ''))
  const setSidebarRoot = useStore((s) => s.setSidebarRoot)
  const treeApi = useRef<FileTreeApi | null>(null)
  const t = useT()

  if (!open || !project) return null
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
      <FileTree key={root} rootPath={root} apiRef={treeApi} />
    </aside>
  )
}
