import { useStore } from './store'
import type { Settings } from './types'

/* Editable keybindings.

   Every bindable action has an id in ShortcutAction and a default combo in
   DEFAULT_BINDINGS. A combo is 'ctrl+alt+shift+key' — modifiers in that fixed
   order, key lowercased (' ' → 'space'). User overrides live in
   settings.bindings ('' = unbound) and ride the normal settings persistence.

   Two families stay hardcoded on purpose: Alt+1…9 (activate workspace N,
   clamped) and Ctrl+Tab / Ctrl+Shift+Tab (cycle tabs inside a pane). An
   explicit user binding still wins over a family combo — bindings are checked
   first. */

export type ShortcutAction =
  | 'pane.newTerminal'
  | 'pane.newBrowser'
  | 'pane.newEditor'
  | 'pane.splitRight'
  | 'pane.splitDown'
  | 'pane.close'
  | 'pane.minimize'
  | 'pane.float'
  | 'focus.next'
  | 'focus.prev'
  | 'focus.left'
  | 'focus.right'
  | 'focus.up'
  | 'focus.down'
  | 'ws.next'
  | 'ws.prev'
  | 'sidebar.toggle'
  | 'tree.toggle'
  | 'theme.toggle'

export const DEFAULT_BINDINGS: Record<ShortcutAction, string> = {
  'pane.newTerminal': 'alt+t',
  'pane.newBrowser': 'alt+b',
  'pane.newEditor': 'alt+e',
  'pane.splitRight': 'alt+d',
  'pane.splitDown': 'alt+s',
  'pane.close': 'alt+w',
  'pane.minimize': 'alt+h',
  'pane.float': 'alt+f',
  'focus.next': 'alt+]',
  'focus.prev': 'alt+[',
  'focus.left': 'alt+arrowleft',
  'focus.right': 'alt+arrowright',
  'focus.up': 'alt+arrowup',
  'focus.down': 'alt+arrowdown',
  'ws.next': 'ctrl+alt+arrowright',
  'ws.prev': 'ctrl+alt+arrowleft',
  'sidebar.toggle': 'alt+x',
  'tree.toggle': 'alt+o',
  'theme.toggle': 'alt+m'
}

export function effectiveBindings(
  settings: Pick<Settings, 'bindings'>
): Record<ShortcutAction, string> {
  return { ...DEFAULT_BINDINGS, ...settings.bindings } as Record<ShortcutAction, string>
}

export interface ShortcutInput {
  key: string
  alt: boolean
  ctrl: boolean
  shift: boolean
  meta: boolean
}

/** Normalize a key event into a combo string — 'ctrl+alt+shift+key'. */
export function comboOf(i: ShortcutInput): string {
  const mods = [i.ctrl && 'ctrl', i.alt && 'alt', i.shift && 'shift', i.meta && 'meta'].filter(
    Boolean
  )
  const k = i.key === ' ' ? 'space' : i.key.toLowerCase()
  return [...mods, k].join('+')
}

const KEY_LABEL: Record<string, string> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  space: 'Space',
  tab: 'Tab',
  escape: 'Esc',
  backspace: '⌫',
  delete: 'Del',
  enter: '↵'
}

/** 'ctrl+alt+arrowright' → 'Ctrl+Alt+→' for display. '' (unbound) → '—'. */
export function formatCombo(combo: string): string {
  if (!combo) return '—'
  return combo
    .split('+')
    .map((p) => {
      if (p === 'ctrl') return 'Ctrl'
      if (p === 'alt') return 'Alt'
      if (p === 'shift') return 'Shift'
      if (p === 'meta') return 'Meta'
      return KEY_LABEL[p] ?? (p.length === 1 ? p.toUpperCase() : p)
    })
    .join('+')
}

/* While the settings page is capturing a new binding, the dispatch must not
   fire — the captured keys are input, not commands. The recorder sets this
   module flag because its window listener is registered after App's (same
   target + phase = registration order decides). */
let capturing = false
export function setKeyCapture(on: boolean): void {
  capturing = on
}
export function isKeyCapturing(): boolean {
  return capturing
}

// Directional focus move: among the active workspace's rendered .pane rects,
// pick the pane whose center lies in `dir` from the focused pane's center,
// scored by axial + orthogonal distance. Null when nothing lies that way.
function paneIdInDirection(
  st: ReturnType<typeof useStore.getState>,
  dir: 'left' | 'right' | 'up' | 'down'
): string | null {
  const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId)
  const host = document.querySelector('.ws-host:not([hidden])')
  if (!ws?.focusedPaneId || !host) return null
  // minimized panes stay mounted inside [hidden] wrappers — zero rects, so
  // they'd wrongly win left/up; exclude them (and bail if focus is on one)
  const els = [...host.querySelectorAll<HTMLElement>('.pane[data-pane-id]')].filter(
    (el) => !el.closest('[hidden]')
  )
  const from = els.find((el) => el.dataset.paneId === ws.focusedPaneId)
  if (!from) return null
  const fr = from.getBoundingClientRect()
  const fx = fr.left + fr.width / 2
  const fy = fr.top + fr.height / 2
  let best: { id: string; score: number } | null = null
  for (const el of els) {
    if (el === from) continue
    const r = el.getBoundingClientRect()
    const dx = r.left + r.width / 2 - fx
    const dy = r.top + r.height / 2 - fy
    const axial = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy
    if (axial <= 0) continue
    const score = axial + Math.abs(dir === 'left' || dir === 'right' ? dy : dx)
    const id = el.dataset.paneId
    if (id && (!best || score < best.score)) best = { id, score }
  }
  return best?.id ?? null
}

type St = ReturnType<typeof useStore.getState>

function run(st: St, a: ShortcutAction): boolean {
  const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId)
  switch (a) {
    case 'pane.newTerminal':
      st.newBlock('term')
      return true
    case 'pane.newBrowser':
      st.newBlock('web')
      return true
    case 'pane.newEditor':
      st.newBlock('file')
      return true
    case 'pane.splitRight':
      if (ws?.focusedPaneId) st.splitPane(ws.focusedPaneId, 'row', 'term')
      else st.newBlock('term')
      return true
    case 'pane.splitDown':
      if (ws?.focusedPaneId) st.splitPane(ws.focusedPaneId, 'col', 'term')
      else st.newBlock('term')
      return true
    case 'pane.close':
      if (!ws?.focusedPaneId) return false
      st.closePane(ws.focusedPaneId)
      return true
    case 'pane.minimize':
      if (!ws?.focusedPaneId) return false
      st.minimizePane(ws.focusedPaneId)
      return true
    case 'pane.float': {
      const p = ws?.focusedPaneId ? ws.panes[ws.focusedPaneId] : undefined
      if (!p) return false
      if (p.floating) st.dockPane(p.id)
      else if (!p.detached) st.floatPane(p.id)
      return true
    }
    case 'focus.next':
      st.cycleFocus(1)
      return true
    case 'focus.prev':
      st.cycleFocus(-1)
      return true
    case 'focus.left':
    case 'focus.right':
    case 'focus.up':
    case 'focus.down': {
      const dir = a.slice('focus.'.length) as 'left' | 'right' | 'up' | 'down'
      const paneId = paneIdInDirection(st, dir)
      if (!paneId) return false
      st.focusPane(paneId)
      return true
    }
    case 'ws.next':
      st.cycleWorkspace(1)
      return true
    case 'ws.prev':
      st.cycleWorkspace(-1)
      return true
    case 'sidebar.toggle':
      st.setSidebarOpen(!st.sidebarOpen)
      return true
    case 'tree.toggle':
      st.setTreeOverlayOpen(!st.treeOverlayOpen)
      return true
    case 'theme.toggle':
      st.updateSettings({ theme: st.resolvedTheme === 'dark' ? 'light' : 'dark' })
      return true
  }
}

// Shared shortcut dispatch — used by the window keydown listener AND by keys
// forwarded from <webview> guests (a focused webview never emits keydown to
// the host document; resources/webview-preload.cjs relays them via
// ipc-message → `mahas:key`). Returns true when handled.
export function applyShortcut(input: ShortcutInput): boolean {
  if (capturing || input.meta) return false
  const st = useStore.getState()

  // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs inside the focused pane.
  // Deliberately window-level (not gated on target): inputs, CodeMirror and
  // xterm must not keep it; panes without internal tabs simply no-op.
  // A user binding for ctrl+tab wins — check bindings first below.
  // bare keys are never bindable — every typed letter would fire the action
  if (input.alt || input.ctrl) {
    const combo = comboOf(input)
    const bindings = effectiveBindings(st.settings)
    const action = (Object.keys(bindings) as ShortcutAction[]).find((a) => bindings[a] === combo)
    if (action) return run(st, action)
  }

  // unbound defaults that aren't in the binding table
  if (input.ctrl && !input.alt && input.key === 'Tab') {
    st.cyclePaneTab(input.shift ? -1 : 1)
    return true
  }
  // Alt+1 … Alt+9 → workspace N, clamped to the last existing one
  if (input.alt && !input.ctrl && !input.shift) {
    const key = input.key.toLowerCase()
    if (key >= '1' && key <= '9' && st.workspaces.length > 0) {
      const i = Math.min(Number(key) - 1, st.workspaces.length - 1)
      st.activateWorkspace(st.workspaces[i].id)
      return true
    }
  }
  return false
}
