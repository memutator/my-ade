import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'

/* Shared floating-popup primitives.

   Popup    — portaled, position:fixed card that clamps into the viewport and
              closes on Escape / outside pointer / focus theft (a focused
              <webview> emits no keydown or click to the host — only a capture-
              phase focus event) / outside scroll or window resize.
   Dropdown — wraps a trigger element and opens a Popup anchored under it.
              mode 'click' toggles on click; mode 'hover' opens on pointer
              entry and uses a short close-delay to bridge the gap between
              trigger and card.
   Select   — button + Dropdown list, the themed replacement for <select>.

   Special-cased menus that carry their own structure (workspace create menu,
   browser tab/bookmark lists, notification panel) keep their own markup —
   this covers the generic cases: pane ⋯ menu, tree context menu, selects. */

export function Popup({
  pos,
  alignX = 'start',
  onClose,
  insideRef,
  closeOnClick,
  className,
  children,
  onMouseEnter,
  onMouseLeave
}: {
  /** desired fixed position before viewport clamping. With alignX='end',
      pos.left is the card's desired RIGHT edge, not its left */
  pos: { left: number; top: number }
  alignX?: 'start' | 'end'
  onClose: () => void
  /** ref whose element counts as 'inside' for outside-close (the trigger) —
      a ref, not the element, so callers never touch .current during render */
  insideRef?: RefObject<HTMLElement | null>
  /** any click inside the card closes it (menu semantics) */
  closeOnClick?: boolean
  className?: string
  children: ReactNode
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // null until the first layout measurement clamps pos into the viewport —
  // the card stays invisible rather than flashing at the unclamped spot
  const [clamped, setClamped] = useState<{ left: number; top: number } | null>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const wantLeft = alignX === 'end' ? pos.left - r.width : pos.left
    setClamped({
      left: Math.max(4, Math.min(wantLeft, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(pos.top, window.innerHeight - r.height - 4))
    })
  }, [pos.left, pos.top, alignX])

  useEffect(() => {
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      (ref.current?.contains(target) === true || insideRef?.current?.contains(target) === true)
    const onDown = (e: MouseEvent): void => {
      if (!inside(e.target)) onCloseRef.current()
    }
    // a focused <webview> never produces focusin — capture the focus theft
    const onFocus = (e: FocusEvent): void => {
      if (!inside(e.target)) onCloseRef.current()
    }
    // a fixed card can't follow an anchor that scrolled away
    const onMove = (e: Event): void => {
      if (!inside(e.target)) onCloseRef.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('focus', onFocus, true)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('focus', onFocus, true)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [insideRef])

  return createPortal(
    <div
      ref={ref}
      className={className}
      style={{
        position: 'fixed',
        left: clamped?.left ?? pos.left,
        top: clamped?.top ?? pos.top,
        visibility: clamped ? 'visible' : 'hidden'
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={closeOnClick ? () => onCloseRef.current() : undefined}
    >
      {children}
    </div>,
    document.body
  )
}

export function Dropdown({
  trigger,
  mode = 'click',
  align = 'start',
  panelClassName,
  children
}: {
  trigger: ReactNode
  mode?: 'click' | 'hover'
  /** which panel edge aligns with the trigger's; 'end' = right edges */
  align?: 'start' | 'end'
  panelClassName?: string
  children: ReactNode
}): React.JSX.Element {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const closeT = useRef<ReturnType<typeof setTimeout> | null>(null)

  const openNow = (): void => {
    if (closeT.current) clearTimeout(closeT.current)
    closeT.current = null
    setRect(anchorRef.current?.getBoundingClientRect() ?? null)
  }
  const close = (): void => {
    if (closeT.current) clearTimeout(closeT.current)
    closeT.current = null
    setRect(null)
  }
  const closeSoon = (): void => {
    if (closeT.current) clearTimeout(closeT.current)
    closeT.current = setTimeout(close, 140)
  }

  const hover = mode === 'hover' ? { onMouseEnter: openNow, onMouseLeave: closeSoon } : {}

  return (
    <span
      ref={anchorRef}
      style={{ display: 'inline-flex' }}
      onClick={mode === 'click' ? () => (rect ? close() : openNow()) : undefined}
      {...hover}
    >
      {trigger}
      {rect && (
        <Popup
          pos={{ left: align === 'end' ? rect.right : rect.left, top: rect.bottom + 5 }}
          alignX={align}
          onClose={close}
          insideRef={anchorRef}
          closeOnClick
          className={panelClassName}
          {...hover}
        >
          {children}
        </Popup>
      )}
    </span>
  )
}

export function Select({
  value,
  options,
  onChange,
  className
}: {
  value: string
  options: { value: string; label: ReactNode }[]
  onChange: (v: string) => void
  className?: string
}): React.JSX.Element {
  const current = options.find((o) => o.value === value)
  return (
    <Dropdown
      mode="click"
      panelClassName="sel-pop"
      trigger={
        <button type="button" className={`sel${className ? ` ${className}` : ''}`}>
          <span className="sel-label">{current?.label ?? value}</span>
          <ChevronDown />
        </button>
      }
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`sel-item${o.value === value ? ' on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </Dropdown>
  )
}
