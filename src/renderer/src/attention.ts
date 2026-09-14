// Agent-attention policy — the single choke point every agent signal flows
// through before it can interrupt the user. Spec: docs/notifications.md.
//
//   hook events      agent:event IPC          → handleHookEvent
//   process fallback pty agent→idle           → reportProcessIdle
//   detached panes   pane:cmd 'agentIdle'     → reportProcessIdle (main store)
//
// Attention level decides the interruption: attended = you're looking at it
// (silent, pre-read record), ambient = app focused but target off-screen
// (unread badge, no OS banner), away = hosting window unfocused (unread + OS).

import { useStore, visibleLeafIds } from './store'
import { agentLabel } from './agents'
import { resumeSupported } from './resume'
import { translate } from './i18n'
import { shortPath } from './utils'
import type { AgentHookEvent, Language, PaneState, TerminalTab, Workspace } from './types'

type Level = 'attended' | 'ambient' | 'away'
type Action = 'os' | 'badge' | 'silent' | 'drop'

export interface Target {
  ws: Workspace | undefined
  paneId: string | undefined
  tabId: string | undefined
  tab: TerminalTab | undefined
}

// events that can demand attention — everything else is tracking-only
const NOTIFY_EVENTS = new Set(['turn-complete', 'needs-input', 'error'])

// per-provider hook-installed state, refreshed on boot and after Settings
// installs. When a provider's hook is installed the process-exit proxy stops
// notifying — the hook owns completion, and a missing agent process is then
// usually the user quitting the CLI themselves.
let hookInstalled: Record<string, boolean> = {}

export async function refreshHookInstalled(): Promise<void> {
  try {
    const status = await window.ade.hooks.status()
    hookInstalled = Object.fromEntries(status.map((h) => [h.id, h.installed]))
  } catch {
    /* keep the previous map */
  }
}

function logDecision(
  ev: Pick<AgentHookEvent, 'provider' | 'event' | 'sessionId' | 'cwd'>,
  t: Target | null,
  action: Action,
  reason: string,
  via: string
): void {
  window.ade.notify.decision?.({
    ts: Date.now(),
    via,
    ev: { provider: ev.provider, event: ev.event, sessionId: ev.sessionId, cwd: ev.cwd },
    target: t ? { wsId: t.ws?.id, paneId: t.paneId, tabId: t.tabId } : undefined,
    action,
    reason
  })
}

// Resolve an event to a workspace/pane/tab. The session registry wins once
// known (survives `cd`, disambiguates agents sharing a dir); else longest
// project-path prefix picks the workspace and an exact live-cwd match picks
// the tab (background tabs count — the emitter may not be the visible one).
function resolveTarget(
  st: ReturnType<typeof useStore.getState>,
  sessionId: string | undefined,
  cwd: string | undefined,
  provider?: string
): Target {
  const reg = sessionId ? st.agentSessions[sessionId] : undefined
  if (reg?.wsId && reg.paneId) {
    const ws = st.workspaces.find((w) => w.id === reg.wsId)
    const pane = ws?.panes[reg.paneId]
    if (ws && pane) {
      const tab =
        pane.type === 'terminal' && reg.tabId
          ? pane.tabs.find((t) => t.id === reg.tabId)
          : undefined
      return { ws, paneId: pane.id, tabId: tab?.id, tab }
    }
  }
  const dir = (cwd ?? '').replace(/\/+$/, '')
  let ws: Workspace | undefined
  let best = -1
  if (dir) {
    for (const w of st.workspaces) {
      const proj = st.projects.find((p) => p.id === w.projectId)
      const pp = proj?.path.replace(/\/+$/, '') ?? ''
      if (pp && (dir === pp || dir.startsWith(pp + '/')) && pp.length > best) {
        ws = w
        best = pp.length
      }
    }
  }
  let paneId: string | undefined
  let tabId: string | undefined
  let tab: TerminalTab | undefined
  if (ws) {
    if (dir) {
      for (const p of Object.values(ws.panes)) {
        if (p.type !== 'terminal') continue
        const hit = (p.tabs ?? []).find((t) => (t.cwd ?? '').replace(/\/+$/, '') === dir)
        if (hit) {
          paneId = p.id
          tabId = hit.id
          tab = hit
          break
        }
      }
    }
    // cwd missed (agent moved dirs before ade saw it) — attribute to the tab
    // currently hosting this provider, if exactly one does
    if (!tab && provider) {
      const hits: { paneId: string; tab: TerminalTab }[] = []
      for (const p of Object.values(ws.panes)) {
        if (p.type !== 'terminal') continue
        for (const t of p.tabs ?? []) {
          if (t.agent === provider) hits.push({ paneId: p.id, tab: t })
        }
      }
      if (hits.length === 1) {
        paneId = hits[0].paneId
        tabId = hits[0].tab.id
        tab = hits[0].tab
      }
    }
    // cwd didn't match a live terminal — still land on something sensible so
    // clicking the notification focuses the workspace's active pane
    paneId ??= ws.focusedPaneId ?? Object.keys(ws.panes)[0]
  }
  return { ws, paneId, tabId, tab }
}

function paneOnScreen(ws: Workspace, pane: PaneState): boolean {
  if (pane.minimized) return false
  if (pane.detached) return true // a focused detached window is its own screen
  if (pane.floating) return true // overlays are always on top of the workspace
  return visibleLeafIds(ws.root, ws.panes).includes(pane.id)
}

// attended needs the actual emitting tab on screen — a focused-pane fallback
// target doesn't count (the thing asking isn't visible)
async function levelFor(
  st: ReturnType<typeof useStore.getState>,
  t: Target
): Promise<{ level: Level; win: string }> {
  const ws = t.ws
  const pane = ws && t.paneId ? ws.panes[t.paneId] : undefined
  const win = await window.ade.win
    .state({ wsId: ws?.id, paneId: t.paneId, detached: !!pane?.detached })
    .catch(() => 'hidden')
  if (win !== 'focused') return { level: 'away', win }
  if (!ws || !pane || st.activeWorkspaceId !== ws.id || !paneOnScreen(ws, pane))
    return { level: 'ambient', win }
  const tabActive = !!t.tabId && pane.type === 'terminal' && pane.activeTabId === t.tabId
  return { level: tabActive ? 'attended' : 'ambient', win }
}

// Second-layer dedupe (the tailer already collapsed byte-identical events):
// same provider+target+kind inside the window records pre-read instead of
// re-pinging — this is where the hook path and the pty-idle path stop
// double-firing, and where opencode's permission.updated churn collapses.
const DEDUPE_MS: Record<string, number> = {
  'turn-complete': 45_000,
  'needs-input': 60_000,
  error: 20_000
}
// turn-completes for one provider+workspace arriving within the burst window
// are one logical completion (task-tool fan-out) — extra ones record silently
const BURST_MS = 3_000

const recent = new Map<string, number>()
const lastBurst = new Map<string, number>()

function dedupe(provider: string, kind: string, t: Target): 'full' | 'quiet' {
  const now = Date.now()
  const key = `${provider}|${t.ws?.id ?? ''}|${t.paneId ?? ''}|${t.tabId ?? ''}|${kind}`
  const last = recent.get(key)
  if (last !== undefined && now - last < (DEDUPE_MS[kind] ?? 10_000)) return 'quiet'
  recent.set(key, now)
  if (kind === 'turn-complete') {
    const bkey = `${provider}|${t.ws?.id ?? ''}`
    const blast = lastBurst.get(bkey)
    lastBurst.set(bkey, now)
    if (blast !== undefined && now - blast < BURST_MS) return 'quiet'
  }
  if (recent.size > 500) {
    for (const [k, ts] of recent) if (now - ts > 120_000) recent.delete(k)
  }
  return 'full'
}

// A pending needs-input is stale once the turn moves on — resumed, finished,
// cancelled, errored, or superseded by a new ask. Only real turn activity
// settles: an 'idle'/'other'/session-start from the same session (or a
// sibling sub-session landing on the same tab) must not clear a live prompt.
const SETTLE_KINDS = new Set([
  'turn-start',
  'turn-complete',
  'turn-cancelled',
  'error',
  'session-end',
  'needs-input'
])

function settleFor(
  st: ReturnType<typeof useStore.getState>,
  ev: Pick<AgentHookEvent, 'event' | 'sessionId'>,
  t: Target
): void {
  if (!SETTLE_KINDS.has(ev.event)) return
  st.settleInput({
    wsId: t.ws?.id,
    paneId: t.paneId,
    tabId: t.tabId,
    sessionId: ev.sessionId
  })
}

function titleFor(language: Language, provider: string, kind: string): string {
  return translate(
    language,
    kind === 'needs-input' ? 'agentNeedsInput' : kind === 'error' ? 'agentError' : 'agentFinished',
    { agent: agentLabel(provider) }
  )
}

// Shared tail of both delivery paths: dedupe → attention level → deliver.
async function deliver(
  ev: Pick<AgentHookEvent, 'provider' | 'event' | 'sessionId' | 'cwd' | 'message' | 'force'>,
  t: Target,
  via: string
): Promise<void> {
  const st = useStore.getState()
  const verdict = dedupe(ev.provider, ev.event, t)
  const { level, win } = ev.force ? { level: 'away' as Level, win: 'test' } : await levelFor(st, t)
  // needs-input never goes fully silent — it's pending work, not news; the
  // badge stays until the next event for the session/tab settles it
  const action: Action =
    verdict === 'quiet'
      ? 'silent'
      : level === 'away'
        ? 'os'
        : level === 'ambient' || ev.event === 'needs-input'
          ? 'badge'
          : 'silent'
  const wsId = t.ws?.id ?? st.activeWorkspaceId
  const title = titleFor(st.settings.language, ev.provider, ev.event)
  const session =
    (ev.sessionId ? st.agentSessions[ev.sessionId]?.name : undefined) ??
    t.tab?.title ??
    (ev.cwd ? shortPath(ev.cwd) : undefined)
  const body = ev.message || ''
  if (wsId) {
    st.notify({
      workspaceId: wsId,
      paneId: t.paneId,
      tabId: t.tabId,
      title,
      body,
      session,
      agent: ev.provider,
      kind: ev.event === 'needs-input' ? 'needs-input' : undefined,
      sessionId: ev.sessionId,
      read: action === 'silent'
    })
  }
  if (action === 'os' && st.settings.osNotifications) {
    window.ade.notify.show(title, [session, body].filter(Boolean).join(' — '), {
      workspaceId: wsId ?? undefined,
      paneId: t.paneId,
      tabId: t.tabId
    })
  }
  logDecision(
    ev,
    t,
    wsId ? action : 'drop',
    verdict === 'quiet' ? `dedupe ${level}:${win}` : `${level}:${win}`,
    via
  )
}

// Read-on-view sweep for the MAIN window: an unread ping whose target the
// user is attending (this window focused, its workspace active, its pane on
// screen, its emitting tab selected) has done its job — clear it without a
// click. Detached panes report 'attended' over pane:cmd from their own
// window, whose focus isn't observable here. needs-input clears too — the
// prompt itself is on screen.
export function sweepAttended(): void {
  if (!document.hasFocus()) return
  const st = useStore.getState()
  if (!st.notifications.some((n) => !n.read)) return
  const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId)
  if (!ws) return
  const leaves = new Set(visibleLeafIds(ws.root, ws.panes))
  // paneId → attended tab (undefined = whole pane counts as seen)
  const attended = new Map<string, string | undefined>()
  for (const p of Object.values(ws.panes)) {
    if (p.detached || p.minimized || (!p.floating && !leaves.has(p.id))) continue
    attended.set(p.id, p.type === 'terminal' ? p.activeTabId : undefined)
  }
  const ids = new Set(
    st.notifications
      .filter(
        (n) =>
          !n.read &&
          n.workspaceId === ws.id &&
          (n.paneId === undefined ||
            (attended.has(n.paneId) &&
              (n.tabId === undefined || n.tabId === attended.get(n.paneId))))
      )
      .map((n) => n.id)
  )
  if (!ids.size) return
  // one set — markAttendedRead in a loop would re-enter this sweep
  useStore.setState((s) => ({
    notifications: s.notifications.map((n) => (ids.has(n.id) ? { ...n, read: true } : n))
  }))
}

// agent:event IPC entry — the real harness signals.
export async function handleHookEvent(ev: AgentHookEvent): Promise<void> {
  const st = useStore.getState()
  // session-rename: a tab rename propagated through the real channel —
  // updates the session registry (and the mapped tab's title), no notify
  if (ev.event === 'session-rename') {
    if (ev.sessionId) st.renameAgentSession(ev.sessionId, ev.name ?? '')
    return
  }
  // hooks are installed globally, so agents launched in terminals outside
  // ade (no ADE_SESSION in their env) append here too — never act on those
  if (!ev.ours) {
    logDecision(ev, null, 'drop', 'foreign', 'hook')
    return
  }
  const t = resolveTarget(st, ev.sessionId, ev.cwd, ev.provider)
  // track the session ↔ tab association so later events (and renames) land
  // precisely even after the session's cwd drifts
  if (ev.sessionId) {
    st.upsertAgentSession(ev.sessionId, {
      provider: ev.provider,
      cwd: ev.cwd,
      wsId: t.ws?.id,
      paneId: t.paneId,
      tabId: t.tabId
    })
    // the live-session set powering restart-resume: any event means the
    // session is alive (providers without session-start hooks still get
    // tracked), session-end takes it out. `force` test events are synthetic
    // — no real session exists to reopen.
    if (!ev.force) {
      if (ev.event === 'session-end') st.dropResumeSession(ev.sessionId)
      else if (t.ws && t.paneId && t.tabId && resumeSupported(ev.provider)) {
        st.upsertResumeSession({
          sessionId: ev.sessionId,
          provider: ev.provider,
          cwd: ev.cwd,
          wsId: t.ws.id,
          paneId: t.paneId,
          tabId: t.tabId
        })
      }
    }
  }
  settleFor(st, ev, t)
  if (!NOTIFY_EVENTS.has(ev.event)) {
    logDecision(ev, t, 'drop', 'tracking', 'hook')
    return
  }
  if (st.settings.providers[ev.provider] === false) {
    logDecision(ev, t, 'drop', 'provider-disabled', 'hook')
    return
  }
  await deliver(ev, t, 'hook')
}

// pty-host process-detection fallback: agent process left the shell's tree.
// Suppressed when the provider's hook is installed — the hook owns completion
// then, and a vanishing process is usually the user quitting the CLI.
export function reportProcessIdle(
  provider: string,
  wsId: string,
  paneId: string,
  tabId: string
): void {
  const st = useStore.getState()
  const ws = st.workspaces.find((w) => w.id === wsId)
  const pane = ws?.panes[paneId]
  const tab = pane?.type === 'terminal' ? pane.tabs.find((t) => t.id === tabId) : undefined
  const t: Target = { ws, paneId, tabId: tab ? tabId : undefined, tab }
  const ev = { provider, event: 'turn-complete', cwd: tab?.cwd }
  // the agent process is gone — a pending prompt died with it
  settleFor(st, ev, t)
  if (hookInstalled[provider]) {
    logDecision(ev, t, 'drop', 'hook-owned provider', 'pty-idle')
    return
  }
  if (st.settings.providers[provider] === false) {
    logDecision(ev, t, 'drop', 'provider-disabled', 'pty-idle')
    return
  }
  void deliver(ev, t, 'pty-idle')
}
