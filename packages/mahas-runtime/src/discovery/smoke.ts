// mahas-runtime/src/discovery/smoke.ts — dev smoke harness for IMP-06.
//
// Seeds a minimal schema-v1 model in :memory: and exercises all five
// operations end to end with scoped fake deps (peer boundaries IMP-10/11
// are in flight — the fakes stand exactly where DiscoveryDeps puts the
// real authorize/decide). Run: `node packages/mahas-runtime/src/discovery/smoke.ts`.
// This file is a verification harness, not wired into the registry.

import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import type { DiscoveryDeps } from './deps.ts'
import type { DiscoveryTarget } from './types.ts'
import { responsibilitySearch } from './search.ts'
import { responsibilityInspect } from './inspect.ts'
import { responsibilityLocate } from './locate.ts'
import { responsibilityCollaborators } from './collaborators.ts'
import { roleImplementations } from './implementation-availability.ts'
import { verifySelectionToken, readSelectionTokenUnsafe } from './selection-token.ts'
import { isMahasError } from './types.ts'
import type { SearchResult, LocateResult } from './types.ts'

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

const DDL = `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL,
  repository_root TEXT NOT NULL, active_model_version TEXT, revision INTEGER NOT NULL);
CREATE TABLE model_versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  parent_version TEXT, root_boundary_id TEXT, goal_snapshot TEXT NOT NULL,
  status TEXT NOT NULL, digest TEXT, created_at INTEGER NOT NULL);
CREATE TABLE rdd_boundaries (model_version TEXT NOT NULL, id TEXT NOT NULL,
  name TEXT NOT NULL, responsibility_statement TEXT NOT NULL,
  PRIMARY KEY(model_version,id));
CREATE TABLE rdd_criteria (model_version TEXT NOT NULL, boundary_id TEXT NOT NULL,
  id TEXT NOT NULL, criterion TEXT NOT NULL, description TEXT NOT NULL,
  ordinal INTEGER NOT NULL, PRIMARY KEY(model_version,boundary_id,id));
CREATE TABLE boundary_paths (model_version TEXT NOT NULL, boundary_id TEXT NOT NULL,
  path TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(model_version,boundary_id,path));
CREATE TABLE boundary_edges (model_version TEXT NOT NULL, child_id TEXT NOT NULL,
  parent_id TEXT NOT NULL, PRIMARY KEY(model_version,child_id));
CREATE TABLE horizontal_roles (model_version TEXT NOT NULL, name TEXT NOT NULL,
  PRIMARY KEY(model_version,name));
CREATE TABLE rdd_roles (model_version TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT NOT NULL, boundary_id TEXT NOT NULL, horizontal_role_name TEXT NOT NULL,
  PRIMARY KEY(model_version,id));
CREATE TABLE rdd_contexts (model_version TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL,
  PRIMARY KEY(model_version,id));
CREATE TABLE boundary_contexts (model_version TEXT NOT NULL, boundary_id TEXT NOT NULL,
  context_id TEXT NOT NULL, PRIMARY KEY(model_version,boundary_id,context_id));
CREATE TABLE rdd_contracts (model_version TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
  schema_path TEXT NOT NULL, provider_boundary_id TEXT NOT NULL, PRIMARY KEY(model_version,id));
CREATE TABLE contract_consumers (model_version TEXT NOT NULL, contract_id TEXT NOT NULL,
  consumer_boundary_id TEXT NOT NULL, PRIMARY KEY(model_version,contract_id,consumer_boundary_id));
CREATE TABLE rdd_non_goals (model_version TEXT NOT NULL, id TEXT NOT NULL,
  boundary_id TEXT NOT NULL, statement TEXT NOT NULL, PRIMARY KEY(model_version,id));
CREATE TABLE role_search_rows (model_version TEXT NOT NULL, role_id TEXT NOT NULL,
  normalized_text TEXT NOT NULL, PRIMARY KEY(model_version,role_id));
CREATE VIRTUAL TABLE role_search_fts USING fts5(
  model_version UNINDEXED, role_id UNINDEXED, normalized_text, tokenize='unicode61');
CREATE TABLE role_interfaces (digest TEXT PRIMARY KEY, model_version TEXT NOT NULL,
  role_id TEXT NOT NULL, requirements_json TEXT NOT NULL, judgment_scope_json TEXT NOT NULL);
CREATE TABLE harness_profiles (id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL,
  recipe_json TEXT NOT NULL, capabilities_json TEXT NOT NULL, executable_identity_json TEXT NOT NULL,
  PRIMARY KEY(id,revision));
CREATE TABLE role_implementations (id TEXT NOT NULL, revision INTEGER NOT NULL,
  interface_digest TEXT NOT NULL, profile_id TEXT NOT NULL, profile_revision INTEGER NOT NULL,
  status TEXT NOT NULL, maintainer_role_id TEXT NOT NULL, semantic_decision TEXT,
  PRIMARY KEY(id,revision));
CREATE TABLE implementation_components (implementation_id TEXT NOT NULL,
  implementation_revision INTEGER NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
  activation TEXT NOT NULL, binding_json TEXT NOT NULL, consumes_json TEXT NOT NULL,
  coverage_json TEXT NOT NULL, PRIMARY KEY(implementation_id,implementation_revision,id));
CREATE TABLE support_attestations (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL, decision TEXT NOT NULL, installation_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL);
CREATE TABLE principals (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, model_version TEXT NOT NULL,
  goal_text TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'work',
  coordinator_member_id TEXT, state TEXT NOT NULL, current_plan_revision INTEGER,
  revision INTEGER NOT NULL);
CREATE TABLE members (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, model_version TEXT NOT NULL,
  role_id TEXT NOT NULL, implementation_id TEXT NOT NULL, implementation_revision INTEGER NOT NULL,
  generation INTEGER NOT NULL, current_execution_id TEXT, state TEXT NOT NULL, revision INTEGER NOT NULL);
CREATE TABLE assignments (id TEXT NOT NULL, revision INTEGER NOT NULL, member_id TEXT NOT NULL,
  kind TEXT NOT NULL, mandate_text TEXT NOT NULL, grant_id TEXT NOT NULL, task_id TEXT,
  task_revision INTEGER, scope_json TEXT NOT NULL, PRIMARY KEY(id,revision));
CREATE TABLE domain_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate_id TEXT NOT NULL, aggregate_revision INTEGER NOT NULL, event_type TEXT NOT NULL,
  scope_json TEXT NOT NULL, payload_json TEXT NOT NULL);
`

function seed(db: DatabaseSync): void {
  db.exec(DDL)
  const ins = (sql: string, ...args: (string | number | null)[]): StatementResultingChanges =>
    db.prepare(sql).run(...args)

  ins(`INSERT INTO projects VALUES ('p1','mahas','goal','/repo','mv1',1)`)
  ins(`INSERT INTO model_versions VALUES ('mv1','p1',NULL,'b-root','goal','published','dig1',1)`)

  // tree: b-root → {b-auth, b-web}; b-store is a second root-level branch
  const b = (id: string, name: string, resp: string): StatementResultingChanges =>
    ins(`INSERT INTO rdd_boundaries VALUES ('mv1',?,?,?)`, id, name, resp)
  b('b-root', 'app', '전체 앱 책임')
  b('b-auth', 'auth', '인증 책임 — 로그인과 세션을 소유한다')
  b('b-web', 'web', '웹 UI 책임')
  b('b-store', 'store', '저장소 책임')
  b('b-shared-a', 'shared-a', '공유 유틸 A')
  b('b-shared-b', 'shared-b', '공유 유틸 B')
  b('b-empty', 'empty', '역할 없는 영토')

  const crit = (
    bId: string,
    id: string,
    c: string,
    d: string,
    o: number
  ): StatementResultingChanges =>
    ins(`INSERT INTO rdd_criteria VALUES ('mv1',?,?,?,?,?)`, bId, id, c, d, o)
  crit('b-root', 'cr1', '모든 책임이 배정된다', 'coverage', 1)
  crit('b-auth', 'cr1', '로그인 성공', '로그인 플로우가 동작한다', 1)
  crit('b-web', 'cr1', '렌더링', '화면이 그려진다', 1)
  crit('b-store', 'cr1', '내구성', '데이터가 보존된다', 1)

  const bp = (bId: string, path: string, kind: string): StatementResultingChanges =>
    ins(`INSERT INTO boundary_paths VALUES ('mv1',?,?,?)`, bId, path, kind)
  bp('b-root', 'src', 'directory')
  bp('b-auth', 'src/auth', 'directory')
  bp('b-web', 'src/web', 'directory')
  bp('b-store', 'src/store', 'directory')
  bp('b-shared-a', 'src/shared/util-a.ts', 'file')
  bp('b-shared-a', 'src/shared', 'directory')
  bp('b-shared-b', 'src/shared', 'directory')
  bp('b-empty', 'src/empty', 'directory')

  const edge = (child: string, parent: string): StatementResultingChanges =>
    ins(`INSERT INTO boundary_edges VALUES ('mv1',?,?)`, child, parent)
  edge('b-auth', 'b-root')
  edge('b-web', 'b-root')
  edge('b-store', 'b-root')
  edge('b-shared-a', 'b-store')
  edge('b-shared-b', 'b-store')
  edge('b-empty', 'b-root')

  ins(`INSERT INTO horizontal_roles VALUES ('mv1','implementer')`)
  ins(`INSERT INTO horizontal_roles VALUES ('mv1','coordinator')`)

  const role = (
    id: string,
    name: string,
    desc: string,
    bId: string,
    hr: string
  ): StatementResultingChanges =>
    ins(`INSERT INTO rdd_roles VALUES ('mv1',?,?,?,?,?)`, id, name, desc, bId, hr)
  role('r-lead', 'team-lead', '전체 조율 책무', 'b-root', 'coordinator')
  role('r-auth', 'auth-dev', '인증 구현 책무 — 로그인/세션 코드를 담당', 'b-auth', 'implementer')
  role('r-web', 'web-dev', '웹 구현 책무', 'b-web', 'implementer')
  role('r-store', 'store-dev', '저장소 구현 책무', 'b-store', 'implementer')
  role('r-sa', 'util-a-dev', '유틸 A 책무', 'b-shared-a', 'implementer')
  role('r-sb', 'util-b-dev', '유틸 B 책무', 'b-shared-b', 'implementer')

  // search projection (IMP-05's write side, seeded directly for the smoke)
  const sr = (roleId: string, text: string): void => {
    ins(`INSERT INTO role_search_rows VALUES ('mv1',?,?)`, roleId, text)
    ins(
      `INSERT INTO role_search_fts (model_version, role_id, normalized_text) VALUES ('mv1',?,?)`,
      roleId,
      text
    )
  }
  sr('r-lead', 'team-lead 전체 조율 책무 app 전체 앱 책임')
  sr('r-auth', 'auth-dev 인증 구현 책무 로그인 세션 auth 인증 책임 로그인 성공')
  sr('r-web', 'web-dev 웹 구현 책무 web 웹 ui 책임 렌더링')
  sr('r-store', 'store-dev 저장소 구현 책무 store 저장소 책임 내구성')
  sr('r-sa', 'util-a-dev 유틸 a 책무 shared-a 공유 유틸 a')
  sr('r-sb', 'util-b-dev 유틸 b 책무 shared-b 공유 유틸 b')

  // contexts — refs only
  ins(`INSERT INTO rdd_contexts VALUES ('mv1','ctx1','docs/auth-notes.md')`)
  ins(`INSERT INTO boundary_contexts VALUES ('mv1','b-auth','ctx1')`)

  // contracts: c-session provided by auth, consumed by web + store
  ins(
    `INSERT INTO rdd_contracts VALUES ('mv1','c-session','session-api','contracts/session.json','b-auth')`
  )
  ins(`INSERT INTO contract_consumers VALUES ('mv1','c-session','b-web')`)
  ins(`INSERT INTO contract_consumers VALUES ('mv1','c-session','b-store')`)

  ins(`INSERT INTO rdd_non_goals VALUES ('mv1','ng1','b-auth','소셜 로그인은 이번 범위 아님')`)

  // interfaces — r-lead has a coordination-perspective clause (the authored view)
  ins(
    `INSERT INTO role_interfaces VALUES ('if-lead','mv1','r-lead',?, '{}')`,
    JSON.stringify([
      {
        clauseId: 'cl-1',
        criterionRef: 'b-auth/cr1',
        requiredMeaning: '인증 하위 책임의 상태를 조율 해상도로 읽는다',
        deliveryClass: 'conditional',
        readerPerspective: 'coordination'
      },
      {
        clauseId: 'cl-2',
        contextId: 'ctx1',
        requiredMeaning: '구현자 전용 상세',
        deliveryClass: 'initial',
        readerPerspective: 'owner'
      }
    ])
  )
  ins(`INSERT INTO role_interfaces VALUES ('if-auth','mv1','r-auth','[]','{}')`)

  // harness profiles + implementations
  ins(
    `INSERT INTO harness_profiles VALUES ('devin','1','verified','{}','{"supportedComponents":["instruction","skill"]}','{}')`
  )
  ins(
    `INSERT INTO harness_profiles VALUES ('claude','2','documented','{}','{"supportedComponents":["instruction","skill","subagent"]}','{}')`
  )
  ins(
    `INSERT INTO role_implementations VALUES ('impl-a1','3','if-auth','devin','1','published','r-lead',NULL)`
  )
  ins(
    `INSERT INTO role_implementations VALUES ('impl-a2','1','if-auth','claude','2','published','r-lead',NULL)`
  )
  ins(
    `INSERT INTO role_implementations VALUES ('impl-old','1','if-auth','devin','1','retired','r-lead',NULL)`
  )
  ins(
    `INSERT INTO implementation_components VALUES ('impl-a1','3','c1','instruction','initial','{}','[]','[]')`
  )
  ins(
    `INSERT INTO implementation_components VALUES ('impl-a1','3','c2','skill','conditional','{}','[]','[]')`
  )
  ins(
    `INSERT INTO implementation_components VALUES ('impl-a2','1','c1','subagent','initial','{}','[]','[]')`
  )
  ins(
    `INSERT INTO support_attestations VALUES ('att1','devin','1','verified','{"hostId":"h1"}','{}')`
  )

  // run + member for r-auth
  ins(`INSERT INTO runs VALUES ('run1','p1','mv1','goal','work',NULL,'active',NULL,1)`)
  ins(`INSERT INTO members VALUES ('m1','run1','mv1','r-auth','impl-a1','3','1',NULL,'active',1)`)
  ins(
    `INSERT INTO assignments VALUES ('as1','1','m1','coordination','mandate','g1',NULL,NULL,'{}')`
  )

  ins(`INSERT INTO principals VALUES ('op','operator','active')`)
  ins(`INSERT INTO domain_events (aggregate_id,aggregate_revision,event_type,scope_json,payload_json)
       VALUES ('mv1',1,'ModelPublished','{}','{}')`)
}

// ---------------------------------------------------------------------------
// fake deps — scoped visibility: 'b-shared-b' denied to the non-operator
// ---------------------------------------------------------------------------

const SECRET = 'smoke-secret-key'
const ctx: AuthenticatedContext = {
  principalId: 'op' as AuthenticatedContext['principalId'],
  controllerEpoch: 1 as AuthenticatedContext['controllerEpoch'],
  grantRevisions: { g1: 1 },
  transportSessionId: 'ts-1'
}

function makeDeps(deniedBoundaries: Set<string> = new Set()): DiscoveryDeps {
  const denied = (targets: DiscoveryTarget[]): boolean =>
    targets.some((t) => deniedBoundaries.has(t.id))
  return {
    authorize(_c, _op, targets) {
      if (denied(targets as unknown as DiscoveryTarget[])) {
        const e = { code: 'SCOPE_DENIED', message: 'denied', retry: 'none' }
        throw e
      }
    },
    decide(_c, _op, targets) {
      return { allow: !denied(targets as unknown as DiscoveryTarget[]) }
    },
    tokenSecret: SECRET,
    now: () => 1700000000000
  }
}

// ---------------------------------------------------------------------------
// tiny assertion runner
// ---------------------------------------------------------------------------

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}`, extra === undefined ? '' : JSON.stringify(extra))
  }
}
function section(name: string): void {
  console.log(`\n== ${name}`)
}

const db = new DatabaseSync(':memory:')
seed(db)
const deps = makeDeps()

section('responsibility.locate')
{
  const r1 = responsibilityLocate(db, ctx, deps, {
    projectId: 'p1',
    paths: ['src/auth/login.ts']
  }) as LocateResult
  check('deepest boundary wins', r1.items[0]?.boundaryId === 'b-auth', r1.items[0])
  check(
    'shallower claimants shown not hidden',
    (r1.items[0]?.claimants.length ?? 0) >= 2,
    r1.items[0]?.claimants
  )
  check('resolved role listed', r1.items[0]?.roles?.[0]?.id === 'r-auth')

  const r2 = responsibilityLocate(db, ctx, deps, {
    projectId: 'p1',
    paths: ['src/shared/x.ts']
  }) as LocateResult
  check('non-ancestor same-depth = ambiguous', r2.items[0]?.status === 'ambiguous', r2.items[0])
  check(
    'both claimants shown',
    r2.items[0]?.claimants.filter((c) => c.claim === 'owns').length === 2,
    r2.items[0]?.claimants
  )

  const r3 = responsibilityLocate(db, ctx, deps, {
    projectId: 'p1',
    paths: ['etc/nothing.ts', '../escape', '/abs']
  }) as LocateResult
  check('unassigned', r3.items[0]?.status === 'unassigned')
  check('.. escape invalid', r3.items[1]?.status === 'invalid')
  check('absolute invalid', r3.items[2]?.status === 'invalid')

  const r4 = responsibilityLocate(db, ctx, deps, {
    projectId: 'p1',
    paths: ['src/shared']
  }) as LocateResult
  check(
    'directory query with cover claims',
    r4.items[0]?.claimants.some((c) => c.claim === 'covers') || r4.items[0]?.status !== 'invalid',
    r4.items[0]
  )
}

section('responsibility.search')
{
  const s1 = responsibilitySearch(db, ctx, deps, {
    projectId: 'p1',
    paths: ['./src//auth/../auth/login.ts']
  }) as SearchResult
  const authCard = s1.items.find((i) => i.role.id === 'r-auth')
  check(
    'path search finds auth role',
    authCard !== undefined,
    s1.items.map((i) => i.role.id)
  )
  check(
    'ancestor owners are also candidates',
    s1.items.some((i) => i.role.id === 'r-lead')
  )
  check(
    'normalized prefix match reason',
    authCard?.matchReasons.some((m) => m.kind === 'path-prefix') ?? false,
    authCard?.matchReasons
  )
  check('card has criteria', (authCard?.boundary.criteria.length ?? 0) > 0)
  check(
    'card has contract relationship',
    authCard?.relationshipRefs.some((r) => r.kind === 'contract') ?? false,
    authCard?.relationshipRefs
  )
  check(
    'impl availability excludes retired',
    authCard?.implementationAvailability.length === 2 &&
      authCard.implementationAvailability.every((i) => i.implementationId !== 'impl-old'),
    authCard?.implementationAvailability
  )
  check(
    'member availability has run member',
    authCard?.memberAvailability[0]?.memberId === 'm1',
    authCard?.memberAvailability
  )
  check('selectionToken present', typeof authCard?.selectionToken === 'string')

  // token verification
  const tok = authCard!.selectionToken
  const v = verifySelectionToken(SECRET, tok)
  check('token verifies', v.ok && v.claims.roleId === 'r-auth', v)
  check('token pins modelVersion', v.ok && v.claims.modelVersion === 'mv1')
  const tampered = tok.slice(0, -4) + 'AAAA'
  check('tampered token rejected', !verifySelectionToken(SECRET, tampered).ok)
  check('unsafe read without secret', readSelectionTokenUnsafe(tok)?.roleId === 'r-auth')

  // text query — Korean substring fallback
  const s2 = responsibilitySearch(db, ctx, deps, {
    projectId: 'p1',
    query: '인증'
  }) as SearchResult
  check(
    'korean query hits auth',
    s2.items.some((i) => i.role.id === 'r-auth'),
    s2.items.map((i) => i.role.id)
  )

  const s3 = responsibilitySearch(db, ctx, deps, {
    projectId: 'p1',
    contractIds: ['c-session']
  }) as SearchResult
  const s3ids = s3.items.map((i) => i.role.id).sort()
  check(
    'contract search gives provider+consumers',
    s3ids.includes('r-auth') && s3ids.includes('r-web') && s3ids.includes('r-store'),
    s3ids
  )
  check(
    'direction recorded',
    s3.items
      .find((i) => i.role.id === 'r-auth')
      ?.matchReasons.some((m) => m.direction === 'provides') ?? false,
    s3.items
  )

  const s4 = responsibilitySearch(db, ctx, deps, {
    projectId: 'p1',
    scopeBoundaryId: 'b-store'
  }) as SearchResult
  const s4ids = s4.items.map((i) => i.role.id).sort()
  check(
    'scope limits to subtree',
    s4ids.every((id) => ['r-store', 'r-sa', 'r-sb'].includes(id)) && s4ids.length === 3,
    s4ids
  )

  // no filters → MODEL_INVALID
  let threw = false
  try {
    responsibilitySearch(db, ctx, deps, { projectId: 'p1' })
  } catch (e) {
    threw = isMahasError(e) && e.code === 'MODEL_INVALID'
  }
  check('empty request rejected', threw)

  // pagination + cursor binding
  const p1 = responsibilitySearch(db, ctx, deps, {
    projectId: 'p1',
    scopeBoundaryId: 'b-store',
    limit: 1
  }) as SearchResult
  check('page 1 limit', p1.items.length === 1 && typeof p1.nextCursor === 'string')
  const p2 = responsibilitySearch(db, ctx, deps, {
    projectId: 'p1',
    cursor: p1.nextCursor!
  }) as SearchResult
  check(
    'page 2 continues same snapshot/filter',
    p2.items.length === 1 && p2.items[0]?.role.id !== p1.items[0]?.role.id,
    p2.items.map((i) => i.role.id)
  )
  let staleThrew = false
  try {
    responsibilitySearch(db, ctx, deps, {
      projectId: 'p1',
      modelVersion: 'mv-other',
      cursor: p1.nextCursor!
    })
  } catch (e) {
    staleThrew = isMahasError(e) && (e.code === 'STALE_REVISION' || e.code === 'MODEL_INVALID')
  }
  check('cursor rejects model mixing', staleThrew)
}

section('responsibility.inspect')
{
  const i1 = responsibilityInspect(db, ctx, deps, {
    projectId: 'p1',
    modelVersion: 'mv1',
    boundaryId: 'b-root',
    perspective: 'coordination'
  }) as ReturnType<typeof responsibilityInspect>
  check('boundary summary', i1.boundary.id === 'b-root')
  check(
    'direct children at statement resolution',
    i1.children
      .map((c) => c.id)
      .sort()
      .join(',') === 'b-auth,b-empty,b-store',
    i1.children.map((c) => c.id)
  )
  check(
    'contract tension outbound (auth provides out of nothing)',
    i1.contractTensions.every((t) => t.crossing === 'internal'),
    i1.contractTensions
  )
  check(
    'authored coordination view read from interface clauses',
    i1.coordinationView.status === 'authored' &&
      i1.coordinationView.clauses?.[0]?.clauseId === 'cl-1',
    i1.coordinationView
  )
  const i2 = responsibilityInspect(db, ctx, deps, {
    projectId: 'p1',
    modelVersion: 'mv1',
    boundaryId: 'b-web',
    perspective: 'coordination'
  }) as ReturnType<typeof responsibilityInspect>
  check('missing view is honest', i2.coordinationView.status === 'missing')
  const i3 = responsibilityInspect(db, ctx, deps, {
    projectId: 'p1',
    modelVersion: 'mv1',
    boundaryId: 'b-auth',
    perspective: 'owner'
  }) as ReturnType<typeof responsibilityInspect>
  check('owner sees context refs not bodies', i3.contextRefs[0] === 'docs/auth-notes.md')
  check('non-goals listed', i3.nonGoals[0]?.statement.includes('소셜'))
}

section('responsibility.collaborators')
{
  const c1 = responsibilityCollaborators(db, ctx, deps, {
    projectId: 'p1',
    modelVersion: 'mv1',
    roleId: 'r-auth',
    runId: 'run1'
  }) as ReturnType<typeof responsibilityCollaborators>
  const byId = new Map(c1.items.map((c) => [c.role.id, c]))
  check(
    'siblings via same parent',
    byId.has('r-web'),
    c1.items.map((c) => c.role.id)
  )
  check(
    'contract consumers get provides-direction',
    byId
      .get('r-web')
      ?.relationReasons.some((r) => r.kind === 'contract' && r.direction === 'provides') ?? false,
    byId.get('r-web')
  )
  check(
    'contains parent relation',
    byId
      .get('r-lead')
      ?.relationReasons.some((r) => r.kind === 'contains' && r.direction === 'parent') ?? false,
    byId.get('r-lead')
  )
  const c2 = responsibilityCollaborators(db, ctx, deps, {
    projectId: 'p1',
    modelVersion: 'mv1',
    roleId: 'r-web',
    runId: 'run1'
  }) as ReturnType<typeof responsibilityCollaborators>
  const web2 = new Map(c2.items.map((c) => [c.role.id, c]))
  check(
    'consumer side sees consumes-direction',
    web2
      .get('r-auth')
      ?.relationReasons.some((r) => r.kind === 'contract' && r.direction === 'consumes') ?? false,
    web2.get('r-auth')
  )
  check(
    'member address resolved in run',
    web2.get('r-auth')?.members[0]?.memberId === 'm1',
    web2.get('r-auth')
  )
  check(
    'unassigned role comes back role-only',
    web2.get('r-store')?.members.length === 0,
    web2.get('r-store')
  )
}

section('role.implementations')
{
  const r = roleImplementations(db, ctx, deps, {
    modelVersion: 'mv1',
    roleId: 'r-auth'
  }) as ReturnType<typeof roleImplementations>
  check('two non-retired impls', r.implementations.length === 2, r.implementations)
  check(
    'verified profile support via attestation',
    r.implementations.find((i) => i.implementationId === 'impl-a1')?.support === 'verified'
  )
  check(
    'documented profile has admission blocker',
    r.implementations
      .find((i) => i.implementationId === 'impl-a2')
      ?.blockers.some((b) => b.kind === 'profile-admission') ?? false,
    r.implementations
  )
  const r2 = roleImplementations(db, ctx, deps, {
    modelVersion: 'mv1',
    roleId: 'r-auth',
    componentNeeds: ['subagent']
  }) as ReturnType<typeof roleImplementations>
  check(
    'componentNeeds filters with reason',
    r2.excluded.some(
      (e) => e.implementationId === 'impl-a1' && e.missingNeeds.includes('subagent')
    ),
    r2.excluded
  )
  const r3 = roleImplementations(db, ctx, deps, {
    modelVersion: 'mv1',
    roleId: 'r-web'
  }) as ReturnType<typeof roleImplementations>
  check('IMPLEMENTATION_MISSING is a result state', r3.status === 'implementation-missing')
  const r4 = roleImplementations(db, ctx, deps, {
    modelVersion: 'mv1',
    roleId: 'r-auth',
    hostId: 'h9'
  }) as ReturnType<typeof roleImplementations>
  check(
    'unverified host flagged',
    r4.implementations.every((i) => i.blockers.some((b) => b.kind === 'host-unverified')),
    r4.implementations
  )
}

section('visibility filter')
{
  const scoped = makeDeps(new Set(['b-shared-b']))
  const s = responsibilitySearch(db, ctx, scoped, {
    projectId: 'p1',
    scopeBoundaryId: 'b-store'
  }) as SearchResult
  check(
    'denied boundary never appears',
    !s.items.some((i) => i.boundary.id === 'b-shared-b') &&
      !s.diagnostics.rolelessBoundaryIds.includes('b-shared-b') &&
      !s.unmatchedPaths.some((u) => u.boundaryIds?.includes('b-shared-b')),
    s
  )
  const l = responsibilityLocate(db, ctx, scoped, {
    projectId: 'p1',
    paths: ['src/shared/x.ts']
  }) as LocateResult
  check(
    'hidden claimant filtered before ambiguity check',
    l.items[0]?.status === 'resolved' && l.items[0]?.boundaryId === 'b-shared-a',
    l.items[0]
  )
  check(
    'hidden boundary not named in claimants',
    !l.items[0]?.claimants.some((c) => c.boundaryId === 'b-shared-b'),
    l.items[0]?.claimants
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
