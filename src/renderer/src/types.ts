export type PaneType = 'terminal' | 'browser' | 'editor'

export interface PaneBase {
  id: string
  type: PaneType
  title: string
}

export interface TerminalPaneState extends PaneBase {
  type: 'terminal'
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
}

export interface EditorPaneState extends PaneBase {
  type: 'editor'
  tabs: EditorTab[]
  activeTabId?: string
}

export type PaneState = TerminalPaneState | BrowserPaneState | EditorPaneState

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
  title: string
  body?: string
  ts: number
  read: boolean
}

export type Theme = 'dark' | 'light' | 'system'

export interface Settings {
  theme: Theme
  accent: string
  uiFont: string
  termFont: string
  termFontSize: number
  osNotifications: boolean
  providers: Record<string, boolean>
}

export interface AgentProviderInfo {
  label: string
  match: string[]
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
