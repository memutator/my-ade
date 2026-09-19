// F-062 regression: assignment ancestry + launch's internal service boundary.
//
// Run: node packages/mahas-runtime/src/access/f062-assignment-service.smoke.ts
//
// This deliberately starts from a freshly migrated control DB.  In particular,
// the member grant contains only worker.prepare and is scoped only to its run:
// there is no explicit assignment target and no context.build action.  The
// prepare must therefore rely on assignment -> member/run ancestry, while its
// nested context.build must use composeRuntime's narrow service principal.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext, CommandReceipt } from '../../../mahas-contracts/src/index.ts'
import { composeRuntime } from '../composition.ts'
import { openControlDb } from '../storage/db.ts'

export const IDS = {
  project: 'project-f062',
  model: 'model-f062',
  boundary: 'boundary-f062',
  role: 'role-f062',
  interface: 'interface-f062',
  profile: 'profile-f062',
  implementation: 'implementation-f062',
  host: 'host-f062',
  run: 'run-f062',
  foreignRun: 'run-f062-foreign',
  member: 'member-f062',
  foreignMember: 'member-f062-foreign',
  grant: 'grant-f062-member',
  foreignGrant: 'grant-f062-foreign',
  assignment: 'assignment-f062',
  foreignAssignment: 'assignment-f062-foreign'
} as const

function insert(db: DatabaseSync, sql: string, ...values: unknown[]): void {
  db.prepare(sql).run(...(values as never[]))
}

export function seedFixture(db: DatabaseSync): void {
  insert(
    db,
    `INSERT INTO projects(id,name,goal,repository_root,active_model_version,revision)
     VALUES(?,?,?,?,NULL,1)`,
    IDS.project,
    'F-062 fixture',
    'verify assignment ancestry and the service call boundary',
    '/fixture/f062'
  )
  insert(
    db,
    `INSERT INTO model_versions(id,project_id,parent_version,root_boundary_id,goal_snapshot,status,digest,created_at)
     VALUES(?,?,NULL,NULL,?,'published',?,1)`,
    IDS.model,
    IDS.project,
    'F-062 model',
    'model-digest-f062'
  )
  insert(
    db,
    'INSERT INTO rdd_boundaries(model_version,id,name,responsibility_statement) VALUES(?,?,?,?)',
    IDS.model,
    IDS.boundary,
    'F-062 boundary',
    'Own the authorization regression fixture'
  )
  insert(db, 'UPDATE model_versions SET root_boundary_id=? WHERE id=?', IDS.boundary, IDS.model)
  insert(db, 'UPDATE projects SET active_model_version=? WHERE id=?', IDS.model, IDS.project)
  insert(db, 'INSERT INTO horizontal_roles(model_version,name) VALUES(?,?)', IDS.model, 'worker')
  insert(
    db,
    `INSERT INTO rdd_roles(model_version,id,name,description,boundary_id,horizontal_role_name)
     VALUES(?,?,?,?,?,?)`,
    IDS.model,
    IDS.role,
    'F-062 worker',
    'Minimal worker role',
    IDS.boundary,
    'worker'
  )
  insert(
    db,
    `INSERT INTO role_interfaces(digest,model_version,role_id,requirements_json,judgment_scope_json)
     VALUES(?,?,?,'[]','{}')`,
    IDS.interface,
    IDS.model,
    IDS.role
  )

  const recipe = {
    process: {
      executable: '/bin/true',
      argv: [{ literal: '/bin/true' }],
      stdio: 'pipes'
    },
    routes: [
      { source: 'role/mandatory.md', kind: 'native-preload', required: true },
      { source: 'task/initial.txt', kind: 'stdin', required: true }
    ]
  }
  insert(
    db,
    `INSERT INTO harness_profiles(id,revision,state,recipe_json,capabilities_json,executable_identity_json)
     VALUES(?,1,'verified',?,?,'{}')`,
    IDS.profile,
    JSON.stringify(recipe),
    JSON.stringify({ components: [] })
  )
  insert(
    db,
    `INSERT INTO role_implementations
       (id,revision,interface_digest,profile_id,profile_revision,status,maintainer_role_id,semantic_decision)
     VALUES(?,1,?,?,1,'published',?,?)`,
    IDS.implementation,
    IDS.interface,
    IDS.profile,
    IDS.role,
    'F-062 fixture implementation'
  )
  insert(
    db,
    `INSERT INTO execution_hosts(id,incarnation,protocol_version,state,identity_json)
     VALUES(?,?,'1','live','{}')`,
    IDS.host,
    'incarnation-f062'
  )

  for (const runId of [IDS.run, IDS.foreignRun]) {
    insert(
      db,
      `INSERT INTO runs
         (id,project_id,model_version,goal_text,purpose,coordinator_member_id,state,current_plan_revision,revision)
       VALUES(?,?,?,?,'work',NULL,'active',NULL,1)`,
      runId,
      IDS.project,
      IDS.model,
      `goal for ${runId}`
    )
  }
  for (const [memberId, runId] of [
    [IDS.member, IDS.run],
    [IDS.foreignMember, IDS.foreignRun]
  ] as const) {
    insert(db, "INSERT INTO principals(id,kind,status) VALUES(?,'member','active')", memberId)
    insert(
      db,
      `INSERT INTO members
         (id,run_id,model_version,role_id,implementation_id,implementation_revision,generation,current_execution_id,state,revision)
       VALUES(?,?,?,?,?,1,1,NULL,'assigned',1)`,
      memberId,
      runId,
      IDS.model,
      IDS.role,
      IDS.implementation
    )
  }

  // Critical fixture property: run-only target, worker.prepare-only action.
  // No assignment target and no context.build action are granted to the member.
  insert(
    db,
    `INSERT INTO grants
       (id,revision,kind,principal_id,parent_grant_id,policy_id,policy_revision,expires_at,revoked_at,scope_json,actions_json)
     VALUES(?,1,'assignment',?,NULL,NULL,NULL,NULL,NULL,?,?)`,
    IDS.grant,
    IDS.member,
    JSON.stringify({ targets: [{ kind: 'run', id: IDS.run }] }),
    JSON.stringify(['worker.prepare'])
  )
  insert(
    db,
    `INSERT INTO grants
       (id,revision,kind,principal_id,parent_grant_id,policy_id,policy_revision,expires_at,revoked_at,scope_json,actions_json)
     VALUES(?,1,'assignment',?,NULL,NULL,NULL,NULL,NULL,?,?)`,
    IDS.foreignGrant,
    IDS.foreignMember,
    JSON.stringify({ targets: [{ kind: 'run', id: IDS.foreignRun }] }),
    JSON.stringify(['worker.prepare'])
  )
  for (const [assignmentId, memberId, grantId] of [
    [IDS.assignment, IDS.member, IDS.grant],
    [IDS.foreignAssignment, IDS.foreignMember, IDS.foreignGrant]
  ] as const) {
    insert(
      db,
      `INSERT INTO assignments
         (id,revision,member_id,kind,mandate_text,grant_id,task_id,task_revision,scope_json)
       VALUES(?,1,?,'coordination',?,?,NULL,NULL,'{}')`,
      assignmentId,
      memberId,
      `mandate for ${assignmentId}`,
      grantId
    )
    const bodyDigest = `body-${assignmentId}`
    const body = Buffer.from(`initial input for ${assignmentId}`)
    insert(
      db,
      `INSERT INTO content_blobs(digest,media_type,byte_length,body,external_ref,verified)
       VALUES(?,'text/plain',?,?,NULL,1)`,
      bodyDigest,
      body.byteLength,
      body
    )
    insert(
      db,
      `INSERT INTO work_envelopes
         (digest,assignment_id,assignment_revision,kind,body_digest,bindings_json)
       VALUES(?,?,1,'coordination',?,'{}')`,
      `envelope-${assignmentId}`,
      assignmentId,
      bodyDigest
    )
  }
}

function memberContext(): AuthenticatedContext {
  return {
    principalId: IDS.member as never,
    memberId: IDS.member as never,
    controllerEpoch: 1 as never,
    grantRevisions: { [IDS.grant]: 1 as never },
    transportSessionId: 'f062-member-session'
  }
}

function request(
  operation: string,
  operationId: string,
  payload: unknown
): { protocolVersion: string; operation: string; operationId: string; payload: unknown } {
  return { protocolVersion: 'f062/1', operation, operationId, payload }
}

function decisionRows(db: DatabaseSync, operation: string): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT principal_id,allow,actual_targets_json,policy_evidence_json
       FROM authorization_decisions WHERE operation_key=? ORDER BY rowid`
    )
    .all(operation) as Array<Record<string, unknown>>
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'mahas-f062-'))
  const db = openControlDb(join(root, 'control.sqlite'))
  const runtime = await composeRuntime({
    db,
    configDir: join(root, 'config'),
    endpoint: join(root, 'mahasd.sock'),
    hostEndpoint: join(root, 'absent-host.sock'),
    controllerEpoch: 1,
    controllerIdentity: { pid: process.pid, label: 'f062-smoke' }
  })

  try {
    seedFixture(db)
    const ctx = memberContext()
    const payload = {
      assignmentId: IDS.assignment,
      assignmentRevision: 1,
      implementationRevision: 1,
      placementIntent: { hostId: IDS.host },
      harnessProfileRevision: 1,
      purpose: 'work'
    }

    const prepared = (await runtime.registry.dispatch(
      ctx,
      request('worker.prepare', 'f062-prepare-allowed', payload) as never
    )) as CommandReceipt
    assert.equal(prepared.status, 'committed', JSON.stringify(prepared, null, 2))
    assert.deepEqual((prepared.result as { blockers?: unknown[] }).blockers, [])
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS n FROM launch_plans WHERE assignment_id=?')
        .get(IDS.assignment)?.['n'],
      1
    )

    const prepareDecisions = decisionRows(db, 'worker.prepare')
    const allowedPrepare = prepareDecisions.find(
      (row) => row.principal_id === IDS.member && Number(row.allow) === 1
    )
    assert.ok(allowedPrepare, 'member worker.prepare must have an allow decision')
    const allowedTargets = JSON.parse(String(allowedPrepare.actual_targets_json)) as Array<{
      kind: string
      id: string
    }>
    assert.ok(
      allowedTargets.some((target) => target.kind === 'run' && target.id === IDS.run),
      'assignment authorization evidence must include its run ancestor'
    )

    const contextDecisions = decisionRows(db, 'context.build')
    assert.ok(
      contextDecisions.some(
        (row) => row.principal_id === 'service:mahasd' && Number(row.allow) === 1
      ),
      'worker.prepare nested context.build must authorize as service:mahasd'
    )
    assert.equal(
      contextDecisions.some((row) => row.principal_id === IDS.member && Number(row.allow) === 1),
      false,
      'member principal must not receive context.build authority'
    )

    const directBuild = (await runtime.registry.dispatch(
      ctx,
      request('context.build', 'f062-member-direct-build', {
        interfaceDigest: IDS.interface,
        implementationId: IDS.implementation,
        implementationRevision: 1,
        surfaceDigest: (prepared.result as { plannedSurface: { digest: string } }).plannedSurface
          .digest,
        sourceSnapshotPins: []
      }) as never
    )) as CommandReceipt
    assert.equal(directBuild.status, 'rejected')
    assert.equal(directBuild.error?.code, 'UNAVAILABLE_OPERATION')

    const foreign = (await runtime.registry.dispatch(
      ctx,
      request('worker.prepare', 'f062-prepare-foreign', {
        ...payload,
        assignmentId: IDS.foreignAssignment
      }) as never
    )) as CommandReceipt
    assert.equal(foreign.status, 'rejected')
    assert.equal(foreign.error?.code, 'SCOPE_DENIED')
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS n FROM launch_plans WHERE assignment_id=?')
        .get(IDS.foreignAssignment)?.['n'],
      0
    )

    const memberGrant = db
      .prepare('SELECT scope_json,actions_json FROM grants WHERE id=?')
      .get(IDS.grant) as { scope_json: string; actions_json: string }
    assert.deepEqual(JSON.parse(memberGrant.actions_json), ['worker.prepare'])
    assert.deepEqual(JSON.parse(memberGrant.scope_json), {
      targets: [{ kind: 'run', id: IDS.run }]
    })

    console.log('PASS F-062 clean fixture')
    console.log('  permitted: run-scoped member worker.prepare -> committed')
    console.log('  internal: context.build authorized only as service:mahasd')
    console.log('  denied: foreign assignment -> SCOPE_DENIED')
    console.log('  hidden: direct member context.build -> UNAVAILABLE_OPERATION')
  } finally {
    runtime.close()
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
