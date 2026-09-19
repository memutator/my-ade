// VER-02 Step 2 — receipt replay/conflict idempotency (REQ-20, REQ-27).
// Storage level: insertReceipt/findReceipt/findConflictingReceipt.
// Dispatch level: same operationId ± same payload through the real pipeline.
import { mkdirSync, rmSync } from 'node:fs'
import {
  Recorder,
  wireRuntime,
  seedAll,
  ctxFor,
  storage
} from './common.ts'

const DIR = '/tmp/mahas-ver-02/s2'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
const rec = new Recorder('s2-idempotency')

/* ── storage level ─────────────────────────────────────────────────── */
{
  const db = storage.openControlDb(`${DIR}/store.sqlite`, { contentStoreDir: `${DIR}/store.blobs` })
  const base = {
    operationId: 'op-s1',
    operation: 'probe.op',
    fingerprint: 'fp-aaa',
    status: 'committed',
    result: { v: 1 },
    effects: [],
    domainRevision: 0,
    eventCursor: 0
  }
  storage.withTx(db, (tx) => storage.insertReceipt(tx, base, 'pr_scope'))
  const found = storage.findReceipt(db, 'pr_scope', 'probe.op', 'op-s1')
  rec.check('2s findReceipt returns stored receipt', found?.operationId === 'op-s1' && found?.fingerprint === 'fp-aaa', 'op-s1/fp-aaa', `${found?.operationId}/${found?.fingerprint}`)

  // same key + same fingerprint → safe upsert (retried write)
  storage.withTx(db, (tx) => storage.insertReceipt(tx, { ...base, result: { v: 2 } }, 'pr_scope'))
  const after = storage.findReceipt(db, 'pr_scope', 'probe.op', 'op-s1')
  rec.check('2s same-fingerprint re-insert allowed', true, 'no throw', 'no throw')
  rec.check('2s stored fingerprint unchanged', after?.fingerprint === 'fp-aaa', 'fp-aaa', String(after?.fingerprint))

  // same key + different fingerprint → OPERATION_CONFLICT, stored row kept
  let code = ''
  try {
    storage.withTx(db, (tx) =>
      storage.insertReceipt(tx, { ...base, fingerprint: 'fp-DIFFERENT' }, 'pr_scope')
    )
  } catch (e) {
    code = (e as { code?: string }).code ?? String(e)
  }
  rec.check('2s different fingerprint → OPERATION_CONFLICT', code === 'OPERATION_CONFLICT', 'OPERATION_CONFLICT', String(code))
  const kept = storage.findReceipt(db, 'pr_scope', 'probe.op', 'op-s1')
  rec.check('2s original receipt not overwritten', kept?.fingerprint === 'fp-aaa', 'fp-aaa', String(kept?.fingerprint))

  // findConflictingReceipt semantics
  const conflict = storage.findConflictingReceipt(db, 'pr_scope', 'probe.op', 'op-s1', 'fp-NEW')
  const noConflictSame = storage.findConflictingReceipt(db, 'pr_scope', 'probe.op', 'op-s1', 'fp-aaa')
  const noConflictAbsent = storage.findConflictingReceipt(db, 'pr_scope', 'probe.op', 'op-absent', 'fp-x')
  rec.check('2s conflict probe: differing fingerprint → stored receipt', conflict?.fingerprint === 'fp-aaa', 'fp-aaa', String(conflict?.fingerprint))
  rec.check('2s conflict probe: same fingerprint → null', noConflictSame === null, 'null', String(noConflictSame))
  rec.check('2s conflict probe: absent key → null', noConflictAbsent === null, 'null', String(noConflictAbsent))

  // scope isolation: same operationId under a different principal scope is fine
  storage.withTx(db, (tx) =>
    storage.insertReceipt(tx, { ...base, fingerprint: 'fp-other' }, 'other_scope')
  )
  const other = storage.findReceipt(db, 'other_scope', 'probe.op', 'op-s1')
  rec.check('2s key is (scope,operation,operationId)', other?.fingerprint === 'fp-other', 'fp-other', String(other?.fingerprint))

  // contract gap: receipt without `operation` is refused by insertReceipt
  let missing = ''
  try {
    storage.withTx(db, (tx) =>
      storage.insertReceipt(
        tx,
        { operationId: 'op-x', fingerprint: 'f', status: 'committed', effects: [], domainRevision: 0, eventCursor: 0 } as never,
        's'
      )
    )
  } catch (e) {
    missing = String(e)
  }
  rec.check('2s receipt missing `operation` refused', missing.includes('must carry `operation`'), 'throw', missing.slice(0, 100))
  db.close()
}

/* ── dispatch level ────────────────────────────────────────────────── */
{
  const rt = await wireRuntime(`${DIR}/disp.sqlite`, { contentStoreDir: `${DIR}/disp.blobs` })
  seedAll(rt.db)
  const ctx = ctxFor('pr_m1', 'm1', 'e1', 1)
  const count = (t: string): number =>
    Number((rt.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n)

  const payload = { recipientMemberIds: ['m2', 'm3'], body: 'hello', kind: 'question' }
  const r1 = await rt.dispatch(ctx, 'message.send', payload, 'op-idem-1')
  const msgId = r1?.result?.messageId
  const before = { m: count('messages'), d: count('deliveries'), e: count('domain_events'), r: count('operation_receipts') }

  // (a) identical replay — same operationId + same payload
  const r2 = await rt.dispatch(ctx, 'message.send', payload, 'op-idem-1')
  rec.check('2d replay returns committed', r2?.status === 'committed', 'committed', String(r2?.status))
  rec.check('2d replay identical fingerprint', r2?.fingerprint === r1?.fingerprint, r1?.fingerprint, r2?.fingerprint)
  rec.check('2d replay same result (stored receipt)', r2?.result?.messageId === msgId, String(msgId), String(r2?.result?.messageId))
  rec.check(
    '2d replay no duplicate effects',
    count('messages') === before.m && count('deliveries') === before.d && count('domain_events') === before.e,
    `${before.m}/${before.d}/${before.e}`,
    `${count('messages')}/${count('deliveries')}/${count('domain_events')}`
  )
  rec.check('2d replay no second receipt row', count('operation_receipts') === before.r, String(before.r), String(count('operation_receipts')))

  // (b) canonical-payload equivalence: different key ORDER → same fingerprint
  const reordered = { kind: 'question', body: 'hello', recipientMemberIds: ['m2', 'm3'] }
  const r3 = await rt.dispatch(ctx, 'message.send', reordered, 'op-idem-1')
  rec.check('2d key-order variant replays (canonical fingerprint)', r3?.status === 'committed' && r3?.fingerprint === r1?.fingerprint, `committed/${r1?.fingerprint}`, `${r3?.status}/${r3?.fingerprint}`)

  // (c) same operationId + different payload → OPERATION_CONFLICT, nothing written
  const r4 = await rt.dispatch(ctx, 'message.send', { ...payload, body: 'DIFFERENT' }, 'op-idem-1')
  rec.check('2d conflict → rejected', r4?.status === 'rejected', 'rejected', String(r4?.status))
  rec.check('2d conflict code', r4?.error?.code === 'OPERATION_CONFLICT', 'OPERATION_CONFLICT', String(r4?.error?.code))
  rec.check('2d conflict no writes', count('messages') === before.m && count('deliveries') === before.d, `${before.m}/${before.d}`, `${count('messages')}/${count('deliveries')}`)
  const stored = storage.findReceipt(rt.db, 'pr_m1', 'message.send', 'op-idem-1')
  rec.check('2d stored receipt keeps original fingerprint', stored?.fingerprint === r1?.fingerprint, r1?.fingerprint, String(stored?.fingerprint))

  // (d) rejected receipts: an INPUT failure, then identical replay
  const r5 = await rt.dispatch(ctx, 'message.send', { recipientMemberIds: ['ghost'], body: 'x', kind: 'question' }, 'op-idem-2')
  const rejStatus = r5?.status
  const rejCode = r5?.error?.code
  const r6 = await rt.dispatch(ctx, 'message.send', { recipientMemberIds: ['ghost'], body: 'x', kind: 'question' }, 'op-idem-2')
  rec.check('2d rejected op replays its verdict', r6?.status === rejStatus && r6?.error?.code === rejCode, `${rejStatus}/${rejCode}`, `${r6?.status}/${r6?.error?.code}`)
  const rejRows = rt.db.prepare("SELECT count(*) AS n FROM operation_receipts WHERE operation_id='op-idem-2'").get() as { n: number }
  rec.check(
    '2d rejected receipt NOT persisted (same-op retry may re-execute)',
    Number(rejRows.n) === 0,
    '0 (admission.ts:23-26 design)',
    String(rejRows.n)
  )
  // corrected retry under the same operationId is NOT a conflict — the key
  // only binds once a committed receipt exists
  const r7b = await rt.dispatch(ctx, 'message.send', payload, 'op-idem-2')
  rec.check(
    '2d corrected retry under same operationId commits',
    r7b?.status === 'committed',
    'committed', `${r7b?.status}/${r7b?.error?.code}`
  )

  // (e) different principal scope, same operationId → independent op
  const r7 = await rt.dispatch(ctxFor('pr_m2', 'm2', 'e2', 1), 'message.send', payload, 'op-idem-1')
  rec.check('2d other principal scope unaffected', r7?.status === 'committed', 'committed', String(r7?.status))

  rt.close()
}

rec.flush()
