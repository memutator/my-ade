import { useState } from 'react'
import { Code2, FolderOpen } from 'lucide-react'
import type { EditorPaneState, EditorTab } from '../types'
import { useStore } from '../store'
import { useT } from '../i18n'
import { isDetachedWin } from '../detached'
import Tooltip from './Tooltip'
import PaneFrame from './PaneFrame'
import TabStrip, { type TabItem } from './TabStrip'
import FileView from './FileView'
import FileTree from './FileTree'
import TreeRootMenu from './TreeRootMenu'
import { CtxMenu, type CtxItem } from './Menu'

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
  const [ctx, setCtx] = useState<{ x: number; y: number; tabId: string } | null>(null)

  // files always open into THIS pane — the store default would hunt for the
  // focused/first editor, which in a detached window is the wrong store.
  // VS Code preview tabs: a transient open reuses the pane's preview slot;
  // permanent opens (double-click, file dialog, links) append a pinned tab.
  const openHere = (path: string, name: string, permanent = false): void => {
    const existing = pane.tabs.find((t) => t.path === path)
    if (existing) {
      const tabs =
        existing.preview && permanent
          ? pane.tabs.map((t) => (t.id === existing.id ? { ...t, preview: undefined } : t))
          : pane.tabs
      updatePane(pane.id, { tabs, activeTabId: existing.id }, wsId)
      return
    }
    const tab: EditorTab = { id: crypto.randomUUID(), path, name, preview: !permanent || undefined }
    const pi = pane.tabs.findIndex((t) => t.preview)
    const tabs =
      !permanent && pi >= 0 ? pane.tabs.map((t, i) => (i === pi ? tab : t)) : [...pane.tabs, tab]
    updatePane(pane.id, { tabs, activeTabId: tab.id }, wsId)
  }

  // pin a preview tab — double-click on the tab or "Keep Open" in its menu
  const keepTab = (tabId: string): void => {
    updatePane(
      pane.id,
      { tabs: pane.tabs.map((t) => (t.id === tabId ? { ...t, preview: undefined } : t)) },
      wsId
    )
  }

  const openDialog = async (): Promise<void> => {
    const p = await window.ade.file.openDialog()
    if (!p) return
    openHere(p, p.split('/').pop() ?? p, true)
  }

  const tabs: TabItem[] = pane.tabs.map((t) => ({
    id: t.id,
    label: t.name,
    sub: t.path,
    dirty: t.dirty,
    preview: t.preview
  }))

  // closing the last tab closes the pane — an editor with nothing open is
  // dead weight. In a detached window the pane record lives in the main
  // store, so the close goes through pane:cmd (which also tears the window
  // down via closeDetached)
  const applyTabs = (next: EditorTab[], keepId?: string): void => {
    if (next.length === 0) {
      if (isDetachedWin) window.ade.win.paneCmd({ action: 'closePane', wsId, paneId: pane.id })
      else closePane(pane.id, wsId)
      return
    }
    const want = keepId ?? pane.activeTabId
    const activeTabId = next.some((x) => x.id === want) ? want : next.at(-1)?.id
    updatePane(pane.id, { tabs: next, activeTabId }, wsId)
  }
  const closeTab = (tabId: string): void => applyTabs(pane.tabs.filter((t) => t.id !== tabId))

  const ctxItems = (): CtxItem[] => {
    const i = pane.tabs.findIndex((x) => x.id === ctx?.tabId)
    const tab = pane.tabs[i]
    if (!tab) return []
    const rel =
      projectPath && tab.path.startsWith(projectPath + '/')
        ? tab.path.slice(projectPath.length + 1)
        : tab.path
    return [
      ...(tab.preview
        ? [
            { label: t('keepOpen'), act: () => keepTab(tab.id) } as CtxItem,
            { sep: true } as CtxItem
          ]
        : []),
      { label: t('close'), act: () => applyTabs(pane.tabs.filter((x) => x.id !== tab.id)) },
      {
        label: t('closeOthers'),
        disabled: pane.tabs.length < 2,
        act: () => applyTabs([tab], tab.id)
      },
      {
        label: t('closeToRight'),
        disabled: i >= pane.tabs.length - 1,
        act: () => applyTabs(pane.tabs.slice(0, i + 1))
      },
      { label: t('closeAll'), act: () => applyTabs([]) },
      { sep: true },
      { label: t('copyPath'), act: () => void window.ade.clipboard.write(tab.path) },
      { label: t('copyRelPath'), act: () => void window.ade.clipboard.write(rel) },
      { label: t('reveal'), act: () => window.ade.fs.reveal(tab.path) }
    ]
  }

  // an edited preview tab pins itself — the content is now worth keeping
  const markDirty = (tabId: string, dirty: boolean): void => {
    updatePane(
      pane.id,
      {
        tabs: pane.tabs.map((t) =>
          t.id === tabId
            ? { ...t, dirty: dirty || undefined, preview: dirty ? undefined : t.preview }
            : t
        )
      },
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
    <>
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
              onContextMenu={(id, e) => setCtx({ x: e.clientX, y: e.clientY, tabId: id })}
              onDoubleClick={keepTab}
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
      {ctx && <CtxMenu x={ctx.x} y={ctx.y} items={ctxItems()} onClose={() => setCtx(null)} />}
    </>
  )
}
