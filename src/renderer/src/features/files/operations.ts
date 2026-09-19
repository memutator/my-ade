// mahas files — file-tree operations.
//
// Every mutating tree action is the same shape: call main, report failure,
// then reconcile what the shell already knows about the affected paths. The
// reconciliation is the part worth having in one place — a rename or move
// must remap open editor tabs (store.remapOpenFile) and the tree's own
// expansion/selection state, and a delete must close file tabs under the dead
// paths (store.closeFilesUnder). Doing that ad hoc at each call site is how
// a renamed directory ends up with tabs pointing at a path that no longer
// exists.
//
// These are plain functions over an injected sink, not hooks: they are called
// from menu items, keyboard handlers and drop handlers, none of which want a
// second React state machine.

import { useStore } from '../../store'
import { dirname } from './paths'

/** What an operation needs from the view that invoked it. */
export interface FileOpSink {
  /** show a transient failure message in the tree */
  flash: (msg: string) => void
  /** re-list every directory the tree currently shows */
  refreshAll: () => void
  /** rewrite tree expansion/selection after a path moved */
  remapPaths: (oldPath: string, newPath: string) => void
  /** drop deleted paths from tree expansion/selection */
  pruneUnder: (paths: string[]) => void
}

/** Delete (move to trash). Closes editor tabs under the dead paths, prunes
 *  tree state, and re-lists — partial failures still reconcile the paths that
 *  did land, because the tree would otherwise show files that are gone. */
export async function trashPaths(sink: FileOpSink, paths: string[]): Promise<void> {
  if (!paths.length) return
  const r = await window.mahas.fs.trash(paths)
  if (!r.ok) {
    sink.flash(r.error ?? 'delete failed')
    if (!r.paths?.length) return
  }
  const done = r.paths?.length ? r.paths : paths
  useStore.getState().closeFilesUnder(done)
  sink.pruneUnder(done)
  sink.refreshAll()
}

/** Copy into `destDir`. Open tabs are untouched — a copy is a new path. */
export async function copyPaths(sink: FileOpSink, paths: string[], destDir: string): Promise<void> {
  const r = await window.mahas.fs.copy(paths, destDir)
  if (!r.ok) sink.flash(r.error ?? 'copy failed')
  sink.refreshAll()
}

/** Duplicate = copy each item next to itself (mixed parents are fine). */
export async function duplicatePaths(sink: FileOpSink, paths: string[]): Promise<void> {
  for (const p of paths) {
    const r = await window.mahas.fs.copy([p], dirname(p))
    if (!r.ok) sink.flash(r.error ?? 'duplicate failed')
  }
  sink.refreshAll()
}

/** Move into `destDir`, remapping open editor tabs and tree state for each
 *  source that actually landed under a new path. */
export async function movePaths(sink: FileOpSink, paths: string[], destDir: string): Promise<void> {
  const r = await window.mahas.fs.move(paths, destDir)
  if (!r.ok) sink.flash(r.error ?? 'move failed')
  paths.forEach((p, i) => {
    const np = r.paths?.[i]
    if (np && np !== p) {
      sink.remapPaths(p, np)
      useStore.getState().remapOpenFile(p, np)
    }
  })
  sink.refreshAll()
}

/** Rename in place. Returns the new path on success so the caller can move
 *  the tree's focus there, or null when nothing changed. */
export async function renamePath(
  sink: FileOpSink,
  path: string,
  newPath: string
): Promise<string | null> {
  const r = await window.mahas.fs.rename(path, newPath)
  if (!r.ok) {
    sink.flash(r.error ?? 'rename failed')
    return null
  }
  sink.remapPaths(path, newPath)
  useStore.getState().remapOpenFile(path, newPath)
  return newPath
}

/** Create a file/folder inside `dir`. Returns the created path, or null. */
export async function createEntry(
  sink: FileOpSink,
  dir: string,
  name: string,
  kind: 'file' | 'dir'
): Promise<string | null> {
  const r = await window.mahas.fs.create(dir, name, kind)
  if (!r.ok || !r.path) {
    sink.flash(r.error ?? 'create failed')
    return null
  }
  return r.path
}
