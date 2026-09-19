// VER-05 s0 — environment capture + world fixture through real ops.
// Builds: project/model v1 (3 roles sharing ctx-shared + ctx-charter),
// interface snapshots, verified harness profile, Tier-A authored impls,
// run, provisioning grant, negotiation plan (t-asm, t-tool), 3 members.
// Persists fixture ids to state.json for later steps.
import { execSync } from 'node:child_process'
import {
  Recorder, wire, opCtx, memberCtx, saveState, writeJson, sha256File,
  REPO_ROOT, OUT, DB, HOST_SOCK
} from './common.ts'
import {
  buildModelFixture, commitNegotiationPlan, seedMember,
  SHARED_SRC, CHARTER_SRC, type Fixture
} from './fixture.ts'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const rec = new Recorder('s0-fixture')
const git = (cwd: string, args: string) => {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf8' }).trim()
  } catch (e) {
    return `ERR ${String(e).slice(0, 120)}`
  }
}

const w = await wire('s0')
const ctx = opCtx()

// ---- environment ---------------------------------------------------------
const env = {
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  sqlite: (w.db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
  dbBinding: 'node:sqlite (built-in)',
  kernel: execSync('uname -r').toString().trim(),
  srcRevision: git('/tmp/mahas-ver-05/src', 'rev-parse HEAD'),
  srcDirty: git('/tmp/mahas-ver-05/src', 'status --porcelain').length > 0,
  specRevision: git('/home/pyosechang/projects/ade-wt-mahas-architecture/mahas-architecture', 'rev-parse HEAD'),
  mainWorktreeDirty: git('/home/pyosechang/projects/ade-wt-mahas-architecture', 'status --porcelain').length > 0,
  controlDb: DB,
  hostSocket: HOST_SOCK,
  repoRoot: REPO_ROOT,
  service: 'in-process composeRuntime (real op registry + admission) + real mahas-execution-host',
  harness: 'cooperative recorder.mjs spawned by host.process.spawn (pipes)'
}
rec.artifact('environment', env)
rec.check('env.src-revision', env.srcRevision.startsWith('83a6d21'), '83a6d21*', env.srcRevision)

// ---- host attachment ------------------------------------------------------
rec.check('host.attached', w.hostId !== null, 'localHost != null', String(w.hostId))
const hostRow = w.db.prepare('SELECT id,incarnation,state FROM execution_hosts').all()
rec.artifact('executionHosts', hostRow)

// ---- fixture ---------------------------------------------------------------
const fx = await buildModelFixture(w.dispatch, ctx)
const planRevision = await commitNegotiationPlan(w.dispatch, ctx, fx.runId)
fx.planRevision = planRevision
fx.taskIds = { asm: 't-asm', tool: 't-tool' }

const lead = await seedMember(w.db, w.dispatch, ctx, fx, {
  roleId: 'r-lead', kind: 'coordination', mandate: 'VER-05 coordination mandate'
})
const asm = await seedMember(w.db, w.dispatch, ctx, fx, {
  roleId: 'r-asm', kind: 'task', taskId: 't-asm', mandate: 'VER-05 assembly mandate'
})
const tool = await seedMember(w.db, w.dispatch, ctx, fx, {
  roleId: 'r-tool', kind: 'task', taskId: 't-tool', mandate: 'VER-05 tool mandate'
})
const fixture: Fixture = { ...fx, members: { lead, asm, tool } }

// ---- assertions -----------------------------------------------------------
rec.check('fixture.mv1', typeof fx.mv1 === 'string' && fx.mv1.length > 0, 'active model v1', fx.mv1)
for (const r of ['r-lead', 'r-asm', 'r-tool']) {
  rec.check(
    `fixture.iface.${r}`,
    typeof fx.ifaceDigest[r] === 'string' && fx.ifaceDigest[r]!.length === 64,
    'interface snapshot digest',
    String(fx.ifaceDigest[r])
  )
  rec.check(
    `fixture.impl.${r}`,
    typeof fx.impls[r]?.implId === 'string',
    'published authored impl',
    JSON.stringify(fx.impls[r])
  )
}
const sharedSha = sha256File(join(REPO_ROOT, SHARED_SRC))
const charterSha = sha256File(join(REPO_ROOT, CHARTER_SRC))
rec.check('source.shared.pinned', sharedSha.length === 64, 'sha256 of shared source', sharedSha)
rec.artifact('sourcePins', {
  [SHARED_SRC]: sharedSha,
  [CHARTER_SRC]: charterSha
})
const ctxRows = w.db.prepare('SELECT id,path FROM rdd_contexts ORDER BY id').all()
rec.artifact('rddContexts', ctxRows)
const clauses = fx.ifaceClauses['r-asm']!
rec.check(
  'fixture.clause.context-shared',
  clauses.includes('context:ctx-shared'),
  "interface clause 'context:ctx-shared'",
  clauses.join(',')
)

saveState({
  fixture: {
    projectId: fx.projectId,
    mv1: fx.mv1,
    runId: fx.runId,
    ifaceDigest: fx.ifaceDigest,
    ifaceClauses: fx.ifaceClauses,
    impls: fx.impls,
    provAll: fx.provAll,
    profileId: fx.profileId,
    profileRevision: fx.profileRevision,
    planRevision,
    hostId: w.hostId,
    hostIncarnation: (hostRow[0] as { incarnation?: string })?.incarnation ?? null,
    members: fixture.members,
    sourcePins: { [SHARED_SRC]: sharedSha, [CHARTER_SRC]: charterSha }
  }
})

w.runtime.close()
rec.flush({ fixture: { runId: fx.runId, mv1: fx.mv1, members: fixture.members } })
