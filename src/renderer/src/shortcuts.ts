import { useStore } from './store'

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

export interface ShortcutInput {
  key: string
  alt: boolean
  ctrl: boolean
  shift: boolean
  meta: boolean
}

// Shared shortcut dispatch — used by the window keydown listener AND by keys
// forwarded from <webview> guests (a focused webview never emits keydown to
// the host document; resources/webview-preload.cjs relays them via
// ipc-message → `ade:key`). Returns true when handled.
export function applyShortcut(input: ShortcutInput): boolean {
  if (input.meta) return false
  const st = useStore.getState()

  // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs inside the focused pane.
  // Deliberately window-level (not gated on target): inputs, CodeMirror and
  // xterm must not keep it; panes without internal tabs simply no-op.
  if (input.ctrl && !input.alt && input.key === 'Tab') {
    st.cyclePaneTab(input.shift ? -1 : 1)
    return true
  }

  if (!input.alt) return false
  const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId)
  const key = input.key.toLowerCase()
  switch (key) {
    case 't':
      st.newPane('terminal')
      break
    case 'b':
      st.newPane('browser')
      break
    case 'e':
      st.newPane('editor')
      break
    case 'l':
      st.newPane('todo')
      break
    case 'd':
      if (ws?.focusedPaneId) st.splitPane(ws.focusedPaneId, 'row', 'terminal')
      else st.newPane('terminal')
      break
    case 's':
      if (ws?.focusedPaneId) st.splitPane(ws.focusedPaneId, 'col', 'terminal')
      else st.newPane('terminal')
      break
    case 'w':
      if (ws?.focusedPaneId) st.closePane(ws.focusedPaneId)
      break
    case 'h':
      if (ws?.focusedPaneId) st.minimizePane(ws.focusedPaneId)
      break
    case ']':
      st.cycleFocus(1)
      break
    case '[':
      st.cycleFocus(-1)
      break
    case 'm':
      st.updateSettings({ theme: st.resolvedTheme === 'dark' ? 'light' : 'dark' })
      break
    case 'arrowright':
    case 'arrowleft':
    case 'arrowdown':
    case 'arrowup': {
      const dir = key.slice('arrow'.length) as 'right' | 'left' | 'down' | 'up'
      if (input.ctrl) {
        // Ctrl+Alt+←/→ = previous/next workspace; up/down stays unbound
        if (dir === 'up' || dir === 'down') return false
        st.cycleWorkspace(dir === 'right' ? 1 : -1)
      } else {
        const paneId = paneIdInDirection(st, dir)
        if (!paneId) return false
        st.focusPane(paneId)
      }
      break
    }
    default:
      // Alt+1 … Alt+9 → workspace N, clamped to the last existing one
      if (key >= '1' && key <= '9' && st.workspaces.length > 0) {
        const i = Math.min(Number(key) - 1, st.workspaces.length - 1)
        st.activateWorkspace(st.workspaces[i].id)
        break
      }
      return false
  }
  return true
}
