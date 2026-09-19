/** Additive session schema. The control-storage owner composes this fragment. */
export const SESSION_SCHEMA_SQL = `
CREATE TABLE harness_sessions (
  id TEXT PRIMARY KEY,
  harness_id TEXT NOT NULL,
  origin_machine_id TEXT,
  namespace TEXT NOT NULL,
  native_session_key TEXT NOT NULL,
  parent_session_id TEXT,
  title TEXT,
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  UNIQUE(harness_id, namespace, native_session_key),
  CHECK(first_observed_at <= last_observed_at),
  FOREIGN KEY(parent_session_id) REFERENCES harness_sessions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX harness_sessions_recent
  ON harness_sessions(harness_id, last_observed_at DESC, id);

CREATE TABLE session_namespace_aliases (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  harness_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  native_session_key TEXT NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_until INTEGER,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  UNIQUE(harness_id, namespace, native_session_key),
  CHECK(valid_until IS NULL OR valid_until >= valid_from),
  FOREIGN KEY(session_id) REFERENCES harness_sessions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE session_handles (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  installation_id TEXT,
  native_id TEXT NOT NULL,
  locator_json TEXT CHECK(locator_json IS NULL OR json_valid(locator_json)),
  resume_support TEXT NOT NULL CHECK(resume_support IN ('supported','unsupported','unknown')),
  observed_at INTEGER NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  FOREIGN KEY(session_id) REFERENCES harness_sessions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX session_handles_by_session ON session_handles(session_id, observed_at DESC, id);

CREATE TABLE session_attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  installation_id TEXT,
  machine_id TEXT NOT NULL,
  process_identity_json TEXT CHECK(process_identity_json IS NULL OR json_valid(process_identity_json)),
  execution_id TEXT,
  dispatch_id TEXT,
  observed_from INTEGER NOT NULL,
  observed_until INTEGER,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  CHECK(observed_until IS NULL OR observed_until >= observed_from),
  FOREIGN KEY(session_id) REFERENCES harness_sessions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(dispatch_id) REFERENCES dispatches(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX session_attachments_by_session
  ON session_attachments(session_id, observed_from DESC, id);

/* This is an ObservationFact facet, not a second event authority. */
CREATE TABLE observation_session_facets (
  observation_id TEXT PRIMARY KEY,
  session_id TEXT,
  attachment_id TEXT,
  native_kind TEXT NOT NULL,
  native_turn_id TEXT,
  occurred_at INTEGER,
  origin TEXT NOT NULL,
  FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE,
  FOREIGN KEY(session_id) REFERENCES harness_sessions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(attachment_id) REFERENCES session_attachments(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX observation_session_facets_by_session
  ON observation_session_facets(session_id, occurred_at, observation_id);
`
