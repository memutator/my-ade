import type { PointerEvent as ReactPointerEvent } from 'react'
import type { DropEdge } from './types'
import { useStore } from './store'
import { isDetachedWin } from './detached'

export type { DropEdge }

type DropTarget =
  | { kind: 'pane'; wsId: string; paneId: string; edge: DropEdge | null }
  | { kind: 'ws'; wsId: string }
  /** tab drags only: pointer still inside the source strip — the gesture is
      a reorder, `index` is the gap it would insert at (0..n) */
  | { kind: 'insert'; index: number }

interface DragSpec {
  /** label shown in the ghost chip */
  title: string
  /** element whose icon is cloned into the ghost (pane grip / tab) */
  iconEl: HTMLElement | null
  /** the element being dragged (dimmed while dragging) */
  srcEl: HTMLElement | null
  /** pane the payload came out of — a drop back on it is adjusted by mode */
  selfPaneId: string
  /** tab drags: edge drop on the source pane = split self; center = nothing.
      Pane drags: any drop on self cancels (existing behavior). */
  selfEdgeOk: boolean
  /** tab drags only: the source .tstrip — inside it the gesture reorders */
  stripEl?: HTMLElement | null
  /** fired when the hold elapses and the drag arms — lets callers suppress
      the click that a held press would still emit on release */
  onArm?: () => void
  commit: (t: DropTarget) => void
}

export interface PaneDragInfo {
  paneId: string
  wsId: string
  title: string
  iconEl: HTMLElement | null
  paneEl: HTMLElement | null
  onArm?: () => void
}

export interface TabDragInfo {
  wsId: string
  paneId: string
  tabId: string
  /** index of the tab inside its strip — mapped through the insert gap on drop */
  fromIndex: number
  title: string
  iconEl: HTMLElement | null
  /** the dragged .ctab (dimmed while dragging) */
  tabEl: HTMLElement | null
  /** the .tstrip the tab lives in */
  stripEl: HTMLElement | null
  onReorder: (from: number, to: number) => void
  onArm?: () => void
}

const HOLD_MS = 180 // press-and-hold before the drag arms
const CANCEL_PX = 6 // moving this far before the hold elapses cancels
const EDGE_ZONE = 0.25 // outer quarter of a pane = split zone
const TAB_HOVER_MS = 400 // hovering a workspace tab this long activates it

let dragging = false

// Which quarter of the pane rect is the pointer in? Center → null (swap/stack).
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
 * Pointer-based drag & drop engine (NOT HTML5 DnD — dragstart can't cross
 * <webview> and gives no control over the ghost). Arms after a press-and-hold,
 * installs window-level pointermove/pointerup/keydown listeners until the
 * gesture ends or is cancelled.
 *
 * Once armed, `body.pane-dragging` disables pointer-events on every <webview>
 * (they swallow all mouse events otherwise) so hit-testing via
 * document.elementFromPoint keeps working.
 */
function startDrag(e: ReactPointerEvent, spec: DragSpec): void {
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

  // inside the source strip a tab drag is a reorder — resolve the insertion
  // gap under the pointer (index among tabs, by midpoint)
  const insertAt = (x: number): { target: DropTarget; gapX: number } | null => {
    const strip = spec.stripEl
    if (!strip) return null
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>('.ctab'))
    if (!tabs.length) return null
    let idx = tabs.length
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect()
      if (x < r.left + r.width / 2) {
        idx = i
        break
      }
    }
    const gapX =
      idx >= tabs.length
        ? tabs[tabs.length - 1].getBoundingClientRect().right
        : tabs[idx].getBoundingClientRect().left
    return { target: { kind: 'insert', index: idx }, gapX }
  }

  // Recompute the drop target under the pointer and update highlights.
  const updateTarget = (x: number, y: number): void => {
    const hit = document.elementFromPoint(x, y)
    let target: DropTarget | null = null
    let tabEl: Element | null = null
    let rect: { left: number; top: number; width: number; height: number } | null = null
    let indClass = ''

    // reorder mode: pointer still inside the source strip bounds
    const sr = spec.stripEl?.getBoundingClientRect()
    const inStrip = sr && x >= sr.left && x <= sr.right && y >= sr.top - 4 && y <= sr.bottom + 4

    if (inStrip) {
      const ins = insertAt(x)
      if (ins) {
        target = ins.target
        rect = { left: ins.gapX - 1, top: sr.top + 3, width: 2, height: sr.height - 6 }
        indClass = 'insert'
      }
    } else {
      const tab = hit?.closest('.ws-strip .ctab') ?? null
      if (tab instanceof HTMLElement && tab.dataset.tabId) {
        target = { kind: 'ws', wsId: tab.dataset.tabId }
        tabEl = tab
      } else {
        const hitPane = hit?.closest('.pane') ?? null
        // a floating pane is not a drop target (it isn't in the layout tree) —
        // the gesture falls through to the workspace behind it, which appends
        const paneEl = hitPane?.closest('.float-pane') ? null : hitPane
        if (paneEl instanceof HTMLElement) {
          const pid = paneEl.dataset.paneId
          const wid = paneEl.dataset.wsId
          if (pid && wid) {
            const isSelf = pid === spec.selfPaneId
            // tab drags: another leaf's tab strip is stack territory — the
            // drop joins those tabs, it doesn't split at the top edge (the
            // source strip never gets here — inStrip claimed it as reorder)
            const overStrip = !!spec.stripEl && !isSelf && !!hit?.closest('.tstrip')
            const edge = overStrip ? null : edgeAt(paneEl.getBoundingClientRect(), x, y)
            // self: pane drags cancel outright; tab drags accept an edge
            // (split own leaf) but ignore the center (already home)
            if (!isSelf || (spec.selfEdgeOk && edge)) {
              const r = paneEl.getBoundingClientRect()
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
    spec.onArm?.()
    document.body.classList.add('pane-dragging')
    spec.srcEl?.classList.add('drag-src')
    // a dragged float must also become hit-transparent (its overlay wrapper
    // sits above the tree) so drops land on the panes behind it
    spec.srcEl?.closest('.float-pane')?.classList.add('drag-src')

    ghost = document.createElement('div')
    ghost.className = 'drag-ghost'
    const icon =
      spec.iconEl?.querySelector('.picon, .tab-kico, .ticon-img, .agent-icon, svg') ?? spec.iconEl
    if (icon) ghost.appendChild(icon.cloneNode(true))
    const label = document.createElement('span')
    label.className = 'drag-ghost-title'
    label.textContent = spec.title
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
    spec.srcEl?.classList.remove('drag-src')
    spec.srcEl?.closest('.float-pane')?.classList.remove('drag-src')
    curTabEl?.classList.remove('drop-target')
    ghost?.remove()
    indicator?.remove()
  }

  const commit = (): void => {
    if (curTarget) spec.commit(curTarget)
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

/** Pane drag (the titlebar grip): center drop swaps panes, edge drop splits,
    workspace tab / background drops move the pane across workspaces. */
export function startPaneDrag(e: ReactPointerEvent, info: PaneDragInfo): void {
  startDrag(e, {
    title: info.title,
    iconEl: info.iconEl,
    srcEl: info.paneEl,
    selfPaneId: info.paneId,
    selfEdgeOk: false,
    onArm: info.onArm,
    commit: (t) => {
      const st = useStore.getState()
      if (t.kind === 'insert') return
      st.movePane(
        info.paneId,
        info.wsId,
        t.wsId,
        t.kind === 'pane' ? t.paneId : null,
        t.kind === 'pane' ? t.edge : null
      )
    }
  })
}

/** Tab drag (a .ctab in a leaf's strip): inside the strip it reorders; on
    another leaf it stacks, on a leaf edge it splits, on a workspace tab or
    empty workspace area it becomes a new leaf there. */
export function startTabDrag(e: ReactPointerEvent, info: TabDragInfo): void {
  startDrag(e, {
    title: info.title,
    iconEl: info.iconEl,
    srcEl: info.tabEl,
    selfPaneId: info.paneId,
    // a detached window shows only its own pane — edge-on-self would graft a
    // leaf into a workspace the user can't see, so drags are reorder-only
    selfEdgeOk: !isDetachedWin,
    stripEl: info.stripEl,
    onArm: info.onArm,
    commit: (t) => {
      if (t.kind === 'insert') {
        // gap index → final position after the tab leaves its slot
        const to = t.index > info.fromIndex ? t.index - 1 : t.index
        if (to !== info.fromIndex) info.onReorder(info.fromIndex, to)
        return
      }
      const st = useStore.getState()
      st.moveTab(
        info.wsId,
        info.paneId,
        info.tabId,
        t.wsId,
        t.kind === 'pane' ? t.paneId : null,
        t.kind === 'pane' ? t.edge : null
      )
    }
  })
}
