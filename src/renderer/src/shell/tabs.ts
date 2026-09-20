// Tab-close policy shared by LeafPane and PaneDock.
//
// Closing a managed terminal unbinds/detaches whether the tab is visible or
// minimized. Closing the last tab closes the leaf.

import type { PaneState, PaneTab } from '../types'

export interface ExecUnbind {
  viewId: string
  expectedRevision?: number
  terminalId?: string
}

export interface CloseTabPlan {
  closePane: boolean
  nextTabs: PaneTab[]
  activeTabId?: string
  unbind: ExecUnbind | null
}

export function planCloseTab(input: {
  wsId: string
  paneId: string
  pane: Pick<PaneState, 'tabs' | 'activeTabId'>
  tabId: string
}): CloseTabPlan {
  const tab = input.pane.tabs.find((entry) => entry.id === input.tabId)
  let unbind: ExecUnbind | null = null
  if (tab?.kind === 'term' && tab.binding) {
    const viewId = `${input.wsId}:${input.paneId}:${input.tabId}`
    unbind = {
      viewId,
      ...(tab.binding.revision !== undefined ? { expectedRevision: tab.binding.revision } : {}),
      ...(tab.binding.terminalId ? { terminalId: tab.binding.terminalId } : {})
    }
  }
  const nextTabs = input.pane.tabs.filter((entry) => entry.id !== input.tabId)
  if (nextTabs.length === 0) return { closePane: true, nextTabs, unbind }
  const want = input.pane.activeTabId
  const activeTabId =
    want && nextTabs.some((entry) => entry.id === want && !entry.minimized)
      ? want
      : (nextTabs.filter((entry) => !entry.minimized).at(-1)?.id ?? nextTabs.at(-1)!.id)
  return { closePane: false, nextTabs, activeTabId, unbind }
}
