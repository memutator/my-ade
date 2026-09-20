// A 'widget' block — chromeless mini-tools stacked in a leaf like any other
// tab. This file is the ROUTER only:
//
//   'usage' → features/usage/UsageWidget      stored provider quota
//   'tokens' → features/usage/TokensWidget    stored usage + statistics + sessions
//   others   → per-pane session list / the workbench's control-plane views
//
// The usage and tokens bodies used to live here as one component with their own
// module-level caches, provider polling and on-disk summation. They now read the
// daemon domain store through features/usage (see that folder's domain.ts): no
// scanner, no credential probe, no provider HTTP from a view.

import { useCallback } from 'react'
import { useStore } from '../store'
import AgentsPanel from './AgentsPanel'
import WidgetWorkbench, { isWorkbenchWidget } from '../workbench/WidgetWorkbench'
import UsageWidget from '../features/usage/UsageWidget'
import TokensWidget from '../features/usage/TokensWidget'
import { srcProvider } from '../utils'
import type { WidgetTab } from '../types'

export default function WidgetTabView({
  wsId,
  paneId,
  tab
}: {
  wsId: string
  paneId: string
  tab: WidgetTab
}): React.JSX.Element {
  // the widget kind is fixed at creation; the usage widget's source selection
  // rides the tab record so it persists across restarts
  const tabId = tab.id
  const onProviders = useCallback(
    (ids: string[]): void => {
      const store = useStore.getState()
      const pane = store.workspaces.find((workspace) => workspace.id === wsId)?.panes[paneId]
      if (!pane) return
      store.updatePane(
        paneId,
        {
          tabs: pane.tabs.map((entry) =>
            entry.id === tabId
              ? ({
                  ...entry,
                  providers: ids,
                  // subtitle fallback for older readers of `provider`
                  provider: ids[0] ? srcProvider(ids[0]) : undefined
                } as typeof entry)
              : entry
          )
        },
        wsId
      )
    },
    [wsId, paneId, tabId]
  )
  const onDomainProjectId = useCallback(
    (id: string): void => {
      const store = useStore.getState()
      const pane = store.workspaces.find((workspace) => workspace.id === wsId)?.panes[paneId]
      if (!pane) return
      store.updatePane(
        paneId,
        {
          tabs: pane.tabs.map((entry) =>
            entry.id === tabId ? ({ ...entry, domainProjectId: id } as typeof entry) : entry
          )
        },
        wsId
      )
    },
    [wsId, paneId, tabId]
  )

  return (
    <div className="widget">
      {tab.widget === 'usage' ? (
        <UsageWidget providers={tab.providers} onProviders={onProviders} />
      ) : tab.widget === 'tokens' ? (
        <TokensWidget />
      ) : isWorkbenchWidget(tab.widget) ? (
        // domain Project id only — the workspace folder uid is a different model
        <WidgetWorkbench
          widget={tab.widget}
          projectId={tab.domainProjectId}
          onProjectId={onDomainProjectId}
        />
      ) : (
        <AgentsPanel wsId={wsId} />
      )}
    </div>
  )
}
