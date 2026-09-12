import { FolderGit2, Plus } from 'lucide-react'
import { useStore } from '../store'

export default function EmptyState(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const { addProject, createWorkspace } = useStore()

  const pickDir = async (): Promise<void> => {
    const dir = await window.ade.fs.pickDirectory()
    if (dir) createWorkspace(addProject(dir).id)
  }

  return (
    <div className="empty-state">
      <div className="logo">ade</div>
      <div className="empty-actions">
        {projects.map((p) => (
          <button key={p.id} onClick={() => createWorkspace(p.id)}>
            <FolderGit2 />
            {p.name}
            <kbd>{p.path}</kbd>
          </button>
        ))}
        <button onClick={pickDir}>
          <Plus />
          add project
          <kbd>choose dir…</kbd>
        </button>
      </div>
    </div>
  )
}
