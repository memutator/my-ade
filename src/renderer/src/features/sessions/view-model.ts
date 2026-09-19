// Canonical session ↔ live registry join — pure view-model, no IPC or store
// access, so the smoke fixtures can run it under plain node.
//
// The identity problem this solves: the store's sessions are keyed by the
// canonical `HarnessSession.id` (`session.<hash>`), while the app's live
// `agentSessions` registry is keyed by the NATIVE session id the harness
// emitted through its hook events. Joining the two maps on one shared key
// silently splits every session into a stored row and a separate "live" row,
// and a click on the stored row can never navigate.
//
// A stored row may claim a live entry only on EXACT identity plus POSITIVE
// stored evidence:
//
//   1. the live key equals the row's `nativeSessionKey` or one of its
//      recorded handle native ids, AND
//   2. the live entry's `provider` equals the row's `harnessId`, AND
//   3. the entry's ws/pane/tab resolves against the ACTUAL workspace tree —
//      a registry claim alone is not evidence, AND
//   4. the row PROVES the same observation: either the live entry carries a
//      qualified namespace equal to the row's, or the row's own stored
//      placement / open-attachment evidence names the live tab or pane.
//      An entry qualified to a DIFFERENT namespace, or stored evidence naming
//      a different pane/tab still present in the tree, denies the claim —
//      that row is a different observation of the same native id (typically
//      a `desktop-legacy:*` placement record next to a live `hook:*` row).
//
// Absence of contradicting evidence is NOT a match: the live registry does
// not record namespaces, so a row with no placement evidence cannot tell a
// same-namespace live session from a same-native-id collision in another
// namespace. Such rows stay stored-only and the entry stands alone as a
// live-only row. What is never evidence: native-id suffixes, cwd equality,
// titles, or namespace similarity.

import type { AgentSessionInfo } from '../../types.ts'
import type { DomainSessionDetailResult } from '../../../../preload/domain.ts'
import type { SessionUsageRowView } from '../usage/view-model.ts'
import type { ResumeSupport, SessionPlacement, StoredSessionRow } from './domain.ts'

/** Minimal workspace shape the join verifies against — the real Workspace is
 *  structurally assignable, fixtures stay small. */
export interface PaneEvidence {
  detached?: boolean
  tabs: readonly { id: string; kind: string }[]
}

export interface WorkspaceEvidence {
  id: string
  panes: Record<string, PaneEvidence>
}

/** A live target that resolved against the real workspace tree. */
export interface LiveTarget {
  wsId: string
  paneId: string
  tabId?: string
  detached?: boolean
}

/** The live registry entry as the join consumes it. `namespace` is not part
 *  of today's AgentSessionInfo — when the event channel stamps it, qualified
 *  entries get an exact namespace join without needing stored evidence. */
export type LiveEntry = AgentSessionInfo & { namespace?: string }

/** One recorded attachment, reduced to what the live join needs. `open` is
 *  the store's own word for "this attachment never observed an end" — not a
 *  liveness assertion on its own. */
export interface SessionAttachmentView {
  paneId?: string
  tabId?: string
  mahasSession?: string
  machineId?: string
  open: boolean
}

/** The bounded `session.get` read, shaped for the panel: resume support plus
 *  the native ids and attachment locations the canonical↔live join consumes. */
export interface SessionDetailView {
  sessionId: string
  /** every native id this session's handles recorded — join keys beyond the
   *  row's own nativeSessionKey */
  nativeIds: string[]
  resumeSupport: ResumeSupport
  attachments: SessionAttachmentView[]
  childSessionIds: string[]
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/** Where a session was observed running, lifted from session metadata. Hook
 *  observations stamp paneId/tabId top-level; the desktop-legacy import nests
 *  them under `placement`. The nested object wins per key; absent means
 *  unrecorded — never synthesized. */
export function placementOfMetadata(
  metadata: Record<string, unknown>
): SessionPlacement | undefined {
  const nested =
    metadata['placement'] && typeof metadata['placement'] === 'object'
      ? (metadata['placement'] as Record<string, unknown>)
      : {}
  const cwd = text(nested['cwd']) ?? text(metadata['cwd'])
  const wsId = text(nested['wsId']) ?? text(metadata['wsId'])
  const paneId = text(nested['paneId']) ?? text(metadata['paneId'])
  const tabId = text(nested['tabId']) ?? text(metadata['tabId'])
  if (!cwd && !wsId && !paneId && !tabId) return undefined
  return {
    ...(cwd ? { cwd } : {}),
    ...(wsId ? { wsId } : {}),
    ...(paneId ? { paneId } : {}),
    ...(tabId ? { tabId } : {})
  }
}

/** Attachment evidence is a verbatim JSON description the ingest wrote
 *  (`{mahasSession, paneId, tabId}`); other sources leave free text. Parse
 *  defensively and keep only string fields — never interpret further. */
export function attachmentView(
  attachment: DomainSessionDetailResult['attachments'][number]
): SessionAttachmentView {
  let paneId: string | undefined
  let tabId: string | undefined
  let mahasSession: string | undefined
  for (const ev of attachment.evidence) {
    if (!ev.description) continue
    try {
      const parsed: unknown = JSON.parse(ev.description)
      if (!parsed || typeof parsed !== 'object') continue
      const record = parsed as Record<string, unknown>
      paneId ??= text(record['paneId'])
      tabId ??= text(record['tabId'])
      mahasSession ??= text(record['mahasSession'])
    } catch {
      // free-text evidence (e.g. the legacy import's placement-only note)
    }
  }
  return {
    ...(paneId ? { paneId } : {}),
    ...(tabId ? { tabId } : {}),
    ...(mahasSession ? { mahasSession } : {}),
    ...(attachment.machineId ? { machineId: attachment.machineId } : {}),
    open: attachment.observedUntil == null
  }
}

/** Aggregate a session's handles into one answer. 'supported' wins over an
 *  unknown sibling so one usable locator is reported as usable; a session with
 *  no handle at all is unknown, not unsupported. */
export function handlesResumeSupport(
  handles: readonly { resumeSupport: ResumeSupport }[]
): ResumeSupport {
  const values = handles.map((handle) => handle.resumeSupport)
  if (!values.length) return 'unknown'
  if (values.includes('supported')) return 'supported'
  if (values.includes('unknown')) return 'unknown'
  return 'unsupported'
}

/** Shape a `session.get` answer for the join: handle native ids are extra
 *  exact-identity keys, open attachments are placement evidence, and the
 *  handle set still answers resume support. */
export function sessionDetailView(detail: DomainSessionDetailResult): SessionDetailView {
  return {
    sessionId: detail.session.id,
    nativeIds: [...new Set(detail.handles.map((handle) => handle.nativeId).filter(Boolean))],
    resumeSupport: handlesResumeSupport(detail.handles),
    attachments: detail.attachments.map(attachmentView),
    childSessionIds: [...detail.childSessionIds]
  }
}

/** The registry entry's claimed location, verified: the workspace exists, the
 *  pane exists in it, and a named tab is still a term tab in that pane. An
 *  entry that fails any step is not live anywhere this app can show. */
export function resolveLiveTarget(
  entry: LiveEntry,
  workspaces: readonly WorkspaceEvidence[]
): LiveTarget | undefined {
  if (!entry.wsId || !entry.paneId) return undefined
  const ws = workspaces.find((w) => w.id === entry.wsId)
  const pane = ws?.panes[entry.paneId]
  if (!ws || !pane || !pane.tabs.some((tab) => tab.kind === 'term')) return undefined
  if (entry.tabId && !pane.tabs.some((tab) => tab.id === entry.tabId && tab.kind === 'term'))
    return undefined
  return {
    wsId: ws.id,
    paneId: entry.paneId,
    ...(entry.tabId ? { tabId: entry.tabId } : {}),
    ...(pane.detached ? { detached: true } : {})
  }
}

interface PlacementEvidence {
  paneId?: string
  tabId?: string
}

/** Every pane/tab the row's own stored evidence names: the metadata placement
 *  (hook events stamp paneId/tabId top-level; the legacy import nests them
 *  under `placement`) plus each OPEN attachment's recorded location. */
function rowEvidence(row: StoredSessionRow, detail?: SessionDetailView): PlacementEvidence[] {
  const out: PlacementEvidence[] = []
  if (row.placement?.paneId || row.placement?.tabId) {
    out.push({
      ...(row.placement.paneId ? { paneId: row.placement.paneId } : {}),
      ...(row.placement.tabId ? { tabId: row.placement.tabId } : {})
    })
  }
  for (const attachment of detail?.attachments ?? []) {
    if (!attachment.open || (!attachment.paneId && !attachment.tabId)) continue
    out.push({
      ...(attachment.paneId ? { paneId: attachment.paneId } : {}),
      ...(attachment.tabId ? { tabId: attachment.tabId } : {})
    })
  }
  return out
}

function paneExists(workspaces: readonly WorkspaceEvidence[], paneId: string): boolean {
  return workspaces.some((ws) => !!ws.panes[paneId])
}

function termTabExists(workspaces: readonly WorkspaceEvidence[], tabId: string): boolean {
  return workspaces.some((ws) =>
    Object.values(ws.panes).some((pane) =>
      pane.tabs.some((tab) => tab.id === tabId && tab.kind === 'term')
    )
  )
}

/** Does this stored row PROVE it observes the same session as the live entry?
 *  'confirm' = a qualified namespace or stored evidence points AT the target,
 *  'contradict' = a different qualified namespace, or stored evidence naming
 *  a different pane/tab that still exists, 'none' = no usable evidence —
 *  which also denies the claim (see the header: absence of contradiction is
 *  not a match). */
function evidenceVerdict(
  row: StoredSessionRow,
  detail: SessionDetailView | undefined,
  entry: LiveEntry,
  target: LiveTarget,
  workspaces: readonly WorkspaceEvidence[]
): 'confirm' | 'contradict' | 'none' {
  if (entry.namespace) return entry.namespace === row.namespace ? 'confirm' : 'contradict'
  for (const ev of rowEvidence(row, detail)) {
    // tab identity wins over pane identity: a dragged tab changes panes, and
    // the attachment's paneId goes stale while the registry stays fresh
    if (ev.tabId) {
      if (target.tabId && ev.tabId === target.tabId) return 'confirm'
      // the record names a DIFFERENT tab: a live tab elsewhere contradicts,
      // and a gone tab still cannot confirm — panes get recycled, so an
      // explicit tabId never falls back to a pane-only match
      if (termTabExists(workspaces, ev.tabId)) return 'contradict'
      continue
    }
    if (ev.paneId) {
      // pane-only evidence (the record carried no tabId): same pane confirms,
      // a different pane still in the tree contradicts
      if (ev.paneId === target.paneId) return 'confirm'
      if (paneExists(workspaces, ev.paneId)) return 'contradict'
      continue
    }
  }
  return 'none'
}

export interface SessionRowView {
  /** react key — canonical id for stored rows, `live:<nativeId>` otherwise */
  key: string
  /** canonical session id when the store backs this row */
  sessionId?: string
  /** live registry key when the row is running in this app */
  liveNativeId?: string
  harnessId: string
  title: string
  cwd?: string
  stored?: StoredSessionRow
  usage?: SessionUsageRowView
  /** resume support — present only when the detail read covered this row */
  resumeSupport?: ResumeSupport
  /** a bounded detail read returned this row */
  detailLoaded: boolean
  parentSessionId?: string
  /** in-page children, sorted by recency */
  children: SessionRowView[]
  /** parent exists but is not in this page — shown with a child chip */
  orphanChild: boolean
  /** children the store knows about (detail read) or this page holds */
  childCount: number
  liveTarget?: LiveTarget
  lastActivity: number
}

export interface JoinSessionsInput {
  stored: readonly StoredSessionRow[]
  usage: readonly SessionUsageRowView[]
  live: Record<string, LiveEntry>
  details?: Record<string, SessionDetailView>
  workspaces: readonly WorkspaceEvidence[]
}

/** Merge the three keyspaces into display rows. Stored and usage rows share
 *  the canonical id; a live entry merges into a stored row only through the
 *  exact-identity rules above, otherwise it stands alone as a live-only row
 *  (a session the store has not collected yet — shown as such, never as a
 *  zero-token session). */
export function joinSessions(input: JoinSessionsInput): SessionRowView[] {
  const { stored, usage, live, workspaces } = input
  const details = input.details ?? {}
  const usageById = new Map(usage.map((row) => [row.sessionId, row]))

  // resolve every registry entry's target once; unresolvable entries are not
  // live anywhere and can neither merge nor stand alone
  const targets = new Map<string, { entry: LiveEntry; target: LiveTarget }>()
  for (const [nativeId, entry] of Object.entries(live)) {
    const target = resolveLiveTarget(entry, workspaces)
    if (target) targets.set(nativeId, { entry, target })
  }

  const rows: SessionRowView[] = []
  const bySessionId = new Map<string, SessionRowView>()
  const claimed = new Set<string>() // live nativeIds owned by a stored row

  for (const row of stored) {
    const detail = details[row.sessionId]
    const nativeIds = new Set<string>([row.nativeSessionKey, ...(detail?.nativeIds ?? [])])
    // a row claims an entry only with a 'confirm' verdict — exact native id,
    // exact harness, and positive stored/namespace evidence for the target.
    // Several rows may confirm the same entry (two stored observations of one
    // running session); every confirming row shows the marker.
    let best: { nativeId: string; target: LiveTarget } | undefined
    for (const nativeId of nativeIds) {
      const candidate = targets.get(nativeId)
      if (!candidate || candidate.entry.provider !== row.harnessId) continue
      if (evidenceVerdict(row, detail, candidate.entry, candidate.target, workspaces) !== 'confirm')
        continue
      best = { nativeId, target: candidate.target }
      break
    }
    if (best) claimed.add(best.nativeId)
    const usageRow = usageById.get(row.sessionId)
    const view: SessionRowView = {
      key: row.sessionId,
      sessionId: row.sessionId,
      harnessId: row.harnessId,
      title: row.title ?? row.sessionId.slice(0, 12),
      ...(row.cwd ? { cwd: row.cwd } : {}),
      stored: row,
      ...(usageRow ? { usage: usageRow } : {}),
      ...(detail ? { resumeSupport: detail.resumeSupport } : {}),
      detailLoaded: !!detail,
      ...(row.parentSessionId ? { parentSessionId: row.parentSessionId } : {}),
      children: [],
      orphanChild: false,
      childCount: detail?.childSessionIds.length ?? 0,
      ...(best ? { liveNativeId: best.nativeId, liveTarget: best.target } : {}),
      lastActivity: row.lastObservedAt
    }
    rows.push(view)
    bySessionId.set(row.sessionId, view)
  }

  // usage rows whose canonical session is not in this page (the list read is
  // bounded) still surface — with usage, never with a fabricated stored row
  for (const usageRow of usage) {
    if (bySessionId.has(usageRow.sessionId)) continue
    const view: SessionRowView = {
      key: usageRow.sessionId,
      sessionId: usageRow.sessionId,
      harnessId: usageRow.harnessId,
      title: usageRow.sessionId.slice(0, 12),
      usage: usageRow,
      detailLoaded: false,
      children: [],
      orphanChild: false,
      childCount: 0,
      lastActivity: usageRow.lastAt ?? 0
    }
    rows.push(view)
    bySessionId.set(usageRow.sessionId, view)
  }

  // live entries no stored row claimed: the store has not collected this
  // session yet — it stands alone as a live-only row
  for (const [nativeId, { entry, target }] of targets) {
    if (claimed.has(nativeId)) continue
    rows.push({
      key: `live:${nativeId}`,
      liveNativeId: nativeId,
      harnessId: entry.provider ?? '',
      title: entry.name ?? nativeId.slice(0, 12),
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      detailLoaded: false,
      children: [],
      orphanChild: false,
      childCount: 0,
      liveTarget: target,
      lastActivity: entry.ts ?? 0
    })
  }

  // hierarchy: children nest under an in-page parent; a child whose parent is
  // outside this page stays a root and carries the orphan marker
  const roots: SessionRowView[] = []
  for (const view of rows) {
    const parent = view.parentSessionId ? bySessionId.get(view.parentSessionId) : undefined
    if (parent) parent.children.push(view)
    else {
      if (view.parentSessionId) view.orphanChild = true
      roots.push(view)
    }
  }
  const byRecency = (a: SessionRowView, b: SessionRowView): number =>
    b.lastActivity - a.lastActivity
  roots.sort(byRecency)
  for (const view of rows) {
    view.children.sort(byRecency)
    if (view.childCount < view.children.length) view.childCount = view.children.length
  }
  return roots
}

/** Which stored rows earn a bounded `session.get` read. Order decides under
 *  the limit: rows whose native key collides with a live registry entry first
 *  (the join needs their attachment evidence), then caller-pinned rows, then
 *  most recently observed. Returns canonical session ids. */
export function selectDetailCandidates(
  rows: readonly StoredSessionRow[],
  options: {
    live?: Record<string, AgentSessionInfo>
    pinned?: readonly string[]
    limit?: number
  } = {}
): string[] {
  const limit = Math.max(0, options.limit ?? 20)
  const live = options.live ?? {}
  const pinned = new Set(options.pinned ?? [])
  const contested = new Set(
    rows
      .filter((row) => live[row.nativeSessionKey]?.provider === row.harnessId)
      .map((row) => row.sessionId)
  )
  const byRecency = [...rows].sort((a, b) => b.lastObservedAt - a.lastObservedAt)
  const ordered: string[] = []
  const push = (id: string): void => {
    if (!ordered.includes(id)) ordered.push(id)
  }
  for (const row of byRecency) if (contested.has(row.sessionId)) push(row.sessionId)
  for (const row of byRecency) if (pinned.has(row.sessionId)) push(row.sessionId)
  for (const row of byRecency) push(row.sessionId)
  return ordered.slice(0, limit)
}
