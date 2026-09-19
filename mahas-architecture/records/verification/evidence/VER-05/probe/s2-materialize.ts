// s2 — materialization seam: can a compiled ContextBundle become real files?
//
//   s2a  REAL compiled bundle (from s1b context.build) → materializeBundle.
//        The compiler writes manifest components {blobDigest,installPath,
//        loadRoutes}; component-store.parseBundleManifest requires
//        {digest,path,loadPhase,route} → documented schema break.
//   s2b  consumer-shape bundle (same blobs/pins, translated manifest) →
//        full input (envelope+connection+cli) → published execution root:
//        mandatory bytes, task/initial.txt, routes with byte digests,
//        'materialized' injection receipt, replay + drift checks.
//   s2c  composition-adapter shape — composition.ts:382-386 forwards ONLY
//        {executionId,bundleDigest,workspaceId}: envelope/connection/cli
//        are dropped → firstInput absent. Evidence for the launch seam.
//   s2d  checkout scope — real workspace.prepare through the attached
//        execution host → real claim → checkout-scoped install; then
//        AGENTS.md/CLAUDE.md reserved-path and collision refusals.
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  Recorder, wire, opCtx, memberCtx, loadState, sha256Hex, CHECKOUT_A, REPO_ROOT, q1
} from './common.ts'
import { materializeBundle } from 'file:///tmp/mahas-ver-05/src/packages/mahas-runtime/src/realization/materializer.ts'
import { canonicalJson } from 'file:///tmp/mahas-ver-05/src/packages/mahas-runtime/src/realization/component-store.ts'

const rec = new Recorder('s2-materialize')
const w = await wire('s2')
const fx = loadState().fixture as Record<string, any>
const hostId = String(w.hostId)
const EXEC_ROOTS = '/tmp/mahas-ver-05/executions'
const { rmSync: rmRoots } = await import('node:fs')
rmRoots(EXEC_ROOTS, { recursive: true, force: true })
mkdirSync(EXEC_ROOTS, { recursive: true })

/** service ctx — the same shape composeRuntime mints for cross-domain calls
 *  (composition.ts:270-275: principalId 'service:*'). NOTE: composeRuntime
 *  seeds only 'operator-local' — 'service:mahasd' has NO principal row or
 *  grants, so effectiveActionsFor returns [] and every deps.caller dispatch
 *  through admission returns UNAVAILABLE_OPERATION at this revision. The
 *  probe mints the principal + least-privilege grant the composition should
 *  have provided; without it, workspace.inspect inside materializeBundle is
 *  unreachable — itself evidence for the seam finding. */
w.db.prepare("INSERT OR IGNORE INTO principals(id,kind,status) VALUES('service:ver05','service','active')").run()
w.db
  .prepare(
    `INSERT OR IGNORE INTO grants(id, revision, kind, principal_id, parent_grant_id, policy_id,
       policy_revision, expires_at, revoked_at, scope_json, actions_json)
     VALUES ('grant-service-ver05', 1, 'assignment', 'service:ver05', NULL, NULL, NULL, NULL, NULL, ?, ?)`
  )
  .run(JSON.stringify({ targets: [{ kind: '*', id: '*' }] }), JSON.stringify(['workspace.inspect']))
// evidence FIRST: the ctx composition.ts:270 actually mints — 'service:mahasd'
// — has no principal row → UNAVAILABLE_OPERATION through real admission.
const realSvc = await w.dispatch(
  {
    principalId: 'service:mahasd',
    controllerEpoch: w.epoch,
    grantRevisions: {},
    transportSessionId: `ver05:svc-real:${process.pid}`
  } as never,
  'workspace.inspect',
  { workspaceId: 'ws-any' }
)
rec.check(
  's2.servicePrincipalUnseeded',
  realSvc.status === 'rejected' && realSvc.error?.code === 'UNAVAILABLE_OPERATION',
  "composition's service:mahasd ctx cannot reach ANY op through admission (no principal/grants)",
  `${realSvc.status} ${realSvc.error?.code}`
)
rec.artifact('s2.servicePrincipalUnseeded', realSvc)

const svcCtx = {
  principalId: 'service:ver05',
  controllerEpoch: w.epoch,
  grantRevisions: { 'grant-service-ver05': 1 },
  transportSessionId: `ver05:svc:${process.pid}`
}
const svcCaller = async (operation: string, payload?: unknown): Promise<unknown> => {
  const r = await w.dispatch(svcCtx as never, operation, payload)
  if (r.status !== 'committed') throw r.error ?? { code: 'UNKNOWN', message: 'dispatch failed' }
  return r.result
}
const matDeps = { db: w.db, caller: svcCaller, executionRootsDir: EXEC_ROOTS }
const putBlob = (digest: string, body: Uint8Array, mediaType: string): void => {
  w.db
    .prepare(
      'INSERT OR IGNORE INTO content_blobs (digest, media_type, byte_length, body, external_ref, verified) VALUES (?,?,?,?,NULL,1)'
    )
    .run(digest, mediaType, body.byteLength, body)
}

/** injection_receipts.execution_id → executions.id (FK); launch_plans FKs to
 *  real digest rows. Seed the minimal parents the coordinator would have
 *  created — call AFTER compiled/envRow are known. */
function seedExecution(execId: string, memberId?: string): void {
  const lp = `lp-${execId}`
  const member = memberId ?? fx.members.asm.memberId
  // (member_id,generation) is UNIQUE and the DB persists across probe runs —
  // reuse the existing row, else take the member's next free generation.
  const existing = q1(w.db, 'SELECT id FROM executions WHERE id=?', execId)
  if (existing) return
  const gen =
    ((q1(w.db, 'SELECT MAX(generation) g FROM executions WHERE member_id=?', member)?.g as number) ?? 0) + 1
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
      consumerDigest,
      String(envRow.digest),
      String(compiled.surface_digest)
    )
  w.db
    .prepare(
      `INSERT OR IGNORE INTO executions
         (id,member_id,generation,host_id,launch_plan_id,state,liveness,
          process_identity_json,native_conversation_json,revision)
       VALUES (?,?,?,?,?,'materializing','live','{}','{}',1)`
    )
    .run(execId, member, gen, hostId, lp)
}

// ---------- pick the real compiled bundle for impl-v5-lead -------------------
const bundleRows = w.db
  .prepare(
    `SELECT digest, manifest_json, interface_digest, implementation_id,
            implementation_revision, surface_digest, required_text_digest
       FROM context_bundles WHERE implementation_id='impl-v5-lead'`
  )
  .all() as Record<string, unknown>[]
const compiled = bundleRows.find(
  (r) =>
    String(r.manifest_json).includes('"blobDigest"') &&
    String(
      (q1(w.db, 'SELECT actions_and_schemas_json FROM command_surfaces WHERE digest=?', String(r.surface_digest)) ?? {})
        .actions_and_schemas_json ?? ''
    ).includes('"actions"')
)!
const compiledDigest = String(compiled.digest)
const compiledManifest = JSON.parse(String(compiled.manifest_json))
rec.artifact('s2.compiledBundle', {
  digest: compiledDigest,
  surfaceDigest: compiled.surface_digest,
  componentFields: Object.keys((compiledManifest.components as object[])[0])
})

// ---------- s2a: real compiled bundle → materializer -------------------------
let s2a: { code?: string; message?: string } | string = 'published'
try {
  const r = await materializeBundle(matDeps, {
    executionId: 'exec-s2a' as never,
    bundleDigest: compiledDigest as never
  })
  s2a = `UNEXPECTED published root=${r.executionRoot}`
} catch (e) {
  s2a = { code: (e as { code?: string }).code, message: (e as { message?: string }).message }
}
rec.check(
  's2a.compiledBundleRejected',
  typeof s2a === 'object' && s2a.code === 'MODEL_INVALID' && /missing digest/.test(s2a.message ?? ''),
  'compiled manifest shape is unreadable to the materializer (MODEL_INVALID missing digest)',
  JSON.stringify(s2a)
)
rec.artifact('s2a.compiledBundleRejected', s2a)

// ---------- s2b: consumer-shape bundle → published root ----------------------
// Translate the compiled manifest into the shape parseBundleManifest accepts —
// identical blob bytes and pins, only field names differ.
const consumerManifest = {
  schema: 'mahas.bundle-manifest/v1',
  requiredText: { digest: String(compiled.required_text_digest), path: 'role/mandatory.md' },
  components: (compiledManifest.components as Record<string, unknown>[]).map((c) => ({
    componentId: c.componentId,
    kind: c.kind,
    digest: c.blobDigest,
    path: c.installPath,
    scope: 'execution',
    activation: c.activation,
    loadPhase: c.activation
  }))
}
const consumerDigest = sha256Hex(canonicalJson(consumerManifest))
w.db
  .prepare(
    `INSERT OR IGNORE INTO context_bundles
       (digest, interface_digest, implementation_id, implementation_revision,
        surface_digest, required_text_digest, manifest_json, source_observations_json)
     VALUES (?,?,?,?,?,?,?,?)`
  )
  .run(
    consumerDigest,
    String(compiled.interface_digest),
    'impl-v5-lead',
    1,
    String(compiled.surface_digest),
    String(compiled.required_text_digest),
    canonicalJson(consumerManifest),
    '[]'
  )

// real work-envelope bytes → envelope input (asm assignment, pinned in s1d)
const envRow = q1(
  w.db,
  'SELECT digest, body_digest, bindings_json FROM work_envelopes WHERE assignment_id=?',
  fx.members.asm.assignmentId
)!
const envBody = JSON.parse(
  Buffer.from((q1(w.db, 'SELECT body FROM content_blobs WHERE digest=?', envRow.body_digest as string)!.body as Uint8Array)).toString('utf8')
)
const initialText = String(envBody.requirementText ?? envBody.mandateText ?? 'ver05 initial input')
const envelopeInput = {
  digest: String(envRow.digest),
  initialText,
  envelopeJson: { digest: envRow.digest, body: envBody, bindings: JSON.parse(String(envRow.bindings_json)) }
}
for (const id of [
  'exec-s2a', 'exec-s2b', 'exec-s2b-plannersurf', 'exec-s2c', 'exec-s2d', 'exec-s2d-foreign',
  'exec-s2d-noclaim', 'exec-s2d-AGENTSmd', 'exec-s2d-CLAudemd', 'exec-s2d-docsAGENTSmd'
]) seedExecution(id)
const connBytes = new TextEncoder().encode('ver05-worker-credential-placeholder')
const pub = await materializeBundle(matDeps, {
  executionId: 'exec-s2b' as never,
  memberId: fx.members.asm.memberId,
  launchPlanId: 'plan-s2b' as never,
  bundleDigest: consumerDigest as never,
  envelope: envelopeInput,
  connection: { files: [{ name: 'worker.token', bytes: connBytes }] },
  cli: { executablePath: '/tmp/mahas-ver-05/coop/recorder.mjs', endpoint: 'unix:///tmp/mahas-ver-05/config/mahasd.sock' }
})

const root = pub.executionRoot
const fileAt = (rel: string): { exists: boolean; mode?: number; digest?: string } => {
  const p = join(root, rel)
  if (!existsSync(p)) return { exists: false }
  return { exists: true, mode: statSync(p).mode & 0o777, digest: sha256Hex(readFileSync(p)) }
}
const exManifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const rtBlob = q1(w.db, 'SELECT body FROM content_blobs WHERE digest=?', String(compiled.required_text_digest))!
const rtBytes = Buffer.from(rtBlob.body as Uint8Array)

rec.check('s2b.published', pub.outcome === 'published', 'consumer-shape bundle publishes an execution root', pub.executionRoot)
rec.check(
  's2b.mandatoryBytes',
  fileAt('role/mandatory.md').digest === String(compiled.required_text_digest) &&
    readFileSync(join(root, 'role/mandatory.md'), 'utf8').includes('SHARED-MARKER-7f3a91'),
  'role/mandatory.md carries the pinned requiredText bytes (mode 0444)',
  `digest=${fileAt('role/mandatory.md').digest} mode=${fileAt('role/mandatory.md').mode?.toString(8)}`
)
rec.check(
  's2b.initialTxt',
  fileAt('task/initial.txt').digest === sha256Hex(initialText) && pub.firstInput?.text === initialText,
  'task/initial.txt carries the real first-input text (REQ-07)',
  `digest=${fileAt('task/initial.txt').digest} firstInputDigest=${pub.firstInput?.digest}`
)
rec.check(
  's2b.envelopeJson',
  fileAt('task/envelope.json').exists && fileAt('task/envelope.json').mode === 0o444,
  'task/envelope.json pins the exact envelope revisions',
  `mode=${fileAt('task/envelope.json').mode?.toString(8)}`
)
const cmds = fileAt('surface/commands.md')
const cmdsBody = cmds.exists ? readFileSync(join(root, 'surface/commands.md'), 'utf8') : ''
rec.check(
  's2b.commandsMd',
  cmds.exists && cmdsBody.includes('## execution.join') && cmdsBody.includes('## task.accept'),
  'surface/commands.md lists real operation names from the surface snapshot',
  `hasJoin=${cmdsBody.includes('## execution.join')} hasAccept=${cmdsBody.includes('## task.accept')}`
)
const conn = fileAt('connection/worker.token')
const manifestConn = (exManifest.files as Record<string, unknown>[]).find((f) => f.path === 'connection/worker.token')
rec.check(
  's2b.connectionPrivate',
  conn.exists && conn.mode === 0o600 && manifestConn?.private === true && manifestConn?.digest === undefined,
  'connection file staged 0600, flagged private, digest absent from manifest',
  `mode=${conn.mode?.toString(8)} private=${manifestConn?.private} digest=${manifestConn?.digest}`
)
const binM = fileAt('bin/mahas')
rec.check(
  's2b.cliLauncher',
  binM.exists && binM.mode === 0o755 && readFileSync(join(root, 'bin/mahas'), 'utf8').includes('exec '),
  'bin/mahas launcher rendered executable (0755)',
  `mode=${binM.mode?.toString(8)}`
)
const routesOk = (pub.routes as { componentId: string; byteDigest: string; actualPath: string; loadingPhase: string }[]).every(
  (r) => r.byteDigest && r.actualPath.startsWith(root) && existsSync(r.actualPath)
)
rec.check(
  's2b.routeEvidence',
  pub.routes.length >= (consumerManifest.components as unknown[]).length && routesOk,
  'route evidence: component → actualPath → byteDigest → loadingPhase',
  `routes=${pub.routes.length}`
)
const mReceipt = q1(
  w.db,
  "SELECT phase, revision, components_json, evidence_json FROM injection_receipts WHERE execution_id='exec-s2b' AND phase='materialized'"
)
rec.check(
  's2b.materializedReceipt',
  mReceipt !== null && mReceipt !== undefined,
  "'materialized' injection receipt recorded",
  mReceipt ? `rev=${mReceipt.revision}` : 'absent'
)
rec.artifact('s2b.materializeResult', {
  outcome: pub.outcome,
  executionRoot: pub.executionRoot,
  manifestDigest: pub.manifestDigest,
  files: pub.files,
  routes: pub.routes,
  firstInput: pub.firstInput,
  pins: pub.pins,
  effectId: pub.effectId,
  residuals: pub.residualResources,
  receipt: mReceipt ? { phase: mReceipt.phase, revision: mReceipt.revision, evidence: JSON.parse(String(mReceipt.evidence_json)) } : null
})

// replay — same execution+bundle → 'replayed', no double receipt
const replay = await materializeBundle(matDeps, {
  executionId: 'exec-s2b' as never,
  bundleDigest: consumerDigest as never,
  envelope: envelopeInput
})
rec.check('s2b.replay', replay.outcome === 'replayed', 're-materializing same bundle replays', replay.outcome)

// drift — corrupt a published file → ARTIFACT_MISMATCH on next materialize
// (0444 is the materializer's own pin — the drift simulation must chmod first)
const { chmodSync } = await import('node:fs')
chmodSync(join(root, 'task/envelope.json'), 0o644)
writeFileSync(join(root, 'task/envelope.json'), '{"drifted":true}\n')
let drift: string | { code?: string } = 'ok'
try {
  await materializeBundle(matDeps, { executionId: 'exec-s2b' as never, bundleDigest: consumerDigest as never })
} catch (e) {
  drift = { code: (e as { code?: string }).code }
}
rec.check(
  's2b.driftDetected',
  typeof drift === 'object' && drift.code === 'ARTIFACT_MISMATCH',
  'published-root drift → ARTIFACT_MISMATCH on re-verify',
  JSON.stringify(drift)
)
writeFileSync(join(root, 'task/envelope.json'), canonicalJson(envelopeInput.envelopeJson)) // restore

// planner-shape surface through the materializer — {allowed:[…]} renders as
// "(empty surface)" in commands.md: the same shape break poisons the
// materialized artifact, not just the compiler's permitted-commands block.
const plannerSurfRow = q1(
  w.db,
  "SELECT digest FROM command_surfaces WHERE actions_and_schemas_json LIKE '%\"allowed\"%' LIMIT 1"
)
if (plannerSurfRow) {
  const pm = {
    schema: 'mahas.bundle-manifest/v1',
    requiredText: { digest: String(compiled.required_text_digest) },
    components: [] as unknown[]
  }
  const pd = sha256Hex(canonicalJson(pm))
  w.db
    .prepare(
      `INSERT OR IGNORE INTO context_bundles
         (digest, interface_digest, implementation_id, implementation_revision,
          surface_digest, required_text_digest, manifest_json, source_observations_json)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(pd, String(compiled.interface_digest), 'impl-v5-lead', 1, String(plannerSurfRow.digest), String(compiled.required_text_digest), canonicalJson(pm), '[]')
  const pPub = await materializeBundle(matDeps, {
    executionId: 'exec-s2b-plannersurf' as never,
    bundleDigest: pd as never
  })
  const pCmds = readFileSync(join(pPub.executionRoot, 'surface/commands.md'), 'utf8')
  rec.check(
    's2b.plannerSurfaceCommandsMd',
    pCmds.includes('(empty surface'),
    'planner-minted {allowed:[…]} surface materializes as "(empty surface)" in commands.md',
    `empty=${pCmds.includes('(empty surface')}`
  )
}

// different bundle for the same execution → pin cannot move
let moved: string | { code?: string } = 'ok'
try {
  await materializeBundle(matDeps, { executionId: 'exec-s2b' as never, bundleDigest: ('0'.repeat(64)) as never })
} catch (e) {
  moved = { code: (e as { code?: string }).code }
}
rec.check(
  's2b.pinCannotMove',
  typeof moved === 'object' && (moved.code === 'INVALID_TRANSITION' || moved.code === 'MODEL_INVALID'),
  'a different bundle for a published execution is rejected',
  JSON.stringify(moved)
)

// ---------- s2c: composition-adapter shape (dropped fields) ------------------
// composition.ts:382-386 forwards ONLY {executionId,bundleDigest,workspaceId}.
const minimal = await materializeBundle(matDeps, {
  executionId: 'exec-s2c' as never,
  bundleDigest: consumerDigest as never
})
const cRoot = minimal.executionRoot
const cMissing = ['task/initial.txt', 'task/envelope.json', 'connection/worker.token', 'bin/mahas'].filter(
  (rel) => !existsSync(join(cRoot, rel))
)
rec.check(
  's2c.adapterDropsFields',
  minimal.firstInput === undefined && cMissing.length === 4,
  'adapter-shaped input publishes a root WITHOUT task/*, connection/*, bin/mahas — firstInput absent',
  `firstInput=${minimal.firstInput} missing=${cMissing.join(',')}`
)
rec.artifact('s2c.adapterResult', { outcome: minimal.outcome, files: minimal.files.map((f) => f.path), firstInput: minimal.firstInput })

// ---------- s2d: checkout scope through the REAL host ------------------------
// workspace.prepare via the operator ctx (fixture member grants cover the op
// but not project placement scope); the host enforces placement containment —
// target must live under the project's repository_root.
const wsTarget = join(REPO_ROOT, '.ver05-checkouts', 'co-a')
const wsR = await w.dispatch(opCtx(), 'workspace.prepare', {
  projectId: fx.projectId,
  placementIntent: { kind: 'folder', targetPath: wsTarget, hostId },
  ownerReservation: { ownerKind: 'execution', ownerId: 'exec-s2d' }
})
let ws = (wsR.result ?? {}) as { workspace?: { id: string }; checkout?: { canonicalPath: string }; effect?: { state: string } }
let wsNote = `${wsR.status} effect=${ws.effect?.state} path=${ws.checkout?.canonicalPath}`
if (wsR.status === 'rejected' && wsR.error?.code === 'RESOURCE_BUSY') {
  // prior probe run already holds this checkout for exec-s2d — reuse the
  // persisted rows (the claim is durable by design).
  const co = q1(w.db, 'SELECT id, canonical_path FROM checkouts WHERE canonical_path=?', wsTarget)
  const wsr = co ? q1(w.db, 'SELECT id FROM workspaces WHERE checkout_id=? ORDER BY rowid DESC', co.id) : null
  ws = { workspace: { id: String(wsr?.id) }, checkout: { canonicalPath: String(co?.canonical_path) }, effect: { state: 'reused' } }
  wsNote = `reused workspace=${wsr?.id} (RESOURCE_BUSY by our own prior claim)`
}
rec.check(
  's2d.workspacePrepare',
  (wsR.status === 'committed' && ws.effect?.state === 'confirmed') || ws.effect?.state === 'reused',
  'real host prepares the checkout folder + held write claim',
  wsNote
)
rec.artifact('s2d.workspacePrepare', wsR)
const workspaceId = ws.workspace?.id as string

// second writer on the same canonical checkout → prepare refuses RESOURCE_BUSY
// (runs BEFORE we touch the directory: the overlap scan needs the blocking
// checkout's stored identity to still match the live one)
const ws2R = await w.dispatch(opCtx(), 'workspace.prepare', {
  projectId: fx.projectId,
  placementIntent: { kind: 'folder', targetPath: wsTarget, hostId },
  ownerReservation: { ownerKind: 'execution', ownerId: 'exec-s2d-second' }
})
rec.check(
  's2d.secondWriterRefused',
  ws2R.status === 'rejected' && ws2R.error?.code === 'RESOURCE_BUSY',
  'a second writer on the same canonical checkout is refused before launch',
  `${ws2R.status} ${ws2R.error?.code}: ${ws2R.error?.message}`
)
rec.artifact('s2d.secondWriterRefused', ws2R)

// reset the checkout contents (prior runs may have installed files)
const { rmSync } = await import('node:fs')
rmSync(wsTarget, { recursive: true, force: true })
mkdirSync(wsTarget, { recursive: true })

// consumer bundle with a checkout-scoped skill file
const coManifest = {
  schema: 'mahas.bundle-manifest/v1',
  requiredText: { digest: String(compiled.required_text_digest) },
  components: [
    {
      componentId: 'co-skill',
      kind: 'skill',
      digest: sha256Hex('# ver05 checkout skill\nSKILL-CHECKOUT-MARKER\n'),
      path: '.agents/skills/ver05/SKILL.md',
      scope: 'checkout',
      activation: 'initial',
      loadPhase: 'initial'
    }
  ]
}
putBlob(
  sha256Hex('# ver05 checkout skill\nSKILL-CHECKOUT-MARKER\n'),
  new TextEncoder().encode('# ver05 checkout skill\nSKILL-CHECKOUT-MARKER\n'),
  'text/markdown'
)
const coDigest = sha256Hex(canonicalJson(coManifest))
w.db
  .prepare(
    `INSERT OR IGNORE INTO context_bundles
       (digest, interface_digest, implementation_id, implementation_revision,
        surface_digest, required_text_digest, manifest_json, source_observations_json)
     VALUES (?,?,?,?,?,?,?,?)`
  )
  .run(
    coDigest,
    String(compiled.interface_digest),
    'impl-v5-lead',
    1,
    String(compiled.surface_digest),
    String(compiled.required_text_digest),
    canonicalJson(coManifest),
    '[]'
  )
const coPub = await materializeBundle(matDeps, {
  executionId: 'exec-s2d' as never,
  bundleDigest: coDigest as never,
  workspaceId: workspaceId as never,
  claimOwner: { kind: 'execution', id: 'exec-s2d' }
})
const coFile = join(ws.checkout!.canonicalPath, '.agents/skills/ver05/SKILL.md')
const coRoute = (coPub.routes as { componentId: string; actualPath: string; byteDigest: string }[]).find(
  (r) => r.componentId === 'co-skill'
)
rec.check(
  's2d.checkoutInstall',
  coPub.outcome === 'published' && existsSync(coFile) && coRoute?.actualPath === coFile,
  'checkout-scoped component lands in the REAL checkout; route evidence points at the canonical path',
  `path=${coFile} route=${coRoute?.actualPath}`
)
rec.artifact('s2d.checkoutInstall', { root: coPub.executionRoot, checkoutPath: ws.checkout?.canonicalPath, routes: coPub.routes })

// reserved basenames — shared instruction files can never be component output
for (const base of ['AGENTS.md', 'CLAUDE.md', 'docs/AGENTS.md']) {
  const m = {
    schema: 'mahas.bundle-manifest/v1',
    requiredText: { digest: String(compiled.required_text_digest) },
    components: [
      {
        componentId: 'co-bad',
        kind: 'instruction',
        digest: sha256Hex('x'),
        path: base,
        scope: 'checkout',
        activation: 'initial',
        loadPhase: 'initial'
      }
    ]
  }
  putBlob(
    sha256Hex('x'),
    new TextEncoder().encode('x'),
    'text/markdown'
  )
  const d = sha256Hex(canonicalJson(m))
  w.db
    .prepare(
      `INSERT OR IGNORE INTO context_bundles
         (digest, interface_digest, implementation_id, implementation_revision,
          surface_digest, required_text_digest, manifest_json, source_observations_json)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(d, String(compiled.interface_digest), 'impl-v5-lead', 1, String(compiled.surface_digest), String(compiled.required_text_digest), canonicalJson(m), '[]')
  let res: { code?: string; message?: string } | string = 'published'
  try {
    await materializeBundle(matDeps, {
      executionId: `exec-s2d-${base.replace(/[^a-z]/gi, '')}` as never,
      bundleDigest: d as never,
      workspaceId: workspaceId as never,
      claimOwner: { kind: 'execution', id: 'exec-s2d' }
    })
  } catch (e) {
    res = { code: (e as { code?: string }).code, message: (e as { message?: string }).message }
  }
  rec.check(
    `s2d.reserved.${base}`,
    typeof res === 'object' && res.code === 'MODEL_INVALID' && /shared instruction/.test(res.message ?? ''),
    `checkout-scoped ${base} refused at plan time`,
    JSON.stringify(res)
  )
}

// foreign file already at the target path → never overwrite another writer's
// bytes (the second-execution/same-collision case: claim is ours, file isn't)
const foreignRel = '.agents/skills/ver05/FOREIGN.md'
mkdirSync(join(ws.checkout!.canonicalPath, '.agents/skills/ver05'), { recursive: true })
writeFileSync(join(ws.checkout!.canonicalPath, foreignRel), 'foreign writer bytes\n')
const fm = {
  schema: 'mahas.bundle-manifest/v1',
  requiredText: { digest: String(compiled.required_text_digest) },
  components: [
    {
      componentId: 'co-foreign',
      kind: 'skill',
      digest: sha256Hex('# ours\n'),
      path: foreignRel,
      scope: 'checkout',
      activation: 'initial',
      loadPhase: 'initial'
    }
  ]
}
putBlob(
  sha256Hex('# ours\n'),
  new TextEncoder().encode('# ours\n'),
  'text/markdown'
)
const fDigest = sha256Hex(canonicalJson(fm))
w.db
  .prepare(
    `INSERT OR IGNORE INTO context_bundles
       (digest, interface_digest, implementation_id, implementation_revision,
        surface_digest, required_text_digest, manifest_json, source_observations_json)
     VALUES (?,?,?,?,?,?,?,?)`
  )
  .run(fDigest, String(compiled.interface_digest), 'impl-v5-lead', 1, String(compiled.surface_digest), String(compiled.required_text_digest), canonicalJson(fm), '[]')
let foreign: { code?: string; message?: string } | string = 'published'
try {
  await materializeBundle(matDeps, {
    executionId: 'exec-s2d-foreign' as never,
    bundleDigest: fDigest as never,
    workspaceId: workspaceId as never,
    claimOwner: { kind: 'execution', id: 'exec-s2d' }
  })
} catch (e) {
  foreign = { code: (e as { code?: string }).code, message: (e as { message?: string }).message }
}
const foreignStill = readFileSync(join(ws.checkout!.canonicalPath, foreignRel), 'utf8')
rec.check(
  's2d.existingTargetRefused',
  typeof foreign === 'object' && foreign.code === 'OPERATION_CONFLICT' && foreignStill === 'foreign writer bytes\n',
  'existing checkout target → OPERATION_CONFLICT, foreign bytes untouched',
  `${JSON.stringify(foreign)} stillForeign=${foreignStill === 'foreign writer bytes\n'}`
)

// execution without a claim → SCOPE_DENIED before any file is written
let noClaim: { code?: string } | string = 'published'
try {
  await materializeBundle(matDeps, {
    executionId: 'exec-s2d-noclaim' as never,
    bundleDigest: coDigest as never,
    workspaceId: workspaceId as never
  })
} catch (e) {
  noClaim = { code: (e as { code?: string }).code }
}
rec.check(
  's2d.noClaimDenied',
  typeof noClaim === 'object' && noClaim.code === 'SCOPE_DENIED',
  'checkout-scoped components without a held write claim → SCOPE_DENIED',
  JSON.stringify(noClaim)
)

w.runtime.close()
rec.flush()
