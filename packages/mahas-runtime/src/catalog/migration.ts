/** Additive catalog schema. The composition root appends this SQL to the control migration. */
export const CATALOG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS catalog_organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  revision INTEGER NOT NULL CHECK(revision > 0)
);

CREATE TABLE IF NOT EXISTS catalog_harnesses (
  id TEXT PRIMARY KEY,
  publisher_organization_id TEXT,
  label TEXT NOT NULL,
  identity_metadata_json TEXT NOT NULL CHECK(json_valid(identity_metadata_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  FOREIGN KEY(publisher_organization_id) REFERENCES catalog_organizations(id)
);

CREATE TABLE IF NOT EXISTS catalog_providers (
  id TEXT PRIMARY KEY,
  operator_organization_id TEXT,
  label TEXT NOT NULL,
  realm TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  FOREIGN KEY(operator_organization_id) REFERENCES catalog_organizations(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_providers_realm_uq
  ON catalog_providers(realm);

CREATE TABLE IF NOT EXISTS catalog_offerings (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  offering_key TEXT NOT NULL,
  label TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  UNIQUE(provider_id, offering_key),
  FOREIGN KEY(provider_id) REFERENCES catalog_providers(id)
);

CREATE TABLE IF NOT EXISTS catalog_inference_models (
  id TEXT PRIMARY KEY,
  publisher_organization_id TEXT,
  label TEXT NOT NULL,
  model_version TEXT,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  FOREIGN KEY(publisher_organization_id) REFERENCES catalog_organizations(id)
);

CREATE TABLE IF NOT EXISTS catalog_native_model_aliases (
  id TEXT PRIMARY KEY,
  namespace_kind TEXT NOT NULL CHECK(namespace_kind IN ('harness','offering')),
  namespace_id TEXT NOT NULL,
  native_name TEXT NOT NULL,
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  UNIQUE(namespace_kind, namespace_id, native_name),
  CHECK(last_observed_at >= first_observed_at)
);

CREATE TABLE IF NOT EXISTS catalog_model_alias_resolutions (
  id TEXT PRIMARY KEY,
  alias_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_until INTEGER,
  confidence TEXT NOT NULL CHECK(confidence IN ('declared','observed','verified')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  CHECK(valid_until IS NULL OR valid_until >= valid_from),
  FOREIGN KEY(alias_id) REFERENCES catalog_native_model_aliases(id),
  FOREIGN KEY(model_id) REFERENCES catalog_inference_models(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_alias_one_current_uq
  ON catalog_model_alias_resolutions(alias_id) WHERE valid_until IS NULL;
CREATE INDEX IF NOT EXISTS catalog_alias_resolution_history_idx
  ON catalog_model_alias_resolutions(alias_id, valid_from, valid_until);
`

export function applyCatalogSchema(db: import('node:sqlite').DatabaseSync): void {
  db.exec(CATALOG_SCHEMA_SQL)
}
