export type PaneType = 'terminal' | 'browser' | 'editor' | 'todo'

/** edge of a target pane a drop/insert lands on */
export type DropEdge = 'left' | 'right' | 'top' | 'bottom'

/** floating overlay geometry — fractions of the workspace area (0..1) */
export interface FloatRect {
  x: number
  y: number
  w: number
  h: number
  z: number
}

export interface PaneBase {
  id: string
  type: PaneType
  title: string
  /**
   * Minimized panes keep their leaf in the layout tree but render hidden
   * (mounted, so terminals/webviews keep running). A chip in the workspace's
   * pane dock restores them to their exact slot.
   */
  minimized?: boolean
  /**
   * Floating panes are removed from the layout tree (space is reclaimed) and
   * render as an absolutely-positioned overlay on the workspace instead —
   * free size/position, draggable, resizable; dock puts them back.
   */
  floating?: FloatRect
  /**
   * Detached panes live in their own OS window. The leaf stays in the tree
   * (reattach returns to the same slot) but the content unmounts in the main
   * window — the detached window owns it. Terminal sessions survive via
   * pty `attach` on the stored session id.
   */
  detached?: boolean
}

export interface TerminalTab {
  id: string
  /** user-set label (double-click rename); falls back to agent/shell */
  title?: string
  cwd?: string
  shell?: string
  exited?: boolean
  agent?: string | null
  /** live pty-host session id — lets remounts/detached windows `attach`
   *  (with scrollback replay) instead of spawning a new shell */
  pty?: string
}

export interface TerminalPaneState extends PaneBase {
  type: 'terminal'
  tabs: TerminalTab[]
  activeTabId?: string
  /** @deprecated legacy single-shell fields — read only by normalizePane when
   *  hydrating pre-tabs saves, then stripped */
  cwd?: string
  shell?: string
  exited?: boolean
  agent?: string | null
}

export interface BrowserTab {
  id: string
  url: string
  title: string
}

export interface BrowserPaneState extends PaneBase {
  type: 'browser'
  /** mirror of the active tab's url (kept for backward compat with older saves) */
  url: string
  tabs: BrowserTab[]
  activeTabId?: string
}

export interface EditorTab {
  id: string
  path: string
  name: string
  dirty?: boolean
  /** VS Code-style preview tab — italic label, replaced in place by the next
      preview open, pins permanently on edit / double-click / Keep Open */
  preview?: boolean
}

export interface EditorPaneState extends PaneBase {
  type: 'editor'
  tabs: EditorTab[]
  activeTabId?: string
  /** the pane tree's root dir (icon-hover peek overlay) — independent of the
   *  workspace's project; falls back to the project path, materialized onto
   *  the pane on float/detach */
  treeRoot?: string
}

export interface TodoPaneState extends PaneBase {
  type: 'todo'
}

export type PaneState = TerminalPaneState | BrowserPaneState | EditorPaneState | TodoPaneState

export type LayoutNode =
  | { kind: 'leaf'; id: string; paneId: string }
  | { kind: 'split'; id: string; dir: 'row' | 'col'; ratio: number; a: LayoutNode; b: LayoutNode }

export interface Project {
  id: string
  name: string
  path: string
}

export interface Workspace {
  id: string
  name: string
  projectId: string
  root: LayoutNode | null
  panes: Record<string, PaneState>
  focusedPaneId: string | null
}

export interface AppNotification {
  id: string
  workspaceId: string
  paneId?: string
  /** internal tab inside paneId to activate on click (terminal tabs) */
  tabId?: string
  title: string
  body?: string
  /** session label — user-renamed tab title, else cwd */
  session?: string
  /** agent provider id — renders the vendor icon in the notification list */
  agent?: string
  /** 'needs-input' pings auto-resolve when the same tab's turn resumes
   *  (a later event for the same session/tab marks them read) */
  kind?: 'needs-input'
  /** harness session that emitted the event — precise settling + dedupe */
  sessionId?: string
  ts: number
  read: boolean
}

/** ephemeral in-app toast — ambient-level agent signals slide down from the
 *  top center; clicking jumps to the emitting target via its notification */
export interface ToastItem {
  id: string
  /** notification to open on click — marks it read and navigates */
  notifId?: string
  title: string
  body?: string
  agent?: string
  ts: number
}

export type Theme = 'dark' | 'light' | 'system'

export type Language = 'ko' | 'en' | 'system'

export interface Settings {
  theme: Theme
  accent: string
  uiFont: string
  termFont: string
  termFontSize: number
  editorFont: string
  /** user keybinding overrides — action id → combo ('mod+mod+key', '' = unbound).
      Action ids live in shortcuts.ts (DEFAULT_BINDINGS keys). */
  bindings?: Record<string, string>
  language: Language
  homeUrl: string
  osNotifications: boolean
  providers: Record<string, boolean>
}

export interface AgentProviderInfo {
  label: string
  match: string[]
  /** vendor domain — favicon source for the provider icon (Chrome-style) */
  domain?: string
  /** brand color — letter-monogram fallback when no icon can be fetched */
  color?: string
  /** how to reopen a session: `<cmd> <args…> <sessionId>` in the tab's shell */
  resume?: { cmd: string; args?: string[] }
}

export interface AgentHookEvent {
  provider: string
  event: string
  cwd?: string
  sessionId?: string
  /** pane/tab the emitting shell was spawned into (pty-stamped env) — exact
   *  attribution, beats cwd/registry guessing */
  paneId?: string
  tabId?: string
  /** true when the event came from an ade-spawned terminal session */
  ours?: boolean
  /** session-rename payload: the new session name */
  name?: string
  message?: string
  /** test events bypass attention gating (hooks:test proves the pipeline) */
  force?: boolean
  ts?: number
}

/**
 * A live agent session worth offering to resume after an app restart. One per
 * harness sessionId — the set is the sessions that were alive when the state
 * was last persisted, never a history. Entries are dropped as soon as the
 * session ends (session-end event, agent process leaving the tab's process
 * tree, pty exit, tab/pane/workspace close).
 */
export interface ResumeSession {
  sessionId: string
  provider: string
  cwd?: string
  wsId: string
  paneId: string
  tabId: string
  ts: number
}

/** registry entry for a harness sessionId observed via hook events */
export interface AgentSessionInfo {
  name?: string
  provider?: string
  cwd?: string
  wsId?: string
  paneId?: string
  tabId?: string
  ts?: number
}

export interface AgentHookStatus {
  id: string
  label: string
  mechanism: string
  available: boolean
  installed: boolean
  detail?: string
  configPath: string
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export interface WorktreeEntry {
  path: string
  branch: string | null
  head: string
  main: boolean
}

export interface GitInfo {
  isRepo: boolean
  branch?: string | null
  branches?: string[]
  worktrees?: WorktreeEntry[]
  wtRoot?: string
}

/** 'global' or a project id */
export type BookmarkScope = 'global' | (string & {})

export interface Bookmark {
  id: string
  title: string
  url: string
  scope: BookmarkScope
  createdAt: number
}

export type TodoStatus = 'todo' | 'doing' | 'done'

export interface TodoItem {
  id: string
  text: string
  status: TodoStatus
  parentId?: string
  dependsOn: string[]
  createdAt: number
  order: number
}
