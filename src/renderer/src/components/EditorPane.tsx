import { Code2, FolderOpen } from 'lucide-react'
import type { EditorPaneState } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import Tooltip from './Tooltip'
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
  const t = useT()

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

  const tabs: TabItem[] = pane.tabs.map((t) => ({ id: t.id, label: t.name }))
  const active = pane.tabs.find((t) => t.id === pane.activeTabId)

  const closeTab = (tabId: string): void => {
    const tabs = pane.tabs.filter((t) => t.id !== tabId)
    const activeTabId =
      pane.activeTabId === tabId ? (tabs.at(-1)?.id ?? undefined) : pane.activeTabId
    updatePane(pane.id, { tabs, activeTabId }, wsId)
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
        <Tooltip label={t('openFileTooltip')}>
          <button className="pbtn" onClick={openDialog}>
            <FolderOpen />
          </button>
        </Tooltip>
      }
    >
      {active ? (
        <FileView path={active.path} />
      ) : (
        <div className="file-body">
          <div className="file-empty">
            <span>{t('noFileOpen')}</span>
            <button onClick={openDialog}>{t('openFile')}</button>
          </div>
        </div>
      )}
    </PaneFrame>
  )
}
