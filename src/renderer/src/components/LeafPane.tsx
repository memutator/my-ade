import { useEffect, useRef, useState } from 'react'
import { Code2, FolderOpen, FolderTree, Globe, Plus, RotateCw, TerminalSquare } from 'lucide-react'
import type { BlockKind, EditorTab, PaneState, PaneTab, TerminalTab } from '../types'
import { useStore, patchTerminalTab } from '../store'
import { useT } from '../i18n'
import { isDetachedWin } from '../detached'
import { blockLabel, blockSub } from '../utils'
import { useFileIcon } from '../fileIcons'
import AgentIcon from './AgentIcon'
import Tooltip from './Tooltip'
import PaneFrame from './PaneFrame'
import TabStrip, { type TabItem, type TabStripHandle } from './TabStrip'
import { TerminalTabView } from './TerminalPane'
import { BrowserTabView } from './BrowserPane'
import FileView from './FileView'
import FileTree from './FileTree'
import TreeRootMenu from './TreeRootMenu'
import { CtxMenu, Dropdown, Popup, type CtxItem } from './Menu'

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1) || p

// per-block-kind tab glyph — the leaf has no type of its own, the active
// block's icon IS the pane icon
function BlockIcon({ tab }: { tab: PaneTab }): React.JSX.Element {
  if (tab.kind === 'term' && tab.agent) return <AgentIcon id={tab.agent} size={13} />
  if (tab.kind === 'web') return <Globe className="tab-kico" />
  if (tab.kind === 'file') return <FileGlyph name={tab.name || 'file'} />
  return <TerminalSquare className="tab-kico" />
}

function FileGlyph({ name }: { name: string }): React.JSX.Element {
  const url = useFileIcon(name, false)
  return url ? <img className="ticon-img" src={url} alt="" /> : <Code2 className="tab-kico" />
}

// the leaf's file-tree overlay — a corner fab floats over editor content;
// ~350ms hover dwell pops the tree, the 150ms leave-delay bridges the gap
// into the card. Root is pane-owned (pane.treeRoot, default project dir).
function TreePeek({
  pane,
  wsId,
  projectPath
}: {
  pane: PaneState
  wsId: string
  projectPath?: string
}): React.JSX.Element {
  const updatePane = useStore((s) => s.updatePane)
  const openFile = useStore((s) => s.openFile)
  const treeRoot = pane.treeRoot ?? projectPath ?? '/'
  const fabRef = useRef<HTMLButtonElement>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const openT = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeT = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearT = (r: typeof openT): void => {
    if (r.current) {
      clearTimeout(r.current)
      r.current = null
    }
  }
  useEffect(
    () => () => {
      clearT(openT)
      clearT(closeT)
    },
    []
  )
  return (
    <>
      <button
        ref={fabRef}
        className="tree-fab"
        onMouseEnter={() => {
          clearT(closeT)
          clearT(openT)
          openT.current = setTimeout(
            () => setRect(fabRef.current?.getBoundingClientRect() ?? null),
            350
          )
        }}
        onMouseLeave={() => {
          clearT(openT)
          if (!rect) return
          clearT(closeT)
          closeT.current = setTimeout(() => setRect(null), 150)
        }}
      >
        <FolderTree />
      </button>
      {rect && (
        <Popup
          pos={{ left: rect.left, top: rect.bottom + 5 }}
          onClose={() => setRect(null)}
          insideRef={fabRef}
          className="tree-overlay"
          onMouseEnter={() => clearT(closeT)}
          onMouseLeave={() => setRect(null)}
        >
          <div className="tree-overlay-head">
            <TreeRootMenu
              root={treeRoot}
              onPick={(p) => updatePane(pane.id, { treeRoot: p }, wsId)}
              label={basename(treeRoot)}
            />
          </div>
          {/* files open into THIS leaf — explicit paneId stacks a file tab
              here instead of hunting for the focused leaf */}
          <FileTree
            key={treeRoot}
            rootPath={treeRoot}
            onOpenFile={(path, name, permanent) =>
              openFile(path, name, wsId, !permanent || undefined, pane.id)
            }
          />
        </Popup>
      )}
    </>
  )
}

/**
 * A leaf is a type-agnostic stack of blocks (term/web/file tabs) — the active
 * tab decides which content renders and which block-specific chrome appears
 * (editor corner fab, browser omnibox). Closing the last tab closes the leaf.
 */
export default function LeafPane({
  pane,
  wsId,
  projectPath
}: {
  pane: PaneState
  wsId: string
  projectPath?: string
}): React.JSX.Element {
  const updatePane = useStore((s) => s.updatePane)
  const closePane = useStore((s) => s.closePane)
  const notify = useStore((s) => s.notify)
  const openFile = useStore((s) => s.openFile)
  const notifications = useStore((s) => s.notifications)
  const language = useStore((s) => s.settings.language)
  const home = useStore((s) => s.settings.homeUrl.trim())
  const focused = useStore((s) => {
    const w = s.workspaces.find((x) => x.id === wsId)
    return s.activeWorkspaceId === wsId && w?.focusedPaneId === pane.id
  })
  const t = useT()

  const tabs = pane.tabs
  const activeTab = tabs.find((x) => x.id === pane.activeTabId) ?? tabs[0]
  const activeTabId = activeTab?.id ?? null

  const stripRef = useRef<TabStripHandle>(null)
  const [ctx, setCtx] = useState<{ x: number; y: number; tabId: string } | null>(null)
  // ctx-menu "rename" can't touch the strip ref during render — the effect
  // performs it after the menu's click committed (seq makes repeats re-fire)
  const [renameReq, setRenameReq] = useState<{ id: string; seq: number } | null>(null)
  const lastRenameSeq = useRef(0)
  useEffect(() => {
    if (renameReq && renameReq.seq !== lastRenameSeq.current) {
      lastRenameSeq.current = renameReq.seq
      stripRef.current?.startRename(renameReq.id)
    }
  }, [renameReq])
  // per-tab restart counter — bumping re-runs the term block's spawn effect
  const [epochs, setEpochs] = useState<Record<string, number>>({})

  // ── shared tab ops ──
  // closing the last tab closes the leaf — an empty stack is dead weight.
  // In a detached window the record lives in the main store, so the close
  // goes through pane:cmd (which also tears this window down)
  const applyTabs = (next: PaneTab[], keepId?: string): void => {
    if (next.length === 0) {
      if (isDetachedWin) window.ade.win.paneCmd({ action: 'closePane', wsId, paneId: pane.id })
      else closePane(pane.id, wsId)
      return
    }
    const want = keepId ?? activeTabId
    const keep = want && next.some((x) => x.id === want) ? want : next.at(-1)!.id
    updatePane(pane.id, { tabs: next, activeTabId: keep }, wsId)
  }
  const closeTab = (tabId: string): void => applyTabs(tabs.filter((x) => x.id !== tabId))
  const reorderTabs = (from: number, to: number): void => {
    const next = [...tabs]
    const [m] = next.splice(from, 1)
    next.splice(to, 0, m)
    updatePane(pane.id, { tabs: next }, wsId)
  }
  // the strip's + adds a block to THIS leaf — the pane's own UI is an
  // explicit target, not a global open
  const addTab = (kind: BlockKind): void => {
    const tab: PaneTab =
      kind === 'term'
        ? { kind, id: crypto.randomUUID() }
        : kind === 'web'
          ? { kind, id: crypto.randomUUID(), url: home || 'https://', title: '' }
          : { kind, id: crypto.randomUUID(), path: '', name: '' }
    updatePane(pane.id, { tabs: [...tabs, tab], activeTabId: tab.id }, wsId)
  }

  // ── term-block ops ──
  // kill the old session AND clear the session id — the remount must spawn a
  // fresh shell, not attach back to the session being "restarted" (unmount
  // cleanup won't kill it: the tab record still exists)
  const restartTab = (tabId: string): void => {
    const old = tabs.find((x): x is TerminalTab => x.id === tabId && x.kind === 'term')?.pty
    if (old) window.ade.pty.kill(old)
    patchTerminalTab(wsId, pane.id, tabId, { pty: undefined })
    setEpochs((m) => ({ ...m, [tabId]: (m[tabId] ?? 0) + 1 }))
  }
  const termTab = (tabId: string): TerminalTab | undefined =>
    tabs.find((x): x is TerminalTab => x.id === tabId && x.kind === 'term')
  const renameTab = (tabId: string, name: string): void => {
    const title = name.trim()
    patchTerminalTab(wsId, pane.id, tabId, { title: title || undefined })
    // session-rename hook: if a harness session was observed for this tab,
    // propagate the name through the real event channel so the session
    // registry (and every ade instance) learns it — powers the "which
    // session" line in notifications
    const st = useStore.getState()
    const tab = termTab(tabId)
    const sid = Object.entries(st.agentSessions).find(
      ([, i]) => i.tabId === tabId && i.wsId === wsId
    )?.[0]
    if (sid) {
      st.renameAgentSession(sid, title)
      void window.ade.hooks.emit?.({
        provider: tab?.agent ?? st.agentSessions[sid]?.provider ?? 'unknown',
        event: 'session-rename',
        sessionId: sid,
        cwd: tab?.cwd,
        name: title || undefined
      })
    }
  }

  // ── file-block ops ──
  const keepTab = (tabId: string): void => {
    updatePane(
      pane.id,
      {
        tabs: tabs.map((x) =>
          x.id === tabId && x.kind === 'file' ? { ...x, preview: undefined } : x
        )
      },
      wsId
    )
  }
  // an edited preview tab pins itself — the content is now worth keeping
  const markDirty = (tabId: string, dirty: boolean): void => {
    updatePane(
      pane.id,
      {
        tabs: tabs.map((x) =>
          x.id === tabId && x.kind === 'file'
            ? { ...x, dirty: dirty || undefined, preview: dirty ? undefined : x.preview }
            : x
        )
      },
      wsId
    )
  }
  const saveFailed = (tabId: string, msg: string): void => {
    const name =
      tabs.find((x): x is EditorTab => x.id === tabId && x.kind === 'file')?.name ?? 'file'
    notify({ workspaceId: wsId, paneId: pane.id, title: t('saveFailed', { name }), body: msg })
  }
  // an empty file block's own dialog fills the block in place (via the
  // explicit paneId — never splits, never wanders to another leaf)
  const openDialog = async (): Promise<void> => {
    const p = await window.ade.file.openDialog()
    if (p) openFile(p, basename(p), wsId, false, pane.id)
  }

  // ── ctx menu — block-kind items on top, shared close ops below ──
  const ctxItems = (): CtxItem[] => {
    const i = tabs.findIndex((x) => x.id === ctx?.tabId)
    const tab = tabs[i]
    if (!tab) return []
    const rel =
      projectPath && tab.kind === 'file' && tab.path.startsWith(projectPath + '/')
        ? tab.path.slice(projectPath.length + 1)
        : tab.kind === 'file'
          ? tab.path
          : ''
    const head: CtxItem[] = []
    if (tab.kind === 'term') {
      head.push(
        { label: t('rename'), act: () => setRenameReq({ id: tab.id, seq: Date.now() }) },
        {
          label: t('copyCwd'),
          disabled: !tab.cwd,
          act: () => tab.cwd && void window.ade.clipboard.write(tab.cwd)
        },
        { label: t('restartShell'), act: () => restartTab(tab.id) }
      )
    } else if (tab.kind === 'web') {
      head.push({
        label: t('copyUrl'),
        disabled: !tab.url || tab.url === 'https://',
        act: () => void window.ade.clipboard.write(tab.url)
      })
    } else {
      if (tab.preview) head.push({ label: t('keepOpen'), act: () => keepTab(tab.id) })
      if (tab.path)
        head.push(
          { label: t('copyPath'), act: () => void window.ade.clipboard.write(tab.path) },
          { label: t('copyRelPath'), act: () => void window.ade.clipboard.write(rel) },
          { label: t('reveal'), act: () => window.ade.fs.reveal(tab.path) }
        )
    }
    return [
      ...head,
      ...(head.length ? [{ sep: true } as CtxItem] : []),
      { label: t('close'), act: () => closeTab(tab.id) },
      {
        label: t('closeOthers'),
        disabled: tabs.length < 2,
        act: () => applyTabs([tab], tab.id)
      },
      {
        label: t('closeToRight'),
        disabled: i >= tabs.length - 1,
        act: () => applyTabs(tabs.slice(0, i + 1))
      },
      { label: t('closeAll'), act: () => applyTabs([]) }
    ]
  }

  // unread notifications badge the exact block — the workspace strip only
  // points at the workspace level
  const unreadTabs = new Set(notifications.filter((n) => !n.read && n.tabId).map((n) => n.tabId))
  const items: TabItem[] = tabs.map((tab) => ({
    id: tab.id,
    label: blockLabel(tab, language),
    sub: blockSub(tab),
    icon: <BlockIcon tab={tab} />,
    dirty:
      tab.kind === 'term'
        ? tab.exited || unreadTabs.has(tab.id)
        : tab.kind === 'file'
          ? tab.dirty || unreadTabs.has(tab.id)
          : unreadTabs.has(tab.id),
    dotTip:
      tab.kind === 'term' && tab.exited
        ? t('shellExited')
        : unreadTabs.has(tab.id)
          ? t('wsUnread')
          : undefined,
    preview: tab.kind === 'file' ? tab.preview : undefined,
    renameable: tab.kind === 'term'
  }))

  return (
    <>
      <PaneFrame
        pane={pane}
        wsId={wsId}
        icon={activeTab ? <BlockIcon tab={activeTab} /> : <TerminalSquare className="picon" />}
        dragTitle={activeTab ? blockLabel(activeTab, language) : ''}
        title={
          <div className="pane-tabs">
            <TabStrip
              ref={stripRef}
              tabs={items}
              activeId={activeTabId}
              onActivate={(id) => updatePane(pane.id, { activeTabId: id }, wsId)}
              onClose={closeTab}
              onRename={renameTab}
              onReorder={reorderTabs}
              onContextMenu={(id, e) => setCtx({ x: e.clientX, y: e.clientY, tabId: id })}
              onDoubleClick={(id) => {
                const tab = tabs.find((x) => x.id === id)
                if (tab?.kind === 'file' && tab.preview) keepTab(id)
              }}
              addControl={
                <Dropdown
                  trigger={
                    <Tooltip label={t('newTab')}>
                      <button className="pbtn tab-add">
                        <Plus />
                      </button>
                    </Tooltip>
                  }
                >
                  <button className="pact-item" onClick={() => addTab('term')}>
                    <TerminalSquare />
                    {t('terminal')}
                  </button>
                  <button className="pact-item" onClick={() => addTab('web')}>
                    <Globe />
                    {t('browser')}
                  </button>
                  <button className="pact-item" onClick={() => addTab('file')}>
                    <Code2 />
                    {t('editor')}
                  </button>
                </Dropdown>
              }
            />
          </div>
        }
        extraActions={
          <>
            {activeTab?.kind === 'term' && activeTab.exited && (
              <Tooltip label={t('restartShell')}>
                <button className="pbtn" onClick={() => restartTab(activeTab.id)}>
                  <RotateCw />
                </button>
              </Tooltip>
            )}
            {activeTab?.kind === 'file' && (
              <Tooltip label={t('openFileTooltip')}>
                <button className="pbtn" onClick={openDialog}>
                  <FolderOpen />
                </button>
              </Tooltip>
            )}
          </>
        }
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={
              tab.kind === 'term' ? 'term-tab' : tab.kind === 'file' ? 'editor-file' : 'web-tab'
            }
            hidden={tab.id !== activeTabId}
          >
            {tab.kind === 'term' ? (
              <TerminalTabView
                wsId={wsId}
                paneId={pane.id}
                tabId={tab.id}
                projectPath={projectPath}
                active={tab.id === activeTabId}
                epoch={epochs[tab.id] ?? 0}
                focused={focused}
                onRestart={() => restartTab(tab.id)}
              />
            ) : tab.kind === 'web' ? (
              <BrowserTabView
                wsId={wsId}
                paneId={pane.id}
                tab={tab}
                onFocusPane={() => useStore.getState().focusPane(pane.id, wsId)}
              />
            ) : tab.path ? (
              <FileView
                path={tab.path}
                onDirtyChange={(d) => markDirty(tab.id, d)}
                onSaveError={(msg) => saveFailed(tab.id, msg)}
              />
            ) : (
              <div className="file-body">
                <div className="file-empty">
                  <span>{t('noFileOpen')}</span>
                  <button onClick={openDialog}>{t('openFile')}</button>
                </div>
              </div>
            )}
          </div>
        ))}
        {activeTab?.kind === 'file' && (
          <TreePeek pane={pane} wsId={wsId} projectPath={projectPath} />
        )}
      </PaneFrame>
      {ctx && <CtxMenu x={ctx.x} y={ctx.y} items={ctxItems()} onClose={() => setCtx(null)} />}
    </>
  )
}
