/**
 * Additive auth schema. The control-storage composition appends this fragment to
 * its numbered migration next to the catalog/inventory fragments — `AUTH_SCHEMA_SQL`
 * is the export the composition imports.
 *
 * Only intent bookkeeping lives here. Secret material is never a row: it is either a
 * mahas-managed materialRef (see secret-store.ts) or a read-only locatorRef pointing
 * at a file the user owns (see locators.ts).
 */
export const AUTH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS auth_intents (
  id TEXT PRIMARY KEY,
  intent_kind TEXT NOT NULL CHECK(intent_kind IN ('login','add-account','replace-account','refresh','repair')),
  offering_id TEXT NOT NULL,
  connection_id TEXT,
  credential_id TEXT,
  expected_material_revision INTEGER,
  flow_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','needs-input','effect-required','complete','failed','cancelled','interrupted')),
  required_input_json TEXT CHECK(required_input_json IS NULL OR json_valid(required_input_json)),
  effect_json TEXT CHECK(effect_json IS NULL OR json_valid(effect_json)),
  error_code TEXT,
  result_credential_id TEXT,
  result_connection_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  revision INTEGER NOT NULL CHECK(revision > 0),
  CHECK(completed_at IS NULL OR completed_at >= created_at)
);

CREATE INDEX IF NOT EXISTS auth_intents_state_time
  ON auth_intents(state, updated_at DESC);
CREATE INDEX IF NOT EXISTS auth_intents_offering_time
  ON auth_intents(offering_id, created_at DESC);

/* Which materialRef a credential came from. Locator refs stay visible so a
 * user-owned file is never silently rewritten by mahas. */
CREATE TABLE IF NOT EXISTS auth_credential_provenance (
  credential_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL CHECK(origin IN ('managed','adopted-locator','imported-locator')),
  locator_ref TEXT,
  imported_at INTEGER NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json))
);

CREATE INDEX IF NOT EXISTS auth_credential_provenance_locator
  ON auth_credential_provenance(locator_ref);
`

export function applyAuthSchema(db: import('node:sqlite').DatabaseSync): void {
  db.exec(AUTH_SCHEMA_SQL)
}
