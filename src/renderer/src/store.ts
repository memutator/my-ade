import { create } from 'zustand'
import type {
  AgentSessionInfo,
  AppNotification,
  Bookmark,
  BrowserPaneState,
  BrowserTab,
  DropEdge,
  EditorPaneState,
  EditorTab,
  LayoutNode,
  PaneState,
  PaneType,
  Project,
  Settings,
  TerminalPaneState,
  TerminalTab,
  TodoItem,
  Workspace
} from './types'

const uid = (): string => crypto.randomUUID()

function makePane(type: PaneType): PaneState {
  const id = uid()
  switch (type) {
    case 'terminal': {
      const tab: TerminalTab = { id: uid() }
      return { id, type, title: 'terminal', tabs: [tab], activeTabId: tab.id }
    }
    case 'browser': {
      const tab: BrowserTab = { id: uid(), url: 'https://', title: '' }
      return { id, type, title: 'browser', url: 'https://', tabs: [tab], activeTabId: tab.id }
    }
    case 'editor':
      return { id, type, title: 'editor', tabs: [] }
    case 'todo':
      return { id, type, title: 'todos' }
  }
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

// Insert a pane into a workspace: as the only leaf when empty, else split the
// focused (or last visible) leaf to the right. Focus moves to the new pane.
function insertPane(w: Workspace, pane: PaneState): Workspace {
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

// The sibling subtree of paneId's leaf — its nearest neighbor in the layout.
function siblingOf(node: LayoutNode | null, paneId: string): LayoutNode | null {
  if (!node || node.kind === 'leaf') return null
  if (node.a.kind === 'leaf' && node.a.paneId === paneId) return node.b
  if (node.b.kind === 'leaf' && node.b.paneId === paneId) return node.a
  return siblingOf(node.a, paneId) ?? siblingOf(node.b, paneId)
}

// When an editor pane leaves the layout (float/detach) its tree root
// materializes to the project path if it never had one — the pane keeps its
// own root from then on, independent of the workspace it sits in.
function withEditorTreeRoot(pane: PaneState, projectPath: string | undefined): PaneState {
  if (pane.type !== 'editor' || pane.treeRoot || !projectPath) return pane
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

// older saves predate internal tabs: browser panes had no `tabs` (seed one from
// the stored url); terminal panes kept their single shell's cwd/shell/exited/
// agent on the pane itself (migrated into a seeded tab, then stripped)
function normalizePane(p: PaneState): PaneState {
  if (p.type === 'browser') {
    if (Array.isArray(p.tabs) && p.tabs.length > 0) return p
    const tab: BrowserTab = { id: uid(), url: p.url, title: '' }
    return { ...p, tabs: [tab], activeTabId: tab.id }
  }
  if (p.type === 'terminal') {
    const tabs = Array.isArray(p.tabs) ? p.tabs : []
    if (tabs.length === 0) {
      const tab: TerminalTab = {
        id: uid(),
        cwd: p.cwd,
        shell: p.shell,
        exited: p.exited,
        agent: p.agent ?? null
      }
      const np: TerminalPaneState = { ...p, tabs: [tab], activeTabId: tab.id }
      delete np.cwd
      delete np.shell
      delete np.exited
      delete np.agent
      return np
    }
    // a stale/missing activeTabId would leave the pane showing nothing
    return tabs.some((t) => t.id === p.activeTabId) ? p : { ...p, activeTabId: tabs[0].id }
  }
  return p
}

function normalizeWorkspace(w: Workspace): Workspace {
  let changed = false
  let root = w.root
  const panes: Record<string, PaneState> = {}
  for (const [id, p] of Object.entries(w.panes)) {
    // tab-less editors can't be produced anymore (closing the last tab closes
    // the pane) — drop strays from older saves, leaf included
    if (p.type === 'editor' && Array.isArray(p.tabs) && p.tabs.length === 0) {
      if (root) root = removeLeaf(root, id)
      changed = true
      continue
    }
    panes[id] = normalizePane(p)
    if (panes[id] !== p) changed = true
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

// todos: order is only meaningful within a sibling group (same parentId)
function todoSiblings(list: TodoItem[], parentId: string | undefined): TodoItem[] {
  return list.filter((t) => t.parentId === parentId).sort((a, b) => a.order - b.order)
}

function isDescendantOf(list: TodoItem[], id: string, ancestorId: string): boolean {
  let cur = list.find((t) => t.id === id)?.parentId
  let guard = 0
  while (cur && guard++ < 1000) {
    if (cur === ancestorId) return true
    cur = list.find((t) => t.id === cur)?.parentId
  }
  return false
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
  projects: Project[]
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  settings: Settings
  sidebarOpen: boolean
  treeOverlayOpen: boolean
  bookmarks: Bookmark[]
  todos: Record<string, TodoItem[]>
  /** harness sessionId → observed info (name set via session-rename) */
  agentSessions: Record<string, AgentSessionInfo>
  /** most-recently-picked file-tree roots (any host: sidebar, overlay, pane) */
  treeRoots: string[]
  /** per-project sidebar tree root overrides — sidebar trees can point
   *  somewhere other than the project dir */
  sidebarRoots: Record<string, string>
}

interface AdeState extends PersistedState {
  notifications: AppNotification[]
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

  newPane: (type: PaneType, wsId?: string) => void
  splitPane: (paneId: string, dir: 'row' | 'col', type: PaneType, wsId?: string) => void
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
  setRatio: (splitId: string, ratio: number, wsId?: string) => void
  updatePane: (paneId: string, patch: Partial<PaneState>, wsId?: string) => void
  focusPane: (paneId: string, wsId?: string) => void
  cycleFocus: (dir: 1 | -1, wsId?: string) => void
  cyclePaneTab: (dir: 1 | -1, wsId?: string) => void

  openFileInEditor: (path: string, name: string, wsId?: string) => void
  openUrlInBrowser: (url: string, wsId?: string) => void
  // file-tree ops: keep open editor tabs pointing at real paths — a rename or
  // move remaps tab.path (incl. descendants of a renamed dir), a delete closes
  // the tab
  remapOpenFile: (oldPath: string, newPath: string) => void
  closeFilesUnder: (paths: string[]) => void

  addTodo: (projectId: string, text?: string, parentId?: string) => string
  updateTodo: (
    projectId: string,
    todoId: string,
    patch: Partial<Pick<TodoItem, 'text' | 'status' | 'dependsOn'>>
  ) => void
  cycleTodo: (projectId: string, todoId: string) => void
  removeTodo: (projectId: string, todoId: string) => void
  indentTodo: (projectId: string, todoId: string) => void
  outdentTodo: (projectId: string, todoId: string) => void
  reorderTodo: (
    projectId: string,
    todoId: string,
    targetId: string,
    place: 'before' | 'after'
  ) => void

  setSidebarOpen: (open: boolean) => void
  setSidebarRoot: (projectId: string, path: string) => void
  pushTreeRoot: (path: string) => void
  setTreeOverlayOpen: (open: boolean) => void
  setNotifOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  updateSettings: (patch: Partial<Settings>) => void

  addBookmark: (b: { title: string; url: string; scope: string }) => void
  removeBookmark: (id: string) => void

  notify: (n: Omit<AppNotification, 'id' | 'ts' | 'read'> & { read?: boolean }) => void
  /** settle pending needs-input pings for a session or tab (turn resumed /
   *  ended / cancelled — the prompt is stale either way) */
  settleInput: (k: { wsId?: string; paneId?: string; tabId?: string; sessionId?: string }) => void
  markRead: (id: string) => void
  markAllRead: () => void
  clearNotifications: () => void
  goToNotification: (id: string) => void

  upsertAgentSession: (sessionId: string, info: Partial<AgentSessionInfo>) => void
  renameAgentSession: (sessionId: string, name: string) => void
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

  // new browser panes/tabs start on the configured home page (empty = blank)
  const withHome = (p: PaneState): PaneState => {
    const home = get().settings.homeUrl.trim()
    if (p.type !== 'browser' || !home) return p
    const bp = p as BrowserPaneState
    return { ...bp, url: home, tabs: bp.tabs.map((t) => ({ ...t, url: home })) }
  }

  return {
    projects: [],
    workspaces: [],
    activeWorkspaceId: null,
    settings: DEFAULT_SETTINGS,
    sidebarOpen: false,
    treeOverlayOpen: false,
    bookmarks: [],
    todos: {},
    agentSessions: {},
    treeRoots: [],
    sidebarRoots: {},
    notifications: [],
    notifOpen: false,
    settingsOpen: false,
    resolvedTheme: 'dark',
    setResolvedTheme: (t) => set({ resolvedTheme: t }),

    hydrate: (s) =>
      set({
        projects: s.projects ?? [],
        workspaces: (s.workspaces ?? []).map(normalizeWorkspace),
        activeWorkspaceId: s.activeWorkspaceId ?? s.workspaces?.[0]?.id ?? null,
        settings: { ...DEFAULT_SETTINGS, ...s.settings },
        sidebarOpen: s.sidebarOpen ?? false,
        bookmarks: s.bookmarks ?? [],
        todos: s.todos ?? {},
        agentSessions: s.agentSessions ?? {},
        treeRoots: s.treeRoots ?? [],
        sidebarRoots: s.sidebarRoots ?? {}
      }),

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
        const todos = { ...s.todos }
        delete todos[id]
        return {
          projects: s.projects.filter((p) => p.id !== id),
          workspaces: s.workspaces.filter((w) => w.projectId !== id),
          bookmarks: s.bookmarks.filter((b) => b.scope !== id),
          todos
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
        return { workspaces, activeWorkspaceId }
      }),

    moveWorkspace: (from, to) =>
      set((s) => {
        const workspaces = [...s.workspaces]
        const [w] = workspaces.splice(from, 1)
        workspaces.splice(to, 0, w)
        return { workspaces }
      }),

    newPane: (type, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        const pane = withHome(makePane(type))
        return { workspaces: updWs(s.workspaces, wsId, (w) => insertPane(w, pane)) }
      }),

    splitPane: (paneId, dir, type, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        const pane = withHome(makePane(type))
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => {
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
        if (pane.type === 'terminal') {
          for (const t of pane.tabs) if (t.pty) window.ade.pty.kill(t.pty)
        }
        window.ade.win.closeDetached?.(wsId0, paneId)
      }
      set((s) => {
        const wsId = wsId0
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => removePaneFromWs(w, paneId))
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
            const pane = withEditorTreeRoot(
              pane0,
              s.projects.find((x) => x.id === w.projectId)?.path
            )
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
            const pane = withEditorTreeRoot(
              pane0,
              s.projects.find((x) => x.id === w.projectId)?.path
            )
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

    // Ctrl+Tab target: advance activeTabId inside the focused pane when it has
    // internal tabs (browser/editor/terminal); todo panes are a no-op.
    cyclePaneTab: (dir, wsIdArg) => {
      const wsId = wid(wsIdArg)
      if (!wsId) return
      const ws = get().workspaces.find((w) => w.id === wsId)
      const p = ws?.focusedPaneId ? ws.panes[ws.focusedPaneId] : undefined
      if (!p || !('tabs' in p) || p.tabs.length < 2) return
      const i = Math.max(
        0,
        p.tabs.findIndex((t) => t.id === p.activeTabId)
      )
      const next = p.tabs[(i + dir + p.tabs.length) % p.tabs.length]
      // browser panes mirror the active tab's url on the pane itself
      get().updatePane(
        p.id,
        'url' in next ? { activeTabId: next.id, url: next.url } : { activeTabId: next.id },
        wsId
      )
    },

    openFileInEditor: (path, name, wsIdArg) =>
      set((s) => {
        const wsId = wsIdArg ?? s.activeWorkspaceId
        if (!wsId) return s
        const ws = s.workspaces.find((w) => w.id === wsId)
        if (!ws) return s

        const tab: EditorTab = { id: uid(), path, name }
        const applyTab = (p: EditorPaneState): EditorPaneState => {
          const existing = p.tabs.find((t) => t.path === path)
          if (existing) return { ...p, activeTabId: existing.id }
          return { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id }
        }

        // prefer the focused editor pane, else first editor pane, else create
        // one — minimized editors are skipped so files never open in a hidden
        // pane (their dock chip stays untouched)
        const panes = Object.values(ws.panes)
        const target =
          (ws.focusedPaneId &&
            (ws.panes[ws.focusedPaneId] as EditorPaneState | undefined)?.type === 'editor' &&
            !ws.panes[ws.focusedPaneId]?.minimized &&
            ws.focusedPaneId) ||
          panes.find((p) => p.type === 'editor' && !p.minimized)?.id

        if (target) {
          return {
            workspaces: updWs(s.workspaces, wsId, (w) => ({
              ...w,
              panes: { ...w.panes, [target]: applyTab(w.panes[target] as EditorPaneState) },
              focusedPaneId: target
            }))
          }
        }

        const pane = makePane('editor') as EditorPaneState
        pane.tabs = [tab]
        pane.activeTabId = tab.id
        return { workspaces: updWs(s.workspaces, wsId, (w) => insertPane(w, pane)) }
      }),

    // Navigate a browser pane in the workspace: focused browser pane, else the
    // first browser pane, else a new one (split off the focused pane).
    openUrlInBrowser: (url, wsIdArg) =>
      set((s) => {
        const wsId = wsIdArg ?? s.activeWorkspaceId
        if (!wsId) return s
        const ws = s.workspaces.find((w) => w.id === wsId)
        if (!ws) return s

        const target =
          (ws.focusedPaneId &&
            ws.panes[ws.focusedPaneId]?.type === 'browser' &&
            !ws.panes[ws.focusedPaneId]?.minimized &&
            ws.focusedPaneId) ||
          Object.values(ws.panes).find((p) => p.type === 'browser' && !p.minimized)?.id

        if (target) {
          const bp = ws.panes[target] as BrowserPaneState
          const tabs = (bp.tabs ?? []).map((t) =>
            t.id === (bp.activeTabId ?? bp.tabs?.[0]?.id) ? { ...t, url } : t
          )
          return {
            workspaces: updWs(s.workspaces, wsId, (w) => ({
              ...w,
              panes: {
                ...w.panes,
                [target]: { ...w.panes[target], url, tabs } as PaneState
              },
              focusedPaneId: target
            }))
          }
        }

        const pane = makePane('browser') as BrowserPaneState
        pane.url = url
        if (pane.tabs?.length) pane.tabs = pane.tabs.map((t) => ({ ...t, url }))
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
              if (p.type !== 'editor') {
                panes[id] = p
                continue
              }
              const tabs = p.tabs.map((t) => {
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
          if (p.type === 'editor' && p.tabs.length && p.tabs.every((t) => under(t.path))) {
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
            if (p.type !== 'editor') {
              panes[id] = p
              continue
            }
            const tabs = p.tabs.filter((t) => !under(t.path))
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

    addTodo: (projectId, text = '', parentId) => {
      const sibs = todoSiblings(get().todos[projectId] ?? [], parentId)
      const item: TodoItem = {
        id: uid(),
        text,
        status: 'todo',
        parentId,
        dependsOn: [],
        createdAt: Date.now(),
        order: sibs.length ? sibs.at(-1)!.order + 1 : 0
      }
      set((s) => ({ todos: { ...s.todos, [projectId]: [...(s.todos[projectId] ?? []), item] } }))
      return item.id
    },

    updateTodo: (projectId, todoId, patch) =>
      set((s) => ({
        todos: {
          ...s.todos,
          [projectId]: (s.todos[projectId] ?? []).map((t) =>
            t.id === todoId ? { ...t, ...patch } : t
          )
        }
      })),

    cycleTodo: (projectId, todoId) =>
      set((s) => ({
        todos: {
          ...s.todos,
          [projectId]: (s.todos[projectId] ?? []).map((t) =>
            t.id === todoId
              ? {
                  ...t,
                  status: t.status === 'todo' ? 'doing' : t.status === 'doing' ? 'done' : 'todo'
                }
              : t
          )
        }
      })),

    removeTodo: (projectId, todoId) =>
      set((s) => {
        const list = s.todos[projectId] ?? []
        const dead = new Set<string>([todoId])
        let grew = true
        while (grew) {
          grew = false
          for (const t of list) {
            if (t.parentId && dead.has(t.parentId) && !dead.has(t.id)) {
              dead.add(t.id)
              grew = true
            }
          }
        }
        return {
          todos: {
            ...s.todos,
            [projectId]: list
              .filter((t) => !dead.has(t.id))
              .map((t) =>
                t.dependsOn.some((d) => dead.has(d))
                  ? { ...t, dependsOn: t.dependsOn.filter((d) => !dead.has(d)) }
                  : t
              )
          }
        }
      }),

    indentTodo: (projectId, todoId) =>
      set((s) => {
        const list = s.todos[projectId] ?? []
        const item = list.find((t) => t.id === todoId)
        if (!item) return s
        const sibs = todoSiblings(list, item.parentId)
        const prev = sibs[sibs.findIndex((t) => t.id === todoId) - 1]
        if (!prev) return s
        const children = todoSiblings(list, prev.id)
        const order = children.length ? children.at(-1)!.order + 1 : 0
        return {
          todos: {
            ...s.todos,
            [projectId]: list.map((t) => (t.id === todoId ? { ...t, parentId: prev.id, order } : t))
          }
        }
      }),

    outdentTodo: (projectId, todoId) =>
      set((s) => {
        const list = s.todos[projectId] ?? []
        const item = list.find((t) => t.id === todoId)
        if (!item?.parentId) return s
        const parent = list.find((t) => t.id === item.parentId)
        return {
          todos: {
            ...s.todos,
            [projectId]: list.map((t) =>
              t.id === todoId
                ? { ...t, parentId: parent?.parentId, order: (parent?.order ?? t.order) + 0.5 }
                : t
            )
          }
        }
      }),

    reorderTodo: (projectId, todoId, targetId, place) =>
      set((s) => {
        const list = s.todos[projectId] ?? []
        const item = list.find((t) => t.id === todoId)
        const target = list.find((t) => t.id === targetId)
        if (!item || !target || item.id === target.id) return s
        if (isDescendantOf(list, targetId, todoId)) return s
        const parentId = target.parentId
        const sibs = list
          .filter((t) => t.parentId === parentId && t.id !== todoId)
          .sort((a, b) => a.order - b.order)
        const idx = sibs.findIndex((t) => t.id === targetId)
        sibs.splice(place === 'after' ? idx + 1 : idx, 0, item)
        const orderOf = new Map(sibs.map((t, i) => [t.id, i]))
        return {
          todos: {
            ...s.todos,
            [projectId]: list.map((t) =>
              t.id === todoId
                ? { ...t, parentId, order: orderOf.get(t.id)! }
                : orderOf.has(t.id)
                  ? { ...t, order: orderOf.get(t.id)! }
                  : t
            )
          }
        }
      }),

    setSidebarOpen: (open) => set({ sidebarOpen: open }),

    setSidebarRoot: (projectId, path) =>
      set((s) => ({
        sidebarRoots: { ...s.sidebarRoots, [projectId]: path }
      })),

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

    notify: (n) =>
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
          notifications: [
            { ...n, id: uid(), ts: now, read: n.read || dupe },
            ...s.notifications
          ].slice(0, 100)
        }
      }),

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
          if (p && 'tabs' in p && p.tabs.some((t) => t.id === n.tabId)) {
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
          if (ws && pane && pane.type === 'terminal') {
            patch.workspaces = updWs(s.workspaces, ws.id, (w) => ({
              ...w,
              panes: {
                ...w.panes,
                [pane.id]: {
                  ...pane,
                  tabs: pane.tabs.map((t) => (t.id === info.tabId ? { ...t, title } : t))
                }
              }
            }))
          }
        }
        return patch
      })
  }
})
