// storage/migrations.ts — schema versioning, migration receipts and the
// write-compatibility gate for mahas.sqlite (spec/storage.md §3, §5; §4 of the
// IMP-03 instruction).
//
// CONTROL_SCHEMA_DDL_V1 below is the spec/storage.md §3 contract DDL copied
// VERBATIM (CREATE TABLE/INDEX/VIRTUAL TABLE statements only — the PRAGMA
// lines at the top of the spec block are connection settings and are applied
// in database.ts, not inside a migration transaction). Do not 'fix' it: the
// DDL is the v1 storage contract other repositories code against.
//
// Write-compatibility rules enforced here (spec/storage.md §5):
//   * schema_meta.schema_version > this binary's version  → refuse to open
//     for write — an older binary must not write a newer DB.
//   * schema_meta.schema_owner !== 'control'              → not ours, refuse;
//     two daemons never write the same DB.
//   * user tables exist but schema_meta is absent          → unmanaged schema,
//     refuse rather than guess (the execution-host DB has no schema_meta and
//     must never be treated as a control DB).
//   * empty file                                           → migrate to v1.
//
// Every applied migration writes a migration_receipts row in the SAME
// transaction as its DDL, so a failed migration leaves neither schema nor a
// false success receipt behind.

import type { DatabaseSync } from 'node:sqlite'
import { StorageError } from './errors.ts'
import { sha256Hex } from './blob-store.ts'
import { withTx } from './transaction.ts'
import { CATALOG_SCHEMA_SQL } from '../catalog/migration.ts'
import { INVENTORY_SCHEMA_SQL } from '../inventory/migration.ts'
import { AUTH_SCHEMA_SQL } from '../inventory/auth/migrations.ts'
import { INTEGRATION_SCHEMA_SQL } from '../integration/migration.ts'
import { SESSION_SCHEMA_SQL } from '../sessions/migrations.ts'
import { COLLECTION_SCHEMA_SQL } from '../observation/collection/migrations.ts'
import { USAGE_SCHEMA_SQL } from '../metering/usage/migrations.ts'
import { QUOTA_SCHEMA_SQL } from '../metering/quota/migrations.ts'
import { USAGE_AGGREGATES_SCHEMA_SQL } from '../metering/aggregates/schema.ts'
import { USAGE_STATISTICS_SCHEMA_SQL } from '../metering/statistics/schema.ts'
import { EXECUTION_SESSION_REF_SCHEMA_SQL, EXECUTION_SESSION_BACKFILL_STATE_SCHEMA_SQL } from '../recovery/session-reference-migration.ts'

export const CONTROL_SCHEMA_VERSION = 3
export const CONTROL_DB_OWNER = 'control'

export interface Migration {
  /** stable id — also the migration_receipts primary key */
  id: string
  fromVersion: number
  toVersion: number
  /** DDL executed inside the migration transaction — verbatim spec text */
  ddl: string
}

export const CONTROL_MIGRATIONS: readonly Migration[] = [
  {
    id: 'control-0001-schema-v1',
    fromVersion: 0,
    toVersion: 1,
    ddl: controlSchemaDdlV1()
  },
  {
    id: 'control-0002-integration-domains',
    fromVersion: 1,
    toVersion: 2,
    ddl: [
      CATALOG_SCHEMA_SQL,
      INVENTORY_SCHEMA_SQL,
      AUTH_SCHEMA_SQL,
      INTEGRATION_SCHEMA_SQL,
      SESSION_SCHEMA_SQL,
      COLLECTION_SCHEMA_SQL,
      USAGE_SCHEMA_SQL,
      QUOTA_SCHEMA_SQL,
      USAGE_AGGREGATES_SCHEMA_SQL,
      USAGE_STATISTICS_SCHEMA_SQL
    ].join('\n')
  },
  {
    id: 'control-0003-execution-session-references',
    fromVersion: 2,
    toVersion: 3,
    ddl: [EXECUTION_SESSION_REF_SCHEMA_SQL, EXECUTION_SESSION_BACKFILL_STATE_SCHEMA_SQL].join('\n')
  }
]

/** names of all user tables/views in the main schema (excludes sqlite_ internals) */
function userTableNames(db: DatabaseSync): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'"
    )
    .all()
    .map((r) => String(r['name']))
}

function schemaMetaValue(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key=?').get(key)
  return row === undefined ? undefined : String(row['value'])
}

function setSchemaMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO schema_meta(key,value) VALUES (?,?) ' +
      'ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, value)
}

/** current schema version, or null when the file has no schema_meta at all */
export function schemaVersion(db: DatabaseSync): number | null {
  if (!userTableNames(db).includes('schema_meta')) return null
  const raw = schemaMetaValue(db, 'schema_version')
  return raw === undefined ? 0 : Number(raw)
}

/**
 * Open-time gate + migration runner for the control DB. Throws StorageError on
 * any incompatibility — callers must let the open fail, never write anyway.
 * Returns the ids of the migrations applied during this call ([] on reopen).
 */
export function applyMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
  owner: string
): string[] {
  const tables = userTableNames(db)
  const hasMeta = tables.includes('schema_meta')
  if (!hasMeta && tables.length > 0) {
    throw new StorageError(
      'INVALID_TRANSITION',
      'database has user tables but no schema_meta — refusing to treat an ' +
        'unmanaged/foreign SQLite file as the mahas control DB',
      { details: { tables } }
    )
  }
  const version = hasMeta ? Number(schemaMetaValue(db, 'schema_version') ?? '0') : 0
  const recordedOwner = hasMeta ? schemaMetaValue(db, 'schema_owner') : undefined
  if (recordedOwner !== undefined && recordedOwner !== owner) {
    throw new StorageError(
      'INVALID_TRANSITION',
      "database owner is '" +
        recordedOwner +
        "', this opener writes as '" +
        owner +
        "' — two daemons never write the same DB",
      { details: { recordedOwner, owner } }
    )
  }
  const head = migrations.length === 0 ? 0 : Math.max(...migrations.map((m) => m.toVersion))
  if (version > head) {
    throw new StorageError(
      'INVALID_TRANSITION',
      'database schema v' +
        version +
        ' is newer than this binary supports (v' +
        head +
        ') — an older binary must not write a newer DB',
      { details: { schemaVersion: version, supported: head } }
    )
  }
  const pending = migrations.filter((m) => m.toVersion > version)
  const applied: string[] = []
  for (const m of pending) {
    withTx(db, (tx) => {
      const currentVersion = schemaVersion(tx) ?? 0
      if (currentVersion !== m.fromVersion) {
        throw new StorageError('INVALID_TRANSITION',
          `migration ${m.id} requires schema v${m.fromVersion}, found v${currentVersion}`)
      }
      tx.exec(m.ddl)
      setSchemaMeta(tx, 'schema_version', String(m.toVersion))
      setSchemaMeta(tx, 'schema_owner', owner)
      setSchemaMeta(tx, 'schema_version_compat', String(m.toVersion))
      tx.prepare(
        'INSERT INTO migration_receipts(id,from_version,to_version,state,payload_json) ' +
          'VALUES (?,?,?,?,?)'
      ).run(
        m.id,
        m.fromVersion,
        m.toVersion,
        'applied',
        JSON.stringify({
          stage: 'schema',
          fingerprint: sha256Hex(m.ddl),
          backupRef: null,
          outcome: 'applied',
          appliedAt: Date.now()
        })
      )
    })
    applied.push(m.id)
  }
  return applied
}

// ── spec/storage.md §3 — control DB DDL, verbatim (PRAGMAs excluded) ─────────
// hoisted function so CONTROL_MIGRATIONS above can embed it at module load.

function controlSchemaDdlV1(): string {
  return `
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE migration_receipts (
  id TEXT PRIMARY KEY,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
);

CREATE TABLE content_blobs (
  digest TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length>=0),
  body BLOB,
  external_ref TEXT,
  verified INTEGER NOT NULL CHECK(verified IN (0,1)),
  CHECK((body IS NOT NULL)+(external_ref IS NOT NULL)=1)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  repository_root TEXT NOT NULL,
  active_model_version TEXT,
  revision INTEGER NOT NULL CHECK(revision>0),
  FOREIGN KEY(active_model_version) REFERENCES model_versions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE model_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_version TEXT,
  root_boundary_id TEXT,
  goal_snapshot TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','published','superseded')),
  digest TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(parent_version) REFERENCES model_versions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(id,root_boundary_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE rdd_boundaries (
  model_version TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  responsibility_statement TEXT NOT NULL,
  PRIMARY KEY(model_version,id),
  FOREIGN KEY(model_version) REFERENCES model_versions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE rdd_criteria (
  model_version TEXT NOT NULL,
  boundary_id TEXT NOT NULL,
  id TEXT NOT NULL,
  criterion TEXT NOT NULL,
  description TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(model_version,boundary_id,id),
  FOREIGN KEY(model_version,boundary_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE boundary_paths (
  model_version TEXT NOT NULL,
  boundary_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('file','directory')),
  PRIMARY KEY(model_version,boundary_id,path),
  FOREIGN KEY(model_version,boundary_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE boundary_edges (
  model_version TEXT NOT NULL,
  child_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  PRIMARY KEY(model_version,child_id),
  CHECK(child_id<>parent_id),
  FOREIGN KEY(model_version,child_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(model_version,parent_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE horizontal_roles (
  model_version TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY(model_version,name),
  FOREIGN KEY(model_version) REFERENCES model_versions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE rdd_roles (
  model_version TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  boundary_id TEXT NOT NULL,
  horizontal_role_name TEXT NOT NULL,
  PRIMARY KEY(model_version,id),
  FOREIGN KEY(model_version,boundary_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(model_version,horizontal_role_name) REFERENCES horizontal_roles(model_version,name) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE rdd_contexts (
  model_version TEXT NOT NULL,
  id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY(model_version,id),
  FOREIGN KEY(model_version) REFERENCES model_versions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE boundary_contexts (
  model_version TEXT NOT NULL,
  boundary_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  PRIMARY KEY(model_version,boundary_id,context_id),
  FOREIGN KEY(model_version,boundary_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(model_version,context_id) REFERENCES rdd_contexts(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE horizontal_contexts (
  model_version TEXT NOT NULL,
  horizontal_role_name TEXT NOT NULL,
  context_id TEXT NOT NULL,
  PRIMARY KEY(model_version,horizontal_role_name,context_id),
  FOREIGN KEY(model_version,horizontal_role_name) REFERENCES horizontal_roles(model_version,name) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(model_version,context_id) REFERENCES rdd_contexts(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE rdd_contracts (
  model_version TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  schema_path TEXT NOT NULL,
  provider_boundary_id TEXT NOT NULL,
  PRIMARY KEY(model_version,id),
  FOREIGN KEY(model_version,provider_boundary_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE contract_consumers (
  model_version TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  consumer_boundary_id TEXT NOT NULL,
  PRIMARY KEY(model_version,contract_id,consumer_boundary_id),
  FOREIGN KEY(model_version,contract_id) REFERENCES rdd_contracts(model_version,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(model_version,consumer_boundary_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE rdd_non_goals (
  model_version TEXT NOT NULL,
  id TEXT NOT NULL,
  boundary_id TEXT NOT NULL,
  statement TEXT NOT NULL,
  PRIMARY KEY(model_version,id),
  FOREIGN KEY(model_version,boundary_id) REFERENCES rdd_boundaries(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE model_changes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  base_version TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  edits_json TEXT NOT NULL CHECK(json_valid(edits_json)),
  touched_targets_json TEXT NOT NULL CHECK(json_valid(touched_targets_json)),
  diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json)),
  FOREIGN KEY(project_id) REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(base_version) REFERENCES model_versions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE role_search_rows (
  model_version TEXT NOT NULL,
  role_id TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  PRIMARY KEY(model_version,role_id),
  FOREIGN KEY(model_version,role_id) REFERENCES rdd_roles(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE VIRTUAL TABLE role_search_fts USING fts5(model_version UNINDEXED, role_id UNINDEXED, normalized_text, tokenize='unicode61');

CREATE TABLE role_interfaces (
  digest TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  role_id TEXT NOT NULL,
  requirements_json TEXT NOT NULL CHECK(json_valid(requirements_json)),
  judgment_scope_json TEXT NOT NULL CHECK(json_valid(judgment_scope_json)),
  FOREIGN KEY(model_version,role_id) REFERENCES rdd_roles(model_version,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE harness_profiles (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  recipe_json TEXT NOT NULL CHECK(json_valid(recipe_json)),
  capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
  executable_identity_json TEXT NOT NULL CHECK(json_valid(executable_identity_json)),
  PRIMARY KEY(id,revision)
);

CREATE TABLE role_implementations (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  interface_digest TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  maintainer_role_id TEXT NOT NULL,
  semantic_decision TEXT,
  PRIMARY KEY(id,revision),
  FOREIGN KEY(interface_digest) REFERENCES role_interfaces(digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(profile_id,profile_revision) REFERENCES harness_profiles(id,revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE implementation_components (
  implementation_id TEXT NOT NULL,
  implementation_revision INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  activation TEXT NOT NULL,
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  consumes_json TEXT NOT NULL CHECK(json_valid(consumes_json)),
  coverage_json TEXT NOT NULL CHECK(json_valid(coverage_json)),
  PRIMARY KEY(implementation_id,implementation_revision,id),
  FOREIGN KEY(implementation_id,implementation_revision) REFERENCES role_implementations(id,revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE maintenance_bindings (
  implementation_id TEXT NOT NULL,
  implementation_revision INTEGER NOT NULL,
  id TEXT NOT NULL,
  basis_ref_json TEXT NOT NULL CHECK(json_valid(basis_ref_json)),
  component_ref_json TEXT NOT NULL CHECK(json_valid(component_ref_json)),
  PRIMARY KEY(implementation_id,implementation_revision,id),
  FOREIGN KEY(implementation_id,implementation_revision) REFERENCES role_implementations(id,revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE context_bundles (
  digest TEXT PRIMARY KEY,
  implementation_id TEXT NOT NULL,
  implementation_revision INTEGER NOT NULL,
  interface_digest TEXT NOT NULL,
  surface_digest TEXT NOT NULL,
  required_text_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  source_observations_json TEXT NOT NULL CHECK(json_valid(source_observations_json)),
  FOREIGN KEY(implementation_id,implementation_revision) REFERENCES role_implementations(id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(interface_digest) REFERENCES role_interfaces(digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(required_text_digest) REFERENCES content_blobs(digest) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE role_policies (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  selector_json TEXT NOT NULL CHECK(json_valid(selector_json)),
  action_ceiling_json TEXT NOT NULL CHECK(json_valid(action_ceiling_json)),
  projection_policy_json TEXT NOT NULL CHECK(json_valid(projection_policy_json)),
  PRIMARY KEY(id,revision)
);

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('assignment','provisioning','continuation')),
  principal_id TEXT NOT NULL,
  parent_grant_id TEXT,
  policy_id TEXT,
  policy_revision INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  actions_json TEXT NOT NULL CHECK(json_valid(actions_json)),
  FOREIGN KEY(principal_id) REFERENCES principals(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(parent_grant_id) REFERENCES grants(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(policy_id,policy_revision) REFERENCES role_policies(id,revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE command_surfaces (
  digest TEXT PRIMARY KEY,
  actions_and_schemas_json TEXT NOT NULL CHECK(json_valid(actions_and_schemas_json)),
  policy_pins_json TEXT NOT NULL CHECK(json_valid(policy_pins_json))
);

CREATE TABLE authorization_decisions (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  allow INTEGER NOT NULL CHECK(allow IN (0,1)),
  actual_targets_json TEXT NOT NULL CHECK(json_valid(actual_targets_json)),
  policy_evidence_json TEXT NOT NULL CHECK(json_valid(policy_evidence_json)),
  FOREIGN KEY(principal_id) REFERENCES principals(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  goal_text TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'work' CHECK(purpose IN ('work','verification')),
  coordinator_member_id TEXT,
  state TEXT NOT NULL,
  current_plan_revision INTEGER,
  revision INTEGER NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(model_version) REFERENCES model_versions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(coordinator_member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  role_id TEXT NOT NULL,
  implementation_id TEXT NOT NULL,
  implementation_revision INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  current_execution_id TEXT,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(model_version,role_id) REFERENCES rdd_roles(model_version,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(implementation_id,implementation_revision) REFERENCES role_implementations(id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(current_execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE assignments (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('coordination','task')),
  mandate_text TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  task_id TEXT,
  task_revision INTEGER,
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  PRIMARY KEY(id,revision),
  FOREIGN KEY(member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(grant_id) REFERENCES grants(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(task_id,task_revision) REFERENCES task_specs(task_id,revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE plans (
  run_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  dispositions_json TEXT NOT NULL CHECK(json_valid(dispositions_json)),
  PRIMARY KEY(run_id,revision),
  FOREIGN KEY(run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE plan_candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  base_revision INTEGER,
  digest TEXT NOT NULL,
  patch_json TEXT NOT NULL CHECK(json_valid(patch_json)),
  diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json)),
  FOREIGN KEY(run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  current_dispatch_id TEXT,
  FOREIGN KEY(run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(current_dispatch_id) REFERENCES dispatches(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE task_specs (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  requirement_text TEXT NOT NULL,
  owner_role_id TEXT NOT NULL,
  assigned_member_id TEXT,
  inputs_json TEXT NOT NULL CHECK(json_valid(inputs_json)),
  outputs_json TEXT NOT NULL CHECK(json_valid(outputs_json)),
  settlement_policy_json TEXT NOT NULL CHECK(json_valid(settlement_policy_json)),
  PRIMARY KEY(task_id,revision),
  FOREIGN KEY(task_id) REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(assigned_member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE plan_tasks (
  run_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  PRIMARY KEY(run_id,plan_revision,task_id),
  FOREIGN KEY(run_id,plan_revision) REFERENCES plans(run_id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(task_id,task_revision) REFERENCES task_specs(task_id,revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE task_edges (
  run_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL,
  from_task TEXT NOT NULL,
  to_task TEXT NOT NULL,
  requirements_json TEXT NOT NULL CHECK(json_valid(requirements_json)),
  PRIMARY KEY(run_id,plan_revision,from_task,to_task),
  CHECK(from_task<>to_task),
  FOREIGN KEY(run_id,plan_revision,from_task) REFERENCES plan_tasks(run_id,plan_revision,task_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(run_id,plan_revision,to_task) REFERENCES plan_tasks(run_id,plan_revision,task_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE runtime_instances (
  id TEXT PRIMARY KEY,
  controller_epoch INTEGER NOT NULL UNIQUE,
  state TEXT NOT NULL,
  process_identity_json TEXT NOT NULL CHECK(json_valid(process_identity_json)),
  endpoint_incarnation TEXT NOT NULL
);

CREATE TABLE execution_hosts (
  id TEXT PRIMARY KEY,
  incarnation TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  state TEXT NOT NULL,
  identity_json TEXT NOT NULL CHECK(json_valid(identity_json))
);

CREATE TABLE controller_leases (
  host_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  proof_json TEXT NOT NULL CHECK(json_valid(proof_json)),
  FOREIGN KEY(host_id) REFERENCES execution_hosts(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  host_id TEXT NOT NULL,
  launch_plan_id TEXT NOT NULL,
  state TEXT NOT NULL,
  liveness TEXT NOT NULL CHECK(liveness IN ('live','unverifiable','exited')),
  terminal_id TEXT,
  process_identity_json TEXT NOT NULL CHECK(json_valid(process_identity_json)),
  native_conversation_json TEXT NOT NULL CHECK(json_valid(native_conversation_json)),
  revision INTEGER NOT NULL,
  UNIQUE(member_id,generation),
  FOREIGN KEY(member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(host_id) REFERENCES execution_hosts(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(launch_plan_id) REFERENCES launch_plans(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(terminal_id) REFERENCES terminal_records(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE execution_credentials (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('bootstrap','full')),
  revoked_at INTEGER,
  revision INTEGER NOT NULL,
  FOREIGN KEY(principal_id) REFERENCES principals(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE work_envelopes (
  digest TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  assignment_revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  bindings_json TEXT NOT NULL CHECK(json_valid(bindings_json)),
  FOREIGN KEY(assignment_id,assignment_revision) REFERENCES assignments(id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(body_digest) REFERENCES content_blobs(digest) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE launch_plans (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  assignment_revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  bundle_digest TEXT NOT NULL,
  envelope_digest TEXT NOT NULL,
  surface_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  process_spec_json TEXT NOT NULL CHECK(json_valid(process_spec_json)),
  pins_json TEXT NOT NULL CHECK(json_valid(pins_json)),
  reservations_json TEXT NOT NULL CHECK(json_valid(reservations_json)),
  FOREIGN KEY(assignment_id,assignment_revision) REFERENCES assignments(id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(bundle_digest) REFERENCES context_bundles(digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(envelope_digest) REFERENCES work_envelopes(digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(surface_digest) REFERENCES command_surfaces(digest) DEFERRABLE INITIALLY DEFERRED
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
  authority_state TEXT NOT NULL CHECK(authority_state IN ('active','settled','revoked')),
  assignment_delivery_id TEXT,
  revision INTEGER NOT NULL,
  FOREIGN KEY(task_id,task_revision) REFERENCES task_specs(task_id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(envelope_digest) REFERENCES work_envelopes(digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(assignment_delivery_id) REFERENCES deliveries(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX one_active_dispatch_per_task ON dispatches(task_id) WHERE authority_state='active';

CREATE UNIQUE INDEX one_active_dispatch_per_execution ON dispatches(execution_id) WHERE authority_state='active';

CREATE TABLE injection_receipts (
  execution_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  revision INTEGER NOT NULL,
  components_json TEXT NOT NULL CHECK(json_valid(components_json)),
  inherited_json TEXT NOT NULL CHECK(json_valid(inherited_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  PRIMARY KEY(execution_id,phase,revision),
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE worker_joins (
  execution_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  bundle_digest TEXT NOT NULL,
  surface_digest TEXT NOT NULL,
  envelope_digest TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(execution_id,generation),
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(bundle_digest) REFERENCES context_bundles(digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(surface_digest) REFERENCES command_surfaces(digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(envelope_digest) REFERENCES work_envelopes(digest) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE operation_receipts (
  principal_scope TEXT NOT NULL,
  operation TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(principal_scope,operation,operation_id)
);

CREATE TABLE effect_intents (
  id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  host_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('prepared','attempting','confirmed','rejected','unknown')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  residuals_json TEXT NOT NULL CHECK(json_valid(residuals_json)),
  FOREIGN KEY(host_id) REFERENCES execution_hosts(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sender_principal_id TEXT NOT NULL,
  sender_member_id TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  links_json TEXT NOT NULL CHECK(json_valid(links_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(sender_member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(sender_principal_id) REFERENCES principals(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  recipient_member_id TEXT NOT NULL,
  consumer_generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('outstanding','acknowledged','fenced')),
  revision INTEGER NOT NULL,
  acked_at INTEGER,
  handling_json TEXT NOT NULL CHECK(json_valid(handling_json)),
  UNIQUE(message_id,recipient_member_id),
  FOREIGN KEY(message_id) REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(recipient_member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX inbox_outstanding ON deliveries(recipient_member_id,status,consumer_generation);

CREATE TABLE wake_requests (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  execution_id TEXT,
  continuation_grant_id TEXT,
  operation_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  delivery_set_json TEXT NOT NULL CHECK(json_valid(delivery_set_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  FOREIGN KEY(member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(continuation_grant_id) REFERENCES grants(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE artifacts (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  producer_dispatch_id TEXT NOT NULL,
  output_slot TEXT NOT NULL,
  digest TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  storage_ref_json TEXT NOT NULL CHECK(json_valid(storage_ref_json)),
  PRIMARY KEY(id,revision),
  FOREIGN KEY(run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(producer_dispatch_id) REFERENCES dispatches(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE outcomes (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  dispatch_id TEXT NOT NULL,
  result TEXT NOT NULL,
  rationale TEXT NOT NULL,
  assessment_json TEXT NOT NULL CHECK(json_valid(assessment_json)),
  contract_effects_json TEXT NOT NULL CHECK(json_valid(contract_effects_json)),
  PRIMARY KEY(id,revision),
  FOREIGN KEY(task_id,task_revision) REFERENCES task_specs(task_id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(dispatch_id) REFERENCES dispatches(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE outcome_outputs (
  outcome_id TEXT NOT NULL,
  outcome_revision INTEGER NOT NULL,
  slot TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_revision INTEGER NOT NULL,
  PRIMARY KEY(outcome_id,outcome_revision,slot),
  FOREIGN KEY(outcome_id,outcome_revision) REFERENCES outcomes(id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(artifact_id,artifact_revision) REFERENCES artifacts(id,revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE settlements (
  id TEXT PRIMARY KEY,
  outcome_id TEXT NOT NULL,
  outcome_revision INTEGER NOT NULL,
  authority_member_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  UNIQUE(outcome_id,outcome_revision),
  FOREIGN KEY(outcome_id,outcome_revision) REFERENCES outcomes(id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(authority_member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE run_decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL,
  coordinator_member_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  FOREIGN KEY(run_id,plan_revision) REFERENCES plans(run_id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(coordinator_member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  host_id TEXT,
  identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
  FOREIGN KEY(host_id) REFERENCES execution_hosts(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE checkouts (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE,
  host_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  filesystem_identity TEXT NOT NULL,
  repository_json TEXT NOT NULL CHECK(json_valid(repository_json)),
  revision INTEGER NOT NULL,
  UNIQUE(host_id,canonical_path,filesystem_identity),
  FOREIGN KEY(resource_id) REFERENCES resources(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(host_id) REFERENCES execution_hosts(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(checkout_id) REFERENCES checkouts(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE resource_claims (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('read','write')),
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('held','transferring','released','unknown')),
  revision INTEGER NOT NULL,
  FOREIGN KEY(resource_id) REFERENCES resources(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX one_writer_per_resource ON resource_claims(resource_id) WHERE mode='write' AND state IN ('held','transferring','unknown');

CREATE TABLE resource_transfers (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  from_owner TEXT NOT NULL,
  to_owner TEXT NOT NULL,
  state TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  FOREIGN KEY(claim_id) REFERENCES resource_claims(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE terminal_records (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  host_incarnation TEXT NOT NULL,
  pty_id TEXT NOT NULL,
  output_epoch TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  state TEXT NOT NULL,
  process_identity_json TEXT NOT NULL CHECK(json_valid(process_identity_json)),
  FOREIGN KEY(host_id) REFERENCES execution_hosts(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(resource_id) REFERENCES resources(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE terminal_input_leases (
  terminal_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(terminal_id) REFERENCES terminal_records(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(principal_id) REFERENCES principals(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE retention_pins (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  holder_kind TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  from_dispatch TEXT NOT NULL,
  to_task TEXT,
  to_member TEXT,
  bindings_json TEXT NOT NULL CHECK(json_valid(bindings_json)),
  FOREIGN KEY(from_dispatch) REFERENCES dispatches(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(to_task) REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(to_member) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  execution_id TEXT,
  dispatch_id TEXT,
  source TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  identity_evidence_json TEXT NOT NULL CHECK(json_valid(identity_evidence_json)),
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(dispatch_id) REFERENCES dispatches(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE interventions (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  member_id TEXT,
  execution_id TEXT,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  FOREIGN KEY(run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(member_id) REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE domain_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
);

CREATE TABLE effect_outbox (
  effect_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  next_attempt_at INTEGER,
  FOREIGN KEY(effect_id) REFERENCES effect_intents(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE client_view_bindings (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  view_id TEXT NOT NULL,
  execution_id TEXT,
  terminal_id TEXT,
  layout_binding_json TEXT NOT NULL CHECK(json_valid(layout_binding_json)),
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(terminal_id) REFERENCES terminal_records(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE resume_candidates (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  support_state TEXT NOT NULL,
  native_handle_json TEXT NOT NULL CHECK(json_valid(native_handle_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  FOREIGN KEY(execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE impact_candidates (
  id TEXT PRIMARY KEY,
  change_ref TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  reason_json TEXT NOT NULL CHECK(json_valid(reason_json)),
  resolution_json TEXT NOT NULL CHECK(json_valid(resolution_json))
);

CREATE TABLE backup_sets (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  consistency_point TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json))
);

CREATE TABLE runtime_shutdowns (
  operation_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  stages_json TEXT NOT NULL CHECK(json_valid(stages_json)),
  residuals_json TEXT NOT NULL CHECK(json_valid(residuals_json))
);

CREATE TABLE support_attestations (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  decision TEXT NOT NULL,
  installation_json TEXT NOT NULL CHECK(json_valid(installation_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  FOREIGN KEY(profile_id,profile_revision) REFERENCES harness_profiles(id,revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX roles_by_boundary ON rdd_roles(model_version,boundary_id);

CREATE INDEX consumers_by_boundary ON contract_consumers(model_version,consumer_boundary_id);

CREATE INDEX members_by_role ON members(model_version,role_id,state);

CREATE INDEX effects_pending ON effect_intents(state,host_id);
`
}
