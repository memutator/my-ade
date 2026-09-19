// workbench/scope.tsx — <WorkbenchScopeProvider>: one scope per mounted widget.
//
// The provider owns the scope (store.ts) for its subtree and nothing more;
// the hooks that read it live in scope.ts so this file stays a component-only
// module (Fast Refresh).

import { useEffect, useState, type ReactNode } from 'react'
import { workbenchCaller, type OpCaller } from './client.ts'
import type { WorkbenchQueueRegistry } from './queues.ts'
import { createWorkbenchScope } from './store.ts'
import { WorkbenchScopeContext } from './scope.ts'

export interface WorkbenchScopeProviderProps {
  /** the hosting workspace's desktop project id */
  projectId: string
  /** optional initial pins; the ContextBar edits them afterwards */
  modelVersion?: string
  runId?: string
  /** the op seam for this mount (defaults to the desktop exec:* adapter) */
  caller?: OpCaller
  /** queue registry (defaults to the app-wide one; tests inject their own) */
  queues?: WorkbenchQueueRegistry
  children: ReactNode
}

export default function WorkbenchScopeProvider({
  projectId,
  modelVersion,
  runId,
  caller,
  queues,
  children
}: WorkbenchScopeProviderProps): React.JSX.Element {
  const [scope] = useState(() =>
    createWorkbenchScope({
      projectId,
      modelVersion: modelVersion ?? '',
      runId: runId ?? '',
      caller: caller ?? workbenchCaller(),
      queues
    })
  )

  // Props are this mount's own facts. A changed project is an incompatible
  // context: setContext drops the previous project's pins instead of
  // querying one project with another project's model pin.
  useEffect(() => {
    scope.actions.setContext({ projectId })
  }, [scope, projectId])
  useEffect(() => {
    if (modelVersion !== undefined) scope.actions.setContext({ modelVersion })
  }, [scope, modelVersion])
  useEffect(() => {
    if (runId !== undefined) scope.actions.setContext({ runId })
  }, [scope, runId])

  return <WorkbenchScopeContext.Provider value={scope}>{children}</WorkbenchScopeContext.Provider>
}
