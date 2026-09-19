// workbench/store.ts — shared 팀장 workbench state.
//
// One small store shared by every workbench widget tab: the coordination
// context (project / modelVersion / run) is a single working set, the
// assignment queue carries candidates between the find view and the assign
// view, and latestModelVersion is the staleness yardstick — a result issued
// against an older modelVersion renders STALE with an explicit re-query,
// never silently trusted (IMP-31 §6).
//
// This store holds UI working state only. Nothing here is a control-plane
// fact: every datum came from an op response and every mutation goes back
// through one (the renderer is never a persistent control writer —
// architecture.md §2 workbench boundary).

import { create } from 'zustand'
import type { CandidateCard, ImplementationOffer } from './contracts.ts'

/** a candidate the 팀장 queued for assignment — queueing is NOT assigning;
 //  each entry still needs its own preview + explicit assign (REQ-04). */
export interface AssignQueueEntry {
  card: CandidateCard
  modelVersion: string
  queuedAt: number
}

interface WorkbenchState {
  /** coordination context — projectId defaults to the workspace project id
   //  but is editable (the control-plane project is a different identity
   //  from the desktop project record). */
  projectId: string
  modelVersion: string
  runId: string

  /** highest modelVersion the client has observed (search responses,
   //  runtime snapshots). Cards/results older than this are stale. */
  latestModelVersion: string

  /** candidates queued for preview→assign — provider and consumer for the
   //  same initial negotiation can both sit here and be assigned
   //  independently, so neither waits on the other's tasks (§4.5). */
  assignQueue: AssignQueueEntry[]

  /** the implementation chosen per queue entry (explicit 팀장 choice —
   //  never the first row by default). key = selectionToken */
  implChoices: Record<string, ImplementationOffer | undefined>

  setContext: (ctx: { projectId?: string; modelVersion?: string; runId?: string }) => void
  noteModelVersion: (v: string | undefined) => void
  queueCandidate: (card: CandidateCard, modelVersion: string) => void
  unqueueCandidate: (selectionToken: string) => void
  chooseImpl: (selectionToken: string, impl: ImplementationOffer | undefined) => void
}

/** a result is stale when it was issued against an older modelVersion than
 //  the newest the client has seen — the token's version is what preview/
 //  assign re-check server-side anyway (STALE_REVISION is a normal answer). */
export function isStale(resultModelVersion: string | undefined, latest: string): boolean {
  return !!resultModelVersion && !!latest && resultModelVersion !== latest
}

export const useWorkbench = create<WorkbenchState>((set) => ({
  projectId: '',
  modelVersion: '',
  runId: '',
  latestModelVersion: '',
  assignQueue: [],
  implChoices: {},

  setContext: (ctx) => set((s) => ({ ...s, ...ctx })),
  noteModelVersion: (v) =>
    set((s) => {
      if (!v) return s
      // lexically newer wins — modelVersion ids are opaque but versioned;
      // first-seen fills the yardstick, later versions replace it
      if (!s.latestModelVersion || v > s.latestModelVersion) {
        return { ...s, latestModelVersion: v }
      }
      return s
    }),
  queueCandidate: (card, modelVersion) =>
    set((s) =>
      s.assignQueue.some((e) => e.card.selectionToken === card.selectionToken)
        ? s
        : {
            ...s,
            assignQueue: [...s.assignQueue, { card, modelVersion, queuedAt: Date.now() }]
          }
    ),
  unqueueCandidate: (selectionToken) =>
    set((s) => ({
      ...s,
      assignQueue: s.assignQueue.filter((e) => e.card.selectionToken !== selectionToken)
    })),
  chooseImpl: (selectionToken, impl) =>
    set((s) => ({ ...s, implChoices: { ...s.implChoices, [selectionToken]: impl } }))
}))
