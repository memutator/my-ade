// api/admission.deferred.smoke.ts — focused admission checks for the parts of
// the pipeline that the registry smoke test does not cover:
//
//   • per-DB serialization: independent dispatches never interleave BEGIN, so
//     no admission read can observe a foreign transaction's uncommitted rows
//     (SQLite reads on the same connection DO see them), and the scheduler
//     seam lets another writer take its turn without joining an admission.
//   • nested dispatch still joins the ambient transaction (atomicity) and does
//     not deadlock on the serialization it already holds.
//   • long-poll queries release the connection while they wait.
//   • the deferred (outside-transaction) effect path: durable admit → effect
//     with NO transaction/slot → atomic completion whose receipt is committed
//     with the domain rows, plus the pending/abort/unknown/completion-failure
//     branches.
//
// Run:  node packages/mahas-runtime/src/api/admission.deferred.smoke.ts
//
// Uses the REAL storage boundary (openControlDb + migrations) so the
// transaction depth tracking, receipt store and effect ledger are the shipped
// ones; only the access boundary is a double (allowing everything).

import assert from 'node:assert/strict'
import type { AuthenticatedContext, CommandRequest } from '../../../mahas-contracts/src/index.ts'
import {
  asDeferredHandler,
  databaseContenders,
  deferredMutation,
  deferredSpec,
  hasAmbientTransaction,
  holdsDatabaseSerialization,
  listDeferredAdmissions,
  releaseDeferredAdmission,
  serializeDatabase
} from './admission.ts'
import type { AccessBoundary, StorageBoundary, TxnContext } from './handler-ports.ts'
import { mahasError } from './handler-ports.ts'
import { makeCaller, OperationRegistry } from './registry.ts'
import * as controlStorage from '../storage/db.ts'
import { inTransaction, openControlDb, withTx } from '../storage/db.ts'

let checks = 0
function ok(name: string): void {
  checks++
  process.stdout.write(`  ok ${name}\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** a promise resolved by the test, used to hold an operation mid-flight */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

function context(): AuthenticatedContext {
  return {
    principalId: 'principal-1' as AuthenticatedContext['principalId'],
    controllerEpoch: 1 as AuthenticatedContext['controllerEpoch'],
    grantRevisions: {},
    transportSessionId: 'session-1'
  }
}

function request(operation: string, operationId: string, payload?: unknown): CommandRequest {
  return { protocolVersion: 'smoke/1', operation, operationId, payload }
}

function accessDouble(): AccessBoundary {
  return {
    authorize: () => undefined,
    surfaceFor: () =>
      ({
        digest: 'smoke-surface',
        rolePolicyRevision: 1,
        effectiveActions: [
          'test.hold',
          'test.hold2',
          'test.count',
          'test.inner',
          'test.outer',
          'test.deferred',
          'test.deferred.abort',
          'test.deferred.unknown',
          'test.deferred.completefail',
          'test.poll',
          'test.quick',
          'test.outerCallsDeferred'
        ],
        schemas: {},
        visibilityScope: 'smoke'
      }) as never,
    isOperationVisible: (surface, operation) =>
      (surface as unknown as { effectiveActions: string[] }).effectiveActions.includes(operation)
  }
}

function countRows(
  db: import('node:sqlite').DatabaseSync,
  sql: string,
  ...params: unknown[]
): number {
  const row = db.prepare(sql).get(...(params as never[])) as { c: number } | undefined
  return Number(row?.c ?? 0)
}

function admissionRow(
  db: import('node:sqlite').DatabaseSync,
  operationKey: string
): { id: string; state: string; receipt: unknown } | null {
  const row = db
    .prepare('SELECT id, state, receipt_json FROM effect_intents WHERE operation_key=? ORDER BY id')
    .get(operationKey) as { id: string; state: string; receipt_json: string } | undefined
  return row
    ? {
        id: String(row.id),
        state: String(row.state),
        receipt: JSON.parse(String(row.receipt_json))
      }
    : null
}

function insertEvent(txn: TxnContext, aggregateId: string, eventType: string): void {
  txn.emitEvent({ aggregateId, aggregateRevision: 1, eventType })
}

async function main(): Promise<void> {
  const db = openControlDb(':memory:')
  const ops = new OperationRegistry({
    db,
    access: accessDouble(),
    storage: controlStorage as unknown as StorageBoundary
  })
  const ctx = context()

  // ── 1. independent dispatch waits, and never sees a foreign open tx ───────
  const holdEntered = gate()
  const holdRelease = gate()
  ops.register({ name: 'test.hold', visibility: 'operator', mutation: true }, (txn) => {
    insertEvent(txn, 'hold-row', 'HeldRow')
    holdEntered.open()
    return holdRelease.promise.then(() => {
      throw mahasError('INPUT_NOT_READY', 'held row rolled back', 'same-operation')
    })
  })
  ops.register({ name: 'test.count', visibility: 'operator', mutation: false }, (txn) => ({
    events: countRows(txn.db, 'SELECT COUNT(*) c FROM domain_events')
  }))

  const held = ops.dispatch(ctx, request('test.hold', 'hold-1', {}))
  await holdEntered.promise
  const heldTxOpen = countRows(db, 'SELECT COUNT(*) c FROM domain_events')
  assert.equal(heldTxOpen, 1, 'the held transaction wrote its row')
  const concurrent = ops.dispatch(ctx, request('test.count', 'count-1', {}))
  let concurrentSettled = false
  void concurrent.then(() => {
    concurrentSettled = true
  })
  await sleep(60)
  assert.equal(concurrentSettled, false, 'an independent dispatch waits for the slot')
  assert.equal(databaseContenders(db) >= 2, true, 'holder + waiter are both accounted for')
  holdRelease.open()
  const heldReceipt = await held
  assert.equal(heldReceipt.status, 'rejected')
  assert.equal(countRows(db, 'SELECT COUNT(*) c FROM domain_events'), 0, 'the held row rolled back')
  const concurrentReceipt = await concurrent
  assert.equal(concurrentReceipt.status, 'committed')
  assert.deepEqual(concurrentReceipt.result, { events: 0 }, 'no foreign uncommitted read')
  ok('independent dispatches serialize, and admission reads see only committed rows')

  // ── 2. the scheduler seam: serializeDatabase(db, () => withTx(db, ...)) ───
  const seamEntered = gate()
  const seamRelease = gate()
  ops.register({ name: 'test.hold2', visibility: 'operator', mutation: true }, (txn) => {
    insertEvent(txn, 'seam-rollback', 'SeamRollback')
    seamEntered.open()
    return seamRelease.promise.then(() => {
      throw mahasError('INPUT_NOT_READY', 'seam holder rolls back', 'same-operation')
    })
  })
  const seamHeld = ops.dispatch(ctx, request('test.hold2', 'seam-1', {}))
  await seamEntered.promise
  let scheduled = false
  const scheduledWrite = serializeDatabase(db, () => {
    withTx(db, (tx) => {
      tx.prepare(
        'INSERT INTO domain_events(aggregate_id, aggregate_revision, event_type, scope_json, payload_json) ' +
          "VALUES ('scheduler-row', 1, 'SchedulerRow', '{}', '{}')"
      ).run()
    })
    scheduled = true
  })
  await sleep(60)
  assert.equal(scheduled, false, 'the scheduler waits instead of joining the admission transaction')
  seamRelease.open()
  await seamHeld
  await scheduledWrite
  assert.equal(scheduled, true)
  assert.equal(
    countRows(db, "SELECT COUNT(*) c FROM domain_events WHERE aggregate_id='scheduler-row'"),
    1
  )
  assert.equal(
    countRows(db, "SELECT COUNT(*) c FROM domain_events WHERE aggregate_id='seam-rollback'"),
    0
  )
  ok('serializeDatabase is a usable scheduler seam: its commit survives the admission rollback')

  // ── 3. nested dispatch joins the ambient transaction (no deadlock) ────────
  ops.register({ name: 'test.inner', visibility: 'member', mutation: true }, (txn) => {
    insertEvent(txn, 'inner-row', 'InnerRow')
    return { inner: true }
  })
  ops.register({ name: 'test.outer', visibility: 'member', mutation: true }, async (txn) => {
    const caller = makeCaller(ops, txn.ctx)
    await caller('test.inner', {})
    throw mahasError('INPUT_NOT_READY', 'outer fails after inner succeeded', 'same-operation')
  })
  const outerReceipt = await ops.dispatch(ctx, request('test.outer', 'outer-1', {}))
  assert.equal(outerReceipt.status, 'rejected')
  assert.equal(
    countRows(db, "SELECT COUNT(*) c FROM domain_events WHERE aggregate_id='inner-row'"),
    0,
    'the nested dispatch committed with the outer transaction, which rolled back'
  )
  ok('nested dispatch joins the ambient transaction and never deadlocks on the queue')

  // ── 4. deferred mutation: admit → effect (no tx) → atomic completion ──────
  const effectStarted = gate()
  const effectGo = gate()
  let effectRuns = 0
  const effectObservations: Array<{ inTx: boolean; serialized: boolean; ambient: boolean }> = []
  ops.register(
    deferredSpec({ name: 'test.deferred', visibility: 'operator', mutation: true }),
    asDeferredHandler(async (effect) => {
      effectRuns++
      effectObservations.push({
        inTx: inTransaction(effect.db),
        serialized: holdsDatabaseSerialization(effect.db),
        ambient: hasAmbientTransaction(effect.db)
      })
      effectStarted.open()
      await effectGo.promise
      return {
        complete: (txn) => {
          insertEvent(txn, 'deferred-row', 'DeferredRow')
          return { token: 'abc' }
        }
      }
    })
  )

  const deferred = ops.dispatch(ctx, request('test.deferred', 'def-1', { value: 1 }))
  await effectStarted.promise
  assert.equal(effectRuns, 1)
  assert.deepEqual(effectObservations[0], { inTx: false, serialized: false, ambient: false })
  const admissionKey = 'principal-1/test.deferred/def-1'
  assert.equal(admissionRow(db, admissionKey)?.state, 'attempting')
  assert.equal(
    countRows(db, "SELECT COUNT(*) c FROM operation_receipts WHERE operation_id='def-1'"),
    0,
    'no receipt while the effect is uncommitted'
  )
  // the connection is free: an independent writer can take the write lock now
  db.exec('BEGIN IMMEDIATE')
  db.exec('ROLLBACK')
  // a duplicate dispatch of the same operation key answers 'pending' and does
  // NOT run the effect a second time
  const duplicate = await ops.dispatch(ctx, request('test.deferred', 'def-1', { value: 1 }))
  assert.equal(duplicate.status, 'pending')
  assert.equal(duplicate.error?.retry, 'reconcile')
  assert.equal(effectRuns, 1)
  effectGo.open()
  const committed = await deferred
  assert.equal(committed.status, 'committed')
  assert.deepEqual(committed.result, { token: 'abc' })
  assert.equal(
    countRows(db, "SELECT COUNT(*) c FROM domain_events WHERE aggregate_id='deferred-row'"),
    1
  )
  assert.equal(
    countRows(db, "SELECT COUNT(*) c FROM operation_receipts WHERE operation_id='def-1'"),
    1
  )
  const confirmed = admissionRow(db, admissionKey)
  assert.equal(confirmed?.state, 'confirmed')
  assert.deepEqual((confirmed?.receipt as { result: unknown }).result, { token: 'abc' })
  const replay = await ops.dispatch(ctx, request('test.deferred', 'def-1', { value: 1 }))
  // the stored copy also carries the operation column the receipt key needs
  // (IMP-02/03 wart) — the contract shape itself must match
  assert.equal(replay.status, 'committed')
  assert.equal(replay.fingerprint, committed.fingerprint)
  assert.deepEqual(replay.result, committed.result)
  assert.equal(replay.operationId, committed.operationId, 'a replay returns the stored receipt')
  assert.equal(effectRuns, 1)
  const conflict = await ops.dispatch(ctx, request('test.deferred', 'def-1', { value: 2 }))
  assert.equal(conflict.status, 'rejected')
  assert.equal(conflict.error?.code, 'OPERATION_CONFLICT')
  ok(
    'a deferred mutation admits durably, effects outside the transaction, and completes atomically'
  )

  // ── 5. a business failure in the effect releases the admission ────────────
  let abortRuns = 0
  let abortSucceeds = false
  // spread form: the bundle marks the spec and adapts the handler in one call
  ops.register(
    ...deferredMutation(
      { name: 'test.deferred.abort', visibility: 'operator', mutation: true },
      async () => {
        abortRuns++
        if (!abortSucceeds) throw mahasError('MODEL_INVALID', 'fixture rejects the request', 'none')
        return {
          complete: (txn) => {
            insertEvent(txn, 'abort-row', 'AbortRow')
            return { ok: true }
          }
        }
      }
    )
  )
  const aborted = await ops.dispatch(ctx, request('test.deferred.abort', 'abort-1', {}))
  assert.equal(aborted.status, 'rejected')
  assert.equal(aborted.error?.code, 'MODEL_INVALID')
  assert.equal(admissionRow(db, 'principal-1/test.deferred.abort/abort-1'), null)
  abortSucceeds = true
  const retried = await ops.dispatch(ctx, request('test.deferred.abort', 'abort-1', {}))
  assert.equal(retried.status, 'committed')
  assert.equal(abortRuns, 2, 'a proven-unapplied failure is retried, not parked')
  ok('a MahasError from the effect releases the durable admission for a retry')

  // ── 6. an ambiguous fault parks the admission as 'unknown' ────────────────
  let unknownRuns = 0
  ops.register(
    deferredSpec({ name: 'test.deferred.unknown', visibility: 'operator', mutation: true }),
    asDeferredHandler(async () => {
      unknownRuns++
      throw new Error('fixture crashed mid-effect')
    })
  )
  const ambiguous = await ops.dispatch(ctx, request('test.deferred.unknown', 'unk-1', {}))
  assert.equal(ambiguous.status, 'unknown')
  assert.equal(ambiguous.error?.code, 'CONTROL_UNAVAILABLE')
  assert.equal(ambiguous.error?.retry, 'reconcile')
  const unknownKey = 'principal-1/test.deferred.unknown/unk-1'
  assert.equal(admissionRow(db, unknownKey)?.state, 'attempting')
  const parkedAgain = await ops.dispatch(ctx, request('test.deferred.unknown', 'unk-1', {}))
  assert.equal(parkedAgain.status, 'pending')
  assert.equal(unknownRuns, 1, 'an ambiguous outcome is never re-executed automatically')
  const pending = listDeferredAdmissions(db).find((row) => row.operationKey === unknownKey)
  assert.ok(pending, 'the pending admission is visible to a reconcile worker')
  assert.equal(releaseDeferredAdmissionPending(db, pending.id), true)
  await ops.dispatch(ctx, request('test.deferred.unknown', 'unk-1', {}))
  assert.equal(unknownRuns, 2, 'after an evidence-based release the effect can run again')
  ok('an ambiguous fault parks the admission for reconcile instead of re-running it')

  // ── 7. a failing completion rolls back and releases ───────────────────────
  let completions = 0
  ops.register(
    deferredSpec({ name: 'test.deferred.completefail', visibility: 'operator', mutation: true }),
    asDeferredHandler(async () => ({
      complete: (txn) => {
        completions++
        insertEvent(txn, 'completefail-row', 'CompleteFailRow')
        throw mahasError('INVALID_TRANSITION', 'completion refuses', 'none')
      }
    }))
  )
  const failedCompletion = await ops.dispatch(
    ctx,
    request('test.deferred.completefail', 'cf-1', {})
  )
  assert.equal(failedCompletion.status, 'rejected')
  assert.equal(failedCompletion.error?.code, 'INVALID_TRANSITION')
  assert.equal(
    countRows(db, "SELECT COUNT(*) c FROM domain_events WHERE aggregate_id='completefail-row'"),
    0,
    'the completion transaction rolled back'
  )
  assert.equal(
    countRows(db, "SELECT COUNT(*) c FROM operation_receipts WHERE operation_id='cf-1'"),
    0
  )
  assert.equal(admissionRow(db, 'principal-1/test.deferred.completefail/cf-1'), null)
  await ops.dispatch(ctx, request('test.deferred.completefail', 'cf-1', {}))
  assert.equal(completions, 2, 'a rolled-back completion leaves nothing behind, so retry re-runs')
  ok('a failing completion rolls back, releases the admission, and stays retryable')

  // ── 8. long-poll queries do not fence the writer ──────────────────────────
  const pollEntered = gate()
  const pollGo = gate()
  ops.register(
    { name: 'test.poll', visibility: 'member', mutation: false, longPoll: true },
    async () => {
      pollEntered.open()
      await pollGo.promise
      return { polled: true }
    }
  )
  ops.register({ name: 'test.quick', visibility: 'member', mutation: true }, (txn) => {
    insertEvent(txn, 'quick-row', 'QuickRow')
    return { quick: true }
  })
  const polling = ops.dispatch(ctx, request('test.poll', 'poll-1', {}))
  await pollEntered.promise
  const quick = await ops.dispatch(ctx, request('test.quick', 'quick-1', {}))
  assert.equal(quick.status, 'committed', 'the writer is not fenced by the waiting query')
  pollGo.open()
  assert.deepEqual((await polling).result, { polled: true })
  ok('a long-poll query waits without holding the connection or a transaction')

  // ── 9. a deferred operation refuses to run inside an ambient transaction ───
  let nestedCode: string | undefined
  ops.register(
    { name: 'test.outerCallsDeferred', visibility: 'operator', mutation: true },
    async (txn) => {
      try {
        await makeCaller(ops, txn.ctx)('test.deferred', { value: 99 })
      } catch (error) {
        nestedCode = (error as { mahasError?: { code?: string } }).mahasError?.code
      }
      return { nestedCode }
    }
  )
  const beforeNested = countRows(db, 'SELECT COUNT(*) c FROM effect_intents')
  const nested = await ops.dispatch(ctx, request('test.outerCallsDeferred', 'outer-2', {}))
  assert.equal(nested.status, 'committed')
  assert.equal(nestedCode, 'INVALID_TRANSITION')
  assert.equal(countRows(db, 'SELECT COUNT(*) c FROM effect_intents'), beforeNested)
  ok('a deferred operation refuses an ambient transaction instead of effecting under BEGIN')

  db.close()
}

/** release under the connection slot, as a reconcile worker would */
function releaseDeferredAdmissionPending(
  db: import('node:sqlite').DatabaseSync,
  effectId: string
): boolean {
  withTx(db, () => releaseDeferredAdmission(db, effectId))
  return true
}

void main()
  .then(() => {
    process.stdout.write(`\n${checks} checks passed\n`)
  })
  .catch((error: unknown) => {
    process.stdout.write(`FAILED: ${error instanceof Error ? error.stack : String(error)}\n`)
    process.exit(1)
  })
