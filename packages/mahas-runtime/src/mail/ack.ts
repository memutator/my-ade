// mahas-runtime/mail — delivery.ack (C-MAIL).
//
// ACK means the agent declares the message was processed or that a durable
// follow-up record now exists — it is NOT "was read" and NOT "was woken"
// (D-MAIL §2, REQ-18). The ack + its event land in the caller's transaction.
// Cross-member acks are SCOPE_DENIED; stale generation/revision are fenced.

import type { OperationHandler } from '../api/registry.ts'
import type { Revision } from '../../../mahas-contracts/src/common.ts'
import type { DeliveryAckPayload, DeliveryAckResult, MailDeps } from './api.ts'
import {
  asObject,
  defaultNow,
  fail,
  loadDelivery,
  optString,
  rebindOutstandingDeliveries,
  reqHandling,
  reqInt,
  reqString,
  requireCurrentMember,
  type DeliveryRow
} from './shared.ts'

/**
 * Shared ack core used by delivery.ack and message.replyAndAck — validates
 * recipient/generation/status/revision and applies the status transition.
 * Returns the new delivery revision. Does NOT authorize (caller does, with
 * its own operation name).
 */
export function applyDeliveryAck(
  deps: MailDeps,
  db: Parameters<typeof loadDelivery>[0],
  memberId: string,
  memberGeneration: number,
  memberRunId: string,
  delivery: DeliveryRow,
  expectedDeliveryRevision: number | undefined,
  handling: 'completed' | 'durably-deferred',
  followupRef: string | undefined,
  op: string
): Revision {
  if (delivery.recipient_member_id !== memberId) {
    fail('SCOPE_DENIED', `${op}: delivery ${delivery.id} belongs to another member's inbox`, 'none')
  }
  if (delivery.status === 'fenced') {
    fail(
      'STALE_EXECUTION',
      `${op}: delivery ${delivery.id} is fenced — receipt for this member is closed`,
      'reconcile'
    )
  }
  if (delivery.status === 'acknowledged') {
    fail(
      'OPERATION_CONFLICT',
      `${op}: delivery ${delivery.id} is already acknowledged at revision ${delivery.revision}`,
      'reconcile',
      { deliveryId: delivery.id, revision: delivery.revision }
    )
  }
  if (delivery.consumer_generation !== memberGeneration) {
    // an outstanding row on a future generation — the caller's generation is
    // not the delivery's consumer; re-check the inbox to reconcile.
    fail(
      'STALE_EXECUTION',
      `${op}: delivery ${delivery.id} is bound to consumer generation ${delivery.consumer_generation}, not ${memberGeneration}`,
      'reconcile'
    )
  }
  if (expectedDeliveryRevision !== undefined && delivery.revision !== expectedDeliveryRevision) {
    fail(
      'STALE_REVISION',
      `${op}: delivery ${delivery.id} is at revision ${delivery.revision}, expected ${expectedDeliveryRevision}`,
      'reconcile'
    )
  }
  if (handling === 'durably-deferred' && !followupRef) {
    fail(
      'INPUT_NOT_READY',
      `${op}: handling 'durably-deferred' requires followupRef — an actual durable follow-up record`,
      'none'
    )
  }

  const now = (deps.now ?? defaultNow)()
  const ackRevision = (delivery.revision + 1) as Revision
  const res = db
    .prepare(
      `UPDATE deliveries
         SET status = 'acknowledged', revision = ?, acked_at = ?, handling_json = ?
       WHERE id = ? AND revision = ? AND status = 'outstanding'`
    )
    .run(
      ackRevision,
      now,
      JSON.stringify({ handling, followupRef: followupRef ?? null }),
      delivery.id,
      delivery.revision
    )
  if (Number(res.changes) !== 1) {
    // lost a race inside the transaction — report honestly, never pretend
    fail(
      'OPERATION_CONFLICT',
      `${op}: delivery ${delivery.id} changed underneath the ack`,
      'reconcile'
    )
  }
  deps.appendDomainEvent(
    db,
    delivery.id,
    ackRevision,
    'delivery.acknowledged',
    { memberId, runId: memberRunId },
    {
      deliveryId: delivery.id,
      messageId: delivery.message_id,
      handling,
      followupRef: followupRef ?? null,
      ackedAt: now
    }
  )
  return ackRevision
}

export function deliveryAck(deps: MailDeps): OperationHandler {
  return (txn, raw) => {
    const op = 'delivery.ack'
    const o = asObject(raw, op)
    const payload: DeliveryAckPayload = {
      deliveryId: reqString(o, 'deliveryId', op),
      expectedDeliveryRevision: reqInt(o, 'expectedDeliveryRevision', op, 1),
      handling: reqHandling(o, 'handling', op),
      followupRef: optString(o, 'followupRef', op)
    }

    const member = requireCurrentMember(txn.db, txn.ctx)
    // converge: rows left on an older generation re-bind to the current one
    rebindOutstandingDeliveries(txn.db, member.id, member.generation)

    const delivery = loadDelivery(txn.db, payload.deliveryId)
    if (!delivery) {
      fail('INPUT_NOT_READY', `${op}: delivery ${payload.deliveryId} not found`, 'none')
    }
    // authorize BEFORE mutating — own-inbox check also happens in applyDeliveryAck
    deps.authorize(txn.ctx, op, [
      { kind: 'delivery', id: delivery!.id },
      { kind: 'member', id: member.id }
    ])

    const ackRevision = applyDeliveryAck(
      deps,
      txn.db,
      member.id,
      member.generation,
      member.run_id,
      delivery!,
      payload.expectedDeliveryRevision,
      payload.handling,
      payload.followupRef,
      op
    )
    const result: DeliveryAckResult = { ackRevision }
    return result
  }
}

// re-exported for the retirement/stop path — the fence helpers live in shared.ts
export { rebindOutstandingDeliveries, fenceDeliveriesForMember } from './shared.ts'
