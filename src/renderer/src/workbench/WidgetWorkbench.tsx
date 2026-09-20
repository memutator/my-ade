/* eslint-disable react-refresh/only-export-components -- this module is the
   wrapper's public entry: the host (WidgetView) imports the component AND the
   kind guard from one place. The guard is a pure predicate, so Fast Refresh
   only ever falls back to a reload for edits to this file itself. */

// workbench/WidgetWorkbench.tsx — the widget-block entry point for the four
// workbench surfaces (책임 탐색 / 팀 배정 / 계획 / inspector).
//
// WHY THIS WRAPPER EXISTS
// A workbench widget is mounted in an ordinary pane and several can be open at
// once — one of them inside a background workspace. The workbench context
// (project / model pin / run) is a property of the MOUNT, not of the app, so
// this wrapper opens a scope (store.ts via scope.tsx) for its own subtree: a
// background widget can no longer overwrite the context another widget is
// working in, and the assignment queue is keyed by project/run (queues.ts).
//
// HOST CONTRACT
//   import WidgetWorkbench, { isWorkbenchWidget } from '../workbench/WidgetWorkbench'
//   ...
//   isWorkbenchWidget(tab.widget) ? (
//     <WidgetWorkbench widget={tab.widget} projectId={tab.domainProjectId} onProjectId={…} />
//   ) : ( …other widget kinds… )
//
// `projectId` is a daemon projects.id (or '' while unconnected). The hosting
// workspace folder uid must not be passed through. `modelVersion` and `runId`
// stay unpinned by the host: the 팀장 edits those in the view's own context
// bar. The mount change is written out for the parent in
// docs/plans/workbench-scope-mount.md.

import type { WidgetTab } from '../types'
import InspectorView from './InspectorView.tsx'
import PlanView from './PlanView.tsx'
import ResponsibilityView from './ResponsibilityView.tsx'
import TeamView from './TeamView.tsx'
import WorkbenchScopeProvider from './scope.tsx'

/** widget kinds this wrapper renders; the rest are other workers' surfaces */
export type WorkbenchWidgetKind = 'responsibility' | 'team' | 'plan' | 'inspector'

export function isWorkbenchWidget(kind: WidgetTab['widget']): kind is WorkbenchWidgetKind {
  return kind === 'responsibility' || kind === 'team' || kind === 'plan' || kind === 'inspector'
}

export default function WidgetWorkbench({
  widget,
  projectId,
  onProjectId
}: {
  widget: WorkbenchWidgetKind
  /** daemon projects.id; '' / undefined = unconnected */
  projectId: string | undefined
  onProjectId?: (id: string) => void
}): React.JSX.Element {
  return (
    <WorkbenchScopeProvider projectId={projectId ?? ''} onProjectId={onProjectId}>
      {widget === 'responsibility' ? (
        <ResponsibilityView />
      ) : widget === 'team' ? (
        <TeamView />
      ) : widget === 'plan' ? (
        <PlanView />
      ) : (
        <InspectorView />
      )}
    </WorkbenchScopeProvider>
  )
}
