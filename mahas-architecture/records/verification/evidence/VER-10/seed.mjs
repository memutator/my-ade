// VER-10 fixture — real ops via operator socket where they work on WIP;
// DB-seeded rows are labeled SCAFFOLD (the launch path is separately under test).
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { randomUUID, createHash, randomBytes } from 'node:crypto'

const ROOT = '/tmp/mahas-ver-10'
const DB = `${ROOT}/config/mahas.sqlite`
const OUT = `${ROOT}/out`
const results = []
const rec = (step, ok, detail) => { results.push({ step, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${step} ${JSON.stringify(detail).slice(0, 200)}`) }

// --- NDJSON RPC client per rpc/framing.ts protocol ---
function rpc(sockPath, credential) {
  const sock = connect(sockPath)
  const buf = { data: '' }
  let pending = new Map()
  let seq = 0
  let helloResolve
  const helloP = new Promise((res) => { helloResolve = res })
  sock.on('data', (d) => {
    buf.data += d
    let i
    while ((i = buf.data.indexOf('\n')) >= 0) {
      const line = buf.data.slice(0, i); buf.data = buf.data.slice(i + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (msg.kind === 'hello-ok' || msg.kind === 'hello-error') { helloResolve(msg); continue }
      if (msg.requestId !== undefined && pending.has(msg.requestId)) { pending.get(msg.requestId)(msg); pending.delete(msg.requestId) }
    }
  })
  sock.on('connect', () => {
    sock.write(JSON.stringify({ kind: 'hello', protocolVersion: 1, credential }) + '\n')
  })
  return {
    ready: helloP,
    call: async (operation, payload = {}, opId) => {
      const requestId = ++seq
      const request = { protocolVersion: "1", operation, operationId: opId ?? `op_${randomUUID().slice(0, 8)}`, payload }
      return new Promise((res) => { pending.set(requestId, res); sock.write(JSON.stringify({ kind: 'call', requestId, request }) + '\n') })
    },
    close: () => sock.destroy()
  }
}

const opCred = JSON.parse(readFileSync(`${ROOT}/config/operator-connection.json`, 'utf8'))
const client = rpc(`${ROOT}/config/mahasd.sock`, opCred.credential)
const hello = await client.ready
rec('hello.operator', hello.kind === 'hello-ok', hello)

const state = { t0: Date.now() }
const db = new DatabaseSync(DB)

// --- project via real op ---
const prj = await client.call('project.create', {
  projectId: 'prj-ver10', name: 'ver10-codex', goal: 'VER-10 codex real-execution verification',
  repositoryRoot: `${ROOT}/repo`
})
rec('project.create', prj.receipt?.status === 'committed', prj.receipt ?? prj)
state.projectCommitted = prj.receipt?.status === 'committed'

// --- provisioning grant purpose=verification via real op ---
const prov = await client.call('access.grant', {
  kind: 'provisioning',
  subject: { principalId: 'operator-local' },
  scope: {
    targets: [{ kind: 'project', id: 'prj-ver10' }],
    provisioning: { allowedRoleIds: ['r-codex'], maxMembers: 4, profileAdmission: 'documented-in-verification-run' }
  },
  actions: ['team.assign', 'implementation.prepare', 'worker.prepare', 'worker.start']
})
rec('access.grant.verification', prov.receipt?.status === 'committed', prov.receipt ?? prov)

// --- SCAFFOLD: member + execution + worker credential (launch path under test separately) ---
const projectId = (db.prepare('SELECT id FROM projects LIMIT 1').get() || {}).id ?? 'prj-ver10'
const runId = 'run-ver10'
const memberId = 'mem-ver10-worker'
const execId = 'exec-ver10-1'
const workerPrincipal = `principal-${execId}`  // memberPrincipalBound convention: 'principal-'+executionId
const credId = 'cred-ver10-1'
const secret = randomBytes(32).toString('hex')
const now = Date.now()

// model_versions row exists from project.create — reuse it; add boundary + role impl
const mvId = (db.prepare('SELECT id FROM model_versions LIMIT 1').get() || {}).id
db.prepare(`INSERT OR IGNORE INTO rdd_boundaries(model_version,id,name,responsibility_statement)
  VALUES(?,?,?,?)`).run(mvId, 'b-root', 'root', 'ver10 root boundary')
db.prepare(`INSERT OR IGNORE INTO harness_profiles(id,revision,state,recipe_json,capabilities_json,executable_identity_json)
  VALUES(?,?,?,?,?,?)`).run('hp-codex', 1, 'verified', '{}', '{}', '{}')
db.prepare(`INSERT OR IGNORE INTO horizontal_roles(model_version,name)
  VALUES(?,?)`).run(mvId, 'codex-worker')
db.prepare(`INSERT OR IGNORE INTO rdd_roles(model_version,id,name,description,boundary_id,horizontal_role_name)
  VALUES(?,?,?,?,?,?)`).run(mvId, 'r-codex', 'codex-worker', 'codex verification worker', 'b-root', 'codex-worker')
db.prepare(`INSERT OR IGNORE INTO role_interfaces(digest,model_version,role_id,requirements_json,judgment_scope_json)
  VALUES(?,?,?,?,?)`).run('iface-digest-ver10', mvId, 'r-codex', '[]', '{}')
db.prepare(`INSERT OR IGNORE INTO role_implementations(id,revision,interface_digest,profile_id,profile_revision,status,maintainer_role_id,semantic_decision)
  VALUES(?,?,?,?,?,?,?,?)`).run('impl-codex-1', 1, 'iface-digest-ver10', 'hp-codex', 1, 'verified', 'r-codex', 'codex profile impl')

db.prepare(`INSERT OR IGNORE INTO runs(id,project_id,model_version,goal_text,purpose,coordinator_member_id,state,current_plan_revision,revision)
  VALUES(?,?,?,?,?,?,?,?,?)`).run(runId, projectId, mvId, 'ver10 run', 'verification', null, 'active', 1, 1)

db.prepare(`INSERT OR IGNORE INTO principals(id,kind,status) VALUES(?,?,?)`).run(workerPrincipal, 'worker', 'active')

// worker grant FIRST (assignments.grant_id FK), then member, assignment, execution
db.prepare(`INSERT OR IGNORE INTO grants(id,revision,kind,principal_id,parent_grant_id,policy_id,policy_revision,expires_at,revoked_at,scope_json,actions_json)
  VALUES(?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?)`).run(
  'grant-ver10-worker', 1, 'assignment', workerPrincipal,
  JSON.stringify({ targets: [{ kind: 'run', id: runId }, { kind: 'member', id: memberId }, { kind: 'execution', id: execId }] }),
  JSON.stringify(['surface.describe', 'operation.get', 'assignment.show', 'execution.join', 'execution.heartbeat', 'execution.report', 'inbox.check', 'inbox.read', 'delivery.ack', 'task.accept', 'task.report', 'run.get', 'message.send'])
)

// circular FK: member.current_execution_id → executions.id AND executions.member_id → members.id
db.prepare(`INSERT OR IGNORE INTO members(id,run_id,model_version,role_id,implementation_id,implementation_revision,generation,current_execution_id,state,revision)
  VALUES(?,?,?,?,?,?,?,NULL,?,?)`).run(memberId, runId, mvId, 'r-codex', 'impl-codex-1', 1, 'assigned', 1)

db.prepare(`INSERT OR IGNORE INTO assignments(id,revision,member_id,kind,mandate_text,grant_id,task_id,task_revision,scope_json)
  VALUES(?,?,?,?,?,?,?,?,?)`).run('asgn-ver10-1', 1, memberId, 'coordination', 'VER-10 codex verification member', 'grant-ver10-worker', null, null, '{}')

// launch_plans chain: content_blobs → command_surfaces → work_envelopes/context_bundles → launch_plans
const mandatoryText = '# VER-10 mandatory instruction\nYou are a codex verification worker.\n'
db.prepare(`INSERT OR IGNORE INTO content_blobs(digest,media_type,byte_length,body,external_ref,verified)
  VALUES(?,?,?,?,NULL,?)`).run('blob-ver10-mandatory', 'text/markdown', Buffer.byteLength(mandatoryText), Buffer.from(mandatoryText), 1)
db.prepare(`INSERT OR IGNORE INTO command_surfaces(digest,actions_and_schemas_json,policy_pins_json)
  VALUES(?,?,?)`).run('surf-ver10', '{"actions":["surface.describe","operation.get","assignment.show","execution.join"]}', '{}')
db.prepare(`INSERT OR IGNORE INTO work_envelopes(digest,assignment_id,assignment_revision,kind,body_digest,bindings_json)
  VALUES(?,?,?,?,?,?)`).run('env-ver10', 'asgn-ver10-1', 1, 'coordination', 'blob-ver10-mandatory', '{}')
db.prepare(`INSERT OR IGNORE INTO context_bundles(digest,implementation_id,implementation_revision,interface_digest,surface_digest,required_text_digest,manifest_json,source_observations_json)
  VALUES(?,?,?,?,?,?,?,?)`).run('bundle-ver10', 'impl-codex-1', 1, 'iface-digest-ver10', 'surf-ver10', 'blob-ver10-mandatory', '{}', '{}')
db.prepare(`INSERT OR IGNORE INTO launch_plans(id,assignment_id,assignment_revision,digest,bundle_digest,envelope_digest,surface_digest,state,process_spec_json,pins_json,reservations_json)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('lp-ver10-1', 'asgn-ver10-1', 1, 'lpdigest-ver10', 'bundle-ver10', 'env-ver10', 'surf-ver10', 'admitted', '{}', '{}', '{}')

db.prepare(`INSERT OR IGNORE INTO executions(id,member_id,generation,host_id,launch_plan_id,state,liveness,terminal_id,process_identity_json,native_conversation_json,revision)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(execId, memberId, 1, 'host-pyosechang-MS-7D76', 'lp-ver10-1', 'preparing', 'live', null, '{}', '{}', 1)

db.prepare(`UPDATE members SET current_execution_id=? WHERE id=?`).run(execId, memberId)

// worker credential — bootstrap mode (realistic launch-time state)
const sha = createHash('sha256').update(secret).digest('hex')
db.prepare(`INSERT OR IGNORE INTO execution_credentials(id,secret_hash,principal_id,execution_id,generation,mode,revoked_at,revision)
  VALUES(?,?,?,?,?,?,NULL,1)`).run(credId, `sha256:${sha}`, workerPrincipal, execId, 1, 'bootstrap')

// worker connection file (0600) — MAHAS_CONNECTION_FILE shape
const connFile = `${ROOT}/exec/worker-connection.json`
writeFileSync(connFile, JSON.stringify({ kind: 'worker', credentialId: credId, secret }, null, 2), { mode: 0o600 })
rec('seed.scaffold', true, { runId, memberId, execId, credId })

state.fixture = { projectId: 'prj-ver10', runId, memberId, execId, workerPrincipal, credId, secret: '<redacted-in-state>', connFile }
writeFileSync(`${ROOT}/state.json`, JSON.stringify(state, null, 2))
writeFileSync(`${OUT}/seed-results.json`, JSON.stringify(results, null, 2))
client.close()
console.log(`\n${results.filter(r => r.ok).length}/${results.length} ok`)
process.exit(0)
