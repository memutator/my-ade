import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { PaneState, TerminalTab } from '../types'
import { useStore, patchTerminalTab, linkTargetPane } from '../store'
import { reportProcessIdle, reportAgentError } from '../attention'
import { useT, translate } from '../i18n'
import { isDetachedWin } from '../detached'
import { decode, utf8 } from '../features/terminal/codec'
import { ErrorBannerScanner } from '../features/terminal/errorScan'
import { makePathLinkProvider } from '../features/terminal/links'
import { WorkingPulse } from '../features/terminal/workingPulse'
import { newSessionId, shellTransport } from '../features/terminal/transport'
import { TERM_THEME } from '../features/terminal/theme'
import { CtxMenu } from './Menu'

/** event handlers outlive props — always read the pane fresh from the store */
function paneAt(wsId: string, paneId: string): PaneState | undefined {
  return useStore.getState().workspaces.find((x) => x.id === wsId)?.panes[paneId]
}

// The leaf a link opens into — a content pane, never the clicked terminal's
// own (see linkTargetPane); undefined when no other leaf exists
function linkTarget(wsId: string, paneId: string): string | undefined {
  const w = useStore.getState().workspaces.find((x) => x.id === wsId)
  return w ? linkTargetPane(w, paneId) : undefined
}

// Resolve against the owning tab's live cwd and open in the workspace — the
// file tab stacks into a sibling content leaf, not this tab's own
function openLinkedPath(raw: string, wsId: string, paneId: string, tabId: string): void {
  const cwd = paneAt(wsId, paneId)?.tabs.find(
    (t): t is TerminalTab => t.id === tabId && t.kind === 'term'
  )?.cwd
  window.mahas.fs
    .resolvePath(raw, cwd)
    .then((abs) => {
      if (!abs) return
      useStore
        .getState()
        .openFile(abs, abs.split('/').pop() ?? abs, wsId, false, linkTarget(wsId, paneId))
    })
    .catch(() => {})
}

/**
 * One xterm + pty session per tab. Inactive tabs stay mounted (their wrapper
 * uses the `hidden` attribute) so shells keep running; the ResizeObserver
 * refits when a tab becomes visible again.
 */
export function TerminalTabView({
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
  // the working pulse + error-banner scan are per-view state machines over
  // the pty byte stream — see features/terminal/{workingPulse,errorScan}.ts.
  // Built inside the mount effect (a ref written during render is not
  // allowed and would race a StrictMode double-invoke).
  const pulseRef = useRef<WorkingPulse | null>(null)
  const errScanRef = useRef<ErrorBannerScanner | null>(null)
  const resolvedTheme = useStore((s) => s.resolvedTheme)
  const termFont = useStore((s) => s.settings.termFont)
  const termFontSize = useStore((s) => s.settings.termFontSize)
  const exited = useStore((s) => {
    const p = s.workspaces.find((x) => x.id === wsId)?.panes[paneId]
    return (
      p?.tabs.find((x): x is TerminalTab => x.id === tabId && x.kind === 'term')?.exited ?? false
    )
  })
  const t = useT()
  const [ctx, setCtx] = useState<{ x: number; y: number; sel: boolean } | null>(null)

  const copySelection = (): void => {
    const term = termRef.current
    if (term?.hasSelection()) void window.mahas.clipboard.write(term.getSelection())
  }
  const pasteClipboard = (): void => {
    void window.mahas.clipboard.read().then((s) => s && termRef.current?.paste(s))
  }

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
    term.loadAddon(
      new WebLinksAddon((_e, uri) =>
        // newTab: a link always stacks a fresh web block into the content
        // leaf — never navigates the tab it happens to have active
        useStore.getState().openUrlInBrowser(uri, wsId, true, linkTarget(wsId, paneId))
      )
    )
    term.registerLinkProvider(
      makePathLinkProvider(term, (raw) => openLinkedPath(raw, wsId, paneId, tabId))
    )
    // clipboard chords — xterm forwards every key to the pty, so copy/paste
    // is intercepted before it sees them. Any copy chord (Ctrl+Shift+C,
    // Cmd+C, or plain Ctrl+C) copies the selection; plain Ctrl+C with no
    // selection stays SIGINT and falls through to the pty.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const k = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && !e.altKey && k === 'c') {
        if (term.hasSelection()) {
          e.preventDefault() // else Chromium fires 'copy' on the textarea too
          void window.mahas.clipboard.write(term.getSelection())
          return false
        }
        return e.ctrlKey && !e.shiftKey && !e.metaKey
      }
      if (!e.altKey && k === 'v' && ((e.ctrlKey && e.shiftKey) || e.metaKey)) {
        // returning false only skips xterm's key handling — the keydown's
        // default action still dispatches 'paste' on the textarea and xterm's
        // own paste listener writes the clipboard a second time. Cancel it.
        e.preventDefault()
        void window.mahas.clipboard.read().then((s) => s && term.paste(s))
        return false
      }
      return true
    })
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
    const existingPty = paneAt(wsId, paneId)?.tabs.find(
      (x): x is TerminalTab => x.id === tabId && x.kind === 'term'
    )?.pty
    const id = existingPty ?? newSessionId(paneId, tabId)

    const refit = (): void => {
      try {
        fit.fit()
        shell.resize(id, term.cols, term.rows)
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

    // the unmanaged shell transport — managed executions never flow through
    // here (see features/terminal/transport.ts)
    const shell = shellTransport()
    const pulse = new WorkingPulse((t) => patchTerminalTab(wsId, paneId, tabId, t))
    const errScan = new ErrorBannerScanner()
    pulseRef.current = pulse
    errScanRef.current = errScan

    const clearWorking = (): void => pulse.clear()
    const emitErrorBanner = (msg: string): void => {
      const provider = lastAgentRef.current
      if (!provider) return
      const clipped = msg.replace(/\s+/g, ' ').trim().slice(0, 300)
      if (!clipped) return
      if (isDetachedWin)
        window.mahas.win.paneCmd({
          action: 'agentError',
          wsId,
          paneId,
          tabId,
          provider,
          message: clipped
        })
      else reportAgentError(provider, wsId, paneId, tabId, clipped)
    }
    /** the store is the single source — attention.ts can clear the flag on
     *  hook events, so the pulse reads the tab record instead of mirroring it */
    const termRec = (): TerminalTab | undefined =>
      paneAt(wsId, paneId)?.tabs.find((x): x is TerminalTab => x.id === tabId && x.kind === 'term')
    const noteOutput = (): void => pulse.noteOutput(termRec())
    const noteErrorBanner = (chunk: string): void => {
      // attach replay is history — the scanner is reset on attach, so a
      // historical banner never re-fires
      const msg = errScan.push(chunk)
      if (msg) emitErrorBanner(msg)
    }

    const offData = term.onData((d) => {
      // typing isn't work — composer echoes can't keep a burst alive, else
      // composing a long prompt would itself read as a turn
      pulse.noteInput()
      if (termRec()?.idleLocked) patchTerminalTab(wsId, paneId, tabId, { idleLocked: false })
      shell.write(id, d)
    })
    const offEvent = shell.onEvent((e) => {
      if (e.id !== id) return
      if (e.t === 'data' && e.d) {
        const bytes = decode(e.d)
        term.write(bytes)
        noteOutput()
        noteErrorBanner(utf8.decode(bytes))
      } else if (e.t === 'spawned' && e.shell) {
        // fresh shell: clear exited and any stale agent label from the old session
        clearWorking()
        patchTerminalTab(wsId, paneId, tabId, {
          shell: e.shell,
          exited: false,
          agent: null,
          working: false,
          workingSince: undefined,
          turnEndedAt: undefined,
          idleLocked: true,
          pty: id
        })
      } else if (e.t === 'attached') {
        // reattached to a live session — adopt its recorded state; the
        // replayed tail must not trip the working light. Seeding
        // lastAgentRef matters: without it a remount loses the agent→idle
        // transition (prev reads null) AND output can't light `working`
        // until the next agent event
        pulse.noteReplay()
        lastAgentRef.current = e.agent ?? null
        pulse.agent = e.agent ?? null
        errScan.reset()
        clearWorking()
        patchTerminalTab(wsId, paneId, tabId, {
          shell: e.shell,
          cwd: e.cwd ?? undefined,
          agent: e.agent ?? null,
          exited: false,
          working: false,
          pty: id
        })
      } else if (e.t === 'cwd' && e.cwd) patchTerminalTab(wsId, paneId, tabId, { cwd: e.cwd })
      else if (e.t === 'exit') {
        clearWorking()
        patchTerminalTab(wsId, paneId, tabId, { exited: true, agent: null, working: false })
      } else if (e.t === 'error')
        term.writeln(
          `\r\n[${translate(useStore.getState().settings.language, 'ptyError')}] ${e.msg ?? ''}`
        )
      else if (e.t === 'agent') {
        const prev = lastAgentRef.current
        lastAgentRef.current = e.agent ?? null
        pulse.agent = e.agent ?? null
        patchTerminalTab(wsId, paneId, tabId, {
          agent: e.agent ?? null,
          // a freshly detected agent is mid-launch — its startup banner / idle
          // TUI is output but not a turn. quietUntil covers the first paint;
          // idleLocked covers Codex-style frame loops that never go quiet.
          ...(!prev && e.agent ? { quietUntil: Date.now() + 1200, idleLocked: true } : {}),
          ...(e.agent ? {} : { working: false, idleLocked: true })
        })
        if (!e.agent) clearWorking()
        // agent → idle transition = completion fallback. In a detached window
        // the notification list lives in the main renderer — relay there.
        if (prev && !e.agent) {
          if (isDetachedWin)
            window.mahas.win.paneCmd({ action: 'agentIdle', wsId, paneId, tabId, provider: prev })
          else reportProcessIdle(prev, wsId, paneId, tabId)
        }
      }
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        shell.resize(id, term.cols, term.rows)
      } catch {
        /* not visible yet */
      }
    })
    ro.observe(host)

    // attach → reuse the live session (host replays its scrollback tail);
    // fall back to a fresh spawn under the same id when it's gone
    if (existingPty) {
      shell
        .attach(id, term.cols, term.rows)
        .then((ok) => {
          if (!ok && !disposed) {
            shell.spawn({ id, cols: term.cols, rows: term.rows, cwd: projectPath })
          }
        })
        .catch(() => {})
    } else {
      shell.spawn({ id, cols: term.cols, rows: term.rows, cwd: projectPath })
    }

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      offEvent()
      offData.dispose()
      // the pty (and any live turn) outlives this view, but this view owned
      // the silence timer — dropping it without clearing `working` leaves a
      // stuck green pulse in a pane nobody is watching. Only patch when the
      // lamp is actually on: stamping turnEndedAt unconditionally would
      // mislabel hours-idle sessions as "ended just now"
      pulse.dispose()
      const rec = termRec()
      if (rec?.working) {
        patchTerminalTab(wsId, paneId, tabId, { working: false, turnEndedAt: Date.now() })
      }
      term.dispose()
      // The pty session belongs to the tab record, not this view. Unmounts
      // from layout churn (splits, moves, dock/float), detach handoff and
      // StrictMode remounts all re-attach to the live session — kill only
      // when the tab no longer owns THIS session: tab/pane/workspace closed,
      // the id was cleared (restart kills it explicitly first), or a newer
      // mount already superseded it.
      const st = useStore.getState()
      let ownsSession = false
      for (const w of st.workspaces) {
        const p = w.panes[paneId]
        if (p) {
          ownsSession = p.tabs.some((t) => t.id === tabId && t.kind === 'term' && t.pty === id)
          break
        }
      }
      if (!ownsSession) shell.kill(id)
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
      <div
        className="term-host"
        ref={hostRef}
        onClick={() => termRef.current?.focus()}
        onContextMenu={(e) => {
          e.preventDefault()
          setCtx({ x: e.clientX, y: e.clientY, sel: termRef.current?.hasSelection() ?? false })
        }}
        onAuxClick={(e) => {
          // X11-style middle-click paste
          if (e.button === 1) {
            e.preventDefault()
            pasteClipboard()
          }
        }}
      />
      {exited && (
        <div className="term-exited" onClick={onRestart}>
          {t('processExited')}
        </div>
      )}
      {ctx && (
        <CtxMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            { label: t('copy'), hint: 'Ctrl+Shift+C', disabled: !ctx.sel, act: copySelection },
            { label: t('paste'), hint: 'Ctrl+Shift+V', act: pasteClipboard },
            { sep: true },
            { label: t('selectAll'), act: () => termRef.current?.selectAll() },
            { label: t('clear'), act: () => termRef.current?.clear() }
          ]}
        />
      )}
    </>
  )
}
