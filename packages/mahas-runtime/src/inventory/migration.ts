/** Additive inventory schema. Apply after CATALOG_SCHEMA_SQL. */
export const INVENTORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS inventory_machines (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  CHECK(last_seen_at >= first_seen_at)
);

CREATE TABLE IF NOT EXISTS inventory_installations (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  harness_id TEXT NOT NULL,
  executable_locator TEXT,
  config_namespace TEXT NOT NULL,
  data_namespace TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  presence TEXT NOT NULL CHECK(presence IN ('present','absent','unknown')),
  origin TEXT NOT NULL CHECK(origin IN ('discovered','registered')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  UNIQUE(machine_id, harness_id, config_namespace, data_namespace),
  CHECK(last_seen_at >= first_seen_at),
  FOREIGN KEY(machine_id) REFERENCES inventory_machines(id),
  FOREIGN KEY(harness_id) REFERENCES catalog_harnesses(id)
);

CREATE TABLE IF NOT EXISTS inventory_installation_revisions (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  installation_revision INTEGER NOT NULL CHECK(installation_revision > 0),
  executable_identity_json TEXT NOT NULL CHECK(json_valid(executable_identity_json)),
  version TEXT,
  config_structure_digest TEXT,
  observed_at INTEGER NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  UNIQUE(installation_id, installation_revision),
  FOREIGN KEY(installation_id) REFERENCES inventory_installations(id)
);

CREATE TABLE IF NOT EXISTS inventory_provider_credentials (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  material_ref TEXT NOT NULL,
  material_revision INTEGER NOT NULL CHECK(material_revision > 0),
  ownership TEXT NOT NULL CHECK(ownership IN ('user','machine','external','unknown')),
  availability TEXT NOT NULL CHECK(availability IN ('available','unavailable','unknown')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  observed_until INTEGER,
  replaced_by_credential_id TEXT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  CHECK(last_seen_at >= first_seen_at),
  CHECK(observed_until IS NULL OR observed_until >= first_seen_at),
  FOREIGN KEY(machine_id) REFERENCES inventory_machines(id),
  FOREIGN KEY(replaced_by_credential_id) REFERENCES inventory_provider_credentials(id)
);

CREATE INDEX IF NOT EXISTS inventory_credential_locator_idx
  ON inventory_provider_credentials(machine_id, material_ref, observed_until);

CREATE TABLE IF NOT EXISTS inventory_provider_connections (
  id TEXT PRIMARY KEY,
  offering_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  auth_scope_json TEXT CHECK(auth_scope_json IS NULL OR json_valid(auth_scope_json)),
  first_seen_at INTEGER NOT NULL,
  observed_until INTEGER,
  availability TEXT NOT NULL CHECK(availability IN ('available','unavailable','unknown')),
  origin TEXT NOT NULL CHECK(origin IN ('discovered','registered')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  CHECK(observed_until IS NULL OR observed_until >= first_seen_at),
  FOREIGN KEY(offering_id) REFERENCES catalog_offerings(id),
  FOREIGN KEY(credential_id) REFERENCES inventory_provider_credentials(id)
);

CREATE INDEX IF NOT EXISTS inventory_connection_credential_idx
  ON inventory_provider_connections(credential_id, observed_until);

CREATE TABLE IF NOT EXISTS inventory_identity_claims (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  claim_value TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  valid_until INTEGER,
  confidence TEXT NOT NULL CHECK(confidence IN ('declared','observed','verified')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  CHECK(valid_until IS NULL OR valid_until >= observed_at),
  FOREIGN KEY(connection_id) REFERENCES inventory_provider_connections(id)
);

CREATE INDEX IF NOT EXISTS inventory_identity_claim_history_idx
  ON inventory_identity_claims(connection_id, kind, observed_at, valid_until);

CREATE TABLE IF NOT EXISTS inventory_quota_pool_claims (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  provider_pool_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  valid_until INTEGER,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  CHECK(valid_until IS NULL OR valid_until >= observed_at),
  FOREIGN KEY(connection_id) REFERENCES inventory_provider_connections(id)
);

CREATE INDEX IF NOT EXISTS inventory_pool_claim_history_idx
  ON inventory_quota_pool_claims(connection_id, scope, observed_at, valid_until);

CREATE TABLE IF NOT EXISTS inventory_harness_provider_bindings (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  config_slot TEXT NOT NULL,
  selector_json TEXT CHECK(selector_json IS NULL OR json_valid(selector_json)),
  origin TEXT NOT NULL CHECK(origin IN ('discovered','registered')),
  observed_from INTEGER NOT NULL,
  observed_until INTEGER,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  CHECK(observed_until IS NULL OR observed_until >= observed_from),
  FOREIGN KEY(installation_id) REFERENCES inventory_installations(id),
  FOREIGN KEY(connection_id) REFERENCES inventory_provider_connections(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_binding_one_current_uq
  ON inventory_harness_provider_bindings(installation_id, config_slot, connection_id)
  WHERE observed_until IS NULL;
CREATE INDEX IF NOT EXISTS inventory_binding_history_idx
  ON inventory_harness_provider_bindings(installation_id, observed_from, observed_until);

/* Discovery failure/missing/confirmed removal are different facts. */
CREATE TABLE IF NOT EXISTS inventory_observations (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_id TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('observed','missing','removed','failed')),
  observed_at INTEGER NOT NULL,
  source_ref TEXT,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json))
);
`

export function applyInventorySchema(db: import('node:sqlite').DatabaseSync): void {
  db.exec(INVENTORY_SCHEMA_SQL)
}
