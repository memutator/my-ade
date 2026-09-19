// VER-01 step-5 — structural edits through the real API:
//   boundary.split / boundary.reparent / role.retire / boundary.retire,
//   invalid-candidate refusal, touched-scope computation, and post-commit
//   relationship consistency verified against BOTH the SQLite rows and the
//   discovery surface (locate/search/inspect on the new active version).
import {
  Recorder, wire, opCtx, loadState, saveState, writeJson, cnt, q1, qa, dumpModelRows, digestOf
} from './common.ts'

const rec = new Recorder('s5-structure')
const st = loadState()
const w = await wire('s5')
const { db } = w
const projectId = st.projectId as string
const mv2 = st.mv2 as string
const tokByRole = st.tokByRole as Record<string, string>
const impls = st.impls as Record<string, { implId: string; revision: number }>
const provWide = st.provWide as { grantId: string; revision: number }
const provCtx = () => opCtx({ [provWide.grantId]: provWide.revision })
const ctx = opCtx()

const tKey = (t: unknown): string => {
  const o = t as { kind?: string; id?: string }
  return `${o?.kind}:${o?.id}`
}
const hasTarget = (touched: unknown[], kind: string, id: string): boolean =>
  touched.some((t) => tKey(t) === `${kind}:${id}`)

interface Prep {
  changeId: string
  candidateDigest: string
  touchedTargets: { kind: string; id: string }[]
  structuralErrors: { code: string; message: string; severity?: string }[]
  semanticReviewItems: { code: string; message: string }[]
}
interface CommitOut {
  publishedVersion: string
  digest: string
  impactBatchId?: string
}

const activeMv = (): string =>
  q1(db, 'SELECT active_model_version AS m FROM projects WHERE id=?', projectId)!.m as string

async function prepare(baseVersion: string, edits: unknown[]): Promise<{ status: string; result?: Prep; error?: { code: string; message: string } }> {
  const r = await w.dispatch(ctx, 'model.change.prepare', { projectId, baseVersion, edits })
  return { status: r.status, result: r.result as Prep | undefined, error: r.error }
}
async function commit(changeId: string, candidateDigest: string, expectedActiveVersion: string | null, label: string) {
  const r = await w.dispatch(ctx, 'model.change.commit', {
    changeId, candidateDigest, expectedActiveVersion, semanticDecision: `VER-01 ${label}`
  })
  return r
}

// ------------------------------------------------- 0. baseline ----------
const mv0rows = dumpModelRows(db, mv2)
rec.check('baseline: active version is mv2', activeMv() === mv2, mv2, activeMv())
rec.artifact('baseline.mv2.boundaries', qa(db, 'SELECT id,name FROM rdd_boundaries WHERE model_version=? ORDER BY id', mv2))

// ===================================== 1. boundary.split → mv3 ============
const splitEdits = [
  {
    type: 'boundary.split',
    boundaryId: 'b-api',
    children: [
      {
        id: 'b-api-auth', name: 'api-auth', responsibility: '인증·토큰 검증 API를 소유한다',
        paths: [{ path: 'src/api/auth', kind: 'directory' }],
        criteria: [{ criterion: '보안 정확성', description: '인증 경로가 위협 모델을 만족한다' }]
      },
      {
        id: 'b-api-users', name: 'api-users', responsibility: '사용자 계정·프로필 API를 소유한다',
        paths: [{ path: 'src/api/users', kind: 'directory' }],
        criteria: [{ criterion: '데이터 정합성', description: '계정 상태가 일관되게 유지된다' }]
      }
    ],
    roleRemap: { 'r-auth': 'b-api-auth', 'r-users': 'b-api-users' },
    contractProviderRemap: { 'c-user-api': 'b-api-auth' },
    nonGoalRemap: { 'ng-api-1': 'b-api-auth' },
    contextRemap: { 'ctx-security': 'b-api-auth' }
  }
]
const pSplit = await prepare(mv2, splitEdits)
rec.check('split: prepare committed', pSplit.status === 'committed', 'committed', `${pSplit.status} ${pSplit.error?.code} ${pSplit.error?.message}`)
const prepSplit = pSplit.result!
rec.check('split: no structural errors', (prepSplit.structuralErrors ?? []).length === 0, '[]', JSON.stringify(prepSplit.structuralErrors))
rec.check(
  'split: touched scope covers split boundary + children + remapped role/contract',
  hasTarget(prepSplit.touchedTargets, 'boundary', 'b-api') &&
    hasTarget(prepSplit.touchedTargets, 'boundary', 'b-api-auth') &&
    hasTarget(prepSplit.touchedTargets, 'boundary', 'b-api-users') &&
    hasTarget(prepSplit.touchedTargets, 'role', 'r-auth') &&
    hasTarget(prepSplit.touchedTargets, 'role', 'r-users') &&
    hasTarget(prepSplit.touchedTargets, 'contract', 'c-user-api') &&
    hasTarget(prepSplit.touchedTargets, 'non-goal', 'ng-api-1'),
  'b-api+children+r-auth+r-users+c-user-api+ng-api-1',
  JSON.stringify(prepSplit.touchedTargets)
)
rec.check(
  'split: territory overlap reported as review diagnostic (not a publish error)',
  (prepSplit.semanticReviewItems ?? []).some((i) => i.code === 'AMBIGUOUS_TERRITORY'),
  'AMBIGUOUS_TERRITORY review', JSON.stringify(prepSplit.semanticReviewItems?.map((i) => i.code))
)
rec.artifact('split.prepare', prepSplit)
// prepare must not mutate the active snapshot
const mv2AfterPrep = dumpModelRows(db, mv2)
rec.check('prepare left mv2 rows untouched', digestOf(mv2AfterPrep) === digestOf(mv0rows), 'same digest', `${digestOf(mv2AfterPrep).slice(0, 16)} vs ${digestOf(mv0rows).slice(0, 16)}`)
rec.check('model_changes row persisted as prepared', q1(db, 'SELECT state FROM model_changes WHERE id=?', prepSplit.changeId)?.state === 'prepared', 'prepared', String(q1(db, 'SELECT state FROM model_changes WHERE id=?', prepSplit.changeId)?.state))
rec.check('active version unchanged by prepare', activeMv() === mv2, mv2, activeMv())

const cSplit = await commit(prepSplit.changeId, prepSplit.candidateDigest, mv2, 'split b-api')
rec.check('split: commit committed', cSplit.status === 'committed', 'committed', `${cSplit.status} ${cSplit.error?.code} ${cSplit.error?.message}`)
const mv3 = (cSplit.result as CommitOut)?.publishedVersion
rec.check('mv3 active after split commit', activeMv() === mv3 && mv3 !== mv2, 'new active', String(mv3))

// --- post-commit relationship consistency (SQLite 정본) ---
const edges3 = qa(db, 'SELECT child_id,parent_id FROM boundary_edges WHERE model_version=? ORDER BY child_id', mv3)
const b3 = qa(db, 'SELECT id,name FROM rdd_boundaries WHERE model_version=? ORDER BY id', mv3).map((b) => b.id)
rec.check('mv3 contains split children', b3.includes('b-api-auth') && b3.includes('b-api-users') && b3.includes('b-api'), 'b-api-auth+b-api-users kept under b-api', JSON.stringify(b3))
const parentOf = (id: string): unknown => edges3.find((e) => e.child_id === id)?.parent_id
rec.check('split children parented under b-api', parentOf('b-api-auth') === 'b-api' && parentOf('b-api-users') === 'b-api', 'parent=b-api', JSON.stringify(edges3.filter((e) => (e.child_id as string).startsWith('b-api'))))
const roles3 = qa(db, 'SELECT id,boundary_id FROM rdd_roles WHERE model_version=? ORDER BY id', mv3)
const roleB = (id: string): unknown => roles3.find((r) => r.id === id)?.boundary_id
rec.check('roleRemap applied: r-auth→b-api-auth, r-users→b-api-users', roleB('r-auth') === 'b-api-auth' && roleB('r-users') === 'b-api-users', 'remapped', JSON.stringify(roles3.filter((r) => ['r-auth', 'r-users'].includes(r.id as string))))
const prov3 = q1(db, 'SELECT provider_boundary_id FROM rdd_contracts WHERE model_version=? AND id=?', mv3, 'c-user-api')
rec.check('contractProviderRemap applied: c-user-api→b-api-auth', prov3?.provider_boundary_id === 'b-api-auth', 'b-api-auth', String(prov3?.provider_boundary_id))
const cons3 = qa(db, 'SELECT consumer_boundary_id FROM contract_consumers WHERE model_version=? AND contract_id=?', mv3, 'c-user-api').map((c) => c.consumer_boundary_id)
rec.check('contract consumers preserved (b-web)', cons3.length === 1 && cons3[0] === 'b-web', 'b-web', JSON.stringify(cons3))
const ng3 = q1(db, 'SELECT boundary_id FROM rdd_non_goals WHERE model_version=? AND id=?', mv3, 'ng-api-1')
rec.check('nonGoalRemap applied: ng-api-1→b-api-auth', ng3?.boundary_id === 'b-api-auth', 'b-api-auth', String(ng3?.boundary_id))
const bcx3 = qa(db, 'SELECT boundary_id,context_id FROM boundary_contexts WHERE model_version=? AND context_id=?', mv3, 'ctx-security')
rec.check('contextRemap applied: ctx-security moved to b-api-auth', bcx3.length === 1 && bcx3[0]!.boundary_id === 'b-api-auth', 'b-api-auth only', JSON.stringify(bcx3))
const paths3 = qa(db, 'SELECT boundary_id,path FROM boundary_paths WHERE model_version=? AND boundary_id IN (?,?) ORDER BY boundary_id', mv3, 'b-api-auth', 'b-api-users')
rec.check('split children carry declared paths', paths3.length === 2 && paths3[0]!.path === 'src/api/auth' && paths3[1]!.path === 'src/api/users', 'src/api/auth+src/api/users', JSON.stringify(paths3))

// --- consistency through the discovery surface on the NEW version ---
const rLoc3 = await w.dispatch(ctx, 'responsibility.locate', {
  projectId, paths: ['src/api/auth/login.ts', 'src/api/users/list.ts', 'src/api', 'src/api/readme.md']
})
const loc3 = Object.fromEntries(((rLoc3.result as { items: { path: string; status: string; boundaryId?: string; claimants?: { boundaryId: string }[] }[] })?.items ?? []).map((i) => [i.path, i]))
// SPEC (rdd §2 + model/territory.ts resolveTerritory rule 2): ANY pair of
// claimants not in a contains ancestor relation → ambiguous, never
// deepest-wins. OBSERVED at 83a6d21: locate.ts's own resolveDeepest picks the
// deeper claim anyway — the non-ancestor overlap with b-api-alt is silently
// resolved to the carved child. IMP-06 defect (the uncommitted tree re-wires
// locate to resolveTerritory — the owner already agrees).
const claimIdsOf = (p: string): string[] => (loc3[p]?.claimants ?? []).map((c) => c.boundaryId)
rec.check(
  'DEFECT: locate src/api/auth/* → ambiguous while b-api-alt overlaps',
  loc3['src/api/auth/login.ts']?.status === 'ambiguous' && claimIdsOf('src/api/auth/login.ts').includes('b-api-alt'),
  'ambiguous incl b-api-alt', `${loc3['src/api/auth/login.ts']?.status} winner=${loc3['src/api/auth/login.ts']?.boundaryId} claimants=${JSON.stringify(claimIdsOf('src/api/auth/login.ts'))}`
)
rec.check(
  'DEFECT: locate src/api/users/* → ambiguous while b-api-alt overlaps',
  loc3['src/api/users/list.ts']?.status === 'ambiguous',
  'ambiguous', `${loc3['src/api/users/list.ts']?.status} winner=${loc3['src/api/users/list.ts']?.boundaryId} claimants=${JSON.stringify(claimIdsOf('src/api/users/list.ts'))}`
)
rec.artifact('locate.mv3.divergence', loc3)
rec.check('locate src/api/readme → ambiguous (b-api vs b-api-alt same-depth)', loc3['src/api/readme.md']?.status === 'ambiguous', 'ambiguous', `${loc3['src/api/readme.md']?.status} ${loc3['src/api/readme.md']?.boundaryId}`)
const rInspAuth = await w.dispatch(ctx, 'responsibility.inspect', { projectId, modelVersion: mv3, boundaryId: 'b-api-auth', perspective: 'coordination' })
const inspAuth = rInspAuth.result as { roles: { id: string }[]; nonGoals: { id: string }[]; contextRefs: string[] }
rec.check('inspect b-api-auth shows r-auth', (inspAuth?.roles ?? []).some((r) => r.id === 'r-auth'), 'r-auth', JSON.stringify(inspAuth?.roles))
rec.check('inspect b-api-auth carries remapped nonGoal+context', (inspAuth?.nonGoals ?? []).some((n) => n.id === 'ng-api-1') && (inspAuth?.contextRefs ?? []).includes('docs/security.md'), 'ng-api-1+security.md', JSON.stringify({ ng: inspAuth?.nonGoals, ctx: inspAuth?.contextRefs }))
// model-version rows: mv2 relational payload immutable history
// (model_versions.status legitimately moves published→superseded — the RDD
//  rows themselves must not be rewritten)
const stripMv = (d: Record<string, unknown>): Record<string, unknown> => {
  const { model_versions: _drop, ...rest } = d
  return rest
}
const mv2Final = dumpModelRows(db, mv2)
rec.check('mv2 RDD rows immutable after split publish', digestOf(stripMv(mv2Final)) === digestOf(stripMv(mv0rows)), 'same digest', `${digestOf(stripMv(mv2Final)).slice(0, 16)}`)
rec.check('mv2 status now superseded', q1(db, 'SELECT status AS s FROM model_versions WHERE id=?', mv2)?.s === 'superseded', 'superseded', String(q1(db, 'SELECT status AS s FROM model_versions WHERE id=?', mv2)?.s))
rec.check('mv3 row has parent_version=mv2 + published status', q1(db, 'SELECT parent_version AS p,status AS s FROM model_versions WHERE id=?', mv3)?.p === mv2 && q1(db, 'SELECT status AS s FROM model_versions WHERE id=?', mv3)?.s === 'published', 'parent+published', JSON.stringify(q1(db, 'SELECT parent_version,status FROM model_versions WHERE id=?', mv3)))

// ===================================== 2. boundary.reparent → mv4 =========
const pRep = await prepare(mv3, [{ type: 'boundary.reparent', boundaryId: 'b-lib', newParentId: 'b-docs' }])
rec.check('reparent: prepare committed', pRep.status === 'committed', 'committed', `${pRep.status} ${pRep.error?.code}`)
const prepRep = pRep.result!
rec.check(
  'reparent: touched scope covers moved boundary + old/new parent + subtree',
  hasTarget(prepRep.touchedTargets, 'boundary', 'b-lib') &&
    hasTarget(prepRep.touchedTargets, 'boundary', 'b-root') &&
    hasTarget(prepRep.touchedTargets, 'boundary', 'b-docs'),
  'b-lib+b-root+b-docs',
  JSON.stringify(prepRep.touchedTargets)
)
rec.check(
  'reparent: SUBTREE_MOVED review item emitted',
  (prepRep.semanticReviewItems ?? []).some((i) => i.code === 'SUBTREE_MOVED'),
  'SUBTREE_MOVED', JSON.stringify(prepRep.semanticReviewItems?.map((i) => i.code))
)
const cRep = await commit(prepRep.changeId, prepRep.candidateDigest, mv3, 'reparent b-lib under b-docs')
rec.check('reparent: commit committed', cRep.status === 'committed', 'committed', `${cRep.status} ${cRep.error?.code}`)
const mv4 = (cRep.result as CommitOut)?.publishedVersion
const edges4 = qa(db, 'SELECT child_id,parent_id FROM boundary_edges WHERE model_version=? AND child_id=?', mv4, 'b-lib')
rec.check('reparent edge applied: b-lib.parent=b-docs', edges4[0]?.parent_id === 'b-docs', 'b-docs', JSON.stringify(edges4))
// scope-boundary filter on b-docs now covers b-lib subtree → r-lib visible
// (scopeBoundaryId is a TOP-LEVEL request field and counts as a signal)
const rScope4 = await w.dispatch(ctx, 'responsibility.search', { projectId, modelVersion: mv4, scopeBoundaryId: 'b-docs' })
const scope4roles = ((rScope4.result as { items?: { role: { id: string } }[] })?.items ?? []).map((i) => i.role.id)
rec.check('scope=b-docs subtree now includes r-lib', rScope4.status === 'committed' && scope4roles.includes('r-lib'), 'r-lib in subtree', `${rScope4.status} ${JSON.stringify(scope4roles)} ${rScope4.error?.code ?? ''}`)
const rScope4neg = await w.dispatch(ctx, 'responsibility.search', { projectId, modelVersion: mv4, scopeBoundaryId: 'b-web' })
const scope4negRoles = ((rScope4neg.result as { items?: { role: { id: string } }[] })?.items ?? []).map((i) => i.role.id)
rec.check('scope=b-web excludes r-lib (outside subtree)', !scope4negRoles.includes('r-lib'), 'no r-lib', JSON.stringify(scope4negRoles))
const rLoc4 = await w.dispatch(ctx, 'responsibility.locate', { projectId, paths: ['src/lib/x.ts'] })
const loc4 = (rLoc4.result as { items: { path: string; status: string; boundaryId?: string }[] }).items[0]
rec.check('reparent keeps deepest owner: src/lib → b-lib', loc4?.status === 'resolved' && loc4.boundaryId === 'b-lib', 'b-lib', `${loc4?.status} ${loc4?.boundaryId}`)

// ===================================== 3. role.retire → mv5 ===============
const pRet = await prepare(mv4, [{ type: 'role.retire', roleId: 'r-alt' }])
rec.check('role.retire: prepare committed', pRet.status === 'committed', 'committed', `${pRet.status} ${pRet.error?.code}`)
const prepRet = pRet.result!
rec.check('role.retire: touched = role:r-alt', hasTarget(prepRet.touchedTargets, 'role', 'r-alt'), 'role:r-alt', JSON.stringify(prepRet.touchedTargets))
const cRet = await commit(prepRet.changeId, prepRet.candidateDigest, mv4, 'retire r-alt')
rec.check('role.retire: commit committed', cRet.status === 'committed', 'committed', `${cRet.status} ${cRet.error?.code}`)
const mv5 = (cRet.result as CommitOut)?.publishedVersion
const roles5 = qa(db, 'SELECT id FROM rdd_roles WHERE model_version=?', mv5).map((r) => r.id)
rec.check('mv5 drops r-alt, keeps boundary b-api-alt', !roles5.includes('r-alt') && qa(db, 'SELECT id FROM rdd_boundaries WHERE model_version=? AND id=?', mv5, 'b-api-alt').length === 1, 'r-alt gone,b-api-alt stays', JSON.stringify(roles5))
const rImplAlt5 = await w.dispatch(ctx, 'role.implementations', { modelVersion: mv5, roleId: 'r-alt' })
const implAlt5 = rImplAlt5.result as { status?: string } | undefined
rec.check('retired role: role.implementations not ok', rImplAlt5.status === 'rejected' || implAlt5?.status === 'implementation-missing' || implAlt5?.status === 'role-missing', 'rejected/missing', `${rImplAlt5.status} ${implAlt5?.status} ${rImplAlt5.error?.code}`)
const rInspAlt5 = await w.dispatch(ctx, 'responsibility.inspect', { projectId, modelVersion: mv5, boundaryId: 'b-api-alt', perspective: 'coordination' })
const inspAlt5 = rInspAlt5.result as { roles?: { id: string }[] } | undefined
rec.check('retired role absent from inspect', rInspAlt5.status === 'committed' && !(inspAlt5?.roles ?? []).some((r) => r.id === 'r-alt'), 'no r-alt', `${rInspAlt5.status} ${JSON.stringify(inspAlt5?.roles)}`)
// stale token replay against the new active run pins — model pin mismatch
const rStaleTok5 = await w.dispatch(provCtx(), 'assignment.preview', {
  runId: st.runId2 as string, selectionToken: tokByRole['r-alt'],
  implementationId: impls['r-alt']!.implId, implementationRevision: impls['r-alt']!.revision,
  assignmentKind: 'task', mandateText: 'post-retire token replay'
})
rec.check('retired-role token → rejected (stale pins)', rStaleTok5.status === 'rejected', 'rejected', `${rStaleTok5.status} ${rStaleTok5.error?.code} ${rStaleTok5.error?.message}`)

// ================= 4a. boundary.retire WITHOUT remap → refused ============
const pBadRet = await prepare(mv5, [{ type: 'boundary.retire', boundaryId: 'b-api-auth' }])
rec.check('retire-no-remap: prepare still committed (returns full picture)', pBadRet.status === 'committed', 'committed', `${pBadRet.status} ${pBadRet.error?.code}`)
const badCodes = (pBadRet.result?.structuralErrors ?? []).map((e) => e.code)
rec.check(
  'retire-no-remap: dangling FK errors reported (role+contract+nonGoal)',
  badCodes.includes('DANGLING_ROLE_BOUNDARY') && badCodes.includes('DANGLING_CONTRACT_PROVIDER') && badCodes.includes('DANGLING_NON_GOAL'),
  'DANGLING_* set', JSON.stringify(badCodes)
)
rec.artifact('retireNoRemap.structuralErrors', pBadRet.result?.structuralErrors)
const cBadRet = await commit(pBadRet.result!.changeId, pBadRet.result!.candidateDigest, mv5, 'retire-no-remap (must refuse)')
rec.check('retire-no-remap: commit refused MODEL_INVALID', cBadRet.status === 'rejected' && cBadRet.error?.code === 'MODEL_INVALID', 'rejected MODEL_INVALID', `${cBadRet.status} ${cBadRet.error?.code} ${cBadRet.error?.message}`)
rec.check('refused commit left active version at mv5', activeMv() === mv5, mv5, activeMv())

// ================= 4b. boundary.retire b-api-alt (clean) → mv6 ============
const pRetB = await prepare(mv5, [{ type: 'boundary.retire', boundaryId: 'b-api-alt' }])
rec.check('boundary.retire: prepare committed', pRetB.status === 'committed', 'committed', `${pRetB.status} ${pRetB.error?.code}`)
const prepRetB = pRetB.result!
rec.check('boundary.retire: touched = boundary:b-api-alt', hasTarget(prepRetB.touchedTargets, 'boundary', 'b-api-alt'), 'b-api-alt', JSON.stringify(prepRetB.touchedTargets))
const cRetB = await commit(prepRetB.changeId, prepRetB.candidateDigest, mv5, 'retire b-api-alt')
rec.check('boundary.retire: commit committed', cRetB.status === 'committed', 'committed', `${cRetB.status} ${cRetB.error?.code}`)
const mv6 = (cRetB.result as CommitOut)?.publishedVersion
const b6 = qa(db, 'SELECT id FROM rdd_boundaries WHERE model_version=?', mv6).map((b) => b.id)
rec.check('mv6 drops b-api-alt', !b6.includes('b-api-alt'), 'gone', JSON.stringify(b6))
const rLoc6 = await w.dispatch(ctx, 'responsibility.locate', { projectId, paths: ['src/api', 'src/api/auth/x.ts'] })
const loc6 = Object.fromEntries(((rLoc6.result as { items: { path: string; status: string; boundaryId?: string }[] })?.items ?? []).map((i) => [i.path, i]))
rec.check('ambiguity resolved after retire: src/api → resolved b-api', loc6['src/api']?.status === 'resolved' && loc6['src/api']?.boundaryId === 'b-api', 'resolved b-api', `${loc6['src/api']?.status} ${loc6['src/api']?.boundaryId}`)
rec.check('deepest claim still wins: src/api/auth → b-api-auth', loc6['src/api/auth/x.ts']?.boundaryId === 'b-api-auth', 'b-api-auth', String(loc6['src/api/auth/x.ts']?.boundaryId))

// ===================================== 5. invalid candidates ==============
// each: prepare commits a full diagnostic picture; commit MUST refuse.
const invalidCases: { name: string; edits: unknown[]; expectCodes: string[] }[] = [
  {
    name: 'reparent to missing parent → DANGLING_PARENT',
    edits: [{ type: 'boundary.reparent', boundaryId: 'b-web', newParentId: 'b-ghost' }],
    expectCodes: ['DANGLING_PARENT']
  },
  {
    name: 'second parentless root → MULTIPLE_ROOTS',
    edits: [{
      type: 'boundary.create',
      boundary: { id: 'b-rogue', name: 'rogue', responsibility: '두 번째 루트 시도', parentId: null, criteria: [{ criterion: 'c', description: 'd' }] }
    }],
    expectCodes: ['MULTIPLE_ROOTS']
  },
  {
    name: 'boundary without criteria → MISSING_CRITERION',
    edits: [{
      type: 'boundary.create',
      boundary: { id: 'b-nocrit', name: 'nocrit', responsibility: '기준 없는 경계', parentId: 'b-root' }
    }],
    expectCodes: ['MISSING_CRITERION']
  },
  {
    name: 'role.retire of missing role → edit diagnostic',
    edits: [{ type: 'role.retire', roleId: 'r-ghost' }],
    expectCodes: []
  },
  {
    name: 'contract without consumer → CONTRACT_WITHOUT_CONSUMER',
    edits: [{
      type: 'contract.bind',
      contract: { id: 'c-orphan', name: 'orphan', schemaPath: 'schemas/o.json', providerBoundaryId: 'b-web', consumerBoundaryIds: [] }
    }],
    expectCodes: ['CONTRACT_WITHOUT_CONSUMER']
  }
]
for (const caze of invalidCases) {
  const p = await prepare(mv6, caze.edits)
  const codes = (p.result?.structuralErrors ?? []).map((e) => e.code)
  const covers = caze.expectCodes.every((c) => codes.includes(c)) && codes.length > 0
  rec.check(`invalid: ${caze.name}`, p.status === 'committed' && covers, `errors ⊇ ${JSON.stringify(caze.expectCodes)}`, `${p.status} codes=${JSON.stringify(codes)}`)
  if (p.status === 'committed' && p.result) {
    const c = await commit(p.result.changeId, p.result.candidateDigest, mv6, `invalid: ${caze.name}`)
    rec.check(`invalid commit refused: ${caze.name}`, c.status === 'rejected' && c.error?.code === 'MODEL_INVALID', 'rejected MODEL_INVALID', `${c.status} ${c.error?.code}`)
  }
}

// --- cyclic reparent — SPEC expects a CONTAINS_CYCLE diagnostic + refused
// commit. OBSERVED: diffSnapshots.descendantsOf walks the cyclic parent map
// with NO visited set → RangeError escapes registry.dispatch as an uncaught
// exception (no rejected receipt at all). IMP-04 defect, captured here.
let cycleOutcome: string
let cycleArtifact: unknown = null
try {
  const pCyc = await prepare(mv6, [{ type: 'boundary.reparent', boundaryId: 'b-root', newParentId: 'b-web' }])
  const codes = (pCyc.result?.structuralErrors ?? []).map((e) => e.code)
  cycleOutcome = `receipt ${pCyc.status} codes=${JSON.stringify(codes)}`
  cycleArtifact = { status: pCyc.status, errors: pCyc.result?.structuralErrors, error: pCyc.error }
  if (pCyc.status === 'committed' && pCyc.result) {
    const cCyc = await commit(pCyc.result.changeId, pCyc.result.candidateDigest, mv6, 'cycle (must refuse)')
    cycleOutcome += ` commit=${cCyc.status}:${cCyc.error?.code}`
    cycleArtifact = { ...(cycleArtifact as object), commit: { status: cCyc.status, error: cCyc.error } }
  }
} catch (e) {
  cycleOutcome = `THREW ${(e as Error).name}: ${(e as Error).message}`
  cycleArtifact = { threw: true, name: (e as Error).name, message: (e as Error).message, stack: String((e as Error).stack).split('\n').slice(0, 6) }
}
rec.check(
  'DEFECT: cyclic reparent → clean CONTAINS_CYCLE refusal (no crash)',
  cycleOutcome.includes('CONTAINS_CYCLE') || (cycleOutcome.includes('rejected') && cycleOutcome.includes('MODEL_INVALID')),
  'CONTAINS_CYCLE diag + refused commit',
  cycleOutcome
)
rec.artifact('cycleReparent.outcome', cycleArtifact)
rec.check('runtime survives the cyclic crash (db still usable)', activeMv() === mv6, mv6, activeMv())
rec.check('active version still mv6 after refused candidates', activeMv() === mv6, mv6, activeMv())

// ===================================== 6. commit-time guards ==============
const pGoal = await prepare(mv6, [{ type: 'goal.revise', goal: 'VER-01 v7 — 구조 편집 후 갱신된 목표' }])
const prepGoal = pGoal.result!
const cWrongDigest = await commit(prepGoal.changeId, 'sha256:' + '0'.repeat(64), mv6, 'wrong digest')
rec.check('commit wrong candidateDigest → OPERATION_CONFLICT', cWrongDigest.status === 'rejected' && cWrongDigest.error?.code === 'OPERATION_CONFLICT', 'OPERATION_CONFLICT', `${cWrongDigest.status} ${cWrongDigest.error?.code} ${cWrongDigest.error?.message}`)
const cWrongBase = await commit(prepGoal.changeId, prepGoal.candidateDigest, 'mv_nonexistent', 'wrong expected base')
rec.check('commit wrong expectedActiveVersion → STALE_REVISION', cWrongBase.status === 'rejected' && cWrongBase.error?.code === 'STALE_REVISION', 'STALE_REVISION', `${cWrongBase.status} ${cWrongBase.error?.code}`)
const cGoal = await commit(prepGoal.changeId, prepGoal.candidateDigest, mv6, 'goal v7')
rec.check('valid commit succeeds after rejected attempts', cGoal.status === 'committed', 'committed', `${cGoal.status} ${cGoal.error?.code}`)
const mv7 = (cGoal.result as CommitOut)?.publishedVersion
const cAgain = await commit(prepGoal.changeId, prepGoal.candidateDigest, mv7, 're-commit')
rec.check('re-commit of consumed change → INVALID_TRANSITION', cAgain.status === 'rejected' && cAgain.error?.code === 'INVALID_TRANSITION', 'INVALID_TRANSITION', `${cAgain.status} ${cAgain.error?.code} ${cAgain.error?.message}`)
const ghost = await commit('mc_nonexistent', 'x', mv7, 'ghost change')
rec.check('commit unknown changeId → MODEL_INVALID', ghost.status === 'rejected' && ghost.error?.code === 'MODEL_INVALID', 'MODEL_INVALID', `${ghost.status} ${ghost.error?.code}`)

// --- published-version lineage + events ----------------------------------
const lineage = qa(db, 'SELECT id,parent_version,status FROM model_versions WHERE project_id=? ORDER BY created_at', projectId)
rec.check('superseded chain mv2→…→mv7 consistent', lineage.filter((v) => v.status === 'published').length === 1 && lineage.at(-1)!.id === mv7, 'single published tip', JSON.stringify(lineage.map((v) => `${String(v.id).slice(0, 14)}:${v.status}`)))
const pubEvents = qa(db, "SELECT COUNT(*) AS n FROM domain_events WHERE event_type='ModelPublished'")
rec.check('ModelPublished events emitted per commit', Number(pubEvents[0]!.n) >= 5, '>=5', String(pubEvents[0]!.n))
rec.artifact('lineage', lineage)

saveState({ mv3, mv4, mv5, mv6, mv7, activeMv: mv7 })
writeJson('s5-evidence.json', {
  mv3: dumpModelRows(db, mv3),
  mv6: dumpModelRows(db, mv6)
})
w.runtime.close()
db.close()
rec.flush({ processPid: process.pid })
console.log('s5 done')
