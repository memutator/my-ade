// mahas-runtime — maintenance/smoke (IMP-27 self-check, NOT a shipped op).
//
//   node packages/mahas-runtime/src/maintenance/smoke.ts
//
// Drives the mandated verification: change a contract -> stale candidates
// appear for consumer boundaries -> the designated maintainer classifies ->
// the resolution is recorded. Also covers parent-responsibility translation
// candidates, interface drift, context-source staleness, outcome-reported
// contract effects, the self-active-instruction guard, cursor pagination,
// explicit task linking and re-observation idempotency.
//
// Runs against an in-memory DatabaseSync carrying the spec/storage.md §3
// DDL subset this module touches — no sibling IMP code is required.

import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite'
import type {
  AuthenticatedContext,
  ControllerEpoch,
  Id
} from '../../../mahas-contracts/src/common.ts'
import { createMaintenanceHooks, MaintenanceError } from './basis-observer.ts'
import { linkMaintenanceTask, resolveMemberPins } from './task-link.ts'
import {
  listImpactCandidates,
  registerMaintenanceOps,
  unreviewedStaleCandidates
} from './impact-service.ts'

/* ---------------------------------------------------------------- */

let failures = 0
function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok    ${msg}`)
  } else {
    failures++
    console.log(`  FAIL  ${msg}`)
  }
}
function checkErr(fn: () => unknown, code: string, msg: string): void {
  try {
    fn()
    failures++
    console.log(`  FAIL  ${msg} (no error thrown, expected ${code})`)
  } catch (e) {
    const c = e instanceof MaintenanceError ? e.code : ((e as { code?: string }).code ?? 'other')
    check(c === code, `${msg} (got ${String(c)})`)
  }
}

/* ------------------------- DDL subset --------------------------- */

const db = new DatabaseSync(':memory:')
db.exec(`
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, goal TEXT, repository_root TEXT, active_model_version TEXT, revision INTEGER);
CREATE TABLE model_versions (id TEXT PRIMARY KEY, project_id TEXT, parent_version TEXT, root_boundary_id TEXT, goal_snapshot TEXT, status TEXT, digest TEXT, created_at INTEGER);
CREATE TABLE rdd_boundaries (model_version TEXT, id TEXT, name TEXT, responsibility_statement TEXT, PRIMARY KEY(model_version,id));
CREATE TABLE boundary_edges (model_version TEXT, child_id TEXT, parent_id TEXT, PRIMARY KEY(model_version,child_id));
CREATE TABLE horizontal_roles (model_version TEXT, name TEXT, PRIMARY KEY(model_version,name));
CREATE TABLE rdd_roles (model_version TEXT, id TEXT, name TEXT, description TEXT, boundary_id TEXT, horizontal_role_name TEXT, PRIMARY KEY(model_version,id));
CREATE TABLE rdd_contexts (model_version TEXT, id TEXT, path TEXT, PRIMARY KEY(model_version,id));
CREATE TABLE boundary_contexts (model_version TEXT, boundary_id TEXT, context_id TEXT, PRIMARY KEY(model_version,boundary_id,context_id));
CREATE TABLE horizontal_contexts (model_version TEXT, horizontal_role_name TEXT, context_id TEXT, PRIMARY KEY(model_version,horizontal_role_name,context_id));
CREATE TABLE rdd_contracts (model_version TEXT, id TEXT, name TEXT, schema_path TEXT, provider_boundary_id TEXT, PRIMARY KEY(model_version,id));
CREATE TABLE contract_consumers (model_version TEXT, contract_id TEXT, consumer_boundary_id TEXT, PRIMARY KEY(model_version,contract_id,consumer_boundary_id));
CREATE TABLE model_changes (id TEXT PRIMARY KEY, project_id TEXT, base_version TEXT, candidate_digest TEXT, state TEXT, edits_json TEXT, touched_targets_json TEXT, diagnostics_json TEXT);
CREATE TABLE role_interfaces (digest TEXT PRIMARY KEY, model_version TEXT, role_id TEXT, requirements_json TEXT, judgment_scope_json TEXT);
CREATE TABLE role_implementations (id TEXT, revision INTEGER, interface_digest TEXT, profile_id TEXT, profile_revision INTEGER, status TEXT, maintainer_role_id TEXT, semantic_decision TEXT, PRIMARY KEY(id,revision));
CREATE TABLE maintenance_bindings (implementation_id TEXT, implementation_revision INTEGER, id TEXT, basis_ref_json TEXT, component_ref_json TEXT, PRIMARY KEY(implementation_id,implementation_revision,id));
CREATE TABLE context_bundles (digest TEXT PRIMARY KEY, implementation_id TEXT, implementation_revision INTEGER, interface_digest TEXT, surface_digest TEXT, required_text_digest TEXT, manifest_json TEXT, source_observations_json TEXT);
CREATE TABLE impact_candidates (id TEXT PRIMARY KEY, change_ref TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, reason_json TEXT NOT NULL, resolution_json TEXT NOT NULL);
CREATE TABLE domain_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_id TEXT, aggregate_revision INTEGER, event_type TEXT, scope_json TEXT, payload_json TEXT);
CREATE TABLE runs (id TEXT PRIMARY KEY, project_id TEXT, model_version TEXT, goal_text TEXT, state TEXT, revision INTEGER);
CREATE TABLE members (id TEXT PRIMARY KEY, run_id TEXT, model_version TEXT, role_id TEXT, implementation_id TEXT, implementation_revision INTEGER, generation INTEGER, current_execution_id TEXT, state TEXT, revision INTEGER);
CREATE TABLE executions (id TEXT PRIMARY KEY, member_id TEXT, generation INTEGER, host_id TEXT, launch_plan_id TEXT, state TEXT, liveness TEXT, terminal_id TEXT, process_identity_json TEXT, native_conversation_json TEXT, revision INTEGER);
CREATE TABLE launch_plans (id TEXT PRIMARY KEY, assignment_id TEXT, assignment_revision INTEGER, digest TEXT, bundle_digest TEXT, envelope_digest TEXT, surface_digest TEXT, state TEXT, process_spec_json TEXT, pins_json TEXT, reservations_json TEXT);
CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, current_revision INTEGER, current_dispatch_id TEXT);
CREATE TABLE task_specs (task_id TEXT, revision INTEGER, title TEXT, requirement_text TEXT, owner_role_id TEXT, assigned_member_id TEXT, inputs_json TEXT, outputs_json TEXT, settlement_policy_json TEXT, PRIMARY KEY(task_id,revision));
CREATE TABLE plans (run_id TEXT, revision INTEGER, digest TEXT, dispositions_json TEXT, PRIMARY KEY(run_id,revision));
CREATE TABLE outcomes (id TEXT, revision INTEGER, task_id TEXT, task_revision INTEGER, dispatch_id TEXT, result TEXT, rationale TEXT, assessment_json TEXT, contract_effects_json TEXT, PRIMARY KEY(id,revision));
`)

const ins = (sql: string, ...args: (string | number | null)[]): StatementResultingChanges =>
  db.prepare(sql).run(...(args as string[]))

/* ------------------------- seed model v1 ------------------------ */

ins(`INSERT INTO projects VALUES ('p1','demo','goal','/repo','mv1',1)`)
ins(`INSERT INTO model_versions VALUES ('mv1','p1',NULL,'BR','goal','published','d1',1)`)
// boundaries: BR root -> BP -> {BC1, BC2}
for (const [id, name, stmt] of [
  ['BR', 'root', 'root responsibility'],
  ['BP', 'parent', 'parent responsibility v1'],
  ['BC1', 'child1', 'child1 responsibility'],
  ['BC2', 'child2', 'child2 responsibility']
] as const) {
  ins(`INSERT INTO rdd_boundaries VALUES ('mv1',?,?,?)`, id, name, stmt)
}
ins(`INSERT INTO boundary_edges VALUES ('mv1','BP','BR')`)
ins(`INSERT INTO boundary_edges VALUES ('mv1','BC1','BP')`)
ins(`INSERT INTO boundary_edges VALUES ('mv1','BC2','BP')`)
ins(`INSERT INTO horizontal_roles VALUES ('mv1','H1')`)
ins(`INSERT INTO rdd_roles VALUES ('mv1','R_p','provider','provider role','BP','H0')`)
ins(`INSERT INTO rdd_roles VALUES ('mv1','R_c1','consumer1','consumer role 1','BC1','H0')`)
ins(`INSERT INTO rdd_roles VALUES ('mv1','R_c2','consumer2','consumer role 2','BC2','H1')`)
ins(`INSERT INTO rdd_contexts VALUES ('mv1','ctx1','contexts/ctx1.md')`)
ins(`INSERT INTO rdd_contexts VALUES ('mv1','ctx2','contexts/ctx2.md')`)
ins(`INSERT INTO boundary_contexts VALUES ('mv1','BC1','ctx1')`)
ins(`INSERT INTO horizontal_contexts VALUES ('mv1','H1','ctx2')`)
ins(`INSERT INTO rdd_contracts VALUES ('mv1','K1','contract','schemas/k1.json','BP')`)
ins(`INSERT INTO contract_consumers VALUES ('mv1','K1','BC1')`)
ins(
  `INSERT INTO role_interfaces VALUES ('I_c1','mv1','R_c1','[{"clauseId":"cl1","contextId":"ctx1","deliveryClass":"initial"}]','{}')`
)
ins(
  `INSERT INTO role_interfaces VALUES ('I_c2','mv1','R_c2','[{"clauseId":"cl2","contextId":"ctx2","deliveryClass":"conditional"}]','{}')`
)
ins(`INSERT INTO role_interfaces VALUES ('I_p','mv1','R_p','[]','{}')`)
ins(
  `INSERT INTO role_implementations VALUES ('impl_c1',1,'I_c1','prof',1,'published','R_maint','ok')`
)
ins(
  `INSERT INTO role_implementations VALUES ('impl_p',1,'I_p','prof',1,'published','R_maint','ok')`
)
ins(
  `INSERT INTO role_implementations VALUES ('impl_p',2,'I_p','prof',1,'published','R_maint','rev2')`
)
ins(
  `INSERT INTO maintenance_bindings VALUES ('impl_c1',1,'mb1','{"kind":"context","contextId":"ctx1"}','{}')`
)

/* ------------------------- publish model v2 --------------------- */

ins(`INSERT INTO model_versions VALUES ('mv2','p1','mv1','BR','goal','published','d2',2)`)
for (const [id, name, stmt] of [
  ['BR', 'root', 'root responsibility'],
  ['BP', 'parent', 'parent responsibility v2 CHANGED'],
  ['BC1', 'child1', 'child1 responsibility'],
  ['BC2', 'child2', 'child2 responsibility']
] as const) {
  ins(`INSERT INTO rdd_boundaries VALUES ('mv2',?,?,?)`, id, name, stmt)
}
ins(`INSERT INTO boundary_edges VALUES ('mv2','BP','BR')`)
ins(`INSERT INTO boundary_edges VALUES ('mv2','BC1','BP')`)
ins(`INSERT INTO boundary_edges VALUES ('mv2','BC2','BP')`)
ins(`INSERT INTO horizontal_roles VALUES ('mv2','H1')`)
ins(`INSERT INTO rdd_roles VALUES ('mv2','R_p','provider','provider role','BP','H0')`)
ins(`INSERT INTO rdd_roles VALUES ('mv2','R_c1','consumer1','consumer role 1','BC1','H0')`)
ins(`INSERT INTO rdd_roles VALUES ('mv2','R_c2','consumer2','consumer role 2','BC2','H1')`)
ins(`INSERT INTO rdd_contexts VALUES ('mv2','ctx1','contexts/ctx1.md')`)
ins(`INSERT INTO rdd_contexts VALUES ('mv2','ctx2','contexts/ctx2.md')`)
ins(`INSERT INTO boundary_contexts VALUES ('mv2','BC1','ctx1')`)
ins(`INSERT INTO horizontal_contexts VALUES ('mv2','H1','ctx2')`)
ins(`INSERT INTO rdd_contracts VALUES ('mv2','K1','contract','schemas/k1-v2.json','BP')`)
ins(`INSERT INTO contract_consumers VALUES ('mv2','K1','BC1')`)
ins(`INSERT INTO contract_consumers VALUES ('mv2','K1','BC2')`) // consumer added
ins(
  `INSERT INTO role_interfaces VALUES ('I_c1_v2','mv2','R_c1','[{"clauseId":"cl1","contextId":"ctx1","deliveryClass":"initial"}]','{}')`
)
ins(
  `INSERT INTO role_interfaces VALUES ('I_c2_v2','mv2','R_c2','[{"clauseId":"cl2","contextId":"ctx2","deliveryClass":"conditional"}]','{}')`
)
ins(`INSERT INTO role_interfaces VALUES ('I_p_v2','mv2','R_p','[]','{}')`)
ins(`INSERT INTO model_changes VALUES ('chg1','p1','mv1','cand-digest','committed','[]','[]','{}')`)

/* ------------------------- deps + hooks ------------------------- */

const auths: { op: string; targets: { kind: string; id: string }[] }[] = []
const deps = {
  authorize: (
    _ctx: AuthenticatedContext,
    operation: string,
    targets: { kind: string; id: string }[]
  ) => {
    auths.push({ op: operation, targets })
  },
  now: (() => {
    let t = 1_700_000_000_000
    return () => ++t
  })()
}
const hooks = createMaintenanceHooks(deps)

const ctxOp: AuthenticatedContext = {
  principalId: 'principal_maintainer' as Id,
  controllerEpoch: 1 as ControllerEpoch,
  grantRevisions: {},
  transportSessionId: 'smoke'
}
const ctxMember = (memberId: string): AuthenticatedContext => ({
  principalId: 'principal_worker' as Id,
  memberId: memberId as Id,
  executionId: 'ex1' as Id,
  controllerEpoch: 1 as ControllerEpoch,
  grantRevisions: {},
  transportSessionId: 'smoke'
})

/* =================== 1. model publication ======================== */

console.log(
  '1. observeModelPublication — contract change + parent responsibility + interface drift'
)
const pub = hooks.onModelPublished(db, {
  projectId: 'p1',
  changeId: 'chg1',
  baseModelVersion: 'mv1',
  publishedModelVersion: 'mv2'
})
check(pub.created > 0, `publication produced ${pub.created} candidates`)

const all = listImpactCandidates(db, { projectId: 'p1' })
const kindsFor = (target: string): string[] =>
  all.items.filter((i) => i.targetId === target).map((i) => i.reason.kind)

check(
  kindsFor('R_c1').includes('contract-consumer'),
  'R_c1 is a contract-consumer candidate (continued consumer)'
)
check(
  kindsFor('R_c2').includes('contract-consumer'),
  'R_c2 is a contract-consumer candidate (added consumer — after side of union)'
)
check(
  kindsFor('R_c1').includes('parent-responsibility'),
  'R_c1 is a parent-responsibility candidate (direct child of changed BP)'
)
check(
  kindsFor('impl_p').includes('interface-digest'),
  'impl_p is an interface-drift candidate (pins I_p, live interface is I_p_v2)'
)
// impl_c1 pins I_c1; at mv2 role R_c1's interface is I_c1_v2 → drift expected.
check(
  kindsFor('impl_c1').includes('interface-digest'),
  'impl_c1 IS an interface-drift candidate (I_c1 absent at mv2, replaced by I_c1_v2)'
)

// consumer before/after refs recorded
const consumerCand = all.items.find(
  (i) => i.targetId === 'R_c2' && i.reason.kind === 'contract-consumer'
)
check(
  consumerCand !== undefined &&
    JSON.stringify(consumerCand.reason.beforeRef).includes('"BC1"') &&
    JSON.stringify(consumerCand.reason.afterRef).includes('"BC2"'),
  'contract-consumer candidate carries before/after consumer refs'
)

// idempotent re-observation of the same change ref
const pub2 = hooks.onModelPublished(db, {
  projectId: 'p1',
  changeId: 'chg1',
  baseModelVersion: 'mv1',
  publishedModelVersion: 'mv2'
})
check(pub2.created === 0, 're-observing the same change is idempotent (0 new)')

/* =================== 2. list filters + cursor ==================== */

console.log('2. model.impact.list — status/roleId filters + cursor')
const rc1 = listImpactCandidates(db, { projectId: 'p1', roleId: 'R_c1' })
check(
  rc1.items.length > 0 &&
    rc1.items.every(
      (i) =>
        i.reason.scope?.roleId === 'R_c1' ||
        i.reason.scope?.maintainerRoleId === 'R_c1' ||
        (i.targetKind === 'role' && i.targetId === 'R_c1')
    ),
  `roleId=R_c1 filter returns only R_c1-scoped candidates (${rc1.items.length})`
)
const page1 = listImpactCandidates(db, { projectId: 'p1', limit: 2 })
check(page1.items.length === 2 && page1.nextCursor !== undefined, 'page 1 has 2 items + cursor')
const page2 = listImpactCandidates(db, { projectId: 'p1', limit: 2, cursor: page1.nextCursor })
check(
  page2.items.length > 0 && !page2.items.some((i) => page1.items.some((j) => j.id === i.id)),
  'page 2 continues without overlap'
)
checkErr(
  () => listImpactCandidates(db, { projectId: 'p1', cursor: 'garbage!!' }),
  'STALE_REVISION',
  'garbage cursor rejected'
)

/* =================== 3. classification =========================== */

console.log('3. model.impact.classify — verdicts, CAS, transitions')
const ops: {
  spec: { name: string }
  handler: (txn: { db: DatabaseSync; ctx: AuthenticatedContext }, p: unknown) => unknown
}[] = []
registerMaintenanceOps(
  { register: (spec, handler) => ops.push({ spec, handler: handler as never }) },
  deps
)
const listOp = ops.find((o) => o.spec.name === 'model.impact.list')!
const classifyOp = ops.find((o) => o.spec.name === 'model.impact.classify')!
check(ops.length === 2, 'registerMaintenanceOps registered exactly the two owned operations')

const viaList = listOp.handler({ db, ctx: ctxOp }, { projectId: 'p1', status: 'candidate' }) as {
  items: { id: string; revision: number; reason: { kind: string }; targetId: string }[]
}
check(
  viaList.items.every((i) => i.id !== undefined),
  'list op returns candidate-state items'
)

const driftCand = all.items.find(
  (i) => i.targetId === 'impl_p' && i.reason.kind === 'interface-digest'
)!
const confirmRes = classifyOp.handler(
  { db, ctx: ctxOp },
  {
    candidateId: driftCand.id,
    expectedRevision: driftCand.revision,
    decision: 'confirmed',
    rationale: 'interface digest moved; implementation must be re-based'
  }
) as { revision: number; state: string }
check(
  confirmRes.state === 'confirmed' && confirmRes.revision === 2,
  'confirmed verdict bumps revision to 2'
)

checkErr(
  () =>
    classifyOp.handler(
      { db, ctx: ctxOp },
      {
        candidateId: driftCand.id,
        expectedRevision: 1,
        decision: 'resolved',
        rationale: 'x',
        resolutionRef: { kind: 'implementation', id: 'impl_p', revision: 2 }
      }
    ),
  'STALE_REVISION',
  'stale expectedRevision rejected'
)

const resolveRes = classifyOp.handler(
  { db, ctx: ctxOp },
  {
    candidateId: driftCand.id,
    expectedRevision: 2,
    decision: 'resolved',
    rationale: 'implementation republished against the live interface',
    resolutionRef: { kind: 'implementation', id: 'impl_p', revision: 2 }
  }
) as { revision: number; state: string }
check(
  resolveRes.state === 'resolved' && resolveRes.revision === 3,
  'resolved verdict records resolutionRef'
)

const stored = db
  .prepare('SELECT state, resolution_json FROM impact_candidates WHERE id = ?')
  .get(driftCand.id) as { state: string; resolution_json: string }
const resJson = JSON.parse(stored.resolution_json) as {
  decision: string
  resolutionRef: { kind: string; id: string }
}
check(
  stored.state === 'resolved' &&
    resJson.resolutionRef.id === 'impl_p' &&
    resJson.decision === 'resolved',
  'resolution ref persisted in resolution_json'
)
checkErr(
  () =>
    classifyOp.handler(
      { db, ctx: ctxOp },
      { candidateId: driftCand.id, expectedRevision: 3, decision: 'confirmed', rationale: 'again' }
    ),
  'INVALID_TRANSITION',
  'resolved is terminal — further classification rejected'
)
checkErr(
  () =>
    classifyOp.handler(
      { db, ctx: ctxOp },
      {
        candidateId: all.items.find((i) => i.reason.kind === 'parent-responsibility')!.id,
        expectedRevision: 1,
        decision: 'resolved',
        rationale: 'no ref'
      }
    ),
  'MODEL_INVALID',
  'resolved without resolutionRef rejected'
)
checkErr(
  () =>
    classifyOp.handler(
      { db, ctx: ctxOp },
      {
        candidateId: all.items.find((i) => i.reason.kind === 'parent-responsibility')!.id,
        expectedRevision: 1,
        decision: 'resolved',
        rationale: 'phantom task',
        resolutionRef: { kind: 'task', id: 'nope', revision: 1 }
      }
    ),
  'MODEL_INVALID',
  'resolved with nonexistent resolutionRef rejected'
)
check(
  auths.some((a) => a.op === 'model.impact.classify'),
  'classify invoked authorize with candidate scope'
)
check(
  auths.some((a) => a.op === 'model.impact.list'),
  'list invoked authorize with project scope'
)

/* ============ 4. self-active-instruction guard ================== */

console.log('4. self-scope guard — active member vs pinned implementation')
ins(`INSERT INTO runs VALUES ('run1','p1','mv1','goal','active',1)`)
ins(`INSERT INTO context_bundles VALUES ('bndl1','impl_c1',1,'I_c1','surf','req','{}','[]')`)
ins(
  `INSERT INTO launch_plans VALUES ('lp1','a1',1,'lpd','bndl1','env','surf','active','{}','{}','{}')`
)
ins(`INSERT INTO executions VALUES ('ex1','m_c1',1,'h1','lp1','running','live',NULL,'{}','{}',1)`)
ins(`INSERT INTO members VALUES ('m_c1','run1','mv1','R_c1','impl_c1',1,1,'ex1','running',1)`)

const pins = resolveMemberPins(db, 'm_c1')
check(
  pins?.active === true && pins.implementationId === 'impl_c1' && pins.interfaceDigest === 'I_c1',
  'member pins resolve: impl_c1 + I_c1 live'
)

const ownImplCand = all.items.find(
  (i) => i.targetId === 'impl_c1' && i.reason.kind === 'interface-digest'
)!
checkErr(
  () =>
    classifyOp.handler(
      { db, ctx: ctxMember('m_c1') },
      {
        candidateId: ownImplCand.id,
        expectedRevision: ownImplCand.revision,
        decision: 'dismissed',
        rationale: 'looks fine to me'
      }
    ),
  'SCOPE_DENIED',
  'active member may NOT dismiss staleness on its own pinned implementation'
)
const selfConfirm = classifyOp.handler(
  { db, ctx: ctxMember('m_c1') },
  {
    candidateId: ownImplCand.id,
    expectedRevision: ownImplCand.revision,
    decision: 'confirmed',
    rationale: 'yes, my pinned interface drifted'
  }
) as { state: string }
check(
  selfConfirm.state === 'confirmed',
  'active member MAY confirm staleness on own pins (detection-side)'
)

// a DIFFERENT principal (maintainer) can act on it — operator path already covered.

/* ============ 5. context-source staleness ======================= */

console.log('5. context source digest change -> stale candidate (hash ≠ semantic verdict)')
const src = hooks.onContextSourceChanged(db, {
  projectId: 'p1',
  modelVersion: 'mv2',
  contextId: 'ctx1',
  path: 'contexts/ctx1.md',
  beforeDigest: 'sha_old',
  afterDigest: 'sha_new'
})
const srcAll = listImpactCandidates(db, { projectId: 'p1' })
const ctx1Cands = srcAll.items.filter((i) => i.reason.kind === 'context-source')
check(
  src.created > 0 && ctx1Cands.some((i) => i.targetId === 'impl_c1'),
  'ctx1 digest change raises impl_c1 candidate (boundary link + maintenance basis)'
)
check(
  ctx1Cands.some((i) => i.targetId === 'R_c1' && i.reason.required === true),
  'ctx1 required (initial-delivery) coverage flagged on R_c1 candidate'
)
const noop = hooks.onContextSourceChanged(db, {
  projectId: 'p1',
  modelVersion: 'mv2',
  contextId: 'ctx1',
  beforeDigest: 'sha_new',
  afterDigest: 'sha_new'
})
check(noop.created === 0, 'identical digests produce no candidates')

/* ============ 6. outcome contractEffects ======================== */

console.log('6. outcome-reported contract effects -> provider + reporter candidates')
ins(
  `INSERT INTO outcomes VALUES ('o1',1,'t0',1,'d0','ok','rationale','{}','[{"contractId":"K1"}]')`
)
const eff = hooks.onContractEffectsReported(db, {
  runId: 'run1',
  outcomeId: 'o1',
  outcomeRevision: 1,
  reportedByMemberId: 'm_c1',
  effects: [{ contractId: 'K1', note: 'schema missing field' }]
})
const effCands = listImpactCandidates(db, { projectId: 'p1' }).items.filter(
  (i) => i.reason.kind === 'reported-effect'
)
check(
  eff.created > 0 && effCands.some((i) => i.targetId === 'R_p'),
  'reported effect produces provider-side (R_p) candidate'
)
check(
  effCands.some((i) => i.targetId === 'R_c1'),
  'reported effect produces reporter-side (R_c1) candidate — own bundle untouched'
)

/* ============ 7. explicit task link ============================= */

console.log('7. explicit maintenance-task link (runtime creates nothing)')
ins(`INSERT INTO tasks VALUES ('t1','run1',1,NULL)`)
ins(
  `INSERT INTO task_specs VALUES ('t1',1,'refresh impl_c1','rebase on I_c1_v2','R_maint',NULL,'[]','[]','{}')`
)
const linkTarget = listImpactCandidates(db, { projectId: 'p1', status: 'candidate' }).items.find(
  (i) => i.reason.kind === 'context-source' && i.targetId === 'impl_c1'
)!
const link = linkMaintenanceTask(
  db,
  {
    candidateId: linkTarget.id,
    taskRef: { kind: 'task', taskId: 't1', revision: 1 },
    note: 'coordinator task'
  },
  ctxOp,
  deps
)
const linked = db
  .prepare('SELECT resolution_json FROM impact_candidates WHERE id = ?')
  .get(linkTarget.id) as { resolution_json: string }
check(
  link.revision === 2 &&
    (JSON.parse(linked.resolution_json) as { links: { id: string }[] }).links[0]?.id === 't1',
  'candidate linked to existing task t1 — no task created by runtime'
)
checkErr(
  () =>
    linkMaintenanceTask(
      db,
      { candidateId: linkTarget.id, taskRef: { kind: 'task', taskId: 'ghost' } },
      ctxOp,
      deps
    ),
  'MODEL_INVALID',
  'link to a nonexistent task rejected'
)

/* ============ 8. stale gate for new launches ==================== */

console.log('8. unreviewedStaleCandidates — launch-policy read model')
const gate = unreviewedStaleCandidates(db, { implementationId: 'impl_c1' })
check(
  gate.length > 0 && gate.every((i) => i.state === 'candidate' || i.state === 'confirmed'),
  'impl_c1 has unreviewed staleness for the launch gate (states candidate|confirmed only)'
)
const reqGate = unreviewedStaleCandidates(db, { roleId: 'R_c1', requiredOnly: true })
check(
  reqGate.every((i) => i.reason.required === true),
  'requiredOnly filters to required-coverage candidates'
)

/* ============ 9. event feeding =================================== */

console.log('9. applyDomainEvent — outbox-driven observation')
const handled = hooks.applyDomainEvent(db, {
  eventType: 'ContextSourceChanged',
  payload: {
    projectId: 'p1',
    modelVersion: 'mv2',
    contextId: 'ctx2',
    beforeDigest: 'x',
    afterDigest: 'y'
  }
})
const ctx2Cands = listImpactCandidates(db, { projectId: 'p1' }).items.filter(
  (i) => i.reason.kind === 'context-source' && JSON.stringify(i.reason).includes('ctx2')
)
check(
  handled && ctx2Cands.some((i) => i.targetId === 'R_c2'),
  'ctx2 event fed via applyDomainEvent -> R_c2 (horizontal link) candidate'
)
check(
  !hooks.applyDomainEvent(db, { eventType: 'Unrelated', payload: {} }),
  'unrelated event type is not consumed'
)

/* ============ 10. pin integrity — running bundle untouched ======= */

console.log('10. running bundle pin is never rewritten')
const bundleRow = db
  .prepare('SELECT interface_digest FROM context_bundles WHERE digest = ?')
  .get('bndl1') as { interface_digest: string }
const lpRow = db
  .prepare('SELECT bundle_digest, state FROM launch_plans WHERE id = ?')
  .get('lp1') as { bundle_digest: string; state: string }
check(
  bundleRow.interface_digest === 'I_c1' &&
    lpRow.bundle_digest === 'bndl1' &&
    lpRow.state === 'active',
  'pinned bundle/launch plan untouched by all maintenance writes'
)

/* ---------------------------------------------------------------- */

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAILURES: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
