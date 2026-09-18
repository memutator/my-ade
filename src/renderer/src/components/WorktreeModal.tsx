import { useEffect, useMemo, useState } from 'react'
import { GitBranch, GitBranchPlus, Trash2, X } from 'lucide-react'
import type { GitInfo, Project, WorktreeEntry } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import Tooltip from './Tooltip'

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

function WtLabel({ wt }: { wt: WorktreeEntry }): React.JSX.Element {
  return (
    <div className="wt-meta">
      <span className="wt-branch">
        <GitBranch size={11} />
        {wt.branch ?? wt.head.slice(0, 7)}
      </span>
      <span className="ws-menu-path">{wt.path}</span>
    </div>
  )
}

// Create-or-open git worktrees for a project. New worktrees land in
// `<repo>.worktrees/<branch-slug>` (see src/main/worktree.ts) and open as a
// project + workspace; existing ones can be opened or removed.
export default function WorktreeModal({
  project,
  onClose
}: {
  project: Project
  onClose: () => void
}): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const { addProject, createWorkspace, removeProject } = useStore()
  const [info, setInfo] = useState<GitInfo | null>(null)
  const [branch, setBranch] = useState('')
  const [base, setBase] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [forceFor, setForceFor] = useState<string | null>(null)
  const t = useT()

  const refresh = (): void => {
    void window.mahas.git.info(project.path).then((i) => {
      setInfo(i)
      setBase((b) => b || i.branch || '')
    })
  }

  useEffect(refresh, [project.path])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const slug = branch
    .trim()
    .replace(/[/\\\s]+/g, '-')
    .replace(/[^\w.-]/g, '')
  const dest = info?.wtRoot ? `${info.wtRoot}/${slug || '…'}` : ''

  const openWorkspace = (path: string, name: string): void => {
    const proj = addProject(path, name)
    createWorkspace(proj.id, name)
    onClose()
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    const r = await window.mahas.git.addWorktree(project.path, {
      branch: branch.trim(),
      base: base.trim() || undefined
    })
    setBusy(false)
    if (!r.ok || !r.path) {
      setErr(r.error ?? 'worktree failed')
      return
    }
    openWorkspace(r.path, r.branch ?? branch.trim())
  }

  const remove = async (wtPath: string): Promise<void> => {
    const force = forceFor === wtPath
    const r = await window.mahas.git.removeWorktree(project.path, wtPath, force)
    if (!r.ok) {
      setForceFor(wtPath)
      setErr(r.error ?? 'remove failed')
      return
    }
    setForceFor(null)
    setErr(null)
    // drop the mahas project that pointed at this worktree (and its workspaces)
    const proj = projects.find((p) => p.path === wtPath)
    if (proj) removeProject(proj.id)
    refresh()
  }

  const others = useMemo(() => (info?.worktrees ?? []).filter((w) => !w.main), [info])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="wt-title">
            <GitBranchPlus size={14} />
            {t('worktrees')} — {project.name}
          </span>
          <Tooltip label={t('close')}>
            <button className="pbtn" onClick={onClose}>
              <X />
            </button>
          </Tooltip>
        </div>
        <div className="modal-body">
          {!info ? (
            <div className="srow dim">{t('loading')}</div>
          ) : !info.isRepo ? (
            <div className="srow dim">{t('notARepo')}</div>
          ) : (
            <>
              <section>
                <h3>{t('createWorktree')}</h3>
                <div className="srow">
                  <label>{t('branch')}</label>
                  <input
                    className="sinput"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && branch.trim() && !busy) void create()
                    }}
                    placeholder="feat/…"
                    spellCheck={false}
                    autoFocus
                  />
                </div>
                <div className="srow">
                  <label>{t('baseRef')}</label>
                  <input
                    className="sinput"
                    value={base}
                    onChange={(e) => setBase(e.target.value)}
                    placeholder={info.branch ?? 'HEAD'}
                    list="wt-branches"
                    spellCheck={false}
                  />
                  <datalist id="wt-branches">
                    {(info.branches ?? []).map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                </div>
                <div className="srow dim wt-dest">
                  <label>{t('worktreeAt')}</label>
                  <span>{dest}</span>
                </div>
                {err && <div className="srow wt-err">{err}</div>}
                <div className="srow">
                  <label />
                  <button
                    className="sbtn accent"
                    disabled={!branch.trim() || busy}
                    onClick={() => void create()}
                  >
                    {t('createWorktree')}
                  </button>
                </div>
              </section>
              <section>
                <h3>{t('worktrees')}</h3>
                {others.length === 0 && <div className="srow dim">{t('noWorktrees')}</div>}
                {others.map((w) => (
                  <div className="srow wt-row" key={w.path}>
                    <WtLabel wt={w} />
                    <button
                      className="sbtn"
                      onClick={() => openWorkspace(w.path, w.branch ?? basename(w.path))}
                    >
                      {t('openWorkspaceHere')}
                    </button>
                    <Tooltip label={forceFor === w.path ? t('forceRemove') : t('removeWorktree')}>
                      <button
                        className={`sbtn wt-rm${forceFor === w.path ? ' danger' : ''}`}
                        onClick={() => void remove(w.path)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </Tooltip>
                  </div>
                ))}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
