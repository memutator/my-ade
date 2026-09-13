import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Columns2,
  Minus,
  MoreVertical,
  PictureInPicture,
  PictureInPicture2,
  Rows2,
  SquareArrowOutUpRight,
  X
} from 'lucide-react'
import type { PaneState } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import { startPaneDrag } from '../paneDnd'
import { isDetachedWin } from '../detached'
import { useFloatCtx } from './floatCtx'
import Tooltip from './Tooltip'

export default function PaneFrame({
  pane,
  wsId,
  icon,
  title,
  extraActions,
  children
}: {
  pane: PaneState
  wsId: string
  icon: ReactNode
  title?: ReactNode
  extraActions?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const focused = useStore((s) => {
    const w = s.workspaces.find((x) => x.id === wsId)
    return s.activeWorkspaceId === wsId && w?.focusedPaneId === pane.id
  })
  const { focusPane, splitPane, closePane, minimizePane, floatPane, dockPane, detachPane } =
    useStore()
  const gripRef = useRef<HTMLSpanElement>(null)
  const floatCtx = useFloatCtx()
  const t = useT()

  const floating = !!pane.floating
  // inside a detached window, pane-tree ops don't apply — closing routes back
  // to the main store via pane:cmd
  const detachedCtx = isDetachedWin

  return (
    <div
      className={`pane${focused ? ' focused' : ''}${floating ? ' in-float' : ''}`}
      data-pane-id={pane.id}
      data-ws-id={wsId}
      onPointerDownCapture={() => focusPane(pane.id, wsId)}
    >
      <div className="pane-titlebar" onPointerDown={floatCtx?.onTitlebarPointerDown}>
        <Tooltip label={t('dragToMove')}>
          <span
            ref={gripRef}
            className="pane-grip"
            onPointerDown={(e) => {
              if (detachedCtx) return
              startPaneDrag(e, {
                paneId: pane.id,
                wsId,
                title:
                  gripRef.current?.parentElement?.querySelector('.pane-title')?.textContent ??
                  pane.title,
                iconEl: gripRef.current,
                paneEl: gripRef.current?.closest('.pane') as HTMLElement | null
              })
            }}
          >
            {icon}
          </span>
        </Tooltip>
        {title ?? <span className="pane-title">{pane.title}</span>}
        <div className="actions">
          {extraActions}
          {detachedCtx ? (
            <Tooltip label={t('closePane')}>
              <button
                className="pbtn"
                onClick={() =>
                  window.ade.win.paneCmd({ action: 'closePane', wsId, paneId: pane.id })
                }
              >
                <X />
              </button>
            </Tooltip>
          ) : (
            /* all pane ops live behind one ⋯ so the tab strip keeps the room */
            <PactMenu label={t('paneMenu')}>
              <button
                className="pact-item"
                onClick={() => (floating ? dockPane(pane.id, wsId) : floatPane(pane.id, wsId))}
              >
                {floating ? <PictureInPicture /> : <PictureInPicture2 />}
                {t(floating ? 'dockPane' : 'floatPane')}
              </button>
              <button
                className="pact-item"
                onClick={() => {
                  window.ade.win.detach(wsId, pane.id, pane)
                  detachPane(pane.id, wsId)
                }}
              >
                <SquareArrowOutUpRight />
                {t('detachPane')}
              </button>
              {!floating && (
                <>
                  <button
                    className="pact-item"
                    onClick={() => splitPane(pane.id, 'row', 'terminal', wsId)}
                  >
                    <Columns2 />
                    {t('splitRight')}
                  </button>
                  <button
                    className="pact-item"
                    onClick={() => splitPane(pane.id, 'col', 'terminal', wsId)}
                  >
                    <Rows2 />
                    {t('splitDown')}
                  </button>
                </>
              )}
              <button className="pact-item" onClick={() => minimizePane(pane.id, wsId)}>
                <Minus />
                {t('minimizePane')}
              </button>
              <button className="pact-item danger" onClick={() => closePane(pane.id, wsId)}>
                <X />
                {t('closePane')}
              </button>
            </PactMenu>
          )}
        </div>
      </div>
      <div className="pane-body">{children}</div>
    </div>
  )
}

// One ⋯ trigger opens a fixed-position popover on hover — portal-mounted so a
// short pane's overflow:hidden can't clip it. A close-delay bridges the gap
// between the trigger and the floating card while the pointer crosses.
function PactMenu({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const closeT = useRef<ReturnType<typeof setTimeout> | null>(null)

  const openNow = (): void => {
    if (closeT.current) clearTimeout(closeT.current)
    closeT.current = null
    if (anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect()
      setPos({
        top: r.bottom + 5,
        left: Math.max(4, Math.min(r.right - 176, window.innerWidth - 184))
      })
    }
    setOpen(true)
  }
  const closeSoon = (): void => {
    if (closeT.current) clearTimeout(closeT.current)
    closeT.current = setTimeout(() => setOpen(false), 140)
  }

  return (
    <div className="pact" data-nodrag onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <div ref={anchorRef} className="pact-anchor">
        <Tooltip label={label}>
          <button className="pbtn">
            <MoreVertical />
          </button>
        </Tooltip>
      </div>
      {open &&
        pos &&
        createPortal(
          <div
            className="pact-card"
            style={{ top: pos.top, left: pos.left }}
            onMouseEnter={openNow}
            onMouseLeave={closeSoon}
            onClick={() => setOpen(false)}
          >
            {children}
          </div>,
          document.body
        )}
    </div>
  )
}
