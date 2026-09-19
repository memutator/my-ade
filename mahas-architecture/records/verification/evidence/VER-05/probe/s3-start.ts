// s3 — worker.start end-to-end: real stage chain, real host spawn, join, accept.
//
//   s3a  REAL shipped path — worker.start through the composition registry
//        with the deps composition.ts wires verbatim. Expected ceiling:
//        resources_claimed — the coordinator's workspace.prepare payload
//        ({owner,reservationId,memberId,runId,purpose,mode}) lacks the op
//        contract's projectId/ownerReservation → INPUT_NOT_READY.
//   s3b  corrected glue — REAL stage handlers + REAL host spawn of the
//        cooperative recorder: only the two seam mismatches are translated
//        (call: coordinator payload → real workspace.prepare payload;
//        materialize: coordinator req → full MaterializeInput + wantBytes
//        byte read-back). Everything else is the shipped code path.
//   s3c  execution.join — negatives then the real join via the bootstrap
//        credential ctx through the REAL registry (bootstrap surface).
//   s3d  task.accept — worker-surface gap, dispatch-phase seam, negatives,
//        then a corrected-glue accept to verify handler semantics.
//   s3e  stdin route — coordinator writes spawnPayload.initialStdin
//        (payload level); host SpawnSpec reads spec.initialStdin — direct
//        host probes pin the field-placement break.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  Recorder, wire, memberCtx, loadState, sha256Hex, REPO_ROOT, OUT, COOP, NODE_BIN, q1, qa
} from './common.ts'
import { workerStart } from 'file:///tmp/mahas-ver-05/src/packages/mahas-runtime/src/launch/start-coordinator.ts'
import { resolveDeps, canonicalJson, type LaunchDeps } from 'file:///tmp/mahas-ver-05/src/packages/mahas-runtime/src/launch/deps.ts'
import { materializeBundle } from 'file:///tmp/mahas-ver-05/src/packages/mahas-runtime/src/realization/materializer.ts'
import { canonicalJson as bundleCanonicalJson } from 'file:///tmp/mahas-ver-05/src/packages/mahas-runtime/src/realization/component-store.ts'
import { buildTaskEnvelope } from 'file:///tmp/mahas-ver-05/src/packages/mahas-runtime/src/coordination/work-envelope.ts'

const rec = new Recorder('s3-start')
const w = await wire('s3')
const fx = loadState().fixture as Record<string, any>
const hostId = String(w.hostId ?? fx.hostId)
const hostInc = String(fx.hostIncarnation)
const E = w.epoch
const EXEC_ROOTS = '/tmp/mahas-ver-05/executions'

// service ctx — same corrected service principal as s2 (composition's real
// 'service:mahasd' ctx has no principal/grants — recorded at s2.servicePrincipalUnseeded)
w.db.prepare("INSERT OR IGNORE INTO principals(id,kind,status) VALUES('service:ver05','service','active')").run()
w.db
  .prepare(
    `INSERT OR REPLACE INTO grants(id, revision, kind, principal_id, parent_grant_id, policy_id,
       policy_revision, expires_at, revoked_at, scope_json, actions_json)
     VALUES ('grant-service-ver05', 1, 'assignment', 'service:ver05', NULL, NULL, NULL, NULL, NULL, ?, ?)`
  )
  .run(
    JSON.stringify({ targets: [{ kind: '*', id: '*' }] }),
    JSON.stringify(['workspace.inspect', 'workspace.prepare', 'context.build'])
  )
const svcCtx = {
  principalId: 'service:ver05',
  controllerEpoch: E,
  grantRevisions: { 'grant-service-ver05': 1 },
  transportSessionId: `ver05:svc-s3:${process.pid}`
}
const svcCaller = async (operation: string, payload?: unknown): Promise<unknown> => {
  const r = await w.dispatch(svcCtx as never, operation, payload)
  if (r.status !== 'committed') throw r.error ?? { code: 'UNKNOWN', message: 'dispatch failed' }
  return r.result
}
const matDeps = { db: w.db, caller: svcCaller, executionRootsDir: EXEC_ROOTS }

// ---------- helpers ---------------------------------------------------------

/** a fresh task-member tuple (principal/member/grant/task/assignment/envelope)
 *  cloned from the fixture asm member so every start attempt binds a member
 *  that is not already bound to an execution. */
function cloneTaskMember(tag: string): {
  memberId: string; assignmentId: string; taskId: string; grantId: string
} {
  const sfx = `${tag}-e${E}`
  const memberId = `mem-ver05-${sfx}`
  const asgId = `asg-ver05-${sfx}`
  const taskId = `t-${sfx}`
  const grantId = `grt-s3-${sfx}`
  const base = q1(w.db, 'SELECT * FROM grants WHERE id=?', fx.members.asm.grantId)!
  const asmImpl = fx.impls['r-asm']
  w.db.prepare("INSERT OR IGNORE INTO principals(id,kind,status) VALUES(?,'member','active')").run(memberId)
  w.db
    .prepare(
      "INSERT OR IGNORE INTO members(id,run_id,model_version,role_id,implementation_id,implementation_revision,generation,current_execution_id,state,revision) VALUES(?,?,?,?,?,?,1,NULL,'assigned',1)"
    )
    .run(memberId, fx.runId, fx.mv1, 'r-asm', asmImpl.implId, asmImpl.revision)
  w.db
    .prepare('INSERT OR IGNORE INTO tasks(id,run_id,current_revision,current_dispatch_id) VALUES(?,?,1,NULL)')
    .run(taskId, fx.runId)
  w.db
    .prepare(
      `INSERT OR IGNORE INTO task_specs(task_id,revision,title,requirement_text,owner_role_id,assigned_member_id,inputs_json,outputs_json,settlement_policy_json)
       VALUES(?,1,?,?,?,NULL,'[]','[]','{}')`
    )
    .run(taskId, `VER-05 s3 ${tag} task`, `VER-05 s3 ${tag} requirement — inspect the materialized inputs and report`, 'r-asm')
  w.db
    .prepare(
      `INSERT OR IGNORE INTO grants(id,revision,kind,principal_id,parent_grant_id,policy_id,policy_revision,
         expires_at,revoked_at,scope_json,actions_json) VALUES(?,1,?,?,NULL,NULL,NULL,NULL,NULL,?,?)`
    )
    .run(grantId, String(base.kind), memberId, String(base.scope_json), String(base.actions_json))
  const scope = JSON.parse(String(q1(w.db, 'SELECT scope_json FROM assignments WHERE id=?', fx.members.asm.assignmentId)!.scope_json))
  scope.taskIds = [taskId]
  w.db
    .prepare(
      "INSERT OR IGNORE INTO assignments(id,revision,member_id,kind,mandate_text,grant_id,task_id,task_revision,scope_json) VALUES(?,1,?,'task',?,?,?,1,?)"
    )
    .run(asgId, memberId, `VER-05 s3 ${tag} mandate`, grantId, taskId, JSON.stringify(scope))
  buildTaskEnvelope(w.db, { assignmentId: asgId, assignmentRevision: 1, taskId, taskRevision: 1 })
  return { memberId, assignmentId: asgId, taskId, grantId }
}

/** consumer-shape bundle for impl-v5-asm — same translation as s2b */
function consumerBundle(): { digest: string; requiredTextDigest: string; surfaceDigest: string; initialText: string; envelopeDigest: string } {
  const rows = qa(
    w.db,
    `SELECT digest, manifest_json, interface_digest, surface_digest, required_text_digest
       FROM context_bundles WHERE implementation_id='impl-v5-asm'`
  )
  const compiled = rows.find(
    (r) =>
      String(r.manifest_json).includes('"blobDigest"') &&
      String(
        (q1(w.db, 'SELECT actions_and_schemas_json FROM command_surfaces WHERE digest=?', String(r.surface_digest)) ?? {})
          .actions_and_schemas_json ?? ''
      ).includes('"actions"')
  )!
  const cm = JSON.parse(String(compiled.manifest_json))
  const manifest = {
    schema: 'mahas.bundle-manifest/v1',
    requiredText: { digest: String(compiled.required_text_digest), path: 'role/mandatory.md' },
    components: (cm.components as Record<string, unknown>[]).map((c) => ({
      componentId: c.componentId,
      kind: c.kind,
      digest: c.blobDigest,
      path: c.installPath,
      scope: 'execution',
      activation: c.activation,
      loadPhase: c.activation
    }))
  }
  const digest = sha256Hex(bundleCanonicalJson(manifest))
  w.db
    .prepare(
      `INSERT OR IGNORE INTO context_bundles
         (digest, interface_digest, implementation_id, implementation_revision,
          surface_digest, required_text_digest, manifest_json, source_observations_json)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      digest,
      String(compiled.interface_digest),
      'impl-v5-asm',
      1,
      String(compiled.surface_digest),
      String(compiled.required_text_digest),
      bundleCanonicalJson(manifest),
      '[]'
    )
  return {
    digest,
    requiredTextDigest: String(compiled.required_text_digest),
    surfaceDigest: String(compiled.surface_digest)
  } as never
}

const bundle = consumerBundle()
const rtBlob = q1(w.db, 'SELECT body FROM content_blobs WHERE digest=?', bundle.requiredTextDigest)!
const rtBytes = Buffer.from(rtBlob.body as Uint8Array)

/** insert a launch_plans row in the exact shape workerStart parses */
function insertPlan(tag: string, m: ReturnType<typeof cloneTaskMember>, spec: unknown, targetPath: string): { planId: string; planDigest: string; envelopeDigest: string } {
  const envRow = q1(w.db, 'SELECT digest, body_digest FROM work_envelopes WHERE assignment_id=?', m.assignmentId)!
  const envelopeDigest = String(envRow.digest)
  const asmImpl = fx.impls['r-asm']
  const pins = {
    assignment: { id: m.assignmentId, revision: 1, kind: 'task' },
    member: { id: m.memberId },
    run: { id: fx.runId, purpose: 'verification' },
    modelVersion: fx.mv1,
    roleId: 'r-asm',
    interfaceDigest: String(fx.ifaceDigest['r-asm']),
    implementation: { id: asmImpl.implId, revision: asmImpl.revision },
    harnessProfile: { id: fx.profileId, revision: fx.profileRevision },
    grant: { id: m.grantId, revision: 1 },
    policy: null,
    task: { id: m.taskId, revision: 1 },
    envelope: { digest: envelopeDigest },
    bundle: { digest: bundle.digest },
    surface: { digest: bundle.surfaceDigest },
    host: { id: hostId, incarnation: hostInc },
    placementIntent: { hostId, kind: 'folder', projectId: fx.projectId, targetPath },
    purpose: 'work',
    routes: [
      { source: 'role/mandatory.md', kind: 'argv-file', target: '--file', required: true },
      { source: 'task/initial.txt', kind: 'stdin', required: true }
    ],
    inputs: {}
  }
  const planId = `plan-s3-${tag}-e${E}`
  const planDigest = sha256Hex(canonicalJson({ pins, processSpec: spec }))
  w.db
    .prepare(
      `INSERT OR REPLACE INTO launch_plans
         (id,assignment_id,assignment_revision,digest,bundle_digest,envelope_digest,
          surface_digest,state,process_spec_json,pins_json,reservations_json)
       VALUES (?,?,?,?,?,?,?,'planned',?,?,?)`
    )
    .run(planId, m.assignmentId, 1, planDigest, bundle.digest, envelopeDigest, bundle.surfaceDigest, JSON.stringify(spec), JSON.stringify(pins), '[]')
  return { planId, planDigest, envelopeDigest }
}

// NOTE: PlannedProcessSpec.executable is dropped by buildSpawnSpec — only
// spec.argv entries reach the host's argv (resolveArgv iterates argv). A
// recipe whose executable field carries argv[0] silently spawns argv[1]
// instead (observed: spawn .../recorder.mjs EACCES). The spec below puts
// the interpreter in argv[0] explicitly — the workaround a recipe needs.
const recorderSpec = (recordPath: string) => ({
  executable: NODE_BIN, // informational only — see note above
  argv: [
    { literal: NODE_BIN },
    { literal: COOP },
    { literal: '--record-out' },
    { literal: recordPath },
    { slot: 'file', source: 'role/mandatory.md', flag: '--file' },
    { literal: '--echo-stdin' }
  ],
  stdio: 'pipes' as const,
  stdin: { source: 'task/initial.txt' },
  env: { VER05_MARKER: 's3-start' }
})

const stageSummary = (r: { stageReceipt?: { stages?: { stage: string; status: string; error?: { code?: string } }[]; failedStage?: string; terminal?: string } }) => {
  const st = r.stageReceipt?.stages ?? []
  return `terminal=${r.stageReceipt?.terminal ?? '-'} failed=${r.stageReceipt?.failedStage ?? '-'} ` +
    st.map((s) => `${s.stage}:${s.status}${s.error ? `(${s.error.code})` : ''}`).join(' ')
}

// ---------- s3a — REAL shipped path -----------------------------------------
// deps exactly as composition.ts:371-417 wires them (caller, hostClient,
// field-dropping materialize adapter, ensureEnvelope, storage helpers).
const m3a = cloneTaskMember('s3a')
const target3a = join(REPO_ROOT, '.ver05-checkouts', `co-s3a-e${E}`)
const plan3a = insertPlan('s3a', m3a, recorderSpec(`${OUT}/s3a-spawn-record.json`), target3a)

const leadCtx = memberCtx(fx.members.lead.memberId, { [fx.members.lead.grantId]: fx.members.lead.grantRevision })
const realStart = await w.dispatch(leadCtx, 'worker.start', {
  launchPlanId: plan3a.planId,
  planDigest: plan3a.planDigest,
  operationId: `ver05:s3a:${E}:001`
})
const realResult = (realStart.result ?? {}) as Parameters<typeof stageSummary>[0] & { executionId?: string }
const s3aFailed = realResult.stageReceipt?.failedStage
const s3aResError = realResult.stageReceipt?.stages?.find((s) => s.stage === 'resources_claimed')?.error
rec.check(
  's3a.realPathCeiling',
  realStart.status === 'committed' &&
    s3aFailed === 'resources_claimed' &&
    s3aResError?.code === 'INTERNAL' &&
    /INPUT_NOT_READY/.test(String((s3aResError as { message?: string })?.message ?? '')),
  "shipped path: worker.start dies at resources_claimed — coordinator's workspace.prepare payload lacks projectId/ownerReservation; the OperationCallError wrapper degrades the code to INTERNAL/'unknown' (reconcile) instead of the definitive rejection",
  `${realStart.status} ${stageSummary(realResult)}`
)
rec.artifact('s3a.realPath', {
  receipt: realStart,
  stageReceipt: realResult.stageReceipt,
  executionRow: realResult.executionId ? q1(w.db, 'SELECT id,member_id,generation,state,liveness FROM executions WHERE id=?', realResult.executionId) : null,
  memberRow: q1(w.db, 'SELECT id,generation,current_execution_id,state FROM members WHERE id=?', m3a.memberId),
  dispatchRow: realResult.executionId ? q1(w.db, 'SELECT id,phase,authority_state FROM dispatches WHERE execution_id=?', realResult.executionId) : null,
  effects: qa(w.db, 'SELECT id,kind,state FROM effect_intents WHERE operation_key=?', `worker.start:${plan3a.planId}`)
})

// ---------- s3b — corrected glue → full chain + real spawn -------------------
// The ONLY translations are the two documented seam mismatches:
//   call        — coordinator payload → real workspace.prepare payload
//   materialize — coordinator req → full MaterializeInput (envelope/connection/
//                 wantBytes), then read wantBytes back from the published root
// Stage handlers, effect journal, receipts, host spawn: shipped code verbatim.
const m3b = cloneTaskMember('s3b')
const target3b = join(REPO_ROOT, '.ver05-checkouts', `co-s3b-e${E}`)
const record3b = `${OUT}/s3b-spawn-record.json`
const plan3b = insertPlan('s3b', m3b, recorderSpec(record3b), target3b)
const envRow3b = q1(w.db, 'SELECT digest, body_digest, bindings_json FROM work_envelopes WHERE assignment_id=?', m3b.assignmentId)!
const envBody3b = JSON.parse(Buffer.from((q1(w.db, 'SELECT body FROM content_blobs WHERE digest=?', String(envRow3b.body_digest))!).body as Uint8Array).toString('utf8'))
const initialText3b = String(envBody3b.requirementText ?? envBody3b.mandateText ?? 'ver05 initial input')

const correctedDeps: LaunchDeps = {
  // CORRECTED GLUE — coordinator payload uses {owner,reservationId,memberId,
  // runId,purpose,mode}; workspace.prepare requires {projectId,placementIntent,
  // ownerReservation}. Translate and dispatch through the real registry.
  call: async (ctx, operation, payload) => {
    const p = payload as Record<string, any>
    if (operation === 'workspace.prepare') {
      const out = (await svcCaller('workspace.prepare', {
        projectId: fx.projectId,
        placementIntent: p.placementIntent,
        ownerReservation: { ownerKind: p.owner?.kind ?? 'execution', ownerId: p.owner?.id }
      })) as { workspace: { id: string }; checkout: { id: string; canonicalPath: string }; claim: unknown }
      return {
        checkoutId: out.checkout.id,
        checkoutPath: out.checkout.canonicalPath,
        workspaceId: out.workspace.id,
        claims: [out.claim]
      }
    }
    return svcCaller(operation, payload)
  },
  // REAL host resolver — the same client composition.ts wires
  host: (h: string) => (w.runtime as { hostClient?: (id: string) => Promise<never> }).hostClient!(h) as never,
  // CORRECTED GLUE — the composition adapter forwards only
  // {executionId,bundleDigest,workspaceId}; translate to the full port input
  // (envelope + connection secret files + claim owner) and return wantBytes.
  materialize: async (req) => {
    const res = await materializeBundle(matDeps, {
      executionId: req.executionId as never,
      memberId: m3b.memberId,
      launchPlanId: plan3b.planId as never,
      bundleDigest: req.bundleDigest as never,
      workspaceId: req.workspaceId as never,
      envelope: {
        digest: String(envRow3b.digest),
        initialText: initialText3b,
        envelopeJson: { digest: String(envRow3b.digest), body: envBody3b, bindings: JSON.parse(String(envRow3b.bindings_json)) }
      },
      connection: {
        files: (req.secretFiles ?? []).map((f) => ({ name: f.path.replace(/^connection\//, ''), bytes: f.bytes }))
      },
      cli: { executablePath: COOP, endpoint: 'unix:///tmp/mahas-ver-05/config/mahasd.sock' },
      claimOwner: { kind: 'execution', id: req.executionId }
    })
    const want = new Set(req.wantBytes ?? [])
    const files = res.files.map((f) => {
      const p = join(res.executionRoot, f.path)
      const bytes = want.has(f.path) && existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined
      return {
        path: f.path,
        digest: f.digest ?? sha256Hex(readFileSync(p)),
        byteLength: statSync(p).size,
        ...(bytes ? { bytes } : {}),
        verified: true
      }
    })
    return {
      executionRoot: res.executionRoot,
      manifestDigest: res.manifestDigest,
      files,
      receipts: res.routes,
      residuals: res.residualResources
    }
  },
  digest: sha256Hex,
  newId: (kind: string) => `${kind}-${randomUUID()}`,
  now: () => Date.now(),
  endpoint: 'unix:///tmp/mahas-ver-05/config/mahasd.sock'
}
const txn3b = { db: w.db, ctx: leadCtx, emitEvent: () => {} } as never
const start3b = await workerStart(txn3b, { launchPlanId: plan3b.planId, planDigest: plan3b.planDigest, operationId: `ver05:s3b:${E}:001` }, resolveDeps(correctedDeps))
const s3bStages = start3b.stageReceipt.stages
const allConfirmed = s3bStages.filter((s) => ['admitted', 'inputs_pinned', 'resources_claimed', 'components_materialized', 'process_attempting', 'process_confirmed', 'initial_attached', 'awaiting_join'].includes(s.stage)).every((s) => s.status === 'confirmed')
const execId3b = String(start3b.executionId)
const gen3b = Number(start3b.generation)
rec.check(
  's3b.allDrivenStages',
  allConfirmed && start3b.stageReceipt.terminal === 'awaiting_join',
  'all 8 driven stages confirmed → terminal awaiting_join',
  stageSummary(start3b)
)
const execRow3b = q1(w.db, 'SELECT id,member_id,generation,state,host_id,process_identity_json,terminal_id FROM executions WHERE id=?', execId3b)!
const memberRow3b = q1(w.db, 'SELECT generation,current_execution_id,state FROM members WHERE id=?', m3b.memberId)!
const dispatchRow3b = q1(w.db, 'SELECT id,phase,authority_state,task_revision,envelope_digest,assignment_delivery_id FROM dispatches WHERE execution_id=?', execId3b)!
const deliveryRow3b = q1(w.db, 'SELECT id,status,consumer_generation,recipient_member_id FROM deliveries WHERE id=?', String(dispatchRow3b.assignment_delivery_id))!
const credRow3b = q1(w.db, 'SELECT id,principal_id,mode,secret_hash FROM execution_credentials WHERE execution_id=?', execId3b)!
rec.check(
  's3b.executionRows',
  execRow3b.state === 'awaiting_join' && memberRow3b.current_execution_id === execId3b && memberRow3b.generation === gen3b,
  'executions.awaiting_join + member bound to this execution+generation',
  `state=${execRow3b.state} member.gen=${memberRow3b.generation} bound=${memberRow3b.current_execution_id}`
)
rec.check(
  's3b.dispatchDelivery',
  dispatchRow3b.authority_state === 'active' && deliveryRow3b.status === 'outstanding' && deliveryRow3b.consumer_generation === gen3b,
  'dispatch active + assignment delivery outstanding for this generation',
  `phase=${dispatchRow3b.phase} delivery=${deliveryRow3b.status} gen=${deliveryRow3b.consumer_generation}`
)
rec.check(
  's3b.bootstrapCredential',
  credRow3b.mode === 'bootstrap',
  'bootstrap execution credential minted (hash only)',
  `mode=${credRow3b.mode} principal=${credRow3b.principal_id}`
)

// spawn effect + connection file + recorder evidence
const spawnEff = q1(w.db, 'SELECT id,state,receipt_json,payload_json FROM effect_intents WHERE id=?', `${plan3b.planId}:effect:spawn`)!
const spawnReceipt = JSON.parse(String(spawnEff.receipt_json))
const matEff = q1(w.db, 'SELECT receipt_json FROM effect_intents WHERE id=?', `${plan3b.planId}:effect:materialize`)!
const matReceipt = JSON.parse(String(matEff.receipt_json))
const executionRoot = String(matReceipt.executionRoot ?? '')
const connPath = join(executionRoot, 'connection/worker')
const connExists = existsSync(connPath)
const connJson = connExists ? JSON.parse(readFileSync(connPath, 'utf8')) : null
const connMode = connExists ? statSync(connPath).mode & 0o777 : 0
rec.check(
  's3b.spawnConfirmed',
  spawnEff.state === 'confirmed' && spawnReceipt.processIdentity != null,
  'host.process.spawn confirmed with a process incarnation',
  `state=${spawnEff.state} nonce=${spawnReceipt.spawnNonce?.slice(0, 12)}`
)
rec.check(
  's3b.connectionFile',
  connExists && connMode === 0o600 && connJson?.executionId === execId3b &&
    sha256Hex(String(connJson?.credential)) === String(credRow3b.secret_hash),
  'connection/worker staged 0600; credential token hashes to execution_credentials.secret_hash',
  `mode=${connMode.toString(8)} execIdMatch=${connJson?.executionId === execId3b} hashMatch=${sha256Hex(String(connJson?.credential ?? '')) === String(credRow3b.secret_hash)}`
)

// cooperative recorder output — real argv/cwd/env/file-digest/stdin evidence
await new Promise((r) => setTimeout(r, 3500)) // recorder exits ≤3s after spawn
const spawned = existsSync(record3b) ? JSON.parse(readFileSync(record3b, 'utf8')) : null
const spawnPayload = JSON.parse(String(spawnEff.payload_json))
const mandatoryFileRec = spawned?.files?.find((f: { path: string }) => f.path.endsWith('role/mandatory.md'))
rec.check(
  's3b.recorderRan',
  spawned !== null && spawned.argv.includes('--file') && spawned.argv.some((a: string) => a.endsWith('role/mandatory.md')),
  'cooperative executable spawned by the real host recorded its argv',
  spawned ? `argv=${JSON.stringify(spawned.argv).slice(0, 160)}` : 'no record file'
)
rec.check(
  's3b.mandatoryViaArgv',
  mandatoryFileRec?.sha256 === bundle.requiredTextDigest,
  'argv-file route: the file the spawned process read is the pinned mandatory bytes',
  `sha256=${mandatoryFileRec?.sha256} expected=${bundle.requiredTextDigest}`
)
rec.check(
  's3b.cwdAndEnv',
  spawned?.cwd === spawnPayload.spec.cwd &&
    spawned?.env?.MAHAS_EXECUTION_ID === execId3b &&
    spawned?.env?.MAHAS_MEMBER_ID === m3b.memberId &&
    spawned?.env?.MAHAS_GENERATION === String(gen3b) &&
    spawned?.env?.VER05_MARKER === 's3-start' &&
    spawned?.env?.MAHAS_CONNECTION_FILE === connPath,
  'cwd = claimed checkout; MAHAS_* env + marker delivered',
  `cwd=${spawned?.cwd} execEnv=${spawned?.env?.MAHAS_EXECUTION_ID === execId3b} conn=${spawned?.env?.MAHAS_CONNECTION_FILE === connPath}`
)
const stdinEvidence = (spawnReceipt.evidence ?? []).find((e: { source: string }) => e.source === 'task/initial.txt')
rec.check(
  's3b.stdinRouteDropped',
  spawned?.stdin?.byteLength === 0 && stdinEvidence?.byteDigest === sha256Hex(initialText3b),
  'SEAM: coordinator sent spawnPayload.initialStdin {digest,sizeBytes,bytesB64}; host SpawnSpec reads spec.initialStdin — stdin bytes never reach the process',
  `stdinBytes=${spawned?.stdin?.byteLength} evidenceDigest=${stdinEvidence?.byteDigest} payloadField=${spawnPayload.initialStdin ? 'initialStdin{…}' : 'absent'} specField=${spawnPayload.spec.initialStdin ?? 'absent'}`
)

// injection receipts — materialized (materializer) + initial-attachment (stage)
const phases3b = qa(w.db, 'SELECT phase,revision FROM injection_receipts WHERE execution_id=? ORDER BY rowid', execId3b).map((r) => `${r.phase}@${r.revision}`)
rec.check(
  's3b.injectionReceipts',
  phases3b.some((p) => p.startsWith('materialized')) && phases3b.some((p) => p.startsWith('initial-attachment')),
  "'materialized' + 'initial-attachment' receipts recorded for this execution",
  phases3b.join(',')
)
rec.artifact('s3b', {
  start: { joinState: start3b.joinState, executionId: execId3b, generation: gen3b, dispatchId: start3b.dispatchId },
  stages: s3bStages,
  execution: execRow3b,
  member: memberRow3b,
  dispatch: dispatchRow3b,
  delivery: deliveryRow3b,
  credential: { id: credRow3b.id, principalId: credRow3b.principal_id, mode: credRow3b.mode },
  effects: qa(w.db, 'SELECT id,kind,state FROM effect_intents WHERE operation_key=?', `worker.start:${plan3b.planId}`),
  spawnPayload: { spec: spawnPayload.spec, initialStdin: spawnPayload.initialStdin ? { digest: spawnPayload.initialStdin.digest, sizeBytes: spawnPayload.initialStdin.sizeBytes } : null },
  spawnEvidence: spawnReceipt.evidence,
  executionRoot,
  connectionFile: { path: connPath, mode: connMode.toString(8), executionId: connJson?.executionId, generation: connJson?.generation, endpoint: connJson?.endpoint },
  recorder: spawned,
  injectionPhases: phases3b,
  initialTextDigest: sha256Hex(initialText3b),
  requiredTextDigest: bundle.requiredTextDigest
})

// ---------- s3c — execution.join ---------------------------------------------
const workerPrincipal = String(credRow3b.principal_id)
const joinPayload = {
  executionId: execId3b,
  generation: gen3b,
  bundleDigest: bundle.digest,
  surfaceDigest: bundle.surfaceDigest,
  envelopeDigest: String(envRow3b.digest)
}
const workerCtx = memberCtx(m3b.memberId, {}, { executionId: execId3b, generation: gen3b, principalId: workerPrincipal })

// bootstrap surface excludes task.accept — pre-join proof
const acceptPreJoin = await w.dispatch(workerCtx, 'task.accept', {
  dispatchId: String(dispatchRow3b.id), taskRevision: 1, envelopeDigest: String(envRow3b.digest)
})
rec.check(
  's3c.acceptHiddenPreJoin',
  acceptPreJoin.status === 'rejected' && acceptPreJoin.error?.code === 'UNAVAILABLE_OPERATION',
  'bootstrap surface hides task.accept before join',
  `${acceptPreJoin.status} ${acceptPreJoin.error?.code}`
)

const joinNoBinding = await w.dispatch(memberCtx(m3b.memberId, {}), 'execution.join', joinPayload)
rec.check(
  's3c.joinNoExecBinding',
  joinNoBinding.status === 'rejected' && joinNoBinding.error?.code === 'SCOPE_DENIED',
  'operator/member ctx without the execution binding cannot join (no proxy join)',
  `${joinNoBinding.status} ${joinNoBinding.error?.code}`
)
const joinBadGen = await w.dispatch(
  memberCtx(m3b.memberId, {}, { executionId: execId3b, generation: gen3b + 9, principalId: workerPrincipal }),
  'execution.join', { ...joinPayload, generation: gen3b + 9 }
)
rec.check(
  's3c.joinStaleGeneration',
  joinBadGen.status === 'rejected' && ['STALE_EXECUTION', 'UNAVAILABLE_OPERATION'].includes(String(joinBadGen.error?.code)),
  'wrong generation rejected',
  `${joinBadGen.status} ${joinBadGen.error?.code}`
)
const joinBadDigest = await w.dispatch(workerCtx, 'execution.join', { ...joinPayload, bundleDigest: '0'.repeat(64) })
rec.check(
  's3c.joinDigestMismatch',
  joinBadDigest.status === 'rejected' && joinBadDigest.error?.code === 'ARTIFACT_MISMATCH',
  'join digests that differ from the launch plan pins → ARTIFACT_MISMATCH',
  `${joinBadDigest.status} ${joinBadDigest.error?.code}`
)

// SEAM — admission.ts:313-314 re-runs authorize AFTER the handler inside the
// same write tx. The join handler's own worker_joins insert makes
// isJoined()==true mid-transaction → evidence.bootstrap flips false → the
// bootstrap-scope bypass no longer applies → step-6 requires a real grant
// for the worker principal — and launch never issues one. execution.join is
// therefore unreachable through shipped admission: the op's own commit
// output revokes the scope that admitted it.
const joinRaw = await w.dispatch(workerCtx, 'execution.join', joinPayload)
const joinRowAfterRaw = q1(w.db, 'SELECT * FROM worker_joins WHERE execution_id=?', execId3b)
rec.check(
  's3c.joinCommitReauth',
  joinRaw.status === 'rejected' && joinRaw.error?.code === 'SCOPE_DENIED' && joinRowAfterRaw === undefined,
  "SEAM: join's own worker_joins write flips bootstrap→post-join inside the tx; commit-time re-authorize demands a grant that was never issued → SCOPE_DENIED + rollback",
  `${joinRaw.status} ${joinRaw.error?.code} workerJoins=${joinRowAfterRaw ? 'row!' : 'rolled back'}`
)

// task.accept while unjoined — bootstrap surface hides it (same gate as
// acceptPreJoin; recorded here because the worker principal still holds no
// grant — member ops unreachable for it either way).
const acceptUnjoined = await w.dispatch(workerCtx, 'task.accept', {
  dispatchId: String(dispatchRow3b.id), taskRevision: 1, envelopeDigest: String(envRow3b.digest)
})
rec.check(
  's3d.acceptUnjoinedHidden',
  acceptUnjoined.status === 'rejected' && acceptUnjoined.error?.code === 'UNAVAILABLE_OPERATION',
  'SEAM: no grant is ever issued to the worker principal → member ops invisible (bootstrap or post-join alike)',
  `${acceptUnjoined.status} ${acceptUnjoined.error?.code}`
)

// CORRECTED GLUE — issue the worker principal a grant covering the
// assignment's actions. NOTE: the assignment grant's own {runId} scope does
// NOT cover join/accept's primary targets (execution/launchPlan/member do
// not all resolve to the run) — observed SCOPE_DENIED with it — so the glue
// uses an explicit wildcard scope, standing in for whatever scope the
// worker grant should carry at this seam (recorded, not assumed).
const workerGrantId = `grt-worker-${execId3b}`
const asgGrant = q1(w.db, 'SELECT kind,scope_json,actions_json FROM grants WHERE id=?', m3b.grantId)!
w.db
  .prepare(
    `INSERT OR IGNORE INTO grants(id,revision,kind,principal_id,parent_grant_id,policy_id,policy_revision,
       expires_at,revoked_at,scope_json,actions_json) VALUES(?,1,?,?,NULL,NULL,NULL,NULL,NULL,?,?)`
  )
  .run(
    workerGrantId,
    String(asgGrant.kind),
    workerPrincipal,
    JSON.stringify({ runId: fx.runId, targets: [{ kind: '*', id: '*' }] }),
    String(asgGrant.actions_json)
  )

const joinR = await w.dispatch(workerCtx, 'execution.join', joinPayload)
const joinRes = (joinR.result ?? {}) as { alreadyJoined?: boolean; dispatchesAdvanced?: number }
const joinRow = q1(w.db, 'SELECT * FROM worker_joins WHERE execution_id=?', execId3b)
const credAfter = q1(w.db, 'SELECT mode FROM execution_credentials WHERE id=?', String(credRow3b.id))
const execAfter = q1(w.db, 'SELECT state FROM executions WHERE id=?', execId3b)
const dispatchAfter = q1(w.db, 'SELECT phase,revision FROM dispatches WHERE id=?', String(dispatchRow3b.id))
rec.check(
  's3c.joinCommitted',
  joinR.status === 'committed' && joinRes.alreadyJoined === false && joinRow !== undefined && credAfter?.mode === 'full' && execAfter?.state === 'ready',
  'execution.join (corrected-glue worker grant): WorkerJoin + credential promotion + execution ready',
  `${joinR.status} alreadyJoined=${joinRes.alreadyJoined} cred=${credAfter?.mode} exec=${execAfter?.state}`
)
const joinedReceipt = q1(w.db, "SELECT phase,revision,evidence_json FROM injection_receipts WHERE execution_id=? AND phase='worker_joined'", execId3b)
rec.check(
  's3c.workerJoinedReceipt',
  joinedReceipt !== undefined,
  "'worker_joined' injection receipt (agent-declared pins, not comprehension)",
  joinedReceipt ? `rev=${joinedReceipt.revision} evidence=${String(joinedReceipt.evidence_json).slice(0, 140)}` : 'absent'
)
// SEAM: admitDispatch inserts phase 'assigned' but join advances only
// ('reserved','starting','awaiting_join') → dispatch is NOT promoted.
rec.check(
  's3c.dispatchPhaseSeam',
  joinRes.dispatchesAdvanced === 0 && dispatchAfter?.phase === 'assigned',
  "SEAM: join advances dispatches only from reserved/starting/awaiting_join — admitDispatch wrote 'assigned' → 0 advanced",
  `advanced=${joinRes.dispatchesAdvanced} phase=${dispatchAfter?.phase}`
)
const joinAgain = await w.dispatch(workerCtx, 'execution.join', joinPayload)
rec.check(
  's3c.joinReplay',
  joinAgain.status === 'committed' && (joinAgain.result as { alreadyJoined?: boolean })?.alreadyJoined === true,
  'second join returns the recorded truth (alreadyJoined)',
  `${joinAgain.status} alreadyJoined=${(joinAgain.result as { alreadyJoined?: boolean })?.alreadyJoined}`
)
rec.artifact('s3c.join', { joinRaw, join: joinR, joinAgain, joinRow, credAfter, execAfter, dispatchAfter, acceptPreJoin, acceptUnjoined, joinNoBinding, joinBadGen, joinBadDigest, workerGrantId })

// ---------- s3d — task.accept -------------------------------------------------
// negatives with the now-visible op (worker grant was the corrected glue)
const acceptWrongMember = await w.dispatch(workerCtx, 'task.accept', {
  dispatchId: 'dsp-nope', taskRevision: 1, envelopeDigest: String(envRow3b.digest)
})
const acceptStaleRev = await w.dispatch(workerCtx, 'task.accept', {
  dispatchId: String(dispatchRow3b.id), taskRevision: 99, envelopeDigest: String(envRow3b.digest)
})
const acceptBadEnv = await w.dispatch(workerCtx, 'task.accept', {
  dispatchId: String(dispatchRow3b.id), taskRevision: 1, envelopeDigest: 'f'.repeat(64)
})
rec.check(
  's3d.acceptNegatives',
  acceptWrongMember.status === 'rejected' && acceptWrongMember.error?.code === 'SCOPE_DENIED' &&
    acceptStaleRev.status === 'rejected' && acceptStaleRev.error?.code === 'STALE_REVISION' &&
    acceptBadEnv.status === 'rejected' && acceptBadEnv.error?.code === 'ARTIFACT_MISMATCH',
  'wrong dispatch → SCOPE_DENIED; stale taskRevision → STALE_REVISION; wrong envelope → ARTIFACT_MISMATCH',
  `${acceptWrongMember.error?.code}/${acceptStaleRev.error?.code}/${acceptBadEnv.error?.code}`
)

// dispatch is stuck at 'assigned' (s3c seam) → the honest accept verdict first
const acceptStuck = await w.dispatch(workerCtx, 'task.accept', {
  dispatchId: String(dispatchRow3b.id), taskRevision: 1, envelopeDigest: String(envRow3b.digest)
})
rec.check(
  's3d.acceptPhaseStuck',
  acceptStuck.status === 'rejected' && acceptStuck.error?.code === 'INVALID_TRANSITION',
  "SEAM consequence: dispatch still 'assigned' after join → task.accept cannot reach 'awaiting_accept' through the shipped chain",
  `${acceptStuck.status} ${acceptStuck.error?.code}: ${String(acceptStuck.error?.message).slice(0, 120)}`
)

// CORRECTED GLUE — set the phase join's UPDATE was meant to produce, then run
// the real accept path end-to-end.
w.db.prepare("UPDATE dispatches SET phase='awaiting_accept' WHERE id=?").run(String(dispatchRow3b.id))
const accept = await w.dispatch(workerCtx, 'task.accept', {
  dispatchId: String(dispatchRow3b.id), taskRevision: 1, envelopeDigest: String(envRow3b.digest)
})
const acceptRes = (accept.result ?? {}) as { phase?: string; alreadyAccepted?: boolean; acknowledgedAssignmentDelivery?: string }
const deliveryAfter = q1(w.db, 'SELECT status,acked_at FROM deliveries WHERE id=?', String(dispatchRow3b.assignment_delivery_id))
const acceptEvent = q1(w.db, "SELECT event_type,payload_json FROM domain_events WHERE aggregate_id=? AND event_type='task.accepted'", String(dispatchRow3b.id))
rec.check(
  's3d.acceptCommitted',
  accept.status === 'committed' && acceptRes.phase === 'running' && acceptRes.alreadyAccepted === false &&
    deliveryAfter?.status === 'acknowledged' && acceptEvent !== undefined,
  "task.accept (corrected-glue phase): dispatch 'running', delivery acknowledged, task.accepted event",
  `${accept.status} phase=${acceptRes.phase} acked=${acceptRes.acknowledgedAssignmentDelivery}`
)
const acceptAgain = await w.dispatch(workerCtx, 'task.accept', {
  dispatchId: String(dispatchRow3b.id), taskRevision: 1, envelopeDigest: String(envRow3b.digest)
})
rec.check(
  's3d.acceptReplay',
  acceptAgain.status === 'committed' && (acceptAgain.result as { alreadyAccepted?: boolean })?.alreadyAccepted === true,
  'second accept returns recorded acceptance (alreadyAccepted)',
  `${acceptAgain.status} alreadyAccepted=${(acceptAgain.result as { alreadyAccepted?: boolean })?.alreadyAccepted}`
)
rec.artifact('s3d.accept', { acceptUnjoined, acceptWrongMember, acceptStaleRev, acceptBadEnv, acceptStuck, accept, acceptAgain, deliveryAfter, acceptEvent, workerGrantId })

// ---------- s3e — stdin route seam (direct host probes) ----------------------
const hostClient = await (w.runtime as { hostClient?: (id: string) => Promise<{ call: (op: string, p?: unknown) => Promise<unknown> }> }).hostClient!(hostId)
const stdinSpecRecord = `${OUT}/s3e-stdin-spec.json`
const specSpawn = (await hostClient.call('host.process.spawn', {
  spawnNonce: sha256Hex(`s3e:spec:${E}`).slice(0, 32),
  executionId: 'exec-s3e-spec',
  generation: 1,
  spec: {
    argv: [NODE_BIN, COOP, '--record-out', stdinSpecRecord, '--echo-stdin'],
    cwd: REPO_ROOT,
    env: { VER05_MARKER: 's3e' },
    initialStdin: 'STDIN-VIA-SPEC-FIELD-7d2a'
  }
})) as { spawn?: { state?: string } }
await new Promise((r) => setTimeout(r, 3500))
const specRec = existsSync(stdinSpecRecord) ? JSON.parse(readFileSync(stdinSpecRecord, 'utf8')) : null
rec.check(
  's3e.specFieldDelivered',
  specRec?.stdin?.byteLength === 'STDIN-VIA-SPEC-FIELD-7d2a'.length && specRec?.stdin?.text === 'STDIN-VIA-SPEC-FIELD-7d2a',
  'host honors spec.initialStdin — the bytes reach the process when placed inside spec',
  `byteLength=${specRec?.stdin?.byteLength} text=${specRec?.stdin?.text ?? '-'}`
)
const payloadRecord = `${OUT}/s3e-stdin-payload.json`
await hostClient.call('host.process.spawn', {
  spawnNonce: sha256Hex(`s3e:payload:${E}`).slice(0, 32),
  executionId: 'exec-s3e-payload',
  generation: 1,
  spec: { argv: [NODE_BIN, COOP, '--record-out', payloadRecord, '--echo-stdin'], cwd: REPO_ROOT, env: { VER05_MARKER: 's3e' } },
  initialStdin: { digest: sha256Hex('STDIN-VIA-PAYLOAD'), mediaType: 'text/plain', sizeBytes: 16, bytesB64: Buffer.from('STDIN-VIA-PAYLOAD').toString('base64') }
})
await new Promise((r) => setTimeout(r, 3500))
const payloadRec = existsSync(payloadRecord) ? JSON.parse(readFileSync(payloadRecord, 'utf8')) : null
rec.check(
  's3e.payloadFieldDropped',
  payloadRec?.stdin?.byteLength === 0,
  "coordinator's payload-level initialStdin is silently ignored by the host — stdin route never delivers",
  `byteLength=${payloadRec?.stdin?.byteLength} spawnState=${specSpawn.spawn?.state}`
)
rec.artifact('s3e.stdin', { specRec, payloadRec })

// ---------- evidence chain ----------------------------------------------------
const chain = {
  sourceSnapshot: fx.sourcePins,
  componentManifest: { bundleDigest: bundle.digest, requiredTextDigest: bundle.requiredTextDigest, surfaceDigest: bundle.surfaceDigest },
  launchPlan: { id: plan3b.planId, digest: plan3b.planDigest },
  argvConfigStdin: {
    argv: spawnPayload.spec?.argv,
    cwd: spawnPayload.spec?.cwd,
    envKeys: Object.keys(spawnPayload.spec?.env ?? {}).filter((k) => k.startsWith('MAHAS_') || k === 'VER05_MARKER'),
    stdinDigest: spawnPayload.initialStdin?.digest ?? null,
    stdinDelivered: (spawned?.stdin?.byteLength ?? 0) > 0
  },
  joinDigests: joinRow ? { bundle: joinRow.bundle_digest, surface: joinRow.surface_digest, envelope: joinRow.envelope_digest } : null,
  execution: { id: execId3b, generation: gen3b, state: execAfter?.state },
  dispatch: { id: dispatchRow3b.id, phaseAfterAccept: q1(w.db, 'SELECT phase FROM dispatches WHERE id=?', String(dispatchRow3b.id))?.phase }
}
rec.artifact('evidenceChain', chain)

w.runtime.close()
rec.flush()
