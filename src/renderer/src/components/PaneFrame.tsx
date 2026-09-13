import { useEffect, useRef, useState, type ReactNode } from 'react'
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
import { Dropdown, Popup } from './Menu'

export default function PaneFrame({
  pane,
  wsId,
  icon,
  title,
  extraActions,
  gripPeek,
  children
}: {
  pane: PaneState
  wsId: string
  icon: ReactNode
  title?: ReactNode
  extraActions?: ReactNode
  /** grip icon dwell-peek content (editor: tree overlay) — rendered in a
      portaled card under the icon, same in docked/floating/detached */
  gripPeek?: ReactNode
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

  // ── grip icon: hover → dwell-peek card, hold → drag ──
  // the peek opens on a 350ms dwell; a 150ms leave-delay bridges the pointer
  // gap into the card. peek-capable icons show no tooltip — the card is the
  // affordance (and they'd overlap)
  const [peekRect, setPeekRect] = useState<DOMRect | null>(null)
  const openT = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeT = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearT = (r: typeof openT): void => {
    if (r.current) {
      clearTimeout(r.current)
      r.current = null
    }
  }
  const gripEnter = (): void => {
    if (!gripPeek) return
    clearT(closeT)
    clearT(openT)
    openT.current = setTimeout(
      () => setPeekRect(gripRef.current?.getBoundingClientRect() ?? null),
      350
    )
  }
  const gripLeave = (): void => {
    clearT(openT)
    if (!peekRect) return
    clearT(closeT)
    closeT.current = setTimeout(() => setPeekRect(null), 150)
  }
  useEffect(
    () => () => {
      clearT(openT)
      clearT(closeT)
    },
    []
  )

  return (
    <div
      className={`pane${focused ? ' focused' : ''}${floating ? ' in-float' : ''}`}
      data-pane-id={pane.id}
      data-ws-id={wsId}
      onPointerDownCapture={() => focusPane(pane.id, wsId)}
    >
      <div className="pane-titlebar" onPointerDown={floatCtx?.onTitlebarPointerDown}>
        <Tooltip label={gripPeek ? undefined : t('dragToMove')}>
          <span
            ref={gripRef}
            className="pane-grip"
            onMouseEnter={gripEnter}
            onMouseLeave={gripLeave}
            onPointerDown={(e) => {
              startPaneDrag(e, {
                paneId: pane.id,
                wsId,
                title:
                  gripRef.current?.parentElement?.querySelector('.pane-title')?.textContent ??
                  pane.title,
                iconEl: gripRef.current,
                paneEl: gripRef.current?.closest('.pane') as HTMLElement | null,
                onArm: () => setPeekRect(null)
              })
            }}
          >
            {icon}
          </span>
        </Tooltip>
        {peekRect && gripPeek && (
          <Popup
            pos={{ left: peekRect.left, top: peekRect.bottom + 5 }}
            onClose={() => setPeekRect(null)}
            insideRef={gripRef}
            className="tree-overlay pane-peek"
            onMouseEnter={() => clearT(closeT)}
            onMouseLeave={() => setPeekRect(null)}
          >
            {gripPeek}
          </Popup>
        )}
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

// One ⋯ trigger opens a hover Dropdown — portal-mounted so a short pane's
// overflow:hidden can't clip it; right-aligned to the trigger like before.
function PactMenu({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <span className="pact" data-nodrag>
      <Dropdown
        mode="hover"
        align="end"
        panelClassName="pact-card"
        trigger={
          <Tooltip label={label}>
            <button className="pbtn">
              <MoreVertical />
            </button>
          </Tooltip>
        }
      >
        {children}
      </Dropdown>
    </span>
  )
}
