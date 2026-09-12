import { useEffect, useRef } from 'react'
import { Bell, CheckCheck, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'
import Tooltip from './Tooltip'
import AgentIcon from './AgentIcon'

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export default function NotificationBell(): React.JSX.Element {
  const notifications = useStore((s) => s.notifications)
  const workspaces = useStore((s) => s.workspaces)
  const open = useStore((s) => s.notifOpen)
  const { setNotifOpen, goToNotification, markAllRead, clearNotifications } = useStore()
  const ref = useRef<HTMLDivElement>(null)
  const t = useT()

  const unread = notifications.filter((n) => !n.read).length

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setNotifOpen(false)
    }
    // webview clicks never reach this document — catch the focus theft instead
    // (webview focus produces no focusin, only a capture-phase focus event)
    const onFocus = (e: FocusEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setNotifOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('focus', onFocus, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('focus', onFocus, true)
    }
  }, [open, setNotifOpen])

  const wsName = (id: string): string => workspaces.find((w) => w.id === id)?.name ?? ''

  return (
    <div className="notif-wrap" ref={ref}>
      <Tooltip label={t('notificationsTooltip')}>
        <button className="tbtn" onClick={() => setNotifOpen(!open)}>
          <Bell />
          {unread > 0 && <span className="notif-badge">{unread}</span>}
        </button>
      </Tooltip>
      {open && (
        <>
          <div className="click-catcher" onMouseDown={() => setNotifOpen(false)} />
          <div className="notif-panel">
            <div className="notif-head">
              <span>{t('notifications')}</span>
              <Tooltip label={t('markAllRead')}>
                <button className="tbtn" onClick={markAllRead}>
                  <CheckCheck size={13} />
                </button>
              </Tooltip>
              <Tooltip label={t('clearAll')}>
                <button className="tbtn" onClick={clearNotifications}>
                  <Trash2 size={13} />
                </button>
              </Tooltip>
            </div>
            <div className="notif-list">
              {notifications.length === 0 && (
                <div className="notif-empty">{t('noNotifications')}</div>
              )}
              {notifications.map((n) => (
                <button
                  key={n.id}
                  className={`notif-item${n.read ? '' : ' unread'}`}
                  onClick={() => goToNotification(n.id)}
                >
                  <div className="notif-title">
                    {n.agent && <AgentIcon id={n.agent} size={13} />}
                    {n.title}
                  </div>
                  <div className="notif-sub">
                    {wsName(n.workspaceId)}
                    {n.body ? ` · ${n.body}` : ''} · {timeAgo(n.ts)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
