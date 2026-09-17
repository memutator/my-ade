import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ILink, ILinkProvider } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { PaneState, TerminalTab } from '../types'
import { useStore, patchTerminalTab, linkTargetPane } from '../store'
import { reportProcessIdle } from '../attention'
import { useT, translate } from '../i18n'
import { isDetachedWin } from '../detached'
import { CtxMenu } from './Menu'

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
  window.ade.fs
    .resolvePath(raw, cwd)
    .then((abs) => {
      if (!abs) return
      useStore
        .getState()
        .openFile(abs, abs.split('/').pop() ?? abs, wsId, false, linkTarget(wsId, paneId))
    })
    .catch(() => {})
}

/** event handlers outlive props — always read the pane fresh from the store */
function paneAt(wsId: string, paneId: string): PaneState | undefined {
  return useStore.getState().workspaces.find((x) => x.id === wsId)?.panes[paneId]
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
  // `working` (tab close-slot pulse): output while an agent owns the shell ≈
  // a turn in flight — agent TUIs stream/spin while working and go silent at
  // their prompt. ~1.6 s of silence ends it. Hook events (attention.ts)
  // refine the same flag.
  const workingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // attach replays the scrollback tail as `data` — that burst is history,
  // not a working turn, so activity is ignored briefly after (re)attach
  const replayUntil = useRef(0)
  // keystroke echo suppression: typing at the agent's prompt redraws it,
  // which is output but NOT work — output within ~0.8 s of an input never
  // lights the flag (it still refreshes an already-lit one, so typing
  // mid-turn doesn't flicker the light out)
  const lastInputAt = useRef(0)
  // a "burst" is output flowing with no >1.6 s gap. Only a burst that keeps
  // going past ~0.9 s counts as a turn in flight — lone redraws (the attach
  // replay tail, git/status watcher ticks, the post-turn prompt redraw) are
  // one-frame blips that must not light the pulse
  const lastDataAt = useRef(0)
  const burstStartAt = useRef(0)
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
    if (term?.hasSelection()) void window.ade.clipboard.write(term.getSelection())
  }
  const pasteClipboard = (): void => {
    void window.ade.clipboard.read().then((s) => s && termRef.current?.paste(s))
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
    term.registerLinkProvider(makePathLinkProvider(term, wsId, paneId, tabId))
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
          void window.ade.clipboard.write(term.getSelection())
          return false
        }
        return e.ctrlKey && !e.shiftKey && !e.metaKey
      }
      if (!e.altKey && k === 'v' && ((e.ctrlKey && e.shiftKey) || e.metaKey)) {
        // returning false only skips xterm's key handling — the keydown's
        // default action still dispatches 'paste' on the textarea and xterm's
        // own paste listener writes the clipboard a second time. Cancel it.
        e.preventDefault()
        void window.ade.clipboard.read().then((s) => s && term.paste(s))
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

    const clearWorking = (): void => {
      if (workingTimer.current) clearTimeout(workingTimer.current)
      workingTimer.current = null
      patchTerminalTab(wsId, paneId, tabId, { working: false })
    }
    const noteOutput = (): void => {
      if (!lastAgentRef.current) return
      const now = Date.now()
      // replayed scrollback is history — skip it without touching the burst
      // clocks, so the first live output afterwards starts a fresh burst
      if (now < replayUntil.current) return
      // a burst is a DENSE stream — a chunk only continues it while the gap
      // stays under ~350ms. Sparser trickles (codex's git/status-watcher
      // redraws in an active repo) can neither light the lamp nor hold it
      const dense = now - lastDataAt.current < 350
      if (!dense) burstStartAt.current = now
      lastDataAt.current = now
      // the store is the single source — attention.ts can clear the flag on
      // hook events, so read it instead of mirroring locally
      const rec = paneAt(wsId, paneId)?.tabs.find(
        (x): x is TerminalTab => x.id === tabId && x.kind === 'term'
      )
      const working = rec?.working ?? false
      if (!working) {
        // suppressed output isn't turn evidence either — echo redraws and
        // the quiet window's trailing redraw restart the burst clock instead
        // of accumulating toward the light
        if (now - lastInputAt.current < 800 || now < (rec?.quietUntil ?? 0)) {
          burstStartAt.current = now
          return
        }
        if (now - burstStartAt.current < 900) return // blip, not a turn
        patchTerminalTab(wsId, paneId, tabId, {
          working: true,
          // a relight soon after the light went out is the same turn
          // resuming (a tool ran silently for a beat) — keep its start so
          // the elapsed timer tracks the turn, not the latest burst
          workingSince:
            rec?.turnEndedAt && now - rec.turnEndedAt < 20_000 ? (rec.workingSince ?? now) : now
        })
      }
      // a sparse chunk can't hold the light — let the pending silence
      // deadline stand so periodic redraws can't pin it forever
      if (!dense) return
      if (workingTimer.current) clearTimeout(workingTimer.current)
      workingTimer.current = setTimeout(() => {
        workingTimer.current = null
        patchTerminalTab(wsId, paneId, tabId, {
          working: false,
          // keep workingSince — a relight within the window above resumes
          // the same turn's elapsed clock
          turnEndedAt: Date.now()
        })
      }, 1600)
    }

    const offData = term.onData((d) => {
      lastInputAt.current = Date.now()
      // typing isn't work — composer echoes can't keep a burst alive, else
      // composing a long prompt would itself read as a turn
      burstStartAt.current = 0
      window.ade.pty.write(id, d)
    })
    const offEvent = window.ade.pty.onEvent((e) => {
      if (e.id !== id) return
      if (e.t === 'data' && e.d) {
        term.write(decode(e.d))
        noteOutput()
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
          pty: id
        })
      } else if (e.t === 'attached') {
        // reattached to a live session — adopt its recorded state; the
        // replayed tail must not trip the working light. Seeding
        // lastAgentRef matters: without it a remount loses the agent→idle
        // transition (prev reads null) AND output can't light `working`
        // until the next agent event
        replayUntil.current = Date.now() + 400
        lastAgentRef.current = e.agent ?? null
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
        patchTerminalTab(wsId, paneId, tabId, {
          agent: e.agent ?? null,
          // a freshly detected agent is mid-launch — its startup banner is
          // output but not a turn; hold the light off or every spawn flashes
          ...(!prev && e.agent ? { quietUntil: Date.now() + 1200 } : {}),
          ...(e.agent ? {} : { working: false })
        })
        if (!e.agent) clearWorking()
        // agent → idle transition = completion fallback. In a detached window
        // the notification list lives in the main renderer — relay there.
        if (prev && !e.agent) {
          if (isDetachedWin)
            window.ade.win.paneCmd({ action: 'agentIdle', wsId, paneId, tabId, provider: prev })
          else reportProcessIdle(prev, wsId, paneId, tabId)
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
      // the pty (and any live turn) outlives this view, but this view owned
      // the silence timer — dropping it without clearing `working` leaves a
      // stuck green pulse in a pane nobody is watching. Only patch when the
      // lamp is actually on: stamping turnEndedAt unconditionally would
      // mislabel hours-idle sessions as "ended just now"
      if (workingTimer.current) clearTimeout(workingTimer.current)
      workingTimer.current = null
      const rec = paneAt(wsId, paneId)?.tabs.find(
        (x): x is TerminalTab => x.id === tabId && x.kind === 'term'
      )
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
      if (!ownsSession) window.ade.pty.kill(id)
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
