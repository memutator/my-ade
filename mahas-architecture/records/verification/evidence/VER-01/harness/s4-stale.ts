// VER-01 step-4 — assignment preview/assign semantics, idempotency, and
// stale-token / stale-grant / stale-impl rejection with side-effect
// absence proof (row counts before vs after each rejected dispatch).
import {
  Recorder, wire, opCtx, loadState, saveState, writeJson, cnt, q1, qa
} from './common.ts'

const rec = new Recorder('s4-stale')
const st = loadState()
const w = await wire('s4')
const { db } = w
const projectId = st.projectId as string
const mv1 = st.mv1 as string
const runId1 = st.runId1 as string
const impls = st.impls as Record<string, { implId: string; revision: number }>
const provAll = st.provAll as { grantId: string; revision: number }
const tokByRole = st.tokByRole as Record<string, string>
const roleIds = st.roleIds as string[]

// The s1 provisioning grant carried only the two delegating actions — but a
// member grant is derived UNDER it (parentGrantId), and child actions must be
// a subset of parent actions. Re-issue with the full member vocabulary the
// delegation is allowed to mint (coordination ∪ task required actions).
const MEMBER_VOCAB = [
  'surface.describe', 'operation.get', 'assignment.show', 'inbox.check', 'inbox.wait',
  'delivery.ack', 'message.send', 'message.replyAndAck', 'artifact.read',
  'responsibility.search', 'responsibility.inspect', 'responsibility.locate',
  'responsibility.collaborators', 'role.implementations', 'assignment.preview',
  'run.get', 'run.close', 'plan.prepare', 'plan.commit', 'team.assign', 'team.retire',
  'task.dispatch', 'worker.prepare', 'worker.start', 'worker.inspect', 'worker.stop',
  'worker.resume', 'worker.release', 'execution.wake', 'outcome.decide', 'model.impact.list',
  'execution.join', 'execution.heartbeat', 'task.accept', 'task.report', 'artifact.publish',
  'access.inspect'
]
const rProvWide = await w.dispatch(opCtx(), 'access.grant', {
  kind: 'provisioning',
  subject: { principalId: 'operator-local' },
  scope: {
    targets: [{ kind: 'project', id: projectId }],
    provisioning: {
      allowedRoleIds: roleIds,
      placementScope: [{ kind: 'project', id: projectId }],
      profileAdmission: 'verified-only'
    }
  },
  actions: MEMBER_VOCAB
})
rec.check('wide provisioning grant committed', rProvWide.status === 'committed', 'committed', `${rProvWide.status} ${rProvWide.error?.code} ${rProvWide.error?.message}`)
const provWide = rProvWide.result as { grantId: string; revision: number }

const rProvRestr = await w.dispatch(opCtx(), 'access.grant', {
  kind: 'provisioning',
  subject: { principalId: 'operator-local' },
  scope: {
    targets: [{ kind: 'project', id: projectId }],
    provisioning: { allowedRoleIds: ['r-lead'], placementScope: [{ kind: 'project', id: projectId }] }
  },
  actions: MEMBER_VOCAB
})
rec.check('restricted(r-lead-only) prov grant committed', rProvRestr.status === 'committed', 'committed', `${rProvRestr.status} ${rProvRestr.error?.code}`)
const provRestricted2 = rProvRestr.result as { grantId: string; revision: number }
saveState({ provWide, provRestricted2 })

/** ctx carrying the operator seed grant + the broad provisioning grant */
const provCtx = () => opCtx({ [provWide.grantId]: provWide.revision })
/** ctx carrying ONLY the restricted provisioning grant (r-lead allowlist) */
const restrictedCtx = () => opCtx({ [provRestricted2.grantId]: provRestricted2.revision })

const SIDE_EFFECT_TABLES = ['members', 'assignments', 'grants', 'deliveries', 'principals', 'dispatches', 'domain_events', 'effect_intents']
function sideEffectCounts(): Record<string, number> {
  const o: Record<string, number> = {}
  for (const t of SIDE_EFFECT_TABLES) o[t] = cnt(db, t)
  return o
}
function countsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  return SIDE_EFFECT_TABLES.every((t) => a[t] === b[t])
}

// ------------------------------------------------- 1. positive control ---
// assignment.preview on a FRESH r-auth token — must create nothing.
const before0 = sideEffectCounts()
const rPrev = await w.dispatch(provCtx(), 'assignment.preview', {
  runId: runId1,
  selectionToken: tokByRole['r-auth'],
  implementationId: impls['r-auth']!.implId,
  implementationRevision: impls['r-auth']!.revision,
  assignmentKind: 'task',
  mandateText: 'preview only — 인증 검증 Task 후보'
})
rec.check('assignment.preview committed', rPrev.status === 'committed', 'committed', `${rPrev.status} ${rPrev.error?.code} ${rPrev.error?.message}`)
const prev = rPrev.result as {
  proposedMember: { runId: string; roleId: string; state: string }
  requiredActions: string[]
  grantCoverage: { grantId: string | null; missing: string[] }
  contextBlockers: string[]
  resourceConditions: string[]
}
rec.check('preview proposes pending member for r-auth', prev?.proposedMember?.roleId === 'r-auth' && prev.proposedMember.state === 'pending', 'r-auth/pending', JSON.stringify(prev?.proposedMember))
rec.check('preview grant coverage = broad prov grant', prev?.grantCoverage?.grantId === provWide.grantId, provWide.grantId, String(prev?.grantCoverage?.grantId))
rec.check('preview lists task-kind required actions', (prev?.requiredActions ?? []).includes('task.accept'), 'task.accept', JSON.stringify(prev?.requiredActions?.slice(0, 6)))
const after0 = sideEffectCounts()
rec.check('preview created ZERO side effects', countsEqual(before0, after0), 'no row deltas', JSON.stringify({ before: before0, after: after0 }))
rec.artifact('preview.r-auth', prev)

// team.assign — coordination leader first (no Task), then a task-kind member.
const rAssignLead = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId1,
  selectionToken: tokByRole['r-lead'],
  implementationId: impls['r-lead']!.implId,
  implementationRevision: impls['r-lead']!.revision,
  assignmentKind: 'coordination',
  mandateText: 'run-1 coordination leader — 책임 검색과 팀 배정을 수행'
})
rec.check('coordination assign committed', rAssignLead.status === 'committed', 'committed', `${rAssignLead.status} ${rAssignLead.error?.code} ${rAssignLead.error?.message}`)
const asgLead = rAssignLead.result as { memberId: string; assignmentId: string; effectiveGrantBinding: { grantId: string; actions: string[] } }
rec.check('member+assignment ids returned', typeof asgLead?.memberId === 'string' && typeof asgLead?.assignmentId === 'string', 'ids', JSON.stringify(asgLead))
rec.check('coordination grant carries discovery+team ops', ['responsibility.search', 'team.assign', 'plan.commit'].every((a) => asgLead?.effectiveGrantBinding?.actions?.includes(a)), 'coord ops', JSON.stringify(asgLead?.effectiveGrantBinding?.actions?.length))
const runRow = q1(db, 'SELECT coordinator_member_id, state, revision FROM runs WHERE id=?', runId1)
rec.check('run.coordinator_member_id set atomically', runRow?.coordinator_member_id === asgLead.memberId, asgLead.memberId, String(runRow?.coordinator_member_id))
rec.check('run activated from draft', runRow?.state === 'active', 'active', String(runRow?.state))
const leadGrantRow = q1(db, 'SELECT kind,parent_grant_id,actions_json FROM grants WHERE id=?', asgLead.effectiveGrantBinding.grantId)
rec.check('member grant derived from provisioning grant', leadGrantRow?.parent_grant_id === provWide.grantId, provWide.grantId, String(leadGrantRow?.parent_grant_id))
const memAssigned = qa(db, "SELECT event_type FROM domain_events WHERE aggregate_id=? OR payload_json LIKE ?", asgLead.memberId, `%${asgLead.memberId}%`)
rec.check('member.assigned domain event emitted', memAssigned.some((e) => e.event_type === 'member.assigned'), 'member.assigned', JSON.stringify(memAssigned.map((e) => e.event_type)))

const rAssignAuth = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId1,
  selectionToken: tokByRole['r-auth'],
  implementationId: impls['r-auth']!.implId,
  implementationRevision: impls['r-auth']!.revision,
  assignmentKind: 'task',
  mandateText: '인증 토큰 검증 구현 Task 담당'
})
rec.check('task-kind assign (no taskId) committed', rAssignAuth.status === 'committed', 'committed', `${rAssignAuth.status} ${rAssignAuth.error?.code} ${rAssignAuth.error?.message}`)
const asgAuth = rAssignAuth.result as { memberId: string; effectiveGrantBinding: { actions: string[] } }
rec.check('task member grant lacks coordination ops', !asgAuth?.effectiveGrantBinding?.actions?.includes('team.assign') && asgAuth?.effectiveGrantBinding?.actions?.includes('task.accept'), 'least-privilege', JSON.stringify(asgAuth?.effectiveGrantBinding?.actions))
saveState({ memLead: asgLead.memberId, asgLead: asgLead.assignmentId, memAuth: asgAuth.memberId })

// documented-profile impl under a verified-only provisioning admission →
// must be refused at the provisioning check (REQ-10 / D-ACCESS)
const rAssignUsers = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId1,
  selectionToken: tokByRole['r-users'],
  implementationId: impls['r-users']!.implId,
  implementationRevision: impls['r-users']!.revision,
  assignmentKind: 'task',
  mandateText: 'documented-profile member — should be refused (verified-only)'
})
rec.check(
  'documented-profile impl refused (verified-only admission)',
  rAssignUsers.status === 'rejected' && rAssignUsers.error?.code === 'SCOPE_DENIED',
  'rejected SCOPE_DENIED', `${rAssignUsers.status} ${rAssignUsers.error?.code} ${rAssignUsers.error?.message} ${JSON.stringify(rAssignUsers.error?.details ?? '')}`
)
rec.artifact('usersAssignRejection', rAssignUsers.error)

// provisioning allowlist enforcement — the restricted grant names ONLY
// r-lead in scope.provisioning.allowedRoleIds (the shape access.grant
// REQUIRES). SPEC: r-auth assign must be refused (outside the allowlist).
// If checkProvisioning reads a different (flat) shape, the allowlist is
// vacuous and this commits — an authorization bypass.
const rRestricted = await w.dispatch(restrictedCtx(), 'team.assign', {
  runId: runId1,
  selectionToken: tokByRole['r-auth'],
  implementationId: impls['r-auth']!.implId,
  implementationRevision: impls['r-auth']!.revision,
  assignmentKind: 'task',
  mandateText: 'r-auth under r-lead-only provisioning grant — must refuse'
})
rec.check(
  'provisioning allowlist enforced: r-auth refused under r-lead-only grant',
  rRestricted.status === 'rejected',
  'rejected', `${rRestricted.status} ${rRestricted.error?.code} ${rRestricted.error?.message}`
)
rec.artifact('restrictedAssign.outcome', { status: rRestricted.status, error: rRestricted.error, result: rRestricted.status === 'committed' ? rRestricted.result : undefined })
if (rRestricted.status === 'committed') {
  rec.artifact('restrictedAssign.memberRow', q1(db, 'SELECT id,role_id,state FROM members WHERE id=?', (rRestricted.result as { memberId: string }).memberId))
}

// idempotent replay — same operationId + same payload → stored receipt, no dup
const dupOpId = 'ver01:s4:idem-1'
const i1 = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId1,
  selectionToken: tokByRole['r-web'],
  implementationId: impls['r-web']!.implId,
  implementationRevision: impls['r-web']!.revision,
  assignmentKind: 'task',
  mandateText: 'idempotent member fixture'
}, dupOpId)
rec.check('web assign attempt-1 committed', i1.status === 'committed', 'committed', `${i1.status} ${i1.error?.code} ${i1.error?.message}`)
const nMemAfterWeb1 = cnt(db, 'members')
const i2 = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId1,
  selectionToken: tokByRole['r-web'],
  implementationId: impls['r-web']!.implId,
  implementationRevision: impls['r-web']!.revision,
  assignmentKind: 'task',
  mandateText: 'idempotent member fixture'
}, dupOpId)
rec.check(
  'idempotent replay returns same member, no duplicate',
  i2.status === 'committed' &&
    (i2.result as { memberId: string }).memberId === (i1.result as { memberId: string }).memberId &&
    cnt(db, 'members') === nMemAfterWeb1,
  'same memberId +0 members',
  `${i2.status} members=${cnt(db, 'members')} (was ${nMemAfterWeb1})`
)
const memWeb = (i1.result as { memberId?: string })?.memberId
saveState({ memWeb })

// conflict — same operationId, different payload → OPERATION_CONFLICT
const i3 = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId1,
  selectionToken: tokByRole['r-alt'],
  implementationId: impls['r-alt']!.implId,
  implementationRevision: impls['r-alt']!.revision,
  assignmentKind: 'task',
  mandateText: 'DIFFERENT payload, same operationId'
}, dupOpId)
rec.check('same operationId + different payload → OPERATION_CONFLICT', i3.status === 'rejected' && i3.error?.code === 'OPERATION_CONFLICT', 'OPERATION_CONFLICT', `${i3.status} ${i3.error?.code}`)

// ------------------------------------------------ 2. publish model v2 ----
const rPrep2 = await w.dispatch(opCtx(), 'model.change.prepare', {
  projectId, baseVersion: mv1,
  edits: [
    { type: 'boundary.revise', boundaryId: 'b-docs', set: { name: 'docs-v2' } },
    { type: 'role.revise', roleId: 'r-users', set: { description: '사용자 계정·프로필·권한 API를 담당한다 (v2)' } }
  ]
})
rec.check('v2 prepare committed', rPrep2.status === 'committed', 'committed', `${rPrep2.status} ${rPrep2.error?.code}`)
const prep2 = rPrep2.result as { changeId: string; candidateDigest: string; touchedTargets: unknown[] }
rec.artifact('v2.touchedTargets', prep2.touchedTargets)
const rCommit2 = await w.dispatch(opCtx(), 'model.change.commit', {
  changeId: prep2.changeId, candidateDigest: prep2.candidateDigest,
  expectedActiveVersion: mv1,
  semanticDecision: 'VER-01 v2 — docs rename + r-users description'
})
rec.check('v2 commit committed', rCommit2.status === 'committed', 'committed', `${rCommit2.status} ${rCommit2.error?.code}`)
const mv2 = q1(db, 'SELECT active_model_version AS m FROM projects WHERE id=?', projectId)!.m as string
rec.check('mv1 superseded, mv2 active', q1(db, 'SELECT status FROM model_versions WHERE id=?', mv1)?.status === 'superseded' && mv2 !== mv1, 'superseded+mv2', `${q1(db, 'SELECT status FROM model_versions WHERE id=?', mv1)?.status} active=${mv2}`)

const rRun2 = await w.dispatch(opCtx(), 'run.create', {
  projectId, modelVersion: mv2,
  goalText: 'VER-01 run-2 — on model v2', coordinatorRoleId: 'r-lead', purpose: 'work'
})
rec.check('run-2 created on mv2', rRun2.status === 'committed', 'committed', `${rRun2.status} ${rRun2.error?.code}`)
const runId2 = ((rRun2.result as { runId?: string; id?: string }).runId ?? (rRun2.result as { id?: string }).id) as string
saveState({ mv2, runId2 })

// ------------------------------------- 3. stale / tampered / revoked ----
// (a) mv1 token replayed against run-2 (mv2) — model pin mismatch
const beforeStale = sideEffectCounts()
const rStaleTok = await w.dispatch(provCtx(), 'assignment.preview', {
  runId: runId2,
  selectionToken: tokByRole['r-auth'],
  implementationId: impls['r-auth']!.implId,
  implementationRevision: impls['r-auth']!.revision,
  assignmentKind: 'task', mandateText: 'stale token replay'
})
rec.check('stale token → preview rejected STALE_REVISION', rStaleTok.status === 'rejected' && rStaleTok.error?.code === 'STALE_REVISION', 'STALE_REVISION', `${rStaleTok.status} ${rStaleTok.error?.code} ${rStaleTok.error?.message}`)
const rStaleAssign = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId2,
  selectionToken: tokByRole['r-auth'],
  implementationId: impls['r-auth']!.implId,
  implementationRevision: impls['r-auth']!.revision,
  assignmentKind: 'task', mandateText: 'stale token replay'
})
rec.check('stale token → assign rejected STALE_REVISION', rStaleAssign.status === 'rejected' && rStaleAssign.error?.code === 'STALE_REVISION', 'STALE_REVISION', `${rStaleAssign.status} ${rStaleAssign.error?.code}`)
rec.check('stale-token rejections left no side effects', countsEqual(beforeStale, sideEffectCounts()), 'no deltas', JSON.stringify(sideEffectCounts()))

// (b) tampered token — last char swapped → signature failure
const tampered = tokByRole['r-auth']!.slice(0, -4) + (tokByRole['r-auth']!.endsWith('AAAA') ? 'BBBB' : 'AAAA')
const beforeTamper = sideEffectCounts()
const rTamp = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId1, selectionToken: tampered,
  implementationId: impls['r-auth']!.implId, implementationRevision: impls['r-auth']!.revision,
  assignmentKind: 'task', mandateText: 'tampered token'
})
rec.check('tampered token → rejected (integrity)', rTamp.status === 'rejected' && (rTamp.error?.code === 'STALE_REVISION' || rTamp.error?.code === 'UNAUTHENTICATED'), 'rejected', `${rTamp.status} ${rTamp.error?.code} ${rTamp.error?.message}`)
rec.check('tamper rejection left no side effects', countsEqual(beforeTamper, sideEffectCounts()), 'no deltas', '')

// (c) revoked provisioning grant — issue a fresh prov grant, revoke it, replay
const rProvTmp = await w.dispatch(opCtx(), 'access.grant', {
  kind: 'provisioning',
  subject: { principalId: 'operator-local' },
  scope: { targets: [{ kind: 'project', id: projectId }], provisioning: { allowedRoleIds: ['r-alt'] } },
  actions: ['team.assign', 'assignment.preview']
})
const provTmp = rProvTmp.result as { grantId: string; revision: number }
const rRevoke = await w.dispatch(opCtx(), 'access.revoke', { grantId: provTmp.grantId, reason: 'VER-01 stale-grant test' })
rec.check('prov grant revoked via API', rRevoke.status === 'committed', 'committed', `${rRevoke.status} ${rRevoke.error?.code}`)
const beforeRev = sideEffectCounts()
const rRev = await w.dispatch(
  opCtx({ [provTmp.grantId]: provTmp.revision }),
  'team.assign',
  {
    runId: runId1, selectionToken: tokByRole['r-alt'],
    implementationId: impls['r-alt']!.implId, implementationRevision: impls['r-alt']!.revision,
    assignmentKind: 'task', mandateText: 'assign under revoked grant'
  }
)
rec.check('revoked grant → GRANT_REVOKED', rRev.status === 'rejected' && rRev.error?.code === 'GRANT_REVOKED', 'GRANT_REVOKED', `${rRev.status} ${rRev.error?.code} ${rRev.error?.message}`)
rec.check('revocation rejection left no side effects', countsEqual(beforeRev, sideEffectCounts()), 'no deltas', '')

// (d) retired implementation — retire impl-r-alt then replay its token
const rRetire = await w.dispatch(opCtx(), 'implementation.retire', {
  implementationId: impls['r-alt']!.implId, revision: impls['r-alt']!.revision,
  reason: 'VER-01 stale-impl test'
})
rec.check('implementation.retire committed', rRetire.status === 'committed', 'committed', `${rRetire.status} ${rRetire.error?.code}`)
const beforeRet = sideEffectCounts()
const rStaleImpl = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId1, selectionToken: tokByRole['r-alt'],
  implementationId: impls['r-alt']!.implId, implementationRevision: impls['r-alt']!.revision,
  assignmentKind: 'task', mandateText: 'assign retired impl'
})
rec.check('retired impl → IMPLEMENTATION_MISSING', rStaleImpl.status === 'rejected' && rStaleImpl.error?.code === 'IMPLEMENTATION_MISSING', 'IMPLEMENTATION_MISSING', `${rStaleImpl.status} ${rStaleImpl.error?.code} ${rStaleImpl.error?.message}`)
rec.check('stale-impl rejection left no side effects', countsEqual(beforeRet, sideEffectCounts()), 'no deltas', '')

// (e) expectedPlanRevision mismatch → STALE_REVISION
const rPlanStale = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId1, selectionToken: tokByRole['r-web'],
  implementationId: impls['r-web']!.implId, implementationRevision: impls['r-web']!.revision,
  assignmentKind: 'task', mandateText: 'stale plan pin', expectedPlanRevision: 99
})
rec.check('expectedPlanRevision=99 → STALE_REVISION', rPlanStale.status === 'rejected' && rPlanStale.error?.code === 'STALE_REVISION', 'STALE_REVISION', `${rPlanStale.status} ${rPlanStale.error?.code} ${rPlanStale.error?.message}`)

// (f) coordination assignment carrying a taskId → rejected contract
const rCoordTask = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId1, selectionToken: tokByRole['r-web'],
  implementationId: impls['r-web']!.implId, implementationRevision: impls['r-web']!.revision,
  assignmentKind: 'coordination', mandateText: 'coordination w/ task',
  taskId: 'tsk-x', taskRevision: 1
})
rec.check('coordination+taskId → rejected (D-WORK §2)', rCoordTask.status === 'rejected', 'rejected', `${rCoordTask.status} ${rCoordTask.error?.code} ${rCoordTask.error?.message}`)

// (g) second coordination assign → single-owner rule
const rCoord2 = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId1, selectionToken: tokByRole['r-web'],
  implementationId: impls['r-web']!.implId, implementationRevision: impls['r-web']!.revision,
  assignmentKind: 'coordination', mandateText: 'second coordinator attempt'
})
rec.check('second coordinator → INVALID_TRANSITION', rCoord2.status === 'rejected' && rCoord2.error?.code === 'INVALID_TRANSITION', 'INVALID_TRANSITION', `${rCoord2.status} ${rCoord2.error?.code} ${rCoord2.error?.message}`)

// (h) token minted for one role + impl of a different role → mismatch
const rWrongImpl = await w.dispatch(provCtx(), 'team.assign', {
  runId: runId1, selectionToken: tokByRole['r-auth'],
  implementationId: impls['r-web']!.implId, implementationRevision: impls['r-web']!.revision,
  assignmentKind: 'task', mandateText: 'token r-auth + impl r-web'
})
rec.check('token role ≠ impl role → INTERFACE_STALE', rWrongImpl.status === 'rejected' && rWrongImpl.error?.code === 'INTERFACE_STALE', 'INTERFACE_STALE', `${rWrongImpl.status} ${rWrongImpl.error?.code} ${rWrongImpl.error?.message}`)

// ------------------------------------------------ 4. member-ctx surface ---
// the coordinator member's own credential sees the coordination surface
const memLead = asgLead.memberId as string
const leadGrant = q1(db, 'SELECT id,revision FROM grants WHERE principal_id=? AND kind=?', memLead, 'assignment')
const memCtxLead = { principalId: memLead, memberId: memLead, controllerEpoch: 1, grantRevisions: { [leadGrant!.id as string]: leadGrant!.revision as number }, transportSessionId: `ver01:member:${memLead}` }
const rMemSearch = await w.dispatch(memCtxLead, 'responsibility.search', { projectId, query: '인증' })
// SPEC expectation: the coordinator member's grant lists responsibility.search
// in its actions, so the member should be able to search. OBSERVED: SCOPE_DENIED
// — the stored member scope maps to {run} targets only; discovery authorizes
// {project}/{modelVersion}/{boundary}/{role} targets the scope never covers.
rec.check(
  'DEFECT: coordinator member can search (grant lists the op)',
  rMemSearch.status === 'committed',
  'committed', `${rMemSearch.status} ${rMemSearch.error?.code} ${rMemSearch.error?.message}`
)
rec.artifact('memberSearchRejection', { status: rMemSearch.status, error: rMemSearch.error })
const rMemRunGet = await w.dispatch(memCtxLead, 'run.get', { runId: runId1 })
rec.check('member ctx run.get works (run-scoped target covered)', rMemRunGet.status === 'committed', 'committed', `${rMemRunGet.status} ${rMemRunGet.error?.code} ${rMemRunGet.error?.message}`)
const rMemGrantOp = await w.dispatch(memCtxLead, 'access.grant', {
  kind: 'assignment', subject: { principalId: 'x' }, scope: {}, actions: ['task.accept']
})
rec.check('member ctx denied operator op access.grant', rMemGrantOp.status === 'rejected', 'rejected', `${rMemGrantOp.status} ${rMemGrantOp.error?.code}`)

// ------------------------------------------------------- 5. final dump ---
writeJson('s4-evidence.json', {
  members: qa(db, 'SELECT id,run_id,role_id,implementation_id,state,generation FROM members'),
  assignments: qa(db, 'SELECT id,member_id,kind,task_id,grant_id FROM assignments'),
  memberGrants: qa(db, "SELECT id,kind,principal_id,parent_grant_id,revoked_at FROM grants WHERE kind != 'provisioning' OR revoked_at IS NOT NULL"),
  runRows: qa(db, 'SELECT id,model_version,state,coordinator_member_id,current_plan_revision,revision FROM runs'),
  domainEventTypes: qa(db, 'SELECT event_type, COUNT(*) n FROM domain_events GROUP BY event_type ORDER BY event_type'),
  finalCounts: sideEffectCounts()
})

w.runtime.close()
db.close()
rec.flush({ processPid: process.pid })
console.log('s4 done')
