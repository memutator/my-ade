// workbench/scope.ts — the React binding for a workbench scope.
//
// The scope itself is a factory (store.ts) so a MOUNT owns its own
// coordination context: several workbench widgets can be open at once, one of
// them in a background workspace, and none of them may rewrite another's
// project/model/run. <WorkbenchScopeProvider> (scope.tsx) opens one scope per
// widget and this module hands it to the views through hooks.
//
// Hooks live in a module without components so Fast Refresh keeps working for
// the provider file (react-refresh/only-export-components).

import { createContext, useContext, useSyncExternalStore } from 'react'
import { useStore } from 'zustand'
import type { OpCaller } from './client.ts'
import type { AssignQueueEntry } from './queues.ts'
import type {
  ModelHead,
  WorkbenchContext,
  WorkbenchScope,
  WorkbenchScopeActions,
  WorkbenchScopeState
} from './store.ts'
import type { ImplementationOfferView } from './view-model.ts'

export const WorkbenchScopeContext = createContext<WorkbenchScope | null>(null)

/** the scope of the nearest workbench widget; throws outside one */
export function useWorkbenchScope(): WorkbenchScope {
  const scope = useContext(WorkbenchScopeContext)
  if (!scope) {
    throw new Error('workbench view mounted without <WorkbenchScopeProvider>')
  }
  return scope
}

export function useWorkbenchState<T>(selector: (state: WorkbenchScopeState) => T): T {
  return useStore(useWorkbenchScope().store, selector)
}

export function useWorkbenchContext(): WorkbenchContext {
  return useWorkbenchState((s) => s.context)
}

export function useModelHead(): ModelHead | null {
  return useWorkbenchState((s) => s.head)
}

export function useWorkbenchActions(): WorkbenchScopeActions {
  return useWorkbenchScope().actions
}

/** the op seam this mount calls — never a second global transport */
export function useScopeCaller(): OpCaller {
  return useWorkbenchScope().caller
}

/** the project/run assignment queue this mount shares with its siblings */
export function useAssignQueue(): AssignQueueEntry[] {
  const scope = useWorkbenchScope()
  return useSyncExternalStore(scope.subscribeQueue, scope.queueSnapshot, scope.queueSnapshot)
}

export function useImplementationChoice(selectionToken: string): ImplementationOfferView | null {
  return useWorkbenchState((s) => s.implChoices[selectionToken] ?? null)
}
