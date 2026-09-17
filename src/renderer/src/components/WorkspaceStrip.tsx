import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GitBranchPlus, Plus, Trash2, X } from 'lucide-react'
import type { Project, Workspace } from '../types'
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
  const { createWorkspace, addProject, removeProject } = useStore()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [repos, setRepos] = useState<Record<string, boolean>>({})
  // delete is two-click (arm → confirm) — removing a project drops all its
  // workspaces, so a single stray click must not be destructive
  const [armDel, setArmDel] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const t = useT()

  // every close path clears an armed delete — a menu that reopened with a
  // still-armed trash would be one stray click away from deleting a project
  const close = (): void => {
    setOpen(false)
    setArmDel(null)
  }

  // the menu is portaled to <body> (the strip's overflow-y:clip would hide an
  // in-place absolute menu), so "inside" for outside-close purposes is the
  // '+' wrap OR the portaled menu
  useEffect(() => {
    if (!open) return
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      (ref.current?.contains(target) === true || menuRef.current?.contains(target) === true)
    const onDown = (e: MouseEvent): void => {
      if (!inside(e.target)) close()
    }
    // webview clicks never reach this document — catch the focus theft instead
    // (webview focus produces no focusin, only a capture-phase focus event)
    const onFocus = (e: FocusEvent): void => {
      if (!inside(e.target)) close()
    }
    // a fixed menu can't follow its anchor — close if the strip scrolls or the
    // window resizes (a scroll originating inside the menu itself is exempt)
    const onMove = (e: Event): void => {
      if (!inside(e.target)) close()
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
    close()
  }

  const toggle = (): void => {
    if (!open && ref.current) {
      // measure the anchor when the menu opens — the portaled menu is
      // position:fixed just below the '+' button
      const r = ref.current.getBoundingClientRect()
      setPos({ top: r.bottom + 6, left: r.left })
      setOpen(true)
    } else {
      close()
    }
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
            <div className="click-catcher" onMouseDown={close} />
            <div className="ws-menu" ref={menuRef} style={{ top: pos.top, left: pos.left }}>
              {projects.map((p) => (
                <div className="ws-menu-row" key={p.id}>
                  <button
                    className="ws-menu-item"
                    onClick={() => {
                      createWorkspace(p.id, t('workspace'))
                      close()
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
                          close()
                          onWorktree(p)
                        }}
                      >
                        <GitBranchPlus size={13} />
                      </button>
                    </Tooltip>
                  )}
                  <Tooltip label={armDel === p.id ? t('removeProjectConfirm') : t('removeProject')}>
                    <button
                      className={`ws-menu-wt ws-menu-del${armDel === p.id ? ' armed' : ''}`}
                      onClick={() => {
                        if (armDel === p.id) {
                          removeProject(p.id)
                          setArmDel(null)
                        } else {
                          setArmDel(p.id)
                        }
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </Tooltip>
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
  const notifications = useStore((s) => s.notifications)
  const { activateWorkspace, closeWorkspace, renameWorkspace, moveWorkspace } = useStore()
  const [wtProject, setWtProject] = useState<Project | null>(null)
  // workspace close guard: live agent processes die with the workspace, so a
  // stray X click can't take a running turn down silently
  const [confirmClose, setConfirmClose] = useState<string | null>(null)
  const t = useT()

  const agentCount = (w: Workspace): number =>
    Object.values(w.panes).reduce(
      (n, p) => n + p.tabs.filter((x) => x.kind === 'term' && x.agent).length,
      0
    )
  const onCloseWs = (id: string): void => {
    const w = workspaces.find((x) => x.id === id)
    if (w && agentCount(w) > 0) setConfirmClose(id)
    else closeWorkspace(id)
  }
  const closingWs = confirmClose ? workspaces.find((w) => w.id === confirmClose) : undefined

  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? '?'

  // unread notifications badge the workspace tab — the ambient-level
  // discovery path while the app is focused (no OS banner needed then)
  const unreadWs = new Set(notifications.filter((n) => !n.read).map((n) => n.workspaceId))

  const tabs: TabItem[] = workspaces.map((w) => ({
    id: w.id,
    label: w.name,
    sub: projectName(w.projectId),
    status: unreadWs.has(w.id) ? 'news' : undefined,
    dotTip: t('wsUnread')
  }))

  return (
    <div className="ws-strip">
      <TabStrip
        tabs={tabs}
        activeId={activeId}
        onActivate={activateWorkspace}
        onClose={onCloseWs}
        onRename={renameWorkspace}
        onReorder={moveWorkspace}
        addControl={<AddWorkspaceButton onWorktree={setWtProject} />}
      />
      {wtProject && <WorktreeModal project={wtProject} onClose={() => setWtProject(null)} />}
      {closingWs && (
        <div className="modal-overlay" onClick={() => setConfirmClose(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="resume-title">
                <X size={14} />
                {t('wsCloseTitle')}
              </span>
              <button className="pbtn" onClick={() => setConfirmClose(null)}>
                <X size={14} />
              </button>
            </div>
            <div className="modal-body">
              <div className="resume-hint">
                {t('wsCloseHint', { n: String(agentCount(closingWs)) })}
              </div>
              <div className="resume-actions">
                <button className="sbtn" onClick={() => setConfirmClose(null)}>
                  {t('quitCancel')}
                </button>
                <button
                  className="sbtn accent"
                  onClick={() => {
                    closeWorkspace(closingWs.id)
                    setConfirmClose(null)
                  }}
                >
                  {t('wsCloseConfirm')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
