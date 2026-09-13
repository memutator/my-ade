import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { create } from 'zustand'
import { createPortal } from 'react-dom'
import { ChevronRight, File, Folder } from 'lucide-react'
import type { DirEntry } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import { useFileIcon } from '../fileIcons'

// posix path helpers — ade only ever runs on this linux box
const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const dirname = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/'
const joinPath = (d: string, n: string): string => (d.endsWith('/') ? d : d + '/') + n
const isUnder = (p: string, dir: string): boolean =>
  p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/')

const DND_MIME = 'application/x-ade-paths'

// clipboard shared by every FileTree instance (sidebar + hover overlay), like
// VS Code's global explorer clipboard. Not persisted.
const useTreeClip = create<{ paths: string[]; cut: boolean }>(() => ({ paths: [], cut: false }))

export interface FileTreeApi {
  newFile: () => void
  newFolder: () => void
  refresh: () => void
  collapseAll: () => void
}

interface MenuState {
  x: number
  y: number
  /** null = right-click on the tree background (root-level ops) */
  entry: DirEntry | null
}

type CtxItem =
  | { sep: true }
  | {
      sep?: false
      label: string
      hint?: string
      danger?: boolean
      disabled?: boolean
      act?: () => void
    }

interface TreeCtx {
  rootPath: string
  dirs: Record<string, DirEntry[]>
  open: Set<string>
  selected: Set<string>
  focused: string | null
  renaming: string | null
  creating: { dir: string; kind: 'file' | 'dir' } | null
  dropTarget: string | null
  rowEls: Map<string, HTMLElement>
  isCut: (p: string) => boolean
  onRowMouseDown: (e: ReactMouseEvent, entry: DirEntry) => void
  onRowClick: (e: ReactMouseEvent, entry: DirEntry) => void
  onRowContextMenu: (e: ReactMouseEvent, entry: DirEntry) => void
  onRowDragStart: (e: ReactDragEvent, entry: DirEntry) => void
  onRowDragOver: (e: ReactDragEvent, entry: DirEntry) => void
  onRowDrop: (e: ReactDragEvent, entry: DirEntry) => void
  onDragEnd: () => void
  commitRename: (entry: DirEntry, name: string) => void
  cancelEdit: () => void
  commitCreate: (name: string) => void
}

const Ctx = createContext<TreeCtx | null>(null)
const useCtx = (): TreeCtx => useContext(Ctx)!

/* ── inline name input (rename / new file / new folder) ── */

function NameInput({
  initial,
  isDir,
  onCommit,
  onCancel
}: {
  initial: string
  isDir: boolean
  onCommit: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // select the stem so typing a new name keeps the extension (VS Code)
    const dot = initial.lastIndexOf('.')
    el.setSelectionRange(0, !isDir && dot > 0 ? dot : initial.length)
  }, [initial, isDir])

  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(ref.current?.value ?? '')
    else onCancel()
  }

  return (
    <input
      ref={ref}
      className="tinput"
      defaultValue={initial}
      spellCheck={false}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    />
  )
}

/* ── right-click menu (portaled — never clipped by the scroll area) ── */

function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: CtxItem[]
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.min(x, window.innerWidth - r.width - 4),
      top: Math.min(y, window.innerHeight - r.height - 4)
    })
  }, [x, y])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <>
      {/* a focused <webview> swallows real clicks — the catcher is what closes
          the menu there (same trick as the workspace dropdown) */}
      <div
        className="click-catcher"
        style={{ zIndex: 91 }}
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div ref={ref} className="ctxmenu" style={pos}>
        {items.map((it, i) =>
          it.sep ? (
            <div key={i} className="ctx-sep" />
          ) : (
            <button
              key={i}
              className={`ctx-item${it.danger ? ' danger' : ''}`}
              disabled={it.disabled}
              onClick={() => {
                onClose()
                it.act?.()
              }}
            >
              <span>{it.label}</span>
              {it.hint && <kbd>{it.hint}</kbd>}
            </button>
          )
        )}
      </div>
    </>,
    document.body
  )
}

/* ── tree row ── */

function TreeNode({ entry, depth }: { entry: DirEntry; depth: number }): React.JSX.Element {
  const ctx = useCtx()
  const open = ctx.open.has(entry.path)
  const children = ctx.dirs[entry.path]
  const hidden = entry.name.startsWith('.')
  const iconUrl = useFileIcon(entry.name, entry.isDir, open)
  const isRenaming = ctx.renaming === entry.path

  const cls =
    `tnode${hidden ? ' dim' : ''}` +
    `${ctx.selected.has(entry.path) ? ' sel' : ''}` +
    `${ctx.focused === entry.path ? ' kb' : ''}` +
    `${ctx.isCut(entry.path) ? ' cut' : ''}` +
    `${ctx.dropTarget === entry.path ? ' drop' : ''}`

  const Fallback = entry.isDir ? Folder : File
  return (
    <>
      <div
        className={cls}
        style={{ paddingLeft: 8 + depth * 14 }}
        ref={(el) => {
          if (el) ctx.rowEls.set(entry.path, el)
          else ctx.rowEls.delete(entry.path)
        }}
        onMouseDown={(e) => ctx.onRowMouseDown(e, entry)}
        onClick={(e) => ctx.onRowClick(e, entry)}
        onContextMenu={(e) => ctx.onRowContextMenu(e, entry)}
        draggable={!isRenaming}
        onDragStart={(e) => ctx.onRowDragStart(e, entry)}
        onDragOver={(e) => ctx.onRowDragOver(e, entry)}
        onDrop={(e) => ctx.onRowDrop(e, entry)}
        onDragEnd={ctx.onDragEnd}
      >
        {entry.isDir ? (
          <ChevronRight size={11} className={`tchev${open ? ' open' : ''}`} />
        ) : (
          <span className="tchev" />
        )}
        {iconUrl ? (
          <img src={iconUrl} className="ticon-img" draggable={false} alt="" />
        ) : (
          <Fallback size={12} className="ticon" />
        )}
        {isRenaming ? (
          <NameInput
            initial={entry.name}
            isDir={entry.isDir}
            onCommit={(name) => ctx.commitRename(entry, name)}
            onCancel={ctx.cancelEdit}
          />
        ) : (
          <span className="tname">{entry.name}</span>
        )}
      </div>
      {open && ctx.creating?.dir === entry.path && <CreateRow depth={depth + 1} />}
      {open && children?.map((c) => <TreeNode key={c.path} entry={c} depth={depth + 1} />)}
    </>
  )
}

function CreateRow({ depth }: { depth: number }): React.JSX.Element {
  const ctx = useCtx()
  const kind = ctx.creating?.kind ?? 'file'
  const iconUrl = useFileIcon(kind === 'dir' ? 'folder' : 'file', kind === 'dir')
  const Fallback = kind === 'dir' ? Folder : File
  return (
    <div className="tnode creating" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="tchev" />
      {iconUrl ? (
        <img src={iconUrl} className="ticon-img" draggable={false} alt="" />
      ) : (
        <Fallback size={12} className="ticon" />
      )}
      <NameInput
        initial=""
        isDir={kind === 'dir'}
        onCommit={ctx.commitCreate}
        onCancel={ctx.cancelEdit}
      />
    </div>
  )
}

/* ── the tree ── */

export default function FileTree({
  rootPath,
  apiRef
}: {
  rootPath: string
  apiRef?: RefObject<FileTreeApi | null>
}): React.JSX.Element {
  const t = useT()
  const clip = useTreeClip()
  const [dirs, setDirs] = useState<Record<string, DirEntry[]>>({})
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focused, setFocused] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [creating, setCreating] = useState<{ dir: string; kind: 'file' | 'dir' } | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string[] | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const dirsRef = useRef(dirs)
  // stable identity, not a ref — TreeNode ref callbacks register row elements
  // here so keyboard nav can scrollIntoView
  const [rowEls] = useState(() => new Map<string, HTMLElement>())
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const watchedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    dirsRef.current = dirs
  }, [dirs])

  const flash = useCallback((msg: string): void => {
    setStatus(msg)
    if (statusTimer.current) clearTimeout(statusTimer.current)
    statusTimer.current = setTimeout(() => setStatus(null), 4000)
  }, [])

  const reload = useCallback(async (dir: string): Promise<void> => {
    const entries = await window.ade.fs.list(dir)
    setDirs((d) => ({ ...d, [dir]: entries }))
  }, [])

  const refreshAll = useCallback((): void => {
    for (const d of Object.keys(dirsRef.current)) void reload(d)
  }, [reload])

  /* expansion state + directory watches */

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

  // keep an fs.watch on the root + every expanded dir; main refcounts so the
  // two tree instances can share a path
  useEffect(() => {
    const want = new Set([rootPath, ...open])
    for (const p of want) if (!watchedRef.current.has(p)) void window.ade.dir.watch(p)
    for (const p of watchedRef.current) if (!want.has(p)) void window.ade.dir.unwatch(p)
    watchedRef.current = want
  }, [rootPath, open])

  useEffect(
    () => () => {
      for (const p of watchedRef.current) void window.ade.dir.unwatch(p)
      watchedRef.current = new Set()
    },
    []
  )

  // a watched dir changed on disk → re-list it (only if we actually show it)
  useEffect(
    () =>
      window.ade.dir.onChanged((p) => {
        if (p in dirsRef.current) void reload(p)
      }),
    [reload]
  )

  /* initial load — rootPath changes remount the tree (callers pass key) */

  useEffect(() => {
    let on = true
    void window.ade.fs.list(rootPath).then((e) => on && setDirs((d) => ({ ...d, [rootPath]: e })))
    return () => {
      on = false
    }
  }, [rootPath])

  /* visible row order — needed for shift-range select and arrow navigation */

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

  /* path remap — a renamed/moved dir keeps its expansion + selection */

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

  // drop deleted paths (and everything under them) from expansion/selection
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

  /* ops */

  const doTrash = useCallback(
    async (paths: string[]): Promise<void> => {
      if (!paths.length) return
      const r = await window.ade.fs.trash(paths)
      if (!r.ok) {
        flash(r.error ?? 'delete failed')
        if (!r.paths?.length) return
      }
      const done = r.paths?.length ? r.paths : paths
      useStore.getState().closeFilesUnder(done)
      pruneUnder(done)
      refreshAll()
    },
    [flash, pruneUnder, refreshAll]
  )

  const doCopy = useCallback(
    async (paths: string[], destDir: string): Promise<void> => {
      const r = await window.ade.fs.copy(paths, destDir)
      if (!r.ok) flash(r.error ?? 'copy failed')
      refreshAll()
    },
    [flash, refreshAll]
  )

  // duplicate = copy each item next to itself (mixed parents are fine)
  const doDuplicate = useCallback(
    async (paths: string[]): Promise<void> => {
      for (const p of paths) {
        const r = await window.ade.fs.copy([p], dirname(p))
        if (!r.ok) flash(r.error ?? 'duplicate failed')
      }
      refreshAll()
    },
    [flash, refreshAll]
  )

  const doMove = useCallback(
    async (paths: string[], destDir: string): Promise<void> => {
      const r = await window.ade.fs.move(paths, destDir)
      if (!r.ok) flash(r.error ?? 'move failed')
      // remap open-editor tabs + tree state for each source that landed under a new path
      paths.forEach((p, i) => {
        const np = r.paths?.[i]
        if (np && np !== p) {
          remapPaths(p, np)
          useStore.getState().remapOpenFile(p, np)
        }
      })
      refreshAll()
    },
    [flash, remapPaths, refreshAll]
  )

  const doPaste = useCallback(
    async (destDir: string): Promise<void> => {
      const c = useTreeClip.getState()
      if (!c.paths.length) return
      if (c.cut) {
        useTreeClip.setState({ paths: [], cut: false })
        await doMove(c.paths, destDir)
      } else {
        await doCopy(c.paths, destDir)
      }
    },
    [doCopy, doMove]
  )

  const commitRename = useCallback(
    async (entry: DirEntry, name: string): Promise<void> => {
      setRenaming(null)
      const newName = name.trim()
      if (!newName || newName === entry.name) return
      const dir = dirname(entry.path)
      const newPath = joinPath(dir, newName)
      const r = await window.ade.fs.rename(entry.path, newPath)
      if (!r.ok) {
        flash(r.error ?? 'rename failed')
        return
      }
      remapPaths(entry.path, newPath)
      useStore.getState().remapOpenFile(entry.path, newPath)
      setSelected(new Set([newPath]))
      setFocused(newPath)
      setAnchor(newPath)
      void reload(dir)
    },
    [flash, remapPaths, reload]
  )

  const startCreate = useCallback(
    (dir: string, kind: 'file' | 'dir'): void => {
      setCreating({ dir, kind })
      if (dir !== rootPath) setDirOpen(dir, true)
    },
    [rootPath, setDirOpen]
  )

  const commitCreate = useCallback(
    async (name: string): Promise<void> => {
      const c = creating
      setCreating(null)
      if (!c) return
      const nm = name.trim()
      if (!nm) return
      const r = await window.ade.fs.create(c.dir, nm, c.kind)
      if (!r.ok || !r.path) {
        flash(r.error ?? 'create failed')
        return
      }
      void reload(c.dir)
      setSelected(new Set([r.path]))
      setFocused(r.path)
      setAnchor(r.path)
      if (c.kind === 'file') useStore.getState().openFileInEditor(r.path, nm)
    },
    [creating, flash, reload]
  )

  const cancelEdit = useCallback((): void => {
    setRenaming(null)
    setCreating(null)
  }, [])

  // where new files / paste land for a given (or the focused) entry
  const targetDirFor = useCallback(
    (entry: DirEntry | null): string =>
      entry ? (entry.isDir ? entry.path : dirname(entry.path)) : rootPath,
    [rootPath]
  )

  /* row interaction */

  const onRowMouseDown = useCallback(
    (e: ReactMouseEvent, entry: DirEntry): void => {
      if (e.button === 2) {
        // right-click inside the selection keeps it; outside reselects
        if (!selected.has(entry.path)) {
          setSelected(new Set([entry.path]))
          setAnchor(entry.path)
          setFocused(entry.path)
        }
        return
      }
      if (e.button !== 0) return
      if (e.shiftKey && anchor) {
        const r = rangeSel(anchor, entry.path)
        setSelected(e.ctrlKey || e.metaKey ? new Set([...selected, ...r]) : r)
      } else if (e.ctrlKey || e.metaKey) {
        const n = new Set(selected)
        if (n.has(entry.path)) n.delete(entry.path)
        else n.add(entry.path)
        setSelected(n)
        setAnchor(entry.path)
      } else {
        setSelected(new Set([entry.path]))
        setAnchor(entry.path)
      }
      setFocused(entry.path)
    },
    [anchor, selected, rangeSel]
  )

  const onRowClick = useCallback(
    (e: ReactMouseEvent, entry: DirEntry): void => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) return
      if (entry.isDir) setDirOpen(entry.path, !open.has(entry.path))
      else useStore.getState().openFileInEditor(entry.path, entry.name)
    },
    [open, setDirOpen]
  )

  const onRowContextMenu = useCallback(
    (e: ReactMouseEvent, entry: DirEntry): void => {
      e.preventDefault()
      e.stopPropagation()
      if (!selected.has(entry.path)) {
        setSelected(new Set([entry.path]))
        setFocused(entry.path)
        setAnchor(entry.path)
      }
      setMenu({ x: e.clientX, y: e.clientY, entry })
    },
    [selected]
  )

  /* drag & drop — move (or Ctrl+copy) into folders, same MIME gates bg drops */

  const onRowDragStart = useCallback(
    (e: ReactDragEvent, entry: DirEntry): void => {
      let paths = [...selected]
      if (!selected.has(entry.path)) {
        paths = [entry.path]
        setSelected(new Set([entry.path]))
        setFocused(entry.path)
        setAnchor(entry.path)
      }
      setDragging(paths)
      e.dataTransfer.setData(DND_MIME, JSON.stringify(paths))
      e.dataTransfer.effectAllowed = 'copyMove'
    },
    [selected]
  )

  const onRowDragOver = useCallback(
    (e: ReactDragEvent, entry: DirEntry): void => {
      if (!dragging || !e.dataTransfer.types.includes(DND_MIME)) return
      const dir = entry.isDir ? entry.path : dirname(entry.path)
      // can't drop a folder into itself or its own subtree
      if (dragging.some((p) => isUnder(dir, p))) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'
      setDropTarget(entry.isDir ? entry.path : dir)
    },
    [dragging]
  )

  const onRowDrop = useCallback(
    (e: ReactDragEvent, entry: DirEntry): void => {
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(null)
      setDragging(null)
      if (!e.dataTransfer.types.includes(DND_MIME)) return
      const dir = entry.isDir ? entry.path : dirname(entry.path)
      let paths: string[] = []
      try {
        paths = JSON.parse(e.dataTransfer.getData(DND_MIME))
      } catch {
        return
      }
      if (!paths.length || paths.some((p) => isUnder(dir, p))) return
      void (e.ctrlKey ? doCopy(paths, dir) : doMove(paths, dir))
    },
    [doCopy, doMove]
  )

  const onDragEnd = useCallback((): void => {
    setDragging(null)
    setDropTarget(null)
  }, [])

  /* keyboard */

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent): void => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (menu) {
        if (e.key === 'Escape') setMenu(null)
        return
      }
      const idx = flat.findIndex((f) => f.entry.path === focused)
      const cur = idx >= 0 ? flat[idx] : null
      let handled = true

      const moveTo = (ni: number, extend: boolean): void => {
        const f = flat[ni]
        if (!f) return
        setFocused(f.entry.path)
        if (extend && anchor) setSelected(rangeSel(anchor, f.entry.path))
        else {
          setSelected(new Set([f.entry.path]))
          setAnchor(f.entry.path)
        }
      }

      switch (e.key) {
        case 'ArrowDown':
          moveTo(idx < 0 ? 0 : Math.min(flat.length - 1, idx + 1), e.shiftKey)
          break
        case 'ArrowUp':
          moveTo(idx < 0 ? flat.length - 1 : Math.max(0, idx - 1), e.shiftKey)
          break
        case 'Home':
          moveTo(0, e.shiftKey)
          break
        case 'End':
          moveTo(flat.length - 1, e.shiftKey)
          break
        case 'ArrowRight':
          if (cur?.entry.isDir && !open.has(cur.entry.path)) setDirOpen(cur.entry.path, true)
          else if (cur?.entry.isDir && dirs[cur.entry.path]?.length) moveTo(idx + 1, e.shiftKey)
          else handled = false
          break
        case 'ArrowLeft': {
          if (cur?.entry.isDir && open.has(cur.entry.path)) {
            setDirOpen(cur.entry.path, false)
          } else if (cur) {
            const p = dirname(cur.entry.path)
            if (flat.some((f) => f.entry.path === p)) {
              setFocused(p)
              setSelected(new Set([p]))
              setAnchor(p)
            }
          } else handled = false
          break
        }
        case 'Enter':
          if (cur) {
            if (cur.entry.isDir) setDirOpen(cur.entry.path, !open.has(cur.entry.path))
            else useStore.getState().openFileInEditor(cur.entry.path, cur.entry.name)
          } else handled = false
          break
        case 'F2':
          if (cur) setRenaming(cur.entry.path)
          else handled = false
          break
        case 'Delete':
          if (selected.size) void doTrash([...selected])
          else handled = false
          break
        case 'Escape':
          if (renaming || creating) cancelEdit()
          else {
            setSelected(focused ? new Set([focused]) : new Set())
            setAnchor(focused)
          }
          break
        default: {
          const k = e.key.toLowerCase()
          if ((e.ctrlKey || e.metaKey) && k === 'a') {
            setSelected(new Set(flat.map((f) => f.entry.path)))
          } else if ((e.ctrlKey || e.metaKey) && (k === 'c' || k === 'x')) {
            if (selected.size) useTreeClip.setState({ paths: [...selected], cut: k === 'x' })
            else handled = false
          } else if ((e.ctrlKey || e.metaKey) && k === 'v') {
            if (useTreeClip.getState().paths.length) void doPaste(targetDirFor(cur?.entry ?? null))
            else handled = false
          } else handled = false
        }
      }
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    [
      menu,
      flat,
      focused,
      anchor,
      open,
      dirs,
      selected,
      renaming,
      creating,
      rangeSel,
      setDirOpen,
      doTrash,
      doPaste,
      targetDirFor,
      cancelEdit
    ]
  )

  /* context menu contents */

  const menuItems = useMemo((): CtxItem[] => {
    const entry = menu?.entry ?? null
    const sel = [...selected]
    const target = targetDirFor(entry)
    const clipEmpty = clip.paths.length === 0
    const rel = (p: string): string => (p === rootPath ? basename(p) : p.slice(rootPath.length + 1))

    const newItems: CtxItem[] = [
      { label: t('newFile'), act: () => startCreate(target, 'file') },
      { label: t('newFolder'), act: () => startCreate(target, 'dir') }
    ]
    const pathItems = (p: string): CtxItem[] => [
      { label: t('copyPath'), act: () => void navigator.clipboard.writeText(p) },
      { label: t('copyRelPath'), act: () => void navigator.clipboard.writeText(rel(p)) },
      { label: t('reveal'), act: () => window.ade.fs.reveal(p) }
    ]

    if (!entry) {
      return [
        ...newItems,
        { sep: true },
        {
          label: t('paste'),
          hint: 'Ctrl+V',
          disabled: clipEmpty,
          act: () => void doPaste(rootPath)
        },
        { sep: true },
        ...pathItems(rootPath),
        { sep: true },
        { label: t('refresh'), act: refreshAll }
      ]
    }

    return [
      ...(entry.isDir
        ? []
        : [
            {
              label: t('open'),
              act: () => useStore.getState().openFileInEditor(entry.path, entry.name)
            }
          ]),
      ...newItems,
      { sep: true },
      {
        label: t('cut'),
        hint: 'Ctrl+X',
        act: () => useTreeClip.setState({ paths: sel, cut: true })
      },
      {
        label: t('copy'),
        hint: 'Ctrl+C',
        act: () => useTreeClip.setState({ paths: sel, cut: false })
      },
      { label: t('paste'), hint: 'Ctrl+V', disabled: clipEmpty, act: () => void doPaste(target) },
      {
        label: t('duplicate'),
        act: () => void doDuplicate(sel)
      },
      { sep: true },
      {
        label: t('rename'),
        hint: 'F2',
        disabled: sel.length > 1,
        act: () => setRenaming(entry.path)
      },
      { label: t('delete'), hint: 'Del', danger: true, act: () => void doTrash(sel) },
      { sep: true },
      ...pathItems(entry.path)
    ]
  }, [
    menu,
    selected,
    clip.paths,
    targetDirFor,
    rootPath,
    t,
    startCreate,
    doPaste,
    doDuplicate,
    doTrash,
    refreshAll
  ])

  /* imperative api for the sidebar header icons */

  useEffect(() => {
    if (!apiRef) return
    apiRef.current = {
      newFile: () => startCreate(targetDirFor(focusedEntry), 'file'),
      newFolder: () => startCreate(targetDirFor(focusedEntry), 'dir'),
      refresh: refreshAll,
      collapseAll: () => setOpen(new Set())
    }
    return () => {
      apiRef.current = null
    }
  })

  /* render */

  const entries = dirs[rootPath]
  const ctx: TreeCtx = {
    rootPath,
    dirs,
    open,
    selected,
    focused,
    renaming,
    creating,
    dropTarget,
    rowEls,
    isCut: (p) => clip.cut && clip.paths.includes(p),
    onRowMouseDown,
    onRowClick,
    onRowContextMenu,
    onRowDragStart,
    onRowDragOver,
    onRowDrop,
    onDragEnd,
    commitRename: (e2, name) => void commitRename(e2, name),
    cancelEdit,
    commitCreate: (name) => void commitCreate(name)
  }

  return (
    <Ctx.Provider value={ctx}>
      <div
        className={`filetree${dropTarget === rootPath ? ' drop' : ''}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && e.button === 0) {
            setSelected(new Set())
            setFocused(null)
            setAnchor(null)
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, entry: null })
        }}
        onDragOver={(e) => {
          if (!dragging || !e.dataTransfer.types.includes(DND_MIME)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'
          setDropTarget(rootPath)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDropTarget(null)
          setDragging(null)
          if (!e.dataTransfer.types.includes(DND_MIME)) return
          let paths: string[] = []
          try {
            paths = JSON.parse(e.dataTransfer.getData(DND_MIME))
          } catch {
            return
          }
          if (!paths.length) return
          void (e.ctrlKey ? doCopy(paths, rootPath) : doMove(paths, rootPath))
        }}
        onDragLeave={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node))
            setDropTarget(null)
        }}
      >
        {entries === undefined ? (
          <div className="tree-status">{t('loading')}</div>
        ) : (
          <>
            {creating?.dir === rootPath && <CreateRow depth={0} />}
            {entries.length === 0 && !creating ? (
              <div className="tree-status">{t('empty')}</div>
            ) : (
              entries.map((e) => <TreeNode key={e.path} entry={e} depth={0} />)
            )}
          </>
        )}
        {status && <div className="tree-status error">{status}</div>}
        {menu && (
          <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
        )}
      </div>
    </Ctx.Provider>
  )
}
