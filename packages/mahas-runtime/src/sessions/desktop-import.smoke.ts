// session.desktop.import — synthetic fixture.
//
// Run: node packages/mahas-runtime/src/sessions/desktop-import.smoke.ts
//
// No real HOME, credential or harness file is read: the fixture builds the
// session tables in memory and imports synthetic desktop records.

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { SESSION_SCHEMA_SQL } from './migrations.ts'
import {
  desktopLegacyNamespace,
  DESKTOP_LEGACY_NAMESPACE,
  HOOK_NAMESPACE,
  importDesktopSessions,
  type DesktopImportResult
} from './desktop-import.ts'
import { findHarnessSession, listSessionHandles } from './store.ts'

const db = new DatabaseSync(':memory:')
// the session schema's attachments carry foreign keys into the control plane;
// the fixture only needs the parent tables to exist (it inserts nulls there)
db.exec(`
  CREATE TABLE executions(id TEXT PRIMARY KEY);
  CREATE TABLE dispatches(id TEXT PRIMARY KEY);
  CREATE TABLE observations(id TEXT PRIMARY KEY);
`)
db.exec(SESSION_SCHEMA_SQL)

const machineId = 'machine.fixture'
const harnessResume = { hasResumeRecipe: (harnessId: string): boolean => harnessId === 'claude' }
const options = { machineId, harnessResume, now: 5_000 }

const batch = {
  records: [
    {
      nativeSessionId: 'legacy-1',
      harnessId: 'claude',
      cwd: '/work/a',
      wsId: 'ws-1',
      paneId: 'pane-1',
      tabId: 'tab-1',
      observedAt: 1_000
    },
    // the Pack declares no resume recipe for this harness in this fixture
    { nativeSessionId: 'legacy-2', harnessId: 'gemini', observedAt: 1_100 },
    // not a harness at all — never invent an installation for it
    { nativeSessionId: 'legacy-3', harnessId: 'not-a-harness', observedAt: 1_200 }
  ]
}

const first = importDesktopSessions(db, batch, options) as DesktopImportResult
assert.equal(first.committed, true)
assert.equal(first.imported, 1, 'only the harness with a declared recipe is imported')
assert.equal(first.skipped, 2)
assert.equal(
  first.diagnostics.filter((d) => d.code === 'desktop-import.unknown-harness').length,
  2,
  'unknown harnesses are reported, not guessed'
)
const mapping = first.mappings[0]!
assert.equal(mapping.nativeSessionId, 'legacy-1')
assert.equal(mapping.harnessId, 'claude')
assert.equal(mapping.resumeSupport, 'supported', 'the Pack declares a resume recipe')
assert.deepEqual(mapping.placement, {
  cwd: '/work/a',
  wsId: 'ws-1',
  paneId: 'pane-1',
  tabId: 'tab-1'
})

const session = findHarnessSession(db, 'claude', desktopLegacyNamespace(machineId), 'legacy-1')
assert.ok(session, 'the canonical session row exists')
assert.equal(session!.id, mapping.sessionId, 'the mapping names the canonical id')
assert.equal(session!.originMachineId, machineId)
assert.equal(session!.firstObservedAt, 1_000, 'the observed time is preserved')
assert.equal(session!.metadata.legacyNativeId, 'legacy-1', 'exact native marker')
assert.equal(session!.metadata.placementOnly, true)
assert.deepEqual(session!.metadata.placement, mapping.placement)
assert.equal((session!.metadata.legacy as Record<string, unknown>).source, DESKTOP_LEGACY_NAMESPACE)

const handles = listSessionHandles(db, session!.id)
assert.equal(handles.length, 1)
assert.equal(handles[0]!.nativeId, 'legacy-1')
assert.equal(handles[0]!.resumeSupport, 'supported')
assert.equal((handles[0]!.locator as Record<string, unknown>).placementOnly, true)
assert.equal(
  (handles[0]!.locator as Record<string, unknown>).machineId,
  machineId,
  'the handle locator names the machine it came from'
)

// the alias is the exact native → canonical marker
const alias = db
  .prepare(
    'SELECT session_id AS id FROM session_namespace_aliases WHERE harness_id=? AND namespace=? AND native_session_key=?'
  )
  .get('claude', desktopLegacyNamespace(machineId), 'legacy-1') as { id: string } | undefined
assert.equal(alias?.id, mapping.sessionId)

const attachment = db
  .prepare('SELECT machine_id AS machineId FROM session_attachments WHERE session_id=?')
  .get(session!.id) as { machineId: string } | undefined
assert.equal(attachment?.machineId, machineId)

// idempotent retry: same batch, same canonical ids, nothing duplicated
const second = importDesktopSessions(db, batch, options) as DesktopImportResult
assert.equal(second.imported, 0, 'a retry imports nothing new')
assert.equal(second.replayed, 1)
assert.equal(second.mappings[0]!.sessionId, mapping.sessionId, 'stable canonical id')
assert.equal(second.mappings[0]!.created, false)
const sessionCount = db.prepare('SELECT COUNT(*) AS n FROM harness_sessions').get() as { n: number }
assert.equal(sessionCount.n, 1, 'no duplicate session rows')

// a session the store already knows is a child run is never resurrected
db.prepare(
  'INSERT INTO harness_sessions(id,harness_id,origin_machine_id,namespace,native_session_key,parent_session_id,title,first_observed_at,last_observed_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?)'
).run(
  'session.hook-child',
  'claude',
  machineId,
  HOOK_NAMESPACE,
  'legacy-4',
  null,
  null,
  900,
  950,
  JSON.stringify({ child: true })
)
const third = importDesktopSessions(
  db,
  { records: [{ nativeSessionId: 'legacy-4', harnessId: 'claude', observedAt: 960 }] },
  options
) as DesktopImportResult
assert.equal(third.imported, 0)
assert.equal(third.diagnostics[0]?.code, 'desktop-import.known-child-or-external')

const otherMachine = importDesktopSessions(db, batch, { ...options, machineId: 'machine.other' })
assert.notEqual(
  otherMachine.mappings[0]?.sessionId,
  mapping.sessionId,
  'native ids never merge across machines'
)
assert.equal(otherMachine.imported, 1)
db.prepare('UPDATE harness_sessions SET namespace=?, metadata_json=? WHERE id=?').run(
  'hook:real-source:claude',
  JSON.stringify({ external: true }),
  'session.hook-child'
)
assert.equal(
  importDesktopSessions(
    db,
    { records: [{ nativeSessionId: 'legacy-4', harnessId: 'claude' }] },
    options
  ).skipped,
  1,
  'exclusions work for the real source-qualified hook namespace'
)

// an over-long batch is refused as a schema error, not silently truncated
try {
  importDesktopSessions(
    db,
    {
      records: Array.from({ length: 513 }, (_, i) => ({
        nativeSessionId: 'x-' + i,
        harnessId: 'claude'
      }))
    },
    options
  )
  assert.fail('a 513-record batch must be rejected')
} catch (error) {
  assert.equal((error as { code?: string }).code, 'MODEL_INVALID')
}

// App shutdown closes PTYs and emits session-end AFTER main's final snapshot.
// Only exact run/pane/tab evidence admits that saved candidate; earlier user
// exits, foreign/child sessions and another app run remain excluded.
const shutdownRecord = {
  nativeSessionId: 'shutdown-session',
  harnessId: 'claude',
  paneId: 'pane-1',
  tabId: 'tab-1',
  shutdown: { runId: 'app-run-1', at: 10_000 }
}
const ended = {
  event: 'session-end',
  mahasSession: 'app-run-1',
  paneId: 'pane-1',
  tabId: 'tab-1',
  ts: 10_100
}
db.prepare(
  `INSERT INTO harness_sessions(id,harness_id,origin_machine_id,namespace,native_session_key,
  parent_session_id,title,first_observed_at,last_observed_at,metadata_json) VALUES (?,?,?,?,?,NULL,NULL,?,?,?)`
).run(
  'session.shutdown',
  'claude',
  machineId,
  'hook',
  'shutdown-session',
  9000,
  10_100,
  JSON.stringify(ended)
)
for (const meta of [
  { ...ended, ts: 9999 },
  { ...ended, ts: 50_000 },
  { ...ended, child: true },
  { ...ended, external: true },
  { ...ended, mahasSession: 'other-app' },
  { ...ended, tabId: 'other-tab' }
]) {
  db.prepare('UPDATE harness_sessions SET metadata_json=? WHERE id=?').run(
    JSON.stringify(meta),
    'session.shutdown'
  )
  assert.equal(importDesktopSessions(db, { records: [shutdownRecord] }, options).skipped, 1)
}
db.prepare('UPDATE harness_sessions SET metadata_json=? WHERE id=?').run(
  JSON.stringify(ended),
  'session.shutdown'
)
assert.equal(
  importDesktopSessions(db, { records: [{ ...shutdownRecord, shutdown: undefined }] }, options)
    .skipped,
  1
)
const shutdown = importDesktopSessions(db, { records: [shutdownRecord] }, options)
assert.equal(shutdown.imported, 1)
assert.deepEqual(
  findHarnessSession(db, 'claude', desktopLegacyNamespace(machineId), 'shutdown-session')?.metadata
    .shutdown,
  shutdownRecord.shutdown
)
assert.equal(
  JSON.parse(
    String(
      db.prepare('SELECT metadata_json FROM harness_sessions WHERE id=?').get('session.shutdown')
        ?.metadata_json
    )
  ).event,
  'session-end',
  'resume evidence never rewrites the historical end event'
)
db.close()
console.log('desktop-import fixtures passed')
