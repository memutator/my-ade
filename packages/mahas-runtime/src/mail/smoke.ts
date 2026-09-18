// mahas-runtime/mail — IMP-15 smoke harness (dev verification, not shipped).
//
// Run: `node packages/mahas-runtime/src/mail/smoke.ts` (Node 24 type
// stripping). Verifies the C-MAIL op semantics end-to-end against a real
// node:sqlite ledger:
//   send → deliveries outstanding → check (no ack) → ack → fenced on
//   generation bump → replyAndAck atomicity → artifact publish/read
//   round-trip → bounded wait.
//
// The fixture DB applies the spec/storage.md §3 columns for the tables this
// boundary touches with PRAGMA foreign_keys=OFF — IMP-03 owns the real
// schema/migration; this checks MY logic, not the DDL chain. Deps are
// faithful stand-ins for the SHARED-APIS kernel functions (same semantics,
// no mocks that fake success).

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AuthenticatedContext,
  ContentRef,
  MahasError
} from '../../../mahas-contracts/src/common.ts'
import type {
  OperationHandler,
  OperationRegistry,
  OperationSpec,
  TxnContext
} from '../api/registry.ts'
import type { TargetRef } from '../access/authorize.ts'
import type {
  ArtifactPublishResult,
  ArtifactReadResult,
  DeliveryAckResult,
  InboxCheckResult,
  InboxWaitResult,
  MailDeps,
  MessageReplyAndAckResult,
  MessageSendResult
} from './api.ts'
import { registerMailOps } from './index.ts'
import { fenceDeliveriesForMember } from './shared.ts'

// --------------------------------------------------------------------------
// fixture DB — spec/storage.md §3 subset (FK off: we are not the migrator)
// --------------------------------------------------------------------------

const db = new DatabaseSync(':memory:')
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE content_blobs (
  digest TEXT PRIMARY KEY, media_type TEXT NOT NULL, byte_length INTEGER NOT NULL,
  body BLOB, external_ref TEXT, verified INTEGER NOT NULL,
  CHECK((body IS NOT NULL)+(external_ref IS NOT NULL)=1)
);
CREATE TABLE principals (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, model_version TEXT NOT NULL,
  goal_text TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'work',
  coordinator_member_id TEXT, state TEXT NOT NULL, current_plan_revision INTEGER,
  revision INTEGER NOT NULL
);
CREATE TABLE members (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, model_version TEXT NOT NULL,
  role_id TEXT NOT NULL, implementation_id TEXT NOT NULL,
  implementation_revision INTEGER NOT NULL, generation INTEGER NOT NULL,
  current_execution_id TEXT, state TEXT NOT NULL, revision INTEGER NOT NULL
);
CREATE TABLE executions (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL, generation INTEGER NOT NULL,
  host_id TEXT NOT NULL, launch_plan_id TEXT NOT NULL, state TEXT NOT NULL,
  liveness TEXT NOT NULL, terminal_id TEXT, process_identity_json TEXT NOT NULL,
  native_conversation_json TEXT NOT NULL, revision INTEGER NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, current_revision INTEGER NOT NULL,
  current_dispatch_id TEXT
);
CREATE TABLE task_specs (
  task_id TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL,
  requirement_text TEXT NOT NULL, owner_role_id TEXT NOT NULL,
  assigned_member_id TEXT, inputs_json TEXT NOT NULL, outputs_json TEXT NOT NULL,
  settlement_policy_json TEXT NOT NULL, PRIMARY KEY(task_id, revision)
);
CREATE TABLE dispatches (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_revision INTEGER NOT NULL,
  member_id TEXT NOT NULL, execution_id TEXT NOT NULL, generation INTEGER NOT NULL,
  envelope_digest TEXT NOT NULL, phase TEXT NOT NULL, authority_state TEXT NOT NULL,
  assignment_delivery_id TEXT, revision INTEGER NOT NULL
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, sender_principal_id TEXT NOT NULL,
  sender_member_id TEXT, kind TEXT NOT NULL, body TEXT NOT NULL,
  links_json TEXT NOT NULL CHECK(json_valid(links_json)), created_at INTEGER NOT NULL
);
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, recipient_member_id TEXT NOT NULL,
  consumer_generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('outstanding','acknowledged','fenced')),
  revision INTEGER NOT NULL, acked_at INTEGER,
  handling_json TEXT NOT NULL CHECK(json_valid(handling_json)),
  UNIQUE(message_id, recipient_member_id)
);
CREATE INDEX inbox_outstanding ON deliveries(recipient_member_id, status, consumer_generation);
CREATE TABLE wake_requests (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL, execution_id TEXT,
  continuation_grant_id TEXT, operation_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL, delivery_set_json TEXT NOT NULL, receipt_json TEXT NOT NULL
);
CREATE TABLE artifacts (
  id TEXT NOT NULL, revision INTEGER NOT NULL, run_id TEXT NOT NULL,
  producer_dispatch_id TEXT NOT NULL, output_slot TEXT NOT NULL, digest TEXT NOT NULL,
  media_type TEXT NOT NULL, byte_length INTEGER NOT NULL, storage_ref_json TEXT NOT NULL,
  PRIMARY KEY(id, revision)
);
CREATE TABLE retention_pins (
  id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
  holder_kind TEXT NOT NULL, holder_id TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE resources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, host_id TEXT, identity_json TEXT NOT NULL);
CREATE TABLE checkouts (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL UNIQUE, host_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL, filesystem_identity TEXT NOT NULL,
  repository_json TEXT NOT NULL, revision INTEGER NOT NULL
);
CREATE TABLE resource_claims (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL, mode TEXT NOT NULL, generation INTEGER NOT NULL,
  state TEXT NOT NULL, revision INTEGER NOT NULL
);
CREATE TABLE domain_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL, event_type TEXT NOT NULL,
  scope_json TEXT NOT NULL, payload_json TEXT NOT NULL
);
`)

// --------------------------------------------------------------------------
// faithful kernel stand-ins (SHARED-APIS semantics — no success faking)
// --------------------------------------------------------------------------

const sha256Hex = (d: string | Uint8Array): string => createHash('sha256').update(d).digest('hex')
const authCalls: { operation: string; targets: TargetRef[] }[] = []

const deps: MailDeps = {
  authorize: (_ctx, operation, targets) => {
    authCalls.push({ operation, targets })
  },
  sha256Hex,
  putContentBlob: (d, bytes, mediaType): ContentRef => {
    const digest = sha256Hex(bytes)
    d.prepare(
      'INSERT OR IGNORE INTO content_blobs (digest, media_type, byte_length, body, verified) VALUES (?, ?, ?, ?, 1)'
    ).run(digest, mediaType, bytes.byteLength, bytes)
    return { digest, mediaType, sizeBytes: bytes.byteLength }
  },
  getContentBlob: (d, digest) => {
    const r = d
      .prepare('SELECT body, media_type FROM content_blobs WHERE digest = ?')
      .get(digest) as { body: Uint8Array; media_type: string } | undefined
    return r ? { bytes: new Uint8Array(r.body), mediaType: r.media_type } : null
  },
  appendDomainEvent: (d, aggregateId, aggregateRevision, eventType, scope, payload) => {
    d.prepare(
      'INSERT INTO domain_events (aggregate_id, aggregate_revision, event_type, scope_json, payload_json) VALUES (?, ?, ?, ?, ?)'
    ).run(aggregateId, aggregateRevision, eventType, JSON.stringify(scope), JSON.stringify(payload))
  },
  limits: { maxWaitMs: 2_000, pollIntervalMs: 20, maxBatch: 100 }
}

// capture handlers through the registry seam exactly as IMP-11 would
const handlers = new Map<string, { spec: OperationSpec; handler: OperationHandler }>()
const fakeRegistry = {
  register(spec: OperationSpec, handler: OperationHandler): void {
    handlers.set(spec.name, { spec, handler })
  }
}
registerMailOps(fakeRegistry as unknown as OperationRegistry, deps)

// handlers read txn.db/txn.ctx only; the event/effect channels are the
// registry's write-tx responsibility and are never exercised by C-MAIL ops,
// so this double throws if a handler ever reaches for them.
const txn = (ctx: AuthenticatedContext): TxnContext => ({
  db,
  ctx,
  emitEvent: (): never => {
    throw new Error('smoke: C-MAIL handlers emit through deps.appendDomainEvent, not txn.emitEvent')
  },
  intendEffect: (): never => {
    throw new Error('smoke: C-MAIL handlers declare no effect intents')
  }
})

const call = async <T>(op: string, ctx: AuthenticatedContext, payload: unknown): Promise<T> => {
  const h = handlers.get(op)
  if (!h) throw new Error(`op ${op} not registered`)
  return (await h.handler(txn(ctx), payload)) as T
}

// --------------------------------------------------------------------------
// seed
// --------------------------------------------------------------------------

const run = (sql: string, ...args: (string | number | null)[]): void => {
  db.prepare(sql).run(...args)
}
run("INSERT INTO principals VALUES ('pr_m1','member','active')")
run("INSERT INTO principals VALUES ('pr_m2','member','active')")
run("INSERT INTO principals VALUES ('pr_m3','member','active')")
run("INSERT INTO principals VALUES ('pr_svc','service','active')")
run(
  "INSERT INTO runs (id,project_id,model_version,goal_text,state,revision) VALUES ('run1','p1','mv1','goal','active',1)"
)
run(
  "INSERT INTO runs (id,project_id,model_version,goal_text,state,revision) VALUES ('run2','p1','mv1','other','active',1)"
)
const member = (id: string, runId: string, gen: number, exec: string): void =>
  run(
    "INSERT INTO members (id,run_id,model_version,role_id,implementation_id,implementation_revision,generation,current_execution_id,state,revision) VALUES (?,?,?,?,?,?,?,?,'active',1)",
    id,
    runId,
    'mv1',
    'role1',
    'impl1',
    1,
    gen,
    exec
  )
member('m1', 'run1', 1, 'e1')
member('m2', 'run1', 1, 'e2')
member('m3', 'run1', 1, 'e3')
member('mX', 'run2', 1, 'eX') // foreign run — scope denial checks
run(
  "INSERT INTO executions (id,member_id,generation,host_id,launch_plan_id,state,liveness,process_identity_json,native_conversation_json,revision) VALUES ('e1','m1',1,'h1','lp1','running','live','{}','{}',1)"
)
run(
  "INSERT INTO executions (id,member_id,generation,host_id,launch_plan_id,state,liveness,process_identity_json,native_conversation_json,revision) VALUES ('e2','m2',1,'h1','lp1','running','live','{}','{}',1)"
)
run("INSERT INTO tasks VALUES ('t1','run1',1,'d1')")
run("INSERT INTO task_specs VALUES ('t1',1,'t','req','role1','m1','{}','{}','{}')")
run(
  "INSERT INTO dispatches (id,task_id,task_revision,member_id,execution_id,generation,envelope_digest,phase,authority_state,revision) VALUES ('d1','t1',1,'m1','e1',1,'env','work','active',1)"
)
run("INSERT INTO resources VALUES ('r1','checkout','h1','{}')")
run(
  "INSERT INTO resource_claims (id,resource_id,owner_kind,owner_id,mode,generation,state,revision) VALUES ('cl1','r1','dispatch','d1','write',1,'held',1)"
)

const ctxFor = (
  principal: string,
  memberId: string,
  exec: string,
  gen: number
): AuthenticatedContext =>
  ({
    principalId: principal,
    memberId,
    executionId: exec,
    executionGeneration: gen,
    controllerEpoch: 1,
    grantRevisions: {},
    transportSessionId: 'smoke'
  }) as unknown as AuthenticatedContext

const ctx1 = ctxFor('pr_m1', 'm1', 'e1', 1)
const ctx2 = ctxFor('pr_m2', 'm2', 'e2', 1)
const ctx3g1 = ctxFor('pr_m3', 'm3', 'e3', 1)
const ctxSvc = {
  principalId: 'pr_svc',
  controllerEpoch: 1,
  grantRevisions: {},
  transportSessionId: 'smoke'
} as unknown as AuthenticatedContext

// --------------------------------------------------------------------------
// assertions
// --------------------------------------------------------------------------

let pass = 0
let failed = 0
const ok = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}`, extra ?? '')
  }
}
const expectErr = async (
  name: string,
  code: string,
  fn: () => unknown | Promise<unknown>
): Promise<void> => {
  try {
    await fn()
    failed++
    console.log(`  FAIL ${name} — expected ${code}, got success`)
  } catch (e) {
    const c = (e as MahasError)?.code
    if (c === code) {
      pass++
      console.log(`  ok   ${name} (${code})`)
    } else {
      failed++
      console.log(`  FAIL ${name} — expected ${code}, got`, e)
    }
  }
}
const q = (sql: string, ...a: (string | number)[]): Record<string, unknown> | undefined =>
  db.prepare(sql).get(...a) as Record<string, unknown> | undefined

const main = async (): Promise<void> => {
  console.log('IMP-15 mail/artifacts smoke\n— registration')
  const expected = [
    'inbox.check',
    'inbox.wait',
    'delivery.ack',
    'message.send',
    'message.replyAndAck',
    'artifact.publish',
    'artifact.read'
  ]
  ok(
    'all 7 ops registered',
    expected.every((n) => handlers.has(n))
  )

  console.log('— message.send')
  const send = await call<MessageSendResult>('message.send', ctx1, {
    recipientMemberIds: ['m2', 'm3', 'm2'], // dup collapses
    body: 'hello inbox',
    kind: 'question',
    taskRef: 't1'
  })
  ok('two distinct deliveries', send.deliveryIds.length === 2, send.deliveryIds)
  const d2 = q('SELECT * FROM deliveries WHERE recipient_member_id=?', 'm2')!
  ok('delivery outstanding/gen1', d2.status === 'outstanding' && d2.consumer_generation === 1, d2)
  ok(
    'message immutable row stored',
    q('SELECT body FROM messages WHERE id=?', send.messageId)?.body === 'hello inbox'
  )
  ok(
    'message.sent event appended',
    !!q("SELECT 1 AS x FROM domain_events WHERE event_type='message.sent'")
  )

  await expectErr('cross-run recipient denied', 'SCOPE_DENIED', () =>
    call('message.send', ctx1, { recipientMemberIds: ['mX'], body: 'x', kind: 'question' })
  )
  await expectErr('member principal cannot send assignment kind', 'SCOPE_DENIED', () =>
    call('message.send', ctx1, { recipientMemberIds: ['m2'], body: 'x', kind: 'assignment' })
  )
  const svcSend = await call<MessageSendResult>('message.send', ctxSvc, {
    recipientMemberIds: ['m1'],
    body: 'your assignment',
    kind: 'assignment'
  })
  ok(
    'service principal assignment has null sender_member_id',
    q('SELECT sender_member_id AS s FROM messages WHERE id=?', svcSend.messageId)?.s === null
  )

  console.log('— inbox.check (read is not ack)')
  const chk = await call<InboxCheckResult>('inbox.check', ctx2, {})
  ok('one outstanding item', chk.items.length === 1)
  ok('body delivered', chk.items[0]?.message.body === 'hello inbox')
  const chkAgain = await call<InboxCheckResult>('inbox.check', ctx2, {})
  ok('re-check returns same batch (not acked)', chkAgain.items.length === 1)
  ok('InboxRead snapshot carries deliveryIds', chk.read.deliveryIds.length === 1)

  console.log('— delivery.ack')
  await expectErr('stale revision refused', 'STALE_REVISION', () =>
    call('delivery.ack', ctx2, {
      deliveryId: send.deliveryIds[0],
      expectedDeliveryRevision: 9,
      handling: 'completed'
    })
  )
  await expectErr("cannot ack another member's delivery", 'SCOPE_DENIED', () =>
    call('delivery.ack', ctx3g1, {
      deliveryId: send.deliveryIds[0],
      expectedDeliveryRevision: 1,
      handling: 'completed'
    })
  )
  await expectErr('durably-deferred requires followup', 'INPUT_NOT_READY', () =>
    call('delivery.ack', ctx2, {
      deliveryId: send.deliveryIds[0],
      expectedDeliveryRevision: 1,
      handling: 'durably-deferred'
    })
  )
  const ack = await call<DeliveryAckResult>('delivery.ack', ctx2, {
    deliveryId: send.deliveryIds[0],
    expectedDeliveryRevision: 1,
    handling: 'completed'
  })
  ok('ackRevision = revision+1', ack.ackRevision === 2)
  ok(
    'status acknowledged + acked_at set',
    q('SELECT status, acked_at FROM deliveries WHERE id=?', send.deliveryIds[0]!)?.status ===
      'acknowledged'
  )
  await expectErr('second ack is a conflict', 'OPERATION_CONFLICT', () =>
    call('delivery.ack', ctx2, {
      deliveryId: send.deliveryIds[0],
      expectedDeliveryRevision: 2,
      handling: 'completed'
    })
  )

  console.log('— generation fence + rebind (m3: gen1 → gen2)')
  run('UPDATE members SET generation=2, revision=revision+1 WHERE id=?', 'm3')
  await expectErr('old generation credential fenced', 'STALE_EXECUTION', () =>
    call('inbox.check', ctx3g1, {})
  )
  const ctx3g2 = ctxFor('pr_m3', 'm3', 'e3b', 2)
  const chk3 = await call<InboxCheckResult>('inbox.check', ctx3g2, {})
  ok('rebound delivery visible to new generation', chk3.items.length === 1)
  ok(
    'delivery re-bound to generation 2 in the ledger',
    q('SELECT consumer_generation AS g FROM deliveries WHERE id=?', send.deliveryIds[1]!)?.g === 2
  )

  console.log('— message.replyAndAck (atomic reply+ack)')
  const rep = await call<MessageReplyAndAckResult>('message.replyAndAck', ctx3g2, {
    originalDeliveryId: send.deliveryIds[1],
    expectedDeliveryRevision: 2, // bumped by the rebind
    replyBody: 'ack and reply',
    handling: 'completed'
  })
  ok('reply message stored', !!q('SELECT 1 AS x FROM messages WHERE id=?', rep.replyMessageId))
  ok(
    'reply delivery outstanding to original sender',
    q('SELECT status FROM deliveries WHERE id=?', rep.deliveryIds[0]!)?.status === 'outstanding'
  )
  ok(
    'original acked in same op',
    rep.ackRevision === 3 &&
      q('SELECT status FROM deliveries WHERE id=?', send.deliveryIds[1]!)?.status === 'acknowledged'
  )
  ok(
    'reply carries replyTo link',
    (
      q('SELECT links_json AS l FROM messages WHERE id=?', rep.replyMessageId)?.l as string
    ).includes(send.deliveryIds[1] as string)
  )
  await expectErr('re-ack via replyAndAck conflicts', 'OPERATION_CONFLICT', () =>
    call('message.replyAndAck', ctx3g2, {
      originalDeliveryId: send.deliveryIds[1],
      replyBody: 'again',
      handling: 'completed'
    })
  )

  console.log('— fenced on retire')
  await call('message.send', ctx1, { recipientMemberIds: ['m3'], body: 'second', kind: 'notice' })
  const fenced = fenceDeliveriesForMember(db, 'm3')
  ok('outstanding delivery fenced', fenced === 1)
  const chkFenced = await call<InboxCheckResult>('inbox.check', ctx3g2, {})
  ok('fenced delivery not returned', chkFenced.items.length === 0)
  ok(
    'ledger keeps fenced status',
    q("SELECT status FROM deliveries WHERE recipient_member_id='m3' AND status='fenced'") !==
      undefined
  )

  console.log('— inbox.wait (bounded, honest timeout)')
  const t0 = Date.now()
  const wTimeout = await call<InboxWaitResult>('inbox.wait', ctx3g2, { maxWaitMs: 200 })
  ok('timeout returns empty, not error', wTimeout.timedOut === true && wTimeout.items.length === 0)
  ok(
    'waited approximately the bound',
    wTimeout.waitedMs >= 190 && Date.now() - t0 < 2000,
    wTimeout.waitedMs
  )
  // a send landing mid-wait wakes the poller with the batch
  setTimeout(() => {
    void call('message.send', ctx1, { recipientMemberIds: ['m3'], body: 'wake me', kind: 'notice' })
  }, 60)
  const wHit = await call<InboxWaitResult>('inbox.wait', ctx3g2, { maxWaitMs: 1500 })
  ok(
    'wait returns the new batch early',
    wHit.timedOut === false && wHit.items.length === 1 && wHit.waitedMs < 1500,
    {
      waitedMs: wHit.waitedMs,
      items: wHit.items.length
    }
  )
  // m3 still holds the un-acked 'wake me' delivery — a 0-bound wait must
  // return it immediately (wait never acks); the empty case needs m2's
  // drained inbox.
  const wZero = await call<InboxWaitResult>('inbox.wait', ctx3g2, { maxWaitMs: 0 })
  ok(
    'maxWaitMs=0 returns outstanding batch immediately',
    wZero.timedOut === false && wZero.items.length === 1
  )
  const wZeroEmpty = await call<InboxWaitResult>('inbox.wait', ctx2, { maxWaitMs: 0 })
  ok('maxWaitMs=0 on empty inbox is an immediate honest empty', wZeroEmpty.timedOut === true)

  console.log('— artifact.publish / artifact.read (file)')
  const coDir = mkdtempSync(join(tmpdir(), 'mahas-mail-co-'))
  writeFileSync(join(coDir, 'out.txt'), 'artifact-bytes')
  run(
    "INSERT INTO checkouts (id,resource_id,host_id,canonical_path,filesystem_identity,repository_json,revision) VALUES ('co1','r1','h1',?,'fs1','{}',1)",
    coDir
  )
  const pub = await call<ArtifactPublishResult>('artifact.publish', ctx1, {
    dispatchId: 'd1',
    outputSlot: 'result',
    source: 'file',
    sourcePath: 'out.txt',
    mediaType: 'text/plain'
  })
  ok(
    'publish returns digest of stored bytes',
    pub.digest === sha256Hex('artifact-bytes'),
    pub.digest
  )
  ok('artifact row stored', !!q('SELECT 1 AS x FROM artifacts WHERE id=?', pub.artifactId))
  ok(
    'retention pin recorded',
    !!q(
      "SELECT 1 AS x FROM retention_pins WHERE target_kind='content-blob' AND target_id=?",
      pub.digest
    )
  )
  const rd = await call<ArtifactReadResult>('artifact.read', ctx2, {
    artifactId: pub.artifactId,
    revision: 1,
    expectedDigest: pub.digest
  })
  ok(
    'same-run member reads bytes round-trip',
    rd.availability === 'bytes' &&
      Buffer.from(rd.dataBase64!, 'base64').toString() === 'artifact-bytes'
  )
  const rdRange = await call<ArtifactReadResult>('artifact.read', ctx2, {
    artifactId: pub.artifactId,
    revision: 1,
    expectedDigest: pub.digest,
    range: { offset: 0, length: 4 }
  })
  ok('range read slices bytes', rdRange.dataBase64 === Buffer.from('arti').toString('base64'))
  await expectErr('wrong expectedDigest refused', 'ARTIFACT_MISMATCH', () =>
    call('artifact.read', ctx2, {
      artifactId: pub.artifactId,
      revision: 1,
      expectedDigest: 'deadbeef'
    })
  )
  await expectErr('foreign-run member has no share scope', 'SCOPE_DENIED', () =>
    call('artifact.read', ctxFor('pr_mX', 'mX', 'eX', 1), {
      artifactId: pub.artifactId,
      revision: 1,
      expectedDigest: pub.digest
    })
  )
  await expectErr('publish with stale expectedDigest refused', 'ARTIFACT_MISMATCH', () =>
    call('artifact.publish', ctx1, {
      dispatchId: 'd1',
      outputSlot: 'result',
      source: 'file',
      sourcePath: 'out.txt',
      mediaType: 'text/plain',
      expectedDigest: 'nope'
    })
  )
  await expectErr('publish path escaping checkout denied', 'SCOPE_DENIED', () =>
    call('artifact.publish', ctx1, {
      dispatchId: 'd1',
      outputSlot: 'result',
      source: 'file',
      sourcePath: '../../etc/passwd',
      mediaType: 'text/plain'
    })
  )

  console.log('— artifact.publish / artifact.read (git-commit)')
  const repoDir = mkdtempSync(join(tmpdir(), 'mahas-mail-repo-'))
  execFileSync('git', ['init', '-q', repoDir])
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'smoke@test'])
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'smoke'])
  writeFileSync(join(repoDir, 'f.txt'), 'committed')
  execFileSync('git', ['-C', repoDir, 'add', 'f.txt'])
  execFileSync('git', ['-C', repoDir, 'commit', '-qm', 'c1'])
  const commitSha = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD']).toString().trim()
  run("INSERT INTO resources VALUES ('r2','checkout','h1','{}')")
  run(
    "INSERT INTO checkouts (id,resource_id,host_id,canonical_path,filesystem_identity,repository_json,revision) VALUES ('co2','r2','h1',?,'fs2','{}',1)",
    repoDir
  )
  run(
    "INSERT INTO resource_claims (id,resource_id,owner_kind,owner_id,mode,generation,state,revision) VALUES ('cl2','r2','dispatch','d1','write',1,'held',1)"
  )
  // two held checkouts now → implicit resolution is ambiguous, pass checkoutId
  await expectErr('ambiguous held checkouts need checkoutId', 'AMBIGUOUS_TERRITORY', () =>
    call('artifact.publish', ctx1, {
      dispatchId: 'd1',
      outputSlot: 'src',
      source: 'git-commit',
      commit: 'HEAD',
      mediaType: 'application/x-git'
    })
  )
  const pubGit = await call<ArtifactPublishResult>('artifact.publish', ctx1, {
    dispatchId: 'd1',
    outputSlot: 'src',
    source: 'git-commit',
    checkoutId: 'co2',
    commit: 'HEAD',
    mediaType: 'application/x-git'
  })
  ok('git commit pinned by canonical sha', pubGit.digest === commitSha, {
    got: pubGit.digest,
    want: commitSha
  })
  ok(
    'git-object retention pin',
    !!q(
      "SELECT 1 AS x FROM retention_pins WHERE target_kind='git-object' AND target_id=?",
      commitSha
    )
  )
  const rdGit = await call<ArtifactReadResult>('artifact.read', ctx1, {
    artifactId: pubGit.artifactId,
    revision: 1,
    expectedDigest: commitSha
  })
  ok(
    'git artifact returns identity reference (no live path)',
    rdGit.availability === 'reference' &&
      rdGit.gitRef?.commit === commitSha &&
      rdGit.gitRef?.checkoutId === 'co2'
  )
  await expectErr('missing commit object refused', 'ARTIFACT_MISMATCH', () =>
    call('artifact.publish', ctx1, {
      dispatchId: 'd1',
      outputSlot: 'src',
      source: 'git-commit',
      checkoutId: 'co2',
      commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      mediaType: 'application/x-git'
    })
  )

  console.log(`\n${pass} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
