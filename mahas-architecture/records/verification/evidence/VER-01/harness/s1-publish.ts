// VER-01 step-1 — fixture + publish, process A.
// Builds the whole control-plane fixture through the REAL registry only:
//   project.create → model.change.prepare/commit (model v1, 6 boundaries /
//   7 roles / 1 contract / 3 contexts / 2 non-goals / 3 horizontal roles)
//   → interface.get ×6 → harness.profile.register/admit ×2
//   → implementation.prepare/publish ×5 → access.grant (provisioning)
//   → run.create.
// Then dumps the SQLite-side rows that the reopen process (s2) must see.
import {
  Recorder, wire, opCtx, saveState, loadState, dumpModelRows, digestOf,
  writeJson, qa, q1, cnt, REPO_ROOT
} from './common.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const rec = new Recorder('s1-publish')
const w = await wire('s1')
const { db } = w
const ctx = opCtx()

// a repo tree the path claims point at (real dirs so structural path checks
// that probe the fs — if any — have something to see)
for (const d of ['src/api/auth', 'src/api/users', 'src/web', 'src/lib', 'docs', 'contracts'])
  mkdirSync(join(REPO_ROOT, d), { recursive: true })
for (const f of ['src/api/auth/login.ts', 'src/web/app.tsx', 'src/lib/util.ts',
  'docs/security.md', 'docs/ui-guide.md', 'docs/backend-guide.md',
  'contracts/user-api.schema.json'])
  writeFileSync(join(REPO_ROOT, f), `// VER-01 fixture file ${f}\n`)

// ---------------------------------------------------------------
// 1. project.create
// ---------------------------------------------------------------
const rCreate = await w.dispatch(ctx, 'project.create', {
  name: 'ver01-product',
  repositoryRoot: REPO_ROOT,
  goal: 'VER-01 fixture product — 인증 API와 웹 클라이언트를 갖는다'
})
rec.check('project.create committed', rCreate.status === 'committed', 'committed', rCreate.status)
const proj = rCreate.result as { projectId: string; draftModelVersion: string; registrationState: string }
const projectId = proj.projectId
const mv0 = proj.draftModelVersion
rec.check('project root verified', proj.registrationState === 'registered', 'registered', proj.registrationState)

// ---------------------------------------------------------------
// 2. model.change.prepare — the full v1 model in one change unit
// ---------------------------------------------------------------
const editsV1: unknown[] = [
  { type: 'horizontalRole.revise', name: 'coordinator' },
  { type: 'horizontalRole.revise', name: 'backend', addContextIds: ['ctx-backend-guide'] },
  { type: 'horizontalRole.revise', name: 'frontend' },
  { type: 'context.register', context: { id: 'ctx-security', path: 'docs/security.md' } },
  { type: 'context.register', context: { id: 'ctx-ui-guide', path: 'docs/ui-guide.md' } },
  { type: 'context.register', context: { id: 'ctx-backend-guide', path: 'docs/backend-guide.md' } },
  {
    type: 'boundary.create',
    boundary: {
      id: 'b-root', name: 'product-root',
      responsibility: '제품 전체 책임 — 하위 경계 조정과 전체 목표 달성',
      parentId: null,
      paths: [{ path: 'src', kind: 'directory' }],
      criteria: [
        { id: 'crit-root-1', criterion: '모든 하위 경계가 자신의 책임을 충족한다', description: 'root coordination criterion' }
      ]
    }
  },
  {
    type: 'boundary.create',
    boundary: {
      id: 'b-api', name: 'api',
      responsibility: 'API 서버 — 인증 토큰 검증과 사용자 관리 API 제공',
      parentId: 'b-root',
      paths: [{ path: 'src/api', kind: 'directory' }],
      criteria: [
        { id: 'crit-api-1', criterion: 'API 응답은 계약 스키마를 만족한다', description: 'schema conformance' },
        { id: 'crit-api-2', criterion: '인증 실패는 401과 감사 로그를 남긴다', description: 'auth audit' }
      ],
      contextIds: ['ctx-security']
    }
  },
  {
    type: 'boundary.create',
    boundary: {
      id: 'b-web', name: 'web',
      responsibility: '웹 클라이언트 — 사용자 인터페이스 렌더링과 상호작용',
      parentId: 'b-root',
      paths: [{ path: 'src/web', kind: 'directory' }],
      criteria: [
        { id: 'crit-web-1', criterion: 'UI는 계약된 API만 호출한다', description: 'contract-only calls' }
      ],
      contextIds: ['ctx-ui-guide']
    }
  },
  {
    type: 'boundary.create',
    boundary: {
      id: 'b-api-alt', name: 'api-alt',
      responsibility: 'API 대체 구현 후보 — 같은 영역을 중첩 선언한다 (ambiguity fixture)',
      parentId: 'b-root',
      paths: [{ path: 'src/api', kind: 'directory' }],
      criteria: [
        { id: 'crit-alt-1', criterion: '대체 구현은 기존 계약을 유지한다', description: 'keep contract' }
      ]
    }
  },
  {
    type: 'boundary.create',
    boundary: {
      id: 'b-docs', name: 'docs',
      responsibility: '문서 영역 — 사용자 문서와 개발 가이드',
      parentId: 'b-root',
      paths: [{ path: 'docs', kind: 'directory' }],
      criteria: [
        { id: 'crit-docs-1', criterion: '문서는 현재 모델과 일치한다', description: 'docs freshness' }
      ]
    }
  },
  {
    type: 'boundary.create',
    boundary: {
      id: 'b-lib', name: 'lib',
      responsibility: '공유 라이브러리 — 도메인 무관 유틸리티',
      parentId: 'b-root',
      paths: [{ path: 'src/lib', kind: 'directory' }],
      criteria: [
        { id: 'crit-lib-1', criterion: '라이브러리는 도메인 의존을 갖지 않는다', description: 'no domain dep' }
      ]
    }
  },
  {
    type: 'contract.bind',
    contract: {
      id: 'c-user-api', name: 'user-api-contract',
      schemaPath: 'contracts/user-api.schema.json',
      providerBoundaryId: 'b-api',
      consumerBoundaryIds: ['b-web']
    }
  },
  {
    type: 'role.define',
    role: {
      id: 'r-lead', name: 'coordination-leader',
      description: 'run의 조정 리더 — 책임 검색·팀 배정·계획 수립을 수행한다',
      boundaryId: 'b-root', horizontalRoleName: 'coordinator'
    }
  },
  {
    type: 'role.define',
    role: {
      id: 'r-auth', name: '인증 엔지니어',
      description: '인증 토큰 검증·갱신·세션 관리를 담당한다',
      boundaryId: 'b-api', horizontalRoleName: 'backend'
    }
  },
  {
    type: 'role.define',
    role: {
      id: 'r-users', name: 'user-admin',
      description: '사용자 계정 CRUD와 프로필 API를 담당한다',
      boundaryId: 'b-api', horizontalRoleName: 'backend'
    }
  },
  {
    type: 'role.define',
    role: {
      id: 'r-web', name: 'ui-engineer',
      description: 'UI 렌더링과 상태 관리를 담당한다',
      boundaryId: 'b-web', horizontalRoleName: 'frontend'
    }
  },
  {
    type: 'role.define',
    role: {
      id: 'r-alt', name: 'alt-api-engineer',
      description: 'overlapping api boundary engineer (ambiguity fixture)',
      boundaryId: 'b-api-alt', horizontalRoleName: 'backend'
    }
  },
  {
    type: 'role.define',
    role: {
      id: 'r-lib', name: 'lib-maintainer',
      description: 'shared libraries maintenance',
      boundaryId: 'b-lib', horizontalRoleName: 'backend'
    }
  },
  {
    type: 'nonGoal.revise',
    nonGoal: { id: 'ng-api-1', boundaryId: 'b-api', statement: 'API 경계는 UI 렌더링과 배포 파이프라인을 담당하지 않는다' }
  },
  {
    type: 'nonGoal.revise',
    nonGoal: { id: 'ng-web-1', boundaryId: 'b-web', statement: '웹 경계는 서버 측 인증 로직을 소유하지 않는다' }
  }
]

const rPrep = await w.dispatch(ctx, 'model.change.prepare', {
  projectId, baseVersion: mv0, edits: editsV1
})
rec.check('model.change.prepare committed', rPrep.status === 'committed', 'committed', rPrep.status)
const prep = rPrep.result as {
  changeId: string; candidateDigest: string
  touchedTargets: { kind: string; id: string }[]
  structuralErrors: { code: string }[]
  semanticReviewItems: { code: string }[]
}
rec.check(
  'v1 prepare has no structural errors',
  (prep.structuralErrors ?? []).length === 0,
  '[]',
  JSON.stringify(prep.structuralErrors)
)
rec.artifact('v1.touchedTargets', prep.touchedTargets)
rec.artifact('v1.reviewItems', prep.semanticReviewItems)

// ---------------------------------------------------------------
// 3. model.change.commit — publish v1
// ---------------------------------------------------------------
const rCommit = await w.dispatch(ctx, 'model.change.commit', {
  changeId: prep.changeId,
  candidateDigest: prep.candidateDigest,
  expectedActiveVersion: null,
  semanticDecision: 'VER-01 v1 publish — fixture model, all rows reviewed'
})
rec.check('model.change.commit committed', rCommit.status === 'committed', 'committed', rCommit.status)
const commit = rCommit.result as Record<string, unknown>
rec.artifact('v1.commitResult', commit)

const rGet = await w.dispatch(ctx, 'project.get', { projectId })
const projectAfter = rGet.result as { activeModelVersion: string; revision: number }
const mv1 = projectAfter.activeModelVersion
rec.check('project.activeModelVersion = published v1', typeof mv1 === 'string' && mv1 !== mv0, 'mv≠draft', String(mv1))

// ---------------------------------------------------------------
// 4. interface.get for every role → interface digests
// ---------------------------------------------------------------
const roleIds = ['r-lead', 'r-auth', 'r-users', 'r-web', 'r-alt', 'r-lib']
const ifaceDigest: Record<string, string> = {}
const ifaceClauses: Record<string, string[]> = {}
for (const roleId of roleIds) {
  const r = await w.dispatch(ctx, 'interface.get', { modelVersion: mv1, roleId })
  rec.check(`interface.get ${roleId} committed`, r.status === 'committed', 'committed', r.status)
  const res = r.result as { digest: string; contextRequirements: { clauseId: string }[] }
  ifaceDigest[roleId] = res.digest
  ifaceClauses[roleId] = res.contextRequirements.map((x) => x.clauseId)
}
rec.artifact('ifaceDigests', ifaceDigest)
rec.artifact('ifaceClauses', ifaceClauses)

// ---------------------------------------------------------------
// 5. harness profiles: hp-main (verified), hp-doc (documented)
// ---------------------------------------------------------------
const execIdent = { locator: '/usr/bin/mahas-fake-harness', versionRange: '>=1.0.0 <2.0.0' }
const rProf = await w.dispatch(ctx, 'harness.profile.register', {
  profileId: 'hp-main',
  executableLocator: execIdent.locator,
  versionRange: execIdent.versionRange,
  supportedComponents: ['instruction', 'skill', 'subagent', 'tool-config', 'launch-config'],
  injectionRecipe: { routes: ['instruction-file', 'confirmed-preload'] }
})
rec.check('hp-main register committed', rProf.status === 'committed', 'committed', rProf.status)
const rAdmit = await w.dispatch(ctx, 'harness.profile.admit', {
  profileId: 'hp-main', profileRevision: 1,
  attestation: {
    decision: 'verified',
    evidence: [{ kind: 'test-launch', summary: 'VER-01 fixture: harness launched in verification run' }]
  },
  expectedExecutableIdentity: execIdent
})
rec.check('hp-main admit committed', rAdmit.status === 'committed', 'committed', rAdmit.status)
const hpMainRev = (rAdmit.result as { revision: number; admissionState: string }).revision
rec.check('hp-main admissionState=verified', (rAdmit.result as { admissionState: string }).admissionState === 'verified', 'verified', (rAdmit.result as { admissionState: string }).admissionState)

const rProf2 = await w.dispatch(ctx, 'harness.profile.register', {
  profileId: 'hp-doc',
  executableLocator: '/usr/bin/mahas-doc-harness',
  versionRange: '>=1.0.0',
  supportedComponents: ['instruction'],
  injectionRecipe: { routes: ['instruction-text'] }
})
const rAdmit2 = await w.dispatch(ctx, 'harness.profile.admit', {
  profileId: 'hp-doc', profileRevision: 1,
  attestation: {
    decision: 'documented',
    evidence: [{ kind: 'documentation', summary: 'VER-01 fixture: documented-only profile' }]
  },
  expectedExecutableIdentity: { locator: '/usr/bin/mahas-doc-harness', versionRange: '>=1.0.0' }
})
rec.check('hp-doc admissionState=documented', (rAdmit2.result as { admissionState: string }).admissionState === 'documented', 'documented', (rAdmit2.result as { admissionState: string }).admissionState)
const hpDocRev = (rAdmit2.result as { revision: number }).revision

// ---------------------------------------------------------------
// 6. implementation.prepare + publish
//    r-lead/r-auth/r-web/r-alt on hp-main@rev2 (verified)
//    r-users on hp-doc@rev2 (documented)
//    r-lib gets NO implementation (implementation-missing fixture)
// ---------------------------------------------------------------
async function publishImpl(
  implId: string, roleId: string, profileId: string, profileRev: number, extraSkill: boolean
): Promise<{ implId: string; revision: number } | null> {
  const clauses = ifaceClauses[roleId]!
  const components: unknown[] = [
    {
      componentId: 'comp-core', kind: 'instruction',
      contentBinding: { text: `VER-01 fixture instruction for ${roleId}` },
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
    profileId, profileRevision: profileRev,
    maintainerRoleId: 'r-lead',
    componentGraph: { components },
    coverageBindings
  })
  rec.check(`implementation.prepare ${roleId} committed`, prepR.status === 'committed', 'committed', prepR.status)
  if (prepR.status !== 'committed') return null
  const pr = prepR.result as {
    candidateImplementation: { implementationId: string; revision: number }
    digest: string; uncoveredClauses: string[]
  }
  rec.check(
    `impl ${roleId} coverage complete`,
    pr.uncoveredClauses.length === 0, '[]', JSON.stringify(pr.uncoveredClauses)
  )
  const pubR = await w.dispatch(ctx, 'implementation.publish', {
    candidateId: pr.candidateImplementation.implementationId,
    candidateDigest: pr.digest,
    expectedInterfaceDigest: ifaceDigest[roleId],
    semanticDecision: { statement: `VER-01 fixture: ${roleId} covers its derived interface` }
  })
  rec.check(`implementation.publish ${roleId} committed`, pubR.status === 'committed', 'committed', pubR.status)
  if (pubR.status !== 'committed') return null
  const pub = pubR.result as { implementationId: string; revision: number }
  return { implId: pub.implementationId, revision: pub.revision }
}

const impls: Record<string, { implId: string; revision: number }> = {}
for (const [roleId, skill] of [['r-lead', true], ['r-auth', true], ['r-web', false], ['r-alt', false]] as const) {
  const r = await publishImpl(`impl-${roleId}`, roleId, 'hp-main', hpMainRev, skill)
  if (r) impls[roleId] = r
}
const rUsers = await publishImpl('impl-r-users', 'r-users', 'hp-doc', hpDocRev, false)
if (rUsers) impls['r-users'] = rUsers
rec.artifact('implementations', impls)

// ---------------------------------------------------------------
// 7. run.create on mv1 (purpose work)
// ---------------------------------------------------------------
const rRun = await w.dispatch(ctx, 'run.create', {
  projectId, modelVersion: mv1,
  goalText: 'VER-01 run-1 — fixture run on model v1',
  coordinatorRoleId: 'r-lead', purpose: 'work'
})
rec.check('run.create committed', rRun.status === 'committed', 'committed', rRun.status)
const run1 = (rRun.result as { runId?: string; id?: string })
const runId1 = (run1.runId ?? run1.id) as string
rec.artifact('run1.result', rRun.result)

// ---------------------------------------------------------------
// 8. provisioning grant to operator-local (project-scoped placement)
// ---------------------------------------------------------------
const rProv = await w.dispatch(ctx, 'access.grant', {
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
  actions: ['team.assign', 'assignment.preview']
})
rec.check('provisioning grant committed', rProv.status === 'committed', 'committed', rProv.status)
const provAll = (rProv.result as { grantId: string; revision: number })
rec.artifact('provGrant', rProv.result)

// a second provisioning grant restricted to r-lead only — the
// role-allowlist check is exercised against it in s6
const rProvR = await w.dispatch(ctx, 'access.grant', {
  kind: 'provisioning',
  subject: { principalId: 'operator-local' },
  scope: {
    targets: [{ kind: 'project', id: projectId }],
    provisioning: { allowedRoleIds: ['r-lead'], placementScope: [{ kind: 'project', id: projectId }] }
  },
  actions: ['team.assign', 'assignment.preview']
})
rec.check('restricted provisioning grant committed', rProvR.status === 'committed', 'committed', rProvR.status)
const provRestricted = (rProvR.result as { grantId: string; revision: number })

// ---------------------------------------------------------------
// 9. SQLite-side evidence dump (what s2 must reproduce in a new process)
// ---------------------------------------------------------------
const dump = dumpModelRows(db, mv1)
const ev = {
  projectRow: q1(db, 'SELECT * FROM projects WHERE id=?', projectId),
  modelVersions: qa(db, 'SELECT id,status,parent_version,digest FROM model_versions WHERE project_id=?', projectId),
  rows: dump,
  rowDigest: digestOf(dump),
  counts: {
    rdd_boundaries: cnt(db, 'rdd_boundaries', 'WHERE model_version=?', mv1),
    rdd_roles: cnt(db, 'rdd_roles', 'WHERE model_version=?', mv1),
    rdd_contracts: cnt(db, 'rdd_contracts', 'WHERE model_version=?', mv1),
    rdd_contexts: cnt(db, 'rdd_contexts', 'WHERE model_version=?', mv1),
    rdd_criteria: cnt(db, 'rdd_criteria', 'WHERE model_version=?', mv1),
    boundary_paths: cnt(db, 'boundary_paths', 'WHERE model_version=?', mv1),
    boundary_edges: cnt(db, 'boundary_edges', 'WHERE model_version=?', mv1),
    rdd_non_goals: cnt(db, 'rdd_non_goals', 'WHERE model_version=?', mv1),
    role_search_rows: cnt(db, 'role_search_rows', 'WHERE model_version=?', mv1),
    role_interfaces: cnt(db, 'role_interfaces'),
    role_implementations: cnt(db, 'role_implementations'),
    harness_profiles: cnt(db, 'harness_profiles'),
    support_attestations: cnt(db, 'support_attestations'),
    grants: cnt(db, 'grants'),
    runs: cnt(db, 'runs'),
    domain_events: cnt(db, 'domain_events'),
    operation_receipts: cnt(db, 'operation_receipts')
  },
  modelPublishedEvents: qa(db, "SELECT sequence,aggregate_id,event_type FROM domain_events WHERE event_type='ModelPublished'"),
  receipts: qa(db, 'SELECT principal_scope,operation,operation_id,status FROM operation_receipts ORDER BY rowid')
}
rec.check('v1 boundary count = 6', ev.counts.rdd_boundaries === 6, '6', String(ev.counts.rdd_boundaries))
rec.check('v1 role count = 6', ev.counts.rdd_roles === 6, '6', String(ev.counts.rdd_roles))
rec.check('v1 contract count = 1', ev.counts.rdd_contracts === 1, '1', String(ev.counts.rdd_contracts))
rec.check('v1 context count = 3', ev.counts.rdd_contexts === 3, '3', String(ev.counts.rdd_contexts))
rec.check('v1 non-goal count = 2', ev.counts.rdd_non_goals === 2, '2', String(ev.counts.rdd_non_goals))
rec.check('v1 search projection rows ≥ roles', ev.counts.role_search_rows >= 6, '>=6', String(ev.counts.role_search_rows))
rec.check('ModelPublished event present', ev.modelPublishedEvents.length === 1, '1', String(ev.modelPublishedEvents.length))
rec.check('operation receipts persisted (mutations)', ev.counts.operation_receipts >= 10, '>=10', String(ev.counts.operation_receipts))
writeJson('s1-evidence.json', ev)

saveState({
  projectId, mv0, mv1, runId1,
  ifaceDigest, impls,
  hpMainRev, hpDocRev,
  provAll, provRestricted,
  roleIds
})

w.runtime.close()
db.close()
rec.flush({ processPid: process.pid })
console.log('s1 done')
