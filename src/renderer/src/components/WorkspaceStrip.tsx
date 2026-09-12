import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'
import Tooltip from './Tooltip'
import TabStrip, { type TabItem } from './TabStrip'

function AddWorkspaceButton(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const { createWorkspace, addProject } = useStore()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const t = useT()

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    // webview clicks never reach this document — catch the focus theft instead
    // (webview focus produces no focusin, only a capture-phase focus event)
    const onFocus = (e: FocusEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('focus', onFocus, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('focus', onFocus, true)
    }
  }, [open])

  const pickDirectory = async (): Promise<void> => {
    const dir = await window.ade.fs.pickDirectory()
    if (!dir) return
    const proj = addProject(dir)
    createWorkspace(proj.id, t('workspace'))
    setOpen(false)
  }

  return (
    <div className="ws-add" ref={ref}>
      <Tooltip label={t('newWorkspace')}>
        <button className="tbtn ws-plus" onClick={() => setOpen(!open)}>
          <Plus size={14} />
        </button>
      </Tooltip>
      {open && (
        <>
          <div className="click-catcher" onMouseDown={() => setOpen(false)} />
          <div className="ws-menu">
            {projects.map((p) => (
              <button
                key={p.id}
                className="ws-menu-item"
                onClick={() => {
                  createWorkspace(p.id, t('workspace'))
                  setOpen(false)
                }}
              >
                {p.name}
                <span className="ws-menu-path">{p.path}</span>
              </button>
            ))}
            <button className="ws-menu-item accent" onClick={pickDirectory}>
              {t('addProjectItem')}
            </button>
          </div>
        </>
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
