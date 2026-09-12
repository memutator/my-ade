import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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

export default function TabStrip({
  tabs,
  activeId,
  onActivate,
  onClose,
  onRename,
  onReorder,
  addControl
}: {
  tabs: TabItem[]
  activeId?: string | null
  onActivate: (id: string) => void
  onClose?: (id: string) => void
  onRename?: (id: string, name: string) => void
  onReorder?: (from: number, to: number) => void
  addControl?: ReactNode
}): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const dragIdx = useRef(-1)
  const stripRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const t = useT()

  // the active tab is never allowed to scroll out of view — activating a tab
  // (click, Ctrl+Tab, Alt+N, notification jump) scrolls it back into frame
  useEffect(() => {
    if (!activeId) return
    const el = stripRef.current
    el?.querySelector(`[data-tab-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest'
    })
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

  const commit = (id: string): void => {
    onRename?.(id, editValue)
    setEditingId(null)
  }

  return (
    <div className="tstrip-wrap" ref={wrapRef}>
      <div className="tstrip" ref={stripRef} onPointerDown={(e) => e.stopPropagation()}>
        {tabs.map((tab, i) => (
          <Tooltip key={tab.id} label={tab.sub ? `${tab.label} — ${tab.sub}` : tab.label}>
            <div
              className={`ctab${tab.id === activeId ? ' active' : ''}`}
              data-tab-id={tab.id}
              draggable={!!onReorder && editingId !== tab.id}
              onDragStart={() => (dragIdx.current = i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (onReorder && dragIdx.current >= 0 && dragIdx.current !== i)
                  onReorder(dragIdx.current, i)
                dragIdx.current = -1
              }}
              onClick={() => onActivate(tab.id)}
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
              {tab.sub && <span className="ctab-sub">{tab.sub}</span>}
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
