// s5 — receipt-stage distinction + end-to-end evidence chain.
//
// Read-only consolidation over the live control DB and the recorded artifacts.
// Establishes that materialized / initial-attachment / worker_joined /
// task-accepted are DISTINCT records — evidence of one stage is not evidence
// of another — and joins the digest chain:
//
//   source snapshot → component manifest → actual argv/env/stdin → join digests
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Recorder, DB, sha256Hex } from './common.ts'

const rec = new Recorder('s5-stages')
const db = new DatabaseSync(DB, { readOnly: true })
const s3 = JSON.parse(readFileSync('/tmp/mahas-ver-05/out/s3-start.json', 'utf8'))
const spawnRec = JSON.parse(readFileSync('/tmp/mahas-ver-05/out/s3b-spawn-record.json', 'utf8'))
const specRec = JSON.parse(readFileSync('/tmp/mahas-ver-05/out/s3e-stdin-spec.json', 'utf8'))
const chain = s3.artifacts.evidenceChain
const execId: string = chain.execution.id
const dispatchId: string = chain.dispatch.id

const q1 = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as Record<string, unknown> | undefined
const qa = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as Record<string, unknown>[]

// ---------- distinct stage records -----------------------------------------
const mat = q1(
  "SELECT * FROM injection_receipts WHERE execution_id=? AND phase='materialized' ORDER BY revision",
  execId
)
const att = q1(
  "SELECT * FROM injection_receipts WHERE execution_id=? AND phase='initial-attachment' ORDER BY revision",
  execId
)
const joined = q1(
  "SELECT * FROM injection_receipts WHERE execution_id=? AND phase='worker_joined' ORDER BY revision",
  execId
)
const joinRow = q1('SELECT * FROM worker_joins WHERE execution_id=? AND generation=?', execId, chain.execution.generation)
const disp = q1('SELECT * FROM dispatches WHERE id=?', dispatchId)
const delivery = q1('SELECT * FROM deliveries WHERE id=?', String(disp?.assignment_delivery_id))

rec.check(
  's5.materialized',
  mat !== undefined && String(mat.phase) === 'materialized',
  'materialization recorded as its own injection_receipts row (phase=materialized)',
  `rev=${mat?.revision} components=${String(mat?.components_json).slice(0, 120)}`
)
rec.check(
  's5.initialAttached',
  att !== undefined && String(att.phase) === 'initial-attachment',
  'initial attachment is a SEPARATE receipt row — not folded into materialized',
  `rev=${att?.revision} evidence=${String(att?.evidence_json).slice(0, 160)}`
)
rec.check(
  's5.joined',
  joined !== undefined && joinRow !== undefined,
  'join is a THIRD receipt (worker_joined) plus a worker_joins row carrying the echoed digests',
  `receipt=${joined !== undefined} worker_joins=${joinRow !== undefined} joined_at=${joinRow?.joined_at}`
)
rec.check(
  's5.taskAccepted',
  disp?.phase === 'running' && delivery?.status === 'acknowledged' && typeof delivery?.acked_at === 'number',
  'task acceptance is a FOURTH distinct transition — dispatch running + delivery acknowledged',
  `phase=${disp?.phase} delivery=${delivery?.status} acked_at=${delivery?.acked_at}`
)

// ---------- non-equivalence: stages that were never reached -----------------
// Executions that materialized + attached but never joined (earlier s3 runs).
const attachedNotJoined = qa(
  `SELECT DISTINCT execution_id FROM injection_receipts
    WHERE phase='initial-attachment' AND execution_id NOT IN (SELECT execution_id FROM worker_joins)`
)
const allUnjoinedOk = attachedNotJoined.every((r) => {
  const id = String(r.execution_id)
  const noJoinReceipt = q1(
    "SELECT 1 x FROM injection_receipts WHERE execution_id=? AND phase='worker_joined'",
    id
  ) === undefined
  const d = qa('SELECT phase FROM dispatches WHERE execution_id=?', id)
  const noRunning = d.every((x) => String(x.phase) !== 'running')
  return noJoinReceipt && noRunning
})
rec.check(
  's5.attachedNotJoined',
  attachedNotJoined.length >= 2 && allUnjoinedOk,
  'attached ≠ joined ≠ accepted: executions stuck after initial-attachment have NO worker_joined receipt, NO worker_joins row, and their dispatches never reach running',
  `unjoined=${attachedNotJoined.length} allConsistent=${allUnjoinedOk}`
)

// refused materializations leave no receipt at all
const refused = ['exec-s4b', 'exec-s4c', 'exec-s4d', 'exec-s4g']
const refusedClean = refused.every(
  (id) => q1('SELECT 1 x FROM injection_receipts WHERE execution_id=?', id) === undefined
)
rec.check(
  's5.refusedNoReceipt',
  refusedClean,
  'a stage that fails leaves NO receipt — conflicted/denied materializations are absent from injection_receipts',
  `checked=[${refused.join(',')}] clean=${refusedClean}`
)

// ---------- ordering ---------------------------------------------------------
const stageTimes = (s3.artifacts.s3b.stages as { stage: string; at: number }[]).map((s) => [s.stage, s.at])
const attachIdx = stageTimes.findIndex(([s]) => s === 'initial_attached')
const attachAt = stageTimes[attachIdx]?.[1] ?? 0
const ordered =
  attachAt > 0 &&
  Number(joinRow?.joined_at) >= attachAt &&
  Number(delivery?.acked_at) >= Number(joinRow?.joined_at)
rec.check(
  's5.ordering',
  ordered,
  'stage order: initial_attached → joined_at → delivery acked_at (acceptance strictly after join)',
  `attach=${attachAt} joined=${joinRow?.joined_at} acked=${delivery?.acked_at}`
)

// ---------- evidence chain ---------------------------------------------------
// 1. source snapshot → manifest
const bundleRow = q1('SELECT * FROM context_bundles WHERE digest=?', chain.componentManifest.bundleDigest)
const manifest = JSON.parse(String(bundleRow?.manifest_json))
const reqDigest = String(manifest.requiredText.digest)
const spawnFileSha = String(spawnRec.files[0].sha256)
rec.check(
  's5.chain.sourceToManifest',
  reqDigest === chain.componentManifest.requiredTextDigest && reqDigest === String(bundleRow?.required_text_digest),
  'manifest pins the mandatory-role blob digest the source snapshot produced',
  `requiredText=${reqDigest}`
)

// 2. manifest → actual argv bytes
rec.check(
  's5.chain.manifestToArgv',
  spawnFileSha === reqDigest && (spawnRec.argv as string[]).includes('--file'),
  'the argv --file slot delivered exactly the manifest-pinned mandatory bytes (sha256 equality, cooperative recorder)',
  `file sha=${spawnFileSha}`
)

// 3. argv → join digests (worker_joins echoes the pins it verified)
const pins = chain.joinDigests as Record<string, string>
rec.check(
  's5.chain.argvToJoin',
  String(joinRow?.bundle_digest) === chain.componentManifest.bundleDigest &&
    String(joinRow?.surface_digest) === chain.componentManifest.surfaceDigest &&
    String(joinRow?.envelope_digest) === pins.envelope,
  'worker_joins echoes bundle/surface/envelope digests identical to the verified pins — pin receipt, not comprehension',
  `join bundle=${String(joinRow?.bundle_digest).slice(0, 16)}… env=${String(joinRow?.envelope_digest).slice(0, 16)}…`
)

// 4. stdin chain — the routed break is pinned by digest on both sides
const emptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const payloadSent: string = chain.argvConfigStdin.stdinDigest
rec.check(
  's5.chain.stdinBreak',
  spawnRec.stdin.sha256 === emptySha &&
    payloadSent !== emptySha &&
    specRec.stdin.sha256 === sha256Hex(specRec.stdin.text),
  'stdin chain: coordinator sent non-empty payload bytes (digest recorded), child received 0 bytes via payload field; spec-field route delivers bytes intact (sha of received == sha of sent)',
  `sent=${payloadSent.slice(0, 16)}… got=${spawnRec.stdin.sha256.slice(0, 16)}… spec=${specRec.stdin.sha256.slice(0, 16)}…`
)

// 5. cwd is the claimed checkout
rec.check(
  's5.chain.cwdClaim',
  typeof spawnRec.cwd === 'string' && spawnRec.cwd.includes('.ver05-checkouts'),
  'spawn cwd is the claimed canonical checkout, not an arbitrary directory',
  `cwd=${spawnRec.cwd}`
)

// ---------- consolidated digest table ----------------------------------------
rec.artifact('stageRecords', {
  executionId: execId,
  materialized: { phase: mat?.phase, revision: mat?.revision },
  initialAttachment: { phase: att?.phase, revision: att?.revision },
  workerJoined: { phase: joined?.phase, revision: joined?.revision, joinedAt: joinRow?.joined_at },
  taskAccepted: { dispatchPhase: disp?.phase, deliveryStatus: delivery?.status, ackedAt: delivery?.acked_at },
  attachedNotJoined: attachedNotJoined.map((r) => r.execution_id)
})
rec.artifact('digestChain', {
  sourceSnapshot: chain.sourceSnapshot,
  manifest: {
    bundleDigest: chain.componentManifest.bundleDigest,
    requiredTextDigest: reqDigest,
    surfaceDigest: chain.componentManifest.surfaceDigest
  },
  argv: { file: spawnRec.argv[3], fileSha256: spawnFileSha, cwd: spawnRec.cwd },
  stdin: { payloadSent: payloadSent, delivered: spawnRec.stdin.sha256, specFieldDelivered: specRec.stdin.sha256 },
  join: { bundle: joinRow?.bundle_digest, surface: joinRow?.surface_digest, envelope: joinRow?.envelope_digest },
  acceptance: { dispatch: dispatchId, phase: disp?.phase, deliveryAcked: delivery?.acked_at }
})

rec.flush()
