// mahas shell — layout algebra.
//
// Pure functions over Workspace/PaneState/LayoutNode: where a new leaf is
// inserted, which leaf a programmatic open lands in, what happens to a leaf
// when its pane floats/detaches/minimizes. No zustand, no IPC — the store
// (store.ts) owns state transitions and calls in here, and the layout rules
// stay testable and reusable on their own.
//
// The invariants these functions encode (see AGENTS.md):
//   - a programmatic open STACKS into an existing leaf; the focused leaf is
//     never implicitly split (soleLeafSplit is the one documented exception);
//   - a hidden (minimized/detached) leaf keeps its slot in the tree, so
//     restoring a pane lands it back in the exact place it left;
//   - minimized/detached panes are invisible for target selection but their
//     records survive.

import type {
  BlockKind,
  DropEdge,
  LayoutNode,
  PaneState,
  PaneTab,
  WidgetKind,
  Workspace
} from '../types'
import { uid } from './ids'

export function makeTab(kind: BlockKind, home = '', widget?: WidgetKind): PaneTab {
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

export function makePane(kind: BlockKind, home = '', widget?: WidgetKind): PaneState {
  const tab = makeTab(kind, home, widget)
  return { id: uid(), tabs: [tab], activeTabId: tab.id }
}

export function leaf(paneId: string): LayoutNode {
  return { kind: 'leaf', id: uid(), paneId }
}

// Insert a leaf for paneId into root: split `targetPaneId` at `edge` when the
// target leaf exists, append at the end when target is null (n/(n+1) keeps the
// existing panes' relative share), or become the sole leaf when root is null.
export function insertAt(
  root: LayoutNode | null,
  panes: Record<string, PaneState>,
  paneId: string,
  targetPaneId: string | null,
  edge: DropEdge | null
): LayoutNode {
  const vis = root ? visibleLeafIds(root, panes) : []
  if (root && targetPaneId && edge && vis.includes(targetPaneId)) {
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
    // every leaf is hidden (minimized/detached) — wrapping the whole tree
    // would hand half the screen to dead space and bury each restored pane a
    // level deeper. Take over instead; hidden leaves re-insert on restore.
    if (!vis.length) return leaf(paneId)
    // hidden leaves present — a root append would demote their slots one
    // level (restoring shrinks them); split the last visible leaf so hidden
    // slots keep their exact share.
    if (vis.length !== leafPaneIds(root).length) {
      return mapLeaf(root, vis[vis.length - 1], (l) => ({
        kind: 'split',
        id: uid(),
        dir: 'row',
        ratio: 0.5,
        a: l,
        b: leaf(paneId)
      }))
    }
    const n = vis.length
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
export function insertPane(w: Workspace, pane: PaneState): Workspace {
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
// UI — allowed even when detached), else — for content kinds — a visible leaf
// already hosting that kind (docs bundle with docs, web tabs with web tabs),
// else the focused visible pane, else the last visible leaf. Undefined =
// nothing on screen; the caller makes a leaf.
// Invariant: opens stack into an existing leaf, never split — a focused leaf
// can only be split by explicit user gestures (split keys, drag-to-edge),
// with ONE exception: see soleLeafSplit.
export function stackTarget(
  w: Workspace,
  paneId?: string | null,
  kind?: PaneTab['kind']
): string | undefined {
  const explicit = paneId && w.panes[paneId] && !w.panes[paneId].minimized ? paneId : undefined
  if (explicit) return explicit
  const focused =
    w.focusedPaneId &&
    w.panes[w.focusedPaneId] &&
    !w.panes[w.focusedPaneId].minimized &&
    !w.panes[w.focusedPaneId].detached
      ? w.focusedPaneId
      : undefined
  const vis = visibleLeafIds(w.root, w.panes)
  if (kind) {
    const withKind = vis.filter((id) =>
      w.panes[id]?.tabs.some((t) => t.kind === kind && !t.minimized)
    )
    if (withKind.length) {
      // a kind-carrying leaf you're looking at wins; otherwise the one whose
      // active tab is that kind, then the one holding the most of them
      if (focused && withKind.includes(focused)) return focused
      return withKind
        .map((id) => {
          const p = w.panes[id]
          const active = p.tabs.find((t) => t.id === p.activeTabId)
          return {
            id,
            top: active && !active.minimized && active.kind === kind ? 1 : 0,
            n: p.tabs.filter((t) => t.kind === kind).length
          }
        })
        .sort((a, b) => b.top - a.top || b.n - a.n)[0].id
    }
  }
  return focused ?? vis.at(-1)
}

// Terminal links (file paths, urls) open in a content pane rather than the
// pane you clicked in — that pane's strip is the terminal's own business.
// Among the OTHER visible leaves prefer ones already carrying file/web
// blocks (pure content > mixed > terminals) and break ties by fewest tabs,
// so file+browse roughly bundle together and new tabs spread out. Undefined
// = no other leaf — the caller's stackTarget/soleLeafSplit path decides
// (a sole terminal leaf still splits right for the open).
export function linkTargetPane(w: Workspace, fromPaneId: string): string | undefined {
  const leaves = visibleLeafIds(w.root, w.panes).filter((id) => id !== fromPaneId)
  if (!leaves.length) return undefined
  const count = (id: string, kind: PaneTab['kind']): number =>
    w.panes[id].tabs.filter((t) => t.kind === kind).length
  const rank = (id: string): number => {
    const content = count(id, 'file') + count(id, 'web')
    if (!content) return 0
    return count(id, 'term') ? 1 : 2
  }
  return leaves
    .map((id) => ({ id, r: rank(id), n: w.panes[id].tabs.length }))
    .sort((a, b) => b.r - a.r || a.n - b.n)[0].id
}

// The one exception to stack-don't-split: a workspace with a single visible
// leaf. Stacking a new tab on top of it hides the thing you were looking at,
// so the open splits that leaf right and lands in the new pane instead.
// Returns the updated workspace, or null when the exception doesn't apply.
export function soleLeafSplit(
  w: Workspace,
  target: string | undefined,
  tab: PaneTab
): Workspace | null {
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
export function pushTab(
  w: Workspace,
  paneId: string,
  tabs: PaneTab[],
  activeTabId: string
): Workspace {
  const p = w.panes[paneId]
  if (!p) return w
  return {
    ...w,
    panes: { ...w.panes, [paneId]: { ...p, tabs, activeTabId } },
    focusedPaneId: p.detached ? w.focusedPaneId : paneId
  }
}

export function mapLeaf(
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

export function removeLeaf(node: LayoutNode, paneId: string): LayoutNode | null {
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
export function removePaneFromWs(w: Workspace, paneId: string): Workspace {
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

export function swapPaneIds(node: LayoutNode, a: string, b: string): LayoutNode {
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

export function setRatioIn(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
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
export function maxFloatZ(w: Workspace): number {
  let z = 0
  for (const p of Object.values(w.panes)) if (p.floating) z = Math.max(z, p.floating.z)
  return z
}

// A pane's display number is creation order within the workspace — stable
// across splits/moves (layout position isn't identity). Not necessarily
// contiguous: closed panes leave gaps rather than renumbering survivors.
export function nextPaneNum(w: Workspace): number {
  let n = 0
  for (const p of Object.values(w.panes)) n = Math.max(n, p.num ?? 0)
  return n + 1
}

// The sibling subtree of paneId's leaf — its nearest neighbor in the layout.
export function siblingOf(node: LayoutNode | null, paneId: string): LayoutNode | null {
  if (!node || node.kind === 'leaf') return null
  if (node.a.kind === 'leaf' && node.a.paneId === paneId) return node.b
  if (node.b.kind === 'leaf' && node.b.paneId === paneId) return node.a
  return siblingOf(node.a, paneId) ?? siblingOf(node.b, paneId)
}

// When a pane leaves the layout (float/detach) its tree root materializes to
// the project path if it never had one — the pane keeps its own root from
// then on, independent of the workspace it sits in.
export function withTreeRoot(pane: PaneState, projectPath: string | undefined): PaneState {
  if (pane.treeRoot || !projectPath) return pane
  return { ...pane, treeRoot: projectPath }
}

// Clear a pane's minimized flag and focus it. Its leaf is still in the layout
// so the pane pops back into its exact slot; floating panes aren't in the
// tree at all — clearing the flag just brings the overlay back. Defensively,
// a leaf missing from root is re-inserted at the focused visible pane (or as
// the sole leaf).
export function restoreInWorkspace(w: Workspace, paneId: string): Workspace {
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
