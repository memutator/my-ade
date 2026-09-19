// workbench/store.ts — one coordination scope per mounted workbench widget.
//
// A scope is (projectId, modelVersion pin, runId) plus the small working set
// that belongs with it: the model snapshot the server declared current, the
// implementation the 팀장 picked for a queued candidate, and the run's
// assignment queue.
//
// The scope is a FACTORY, not a module singleton, because the desktop mounts
// workbench widgets in ordinary panes: several can be open at once, one of
// them in a background workspace. A single 'current project' would be written
// by whichever widget mounted last and read by every other one — a background
// mount must not be able to change a foreground widget's context. Mounts read
// their own scope (scope.tsx wires it), and the queue they share is keyed by
// project/run (queues.ts), never by 'whatever is current'.
//
// Nothing here is a control-plane fact: every datum arrived in an op response
// and every mutation goes back through one. The renderer is never a persistent
// control writer (architecture.md §2 workbench boundary).

import { createStore, type StoreApi } from 'zustand/vanilla'
import type { OpCaller } from './client.ts'
import { workbenchCaller } from './client.ts'
import type { CandidateCard } from './contracts.ts'
import {
  queueKey,
  workbenchQueues,
  type AssignQueueEntry,
  type WorkbenchQueueRegistry
} from './queues.ts'
import type { ImplementationOfferView } from './view-model.ts'

export type { AssignQueueEntry } from './queues.ts'

/** the coordination context of one mounted widget */
export interface WorkbenchContext {
  projectId: string
  /** explicit request pin — '' lets the server resolve the active model */
  modelVersion: string
  runId: string
}

/** which server response named the current model snapshot */
export type HeadSource = 'run' | 'search' | 'inspect' | 'locate' | 'implementations'

/**
 * The model snapshot the SERVER most recently declared current for this scope.
 *
 * modelVersion ids are opaque: the client must never order them (comparing
 * '…-9' with '…-10' as strings is meaningless), so the head is REPLACED by
 * whatever the server declares — run.get names the run's pinned model, and a
 * discovery response with staleModel === false names the project's active
 * model. A response that declares itself behind the head (staleModel === true)
 * teaches us nothing about the head's identity and never moves it.
 */
export interface ModelHead {
  modelVersion: string
  snapshotRevision?: number
  declaredBy: HeadSource
  observedAt: number
}

export interface ModelHeadDeclaration {
  modelVersion: string
  snapshotRevision?: number
  declaredBy: HeadSource
  /** the response declared this snapshot IS the current head */
  current: boolean
}

export interface WorkbenchScopeState {
  context: WorkbenchContext
  head: ModelHead | null
  /** explicit implementation choice per selectionToken ('' = none) */
  implChoices: Record<string, ImplementationOfferView>

  /**
   * Apply a context change. A change is INCOMPATIBLE when the project, the run
   * or the model pin actually moves: pins from the previous context are dropped
   * unless the same patch re-declares them, and the model head resets to unknown
   * so nothing is judged stale against a context it never had.
   */
  setContext: (patch: Partial<WorkbenchContext>) => void
  /** record the head the server declared (false = it declared none) */
  noteHead: (declaration: ModelHeadDeclaration) => boolean
  queueCandidate: (card: CandidateCard, modelVersion: string, staleModel: boolean) => void
  unqueueCandidate: (selectionToken: string) => void
  chooseImpl: (selectionToken: string, impl: ImplementationOfferView | null) => void
  clearQueue: () => void
}

export type WorkbenchScopeActions = Pick<
  WorkbenchScopeState,
  'setContext' | 'noteHead' | 'queueCandidate' | 'unqueueCandidate' | 'chooseImpl' | 'clearQueue'
>

export interface WorkbenchScope {
  store: StoreApi<WorkbenchScopeState>
  /** the op seam this scope calls (per widget, injectable for tests) */
  caller: OpCaller
  queues: WorkbenchQueueRegistry
  actions: WorkbenchScopeActions
  /** the project/run queue identity this scope reads and writes */
  key: () => string
  queueSnapshot: () => AssignQueueEntry[]
  subscribeQueue: (listener: () => void) => () => void
}

export interface WorkbenchScopeOptions {
  projectId?: string
  modelVersion?: string
  runId?: string
  caller?: OpCaller
  queues?: WorkbenchQueueRegistry
}

/**
 * Is a result or a queued entry behind the head?
 *
 * Two independent signals, both from the server:
 *  - the response itself said staleModel (it was served from the project's
 *    older snapshot while a newer active model exists);
 *  - the head is known and names a DIFFERENT model snapshot than the result.
 * With no head known, nothing is called stale: inventing staleness is as wrong
 * as ignoring it, and the server re-checks every selection token anyway.
 */
export function isResultStale(
  modelVersion: string | undefined,
  staleModel: boolean | undefined,
  head: ModelHead | null
): boolean {
  if (staleModel === true) return true
  if (!modelVersion || !head) return false
  return modelVersion !== head.modelVersion
}

export function createWorkbenchScope(options: WorkbenchScopeOptions = {}): WorkbenchScope {
  const queues = options.queues ?? workbenchQueues
  const store = createStore<WorkbenchScopeState>((set, get) => ({
    context: {
      projectId: options.projectId ?? '',
      modelVersion: options.modelVersion ?? '',
      runId: options.runId ?? ''
    },
    head: null,
    implChoices: {},

    setContext: (patch) =>
      set((state) => {
        const projectMoved =
          patch.projectId !== undefined && patch.projectId !== state.context.projectId
        const runMoved = patch.runId !== undefined && patch.runId !== state.context.runId
        const modelMoved =
          patch.modelVersion !== undefined && patch.modelVersion !== state.context.modelVersion
        if (!projectMoved && !runMoved && !modelMoved) return state
        const context: WorkbenchContext = {
          projectId: patch.projectId ?? state.context.projectId,
          // a pin that belonged to another project/run is not a context for
          // this one — it is dropped unless this patch re-declares it
          modelVersion:
            projectMoved || runMoved
              ? (patch.modelVersion ?? '')
              : (patch.modelVersion ?? state.context.modelVersion),
          runId: projectMoved ? (patch.runId ?? '') : (patch.runId ?? state.context.runId)
        }
        return { ...state, context, head: null }
      }),

    noteHead: (declaration) => {
      if (!declaration.modelVersion) return false
      // a response that declared itself behind the head says nothing about
      // the head's identity — it must not move it
      if (!declaration.current) return false
      set((state) => ({
        ...state,
        head: {
          modelVersion: declaration.modelVersion,
          snapshotRevision: declaration.snapshotRevision,
          declaredBy: declaration.declaredBy,
          observedAt: Date.now()
        }
      }))
      return true
    },

    queueCandidate: (card, modelVersion, staleModel) =>
      queues.enqueue(queueKey(get().context), {
        card,
        modelVersion,
        staleModel,
        queuedAt: Date.now()
      }),

    unqueueCandidate: (selectionToken) => queues.remove(queueKey(get().context), selectionToken),

    chooseImpl: (selectionToken, impl) =>
      set((state) => {
        const implChoices = { ...state.implChoices }
        if (impl) implChoices[selectionToken] = impl
        else delete implChoices[selectionToken]
        return { ...state, implChoices }
      }),

    clearQueue: () => queues.clear(queueKey(get().context))
  }))

  const live = store.getState()
  const actions: WorkbenchScopeActions = {
    setContext: live.setContext,
    noteHead: live.noteHead,
    queueCandidate: live.queueCandidate,
    unqueueCandidate: live.unqueueCandidate,
    chooseImpl: live.chooseImpl,
    clearQueue: live.clearQueue
  }

  return {
    store,
    caller: options.caller ?? workbenchCaller(),
    queues,
    actions,
    key: () => queueKey(store.getState().context),
    queueSnapshot: () => queues.entries(queueKey(store.getState().context)),
    subscribeQueue: (listener) => queues.subscribe(listener)
  }
}
