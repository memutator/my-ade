import { Code2, FolderOpen } from 'lucide-react'
import type { EditorPaneState } from '../types'
import { useStore } from '../store'
import PaneFrame from './PaneFrame'
import TabStrip, { type TabItem } from './TabStrip'
import FileView from './FileView'

export default function EditorPane({
  pane,
  wsId
}: {
  pane: EditorPaneState
  wsId: string
}): React.JSX.Element {
  const updatePane = useStore((s) => s.updatePane)
  const notify = useStore((s) => s.notify)

  const openDialog = async (): Promise<void> => {
    const p = await window.ade.file.openDialog()
    if (!p) return
    const name = p.split('/').pop() ?? p
    const existing = pane.tabs.find((t) => t.path === p)
    if (existing) {
      updatePane(pane.id, { activeTabId: existing.id }, wsId)
    } else {
      const tab = { id: crypto.randomUUID(), path: p, name }
      updatePane(pane.id, { tabs: [...pane.tabs, tab], activeTabId: tab.id }, wsId)
    }
  }

  const tabs: TabItem[] = pane.tabs.map((t) => ({ id: t.id, label: t.name, dirty: t.dirty }))

  const closeTab = (tabId: string): void => {
    const tabs = pane.tabs.filter((t) => t.id !== tabId)
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
    const name = pane.tabs.find((t) => t.id === tabId)?.name ?? 'file'
    notify({ workspaceId: wsId, paneId: pane.id, title: `save failed: ${name}`, body: msg })
  }

  return (
    <PaneFrame
      pane={pane}
      wsId={wsId}
      icon={<Code2 className="picon" />}
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
        <button className="pbtn" title="Open file…" onClick={openDialog}>
          <FolderOpen />
        </button>
      }
    >
      {pane.tabs.length === 0 ? (
        <div className="file-body">
          <div className="file-empty">
            <span>no file open</span>
            <button onClick={openDialog}>open file…</button>
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
    </PaneFrame>
  )
}
