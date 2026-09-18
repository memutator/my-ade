// VER-02 Step 5 — consistent backup → restore + corrupted-set rejection
// (REQ-27, spec/storage.md §7, spec/contracts/recovery-operations.md).
//
// Positive: backup.create takes a sqlite3_serialize consistent image (never a
// raw WAL-file copy), binds it in a self-digesting manifest, pins content;
// backup.restore to a fresh target resurrects data but marks every past
// execution unverifiable — never a writer again.
// Negative: missing manifest / tampered manifest / missing or corrupt
// snapshot / missing content file / live-writer target / live-control target
// / unattested stop — every one REJECTED with nothing written.
import { DatabaseSync } from 'node:sqlite'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import {
  Recorder,
  wireRuntime,
  seedAll,
  ctxFor,
  storage,
  readBackupManifest,
  restoreBackupSetStandalone
} from './common.ts'

const DIR = '/tmp/mahas-ver-02/s5'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
mkdirSync('/tmp/mahas-ver-02/repo', { recursive: true })

const backupRoot = `${DIR}/backups`
const blobDir = `${DIR}/blobs`
const dbPath = `${DIR}/control.sqlite`
const hostPath = `${DIR}/host.sqlite`
const rec = new Recorder('s5-backup-restore')

const count = (db: DatabaseSync, t: string): number =>
  Number((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n)

// a stand-alone "execution-host" db (any sqlite file — hosts snapshot via serialize)
{
  const h = new DatabaseSync(hostPath)
  h.exec('CREATE TABLE host_state(id TEXT PRIMARY KEY, v TEXT)')
  h.prepare("INSERT INTO host_state VALUES('hs1','alive')").run()
  h.close()
}

const backupDeps = {
  backupRoot,
  controlDbPath: dbPath,
  externalBlobDir: blobDir,
  hostDbPaths: () => [hostPath]
}
const rt = await wireRuntime(dbPath, { contentStoreDir: blobDir, backupDeps })
seedAll(rt.db)
// keep committed rows in the WAL (no auto-checkpoint) so the snapshot must
// prove it captured WAL-resident data, not just the stale main file.
rt.db.exec('PRAGMA wal_autocheckpoint=0')

const rSend = await rt.dispatch(ctxFor('pr_m1', 'm1', 'e1', 1), 'message.send', {
  recipientMemberIds: ['m2'],
  body: 'pre-backup message',
  kind: 'question'
}, 'op-s5-send')
const ext = storage.putExternalContentBlob(rt.db, new TextEncoder().encode('external payload s5'), 'text/plain')
writeFileSync('/tmp/mahas-ver-02/repo/out.txt', 's5 artifact bytes')
const rArt = await rt.dispatch(ctxFor('pr_m1', 'm1', 'e1', 1), 'artifact.publish', {
  dispatchId: 'd1', outputSlot: 'result', source: 'file',
  sourcePath: 'out.txt', mediaType: 'text/plain'
}, 'op-s5-art')
// committed row that stays WAL-resident until a checkpoint runs
storage.withTx(rt.db, (tx) => {
  tx.prepare("INSERT INTO principals(id,kind,status) VALUES('pr_walonly','member','active')").run()
})
const walBytes = existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0
rec.check('5a WAL holds committed data at backup time', walBytes > 0, '>0 bytes in -wal', String(walBytes))

/* counter-evidence: a raw main-file copy of the LIVE db silently loses the
 * WAL-resident row — exactly the success backup.create must never claim. */
const rawCopy = `${DIR}/rawcopy.sqlite`
copyFileSync(dbPath, rawCopy)
{
  let rawDb: DatabaseSync
  try {
    rawDb = new DatabaseSync(rawCopy, { readOnly: true })
  } catch {
    rawDb = new DatabaseSync(rawCopy)
  }
  let rawObserved = ''
  let rawOk = false
  try {
    const n = rawDb.prepare("SELECT count(*) AS n FROM principals WHERE id='pr_walonly'").get() as { n: number }
    rawObserved = `row present=${Number(n.n)}`
    rawOk = Number(n.n) === 0
  } catch (e) {
    // table itself absent — the raw copy lost not just the row but the whole
    // WAL-resident schema+data. Even stronger evidence.
    rawObserved = `query threw: ${e instanceof Error ? e.message : String(e)}`
    rawOk = true
  }
  rec.check(
    '5a raw main-file copy drops WAL-resident committed data (why serialize is required)',
    rawOk,
    'row/schema absent in raw copy',
    rawObserved,
    { note: 'documentary evidence of the failure mode, not a product verdict' }
  )
  rawDb.close()
}

/* ================= 5a — backup.create via the real registry ================ */
const rCreate = await rt.dispatch(ctxFor('pr_op'), 'backup.create', {
  scope: {},
  retentionPolicy: { keep: 'ver-02' }
}, 'op-s5-backup')
rec.check('5a backup.create committed', rCreate?.status === 'committed', 'committed', `${rCreate?.status}/${rCreate?.error?.code}`)
const createRes = rCreate?.result as {
  id: string; state: string; dir: string; manifestDigest: string;
  consistencyPoint: { method: string; imageDigest: string; imageBytes: number };
  contentPins: string[]; residues: unknown[]
}
const setId = createRes.id
const setDir = createRes.dir
{
  rec.check('5a state complete (no residues)', createRes.state === 'complete', 'complete', `${createRes.state} residues=${JSON.stringify(createRes.residues)}`)
  rec.check(
    '5a snapshot method is sqlite3_serialize, never raw copy',
    createRes.consistencyPoint.method === 'sqlite3_serialize',
    'sqlite3_serialize',
    createRes.consistencyPoint.method
  )
  const files = {
    control: existsSync(join(setDir, 'control.sqlite')),
    manifest: existsSync(join(setDir, 'manifest.json')),
    host: existsSync(join(setDir, 'hosts', `host-0-${'host.sqlite'}`)),
    blob: existsSync(join(setDir, 'blobs', ext.digest))
  }
  rec.check(
    '5a set dir holds control+manifest+host+blob',
    files.control && files.manifest && files.host && files.blob,
    'all present', JSON.stringify(files)
  )
  // artifact with storageRef {kind:'content-blob'} stays 'ref-recorded' —
  // its inline bytes already travel inside the snapshot image.
  const manifest0 = readBackupManifest(setDir)
  const artEntry = manifest0.artifacts.find((a) => a.artifactId === (rArt?.result as { artifactId?: string })?.artifactId)
  rec.check(
    '5a artifact recorded in manifest as ref-recorded (no separate file needed)',
    artEntry?.status === 'ref-recorded',
    'ref-recorded',
    JSON.stringify(artEntry)
  )
  // manifest self-digest verifies on read-back
  const manifest = readBackupManifest(setDir)
  rec.check(
    '5a manifest digest binds snapshot image',
    manifest.consistencyPoint.imageDigest === manifest.control.sha256 &&
      manifest.manifestDigest === createRes.manifestDigest,
    'imageDigest==control.sha256==row digest',
    `${manifest.consistencyPoint.imageDigest.slice(0, 12)}/${manifest.control.sha256.slice(0, 12)}/${String(manifest.manifestDigest).slice(0, 12)}`
  )
  const row = rt.db.prepare('SELECT state, manifest_digest FROM backup_sets WHERE id=?').get(setId) as { state: string; manifest_digest: string }
  rec.check('5a backup_sets row recorded', row?.state === 'complete' && row?.manifest_digest === createRes.manifestDigest, 'complete+ digest', JSON.stringify(row))
  const pins = rt.db.prepare("SELECT target_kind, holder_kind FROM retention_pins WHERE holder_id=?").all(setId) as { target_kind: string; holder_kind: string }[]
  const pinKinds = new Set(pins.map((p) => `${p.holder_kind}:${p.target_kind}`))
  rec.check(
    '5a content+artifact pinned under backup_set holder',
    pins.length >= 2 && pinKinds.has('backup_set:content_blob') && pinKinds.has('backup_set:artifact'),
    '>=2 pins incl content_blob+artifact',
    JSON.stringify(pins)
  )
  const ev = rt.db.prepare("SELECT count(*) AS n FROM domain_events WHERE event_type='backup.created' AND aggregate_id=?").get(setId) as { n: number }
  rec.check('5a backup.created event appended', Number(ev.n) === 1, '1', String(ev.n))
  // the snapshot image itself: consistent, integrity-clean, HAS the WAL row
  let snap: DatabaseSync
  try {
    snap = new DatabaseSync(join(setDir, 'control.sqlite'), { readOnly: true })
  } catch {
    snap = new DatabaseSync(join(setDir, 'control.sqlite'))
  }
  const integ = snap.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
  const walRow = snap.prepare("SELECT count(*) AS n FROM principals WHERE id='pr_walonly'").get() as { n: number }
  const msgs = count(snap, 'messages')
  rec.check('5a snapshot integrity_check ok', integ.integrity_check === 'ok', 'ok', integ.integrity_check)
  rec.check(
    '5a snapshot contains WAL-resident committed row (no raw-copy loss)',
    Number(walRow.n) === 1 && msgs >= 1,
    'pr_walonly + message present',
    `walRow=${walRow.n} msgs=${msgs}`
  )
  snap.close()
  // replay: same operationId+payload → stored receipt, no second set
  const rReplay = await rt.dispatch(ctxFor('pr_op'), 'backup.create', {
    scope: {},
    retentionPolicy: { keep: 'ver-02' }
  }, 'op-s5-backup')
  const nSets = count(rt.db, 'backup_sets')
  rec.check(
    '5a backup.create replay returns stored receipt, no second set',
    rReplay?.status === 'committed' && (rReplay.result as { id: string }).id === setId && nSets === 1,
    'committed same id, 1 row',
    `${rReplay?.status}/${(rReplay?.result as { id?: string })?.id}/sets=${nSets}`
  )
}

/* ================= 5b — backup.restore to a fresh target =================== */
const restoredDbPath = `${DIR}/restored/control.sqlite`
const restoredBlobDir = `${DIR}/restored/blobs`
const restoredHostPath = `${DIR}/restored/host.sqlite`
const restorePayload = {
  backupSetId: setId,
  expectedRuntimeStopped: true,
  targetPath: restoredDbPath,
  blobTargetDir: restoredBlobDir,
  restoreHosts: [{ sourcePath: hostPath, targetPath: restoredHostPath }]
}
const rRestore = await rt.dispatch(ctxFor('pr_op'), 'backup.restore', restorePayload, 'op-s5-restore')
rec.check('5b backup.restore committed', rRestore?.status === 'committed', 'committed', `${rRestore?.status}/${rRestore?.error?.code}`)
{
  const res = rRestore?.result as {
    runtimeState: string; unconfirmedExecutions: number; restoredBlobs: number;
    restoredArtifacts: number; restoredHosts: string[]; schemaVersion: number;
    manifestDigest: string; warnings: string[]
  }
  rec.check(
    '5b runtimeState restored-unconfirmed',
    res.runtimeState === 'restored-unconfirmed',
    'restored-unconfirmed',
    res.runtimeState
  )
  rec.check(
    '5b all 3 previously-live executions marked unconfirmed',
    res.unconfirmedExecutions === 3,
    '3',
    String(res.unconfirmedExecutions)
  )
  rec.check(
    '5b external blob file + host snapshot restored (artifact bytes ride inside snapshot)',
    res.restoredBlobs === 1 && res.restoredHosts.length === 1,
    'blob=1 host=1 (artifacts ref-recorded: inline body)',
    `blobs=${res.restoredBlobs} artifacts=${res.restoredArtifacts} hosts=${res.restoredHosts.length} warnings=${JSON.stringify(res.warnings)}`
  )
  rec.check('5b manifest digest echoes set', res.manifestDigest === createRes.manifestDigest, 'match', String(res.manifestDigest).slice(0, 16))

  const rdb = storage.openControlDb(restoredDbPath, { contentStoreDir: restoredBlobDir })
  const walRow = rdb.prepare("SELECT count(*) AS n FROM principals WHERE id='pr_walonly'").get() as { n: number }
  const live = rdb.prepare("SELECT count(*) AS n FROM executions WHERE liveness='live'").get() as { n: number }
  const unv = rdb.prepare("SELECT count(*) AS n FROM executions WHERE liveness='unverifiable'").get() as { n: number }
  const meta = rdb.prepare("SELECT value FROM schema_meta WHERE key='restored_from_backup'").get() as { value: string } | undefined
  const evRestored = rdb.prepare("SELECT count(*) AS n FROM domain_events WHERE event_type='backup.restored'").get() as { n: number }
  rec.check('5b restored db has WAL-resident row', Number(walRow.n) === 1, '1', String(walRow.n))
  rec.check(
    '5b restored row counts match live db',
    count(rdb, 'messages') === count(rt.db, 'messages') &&
      count(rdb, 'deliveries') === count(rt.db, 'deliveries') &&
      count(rdb, 'principals') === count(rt.db, 'principals'),
    'equal counts',
    `m=${count(rdb, 'messages')}/${count(rt.db, 'messages')} d=${count(rdb, 'deliveries')}/${count(rt.db, 'deliveries')} p=${count(rdb, 'principals')}/${count(rt.db, 'principals')}`
  )
  rec.check(
    '5b no live writer resurrected — all executions unverifiable',
    Number(live.n) === 0 && Number(unv.n) === 3,
    '0 live / 3 unverifiable',
    `${live.n}/${unv.n}`
  )
  rec.check('5b restore provenance stamped', meta?.value === setId, setId, String(meta?.value))
  rec.check('5b backup.restored event in restored db', Number(evRestored.n) === 1, '1', String(evRestored.n))
  // external blob: where did restoreContent put the bytes vs where does the
  // restored row's external_ref point? row ref is the sharded path.
  const extRow = rdb.prepare('SELECT external_ref FROM content_blobs WHERE digest=?').get(ext.digest) as { external_ref: string }
  const expectedPath = join(restoredBlobDir, extRow.external_ref) // <root>/xx/<digest>
  const flatPath = join(restoredBlobDir, ext.digest) // restoreContent's actual destName
  let blobRead = ''
  try {
    const b = storage.getContentBlob(rdb, ext.digest)
    blobRead = b ? Buffer.from(b.bytes).toString() : 'null'
  } catch (e) {
    blobRead = `THREW: ${e instanceof Error ? e.message : String(e)}`
  }
  rec.check(
    '5b restored external blob readable via row external_ref',
    blobRead === 'external payload s5',
    'bytes at <storeRoot>/<shard>/<digest>',
    `read=${blobRead.slice(0, 90)} expectedPath=${expectedPath} exists=${existsSync(expectedPath)} flatPath=${flatPath} exists=${existsSync(flatPath)}`,
    { externalRef: extRow.external_ref, expectedPath, flatPath }
  )
  // artifact content: inline body rides inside the snapshot
  const artDigest = (rArt?.result as { digest?: string })?.digest
  const artBlob = artDigest ? rdb.prepare('SELECT length(body) AS l FROM content_blobs WHERE digest=?').get(artDigest) as { l: number } | undefined : undefined
  rec.check(
    '5b artifact inline bytes present in restored snapshot',
    (artBlob?.l ?? 0) > 0,
    '>0 bytes inline',
    `len=${artBlob?.l}`
  )
  // restored db accepts new writes (recovered runtime can write)
  storage.withTx(rdb, (tx) => {
    tx.prepare("INSERT INTO principals(id,kind,status) VALUES('pr_post_restore','member','active')").run()
  })
  rec.check('5b restored db writable', count(rdb, 'principals') === count(rt.db, 'principals') + 1, '+1 principal', String(count(rdb, 'principals')))
  rdb.close()
  // host snapshot restored only at the explicitly mapped path
  let hostDb: DatabaseSync
  try {
    hostDb = new DatabaseSync(restoredHostPath, { readOnly: true })
  } catch {
    hostDb = new DatabaseSync(restoredHostPath)
  }
  const hs = hostDb.prepare('SELECT v FROM host_state WHERE id=?').get('hs1') as { v: string } | undefined
  rec.check('5b host snapshot restored at mapped path', hs?.v === 'alive', 'alive', String(hs?.v))
  hostDb.close()
  // live db bookkeeping: restore recorded
  const setRow = rt.db.prepare('SELECT state FROM backup_sets WHERE id=?').get(setId) as { state: string }
  const evRec = rt.db.prepare("SELECT count(*) AS n FROM domain_events WHERE event_type='backup.restore-recorded'").get() as { n: number }
  rec.check('5b live db marks set restored + event', setRow.state === 'restored' && Number(evRec.n) === 1, 'restored + event', `${setRow.state}/${evRec.n}`)
}

/* ================= 5c — corrupted/invalid sets must be REJECTED ============ */
// helper: mint a fresh valid backup set, return its id+dir
async function mintSet(opId: string): Promise<{ id: string; dir: string }> {
  const r = await rt.dispatch(ctxFor('pr_op'), 'backup.create', { scope: {} }, opId)
  const res = r?.result as { id: string; dir: string }
  return { id: res.id, dir: res.dir }
}
async function expectReject(
  name: string,
  expectedCode: string,
  opId: string,
  payload: Record<string, unknown>,
  targetToCheck?: string
): Promise<void> {
  const r = await rt.dispatch(ctxFor('pr_op'), 'backup.restore', payload, opId)
  const code = r?.error?.code ?? (r?.status === 'rejected' ? 'NO-CODE' : `status=${r?.status}`)
  const nothingWritten = targetToCheck === undefined || !existsSync(targetToCheck)
  rec.check(
    name,
    r?.status === 'rejected' && code === expectedCode && nothingWritten,
    `rejected/${expectedCode} + no target writes`,
    `${r?.status}/${code} targetExists=${targetToCheck !== undefined && existsSync(targetToCheck)}`
  )
}

// c1 — manifest.json missing
{
  const s = await mintSet('op-s5-set-c1')
  rmSync(join(s.dir, 'manifest.json'))
  await expectReject(
    '5c1 missing manifest.json rejected',
    'INPUT_NOT_READY',
    'op-s5-restore-c1',
    { backupSetId: s.id, expectedRuntimeStopped: true, targetPath: `${DIR}/rt-c1.sqlite` },
    `${DIR}/rt-c1.sqlite`
  )
}
// c2 — manifest altered after signing (self-digest mismatch)
{
  const s = await mintSet('op-s5-set-c2')
  const m = JSON.parse(readFileSync(join(s.dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  m.capturedAt = Number(m.capturedAt) + 1 // tamper, keep stale manifestDigest
  writeFileSync(join(s.dir, 'manifest.json'), JSON.stringify(m))
  await expectReject(
    '5c2 tampered manifest rejected',
    'ARTIFACT_MISMATCH',
    'op-s5-restore-c2',
    { backupSetId: s.id, expectedRuntimeStopped: true, targetPath: `${DIR}/rt-c2.sqlite` },
    `${DIR}/rt-c2.sqlite`
  )
}
// c3 — control snapshot missing
{
  const s = await mintSet('op-s5-set-c3')
  rmSync(join(s.dir, 'control.sqlite'))
  await expectReject(
    '5c3 missing control snapshot rejected',
    'ARTIFACT_MISMATCH',
    'op-s5-restore-c3',
    { backupSetId: s.id, expectedRuntimeStopped: true, targetPath: `${DIR}/rt-c3.sqlite` },
    `${DIR}/rt-c3.sqlite`
  )
}
// c4 — control snapshot bytes corrupted (digest mismatch)
{
  const s = await mintSet('op-s5-set-c4')
  const p = join(s.dir, 'control.sqlite')
  const img = readFileSync(p)
  img[img.length >> 1] ^= 0xff
  writeFileSync(p, img)
  await expectReject(
    '5c4 corrupted snapshot bytes rejected',
    'ARTIFACT_MISMATCH',
    'op-s5-restore-c4',
    { backupSetId: s.id, expectedRuntimeStopped: true, targetPath: `${DIR}/rt-c4.sqlite` },
    `${DIR}/rt-c4.sqlite`
  )
}
// c5 — a captured content file deleted from the set
{
  const s = await mintSet('op-s5-set-c5')
  rmSync(join(s.dir, 'blobs', ext.digest))
  await expectReject(
    '5c5 missing captured content file rejected',
    'ARTIFACT_MISMATCH',
    'op-s5-restore-c5',
    { backupSetId: s.id, expectedRuntimeStopped: true, targetPath: `${DIR}/rt-c5.sqlite` },
    `${DIR}/rt-c5.sqlite`
  )
}
// c6 — backup_sets row digest disagrees with manifest on disk → reject; then
// fix the row and the SAME operationId re-executes (rejected receipts are
// never persisted — s2 evidence) and commits.
{
  const s = await mintSet('op-s5-set-c6')
  const good = (rt.db.prepare('SELECT manifest_digest AS d FROM backup_sets WHERE id=?').get(s.id) as { d: string }).d
  rt.db.prepare("UPDATE backup_sets SET manifest_digest='forged' WHERE id=?").run(s.id)
  await expectReject(
    '5c6 row-vs-manifest digest disagreement rejected',
    'ARTIFACT_MISMATCH',
    'op-s5-restore-c6',
    { backupSetId: s.id, expectedRuntimeStopped: true, targetPath: `${DIR}/rt-c6.sqlite` },
    `${DIR}/rt-c6.sqlite`
  )
  rt.db.prepare('UPDATE backup_sets SET manifest_digest=? WHERE id=?').run(good, s.id)
  const rRetry = await rt.dispatch(ctxFor('pr_op'), 'backup.restore', {
    backupSetId: s.id, expectedRuntimeStopped: true, targetPath: `${DIR}/rt-c6.sqlite`
  }, 'op-s5-restore-c6')
  rec.check(
    '5c6 corrected retry under same operationId executes+commits',
    rRetry?.status === 'committed' && existsSync(`${DIR}/rt-c6.sqlite`),
    'committed + target written',
    `${rRetry?.status} exists=${existsSync(`${DIR}/rt-c6.sqlite`)}`
  )
}
// c7 — caller does not attest the runtime stopped
{
  const s = await mintSet('op-s5-set-c7')
  await expectReject(
    '5c7 expectedRuntimeStopped=false rejected',
    'INVALID_TRANSITION',
    'op-s5-restore-c7',
    { backupSetId: s.id, expectedRuntimeStopped: false, targetPath: `${DIR}/rt-c7.sqlite` },
    `${DIR}/rt-c7.sqlite`
  )
}
// c8 — target IS the live control db path
{
  const s = await mintSet('op-s5-set-c8')
  const before = count(rt.db, 'principals')
  await expectReject(
    '5c8 restore over live control db rejected',
    'INVALID_TRANSITION',
    'op-s5-restore-c8',
    { backupSetId: s.id, expectedRuntimeStopped: true, targetPath: dbPath },
    undefined // target legitimately exists — verify content instead below
  )
  rec.check('5c8 live db untouched', count(rt.db, 'principals') === before, `${before} principals`, String(count(rt.db, 'principals')))
}
// c9 — target has a live writer (probeNoLiveWriter must refuse)
{
  const s = await mintSet('op-s5-set-c9')
  const target = `${DIR}/rt-c9.sqlite`
  const liveTarget = new DatabaseSync(target)
  liveTarget.exec('CREATE TABLE t(id TEXT)')
  const rival = new DatabaseSync(target)
  rival.exec('PRAGMA busy_timeout=0')
  rival.exec('BEGIN IMMEDIATE')
  rival.prepare("INSERT INTO t VALUES('held')").run()
  await expectReject(
    '5c9 live-writer target rejected',
    'STOP_UNKNOWN',
    'op-s5-restore-c9',
    { backupSetId: s.id, expectedRuntimeStopped: true, targetPath: target },
    undefined // target exists by construction
  )
  // rival sees its own uncommitted row → the target db was never overwritten
  const rows = rival.prepare('SELECT count(*) AS n FROM t').get() as { n: number }
  rec.check('5c9 live target content untouched', Number(rows.n) === 1, '1 row (rival view)', String(rows.n))
  rival.exec('ROLLBACK')
  rival.close()
  liveTarget.close()
}
// c10 — operator liveness probe reports a live writer (standalone deps seam)
{
  const s = await mintSet('op-s5-set-c10')
  let threw = ''
  let code = ''
  try {
    restoreBackupSetStandalone(rt.db, {
      openDb: storage.openControlDb,
      withTx: storage.withTx,
      sha256Hex: storage.sha256Hex,
      appendDomainEvent: storage.appendDomainEvent,
      ...backupDeps,
      isTargetStopped: () => false
    }, {
      backupSetId: s.id,
      expectedRuntimeStopped: true,
      targetPath: `${DIR}/rt-c10.sqlite`
    })
  } catch (e) {
    threw = String(e)
    code = String((e as { code?: string }).code ?? '')
  }
  rec.check(
    '5c10 operator liveness probe STOP_UNKNOWN',
    code === 'STOP_UNKNOWN' && !existsSync(`${DIR}/rt-c10.sqlite`),
    'STOP_UNKNOWN + no target writes',
    `${code} exists=${existsSync(`${DIR}/rt-c10.sqlite`)} ${threw.slice(0, 80)}`
  )
}

rt.close()
rec.flush()
