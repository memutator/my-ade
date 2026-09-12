import type { PointerEvent as ReactPointerEvent } from 'react'
import type { DropEdge } from './types'
import { useStore } from './store'

export type { DropEdge }

type DropTarget =
  | { kind: 'pane'; wsId: string; paneId: string; edge: DropEdge | null }
  | { kind: 'ws'; wsId: string }

export interface PaneDragInfo {
  paneId: string
  wsId: string
  /** label shown in the ghost chip */
  title: string
  /** grip element — its .picon child is cloned into the ghost */
  iconEl: HTMLElement | null
  /** the .pane being dragged (dimmed while dragging) */
  paneEl: HTMLElement | null
}

const HOLD_MS = 180 // press-and-hold before the drag arms
const CANCEL_PX = 6 // moving this far before the hold elapses cancels
const EDGE_ZONE = 0.25 // outer quarter of a pane = split zone
const TAB_HOVER_MS = 400 // hovering a workspace tab this long activates it

let dragging = false

// Which quarter of the pane rect is the pointer in? Center → null (swap).
function edgeAt(r: DOMRect, x: number, y: number): DropEdge | null {
  const rx = (x - r.left) / r.width
  const ry = (y - r.top) / r.height
  const d = Math.min(rx, 1 - rx, ry, 1 - ry)
  if (d > EDGE_ZONE) return null
  if (d === rx) return 'left'
  if (d === 1 - rx) return 'right'
  if (d === ry) return 'top'
  return 'bottom'
}

/**
 * Pointer-based pane drag & drop (NOT HTML5 DnD — dragstart can't cross
 * <webview> and gives no control over the ghost). Call from the titlebar
 * grip's onPointerDown; installs window-level pointermove/pointerup/keydown
 * listeners until the gesture ends or is cancelled.
 *
 * Once armed, `body.pane-dragging` disables pointer-events on every <webview>
 * (they swallow all mouse events otherwise) so hit-testing via
 * document.elementFromPoint keeps working.
 */
export function startPaneDrag(e: ReactPointerEvent, info: PaneDragInfo): void {
  if (e.button !== 0 || e.isPrimary === false || dragging) return
  dragging = true

  // pointer capture keeps move/up events flowing off-window and retargets
  // them to the grip so a <webview> can't swallow the pending phase either
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* pointer already gone */
  }

  const startX = e.clientX
  const startY = e.clientY
  let lastX = startX
  let lastY = startY
  let armed = false
  let done = false

  let ghost: HTMLElement | null = null
  let indicator: HTMLElement | null = null
  let curTarget: DropTarget | null = null
  let curTabEl: Element | null = null
  let tabTimer: ReturnType<typeof setTimeout> | null = null

  const clearTabTimer = (): void => {
    if (tabTimer) {
      clearTimeout(tabTimer)
      tabTimer = null
    }
  }

  const moveGhost = (x: number, y: number): void => {
    if (ghost) ghost.style.transform = `translate(${x + 12}px, ${y + 14}px)`
  }

  // Recompute the drop target under the pointer and update highlights.
  const updateTarget = (x: number, y: number): void => {
    const hit = document.elementFromPoint(x, y)
    let target: DropTarget | null = null
    let tabEl: Element | null = null
    let rect: { left: number; top: number; width: number; height: number } | null = null
    let indClass = ''

    const tab = hit?.closest('.ws-strip .ctab') ?? null
    if (tab instanceof HTMLElement && tab.dataset.tabId) {
      target = { kind: 'ws', wsId: tab.dataset.tabId }
      tabEl = tab
    } else {
      const paneEl = hit?.closest('.pane') ?? null
      if (paneEl instanceof HTMLElement) {
        const pid = paneEl.dataset.paneId
        const wid = paneEl.dataset.wsId
        // releasing back onto the dragged pane itself = cancel, not a drop
        if (pid && wid && pid !== info.paneId) {
          const r = paneEl.getBoundingClientRect()
          const edge = edgeAt(r, x, y)
          target = { kind: 'pane', wsId: wid, paneId: pid, edge }
          rect = { left: r.left, top: r.top, width: r.width, height: r.height }
          if (edge === 'left') {
            rect.width = r.width / 2
            indClass = 'edge-left'
          } else if (edge === 'right') {
            rect.left = r.left + r.width / 2
            rect.width = r.width / 2
            indClass = 'edge-right'
          } else if (edge === 'top') {
            rect.height = r.height / 2
            indClass = 'edge-top'
          } else if (edge === 'bottom') {
            rect.top = r.top + r.height / 2
            rect.height = r.height / 2
            indClass = 'edge-bottom'
          } else {
            indClass = 'swap'
          }
        }
      } else {
        // workspace background / empty state → append to that workspace
        const host = hit?.closest('.ws-host:not([hidden])') ?? null
        if (host instanceof HTMLElement && host.dataset.wsId) {
          target = { kind: 'ws', wsId: host.dataset.wsId }
          const r = host.getBoundingClientRect()
          rect = { left: r.left, top: r.top, width: r.width, height: r.height }
          indClass = 'ws'
        }
      }
    }

    curTarget = target

    // workspace-tab highlight + delayed activation (drop into another ws)
    if (tabEl !== curTabEl) {
      curTabEl?.classList.remove('drop-target')
      curTabEl = tabEl
      curTabEl?.classList.add('drop-target')
      clearTabTimer()
      if (tabEl && target?.kind === 'ws') {
        const wsId = target.wsId
        tabTimer = setTimeout(() => {
          const st = useStore.getState()
          if (st.activeWorkspaceId !== wsId) st.activateWorkspace(wsId)
        }, TAB_HOVER_MS)
      }
    }

    if (indicator) {
      if (rect) {
        indicator.style.display = 'block'
        indicator.className = `drop-indicator ${indClass}`
        indicator.style.left = `${rect.left}px`
        indicator.style.top = `${rect.top}px`
        indicator.style.width = `${rect.width}px`
        indicator.style.height = `${rect.height}px`
      } else {
        indicator.style.display = 'none'
      }
    }
  }

  const arm = (): void => {
    armed = true
    document.body.classList.add('pane-dragging')
    info.paneEl?.classList.add('drag-src')

    ghost = document.createElement('div')
    ghost.className = 'drag-ghost'
    const icon = info.iconEl?.querySelector('.picon') ?? info.iconEl
    if (icon) ghost.appendChild(icon.cloneNode(true))
    const label = document.createElement('span')
    label.className = 'drag-ghost-title'
    label.textContent = info.title
    ghost.appendChild(label)
    document.body.appendChild(ghost)

    indicator = document.createElement('div')
    indicator.className = 'drop-indicator'
    indicator.style.display = 'none'
    document.body.appendChild(indicator)

    moveGhost(lastX, lastY)
    updateTarget(lastX, lastY)
  }

  const cleanup = (): void => {
    if (done) return
    done = true
    dragging = false
    clearTimeout(holdTimer)
    clearTabTimer()
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onCancel, true)
    window.removeEventListener('lostpointercapture', onCancel, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', onCancel)
    document.body.classList.remove('pane-dragging')
    info.paneEl?.classList.remove('drag-src')
    curTabEl?.classList.remove('drop-target')
    ghost?.remove()
    indicator?.remove()
  }

  const commit = (): void => {
    const t = curTarget
    if (!t) return
    const st = useStore.getState()
    if (t.kind === 'ws') {
      st.movePane(info.paneId, info.wsId, t.wsId, null, null)
    } else {
      st.movePane(info.paneId, info.wsId, t.wsId, t.paneId, t.edge)
    }
  }

  const onMove = (ev: PointerEvent): void => {
    lastX = ev.clientX
    lastY = ev.clientY
    if (!armed) {
      // a release over a <webview> never reaches us — buttons===0 means the
      // pointerup was swallowed, so the gesture is over either way
      if (ev.buttons === 0 || Math.hypot(ev.clientX - startX, ev.clientY - startY) > CANCEL_PX) {
        cleanup()
      }
      return
    }
    if (ev.buttons === 0) {
      updateTarget(ev.clientX, ev.clientY)
      commit()
      cleanup()
      return
    }
    moveGhost(ev.clientX, ev.clientY)
    updateTarget(ev.clientX, ev.clientY)
  }

  const onUp = (ev: PointerEvent): void => {
    if (armed) {
      updateTarget(ev.clientX, ev.clientY)
      commit()
    }
    cleanup()
  }

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      cleanup()
    }
  }
  const onCancel = (): void => cleanup()

  const holdTimer = setTimeout(arm, HOLD_MS)

  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onCancel, true)
  window.addEventListener('lostpointercapture', onCancel, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', onCancel)
}
