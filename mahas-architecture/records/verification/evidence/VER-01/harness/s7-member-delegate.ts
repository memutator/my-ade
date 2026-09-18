// VER-01 step-7 — member-delegated assignment probe.
// The coordination leader's DUTY is to search + assign. s4 showed its
// discovery ops die on scope coverage; here we test the other half — can a
// member hold a provisioning grant and dispatch team.assign itself?
import {
  Recorder, wire, opCtx, memberCtx, loadState, saveState, writeJson, q1, qa
} from './common.ts'

const rec = new Recorder('s7-member-delegate')
const st = loadState()
const w = await wire('s7')
const { db } = w
const projectId = st.projectId as string
const mv7 = st.activeMv as string
const runId3 = st.runId3 as string
const memC3 = st.memC3 as string
const impl7 = st.impl7 as Record<string, { implId: string; revision: number }>
const provWide = st.provWide as { grantId: string; revision: number }
const ctx = opCtx()

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

// fresh token for r-web on mv7 (re-mint — tokens are cheap)
const rTok = await w.dispatch(ctx, 'responsibility.search', { projectId, modelVersion: mv7, paths: ['src/web/app.tsx'] })
const tokWeb = (rTok.result as { items?: { role: { id: string }; selectionToken: string }[] })?.items?.find((i) => i.role.id === 'r-web')?.selectionToken as string
rec.check('mv7 token re-minted for r-web', typeof tokWeb === 'string', 'token', `${rTok.status}`)

// member ctx with ONLY its assignment grant — no provisioning power expected
const asgGrantC = q1(db, "SELECT id,revision FROM grants WHERE principal_id=? AND kind='assignment'", memC3)!
const memCtxOnly = memberCtx(memC3, { [asgGrantC.id as string]: asgGrantC.revision as number })
const rNoProv = await w.dispatch(memCtxOnly, 'team.assign', {
  runId: runId3, selectionToken: tokWeb,
  implementationId: impl7['r-web']!.implId, implementationRevision: impl7['r-web']!.revision,
  assignmentKind: 'task', mandateText: 'member without provisioning tries to assign', expectedPlanRevision: 2
})
rec.check('member w/o provisioning grant → SCOPE_DENIED', rNoProv.status === 'rejected' && rNoProv.error?.code === 'SCOPE_DENIED', 'rejected SCOPE_DENIED', `${rNoProv.status} ${rNoProv.error?.code} ${rNoProv.error?.message}`)

// operator issues a provisioning grant TO the coordinator member principal
const rProvMem = await w.dispatch(opCtx({ [provWide.grantId]: provWide.revision }), 'access.grant', {
  kind: 'provisioning',
  subject: { principalId: memC3 },
  scope: {
    targets: [{ kind: 'project', id: projectId }],
    provisioning: {
      allowedRoleIds: ['r-lead', 'r-auth', 'r-web'],
      placementScope: [{ kind: 'project', id: projectId }],
      profileAdmission: 'verified-only'
    }
  },
  actions: MEMBER_VOCAB,
  parentGrantId: provWide.grantId
})
rec.check('provisioning grant issued to member principal', rProvMem.status === 'committed', 'committed', `${rProvMem.status} ${rProvMem.error?.code} ${rProvMem.error?.message}`)
const provMem = rProvMem.result as { grantId: string; revision: number } | undefined
const memCtxProv = provMem
  ? memberCtx(memC3, { [asgGrantC.id as string]: asgGrantC.revision as number, [provMem.grantId]: provMem.revision })
  : memCtxOnly
if (provMem) {
  const rMemberAssign = await w.dispatch(memCtxProv, 'team.assign', {
    runId: runId3, selectionToken: tokWeb,
    implementationId: impl7['r-web']!.implId, implementationRevision: impl7['r-web']!.revision,
    assignmentKind: 'task', mandateText: 'member-delegated assign under own provisioning grant', expectedPlanRevision: 2
  })
  rec.check('member-held provisioning → member ctx team.assign works', rMemberAssign.status === 'committed', 'committed', `${rMemberAssign.status} ${rMemberAssign.error?.code} ${rMemberAssign.error?.message}`)
  rec.artifact('memberDelegatedAssign', { status: rMemberAssign.status, error: rMemberAssign.error, memberId: (rMemberAssign.result as { memberId?: string })?.memberId })

  // and can the member see its own search surface now? (prov grant scope
  // covers {project} → discovery targets may resolve)
  const rMemberSearch = await w.dispatch(memCtxProv, 'responsibility.search', { projectId, query: '인증' })
  rec.check('member w/ project-scoped prov grant can search', rMemberSearch.status === 'committed', 'committed', `${rMemberSearch.status} ${rMemberSearch.error?.code} ${rMemberSearch.error?.message}`)
  rec.artifact('memberProvSearch', { status: rMemberSearch.status, error: rMemberSearch.error })
}

writeJson('s7-evidence.json', {
  memberGrants: qa(db, 'SELECT id,principal_id,kind,parent_grant_id,scope_json FROM grants WHERE principal_id=?', memC3),
  members: qa(db, 'SELECT id,run_id,role_id,state FROM members WHERE run_id=?', runId3)
})
saveState({ provMem })
w.runtime.close()
db.close()
rec.flush({ processPid: process.pid })
console.log('s7 done')
