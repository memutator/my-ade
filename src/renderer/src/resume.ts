// Agent session resume — after a restart, ade offers to reopen the agent
// sessions that were live when it last persisted state (see ResumeSession —
// a bounded current set, not a history).
//
// Resume = typing the provider's resume command into the session's old tab,
// which restarts as a plain shell on boot; the harness then reopens the
// conversation in place and its own hook events re-register it as live.
//
// This module also owns the live-session bookkeeping driven by pty events
// (broadcast to every window): `exit` and agent→idle both mean the tab's
// agent is gone → its records leave the resume set. Records also drop on
// `session-end` hook events (attention.ts) and pane/workspace close (store).

import { useStore, visibleLeafIds } from './store'
import { agentProviders, resumeCommand } from './agents'
import type { ResumeSession, TerminalTab } from './types'

export interface ResumeCandidate {
  rec: ResumeSession
  tab: TerminalTab
  cmd: string
}

// pty session ids with a running process right now (spawned/attached add,
// exit removes). Resume writes only into live sessions; commands for tabs
// whose shell hasn't spawned yet (a detached window still booting) wait here.
const live = new Set<string>()
const pending = new Map<string, string>()
// on shutdown the pty sessions die too — their `exit` events must not strip
// the very records we persist for next launch
let quitting = false

// pty session id = `paneId:tabId:uuid` — the middle segment is the tab
function tabIdOf(ptyId: string): string | undefined {
  return ptyId.split(':')[1] || undefined
}

function dropForPty(ptyId: string): void {
  const tabId = tabIdOf(ptyId)
  if (tabId) useStore.getState().dropResumeWhere((r) => r.tabId === tabId)
}

export function initResumeTracking(): () => void {
  const off = window.ade.pty.onEvent((e) => {
    if (e.t === 'spawned' || e.t === 'attached') {
      live.add(e.id)
      const cmd = pending.get(e.id)
      if (cmd) {
        pending.delete(e.id)
        // let the fresh shell reach its prompt before the command lands
        setTimeout(() => window.ade.pty.write(e.id, cmd + '\r'), 350)
      }
    } else if (e.t === 'exit') {
      live.delete(e.id)
      pending.delete(e.id)
      if (!quitting) dropForPty(e.id)
    } else if (e.t === 'agent' && !e.agent && !quitting) {
      // the agent left the tab's process tree — the session is over even if
      // the harness's session-end hook never fired (or isn't installed)
      dropForPty(e.id)
    }
  })
  const onUnload = (): void => {
    quitting = true
  }
  window.addEventListener('beforeunload', onUnload)
  return () => {
    off()
    window.removeEventListener('beforeunload', onUnload)
  }
}

// candidates that can actually be resumed right now: the record's pane+tab
// still exist, the tab has a pty and no agent already running in it, the
// provider knows how to resume, and it isn't disabled in settings. Two
// records claiming the same tab (stale cwd-guessed attribution) collapse to
// the newest — both typing into one shell would land in the first agent's
// prompt. Order follows the layout's pane order then the pane's tab order,
// so restoring walks the sessions the way the user sees them.
export function resumeCandidates(
  st: ReturnType<typeof useStore.getState>,
  wsId: string
): ResumeCandidate[] {
  const ws = st.workspaces.find((w) => w.id === wsId)
  if (!ws) return []
  const byTab = new Map<string, ResumeCandidate>()
  for (const rec of Object.values(st.resumeSessions)) {
    if (rec.wsId !== wsId) continue
    const pane = ws.panes[rec.paneId]
    if (pane?.type !== 'terminal') continue
    const tab = pane.tabs.find((t) => t.id === rec.tabId)
    if (!tab || tab.exited || !tab.pty || tab.agent) continue
    if (st.settings.providers[rec.provider] === false) continue
    const cmd = resumeCommand(rec.provider, rec.sessionId)
    if (!cmd) continue
    const prev = byTab.get(tab.id)
    if (!prev || rec.ts > prev.rec.ts) byTab.set(tab.id, { rec, tab, cmd })
  }
  const paneOrder = new Map(visibleLeafIds(ws.root, ws.panes).map((id, i) => [id, i]))
  const tabIndex = (c: ResumeCandidate): number => {
    const p = ws.panes[c.rec.paneId]
    return p?.type === 'terminal' ? p.tabs.findIndex((t) => t.id === c.rec.tabId) : 0
  }
  return [...byTab.values()].sort(
    (a, b) =>
      (paneOrder.get(a.rec.paneId) ?? Number.MAX_SAFE_INTEGER) -
        (paneOrder.get(b.rec.paneId) ?? Number.MAX_SAFE_INTEGER) ||
      tabIndex(a) - tabIndex(b) ||
      a.rec.ts - b.rec.ts
  )
}

// type each resume command into its tab's shell and bring the tab forward.
// Records are consumed either way — a resumed session re-registers itself via
// its own hook events the moment the harness is back up.
export function resumeWorkspaceSessions(wsId: string): number {
  const st = useStore.getState()
  const cands = resumeCandidates(st, wsId)
  const panes = new Map<string, string>() // paneId → first resumed tabId
  let n = 0
  for (const c of cands) {
    const pty = c.tab.pty!
    if (live.has(pty)) window.ade.pty.write(pty, c.cmd + '\r')
    else pending.set(pty, c.cmd) // drained by the tab's own spawned event
    // leftmost resumed tab ends up active — matches the visual restore order
    if (!panes.has(c.rec.paneId)) panes.set(c.rec.paneId, c.rec.tabId)
    st.dropResumeSession(c.rec.sessionId)
    n++
  }
  for (const [paneId, tabId] of panes) {
    st.updatePane(paneId, { activeTabId: tabId }, wsId)
  }
  return n
}

// display name for the candidate row — session rename, tab title, else the id
export function candidateName(rec: ResumeSession, tab: TerminalTab): string {
  const reg = useStore.getState().agentSessions[rec.sessionId]
  return reg?.name ?? tab.title ?? rec.sessionId
}

export function resumeSupported(provider: string): boolean {
  return !!agentProviders()[provider]?.resume
}
