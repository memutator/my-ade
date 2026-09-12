import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ILink, ILinkProvider } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { RotateCw, TerminalSquare } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import type { TerminalPaneState } from '../types'
import { useStore } from '../store'
import { agentLabel } from '../agents'
import PaneFrame from './PaneFrame'

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

function shortPath(p: string): string {
  const home = '/home/'
  if (p.startsWith(home)) return '~/' + p.slice(home.length).split('/').slice(1).join('/')
  return p
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

// Resolve against the terminal's live cwd and open in the workspace's editor.
function openLinkedPath(raw: string, wsId: string, paneId: string): void {
  const st = useStore.getState()
  const p = st.workspaces.find((w) => w.id === wsId)?.panes[paneId]
  const cwd = p?.type === 'terminal' ? p.cwd : undefined
  window.ade.fs
    .resolvePath(raw, cwd)
    .then((abs) => {
      if (!abs) return
      useStore.getState().openFileInEditor(abs, abs.split('/').pop() ?? abs, wsId)
    })
    .catch(() => {})
}

function makePathLinkProvider(term: Terminal, wsId: string, paneId: string): ILinkProvider {
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
          activate: () => openLinkedPath(r.path, wsId, paneId)
        })
      }
      callback(links.length ? links : undefined)
    }
  }
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
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const lastAgentRef = useRef<string | null>(null)
  const resolvedTheme = useStore((s) => s.resolvedTheme)
  const termFont = useStore((s) => s.settings.termFont)
  const termFontSize = useStore((s) => s.settings.termFontSize)
  const focused = useStore((s) => {
    const w = s.workspaces.find((x) => x.id === wsId)
    return s.activeWorkspaceId === wsId && w?.focusedPaneId === pane.id
  })
  const updatePane = useStore((s) => s.updatePane)
  const [epoch, setEpoch] = useState(0)

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
    // editor pane (resolved against the pane's live cwd at click time)
    term.loadAddon(new WebLinksAddon((_e, uri) => useStore.getState().openUrlInBrowser(uri, wsId)))
    term.registerLinkProvider(makePathLinkProvider(term, wsId, pane.id))
    term.open(host)
    try {
      fit.fit()
    } catch {
      /* hidden container — refit on resize */
    }
    termRef.current = term
    fitRef.current = fit

    // Unique session per mount: events from a previous (killed) pty must not
    // leak into this mount (StrictMode remount / HMR).
    const id = `${pane.id}:${crypto.randomUUID()}`
    window.ade.pty.spawn({ id, cols: term.cols, rows: term.rows, cwd: projectPath })

    const offData = term.onData((d) => window.ade.pty.write(id, d))
    const offEvent = window.ade.pty.onEvent((e) => {
      if (e.id !== id) return
      if (e.t === 'data' && e.d) term.write(decode(e.d))
      else if (e.t === 'spawned' && e.shell)
        updatePane(pane.id, { shell: e.shell, exited: false }, wsId)
      else if (e.t === 'cwd' && e.cwd) updatePane(pane.id, { cwd: e.cwd }, wsId)
      else if (e.t === 'exit') updatePane(pane.id, { exited: true }, wsId)
      else if (e.t === 'error') term.writeln(`\r\n[pty error] ${e.msg ?? ''}`)
      else if (e.t === 'agent') {
        const prev = lastAgentRef.current
        lastAgentRef.current = e.agent ?? null
        updatePane(pane.id, { agent: e.agent ?? null }, wsId)
        // agent → idle transition = completion
        if (prev && !e.agent) {
          const st = useStore.getState()
          if (st.settings.providers[prev] === false) return
          const ws = st.workspaces.find((w) => w.id === wsId)
          const title = `${agentLabel(prev)} finished`
          const body = ws ? ws.name : ''
          st.notify({ workspaceId: wsId, paneId: pane.id, title, body })
          if (st.settings.osNotifications) {
            window.ade.notify.show(title, body, { workspaceId: wsId, paneId: pane.id })
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

    return () => {
      ro.disconnect()
      offEvent()
      offData.dispose()
      term.dispose()
      window.ade.pty.kill(id)
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, wsId, epoch])

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
    if (focused) termRef.current?.focus()
  }, [focused])

  const title = pane.cwd ? `${pane.shell ?? 'sh'} · ${shortPath(pane.cwd)}` : pane.title

  return (
    <PaneFrame
      pane={pane}
      wsId={wsId}
      icon={<TerminalSquare className="picon" />}
      title={<span className="pane-title">{title}</span>}
      extraActions={
        pane.exited ? (
          <button className="pbtn" title="Restart shell" onClick={() => setEpoch((n) => n + 1)}>
            <RotateCw />
          </button>
        ) : undefined
      }
    >
      <div className="term-host" ref={hostRef} onClick={() => termRef.current?.focus()} />
      {pane.exited && (
        <div className="term-exited" onClick={() => setEpoch((n) => n + 1)}>
          process exited — click to restart
        </div>
      )}
    </PaneFrame>
  )
}
