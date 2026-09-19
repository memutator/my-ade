/** Additive usage-ledger schema. The control-storage owner composes this fragment. */
export const USAGE_SCHEMA_SQL = `
CREATE TABLE usage_reading_facets (
  observation_id TEXT PRIMARY KEY,
  session_id TEXT,
  measurement_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('delta','cumulative')),
  counter_scope TEXT,
  counter_epoch TEXT,
  counter_epoch_relation TEXT
    CHECK(counter_epoch_relation IS NULL OR counter_epoch_relation IN ('first','disjoint','unknown')),
  counter_epoch_evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(counter_epoch_evidence_json)),
  values_json TEXT NOT NULL CHECK(json_valid(values_json)),
  semantics_json TEXT NOT NULL CHECK(json_valid(semantics_json)),
  time_coverage_json TEXT NOT NULL CHECK(json_valid(time_coverage_json)),
  source_evidence_json TEXT NOT NULL CHECK(json_valid(source_evidence_json)),
  FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE,
  FOREIGN KEY(session_id) REFERENCES harness_sessions(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(mode='delta' OR (counter_scope IS NOT NULL AND counter_epoch IS NOT NULL))
);

CREATE TABLE usage_entries (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  session_id TEXT,
  harness_id TEXT NOT NULL,
  installation_id TEXT,
  origin_machine_id TEXT,
  accounting_namespace TEXT NOT NULL,
  accounting_key TEXT NOT NULL,
  coverage_json TEXT NOT NULL CHECK(json_valid(coverage_json)),
  reading_ids_json TEXT NOT NULL CHECK(json_valid(reading_ids_json)),
  usage_time_json TEXT NOT NULL CHECK(json_valid(usage_time_json)),
  normalized_tokens_json TEXT NOT NULL CHECK(json_valid(normalized_tokens_json)),
  cost_json TEXT CHECK(cost_json IS NULL OR json_valid(cost_json)),
  accounting_status TEXT NOT NULL
    CHECK(accounting_status IN ('counted','duplicate','unresolved','superseded')),
  stream_role TEXT NOT NULL DEFAULT 'primary'
    CHECK(stream_role IN ('primary','corroborating','unresolved')),
  counter_epoch_json TEXT CHECK(counter_epoch_json IS NULL OR json_valid(counter_epoch_json)),
  supersedes_entry_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(id, revision),
  FOREIGN KEY(session_id) REFERENCES harness_sessions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX usage_entries_accounting_revision
  ON usage_entries(harness_id, accounting_namespace, accounting_key, revision);
CREATE INDEX usage_entries_current ON usage_entries(id, revision DESC);

CREATE TABLE usage_attributions (
  entry_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  connection_id TEXT,
  offering_id TEXT,
  provider_id TEXT,
  credential_id TEXT,
  requested_model_json TEXT CHECK(requested_model_json IS NULL OR json_valid(requested_model_json)),
  served_model_json TEXT CHECK(served_model_json IS NULL OR json_valid(served_model_json)),
  execution_id TEXT,
  dispatch_id TEXT,
  basis TEXT NOT NULL CHECK(basis IN ('reported','configured-at-time','correlated','manual')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  status TEXT NOT NULL CHECK(status IN ('verified','observed','inferred','unknown','superseded')),
  valid_from_revision INTEGER NOT NULL CHECK(valid_from_revision > 0),
  PRIMARY KEY(entry_id, revision),
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(dispatch_id) REFERENCES dispatches(id) DEFERRABLE INITIALLY DEFERRED
);

/* One row per counter LINEAGE (the accounting key that reported the snapshot),
   not one row per counter: a correction has to be able to exclude its own prior
   value from the baseline search, and a late or corrected snapshot has to keep
   the other lineages available for recomputing the chain after it. */
CREATE TABLE usage_counter_checkpoints (
  harness_id TEXT NOT NULL,
  accounting_namespace TEXT NOT NULL,
  counter_scope TEXT NOT NULL,
  counter_epoch TEXT NOT NULL,
  measurement_key TEXT NOT NULL,
  accounting_key TEXT NOT NULL,
  entry_revision INTEGER NOT NULL DEFAULT 0,
  reading_id TEXT NOT NULL,
  values_json TEXT NOT NULL CHECK(json_valid(values_json)),
  observed_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY(harness_id, accounting_namespace, counter_scope, counter_epoch, measurement_key, accounting_key),
  FOREIGN KEY(reading_id) REFERENCES observations(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX usage_counter_checkpoints_order
  ON usage_counter_checkpoints(harness_id, accounting_namespace, counter_scope, counter_epoch,
    measurement_key, observed_at, recorded_at, accounting_key);

/* Durable remainder of a bounded correction recompute. A corrected snapshot can
   invalidate every later delta of the same counter; the ingest transaction
   recomputes what fits its bound and leaves the rest here for the usage worker. */
CREATE TABLE usage_counter_recompute_intents (
  id TEXT PRIMARY KEY,
  harness_id TEXT NOT NULL,
  accounting_namespace TEXT NOT NULL,
  counter_scope TEXT NOT NULL,
  counter_epoch TEXT NOT NULL,
  measurement_key TEXT NOT NULL,
  after_observed_at INTEGER NOT NULL,
  after_recorded_at INTEGER NOT NULL,
  after_accounting_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','applied')) DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);

CREATE INDEX usage_counter_recompute_pending
  ON usage_counter_recompute_intents(state, created_at, id);

/* Durable monotonic feed for summaries/statistics; seq is their checkpoint. */
CREATE TABLE usage_ledger_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL,
  entry_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('entry','attribution')),
  changed_at INTEGER NOT NULL
);

CREATE INDEX usage_ledger_changes_entry ON usage_ledger_changes(entry_id, sequence);

/* Aggregate workers claim these from the same transaction as ledger writes. */
CREATE TABLE usage_aggregate_intents (
  change_sequence INTEGER PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('pending','applied')) DEFAULT 'pending',
  applied_generation TEXT,
  FOREIGN KEY(change_sequence) REFERENCES usage_ledger_changes(sequence) ON DELETE CASCADE
);
`
