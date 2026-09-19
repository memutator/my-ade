import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { create } from 'zustand'
import { ChevronRight, File, Folder } from 'lucide-react'
import type { DirEntry } from '../types'
import { CtxMenu, type CtxItem } from './Menu'
import { useStore } from '../store'
import { useT } from '../i18n'
import { useFileIcon } from '../fileIcons'
import {
  basename,
  dirname,
  isHtml,
  isUnder,
  joinPath,
  fileUrl,
  DND_MIME
} from '../features/files/paths'
import {
  createEntry,
  duplicatePaths,
  movePaths,
  copyPaths,
  renamePath,
  trashPaths,
  type FileOpSink
} from '../features/files/operations'
import { useTreeState } from '../features/files/treeState'

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
  onRowDoubleClick: (entry: DirEntry) => void
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
        onDoubleClick={() => ctx.onRowDoubleClick(entry)}
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
  apiRef,
  onOpenFile
}: {
  rootPath: string
  apiRef?: RefObject<FileTreeApi | null>
  // where file activations go — defaults to the store's focused/first editor
  // pane; detached windows pass a callback that opens into their own pane.
  // permanent=true pins the tab (double-click); default is a preview tab
  onOpenFile?: (path: string, name: string, permanent?: boolean) => void
}): React.JSX.Element {
  const t = useT()
  const clip = useTreeClip()
  const openFile = useCallback(
    (path: string, name: string, permanent = false): void => {
      if (onOpenFile) onOpenFile(path, name, permanent)
      else useStore.getState().openFile(path, name, undefined, !permanent)
    },
    [onOpenFile]
  )
  const [renaming, setRenaming] = useState<string | null>(null)
  const [creating, setCreating] = useState<{ dir: string; kind: 'file' | 'dir' } | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string[] | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const tree = useTreeState(rootPath)
  const {
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
  } = tree

  const flash = useCallback((msg: string): void => {
    setStatus(msg)
    if (statusTimer.current) clearTimeout(statusTimer.current)
    statusTimer.current = setTimeout(() => setStatus(null), 4000)
  }, [])

  // the ops layer reconciles the shell (open tabs) and the tree (expansion,
  // selection) after every mutation — one sink, built once per tree
  const sink: FileOpSink = useMemo(
    () => ({ flash, refreshAll, remapPaths, pruneUnder }),
    [flash, refreshAll, remapPaths, pruneUnder]
  )

  /* ops */

  const doTrash = useCallback((paths: string[]): void => void trashPaths(sink, paths), [sink])

  const doCopy = useCallback(
    (paths: string[], destDir: string): void => void copyPaths(sink, paths, destDir),
    [sink]
  )

  const doDuplicate = useCallback(
    (paths: string[]): void => void duplicatePaths(sink, paths),
    [sink]
  )

  const doMove = useCallback(
    (paths: string[], destDir: string): void => void movePaths(sink, paths, destDir),
    [sink]
  )

  const doPaste = useCallback(
    async (destDir: string): Promise<void> => {
      const c = useTreeClip.getState()
      if (!c.paths.length) return
      if (c.cut) {
        useTreeClip.setState({ paths: [], cut: false })
        await movePaths(sink, c.paths, destDir)
      } else {
        await copyPaths(sink, c.paths, destDir)
      }
    },
    [sink]
  )

  const commitRename = useCallback(
    async (entry: DirEntry, name: string): Promise<void> => {
      setRenaming(null)
      const newName = name.trim()
      if (!newName || newName === entry.name) return
      const newPath = joinPath(dirname(entry.path), newName)
      const landed = await renamePath(sink, entry.path, newPath)
      if (!landed) return
      setSelected(new Set([landed]))
      setFocused(landed)
      setAnchor(landed)
      void reload(dirname(entry.path))
    },
    [sink, reload, setSelected, setFocused, setAnchor]
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
      const path = await createEntry(sink, c.dir, nm, c.kind)
      if (!path) return
      void reload(c.dir)
      setSelected(new Set([path]))
      setFocused(path)
      setAnchor(path)
      // a freshly created file opens pinned — the user means to edit it
      if (c.kind === 'file') openFile(path, nm, true)
    },
    [creating, sink, reload, openFile, setSelected, setFocused, setAnchor]
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
    [anchor, selected, rangeSel, setSelected, setFocused, setAnchor]
  )

  const onRowClick = useCallback(
    (e: ReactMouseEvent, entry: DirEntry): void => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) return
      if (entry.isDir) setDirOpen(entry.path, !open.has(entry.path))
      else openFile(entry.path, entry.name)
    },
    [open, setDirOpen, openFile]
  )

  // double-click pins the file open permanently (VS Code preview semantics)
  const onRowDoubleClick = useCallback(
    (entry: DirEntry): void => {
      if (!entry.isDir) openFile(entry.path, entry.name, true)
    },
    [openFile]
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
    [selected, setSelected, setFocused, setAnchor]
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
    [selected, setSelected, setFocused, setAnchor]
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
            else openFile(cur.entry.path, cur.entry.name)
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
      cancelEdit,
      openFile,
      setSelected,
      setFocused,
      setAnchor
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
      { label: t('reveal'), act: () => window.mahas.fs.reveal(p) }
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
              act: () => openFile(entry.path, entry.name)
            },
            ...(isHtml(entry.name)
              ? [
                  {
                    label: t('openInBrowser'),
                    act: () =>
                      useStore.getState().openUrlInBrowser(fileUrl(entry.path), undefined, true)
                  }
                ]
              : [])
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
    refreshAll,
    openFile
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
    onRowDoubleClick,
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
        {menu && <CtxMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      </div>
    </Ctx.Provider>
  )
}
