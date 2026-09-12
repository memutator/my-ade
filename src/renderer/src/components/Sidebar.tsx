import { useStore } from '../store'
import FileTree from './FileTree'

export default function Sidebar(): React.JSX.Element | null {
  const open = useStore((s) => s.sidebarOpen)
  const activeWs = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId))
  const project = useStore((s) => s.projects.find((p) => p.id === activeWs?.projectId))

  if (!open || !project) return null
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">{project.name}</span>
        <span className="sidebar-path">{project.path}</span>
      </div>
      <FileTree rootPath={project.path} />
    </aside>
  )
}
