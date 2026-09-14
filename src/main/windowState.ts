// Per-window geometry persistence. Saved to userData/window-state.json keyed
// by a logical name ('main', 'detached'). Written debounced on resize/move and
// immediately on close. On restore, positions that don't intersect any current
// display's work area are dropped (monitor layouts change) — Wayland ignores
// x/y anyway, but size + maximized still apply.

import { app, screen, BrowserWindow, Rectangle } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

type Store = Record<string, WindowState>

const FILE = (): string => join(app.getPath('userData'), 'window-state.json')

function readAll(): Store {
  try {
    const j = JSON.parse(readFileSync(FILE(), 'utf8'))
    return j && typeof j === 'object' ? (j as Store) : {}
  } catch {
    return {}
  }
}

function writeAll(store: Store): void {
  try {
    const file = FILE()
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(store), 'utf8')
    renameSync(tmp, file)
  } catch {
    /* non-fatal */
  }
}

// enough of the frame must be visible to grab it back
function isOnScreen(b: Rectangle): boolean {
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    const w = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x)
    const h = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y)
    return w >= 100 && h >= 60
  })
}

/** Restore geometry for `key`, clamped to `wa` (the display under the cursor).
 *  No saved state → `{}` — callers fall back to their defaults. */
export function windowStateFor(
  key: string,
  wa: Rectangle
): { width?: number; height?: number; x?: number; y?: number; maximized?: boolean } {
  const st = readAll()[key]
  if (!st || !(st.width > 0) || !(st.height > 0)) return {}
  const width = Math.min(Math.round(st.width), wa.width)
  const height = Math.min(Math.round(st.height), wa.height)
  const onScreen =
    typeof st.x === 'number' &&
    typeof st.y === 'number' &&
    isOnScreen({ x: st.x, y: st.y, width, height })
  return {
    width,
    height,
    ...(onScreen ? { x: Math.round(st.x!), y: Math.round(st.y!) } : {}),
    maximized: !!st.maximized
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

function persist(key: string, win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const b = win.getNormalBounds() // pre-maximize rect — what we want to restore
  const store = readAll()
  store[key] = { ...b, maximized: win.isMaximized() }
  writeAll(store)
}

/** Track resize/move/maximize on `win` and persist under `key`. */
export function trackWindowState(key: string, win: BrowserWindow): void {
  const debounced = (): void => {
    const t = timers.get(key)
    if (t) clearTimeout(t)
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        persist(key, win)
      }, 400)
    )
  }
  win.on('resize', debounced)
  win.on('move', debounced)
  win.on('maximize', debounced)
  win.on('unmaximize', debounced)
  win.on('close', () => persist(key, win))
}
