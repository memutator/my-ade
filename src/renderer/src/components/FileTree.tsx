import { useEffect, useState } from 'react'
import { ChevronRight, File, Folder } from 'lucide-react'
import type { DirEntry } from '../types'
import { useStore } from '../store'
import { useFileIcon } from '../fileIcons'

function TreeNode({ entry, depth }: { entry: DirEntry; depth: number }): React.JSX.Element {
  const openFileInEditor = useStore((s) => s.openFileInEditor)
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<DirEntry[] | null>(null)
  const hidden = entry.name.startsWith('.')
  const iconUrl = useFileIcon(entry.name, entry.isDir, open)

  const toggle = async (): Promise<void> => {
    if (!entry.isDir) {
      openFileInEditor(entry.path, entry.name)
      return
    }
    if (!open && children === null) setChildren(await window.ade.fs.list(entry.path))
    setOpen(!open)
  }

  const Fallback = entry.isDir ? Folder : File
  return (
    <>
      <div
        className={`tnode${hidden ? ' dim' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={toggle}
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
        <span className="tname">{entry.name}</span>
      </div>
      {open && children?.map((c) => <TreeNode key={c.path} entry={c} depth={depth + 1} />)}
    </>
  )
}

export default function FileTree({ rootPath }: { rootPath: string }): React.JSX.Element {
  const [entries, setEntries] = useState<DirEntry[] | null>(null)

  useEffect(() => {
    let on = true
    window.ade.fs.list(rootPath).then((e) => on && setEntries(e))
    return () => {
      on = false
    }
  }, [rootPath])

  return (
    <div className="filetree">
      {entries === null ? (
        <div className="tree-status">loading…</div>
      ) : entries.length === 0 ? (
        <div className="tree-status">empty</div>
      ) : (
        entries.map((e) => <TreeNode key={e.path} entry={e} depth={0} />)
      )}
    </div>
  )
}
