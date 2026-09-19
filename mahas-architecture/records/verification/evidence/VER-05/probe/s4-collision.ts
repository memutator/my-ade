// s4 — same-cwd collision matrix: two roles/materializations converging on one
// canonical checkout. Layers under test:
//   claim level   — second execution without a held write claim (SCOPE_DENIED)
//                   [the prepare-level RESOURCE_BUSY second-writer refusal is
//                   already recorded at s2d.secondWriterRefused]
//   file level    — a second materialization that does reach the checkout hits
//                   existing bytes → OPERATION_CONFLICT, foreign bytes kept
//   plan level    — same-path collision inside one bundle; reserved shared
//                   basenames (AGENTS.md/CLAUDE.md at any depth, any case);
//                   path escapes; symlinked ancestors
//   coexistence   — pre-existing shared AGENTS.md/CLAUDE.md are left
//                   untouched while unrelated components install
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  Recorder, wire, opCtx, loadState, sha256Hex, REPO_ROOT, q1, qa
} from './common.ts'
import { materializeBundle } from 'file:///tmp/mahas-ver-05/src/packages/mahas-runtime/src/realization/materializer.ts'
import { canonicalJson } from 'file:///tmp/mahas-ver-05/src/packages/mahas-runtime/src/realization/component-store.ts'

const rec = new Recorder('s4-collision')
const w = await wire('s4')
const fx = loadState().fixture as Record<string, any>
const hostId = String(w.hostId ?? fx.hostId)
const E = w.epoch
const EXEC_ROOTS = '/tmp/mahas-ver-05/executions'

w.db.prepare("INSERT OR IGNORE INTO principals(id,kind,status) VALUES('service:ver05','service','active')").run()
w.db
  .prepare(
    `INSERT OR IGNORE INTO grants(id, revision, kind, principal_id, parent_grant_id, policy_id,
       policy_revision, expires_at, revoked_at, scope_json, actions_json)
     VALUES ('grant-service-ver05', 1, 'assignment', 'service:ver05', NULL, NULL, NULL, NULL, NULL, ?, ?)`
  )
  .run(
    JSON.stringify({ targets: [{ kind: '*', id: '*' }] }),
    JSON.stringify(['workspace.inspect', 'workspace.prepare'])
  )
const svcCtx = {
  principalId: 'service:ver05',
  controllerEpoch: E,
  grantRevisions: { 'grant-service-ver05': 1 },
  transportSessionId: `ver05:svc-s4:${process.pid}`
}
const svcCaller = async (operation: string, payload?: unknown): Promise<unknown> => {
  const r = await w.dispatch(svcCtx as never, operation, payload)
  if (r.status !== 'committed') throw r.error ?? { code: 'UNKNOWN', message: 'dispatch failed' }
  return r.result
}
const matDeps = { db: w.db, caller: svcCaller, executionRootsDir: EXEC_ROOTS }
const putBlob = (digest: string, body: Uint8Array, mediaType = 'text/markdown'): void => {
  w.db
    .prepare(
      'INSERT OR IGNORE INTO content_blobs (digest, media_type, byte_length, body, external_ref, verified) VALUES (?,?,?,?,NULL,1)'
    )
    .run(digest, mediaType, body.byteLength, body)
}

// requiredText blob — reuse the pinned mandatory bytes
const rtDigest = String(fx.sourcePins['src/shared/ver05-source.md'])
void rtDigest
const anyBundle = q1(w.db, 'SELECT required_text_digest FROM context_bundles LIMIT 1')!
const requiredTextDigest = String(anyBundle.required_text_digest)

/** build + store a consumer-shape bundle; returns its digest */
function makeBundle(tag: string, components: Record<string, unknown>[]): string {
  const manifest = {
    schema: 'mahas.bundle-manifest/v1',
    requiredText: { digest: requiredTextDigest },
    components
  }
  const digest = sha256Hex(canonicalJson(manifest))
  w.db
    .prepare(
      `INSERT OR IGNORE INTO context_bundles
         (digest, interface_digest, implementation_id, implementation_revision,
          surface_digest, required_text_digest, manifest_json, source_observations_json)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      digest,
      String(fx.ifaceDigest['r-asm']),
      'impl-v5-asm',
      1,
      String(q1(w.db, 'SELECT digest FROM command_surfaces LIMIT 1')!.digest),
      requiredTextDigest,
      canonicalJson(manifest),
      '[]'
    )
  return digest
}
const skillComponent = (id: string, path: string, text: string, scope = 'checkout') => {
  const digest = sha256Hex(text)
  putBlob(digest, new TextEncoder().encode(text))
  return { componentId: id, kind: 'skill', digest, path, scope, activation: 'initial', loadPhase: 'initial' }
}
const err = async (fn: () => Promise<unknown>): Promise<{ code?: string; message?: string } | string> => {
  try {
    await fn()
    return 'published'
  } catch (e) {
    return { code: (e as { code?: string }).code, message: (e as { message?: string }).message }
  }
}
const envDigest = String(q1(w.db, 'SELECT digest FROM work_envelopes LIMIT 1')!.digest)
const seedExecution = (execId: string, bundleDigest: string): void => {
  if (q1(w.db, 'SELECT id FROM executions WHERE id=?', execId)) return
  const lp = `lp-${execId}`
  w.db
    .prepare(
      `INSERT OR IGNORE INTO launch_plans
         (id,assignment_id,assignment_revision,digest,bundle_digest,envelope_digest,
          surface_digest,state,process_spec_json,pins_json,reservations_json)
       VALUES (?,?,?,?,?,?,?,'planned','{}','{}','{}')`
    )
    .run(
      lp,
      fx.members.asm.assignmentId,
      1,
      `dg-${execId}`,
      bundleDigest,
      envDigest,
      String(q1(w.db, 'SELECT digest FROM command_surfaces LIMIT 1')!.digest)
    )
  const gen =
    ((q1(w.db, 'SELECT MAX(generation) g FROM executions WHERE member_id=?', fx.members.asm.memberId)?.g as number) ?? 0) + 1
  w.db
    .prepare(
      `INSERT OR IGNORE INTO executions
         (id,member_id,generation,host_id,launch_plan_id,state,liveness,
          process_identity_json,native_conversation_json,revision)
       VALUES (?,?,?,?,?,'materializing','live','{}','{}',1)`
    )
    .run(execId, fx.members.asm.memberId, gen, hostId, lp)
}

// ---------- shared workspace + checkout ------------------------------------
const wsTarget = join(REPO_ROOT, '.ver05-checkouts', `co-s4-e${E}`)
const wsR = await w.dispatch(opCtx(), 'workspace.prepare', {
  projectId: fx.projectId,
  placementIntent: { kind: 'folder', targetPath: wsTarget, hostId },
  ownerReservation: { ownerKind: 'execution', ownerId: 'exec-s4a' }
})
const ws = (wsR.result ?? {}) as { workspace?: { id: string }; checkout?: { canonicalPath: string } }
const workspaceId = String(ws.workspace?.id)
const checkoutPath = String(ws.checkout?.canonicalPath)
rec.check(
  's4.workspacePrepare',
  wsR.status === 'committed' && typeof ws.checkout?.canonicalPath === 'string',
  'shared canonical checkout prepared with write claim held by exec-s4a',
  `${wsR.status} path=${checkoutPath}`
)

// ---------- s4a: two roles → same checkout path ----------------------------
// role A's bundle installs the skill; role B's bundle (different bytes, same
// path) reaches install under the same held claim → file-level guard fires.
const pathShared = '.agents/skills/ver05/SHARED-SKILL.md'
const bundleA = makeBundle('s4a', [skillComponent('skill-role-a', pathShared, '# role A skill\n')])
const bundleB = makeBundle('s4b', [skillComponent('skill-role-b', pathShared, '# role B skill — different bytes\n')])
seedExecution('exec-s4a', bundleA)
const pubA = await materializeBundle(matDeps, {
  executionId: 'exec-s4a' as never,
  bundleDigest: bundleA as never,
  workspaceId: workspaceId as never,
  claimOwner: { kind: 'execution', id: 'exec-s4a' }
})
const aFile = join(checkoutPath, pathShared)
const bRes = await err(() =>
  materializeBundle(matDeps, {
    executionId: 'exec-s4b' as never,
    bundleDigest: bundleB as never,
    workspaceId: workspaceId as never,
    claimOwner: { kind: 'execution', id: 'exec-s4a' } // B slides under A's held claim
  })
)
rec.check(
  's4a.roleAInstalled',
  pubA.outcome === 'published' && existsSync(aFile) && readFileSync(aFile, 'utf8') === '# role A skill\n',
  'role A skill installed into the shared checkout',
  `outcome=${pubA.outcome} file=${aFile}`
)
rec.check(
  's4a.roleBConflict',
  typeof bRes === 'object' && bRes.code === 'OPERATION_CONFLICT' && readFileSync(aFile, 'utf8') === '# role A skill\n',
  "role B's bundle on the same path → OPERATION_CONFLICT 'checkout target already exists'; A's bytes untouched",
  `${JSON.stringify(bRes)} file=${readFileSync(aFile, 'utf8').trim()}`
)
rec.artifact('s4a', { pubA: { outcome: pubA.outcome, routes: pubA.routes }, bRes })

// ---------- s4b: second execution, no held claim ----------------------------
const cRes = await err(() =>
  materializeBundle(matDeps, {
    executionId: 'exec-s4c' as never,
    bundleDigest: makeBundle('s4c', [skillComponent('skill-c', '.agents/skills/ver05/OTHER.md', '# other\n')]) as never,
    workspaceId: workspaceId as never,
    claimOwner: { kind: 'execution', id: 'exec-s4c' }
  })
)
rec.check(
  's4b.noClaimDenied',
  typeof cRes === 'object' && cRes.code === 'SCOPE_DENIED',
  "a different execution without a held write claim → SCOPE_DENIED before any file is touched",
  JSON.stringify(cRes)
)

// ---------- s4c: same-path collision inside ONE bundle ----------------------
const dupRes = await err(() =>
  materializeBundle(matDeps, {
    executionId: 'exec-s4d' as never,
    bundleDigest: makeBundle('s4d', [
      skillComponent('dup-1', 'components/dup.md', '# one\n', 'execution'),
      skillComponent('dup-2', 'components/dup.md', '# two\n', 'execution')
    ]) as never
  })
)
rec.check(
  's4c.inBundleDupPath',
  typeof dupRes === 'object' && dupRes.code === 'OPERATION_CONFLICT' && /collision/.test(dupRes.message ?? ''),
  'two components claiming the same output path in one bundle → OPERATION_CONFLICT at plan',
  JSON.stringify(dupRes)
)

// ---------- s4d: pre-existing shared AGENTS.md/CLAUDE.md coexist ------------
const agentsPath = join(checkoutPath, 'AGENTS.md')
const claudePath = join(checkoutPath, 'CLAUDE.md')
writeFileSync(agentsPath, '# shared project instructions (human-authored)\n')
writeFileSync(claudePath, '# shared claude memory (human-authored)\n')
const bundleCoex = makeBundle('s4e', [skillComponent('skill-coex', '.agents/skills/ver05/COEX.md', '# coex\n')])
seedExecution('exec-s4e', bundleCoex)
const coexRes = await materializeBundle(matDeps, {
  executionId: 'exec-s4e' as never,
  bundleDigest: bundleCoex as never,
  workspaceId: workspaceId as never,
  claimOwner: { kind: 'execution', id: 'exec-s4a' }
})
const coexOk =
  coexRes.outcome === 'published' &&
  readFileSync(agentsPath, 'utf8') === '# shared project instructions (human-authored)\n' &&
  readFileSync(claudePath, 'utf8') === '# shared claude memory (human-authored)\n' &&
  existsSync(join(checkoutPath, '.agents/skills/ver05/COEX.md'))
rec.check(
  's4d.sharedFilesCoexist',
  coexOk,
  'pre-existing shared AGENTS.md/CLAUDE.md untouched; unrelated components still install',
  `outcome=${coexRes.outcome} agentsIntact=${readFileSync(agentsPath, 'utf8').includes('human-authored')}`
)

// ---------- s4e: reserved basenames at depth / case -------------------------
for (const [tag, p] of [
  ['depth', 'sub/dir/AGENTS.md'],
  ['case', 'skills/Agents.MD'],
  ['claude', 'x/y/CLAUDE.md']
] as const) {
  const r = await err(() =>
    materializeBundle(matDeps, {
      executionId: `exec-s4e-${tag}` as never,
      bundleDigest: makeBundle(`s4e-${tag}`, [skillComponent(`res-${tag}`, p, '# nope\n')]) as never,
      workspaceId: workspaceId as never,
      claimOwner: { kind: 'execution', id: 'exec-s4a' }
    })
  )
  rec.check(
    `s4e.reserved.${tag}`,
    typeof r === 'object' && r.code === 'MODEL_INVALID' && /shared instruction/.test(r.message ?? ''),
    `checkout-scoped ${p} refused (basename reserved at any depth, case-insensitive)`,
    JSON.stringify(r)
  )
}

// ---------- s4f: path escapes -----------------------------------------------
for (const [tag, p, scope] of [
  ['dotdot', '../escape.md', 'checkout'],
  ['execdotdot', '../escape.md', 'execution'],
  ['dot', 'a/./b.md', 'checkout'],
  ['abs', '/etc/passwd.md', 'checkout'],
  ['backslash', 'a\\b.md', 'checkout']
] as const) {
  const r = await err(() =>
    materializeBundle(matDeps, {
      executionId: `exec-s4f-${tag}` as never,
      bundleDigest: makeBundle(`s4f-${tag}`, [skillComponent(`esc-${tag}`, p, '# escape\n', scope)]) as never,
      workspaceId: workspaceId as never,
      claimOwner: { kind: 'execution', id: 'exec-s4a' }
    })
  )
  rec.check(
    `s4f.escape.${tag}`,
    typeof r === 'object' && r.code === 'MODEL_INVALID',
    `path '${p}' (${scope}) → MODEL_INVALID`,
    JSON.stringify(r)
  )
}

// ---------- s4g: symlinked ancestor -----------------------------------------
const realDir = join(checkoutPath, '.agents/skills/real')
mkdirSync(realDir, { recursive: true })
try {
  symlinkSync(realDir, join(checkoutPath, '.agents/skills/link'), 'dir')
} catch {
  /* link may already exist on re-run */
}
const symRes = await err(() =>
  materializeBundle(matDeps, {
    executionId: 'exec-s4g' as never,
    bundleDigest: makeBundle('s4g', [skillComponent('sym-1', '.agents/skills/link/SKILL.md', '# via symlink\n')]) as never,
    workspaceId: workspaceId as never,
    claimOwner: { kind: 'execution', id: 'exec-s4a' }
  })
)
rec.check(
  's4g.symlinkAncestor',
  typeof symRes === 'object' && symRes.code === 'MODEL_INVALID' && /symlink/.test(symRes.message ?? ''),
  'component path through a symlinked checkout ancestor → MODEL_INVALID',
  JSON.stringify(symRes)
)

// ---------- s4h: same workspace, disjoint path under same claim → ok --------
const bundleOk = makeBundle('s4h', [skillComponent('skill-ok', '.agents/skills/ver05/OK.md', '# ok\n')])
seedExecution('exec-s4h', bundleOk)
const okRes = await materializeBundle(matDeps, {
  executionId: 'exec-s4h' as never,
  bundleDigest: bundleOk as never,
  workspaceId: workspaceId as never,
  claimOwner: { kind: 'execution', id: 'exec-s4a' }
})
rec.check(
  's4h.disjointPathOk',
  okRes.outcome === 'published' && existsSync(join(checkoutPath, '.agents/skills/ver05/OK.md')),
  'a second materialization under the same held claim on a disjoint path publishes fine — collisions are per-path, not per-checkout',
  `outcome=${okRes.outcome}`
)

rec.artifact('checkoutContents', {
  path: checkoutPath,
  files: [
    'AGENTS.md',
    'CLAUDE.md',
    pathShared,
    '.agents/skills/ver05/COEX.md',
    '.agents/skills/ver05/OK.md'
  ].map((rel) => {
    const p = join(checkoutPath, rel)
    return { rel, exists: existsSync(p), sha256: existsSync(p) ? sha256Hex(readFileSync(p)) : null }
  }),
  receipts: qa(w.db, "SELECT execution_id,phase,revision FROM injection_receipts WHERE execution_id LIKE 'exec-s4%'")
})

w.runtime.close()
rec.flush()
