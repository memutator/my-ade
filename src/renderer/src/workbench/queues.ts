// workbench/queues.ts — the assignment queue, keyed by project/run.
//
// Queuing is not assigning (REQ-04): an entry is a candidate card the 팀장
// carried from the find view to the assign view, and every entry still needs
// its own preview + explicit assign before anything is created.
//
// The queue deliberately lives OUTSIDE any single widget's store. A workspace
// may hold the find widget in one pane and the assign widget in another and
// both must read the same queue for the same project/run — while a widget
// mounted on project B must never see (or disturb) project A's queue. That is
// why the key is project+run and why nothing here reads a "current project".

import type { CandidateCard } from '../../../../packages/mahas-contracts/src/operations/discovery.ts'

/** one queued candidate — the model pin it was found under travels with it */
export interface AssignQueueEntry {
  card: CandidateCard
  /** model snapshot the card's selectionToken was issued against */
  modelVersion: string
  /** the server declared that snapshot behind the project's active model */
  staleModel: boolean
  queuedAt: number
}

export interface WorkbenchQueueRef {
  projectId: string
  /** '' = the project's un-scoped queue (no run chosen yet) */
  runId: string
}

/** queue identity: project + run, never a model revision or a widget id */
export function queueKey(ref: WorkbenchQueueRef): string {
  return `${ref.projectId}\u0000${ref.runId}`
}

const EMPTY: AssignQueueEntry[] = []

/**
 * An in-process registry of queues. One store per mounted widget reads and
 * writes through it, so two widgets on the same project/run converge on the
 * same entries and a widget on another project cannot reach them.
 *
 * Entries are replaced (never mutated in place) so a subscriber can compare
 * snapshots by identity — the requirement for useSyncExternalStore.
 */
export class WorkbenchQueueRegistry {
  private readonly byKey = new Map<string, AssignQueueEntry[]>()
  private readonly listeners = new Set<() => void>()

  /** stable snapshot: the same array reference until that queue changes */
  entries(key: string): AssignQueueEntry[] {
    return this.byKey.get(key) ?? EMPTY
  }

  enqueue(key: string, entry: AssignQueueEntry): void {
    const current = this.byKey.get(key) ?? EMPTY
    if (current.some((e) => e.card.selectionToken === entry.card.selectionToken)) return
    this.byKey.set(key, [...current, entry])
    this.emit()
  }

  remove(key: string, selectionToken: string): void {
    const current = this.byKey.get(key)
    if (!current) return
    const next = current.filter((e) => e.card.selectionToken !== selectionToken)
    if (next.length === current.length) return
    this.byKey.set(key, next)
    this.emit()
  }

  /** drop a whole queue — the 팀장's explicit clear for one project/run */
  clear(key: string): void {
    if (!this.byKey.has(key)) return
    this.byKey.set(key, EMPTY)
    this.emit()
  }

  keys(): string[] {
    return [...this.byKey.keys()]
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** the app's queue registry; tests build their own instance instead */
export const workbenchQueues = new WorkbenchQueueRegistry()
