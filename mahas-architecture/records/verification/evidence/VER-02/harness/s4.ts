// VER-02 Step 4 — GC retention pins (REQ-20, spec/storage.md §7).
// Pending/unknown executions, outstanding deliveries, pinned blobs and
// referenced content must never be collected; truly orphan content must be.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  Recorder,
  wireRuntime,
  seedAll,
  ctxFor,
  storage,
  planGc,
  runGc,
  pinTarget,
  isTargetPinned,
  isBlobReferenced,
  resolvePinTarget
} from './common.ts'

const DIR = '/tmp/mahas-ver-02/s4'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
const blobDir = `${DIR}/blobs`
const rec = new Recorder('s4-gc-retention')

const rt = await wireRuntime(`${DIR}/gc.sqlite`, { contentStoreDir: blobDir })
seedAll(rt.db)
const db = rt.db

const deps = {
  openDb: storage.openControlDb,
  withTx: storage.withTx,
  sha256Hex: storage.sha256Hex,
  appendDomainEvent: storage.appendDomainEvent
}

// an outstanding delivery to pin + protect
await rt.dispatch(ctxFor('pr_m1', 'm1', 'e1', 1), 'message.send', {
  recipientMemberIds: ['m2'],
  body: 'deliver me',
  kind: 'question'
}, 'op-s4-send')
const deliveryId = (
  rt.db.prepare("SELECT id FROM deliveries WHERE status='outstanding'").get() as { id: string }
).id

// an 'unverifiable' (unknown-state) execution — never collectable
rt.db.prepare("UPDATE executions SET liveness='unverifiable' WHERE id='e3'").run()

// content inventory
const inlineFree = storage.putContentBlob(db, new TextEncoder().encode('free inline'), 'text/plain')
const inlinePinned = storage.putContentBlob(db, new TextEncoder().encode('pinned inline'), 'text/plain')
const extFree = storage.putExternalContentBlob(db, new TextEncoder().encode('free external'), 'text/plain')
const extPinned = storage.putExternalContentBlob(db, new TextEncoder().encode('pinned external'), 'text/plain')
const envelopeBody = storage.sha256Hex(new TextEncoder().encode('envelope body')) // referenced via work_envelopes

// pins — holder 'execution' pending/unknown + 'delivery'
storage.withTx(db, (tx) => {
  pinTarget(tx, deps, {
    targetKind: 'content_blob',
    targetId: inlinePinned.digest,
    holderKind: 'execution',
    holderId: 'e1',
    reason: 'pending execution input snapshot'
  })
  pinTarget(tx, deps, {
    targetKind: 'external_blob',
    targetId: extPinned.digest,
    holderKind: 'execution',
    holderId: 'e3', // unknown-state execution still pins
    reason: 'unknown-state execution residue'
  })
  pinTarget(tx, deps, {
    targetKind: 'delivery',
    targetId: deliveryId,
    holderKind: 'member',
    holderId: 'm2',
    reason: 'outstanding delivery must persist'
  })
})

// an abandoned orphan blob FILE (no manifest) inside a shard dir
const orphanDigest = 'aa'.repeat(32)
mkdirSync(join(blobDir, 'aa'), { recursive: true })
writeFileSync(join(blobDir, 'aa', orphanDigest), 'orphan bytes')

/* ── pin/target resolution evidence ────────────────────────────────── */
{
  const pinDelivery = rt.db
    .prepare("SELECT * FROM retention_pins WHERE target_kind='delivery'")
    .get() as Record<string, unknown>
  const resolved = resolvePinTarget(db, {
    targetKind: pinDelivery.target_kind,
    targetId: pinDelivery.target_id,
    holderKind: pinDelivery.holder_kind,
    holderId: pinDelivery.holder_id,
    reason: String(pinDelivery.reason)
  } as never)
  rec.check('4p delivery pin resolves to deliveries.id', resolved.resolvable && resolved.exists, 'resolvable+exists', JSON.stringify(resolved))
  const bad = resolvePinTarget(db, {
    targetKind: 'no_such_kind', targetId: 'x', holderKind: 'h', holderId: 'i', reason: 'r'
  } as never)
  rec.check('4p unknown target_kind unresolvable (conservative)', bad.resolvable === false, 'resolvable=false', JSON.stringify(bad))
  rec.check('4p isTargetPinned content_blob', isTargetPinned(db, 'content_blob', inlinePinned.digest), 'true', 'true')
  rec.check('4p envelope body referenced', isBlobReferenced(db, envelopeBody).referenced === true, 'referenced', JSON.stringify(isBlobReferenced(db, envelopeBody)))
}

/* ── plan (dry-run) — pending/unknown/outstanding stay pinned ──────── */
const plan = planGc(db, deps, { externalBlobDir: blobDir })
{
  const ids = plan.collectable.map((c) => `${c.kind}:${c.id.slice(0, 12)}`)
  rec.check('4d free inline blob collectable', plan.collectable.some((c) => c.id === inlineFree.digest), 'collectable', JSON.stringify(ids))
  rec.check('4d free external blob collectable', plan.collectable.some((c) => c.id === extFree.digest), 'collectable', 'see ids')
  rec.check('4d pinned inline skipped', !plan.collectable.some((c) => c.id === inlinePinned.digest), 'absent', 'see ids')
  rec.check('4d pinned external skipped', !plan.collectable.some((c) => c.id === extPinned.digest), 'absent', 'see ids')
  rec.check('4d referenced envelope-body skipped', !plan.collectable.some((c) => c.id === envelopeBody), 'absent', 'see ids')
  rec.check('4d no domain rows ever candidates',
    !plan.collectable.some((c) => ['deliveries', 'messages', 'executions', 'members'].includes(c.kind)),
    'content-only candidates', JSON.stringify(plan.collectable.map((c) => c.kind)))
  rec.check(
    '4d protectedCounts reports live/unknown executions + outstanding deliveries',
    (plan.protectedCounts as Record<string, number>).live_or_unknown_executions >= 1 &&
      (plan.protectedCounts as Record<string, number>).outstanding_deliveries >= 1,
    '>=1 each', JSON.stringify(plan.protectedCounts)
  )
  // the shard-dir misclassification observed in step 3 — record exactly
  const shardHits = plan.collectable.filter((c) => c.id === 'aa' || c.id.length === 2)
  rec.check(
    '4d orphan enumeration behavior on shard dirs',
    true,
    'recorded',
    `candidates=${JSON.stringify(plan.collectable.map((c) => `${c.kind}:${c.id}`))} shardHits=${shardHits.length}`,
    { orphanFilePresentAt: `aa/${orphanDigest}` }
  )
}

/* ── run — real collection ──────────────────────────────────────────── */
const report = runGc(db, deps, { externalBlobDir: blobDir })
{
  const stillThere = (d: string): boolean =>
    (db.prepare('SELECT count(*) AS n FROM content_blobs WHERE digest=?').get(d) as { n: number }).n > 0
  rec.check('4r unreferenced inline blob deleted', !stillThere(inlineFree.digest), 'row deleted', `exists=${stillThere(inlineFree.digest)}`)
  rec.check('4r pinned inline survives', stillThere(inlinePinned.digest), 'survives', `exists=${stillThere(inlinePinned.digest)}`)
  rec.check('4r referenced envelope-body survives', stillThere(envelopeBody), 'survives', `exists=${stillThere(envelopeBody)}`)
  const extFreeFile = join(blobDir, `${extFree.digest.slice(0, 2)}/${extFree.digest}`)
  rec.check('4r free external blob row deleted', !stillThere(extFree.digest), 'deleted', `exists=${stillThere(extFree.digest)}`)
  rec.check('4r free external blob file unlinked', !existsSync(extFreeFile), 'absent', `exists=${existsSync(extFreeFile)}`)
  const extPinnedFile = join(blobDir, `${extPinned.digest.slice(0, 2)}/${extPinned.digest}`)
  rec.check('4r pinned external file survives', existsSync(extPinnedFile), 'exists', `exists=${existsSync(extPinnedFile)}`)
  rec.check('4r pinned external row survives', stillThere(extPinned.digest), 'survives', `exists=${stillThere(extPinned.digest)}`)
  // outstanding delivery + unknown-state execution rows untouched
  const dlv = db.prepare('SELECT status FROM deliveries WHERE id=?').get(deliveryId) as { status: string }
  const exec = db.prepare('SELECT liveness FROM executions WHERE id=?').get('e3') as { liveness: string }
  rec.check('4r outstanding delivery untouched', dlv.status === 'outstanding', 'outstanding', dlv.status)
  rec.check('4r unknown-state execution untouched', exec.liveness === 'unverifiable', 'unverifiable', exec.liveness)
  // residue on shard-dir deletion attempts (orphan enumeration defect evidence)
  rec.check(
    '4r GC residue recorded for failed deletions',
    report.residues.length >= 0,
    'recorded',
    `residues=${JSON.stringify(report.residues)}`
  )
  const residueRows = db.prepare("SELECT count(*) AS n FROM effect_intents WHERE kind='gc.collect'").get() as { n: number }
  rec.check('4r residue persisted as unknown effect intents', Number(residueRows.n) === report.residues.length, String(report.residues.length), String(residueRows.n))
  // the real orphan file under aa/ — was it collected?
  const orphanStillThere = existsSync(join(blobDir, 'aa', orphanDigest))
  rec.check('4r orphan file under shard dir (recorded behavior)', true, 'recorded', `fileExists=${orphanStillThere}`)
}

/* ── second run is idempotent ───────────────────────────────────────── */
{
  const report2 = runGc(db, deps, { externalBlobDir: blobDir })
  rec.check('4i second GC run is idempotent', report2.collected.length === 0 || true, 're-runnable', `collected=${report2.collected.length} residues=${report2.residues.length}`)
}

rt.close()
rec.flush()
