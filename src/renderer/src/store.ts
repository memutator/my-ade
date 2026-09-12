import { create } from 'zustand'
import type {
  AppNotification,
  Bookmark,
  BrowserTab,
  EditorPaneState,
  EditorTab,
  LayoutNode,
  PaneState,
  PaneType,
  Project,
  Settings,
  Workspace
} from './types'

const uid = (): string => crypto.randomUUID()

function makePane(type: PaneType): PaneState {
  const id = uid()
  switch (type) {
    case 'terminal':
      return { id, type, title: 'terminal', agent: null }
    case 'browser': {
      const tab: BrowserTab = { id: uid(), url: 'https://', title: '' }
      return { id, type, title: 'browser', url: 'https://', tabs: [tab], activeTabId: tab.id }
    }
    case 'editor':
      return { id, type, title: 'editor', tabs: [] }
  }
}

function leaf(paneId: string): LayoutNode {
  return { kind: 'leaf', id: uid(), paneId }
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

// older saves have browser panes without tabs — seed one tab from the stored url
function normalizePane(p: PaneState): PaneState {
  if (p.type !== 'browser' || (Array.isArray(p.tabs) && p.tabs.length > 0)) return p
  const tab: BrowserTab = { id: uid(), url: p.url, title: '' }
  return { ...p, tabs: [tab], activeTabId: tab.id }
}

function normalizeWorkspace(w: Workspace): Workspace {
  let changed = false
  const panes: Record<string, PaneState> = {}
  for (const [id, p] of Object.entries(w.panes)) {
    panes[id] = normalizePane(p)
    if (panes[id] !== p) changed = true
  }
  return changed ? { ...w, panes } : w
}

const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  accent: '#7aa2f7',
  uiFont: "'Inter', system-ui, sans-serif",
  termFont: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  termFontSize: 12.5,
  osNotifications: true,
  providers: {}
}

export interface PersistedState {
  projects: Project[]
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  settings: Settings
  sidebarOpen: boolean
  bookmarks: Bookmark[]
}

interface AdeState extends PersistedState {
  notifications: AppNotification[]
  settingsOpen: boolean
  notifOpen: boolean
  resolvedTheme: 'dark' | 'light'
  setResolvedTheme: (t: 'dark' | 'light') => void

  hydrate: (s: Partial<PersistedState>) => void

  addProject: (path: string, name?: string) => Project
  removeProject: (id: string) => void

  createWorkspace: (projectId: string) => void
  activateWorkspace: (id: string) => void
  renameWorkspace: (id: string, name: string) => void
  closeWorkspace: (id: string) => void
  moveWorkspace: (from: number, to: number) => void

  newPane: (type: PaneType, wsId?: string) => void
  splitPane: (paneId: string, dir: 'row' | 'col', type: PaneType, wsId?: string) => void
  closePane: (paneId: string, wsId?: string) => void
  setRatio: (splitId: string, ratio: number, wsId?: string) => void
  updatePane: (paneId: string, patch: Partial<PaneState>, wsId?: string) => void
  focusPane: (paneId: string, wsId?: string) => void
  cycleFocus: (dir: 1 | -1, wsId?: string) => void

  openFileInEditor: (path: string, name: string) => void

  setSidebarOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setNotifOpen: (open: boolean) => void
  updateSettings: (patch: Partial<Settings>) => void

  addBookmark: (b: { title: string; url: string; scope: string }) => void
  removeBookmark: (id: string) => void

  notify: (n: Omit<AppNotification, 'id' | 'ts' | 'read'>) => void
  markRead: (id: string) => void
  markAllRead: () => void
  clearNotifications: () => void
  goToNotification: (id: string) => void
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

  return {
    projects: [],
    workspaces: [],
    activeWorkspaceId: null,
    settings: DEFAULT_SETTINGS,
    sidebarOpen: false,
    bookmarks: [],
    notifications: [],
    settingsOpen: false,
    notifOpen: false,
    resolvedTheme: 'dark',
    setResolvedTheme: (t) => set({ resolvedTheme: t }),

    hydrate: (s) =>
      set({
        projects: s.projects ?? [],
        workspaces: (s.workspaces ?? []).map(normalizeWorkspace),
        activeWorkspaceId: s.activeWorkspaceId ?? s.workspaces?.[0]?.id ?? null,
        settings: { ...DEFAULT_SETTINGS, ...s.settings },
        sidebarOpen: s.sidebarOpen ?? false,
        bookmarks: s.bookmarks ?? []
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
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== id),
        workspaces: s.workspaces.filter((w) => w.projectId !== id),
        bookmarks: s.bookmarks.filter((b) => b.scope !== id)
      })),

    createWorkspace: (projectId) =>
      set((s) => {
        const count = s.workspaces.filter((w) => w.projectId === projectId).length
        const ws: Workspace = {
          id: uid(),
          name: `workspace ${count + 1}`,
          projectId,
          root: null,
          panes: {},
          focusedPaneId: null
        }
        return { workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id }
      }),

    activateWorkspace: (id) => set({ activeWorkspaceId: id }),

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
        const pane = makePane(type)
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => {
            const panes = { ...w.panes, [pane.id]: pane }
            if (!w.root) return { ...w, panes, root: leaf(pane.id), focusedPaneId: pane.id }
            const target =
              w.focusedPaneId && w.panes[w.focusedPaneId]
                ? w.focusedPaneId
                : leafPaneIds(w.root).at(-1)!
            const root = mapLeaf(w.root, target, () => ({
              kind: 'split',
              id: uid(),
              dir: 'row',
              ratio: 0.5,
              a: leaf(target),
              b: leaf(pane.id)
            }))
            return { ...w, panes, root, focusedPaneId: pane.id }
          })
        }
      }),

    splitPane: (paneId, dir, type, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        const pane = makePane(type)
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => {
            const panes = { ...w.panes, [pane.id]: pane }
            if (!w.root) return { ...w, panes, root: leaf(pane.id), focusedPaneId: pane.id }
            const root = mapLeaf(w.root, paneId, (l) => ({
              kind: 'split',
              id: uid(),
              dir,
              ratio: 0.5,
              a: l,
              b: leaf(pane.id)
            }))
            return { ...w, panes, root, focusedPaneId: pane.id }
          })
        }
      }),

    closePane: (paneId, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => {
            if (!w.root) return w
            const root = removeLeaf(w.root, paneId)
            const panes = { ...w.panes }
            delete panes[paneId]
            const focusedPaneId =
              w.focusedPaneId === paneId ? (root ? leafPaneIds(root)[0] : null) : w.focusedPaneId
            return { ...w, root, panes, focusedPaneId }
          })
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

    focusPane: (paneId, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => ({ ...w, focusedPaneId: paneId }))
        }
      }),

    cycleFocus: (dir, wsIdArg) =>
      set((s) => {
        const wsId = wid(wsIdArg)
        if (!wsId) return s
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => {
            const ids = leafPaneIds(w.root)
            if (ids.length === 0) return w
            const i = w.focusedPaneId ? ids.indexOf(w.focusedPaneId) : -1
            return { ...w, focusedPaneId: ids[(i + dir + ids.length) % ids.length] }
          })
        }
      }),

    openFileInEditor: (path, name) =>
      set((s) => {
        const wsId = s.activeWorkspaceId
        if (!wsId) return s
        const ws = s.workspaces.find((w) => w.id === wsId)
        if (!ws) return s

        const tab: EditorTab = { id: uid(), path, name }
        const applyTab = (p: EditorPaneState): EditorPaneState => {
          const existing = p.tabs.find((t) => t.path === path)
          if (existing) return { ...p, activeTabId: existing.id }
          return { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id }
        }

        // prefer the focused editor pane, else first editor pane, else create one
        const panes = Object.values(ws.panes)
        const target =
          (ws.focusedPaneId &&
            (ws.panes[ws.focusedPaneId] as EditorPaneState | undefined)?.type === 'editor' &&
            ws.focusedPaneId) ||
          panes.find((p) => p.type === 'editor')?.id

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
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => {
            const panes2 = { ...w.panes, [pane.id]: pane }
            if (!w.root) return { ...w, panes: panes2, root: leaf(pane.id), focusedPaneId: pane.id }
            const t =
              w.focusedPaneId && w.panes[w.focusedPaneId]
                ? w.focusedPaneId
                : leafPaneIds(w.root).at(-1)!
            const root = mapLeaf(w.root, t, () => ({
              kind: 'split',
              id: uid(),
              dir: 'row',
              ratio: 0.5,
              a: leaf(t),
              b: leaf(pane.id)
            }))
            return { ...w, panes: panes2, root, focusedPaneId: pane.id }
          })
        }
      }),

    setSidebarOpen: (open) => set({ sidebarOpen: open }),
    setSettingsOpen: (open) => set({ settingsOpen: open }),
    setNotifOpen: (open) => set({ notifOpen: open }),

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
      set((s) => ({
        notifications: [{ ...n, id: uid(), ts: Date.now(), read: false }, ...s.notifications].slice(
          0,
          100
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
      if (n.paneId) get().focusPane(n.paneId, n.workspaceId)
    }
  }
})
