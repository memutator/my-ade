import { create } from 'zustand'
import type {
  AgentSessionInfo,
  AppNotification,
  BlockKind,
  Bookmark,
  BrowserTab,
  DropEdge,
  EditorTab,
  LayoutNode,
  PaneState,
  PaneTab,
  Project,
  ResumeSession,
  Settings,
  TerminalTab,
  ToastItem,
  WidgetKind,
  Workspace
} from './types'

const uid = (): string => crypto.randomUUID()

function makeTab(kind: BlockKind, home = '', widget?: WidgetKind): PaneTab {
  switch (kind) {
    case 'term':
      return { kind, id: uid() }
    case 'web':
      return { kind, id: uid(), url: home || 'https://', title: '' }
    case 'file':
      return { kind, id: uid(), path: '', name: '' }
    case 'widget':
      return { kind, id: uid(), widget: widget ?? 'agents' }
  }
}

function makePane(kind: BlockKind, home = '', widget?: WidgetKind): PaneState {
  const tab = makeTab(kind, home, widget)
  return { id: uid(), tabs: [tab], activeTabId: tab.id }
}

function leaf(paneId: string): LayoutNode {
  return { kind: 'leaf', id: uid(), paneId }
}

// Insert a leaf for paneId into root: split `targetPaneId` at `edge` when the
// target leaf exists, append at the end when target is null (n/(n+1) keeps the
// existing panes' relative share), or become the sole leaf when root is null.
function insertAt(
  root: LayoutNode | null,
  panes: Record<string, PaneState>,
  paneId: string,
  targetPaneId: string | null,
  edge: DropEdge | null
): LayoutNode {
  if (root && targetPaneId && edge && leafPaneIds(root).includes(targetPaneId)) {
    const dir: 'row' | 'col' = edge === 'left' || edge === 'right' ? 'row' : 'col'
    const first = edge === 'left' || edge === 'top'
    return mapLeaf(root, targetPaneId, (l) => ({
      kind: 'split',
      id: uid(),
      dir,
      ratio: 0.5,
      a: first ? leaf(paneId) : l,
      b: first ? l : leaf(paneId)
    }))
  }
  if (root) {
    const n = Math.max(1, visibleLeafIds(root, panes).length)
    return {
      kind: 'split',
      id: uid(),
      dir: 'row',
      ratio: n / (n + 1),
      a: root,
      b: leaf(paneId)
    }
  }
  return leaf(paneId)
}

// Insert a pane into a workspace: as the only leaf when empty, else appended
// after the visible leaves (callers reach here only when nothing visible
// exists — programmatic opens stack into a leaf instead of splitting).
// Focus moves to the new pane.
function insertPane(w: Workspace, pane: PaneState): Workspace {
  pane.num ??= nextPaneNum(w)
  const panes = { ...w.panes, [pane.id]: pane }
  const vis = visibleLeafIds(w.root, w.panes)
  const target =
    w.focusedPaneId && vis.includes(w.focusedPaneId) ? w.focusedPaneId : (vis.at(-1) ?? null)
  return {
    ...w,
    panes,
    root: insertAt(w.root, panes, pane.id, target, 'right'),
    focusedPaneId: pane.id
  }
}

// The leaf a programmatic open lands in: the explicit requester (a pane's own
// UI — allowed even when detached), else the focused visible pane, else the
// last visible leaf. Undefined = nothing on screen; the caller makes a leaf.
// Invariant: opens stack into an existing leaf, never split — a focused leaf
// can only be split by explicit user gestures (split keys, drag-to-edge),
// with ONE exception: see soleLeafSplit.
function stackTarget(w: Workspace, paneId?: string | null): string | undefined {
  const explicit = paneId && w.panes[paneId] && !w.panes[paneId].minimized ? paneId : undefined
  const focused =
    w.focusedPaneId &&
    w.panes[w.focusedPaneId] &&
    !w.panes[w.focusedPaneId].minimized &&
    !w.panes[w.focusedPaneId].detached
      ? w.focusedPaneId
      : undefined
  return explicit ?? focused ?? visibleLeafIds(w.root, w.panes).at(-1)
}

// The one exception to stack-don't-split: a workspace with a single visible
// leaf. Stacking a new tab on top of it hides the thing you were looking at,
// so the open splits that leaf right and lands in the new pane instead.
// Returns the updated workspace, or null when the exception doesn't apply.
function soleLeafSplit(w: Workspace, target: string | undefined, tab: PaneTab): Workspace | null {
  const vis = visibleLeafIds(w.root, w.panes)
  if (!target || vis.length !== 1 || vis[0] !== target) return null
  const pane = makePane('term')
  pane.tabs = [tab]
  pane.activeTabId = tab.id
  pane.num = nextPaneNum(w)
  const panes = { ...w.panes, [pane.id]: pane }
  return {
    ...w,
    panes,
    root: insertAt(w.root, panes, pane.id, target, 'right'),
    focusedPaneId: pane.id
  }
}

// Push a tab into a leaf and raise it — the shared tail of every
// programmatic open. Focus follows unless the target is detached (its window
// owns focus there).
function pushTab(w: Workspace, paneId: string, tabs: PaneTab[], activeTabId: string): Workspace {
  const p = w.panes[paneId]
  if (!p) return w
  return {
    ...w,
    panes: { ...w.panes, [paneId]: { ...p, tabs, activeTabId } },
    focusedPaneId: p.detached ? w.focusedPaneId : paneId
  }
}

function mapLeaf(
  node: LayoutNode,
  paneId: string,
  fn: (l: Extract<LayoutNode, { kind: 'leaf' }>) => LayoutNode | null
): LayoutNode {
  if (node.kind === 'leaf') {
    if (node.paneId !== paneId) return node
    const r = fn(node)
    return r ?? node
  }
  const a = mapLeaf(node.a, paneId, fn)
  const b = mapLeaf(node.b, paneId, fn)
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

function removeLeaf(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.kind === 'leaf') return node.paneId === paneId ? null : node
  const a = removeLeaf(node.a, paneId)
  const b = removeLeaf(node.b, paneId)
  if (a === null) return b
  if (b === null) return a
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

// Drop a pane record + its layout leaf and re-aim focus at the nearest
// visible leaf (or a non-minimized float). IPC side effects for detached
// panes (pty kill, window close) are the caller's job — this is pure state.
function removePaneFromWs(w: Workspace, paneId: string): Workspace {
  if (!w.panes[paneId]) return w
  const root = w.root ? removeLeaf(w.root, paneId) : w.root
  const panes = { ...w.panes }
  delete panes[paneId]
  const focusedPaneId =
    w.focusedPaneId === paneId
      ? (visibleLeafIds(root, panes)[0] ??
        Object.values(panes).find((p) => p.floating && !p.minimized)?.id ??
        null)
      : w.focusedPaneId
  return { ...w, root, panes, focusedPaneId }
}

function swapPaneIds(node: LayoutNode, a: string, b: string): LayoutNode {
  if (node.kind === 'leaf') {
    if (node.paneId === a) return { ...node, paneId: b }
    if (node.paneId === b) return { ...node, paneId: a }
    return node
  }
  const na = swapPaneIds(node.a, a, b)
  const nb = swapPaneIds(node.b, a, b)
  if (na === node.a && nb === node.b) return node
  return { ...node, a: na, b: nb }
}

function setRatioIn(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.kind === 'leaf') return node
  if (node.id === splitId) return { ...node, ratio }
  return { ...node, a: setRatioIn(node.a, splitId, ratio), b: setRatioIn(node.b, splitId, ratio) }
}

export function leafPaneIds(node: LayoutNode | null): string[] {
  if (!node) return []
  if (node.kind === 'leaf') return [node.paneId]
  return [...leafPaneIds(node.a), ...leafPaneIds(node.b)]
}

// Leaf ids whose pane is not minimized/detached — i.e. the actually visible
// layout. Those panes keep their leaf (removing it would collapse the split
// and lose their slot); SplitView hides fully-hidden subtrees with `hidden`.
export function visibleLeafIds(
  node: LayoutNode | null,
  panes: Record<string, PaneState>
): string[] {
  return leafPaneIds(node).filter((id) => !panes[id]?.minimized && !panes[id]?.detached)
}

// Highest z among a workspace's floating panes (new raises go above it).
function maxFloatZ(w: Workspace): number {
  let z = 0
  for (const p of Object.values(w.panes)) if (p.floating) z = Math.max(z, p.floating.z)
  return z
}

// A pane's display number is creation order within the workspace — stable
// across splits/moves (layout position isn't identity). Not necessarily
// contiguous: closed panes leave gaps rather than renumbering survivors.
function nextPaneNum(w: Workspace): number {
  let n = 0
  for (const p of Object.values(w.panes)) n = Math.max(n, p.num ?? 0)
  return n + 1
}

// The sibling subtree of paneId's leaf — its nearest neighbor in the layout.
function siblingOf(node: LayoutNode | null, paneId: string): LayoutNode | null {
  if (!node || node.kind === 'leaf') return null
  if (node.a.kind === 'leaf' && node.a.paneId === paneId) return node.b
  if (node.b.kind === 'leaf' && node.b.paneId === paneId) return node.a
  return siblingOf(node.a, paneId) ?? siblingOf(node.b, paneId)
}

// When a pane leaves the layout (float/detach) its tree root materializes to
// the project path if it never had one — the pane keeps its own root from
// then on, independent of the workspace it sits in.
function withTreeRoot(pane: PaneState, projectPath: string | undefined): PaneState {
  if (pane.treeRoot || !projectPath) return pane
  return { ...pane, treeRoot: projectPath }
}

// Clear a pane's minimized flag and focus it. Its leaf is still in the layout
// so the pane pops back into its exact slot; floating panes aren't in the
// tree at all — clearing the flag just brings the overlay back. Defensively,
// a leaf missing from root is re-inserted at the focused visible pane (or as
// the sole leaf).
function restoreInWorkspace(w: Workspace, paneId: string): Workspace {
  const pane = w.panes[paneId]
  if (!pane?.minimized) return w
  const panes = { ...w.panes, [paneId]: { ...pane, minimized: undefined } as PaneState }
  if (pane.floating || (w.root && leafPaneIds(w.root).includes(paneId))) {
    return { ...w, panes, focusedPaneId: paneId }
  }
  const vis = visibleLeafIds(w.root, panes)
  const target = w.focusedPaneId && vis.includes(w.focusedPaneId) ? w.focusedPaneId : null
  return {
    ...w,
    panes,
    root: insertAt(w.root, panes, paneId, target, 'right'),
    focusedPaneId: paneId
  }
}

// stateVersion<3 saves: panes carried a `type` ('terminal'/'browser'/'editor'
// /'todo') and tabs carried no `kind`. Migrates to the type-less leaf model —
// every pane is a stack of kind-tagged tabs. Returns null for panes to drop
// (todo panes, tab-less strays); the caller removes their leaf.
function normalizePane(
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

function normalizeWorkspace(w: Workspace): Workspace {
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

const DEFAULT_SETTINGS: Settings = {
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

interface AdeState extends PersistedState {
  notifications: AppNotification[]
  /** ambient-level pings shown as slide-down toasts — runtime-only */
  toasts: ToastItem[]
  notifOpen: boolean
  settingsOpen: boolean
  resolvedTheme: 'dark' | 'light'
  setResolvedTheme: (t: 'dark' | 'light') => void

  hydrate: (s: Partial<PersistedState>) => void

  addProject: (path: string, name?: string) => Project
  removeProject: (id: string) => void

  createWorkspace: (projectId: string, name?: string) => void
  activateWorkspace: (id: string) => void
  cycleWorkspace: (dir: 1 | -1) => void
  renameWorkspace: (id: string, name: string) => void
  closeWorkspace: (id: string) => void
  moveWorkspace: (from: number, to: number) => void

  /** stack a fresh block of `kind` into the target leaf (explicit > focused >
      last visible); only creates a leaf when nothing visible exists. `widget`
      picks the WidgetKind when kind === 'widget' */
  newBlock: (kind: BlockKind, wsId?: string, widget?: WidgetKind) => void
  /** explicit split — only user gestures reach this */
  splitPane: (paneId: string, dir: 'row' | 'col', kind: BlockKind, wsId?: string) => void
  closePane: (paneId: string, wsId?: string) => void
  minimizePane: (paneId: string, wsId?: string) => void
  restorePane: (paneId: string, wsId?: string) => void
  floatPane: (paneId: string, wsId?: string) => void
  dockPane: (
    paneId: string,
    wsId?: string,
    targetPaneId?: string | null,
    edge?: DropEdge | null
  ) => void
  setFloatRect: (
    paneId: string,
    rect: { x: number; y: number; w: number; h: number },
    wsId?: string
  ) => void
  detachPane: (paneId: string, wsId?: string) => void
  attachPane: (paneId: string, wsId?: string) => void
  movePane: (
    paneId: string,
    fromWsId: string,
    toWsId: string,
    targetPaneId: string | null,
    edge?: 'left' | 'right' | 'top' | 'bottom' | null
  ) => void
  /** tab drag & drop — pull one tab out of its leaf: stack onto targetPaneId
      (no edge), split it (edge), or append a fresh leaf to toWsId (null) */
  moveTab: (
    fromWsId: string,
    fromPaneId: string,
    tabId: string,
    toWsId: string,
    targetPaneId: string | null,
    edge?: 'left' | 'right' | 'top' | 'bottom' | null
  ) => void
  setRatio: (splitId: string, ratio: number, wsId?: string) => void
  updatePane: (paneId: string, patch: Partial<PaneState>, wsId?: string) => void
  focusPane: (paneId: string, wsId?: string) => void
  cycleFocus: (dir: 1 | -1, wsId?: string) => void
  cyclePaneTab: (dir: 1 | -1, wsId?: string) => void

  openFile: (path: string, name: string, wsId?: string, preview?: boolean, paneId?: string) => void
  // newTab appends a tab instead of navigating the active web tab — explicit
  // opens (file tree) shouldn't destroy a page the user is on
  openUrlInBrowser: (url: string, wsId?: string, newTab?: boolean, paneId?: string) => void
  // file-tree ops: keep open editor tabs pointing at real paths — a rename or
  // move remaps tab.path (incl. descendants of a renamed dir), a delete closes
  // the tab
  remapOpenFile: (oldPath: string, newPath: string) => void
  closeFilesUnder: (paths: string[]) => void

  setSidebarOpen: (open: boolean) => void
  setSidebarRoot: (projectId: string, path: string) => void
  setSideAgentsCollapsed: (collapsed: boolean) => void
  setSideAgentsFrac: (frac: number) => void
  setAgentsScope: (scope: 'ws' | 'all') => void
  pushTreeRoot: (path: string) => void
  setTreeOverlayOpen: (open: boolean) => void
  setNotifOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  updateSettings: (patch: Partial<Settings>) => void

  addBookmark: (b: { title: string; url: string; scope: string }) => void
  removeBookmark: (id: string) => void

  notify: (n: Omit<AppNotification, 'id' | 'ts' | 'read'> & { read?: boolean }) => string
  pushToast: (t: Omit<ToastItem, 'id' | 'ts'>) => void
  dismissToast: (id: string) => void
  /** settle pending needs-input pings for a session or tab (turn resumed /
   *  ended / cancelled — the prompt is stale either way) */
  settleInput: (k: { wsId?: string; paneId?: string; tabId?: string; sessionId?: string }) => void
  markRead: (id: string) => void
  /** a window reports the target it's currently attending — unread pings
   *  pointed at it clear without needing a notification click */
  markAttendedRead: (m: { wsId: string; paneId?: string; tabId?: string }) => void
  markAllRead: () => void
  clearNotifications: () => void
  goToNotification: (id: string) => void

  upsertAgentSession: (sessionId: string, info: Partial<AgentSessionInfo>) => void
  renameAgentSession: (sessionId: string, name: string) => void

  upsertResumeSession: (r: Omit<ResumeSession, 'ts'>) => void
  dropResumeSession: (sessionId: string) => void
  /** drop every resume candidate matching a predicate — tab/pane/workspace
   *  teardown paths call this so closed shells leave nothing to restore */
  dropResumeWhere: (pred: (r: ResumeSession) => boolean) => void
}

function updWs(
  workspaces: Workspace[],
  wsId: string,
  fn: (w: Workspace) => Workspace
): Workspace[] {
  return workspaces.map((w) => (w.id === wsId ? fn(w) : w))
}

export const useStore = create<AdeState>((set, get) => {
  // helper: resolve wsId (default: active)
  const wid = (wsId?: string): string | null => wsId ?? get().activeWorkspaceId

  const home = (): string => get().settings.homeUrl.trim()

  return {
    projects: [],
    workspaces: [],
    activeWorkspaceId: null,
    settings: DEFAULT_SETTINGS,
    sidebarOpen: false,
    treeOverlayOpen: false,
    bookmarks: [],
    agentSessions: {},
    resumeSessions: {},
    treeRoots: [],
    sidebarRoots: {},
    sideAgentsCollapsed: false,
    sideAgentsFrac: 0.38,
    agentsScope: 'ws',
    notifications: [],
    toasts: [],
    notifOpen: false,
    settingsOpen: false,
    resolvedTheme: 'dark',
    setResolvedTheme: (t) => set({ resolvedTheme: t }),

    hydrate: (s) => {
      const workspaces = (s.workspaces ?? []).map(normalizeWorkspace)
      // resume records survive restarts, but only while their pane+tab do —
      // anything that died structurally since the last save is unrecoverable.
      // v<2 records predate env-stamped attribution — they were resolved by
      // cwd guessing and evict each other when several share a directory, so
      // the whole set is discarded rather than offering wrong-tab resumes.
      const versioned = (s.stateVersion ?? 1) >= 2
      const byTab = new Map<string, [string, ResumeSession]>()
      if (versioned) {
        for (const e of Object.entries(s.resumeSessions ?? {})) {
          const r = e[1]
          const pane = workspaces.find((w) => w.id === r.wsId)?.panes[r.paneId]
          if (!pane?.tabs.some((t) => t.id === r.tabId && t.kind === 'term')) continue
          const key = `${r.paneId}:${r.tabId}`
          const prev = byTab.get(key)
          if (!prev || r.ts > prev[1].ts) byTab.set(key, e)
        }
      }
      const resumeSessions = Object.fromEntries(byTab.values())
      set({
        projects: s.projects ?? [],
        workspaces,
        activeWorkspaceId: s.activeWorkspaceId ?? s.workspaces?.[0]?.id ?? null,
        settings: { ...DEFAULT_SETTINGS, ...s.settings },
        sidebarOpen: s.sidebarOpen ?? false,
        bookmarks: s.bookmarks ?? [],
        agentSessions: s.agentSessions ?? {},
        resumeSessions,
        treeRoots: s.treeRoots ?? [],
        sidebarRoots: s.sidebarRoots ?? {},
        sideAgentsCollapsed: s.sideAgentsCollapsed ?? false,
        sideAgentsFrac:
          typeof s.sideAgentsFrac === 'number'
            ? Math.min(0.8, Math.max(0.12, s.sideAgentsFrac))
            : 0.38,
        agentsScope: s.agentsScope === 'all' ? 'all' : 'ws'
      })
    },

    addProject: (path, name) => {
      const existing = get().projects.find((p) => p.path === path)
      if (existing) return existing
      const proj: Project = {
        id: uid(),
        path,
        name: name ?? path.split('/').filter(Boolean).pop() ?? path
      }
      set((s) => ({ projects: [...s.projects, proj] }))
      return proj
    },

    removeProject: (id) =>
      set((s) => {
        const deadWs = new Set(s.workspaces.filter((w) => w.projectId === id).map((w) => w.id))
        const workspaces = s.workspaces.filter((w) => w.projectId !== id)
        const resumeSessions = Object.fromEntries(
          Object.entries(s.resumeSessions).filter(([, r]) => !deadWs.has(r.wsId))
        )
        return {
          projects: s.projects.filter((p) => p.id !== id),
          workspaces,
          // don't leave the active id dangling on a dead workspace
          activeWorkspaceId: deadWs.has(s.activeWorkspaceId ?? '')
            ? (workspaces[0]?.id ?? null)
            : s.activeWorkspaceId,
          bookmarks: s.bookmarks.filter((b) => b.scope !== id),
          resumeSessions
        }
      }),

    createWorkspace: (projectId, name) =>
      set((s) => {
        const count = s.workspaces.filter((w) => w.projectId === projectId).length
        const ws: Workspace = {
          id: uid(),
          name: `${name ?? 'workspace'} ${count + 1}`,
          projectId,
          root: null,
          panes: {},
          focusedPaneId: null
        }
        return { workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id }
      }),

    activateWorkspace: (id) => set({ activeWorkspaceId: id }),

    cycleWorkspace: (dir) =>
      set((s) => {
        const n = s.workspaces.length
        if (n === 0) return s
        const i = s.workspaces.findIndex((w) => w.id === s.activeWorkspaceId)
        return { activeWorkspaceId: s.workspaces[(Math.max(0, i) + dir + n) % n].id }
      }),

    renameWorkspace: (id, name) =>
      set((s) => ({
        workspaces: updWs(s.workspaces, id, (w) => ({ ...w, name: name.trim() || w.name }))
      })),

    closeWorkspace: (id) =>
      set((s) => {
        const idx = s.workspaces.findIndex((w) => w.id === id)
        const workspaces = s.workspaces.filter((w) => w.id !== id)
        let activeWorkspaceId = s.activeWorkspaceId
        if (activeWorkspaceId === id) {
          const next = workspaces[Math.min(idx, workspaces.length - 1)]
          activeWorkspaceId = next?.id ?? null
        }
        const resumeSessions = Object.fromEntries(
          Object.entries(s.resumeSessions).filter(([, r]) => r.wsId !== id)
        )
        return { workspaces, activeWorkspaceId, resumeSessions }
      }),

    moveWorkspace: (from, to) =>
      set((s) => {
        const workspaces = [...s.workspaces]
        const [w] = workspaces.splice(from, 1)
        workspaces.splice(to, 0, w)
        return { workspaces }
      }),

    // Opening content never splits the focused leaf: the block stacks into
    // the target leaf as a tab (explicit > focused > last visible). A new
    // leaf only appears when nothing visible exists — or when the workspace
    // has exactly one visible leaf, which splits right instead (soleLeafSplit).
    newBlock: (kind, wsIdArg, widget) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        const ws = s.workspaces.find((w) => w.id === wsId)
        if (!ws) return s
        const target = stackTarget(ws)
        if (!target) {
          return {
            workspaces: updWs(s.workspaces, wsId, (w) =>
              insertPane(w, makePane(kind, home(), widget))
            )
          }
        }
        const tab = makeTab(kind, home(), widget)
        return {
          workspaces: updWs(
            s.workspaces,
            wsId,
            (w) =>
              soleLeafSplit(w, target, tab) ??
              pushTab(w, target, [...w.panes[target].tabs, tab], tab.id)
          )
        }
      }),

    splitPane: (paneId, dir, kind, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        const pane = makePane(kind, home())
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => {
            pane.num ??= nextPaneNum(w)
            const panes = { ...w.panes, [pane.id]: pane }
            const vis = visibleLeafIds(w.root, w.panes)
            // a minimized pane can't be split — retarget the last visible leaf
            // so the new pane never lands in a hidden slot
            const target = vis.includes(paneId) ? paneId : (vis.at(-1) ?? null)
            const root = insertAt(
              w.root,
              panes,
              pane.id,
              target,
              dir === 'row' ? 'right' : 'bottom'
            )
            return { ...w, panes, root, focusedPaneId: pane.id }
          })
        }
      }),

    closePane: (paneId, wsIdArg) => {
      const wsId0 = wid(wsIdArg)
      if (!wsId0) return
      const pane = get().workspaces.find((w) => w.id === wsId0)?.panes[paneId]
      // a detached pane owns its window + pty sessions — the window's renderer
      // is already gone by close time, so kill its live sessions here
      if (pane?.detached) {
        for (const t of pane.tabs) if (t.kind === 'term' && t.pty) window.ade.pty.kill(t.pty)
        window.ade.win.closeDetached?.(wsId0, paneId)
      }
      set((s) => {
        const wsId = wsId0
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => removePaneFromWs(w, paneId)),
          resumeSessions: Object.fromEntries(
            Object.entries(s.resumeSessions).filter(([, r]) => r.paneId !== paneId)
          )
        }
      })
    },

    // Dock the pane: flag it minimized (the leaf stays in the layout so the
    // mounted terminal/webview keeps running; SplitView hides the subtree)
    // and hand focus to the nearest still-visible pane.
    minimizePane: (paneId, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => {
            const pane = w.panes[paneId]
            if (!pane || pane.minimized || pane.detached) return w
            const panes = { ...w.panes, [paneId]: { ...pane, minimized: true } }
            const focusedPaneId = visibleLeafIds(w.root, panes).includes(w.focusedPaneId ?? '')
              ? w.focusedPaneId
              : (visibleLeafIds(siblingOf(w.root, paneId), panes)[0] ??
                visibleLeafIds(w.root, panes)[0] ??
                null)
            return { ...w, panes, focusedPaneId }
          })
        }
      }),

    restorePane: (paneId, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => restoreInWorkspace(w, paneId))
        }
      }),

    // Pull a docked pane out of the tree into a free-floating overlay. The
    // leaf is removed (its space is reclaimed — that's the point of floats)
    // while the pane record keeps living in `panes`.
    floatPane: (paneId, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => {
            const pane0 = w.panes[paneId]
            if (!pane0 || pane0.floating || pane0.detached) return w
            const pane = withTreeRoot(pane0, s.projects.find((x) => x.id === w.projectId)?.path)
            const floating = {
              x: 0.28,
              y: 0.18,
              w: 0.44,
              h: 0.55,
              z: maxFloatZ(w) + 1
            }
            const panes = {
              ...w.panes,
              [paneId]: { ...pane, minimized: undefined, floating } as PaneState
            }
            const root = w.root ? removeLeaf(w.root, paneId) : w.root
            return { ...w, root, panes, focusedPaneId: paneId }
          })
        }
      }),

    // Put a floating pane back into the tree — at the target's edge when
    // given (drag-dock), else split the focused visible leaf.
    dockPane: (paneId, wsIdArg, targetPaneId, edge) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => {
            const pane = w.panes[paneId]
            if (!pane?.floating) return w
            const docked = { ...pane, floating: undefined, minimized: undefined } as PaneState
            const panes = { ...w.panes, [paneId]: docked }
            const vis = visibleLeafIds(w.root, w.panes)
            const target =
              targetPaneId && vis.includes(targetPaneId)
                ? targetPaneId
                : w.focusedPaneId && vis.includes(w.focusedPaneId)
                  ? w.focusedPaneId
                  : (vis.at(-1) ?? null)
            return {
              ...w,
              panes,
              root: insertAt(w.root, w.panes, paneId, target, edge ?? 'right'),
              focusedPaneId: paneId
            }
          })
        }
      }),

    setFloatRect: (paneId, rect, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => {
            const pane = w.panes[paneId]
            if (!pane?.floating) return w
            const w0 = Math.min(0.9, Math.max(0.12, rect.w))
            const h0 = Math.min(0.9, Math.max(0.15, rect.h))
            const floating = {
              ...pane.floating,
              x: Math.min(1 - w0, Math.max(0, rect.x)),
              y: Math.min(1 - h0, Math.max(0, rect.y)),
              w: w0,
              h: h0
            }
            return {
              ...w,
              panes: { ...w.panes, [paneId]: { ...pane, floating } as PaneState }
            }
          })
        }
      }),

    // Move the pane into its own OS window. The leaf stays in the tree
    // (reattach lands on the same slot) but the content unmounts here — the
    // detached window owns it; terminal sessions survive via pty `attach`.
    detachPane: (paneId, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => {
            const pane0 = w.panes[paneId]
            if (!pane0 || pane0.detached) return w
            const pane = withTreeRoot(pane0, s.projects.find((x) => x.id === w.projectId)?.path)
            const panes = { ...w.panes, [paneId]: { ...pane, detached: true } }
            const focusedPaneId =
              w.focusedPaneId === paneId
                ? (visibleLeafIds(w.root, panes)[0] ?? null)
                : w.focusedPaneId
            return { ...w, panes, focusedPaneId }
          })
        }
      }),

    attachPane: (paneId, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => {
            const pane = w.panes[paneId]
            if (!pane?.detached) return w
            return {
              ...w,
              panes: { ...w.panes, [paneId]: { ...pane, detached: undefined } as PaneState },
              focusedPaneId: paneId
            }
          })
        }
      }),

    // Drag & drop move. targetPaneId == null → append to the end of the target
    // layout (root wrapped in a row split). targetPaneId + edge → split that
    // leaf and drop the pane into the new half. targetPaneId without edge →
    // swap the two panes' positions (across workspaces both states migrate).
    movePane: (paneId, fromWsId, toWsId, targetPaneId, edge) =>
      set((s) => {
        const from = s.workspaces.find((w) => w.id === fromWsId)
        const to = s.workspaces.find((w) => w.id === toWsId)
        const pane = from?.panes[paneId]
        if (!from || !to || !pane) return s
        if (paneId === targetPaneId) return s
        if (targetPaneId && !to.panes[targetPaneId]) return s
        const sameWs = fromWsId === toWsId

        // Floating source: the pane lives outside the tree — strip just drops
        // its record and the graft inserts it docked (flags cleared).
        if (pane.floating) {
          const docked = {
            ...pane,
            floating: undefined,
            minimized: undefined,
            detached: undefined
          } as PaneState
          const graft = (w: Workspace): Workspace => {
            const panes = { ...w.panes, [paneId]: docked }
            const root = insertAt(w.root, panes, paneId, targetPaneId ?? null, edge ?? 'right')
            return { ...w, panes, root, focusedPaneId: paneId }
          }
          const strip = (w: Workspace): Workspace => {
            const panes = { ...w.panes }
            delete panes[paneId]
            return { ...w, panes }
          }
          if (sameWs) {
            return { workspaces: updWs(s.workspaces, toWsId, (w) => graft(strip(w))) }
          }
          return {
            activeWorkspaceId: toWsId,
            workspaces: s.workspaces.map((w) =>
              w.id === fromWsId ? strip(w) : w.id === toWsId ? graft(w) : w
            )
          }
        }

        if (!from.root) return s

        if (targetPaneId && !edge) {
          const target = to.panes[targetPaneId]
          if (sameWs) {
            return {
              workspaces: updWs(s.workspaces, toWsId, (w) =>
                w.root ? { ...w, root: swapPaneIds(w.root, paneId, targetPaneId) } : w
              )
            }
          }
          if (!to.root) return s
          return {
            activeWorkspaceId: toWsId,
            workspaces: s.workspaces.map((w) => {
              if (w.id === fromWsId) {
                const panes = { ...w.panes }
                delete panes[paneId]
                panes[targetPaneId] = target
                return {
                  ...w,
                  root: mapLeaf(w.root!, paneId, (l) => ({ ...l, paneId: targetPaneId })),
                  panes,
                  focusedPaneId: w.focusedPaneId === paneId ? targetPaneId : w.focusedPaneId
                }
              }
              if (w.id === toWsId) {
                const panes = { ...w.panes }
                delete panes[targetPaneId]
                panes[paneId] = pane
                return {
                  ...w,
                  root: mapLeaf(w.root!, targetPaneId, (l) => ({ ...l, paneId })),
                  panes,
                  focusedPaneId: paneId
                }
              }
              return w
            })
          }
        }

        const strip = (w: Workspace): Workspace => {
          const root = w.root ? removeLeaf(w.root, paneId) : w.root
          const panes = { ...w.panes }
          delete panes[paneId]
          const focusedPaneId =
            w.focusedPaneId === paneId ? (visibleLeafIds(root, panes)[0] ?? null) : w.focusedPaneId
          return { ...w, root, panes, focusedPaneId }
        }

        const graft = (w: Workspace): Workspace => {
          const panes = { ...w.panes, [paneId]: pane }
          const root = insertAt(w.root, panes, paneId, targetPaneId, edge ?? null)
          return { ...w, panes, root, focusedPaneId: paneId }
        }

        if (sameWs) {
          return { workspaces: updWs(s.workspaces, toWsId, (w) => graft(strip(w))) }
        }
        return {
          activeWorkspaceId: toWsId,
          workspaces: s.workspaces.map((w) =>
            w.id === fromWsId ? strip(w) : w.id === toWsId ? graft(w) : w
          )
        }
      }),

    // Tab drag & drop. targetPaneId + edge → split that leaf, the tab lands in
    // a fresh pane on the new half (target may be the source leaf itself —
    // splitting a tab off). targetPaneId without edge → stack onto that leaf
    // and raise the tab. targetPaneId null → a new leaf appended to toWsId.
    // A source pane emptied by the move dies — the tab record (and with it a
    // term tab's live pty) already moved, so nothing is killed.
    moveTab: (fromWsId, fromPaneId, tabId, toWsId, targetPaneId, edge) =>
      set((s) => {
        const from = s.workspaces.find((w) => w.id === fromWsId)
        const to = s.workspaces.find((w) => w.id === toWsId)
        const src = from?.panes[fromPaneId]
        const tab = src?.tabs.find((t) => t.id === tabId)
        if (!from || !to || !src || !tab) return s
        if (targetPaneId === fromPaneId && !edge) return s // drop on own center = noop
        if (targetPaneId && !to.panes[targetPaneId]) return s

        const remaining = src.tabs.filter((t) => t.id !== tabId)
        // unreachable from the UI (a detached pane isn't a drag source), but
        // an emptied detached pane must also lose its window
        if (!remaining.length && src.detached) window.ade.win.closeDetached?.(fromWsId, fromPaneId)

        const stripSrc = (w: Workspace): Workspace => {
          if (!remaining.length) return removePaneFromWs(w, fromPaneId)
          const activeTabId =
            src.activeTabId && remaining.some((t) => t.id === src.activeTabId)
              ? src.activeTabId
              : remaining.at(-1)!.id
          return {
            ...w,
            panes: { ...w.panes, [fromPaneId]: { ...src, tabs: remaining, activeTabId } }
          }
        }

        // fresh leaf for the split/append cases — id minted once so the two
        // workspace updates below graft the same pane
        const pane: PaneState = { id: uid(), tabs: [tab], activeTabId: tab.id }
        const graft = (w: Workspace): Workspace => {
          if (targetPaneId && !edge) {
            const target = w.panes[targetPaneId]
            return pushTab(w, targetPaneId, [...target.tabs, tab], tab.id)
          }
          pane.num ??= nextPaneNum(w)
          const panes = { ...w.panes, [pane.id]: pane }
          const root = insertAt(w.root, panes, pane.id, targetPaneId, edge ?? null)
          return { ...w, panes, root, focusedPaneId: pane.id }
        }

        // a moved tab takes its attribution with it — hook events keep
        // stamping the OLD paneId via env, so retarget the records attention
        // routing and session resume read
        const land = targetPaneId && !edge ? targetPaneId : pane.id
        const retarget = <T extends { wsId?: string; paneId?: string; tabId?: string }>(
          m: Record<string, T>
        ): Record<string, T> => {
          const next: Record<string, T> = {}
          for (const [k, v] of Object.entries(m))
            next[k] = v.tabId === tabId ? { ...v, wsId: toWsId, paneId: land } : v
          return next
        }
        const notifications = s.notifications.map((n) =>
          n.tabId === tabId ? { ...n, workspaceId: toWsId, paneId: land } : n
        )

        if (fromWsId === toWsId) {
          return {
            notifications,
            agentSessions: retarget(s.agentSessions),
            resumeSessions: retarget(s.resumeSessions),
            workspaces: updWs(s.workspaces, toWsId, (w) => graft(stripSrc(w)))
          }
        }
        return {
          activeWorkspaceId: toWsId,
          notifications,
          agentSessions: retarget(s.agentSessions),
          resumeSessions: retarget(s.resumeSessions),
          workspaces: s.workspaces.map((w) =>
            w.id === fromWsId ? stripSrc(w) : w.id === toWsId ? graft(w) : w
          )
        }
      }),

    setRatio: (splitId, ratio, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        return {
          workspaces: updWs(s.workspaces, wsId, (w) =>
            w.root
              ? {
                  ...w,
                  root: setRatioIn(w.root, splitId, Math.min(0.9, Math.max(0.1, ratio)))
                }
              : w
          )
        }
      }),

    updatePane: (paneId, patch, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => {
            const p = w.panes[paneId]
            if (!p) return w
            return { ...w, panes: { ...w.panes, [paneId]: { ...p, ...patch } as PaneState } }
          })
        }
      }),

    // focusing a minimized pane (e.g. a notification click) restores it —
    // otherwise the click would appear to do nothing
    focusPane: (paneId, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => {
            const pane = w.panes[paneId]
            if (!pane) return w
            if (pane.minimized) return restoreInWorkspace(w, paneId)
            if (pane.detached) return w
            // focusing a float raises it above the others
            if (pane.floating) {
              const z = maxFloatZ(w) + 1
              return {
                ...w,
                panes: {
                  ...w.panes,
                  [paneId]: { ...pane, floating: { ...pane.floating, z } } as PaneState
                },
                focusedPaneId: paneId
              }
            }
            return { ...w, focusedPaneId: paneId }
          })
        }
      }),

    cycleFocus: (dir, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => {
            const ids = [
              ...visibleLeafIds(w.root, w.panes),
              ...Object.values(w.panes)
                .filter((p) => p.floating && !p.minimized && !p.detached)
                .map((p) => p.id)
            ]
            if (ids.length === 0) return w
            const i = w.focusedPaneId ? ids.indexOf(w.focusedPaneId) : -1
            const nextId = ids[(i + dir + ids.length) % ids.length]
            const next = w.panes[nextId]
            if (next?.floating) {
              return {
                ...w,
                panes: {
                  ...w.panes,
                  [nextId]: {
                    ...next,
                    floating: { ...next.floating, z: maxFloatZ(w) + 1 }
                  } as PaneState
                },
                focusedPaneId: nextId
              }
            }
            return { ...w, focusedPaneId: nextId }
          })
        }
      }),

    // Ctrl+Tab target: advance activeTabId inside the focused pane's stack.
    cyclePaneTab: (dir, wsIdArg) => {
      const wsId = wid(wsIdArg)
      if (!wsId) return
      const ws = get().workspaces.find((w) => w.id === wsId)
      const p = ws?.focusedPaneId ? ws.panes[ws.focusedPaneId] : undefined
      if (!p || p.tabs.length < 2) return
      const i = Math.max(
        0,
        p.tabs.findIndex((t) => t.id === p.activeTabId)
      )
      const next = p.tabs[(i + dir + p.tabs.length) % p.tabs.length]
      get().updatePane(p.id, { activeTabId: next.id }, wsId)
    },

    // A file open stacks a file tab into the target leaf — never a split.
    // VS Code preview semantics live per leaf: preview opens reuse the leaf's
    // preview slot; an empty file block (Alt+E before picking a file) gets
    // filled by the first real file.
    openFile: (path, name, wsIdArg, preview, paneId) =>
      set((s) => {
        const wsId = wsIdArg ?? s.activeWorkspaceId
        if (!wsId) return s
        const ws = s.workspaces.find((w) => w.id === wsId)
        if (!ws) return s

        const tab: EditorTab = {
          kind: 'file',
          id: uid(),
          path,
          name,
          preview: preview || undefined
        }
        const target = stackTarget(ws, paneId)
        if (!target) {
          const pane = makePane('file')
          pane.tabs = [tab]
          pane.activeTabId = tab.id
          return { workspaces: updWs(s.workspaces, wsId, (w) => insertPane(w, pane)) }
        }

        const p = ws.panes[target]
        const existing = p.tabs.find((t): t is EditorTab => t.kind === 'file' && t.path === path)
        if (existing) {
          // a permanent open on a preview tab pins it
          const tabs =
            existing.preview && !preview
              ? p.tabs.map((t) => (t.id === existing.id ? { ...t, preview: undefined } : t))
              : p.tabs
          return {
            workspaces: updWs(s.workspaces, wsId, (w) => pushTab(w, target, tabs, existing.id))
          }
        }
        const emptyIdx = p.tabs.findIndex((t) => t.kind === 'file' && !t.path)
        const pi = preview ? p.tabs.findIndex((t) => t.kind === 'file' && t.preview) : -1
        const slot = emptyIdx >= 0 ? emptyIdx : pi
        if (slot < 0) {
          // a genuinely new tab on a one-leaf workspace splits right instead
          // of covering the leaf you were looking at
          return {
            workspaces: updWs(
              s.workspaces,
              wsId,
              (w) => soleLeafSplit(w, target, tab) ?? pushTab(w, target, [...p.tabs, tab], tab.id)
            )
          }
        }
        const tabs = p.tabs.map((t, i) => (i === slot ? tab : t))
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => pushTab(w, target, tabs, tab.id))
        }
      }),

    // The target leaf's active web tab navigates (newTab appends a web block
    // instead); nothing visible → a new leaf carrying the web block.
    openUrlInBrowser: (url, wsIdArg, newTab, paneId) =>
      set((s) => {
        const wsId = wsIdArg ?? s.activeWorkspaceId
        if (!wsId) return s
        const ws = s.workspaces.find((w) => w.id === wsId)
        if (!ws) return s

        const target = stackTarget(ws, paneId)
        const p = target ? ws.panes[target] : undefined
        const active = p?.tabs.find((t) => t.id === p.activeTabId)
        if (p && target && active?.kind === 'web' && !newTab) {
          const tabs = p.tabs.map((t) => (t.id === active.id ? { ...t, url } : t))
          return {
            workspaces: updWs(s.workspaces, wsId, (w) => pushTab(w, target, tabs, active.id))
          }
        }
        const tab: BrowserTab = { kind: 'web', id: uid(), url, title: '' }
        if (p && target) {
          return {
            workspaces: updWs(
              s.workspaces,
              wsId,
              (w) => soleLeafSplit(w, target, tab) ?? pushTab(w, target, [...p.tabs, tab], tab.id)
            )
          }
        }
        const pane = makePane('web')
        pane.tabs = [tab]
        pane.activeTabId = tab.id
        return { workspaces: updWs(s.workspaces, wsId, (w) => insertPane(w, pane)) }
      }),

    remapOpenFile: (oldPath, newPath) =>
      set((s) => {
        const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
        const remap = (p: string): string | null =>
          p === oldPath
            ? newPath
            : p.startsWith(oldPath.endsWith('/') ? oldPath : oldPath + '/')
              ? newPath + p.slice(oldPath.length)
              : null
        return {
          workspaces: s.workspaces.map((w) => {
            let changed = false
            const panes: Record<string, PaneState> = {}
            for (const [id, p] of Object.entries(w.panes)) {
              const tabs = p.tabs.map((t) => {
                if (t.kind !== 'file') return t
                const np = remap(t.path)
                return np ? { ...t, path: np, name: base(np) } : t
              })
              if (tabs.some((t, i) => t !== p.tabs[i])) {
                panes[id] = { ...p, tabs }
                changed = true
              } else {
                panes[id] = p
              }
            }
            return changed ? { ...w, panes } : w
          })
        }
      }),

    closeFilesUnder: (paths) => {
      const under = (p: string): boolean =>
        paths.some((d) => p === d || p.startsWith(d.endsWith('/') ? d : d + '/'))
      // an editor whose last tab just died gets closed like any tab-empty
      // pane — detached ones also need their window torn down from here
      // (their renderer can't observe the removal)
      const dead = new Set<string>()
      for (const w of get().workspaces) {
        for (const p of Object.values(w.panes)) {
          if (p.tabs.length && p.tabs.every((t) => t.kind === 'file' && under(t.path))) {
            dead.add(p.id)
            if (p.detached) window.ade.win.closeDetached?.(w.id, p.id)
          }
        }
      }
      set((s) => ({
        workspaces: s.workspaces.map((w) => {
          let cur = w
          for (const id of dead) cur = removePaneFromWs(cur, id)
          let changed = cur !== w
          const panes: Record<string, PaneState> = {}
          for (const [id, p] of Object.entries(cur.panes)) {
            const tabs = p.tabs.filter((t) => t.kind !== 'file' || !under(t.path))
            if (tabs.length !== p.tabs.length) {
              const activeTabId =
                p.activeTabId && tabs.some((t) => t.id === p.activeTabId)
                  ? p.activeTabId
                  : (tabs.at(-1)?.id ?? undefined)
              panes[id] = { ...p, tabs, activeTabId }
              changed = true
            } else {
              panes[id] = p
            }
          }
          return changed ? { ...cur, panes } : cur
        })
      }))
    },

    setSidebarOpen: (open) => set({ sidebarOpen: open }),

    setSidebarRoot: (projectId, path) =>
      set((s) => ({
        sidebarRoots: { ...s.sidebarRoots, [projectId]: path }
      })),

    setSideAgentsCollapsed: (collapsed) => set({ sideAgentsCollapsed: collapsed }),

    setSideAgentsFrac: (frac) => set({ sideAgentsFrac: Math.min(0.8, Math.max(0.12, frac)) }),

    setAgentsScope: (scope) => set({ agentsScope: scope }),

    // file-tree root MRU — every root picker feeds this so the dropdown can
    // offer recently-opened dirs first (cap keeps it tidy)
    pushTreeRoot: (path) =>
      set((s) => ({ treeRoots: [path, ...s.treeRoots.filter((p) => p !== path)].slice(0, 10) })),

    setTreeOverlayOpen: (open) => set({ treeOverlayOpen: open }),
    setNotifOpen: (open) => set({ notifOpen: open }),
    setSettingsOpen: (open) => set({ settingsOpen: open }),

    updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

    addBookmark: (b) =>
      set((s) => ({
        bookmarks: [
          { ...b, id: uid(), createdAt: Date.now() },
          // replace any existing bookmark for the same url+scope
          ...s.bookmarks.filter((x) => !(x.url === b.url && x.scope === b.scope))
        ]
      })),

    removeBookmark: (id) => set((s) => ({ bookmarks: s.bookmarks.filter((x) => x.id !== id) })),

    notify: (n) => {
      const id = uid()
      set((s) => {
        const now = Date.now()
        // a same-title unread ping for the workspace already badges — keep the
        // trail but don't re-demand attention
        const dupe =
          !n.read &&
          s.notifications.some(
            (x) =>
              !x.read &&
              x.title === n.title &&
              x.workspaceId === n.workspaceId &&
              now - x.ts < 15000
          )
        return {
          notifications: [{ ...n, id, ts: now, read: n.read || dupe }, ...s.notifications].slice(
            0,
            100
          )
        }
      })
      return id
    },

    pushToast: (t) =>
      set((s) => ({ toasts: [{ ...t, id: uid(), ts: Date.now() }, ...s.toasts].slice(0, 4) })),

    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),

    settleInput: (k) =>
      set((s) => ({
        notifications: s.notifications.map((x) =>
          x.kind === 'needs-input' &&
          !x.read &&
          ((k.sessionId && x.sessionId === k.sessionId) ||
            (x.workspaceId === k.wsId && x.paneId === k.paneId && x.tabId === k.tabId))
            ? { ...x, read: true }
            : x
        )
      })),

    markRead: (id) =>
      set((s) => ({
        notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n))
      })),

    markAttendedRead: (m) =>
      set((s) => {
        const pane = s.workspaces.find((w) => w.id === m.wsId)?.panes[m.paneId ?? '']
        // a ping whose recorded tab no longer exists degrades to pane-level —
        // otherwise a stale target can never be cleared by looking at it
        const tabGone = (n: AppNotification): boolean =>
          n.tabId !== undefined && !!pane && !pane.tabs.some((t) => t.id === n.tabId)
        return {
          notifications: s.notifications.map((n) =>
            !n.read &&
            n.workspaceId === m.wsId &&
            (n.paneId === undefined || n.paneId === m.paneId) &&
            (n.tabId === undefined || n.tabId === m.tabId || tabGone(n))
              ? { ...n, read: true }
              : n
          )
        }
      }),

    markAllRead: () =>
      set((s) => ({ notifications: s.notifications.map((n) => ({ ...n, read: true })) })),

    clearNotifications: () => set({ notifications: [] }),

    goToNotification: (id) => {
      const s = get()
      const n = s.notifications.find((x) => x.id === id)
      if (!n) return
      set({
        activeWorkspaceId: n.workspaceId,
        notifOpen: false,
        notifications: s.notifications.map((x) => (x.id === id ? { ...x, read: true } : x))
      })
      if (n.paneId) {
        const target = get().workspaces.find((w) => w.id === n.workspaceId)?.panes[n.paneId]
        // a detached pane lives in its own window — focus that, don't restore
        if (target?.detached) {
          window.ade.win.focusDetached(n.workspaceId, n.paneId)
        } else {
          get().focusPane(n.paneId, n.workspaceId)
        }
        // land on the tab that emitted the event, not just the pane
        if (n.tabId) {
          const p = get().workspaces.find((w) => w.id === n.workspaceId)?.panes[n.paneId]
          if (p && p.tabs.some((t) => t.id === n.tabId)) {
            get().updatePane(n.paneId, { activeTabId: n.tabId }, n.workspaceId)
          }
        }
      }
    },

    upsertAgentSession: (sessionId, info) =>
      set((s) => {
        const next = {
          ...s.agentSessions,
          [sessionId]: { ...s.agentSessions[sessionId], ...info, ts: Date.now() }
        }
        // cap the registry — drop oldest-observed entries beyond 200
        const keys = Object.keys(next)
        if (keys.length > 200) {
          keys
            .sort((a, b) => (next[a].ts ?? 0) - (next[b].ts ?? 0))
            .slice(0, keys.length - 200)
            .forEach((k) => delete next[k])
        }
        return { agentSessions: next }
      }),

    renameAgentSession: (sessionId, name) =>
      set((s) => {
        // create the entry when absent — a rename can arrive (from another
        // instance's event) before this instance sees any session event
        const info = s.agentSessions[sessionId] ?? {}
        const title = name || undefined
        const patch: Partial<AdeState> = {
          agentSessions: {
            ...s.agentSessions,
            [sessionId]: { ...info, name: title, ts: Date.now() }
          }
        }
        // the name is also the tab label — sync it when the session maps to a
        // live terminal tab (covers renames arriving via the event channel)
        if (info.wsId && info.paneId && info.tabId) {
          const ws = s.workspaces.find((w) => w.id === info.wsId)
          const pane = ws?.panes[info.paneId]
          if (ws && pane && pane.tabs.some((t) => t.id === info.tabId && t.kind === 'term')) {
            patch.workspaces = updWs(s.workspaces, ws.id, (w) => ({
              ...w,
              panes: {
                ...w.panes,
                [pane.id]: {
                  ...pane,
                  tabs: pane.tabs.map((t) =>
                    t.id === info.tabId && t.kind === 'term' ? { ...t, title } : t
                  )
                }
              }
            }))
          }
        }
        return patch
      }),

    upsertResumeSession: (r) =>
      set((s) => {
        const prev = s.resumeSessions[r.sessionId]
        const next = { ...s.resumeSessions }
        // a tab hosts one live session — a new session observed here retires
        // whatever the tab was recorded as running (its end event may never
        // have fired)
        for (const [k, v] of Object.entries(next)) {
          if (k !== r.sessionId && v.tabId === r.tabId) delete next[k]
        }
        // later events may omit cwd — keep the one already observed
        next[r.sessionId] = { ...prev, ...r, cwd: r.cwd ?? prev?.cwd, ts: Date.now() }
        // the set is meant to hold live sessions only — cap it anyway so a
        // bookkeeping leak can't grow state without bound
        const keys = Object.keys(next)
        if (keys.length > 64) {
          keys
            .sort((a, b) => next[a].ts - next[b].ts)
            .slice(0, keys.length - 64)
            .forEach((k) => delete next[k])
        }
        return { resumeSessions: next }
      }),

    dropResumeSession: (sessionId) =>
      set((s) => {
        if (!s.resumeSessions[sessionId]) return s
        const next = { ...s.resumeSessions }
        delete next[sessionId]
        return { resumeSessions: next }
      }),

    dropResumeWhere: (pred) =>
      set((s) => {
        const keys = Object.keys(s.resumeSessions).filter((k) => pred(s.resumeSessions[k]))
        if (!keys.length) return s
        const next = { ...s.resumeSessions }
        for (const k of keys) delete next[k]
        return { resumeSessions: next }
      })
  }
})

// pty events arrive keyed by session id (paneId:tabId:uuid) — route the state
// write to the tab that owns the session, never to the pane as a whole
export function patchTerminalTab(
  wsId: string,
  paneId: string,
  tabId: string,
  patch: Partial<TerminalTab>
): void {
  const st = useStore.getState()
  const p = st.workspaces.find((x) => x.id === wsId)?.panes[paneId]
  if (!p || !p.tabs.some((x) => x.id === tabId && x.kind === 'term')) return
  st.updatePane(
    paneId,
    { tabs: p.tabs.map((x) => (x.id === tabId ? ({ ...x, ...patch } as typeof x) : x)) },
    wsId
  )
}
