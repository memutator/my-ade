// Persist field list and shutdown stamp — no IPC.
//
// Run: node src/renderer/src/shell/hydration.smoke.ts

import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS,
  snapshotPersistedState,
  stampResumeShutdown,
  STATE_VERSION,
  type PersistedState
} from './persist.ts'
import type { ResumeSession } from '../types.ts'

const empty: PersistedState = {
  projects: [],
  workspaces: [],
  activeWorkspaceId: null,
  settings: DEFAULT_SETTINGS,
  sidebarOpen: false,
  treeOverlayOpen: true,
  bookmarks: [],
  agentSessions: {},
  resumeSessions: {},
  treeRoots: [],
  sidebarRoots: {},
  sideAgentsCollapsed: false,
  sideAgentsFrac: 0.38,
  agentsScope: 'ws'
}

const snap = snapshotPersistedState({ ...empty, stateVersion: 1 })
assert.equal(snap.stateVersion, STATE_VERSION)
assert.equal(snap.treeOverlayOpen, true)
assert.equal('notifications' in snap, false)
assert.equal('toasts' in snap, false)

const row: ResumeSession = {
  sessionId: 's',
  provider: 'claude',
  wsId: 'w',
  paneId: 'p',
  tabId: 't',
  ts: 1
}
const stamped = stampResumeShutdown({ resumeSessions: { s: row } }, 'run-1', 9)
assert.deepEqual(stamped.resumeSessions.s.shutdown, { runId: 'run-1', at: 9 })
assert.equal(row.shutdown, undefined)
assert.deepEqual(stampResumeShutdown(stamped, 'run-2', 10), stamped)

console.log('hydration persist contract: ok')
