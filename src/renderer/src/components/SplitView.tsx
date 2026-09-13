import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LayoutNode } from '../types'
import { useStore, visibleLeafIds } from '../store'
import { registerPaneSlot, usePaneSlot } from '../paneSlots'
import { FloatCtx } from './floatCtx'
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

// Every pane record gets exactly one mounted PaneFor per workspace. The pane
// renders into a mount node it owns forever — the portal container never
// changes (a changed container would remount the whole subtree), the NODE is
// moved between layout slots (split leaf / float overlay) with appendChild
// instead. Result: splitting, closing, swapping, floating or docking panes
// reparents live DOM without unmounting — xterm, webview and editor state
// all survive. A pane with no slot (e.g. a minimized float) sits in a hidden
// stash div and keeps running.
export function PanePortals({ wsId }: { wsId: string }): React.JSX.Element {
  const panes = useStore((s) => s.workspaces.find((x) => x.id === wsId)?.panes)
  return (
    <>
      {Object.values(panes ?? {})
        .filter((p) => !p.detached)
        .map((p) => (
          <PanePortal key={p.id} wsId={wsId} paneId={p.id} />
        ))}
    </>
  )
}

function PanePortal({ wsId, paneId }: { wsId: string; paneId: string }): React.JSX.Element {
  const slot = usePaneSlot(paneId)
  const [stash, setStash] = useState<HTMLDivElement | null>(null)
  const [mount] = useState(() => {
    const el = document.createElement('div')
    el.className = 'pane-mount'
    return el
  })

  const parent = slot?.el ?? stash
  useLayoutEffect(() => {
    if (!parent) return
    parent.appendChild(mount)
    return () => {
      if (mount.parentNode === parent) parent.removeChild(mount)
    }
  }, [parent, mount])

  return (
    <>
      <div ref={setStash} className="pane-stash" hidden />
      {createPortal(
        <FloatCtx.Provider value={slot?.floatCtx ?? null}>
          <PaneFor paneId={paneId} wsId={wsId} />
        </FloatCtx.Provider>,
        mount,
        paneId
      )}
    </>
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

  // A leaf is just a slot: PanePortals owns the actual pane content and
  // portals it in. Registering the div (with an identity-guarded cleanup) is
  // what lets a pane survive splits/collapses — the slot moves, the mounted
  // component doesn't.
  const leafPaneId = node.kind === 'leaf' ? node.paneId : null
  const setLeafRef = useCallback(
    (el: HTMLDivElement | null) => {
      ref.current = el
      if (!el || !leafPaneId) return
      const unregister = registerPaneSlot(leafPaneId, el)
      return () => {
        ref.current = null
        unregister()
      }
    },
    [leafPaneId]
  )

  // Minimized panes keep their leaf in the tree — the subtree renders hidden
  // (display:none, still MOUNTED, so terminals/webviews keep running) and the
  // visible sibling's flex share fills the freed space. Restore = clearing the
  // flag, which pops the pane back into its exact slot.
  // Detached panes also keep the leaf (reattach lands on the same slot) but
  // stay empty — the detached window owns the content; its terminal session
  // survives via pty `attach` on the tab's session id.
  if (node.kind === 'leaf') {
    const p = panes?.[node.paneId]
    return <div className="node leaf" ref={setLeafRef} hidden={!!p?.minimized || !!p?.detached} />
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
