// VER-02 Step 1 — fault injection at DB write boundaries (REQ-02, REQ-14,
// REQ-18, REQ-22). Real implementation modules only; real node:sqlite DBs.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync, chmodSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import {
  Recorder,
  wireRuntime,
  seedAll,
  ctxFor,
  storage,
  publishCandidate,
  emptySnapshot,
  type ModelSnapshot
} from './common.ts'

const DIR = '/tmp/mahas-ver-02/s1'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
mkdirSync(`${DIR}/repo`, { recursive: true })

const rec = new Recorder('s1-fault-injection')
const count = (db: DatabaseSync, t: string): number =>
  Number((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n)

/* ================================================================
 * 1a — withTx throw → complete rollback (baseline atomicity, REQ-02)
 * ================================================================ */
{
  const db = storage.openControlDb(`${DIR}/a.sqlite`, { contentStoreDir: `${DIR}/a.blobs` })
  const bytes = new TextEncoder().encode('blob-A')
  const digest = storage.sha256Hex(bytes)
  let threw = ''
  try {
    storage.withTx(db, (tx) => {
      storage.putContentBlob(tx, bytes, 'text/plain')
      tx.prepare("INSERT INTO principals(id,kind,status) VALUES('pa','member','active')").run()
      throw new Error('injected-failure-after-writes')
    })
  } catch (e) {
    threw = String(e)
  }
  rec.check('1a throw propagates', threw.includes('injected-failure'), 'injected error', threw)
  rec.check(
    '1a all writes rolled back',
    count(db, 'content_blobs') === 0 && count(db, 'principals') === 0,
    '0 content_blobs + 0 principals',
    `${count(db, 'content_blobs')}/${count(db, 'principals')}`
  )
  rec.check('1a getContentBlob misses', storage.getContentBlob(db, digest) === null, 'null', 'null')
  db.close()
}

/* ================================================================
 * 1b — nested withTx → savepoint rollback only, outer commits
 * ================================================================ */
{
  const db = storage.openControlDb(`${DIR}/b.sqlite`, { contentStoreDir: `${DIR}/b.blobs` })
  const a = new TextEncoder().encode('outer-A')
  const b = new TextEncoder().encode('inner-B')
  storage.withTx(db, (tx) => {
    storage.putContentBlob(tx, a, 'text/plain')
    try {
      storage.withTx(tx, (inner) => {
        storage.putContentBlob(inner, b, 'text/plain')
        throw new Error('inner-failure')
      })
    } catch {
      /* outer swallows: inner must be rolled back, outer survives */
    }
  })
  const haveA = storage.getContentBlob(db, storage.sha256Hex(a)) !== null
  const haveB = storage.getContentBlob(db, storage.sha256Hex(b)) !== null
  rec.check('1b savepoint: outer kept, inner rolled back', haveA && !haveB, 'A present B absent', `A=${haveA} B=${haveB}`)
  db.close()
}

/* ================================================================
 * 1c — commitUnitOfWork: mutation+receipt+event+effect unit is atomic
 * ================================================================ */
{
  const db = storage.openControlDb(`${DIR}/c.sqlite`, { contentStoreDir: `${DIR}/c.blobs` })
  // positive control: full unit commits
  const receipt = {
    operationId: 'op-c1',
    operation: 'probe.op',
    fingerprint: 'fp-c1',
    status: 'committed',
    result: { ok: true },
    effects: [],
    domainRevision: 0,
    eventCursor: 0
  }
  storage.commitUnitOfWork(db, {
    mutate: (tx: DatabaseSync) => {
      tx.prepare("INSERT INTO principals(id,kind,status) VALUES('pc','member','active')").run()
      return 'mutated'
    },
    writes: () => ({
      receipts: [{ receipt, principalScope: 'pr_scope' }],
      events: [
        {
          aggregateId: 'agg1',
          aggregateRevision: 1,
          eventType: 'probe.event',
          scope: { s: 1 },
          payload: { p: 1 }
        }
      ],
      effectIntents: [
        {
          id: 'eff-1',
          operationKey: 'opkey-1',
          kind: 'probe',
          fingerprint: 'effp',
          state: 'prepared',
          payload: {}
        }
      ]
    })
  })
  const ok =
    count(db, 'principals') === 1 &&
    count(db, 'operation_receipts') === 1 &&
    count(db, 'domain_events') === 1 &&
    count(db, 'effect_intents') === 1 &&
    count(db, 'effect_outbox') === 1
  rec.check('1c unit commits atomically', ok, '1 each of principal/receipt/event/intent/outbox', `1/1/1/1/1 observed=${ok}`)

  // fault: writes() produces a receipt lacking `operation` → insertReceipt
  // throws INSIDE the same tx → mutate() rows must roll back too.
  let threw = ''
  try {
    storage.commitUnitOfWork(db, {
      mutate: (tx: DatabaseSync) => {
        tx.prepare("INSERT INTO principals(id,kind,status) VALUES('pc2','member','active')").run()
        tx.prepare("INSERT INTO content_blobs(digest,media_type,byte_length,body,verified) VALUES('dgc','t',1,x'00',1)").run()
        return 'mutated2'
      },
      writes: () => ({
        receipts: [
          {
            receipt: {
              operationId: 'op-c2',
              // operation intentionally missing → insertReceipt throws
              fingerprint: 'fp-c2',
              status: 'committed',
              effects: [],
              domainRevision: 0,
              eventCursor: 0
            },
            principalScope: 'pr_scope'
          }
        ],
        events: [
          {
            aggregateId: 'agg2',
            aggregateRevision: 1,
            eventType: 'probe.event2',
            scope: {},
            payload: {}
          }
        ],
        effectIntents: [
          {
            id: 'eff-2',
            operationKey: 'opkey-2',
            kind: 'probe',
            fingerprint: 'effp2',
            state: 'prepared',
            payload: {}
          }
        ]
      })
    })
  } catch (e) {
    threw = String(e)
  }
  rec.check('1c write-stage failure throws', threw.length > 0, 'error', threw.slice(0, 120))
  const principalPc2 = db.prepare("SELECT count(*) AS n FROM principals WHERE id='pc2'").get() as { n: number }
  const blobDgc = db.prepare("SELECT count(*) AS n FROM content_blobs WHERE digest='dgc'").get() as { n: number }
  const ev2 = db.prepare("SELECT count(*) AS n FROM domain_events WHERE aggregate_id='agg2'").get() as { n: number }
  const eff2 = db.prepare("SELECT count(*) AS n FROM effect_intents WHERE id='eff-2'").get() as { n: number }
  const rcpt2 = db.prepare("SELECT count(*) AS n FROM operation_receipts WHERE operation_id='op-c2'").get() as { n: number }
  rec.check(
    '1c fault rolls back mutate+writes together',
    Number(principalPc2.n) === 0 &&
      Number(blobDgc.n) === 0 &&
      Number(ev2.n) === 0 &&
      Number(eff2.n) === 0 &&
      Number(rcpt2.n) === 0,
    'pc2/dgc/agg2/eff-2/op-c2 all absent',
    `${principalPc2.n}/${blobDgc.n}/${ev2.n}/${eff2.n}/${rcpt2.n}`
  )
  db.close()
}

/* ================================================================
 * 1d — model publication: mid-write failure inside publishCandidate
 *      (planted rdd_boundaries PK conflict after the CAS). REQ-22.
 * ================================================================ */
{
  const db = storage.openControlDb(`${DIR}/d.sqlite`, { contentStoreDir: `${DIR}/d.blobs` })
  storage.withTx(db, () => {
    db.prepare(
      "INSERT INTO projects(id,name,goal,repository_root,active_model_version,revision) VALUES('p1','proj','goal','/r',NULL,1)"
    ).run()
    db.prepare(
      "INSERT INTO model_versions(id,project_id,parent_version,root_boundary_id,goal_snapshot,status,digest,created_at) VALUES('mv_base','p1',NULL,NULL,'goal','published','dg',1)"
    ).run()
    db.prepare(
      "INSERT INTO rdd_boundaries(model_version,id,name,responsibility_statement) VALUES('mv_base','b1','root','root')"
    ).run()
    db.prepare("UPDATE model_versions SET root_boundary_id='b1' WHERE id='mv_base'").run()
    db.prepare("UPDATE projects SET active_model_version='mv_base' WHERE id='p1'").run()
    db.prepare(
      "INSERT INTO model_changes(id,project_id,base_version,candidate_digest,state,edits_json,touched_targets_json,diagnostics_json) VALUES('chg1','p1','mv_base','cd','prepared','[]','[]','{}')"
    ).run()
  })
  const snapshot: ModelSnapshot = emptySnapshot('goal2')
  snapshot.boundaries.set('b1', {
    id: 'b1', name: 'root', responsibilityStatement: 'root', parentId: null,
    paths: [], criteria: [], contextIds: []
  })
  snapshot.boundaries.set('b2', {
    id: 'b2', name: 'child', responsibilityStatement: 'child', parentId: 'b1',
    paths: [], criteria: [], contextIds: []
  })
  let threw = ''
  try {
    storage.withTx(db, (tx) => {
      // plant the conflicting boundary row inside the same tx — it satisfies
      // its deferred FK at commit only if mv_new were to exist.
      tx.prepare(
        "INSERT INTO rdd_boundaries(model_version,id,name,responsibility_statement) VALUES('mv_new','b2','planted','planted')"
      ).run()
      publishCandidate(tx, {
        project: {
          id: 'p1', name: 'proj', goal: 'goal', repositoryRoot: '/r',
          activeModelVersion: 'mv_base', revision: 2
        } as never,
        change: {
          id: 'chg1', projectId: 'p1', baseVersion: 'mv_base',
          candidateDigest: 'cd', state: 'prepared', edits: [],
          touchedTargets: [], diagnostics: {}
        } as never,
        snapshot,
        snapshotDigest: 'sd',
        expectedActiveVersion: 'mv_base',
        semanticDecision: 'approve',
        semanticReviewItems: [],
        now: 1000,
        newVersionId: 'mv_new'
      })
    })
  } catch (e) {
    threw = String(e)
  }
  rec.check('1d publish throws on PK conflict', threw.length > 0, 'SQLITE_CONSTRAINT', threw.slice(0, 140))
  const proj = db.prepare("SELECT active_model_version AS v, revision AS r FROM projects WHERE id='p1'").get() as { v: string | null; r: number }
  const mvNew = db.prepare("SELECT count(*) AS n FROM model_versions WHERE id='mv_new'").get() as { n: number }
  const bNew = db.prepare("SELECT count(*) AS n FROM rdd_boundaries WHERE model_version='mv_new'").get() as { n: number }
  const baseStatus = db.prepare("SELECT status AS s FROM model_versions WHERE id='mv_base'").get() as { s: string }
  const chg = db.prepare("SELECT state AS s FROM model_changes WHERE id='chg1'").get() as { s: string }
  const evPub = db.prepare("SELECT count(*) AS n FROM domain_events WHERE event_type='ModelPublished'").get() as { n: number }
  rec.check(
    '1d CAS reverted — active pointer still mv_base',
    proj.v === 'mv_base',
    'mv_base', String(proj.v)
  )
  rec.check(
    '1d no partial version payload',
    Number(mvNew.n) === 0 && Number(bNew.n) === 0,
    'mv_new+its boundaries absent', `mv=${mvNew.n} bounds=${bNew.n}`
  )
  rec.check('1d base not superseded', baseStatus.s === 'published', 'published', baseStatus.s)
  rec.check('1d change not committed', chg.s === 'prepared', 'prepared', chg.s)
  rec.check('1d no ModelPublished event', Number(evPub.n) === 0, '0', String(evPub.n))
  db.close()
}

/* ================================================================
 * 1e — message.send: failure after message+delivery inserts inside the
 *      REAL dispatch tx (injected via sanctioned deps seam). REQ-14.
 * ================================================================ */
{
  const rt = await wireRuntime(`${DIR}/e.sqlite`, {
    contentStoreDir: `${DIR}/e.blobs`,
    mailDeps: {
      appendDomainEvent: (
        db: DatabaseSync,
        agg: string,
        rev: number,
        eventType: string,
        scope: unknown,
        payload: unknown
      ) => {
        if (eventType === 'message.sent') {
          throw new Error('INJECTED: fsync/event-sink failure after inserts')
        }
        return storage.appendDomainEvent(db, agg, rev, eventType, scope, payload)
      }
    }
  })
  seedAll(rt.db)
  const ctx = ctxFor('pr_m1', 'm1', 'e1', 1)
  let threw = ''
  let receipt: any = null
  try {
    receipt = await rt.dispatch(ctx, 'message.send', {
      recipientMemberIds: ['m2', 'm3'],
      body: 'will fail at event append',
      kind: 'question'
    }, 'op-e1')
  } catch (e) {
    threw = String(e)
  }
  const msgs = count(rt.db, 'messages')
  const dlvs = count(rt.db, 'deliveries')
  const evs = count(rt.db, 'domain_events')
  const rcpts = count(rt.db, 'operation_receipts')
  rec.check('1e dispatch surfaced the failure', threw.length > 0 || receipt?.status === 'rejected', 'throw or rejected', `threw=${threw.slice(0, 80)} status=${receipt?.status}`)
  rec.check(
    '1e message+deliveries rolled back atomically',
    msgs === 0 && dlvs === 0,
    '0 messages 0 deliveries', `m=${msgs} d=${dlvs}`
  )
  rec.check('1e no orphan event', evs === 0, '0 domain_events', String(evs))
  rec.check('1e no receipt persisted', rcpts === 0, '0 receipts', String(rcpts))
  rt.close()
}

/* ================================================================
 * 1f — reply+ack: failure at the ack boundary rolls back the reply too.
 *      REQ-18.
 * ================================================================ */
{
  // first a healthy runtime to create the original delivery
  const rtOk = await wireRuntime(`${DIR}/f.sqlite`, { contentStoreDir: `${DIR}/f.blobs` })
  seedAll(rtOk.db)
  const rSend = await rtOk.dispatch(ctxFor('pr_m1', 'm1', 'e1', 1), 'message.send', {
    recipientMemberIds: ['m2'],
    body: 'original',
    kind: 'question'
  }, 'op-f-send')
  const dlvId = rSend.result.deliveryIds[0] as string
  rtOk.close()

  // reopen with the event-append fault armed for delivery.acknowledged
  const rt = await wireRuntime(`${DIR}/f.sqlite`, {
    contentStoreDir: `${DIR}/f.blobs`,
    mailDeps: {
      appendDomainEvent: (
        db: DatabaseSync,
        agg: string,
        rev: number,
        eventType: string,
        scope: unknown,
        payload: unknown
      ) => {
        if (eventType === 'delivery.acknowledged') {
          throw new Error('INJECTED: event-sink failure inside ack boundary')
        }
        return storage.appendDomainEvent(db, agg, rev, eventType, scope, payload)
      }
    }
  })
  let threw = ''
  let receipt: any = null
  try {
    receipt = await rt.dispatch(ctxFor('pr_m2', 'm2', 'e2', 1), 'message.replyAndAck', {
      originalDeliveryId: dlvId,
      expectedDeliveryRevision: 1,
      replyBody: 'reply that must roll back',
      handling: 'completed'
    }, 'op-f-ra')
  } catch (e) {
    threw = String(e)
  }
  const dlv = rt.db.prepare('SELECT status AS s, revision AS r FROM deliveries WHERE id=?').get(dlvId) as { s: string; r: number }
  const replyMsgs = rt.db.prepare("SELECT count(*) AS n FROM messages WHERE kind='reply'").get() as { n: number }
  const allDlvs = count(rt.db, 'deliveries')
  const evs = count(rt.db, 'domain_events')
  const rcpts = count(rt.db, 'operation_receipts')
  rec.check('1f dispatch surfaced the failure', threw.length > 0 || receipt?.status === 'rejected', 'throw or rejected', `threw=${threw.slice(0, 80)} status=${receipt?.status}`)
  rec.check('1f original delivery still outstanding rev1', dlv.s === 'outstanding' && dlv.r === 1, 'outstanding/1', `${dlv.s}/${dlv.r}`)
  rec.check('1f no reply message persisted', Number(replyMsgs.n) === 0, '0', String(replyMsgs.n))
  rec.check('1f no extra deliveries', allDlvs === 1, '1 (original only)', String(allDlvs))
  rec.check('1f no ack event', evs === 1, '1 (only message.sent)', String(evs))
  rec.check('1f no receipt persisted', rcpts === 1, '1 (send receipt only)', String(rcpts))
  rt.close()
}

/* ================================================================
 * 1g — SQLITE_BUSY: second writer holds the write lock; dispatch must
 *      fail rather than partially commit. (busy_timeout=5000)
 * ================================================================ */
{
  const rt = await wireRuntime(`${DIR}/g.sqlite`, { contentStoreDir: `${DIR}/g.blobs` })
  seedAll(rt.db)
  const rival = new DatabaseSync(`${DIR}/g.sqlite`)
  rival.exec('PRAGMA busy_timeout=0')
  rival.exec('BEGIN IMMEDIATE')
  rival.prepare("INSERT INTO principals(id,kind,status) VALUES('pr_rival','member','active')").run()
  const t0 = Date.now()
  let threw = ''
  let receipt: any = null
  try {
    receipt = await rt.dispatch(ctxFor('pr_m1', 'm1', 'e1', 1), 'message.send', {
      recipientMemberIds: ['m2'],
      body: 'blocked by rival writer',
      kind: 'question'
    }, 'op-g1')
  } catch (e) {
    threw = String(e)
  }
  const waitedMs = Date.now() - t0
  rec.check('1g dispatch failed under rival writer', threw.length > 0 || receipt?.status === 'rejected', 'BUSY error', `threw=${threw.slice(0, 100)} status=${receipt?.status} waited=${waitedMs}ms`)
  rec.check(
    '1g no partial rows from blocked dispatch',
    count(rt.db, 'messages') === 0 && count(rt.db, 'deliveries') === 0,
    '0 messages 0 deliveries', `m=${count(rt.db, 'messages')} d=${count(rt.db, 'deliveries')}`
  )
  rival.exec('ROLLBACK')
  rival.close()
  rt.close()
}

/* ================================================================
 * 1h — kill -9 mid-transaction → WAL recovery on reopen. REQ-02.
 * ================================================================ */
{
  const dbPath = `${DIR}/h.sqlite`
  // baseline commit + leave a wal file
  {
    const warm = storage.openControlDb(dbPath)
    warm.prepare("INSERT INTO principals(id,kind,status) VALUES('pr_warm','member','active')").run()
    warm.close()
  }
  const child = spawn('node', ['/tmp/mahas-ver-02/harness/s1-child.ts', dbPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  const ready = new Promise<void>((resolve) => {
    child.stdout.on('data', (d) => {
      out += String(d)
      if (out.includes('UNCOMMITTED-READY')) resolve()
    })
    child.stderr.on('data', (d) => console.error('[child stderr]', String(d)))
  })
  await Promise.race([ready, new Promise((r) => setTimeout(r, 15000))])
  const walExisted = existsSync(`${dbPath}-wal`)
  child.kill('SIGKILL')
  await new Promise((r) => child.on('exit', r))
  rec.check('1h child reached uncommitted state', out.includes('UNCOMMITTED-READY'), 'marker', out.trim().split('\n').join('|'))

  // reopen via the real opener — WAL recovery must restore consistency
  const db = storage.openControlDb(dbPath)
  const base = db.prepare("SELECT count(*) AS n FROM principals WHERE id='pr_warm'").get() as { n: number }
  const unc = db.prepare("SELECT count(*) AS n FROM principals WHERE id IN ('pr_unc','pr_unc2')").get() as { n: number }
  const proj = db.prepare("SELECT count(*) AS n FROM projects WHERE id='pbase'").get() as { n: number }
  rec.check('1h committed baseline survived crash', Number(base.n) === 1 && Number(proj.n) === 1, 'warm+baseline present', `warm=${base.n} pbase=${proj.n}`)
  rec.check('1h uncommitted rows absent after crash', Number(unc.n) === 0, '0', String(unc.n), { walExisted })
  // DB is usable for new writes post-recovery
  storage.withTx(db, (tx) => {
    tx.prepare("INSERT INTO principals(id,kind,status) VALUES('pr_post','member','active')").run()
  })
  const post = db.prepare("SELECT count(*) AS n FROM principals WHERE id='pr_post'").get() as { n: number }
  rec.check('1h db writable after recovery', Number(post.n) === 1, '1', String(post.n))
  db.close()
}

/* ================================================================
 * 1i — read-only DB surface: open must fail or writes must fail,
 *      never silently degrade. REQ-02 durability precondition.
 * ================================================================ */
{
  const roDir = `${DIR}/ro`
  mkdirSync(roDir, { recursive: true })
  const roPath = `${roDir}/ro.sqlite`
  {
    const db = storage.openControlDb(roPath)
    db.prepare("INSERT INTO principals(id,kind,status) VALUES('pr_ro','member','active')").run()
    db.close()
  }
  // explicit read-only open: a write must fail, not silently land nowhere
  const roDb = new DatabaseSync(roPath, { readOnly: true })
  let threw = ''
  try {
    storage.withTx(roDb, (tx) => {
      tx.prepare("INSERT INTO principals(id,kind,status) VALUES('pr_ro2','member','active')").run()
    })
  } catch (e) {
    threw = String(e)
  }
  rec.check('1i read-only connection refuses write tx', threw.length > 0, 'SQLITE error', threw.slice(0, 140))
  const n = roDb.prepare("SELECT count(*) AS n FROM principals").get() as { n: number }
  rec.check('1i no phantom write', Number(n.n) === 1, '1 principal', String(n.n))
  roDb.close()
  // openControlDb on a chmod-locked file must fail loudly, not degrade
  chmodSync(roPath, 0o444)
  chmodSync(`${roPath}-wal`, 0o444)
  chmodSync(`${roPath}-shm`, 0o444)
  chmodSync(roDir, 0o555)
  let openErr = ''
  try {
    storage.openControlDb(roPath).close()
  } catch (e) {
    openErr = String(e)
  }
  rec.check('1i openControlDb fails on unwritable db', openErr.length > 0, 'error', openErr.slice(0, 140))
  chmodSync(roDir, 0o755)
  chmodSync(roPath, 0o644)
}

/* ================================================================
 * 1j — report+settlement boundary: ops unregistered (IMP-21 gap) +
 *      storage-level atomicity proof over outcomes+settlements rows.
 * ================================================================ */
{
  const rt = await wireRuntime(`${DIR}/j.sqlite`, { contentStoreDir: `${DIR}/j.blobs` })
  seedAll(rt.db)
  const hasReport = rt.registry.has('task.report')
  const hasDecide = rt.registry.has('outcome.decide')
  rec.check('1j task.report registered', hasReport === false, 'false (gap)', String(hasReport))
  rec.check('1j outcome.decide registered', hasDecide === false, 'false (gap)', String(hasDecide))
  const rep = await rt.dispatch(ctxFor('pr_m1', 'm1', 'e1', 1), 'task.report', {
    dispatchId: 'd1', result: 'done'
  }, 'op-j-report')
  rec.check(
    '1j task.report dispatch → UNAVAILABLE_OPERATION',
    rep?.status === 'rejected' && rep?.error?.code === 'UNAVAILABLE_OPERATION',
    'rejected/UNAVAILABLE_OPERATION', `${rep?.status}/${rep?.error?.code}`
  )
  // storage-level: outcome+settlement insert then throw → both roll back
  let threw = ''
  try {
    storage.withTx(rt.db, (tx) => {
      tx.prepare(
        "INSERT INTO outcomes(id,revision,task_id,task_revision,dispatch_id,result,rationale,assessment_json,contract_effects_json) VALUES('o1',1,'t1',1,'d1','ok','r','{}','{}')"
      ).run()
      tx.prepare(
        "INSERT INTO settlements(id,outcome_id,outcome_revision,authority_member_id,decision,reason,decided_at) VALUES('s1','o1',1,'m1','accept','ok',1)"
      ).run()
      throw new Error('injected-failure-after-settlement')
    })
  } catch (e) {
    threw = String(e)
  }
  const oN = count(rt.db, 'outcomes')
  const sN = count(rt.db, 'settlements')
  rec.check(
    '1j outcome+settlement rows rolled back together',
    Number(oN) === 0 && Number(sN) === 0,
    '0 outcomes 0 settlements', `${oN}/${sN}`
  )
  rt.close()
}

rec.flush()
