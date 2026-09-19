// recovery/session-handles.smoke.ts — canonical session/handle bridge fixture.
//
// Run: node packages/mahas-runtime/src/recovery/session-handles.smoke.ts
//
// Fixture scope: the recovery-side bridge, over the REAL control schema
// (schema v2 through openControlDb) rather than a hand-rolled table set, because
// the rules under test — session identity uniqueness, namespace qualification,
// handle resume support — are exactly what the real DDL enforces.
//
// What it asserts:
//   · a legacy handle without explicit harness evidence stays unresolved and
//     writes nothing (unknown is preserved; no suffix/title guessing);
//   · an explicit backfill creates canonical session + handle + attachment with
//     the collector's installation-qualified namespace and deterministic ids;
//   · a second run is idempotent — same ids, no duplicate rows, no events;
//   · unknown harness, ambiguous installation and harness/installation conflict
//     refuse instead of picking a namespace;
//   · 'unknown' resume support is preserved, never promoted to 'supported';
//   · an exact native-id handle match reuses the collected session;
//   · one native id claimed by two sessions resolves as ambiguous;
//   · worker.resume admits a canonical supported handle under the same
//     profile/pin rules and refuses unknown support or missing profile evidence;
//   · the legacy resume_candidates path is unchanged;
//   · no conversion creates a Task or an Execution.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import type { HarnessRuntimePack } from '../../../mahas-harness-config/src/runtime-pack.ts'
import type { TxnContext } from '../api/registry.ts'
import { putSessionHandle, upsertHarnessSession } from '../sessions/store.ts'
import { appendDomainEvent, openControlDb, sha256Hex, withTx } from '../storage/db.ts'
import { harnessEvidenceResolver, type HarnessEvidenceOptions } from './harness-evidence.ts'
import { loadExecution, type ExecutionRow, type RecoveryDeps } from './ports.ts'
import { makeResumeHandler } from './resume.ts'
import {
  EXECUTION_SESSION_BACKFILL_STATE_SCHEMA_SQL,
  EXECUTION_SESSION_BACKFILL_STATE_TABLE,
  EXECUTION_SESSION_REF_SCHEMA_SQL,
  EXECUTION_SESSION_REF_TABLE,
  LEGACY_NATIVE_CONVERSATION_BACKFILL_ID
} from './session-reference-migration.ts'
import {
  backfillExecutionSession,
  backfillLegacyExecutionSessions,
  resolveExecutionSession,
  resolveResumeRecipe,
  runExecutionSessionBackfillPass,
  stableSessionHandleId,
  stableSessionId
} from './session-handles.ts'

const NOW = 1_700_000_000_000
const HARNESS = 'claude'
const AMBIGUOUS_HARNESS = 'codex'
const MACHINE = 'machine-bridge'
const INSTALLATION = 'installation-bridge'
const DATA_NAMESPACE = 'data-bridge'
const CODEX_INSTALLATION = 'installation-codex-one'
const CODEX_INSTALLATION_TWO = 'installation-codex-two'
const EXPECTED_NAMESPACE = 'installation:' + INSTALLATION + ':' + DATA_NAMESPACE + ':default'
const CODEX_PROFILE = 'profile-codex'
const CODEX_LOCATOR = '/opt/codex/bin/codex'
const PROJECT = 'project-bridge'
const MODEL = 'model-bridge'
const BOUNDARY = 'boundary-bridge'
const ROLE = 'role-bridge'
const INTERFACE = 'interface-bridge'
const PROFILE = 'profile-bridge'
const IMPLEMENTATION = 'implementation-bridge'
const HOST = 'host-bridge'
const RUN = 'run-bridge'
const MEMBER = 'member-bridge'
const GRANT = 'grant-bridge'
const ASSIGNMENT = 'assignment-bridge'
const BODY = 'body-bridge'
const ENVELOPE = 'envelope-bridge'

interface Bridge {
  db: DatabaseSync
  deps: RecoveryDeps
  close(): void
}

function count(db: DatabaseSync, table: string, where?: string): number {
  const sql = 'SELECT COUNT(*) AS n FROM ' + table + (where ? ' WHERE ' + where : '')
  const row = db.prepare(sql).get() as { n?: number }
  return Number(row.n ?? 0)
}

function column(db: DatabaseSync, sql: string, ...args: string[]): Record<string, unknown> {
  const row = db.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined
  assert.ok(row, 'row expected: ' + sql)
  return row
}

function executionRow(db: DatabaseSync, id: string): ExecutionRow {
  const row = loadExecution(db, id)
  assert.ok(row, 'execution expected: ' + id)
  return row
}

/**
 * The minimal referential chain a managed execution hangs from, written with
 * this fixture's own ids so the file stays self-contained (a smoke that imports
 * another smoke's seed would also import that smoke's composition graph).
 */
function seedLocalFixture(db: DatabaseSync): void {
  const run = (sql: string, ...args: (string | number | null | Uint8Array)[]): void => {
    db.prepare(sql).run(...(args as never[]))
  }
  run(
    'INSERT INTO projects(id,name,goal,repository_root,active_model_version,revision)' +
      " VALUES(?,'bridge fixture','canonical session/handle bridge fixture','/fixture/bridge',NULL,1)",
    PROJECT
  )
  run(
    'INSERT INTO model_versions' +
      '(id,project_id,parent_version,root_boundary_id,goal_snapshot,status,digest,created_at)' +
      " VALUES(?,?,NULL,NULL,'bridge model','published','digest-bridge',1)",
    MODEL,
    PROJECT
  )
  run(
    'INSERT INTO rdd_boundaries(model_version,id,name,responsibility_statement) VALUES(?,?,?,?)',
    MODEL,
    BOUNDARY,
    'bridge boundary',
    'own the canonical session bridge fixture'
  )
  run('UPDATE model_versions SET root_boundary_id=? WHERE id=?', BOUNDARY, MODEL)
  run('UPDATE projects SET active_model_version=? WHERE id=?', MODEL, PROJECT)
  run("INSERT INTO horizontal_roles(model_version,name) VALUES(?,'worker')", MODEL)
  run(
    'INSERT INTO rdd_roles(model_version,id,name,description,boundary_id,horizontal_role_name)' +
      " VALUES(?,?,?,?,?,'worker')",
    MODEL,
    ROLE,
    'bridge worker',
    'minimal worker role',
    BOUNDARY
  )
  run(
    'INSERT INTO role_interfaces(digest,model_version,role_id,requirements_json,judgment_scope_json)' +
      " VALUES(?,?,?,'[]','{}')",
    INTERFACE,
    MODEL,
    ROLE
  )
  run(
    'INSERT INTO harness_profiles(id,revision,state,recipe_json,capabilities_json,executable_identity_json)' +
      " VALUES(?,1,'verified','{}','{}',?)",
    PROFILE,
    JSON.stringify({ locator: '/usr/bin/' + HARNESS, versionRange: '>=1' })
  )
  run(
    'INSERT INTO harness_profiles' +
      '(id,revision,state,recipe_json,capabilities_json,executable_identity_json)' +
      " VALUES(?,1,'verified','{}','{}',?)",
    CODEX_PROFILE,
    JSON.stringify({ locator: CODEX_LOCATOR, versionRange: '>=1' })
  )
  run(
    'INSERT INTO role_implementations' +
      '(id,revision,interface_digest,profile_id,profile_revision,status,maintainer_role_id,' +
      'semantic_decision) VALUES(?,1,?,?,1,?,?,?)',
    IMPLEMENTATION,
    INTERFACE,
    PROFILE,
    'published',
    ROLE,
    'bridge fixture implementation'
  )
  run(
    'INSERT INTO execution_hosts(id,incarnation,protocol_version,state,identity_json)' +
      " VALUES(?,?,'1','live','{}')",
    HOST,
    'incarnation-bridge'
  )
  run("INSERT INTO principals(id,kind,status) VALUES(?,'member','active')", MEMBER)
  run(
    'INSERT INTO runs' +
      '(id,project_id,model_version,goal_text,purpose,coordinator_member_id,state,' +
      "current_plan_revision,revision) VALUES(?,?,?,'bridge goal','work',NULL,'active',NULL,1)",
    RUN,
    PROJECT,
    MODEL
  )
  run(
    'INSERT INTO members' +
      '(id,run_id,model_version,role_id,implementation_id,implementation_revision,generation,' +
      "current_execution_id,state,revision) VALUES(?,?,?,?,?,1,1,NULL,'assigned',1)",
    MEMBER,
    RUN,
    MODEL,
    ROLE,
    IMPLEMENTATION
  )
  run(
    'INSERT INTO grants(id,revision,kind,principal_id,parent_grant_id,policy_id,policy_revision,' +
      "expires_at,revoked_at,scope_json,actions_json) VALUES(?,1,'assignment',?,NULL,NULL,NULL," +
      "NULL,NULL,'{}','[]')",
    GRANT,
    MEMBER
  )
  run(
    'INSERT INTO assignments' +
      '(id,revision,member_id,kind,mandate_text,grant_id,task_id,task_revision,scope_json)' +
      " VALUES(?,1,?,'coordination','bridge mandate',?,NULL,NULL,'{}')",
    ASSIGNMENT,
    MEMBER,
    GRANT
  )
  run(
    'INSERT INTO content_blobs(digest,media_type,byte_length,body,external_ref,verified)' +
      " VALUES(?,'text/plain',7,?,NULL,1)",
    BODY,
    Buffer.from('bridge')
  )
  run(
    'INSERT INTO work_envelopes' +
      '(digest,assignment_id,assignment_revision,kind,body_digest,bindings_json)' +
      " VALUES(?,?,1,'coordination',?,'{}')",
    ENVELOPE,
    ASSIGNMENT,
    BODY
  )
}

/** one installation row; the locator is exact evidence, never a pattern */
function addInstallationRow(
  db: DatabaseSync,
  id: string,
  harnessId: string,
  configNamespace: string,
  dataNamespace: string,
  executableLocator: string
): void {
  db.prepare(
    'INSERT INTO inventory_installations' +
      '(id,machine_id,harness_id,executable_locator,config_namespace,data_namespace,' +
      'first_seen_at,last_seen_at,presence,origin,revision) VALUES(?,?,?,?,?,?,?,?,?,?,1)'
  ).run(
    id,
    MACHINE,
    harnessId,
    executableLocator,
    configNamespace,
    dataNamespace,
    NOW - 5000,
    NOW,
    'present',
    'discovered'
  )
}

interface BridgeOptions {
  /** false = discovery has not produced installations yet */
  installations?: boolean
}

/** one control DB on the real schema, plus the recovery deps as composed */
function bridge(options: BridgeOptions = {}): Bridge {
  const root = mkdtempSync(join(tmpdir(), 'mahas-session-bridge-'))
  const db = openControlDb(join(root, 'control.sqlite'))
  seedLocalFixture(db)
  for (const [id, label] of [
    [HARNESS, 'Claude'],
    [AMBIGUOUS_HARNESS, 'Codex']
  ] as const) {
    db.prepare(
      'INSERT INTO catalog_harnesses(id,publisher_organization_id,label,identity_metadata_json,revision)' +
        ' VALUES(?,NULL,?,?,1)'
    ).run(id, label, '{}')
  }
  db.prepare(
    'INSERT INTO inventory_machines(id,label,first_seen_at,last_seen_at,metadata_json,revision)' +
      ' VALUES(?,?,?,?,?,1)'
  ).run(MACHINE, 'local', NOW - 5000, NOW, '{}')
  if (options.installations !== false) {
    addInstallationRow(
      db,
      INSTALLATION,
      HARNESS,
      'config-bridge',
      DATA_NAMESPACE,
      '/usr/bin/' + HARNESS
    )
    addInstallationRow(
      db,
      CODEX_INSTALLATION,
      AMBIGUOUS_HARNESS,
      'config-codex-one',
      'data-codex-one',
      '/usr/bin/' + AMBIGUOUS_HARNESS
    )
    addInstallationRow(
      db,
      CODEX_INSTALLATION_TWO,
      AMBIGUOUS_HARNESS,
      'config-codex-two',
      'data-codex-two',
      CODEX_LOCATOR
    )
  }
  db.prepare(
    'INSERT INTO runtime_instances' +
      '(id,controller_epoch,state,process_identity_json,endpoint_incarnation) VALUES(?,?,?,?,?)'
  ).run('runtime-bridge', 1, 'ready', '{}', 'endpoint-bridge')

  const deps: RecoveryDeps = {
    withTx,
    appendDomainEvent,
    sha256Hex,
    authorize: () => {},
    connectHost: () => Promise.reject(new Error('no execution-host in this fixture')),
    makeCaller: () => () => Promise.reject(new Error('no sibling operations in this fixture')),
    now: () => NOW,
    newId: () => randomUUID()
  }
  return {
    db,
    deps,
    close: () => {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

interface LegacyHandleInput {
  harnessProfileId: string
  nativeId: string
  capturedBy: string
  capturedAt: number
  resumeSupport: string
}

function legacyHandle(input: LegacyHandleInput): LegacyHandleInput {
  return input
}

/** a managed execution in the shape the launch coordinator leaves behind */
function seedManagedExecution(
  db: DatabaseSync,
  executionId: string,
  generation: number,
  nativeConversationJson: string
): string {
  const planId = 'launch-plan-' + executionId
  const bundleDigest = 'bundle-' + executionId
  const surfaceDigest = 'surface-' + executionId
  const pins = {
    harnessProfileId: PROFILE,
    implementationId: IMPLEMENTATION,
    implementationRevision: 1,
    interfaceDigest: INTERFACE
  }
  db.prepare(
    'INSERT INTO command_surfaces(digest,actions_and_schemas_json,policy_pins_json) VALUES(?,?,?)'
  ).run(surfaceDigest, '{}', '{}')
  db.prepare(
    'INSERT INTO context_bundles' +
      '(digest,implementation_id,implementation_revision,interface_digest,surface_digest,' +
      'required_text_digest,manifest_json,source_observations_json) VALUES(?,?,1,?,?,?,?,?)'
  ).run(bundleDigest, IMPLEMENTATION, INTERFACE, surfaceDigest, BODY, '{}', '[]')
  db.prepare(
    'INSERT INTO launch_plans' +
      '(id,assignment_id,assignment_revision,digest,bundle_digest,envelope_digest,surface_digest,' +
      'state,process_spec_json,pins_json,reservations_json) VALUES(?,?,1,?,?,?,?,?,?,?,?)'
  ).run(
    planId,
    ASSIGNMENT,
    'plan-digest-' + executionId,
    bundleDigest,
    ENVELOPE,
    surfaceDigest,
    'prepared',
    '{}',
    JSON.stringify(pins),
    '{}'
  )
  db.prepare(
    'INSERT INTO executions' +
      '(id,member_id,generation,host_id,launch_plan_id,state,liveness,terminal_id,' +
      'process_identity_json,native_conversation_json,revision) VALUES(?,?,?,?,?,?,?,NULL,?,?,1)'
  ).run(
    executionId,
    MEMBER,
    generation,
    HOST,
    planId,
    // already exited with exit evidence: native-resume's precondition is a dead
    // prior process, and the fixture must not pretend to probe a host
    'exited',
    'exited',
    JSON.stringify({ pid: 4242, observedExit: { code: 0, at: NOW } }),
    nativeConversationJson
  )
  return planId
}

/** a session the collector may also have written (same deterministic rules) */
function seedCanonicalSession(
  db: DatabaseSync,
  input: {
    id: string
    namespace: string
    nativeSessionKey: string
    nativeId: string
    handleId: string
    resumeSupport: 'supported' | 'unsupported' | 'unknown'
    harnessProfileId: string | null
  }
): void {
  upsertHarnessSession(db, {
    id: input.id,
    harnessId: HARNESS,
    originMachineId: MACHINE,
    namespace: input.namespace,
    nativeSessionKey: input.nativeSessionKey,
    parentSessionId: null,
    title: null,
    firstObservedAt: NOW - 100,
    lastObservedAt: NOW - 10,
    metadata: {}
  })
  putSessionHandle(db, {
    id: input.handleId,
    sessionId: input.id,
    installationId: INSTALLATION,
    nativeId: input.nativeId,
    locator: input.harnessProfileId ? { harnessProfileId: input.harnessProfileId } : null,
    resumeSupport: input.resumeSupport,
    observedAt: NOW - 10,
    evidence: []
  })
}

function operatorContext(): AuthenticatedContext {
  return {
    principalId: 'operator-local',
    controllerEpoch: 1,
    grantRevisions: {},
    transportSessionId: 'session-bridge-fixture'
  } as AuthenticatedContext
}

function txnOf(db: DatabaseSync): TxnContext {
  return {
    db,
    ctx: operatorContext(),
    emitEvent: () => {},
    intendEffect: () => 'effect-unused'
  }
}

/** run an operation that must be refused; returns its coded failure */
async function refusal(run: () => Promise<unknown>): Promise<{ code: string; retry: string }> {
  try {
    await run()
  } catch (error) {
    const shaped = error as { code?: string; retry?: string }
    if (typeof shaped.code !== 'string') throw error
    return { code: shaped.code, retry: shaped.retry ?? 'none' }
  }
  throw new Error('expected the operation to be refused')
}

async function main(): Promise<void> {
  const fixture = bridge()
  const db = fixture.db
  const deps = fixture.deps
  try {
    // ---- every execution this fixture reasons about exists up front, so the
    // ---- 'a conversion never creates a Task/Execution' check stays meaningful
    seedManagedExecution(
      db,
      'exec-legacy-unknown',
      1,
      JSON.stringify(
        legacyHandle({
          harnessProfileId: PROFILE,
          nativeId: 'native-unknown',
          capturedBy: 'launch',
          capturedAt: NOW - 100,
          resumeSupport: 'supported'
        })
      )
    )
    seedManagedExecution(
      db,
      'exec-legacy-codex',
      2,
      JSON.stringify(
        legacyHandle({
          harnessProfileId: 'profile-codex',
          nativeId: 'native-codex',
          capturedBy: 'hook',
          capturedAt: NOW - 50,
          resumeSupport: 'unknown'
        })
      )
    )
    seedManagedExecution(db, 'exec-no-handle', 3, 'null')
    seedManagedExecution(db, 'exec-empty-handle', 4, '{}')
    seedManagedExecution(
      db,
      'exec-collected',
      5,
      JSON.stringify(
        legacyHandle({
          harnessProfileId: PROFILE,
          nativeId: 'native-collected',
          capturedBy: 'launch',
          capturedAt: NOW - 5,
          resumeSupport: 'supported'
        })
      )
    )
    seedManagedExecution(
      db,
      'exec-duplicate-native',
      6,
      JSON.stringify(
        legacyHandle({
          harnessProfileId: PROFILE,
          nativeId: 'native-shared',
          capturedBy: 'launch',
          capturedAt: NOW - 5,
          resumeSupport: 'supported'
        })
      )
    )
    seedManagedExecution(
      db,
      'exec-resume',
      7,
      JSON.stringify(
        legacyHandle({
          harnessProfileId: PROFILE,
          nativeId: 'native-resume',
          capturedBy: 'launch',
          capturedAt: NOW - 5,
          resumeSupport: 'supported'
        })
      )
    )
    seedManagedExecution(
      db,
      'exec-resume-implicit',
      8,
      JSON.stringify(
        legacyHandle({
          harnessProfileId: PROFILE,
          nativeId: 'native-resume',
          capturedBy: 'launch',
          capturedAt: NOW - 5,
          resumeSupport: 'supported'
        })
      )
    )
    seedManagedExecution(
      db,
      'exec-resume-weak',
      9,
      JSON.stringify(
        legacyHandle({
          harnessProfileId: PROFILE,
          nativeId: 'native-weak',
          capturedBy: 'launch',
          capturedAt: NOW - 5,
          resumeSupport: 'unknown'
        })
      )
    )
    seedManagedExecution(
      db,
      'exec-resume-mismatch',
      10,
      JSON.stringify(
        legacyHandle({
          harnessProfileId: PROFILE,
          nativeId: 'native-mismatch',
          capturedBy: 'launch',
          capturedAt: NOW - 5,
          resumeSupport: 'supported'
        })
      )
    )
    seedManagedExecution(
      db,
      'exec-legacy-resume',
      11,
      JSON.stringify(
        legacyHandle({
          harnessProfileId: PROFILE,
          nativeId: 'native-legacy',
          capturedBy: 'launch',
          capturedAt: NOW - 5,
          resumeSupport: 'supported'
        })
      )
    )
    seedManagedExecution(
      db,
      'exec-resolver-refusal',
      12,
      JSON.stringify(
        legacyHandle({
          harnessProfileId: PROFILE,
          nativeId: 'native-resolver',
          capturedBy: 'launch',
          capturedAt: NOW - 5,
          resumeSupport: 'supported'
        })
      )
    )

    // ---- canonical sessions the collector could have stored (same rules)
    seedCanonicalSession(db, {
      id: 'collected-session',
      namespace: EXPECTED_NAMESPACE,
      nativeSessionKey: 'native-collected',
      nativeId: 'native-collected',
      handleId: 'collected-handle',
      resumeSupport: 'supported',
      harnessProfileId: PROFILE
    })
    seedCanonicalSession(db, {
      id: 'resume-session',
      namespace: EXPECTED_NAMESPACE,
      nativeSessionKey: 'native-resume',
      nativeId: 'native-resume',
      handleId: 'resume-handle',
      resumeSupport: 'supported',
      harnessProfileId: PROFILE
    })
    seedCanonicalSession(db, {
      id: 'weak-session',
      namespace: EXPECTED_NAMESPACE,
      nativeSessionKey: 'native-weak',
      nativeId: 'native-weak',
      handleId: 'weak-handle',
      resumeSupport: 'unknown',
      harnessProfileId: PROFILE
    })
    seedCanonicalSession(db, {
      id: 'mismatch-session',
      namespace: EXPECTED_NAMESPACE,
      nativeSessionKey: 'native-mismatch',
      nativeId: 'native-mismatch',
      handleId: 'mismatch-handle',
      resumeSupport: 'supported',
      harnessProfileId: 'profile-other'
    })
    seedCanonicalSession(db, {
      id: 'duplicate-session-a',
      namespace: 'installation:' + INSTALLATION + ':' + DATA_NAMESPACE + ':one',
      nativeSessionKey: 'native-shared',
      nativeId: 'native-shared',
      handleId: 'duplicate-handle-a',
      resumeSupport: 'supported',
      harnessProfileId: PROFILE
    })
    seedCanonicalSession(db, {
      id: 'duplicate-session-b',
      namespace: 'installation:' + INSTALLATION + ':' + DATA_NAMESPACE + ':two',
      nativeSessionKey: 'native-shared',
      nativeId: 'native-shared',
      handleId: 'duplicate-handle-b',
      resumeSupport: 'supported',
      harnessProfileId: PROFILE
    })

    const executionsBefore = count(db, 'executions')
    const tasksBefore = count(db, 'tasks')
    const sessionsBefore = count(db, 'harness_sessions')

    // ---- 1. legacy handle without evidence: unresolved, nothing written
    const unresolvedReport = backfillLegacyExecutionSessions(deps, db, {
      executionIds: ['exec-legacy-unknown'],
      resolveHarness: () => null
    })
    assert.equal(unresolvedReport.scanned, 1)
    assert.equal(unresolvedReport.migrated, 0)
    assert.equal(unresolvedReport.alreadyCanonical, 0)
    assert.equal(unresolvedReport.unsupported.length, 1)
    assert.equal(unresolvedReport.unsupported[0]?.reason, 'no-harness-evidence')
    assert.equal(count(db, 'harness_sessions'), sessionsBefore)
    assert.equal(count(db, 'session_attachments'), 0)
    const unresolvedVerdict = resolveExecutionSession(db, executionRow(db, 'exec-legacy-unknown'))
    assert.equal(unresolvedVerdict.kind, 'unresolved')
    if (unresolvedVerdict.kind === 'unresolved') {
      assert.equal(unresolvedVerdict.reason, 'no-harness-evidence')
    }

    // ---- 2. explicit evidence: canonical rows with the collector's identity
    const migrated = backfillExecutionSession(deps, db, {
      executionId: 'exec-legacy-unknown',
      harness: {
        harnessId: HARNESS,
        installationId: INSTALLATION,
        basis: 'operator mapping: profile-f062 is the claude installation'
      }
    })
    const expectedSessionId = stableSessionId(HARNESS, EXPECTED_NAMESPACE, 'native-unknown')
    assert.equal(migrated.status, 'migrated')
    assert.equal(migrated.sessionId, expectedSessionId)
    assert.equal(migrated.handleId, stableSessionHandleId(expectedSessionId, 'native-unknown'))
    assert.deepEqual(migrated.created, { session: true, handle: true, attachment: true })
    assert.equal(migrated.linked, true)
    assert.equal(migrated.referenceStamped, true, 'schema v3 records the explicit reference')
    const referenceRow = column(
      db,
      'SELECT * FROM ' + EXECUTION_SESSION_REF_TABLE + ' WHERE execution_id=?',
      'exec-legacy-unknown'
    )
    assert.equal(referenceRow.session_id, expectedSessionId)
    assert.equal(referenceRow.session_handle_id, migrated.handleId)
    assert.equal(referenceRow.evidence, 'legacy-backfill')
    assert.equal(referenceRow.revision, 1)
    const sessionRow = column(db, 'SELECT * FROM harness_sessions WHERE id=?', expectedSessionId)
    assert.equal(sessionRow.harness_id, HARNESS)
    assert.equal(sessionRow.namespace, EXPECTED_NAMESPACE)
    assert.equal(sessionRow.native_session_key, 'native-unknown')
    assert.equal(sessionRow.origin_machine_id, MACHINE)
    const metadata = JSON.parse(String(sessionRow.metadata_json)) as Record<string, unknown>
    assert.equal(metadata.harnessProfileId, PROFILE)
    const handleRow = column(
      db,
      'SELECT * FROM session_handles WHERE id=?',
      migrated.handleId as string
    )
    assert.equal(handleRow.resume_support, 'supported')
    assert.equal(handleRow.installation_id, INSTALLATION)
    assert.equal(handleRow.native_id, 'native-unknown')
    const attachmentRow = column(
      db,
      'SELECT * FROM session_attachments WHERE id=?',
      migrated.attachmentId as string
    )
    assert.equal(attachmentRow.execution_id, 'exec-legacy-unknown')
    assert.equal(attachmentRow.session_id, expectedSessionId)
    assert.equal(attachmentRow.machine_id, MACHINE)
    assert.equal(count(db, 'domain_events', "event_type='execution.session-reference-migrated'"), 1)

    // ---- 3. idempotent second run: same ids, no duplicate rows, no new event
    const rerun = backfillExecutionSession(deps, db, {
      executionId: 'exec-legacy-unknown',
      harness: {
        harnessId: HARNESS,
        installationId: INSTALLATION,
        basis: 'operator mapping: profile-f062 is the claude installation'
      }
    })
    assert.equal(rerun.status, 'already-canonical')
    assert.equal(rerun.sessionId, expectedSessionId)
    assert.equal(rerun.handleId, migrated.handleId)
    assert.equal(rerun.attachmentId, migrated.attachmentId)
    assert.equal(rerun.linked, false)
    assert.equal(rerun.referenceStamped, false, 'no reference churn on a re-run')
    assert.equal(rerun.created, undefined)
    assert.equal(count(db, 'harness_sessions'), sessionsBefore + 1)
    assert.equal(count(db, 'session_attachments'), 1)
    assert.equal(
      column(
        db,
        'SELECT revision FROM ' + EXECUTION_SESSION_REF_TABLE + ' WHERE execution_id=?',
        'exec-legacy-unknown'
      ).revision,
      1
    )
    assert.equal(count(db, 'domain_events', "event_type='execution.session-reference-migrated'"), 1)

    // ---- 4. no evidence / ambiguous evidence / conflicting evidence refuse
    const unknownHarness = backfillExecutionSession(deps, db, {
      executionId: 'exec-legacy-codex',
      harness: { harnessId: 'not-a-harness', basis: 'fixture typo' }
    })
    assert.equal(unknownHarness.status, 'unsupported')
    assert.equal(unknownHarness.reason, 'unknown-harness')
    const ambiguousInstallation = backfillExecutionSession(deps, db, {
      executionId: 'exec-legacy-codex',
      harness: { harnessId: AMBIGUOUS_HARNESS, basis: 'harness-only evidence' }
    })
    assert.equal(ambiguousInstallation.reason, 'ambiguous-installation')
    const conflictingInstallation = backfillExecutionSession(deps, db, {
      executionId: 'exec-legacy-codex',
      harness: {
        harnessId: AMBIGUOUS_HARNESS,
        installationId: INSTALLATION,
        basis: 'wrong install'
      }
    })
    assert.equal(conflictingInstallation.reason, 'harness-conflict')
    assert.equal(count(db, 'harness_sessions'), sessionsBefore + 1)

    // ---- 5. unknown resume support is preserved, never promoted
    const codex = backfillExecutionSession(deps, db, {
      executionId: 'exec-legacy-codex',
      harness: {
        harnessId: AMBIGUOUS_HARNESS,
        installationId: CODEX_INSTALLATION,
        basis: 'fixture'
      }
    })
    assert.equal(codex.status, 'migrated')
    const codexHandle = column(
      db,
      'SELECT * FROM session_handles WHERE id=?',
      codex.handleId as string
    )
    assert.equal(codexHandle.resume_support, 'unknown')
    assert.equal(codexHandle.native_id, 'native-codex')
    const codexNamespace =
      'installation:' + CODEX_INSTALLATION + ':' + 'data-codex-one' + ':default'
    assert.equal(count(db, 'harness_sessions', "namespace='" + codexNamespace + "'"), 1)

    // ---- 6. exact native-id equality reuses the collected session
    const collected = resolveExecutionSession(db, executionRow(db, 'exec-collected'))
    assert.equal(collected.kind, 'resolved')
    if (collected.kind === 'resolved') {
      assert.equal(collected.evidence, 'native-id-handle')
      assert.equal(collected.ref.sessionId, 'collected-session')
      assert.equal(collected.ref.handleId, 'collected-handle')
      assert.equal(collected.ref.harnessProfileId, PROFILE)
    }
    const before = count(db, 'harness_sessions')
    const attachmentsBefore = count(db, 'session_attachments')
    const linked = backfillExecutionSession(deps, db, {
      executionId: 'exec-collected',
      harness: { harnessId: HARNESS, installationId: INSTALLATION, basis: 'fixture' }
    })
    assert.equal(linked.status, 'already-canonical')
    assert.equal(linked.sessionId, 'collected-session')
    assert.equal(linked.handleId, 'collected-handle')
    assert.equal(linked.linked, true, 'the execution link is recorded the first time')
    assert.equal(count(db, 'harness_sessions'), before, 'no duplicate session row')
    const linkedRerun = backfillExecutionSession(deps, db, {
      executionId: 'exec-collected',
      harness: { harnessId: HARNESS, installationId: INSTALLATION, basis: 'fixture' }
    })
    assert.equal(linkedRerun.linked, false)
    assert.equal(count(db, 'session_attachments'), attachmentsBefore + 1)

    // ---- 7. one native id in two sessions: ambiguous, no pick
    const duplicate = resolveExecutionSession(db, executionRow(db, 'exec-duplicate-native'))
    assert.equal(duplicate.kind, 'unresolved')
    if (duplicate.kind === 'unresolved') {
      assert.equal(duplicate.reason, 'ambiguous-native-id')
    }

    // ---- 8. legacy JSON shapes without a native key
    const noHandle = resolveExecutionSession(db, executionRow(db, 'exec-no-handle'))
    assert.equal(noHandle.kind === 'unresolved' ? noHandle.reason : '', 'no-legacy-handle')
    const emptyHandle = resolveExecutionSession(db, executionRow(db, 'exec-empty-handle'))
    assert.equal(
      emptyHandle.kind === 'unresolved' ? emptyHandle.reason : '',
      'malformed-legacy-handle'
    )
    const emptyConversion = backfillExecutionSession(deps, db, {
      executionId: 'exec-empty-handle',
      harness: { harnessId: HARNESS, installationId: INSTALLATION, basis: 'fixture' }
    })
    assert.equal(emptyConversion.status, 'unsupported')
    assert.equal(emptyConversion.reason, 'malformed-legacy-handle')

    // ---- 9. worker.resume: canonical handle, explicit selection
    const handler = makeResumeHandler(deps)
    const txn = txnOf(db)
    const admitted = await handler(txn, {
      memberId: MEMBER,
      priorExecutionId: 'exec-resume',
      resumeKind: 'native-resume',
      sessionHandle: { sessionHandleId: 'resume-handle' }
    })
    assert.equal(admitted.admission, 'verified')
    assert.equal(admitted.canonicalSession?.sessionId, 'resume-session')
    assert.equal(admitted.canonicalSession?.handleId, 'resume-handle')
    assert.equal(admitted.canonicalSession?.harnessProfileId, PROFILE)
    assert.equal(admitted.sessionEvidence, 'explicit-selection')
    assert.equal(admitted.newGeneration, 8)
    assert.equal(admitted.nativeHandle, undefined, 'the canonical path echoes no legacy handle')
    assert.equal(count(db, 'domain_events', "event_type='execution.native-resume-admitted'"), 1)

    // ---- 10. worker.resume: execution-derived canonical resolution
    const admittedImplicit = await handler(txn, {
      memberId: MEMBER,
      priorExecutionId: 'exec-resume-implicit',
      resumeKind: 'native-resume'
    })
    assert.equal(admittedImplicit.admission, 'verified')
    assert.equal(admittedImplicit.canonicalSession?.sessionId, 'resume-session')
    assert.equal(admittedImplicit.sessionEvidence, 'native-id-handle')
    assert.equal(admittedImplicit.newGeneration, 9)

    // ---- 11. refusals keep the previous semantics (no generation bump)
    const generationBefore = column(
      db,
      'SELECT generation FROM members WHERE id=?',
      MEMBER
    ).generation
    const weakRecipe = resolveResumeRecipe(db, executionRow(db, 'exec-resume-weak'), {
      profileId: PROFILE,
      selection: { sessionHandleId: 'weak-handle' }
    })
    assert.equal(weakRecipe.kind, 'no-recipe')
    if (weakRecipe.kind === 'no-recipe') assert.equal(weakRecipe.reason, 'unsupported')
    const mismatchRecipe = resolveResumeRecipe(db, executionRow(db, 'exec-resume-mismatch'), {
      profileId: PROFILE,
      selection: { sessionHandleId: 'mismatch-handle' }
    })
    assert.equal(mismatchRecipe.kind, 'no-recipe')
    if (mismatchRecipe.kind === 'no-recipe') {
      assert.equal(mismatchRecipe.reason, 'profile-not-evidenced')
    }
    const unknownRecipe = resolveResumeRecipe(db, executionRow(db, 'exec-resume'), {
      profileId: PROFILE,
      selection: { sessionHandleId: 'no-such-handle' }
    })
    assert.equal(unknownRecipe.kind, 'no-recipe')
    if (unknownRecipe.kind === 'no-recipe') assert.equal(unknownRecipe.reason, 'session-not-found')
    const unresolvableRecipe = resolveResumeRecipe(db, executionRow(db, 'exec-no-handle'), {
      profileId: PROFILE
    })
    assert.equal(unresolvableRecipe.kind, 'unresolved')
    if (unresolvableRecipe.kind === 'unresolved') {
      assert.equal(unresolvableRecipe.reason, 'no-legacy-handle')
    }
    const weak = await refusal(() =>
      handler(txn, {
        memberId: MEMBER,
        priorExecutionId: 'exec-resume-weak',
        resumeKind: 'native-resume',
        sessionHandle: { sessionHandleId: 'weak-handle' }
      })
    )
    assert.equal(weak.code, 'INJECTION_UNSUPPORTED')
    const mismatch = await refusal(() =>
      handler(txn, {
        memberId: MEMBER,
        priorExecutionId: 'exec-resume-mismatch',
        resumeKind: 'native-resume',
        sessionHandle: { sessionHandleId: 'mismatch-handle' }
      })
    )
    assert.equal(mismatch.code, 'INJECTION_UNSUPPORTED')
    const unknownHandle = await refusal(() =>
      handler(txn, {
        memberId: MEMBER,
        priorExecutionId: 'exec-resume',
        resumeKind: 'native-resume',
        sessionHandle: { sessionHandleId: 'no-such-handle' }
      })
    )
    assert.equal(unknownHandle.code, 'INJECTION_UNSUPPORTED')
    const noHandleSelection = await refusal(() =>
      handler(txn, {
        memberId: MEMBER,
        priorExecutionId: 'exec-resume',
        resumeKind: 'native-resume',
        sessionHandle: { sessionId: 'no-such-session' }
      })
    )
    assert.equal(noHandleSelection.code, 'INJECTION_UNSUPPORTED')
    const noSelection = await refusal(() =>
      handler(txn, {
        memberId: MEMBER,
        priorExecutionId: 'exec-no-handle',
        resumeKind: 'native-resume'
      })
    )
    assert.equal(noSelection.code, 'INJECTION_UNSUPPORTED')
    assert.equal(
      column(db, 'SELECT generation FROM members WHERE id=?', MEMBER).generation,
      generationBefore,
      'a refused resume never advances the member generation'
    )
    assert.equal(count(db, 'domain_events', "event_type='execution.native-resume-admitted'"), 2)

    // ---- 12. the legacy resume_candidates path is unchanged
    db.prepare(
      'INSERT INTO resume_candidates(id,execution_id,support_state,native_handle_json,evidence_json)' +
        ' VALUES(?,?,?,?,?)'
    ).run(
      'legacy-candidate',
      'exec-legacy-resume',
      'supported',
      JSON.stringify(
        legacyHandle({
          harnessProfileId: PROFILE,
          nativeId: 'native-legacy',
          capturedBy: 'launch',
          capturedAt: NOW - 5,
          resumeSupport: 'supported'
        })
      ),
      '{}'
    )
    const legacyAdmission = await handler(txn, {
      memberId: MEMBER,
      priorExecutionId: 'exec-legacy-resume',
      resumeKind: 'native-resume',
      nativeHandle: legacyHandle({
        harnessProfileId: PROFILE,
        nativeId: 'native-legacy',
        capturedBy: 'launch',
        capturedAt: NOW - 5,
        resumeSupport: 'supported'
      })
    })
    assert.equal(legacyAdmission.admission, 'verified')
    assert.equal(legacyAdmission.canonicalSession, undefined)
    assert.equal(legacyAdmission.nativeHandle?.nativeId, 'native-legacy')
    assert.equal(legacyAdmission.sessionEvidence, undefined)

    // ---- 13. no Task or Execution was created by any conversion
    assert.equal(count(db, 'tasks'), tasksBefore)
    assert.equal(count(db, 'executions'), executionsBefore)

    // ---- 14. a database that predates the reference table still converts: the
    // ---- attachment stays authoritative and the reference is skipped
    const withReference = bridge()
    try {
      withReference.db.exec('DROP TABLE ' + EXECUTION_SESSION_REF_TABLE)
      seedManagedExecution(
        withReference.db,
        'exec-reference',
        1,
        JSON.stringify(
          legacyHandle({
            harnessProfileId: PROFILE,
            nativeId: 'native-reference',
            capturedBy: 'launch',
            capturedAt: NOW - 5,
            resumeSupport: 'supported'
          })
        )
      )
      const preReference = executionRow(withReference.db, 'exec-reference')
      assert.equal(preReference.sessionId, null, 'no reference row: unresolved, not an empty id')
      const stamped = backfillExecutionSession(withReference.deps, withReference.db, {
        executionId: 'exec-reference',
        harness: { harnessId: HARNESS, installationId: INSTALLATION, basis: 'fixture' }
      })
      assert.equal(stamped.status, 'migrated')
      assert.equal(
        stamped.referenceStamped,
        false,
        'a database without the reference table converts through attachments only'
      )
      const reloaded = executionRow(withReference.db, 'exec-reference')
      const fallbackVerdict = resolveExecutionSession(withReference.db, reloaded)
      assert.equal(fallbackVerdict.kind, 'resolved')
      if (fallbackVerdict.kind === 'resolved') {
        assert.equal(fallbackVerdict.evidence, 'execution-attachment')
        assert.equal(fallbackVerdict.ref.sessionId, stamped.sessionId)
      }
      const recipe = resolveResumeRecipe(withReference.db, reloaded, { profileId: PROFILE })
      assert.equal(recipe.kind, 'recipe')
      // a re-run changes nothing: no duplicate attachment
      const stampedRerun = backfillExecutionSession(withReference.deps, withReference.db, {
        executionId: 'exec-reference'
      })
      assert.equal(stampedRerun.status, 'already-canonical')
      assert.equal(stampedRerun.linked, false)
      assert.equal(stampedRerun.referenceStamped, false)
      assert.equal(count(withReference.db, 'session_attachments'), 1)
    } finally {
      withReference.close()
    }

    // ---- 15. production resolver: registered profile → Pack launcher evidence
    const launcherPack = {
      profiles: {
        [PROFILE]: { harnessId: HARNESS, revision: 1 },
        [CODEX_PROFILE]: { harnessId: AMBIGUOUS_HARNESS, revision: 1 }
      }
    } as unknown as HarnessRuntimePack
    const pointerFor = (
      profileId: string | null
    ): Parameters<ReturnType<typeof harnessEvidenceResolver>>[0] => ({
      executionId: 'exec-resolver-refusal',
      memberId: MEMBER,
      state: 'ready',
      harnessProfileId: profileId,
      nativeId: 'native-resolver',
      capturedBy: 'launch',
      capturedAt: NOW - 5,
      resumeSupport: 'supported'
    })
    const resolveWith = (
      options: HarnessEvidenceOptions
    ): ReturnType<typeof harnessEvidenceResolver> => harnessEvidenceResolver(db, options)
    const packAndMachine = { pack: launcherPack, machineId: MACHINE }

    // (a) an unregistered profile id is never mapped by name similarity
    assert.equal(resolveWith(packAndMachine)(pointerFor('profile-brid')), null)
    // (b) a registered profile the Pack revision does not lower stays unresolved
    assert.equal(
      resolveWith({ pack: { profiles: {} } as unknown as HarnessRuntimePack })(pointerFor(PROFILE)),
      null
    )
    // (c) registered profile + Pack launcher evidence → harness, machine, installation
    const resolvedEvidence = resolveWith(packAndMachine)(pointerFor(PROFILE))
    assert.ok(resolvedEvidence, 'registered profile with Pack launcher evidence resolves')
    assert.equal(resolvedEvidence.harnessId, HARNESS)
    assert.equal(resolvedEvidence.machineId, MACHINE)
    assert.equal(resolvedEvidence.installationId, INSTALLATION)
    assert.match(resolvedEvidence.basis, /declares harnessId claude/)
    // (d) the same profile from a machine with no installation: evidence without
    // an installation, so the bridge refuses rather than borrowing another host
    const foreignMachine = resolveWith({ pack: launcherPack, machineId: 'machine-elsewhere' })(
      pointerFor(PROFILE)
    )
    assert.ok(foreignMachine)
    assert.equal(foreignMachine.installationId, undefined)
    const refusedForeignMachine = backfillExecutionSession(deps, db, {
      executionId: 'exec-resolver-refusal',
      harness: foreignMachine
    })
    assert.equal(refusedForeignMachine.status, 'unsupported')
    assert.equal(refusedForeignMachine.reason, 'unknown-installation')
    // (e) two installations of one harness: only an exact executable path decides
    const exactLocator = resolveWith(packAndMachine)(pointerFor(CODEX_PROFILE))
    assert.ok(exactLocator)
    assert.equal(exactLocator.harnessId, AMBIGUOUS_HARNESS)
    assert.equal(exactLocator.installationId, CODEX_INSTALLATION_TWO)
    assert.match(exactLocator.basis, /exact executable path/)
    // (f) an override wins over Pack data and needs no profile row
    const overrideResolver = resolveWith({
      pack: launcherPack,
      machineId: MACHINE,
      overrides: { 'profile-unregistered': { harnessId: HARNESS, basis: 'operator mapping' } }
    })
    assert.equal(overrideResolver(pointerFor('profile-unregistered')), null)
    // (g) a convertible execution goes through the resolver unchanged
    const converted = backfillExecutionSession(deps, db, {
      executionId: 'exec-resolver-refusal',
      harness: resolvedEvidence
    })
    assert.equal(converted.status, 'migrated')
    const convertedSession = column(
      db,
      'SELECT * FROM harness_sessions WHERE id=?',
      converted.sessionId as string
    )
    assert.equal(convertedSession.harness_id, HARNESS)
    assert.equal(convertedSession.namespace, EXPECTED_NAMESPACE)

    // ---- 16. repeatable pass: bounded, persisted, retried after discovery
    const discovery = bridge({ installations: false })
    try {
      // both tables ship with the (still unreleased) v3 migration; create either
      // one only when this tree has not composed that version yet
      const ensure = (table: string, ddl: string): void => {
        const present = discovery.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get(table)
        if (!present) discovery.db.exec(ddl)
      }
      ensure(EXECUTION_SESSION_REF_TABLE, EXECUTION_SESSION_REF_SCHEMA_SQL)
      ensure(EXECUTION_SESSION_BACKFILL_STATE_TABLE, EXECUTION_SESSION_BACKFILL_STATE_SCHEMA_SQL)
      for (const [executionId, generation, nativeId] of [
        ['exec-discovery-a', 1, 'native-discovery-a'],
        ['exec-discovery-b', 2, 'native-discovery-b'],
        ['exec-discovery-c', 3, 'native-discovery-c']
      ] as const) {
        seedManagedExecution(
          discovery.db,
          executionId,
          generation,
          JSON.stringify(
            legacyHandle({
              harnessProfileId: PROFILE,
              nativeId,
              capturedBy: 'launch',
              capturedAt: NOW - 5,
              resumeSupport: 'supported'
            })
          )
        )
      }
      const resolveHarness = harnessEvidenceResolver(discovery.db, {
        pack: launcherPack,
        machineId: MACHINE
      })
      // pass 1: inventory is still empty — unsupported, but the cursor advances
      const firstPass = runExecutionSessionBackfillPass(discovery.deps, discovery.db, {
        resolveHarness,
        limit: 2
      })
      assert.equal(firstPass.scanned, 2)
      assert.equal(firstPass.migrated, 0)
      assert.equal(firstPass.unsupported.length, 2)
      assert.equal(firstPass.unsupported[0]?.reason, 'unknown-installation')
      assert.equal(firstPass.cursorPersisted, true)
      assert.equal(firstPass.wrapped, false)
      assert.equal(firstPass.fromCursor, null)
      assert.equal(
        column(
          discovery.db,
          'SELECT cursor_execution_id FROM ' +
            EXECUTION_SESSION_BACKFILL_STATE_TABLE +
            ' WHERE id=?',
          LEGACY_NATIVE_CONVERSATION_BACKFILL_ID
        ).cursor_execution_id,
        firstPass.nextCursor
      )
      // pass 2: continues from the cursor and wraps
      const secondPass = runExecutionSessionBackfillPass(discovery.deps, discovery.db, {
        resolveHarness,
        limit: 2
      })
      assert.equal(secondPass.fromCursor, firstPass.nextCursor)
      assert.equal(secondPass.scanned, 1)
      assert.equal(secondPass.wrapped, true)
      assert.equal(secondPass.nextCursor, null)
      // discovery lands, and the wrapped pass converts what was unsupported
      addInstallationRow(
        discovery.db,
        INSTALLATION,
        HARNESS,
        'config-bridge',
        DATA_NAMESPACE,
        '/usr/bin/' + HARNESS
      )
      const thirdPass = runExecutionSessionBackfillPass(discovery.deps, discovery.db, {
        resolveHarness,
        limit: 2
      })
      assert.equal(thirdPass.fromCursor, null)
      assert.equal(thirdPass.migrated, 2)
      assert.equal(thirdPass.unsupported.length, 0, 'a retried pass converts after discovery')
      assert.equal(count(discovery.db, 'harness_sessions'), 2)
      const fourthPass = runExecutionSessionBackfillPass(discovery.deps, discovery.db, {
        resolveHarness,
        limit: 2
      })
      assert.equal(fourthPass.migrated, 1)
      assert.equal(count(discovery.db, 'harness_sessions'), 3)
      // settled: later passes report the reference and write nothing
      const sessionsAfterSettling = count(discovery.db, 'harness_sessions')
      const attachmentsAfterSettling = count(discovery.db, 'session_attachments')
      const fifthPass = runExecutionSessionBackfillPass(discovery.deps, discovery.db, {
        resolveHarness,
        limit: 2
      })
      assert.equal(fifthPass.migrated, 0)
      assert.equal(fifthPass.alreadyCanonical, 2)
      assert.equal(count(discovery.db, 'harness_sessions'), sessionsAfterSettling)
      assert.equal(count(discovery.db, 'session_attachments'), attachmentsAfterSettling)
      // a database without the progress table still backfills; it just cannot
      // remember where it stopped, and says so
      discovery.db.exec('DROP TABLE ' + EXECUTION_SESSION_BACKFILL_STATE_TABLE)
      const statelessPass = runExecutionSessionBackfillPass(discovery.deps, discovery.db, {
        resolveHarness,
        limit: 2
      })
      assert.equal(statelessPass.cursorPersisted, false)
      assert.equal(statelessPass.fromCursor, null)
      assert.equal(statelessPass.migrated, 0)
      assert.equal(statelessPass.alreadyCanonical, 2)
    } finally {
      discovery.close()
    }

    console.log('PASS session-handles bridge (recovery)')
    console.log('  resolve: legacy JSON without evidence -> unresolved, nothing written')
    console.log('  backfill: explicit evidence -> canonical session/handle/attachment, idempotent')
    console.log('  backfill: unknown harness / ambiguous installation / conflict -> refused')
    console.log('  backfill: exact native-id match reuses the collected session')
    console.log('  resume: canonical supported handle admitted; unknown/mismatched refused')
    console.log('  resume: legacy resume_candidates path unchanged')
    console.log('  reference table: v3 additive, stamped when present, NULL read as unresolved')
    console.log(
      '  resolver: registered profile -> Pack harnessId evidence, exact installation only'
    )
    console.log('  pass: bounded, persisted cursor, retried after discovery refresh')
  } finally {
    fixture.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
