// VER-01 step-3 — responsibility discovery (search / inspect / locate /
// collaborators / role.implementations) against the durable v1 model,
// plus token capture for the stale-token and assignment steps.
import {
  Recorder, wire, opCtx, memberCtx, loadState, saveState, writeJson,
  verifySelectionToken, q1, qa, CONFIG_DIR
} from './common.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rec = new Recorder('s3-discovery')
const st = loadState()
const w = await wire('s3')
const { db } = w
const ctx = opCtx()
const projectId = st.projectId as string
const mv1 = st.mv1 as string
const runId1 = st.runId1 as string
const impls = st.impls as Record<string, { implId: string; revision: number }>

const tokSecret = new TextEncoder().encode(
  readFileSync(join(CONFIG_DIR, 'selection-token.key'), 'utf8').trim()
)
const decodeTok = (t: string) => verifySelectionToken(tokSecret, t)

type SearchResult = {
  modelVersion: string; status: string
  items: {
    boundary: { id: string }; role: { id: string; name: string }
    matchReasons: { kind: string; detail?: unknown }[]
    relationshipRefs: unknown[]
    implementationAvailability: { implementationId: string; support: string; blockers: unknown[] }[]
    memberAvailability: unknown[]
    scopeCoverage: { matchedPaths: string[]; matchedContractIds: string[]; coversScope: boolean }
    selectionToken: string
  }[]
  unmatchedPaths: { path: string; status: string; boundaryIds?: string[] }[]
  ambiguityGroups: { kind: string; paths: string[]; boundaryIds: string[] }[]
  diagnostics: { rolelessBoundaryIds: string[]; unmatchedContractIds: string[] }
  nextCursor?: string
  staleModel: boolean
}

const search = async (payload: unknown) =>
  (await w.dispatch(ctx, 'responsibility.search', payload)) as { status: string; result?: SearchResult; error?: { code: string; message: string } }

// ---------------------------------------------------------------- path --
const rAmb = await search({ projectId, paths: ['src/api/auth/login.ts'] })
rec.check('path search committed', rAmb.status === 'committed', 'committed', rAmb.status)
rec.check(
  'ambiguous territory reported for src/api/* (b-api vs b-api-alt)',
  rAmb.result!.unmatchedPaths.some((u) => u.status === 'ambiguous') &&
    rAmb.result!.ambiguityGroups.length === 1,
  'unmatchedPaths[ambiguous]+group',
  `${rAmb.result!.status} ${JSON.stringify(rAmb.result!.unmatchedPaths)}`,
  { groups: rAmb.result!.ambiguityGroups, roles: rAmb.result!.items.map((i) => i.role.id) }
)
rec.check(
  'ambiguity group names both tied boundaries',
  (rAmb.result!.ambiguityGroups[0]?.boundaryIds ?? []).sort().join(',') === 'b-api,b-api-alt',
  'b-api,b-api-alt',
  JSON.stringify(rAmb.result!.ambiguityGroups)
)
rec.check(
  'tied-boundary roles still listed as candidates (not silently picked)',
  ['r-alt', 'r-auth', 'r-users'].every((r) => rAmb.result!.items.some((i) => i.role.id === r)),
  'r-alt+r-auth+r-users cards',
  JSON.stringify(rAmb.result!.items.map((i) => i.role.id))
)

const rWeb = await search({ projectId, paths: ['src/web/app.tsx'] })
rec.check(
  'single-owner path search commits',
  rWeb.status === 'committed' && rWeb.result!.status === 'ok',
  'committed/ok', `${rWeb.status}/${rWeb.result!.status}`
)
const webCard = rWeb.result!.items.find((i) => i.role.id === 'r-web')!
rec.check('deepest-owner card is r-web', webCard !== undefined, 'r-web', JSON.stringify(rWeb.result!.items.map((i) => i.role.id)))
rec.check(
  'ancestor-claiming b-root also surfaces (r-lead) as shallower claim',
  rWeb.result!.items.some((i) => i.role.id === 'r-lead'),
  'r-lead card via src/ claim', JSON.stringify(rWeb.result!.items.map((i) => [i.role.id, i.boundary.id]))
)
rec.check(
  'matchReasons cite the path match',
  webCard.matchReasons.some((m) => JSON.stringify(m).includes('src/web')),
  'path reason',
  JSON.stringify(webCard.matchReasons)
)
rec.check(
  'r-web card shows verified implementation',
  webCard.implementationAvailability.some((i) => i.implementationId === impls['r-web']!.implId && i.support === 'verified'),
  'impl verified',
  JSON.stringify(webCard.implementationAvailability)
)
rec.check('card carries a selection token', typeof webCard.selectionToken === 'string' && webCard.selectionToken.length > 20, 'token', `${webCard.selectionToken.length} chars`)

const rDocs = await search({ projectId, paths: ['docs/guide.md'] })
rec.check(
  'docs path → unassigned/no-responsible-role (boundary owns it, no role)',
  rDocs.result!.status === 'unassigned' &&
    rDocs.result!.unmatchedPaths.some((u) => u.status === 'no-responsible-role') &&
    rDocs.result!.diagnostics.rolelessBoundaryIds.includes('b-docs'),
  'unassigned+roleless b-docs',
  `${rDocs.result!.status} ${JSON.stringify(rDocs.result!.unmatchedPaths)} ${JSON.stringify(rDocs.result!.diagnostics)}`
)

const rVendor = await search({ projectId, paths: ['vendor/lib/x.js'] })
rec.check(
  'unclaimed territory → unassigned',
  rVendor.result!.status === 'unassigned' && rVendor.result!.unmatchedPaths.some((u) => u.status === 'unassigned'),
  'unassigned', `${rVendor.result!.status} ${JSON.stringify(rVendor.result!.unmatchedPaths)}`
)

const rBad = await search({ projectId, paths: ['src/web/app.tsx', '../escape/x.ts', '/abs/path'] })
rec.check(
  'invalid paths reported alongside valid results',
  rBad.status === 'committed' &&
    rBad.result!.unmatchedPaths.filter((u) => u.status === 'invalid').length === 2,
  'invalid×2 + card', `${rBad.status} ${JSON.stringify(rBad.result!.unmatchedPaths)}`
)
const rAllBad = await search({ projectId, paths: ['../escape/x.ts'] })
rec.check(
  'all-invalid paths → rejected MODEL_INVALID (no filter signal)',
  rAllBad.status === 'rejected' && rAllBad.error?.code === 'MODEL_INVALID',
  'rejected MODEL_INVALID', `${rAllBad.status} ${rAllBad.error?.code}`
)

// ------------------------------------------------------------- contract --
const rContract = await search({ projectId, contractIds: ['c-user-api'] })
const contractRoles = (rContract.result?.items ?? []).map((i) => i.role.id).sort()
rec.check(
  'contract search returns provider+consumer boundary roles',
  rContract.result!.status === 'ok' && contractRoles.includes('r-web') && contractRoles.some((r) => r === 'r-auth' || r === 'r-users'),
  'ok w/ provider+consumer',
  `${rContract.result!.status} ${contractRoles}`
)
rec.check(
  'contract match reason cites c-user-api',
  rContract.result!.items.every((i) => i.scopeCoverage.matchedContractIds.includes('c-user-api')),
  'matchedContractIds c-user-api',
  JSON.stringify(rContract.result!.items.map((i) => i.scopeCoverage))
)
const rContractMiss = await search({ projectId, contractIds: ['c-nonexistent'] })
rec.check(
  'unmatched contract reported in diagnostics',
  rContractMiss.result!.diagnostics.unmatchedContractIds.includes('c-nonexistent'),
  'unmatchedContractIds',
  JSON.stringify(rContractMiss.result!.diagnostics)
)

// ------------------------------------------------------------ expertise --
const rBack = await search({ projectId, horizontalRoleNames: ['backend'] })
const backRoles = (rBack.result?.items ?? []).map((i) => i.role.id).sort()
rec.check(
  'horizontal-role backend returns 4 backend roles',
  rBack.result!.status === 'ok' && backRoles.join(',') === 'r-alt,r-auth,r-lib,r-users',
  'r-alt,r-auth,r-lib,r-users', `${rBack.result!.status} ${backRoles}`
)

// ---------------------------------------------------------- korean text --
const rKor = await search({ projectId, query: '인증' })
const korRoles = (rKor.result?.items ?? []).map((i) => i.role.id).sort()
rec.check(
  'Korean query 인증 matches auth-bearing roles',
  rKor.result!.status === 'ok' && korRoles.includes('r-auth') && korRoles.includes('r-users'),
  'ok ⊇{r-auth,r-users}', `${rKor.result!.status} ${korRoles}`
)
rec.check(
  'Korean query emits text match reason',
  rKor.result!.items.some((i) => i.matchReasons.some((m) => (m.kind ?? '').includes('text') || JSON.stringify(m).includes('인증'))),
  'text reason', JSON.stringify(rKor.result!.items[0]?.matchReasons)
)
const rKor2 = await search({ projectId, query: '조정 리더' })
rec.check(
  'Korean query 조정 리더 reaches r-lead',
  (rKor2.result?.items ?? []).some((i) => i.role.id === 'r-lead'),
  'r-lead', JSON.stringify((rKor2.result?.items ?? []).map((i) => i.role.id))
)
const rNomatch = await search({ projectId, query: 'qxjkwv' })
rec.check('empty text result → no-match', rNomatch.result!.status === 'no-match', 'no-match', `${rNomatch.result!.status} ${JSON.stringify(rNomatch.result!.items.map((i) => i.role.id))}`)

// ---------------------------------------------------------------- scope --
const rScope = await search({ projectId, query: '인증', scopeBoundaryId: 'b-web' })
rec.check(
  'scopeBoundaryId restricts candidates to the subtree',
  (rScope.result?.items ?? []).every((i) => i.scopeCoverage.coversScope) &&
    !(rScope.result?.items ?? []).some((i) => i.boundary.id === 'b-api'),
  'no b-api cards under b-web scope',
  JSON.stringify((rScope.result?.items ?? []).map((i) => i.boundary.id))
)

// ------------------------------------------------------------ pagination --
const rP1 = await search({ projectId, horizontalRoleNames: ['backend'], limit: 2 })
const rP2 = rP1.result!.nextCursor
  ? await search({ projectId, cursor: rP1.result!.nextCursor })
  : { status: 'no-cursor', result: undefined }
const page1 = (rP1.result?.items ?? []).map((i) => i.role.id)
const page2 = (rP2.result?.items ?? []).map((i) => i.role.id)
rec.check('page-1 limited to 2 + cursor issued', page1.length === 2 && typeof rP1.result!.nextCursor === 'string', '2+cursor', `${page1.length} ${typeof rP1.result!.nextCursor}`)
rec.check('page-2 continues disjointly', page2.length === 2 && !page2.some((r) => page1.includes(r)), 'disjoint 2', JSON.stringify(page2))
rec.check('cursor pins same modelVersion', rP2.result?.modelVersion === mv1, mv1, String(rP2.result?.modelVersion))
const rBadCursor = await search({ projectId, cursor: 'bogus-cursor' })
rec.check('bogus cursor rejected MODEL_INVALID', rBadCursor.status === 'rejected' && rBadCursor.error?.code === 'MODEL_INVALID', 'rejected MODEL_INVALID', `${rBadCursor.status} ${rBadCursor.error?.code}`)

// ------------------------------------------------- token capture (later) --
const tokByRole: Record<string, string> = {}
for (const r of await Promise.all([
  search({ projectId, paths: ['src/api/auth/login.ts', 'src/web/app.tsx', 'src/lib/x.ts', 'src'] })
])) {
  for (const card of r.result?.items ?? []) tokByRole[card.role.id] = card.selectionToken
}
// r-auth may be missing from the merged set (ambiguous src/api path) — fetch directly
if (!tokByRole['r-auth']) {
  const r = await search({ projectId, query: '세션 관리' })
  for (const c of r.result?.items ?? []) if (c.role.id === 'r-auth') tokByRole['r-auth'] = c.selectionToken
}
if (!tokByRole['r-lead']) {
  const r = await search({ projectId, horizontalRoleNames: ['coordinator'] })
  for (const c of r.result?.items ?? []) tokByRole['r-lead'] = c.selectionToken
}
rec.check('token captured for r-auth', typeof tokByRole['r-auth'] === 'string', 'token', String(tokByRole['r-auth']?.slice(0, 24)))
rec.check('token captured for r-lead', typeof tokByRole['r-lead'] === 'string', 'token', String(tokByRole['r-lead']?.slice(0, 24)))
const authClaims = decodeTok(tokByRole['r-auth']!)
rec.check(
  'r-auth token pins mv1+r-auth+roleDigest+interfaceDigest',
  authClaims.ok === true &&
    authClaims.claims.modelVersion === mv1 &&
    authClaims.claims.roleId === 'r-auth' &&
    typeof authClaims.claims.roleDigest === 'string' &&
    typeof authClaims.claims.interfaceDigest === 'string',
  'claims pinned',
  JSON.stringify(authClaims.ok ? authClaims.claims : authClaims)
)
rec.artifact('tokenClaims.r-auth', authClaims.ok ? authClaims.claims : authClaims)

// ------------------------------------------------------------- inspect ---
const rInsp = await w.dispatch(ctx, 'responsibility.inspect', {
  projectId, modelVersion: mv1, boundaryId: 'b-api', perspective: 'coordination'
})
rec.check('inspect committed', rInsp.status === 'committed', 'committed', rInsp.status)
const insp = rInsp.result as {
  children: { id: string }[]; roles: { id: string }[]
  contractTensions: { contractId: string; crossing: string }[]
  nonGoals: { id: string }[]; contextRefs: string[]
  coordinationView: { status: string }
}
rec.check('inspect roles = r-auth,r-users', (insp.roles ?? []).map((r) => r.id).sort().join(',') === 'r-auth,r-users', 'r-auth,r-users', JSON.stringify(insp.roles?.map((r) => r.id)))
rec.check(
  'inspect contract tension outbound c-user-api',
  (insp.contractTensions ?? []).some((t) => t.contractId === 'c-user-api' && t.crossing === 'outbound'),
  'outbound c-user-api', JSON.stringify(insp.contractTensions)
)
rec.check('inspect context refs = docs/security.md', (insp.contextRefs ?? []).includes('docs/security.md'), 'ctx ref', JSON.stringify(insp.contextRefs))
rec.check('inspect nonGoals present', (insp.nonGoals ?? []).some((n) => n.id === 'ng-api-1'), 'ng-api-1', JSON.stringify(insp.nonGoals))
rec.artifact('inspect.b-api', insp)

// -------------------------------------------------------------- locate ---
const rLoc = await w.dispatch(ctx, 'responsibility.locate', {
  projectId, paths: ['src/api/auth/login.ts', 'src/web/app.tsx', 'docs/guide.md', 'vendor/x.js', '../nope', 'src/api']
})
rec.check('locate committed', rLoc.status === 'committed', 'committed', rLoc.status)
const loc = (rLoc.result as { items: { path: string; status: string; boundaryId?: string; claimants?: unknown[] }[] }).items
const byPath = Object.fromEntries(loc.map((i) => [i.path, i]))
rec.check('locate src/api/auth → ambiguous', byPath['src/api/auth/login.ts']?.status === 'ambiguous', 'ambiguous', byPath['src/api/auth/login.ts']?.status)
rec.check('locate src/web/app → resolved b-web', byPath['src/web/app.tsx']?.status === 'resolved' && byPath['src/web/app.tsx']?.boundaryId === 'b-web', 'b-web', `${byPath['src/web/app.tsx']?.status} ${byPath['src/web/app.tsx']?.boundaryId}`)
rec.check('locate docs/guide → resolved b-docs (owner known, role absent)', byPath['docs/guide.md']?.status === 'resolved' && byPath['docs/guide.md']?.boundaryId === 'b-docs', 'resolved b-docs', `${byPath['docs/guide.md']?.status} ${byPath['docs/guide.md']?.boundaryId}`)
rec.check('locate vendor → unassigned', byPath['vendor/x.js']?.status === 'unassigned', 'unassigned', byPath['vendor/x.js']?.status)
rec.check('locate ../nope → invalid', byPath['../nope']?.status === 'invalid', 'invalid', byPath['../nope']?.status)
rec.check('locate src/api exact → ambiguous (b-api vs b-api-alt)', byPath['src/api']?.status === 'ambiguous', 'ambiguous', byPath['src/api']?.status)
rec.artifact('locate', loc)

// -------------------------------------------------------- collaborators --
const rColl = await w.dispatch(ctx, 'responsibility.collaborators', {
  projectId, modelVersion: mv1, roleId: 'r-auth', runId: runId1
})
rec.check('collaborators committed', rColl.status === 'committed', 'committed', rColl.status)
const coll = (rColl.result as { items: { role: { id: string }; relationReasons: { kind: string; direction?: string }[]; members: unknown[] }[] }).items
rec.check(
  'collaborators: r-users same-boundary',
  coll.some((c) => c.role.id === 'r-users' && c.relationReasons.some((r) => r.kind === 'same-boundary')),
  'r-users same-boundary', JSON.stringify(coll.map((c) => [c.role.id, c.relationReasons.map((r) => r.kind)]))
)
rec.check(
  'collaborators: r-web via contract consume/provide',
  coll.some((c) => c.role.id === 'r-web' && c.relationReasons.some((r) => r.kind === 'contract')),
  'r-web contract', JSON.stringify(coll.map((c) => c.role.id))
)
rec.artifact('collaborators.r-auth', coll)

// ----------------------------------------------------- implementations ---
const rImplAuth = await w.dispatch(ctx, 'role.implementations', { modelVersion: mv1, roleId: 'r-auth' })
const implAuth = rImplAuth.result as { status: string; implementations: { implementationId: string; support: string }[]; interfaceDigests: string[] }
rec.check('role.implementations r-auth committed', rImplAuth.status === 'committed', 'committed', rImplAuth.status)
rec.check(
  'r-auth impl listed as verified',
  implAuth.status === 'ok' && implAuth.implementations.some((i) => i.implementationId === impls['r-auth']!.implId && i.support === 'verified'),
  'verified', JSON.stringify(implAuth.implementations)
)
const rImplUsers = await w.dispatch(ctx, 'role.implementations', { modelVersion: mv1, roleId: 'r-users' })
const implUsers = rImplUsers.result as { status: string; implementations: { implementationId: string; support: string; blockers: { kind?: string }[] }[] }
rec.check(
  'r-users impl documented w/ profile-admission blocker',
  implUsers.implementations.some((i) => i.implementationId === impls['r-users']!.implId && i.support === 'documented'),
  'documented', JSON.stringify(implUsers.implementations)
)
const rImplLib = await w.dispatch(ctx, 'role.implementations', { modelVersion: mv1, roleId: 'r-lib' })
const implLib = rImplLib.result as { status: string }
rec.check('r-lib → implementation-missing', implLib.status === 'implementation-missing', 'implementation-missing', implLib.status)
const rImplSkill = await w.dispatch(ctx, 'role.implementations', { modelVersion: mv1, roleId: 'r-web', componentNeeds: ['skill'] })
const implSkill = rImplSkill.result as { implementations: unknown[]; excluded?: { implementationId: string; missingNeeds: string[] }[]; status: string }
rec.check(
  'componentNeeds=[skill] excludes r-web impl (instruction-only)',
  (implSkill.excluded ?? []).some((e) => e.implementationId === impls['r-web']!.implId),
  'excluded impl-r-web', JSON.stringify(implSkill)
)
rec.artifact('roleImplementations', { auth: implAuth, users: implUsers, lib: implLib, skillFilter: implSkill })

// ------------------------------------------------ visibility negative ----
const ghost = await w.dispatch(
  memberCtx('mem-nonexistent', { 'grant-ghost': 1 }),
  'responsibility.search',
  { projectId, paths: ['src/web/app.tsx'] }
)
rec.check(
  'grant-less member ctx → hidden/unavailable (non-exposure)',
  ghost.status === 'rejected' && (ghost.error?.code === 'UNAVAILABLE_OPERATION' || ghost.error?.code === 'GRANT_REVOKED' || ghost.error?.code === 'UNAUTHENTICATED'),
  'rejected', `${ghost.status} ${ghost.error?.code}`
)

// ------------------------------------------------- stale modelVersion ----
const rStale = await search({ projectId, modelVersion: st.mv0 as string, paths: ['src/web/app.tsx'] })
rec.check('draft model pin → MODEL_INVALID', rStale.status === 'rejected' && rStale.error?.code === 'MODEL_INVALID', 'MODEL_INVALID', `${rStale.status} ${rStale.error?.code}`)

saveState({ tokByRole, authTokenClaims: authClaims.ok ? authClaims.claims : null })
w.runtime.close()
db.close()
rec.flush({ processPid: process.pid })
console.log('s3 done')
