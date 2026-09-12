import { create } from 'zustand'
import type {
  AppNotification,
  Bookmark,
  BrowserPaneState,
  BrowserTab,
  EditorPaneState,
  EditorTab,
  LayoutNode,
  PaneState,
  PaneType,
  Project,
  Settings,
  TodoItem,
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
    case 'todo':
      return { id, type, title: 'todos' }
  }
}

function leaf(paneId: string): LayoutNode {
  return { kind: 'leaf', id: uid(), paneId }
}

// Insert a pane into a workspace: as the only leaf when empty, else split the
// focused (or last) leaf to the right. Focus moves to the new pane.
function insertPane(w: Workspace, pane: PaneState): Workspace {
  const panes = { ...w.panes, [pane.id]: pane }
  if (!w.root) return { ...w, panes, root: leaf(pane.id), focusedPaneId: pane.id }
  const target =
    w.focusedPaneId && w.panes[w.focusedPaneId] ? w.focusedPaneId : leafPaneIds(w.root).at(-1)!
  const root = mapLeaf(w.root, target, () => ({
    kind: 'split',
    id: uid(),
    dir: 'row' as const,
    ratio: 0.5,
    a: leaf(target),
    b: leaf(pane.id)
  }))
  return { ...w, panes, root, focusedPaneId: pane.id }
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
  bookmarks: Bookmark[]
  todos: Record<string, TodoItem[]>
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

  createWorkspace: (projectId: string, name?: string) => void
  activateWorkspace: (id: string) => void
  cycleWorkspace: (dir: 1 | -1) => void
  renameWorkspace: (id: string, name: string) => void
  closeWorkspace: (id: string) => void
  moveWorkspace: (from: number, to: number) => void

  newPane: (type: PaneType, wsId?: string) => void
  splitPane: (paneId: string, dir: 'row' | 'col', type: PaneType, wsId?: string) => void
  closePane: (paneId: string, wsId?: string) => void
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
    bookmarks: [],
    todos: {},
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
        bookmarks: s.bookmarks ?? [],
        todos: s.todos ?? {}
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

    // Drag & drop move. targetPaneId == null → append to the end of the target
    // layout (root wrapped in a row split). targetPaneId + edge → split that
    // leaf and drop the pane into the new half. targetPaneId without edge →
    // swap the two panes' positions (across workspaces both states migrate).
    movePane: (paneId, fromWsId, toWsId, targetPaneId, edge) =>
      set((s) => {
        const from = s.workspaces.find((w) => w.id === fromWsId)
        const to = s.workspaces.find((w) => w.id === toWsId)
        const pane = from?.panes[paneId]
        if (!from || !to || !pane || !from.root) return s
        if (paneId === targetPaneId) return s
        if (targetPaneId && !to.panes[targetPaneId]) return s
        const sameWs = fromWsId === toWsId

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
            w.focusedPaneId === paneId ? (root ? leafPaneIds(root)[0] : null) : w.focusedPaneId
          return { ...w, root, panes, focusedPaneId }
        }

        const graft = (w: Workspace): Workspace => {
          const panes = { ...w.panes, [paneId]: pane }
          let root = w.root
          if (root && targetPaneId && edge) {
            const dir: 'row' | 'col' = edge === 'left' || edge === 'right' ? 'row' : 'col'
            const first = edge === 'left' || edge === 'top'
            root = mapLeaf(root, targetPaneId, (l) => ({
              kind: 'split',
              id: uid(),
              dir,
              ratio: 0.5,
              a: first ? leaf(paneId) : l,
              b: first ? l : leaf(paneId)
            }))
          } else if (root) {
            // append at the end — n/(n+1) keeps existing panes' relative share
            const n = leafPaneIds(root).length
            root = {
              kind: 'split',
              id: uid(),
              dir: 'row',
              ratio: n / (n + 1),
              a: root,
              b: leaf(paneId)
            }
          } else {
            root = leaf(paneId)
          }
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

    // Ctrl+Tab target: advance activeTabId inside the focused pane when it has
    // internal tabs (browser/editor); terminal/todo panes are a no-op.
    cyclePaneTab: (dir, wsIdArg) => {
      const wsId = wid(wsIdArg)
      if (!wsId) return
      const ws = get().workspaces.find((w) => w.id === wsId)
      const p = ws?.focusedPaneId ? ws.panes[ws.focusedPaneId] : undefined
      if (!p || (p.type !== 'browser' && p.type !== 'editor') || p.tabs.length < 2) return
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
            ws.focusedPaneId) ||
          Object.values(ws.panes).find((p) => p.type === 'browser')?.id

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
      set((s) => {
        const now = Date.now()
        // collapse duplicate signals for the same completion — e.g. a codex
        // hook event plus the pty agent→idle transition firing together
        const dupe = s.notifications.some(
          (x) => x.title === n.title && x.paneId === n.paneId && now - x.ts < 8000
        )
        if (dupe) return s
        return {
          notifications: [{ ...n, id: uid(), ts: now, read: false }, ...s.notifications].slice(
            0,
            100
          )
        }
      }),

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
