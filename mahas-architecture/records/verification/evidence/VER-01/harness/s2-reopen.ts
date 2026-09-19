// VER-01 step-2 — durability across a process boundary.
// This is a NEW process (s1 exited). It opens the same SQLite file,
// re-derives the model purely from DB rows (raw SQL), re-queries the API
// surface (project.get / model.snapshot), and compares digests with the
// s1 evidence dump — proving the model + relations are durable state, not
// in-memory or records-file state.
import {
  Recorder, wire, opCtx, loadState, dumpModelRows, digestOf, writeJson,
  q1, qa, cnt
} from './common.ts'
import { readFileSync } from 'node:fs'

const rec = new Recorder('s2-reopen')
const st = loadState()
const s1ev = JSON.parse(readFileSync('/tmp/mahas-ver-01/out/s1-evidence.json', 'utf8'))

const w = await wire('s2')
const { db } = w
const ctx = opCtx()
const projectId = st.projectId as string
const mv1 = st.mv1 as string

// --- A. raw SQLite reads (SQLite is the source of truth, not records) ---
const dump = dumpModelRows(db, mv1)
const rowDigest = digestOf(dump)
rec.check(
  'model row digest identical across process boundary',
  rowDigest === s1ev.rowDigest,
  s1ev.rowDigest,
  rowDigest
)
const proj = q1(db, 'SELECT * FROM projects WHERE id=?', projectId)
rec.check(
  'project row persists w/ active model',
  proj?.active_model_version === mv1,
  mv1,
  String(proj?.active_model_version)
)
rec.check(
  'mv1 status published in reopened db',
  q1(db, 'SELECT status FROM model_versions WHERE id=?', mv1)?.status === 'published',
  'published',
  String(q1(db, 'SELECT status FROM model_versions WHERE id=?', mv1)?.status)
)
rec.check(
  'draft mv0 still persisted',
  q1(db, 'SELECT status FROM model_versions WHERE id=?', st.mv0 as string)?.status === 'draft',
  'draft',
  String(q1(db, 'SELECT status FROM model_versions WHERE id=?', st.mv0 as string)?.status)
)
for (const [table, expect] of Object.entries({
  rdd_boundaries: 6, rdd_roles: 6, rdd_contracts: 1, rdd_contexts: 3,
  rdd_criteria: 7, boundary_paths: 6, boundary_edges: 5, rdd_non_goals: 2,
  role_search_rows: 6
} as Record<string, number>)) {
  const n = cnt(db, table, 'WHERE model_version=?', mv1)
  rec.check(`${table} rows = ${expect}`, n === expect, String(expect), String(n))
}
rec.check(
  'domain_events durable across reopen',
  cnt(db, 'domain_events') === (s1ev.counts.domain_events as number),
  String(s1ev.counts.domain_events),
  String(cnt(db, 'domain_events'))
)
rec.check(
  'operation_receipts durable across reopen',
  cnt(db, 'operation_receipts') === (s1ev.counts.operation_receipts as number),
  String(s1ev.counts.operation_receipts),
  String(cnt(db, 'operation_receipts'))
)
rec.check(
  'grants durable across reopen',
  cnt(db, 'grants') === (s1ev.counts.grants as number),
  String(s1ev.counts.grants),
  String(cnt(db, 'grants'))
)

// relation integrity spot-checks straight from SQLite
const orphans = qa(
  db,
  `SELECT r.id FROM rdd_roles r WHERE r.model_version=? AND NOT EXISTS
     (SELECT 1 FROM rdd_boundaries b WHERE b.model_version=r.model_version AND b.id=r.boundary_id)`,
  mv1
)
rec.check('no role→boundary orphans', orphans.length === 0, '0', String(orphans.length))
const danglingEdges = qa(
  db,
  `SELECT e.child_id FROM boundary_edges e WHERE e.model_version=? AND (
     NOT EXISTS (SELECT 1 FROM rdd_boundaries p WHERE p.model_version=e.model_version AND p.id=e.parent_id)
     OR NOT EXISTS (SELECT 1 FROM rdd_boundaries c WHERE c.model_version=e.model_version AND c.id=e.child_id))`,
  mv1
)
rec.check('no dangling boundary edges', danglingEdges.length === 0, '0', String(danglingEdges.length))
const contractConsumers = qa(
  db,
  `SELECT * FROM contract_consumers WHERE model_version=?`, mv1
)
rec.check(
  'contract consumer edge b-api→b-web persisted',
  contractConsumers.some((c) => c.consumer_boundary_id === 'b-web' && c.contract_id === 'c-user-api'),
  'b-web consumes c-user-api',
  JSON.stringify(contractConsumers)
)
const searchRow = q1(db, 'SELECT * FROM role_search_rows WHERE model_version=? AND role_id=?', mv1, 'r-auth')
rec.check('search projection carries Korean text', JSON.stringify(searchRow ?? {}).includes('인증'), 'contains 인증', JSON.stringify(searchRow)?.slice(0, 200))

// --- B. API surface on the reopened DB ---
const rGet = await w.dispatch(ctx, 'project.get', { projectId })
rec.check('project.get committed after reopen', rGet.status === 'committed', 'committed', rGet.status)
const pg = rGet.result as { activeModelVersion: string; rootBoundary: { id: string } | null }
rec.check(
  'project.get activeModelVersion = mv1',
  pg.activeModelVersion === mv1, mv1, String(pg.activeModelVersion)
)
rec.check('project.get rootBoundary = b-root', pg.rootBoundary?.id === 'b-root', 'b-root', String(pg.rootBoundary?.id))

const rSnap = await w.dispatch(ctx, 'model.snapshot', { projectId, modelVersion: mv1, projection: 'structural' })
rec.check('model.snapshot committed after reopen', rSnap.status === 'committed', 'committed', rSnap.status)
const snap = rSnap.result as { rootBoundaryId: string; snapshot: { boundaries: unknown[] } }
rec.check('snapshot root = b-root', snap.rootBoundaryId === 'b-root', 'b-root', String(snap.rootBoundaryId))
const snapB = (snap.snapshot.boundaries as unknown[]).length
rec.check('snapshot boundary count = 6', snapB === 6, '6', String(snapB))

const rCoord = await w.dispatch(ctx, 'model.snapshot', { projectId, modelVersion: mv1, projection: 'coordination' })
rec.check('coordination projection committed', rCoord.status === 'committed', 'committed', rCoord.status)

const rRole = await w.dispatch(ctx, 'model.snapshot', { projectId, modelVersion: mv1, projection: 'role', roleId: 'r-auth' })
const rv = rRole.result as { role: { role: { id: string }; ancestors: { id: string }[]; contracts: { id: string }[] } }
rec.check('role projection committed', rRole.status === 'committed', 'committed', rRole.status)
rec.check('role projection ancestors = [b-root]', (rv.role.ancestors ?? []).map((a) => a.id).join(',') === 'b-root', 'b-root', JSON.stringify(rv.role.ancestors?.map((a) => a.id)))
rec.check('role projection sees contract c-user-api', (rv.role.contracts ?? []).some((c) => c.id === 'c-user-api'), 'c-user-api', JSON.stringify(rv.role.contracts?.map((c) => c.id)))

writeJson('s2-evidence.json', {
  rowDigest,
  snapshotBoundaries: snapB,
  projectGet: rGet.result,
  runRow: q1(db, 'SELECT * FROM runs WHERE id=?', st.runId1 as string),
  interfaceRows: qa(db, 'SELECT digest,model_version,role_id FROM role_interfaces ORDER BY role_id'),
  implRows: qa(db, 'SELECT id,revision,status,profile_id,profile_revision FROM role_implementations ORDER BY id'),
  grantRows: qa(db, 'SELECT id,kind,principal_id,revoked_at FROM grants ORDER BY id')
})

w.runtime.close()
db.close()
rec.flush({ processPid: process.pid })
console.log('s2 done')
