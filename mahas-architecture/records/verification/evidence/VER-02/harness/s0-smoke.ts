// VER-02 smoke — verify wiring: seed, registry dispatch, receipts.
import { mkdirSync, rmSync } from 'node:fs'
import {
  Recorder,
  wireRuntime,
  seedAll,
  ctxFor,
  storage
} from './common.ts'

const DIR = '/tmp/mahas-ver-02/smoke'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
mkdirSync(`${DIR}/repo`, { recursive: true })

const rec = new Recorder('s0-smoke')
const rt = await wireRuntime(`${DIR}/control.sqlite`, { contentStoreDir: `${DIR}/blobs` })
// move seeded repo path — checkouts canonical_path is /tmp/mahas-ver-02/repo (shared)
seedAll(rt.db)
rec.check('seed committed', true, 'no throw', 'ok')

const counts = (t: string): number =>
  Number((rt.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n)
console.log('counts:', {
  members: counts('members'),
  deliveries: counts('deliveries'),
  receipts: counts('operation_receipts')
})

const ctx = ctxFor('pr_m1', 'm1', 'e1', 1)
const r1 = await rt.dispatch(ctx, 'message.send', {
  recipientMemberIds: ['m2', 'm3'],
  body: 'hello',
  kind: 'question'
}, 'op-smoke-1')
console.log('receipt:', JSON.stringify(r1))
rec.check('message.send committed', r1?.status === 'committed', 'committed', String(r1?.status))
rec.check('2 deliveries', counts('deliveries') === 2, '2', String(counts('deliveries')))
rec.check('1 message', counts('messages') === 1, '1', String(counts('messages')))

// replay same operationId + same payload → stored receipt, no dup effects
const r2 = await rt.dispatch(ctx, 'message.send', {
  recipientMemberIds: ['m2', 'm3'],
  body: 'hello',
  kind: 'question'
}, 'op-smoke-1')
rec.check('replay committed', r2?.status === 'committed', 'committed', String(r2?.status))
rec.check('replay no dup', counts('deliveries') === 2 && counts('messages') === 1, '1 msg/2 dlv', `${counts('messages')}/${counts('deliveries')}`)
rec.check('same fingerprint', r2?.fingerprint === r1?.fingerprint, r1?.fingerprint, r2?.fingerprint)

// conflict: same operationId, different payload
const r3 = await rt.dispatch(ctx, 'message.send', {
  recipientMemberIds: ['m2'],
  body: 'different',
  kind: 'question'
}, 'op-smoke-1')
console.log('conflict receipt:', JSON.stringify(r3))
rec.check('conflict rejected OPERATION_CONFLICT',
  r3?.status === 'rejected' && r3?.error?.code === 'OPERATION_CONFLICT',
  'rejected/OPERATION_CONFLICT', `${r3?.status}/${r3?.error?.code}`)

rt.close()
rec.flush()
