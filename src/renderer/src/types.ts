/** content kinds a leaf can stack — a "pane" has no type of its own */
export type BlockKind = 'term' | 'web' | 'file' | 'widget'

/** built-in widget blocks — 'agents' mirrors the sidebar's per-pane session
 *  list into a tab, 'usage' is a per-harness rate-limit dashboard */
export type WidgetKind = 'agents' | 'usage'

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

export interface TerminalTab {
  kind: 'term'
  id: string
  /** user-set label (double-click rename); falls back to agent/shell */
  title?: string
  cwd?: string
  shell?: string
  exited?: boolean
  agent?: string | null
  /** a turn is in flight — driven by output activity while an agent owns the
   *  shell (hook turn-start/end events refine it); renders as the pulsing
   *  status dot in the tab's close-button slot */
  working?: boolean
  /** output can't light `working` until this time — set when an authoritative
   *  event just declared the turn over (hook clear, fresh agent detect) so the
   *  post-turn prompt redraw / startup banner doesn't relight the pulse */
  quietUntil?: number
  /** live pty-host session id — lets remounts/detached windows `attach`
   *  (with scrollback replay) instead of spawning a new shell */
  pty?: string
}

export interface BrowserTab {
  kind: 'web'
  id: string
  url: string
  title: string
}

export interface EditorTab {
  kind: 'file'
  id: string
  /** '' = an empty editor block (created without a file — shows the
   *  open-file empty state until one is picked) */
  path: string
  name: string
  dirty?: boolean
  /** VS Code-style preview tab — italic label, replaced in place by the next
      preview open, pins permanently on edit / double-click / Keep Open */
  preview?: boolean
}

export interface WidgetTab {
  kind: 'widget'
  id: string
  widget: WidgetKind
  /** usage widget: the provider whose limits are on screen */
  provider?: string
}

/** one tab inside a leaf — the block */
export type PaneTab = TerminalTab | BrowserTab | EditorTab | WidgetTab

export interface PaneState {
  id: string
  tabs: PaneTab[]
  activeTabId?: string
  /** user-set pane name (⋯ menu / double-click the titlebar chip) — wins over
   *  the derived label everywhere a pane needs an identity */
  name?: string
  /** stable creation-order number within the workspace — the fallback
   *  identity ('pane N'); layout position shifts with splits so it can't
   *  come from the tree */
  num?: number
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
  /** the leaf's file-tree root (editor corner-fab peek overlay) — defaults to
   *  the project path, materialized onto the pane on float/detach */
  treeRoot?: string
}

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
  /** tab inside paneId to activate on click */
  tabId?: string
  title: string
  body?: string
  /** session label — user-renamed tab title, else cwd */
  session?: string
  /** agent provider id — renders the vendor icon in the notification list */
  agent?: string
  /** 'needs-input' pings auto-resolve when the same tab's turn resumes
   *  (a later event for the same session/tab marks them read). Both kinds
   *  color the emitting tab's status dot while unread */
  kind?: 'needs-input' | 'error'
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

/** one usage window/bucket on a provider's rate-limit dashboard */
export interface UsageWindow {
  id: string
  label: string
  /** % of the window already consumed (0–100); undefined = unlimited/none */
  usedPct?: number
  /** epoch ms when the window resets */
  resetAt?: number
  /** free-form note — 'unlimited', 'x/y remaining', … */
  detail?: string
}

/** normalized result of a provider usage probe (src/main/usage.ts) */
export interface UsageResult {
  ok: boolean
  provider: string
  /** plan tier when the provider reports one ('pro', 'plus', …) */
  plan?: string
  windows: UsageWindow[]
  /** extra account facts worth a line (credit balance, reset credits) */
  extra?: string
  error?: string
  fetchedAt: number
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
