// Stored harness sessions — the canonical session list the UI reads.
//
// A session here is a durable row (`HarnessSession` from `session.list`), not
// the app's live agent registry. The two are deliberately kept apart:
//
//   · the STORE answers "which sessions exist, when were they seen" and keeps
//     answering after a restart or a deleted transcript;
//   · the live registry (store.agentSessions, fed by hook/pty events) answers
//     "is it running in this app right now, and which pane/tab is it in" — used
//     for navigation only.
//
// Resume support is NOT part of the list read: it belongs to a session's
// handles (`session.get` / `session.handle.list`), so it is fetched for the few
// sessions a view actually asks about instead of for every row.

import type { DomainSessionsResult, DomainSessionDetailResult } from '../../../../preload/domain'
import { loadSessionDetail, loadStoredSessions } from '../usage/domain'
import {
  handlesResumeSupport,
  placementOfMetadata,
  selectDetailCandidates,
  sessionDetailView
} from './view-model'
import type { SessionDetailView } from './view-model'
import type { AgentSessionInfo } from '../../types'

export { loadSessionDetail, loadStoredSessions }
export type { DomainSessionDetailResult, DomainSessionsResult }
export { selectDetailCandidates, sessionDetailView }
export type { SessionAttachmentView, SessionDetailView } from './view-model'

export type ResumeSupport = 'supported' | 'unsupported' | 'unknown'

/** Where a session was observed running, lifted from session metadata. Hook
 *  observations stamp paneId/tabId top-level; the desktop-legacy import nests
 *  them under `placement`. Never synthesized — absent means unrecorded. */
export interface SessionPlacement {
  cwd?: string
  wsId?: string
  paneId?: string
  tabId?: string
}

export interface StoredSessionRow {
  sessionId: string
  harnessId: string
  title?: string
  cwd?: string
  parentSessionId?: string
  namespace: string
  nativeSessionKey: string
  firstObservedAt: number
  lastObservedAt: number
  placement?: SessionPlacement
}

export function storedSessionRows(view: DomainSessionsResult): StoredSessionRow[] {
  return view.items.map((session) => {
    const metadata = session.metadata as Record<string, unknown>
    const cwd = typeof metadata['cwd'] === 'string' ? metadata['cwd'] : undefined
    const placement = placementOfMetadata(metadata)
    return {
      sessionId: session.id,
      harnessId: session.harnessId,
      ...(session.title ? { title: session.title } : {}),
      ...((cwd ?? placement?.cwd) ? { cwd: cwd ?? placement?.cwd } : {}),
      ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
      namespace: session.namespace,
      nativeSessionKey: session.nativeSessionKey,
      firstObservedAt: session.firstObservedAt,
      lastObservedAt: session.lastObservedAt,
      ...(placement ? { placement } : {})
    }
  })
}

export interface SessionDetailsResult {
  /** canonical session id → detail view (failed reads are simply absent) */
  byId: Record<string, SessionDetailView>
  /** how much of the wanted set the bound allowed — the panel shows the rest
   *  as "detail not loaded" rather than "no detail exists" */
  coverage: { wanted: number; loaded: number }
}

/** Bounded canonical detail read for the rows a view shows. Candidate order
 *  comes from `selectDetailCandidates`: live-collision rows first (the join
 *  needs their attachment evidence), then pinned rows, then recency — so the
 *  sessions whose native and canonical ids differ still get their detail. */
export async function loadSessionDetails(
  rows: readonly StoredSessionRow[],
  options: {
    live?: Record<string, AgentSessionInfo>
    pinned?: readonly string[]
    limit?: number
  } = {}
): Promise<SessionDetailsResult> {
  const wanted = selectDetailCandidates(rows, options)
  const results = await Promise.all(wanted.map((id) => loadSessionDetail(id)))
  const byId: Record<string, SessionDetailView> = {}
  results.forEach((result, index) => {
    const id = wanted[index]
    if (!id || !result.ok) return
    byId[id] = sessionDetailView(result.value)
  })
  return { byId, coverage: { wanted: wanted.length, loaded: Object.keys(byId).length } }
}

/** Aggregate a session's handles into one answer. 'supported' wins over an
 *  unknown sibling so one usable locator is reported as usable; a session with
 *  no handle at all is unknown, not unsupported. */
export function resumeSupportOf(detail: DomainSessionDetailResult): ResumeSupport {
  return handlesResumeSupport(detail.handles)
}

/** Resume support for the sessions a view asks about, bounded by `limit`. */
export async function loadResumeSupport(
  sessionIds: string[],
  limit = 20
): Promise<Record<string, ResumeSupport>> {
  const ids = sessionIds.slice(0, limit)
  const results = await Promise.all(ids.map((id) => loadSessionDetail(id)))
  const out: Record<string, ResumeSupport> = {}
  results.forEach((result, index) => {
    const id = ids[index]
    if (!id || !result.ok) return
    out[id] = resumeSupportOf(result.value)
  })
  return out
}
