import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, Globe } from 'lucide-react'
import type { BrowserPaneState } from '../types'
import { useStore } from '../store'
import PaneFrame from './PaneFrame'

function normalizeUrl(input: string): string {
  const v = input.trim()
  if (!v) return 'about:blank'
  if (/^[a-z]+:\/\//i.test(v) || v === 'about:blank') return v
  if (v.includes('.') && !v.includes(' ')) return `https://${v}`
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`
}

export default function BrowserPane({
  pane,
  wsId
}: {
  pane: BrowserPaneState
  wsId: string
}): React.JSX.Element {
  const wvRef = useRef<Electron.WebviewTag>(null)
  const syncUrlRef = useRef<(() => void) | null>(null)
  const readyRef = useRef(false)
  const [urlInput, setUrlInput] = useState(pane.url === 'https://' ? '' : pane.url)
  const updatePane = useStore((s) => s.updatePane)

  useEffect(() => {
    const wv = wvRef.current
    if (!wv) return

    const onNav = (e: Electron.DidNavigateEvent | Electron.DidNavigateInPageEvent): void => {
      setUrlInput(e.url)
      updatePane(pane.id, { url: e.url }, wsId)
    }
    const onTitle = (e: Electron.PageTitleUpdatedEvent): void => {
      if (e.title) updatePane(pane.id, { title: e.title }, wsId)
    }
    const onNewWindow = (e: Event): void => {
      window.ade.openExternal((e as unknown as { url: string }).url)
    }

    const syncUrl = (): void => {
      if (!readyRef.current) return // wait for dom-ready
      const w = useStore.getState().workspaces.find((x) => x.id === wsId)
      const p = w?.panes[pane.id]
      const url = p?.type === 'browser' ? p.url : pane.url
      const target = url === 'https://' ? 'about:blank' : url
      try {
        if (wv.getURL() !== target) wv.loadURL(target).catch(() => {})
      } catch {
        /* not ready yet */
      }
    }
    const onReady = (): void => {
      readyRef.current = true
      syncUrl()
    }
    wv.addEventListener('dom-ready', onReady)

    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNav)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('new-window', onNewWindow as EventListener)
    syncUrlRef.current = syncUrl
    return () => {
      readyRef.current = false
      wv.removeEventListener('dom-ready', onReady)
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNav)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('new-window', onNewWindow as EventListener)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, wsId, updatePane])

  // Keep webview in sync when pane.url changes from outside nav events.
  useEffect(() => {
    syncUrlRef.current?.()
  }, [pane.url])

  const go = (): void => {
    const url = normalizeUrl(urlInput)
    setUrlInput(url)
    updatePane(pane.id, { url }, wsId)
    wvRef.current?.loadURL(url).catch(() => {})
  }

  return (
    <PaneFrame
      pane={pane}
      wsId={wsId}
      icon={<Globe className="picon" />}
      title={
        <>
          <button className="pbtn" title="Back" onClick={() => wvRef.current?.goBack()}>
            <ArrowLeft />
          </button>
          <button className="pbtn" title="Forward" onClick={() => wvRef.current?.goForward()}>
            <ArrowRight />
          </button>
          <button className="pbtn" title="Reload" onClick={() => wvRef.current?.reload()}>
            <RotateCw />
          </button>
          <input
            className="url-input"
            value={urlInput}
            placeholder="url or search…"
            spellCheck={false}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
            onPointerDown={(e) => e.stopPropagation()}
          />
        </>
      }
    >
      <webview
        ref={wvRef}
        className="browser-view"
        src={pane.url === 'https://' ? 'about:blank' : pane.url}
      />
    </PaneFrame>
  )
}
