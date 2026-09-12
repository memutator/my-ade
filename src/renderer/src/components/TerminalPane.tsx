import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
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
