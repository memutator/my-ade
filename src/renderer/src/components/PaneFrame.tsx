import { useRef, type ReactNode } from 'react'
import {
  Columns2,
  Minus,
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
          {!detachedCtx && (
            <>
              {floating ? (
                <Tooltip label={t('dockPane')}>
                  <button className="pbtn" onClick={() => dockPane(pane.id, wsId)}>
                    <PictureInPicture />
                  </button>
                </Tooltip>
              ) : (
                <Tooltip label={t('floatPane')}>
                  <button className="pbtn" onClick={() => floatPane(pane.id, wsId)}>
                    <PictureInPicture2 />
                  </button>
                </Tooltip>
              )}
              <Tooltip label={t('detachPane')}>
                <button
                  className="pbtn"
                  onClick={() => {
                    window.ade.win.detach(wsId, pane.id, pane)
                    detachPane(pane.id, wsId)
                  }}
                >
                  <SquareArrowOutUpRight />
                </button>
              </Tooltip>
              {!floating && (
                <>
                  <Tooltip label={t('splitRight')}>
                    <button
                      className="pbtn"
                      onClick={() => splitPane(pane.id, 'row', 'terminal', wsId)}
                    >
                      <Columns2 />
                    </button>
                  </Tooltip>
                  <Tooltip label={t('splitDown')}>
                    <button
                      className="pbtn"
                      onClick={() => splitPane(pane.id, 'col', 'terminal', wsId)}
                    >
                      <Rows2 />
                    </button>
                  </Tooltip>
                </>
              )}
              <Tooltip label={t('minimizePane')}>
                <button className="pbtn" onClick={() => minimizePane(pane.id, wsId)}>
                  <Minus />
                </button>
              </Tooltip>
            </>
          )}
          <Tooltip label={t('closePane')}>
            <button
              className="pbtn"
              onClick={() =>
                detachedCtx
                  ? window.ade.win.paneCmd({ action: 'closePane', wsId, paneId: pane.id })
                  : closePane(pane.id, wsId)
              }
            >
              <X />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="pane-body">{children}</div>
    </div>
  )
}
