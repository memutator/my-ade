import { useRef, type ReactNode } from 'react'
import { Columns2, Rows2, X } from 'lucide-react'
import type { PaneState } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import { startPaneDrag } from '../paneDnd'
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
  const { focusPane, splitPane, closePane } = useStore()
  const gripRef = useRef<HTMLSpanElement>(null)
  const t = useT()

  return (
    <div
      className={`pane${focused ? ' focused' : ''}`}
      data-pane-id={pane.id}
      data-ws-id={wsId}
      onPointerDownCapture={() => focusPane(pane.id, wsId)}
    >
      <div className="pane-titlebar">
        <Tooltip label={t('dragToMove')}>
          <span
            ref={gripRef}
            className="pane-grip"
            onPointerDown={(e) =>
              startPaneDrag(e, {
                paneId: pane.id,
                wsId,
                title:
                  gripRef.current?.parentElement?.querySelector('.pane-title')?.textContent ??
                  pane.title,
                iconEl: gripRef.current,
                paneEl: gripRef.current?.closest('.pane') as HTMLElement | null
              })
            }
          >
            {icon}
          </span>
        </Tooltip>
        {title ?? <span className="pane-title">{pane.title}</span>}
        <div className="actions">
          {extraActions}
          <Tooltip label={t('splitRight')}>
            <button className="pbtn" onClick={() => splitPane(pane.id, 'row', 'terminal', wsId)}>
              <Columns2 />
            </button>
          </Tooltip>
          <Tooltip label={t('splitDown')}>
            <button className="pbtn" onClick={() => splitPane(pane.id, 'col', 'terminal', wsId)}>
              <Rows2 />
            </button>
          </Tooltip>
          <Tooltip label={t('closePane')}>
            <button className="pbtn" onClick={() => closePane(pane.id, wsId)}>
              <X />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="pane-body">{children}</div>
    </div>
  )
}
