// Compare team.retire revoke-dispatch with fenceDispatch on the same row shape.
//
// Run: node packages/mahas-runtime/src/coordination/dispatch-revoke.smoke.ts
//
// Handwritten DDL (FK off): this checks dispatch mutation meaning, not the
// migration chain. revokeDispatchAuthority withdraws authority only;
// fenceDispatch also sets phase=revoked and clears tasks.current_dispatch_id.

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  checkAttemptAuthority,
  fenceDispatch,
  getDispatch,
  revokeDispatchAuthority
} from './dispatch-authority.ts'
import { getTask } from './task-spec.ts'
import { isMahasError } from '../discovery/types.ts'

function open(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=OFF')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      current_revision INTEGER NOT NULL,
      current_dispatch_id TEXT
    );
    CREATE TABLE task_specs (
      task_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      requirement_text TEXT NOT NULL,
      owner_role_id TEXT NOT NULL,
      assigned_member_id TEXT,
      inputs_json TEXT NOT NULL,
      outputs_json TEXT NOT NULL,
      settlement_policy_json TEXT NOT NULL,
      PRIMARY KEY(task_id, revision)
    );
    CREATE TABLE dispatches (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_revision INTEGER NOT NULL,
      member_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      envelope_digest TEXT NOT NULL,
      phase TEXT NOT NULL,
      authority_state TEXT NOT NULL,
      assignment_delivery_id TEXT,
      revision INTEGER NOT NULL
    );
    CREATE TABLE domain_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      aggregate_id TEXT NOT NULL,
      aggregate_revision INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      scope_json TEXT,
      payload_json TEXT
    );
  `)
  return db
}

function seed(db: DatabaseSync, ids: { task: string; dispatch: string }): void {
  db.prepare('INSERT INTO tasks(id,run_id,current_revision,current_dispatch_id) VALUES(?,?,1,?)').run(
    ids.task,
    'run-1',
    ids.dispatch
  )
  db.prepare(
    `INSERT INTO task_specs(task_id,revision,title,requirement_text,owner_role_id,assigned_member_id,inputs_json,outputs_json,settlement_policy_json)
     VALUES(?,1,'t','req','role',NULL,'[]','[]','{}')`
  ).run(ids.task)
  db.prepare(
    `INSERT INTO dispatches(id,task_id,task_revision,member_id,execution_id,generation,envelope_digest,phase,authority_state,assignment_delivery_id,revision)
     VALUES(?,?,1,'member-1','exec-1',1,'env','running','active',NULL,1)`
  ).run(ids.dispatch, ids.task)
}

function refused(fn: () => unknown): string {
  try {
    fn()
    throw new Error('expected checkAttemptAuthority to throw')
  } catch (error) {
    if (isMahasError(error)) return error.code
    throw error
  }
}

const revokeDb = open()
seed(revokeDb, { task: 'task-revoke', dispatch: 'disp-revoke' })
const revoked = revokeDispatchAuthority(revokeDb, 'disp-revoke', {
  eventBy: 'team.retire',
  runId: 'run-1'
})
assert.equal(revoked.authorityState, 'revoked')
assert.equal(revoked.phase, 'running', 'revoke-dispatch does not move phase')
assert.equal(getTask(revokeDb, 'task-revoke')?.currentDispatchId, 'disp-revoke')
assert.equal(refused(() => checkAttemptAuthority(revokeDb, { dispatchId: 'disp-revoke' })), 'INVALID_TRANSITION')
const revokeEvent = revokeDb
  .prepare('SELECT event_type, aggregate_revision FROM domain_events WHERE aggregate_id=?')
  .get('disp-revoke') as { event_type: string; aggregate_revision: number }
assert.equal(revokeEvent.event_type, 'dispatch.revoked')
assert.equal(revokeEvent.aggregate_revision, 0)

const fenceDb = open()
seed(fenceDb, { task: 'task-fence', dispatch: 'disp-fence' })
const fenced = fenceDispatch(fenceDb, 'disp-fence', { reason: 'test' })
assert.equal(fenced.authorityState, 'revoked')
assert.equal(fenced.phase, 'revoked')
assert.equal(getTask(fenceDb, 'task-fence')?.currentDispatchId, undefined)
assert.equal(refused(() => checkAttemptAuthority(fenceDb, { dispatchId: 'disp-fence' })), 'INVALID_TRANSITION')
const fenceEvent = fenceDb
  .prepare('SELECT event_type FROM domain_events WHERE aggregate_id=?')
  .get('disp-fence') as { event_type: string }
assert.equal(fenceEvent.event_type, 'dispatch.fenced')

assert.notEqual(
  getDispatch(revokeDb, 'disp-revoke')?.phase,
  getDispatch(fenceDb, 'disp-fence')?.phase,
  'revoke-dispatch and fenceDispatch are different mutations'
)

console.log('dispatch revoke vs fence: ok')
