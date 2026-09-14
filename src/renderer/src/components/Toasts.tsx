import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../store'
import AgentIcon from './AgentIcon'
import type { ToastItem } from '../types'

// Ambient-level agent signals slide down from the top center — the app has
// the user's attention, so a nudge in view beats a silent workspace badge.
// Clicking jumps to the emitting target (marks the notification read);
// toasts expire on their own.
const TTL = 6000

function Toast({ t }: { t: ToastItem }): React.JSX.Element {
  const dismissToast = useStore((s) => s.dismissToast)
  const goToNotification = useStore((s) => s.goToNotification)

  useEffect(() => {
    const id = setTimeout(() => dismissToast(t.id), TTL)
    return () => clearTimeout(id)
  }, [t.id, dismissToast])

  const open = (): void => {
    dismissToast(t.id)
    if (t.notifId) goToNotification(t.notifId)
  }

  return (
    <button className="toast" onClick={open}>
      {t.agent && <AgentIcon id={t.agent} size={15} />}
      <span className="toast-text">
        <span className="toast-title">{t.title}</span>
        {t.body && <span className="toast-body">{t.body}</span>}
      </span>
      <span
        className="toast-x"
        role="button"
        aria-label="dismiss"
        onClick={(e) => {
          e.stopPropagation()
          dismissToast(t.id)
        }}
      >
        <X size={12} />
      </span>
    </button>
  )
}

export default function Toasts(): React.JSX.Element | null {
  const toasts = useStore((s) => s.toasts)
  if (!toasts.length) return null
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <Toast key={t.id} t={t} />
      ))}
    </div>
  )
}
