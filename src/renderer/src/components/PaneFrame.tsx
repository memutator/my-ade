import type { ReactNode } from 'react'
import { Columns2, Rows2, X } from 'lucide-react'
import type { PaneState } from '../types'
import { useStore } from '../store'

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

  return (
    <div
      className={`pane${focused ? ' focused' : ''}`}
      onPointerDownCapture={() => focusPane(pane.id, wsId)}
    >
      <div className="pane-titlebar">
        {icon}
        {title ?? <span className="pane-title">{pane.title}</span>}
        <div className="actions">
          {extraActions}
          <button
            className="pbtn"
            title="Split right (Alt+D)"
            onClick={() => splitPane(pane.id, 'row', 'terminal', wsId)}
          >
            <Columns2 />
          </button>
          <button
            className="pbtn"
            title="Split down (Alt+S)"
            onClick={() => splitPane(pane.id, 'col', 'terminal', wsId)}
          >
            <Rows2 />
          </button>
          <button className="pbtn" title="Close (Alt+W)" onClick={() => closePane(pane.id, wsId)}>
            <X />
          </button>
        </div>
      </div>
      <div className="pane-body">{children}</div>
    </div>
  )
}
