import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { useStore } from '../store'
import TabStrip, { type TabItem } from './TabStrip'

function AddWorkspaceButton(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const { createWorkspace, addProject } = useStore()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [open])

  const pickDirectory = async (): Promise<void> => {
    const dir = await window.ade.fs.pickDirectory()
    if (!dir) return
    const proj = addProject(dir)
    createWorkspace(proj.id)
    setOpen(false)
  }

  return (
    <div className="ws-add" ref={ref}>
      <button className="tbtn ws-plus" title="New workspace" onClick={() => setOpen(!open)}>
        <Plus size={14} />
      </button>
      {open && (
        <div className="ws-menu">
          {projects.map((p) => (
            <button
              key={p.id}
              className="ws-menu-item"
              onClick={() => {
                createWorkspace(p.id)
                setOpen(false)
              }}
            >
              {p.name}
              <span className="ws-menu-path">{p.path}</span>
            </button>
          ))}
          <button className="ws-menu-item accent" onClick={pickDirectory}>
            + add project…
          </button>
        </div>
      )}
    </div>
  )
}

export default function WorkspaceStrip(): React.JSX.Element {
  const workspaces = useStore((s) => s.workspaces)
  const projects = useStore((s) => s.projects)
  const activeId = useStore((s) => s.activeWorkspaceId)
  const { activateWorkspace, closeWorkspace, renameWorkspace, moveWorkspace } = useStore()

  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? '?'

  const tabs: TabItem[] = workspaces.map((w) => ({
    id: w.id,
    label: w.name,
    sub: projectName(w.projectId)
  }))

  return (
    <div className="ws-strip">
      <TabStrip
        tabs={tabs}
        activeId={activeId}
        onActivate={activateWorkspace}
        onClose={closeWorkspace}
        onRename={renameWorkspace}
        onReorder={moveWorkspace}
        addControl={<AddWorkspaceButton />}
      />
    </div>
  )
}
