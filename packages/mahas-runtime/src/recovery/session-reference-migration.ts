// recovery/session-reference-migration.ts — additive schema for the canonical
// execution → session reference and its bounded backfill cursor (schema v3).
//
// LEGACY→CANONICAL MIGRATION (milestone stage A, D-EXEC §1)
//   The authoritative execution→session link already exists in v2 as
//   session_attachments.execution_id. This table is the EXPLICIT, single-row
//   reference the recovery/resume path reads directly, so that:
//     · native_conversation_json becomes migration-compatibility data with no
//       reader on the hot path;
//     · a runner can tell "this execution's session is known" apart from
//       "this execution has no session evidence yet" with one lookup;
//     · an idempotent composition-time bridge can record the reference without
//       rewriting the frozen v1 executions row.
//
// It stores REFERENCES ONLY: the session's own identity (harness, namespace,
// native key, resume support) lives in harness_sessions/session_handles and is
// joined, never copied. No second authoritative session copy is created here,
// and nothing in this table can create a Task or an Execution.
//
// Storage owner: the central migration composes BOTH exported fragments into the
// v3 step — v3 is still unreleased, so both tables belong to it:
//
//   import {
//     EXECUTION_SESSION_REF_SCHEMA_SQL,
//     EXECUTION_SESSION_BACKFILL_STATE_SCHEMA_SQL
//   } from './recovery/session-reference-migration.ts'
//
//   {
//     id: 'control-0003-execution-session-references',
//     fromVersion: 2,
//     toVersion: 3,
//     ddl: [EXECUTION_SESSION_REF_SCHEMA_SQL, EXECUTION_SESSION_BACKFILL_STATE_SCHEMA_SQL]
//       .join('\n')
//   }
//
// The two fragments are independent and additive. If they ever ship separately,
// the later one becomes a NEW version: appending DDL to an already-applied
// version does not re-run it, and a database that predates either table keeps
// working — recovery reads a missing reference as 'unresolved' and the pass
// runner reports cursorPersisted false instead of failing.
//
// No data migration callback is needed: the bridge
// (recovery/session-handles.ts → runExecutionSessionBackfillPass) is idempotent
// and runs AFTER migrations at composition time — once before the service
// reports ready and again from each discovery refresh, so an execution that was
// unsupported only because its installation had not been discovered yet is
// retried instead of staying legacy forever.

export const EXECUTION_SESSION_REF_SCHEMA_SQL = `
CREATE TABLE canonical_execution_sessions (
  execution_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  session_handle_id TEXT,
  /* evidence class of the reference: legacy-backfill | execution-attachment |
     native-id-handle | execution-reference | operator — free text on purpose,
     a new evidence class must not need a schema migration */
  evidence TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(session_id) REFERENCES harness_sessions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(session_handle_id) REFERENCES session_handles(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX canonical_execution_sessions_by_session
  ON canonical_execution_sessions(session_id, execution_id);
`

export const EXECUTION_SESSION_REF_TABLE = 'canonical_execution_sessions'

/**
 * Bounded backfill progress — part of the same unreleased v3 step as the
 * reference table (see the composer note above).
 *
 * Discovery is asynchronous: at process start the inventory may still be empty,
 * so a single startup pass would classify every legacy handle as 'unsupported'
 * and never look again. This singleton row makes the pass resumable and
 * repeatable — each refresh continues from the last scanned execution and wraps
 * to the start once it reaches the end, so newly discovered installations let a
 * previously unsupported execution convert on a later pass.
 *
 * The runner tolerates the table's absence (a database without it still
 * backfills, it just cannot remember where it stopped — the pass reports
 * cursorPersisted false and restarts its bounded scan each time).
 */
export const EXECUTION_SESSION_BACKFILL_STATE_SCHEMA_SQL = `
CREATE TABLE canonical_execution_session_backfill (
  /* singleton key: one row per backfill kind */
  id TEXT PRIMARY KEY,
  /* last execution scanned in rowid order; NULL = start (or wrapped) */
  cursor_execution_id TEXT,
  migrated INTEGER NOT NULL DEFAULT 0,
  unresolved INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0)
);
`

export const EXECUTION_SESSION_BACKFILL_STATE_TABLE = 'canonical_execution_session_backfill'

/** the only backfill kind so far: legacy native_conversation_json → session ref */
export const LEGACY_NATIVE_CONVERSATION_BACKFILL_ID = 'legacy-native-conversation'
