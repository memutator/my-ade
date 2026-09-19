// mahas shell — the application store.
//
// What lives here: the mutable state of the shell (projects, workspaces,
// panes/tabs, notifications, resume records, settings) and the transitions
// that act on it. Two things that used to be inline now have their own
// boundary, because they are not state transitions:
//
//   - layout algebra (which leaf an open lands in, how a leaf is inserted or
//     removed, what a hidden leaf keeps) → shell/layout.ts;
//   - persisted-state migration (old pane `type`, missing `num`, stale
//     focus, resume-record pruning) → shell/hydration.ts.
//
// The third boundary is effects. Store actions must stay pure state math so
// they can run in any renderer, including a detached pane window whose
// main-process side of the world is different. Effects that reach the OS
// (kill a detached pane's ptys, close/focus its window, relay a command to
// the main renderer) go through the installable seam below — the main
// window installs the real implementation (shell/effects.ts) at boot and
// the detached renderer installs its own; without an install, actions still
// commit their state and simply do not perform the effect.

import { create } from 'zustand'
import type {
  AgentSessionInfo,
  AppNotification,
  BlockKind,
  BrowserTab,
  DropEdge,
  EditorTab,
  PaneState,
  PaneTab,
  PaneToast,
  Project,
  ResumeSession,
  Settings,
  TerminalTab,
  ToastItem,
  WidgetKind,
  Workspace
} from './types'
import {
  insertAt,
  insertPane,
  leafPaneIds,
  makePane,
  makeTab,
  mapLeaf,
  maxFloatZ,
  nextPaneNum,
  pushTab,
  removeLeaf,
  removePaneFromWs,
  restoreInWorkspace,
  setRatioIn,
  siblingOf,
  soleLeafSplit,
  stackTarget,
  swapPaneIds,
  visibleLeafIds,
  withTreeRoot
} from './shell/layout'
import { normalizeWorkspace, DEFAULT_SETTINGS, type PersistedState } from './shell/hydration'
import { panePtySessionIds, shellEffects, type ShellEffects } from './shell/effects'
import { uid } from './shell/ids'

export { linkTargetPane, leafPaneIds, visibleLeafIds } from './shell/layout'
export type { PersistedState } from './shell/hydration'

/**
 * The OS-facing half of a shell action. Every method is a best-effort side
 * effect on a window or a pty that the store does not own; none of them may
 * change shell state (the action already committed it).
 */
export type StoreEffects = ShellEffects

let effects: StoreEffects = shellEffects()

/** Install the effect implementation for this renderer. Called once at boot
 *  (main window: shell/effects.ts; detached window: its own seam) so store
 *  actions never have to ask which window they are running in. */
export function installStoreEffects(next: Partial<StoreEffects>): void {
  effects = { ...effects, ...next }
}

// ttl timers for pane toasts — keyed by toast id, cleared on dismiss
const paneToastTimers = new Map<string, ReturnType<typeof setTimeout>>()

function updWs(
  workspaces: Workspace[],
  wsId: string,
  fn: (w: Workspace) => Workspace
): Workspace[] {
  return workspaces.map((w) => (w.id === wsId ? fn(w) : w))
}

export const useStore = create<MahasState>((set, get) => {
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
    paneToasts: [],
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
        // content kinds find their own kind's leaf (docs → doc pane); a new
        // shell still lands where you're working — no affinity for 'term'
        const target = stackTarget(ws, null, kind === 'term' ? undefined : kind)
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
      set((s) => {
        const wsId = wsId0
        return {
          workspaces: updWs(s.workspaces, wsId, (w) => removePaneFromWs(w, paneId)),
          resumeSessions: Object.fromEntries(
            Object.entries(s.resumeSessions).filter(([, r]) => r.paneId !== paneId)
          )
        }
      })
      // a detached pane owns its window + pty sessions — the window's renderer
      // is already gone by close time, so kill its live sessions here. State is
      // committed first: a failing OS call must not strand the pane record.
      if (pane?.detached) {
        effects.killPtys(panePtySessionIds(pane))
        effects.closeDetachedWindow(wsId0, paneId)
      }
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
            const panes = {
              ...w.panes,
              [paneId]: { ...pane, detached: undefined } as PaneState
            }
            // a pane created while every leaf was hidden takes over the tree
            // and orphans hidden leaves — re-insert when the slot is gone
            // (same defensive path as restoreInWorkspace)
            if (w.root && leafPaneIds(w.root).includes(paneId)) {
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
        const tab0 = src?.tabs.find((t) => t.id === tabId)
        if (!from || !to || !src || !tab0) return s
        // a tucked tab being moved is meant to be seen — drop its docked
        // state at the destination (unreachable from the strip UI anyway,
        // which only drags visible tabs)
        const tab = (tab0.minimized ? { ...tab0, minimized: undefined } : tab0) as PaneTab
        if (targetPaneId === fromPaneId && !edge) return s // drop on own center = noop
        if (targetPaneId && !to.panes[targetPaneId]) return s

        const remaining = src.tabs.filter((t) => t.id !== tabId)
        // unreachable from the UI (a detached pane isn't a drag source), but
        // an emptied detached pane must also lose its window
        if (!remaining.length && src.detached) effects.closeDetachedWindow(fromWsId, fromPaneId)

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
      const tabs = p?.tabs.filter((t) => !t.minimized) ?? []
      if (!p || tabs.length < 2) return
      const i = Math.max(
        0,
        tabs.findIndex((t) => t.id === p.activeTabId)
      )
      const next = tabs[(i + dir + tabs.length) % tabs.length]
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
        const target = stackTarget(ws, paneId, 'file')
        if (!target) {
          const pane = makePane('file')
          pane.tabs = [tab]
          pane.activeTabId = tab.id
          return { workspaces: updWs(s.workspaces, wsId, (w) => insertPane(w, pane)) }
        }

        const p = ws.panes[target]
        const existing = p.tabs.find((t): t is EditorTab => t.kind === 'file' && t.path === path)
        if (existing) {
          // activating an already-open tab un-tucks it (a minimized tab being
          // opened again visibly belongs back in the strip); a permanent open
          // on a preview tab also pins it
          const ex = existing as PaneTab
          const tabs =
            (existing.preview && !preview) || ex.minimized
              ? p.tabs.map((t) =>
                  t.id === existing.id
                    ? ({
                        ...existing,
                        minimized: undefined,
                        preview: existing.preview && !preview ? undefined : existing.preview
                      } as PaneTab)
                    : t
                )
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

        const target = stackTarget(ws, paneId, 'web')
        const p = target ? ws.panes[target] : undefined
        const active = p?.tabs.find((t) => t.id === p.activeTabId)
        if (p && target && active?.kind === 'web' && !active.minimized && !newTab) {
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
            if (p.detached) effects.closeDetachedWindow(w.id, p.id)
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

    pushPaneToast: (t) => {
      // a same-key toast in the same pane is replaced, not stacked
      if (t.key) {
        const dup = get().paneToasts.find(
          (x) => x.wsId === t.wsId && x.paneId === t.paneId && x.key === t.key
        )
        if (dup) get().dismissPaneToast(dup.id)
      }
      const id = uid()
      set((s) => ({ paneToasts: [...s.paneToasts, { ...t, id }] }))
      if (t.ttl) {
        paneToastTimers.set(
          id,
          setTimeout(() => {
            paneToastTimers.delete(id)
            get().dismissPaneToast(id)
          }, t.ttl)
        )
      }
      return id
    },

    dismissPaneToast: (id) => {
      const tm = paneToastTimers.get(id)
      if (tm) {
        clearTimeout(tm)
        paneToastTimers.delete(id)
      }
      set((s) => ({ paneToasts: s.paneToasts.filter((x) => x.id !== id) }))
    },

    runPaneToastAction: (id, actionId) => {
      const act = get()
        .paneToasts.find((x) => x.id === id)
        ?.actions?.find((a) => a.id === actionId)
      get().dismissPaneToast(id)
      act?.run()
    },

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
          effects.focusDetachedWindow(n.workspaceId, n.paneId)
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
        const patch: Partial<MahasState> = {
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
        next[r.sessionId] = { ...prev, ...r, shutdown: undefined, cwd: r.cwd ?? prev?.cwd, ts: Date.now() }
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
interface MahasState extends PersistedState {
  notifications: AppNotification[]
  /** ambient-level pings shown as slide-down toasts — runtime-only */
  toasts: ToastItem[]
  /** pane-scoped toasts overlaid on the pane body — runtime-only */
  paneToasts: PaneToast[]
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
  /** pane-scoped toast — `ttl` ms auto-dismiss; returns its id */
  pushPaneToast: (t: Omit<PaneToast, 'id'> & { ttl?: number }) => string
  dismissPaneToast: (id: string) => void
  /** fire a toast action — dismisses the toast, then runs it */
  runPaneToastAction: (id: string, actionId: string) => void
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
