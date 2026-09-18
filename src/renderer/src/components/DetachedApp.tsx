import { useEffect, useState } from 'react'
import { ArrowDownToLine, Minus, Pin, PinOff, Square, X } from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'
import { paneLabel } from '../utils'
import type { PaneState } from '../types'
import { PaneFor } from './SplitView'
import Tooltip from './Tooltip'

// A detached pane lives here: its own frameless OS window with a minimal bar
// (drag anywhere, reattach, window controls). The pane keeps its wsId/paneId
// identity in the main store — this window is just another view onto it.
// Local edits (tab ops, renames) sync up via pane:syncUp; close goes through
// pane:cmd so the main store stays the single source of truth. The pane icon
// carries the whole editor tree flow (hover-peek / hold-drag), identical to
// docked/floating — no detached-specific tree chrome lives here.
export default function DetachedApp({
  wsId,
  paneId
}: {
  wsId: string
  paneId: string
}): React.JSX.Element {
  const pane = useStore((s) => s.workspaces.find((w) => w.id === wsId)?.panes[paneId])
  const settings = useStore((s) => s.settings)
  const setResolvedTheme = useStore((s) => s.setResolvedTheme)
  const t = useT()
  const [pinned, setPinned] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const resolved =
        settings.theme === 'system' ? (mq.matches ? 'dark' : 'light') : settings.theme
      setResolvedTheme(resolved)
      document.documentElement.dataset.theme = resolved
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings.theme, setResolvedTheme])

  useEffect(() => {
    const el = document.documentElement
    el.style.setProperty('--accent', settings.accent)
    el.style.setProperty('--font-ui', settings.uiFont)
  }, [settings.accent, settings.uiFont])

  // claim the fresh pane snapshot the main window captured at detach — it
  // carries live pty session ids and newest tabs the disk-hydrated copy may
  // lack. The local copy must also carry `detached` — terminal cleanup keys
  // off it (keep the pty alive when this view unmounts) and sync-up echoes
  // the whole pane object, which would otherwise clear the flag in main
  useEffect(() => {
    void window.mahas?.win.hello().then((h) => {
      if (h?.pane) {
        useStore
          .getState()
          .updatePane(h.paneId, { ...(h.pane as PaneState), detached: true }, h.wsId)
      } else {
        useStore.getState().updatePane(paneId, { detached: true }, wsId)
      }
    })
  }, [wsId, paneId])

  // report what this window is attending (on mount, focus gain, active-tab
  // change) so the main store clears pings aimed at this pane without
  // needing a notification click — our focus isn't observable from there
  const attendedTabId = pane?.activeTabId
  useEffect(() => {
    const report = (): void => {
      if (document.hasFocus())
        window.mahas.win.paneCmd({ action: 'attended', wsId, paneId, tabId: attendedTabId })
    }
    report()
    window.addEventListener('focus', report)
    return () => window.removeEventListener('focus', report)
  }, [wsId, paneId, attendedTabId])

  // window.open here (markdown link tooltips) bounces back as 'open-url' —
  // panes are owned by the main store, so relay the request there
  useEffect(
    () =>
      window.mahas.win.onOpenUrl((url) =>
        window.mahas.win.paneCmd({ action: 'openUrl', wsId, paneId, url })
      ),
    [wsId, paneId]
  )

  // push local pane-state edits (tab renames, cwd/agent patches, closes) up
  // to the main window's store — it's the single source of truth
  useEffect(() => {
    let last: unknown
    const unsub = useStore.subscribe((s) => {
      const p = s.workspaces.find((w) => w.id === wsId)?.panes[paneId]
      if (p !== last) {
        last = p
        if (p) window.mahas.win.paneSyncUp({ wsId, paneId, pane: p })
      }
    })
    return unsub
  }, [wsId, paneId])

  const togglePin = (): void => {
    const next = !pinned
    setPinned(next)
    window.mahas.win.setAlwaysOnTop?.(next)
  }

  return (
    <div className="app detached">
      <div className="detached-bar">
        <span className="dt-title">{pane ? paneLabel(pane, settings.language) : ''}</span>
        <div className="dt-actions">
          <Tooltip label={t(pinned ? 'unpinTop' : 'alwaysOnTop')}>
            <button className={`pbtn${pinned ? ' on' : ''}`} onClick={togglePin}>
              {pinned ? <PinOff /> : <Pin />}
            </button>
          </Tooltip>
          <Tooltip label={t('reattachPane')}>
            <button className="pbtn" onClick={() => window.mahas.win.reattach()}>
              <ArrowDownToLine />
            </button>
          </Tooltip>
          <Tooltip label={t('minimize')}>
            <button className="pbtn" onClick={() => window.mahas.win.minimize()}>
              <Minus />
            </button>
          </Tooltip>
          <Tooltip label={t('maximize')}>
            <button className="pbtn" onClick={() => window.mahas.win.maximize()}>
              <Square />
            </button>
          </Tooltip>
          <Tooltip label={t('reattachPane')}>
            <button className="pbtn" onClick={() => window.mahas.win.reattach()}>
              <X />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="detached-body">{pane ? <PaneFor paneId={paneId} wsId={wsId} /> : null}</div>
    </div>
  )
}
