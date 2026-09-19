// mahas files — file-tree state.
//
// What a tree instance knows about the filesystem: which directories are
// listed, which are expanded, what is selected/focused, and the fs.watch
// subscriptions that keep the listings honest. The rendering layer reads this
// and the operations layer reconciles it after a mutation; neither owns it.
//
// Watching is refcounted in main, so two trees (sidebar + hover overlay) can
// watch the same path; this hook only tracks what THIS tree wants watched and
// drops the subscriptions on unmount.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DirEntry } from '../../types'
import { isUnder } from './paths'

export interface TreeState {
  dirs: Record<string, DirEntry[]>
  open: Set<string>
  selected: Set<string>
  focused: string | null
  /** selection anchor for shift-range picks */
  anchor: string | null
  /** visible rows in display order — needed for range select + arrow nav */
  flat: { entry: DirEntry; depth: number }[]
  /** the focused entry record, when it is still visible */
  focusedEntry: DirEntry | null
  /** stable map of row elements, for scrollIntoView on keyboard nav */
  rowEls: Map<string, HTMLElement>

  setOpen: React.Dispatch<React.SetStateAction<Set<string>>>
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>
  setFocused: React.Dispatch<React.SetStateAction<string | null>>
  setAnchor: React.Dispatch<React.SetStateAction<string | null>>

  /** expand/collapse a directory; expanding always re-lists (never stale) */
  setDirOpen: (dir: string, v: boolean) => void
  /** re-list one directory */
  reload: (dir: string) => Promise<void>
  /** re-list every directory this tree currently shows */
  refreshAll: () => void
  /** shift-range selection between two visible rows */
  rangeSel: (from: string, to: string) => Set<string>
  /** rewrite expansion/selection after a rename or move */
  remapPaths: (oldPath: string, newPath: string) => void
  /** drop deleted paths (and their subtrees) from expansion/selection */
  pruneUnder: (paths: string[]) => void
}

export function useTreeState(rootPath: string): TreeState {
  const [dirs, setDirs] = useState<Record<string, DirEntry[]>>({})
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focused, setFocused] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<string | null>(null)

  const dirsRef = useRef(dirs)
  // stable identity, not a ref — TreeNode ref callbacks register row elements
  // here so keyboard nav can scrollIntoView
  const [rowEls] = useState(() => new Map<string, HTMLElement>())
  const watchedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    dirsRef.current = dirs
  }, [dirs])

  const reload = useCallback(async (dir: string): Promise<void> => {
    const entries = await window.mahas.fs.list(dir)
    setDirs((d) => ({ ...d, [dir]: entries }))
  }, [])

  const refreshAll = useCallback((): void => {
    for (const d of Object.keys(dirsRef.current)) void reload(d)
  }, [reload])

  const setDirOpen = useCallback(
    (dir: string, v: boolean): void => {
      setOpen((prev) => {
        if (prev.has(dir) === v) return prev
        const n = new Set(prev)
        if (v) n.add(dir)
        else n.delete(dir)
        return n
      })
      if (v) void reload(dir) // always re-list on expand — never serve stale children
    },
    [reload]
  )

  /* directory watches — refcounted in main, so two trees can share a path */
  useEffect(() => {
    const want = new Set([rootPath, ...open])
    for (const p of want) if (!watchedRef.current.has(p)) void window.mahas.dir.watch(p)
    for (const p of watchedRef.current) if (!want.has(p)) void window.mahas.dir.unwatch(p)
    watchedRef.current = want
  }, [rootPath, open])

  useEffect(
    () => () => {
      for (const p of watchedRef.current) void window.mahas.dir.unwatch(p)
      watchedRef.current = new Set()
    },
    []
  )

  // a watched dir changed on disk → re-list it (only if we actually show it)
  useEffect(
    () =>
      window.mahas.dir.onChanged((p) => {
        if (p in dirsRef.current) void reload(p)
      }),
    [reload]
  )

  /* initial load — rootPath changes remount the tree (callers pass key) */
  useEffect(() => {
    let on = true
    void window.mahas.fs.list(rootPath).then((e) => on && setDirs((d) => ({ ...d, [rootPath]: e })))
    return () => {
      on = false
    }
  }, [rootPath])

  const flat = useMemo(() => {
    const out: { entry: DirEntry; depth: number }[] = []
    const walk = (dir: string, depth: number): void => {
      for (const e of dirs[dir] ?? []) {
        out.push({ entry: e, depth })
        if (e.isDir && open.has(e.path)) walk(e.path, depth + 1)
      }
    }
    walk(rootPath, 0)
    return out
  }, [dirs, open, rootPath])

  const rangeSel = useCallback(
    (from: string, to: string): Set<string> => {
      const i = flat.findIndex((f) => f.entry.path === from)
      const j = flat.findIndex((f) => f.entry.path === to)
      if (i < 0 || j < 0) return new Set([to])
      const [a, b] = i < j ? [i, j] : [j, i]
      return new Set(flat.slice(a, b + 1).map((f) => f.entry.path))
    },
    [flat]
  )

  const focusedEntry = flat.find((f) => f.entry.path === focused)?.entry ?? null

  useEffect(() => {
    // container:'nearest' — unscoped scrollIntoView walks every scrollable
    // ancestor and can drag the root scroller (overflow:hidden doesn't stop
    // it), sliding the whole app up and pushing the topbar offscreen
    if (focused)
      rowEls.get(focused)?.scrollIntoView({
        block: 'nearest',
        container: 'nearest'
      } as ScrollIntoViewOptions)
  }, [focused, rowEls])

  const remapPaths = useCallback((oldP: string, newP: string): void => {
    const map = (p: string): string =>
      p === oldP ? newP : isUnder(p, oldP) ? newP + p.slice(oldP.length) : p
    const mapSet = (s: Set<string>): Set<string> => new Set([...s].map(map))
    setOpen(mapSet)
    setDirs((d) => {
      const n: Record<string, DirEntry[]> = {}
      for (const [k, v] of Object.entries(d)) n[map(k)] = v
      return n
    })
    setSelected(mapSet)
    setFocused((f) => (f ? map(f) : f))
    setAnchor((a) => (a ? map(a) : a))
  }, [])

  const pruneUnder = useCallback((paths: string[]): void => {
    const gone = (p: string): boolean => paths.some((d) => isUnder(p, d))
    setOpen((o) => new Set([...o].filter((p) => !gone(p))))
    setDirs((d) => {
      const n = { ...d }
      let ch = false
      for (const k of Object.keys(n))
        if (gone(k)) {
          delete n[k]
          ch = true
        }
      return ch ? n : d
    })
    setSelected((s) => new Set([...s].filter((p) => !gone(p))))
    setFocused((f) => (f && gone(f) ? null : f))
    setAnchor((a) => (a && gone(a) ? null : a))
  }, [])

  return {
    dirs,
    open,
    selected,
    focused,
    anchor,
    flat,
    focusedEntry,
    rowEls,
    setOpen,
    setSelected,
    setFocused,
    setAnchor,
    setDirOpen,
    reload,
    refreshAll,
    rangeSel,
    remapPaths,
    pruneUnder
  }
}
