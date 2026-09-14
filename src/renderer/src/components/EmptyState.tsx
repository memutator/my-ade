import { FolderGit2, Plus } from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'

export default function EmptyState(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const { addProject, createWorkspace } = useStore()
  const t = useT()

  const pickDir = async (): Promise<void> => {
    const dir = await window.ade.fs.pickDirectory()
    if (dir) createWorkspace(addProject(dir).id, t('workspace'))
  }

  return (
    <div className="empty-state">
      <div className="logo">ADE</div>
      <div className="empty-actions">
        {projects.map((p) => (
          <button key={p.id} onClick={() => createWorkspace(p.id, t('workspace'))}>
            <FolderGit2 />
            {p.name}
            <kbd>{p.path}</kbd>
          </button>
        ))}
        <button onClick={pickDir}>
          <Plus />
          {t('addProject')}
          <kbd>{t('chooseDir')}</kbd>
        </button>
      </div>
    </div>
  )
}
