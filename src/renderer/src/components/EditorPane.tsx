import { Code2, FolderOpen } from 'lucide-react'
import type { EditorPaneState } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import { isDetachedWin } from '../detached'
import Tooltip from './Tooltip'
import PaneFrame from './PaneFrame'
import TabStrip, { type TabItem } from './TabStrip'
import FileView from './FileView'
import FileTree from './FileTree'
import TreeRootMenu from './TreeRootMenu'

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1) || p

export default function EditorPane({
  pane,
  wsId
}: {
  pane: EditorPaneState
  wsId: string
}): React.JSX.Element {
  const updatePane = useStore((s) => s.updatePane)
  const closePane = useStore((s) => s.closePane)
  const notify = useStore((s) => s.notify)
  // the pane tree's root is pane-owned, not workspace-owned — it defaults to
  // the project dir and follows the pane through float/detach/dock
  const projectPath = useStore(
    (s) => s.projects.find((p) => p.id === s.workspaces.find((w) => w.id === wsId)?.projectId)?.path
  )
  const treeRoot = pane.treeRoot ?? projectPath ?? '/'
  const t = useT()

  // files always open into THIS pane — the store default would hunt for the
  // focused/first editor, which in a detached window is the wrong store
  const openHere = (path: string, name: string): void => {
    const existing = pane.tabs.find((t) => t.path === path)
    if (existing) {
      updatePane(pane.id, { activeTabId: existing.id }, wsId)
    } else {
      const tab = { id: crypto.randomUUID(), path, name }
      updatePane(pane.id, { tabs: [...pane.tabs, tab], activeTabId: tab.id }, wsId)
    }
  }

  const openDialog = async (): Promise<void> => {
    const p = await window.ade.file.openDialog()
    if (!p) return
    openHere(p, p.split('/').pop() ?? p)
  }

  const tabs: TabItem[] = pane.tabs.map((t) => ({
    id: t.id,
    label: t.name,
    sub: t.path,
    dirty: t.dirty
  }))

  // closing the last tab closes the pane — an editor with nothing open is
  // dead weight. In a detached window the pane record lives in the main
  // store, so the close goes through pane:cmd (which also tears the window
  // down via closeDetached)
  const closeTab = (tabId: string): void => {
    const tabs = pane.tabs.filter((t) => t.id !== tabId)
    if (tabs.length === 0) {
      if (isDetachedWin) window.ade.win.paneCmd({ action: 'closePane', wsId, paneId: pane.id })
      else closePane(pane.id, wsId)
      return
    }
    const activeTabId =
      pane.activeTabId === tabId ? (tabs.at(-1)?.id ?? undefined) : pane.activeTabId
    updatePane(pane.id, { tabs, activeTabId }, wsId)
  }

  const markDirty = (tabId: string, dirty: boolean): void => {
    updatePane(
      pane.id,
      { tabs: pane.tabs.map((t) => (t.id === tabId ? { ...t, dirty: dirty || undefined } : t)) },
      wsId
    )
  }

  const saveFailed = (tabId: string, msg: string): void => {
    const name = pane.tabs.find((x) => x.id === tabId)?.name ?? 'file'
    notify({ workspaceId: wsId, paneId: pane.id, title: t('saveFailed', { name }), body: msg })
  }

  const body = (
    <>
      {pane.tabs.length === 0 ? (
        <div className="file-body">
          <div className="file-empty">
            <span>{t('noFileOpen')}</span>
            <button onClick={openDialog}>{t('openFile')}</button>
          </div>
        </div>
      ) : (
        // every open tab keeps a mounted FileView so unsaved buffers survive tab switches
        pane.tabs.map((t) => (
          <div key={t.id} className="editor-file" hidden={t.id !== pane.activeTabId}>
            <FileView
              path={t.path}
              onDirtyChange={(d) => markDirty(t.id, d)}
              onSaveError={(msg) => saveFailed(t.id, msg)}
            />
          </div>
        ))
      )}
    </>
  )

  return (
    <PaneFrame
      pane={pane}
      wsId={wsId}
      icon={<Code2 className="picon" />}
      gripPeek={
        <>
          <div className="tree-overlay-head">
            <TreeRootMenu
              root={treeRoot}
              onPick={(p) => updatePane(pane.id, { treeRoot: p }, wsId)}
              label={basename(treeRoot)}
            />
          </div>
          <FileTree key={treeRoot} rootPath={treeRoot} onOpenFile={openHere} />
        </>
      }
      title={
        <div className="pane-tabs">
          <TabStrip
            tabs={tabs}
            activeId={pane.activeTabId ?? null}
            onActivate={(id) => updatePane(pane.id, { activeTabId: id }, wsId)}
            onClose={closeTab}
          />
        </div>
      }
      extraActions={
        <Tooltip label={t('openFileTooltip')}>
          <button className="pbtn" onClick={openDialog}>
            <FolderOpen />
          </button>
        </Tooltip>
      }
    >
      {body}
    </PaneFrame>
  )
}
