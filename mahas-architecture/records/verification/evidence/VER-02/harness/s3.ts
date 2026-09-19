// VER-02 Step 3 — interrupted blob publication durability (REQ-20/22,
// spec/storage.md §5). A partial file without a manifest row must never be
// served as an artifact; corrupt content must be detected at read.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  Recorder,
  wireRuntime,
  seedAll,
  ctxFor,
  storage,
  planGc
} from './common.ts'

const DIR = '/tmp/mahas-ver-02/s3'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
mkdirSync(`${DIR}/repo`, { recursive: true })
const rec = new Recorder('s3-blob-durability')
const blobDir = `${DIR}/blobs`

/* ── 3a. positive control: real external publish + read-back ─────────── */
{
  const db = storage.openControlDb(`${DIR}/a.sqlite`, { contentStoreDir: blobDir })
  const bytes = new TextEncoder().encode('external blob payload — VER-02')
  const ref = storage.putExternalContentBlob(db, bytes, 'text/plain')
  const rel = `${ref.digest.slice(0, 2)}/${ref.digest}`
  const filePath = join(blobDir, rel)
  const row = db.prepare('SELECT body, external_ref, verified FROM content_blobs WHERE digest=?').get(ref.digest) as {
    body: unknown; external_ref: string; verified: number
  }
  rec.check('3a file at content-addressed path', existsSync(filePath), 'exists', String(existsSync(filePath)), { path: rel })
  rec.check('3a manifest row verified=1 external', row?.verified === 1 && row?.external_ref === rel, `verified=1 ref=${rel}`, `v=${row?.verified} ref=${row?.external_ref}`)
  const got = storage.getContentBlob(db, ref.digest)
  rec.check(
    '3a read-back returns exact bytes',
    got !== null && Buffer.from(got!.bytes).toString() === 'external blob payload — VER-02',
    'exact', got ? Buffer.from(got!.bytes).toString() : 'null'
  )
  db.close()
}

/* ── 3b. simulated crash DURING publish: abandoned .tmp + no manifest ── */
{
  const db = storage.openControlDb(`${DIR}/b.sqlite`, { contentStoreDir: blobDir })
  const victim = new TextEncoder().encode('blob that never finished publishing')
  const digest = storage.sha256Hex(victim)
  const shardDir = join(blobDir, digest.slice(0, 2))
  mkdirSync(shardDir, { recursive: true })
  // putExternalContentBlob's write path: tmp file .<digest>.<pid>.<uuid>.tmp
  const tmpName = `.${digest}.9999.deadbeef.tmp`
  writeFileSync(join(shardDir, tmpName), victim.subarray(0, 8)) // partial bytes
  // crash before rename+manifest: no content_blobs row exists
  const got = storage.getContentBlob(db, digest)
  rec.check('3b partial tmp file never served (no manifest)', got === null, 'null', String(got))
  const rows = db.prepare('SELECT count(*) AS n FROM content_blobs WHERE digest=?').get(digest) as { n: number }
  rec.check('3b no manifest row', Number(rows.n) === 0, '0', String(rows.n))
  // planGc must not mistake the .tmp for collectable content nor crash
  const deps = {
    openDb: storage.openControlDb, withTx: storage.withTx,
    sha256Hex: storage.sha256Hex, appendDomainEvent: storage.appendDomainEvent
  }
  const plan = planGc(db, deps, { externalBlobDir: blobDir })
  const hitsTmp = plan.collectable.filter((c) => c.id.includes('.tmp') || c.id === digest)
  rec.check('3b .tmp residue not a collectable candidate', hitsTmp.length === 0, '0 candidates', String(hitsTmp.length), {
    collectable: plan.collectable.map((c) => `${c.kind}:${c.id}`)
  })
  db.close()
}

/* ── 3c. crash AFTER rename, BEFORE manifest: final-path partial file ── */
{
  const db = storage.openControlDb(`${DIR}/c.sqlite`, { contentStoreDir: blobDir })
  const victim = new TextEncoder().encode('complete blob bytes')
  const digest = storage.sha256Hex(victim)
  const shardDir = join(blobDir, digest.slice(0, 2))
  mkdirSync(shardDir, { recursive: true })
  // partial bytes AT the final content-addressed name, NO manifest row
  writeFileSync(join(shardDir, digest), victim.subarray(0, 10))
  const got = storage.getContentBlob(db, digest)
  rec.check('3c orphan final-path file never served (no manifest)', got === null, 'null', String(got))
  // a forged manifest row over the corrupt file must still fail at read —
  // getContentBlob re-hashes stored bytes every read
  db.prepare(
    "INSERT INTO content_blobs(digest,media_type,byte_length,body,external_ref,verified) VALUES(?,?,?,NULL,?,1)"
  ).run(digest, 'text/plain', victim.byteLength, `${digest.slice(0, 2)}/${digest}`)
  let threw = ''
  try {
    storage.getContentBlob(db, digest)
  } catch (e) {
    threw = String((e as { code?: string }).code ?? e)
  }
  rec.check('3c corrupt content detected at read', threw === 'ARTIFACT_MISMATCH', 'ARTIFACT_MISMATCH', String(threw))
  db.close()
}

/* ── 3d. real artifact.publish: atomic file+manifest+pin; tamper check ─ */
{
  const rt = await wireRuntime(`${DIR}/d.sqlite`, { contentStoreDir: `${DIR}/d.blobs` })
  seedAll(rt.db)
  mkdirSync('/tmp/mahas-ver-02/repo', { recursive: true })
  writeFileSync('/tmp/mahas-ver-02/repo/out.txt', 'artifact output bytes')
  const ctx = ctxFor('pr_m1', 'm1', 'e1', 1)
  const r1 = await rt.dispatch(ctx, 'artifact.publish', {
    dispatchId: 'd1', outputSlot: 'result', source: 'file',
    sourcePath: 'out.txt', mediaType: 'text/plain'
  }, 'op-3d-pub')
  rec.check('3d artifact.publish committed', r1?.status === 'committed', 'committed', `${r1?.status}/${r1?.error?.code}`)
  const art = r1?.result
  const artRow = rt.db.prepare('SELECT digest, storage_ref_json FROM artifacts WHERE id=?').get(art?.artifactId) as { digest: string; storage_ref_json: string } | undefined
  const blobRow = art?.digest
    ? rt.db.prepare('SELECT verified FROM content_blobs WHERE digest=?').get(art.digest) as { verified: number } | undefined
    : undefined
  const pin = rt.db.prepare("SELECT target_kind, target_id, holder_kind FROM retention_pins").all() as { target_kind: string; target_id: string; holder_kind: string }[]
  rec.check('3d artifact+blob+pin landed atomically',
    artRow !== undefined && blobRow?.verified === 1 && pin.length === 1,
    'artifact row + verified blob + 1 pin',
    `art=${artRow !== undefined} blob=${blobRow?.verified} pins=${pin.length}`,
    { pin })
  // read-back through the real op
  const r2 = await rt.dispatch(ctx, 'artifact.read', {
    artifactId: art?.artifactId, revision: 1, expectedDigest: art?.digest
  }, 'op-3d-read')
  rec.check('3d artifact.read returns bytes', r2?.status === 'committed' && r2?.result?.availability === 'bytes', 'bytes', `${r2?.status}/${r2?.result?.availability}`)

  // sabotage: publish a file then mutate it before a second publish with a
  // now-stale expectedDigest → rejected, no partial artifact
  writeFileSync('/tmp/mahas-ver-02/repo/out2.txt', 'v1')
  const r3 = await rt.dispatch(ctx, 'artifact.publish', {
    dispatchId: 'd1', outputSlot: 'result2', source: 'file',
    sourcePath: 'out2.txt', mediaType: 'text/plain',
    expectedDigest: storage.sha256Hex(new TextEncoder().encode('different-bytes'))
  }, 'op-3d-bad')
  const artCount = rt.db.prepare('SELECT count(*) AS n FROM artifacts').get() as { n: number }
  rec.check('3d digest-mismatch publish rejected', r3?.status === 'rejected' && r3?.error?.code === 'ARTIFACT_MISMATCH', 'rejected/ARTIFACT_MISMATCH', `${r3?.status}/${r3?.error?.code}`)
  rec.check('3d no partial artifact row', Number(artCount.n) === 1, '1', String(artCount.n))
  rt.close()
}

rec.flush()
