/** Additive collection/checkpoint schema. The control-storage owner composes this fragment. */
export const COLLECTION_SCHEMA_SQL = `
CREATE TABLE collection_sources (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  subject_json TEXT NOT NULL CHECK(json_valid(subject_json)),
  locator_json TEXT NOT NULL CHECK(json_valid(locator_json)),
  kind TEXT NOT NULL CHECK(kind IN ('file','database','hook-stream','provider-api','other')),
  source_generation TEXT NOT NULL,
  identity_evidence_json TEXT NOT NULL CHECK(json_valid(identity_evidence_json)),
  status TEXT NOT NULL CHECK(status IN ('active','missing','unavailable','retired','unknown')),
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  CHECK(first_observed_at <= last_observed_at)
);

CREATE TABLE collection_cursors (
  source_id TEXT PRIMARY KEY,
  source_generation TEXT NOT NULL,
  collector_revision TEXT NOT NULL,
  position_json TEXT NOT NULL CHECK(json_valid(position_json)),
  checkpoint_revision INTEGER NOT NULL CHECK(checkpoint_revision >= 0),
  last_committed_at INTEGER,
  FOREIGN KEY(source_id) REFERENCES collection_sources(id) ON DELETE CASCADE
);

CREATE TABLE collection_batches (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  adapter_pack_id TEXT NOT NULL,
  adapter_pack_revision INTEGER NOT NULL,
  integration_contract_id TEXT NOT NULL,
  contract_revision INTEGER NOT NULL,
  cursor_before_json TEXT CHECK(cursor_before_json IS NULL OR json_valid(cursor_before_json)),
  cursor_after_json TEXT CHECK(cursor_after_json IS NULL OR json_valid(cursor_after_json)),
  started_at INTEGER NOT NULL,
  committed_at INTEGER,
  result TEXT NOT NULL CHECK(result IN ('committed','partial','failed','cancelled')),
  diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json)),
  FOREIGN KEY(source_id) REFERENCES collection_sources(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX collection_batches_by_source ON collection_batches(source_id, started_at DESC, id);

/* Stable record identity is generation-independent when the source has a native id.
   Positional collectors include generation in source_record_key themselves. */
CREATE TABLE observation_collection_facets (
  observation_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  facet TEXT NOT NULL CHECK(facet IN ('observation','session-event','usage','quota')),
  source_record_key TEXT NOT NULL,
  source_record_revision TEXT NOT NULL DEFAULT '',
  record_discriminator TEXT NOT NULL DEFAULT '',
  occurred_at INTEGER,
  payload_schema TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  UNIQUE(source_id, facet, source_record_key, source_record_revision, record_discriminator),
  FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE,
  FOREIGN KEY(batch_id) REFERENCES collection_batches(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(source_id) REFERENCES collection_sources(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE collection_coverage (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  source_id TEXT,
  subject_json TEXT NOT NULL CHECK(json_valid(subject_json)),
  interval_json TEXT CHECK(interval_json IS NULL OR json_valid(interval_json)),
  completeness TEXT NOT NULL CHECK(completeness IN ('complete','partial','gap','unknown')),
  gap_reason TEXT,
  last_success_at INTEGER,
  watermark TEXT,
  FOREIGN KEY(batch_id) REFERENCES collection_batches(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(source_id) REFERENCES collection_sources(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX collection_coverage_by_source ON collection_coverage(source_id, last_success_at DESC, id);

/* Durable "collect this source now" queue. The operation writes a row; the
   scheduler claims it outside the operation transaction and records the batch. */
CREATE TABLE collection_requests (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability IN ('events','sessions','usage','quota')),
  requested_by TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  not_before INTEGER,
  max_records INTEGER NOT NULL CHECK(max_records > 0),
  max_bytes INTEGER NOT NULL CHECK(max_bytes > 0),
  reason TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','processed','failed','cancelled')),
  claimed_by TEXT,
  claimed_at INTEGER,
  claim_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  batch_id TEXT,
  processed_at INTEGER,
  diagnostics_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(diagnostics_json)),
  FOREIGN KEY(source_id) REFERENCES collection_sources(id) ON DELETE CASCADE,
  FOREIGN KEY(batch_id) REFERENCES collection_batches(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX collection_requests_idempotency
  ON collection_requests(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX collection_requests_queue
  ON collection_requests(status, not_before, requested_at, id);
CREATE INDEX collection_requests_source
  ON collection_requests(source_id, requested_at DESC, id);
`
