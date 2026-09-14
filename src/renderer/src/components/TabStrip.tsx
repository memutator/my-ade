import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref
} from 'react'
import { X } from 'lucide-react'
import { useT } from '../i18n'
import Tooltip from './Tooltip'

export interface TabItem {
  id: string
  label: string
  sub?: string
  icon?: ReactNode
  dirty?: boolean
  /** tooltip for the dirty/status dot (default: unsaved-changes text) */
  dotTip?: string
}

export interface TabStripHandle {
  /** put a tab's label into inline-edit mode (used by the ctx menu's rename) */
  startRename: (id: string) => void
}

export default function TabStrip({
  tabs,
  activeId,
  onActivate,
  onClose,
  onRename,
  onReorder,
  onContextMenu,
  addControl,
  ref
}: {
  tabs: TabItem[]
  activeId?: string | null
  onActivate: (id: string) => void
  onClose?: (id: string) => void
  onRename?: (id: string, name: string) => void
  onReorder?: (from: number, to: number) => void
  onContextMenu?: (id: string, e: React.MouseEvent) => void
  addControl?: ReactNode
  ref?: Ref<TabStripHandle>
}): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const dragIdx = useRef(-1)
  // reorder drags need a press-and-hold — with plain `draggable` any
  // mousedown+wiggle becomes an HTML5 drag and eats the click. The tab only
  // turns draggable after DRAG_HOLD_MS; Chromium re-checks `draggable` on
  // every move while the button is held, so hold-then-drag still works.
  const [armedTab, setArmedTab] = useState<string | null>(null)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const t = useT()

  // the active tab is never allowed to scroll out of view — activating a tab
  // (click, Ctrl+Tab, Alt+N, notification jump) scrolls it back into frame
  useEffect(() => {
    if (!activeId) return
    const el = stripRef.current
    // `container:'nearest'` keeps the scroll inside the strip — without it a
    // scrollIntoView also walks every scrollable ancestor, and when the page
    // has even 1px of overflow the whole document scrolls, pushing the topbar
    // offscreen (root scroller ignores overflow:hidden)
    el?.querySelector(`[data-tab-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      container: 'nearest'
    } as ScrollIntoViewOptions)
    // scrollIntoView's block:nearest may nudge the vertical axis ~1px — the
    // strip must never scroll vertically
    if (el) el.scrollTop = 0
  }, [activeId])

  // vertical wheel scrolls the strip horizontally (Chrome-style). Attached
  // natively — React's onWheel is passive and can't preventDefault.
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      // never let the strip scroll vertically — even overflow:hidden answers
      // to the wheel (a few px of dead range nudges the tabs up/down)
      e.preventDefault()
      if (el.scrollWidth > el.clientWidth) el.scrollLeft += e.deltaY + e.deltaX
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // overlay scrollbar thumb — the native bar can't overlay (it consumes
  // layout height and breaks the active-tab/content merge), so it's hidden
  // and this thumb is drawn on top of the strip's bottom edge on hover.
  const updateThumb = useCallback((): void => {
    const el = stripRef.current
    const th = thumbRef.current
    if (!el || !th) return
    const cw = el.clientWidth
    const sw = el.scrollWidth
    if (sw <= cw + 1) {
      th.style.width = '0px'
      return
    }
    const tw = Math.max(28, (cw * cw) / sw)
    const tx = (el.scrollLeft / (sw - cw)) * (cw - tw)
    th.style.width = `${tw}px`
    th.style.transform = `translateX(${tx}px)`
  }, [])

  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    updateThumb()
    el.addEventListener('scroll', updateThumb, { passive: true })
    const ro = new ResizeObserver(updateThumb)
    ro.observe(el)
    const mo = new MutationObserver(updateThumb)
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      el.removeEventListener('scroll', updateThumb)
      ro.disconnect()
      mo.disconnect()
    }
  }, [updateThumb])

  const onThumbDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    const el = stripRef.current
    if (!el) return
    const cw = el.clientWidth
    const sw = el.scrollWidth
    const tw = Math.max(28, (cw * cw) / sw)
    const scale = (sw - cw) / Math.max(1, cw - tw)
    const startX = e.clientX
    const startL = el.scrollLeft
    wrapRef.current?.classList.add('dragging')
    const move = (ev: MouseEvent): void => {
      el.scrollLeft = startL + (ev.clientX - startX) * scale
    }
    const up = (): void => {
      wrapRef.current?.classList.remove('dragging')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const DRAG_HOLD_MS = 200
  const armDrag = (id: string): void => {
    if (armTimer.current) clearTimeout(armTimer.current)
    armTimer.current = setTimeout(() => setArmedTab(id), DRAG_HOLD_MS)
  }
  const disarmDrag = (): void => {
    if (armTimer.current) {
      clearTimeout(armTimer.current)
      armTimer.current = null
    }
    setArmedTab(null)
  }
  // a release anywhere (incl. off-tab) ends the armed state
  useEffect(() => {
    if (!armedTab) return
    const up = (): void => setArmedTab(null)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    return () => {
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
    }
  }, [armedTab])
  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current)
    },
    []
  )

  const commit = (id: string): void => {
    onRename?.(id, editValue)
    setEditingId(null)
  }

  useImperativeHandle(
    ref,
    (): TabStripHandle => ({
      startRename: (id) => {
        const tab = tabs.find((x) => x.id === id)
        if (!tab || !onRename) return
        setEditingId(id)
        setEditValue(tab.label)
      }
    }),
    [tabs, onRename]
  )

  return (
    <div className="tstrip-wrap" ref={wrapRef}>
      <div
        className="tstrip"
        ref={stripRef}
        onPointerDown={(e) => {
          // only interactive children keep the gesture to themselves — the
          // strip's empty space must bubble up to .pane-titlebar, where a
          // floating pane starts its move drag
          if ((e.target as HTMLElement).closest('.ctab, button, input')) e.stopPropagation()
        }}
      >
        {tabs.map((tab, i) => (
          // tab info (sub) lives in the tooltip only — the tab body itself
          // never changes on hover, so the close button keeps a fixed spot
          <Tooltip key={tab.id} label={tab.sub ? `${tab.label} — ${tab.sub}` : tab.label}>
            <div
              className={`ctab${tab.id === activeId ? ' active' : ''}${armedTab === tab.id ? ' drag-armed' : ''}`}
              data-tab-id={tab.id}
              draggable={!!onReorder && editingId !== tab.id && armedTab === tab.id}
              onPointerDown={(e) => {
                if (e.button !== 0 || (e.target as HTMLElement).closest('button, input')) return
                armDrag(tab.id)
              }}
              onPointerUp={disarmDrag}
              onDragStart={() => (dragIdx.current = i)}
              onDragEnd={() => {
                dragIdx.current = -1
                disarmDrag()
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (onReorder && dragIdx.current >= 0 && dragIdx.current !== i)
                  onReorder(dragIdx.current, i)
                dragIdx.current = -1
              }}
              onClick={() => onActivate(tab.id)}
              onContextMenu={(e) => {
                if (!onContextMenu) return
                e.preventDefault()
                // right-click also selects — makes "close others" predictable
                onActivate(tab.id)
                onContextMenu(tab.id, e)
              }}
              onDoubleClick={() => {
                if (!onRename) return
                setEditingId(tab.id)
                setEditValue(tab.label)
              }}
            >
              {tab.icon}
              {editingId === tab.id ? (
                <input
                  className="ctab-rename"
                  autoFocus
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={() => commit(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit(tab.id)
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="ctab-label">{tab.label}</span>
              )}
              {tab.dirty && (
                <Tooltip label={tab.dotTip ?? t('unsavedChanges')}>
                  <span className="ctab-dot" />
                </Tooltip>
              )}
              {onClose && (
                <button
                  className="ctab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose(tab.id)
                  }}
                >
                  <X size={11} />
                </button>
              )}
            </div>
          </Tooltip>
        ))}
        {addControl}
      </div>
      <div
        className="tstrip-thumb"
        ref={thumbRef}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={onThumbDown}
      />
    </div>
  )
}
