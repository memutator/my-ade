import { useCallback, useRef, useState } from 'react'
import type { LayoutNode } from '../types'
import { useStore, visibleLeafIds } from '../store'
import TerminalPane from './TerminalPane'
import BrowserPane from './BrowserPane'
import EditorPane from './EditorPane'
import TodoPane from './TodoPane'

export function PaneFor({
  paneId,
  wsId
}: {
  paneId: string
  wsId: string
}): React.JSX.Element | null {
  const pane = useStore((s) => {
    const w = s.workspaces.find((x) => x.id === wsId)
    return w?.panes[paneId]
  })
  const projectPath = useStore((s) => {
    const w = s.workspaces.find((x) => x.id === wsId)
    return s.projects.find((p) => p.id === w?.projectId)?.path
  })
  if (!pane) return null
  switch (pane.type) {
    case 'terminal':
      return <TerminalPane pane={pane} wsId={wsId} projectPath={projectPath} />
    case 'browser':
      return <BrowserPane pane={pane} wsId={wsId} />
    case 'editor':
      return <EditorPane pane={pane} wsId={wsId} />
    case 'todo':
      return <TodoPane pane={pane} wsId={wsId} />
  }
}

function Divider({
  splitId,
  dir,
  wsId,
  containerRef,
  hidden
}: {
  splitId: string
  dir: 'row' | 'col'
  wsId: string
  containerRef: React.RefObject<HTMLDivElement | null>
  hidden?: boolean
}): React.JSX.Element {
  const setRatio = useStore((s) => s.setRatio)
  const [dragging, setDragging] = useState(false)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const el = e.currentTarget
      el.setPointerCapture(e.pointerId)
      setDragging(true)

      const onMove = (e: Event): void => {
        const ev = e as PointerEvent
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return
        const ratio =
          dir === 'row'
            ? (ev.clientX - rect.left) / rect.width
            : (ev.clientY - rect.top) / rect.height
        setRatio(splitId, ratio, wsId)
      }
      const onUp = (): void => {
        setDragging(false)
        el.removeEventListener('pointermove', onMove)
        el.removeEventListener('pointerup', onUp)
      }
      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerup', onUp)
    },
    [dir, splitId, setRatio, containerRef, wsId]
  )

  return (
    <div
      className={`divider${dragging ? ' dragging' : ''}`}
      onPointerDown={onPointerDown}
      hidden={hidden}
    />
  )
}

export default function SplitView({
  node,
  wsId
}: {
  node: LayoutNode
  wsId: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const panes = useStore((s) => s.workspaces.find((x) => x.id === wsId)?.panes)

  // Minimized panes keep their leaf in the tree — the subtree renders hidden
  // (display:none, still MOUNTED, so terminals/webviews keep running) and the
  // visible sibling's flex share fills the freed space. Restore = clearing the
  // flag, which pops the pane back into its exact slot.
  // Detached panes also keep the leaf (reattach lands on the same slot) but
  // their content UNMOUNTS here — the detached window owns it, and its
  // terminal session survives via pty `attach` on the tab's session id.
  if (node.kind === 'leaf') {
    const p = panes?.[node.paneId]
    return (
      <div className="node leaf" ref={ref} hidden={!!p?.minimized || !!p?.detached}>
        {!p?.detached && <PaneFor paneId={node.paneId} wsId={wsId} />}
      </div>
    )
  }

  const aMin = !panes || visibleLeafIds(node.a, panes).length === 0
  const bMin = !panes || visibleLeafIds(node.b, panes).length === 0

  // flex-grow sums < 1 do NOT normalize — a hidden side leaves only a fraction
  // of its space to the sibling (0.5 grow ⇒ 0.5 × free space, rest stranded).
  // The sole visible child must take flex:1 to fill it.
  const aFlex = aMin ? 0 : bMin ? 1 : node.ratio
  const bFlex = bMin ? 0 : aMin ? 1 : 1 - node.ratio

  return (
    <div className={`node split ${node.dir}`} ref={ref}>
      <div className="split-child" style={{ flex: aFlex }} hidden={aMin}>
        <SplitView node={node.a} wsId={wsId} />
      </div>
      <Divider
        splitId={node.id}
        dir={node.dir}
        wsId={wsId}
        containerRef={ref}
        hidden={aMin || bMin}
      />
      <div className="split-child" style={{ flex: bFlex }} hidden={bMin}>
        <SplitView node={node.b} wsId={wsId} />
      </div>
    </div>
  )
}
