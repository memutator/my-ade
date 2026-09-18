import { useMemo } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../store'

/* Pane-scoped toasts — overlaid top-right on the pane body, so a notice
   never pushes the content it announces. A toast with a tabId waits for
   that tab to be the pane's active one; tab-less toasts show regardless.
   'info' toasts carry a ttl and dismiss themselves (see pushPaneToast);
   'warn' toasts stick until an action or the ×. */

export default function PaneToasts({
  wsId,
  paneId,
  activeTabId
}: {
  wsId: string
  paneId: string
  activeTabId: string | undefined
}): React.JSX.Element | null {
  const paneToasts = useStore((s) => s.paneToasts)
  const list = useMemo(
    () =>
      paneToasts.filter(
        (x) => x.wsId === wsId && x.paneId === paneId && (!x.tabId || x.tabId === activeTabId)
      ),
    [paneToasts, wsId, paneId, activeTabId]
  )
  if (!list.length) return null
  return (
    <div className="pane-toasts">
      {list.map((x) => (
        <div key={x.id} className={`pane-toast ${x.kind}`}>
          <span className="pane-toast-text">{x.text}</span>
          {x.actions?.map((a) => (
            <button
              key={a.id}
              className="pane-toast-act"
              onClick={() => useStore.getState().runPaneToastAction(x.id, a.id)}
            >
              {a.label}
            </button>
          ))}
          <button
            className="pane-toast-x"
            onClick={() => useStore.getState().dismissPaneToast(x.id)}
          >
            <X />
          </button>
        </div>
      ))}
    </div>
  )
}
