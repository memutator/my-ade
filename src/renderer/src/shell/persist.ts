// On-disk desktop snapshot contract. Migration lives in hydration.ts; this
// file only names the field set so App and tests share one list.

import type {
  AgentSessionInfo,
  Bookmark,
  Project,
  ResumeSession,
  Settings,
  Workspace
} from '../types.ts'

export const STATE_VERSION = 3

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

/** The on-disk field set. Runtime-only store fields (toasts, theme, dialogs) stay out. */
export function snapshotPersistedState(s: PersistedState): PersistedState {
  return {
    stateVersion: STATE_VERSION,
    projects: s.projects,
    workspaces: s.workspaces,
    activeWorkspaceId: s.activeWorkspaceId,
    settings: s.settings,
    sidebarOpen: s.sidebarOpen,
    treeOverlayOpen: s.treeOverlayOpen,
    bookmarks: s.bookmarks,
    agentSessions: s.agentSessions,
    resumeSessions: s.resumeSessions,
    treeRoots: s.treeRoots,
    sidebarRoots: s.sidebarRoots,
    sideAgentsCollapsed: s.sideAgentsCollapsed,
    sideAgentsFrac: s.sideAgentsFrac,
    agentsScope: s.agentsScope
  }
}

/** Stamp shutdown evidence onto resume records. Main's withShutdownEvidence mirrors this. */
export function stampResumeShutdown<T extends { resumeSessions?: Record<string, ResumeSession> }>(
  state: T,
  runId: string,
  at = Date.now()
): T {
  if (!state.resumeSessions) return state
  return {
    ...state,
    resumeSessions: Object.fromEntries(
      Object.entries(state.resumeSessions).map(([id, row]) => [
        id,
        row.shutdown ? row : { ...row, shutdown: { runId, at } }
      ])
    )
  }
}
