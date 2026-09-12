import { ipcMain, webContents, type WebContents } from 'electron'
import { watch, type FSWatcher } from 'fs'

// Directory listing watches for the file tree. One fs.watch per expanded dir,
// refcounted per webContents (sidebar tree + hover overlay can share a dir).
// Any child add/remove/rename debounces into a `dir:changed` push — the
// renderer re-lists that dir, so tree mutations AND external/agent edits both
// refresh. Watcher death (dir deleted, EACCES) reports one final change so a
// deleted dir collapses to empty instead of going stale.

interface DirWatchEntry {
  path: string
  watcher: FSWatcher | null
  refs: Map<number, number> // webContents id -> number of watchers
  debounce: ReturnType<typeof setTimeout> | null
}

const watchers = new Map<string, DirWatchEntry>()
const trackedWcs = new Set<number>()

function broadcast(entry: DirWatchEntry): void {
  for (const wcId of entry.refs.keys()) {
    const wc = webContents.fromId(wcId)
    if (wc && !wc.isDestroyed()) wc.send('dir:changed', { path: entry.path })
  }
}

function destroyEntry(entry: DirWatchEntry): void {
  if (entry.debounce) clearTimeout(entry.debounce)
  if (entry.watcher) {
    try {
      entry.watcher.close()
    } catch {
      /* already closed */
    }
  }
  if (watchers.get(entry.path) === entry) watchers.delete(entry.path)
}

function arm(entry: DirWatchEntry): void {
  if (watchers.get(entry.path) !== entry || entry.watcher) return
  try {
    const w = watch(entry.path, { persistent: false }, () => {
      if (entry.debounce) clearTimeout(entry.debounce)
      entry.debounce = setTimeout(() => broadcast(entry), 120)
      entry.debounce.unref()
    })
    w.on('error', () => {
      try {
        w.close()
      } catch {
        /* already closed */
      }
      if (entry.watcher === w) entry.watcher = null
      broadcast(entry)
    })
    entry.watcher = w
  } catch {
    // unwatched-able dir (deleted between expand and watch) — tell the
    // renderer once so it re-lists and drops the stale children
    broadcast(entry)
  }
}

function releaseRef(entry: DirWatchEntry, wcId: number): void {
  const n = (entry.refs.get(wcId) ?? 0) - 1
  if (n > 0) entry.refs.set(wcId, n)
  else entry.refs.delete(wcId)
  if (entry.refs.size === 0) destroyEntry(entry)
}

function addRef(path: string, wc: WebContents): DirWatchEntry {
  let entry = watchers.get(path)
  if (!entry) {
    entry = { path, watcher: null, refs: new Map(), debounce: null }
    watchers.set(path, entry)
  }
  entry.refs.set(wc.id, (entry.refs.get(wc.id) ?? 0) + 1)
  if (!trackedWcs.has(wc.id)) {
    trackedWcs.add(wc.id)
    wc.once('destroyed', () => {
      trackedWcs.delete(wc.id)
      for (const e of [...watchers.values()]) releaseRef(e, wc.id)
    })
  }
  return entry
}

export function registerDirWatchIpc(): void {
  ipcMain.handle('dir:watch', (e, p: string) => {
    if (typeof p !== 'string' || !p) return { ok: false, error: 'invalid args' }
    const entry = addRef(p, e.sender)
    arm(entry)
    return { ok: true }
  })

  ipcMain.handle('dir:unwatch', (e, p: string) => {
    const entry = typeof p === 'string' ? watchers.get(p) : undefined
    if (entry) releaseRef(entry, e.sender.id)
    return { ok: true }
  })
}
