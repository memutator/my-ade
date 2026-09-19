import type { ExecutionBinding } from '../../../packages/mahas-contracts/src/index.ts'

/** content kinds a leaf can stack — a "pane" has no type of its own */
export type BlockKind = 'term' | 'web' | 'file' | 'widget'

/** built-in widget blocks — 'agents' mirrors the sidebar's per-pane session
 *  list into a tab, 'usage' is a multi-harness rate-limit dashboard; the
 *  workbench widgets (IMP-31/32) are the 팀장's responsibility/team/plan
 *  views over the control plane's C-DISCOVERY/C-WORK contracts */
export type WidgetKind =
  'agents' | 'usage' | 'tokens' | 'responsibility' | 'team' | 'plan' | 'inspector'

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
  /** set when `working` last lit — drives the agents list's elapsed timer */
  workingSince?: number
  /** last time a turn ended (hook clear or the output-silence timeout) —
   *  drives the agents list's '… ago' label for idle sessions */
  turnEndedAt?: number
  /** output can't light `working` until this time — set when an authoritative
   *  event just declared the turn over (hook clear, fresh agent detect) so the
   *  post-turn prompt redraw / startup banner doesn't relight the pulse */
  quietUntil?: number
  /** hook/agent-detect declared the turn idle — output (TUI redraws, watchers)
   *  must not relight `working` until the user types or a turn-start arrives.
   *  Codex has no turn-start and its idle TUI is a dense frame stream, so a
   *  time window alone never holds. */
  idleLocked?: boolean
  /** live pty-host session id — lets remounts/detached windows `attach`
   *  (with scrollback replay) instead of spawning a new shell */
  pty?: string
  /** managed-execution binding (C-CLIENT client.view.bind): set only when a
   *  control plane binds this tab's view to an Execution/Terminal it owns —
   *  a separate identity from the pane/tab (REQ-11). Plain pty terminals
   *  never get one, and a tab persisted before the runtime existed is NOT
   *  retro-claimed as a managed execution (REQ-27) */
  binding?: ExecutionBinding
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
  /** usage widget: last/primary provider (tab subtitle; also hydrates old tabs) */
  provider?: string
  /** usage widget: harnesses whose quotas are on the dashboard */
  providers?: string[]
}

/** one tab inside a leaf — the block */
export type PaneTab = (TerminalTab | BrowserTab | EditorTab | WidgetTab) & {
  /** tucked out of the tab strip into the leaf's tab dock — the block stays
   *  mounted (pty/webview/buffer keep running); its chip restores it */
  minimized?: boolean
}

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

/** a toast anchored to one pane (optionally one tab within it) — overlays
 *  the pane body top-right, never pushing content. 'info' auto-dismisses;
 *  'warn' sticks until acted on or closed. */
export interface PaneToastAction {
  id: string
  label: string
  run: () => void
}

export interface PaneToast {
  id: string
  wsId: string
  paneId: string
  /** when set, the toast is visible only while this tab is the pane's
   *  active one — the notice waits for the tab it belongs to */
  tabId?: string
  /** dedupe key — a push with the same wsId+paneId+key replaces the
   *  existing toast instead of stacking */
  key?: string
  kind: 'info' | 'warn'
  text: string
  actions?: PaneToastAction[]
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
  /** extra OAuth credential files the usage widget probes alongside each
   *  harness's default login (multi-account quota) */
  usageAccounts?: UsageAccount[]
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

// the hook-stream wire type is a contract (mahas-contracts operations/hooks.ts);
// the renderer re-exports it instead of keeping a drifting copy
export type { AgentHookEvent } from '../../../packages/mahas-contracts/src/index.ts'

/**
 * A live agent session worth offering to resume after an app restart. One per
 * harness sessionId — the set is the sessions that were alive when the state
 * was last persisted, never a history. Entries are dropped as soon as the
 * session ends (session-end event, agent process leaving the tab's process
 * tree, pty exit, tab/pane/workspace close).
 */
export interface ResumeSession {
  /** Main-stamped evidence for an app-induced PTY shutdown, imported on boot. */
  shutdown?: { runId: string; at: number }
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

// Legacy usage wire shapes are DEFINED in the preload transport module and
// re-exported here so UI code has one import path. They describe the old
// scanner-era channels; the migrated usage UI reads `window.mahas.domain.*`
// (see src/preload/domain.ts) and keeps these only where a legacy channel is
// still consumed.
export type {
  LedgerProfile,
  LedgerQuery,
  LedgerResult,
  LedgerSession,
  TokenUse,
  UsageAuthDone,
  UsageAuthStart,
  UsageResult,
  UsageWindow
} from '../../preload/index'
export type {
  DomainAuthFlow,
  DomainAuthOutcome,
  DomainFreshness,
  DomainQuotaCurrentView,
  DomainReadiness,
  DomainSessionsResult,
  DomainUnidentified,
  DomainUsageLedgerResult,
  DomainUsageSourceView,
  DomainUsageSourcesResult,
  DomainUsageStatisticRow,
  DomainUsageStatisticsResult,
  DomainUsageSummariesResult,
  DomainUsageSummaryRow
} from '../../preload/domain'

/** A credential the usage widget keeps as a DESKTOP record.
 *
 *  This is persisted desktop state, not the inventory domain: `harnessId` says
 *  which CLI reads the file. `provider` is the old serialized name for exactly
 *  that field — it is NOT a catalog Provider and must never be resolved as one.
 *  The canonical equivalent (ProviderCredential + ProviderConnection) lives in
 *  the daemon store and is reached through `window.mahas.domain.usageSources`. */
export interface UsageAccount {
  id: string
  /** old serialized harness selector, kept so existing state hydrates */
  provider?: string
  /** explicit replacement for the old `provider` harness selector */
  harnessId?: string
  path: string
  /** display fallback when the creds themselves carry no identity */
  label?: string
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
