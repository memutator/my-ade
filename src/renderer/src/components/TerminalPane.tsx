import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ILink, ILinkProvider } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Plus, RotateCw, TerminalSquare } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import type { TerminalPaneState, TerminalTab } from '../types'
import { useStore } from '../store'
import { agentLabel } from '../agents'
import { shortPath } from '../utils'
import AgentIcon from './AgentIcon'
import { useT, translate } from '../i18n'
import Tooltip from './Tooltip'
import PaneFrame from './PaneFrame'
import TabStrip, { type TabItem } from './TabStrip'

const TERM_THEME = {
  dark: {
    background: '#151516',
    foreground: '#ececef',
    cursor: '#7aa2f7',
    cursorAccent: '#0e1114',
    selectionBackground: '#2a3444',
    selectionInactiveBackground: '#1d2129'
  },
  light: {
    background: '#f6f6f7',
    foreground: '#1e2126',
    cursor: '#4f6ef7',
    cursorAccent: '#fbfbfc',
    selectionBackground: '#d4dbf8',
    selectionInactiveBackground: '#e3e6ea'
  }
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// ── terminal → pane links ────────────────────────────────────────────────

// Whitespace-delimited candidate tokens; per-token rules in extractPath decide
// what really looks like a file path.
const PATH_TOKEN_RE = /[^\s'"`()[\]{}<>|;&*]+/g

// Extensionless basenames worth linking.
const KNOWN_BASENAMES = new Set([
  'makefile',
  'dockerfile',
  'containerfile',
  'vagrantfile',
  'jenkinsfile',
  'gemfile',
  'rakefile',
  'justfile',
  'procfile',
  'brewfile',
  'license',
  'licence',
  'readme',
  'changelog',
  'copying',
  'notice',
  'authors',
  'contributors'
])

function looksLikePath(p: string): boolean {
  if (!p || /^(\/|~|~\/|\.{1,2}|\.{1,2}\/)$/.test(p)) return false
  if (p.startsWith('/') || p.startsWith('~/') || p.startsWith('./') || p.startsWith('../'))
    return true
  if (p.includes('/')) return true
  if (/^\.[\w@+-][\w@+.-]*$/.test(p)) return true // dotfiles: .env, .gitignore
  // name.ext — single-char extensions need a stem of 2+ chars (skip "e.g")
  const ext = /\.([A-Za-z][A-Za-z0-9]{0,14})$/.exec(p)
  if (ext && (ext[1].length > 1 || p.length - ext[1].length >= 3)) return true
  return KNOWN_BASENAMES.has(p.toLowerCase())
}

// Extract a linkable path from a raw token: strips leading/trailing junk and an
// optional `:line[:col]` suffix. Returns the path text plus its bounds inside
// `token` (bounds include the suffix), or null.
function extractPath(token: string): { path: string; start: number; end: number } | null {
  let lo = 0
  let hi = token.length
  const lead = /^[^~\w./-]+/.exec(token)
  if (lead) lo = lead[0].length
  const trail = /[,.;:!?]+$/.exec(token)
  if (trail) hi -= trail[0].length
  if (lo >= hi) return null
  let p = token.slice(lo, hi)

  // file:// URIs open in the editor; other schemes belong to the web-links addon
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname)
    } catch {
      return null
    }
    return looksLikePath(p) ? { path: p, start: lo, end: hi } : null
  }
  if (/^[\w.+-]+:\/\//.test(p) || /^(mailto|tel|data|javascript):/i.test(p)) return null

  const lm = /^(.*?):\d+(?::\d+)?$/.exec(p)
  if (lm?.[1]) p = lm[1]
  // `key=path` / `--flag=path` — prefer the part after '=' when it is pathy
  const eq = p.lastIndexOf('=')
  if (eq >= 0) {
    const q = p.slice(eq + 1)
    if (looksLikePath(q)) {
      lo += eq + 1
      p = q
    }
  }
  return looksLikePath(p) ? { path: p, start: lo, end: hi } : null
}

// Resolve against the owning tab's live cwd and open in the workspace's editor.
function openLinkedPath(raw: string, wsId: string, paneId: string, tabId: string): void {
  const cwd = terminalPane(wsId, paneId)?.tabs?.find((t) => t.id === tabId)?.cwd
  window.ade.fs
    .resolvePath(raw, cwd)
    .then((abs) => {
      if (!abs) return
      useStore.getState().openFileInEditor(abs, abs.split('/').pop() ?? abs, wsId)
    })
    .catch(() => {})
}

/** event handlers outlive props — always read the pane fresh from the store */
function terminalPane(wsId: string, paneId: string): TerminalPaneState | null {
  const w = useStore.getState().workspaces.find((x) => x.id === wsId)
  const p = w?.panes[paneId]
  return p?.type === 'terminal' ? p : null
}

// pty events arrive keyed by session id (paneId:tabId:uuid) — route the state
// write to the tab that owns the session, never to the pane as a whole
function patchTerminalTab(
  wsId: string,
  paneId: string,
  tabId: string,
  patch: Partial<TerminalTab>
): void {
  const st = useStore.getState()
  const p = terminalPane(wsId, paneId)
  if (!p || !(p.tabs ?? []).some((x) => x.id === tabId)) return
  st.updatePane(
    paneId,
    { tabs: (p.tabs ?? []).map((x) => (x.id === tabId ? { ...x, ...patch } : x)) },
    wsId
  )
}

function makePathLinkProvider(
  term: Terminal,
  wsId: string,
  paneId: string,
  tabId: string
): ILinkProvider {
  return {
    provideLinks: (bufferLineNumber, callback) => {
      const buf = term.buffer.active
      const line = buf.getLine(bufferLineNumber - 1) // provider lines are 1-based
      const text = line?.translateToString(true)
      if (!line || !text) {
        callback(undefined)
        return
      }

      // string index → cell column (wide chars span multiple cells)
      const col = new Array<number>(text.length)
      const cell = buf.getNullCell()
      let si = 0
      for (let x = 0; x < line.length && si < text.length; x++) {
        const c = line.getCell(x, cell)
        if (!c || c.getWidth() === 0) continue
        const n = c.getChars().length || 1
        for (let k = 0; k < n && si + k < text.length; k++) col[si + k] = x
        si += n
      }

      const links: ILink[] = []
      for (const m of text.matchAll(PATH_TOKEN_RE)) {
        const r = extractPath(m[0])
        if (!r) continue
        const s = (m.index ?? 0) + r.start
        const e = (m.index ?? 0) + r.end - 1
        links.push({
          range: {
            start: { x: (col[s] ?? s) + 1, y: bufferLineNumber },
            end: { x: (col[e] ?? e) + 1, y: bufferLineNumber }
          },
          text: r.path,
          activate: () => openLinkedPath(r.path, wsId, paneId, tabId)
        })
      }
      callback(links.length ? links : undefined)
    }
  }
}

/**
 * One xterm + pty session per tab. Inactive tabs stay mounted (their wrapper
 * uses the `hidden` attribute) so shells keep running; the ResizeObserver
 * refits when a tab becomes visible again.
 */
function TerminalTabView({
  wsId,
  paneId,
  tabId,
  projectPath,
  active,
  epoch,
  focused,
  onRestart
}: {
  wsId: string
  paneId: string
  tabId: string
  projectPath?: string
  active: boolean
  epoch: number
  focused: boolean
  onRestart: () => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const lastAgentRef = useRef<string | null>(null)
  const resolvedTheme = useStore((s) => s.resolvedTheme)
  const termFont = useStore((s) => s.settings.termFont)
  const termFontSize = useStore((s) => s.settings.termFontSize)
  const exited = useStore((s) => {
    const w = s.workspaces.find((x) => x.id === wsId)
    const p = w?.panes[paneId]
    return (p?.type === 'terminal' && (p.tabs ?? []).find((x) => x.id === tabId)?.exited) ?? false
  })
  const t = useT()

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: useStore.getState().settings.termFont,
      fontSize: useStore.getState().settings.termFontSize,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      theme: TERM_THEME[useStore.getState().resolvedTheme]
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // click a URL → a browser pane in this workspace; click a file path → an
    // editor pane (resolved against the tab's live cwd at click time)
    term.loadAddon(new WebLinksAddon((_e, uri) => useStore.getState().openUrlInBrowser(uri, wsId)))
    term.registerLinkProvider(makePathLinkProvider(term, wsId, paneId, tabId))
    term.open(host)
    try {
      fit.fit()
    } catch {
      /* hidden container — refit on resize */
    }
    termRef.current = term
    fitRef.current = fit

    // Session identity lives on the tab: remounts (float/detach transitions,
    // StrictMode, HMR) re-attach to the same pty-host session — scrollback
    // replays via the host's tail buffer. A fresh tab gets a fresh id.
    const existingPty = terminalPane(wsId, paneId)?.tabs.find((x) => x.id === tabId)?.pty
    const id = existingPty ?? `${paneId}:${tabId}:${crypto.randomUUID()}`

    const refit = (): void => {
      try {
        fit.fit()
        window.ade.pty.resize(id, term.cols, term.rows)
      } catch {
        /* not visible yet */
      }
    }

    // Cell metrics can change once fonts finish loading — refit so the xterm
    // screen actually fills the host instead of leaving a bare strip.
    let disposed = false
    document.fonts?.ready.then(() => {
      if (!disposed) refit()
    })
    const raf = requestAnimationFrame(refit)

    const offData = term.onData((d) => window.ade.pty.write(id, d))
    const offEvent = window.ade.pty.onEvent((e) => {
      if (e.id !== id) return
      if (e.t === 'data' && e.d) term.write(decode(e.d))
      else if (e.t === 'spawned' && e.shell)
        // fresh shell: clear exited and any stale agent label from the old session
        patchTerminalTab(wsId, paneId, tabId, {
          shell: e.shell,
          exited: false,
          agent: null,
          pty: id
        })
      else if (e.t === 'attached')
        // reattached to a live session — adopt its recorded state
        patchTerminalTab(wsId, paneId, tabId, {
          shell: e.shell,
          cwd: e.cwd ?? undefined,
          agent: e.agent ?? null,
          exited: false,
          pty: id
        })
      else if (e.t === 'cwd' && e.cwd) patchTerminalTab(wsId, paneId, tabId, { cwd: e.cwd })
      else if (e.t === 'exit') patchTerminalTab(wsId, paneId, tabId, { exited: true, agent: null })
      else if (e.t === 'error')
        term.writeln(
          `\r\n[${translate(useStore.getState().settings.language, 'ptyError')}] ${e.msg ?? ''}`
        )
      else if (e.t === 'agent') {
        const prev = lastAgentRef.current
        lastAgentRef.current = e.agent ?? null
        patchTerminalTab(wsId, paneId, tabId, { agent: e.agent ?? null })
        // agent → idle transition = completion
        if (prev && !e.agent) {
          const st = useStore.getState()
          if (st.settings.providers[prev] === false) return
          const ws = st.workspaces.find((w) => w.id === wsId)
          const lp = ws?.panes[paneId]
          const thisTab = lp?.type === 'terminal' ? lp.tabs.find((t) => t.id === tabId) : undefined
          const title = translate(st.settings.language, 'agentFinished', {
            agent: agentLabel(prev)
          })
          const session = thisTab?.title ?? (thisTab?.cwd ? shortPath(thisTab.cwd) : undefined)
          st.notify({ workspaceId: wsId, paneId, tabId, title, session, agent: prev })
          if (st.settings.osNotifications) {
            window.ade.notify.show(title, session ?? '', {
              workspaceId: wsId,
              paneId,
              tabId
            })
          }
        }
      }
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        window.ade.pty.resize(id, term.cols, term.rows)
      } catch {
        /* not visible yet */
      }
    })
    ro.observe(host)

    // attach → reuse the live session (host replays its scrollback tail);
    // fall back to a fresh spawn under the same id when it's gone
    if (existingPty) {
      window.ade.pty
        .attach(id, term.cols, term.rows)
        .then((ok) => {
          if (!ok && !disposed) {
            window.ade.pty.spawn({ id, cols: term.cols, rows: term.rows, cwd: projectPath })
          }
        })
        .catch(() => {})
    } else {
      window.ade.pty.spawn({ id, cols: term.cols, rows: term.rows, cwd: projectPath })
    }

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      offEvent()
      offData.dispose()
      term.dispose()
      // keep the session alive when the pane is detached (the detached
      // window owns it) — remounts attach back to it; everything else
      // (tab close, pane close) kills it as before
      const pane = useStore.getState().workspaces.find((x) => x.id === wsId)?.panes[paneId]
      if (!pane?.detached) window.ade.pty.kill(id)
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, tabId, wsId, epoch])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = TERM_THEME[resolvedTheme]
  }, [resolvedTheme])

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontFamily = termFont
      termRef.current.options.fontSize = termFontSize
      try {
        fitRef.current?.fit()
      } catch {
        /* hidden */
      }
    }
  }, [termFont, termFontSize])

  useEffect(() => {
    if (focused && active) termRef.current?.focus()
  }, [focused, active])

  return (
    <>
      <div className="term-host" ref={hostRef} onClick={() => termRef.current?.focus()} />
      {exited && (
        <div className="term-exited" onClick={onRestart}>
          {t('processExited')}
        </div>
      )}
    </>
  )
}

export default function TerminalPane({
  pane,
  wsId,
  projectPath
}: {
  pane: TerminalPaneState
  wsId: string
  projectPath?: string
}): React.JSX.Element {
  const updatePane = useStore((s) => s.updatePane)
  const closePane = useStore((s) => s.closePane)
  const focused = useStore((s) => {
    const w = s.workspaces.find((x) => x.id === wsId)
    return s.activeWorkspaceId === wsId && w?.focusedPaneId === pane.id
  })
  // per-tab restart counter — bumping re-runs the tab's spawn effect
  const [epochs, setEpochs] = useState<Record<string, number>>({})
  const t = useT()

  const tabs = pane.tabs ?? []
  const activeTab = tabs.find((x) => x.id === pane.activeTabId) ?? tabs[0]
  const activeTabId = activeTab?.id ?? null

  // clearing the session id first makes the remount spawn a fresh shell —
  // otherwise it would attach right back to the session being "restarted"
  const restartTab = (tabId: string): void => {
    patchTerminalTab(wsId, pane.id, tabId, { pty: undefined })
    setEpochs((m) => ({ ...m, [tabId]: (m[tabId] ?? 0) + 1 }))
  }

  // a new tab spawns a fresh shell in the workspace project dir — same cwd a
  // brand-new terminal pane would get
  const newTab = (): void => {
    const tab: TerminalTab = { id: crypto.randomUUID() }
    updatePane(pane.id, { tabs: [...tabs, tab], activeTabId: tab.id }, wsId)
  }

  const closeTab = (tabId: string): void => {
    const next = tabs.filter((x) => x.id !== tabId)
    // closing the last tab closes the pane — a terminal without a shell is dead
    // weight; unmounting the pane kills the pty via the tab view's cleanup
    if (next.length === 0) {
      closePane(pane.id, wsId)
      return
    }
    const keep = activeTabId && activeTabId !== tabId ? activeTabId : next.at(-1)!.id
    updatePane(pane.id, { tabs: next, activeTabId: keep }, wsId)
  }

  const renameTab = (tabId: string, name: string): void => {
    const title = name.trim()
    patchTerminalTab(wsId, pane.id, tabId, { title: title || undefined })
    // session-rename hook: if a harness session was observed for this tab,
    // propagate the name through the real event channel so the session
    // registry (and every ade instance) learns it — powers the "which
    // session" line in notifications
    const st = useStore.getState()
    const lp = st.workspaces.find((w) => w.id === wsId)?.panes[pane.id]
    const tab = lp?.type === 'terminal' ? lp.tabs.find((t) => t.id === tabId) : undefined
    const sid = Object.entries(st.agentSessions).find(
      ([, i]) => i.tabId === tabId && i.wsId === wsId
    )?.[0]
    if (sid) {
      st.renameAgentSession(sid, title)
      void window.ade.hooks.emit?.({
        provider: tab?.agent ?? st.agentSessions[sid]?.provider ?? 'unknown',
        event: 'session-rename',
        sessionId: sid,
        cwd: tab?.cwd,
        name: title || undefined
      })
    }
  }

  const reorderTabs = (from: number, to: number): void => {
    const next = [...tabs]
    const [m] = next.splice(from, 1)
    next.splice(to, 0, m)
    updatePane(pane.id, { tabs: next }, wsId)
  }

  const items: TabItem[] = tabs.map((tab) => ({
    id: tab.id,
    label: tab.title ?? (tab.agent ? agentLabel(tab.agent) : (tab.shell ?? t('terminal'))),
    sub: tab.cwd ? shortPath(tab.cwd) : undefined,
    icon: tab.agent ? <AgentIcon id={tab.agent} size={16} /> : undefined,
    dirty: tab.exited,
    dotTip: t('shellExited')
  }))

  return (
    <PaneFrame
      pane={pane}
      wsId={wsId}
      icon={<TerminalSquare className="picon" />}
      title={
        <div className="pane-tabs">
          <TabStrip
            tabs={items}
            activeId={activeTabId}
            onActivate={(id) => updatePane(pane.id, { activeTabId: id }, wsId)}
            onClose={closeTab}
            onRename={renameTab}
            onReorder={reorderTabs}
          />
        </div>
      }
      extraActions={
        <>
          {activeTab?.exited && (
            <Tooltip label={t('restartShell')}>
              <button className="pbtn" onClick={() => restartTab(activeTab.id)}>
                <RotateCw />
              </button>
            </Tooltip>
          )}
          <Tooltip label={t('newTerminalTab')}>
            <button className="pbtn" onClick={newTab}>
              <Plus />
            </button>
          </Tooltip>
        </>
      }
    >
      {tabs.map((tab) => (
        <div key={tab.id} className="term-tab" hidden={tab.id !== activeTabId}>
          <TerminalTabView
            wsId={wsId}
            paneId={pane.id}
            tabId={tab.id}
            projectPath={projectPath}
            active={tab.id === activeTabId}
            epoch={epochs[tab.id] ?? 0}
            focused={focused}
            onRestart={() => restartTab(tab.id)}
          />
        </div>
      ))}
    </PaneFrame>
  )
}
