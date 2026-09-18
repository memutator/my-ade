import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, Star, X } from 'lucide-react'
import type { Bookmark, BrowserTab, PaneState } from '../types'
import { useStore } from '../store'
import { useT, translate } from '../i18n'
import { applyShortcut, effectiveBindings } from '../shortcuts'
import Tooltip from './Tooltip'

function normalizeUrl(input: string): string {
  const v = input.trim()
  if (!v) return 'about:blank'
  if (/^[a-z]+:\/\//i.test(v) || v === 'about:blank') return v
  if (v.includes('.') && !v.includes(' ')) return `https://${v}`
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`
}

// 'https://' is the "empty address" sentinel for a fresh tab; scheme-less
// home pages like "example.com" get https:// prepended so loadURL never throws
const toLoad = (url: string): string => {
  if (url === 'https://') return 'about:blank'
  if (url && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return `https://${url}`
  return url
}
const toInput = (url: string): string => (url === 'https://' ? '' : url)

interface TabNavMeta {
  canBack: boolean
  canFwd: boolean
  loading: boolean
}

const NO_META: TabNavMeta = { canBack: false, canFwd: false, loading: false }

/** event handlers outlive props — always read the pane fresh from the store */
function paneAt(wsId: string, paneId: string): PaneState | undefined {
  return useStore.getState().workspaces.find((x) => x.id === wsId)?.panes[paneId]
}

function webTabAt(wsId: string, paneId: string, tabId: string): BrowserTab | undefined {
  return paneAt(wsId, paneId)?.tabs.find((t): t is BrowserTab => t.id === tabId && t.kind === 'web')
}

/** close dropdown on outside click / Escape (same pattern as ws-menu) */
function useDismiss(
  open: boolean,
  ref: React.RefObject<HTMLElement | null>,
  close: () => void
): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    // clicks inside a <webview> never reach this document — but the webview
    // steals focus, which we can observe via a capture-phase focus listener
    const onFocus = (e: FocusEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('focus', onFocus, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('focus', onFocus, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, ref, close])
}

function BookmarkMenu({
  tab,
  projectId,
  projectName,
  onOpen
}: {
  tab: BrowserTab | null
  projectId?: string
  projectName?: string
  onOpen: (url: string, newTab: boolean) => void
}): React.JSX.Element {
  const t = useT()
  const bookmarks = useStore((s) => s.bookmarks)
  const { addBookmark, removeBookmark } = useStore()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, ref, close)

  const visible = bookmarks.filter((b) => b.scope === 'global' || b.scope === projectId)
  const projectBms = visible.filter((b) => b.scope === projectId)
  const globalBms = visible.filter((b) => b.scope === 'global')
  const curUrl = tab?.url ?? ''
  const canSave = !!curUrl && curUrl !== 'https://' && curUrl !== 'about:blank'
  const saved = canSave && visible.some((b) => b.url === curUrl)

  const save = (scope: string): void => {
    addBookmark({ title: tab?.title || curUrl, url: curUrl, scope })
    close()
  }

  const item = (b: Bookmark): React.JSX.Element => (
    <div key={b.id} className="pdrop-row">
      <button
        className="pdrop-main"
        aria-label="Open in this tab"
        onClick={() => {
          onOpen(b.url, false)
          close()
        }}
      >
        <span className="pdrop-title">{b.title || b.url}</span>
        <span className="pdrop-sub">{b.url}</span>
      </button>
      <button
        className="pdrop-x"
        aria-label="Open in new tab"
        onClick={(e) => {
          e.stopPropagation()
          onOpen(b.url, true)
          close()
        }}
      >
        <Plus size={11} />
      </button>
      <button
        className="pdrop-x"
        aria-label="Delete bookmark"
        onClick={(e) => {
          e.stopPropagation()
          removeBookmark(b.id)
        }}
      >
        <X size={11} />
      </button>
    </div>
  )

  return (
    <div className="pd-wrap" ref={ref}>
      <Tooltip label={t('bookmarks')}>
        <button className={`pbtn pd-btn${open ? ' on' : ''}`} onClick={() => setOpen(!open)}>
          <Star fill={saved ? 'currentColor' : 'none'} />
        </button>
      </Tooltip>
      {open && (
        <>
          <div className="click-catcher" onMouseDown={close} />
          <div className="pdrop">
            {projectId && (
              <button className="pdrop-action" disabled={!canSave} onClick={() => save(projectId)}>
                <Star size={11} /> {t('saveTo', { name: projectName ?? t('project') })}
              </button>
            )}
            <button className="pdrop-action" disabled={!canSave} onClick={() => save('global')}>
              <Star size={11} /> {t('saveTo', { name: t('global') })}
            </button>
            {saved && (
              <button
                className="pdrop-action"
                onClick={() => {
                  visible.filter((b) => b.url === curUrl).forEach((b) => removeBookmark(b.id))
                }}
              >
                <X size={11} /> {t('removeBookmark')}
              </button>
            )}
            {visible.length > 0 && <div className="pdrop-sep" />}
            {projectBms.length > 0 && (
              <>
                <div className="pdrop-label">{projectName ?? t('project')}</div>
                {projectBms.map(item)}
              </>
            )}
            {globalBms.length > 0 && (
              <>
                <div className="pdrop-label">{t('global')}</div>
                {globalBms.map(item)}
              </>
            )}
            {visible.length === 0 && <div className="pdrop-empty">{t('noBookmarks')}</div>}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * One <webview> per web block; inactive blocks stay mounted (the leaf hides
 * them) so each keeps its own history, scroll position and page state. The
 * floating omnibox header lives inside the content — the leaf's tab strip is
 * where tabs switch.
 *
 * Desired-url changes flow one way: store (tab.url) → effect → guarded loadURL.
 * loadURL throws before dom-ready, so syncUrl probes by simply trying the call:
 * on throw it marks the view not-ready and a bounded retry re-arms until it
 * succeeds. The probe matters because dom-ready can fire before our listeners
 * attach (StrictMode remount) — without it the tab would never become ready.
 */
export function BrowserTabView({
  wsId,
  paneId,
  tab,
  onFocusPane
}: {
  wsId: string
  paneId: string
  tab: BrowserTab
  onFocusPane: () => void
}): React.JSX.Element {
  const t = useT()
  const wvRef = useRef<Electron.WebviewTag | null>(null)
  const retriesRef = useRef(0)
  const retryTimerRef = useRef<number | undefined>(undefined)
  const syncRef = useRef<() => void>(() => {})
  const bindings = useStore((s) => s.settings.bindings)
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<TabNavMeta>(NO_META)
  // src is frozen at mount — later navigations use loadURL only, so the
  // webview never double-loads when tab.url changes
  const [initialSrc] = useState(() => toLoad(tab.url))
  // guest preload (app-shortcut key forwarding) — resolve before mounting the
  // webview since `preload` is only read when the element attaches
  const [preload, setPreload] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    window.mahas.webview
      .preloadPath()
      .then((p) => {
        if (live) setPreload(p)
      })
      .catch(() => setPreload(''))
    return () => {
      live = false
    }
  }, [])

  const project = useStore((s) => {
    const w = s.workspaces.find((x) => x.id === wsId)
    return s.projects.find((p) => p.id === w?.projectId)
  })

  const desiredUrl = useCallback((): string | null => {
    const t = webTabAt(wsId, paneId, tab.id)
    return t ? toLoad(t.url) : null
  }, [wsId, paneId, tab.id])

  const reportNav = useCallback((): void => {
    const wv = wvRef.current
    let m = NO_META
    try {
      if (wv) m = { canBack: wv.canGoBack(), canFwd: wv.canGoForward(), loading: wv.isLoading() }
    } catch {
      /* not attached yet */
    }
    setMeta((prev) =>
      prev.canBack === m.canBack && prev.canFwd === m.canFwd && prev.loading === m.loading
        ? prev
        : m
    )
  }, [])

  // stable binding — bind/unbind the element exactly on mount/unmount
  const onFocusPaneRef = useRef(onFocusPane)
  useEffect(() => {
    onFocusPaneRef.current = onFocusPane
  })
  // the webview element itself lives in state so dependent effects (nav
  // listeners, url sync) re-run when it attaches after the preload resolves
  const [wvEl, setWvEl] = useState<Electron.WebviewTag | null>(null)
  const attachWebview = useCallback((el: Electron.WebviewTag | null): void => {
    wvRef.current = el
    setWvEl(el)
    // clicking inside the guest focuses the webview element — that's our
    // only signal, so it also marks the pane focused
    el?.addEventListener('focus', () => onFocusPaneRef.current())
    // guest preload relays app-shortcut keydowns as ipc-message 'mahas:key'
    const onIpc = (e: Electron.IpcMessageEvent): void => {
      if (e.channel === 'mahas:key') applyShortcut(e.args[0])
    }
    el?.addEventListener('ipc-message', onIpc)
  }, [])

  // create the webview imperatively — `preload` must be set before the element
  // attaches, and JSX can't express it (React drops unknown webview props)
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host || preload === null) return
    const el = document.createElement('webview') as Electron.WebviewTag
    el.className = 'browser-view'
    if (preload) el.setAttribute('preload', preload)
    el.setAttribute('src', initialSrc)
    host.appendChild(el)
    attachWebview(el)
    return () => {
      attachWebview(null)
      el.remove()
    }
  }, [preload, initialSrc, attachWebview])

  useEffect(() => {
    const wv = wvEl
    if (!wv) return

    // all loadURL calls funnel through syncUrl: they throw before dom-ready, so
    // a bounded retry re-arms until the webview accepts calls. the initial probe
    // matters because dom-ready can fire before our listeners attach (StrictMode
    // remount) — without it the tab would never become ready.
    const syncUrl = (): void => {
      const target = desiredUrl()
      if (!target) return
      try {
        if (wv.getURL() !== target) wv.loadURL(target).catch(() => {})
        retriesRef.current = 0
      } catch {
        if (retryTimerRef.current === undefined && retriesRef.current < 60) {
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = undefined
            retriesRef.current += 1
            syncUrl()
          }, 100)
        }
      }
    }

    const onNav = (e: Electron.DidNavigateEvent | Electron.DidNavigateInPageEvent): void => {
      setError(null)
      const st = useStore.getState()
      const p = paneAt(wsId, paneId)
      if (!p) return
      const tabs = p.tabs.map((t) => (t.id === tab.id ? { ...t, url: e.url } : t))
      st.updatePane(paneId, { tabs }, wsId)
      reportNav()
    }
    const onNavInPage = (e: Electron.DidNavigateInPageEvent): void => {
      if (e.isMainFrame) onNav(e)
    }
    const onTitle = (e: Electron.PageTitleUpdatedEvent): void => {
      if (!e.title) return
      const st = useStore.getState()
      const p = paneAt(wsId, paneId)
      if (!p) return
      const tabs = p.tabs.map((t) => (t.id === tab.id ? { ...t, title: e.title } : t))
      st.updatePane(paneId, { tabs }, wsId)
    }
    const onFailLoad = (e: Electron.DidFailLoadEvent): void => {
      // -3 = ERR_ABORTED (stopped/superseded load) — not a real failure
      if (!e.isMainFrame || e.errorCode === -3) return
      setError(`${e.errorDescription} (${e.errorCode})`)
      reportNav()
    }
    const onStartLoading = (): void => {
      setError(null)
      reportNav()
    }
    const onGone = (): void =>
      setError(translate(useStore.getState().settings.language, 'pageCrashed'))
    const onNewWindow = (e: Event): void => {
      window.mahas.openExternal((e as unknown as { url: string }).url)
    }

    wv.addEventListener('dom-ready', syncUrl)
    wv.addEventListener('dom-ready', reportNav)
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNavInPage)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('did-start-loading', onStartLoading)
    wv.addEventListener('did-stop-loading', reportNav)
    wv.addEventListener('did-fail-load', onFailLoad)
    wv.addEventListener('render-process-gone', onGone)
    wv.addEventListener('new-window', onNewWindow as EventListener)
    syncRef.current = syncUrl
    // dom-ready may already have fired (StrictMode remount) — probe now
    syncUrl()
    reportNav()

    // push the effective keybinding list so the guest preload forwards custom
    // (non-Alt) combos too — re-runs when the user edits bindings
    const pushBindings = (): void => {
      try {
        wv.send('mahas:bindings', Object.values(effectiveBindings(useStore.getState().settings)))
      } catch {
        /* not dom-ready yet — the listener below covers the initial attach */
      }
    }
    wv.addEventListener('dom-ready', pushBindings)
    pushBindings()
    return () => {
      wv.removeEventListener('dom-ready', pushBindings)
      syncRef.current = () => {}
      if (retryTimerRef.current !== undefined) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = undefined
      }
      wv.removeEventListener('dom-ready', syncUrl)
      wv.removeEventListener('dom-ready', reportNav)
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNavInPage)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('did-start-loading', onStartLoading)
      wv.removeEventListener('did-stop-loading', reportNav)
      wv.removeEventListener('did-fail-load', onFailLoad)
      wv.removeEventListener('render-process-gone', onGone)
      wv.removeEventListener('new-window', onNewWindow as EventListener)
    }
  }, [wsId, paneId, tab.id, desiredUrl, reportNav, wvEl, bindings])

  // desired url lives in the store — re-sync the webview when it changes
  useEffect(() => {
    syncRef.current()
  }, [tab.url])

  // ── floating header: nav + bookmarks + omnibox, per-block local state ──
  const [urlInput, setUrlInput] = useState(() => toInput(tab.url))
  // omnibox follows navigations written to the store — adjust during render
  const desiredInput = toInput(tab.url)
  const [lastSynced, setLastSynced] = useState(desiredInput)
  if (desiredInput !== lastSynced) {
    setLastSynced(desiredInput)
    setUrlInput(desiredInput)
  }

  const withWv = (fn: (wv: Electron.WebviewTag) => void): void => {
    const wv = wvRef.current
    if (!wv) return
    try {
      fn(wv)
    } catch {
      /* not attached yet */
    }
  }

  // navigate by writing the desired url to the store — the webview syncs
  // from there (handles dom-ready timing on its own)
  const navigate = (url: string): void => {
    if (tab.url === url) {
      withWv((wv) => wv.reload())
      return
    }
    const p = paneAt(wsId, paneId)
    if (!p) return
    useStore
      .getState()
      .updatePane(paneId, { tabs: p.tabs.map((x) => (x.id === tab.id ? { ...x, url } : x)) }, wsId)
  }

  const go = (): void => {
    const url = normalizeUrl(urlInput)
    setUrlInput(url)
    navigate(url)
  }

  // a bookmark's "open in new tab" stacks a web block into this leaf
  const openBookmark = (url: string, newTab: boolean): void => {
    if (!newTab) {
      navigate(url)
      return
    }
    const p = paneAt(wsId, paneId)
    if (!p) return
    const nt: BrowserTab = { kind: 'web', id: crypto.randomUUID(), url, title: '' }
    useStore.getState().updatePane(paneId, { tabs: [...p.tabs, nt], activeTabId: nt.id }, wsId)
  }

  return (
    <div className="browser-tabview">
      <div className="browser-body" ref={hostRef} />
      <div className="web-head" onPointerDown={(e) => e.stopPropagation()}>
        <BookmarkMenu
          tab={tab}
          projectId={project?.id}
          projectName={project?.name}
          onOpen={openBookmark}
        />
        <Tooltip label={t('back')}>
          <button
            className="pbtn"
            disabled={!meta.canBack}
            onClick={() => withWv((wv) => wv.goBack())}
          >
            <ArrowLeft />
          </button>
        </Tooltip>
        <Tooltip label={t('forward')}>
          <button
            className="pbtn"
            disabled={!meta.canFwd}
            onClick={() => withWv((wv) => wv.goForward())}
          >
            <ArrowRight />
          </button>
        </Tooltip>
        {meta.loading ? (
          <Tooltip label={t('stop')}>
            <button className="pbtn" onClick={() => withWv((wv) => wv.stop())}>
              <X />
            </button>
          </Tooltip>
        ) : (
          <Tooltip label={t('reload')}>
            <button className="pbtn" onClick={() => withWv((wv) => wv.reload())}>
              <RotateCw />
            </button>
          </Tooltip>
        )}
        <input
          className="url-input"
          value={urlInput}
          placeholder={t('urlOrSearch')}
          spellCheck={false}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
          onPointerDown={(e) => e.stopPropagation()}
        />
      </div>
      {error && (
        <div className="browser-err">
          <Globe size={20} />
          <span className="err-title">{t('pageFailed')}</span>
          <span className="err-detail">{error}</span>
          <button
            onClick={() => {
              setError(null)
              try {
                wvRef.current?.reload()
              } catch {
                /* not attached yet */
              }
            }}
          >
            {t('retry')}
          </button>
        </div>
      )}
    </div>
  )
}
