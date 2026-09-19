// VER-02 shared harness helpers — REAL implementation modules only.
// Evidence recorder + control-DB seed + fully-wired OperationRegistry.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const OUT = '/tmp/mahas-ver-02/results'

// Real implementation modules (revision 83a6d21) via absolute file:// URLs.
import * as storage from 'file:///home/pyosechang/projects/ade-wt-mahas-architecture/packages/mahas-runtime/src/storage/db.ts'
import {
  bindAccessDb,
  unbindAccessDb,
  makeAccessKernel
} from 'file:///home/pyosechang/projects/ade-wt-mahas-architecture/packages/mahas-runtime/src/access/authorize.ts'
import { createOperationRegistry } from 'file:///home/pyosechang/projects/ade-wt-mahas-architecture/packages/mahas-runtime/src/api/registry.ts'
import { registerMailOps } from 'file:///home/pyosechang/projects/ade-wt-mahas-architecture/packages/mahas-runtime/src/mail/index.ts'
import { registerModelOps } from 'file:///home/pyosechang/projects/ade-wt-mahas-architecture/packages/mahas-runtime/src/model/ops.ts'
import { registerBackupOps } from 'file:///home/pyosechang/projects/ade-wt-mahas-architecture/packages/mahas-runtime/src/operations/backup.ts'
import { registerOperationGet } from 'file:///home/pyosechang/projects/ade-wt-mahas-architecture/packages/mahas-runtime/src/rpc/operation-get.ts'
import {
  planGc,
  runGc,
  pinTarget,
  isTargetPinned,
  isBlobReferenced,
  resolvePinTarget
} from 'file:///home/pyosechang/projects/ade-wt-mahas-architecture/packages/mahas-runtime/src/operations/gc.ts'
import {
  restoreBackupSetStandalone,
  readBackupManifest
} from 'file:///home/pyosechang/projects/ade-wt-mahas-architecture/packages/mahas-runtime/src/operations/restore.ts'
import { createBackupSetStandalone } from 'file:///home/pyosechang/projects/ade-wt-mahas-architecture/packages/mahas-runtime/src/operations/backup.ts'
import { publishCandidate } from 'file:///home/pyosechang/projects/ade-wt-mahas-architecture/packages/mahas-runtime/src/model/publisher.ts'
import {
  emptySnapshot,
  type ModelSnapshot
} from 'file:///home/pyosechang/projects/ade-wt-mahas-architecture/packages/mahas-runtime/src/model/repository.ts'

export {
  storage,
  bindAccessDb,
  unbindAccessDb,
  makeAccessKernel,
  createOperationRegistry,
  registerMailOps,
  registerModelOps,
  registerBackupOps,
  registerOperationGet,
  planGc,
  runGc,
  pinTarget,
  isTargetPinned,
  isBlobReferenced,
  resolvePinTarget,
  restoreBackupSetStandalone,
  readBackupManifest,
  createBackupSetStandalone,
  publishCandidate,
  emptySnapshot
}
export type { ModelSnapshot }

// ---------------------------------------------------------------- results --

export interface Check {
  name: string
  ok: boolean
  expected: string
  observed: string
  extra?: unknown
}

export class Recorder {
  readonly stepId: string
  readonly checks: Check[] = []
  constructor(stepId: string) {
    this.stepId = stepId
    mkdirSync(OUT, { recursive: true })
  }
  check(name: string, ok: boolean, expected: string, observed: string, extra?: unknown): void {
    this.checks.push({ name, ok, expected, observed, extra })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} — expected ${expected} | observed ${observed}`)
    if (extra !== undefined) console.log('       extra:', JSON.stringify(extra)?.slice(0, 400))
  }
  flush(extra?: Record<string, unknown>): string {
    const file = join(OUT, `${this.stepId}.json`)
    writeFileSync(
      file,
      JSON.stringify({ stepId: this.stepId, at: Date.now(), checks: this.checks, ...extra }, null, 2)
    )
    const fails = this.checks.filter((c) => !c.ok)
    console.log(
      `\n[${this.stepId}] ${this.checks.length - fails.length}/${this.checks.length} checks ok → ${file}`
    )
    return file
  }
}

// ------------------------------------------------------------------- seed --

export const OP_NAMES = [
  'surface.describe',
  'operation.get',
  'inbox.check',
  'inbox.wait',
  'delivery.ack',
  'message.send',
  'message.replyAndAck',
  'artifact.publish',
  'artifact.read',
  'project.create',
  'project.get',
  'model.snapshot',
  'model.change.prepare',
  'model.change.commit',
  'task.dispatch',
  'task.report',
  'outcome.decide',
  'execution.wake',
  'backup.create',
  'backup.restore'
]

/** principals + wildcard-scope grants so the REAL access kernel admits ops.
 *  Authorization itself is VER-03's scope; here it must merely not block. */
export function seedPrincipalsAndGrants(db: DatabaseSync): void {
  const principals: [string, string][] = [
    ['pr_op', 'operator'],
    ['pr_m1', 'member'],
    ['pr_m2', 'member'],
    ['pr_m3', 'member'],
    ['pr_svc', 'service']
  ]
  for (const [id, kind] of principals) {
    db.prepare('INSERT INTO principals(id,kind,status) VALUES(?,?,?)').run(id, kind, 'active')
    db.prepare(
      `INSERT INTO grants(id, revision, kind, principal_id, parent_grant_id, policy_id, policy_revision, expires_at, revoked_at, scope_json, actions_json)
       VALUES(?, 1, 'assignment', ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`
    ).run(
      `grant_${id}`,
      id,
      JSON.stringify({ targets: [{ kind: '*', id: '*' }] }),
      JSON.stringify(OP_NAMES)
    )
  }
}

/** FK DAG inserts — caller MUST run inside withTx (all FKs are DEFERRABLE). */
export function seedMailWorld(db: DatabaseSync): void {
  const run = (sql: string, ...a: (string | number | null)[]): void => {
    db.prepare(sql).run(...a)
  }
  run(
    "INSERT INTO projects(id,name,goal,repository_root,active_model_version,revision) VALUES('p1','proj','goal','/tmp/mahas-ver-02/repo',NULL,1)"
  )
  run(
    "INSERT INTO model_versions(id,project_id,parent_version,root_boundary_id,goal_snapshot,status,digest,created_at) VALUES('mv1','p1',NULL,NULL,'goal','published','dg',1)"
  )
  run(
    "INSERT INTO rdd_boundaries(model_version,id,name,responsibility_statement) VALUES('mv1','b1','root','root responsibility')"
  )
  run("UPDATE model_versions SET root_boundary_id='b1' WHERE id='mv1'")
  run("INSERT INTO horizontal_roles(model_version,name) VALUES('mv1','worker')")
  run(
    "INSERT INTO rdd_roles(model_version,id,name,description,boundary_id,horizontal_role_name) VALUES('mv1','role1','worker role','desc','b1','worker')"
  )
  run(
    "INSERT INTO role_interfaces(digest,model_version,role_id,requirements_json,judgment_scope_json) VALUES('ifdg','mv1','role1','{}','{}')"
  )
  run(
    "INSERT INTO harness_profiles(id,revision,state,recipe_json,capabilities_json,executable_identity_json) VALUES('prof1',1,'verified','{}','{}','{}')"
  )
  run(
    "INSERT INTO role_implementations(id,revision,interface_digest,profile_id,profile_revision,status,maintainer_role_id,semantic_decision) VALUES('impl1',1,'ifdg','prof1',1,'published','role1',NULL)"
  )
  run(
    "INSERT INTO runs(id,project_id,model_version,goal_text,purpose,coordinator_member_id,state,current_plan_revision,revision) VALUES('run1','p1','mv1','goal','work',NULL,'active',NULL,1)"
  )
  run(
    "INSERT INTO execution_hosts(id,incarnation,protocol_version,state,identity_json) VALUES('h1','inc1','1','live','{}')"
  )
  // members (current_execution_id bound after executions insert — deferred FK)
  const member = (id: string, gen: number): void =>
    run(
      "INSERT INTO members(id,run_id,model_version,role_id,implementation_id,implementation_revision,generation,current_execution_id,state,revision) VALUES (?,'run1','mv1','role1','impl1',1,?,NULL,'active',1)",
      id,
      gen
    )
  member('m1', 1)
  member('m2', 1)
  member('m3', 1)
  run(
    "INSERT INTO tasks(id,run_id,current_revision,current_dispatch_id) VALUES('t1','run1',1,NULL)"
  )
  run(
    "INSERT INTO task_specs(task_id,revision,title,requirement_text,owner_role_id,assigned_member_id,inputs_json,outputs_json,settlement_policy_json) VALUES('t1',1,'task','req','role1','m1','{}','{}','{}')"
  )
  run(
    "INSERT INTO assignments(id,revision,member_id,kind,mandate_text,grant_id,task_id,task_revision,scope_json) VALUES('a1',1,'m1','task','do it','grant_pr_m1','t1',1,'{}')"
  )
  // blob bodies for context_bundle + work_envelope FK targets
  storage.putContentBlob(db, new TextEncoder().encode('required text'), 'text/plain')
  storage.putContentBlob(db, new TextEncoder().encode('envelope body'), 'text/plain')
  const dig = (s: string): string => storage.sha256Hex(new TextEncoder().encode(s))
  run(
    "INSERT INTO context_bundles(digest,implementation_id,implementation_revision,interface_digest,surface_digest,required_text_digest,manifest_json,source_observations_json) VALUES(?,?,?,?,?,?,?,?)",
    dig('bundle'),
    'impl1',
    1,
    'ifdg',
    'csd1',
    dig('required text'),
    '{}',
    '{}'
  )
  run(
    "INSERT INTO command_surfaces(digest,actions_and_schemas_json,policy_pins_json) VALUES('csd1','{}','{}')"
  )
  run(
    "INSERT INTO work_envelopes(digest,assignment_id,assignment_revision,kind,body_digest,bindings_json) VALUES(?,?,?,?,?,?)",
    dig('envelope'),
    'a1',
    1,
    'task',
    dig('envelope body'),
    '{}'
  )
  run(
    "INSERT INTO launch_plans(id,assignment_id,assignment_revision,digest,bundle_digest,envelope_digest,surface_digest,state,process_spec_json,pins_json,reservations_json) VALUES('lp1','a1',1,'lpd',?,?,'csd1','ready','{}','{}','{}')",
    dig('bundle'),
    dig('envelope')
  )
  for (const [id, mid] of [
    ['e1', 'm1'],
    ['e2', 'm2'],
    ['e3', 'm3']
  ] as const) {
    run(
      "INSERT INTO executions(id,member_id,generation,host_id,launch_plan_id,state,liveness,terminal_id,process_identity_json,native_conversation_json,revision) VALUES (?,?,1,'h1','lp1','running','live',NULL,'{}','{}',1)",
      id,
      mid
    )
    run("UPDATE members SET current_execution_id=? WHERE id=?", id, mid)
    run(
      "INSERT INTO worker_joins(execution_id,generation,bundle_digest,surface_digest,envelope_digest,joined_at) VALUES (?,1,?,'csd1',?,1)",
      id,
      dig('bundle'),
      dig('envelope')
    )
  }
  run(
    "INSERT INTO dispatches(id,task_id,task_revision,member_id,execution_id,generation,envelope_digest,phase,authority_state,assignment_delivery_id,revision) VALUES('d1','t1',1,'m1','e1',1,?,'work','active',NULL,1)",
    dig('envelope')
  )
  run("UPDATE tasks SET current_dispatch_id='d1' WHERE id='t1'")
  run("INSERT INTO resources(id,kind,host_id,identity_json) VALUES('r1','checkout','h1','{}')")
  run(
    "INSERT INTO checkouts(id,resource_id,host_id,canonical_path,filesystem_identity,repository_json,revision) VALUES('co1','r1','h1','/tmp/mahas-ver-02/repo','fsid1','{}',1)"
  )
  run(
    "INSERT INTO resource_claims(id,resource_id,owner_kind,owner_id,mode,generation,state,revision) VALUES('cl1','r1','dispatch','d1','write',1,'held',1)"
  )
}

/** principals+grants then the mail world, all inside ONE tx (deferred FKs). */
export function seedAll(db: DatabaseSync): void {
  storage.withTx(db, () => {
    seedPrincipalsAndGrants(db)
    seedMailWorld(db)
  })
}

export function ctxFor(
  principal: string,
  memberId?: string,
  executionId?: string,
  generation?: number
): Record<string, unknown> {
  return {
    principalId: principal,
    memberId,
    executionId,
    executionGeneration: generation,
    controllerEpoch: 1,
    grantRevisions: {},
    transportSessionId: 'ver02'
  }
}

export interface WiredRuntime {
  db: DatabaseSync
  registry: any
  dispatch: (
    ctx: Record<string, unknown>,
    operation: string,
    payload: unknown,
    operationId: string
  ) => Promise<any>
  close(): void
}

/**
 * The REAL admission pipeline end-to-end: openControlDb → bindAccessDb →
 * createOperationRegistry (real IMP-10 kernel + real IMP-03 storage) →
 * real op registrations. mailDeps can be customized per harness (e.g. a
 * throwing appendDomainEvent for fault injection).
 */
export async function wireRuntime(
  dbPath: string,
  opts?: {
    mailDeps?: Record<string, unknown>
    backupDeps?: Record<string, unknown>
    contentStoreDir?: string
    trace?: (e: unknown) => void
  }
): Promise<WiredRuntime> {
  const db = storage.openControlDb(dbPath, { contentStoreDir: opts?.contentStoreDir })
  bindAccessDb(db)
  const registry = await createOperationRegistry(db, { trace: opts?.trace })
  const kernel = makeAccessKernel(db)
  const mailDeps: Record<string, unknown> = {
    authorize: (ctx: unknown, operation: string, targets: unknown) =>
      kernel.authorize(ctx as never, operation, targets as never),
    putContentBlob: storage.putContentBlob,
    getContentBlob: storage.getContentBlob,
    appendDomainEvent: storage.appendDomainEvent,
    sha256Hex: storage.sha256Hex,
    ...opts?.mailDeps
  }
  registerMailOps(registry, mailDeps as never)
  registerModelOps(registry)
  registerOperationGet(registry, { findReceipt: storage.findReceipt } as never)
  if (opts?.backupDeps) {
    registerBackupOps(registry, {
      openDb: storage.openControlDb,
      withTx: storage.withTx,
      sha256Hex: storage.sha256Hex,
      appendDomainEvent: storage.appendDomainEvent,
      putContentBlob: storage.putContentBlob,
      backupRoot: '/tmp/mahas-ver-02/backups',
      ...opts.backupDeps
    } as never)
  }
  return {
    db,
    registry,
    dispatch: (ctx, operation, payload, operationId) =>
      registry.dispatch(ctx as never, {
        protocolVersion: 'ver02/1',
        operation,
        operationId,
        payload
      } as never),
    close: () => {
      unbindAccessDb()
      db.close()
    }
  }
}
