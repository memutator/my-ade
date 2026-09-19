// mahas main — file/directory/clipboard IPC.
//
// The read path is deliberately conservative: a file that is a directory, is
// over the size cap, or contains NUL bytes in its first 8 KiB is reported as
// such instead of being handed to the renderer. The editor relies on `kind`
// to decide between CodeMirror, an <img>, a PDF frame or a "binary" notice —
// guessing here would mean loading a 2 GB blob into the renderer to find out.
//
// `mtimeMs` comes back on read and write so the editor's save-guard can tell
// its own save apart from an external edit to the same file.

import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { basename, extname, isAbsolute, join, resolve } from 'path'
import { homedir } from 'os'
import { readFile, stat, readdir, writeFile } from 'fs/promises'

const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.bmp',
  '.avif'
])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.m4v', '.mov', '.ogv'])
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac', '.opus'])
const MAX_FILE_BYTES = 20 * 1024 * 1024
/** how much of a file is sniffed for NUL bytes when classifying it */
const BINARY_SNIFF_BYTES = 8192

export interface FileIpcDeps {
  /** fallback owner for dialogs opened without a sender window */
  main: () => BrowserWindow | null
}

export function registerFileIpc(deps: FileIpcDeps): void {
  const owner = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender) ?? deps.main()

  ipcMain.handle('file:openDialog', async (e) => {
    const win = owner(e)
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('file:read', async (_e, filePath: string) => {
    try {
      const st = await stat(filePath)
      if (!st.isFile()) return { ok: false, error: 'not a file' }
      if (st.size > MAX_FILE_BYTES) return { ok: false, error: 'file too large' }
      const buf = await readFile(filePath)
      const ext = extname(filePath).toLowerCase()
      const head = buf.subarray(0, BINARY_SNIFF_BYTES)
      const kind = IMAGE_EXTS.has(ext)
        ? 'image'
        : VIDEO_EXTS.has(ext)
          ? 'video'
          : AUDIO_EXTS.has(ext)
            ? 'audio'
            : ext === '.pdf'
              ? 'pdf'
              : head.includes(0)
                ? 'binary'
                : 'text'
      return {
        ok: true,
        name: basename(filePath),
        path: filePath,
        ext,
        size: st.size,
        kind,
        mtimeMs: st.mtimeMs,
        data: buf.toString('base64')
      }
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) }
    }
  })

  ipcMain.handle('file:write', async (_e, filePath: string, content: string) => {
    try {
      if (typeof filePath !== 'string' || typeof content !== 'string')
        return { ok: false, error: 'invalid args' }
      await writeFile(filePath, content, 'utf8')
      // the save-guard in FileView records this mtime so a later external
      // edit still detects the divergence
      try {
        const st = await stat(filePath)
        return { ok: true, mtimeMs: st.mtimeMs }
      } catch {
        return { ok: true }
      }
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) }
    }
  })

  ipcMain.handle('file:stat', async (_e, filePath: string) => {
    try {
      const st = await stat(filePath)
      return { ok: true, exists: st.isFile(), mtimeMs: st.mtimeMs }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, exists: false }
      return { ok: false, error: String(e instanceof Error ? e.message : e) }
    }
  })
}

export function registerFsIpc(deps: FileIpcDeps): void {
  ipcMain.handle('fs:list', async (_e, dirPath: string) => {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries
        .map((d) => ({
          name: d.name,
          path: join(dirPath, d.name),
          isDir: d.isDirectory()
        }))
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
        .slice(0, 500)
    } catch {
      return []
    }
  })

  // Resolve a possibly-relative or ~ path (terminal link clicks) to absolute.
  ipcMain.handle('fs:resolve', (_e, p: string, cwd?: string) => {
    if (typeof p !== 'string' || !p) return null
    if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(2))
    return isAbsolute(p) ? resolve(p) : resolve(cwd || homedir(), p)
  })

  ipcMain.handle('dialog:pickDirectory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? deps.main()
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // terminal copy/paste — the renderer can't rely on navigator.clipboard on
  // file:// (non-secure context), so it goes through the main process
  ipcMain.handle('clipboard:write', (_e, t: string) => {
    if (typeof t === 'string') clipboard.writeText(t)
  })
  ipcMain.handle('clipboard:read', () => clipboard.readText())
}
