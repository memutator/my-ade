import { useMemo } from 'react'
import type { AgentSessionInfo, AppNotification, PaneState, TerminalTab, Workspace } from './types'
import { leafPaneIds, useStore } from './store'
import { agentLabel } from './agents'
import { shortPath, statusForTab, type TabStatus } from './utils'

/* Data model for the per-pane agent session list — shared by the sidebar's
   bottom section and the 'agents' widget block. Rows are the term tabs with
   a detected agent; the row state is the same dot the tab strip shows
   (input > error > working > news). */

export interface AgentRow {
  tab: TerminalTab
  status?: TabStatus
  label: string
  sub?: string
}

export interface AgentGroup {
  ws: Workspace
  pane: PaneState
  rows: AgentRow[]
}

// panes in display order: layout order (leafPaneIds keeps tree order and
// includes minimized/detached leaves), then floats (no leaf) topmost-first
function orderedPanes(ws: Workspace): PaneState[] {
  const inTree = new Set(leafPaneIds(ws.root))
  const listed = [...inTree].map((id) => ws.panes[id]).filter((p): p is PaneState => !!p)
  const floats = Object.values(ws.panes)
    .filter((p) => !inTree.has(p.id))
    .sort((a, b) => (b.floating?.z ?? 0) - (a.floating?.z ?? 0))
  return [...listed, ...floats]
}

// latest session record attributed to this tab (env-stamped tabId) — its
// `name` is the user/session-facing label when present
function sessionName(
  sessions: Record<string, AgentSessionInfo>,
  wsId: string,
  tabId: string
): string | undefined {
  let best: AgentSessionInfo | undefined
  for (const info of Object.values(sessions)) {
    if (info.tabId !== tabId || (info.wsId && info.wsId !== wsId)) continue
    if (!best || (info.ts ?? 0) > (best.ts ?? 0)) best = info
  }
  return best?.name
}

function buildGroups(
  ws: Workspace | undefined,
  notifications: AppNotification[],
  sessions: Record<string, AgentSessionInfo>
): AgentGroup[] {
  if (!ws) return []
  const groups: AgentGroup[] = []
  for (const pane of orderedPanes(ws)) {
    const rows = pane.tabs
      .filter((t): t is TerminalTab => t.kind === 'term' && !!t.agent)
      .map((tab) => ({
        tab,
        status: statusForTab(tab, notifications),
        label: sessionName(sessions, ws.id, tab.id) ?? tab.title ?? agentLabel(tab.agent ?? ''),
        sub: tab.cwd ? shortPath(tab.cwd) : undefined
      }))
    if (rows.length) groups.push({ ws, pane, rows })
  }
  return groups
}

/** grouped agent rows — the active workspace's when scope is 'ws', every
 *  workspace's (tagged per group) when scope is 'all'; recomputed only when
 *  its inputs actually change (slice refs are stable across unrelated
 *  store updates) */
export function useAgentGroups(wsId: string | undefined): AgentGroup[] {
  const workspaces = useStore((s) => s.workspaces)
  const scope = useStore((s) => s.agentsScope)
  const notifications = useStore((s) => s.notifications)
  const sessions = useStore((s) => s.agentSessions)
  return useMemo(() => {
    if (scope === 'all') {
      return workspaces.flatMap((w) => buildGroups(w, notifications, sessions))
    }
    return buildGroups(
      workspaces.find((w) => w.id === wsId),
      notifications,
      sessions
    )
  }, [workspaces, wsId, scope, notifications, sessions])
}

export function agentCount(groups: AgentGroup[]): number {
  return groups.reduce((n, g) => n + g.rows.length, 0)
}
