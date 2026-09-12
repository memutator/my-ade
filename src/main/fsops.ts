import { ipcMain, shell } from 'electron'
import { join, basename, dirname, extname } from 'path'
import { rename, mkdir, writeFile, cp, rm, stat } from 'fs/promises'
import { existsSync } from 'fs'

// File-tree operations: create / rename / trash / copy / move / reveal.
// Every handler validates names and reports {ok,error} — the renderer flashes
// failures in the tree status line instead of throwing across IPC.

type OpResult = { ok: boolean; error?: string; path?: string; paths?: string[] }

const ok = (extra?: Partial<OpResult>): OpResult => ({ ok: true, ...extra })
const fail = (e: unknown): OpResult => ({
  ok: false,
  error: String(e instanceof Error ? e.message : e)
})

// A valid single path segment — no separators, no dot specials, no leading
// space (trailing dots/spaces also rejected: they'd be unusable on win32 and
// confusing everywhere else).
function validName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name === name.trim() &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/]/.test(name)
  )
}

function exists(p: string): boolean {
  return existsSync(p)
}

// "file.txt" → "file copy.txt" → "file copy 2.txt"; "dir" → "dir copy".
// First choice is the plain name — only colliding copies get a suffix.
async function availableName(destDir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 0; ; i++) {
    const cand = i === 0 ? name : i === 1 ? `${stem} copy${ext}` : `${stem} copy ${i}${ext}`
    if (!exists(join(destDir, cand))) return cand
  }
}

async function copyOne(src: string, destDir: string): Promise<string> {
  const name = await availableName(destDir, basename(src))
  const dest = join(destDir, name)
  await cp(src, dest, { recursive: true, errorOnExist: false })
  return dest
}

async function moveOne(src: string, destDir: string): Promise<string> {
  const dest = join(destDir, basename(src))
  if (dirname(src) === destDir) return src // cut+paste into own folder = no-op
  if (exists(dest)) throw new Error(`"${basename(src)}" already exists in destination`)
  try {
    await rename(src, dest)
  } catch (e) {
    // cross-device: fall back to copy + remove
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await cp(src, dest, { recursive: true, errorOnExist: true })
    await rm(src, { recursive: true, force: true })
  }
  return dest
}

async function eachPath(paths: unknown, fn: (p: string) => Promise<string>): Promise<OpResult> {
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string'))
    return { ok: false, error: 'invalid args' }
  const done: string[] = []
  for (const p of paths as string[]) {
    try {
      done.push(await fn(p))
    } catch (e) {
      return { ...fail(e), paths: done }
    }
  }
  return ok({ paths: done })
}

export function registerFsOpsIpc(): void {
  ipcMain.handle(
    'fs:create',
    async (_e, dirPath: string, name: string, kind: 'file' | 'dir'): Promise<OpResult> => {
      try {
        if (typeof dirPath !== 'string' || !validName(name)) return fail('invalid name')
        const st = await stat(dirPath).catch(() => null)
        if (!st?.isDirectory()) return fail('not a directory')
        const dest = join(dirPath, name)
        if (exists(dest)) return fail(`"${name}" already exists`)
        if (kind === 'dir') await mkdir(dest)
        else await writeFile(dest, '', { flag: 'wx' })
        return ok({ path: dest })
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle('fs:rename', async (_e, oldPath: string, newPath: string): Promise<OpResult> => {
    try {
      if (typeof oldPath !== 'string' || !validName(newPath ? basename(newPath) : ''))
        return fail('invalid name')
      if (oldPath === newPath) return ok({ path: newPath })
      if (exists(newPath)) return fail(`"${basename(newPath)}" already exists`)
      // a dir can't be renamed into itself
      if (newPath.startsWith(oldPath.endsWith('/') ? oldPath : oldPath + '/'))
        return fail('cannot move a folder into itself')
      await rename(oldPath, newPath)
      return ok({ path: newPath })
    } catch (e) {
      return fail(e)
    }
  })

  // Delete = OS trash (recoverable); never a hard unlink.
  ipcMain.handle('fs:trash', async (_e, paths: string[]): Promise<OpResult> => {
    return eachPath(paths, async (p) => {
      await shell.trashItem(p)
      return p
    })
  })

  ipcMain.handle('fs:copy', async (_e, paths: string[], destDir: string): Promise<OpResult> => {
    if (typeof destDir !== 'string' || !(await stat(destDir).catch(() => null))?.isDirectory())
      return fail('not a directory')
    return eachPath(paths, async (p) => {
      if (isUnder(destDir, p)) throw new Error(`cannot copy "${basename(p)}" into itself`)
      return copyOne(p, destDir)
    })
  })

  ipcMain.handle('fs:move', async (_e, paths: string[], destDir: string): Promise<OpResult> => {
    if (typeof destDir !== 'string' || !(await stat(destDir).catch(() => null))?.isDirectory())
      return fail('not a directory')
    return eachPath(paths, (p) => {
      if (isUnder(destDir, p)) throw new Error(`cannot move "${basename(p)}" into itself`)
      return moveOne(p, destDir)
    })
  })

  ipcMain.handle('fs:exists', (_e, p: string) => (typeof p === 'string' ? exists(p) : false))

  ipcMain.on('fs:reveal', (_e, p: string) => {
    if (typeof p === 'string' && exists(p)) shell.showItemInFolder(p)
  })
}

function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/')
}
