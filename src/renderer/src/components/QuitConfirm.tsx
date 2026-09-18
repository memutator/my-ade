import { useEffect, useState } from 'react'
import { Power, X } from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'
import type { Workspace } from '../types'

// non-exited terminal tabs across every workspace (detached panes included —
// their blocks live in the same records and die with the app)
const liveTerminals = (workspaces: Workspace[]): number =>
  workspaces.reduce(
    (n, w) =>
      n +
      Object.values(w.panes).reduce(
        (m, p) => m + p.tabs.filter((t) => t.kind === 'term' && !t.exited).length,
        0
      ),
    0
  )

// Quit guard: main forwards every main-window close here before honoring it.
// Nothing running → force-close straight through (zero friction); live
// terminals → one confirm. Covers the X button, Alt+F4, Cmd+Q, taskbar close.
export default function QuitConfirm(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const t = useT()
  const live = useStore((s) => liveTerminals(s.workspaces))

  useEffect(
    () =>
      window.mahas.win.onCloseRequest(() => {
        if (liveTerminals(useStore.getState().workspaces) === 0) {
          window.mahas.win.forceClose()
        } else {
          setOpen(true)
        }
      }),
    []
  )

  if (!open) return null
  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="resume-title">
            <Power size={14} />
            {t('quitTitle')}
          </span>
          <button className="pbtn" onClick={() => setOpen(false)}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <div className="resume-hint">{t('quitHint', { n: String(live) })}</div>
          <div className="resume-actions">
            <button className="sbtn" onClick={() => setOpen(false)}>
              {t('quitCancel')}
            </button>
            <button className="sbtn accent" onClick={() => window.mahas.win.forceClose()}>
              {t('quitConfirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
