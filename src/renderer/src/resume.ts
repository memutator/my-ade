// Agent session resume.
//
// Resume is a *domain* read: the daemon's session store owns sessions, handles
// (native id + resume support) and attachments, and this module turns that
// answer into "type this command into that tab".
//
// The desktop's persisted map is legacy input, and it is migrated once:
//
//   · every refresh first calls `session.desktop.import` with the records the
//     store does not know yet (bounded, placement only) and keeps the returned
//     native → canonical mapping;
//   · placement then comes from the store row's metadata (the import writes
//     cwd/wsId/paneId/tabId there) or from that exact mapping — never from a
//     native-id suffix match, and never from another installation's session;
//   · the map itself is only a fallback while the store cannot answer, and a
//     record it still holds is offered at most once, until it is imported.
//
// Ended runs are not offered: a session whose last event is `session-end`, or
// whose store metadata marks it ended, is skipped (the hook commit sets the
// last event kind; the shared detail DTO also preserves attachment end markers).

import { useStore } from './store'
import { agentResumeRecipe, resumeCommand } from './agents'
import type { PaneState, ResumeSession, TerminalTab, Workspace } from './types'
import type { HarnessSession } from '../../../packages/mahas-contracts/src/index.ts'

export type ResumeSupport = 'supported' | 'unknown'

export interface ResumeCandidate {
  rec: ResumeSession
  tab: TerminalTab
  cmd: string
  /** the store answered (or the legacy map did, as a fallback) */
  source: 'domain' | 'desktop-compat'
  /** stored handle identity */
  handleId?: string
  nativeId?: string
  /** the store's verdict for this handle: 'supported' or an honest 'unknown' */
  support: ResumeSupport
}

export interface ResumeDomainState {
  state: 'ready' | 'partial' | 'unavailable'
  diagnostics: string[]
  sessions: number
  candidates: number
  /** legacy records handed to session.desktop.import on this read */
  imported: number
  asOf: number
}

export const DESKTOP_IMPORT_OPERATION = 'session.desktop.import'

// pty session ids with a running process right now (spawned/attached add,
// exit removes). Resume writes only into live sessions; commands for tabs whose
// shell hasn't spawned yet (a detached window still booting) wait here.
const live = new Set<string>()
const pending = new Map<string, string>()
let quitting = false

function tabIdOf(ptyId: string): string | undefined {
  return ptyId.split(':')[1] || undefined
}

function dropForPty(ptyId: string): void {
  const tabId = tabIdOf(ptyId)
  if (tabId) useStore.getState().dropResumeWhere((r) => r.tabId === tabId)
}

export function initResumeTracking(): () => void {
  const off = window.mahas.pty.onEvent((e) => {
    if (e.t === 'spawned' || e.t === 'attached') {
      live.add(e.id)
      const cmd = pending.get(e.id)
      if (cmd) {
        pending.delete(e.id)
        // let the fresh shell reach its prompt before the command lands
        setTimeout(() => window.mahas.pty.write(e.id, cmd + '\r'), 350)
      }
      // TerminalTabView patches its PTY after this listener. Re-read after
      // that patch so an early empty cache cannot hide newly attachable tabs.
      queueMicrotask(() => {
        void refreshResumeCandidates()
      })
    } else if (e.t === 'exit') {
      live.delete(e.id)
      pending.delete(e.id)
      if (!quitting) dropForPty(e.id)
    } else if (e.t === 'agent' && !e.agent && !quitting) {
      dropForPty(e.id)
    }
  })
  const onUnload = (): void => {
    quitting = true
  }
  window.addEventListener('beforeunload', onUnload)
  const unsubscribe = useStore.subscribe((state, previous) => {
    if (state.activeWorkspaceId && state.activeWorkspaceId !== previous.activeWorkspaceId) {
      void refreshResumeCandidates(state.activeWorkspaceId)
    }
  })
  void refreshResumeCandidates()
  return () => {
    off()
    window.removeEventListener('beforeunload', onUnload)
    unsubscribe()
  }
}

/* --------------------------------------------------------------- domain read */

const CACHE_MS = 15_000
const domainCache = new Map<string, { candidates: ResumeCandidate[]; at: number }>()
const resumeListeners = new Set<() => void>()
let resumeVersion = 0
let refreshing: Promise<ResumeDomainState> | null = null

export function subscribeResume(listener: () => void): () => void {
  resumeListeners.add(listener)
  return () => {
    resumeListeners.delete(listener)
  }
}

export function resumeSnapshotVersion(): number {
  return resumeVersion
}
let domainState: ResumeDomainState = {
  state: 'unavailable',
  diagnostics: ['the session store has not been read yet'],
  sessions: 0,
  candidates: 0,
  imported: 0,
  asOf: 0
}

export function resumeDomainState(): ResumeDomainState {
  return domainState
}

function metadataOf(session: HarnessSession): Record<string, unknown> {
  return (session.metadata ?? {}) as Record<string, unknown>
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** A run the user must not be offered: ended, subagent, internal or foreign. */
function notResumable(session: HarnessSession, lastEventKind?: string | null): string | null {
  const meta = metadataOf(session)
  if (meta.child === true) return 'child run'
  if (meta.internalRun === true) return 'internal thread'
  // the hook commit writes `externalRun`; older rows may carry `external`
  if (meta.externalRun === true || meta.external === true) return 'foreign run'
  const policy = record(meta.policy)
  if (policy.demote === true || policy.stripSession === true) return 'policy excluded'
  if (meta.ended === true) return 'ended'
  if (lastEventKind === 'session-end') return 'session-end observed'
  return null
}

/** native id → canonical id, as returned by the one-time desktop import. */
interface LegacyMapping {
  sessionId: string
  harnessId: string
  handleId?: string
  placement: { cwd?: string; wsId?: string; paneId?: string; tabId?: string }
}
const legacyMappings = new Map<string, LegacyMapping>()
const importedIds = new Set<string>()
let importMarker: { version: number; at: number } | null = null

function mappingKey(harnessId: string, nativeId: string): string {
  return harnessId + '\u0000' + nativeId
}

/**
 * Import the desktop records the store does not know yet. The import is
 * placement-only and idempotent, so a repeated call is harmless; failures are
 * reported and the read still runs (the map stays usable for placement).
 */
async function importLegacyRecords(
  st: ReturnType<typeof useStore.getState>
): Promise<{ imported: number; diagnostics: string[] }> {
  const api = window.mahas.exec
  const records = Object.values(st.resumeSessions)
    .filter((rec) => !importedIds.has(mappingKey(rec.provider, rec.sessionId)))
    .slice(0, 200)
    .map((rec) => ({
      nativeSessionId: rec.sessionId,
      harnessId: rec.provider,
      ...(rec.cwd ? { cwd: rec.cwd } : {}),
      wsId: rec.wsId,
      paneId: rec.paneId,
      tabId: rec.tabId,
      observedAt: rec.ts,
      ...(rec.shutdown ? { shutdown: rec.shutdown } : {})
    }))
  if (!api?.op || !records.length) return { imported: 0, diagnostics: [] }
  const result = await api.op({
    operation: DESKTOP_IMPORT_OPERATION,
    operationId: 'desktop-import-' + crypto.randomUUID(),
    payload: { records }
  })
  if (!result.ok) return { imported: 0, diagnostics: ['desktop import: ' + result.error.message] }
  const value = record(result.value)
  const mappings = Array.isArray(value.mappings) ? value.mappings : []
  for (const entry of mappings) {
    const row = record(entry)
    const nativeId = text(row.nativeSessionId)
    const harnessId = text(row.harnessId)
    const sessionId = text(row.sessionId)
    if (!nativeId || !harnessId || !sessionId) continue
    legacyMappings.set(mappingKey(harnessId, nativeId), {
      sessionId,
      harnessId,
      ...(text(row.handleId) ? { handleId: text(row.handleId) } : {}),
      placement: record(row.placement) as LegacyMapping['placement']
    })
    importedIds.add(mappingKey(harnessId, nativeId))
  }
  importMarker = { version: 1, at: Date.now() }
  const diagnostics = (Array.isArray(value.diagnostics) ? value.diagnostics : [])
    .map((entry) => text(record(entry).message))
    .filter((message): message is string => Boolean(message))
  return { imported: mappings.length, diagnostics }
}

/**
 * Read the stored sessions and build resume candidates. Returns the store
 * verdict so a caller can show "unavailable" instead of silently falling back.
 */
export function refreshResumeCandidates(wsId?: string): Promise<ResumeDomainState> {
  if (refreshing) return refreshing
  refreshing = readResumeCandidates(wsId).finally(() => {
    refreshing = null
    resumeVersion++
    for (const listener of resumeListeners) listener()
  })
  return refreshing
}

async function readResumeCandidates(wsId?: string): Promise<ResumeDomainState> {
  const st = useStore.getState()
  const targetWs = wsId ?? st.activeWorkspaceId ?? undefined
  const api = window.mahas.domain
  if (!api?.sessions || !api.sessionDetail) {
    domainState = {
      state: 'unavailable',
      diagnostics: ['the domain session API is not exposed by this build'],
      sessions: 0,
      candidates: 0,
      imported: 0,
      asOf: Date.now()
    }
    return domainState
  }

  const migration = await importLegacyRecords(st)
  const listed = await api.sessions({ rootsOnly: true, limit: 200 })
  if (!listed.ok) {
    domainState = {
      state: 'unavailable',
      diagnostics: [listed.error.message, ...migration.diagnostics],
      sessions: 0,
      candidates: 0,
      imported: migration.imported,
      asOf: Date.now()
    }
    return domainState
  }

  const diagnostics: string[] = [...listed.value.readiness.diagnostics, ...migration.diagnostics]
  const sessions = listed.value.items.filter((session) => {
    const reason = notResumable(session)
    if (reason) {
      diagnostics.push(session.id + ' skipped: ' + reason)
      return false
    }
    return true
  })

  // placement first: only a session whose pane/tab resolves to a live terminal
  // can become a candidate, and resolving the pane is what tells us the
  // workspace it now lives in (a record's wsId may be stale)
  const placed: {
    session: HarnessSession
    pane: PaneState
    ws: Workspace
    tab: TerminalTab
    placement: LegacyMapping['placement']
  }[] = []
  const current = useStore.getState()
  for (const session of sessions) {
    const spot = locate(session, current)
    if (spot) placed.push({ session, ...spot })
  }

  const candidates: ResumeCandidate[] = []
  const chunk = 6
  for (let index = 0; index < placed.length; index += chunk) {
    const slice = placed.slice(index, index + chunk)
    const details = await Promise.all(slice.map((entry) => api.sessionDetail(entry.session.id)))
    details.forEach((detail, offset) => {
      const entry = slice[offset]!
      if (!detail.ok) {
        diagnostics.push(entry.session.id + ': ' + detail.error.message)
        return
      }
      const ended =
        notResumable(detail.value.session, detail.value.lastEventKind) ??
        (detail.value.attachments.length > 0 &&
        detail.value.attachments.every((attachment) => attachment.observedUntil != null)
          ? 'all observed attachments ended'
          : null)
      if (ended) {
        diagnostics.push(entry.session.id + ' skipped: ' + ended)
        return
      }
      const handle = detail.value.handles.find(
        (row) => row.nativeId && row.resumeSupport !== 'unsupported'
      )
      if (!handle) {
        diagnostics.push(entry.session.id + ' has no resumable handle')
        return
      }
      const candidate = buildCandidate(current, entry, handle)
      if (candidate) candidates.push(candidate)
    })
  }

  const ordered = orderCandidates(candidates)
  const byWorkspace = new Map<string, ResumeCandidate[]>()
  for (const candidate of ordered) {
    const list = byWorkspace.get(candidate.rec.wsId) ?? []
    list.push(candidate)
    byWorkspace.set(candidate.rec.wsId, list)
  }
  const now = Date.now()
  for (const [workspaceId, list] of byWorkspace)
    domainCache.set(workspaceId, { candidates: list, at: now })
  if (targetWs && !byWorkspace.has(targetWs)) domainCache.set(targetWs, { candidates: [], at: now })
  domainState = {
    state: diagnostics.length ? 'partial' : 'ready',
    diagnostics,
    sessions: sessions.length,
    candidates: targetWs ? (byWorkspace.get(targetWs)?.length ?? 0) : ordered.length,
    imported: migration.imported,
    asOf: listed.value.asOf || now
  }
  return domainState
}

/** Pane/tab for a session, resolved across every workspace. */
function locate(
  session: HarnessSession,
  st: ReturnType<typeof useStore.getState>
): {
  pane: PaneState
  ws: Workspace
  tab: TerminalTab
  placement: LegacyMapping['placement']
} | null {
  const meta = metadataOf(session)
  const storedPlacement = record(meta.placement)
  const registered = legacyMappings.get(mappingKey(session.harnessId, session.nativeSessionKey))
  const mapping = registered?.sessionId === session.id ? registered : undefined
  // Placement-only imports are history, not independent liveness evidence.
  // Only a record accepted from THIS boot's saved resume set may revive one.
  // In particular a later genuine session-end must not leave an old alias
  // offering that conversation forever after its desktop record was removed.
  if (meta.placementOnly === true && !mapping) return null
  const placement: LegacyMapping['placement'] = {
    ...(text(storedPlacement.cwd) ? { cwd: text(storedPlacement.cwd) } : {}),
    ...(text(storedPlacement.wsId) ? { wsId: text(storedPlacement.wsId) } : {}),
    ...(text(storedPlacement.paneId) ? { paneId: text(storedPlacement.paneId) } : {}),
    ...(text(storedPlacement.tabId) ? { tabId: text(storedPlacement.tabId) } : {}),
    ...(mapping?.placement ?? {})
  }
  const paneId = text(storedPlacement.paneId) ?? text(meta.paneId) ?? mapping?.placement.paneId
  const tabId = text(storedPlacement.tabId) ?? text(meta.tabId) ?? mapping?.placement.tabId
  if (!paneId) return null
  for (const ws of st.workspaces) {
    const pane = ws.panes[paneId]
    if (!pane) continue
    const tab = tabId
      ? pane.tabs.find((t): t is TerminalTab => t.id === tabId && t.kind === 'term')
      : pane.tabs.find((t): t is TerminalTab => t.kind === 'term')
    if (!tab || tab.exited || !tab.pty || tab.agent) continue
    return { pane, ws, tab, placement }
  }
  return null
}

function buildCandidate(
  st: ReturnType<typeof useStore.getState>,
  entry: {
    session: HarnessSession
    pane: PaneState
    ws: Workspace
    tab: TerminalTab
    placement: LegacyMapping['placement']
  },
  handle: { id: string; nativeId: string; resumeSupport: 'supported' | 'unsupported' | 'unknown' }
): ResumeCandidate | null {
  const harnessId = entry.session.harnessId
  if (st.settings.providers[harnessId] === false) return null
  if (!agentResumeRecipe(harnessId)) return null
  const cmd = resumeCommand(harnessId, handle.nativeId)
  if (!cmd) return null
  const cwd = entry.placement.cwd ?? entry.tab.cwd
  const full = cwd ? `cd '${cwd.replace(/'/g, `'\\''`)}' && ${cmd}` : cmd
  return {
    rec: {
      sessionId: handle.nativeId,
      provider: harnessId,
      cwd,
      wsId: entry.ws.id,
      paneId: entry.pane.id,
      tabId: entry.tab.id,
      ts: entry.session.lastObservedAt
    },
    tab: entry.tab,
    cmd: full,
    source: 'domain',
    handleId: handle.id,
    nativeId: handle.nativeId,
    support: handle.resumeSupport === 'supported' ? 'supported' : 'unknown'
  }
}

function orderCandidates(candidates: ResumeCandidate[]): ResumeCandidate[] {
  const byTab = new Map<string, ResumeCandidate>()
  for (const candidate of candidates) {
    const previous = byTab.get(candidate.rec.tabId)
    if (!previous || candidate.rec.ts > previous.rec.ts) byTab.set(candidate.rec.tabId, candidate)
  }
  return [...byTab.values()].sort((a, b) => a.rec.ts - b.rec.ts)
}

/* ------------------------------------------------- compatibility fallback */

/**
 * Candidates from the desktop's persisted map — the fallback while the store
 * cannot answer. A record the store already holds (imported) is skipped: the
 * store row is the marker, and its own candidate is authoritative.
 */
export function compatResumeCandidates(
  st: ReturnType<typeof useStore.getState>,
  wsId: string
): ResumeCandidate[] {
  const ws = st.workspaces.find((w) => w.id === wsId)
  if (!ws) return []
  const byTab = new Map<string, ResumeCandidate>()
  for (const rec of Object.values(st.resumeSessions)) {
    if (rec.wsId !== wsId) continue
    if (importedIds.has(mappingKey(rec.provider, rec.sessionId))) continue
    const pane = ws.panes[rec.paneId]
    if (!pane) continue
    const tab = pane.tabs.find((t): t is TerminalTab => t.id === rec.tabId && t.kind === 'term')
    if (!tab || tab.exited || !tab.pty || tab.agent) continue
    if (st.settings.providers[rec.provider] === false) continue
    const cmd = resumeCommand(rec.provider, rec.sessionId)
    if (!cmd) continue
    const full = rec.cwd ? `cd '${rec.cwd.replace(/'/g, `'\\''`)}' && ${cmd}` : cmd
    const previous = byTab.get(tab.id)
    if (!previous || rec.ts > previous.rec.ts) {
      byTab.set(tab.id, {
        rec,
        tab,
        cmd: full,
        source: 'desktop-compat',
        nativeId: rec.sessionId,
        support: 'unknown'
      })
    }
  }
  return orderCandidates([...byTab.values()])
}

/**
 * One-time import view: which desktop records the store holds (imported — the
 * canonical session row is the marker) and which are still only in the map. The
 * state owner can persist `marker` so the split survives a restart.
 */
export function resumeImportState(st: ReturnType<typeof useStore.getState>): {
  marker: { version: number; at: number } | null
  imported: string[]
  pending: string[]
  mappings: { harnessId: string; nativeSessionId: string; sessionId: string }[]
} {
  return {
    marker: importMarker,
    imported: [...importedIds].map((key) => key.split('\u0000')[1] ?? key),
    pending: Object.values(st.resumeSessions)
      .filter((rec) => !importedIds.has(mappingKey(rec.provider, rec.sessionId)))
      .map((rec) => rec.sessionId),
    mappings: [...legacyMappings.entries()].map(([key, mapping]) => ({
      harnessId: key.split('\u0000')[0] ?? mapping.harnessId,
      nativeSessionId: key.split('\u0000')[1] ?? '',
      sessionId: mapping.sessionId
    }))
  }
}

/**
 * One-time import plan for the desktop's persisted records: exactly the fields
 * the import operation consumes, so a caller (or a state migration) never has to
 * re-derive them from the map.
 */
export function legacyResumeImportPlan(st: ReturnType<typeof useStore.getState>): {
  marker: { version: number; at: number } | null
  imported: string[]
  pending: string[]
  records: ResumeSession[]
} {
  const state = resumeImportState(st)
  return {
    marker: state.marker,
    imported: state.imported,
    pending: state.pending,
    records: state.pending.flatMap((id) => {
      const record = Object.values(st.resumeSessions).find((entry) => entry.sessionId === id)
      return record ? [record] : []
    })
  }
}

/* ------------------------------------------------------------------ public */

/**
 * Candidates for a workspace: the store read when it has answered, else the
 * desktop map. A stale store answer is refreshed in the background instead of
 * silently swapping the source back to the map.
 */
export function resumeCandidates(
  st: ReturnType<typeof useStore.getState>,
  wsId: string
): ResumeCandidate[] {
  const cached = domainCache.get(wsId)
  if (cached) {
    if (Date.now() - cached.at > CACHE_MS) void refreshResumeCandidates(wsId)
    return cached.candidates
  }
  return compatResumeCandidates(st, wsId)
}

// type each resume command into its tab's shell and bring the tab forward.
// Store-backed candidates stay in the store until their session ends (its own
// session-end event or the pty exit prunes them); the desktop record is consumed
// either way, and the resumed session re-registers through its own hook events.
export function resumeWorkspaceSessions(wsId: string): number {
  const st = useStore.getState()
  const cands = resumeCandidates(st, wsId)
  const panes = new Map<string, string>() // paneId → first resumed tabId
  let n = 0
  for (const c of cands) {
    const pty = c.tab.pty
    if (!pty) continue
    if (live.has(pty)) window.mahas.pty.write(pty, c.cmd + '\r')
    else pending.set(pty, c.cmd) // drained by the tab's own spawned event
    if (!panes.has(c.rec.paneId)) panes.set(c.rec.paneId, c.rec.tabId)
    st.dropResumeSession(c.rec.sessionId)
    n++
  }
  for (const [paneId, tabId] of panes) {
    st.updatePane(paneId, { activeTabId: tabId }, wsId)
  }
  return n
}

// display name for the candidate row — session rename, tab title, else the id
export function candidateName(rec: ResumeSession, tab: TerminalTab): string {
  const reg = useStore.getState().agentSessions[rec.sessionId]
  return reg?.name ?? tab.title ?? rec.sessionId
}

export function resumeSupported(provider: string): boolean {
  // a resume recipe is Pack data now (builtin.harness-runtime); the legacy
  // manifest pair is accepted as a fallback by agentResumeRecipe
  return !!agentResumeRecipe(provider)
}
