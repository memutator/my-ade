// view-model.smoke.ts — canonical↔live join fixtures: exact identity,
// namespace collisions, positive-evidence requirement, hierarchy, and the
// bounded detail-candidate order.
//
// Run:  node src/renderer/src/features/sessions/view-model.smoke.ts
//
// Synthetic-only: plain in-memory rows — no store, no IPC, no filesystem.

import assert from 'node:assert/strict'
import type { DomainSessionDetailResult } from '../../../../preload/domain.ts'
import type { SessionUsageRowView } from '../usage/view-model.ts'
import type { StoredSessionRow } from './domain.ts'
import {
  attachmentView,
  handlesResumeSupport,
  joinSessions,
  placementOfMetadata,
  resolveLiveTarget,
  selectDetailCandidates,
  sessionDetailView,
  type LiveEntry,
  type SessionDetailView,
  type WorkspaceEvidence
} from './view-model.ts'

// ── fixture builders ───────────────────────────────────────────────────────

function ws(id: string, panes: WorkspaceEvidence['panes']): WorkspaceEvidence {
  return { id, panes }
}

function stored(partial: Partial<StoredSessionRow> & { sessionId: string }): StoredSessionRow {
  return {
    harnessId: 'codex',
    namespace: 'hook:src1:codex',
    nativeSessionKey: 'native-1',
    firstObservedAt: 100,
    lastObservedAt: 200,
    ...partial
  }
}

function detail(partial: Partial<SessionDetailView> & { sessionId: string }): SessionDetailView {
  return {
    nativeIds: [],
    resumeSupport: 'unknown',
    attachments: [],
    childSessionIds: [],
    ...partial
  }
}

function liveEntry(partial: LiveEntry): LiveEntry {
  return { provider: 'codex', ...partial }
}

function usageRow(sessionId: string, harnessId = 'codex'): SessionUsageRowView {
  return {
    sessionId,
    harnessId,
    totals: {
      inputTotal: 10,
      outputTotal: 4,
      total: 14,
      cacheReadInput: 6,
      cacheWriteInput: null,
      reasoningOutput: null
    },
    unknownComponents: [],
    partialComponents: [],
    entryCount: 2,
    unresolvedCount: 0,
    duplicateCount: 0,
    supersededCount: 0,
    timeUnknownCount: 0
  }
}

const TREE: WorkspaceEvidence[] = [
  ws('ws1', {
    pLive: { tabs: [{ id: 'tLive', kind: 'term' }] },
    pOld: { tabs: [{ id: 'tOld', kind: 'term' }] },
    pWeb: { tabs: [{ id: 'tWeb', kind: 'web' }] },
    pDet: { detached: true, tabs: [{ id: 'tDet', kind: 'term' }] }
  })
]

const LIVE_TARGET = { wsId: 'ws1', paneId: 'pLive', tabId: 'tLive' }

// ── resolveLiveTarget: actual tree evidence only ───────────────────────────

assert.equal(
  resolveLiveTarget(liveEntry(LIVE_TARGET), TREE)?.paneId,
  'pLive',
  'resolves a real ws/pane/tab'
)
assert.equal(
  resolveLiveTarget(liveEntry({ wsId: 'ws1', paneId: 'pLive', tabId: 'tWeb' }), TREE),
  undefined,
  'a web tab is not a session target'
)
assert.equal(
  resolveLiveTarget(liveEntry({ wsId: 'ws1', paneId: 'pGone' }), TREE),
  undefined,
  'missing pane: not live anywhere'
)
assert.equal(
  resolveLiveTarget(liveEntry({ wsId: 'ws9', paneId: 'pLive' }), TREE),
  undefined,
  'missing workspace: not live anywhere'
)
assert.equal(
  resolveLiveTarget(liveEntry({ wsId: 'ws1', paneId: 'pDet', tabId: 'tDet' }), TREE)?.detached,
  true,
  'detached panes resolve and carry the flag'
)

// ── exact join: identity + positive stored evidence ────────────────────────

{
  const rows = joinSessions({
    stored: [stored({ sessionId: 'session.A' })],
    usage: [usageRow('session.A')],
    live: { 'native-1': liveEntry(LIVE_TARGET) },
    details: {
      'session.A': detail({
        sessionId: 'session.A',
        attachments: [{ ...LIVE_TARGET, paneId: 'pLive', tabId: 'tLive', open: true }]
      })
    },
    workspaces: TREE
  })
  assert.equal(rows.length, 1, 'stored row and live entry merge into one row')
  assert.equal(rows[0]?.liveNativeId, 'native-1', 'the row claims the live registry key')
  assert.deepEqual(
    rows[0]?.liveTarget,
    { wsId: 'ws1', paneId: 'pLive', tabId: 'tLive' },
    'the navigation target is the verified live pane/tab'
  )
  assert.equal(rows[0]?.usage?.entryCount, 2, 'stored usage rides the same row')
}

// positive evidence from the metadata placement (no detail read needed) — the
// resumed legacy row whose recorded placement IS the live tab
{
  const rows = joinSessions({
    stored: [
      stored({
        sessionId: 'session.leg',
        namespace: 'desktop-legacy:m1',
        placement: { paneId: 'pLive', tabId: 'tLive' }
      })
    ],
    usage: [],
    live: { 'native-1': liveEntry(LIVE_TARGET) },
    workspaces: TREE
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.liveNativeId, 'native-1', 'exact stored tab match confirms')
}

// pane-only stored evidence confirms (the record carried no tabId)
{
  const rows = joinSessions({
    stored: [
      stored({
        sessionId: 'session.leg',
        namespace: 'desktop-legacy:m1',
        placement: { paneId: 'pLive' }
      })
    ],
    usage: [],
    live: { 'native-1': liveEntry(LIVE_TARGET) },
    workspaces: TREE
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.liveNativeId, 'native-1', 'pane-only evidence confirms')
}

// an explicit stored tabId that differs never falls back to the pane: the
// recorded tab is gone and panes get recycled — no positive proof remains
{
  const rows = joinSessions({
    stored: [
      stored({
        sessionId: 'session.leg',
        namespace: 'desktop-legacy:m1',
        placement: { paneId: 'pLive', tabId: 'tStale' }
      })
    ],
    usage: [],
    live: { 'native-1': liveEntry(LIVE_TARGET) },
    workspaces: TREE
  })
  const leg = rows.find((row) => row.sessionId === 'session.leg')
  const liveRow = rows.find((row) => row.key === 'live:native-1')
  assert.ok(leg && !leg.liveTarget, 'a differing stored tabId denies the pane fallback')
  assert.ok(liveRow?.liveTarget, 'the live entry stands alone')
}

// ── no-evidence same-native different-namespace regression ─────────────────
// A stored row whose native key collides with a live entry but which carries
// NO placement evidence cannot tell a same-namespace live session from a
// cross-namespace collision — it must not claim the marker.
{
  const rows = joinSessions({
    stored: [stored({ sessionId: 'session.leg', namespace: 'desktop-legacy:m1' })],
    usage: [],
    live: { 'native-1': liveEntry(LIVE_TARGET) },
    workspaces: TREE
  })
  assert.equal(rows.length, 2, 'unproven collision splits: stored row + live-only row')
  const storedRow = rows.find((row) => row.sessionId === 'session.leg')
  const liveRow = rows.find((row) => row.key === 'live:native-1')
  assert.ok(storedRow && !storedRow.liveTarget, 'the stored row stays stored-only')
  assert.ok(liveRow?.liveTarget, 'the entry stands alone as a live-only row')
}

// ── namespace collision with contradicting evidence ─────────────────────────
// The legacy row's own placement names a different pane that still exists —
// contradiction, not just absence of proof.
{
  const rows = joinSessions({
    stored: [
      stored({
        sessionId: 'session.leg',
        namespace: 'desktop-legacy:m1',
        placement: { paneId: 'pOld', tabId: 'tOld' }
      }),
      stored({ sessionId: 'session.hook' })
    ],
    usage: [],
    live: { 'native-1': liveEntry(LIVE_TARGET) },
    details: {
      'session.hook': detail({
        sessionId: 'session.hook',
        attachments: [{ paneId: 'pLive', tabId: 'tLive', open: true }]
      }),
      'session.leg': detail({
        sessionId: 'session.leg',
        attachments: [{ machineId: 'm1', open: true }]
      })
    },
    workspaces: TREE
  })
  const leg = rows.find((row) => row.sessionId === 'session.leg')
  const hook = rows.find((row) => row.sessionId === 'session.hook')
  assert.ok(hook?.liveTarget, 'the hook row proves the live session and joins')
  assert.ok(leg && !leg.liveTarget, 'the legacy row contradicts and stays stored-only')
  assert.equal(
    rows.filter((row) => row.liveTarget).length,
    1,
    'exactly one row carries the live marker'
  )
}

// harness mismatch: exact provider equality is part of identity
{
  const rows = joinSessions({
    stored: [stored({ sessionId: 'session.A', harnessId: 'claude' })],
    usage: [],
    live: { 'native-1': liveEntry({ ...LIVE_TARGET, provider: 'codex' }) },
    workspaces: TREE
  })
  const storedRow = rows.find((row) => row.sessionId === 'session.A')
  const liveRow = rows.find((row) => row.key === 'live:native-1')
  assert.ok(storedRow && !storedRow.liveTarget, 'different harness never joins')
  assert.ok(liveRow?.liveTarget, 'the live entry stands alone')
}

// qualified namespace on the live entry: exact namespace match joins without
// stored evidence; a different namespace denies even with matching native id
{
  const rows = joinSessions({
    stored: [
      stored({ sessionId: 'session.hook', namespace: 'hook:src1:codex' }),
      stored({ sessionId: 'session.leg', namespace: 'desktop-legacy:m1' })
    ],
    usage: [],
    live: {
      'native-1': liveEntry({ ...LIVE_TARGET, namespace: 'hook:src1:codex' })
    },
    workspaces: TREE
  })
  const hook = rows.find((row) => row.sessionId === 'session.hook')
  const leg = rows.find((row) => row.sessionId === 'session.leg')
  assert.ok(hook?.liveTarget, 'qualified namespace match joins')
  assert.ok(leg && !leg.liveTarget, 'different qualified namespace denies')
  assert.equal(rows.length, 2, 'no live-only row: the entry was claimed')
}

// stale registry: a live entry pointing at a gone pane joins nothing and does
// not render as a live row either
{
  const rows = joinSessions({
    stored: [stored({ sessionId: 'session.A' })],
    usage: [],
    live: { 'native-1': liveEntry({ wsId: 'ws1', paneId: 'pGone' }) },
    details: {
      'session.A': detail({
        sessionId: 'session.A',
        attachments: [{ paneId: 'pLive', tabId: 'tLive', open: true }]
      })
    },
    workspaces: TREE
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.liveTarget, undefined, 'a dead target is not live')
}

// handle native ids are extra join keys beyond the row's own nativeSessionKey
{
  const rows = joinSessions({
    stored: [stored({ sessionId: 'session.A', nativeSessionKey: 'native-file' })],
    usage: [],
    live: { 'native-hook': liveEntry(LIVE_TARGET) },
    details: {
      'session.A': detail({
        sessionId: 'session.A',
        nativeIds: ['native-hook'],
        attachments: [{ paneId: 'pLive', tabId: 'tLive', open: true }]
      })
    },
    workspaces: TREE
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.liveNativeId, 'native-hook', 'a handle native id joins exactly')
}

// ── hierarchy: children nest in-page, orphans are marked ────────────────────

{
  const rows = joinSessions({
    stored: [
      stored({ sessionId: 'session.parent', lastObservedAt: 300 }),
      stored({ sessionId: 'session.kid', parentSessionId: 'session.parent', lastObservedAt: 400 }),
      stored({
        sessionId: 'session.orphan',
        parentSessionId: 'session.absent',
        lastObservedAt: 500
      })
    ],
    usage: [],
    live: {},
    details: {
      'session.parent': detail({
        sessionId: 'session.parent',
        childSessionIds: ['session.kid', 'session.offpage']
      })
    },
    workspaces: TREE
  })
  const parent = rows.find((row) => row.sessionId === 'session.parent')
  const orphan = rows.find((row) => row.sessionId === 'session.orphan')
  assert.equal(rows.length, 2, 'the in-page child nests under its parent')
  assert.equal(parent?.children[0]?.sessionId, 'session.kid')
  assert.equal(parent?.childCount, 2, 'detail reports children beyond the page')
  assert.equal(orphan?.orphanChild, true, 'a child whose parent is off-page is marked')
}

// usage rows for sessions outside the stored page still surface
{
  const rows = joinSessions({
    stored: [],
    usage: [usageRow('session.offpage')],
    live: {},
    workspaces: TREE
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.sessionId, 'session.offpage')
  assert.equal(rows[0]?.stored, undefined, 'no fabricated stored row')
}

// ── selectDetailCandidates: contested → pinned → recency, bounded ───────────

{
  const rows = [
    stored({ sessionId: 's.old', lastObservedAt: 100 }),
    stored({ sessionId: 's.live', nativeSessionKey: 'native-live', lastObservedAt: 50 }),
    stored({ sessionId: 's.pin', lastObservedAt: 10 }),
    stored({ sessionId: 's.new', lastObservedAt: 200 })
  ]
  const picked = selectDetailCandidates(rows, {
    live: { 'native-live': liveEntry({ provider: 'codex' }) },
    pinned: ['s.pin'],
    limit: 3
  })
  assert.deepEqual(
    picked,
    ['s.live', 's.pin', 's.new'],
    'live-collision first, then pinned, then recency — bounded'
  )
  // a live entry for another harness does not make the row contested
  const none = selectDetailCandidates(rows, {
    live: { 'native-live': liveEntry({ provider: 'claude' }) },
    limit: 2
  })
  assert.deepEqual(none, ['s.new', 's.old'], 'no contest: pure recency order')
}

// ── wire→view shaping ───────────────────────────────────────────────────────

assert.deepEqual(
  placementOfMetadata({
    paneId: 'pTop',
    tabId: 'tTop',
    placement: { paneId: 'pNested', cwd: '/x' }
  }),
  { paneId: 'pNested', tabId: 'tTop', cwd: '/x' },
  'nested placement wins per key; top-level event fields fill the rest'
)
assert.equal(placementOfMetadata({}), undefined, 'no placement is recorded as none')

{
  const raw: DomainSessionDetailResult = {
    session: {
      id: 'session.A',
      harnessId: 'codex',
      namespace: 'hook:src1:codex',
      nativeSessionKey: 'native-1',
      firstObservedAt: 1,
      lastObservedAt: 2,
      metadata: {}
    },
    handles: [
      {
        id: 'h1',
        sessionId: 'session.A',
        nativeId: 'native-1',
        resumeSupport: 'supported',
        observedAt: 1,
        evidence: []
      },
      {
        id: 'h2',
        sessionId: 'session.A',
        nativeId: 'native-1',
        resumeSupport: 'unknown',
        observedAt: 1,
        evidence: []
      }
    ],
    attachments: [
      {
        id: 'a1',
        sessionId: 'session.A',
        machineId: 'm1',
        observedFrom: 1,
        observedUntil: null,
        evidence: [
          { description: JSON.stringify({ mahasSession: 'ms', paneId: 'pLive', tabId: 'tLive' }) },
          { description: 'desktop legacy resume record (placement only)' }
        ]
      },
      {
        id: 'a2',
        sessionId: 'session.A',
        machineId: 'm1',
        observedFrom: 1,
        observedUntil: 5,
        evidence: [{ description: '{not json' }]
      }
    ],
    childSessionIds: ['session.kid'],
    asOf: 3,
    attachmentCount: 2
  }
  const view = sessionDetailView(raw)
  assert.deepEqual(view.nativeIds, ['native-1'], 'handle native ids dedup')
  assert.equal(view.resumeSupport, 'supported', 'supported wins over unknown')
  assert.deepEqual(view.attachments[0], {
    paneId: 'pLive',
    tabId: 'tLive',
    mahasSession: 'ms',
    machineId: 'm1',
    open: true
  })
  assert.equal(view.attachments[1]?.open, false, 'ended attachment is not open')
  assert.deepEqual(view.childSessionIds, ['session.kid'])
}

assert.equal(handlesResumeSupport([]), 'unknown', 'no handle is unknown, not unsupported')
assert.equal(
  handlesResumeSupport([{ resumeSupport: 'unsupported' }, { resumeSupport: 'unknown' }]),
  'unknown',
  'unknown outranks unsupported'
)
assert.equal(
  attachmentView({
    id: 'a',
    sessionId: 's',
    machineId: 'm',
    observedFrom: 0,
    observedUntil: 1,
    evidence: [{ description: 'free text' }]
  }).open,
  false
)

assert.equal(
  resolveLiveTarget(liveEntry({ wsId: 'ws1', paneId: 'fileOnly' }), [
    { id: 'ws1', panes: { fileOnly: { tabs: [{ id: 'f', kind: 'file' }] } } }
  ]),
  undefined,
  'pane-only live evidence requires a terminal in the actual target'
)

console.log('view-model.smoke: all assertions passed')
