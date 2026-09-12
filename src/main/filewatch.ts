import { ipcMain, webContents, type WebContents } from 'electron'
import { watch, type FSWatcher } from 'fs'
import { stat } from 'fs/promises'

// External-change detection for editor files. One fs.watch per open file,
// refcounted across FileView mounts (two tabs on the same path share it).
// Editors often save via tmp+rename which leaves the inotify watch on the
// dead inode — a 'rename' event re-arms the watcher, and while the file is
// missing we fall back to a 1s stat poll so a recreate still notifies.

interface FileChangedMsg {
  path: string
  mtimeMs?: number
  deleted?: boolean
}

interface WatchEntry {
  path: string
  watcher: FSWatcher | null
  refs: Map<number, number> // webContents id -> number of FileViews watching
  debounce: ReturnType<typeof setTimeout> | null
  poll: ReturnType<typeof setInterval> | null
  renameSeen: boolean
  deleted: boolean // last broadcast was a deletion — dedupe repeats
  lastMtimeMs: number | null // last broadcast mtime — dedupe repeats
}

const watchers = new Map<string, WatchEntry>()
const trackedWcs = new Set<number>()

function broadcast(entry: WatchEntry, msg: FileChangedMsg): void {
  for (const wcId of entry.refs.keys()) {
    const wc = webContents.fromId(wcId)
    if (wc && !wc.isDestroyed()) wc.send('file:changed', msg)
  }
}

function destroyEntry(entry: WatchEntry): void {
  if (entry.debounce) clearTimeout(entry.debounce)
  if (entry.poll) clearInterval(entry.poll)
  if (entry.watcher) {
    try {
      entry.watcher.close()
    } catch {
      /* already closed */
    }
  }
  if (watchers.get(entry.path) === entry) watchers.delete(entry.path)
}

// While the file is missing (or fs.watch failed) poll stat() once a second —
// picks up recreates and doubles as a fallback for EACCES-broken watchers.
function goDead(entry: WatchEntry): void {
  if (entry.watcher) {
    try {
      entry.watcher.close()
    } catch {
      /* already closed */
    }
    entry.watcher = null
  }
  if (!entry.poll && watchers.get(entry.path) === entry) {
    entry.poll = setInterval(() => void probe(entry), 1000)
    entry.poll.unref()
  }
}

function armWatch(entry: WatchEntry): boolean {
  if (watchers.get(entry.path) !== entry || entry.watcher) return entry.watcher !== null
  try {
    const w = watch(entry.path, { persistent: false }, (eventType) => {
      entry.renameSeen ||= eventType === 'rename'
      if (entry.debounce) clearTimeout(entry.debounce)
      entry.debounce = setTimeout(() => void probe(entry), 100)
      entry.debounce.unref()
    })
    w.on('error', () => {
      try {
        w.close()
      } catch {
        /* already closed */
      }
      if (entry.watcher === w) entry.watcher = null
      // probe decides: broadcast {deleted:true} + poll, or re-arm if back
      void probe(entry)
    })
    entry.watcher = w
    if (entry.poll) {
      clearInterval(entry.poll)
      entry.poll = null
    }
    return true
  } catch {
    return false
  }
}

// stat the file and push the current state to subscribers (debounced entry
// point for fs events, poll ticks, and watcher-error recovery).
async function probe(entry: WatchEntry): Promise<void> {
  if (watchers.get(entry.path) !== entry) return
  try {
    const st = await stat(entry.path)
    if (!st.isFile()) throw new Error('not a file')
    const renamed = entry.renameSeen
    entry.renameSeen = false
    if (entry.deleted || st.mtimeMs !== entry.lastMtimeMs) {
      entry.deleted = false
      entry.lastMtimeMs = st.mtimeMs
      broadcast(entry, { path: entry.path, mtimeMs: st.mtimeMs })
    }
    // tmp+rename saves move the watch onto a dead inode — re-arm on the
    // path so future edits keep reporting
    if (renamed && entry.watcher) {
      try {
        entry.watcher.close()
      } catch {
        /* already closed */
      }
      entry.watcher = null
    }
    if (!entry.watcher) armWatch(entry)
  } catch {
    if (!entry.deleted) {
      entry.deleted = true
      broadcast(entry, { path: entry.path, deleted: true })
    }
    goDead(entry)
  }
}

function releaseRef(entry: WatchEntry, wcId: number): void {
  const n = (entry.refs.get(wcId) ?? 0) - 1
  if (n > 0) entry.refs.set(wcId, n)
  else entry.refs.delete(wcId)
  if (entry.refs.size === 0) destroyEntry(entry)
}

function addRef(path: string, wc: WebContents): WatchEntry {
  let entry = watchers.get(path)
  if (!entry) {
    entry = {
      path,
      watcher: null,
      refs: new Map(),
      debounce: null,
      poll: null,
      renameSeen: false,
      deleted: false,
      lastMtimeMs: null
    }
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

export function registerFileWatchIpc(): void {
  ipcMain.handle('file:watch', async (e, p: string) => {
    if (typeof p !== 'string' || !p) return { ok: false, error: 'invalid args' }
    // ref is taken synchronously so an unwatch that lands mid-stat still wins
    const entry = addRef(p, e.sender)
    try {
      const st = await stat(p)
      if (!st.isFile()) throw new Error('not a file')
      if (watchers.get(p) !== entry) return { ok: true } // unwatched mid-flight
      entry.lastMtimeMs = st.mtimeMs
      if (!armWatch(entry)) goDead(entry)
      return { ok: true }
    } catch (err) {
      releaseRef(entry, e.sender.id)
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
    }
  })

  ipcMain.handle('file:unwatch', (e, p: string) => {
    const entry = typeof p === 'string' ? watchers.get(p) : undefined
    if (entry) releaseRef(entry, e.sender.id)
    return { ok: true }
  })
}
