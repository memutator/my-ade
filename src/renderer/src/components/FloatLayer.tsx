import { useCallback } from 'react'
import type { PaneState } from '../types'
import { useStore } from '../store'
import { PaneFor } from './SplitView'
import { FloatCtx } from './floatCtx'

// Floating panes render as an overlay inside .ws-host (positioned in
// fractions of the workspace area). Move by dragging the pane titlebar's
// empty space; resize via the edge/corner handles; the pane grip still
// docks via the normal pane drag & drop (startPaneDrag).

const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

function FloatPane({ pane, wsId }: { pane: PaneState; wsId: string }): React.JSX.Element {
  const setFloatRect = useStore((s) => s.setFloatRect)
  const focusPane = useStore((s) => s.focusPane)
  const f = pane.floating!

  // A move/resize gesture computes fractions against the workspace rect at
  // drag start. `body.float-active` (+ a cursor class) disables webview
  // pointer events so the pointer stream reaches the window even when it
  // crosses a <webview>.
  const begin = useCallback(
    (
      e: React.PointerEvent,
      cursorCls: string,
      apply: (rect: typeof f, dx: number, dy: number) => typeof f
    ): void => {
      if (e.button !== 0) return
      e.preventDefault()
      const host = (e.currentTarget as HTMLElement).closest('.ws-host') as HTMLElement | null
      const wsRect = host?.getBoundingClientRect()
      if (!wsRect?.width || !wsRect.height) return
      const startRect = { ...f }
      const sx = e.clientX
      const sy = e.clientY
      document.body.classList.add('float-active', cursorCls)
      const onMove = (ev: PointerEvent): void => {
        const dx = (ev.clientX - sx) / wsRect.width
        const dy = (ev.clientY - sy) / wsRect.height
        setFloatRect(pane.id, apply(startRect, dx, dy), wsId)
      }
      const onUp = (): void => {
        document.body.classList.remove('float-active', cursorCls)
        window.removeEventListener('pointermove', onMove)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp, { once: true })
    },
    [f, pane.id, setFloatRect, wsId]
  )

  const onTitlebarPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const t = e.target as HTMLElement
      // interactive children keep their own gestures (buttons, tabs, grip dnd)
      if (t.closest('button, input, a, .ctab, .pane-grip, [data-nodrag]')) return
      begin(e, 'float-moving', (r, dx, dy) => ({ ...r, x: r.x + dx, y: r.y + dy }))
    },
    [begin]
  )

  const startResize = useCallback(
    (dir: string) => (e: React.PointerEvent) => {
      begin(e, `rz-${dir}`, (r, dx, dy) => {
        let { x, y, w, h } = r
        if (dir.includes('e')) w = r.w + dx
        if (dir.includes('s')) h = r.h + dy
        if (dir.includes('w')) {
          x = r.x + dx
          w = r.w - dx
        }
        if (dir.includes('n')) {
          y = r.y + dy
          h = r.h - dy
        }
        return { ...r, x, y, w, h }
      })
    },
    [begin]
  )

  return (
    <div
      className="float-pane"
      data-pane-id={pane.id}
      style={{
        left: `${f.x * 100}%`,
        top: `${f.y * 100}%`,
        width: `${f.w * 100}%`,
        height: `${f.h * 100}%`,
        zIndex: 10 + f.z
      }}
      onPointerDownCapture={() => focusPane(pane.id, wsId)}
    >
      <div className="float-inner">
        <FloatBody paneId={pane.id} wsId={wsId} onTitlebarPointerDown={onTitlebarPointerDown} />
      </div>
      {RESIZE_DIRS.map((dir) => (
        <div key={dir} className={`fp-rz ${dir}`} onPointerDown={startResize(dir)} />
      ))}
    </div>
  )
}

// PaneFor needs the titlebar-drag handler threaded into PaneFrame — kept as
// a thin context wrapper so FloatPane stays readable.
function FloatBody({
  paneId,
  wsId,
  onTitlebarPointerDown
}: {
  paneId: string
  wsId: string
  onTitlebarPointerDown: (e: React.PointerEvent) => void
}): React.JSX.Element | null {
  return (
    <FloatCtx.Provider value={{ onTitlebarPointerDown }}>
      <PaneFor paneId={paneId} wsId={wsId} />
    </FloatCtx.Provider>
  )
}

export default function FloatLayer({ wsId }: { wsId: string }): React.JSX.Element | null {
  // subscribe to the stable panes record, not a derived array — a selector
  // returning a fresh array every call loops useSyncExternalStore forever
  const panes = useStore((s) => s.workspaces.find((x) => x.id === wsId)?.panes)
  const floats = Object.values(panes ?? {}).filter((p) => p.floating && !p.minimized && !p.detached)
  if (floats.length === 0) return null
  return (
    <div className="float-layer">
      {floats.map((p) => (
        <FloatPane key={p.id} pane={p} wsId={wsId} />
      ))}
    </div>
  )
}
