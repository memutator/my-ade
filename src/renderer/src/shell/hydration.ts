// mahas shell — persisted-state hydration and migration.
//
// The desktop state file is written by an older build as often as the
// current one, so loading it is a migration, not a parse. Everything that
// turns "what was on disk" into "what the store may hold" lives here:
//
//   - stateVersion<3 saves carried a pane `type` and kind-less tabs; those
//     panes normalize onto the type-less leaf model (todo panes are dropped);
//   - pane `num` (display order) is backfilled for saves written before it
//     existed, layout order first, stragglers after;
//   - a persisted focus on a minimized/detached/removed pane snaps back to a
//     visible one — the store must never hydrate an invisible focus;
//   - resume records only survive while their pane AND tab still exist, and
//     v<2 records (resolved by cwd guessing) are dropped wholesale.
//
// Pure: input is the raw parsed file (possibly from a much older build),
// output is what hydrate() should set. No IPC, no side effects.

import type {
  AgentSessionInfo,
  BlockKind,
  Bookmark,
  PaneState,
  PaneTab,
  Project,
  ResumeSession,
  Settings,
  TerminalTab,
  Workspace
} from '../types'
import { removeLeaf, visibleLeafIds, leafPaneIds } from './layout'
import { uid } from './ids'

// stateVersion<3 saves: panes carried a `type` ('terminal'/'browser'/'editor'
// /'todo') and tabs carried no `kind`. Migrates to the type-less leaf model —
// every pane is a stack of kind-tagged tabs. Returns null for panes to drop
// (todo panes, tab-less strays); the caller removes their leaf.
export function normalizePane(
  p: PaneState & {
    type?: string
    title?: string
    url?: string
    cwd?: string
    shell?: string
    exited?: boolean
    agent?: string | null
  }
): PaneState | null {
  const legacy = p.type
  if (legacy === 'todo') return null
  const kind: BlockKind = legacy === 'browser' ? 'web' : legacy === 'editor' ? 'file' : 'term'
  let tabs = (Array.isArray(p.tabs) ? p.tabs : []).map((t) => {
    const nt = { ...t, kind: t.kind ?? kind } as PaneTab
    // `working`/`quietUntil` are live runtime flags — a persisted true would
    // light a dead agent's tab until its shell respawned
    if (nt.kind === 'term') {
      delete (nt as TerminalTab).working
      delete (nt as TerminalTab).workingSince
      delete (nt as TerminalTab).quietUntil
      delete (nt as TerminalTab).idleLocked
    }
    return nt
  })
  if (tabs.length === 0) {
    if (legacy === 'editor' || legacy === undefined) return null
    const tab: PaneTab =
      kind === 'web'
        ? { kind: 'web', id: uid(), url: p.url || 'https://', title: '' }
        : { kind: 'term', id: uid(), cwd: p.cwd, shell: p.shell, exited: p.exited, agent: p.agent }
    tabs = [tab]
  }
  const activeTabId = tabs.some((t) => t.id === p.activeTabId) ? p.activeTabId : tabs[0].id
  const np: Record<string, unknown> = { ...p, tabs, activeTabId }
  delete np.type
  delete np.title
  delete np.url
  delete np.cwd
  delete np.shell
  delete np.exited
  delete np.agent
  return np as unknown as PaneState
}

export function normalizeWorkspace(w: Workspace): Workspace {
  let changed = false
  let root = w.root
  const panes: Record<string, PaneState> = {}
  for (const [id, p] of Object.entries(w.panes)) {
    const np = normalizePane(p)
    if (!np) {
      if (root) root = removeLeaf(root, id)
      changed = true
      continue
    }
    panes[id] = np
    if (panes[id] !== p) changed = true
  }
  // panes persisted before `num` existed get creation-order numbers now —
  // layout order first, floats/detached stragglers after
  let lastNum = 0
  for (const p of Object.values(panes)) lastNum = Math.max(lastNum, p.num ?? 0)
  for (const id of [...leafPaneIds(root), ...Object.keys(panes)]) {
    const p = panes[id]
    if (p && p.num === undefined) {
      panes[id] = { ...p, num: ++lastNum }
      changed = true
    }
  }
  // a persisted focus on a minimized/detached/removed pane would be
  // invisible — snap it back to the first visible leaf (or a float)
  let focusedPaneId = w.focusedPaneId
  if (
    focusedPaneId &&
    (!panes[focusedPaneId] || panes[focusedPaneId]?.minimized || panes[focusedPaneId]?.detached)
  ) {
    focusedPaneId =
      visibleLeafIds(root, panes)[0] ?? Object.values(panes).find((p) => p.floating)?.id ?? null
    changed = true
  }
  return changed ? { ...w, panes, focusedPaneId, root } : w
}

export const DEFAULT_SETTINGS: Settings = {
  homeUrl: '',
  theme: 'dark',
  accent: '#7aa2f7',
  uiFont: "'Inter', system-ui, sans-serif",
  termFont: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  termFontSize: 12.5,
  editorFont: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  language: 'system',
  osNotifications: true,
  providers: {}
}

export interface PersistedState {
  /** bump when persisted semantics change — v2 = resume records carry
   *  env-stamped exact pane/tab attribution; v3 = type-less panes hold
   *  kind-tagged tabs (todo panes dropped) */
  stateVersion?: number
  projects: Project[]
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  settings: Settings
  sidebarOpen: boolean
  treeOverlayOpen: boolean
  bookmarks: Bookmark[]
  /** harness sessionId → observed info (name set via session-rename) */
  agentSessions: Record<string, AgentSessionInfo>
  /** live agent sessions → offered for resume after a restart (see
   *  ResumeSession — a current set, not a history) */
  resumeSessions: Record<string, ResumeSession>
  /** most-recently-picked file-tree roots (any host: sidebar, overlay, pane) */
  treeRoots: string[]
  /** per-project sidebar tree root overrides — sidebar trees can point
   *  somewhere other than the project dir */
  sidebarRoots: Record<string, string>
  /** sidebar agents section — collapsed flag + fraction of sidebar height */
  sideAgentsCollapsed: boolean
  sideAgentsFrac: number
  /** agents list scope — 'ws' shows the active workspace's sessions,
   *  'all' groups every workspace's */
  agentsScope: 'ws' | 'all'
}
