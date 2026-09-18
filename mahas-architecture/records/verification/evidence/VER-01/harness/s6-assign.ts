// VER-01 step-6 — assignment on the CURRENT model:
//   coordination-leader assign WITHOUT a Task (D-WORK §2), plan.prepare/commit
//   creating initial-negotiation tasks, task-pinned team.assign on both sides
//   (the "양측 배정" negotiation start), task-pin validation negatives, and the
//   member-context surface on the fresh members.
import {
  Recorder, wire, opCtx, memberCtx, loadState, saveState, writeJson, cnt, q1, qa
} from './common.ts'

const rec = new Recorder('s6-assign')
const st = loadState()
const w = await wire('s6')
const { db } = w
const projectId = st.projectId as string
const mv7 = st.activeMv as string
const hpMainRev = st.hpMainRev as number
const provWide = st.provWide as { grantId: string; revision: number }
const provCtx = () => opCtx({ [provWide.grantId]: provWide.revision })
const ctx = opCtx()

rec.check('active model is post-structure mv7', typeof mv7 === 'string' && mv7.startsWith('mv_'), 'mv_*', String(mv7))

// ------------------------------------------------ 0. realizations on mv7 --
// impls pin interfaceDigest → role_interfaces.modelVersion; mv7 needs fresh
// interfaces + implementations for the roles we will assign.
const ifaceDigest: Record<string, string> = {}
const ifaceClauses: Record<string, string[]> = {}
for (const roleId of ['r-lead', 'r-auth', 'r-web']) {
  const r = await w.dispatch(ctx, 'interface.get', { modelVersion: mv7, roleId })
  rec.check(`interface.get ${roleId} on mv7 committed`, r.status === 'committed', 'committed', `${r.status} ${r.error?.code}`)
  const res = r.result as { digest: string; contextRequirements: { clauseId: string }[] }
  ifaceDigest[roleId] = res.digest
  ifaceClauses[roleId] = res.contextRequirements.map((x) => x.clauseId)
}

async function publishImpl(roleId: string, extraSkill: boolean): Promise<{ implId: string; revision: number } | null> {
  const clauses = ifaceClauses[roleId]!
  const components: unknown[] = [
    {
      componentId: 'comp-core', kind: 'instruction',
      contentBinding: { text: `VER-01 s6 impl for ${roleId} on mv7` },
      consumes: [], outputs: [],
      activation: { phase: 'initial' },
      permissionRequirements: []
    }
  ]
  if (extraSkill) {
    components.push({
      componentId: 'comp-skill', kind: 'skill',
      contentBinding: { name: `${roleId}-skill` },
      consumes: [], outputs: [],
      activation: { phase: 'conditional' },
      permissionRequirements: []
    })
  }
  const coverageBindings = clauses.map((clauseId) => ({
    clauseId, componentId: 'comp-core', sectionKey: 'main',
    realization: 'reexpressed', requiredLoadPhase: 'initial'
  }))
  const prepR = await w.dispatch(ctx, 'implementation.prepare', {
    interfaceDigest: ifaceDigest[roleId],
    profileId: 'hp-main', profileRevision: hpMainRev,
    maintainerRoleId: 'r-lead',
    componentGraph: { components },
    coverageBindings
  })
  if (prepR.status !== 'committed') {
    rec.check(`implementation.prepare ${roleId}@mv7 committed`, false, 'committed', `${prepR.status} ${prepR.error?.code} ${prepR.error?.message}`)
    return null
  }
  const pr = prepR.result as { candidateImplementation: { implementationId: string; revision: number }; digest: string; uncoveredClauses: string[] }
  rec.check(`impl ${roleId}@mv7 coverage complete`, pr.uncoveredClauses.length === 0, '[]', JSON.stringify(pr.uncoveredClauses))
  const pubR = await w.dispatch(ctx, 'implementation.publish', {
    candidateId: pr.candidateImplementation.implementationId,
    candidateDigest: pr.digest,
    expectedInterfaceDigest: ifaceDigest[roleId],
    semanticDecision: { statement: `VER-01 s6: ${roleId} covers mv7 interface` }
  })
  rec.check(`implementation.publish ${roleId}@mv7 committed`, pubR.status === 'committed', 'committed', `${pubR.status} ${pubR.error?.code} ${pubR.error?.message}`)
  if (pubR.status !== 'committed') return null
  return pubR.result as { implementationId: string; revision: number }
}
const impl7: Record<string, { implId: string; revision: number }> = {}
for (const [roleId, skill] of [['r-lead', true], ['r-auth', true], ['r-web', false]] as const) {
  const r = await publishImpl(roleId, skill)
  if (r) impl7[roleId] = { implId: (r as { implementationId?: string }).implementationId ?? (r as unknown as { implId: string }).implId, revision: r.revision }
}
rec.check('3 implementations published on mv7 interfaces', Object.keys(impl7).length === 3, '3', JSON.stringify(Object.keys(impl7)))

// --------------------------------------------------- 1. run-3 on mv7 -----
const rRun3 = await w.dispatch(ctx, 'run.create', {
  projectId, modelVersion: mv7,
  goalText: 'VER-01 run-3 — current-model assignment run',
  coordinatorRoleId: 'r-lead', purpose: 'work'
})
rec.check('run-3 created on mv7', rRun3.status === 'committed', 'committed', `${rRun3.status} ${rRun3.error?.code}`)
const runId3 = ((rRun3.result as { runId?: string; id?: string }).runId ?? (rRun3.result as { id?: string }).id) as string

// --------------------------------------------------- 2. fresh tokens -----
const tok7: Record<string, string> = {}
for (const [roleId, filter] of [
  ['r-lead', { horizontalRoleNames: ['coordinator'] }],
  ['r-auth', { paths: ['src/api/auth/login.ts'] }],
  ['r-web', { paths: ['src/web/app.tsx'] }]
] as const) {
  const r = await w.dispatch(ctx, 'responsibility.search', { projectId, modelVersion: mv7, ...(filter as object) })
  const card = (r.result as { items?: { role: { id: string }; selectionToken: string }[] })?.items?.find((i) => i.role.id === roleId)
  if (card) tok7[roleId] = card.selectionToken
  rec.check(`mv7 token captured for ${roleId}`, typeof card?.selectionToken === 'string', 'token', `${r.status} ${String(card?.selectionToken ?? r.error?.code).slice(0, 30)}`)
}

// --------------------------------------- 3. coordination preview+assign --
const before0 = ['members', 'assignments', 'grants', 'dispatches', 'domain_events'].map((t) => cnt(db, t))
const rPrevC = await w.dispatch(provCtx(), 'assignment.preview', {
  runId: runId3, selectionToken: tok7['r-lead'],
  implementationId: impl7['r-lead']!.implId, implementationRevision: impl7['r-lead']!.revision,
  assignmentKind: 'coordination', mandateText: 'run-3 coordination leader preview'
})
rec.check('coordination preview committed', rPrevC.status === 'committed', 'committed', `${rPrevC.status} ${rPrevC.error?.code} ${rPrevC.error?.message}`)
const after0 = ['members', 'assignments', 'grants', 'dispatches', 'domain_events'].map((t) => cnt(db, t))
rec.check('coordination preview zero side effects', JSON.stringify(before0) === JSON.stringify(after0), 'no deltas', `${JSON.stringify(before0)}→${JSON.stringify(after0)}`)

const rAsgC = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId3, selectionToken: tok7['r-lead'],
  implementationId: impl7['r-lead']!.implId, implementationRevision: impl7['r-lead']!.revision,
  assignmentKind: 'coordination', mandateText: 'run-3 coordination leader — NO Task (D-WORK §2)'
})
rec.check('coordination assign (no Task) committed', rAsgC.status === 'committed', 'committed', `${rAsgC.status} ${rAsgC.error?.code} ${rAsgC.error?.message}`)
const asgC = rAsgC.result as { memberId: string; assignmentId: string }
const run3row = q1(db, 'SELECT coordinator_member_id,state,current_plan_revision FROM runs WHERE id=?', runId3)
rec.check('run-3 coordinator set + activated, plan still empty', run3row?.coordinator_member_id === asgC?.memberId && run3row?.state === 'active' && (run3row?.current_plan_revision ?? 0) === 0, 'coord+active+plan0', JSON.stringify(run3row))
const asgCRow = q1(db, 'SELECT task_id,task_revision,kind FROM assignments WHERE id=?', asgC?.assignmentId)
rec.check('coordination assignment carries no Task pin', asgCRow?.task_id === null && asgCRow?.kind === 'coordination', 'task_id NULL', JSON.stringify(asgCRow))

// ------------------------------------- 4. initial-negotiation plan -------
// "협의가 필요한 양측은 … 초기 협의 task로 시작하도록 Plan을 작성한다" —
// two negotiation tasks, one per side, no implementation-task precondition.
const rPlanPrep = await w.dispatch(provCtx(), 'plan.prepare', {
  runId: runId3,
  patch: {
    tasks: [
      { taskId: 't-neg-auth', title: '초기 협의 — 인증 API 계약 합의', requirementText: '인증 경계와 웹 경계가 c-user-api 계약 해석을 합의한다', ownerRoleId: 'r-auth' },
      { taskId: 't-neg-web', title: '초기 협의 — UI 계약 소비 합의', requirementText: '웹 경계가 c-user-api 소비 방식을 인증 측과 합의한다', ownerRoleId: 'r-web' }
    ],
    edges: [
      { fromTask: 't-neg-auth', toTask: 't-neg-web', requiredOutputs: [], settlementRequirement: 'accepted' }
    ]
  }
})
rec.check('plan.prepare committed', rPlanPrep.status === 'committed', 'committed', `${rPlanPrep.status} ${rPlanPrep.error?.code} ${rPlanPrep.error?.message}`)
const planPrep = rPlanPrep.result as { candidatePlanId: string; digest: string; structuralErrors: string[]; unresolvedInputs: unknown[] }
rec.check('plan candidate has no structural errors', (planPrep?.structuralErrors ?? []).length === 0, '[]', JSON.stringify(planPrep?.structuralErrors))
const rPlanCommit = await w.dispatch(provCtx(), 'plan.commit', {
  candidatePlanId: planPrep.candidatePlanId, digest: planPrep.digest, expectedPlanRevision: 0
})
rec.check('plan.commit committed → plan revision 1', rPlanCommit.status === 'committed' && (rPlanCommit.result as { planRevision: number }).planRevision === 1, 'committed rev1', `${rPlanCommit.status} ${rPlanCommit.error?.code} ${rPlanCommit.error?.message}`)
const planTasks = qa(db, 'SELECT task_id,task_revision FROM plan_tasks WHERE run_id=? AND plan_revision=1 ORDER BY task_id', runId3)
rec.check('both negotiation tasks pinned in plan@1', planTasks.length === 2 && planTasks.every((t) => t.task_revision === 1), 't-neg-auth+t-neg-web @1', JSON.stringify(planTasks))
const specAuth = q1(db, 'SELECT owner_role_id,assigned_member_id FROM task_specs WHERE task_id=? AND revision=1', 't-neg-auth')
const specWeb = q1(db, 'SELECT owner_role_id,assigned_member_id FROM task_specs WHERE task_id=? AND revision=1', 't-neg-web')
rec.check('task specs carry owner roles', specAuth?.owner_role_id === 'r-auth' && specWeb?.owner_role_id === 'r-web', 'r-auth+r-web', JSON.stringify({ a: specAuth, w: specWeb }))

// ------------------------------------ 5. two-sided task-pinned assign ----
const rAsgA = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId3, selectionToken: tok7['r-auth'],
  implementationId: impl7['r-auth']!.implId, implementationRevision: impl7['r-auth']!.revision,
  assignmentKind: 'task', taskId: 't-neg-auth', taskRevision: 1,
  mandateText: '초기 협의 — 인증 측 담당', expectedPlanRevision: 1
})
rec.check('side-A assign pinned to t-neg-auth@1 committed', rAsgA.status === 'committed', 'committed', `${rAsgA.status} ${rAsgA.error?.code} ${rAsgA.error?.message}`)
const asgA = rAsgA.result as { memberId: string; assignmentId: string; effectiveGrantBinding: { actions: string[] } }
const asgARow = q1(db, 'SELECT task_id,task_revision,kind FROM assignments WHERE id=?', asgA?.assignmentId)
rec.check('assignment row pins t-neg-auth@1', asgARow?.task_id === 't-neg-auth' && asgARow?.task_revision === 1, 'task pin', JSON.stringify(asgARow))
rec.check('side-A grant is task-scoped (least privilege)', asgA?.effectiveGrantBinding?.actions?.includes('task.accept') && !asgA.effectiveGrantBinding.actions.includes('team.assign'), 'task-only actions', JSON.stringify(asgA?.effectiveGrantBinding?.actions))
const scopeA = q1(db, 'SELECT scope_json FROM grants WHERE id=?', (rAsgA.result as { effectiveGrantBinding: { grantId: string } })?.effectiveGrantBinding?.grantId)
rec.artifact('sideA.grantScope', scopeA?.scope_json)

const rAsgW = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId3, selectionToken: tok7['r-web'],
  implementationId: impl7['r-web']!.implId, implementationRevision: impl7['r-web']!.revision,
  assignmentKind: 'task', taskId: 't-neg-web', taskRevision: 1,
  mandateText: '초기 협의 — 웹 측 담당', expectedPlanRevision: 1
})
rec.check('side-B assign pinned to t-neg-web@1 committed', rAsgW.status === 'committed', 'committed', `${rAsgW.status} ${rAsgW.error?.code} ${rAsgW.error?.message}`)
const asgW = rAsgW.result as { memberId: string; assignmentId: string }
const members3 = qa(db, 'SELECT id,role_id,state FROM members WHERE run_id=? ORDER BY rowid', runId3)
rec.check('two-sided assignment: 3 members (leader + both parties)', members3.length === 3 && members3.map((m) => m.role_id).sort().join(',') === 'r-auth,r-lead,r-web', 'leader+A+B', JSON.stringify(members3))
// plan-side binding: revision-2 patch pre-assigns the negotiation tasks
const rPlan2 = await w.dispatch(provCtx(), 'plan.prepare', {
  runId: runId3,
  patch: {
    basePlanRevision: 1,
    tasks: [
      { taskId: 't-neg-auth', assignedMemberId: asgA.memberId },
      { taskId: 't-neg-web', assignedMemberId: asgW.memberId }
    ]
  }
})
rec.check('plan revision-2 prepare committed', rPlan2.status === 'committed', 'committed', `${rPlan2.status} ${rPlan2.error?.code} ${rPlan2.error?.message}`)
const plan2 = rPlan2.result as { candidatePlanId: string; digest: string; structuralErrors: string[] }
const rPlan2C = await w.dispatch(provCtx(), 'plan.commit', { candidatePlanId: plan2.candidatePlanId, digest: plan2.digest, expectedPlanRevision: 1 })
rec.check('plan revision-2 committed', rPlan2C.status === 'committed', 'committed', `${rPlan2C.status} ${rPlan2C.error?.code}`)
const specA2 = q1(db, 'SELECT assigned_member_id FROM task_specs WHERE task_id=? AND revision=2', 't-neg-auth')
const specW2 = q1(db, 'SELECT assigned_member_id FROM task_specs WHERE task_id=? AND revision=2', 't-neg-web')
rec.check('plan-bound member assignment landed on both sides', specA2?.assigned_member_id === asgA.memberId && specW2?.assigned_member_id === asgW.memberId, 'members bound', JSON.stringify({ a: specA2, w: specW2 }))

// ---------------------------------------- 6. task-pin validation ---------
const neg = async (name: string, payload: Record<string, unknown>, expect: { code?: string }) => {
  const r = await w.dispatch(provCtx(), 'team.assign', {
    runId: runId3,
    implementationId: impl7['r-auth']!.implId, implementationRevision: impl7['r-auth']!.revision,
    assignmentKind: 'task', mandateText: name, expectedPlanRevision: 2,
    ...payload
  })
  rec.check(name, r.status === 'rejected' && (expect.code === undefined || r.error?.code === expect.code), `rejected ${expect.code ?? ''}`, `${r.status} ${r.error?.code} ${r.error?.message}`)
  return r
}
await neg('task pin: wrong owner role → SCOPE_DENIED', { selectionToken: tok7['r-web'], implementationId: impl7['r-web']!.implId, implementationRevision: impl7['r-web']!.revision, taskId: 't-neg-auth', taskRevision: 2 }, { code: 'SCOPE_DENIED' })
await neg('task pin: stale taskRevision → STALE_REVISION', { selectionToken: tok7['r-auth'], taskId: 't-neg-auth', taskRevision: 99 }, { code: 'STALE_REVISION' })
await neg('task pin: unknown taskId → STALE_REVISION', { selectionToken: tok7['r-auth'], taskId: 't-ghost', taskRevision: 1 }, { code: 'STALE_REVISION' })
await neg('task pin: taskId without taskRevision → rejected', { selectionToken: tok7['r-auth'], taskId: 't-neg-auth' }, {})
const rPlanStale = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId3, selectionToken: tok7['r-auth'],
  implementationId: impl7['r-auth']!.implId, implementationRevision: impl7['r-auth']!.revision,
  assignmentKind: 'task', taskId: 't-neg-auth', taskRevision: 2,
  mandateText: 'stale plan pin', expectedPlanRevision: 0
})
rec.check('expectedPlanRevision=0 (plan now 2) → STALE_REVISION', rPlanStale.status === 'rejected' && rPlanStale.error?.code === 'STALE_REVISION', 'STALE_REVISION', `${rPlanStale.status} ${rPlanStale.error?.code}`)
const rCoord2 = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId3, selectionToken: tok7['r-web'],
  implementationId: impl7['r-web']!.implId, implementationRevision: impl7['r-web']!.revision,
  assignmentKind: 'coordination', mandateText: 'second coordinator', expectedPlanRevision: 2
})
rec.check('second coordinator on run-3 → INVALID_TRANSITION', rCoord2.status === 'rejected' && rCoord2.error?.code === 'INVALID_TRANSITION', 'INVALID_TRANSITION', `${rCoord2.status} ${rCoord2.error?.code}`)

// ------------------------------------- 7. member ctx surface + grants ----
const sideAGrant = q1(db, "SELECT id,revision,scope_json,actions_json FROM grants WHERE principal_id=? AND kind='assignment'", asgA.memberId)
rec.check('side-A member grant issued', sideAGrant !== undefined, 'grant', String(sideAGrant?.id))
const scopeJson = JSON.parse(String(sideAGrant!.scope_json)) as Record<string, unknown>
rec.artifact('memberGrant.scopeJson', scopeJson)
rec.check('member grant scope carries runId+taskIds pin', scopeJson.runId === runId3 && Array.isArray(scopeJson.taskIds) && (scopeJson.taskIds as string[]).includes('t-neg-auth'), 'runId+taskIds', JSON.stringify(scopeJson))
const memCtxA = memberCtx(asgA.memberId, { [sideAGrant!.id as string]: sideAGrant!.revision as number })
const rSurface = await w.dispatch(memCtxA, 'surface.describe', {})
rec.check('member surface.describe committed', rSurface.status === 'committed', 'committed', `${rSurface.status} ${rSurface.error?.code} ${rSurface.error?.message}`)
const surfOps = ((rSurface.result as { operations?: { name: string }[] })?.operations ?? []).map((o) => o.name)
rec.check('member surface lists task ops, not team.assign', surfOps.includes('task.accept') && !surfOps.includes('team.assign'), 'task surface', JSON.stringify(surfOps))
const rMemRunGet = await w.dispatch(memCtxA, 'run.get', { runId: runId3 })
// task-kind requiredActions excludes run.get → the op is outside this
// member's grant → hidden at the surface check (least privilege). Correct.
rec.check('task member ctx: run.get outside grant → hidden', rMemRunGet.status === 'rejected' && rMemRunGet.error?.code === 'UNAVAILABLE_OPERATION', 'rejected UNAVAILABLE_OPERATION', `${rMemRunGet.status} ${rMemRunGet.error?.code}`)
const rMemSearch = await w.dispatch(memCtxA, 'responsibility.search', { projectId, query: '인증' })
// responsibility.search is also outside the task grant → correctly hidden.
// (The coordinator variant — op in grant but scope can't cover — is the
//  s4 defect, which is the real authorization-shape bug.)
rec.check('task member ctx: responsibility.search outside grant → hidden', rMemSearch.status === 'rejected' && rMemSearch.error?.code === 'UNAVAILABLE_OPERATION', 'rejected UNAVAILABLE_OPERATION', `${rMemSearch.status} ${rMemSearch.error?.code}`)
rec.artifact('memberSearchRejection.taskMember', { status: rMemSearch.status, error: rMemSearch.error })
const rAssignShow = await w.dispatch(provCtx(), 'assignment.show', { memberId: asgA.memberId })
// assignment.show is inside every member's granted actions — but the
// composition root never wires a handler at 83a6d21, so it dispatches
// UNAVAILABLE_OPERATION for everyone. IMP-13 gap: a granted op that can
// never be called.
rec.check(
  'DEFECT: assignment.show implemented (it is in member grants)',
  rAssignShow.status === 'committed',
  'committed', `${rAssignShow.status} ${rAssignShow.error?.code} ${rAssignShow.error?.message}`
)
rec.artifact('assignmentShow.sideA', { status: rAssignShow.status, error: rAssignShow.error, result: rAssignShow.result })

saveState({ runId3, impl7, tok7captured: Object.keys(tok7), memA3: asgA?.memberId, memW3: asgW?.memberId, memC3: asgC?.memberId })
writeJson('s6-evidence.json', {
  members: qa(db, 'SELECT id,run_id,role_id,implementation_id,state FROM members'),
  assignments: qa(db, 'SELECT id,member_id,kind,task_id,task_revision FROM assignments'),
  grants: qa(db, "SELECT id,principal_id,kind,parent_grant_id,scope_json FROM grants WHERE kind='assignment'"),
  planTasks: qa(db, 'SELECT run_id,plan_revision,task_id,task_revision FROM plan_tasks ORDER BY plan_revision,task_id'),
  taskSpecs: qa(db, 'SELECT task_id,revision,owner_role_id,assigned_member_id FROM task_specs ORDER BY task_id,revision'),
  taskEdges: qa(db, 'SELECT * FROM task_edges')
})
w.runtime.close()
db.close()
rec.flush({ processPid: process.pid })
console.log('s6 done')
