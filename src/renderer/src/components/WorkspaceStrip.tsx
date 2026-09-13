import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GitBranchPlus, Plus } from 'lucide-react'
import type { Project } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import Tooltip from './Tooltip'
import TabStrip, { type TabItem } from './TabStrip'
import WorktreeModal from './WorktreeModal'

function AddWorkspaceButton({
  onWorktree
}: {
  onWorktree: (p: Project) => void
}): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const { createWorkspace, addProject } = useStore()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [repos, setRepos] = useState<Record<string, boolean>>({})
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const t = useT()

  // the menu is portaled to <body> (the strip's overflow-y:clip would hide an
  // in-place absolute menu), so "inside" for outside-close purposes is the
  // '+' wrap OR the portaled menu
  useEffect(() => {
    if (!open) return
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      (ref.current?.contains(target) === true || menuRef.current?.contains(target) === true)
    const onDown = (e: MouseEvent): void => {
      if (!inside(e.target)) setOpen(false)
    }
    // webview clicks never reach this document — catch the focus theft instead
    // (webview focus produces no focusin, only a capture-phase focus event)
    const onFocus = (e: FocusEvent): void => {
      if (!inside(e.target)) setOpen(false)
    }
    // a fixed menu can't follow its anchor — close if the strip scrolls or the
    // window resizes (a scroll originating inside the menu itself is exempt)
    const onMove = (e: Event): void => {
      if (!inside(e.target)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('focus', onFocus, true)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('focus', onFocus, true)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])

  // left-align under the '+' like the old absolute menu, but clamp into the
  // viewport — long project paths can push the width past the window edge
  useLayoutEffect(() => {
    if (!open) return
    const menu = menuRef.current
    if (!menu) return
    const w = menu.getBoundingClientRect().width
    setPos((p) =>
      p ? { top: p.top, left: Math.max(4, Math.min(p.left, window.innerWidth - w - 4)) } : p
    )
  }, [open])

  // probe each project once per menu-open to learn which are git repos — only
  // those get a worktree button
  useEffect(() => {
    if (!open) return
    let on = true
    for (const p of projects) {
      if (p.id in repos) continue
      void window.ade.git.info(p.path).then((i) => {
        if (on) setRepos((r) => (p.id in r ? r : { ...r, [p.id]: !!i.isRepo }))
      })
    }
    return () => {
      on = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- repos is write-only cache here
  }, [open, projects])

  const pickDirectory = async (): Promise<void> => {
    const dir = await window.ade.fs.pickDirectory()
    if (!dir) return
    const proj = addProject(dir)
    createWorkspace(proj.id, t('workspace'))
    setOpen(false)
  }

  const toggle = (): void => {
    if (!open && ref.current) {
      // measure the anchor when the menu opens — the portaled menu is
      // position:fixed just below the '+' button
      const r = ref.current.getBoundingClientRect()
      setPos({ top: r.bottom + 6, left: r.left })
    }
    setOpen(!open)
  }

  return (
    <div className="ws-add" ref={ref}>
      <Tooltip label={t('newWorkspace')}>
        <button className="tbtn ws-plus" onClick={toggle}>
          <Plus size={14} />
        </button>
      </Tooltip>
      {open &&
        pos &&
        createPortal(
          <>
            <div className="click-catcher" onMouseDown={() => setOpen(false)} />
            <div className="ws-menu" ref={menuRef} style={{ top: pos.top, left: pos.left }}>
              {projects.map((p) => (
                <div className="ws-menu-row" key={p.id}>
                  <button
                    className="ws-menu-item"
                    onClick={() => {
                      createWorkspace(p.id, t('workspace'))
                      setOpen(false)
                    }}
                  >
                    {p.name}
                    <span className="ws-menu-path">{p.path}</span>
                  </button>
                  {repos[p.id] && (
                    <Tooltip label={t('newWorktree')}>
                      <button
                        className="ws-menu-wt"
                        onClick={() => {
                          setOpen(false)
                          onWorktree(p)
                        }}
                      >
                        <GitBranchPlus size={13} />
                      </button>
                    </Tooltip>
                  )}
                </div>
              ))}
              <button className="ws-menu-item accent" onClick={pickDirectory}>
                {t('addProjectItem')}
              </button>
            </div>
          </>,
          document.body
        )}
    </div>
  )
}

export default function WorkspaceStrip(): React.JSX.Element {
  const workspaces = useStore((s) => s.workspaces)
  const projects = useStore((s) => s.projects)
  const activeId = useStore((s) => s.activeWorkspaceId)
  const { activateWorkspace, closeWorkspace, renameWorkspace, moveWorkspace } = useStore()
  const [wtProject, setWtProject] = useState<Project | null>(null)

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
        addControl={<AddWorkspaceButton onWorktree={setWtProject} />}
      />
      {wtProject && <WorktreeModal project={wtProject} onClose={() => setWtProject(null)} />}
    </div>
  )
}
