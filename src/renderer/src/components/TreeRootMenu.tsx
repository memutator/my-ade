import type { ReactNode } from 'react'
import { ChevronDown, Folder, FolderOpen } from 'lucide-react'
import { useStore } from '../store'
import { useT } from '../i18n'
import { Dropdown } from './Menu'
import { withNativeDialog } from '../nativeDialog'

// Shared "change tree root" dropdown for every FileTree host (sidebar, peek
// overlay, editor-pane tree, detached window). Items: recently-picked roots
// first (MRU via pushTreeRoot), then projects not already listed, then a
// browse item that opens the native dir picker. With no recents the list is
// just the other projects in registry order.
export default function TreeRootMenu({
  root,
  onPick,
  label,
  className
}: {
  /** currently shown root — excluded from the items */
  root: string
  onPick: (path: string) => void
  /** trigger face — usually the root's name or path */
  label: ReactNode
  className?: string
}): React.JSX.Element {
  const recents = useStore((s) => s.treeRoots)
  const projects = useStore((s) => s.projects)
  const pushTreeRoot = useStore((s) => s.pushTreeRoot)
  const t = useT()

  const pick = (p: string): void => {
    pushTreeRoot(p)
    if (p !== root) onPick(p)
  }
  const browse = async (): Promise<void> => {
    const p = await withNativeDialog(window.mahas.fs.pickDirectory())
    if (p) pick(p)
  }

  const projName = (path: string): string =>
    projects.find((x) => x.path === path)?.name ?? basename(path)
  const recentPaths = recents.filter((p) => p !== root)
  const otherProjects = projects.filter((p) => p.path !== root && !recents.includes(p.path))

  const item = (path: string, name: string): React.JSX.Element => (
    <button key={path} className="pact-item root-item" onClick={() => pick(path)}>
      <Folder />
      <span className="root-name">{name}</span>
      <span className="root-path">{path}</span>
    </button>
  )

  return (
    <Dropdown
      mode="click"
      align="start"
      panelClassName="pact-card rootmenu"
      trigger={
        <button className={`rootpick${className ? ` ${className}` : ''}`}>
          <span className="rp-label">{label}</span>
          <ChevronDown />
        </button>
      }
    >
      {recentPaths.map((p) => item(p, projName(p)))}
      {otherProjects.map((p) => item(p.path, p.name))}
      {(recentPaths.length > 0 || otherProjects.length > 0) && <div className="ctx-sep" />}
      <button className="pact-item" onClick={() => void browse()}>
        <FolderOpen />
        {t('chooseDir')}
      </button>
    </Dropdown>
  )
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1) || p
}
