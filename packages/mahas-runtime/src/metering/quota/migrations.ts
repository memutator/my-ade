/** Additive quota schema. The control-storage composition applies this fragment. */
export const QUOTA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS quota_reading_facets (
  observation_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  source_record_key TEXT NOT NULL,
  source_record_revision TEXT,
  occurred_at INTEGER,
  payload_schema TEXT NOT NULL CHECK(payload_schema='mahas.quota-reading/v1'),
  connection_id TEXT NOT NULL,
  reading_observed_at INTEGER NOT NULL,
  provider_measured_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('success','partial','failure')),
  identity_claims_json TEXT NOT NULL CHECK(json_valid(identity_claims_json)),
  plan_claims_json TEXT NOT NULL CHECK(json_valid(plan_claims_json)),
  meters_json TEXT NOT NULL CHECK(json_valid(meters_json)),
  entitlements_json TEXT NOT NULL CHECK(json_valid(entitlements_json)),
  diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json)),
  source_evidence_json TEXT NOT NULL CHECK(json_valid(source_evidence_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  UNIQUE(batch_id, source_record_key, source_record_revision),
  FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS quota_readings_connection_time
  ON quota_reading_facets(connection_id, reading_observed_at DESC, observation_id DESC);
CREATE INDEX IF NOT EXISTS quota_readings_status_time
  ON quota_reading_facets(connection_id, status, reading_observed_at DESC);

/* Claims stay observations. They are not automatic connection merge keys. */
CREATE TABLE IF NOT EXISTS quota_reading_identity_claims (
  observation_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  claim_value TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  valid_until INTEGER,
  confidence TEXT NOT NULL CHECK(confidence IN ('declared','observed','verified')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  PRIMARY KEY(observation_id, claim_id),
  FOREIGN KEY(observation_id) REFERENCES quota_reading_facets(observation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS quota_identity_claim_history
  ON quota_reading_identity_claims(connection_id, kind, observed_at DESC);

CREATE TABLE IF NOT EXISTS quota_reading_pool_claims (
  observation_id TEXT NOT NULL,
  provider_pool_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  meter_key TEXT NOT NULL,
  PRIMARY KEY(observation_id, provider_pool_key, scope, meter_key),
  FOREIGN KEY(observation_id) REFERENCES quota_reading_facets(observation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS quota_pool_claim_history
  ON quota_reading_pool_claims(provider_pool_key, scope, observed_at DESC);
`

export function applyQuotaSchema(db: import('node:sqlite').DatabaseSync): void {
  db.exec(QUOTA_SCHEMA_SQL)
}
