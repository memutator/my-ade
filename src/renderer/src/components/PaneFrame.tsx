import type { ReactNode } from 'react'
import { useRef, useState } from 'react'
import {
  Columns2,
  Minus,
  MoreVertical,
  PictureInPicture,
  PictureInPicture2,
  Rows2,
  SquareArrowOutUpRight,
  Tag,
  X
} from 'lucide-react'
import type { PaneState } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import { startPaneDrag } from '../paneDnd'
import { isDetachedWin } from '../detached'
import { useFloatCtx } from './floatCtx'
import Tooltip from './Tooltip'
import { Dropdown } from './Menu'
import PaneToasts from './PaneToasts'

export default function PaneFrame({
  pane,
  wsId,
  icon,
  title,
  dragTitle,
  extraActions,
  children
}: {
  pane: PaneState
  wsId: string
  icon: ReactNode
  /** the titlebar slot — the leaf's tab strip lives here */
  title: ReactNode
  /** label for the pane-drag ghost chip (the active block's name) */
  dragTitle?: string
  extraActions?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const focused = useStore((s) => {
    const w = s.workspaces.find((x) => x.id === wsId)
    return s.activeWorkspaceId === wsId && w?.focusedPaneId === pane.id
  })
  const { focusPane, splitPane, closePane, minimizePane, floatPane, dockPane, detachPane } =
    useStore()
  const updatePane = useStore((s) => s.updatePane)
  const gripRef = useRef<HTMLSpanElement>(null)
  const floatCtx = useFloatCtx()
  const t = useT()
  // pane rename: ⋯ menu or double-clicking the titlebar chip turns it into an
  // input; an empty commit clears the name back to the 'pane N' fallback
  const [editingName, setEditingName] = useState(false)
  const commitName = (v: string): void => {
    setEditingName(false)
    const name = v.trim()
    if (name !== (pane.name ?? '')) updatePane(pane.id, { name: name || undefined }, wsId)
  }

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
              startPaneDrag(e, {
                paneId: pane.id,
                wsId,
                title: dragTitle ?? '',
                iconEl: gripRef.current,
                paneEl: gripRef.current?.closest('.pane') as HTMLElement | null
              })
            }}
          >
            {icon}
          </span>
        </Tooltip>
        {editingName ? (
          <input
            className="pane-name-input"
            autoFocus
            defaultValue={pane.name ?? ''}
            placeholder={t('paneN', { n: String(pane.num ?? 0) })}
            onBlur={(e) => commitName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName(e.currentTarget.value)
              else if (e.key === 'Escape') setEditingName(false)
            }}
          />
        ) : (
          pane.name && (
            <span
              className="pane-name"
              data-nodrag
              title={t('renamePane')}
              onDoubleClick={() => setEditingName(true)}
            >
              {pane.name}
            </span>
          )
        )}
        {title}
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
              <button className="pact-item" onClick={() => setEditingName(true)}>
                <Tag />
                {t('renamePane')}
              </button>
              <div className="pact-sep" />
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
                    onClick={() => splitPane(pane.id, 'row', 'term', wsId)}
                  >
                    <Columns2 />
                    {t('splitRight')}
                  </button>
                  <button
                    className="pact-item"
                    onClick={() => splitPane(pane.id, 'col', 'term', wsId)}
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
      <div className="pane-body">
        {children}
        <PaneToasts wsId={wsId} paneId={pane.id} activeTabId={pane.activeTabId} />
      </div>
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
