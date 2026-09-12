import { useCallback, useRef, useState } from 'react'
import type { LayoutNode } from '../types'
import { useStore } from '../store'
import TerminalPane from './TerminalPane'
import BrowserPane from './BrowserPane'
import EditorPane from './EditorPane'

function PaneFor({ paneId, wsId }: { paneId: string; wsId: string }): React.JSX.Element | null {
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
  }
}

function Divider({
  splitId,
  dir,
  wsId,
  containerRef
}: {
  splitId: string
  dir: 'row' | 'col'
  wsId: string
  containerRef: React.RefObject<HTMLDivElement | null>
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

  return <div className={`divider${dragging ? ' dragging' : ''}`} onPointerDown={onPointerDown} />
}

export default function SplitView({
  node,
  wsId
}: {
  node: LayoutNode
  wsId: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  if (node.kind === 'leaf') {
    return (
      <div className="node leaf" ref={ref}>
        <PaneFor paneId={node.paneId} wsId={wsId} />
      </div>
    )
  }

  return (
    <div className={`node split ${node.dir}`} ref={ref}>
      <div className="split-child" style={{ flex: node.ratio }}>
        <SplitView node={node.a} wsId={wsId} />
      </div>
      <Divider splitId={node.id} dir={node.dir} wsId={wsId} containerRef={ref} />
      <div className="split-child" style={{ flex: 1 - node.ratio }}>
        <SplitView node={node.b} wsId={wsId} />
      </div>
    </div>
  )
}
