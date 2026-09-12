import {
  cloneElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'

interface AnchorProps {
  onMouseEnter?: (e: React.MouseEvent) => void
  onMouseLeave?: (e: React.MouseEvent) => void
  onFocus?: (e: React.FocusEvent) => void
  onBlur?: (e: React.FocusEvent) => void
  onPointerDown?: (e: React.PointerEvent) => void
}

/**
 * Delayed-hover tooltip. Wraps a single element (no extra DOM node — handlers are
 * cloned onto the child) and shows `label` in a fixed-position overlay after
 * ~300ms. Fixed positioning escapes `overflow: hidden` ancestors as long as no
 * ancestor transforms, which holds for this app's layout.
 */
export default function Tooltip({
  label,
  children,
  delay = 300
}: {
  label: ReactNode
  children: ReactElement<AnchorProps>
  delay?: number
}): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const rectRef = useRef<DOMRect | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = (): void => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }
  const show = (e: React.SyntheticEvent): void => {
    rectRef.current = (e.currentTarget as HTMLElement).getBoundingClientRect()
    clear()
    timer.current = setTimeout(() => setVisible(true), delay)
  }
  const hide = (): void => {
    clear()
    setVisible(false)
    setPos(null)
  }

  useEffect(() => clear, [])

  // measure the tooltip and anchor it below the target (flip above at the edge)
  useLayoutEffect(() => {
    if (!visible) return
    const a = rectRef.current
    const tip = tipRef.current
    if (!a || !tip) return
    const b = tip.getBoundingClientRect()
    const gap = 7
    let top = a.bottom + gap
    if (top + b.height > window.innerHeight - 4 && a.top - gap - b.height > 4) {
      top = a.top - gap - b.height
    }
    const left = Math.min(
      Math.max(4, a.left + a.width / 2 - b.width / 2),
      window.innerWidth - b.width - 4
    )
    setPos({ top: Math.round(top), left: Math.round(left) })
  }, [visible])

  if (!label) return children

  // eslint-disable-next-line react-hooks/refs -- cloneElement only adds handlers; the child's own ref is preserved untouched
  const anchor = cloneElement(children, {
    onMouseEnter: (e: React.MouseEvent) => {
      children.props.onMouseEnter?.(e)
      show(e)
    },
    onMouseLeave: (e: React.MouseEvent) => {
      children.props.onMouseLeave?.(e)
      hide()
    },
    onFocus: (e: React.FocusEvent) => {
      children.props.onFocus?.(e)
      show(e)
    },
    onBlur: (e: React.FocusEvent) => {
      children.props.onBlur?.(e)
      hide()
    },
    onPointerDown: (e: React.PointerEvent) => {
      children.props.onPointerDown?.(e)
      hide()
    }
  })

  return (
    <>
      {anchor}
      {visible && (
        <div
          ref={tipRef}
          className="tooltip"
          role="tooltip"
          style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
        >
          {label}
        </div>
      )}
    </>
  )
}
