export type PaneType = 'terminal' | 'browser' | 'editor' | 'todo'

/** edge of a target pane a drop/insert lands on */
export type DropEdge = 'left' | 'right' | 'top' | 'bottom'

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
}

export interface TerminalTab {
  id: string
  /** user-set label (double-click rename); falls back to agent/shell */
  title?: string
  cwd?: string
  shell?: string
  exited?: boolean
  agent?: string | null
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
}

export interface EditorPaneState extends PaneBase {
  type: 'editor'
  tabs: EditorTab[]
  activeTabId?: string
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
  ts: number
  read: boolean
}

export type Theme = 'dark' | 'light' | 'system'

export type Language = 'ko' | 'en' | 'system'

export interface Settings {
  theme: Theme
  accent: string
  uiFont: string
  termFont: string
  termFontSize: number
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
}

export interface AgentHookEvent {
  provider: string
  event: string
  cwd?: string
  sessionId?: string
  /** true when the event came from an ade-spawned terminal session */
  ours?: boolean
  /** session-rename payload: the new session name */
  name?: string
  message?: string
  ts?: number
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
