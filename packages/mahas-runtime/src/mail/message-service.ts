// mahas-runtime/mail — message.send + message.replyAndAck (C-MAIL).
//
// Semantics (spec/domains/messaging-outcomes.md §2, REQ-14/18):
//   * message.send persists the Message + EVERY recipient's Delivery +
//     the event in ONE transaction — the caller (registry) supplies the tx.
//   * sender identity is resolved server-side from the credential, never
//     from the payload. A 'system assignment' message requires a service
//     principal; peer messages come from Member principals.
//   * message.replyAndAck enqueues the reply and acks the original
//     delivery in the SAME transaction — no partial commit. Re-invoking
//     the same operationId is the registry's idempotency replay; a second
//     ack under a different operationId is OPERATION_CONFLICT.
//   * Delivery creation stamps the recipient's CURRENT consumer
//     generation at send time.

import type { DatabaseSync } from 'node:sqlite'
import type { OperationHandler } from '../api/registry.ts'
import type { ArtifactRef, Id } from '../../../mahas-contracts/src/common.ts'
import type {
  MailDeps,
  MessageReplyAndAckPayload,
  MessageReplyAndAckResult,
  MessageSendPayload,
  MessageSendResult
} from './api.ts'
import { applyDeliveryAck } from './ack.ts'
import {
  asObject,
  assertArtifactRefsExist,
  defaultNewId,
  defaultNow,
  fail,
  loadDelivery,
  loadMember,
  loadMessage,
  optArtifactRefs,
  optInt,
  optString,
  optStringArray,
  principalKind,
  rebindOutstandingDeliveries,
  reqHandling,
  reqString,
  reqStringArray,
  requireCurrentMember,
  uniqueStrings,
  type MemberRow
} from './shared.ts'

interface MessageLinks {
  taskRef?: string
  contractRefs?: string[]
  artifactRefs?: ArtifactRef[]
  replyTo?: { messageId: string; deliveryId: string }
}

/**
 * Persist one Message plus one outstanding Delivery per recipient, stamping
 * each recipient's CURRENT consumer generation. All validation happens
 * before the first INSERT so a refusal never leaves a partial write inside
 * the caller's transaction.
 */
export function insertMessageWithDeliveries(
  deps: MailDeps,
  db: DatabaseSync,
  args: {
    runId: string
    senderPrincipalId: string
    senderMemberId: string | null
    kind: string
    body: string
    links: MessageLinks
    recipientMemberIds: string[]
  },
  op: string
): { messageId: Id; deliveryIds: Id[] } {
  const now = (deps.now ?? defaultNow)()
  const newId = deps.newId ?? defaultNewId

  // resolve + validate every recipient BEFORE any write
  const recipients: MemberRow[] = uniqueStrings(args.recipientMemberIds).map((rid) => {
    const m = loadMember(db, rid)
    if (!m) {
      fail('SCOPE_DENIED', `${op}: recipient member ${rid} does not exist`, 'none')
    }
    if (m.run_id !== args.runId) {
      fail(
        'SCOPE_DENIED',
        `${op}: recipient ${rid} is in run ${m.run_id}, not ${args.runId} — no cross-run delivery`,
        'none'
      )
    }
    return m
  })

  const messageId = newId('msg') as Id
  db.prepare(
    `INSERT INTO messages (id, run_id, sender_principal_id, sender_member_id, kind, body, links_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    messageId,
    args.runId,
    args.senderPrincipalId,
    args.senderMemberId,
    args.kind,
    args.body,
    JSON.stringify(args.links),
    now
  )

  const insDelivery = db.prepare(
    `INSERT INTO deliveries (id, message_id, recipient_member_id, consumer_generation, status, revision, acked_at, handling_json)
     VALUES (?, ?, ?, ?, 'outstanding', 1, NULL, '{}')`
  )
  const deliveryIds: Id[] = []
  for (const r of recipients) {
    const did = newId('dlv') as Id
    insDelivery.run(did, messageId, r.id, r.generation)
    deliveryIds.push(did)
  }

  deps.appendDomainEvent(
    db,
    messageId,
    1,
    'message.sent',
    { runId: args.runId },
    {
      messageId,
      kind: args.kind,
      senderPrincipalId: args.senderPrincipalId,
      senderMemberId: args.senderMemberId,
      deliveryIds,
      recipientMemberIds: recipients.map((r) => r.id)
    }
  )
  return { messageId, deliveryIds }
}

/** resolve the run a send belongs to: the sender member's run, else the (uniform) recipients' run */
function resolveRunId(
  db: DatabaseSync,
  sender: MemberRow | null,
  recipientIds: string[],
  op: string
): string {
  if (sender) return sender.run_id
  const runs = new Set<string>()
  for (const rid of recipientIds) {
    const m = loadMember(db, rid)
    if (!m) fail('SCOPE_DENIED', `${op}: recipient member ${rid} does not exist`, 'none')
    runs.add(m.run_id)
  }
  if (runs.size !== 1) {
    fail(
      'SCOPE_DENIED',
      `${op}: service-principal send requires all recipients to share one run (got ${runs.size})`,
      'none'
    )
  }
  return [...runs][0]!
}

export function messageSend(deps: MailDeps): OperationHandler {
  return (txn, raw) => {
    const op = 'message.send'
    const o = asObject(raw, op)
    const payload: MessageSendPayload = {
      recipientMemberIds: reqStringArray(o, 'recipientMemberIds', op),
      body: reqString(o, 'body', op),
      kind: reqString(o, 'kind', op),
      taskRef: optString(o, 'taskRef', op),
      contractRefs: optStringArray(o, 'contractRefs', op),
      artifactRefs: optArtifactRefs(o, 'artifactRefs', op)
    }

    // sender is server-decided from the credential — payload cannot override
    const sender = txn.ctx.memberId ? loadMember(txn.db, txn.ctx.memberId as string) : null
    if (txn.ctx.memberId && !sender) {
      fail('UNAUTHENTICATED', `${op}: credential member ${txn.ctx.memberId} not found`, 'none')
    }

    // 'assignment' is the system-assignment path: service principal only.
    if (payload.kind === 'assignment') {
      const kind = principalKind(txn.db, txn.ctx.principalId as string)
      if (kind !== 'service') {
        fail(
          'SCOPE_DENIED',
          `${op}: kind 'assignment' is reserved for service principals (got '${kind ?? 'unknown'}')`,
          'none'
        )
      }
    }

    const runId = resolveRunId(txn.db, sender, payload.recipientMemberIds, op)
    const recipientIds = uniqueStrings(payload.recipientMemberIds)

    deps.authorize(
      txn.ctx,
      op,
      recipientIds.map((id) => ({ kind: 'member', id }))
    )
    assertArtifactRefsExist(txn.db, payload.artifactRefs)

    const { messageId, deliveryIds } = insertMessageWithDeliveries(
      deps,
      txn.db,
      {
        runId,
        senderPrincipalId: txn.ctx.principalId as string,
        senderMemberId: sender?.id ?? null,
        kind: payload.kind,
        body: payload.body,
        links: {
          taskRef: payload.taskRef,
          contractRefs: payload.contractRefs,
          artifactRefs: payload.artifactRefs
        },
        recipientMemberIds: recipientIds
      },
      op
    )
    const result: MessageSendResult = { messageId, deliveryIds }
    return result
  }
}

export function messageReplyAndAck(deps: MailDeps): OperationHandler {
  return (txn, raw) => {
    const op = 'message.replyAndAck'
    const o = asObject(raw, op)
    const payload: MessageReplyAndAckPayload = {
      originalDeliveryId: reqString(o, 'originalDeliveryId', op),
      expectedDeliveryRevision: optInt(o, 'expectedDeliveryRevision', op, 1),
      replyBody: reqString(o, 'replyBody', op),
      recipients: optStringArray(o, 'recipients', op),
      artifactRefs: optArtifactRefs(o, 'artifactRefs', op),
      handling: reqHandling(o, 'handling', op),
      followupRef: optString(o, 'followupRef', op)
    }

    const member = requireCurrentMember(txn.db, txn.ctx)
    rebindOutstandingDeliveries(txn.db, member.id, member.generation)

    const original = loadDelivery(txn.db, payload.originalDeliveryId)
    if (!original) {
      fail(
        'INPUT_NOT_READY',
        `${op}: original delivery ${payload.originalDeliveryId} not found`,
        'none'
      )
    }
    const originalMessage = loadMessage(txn.db, original!.message_id)
    if (!originalMessage) {
      fail(
        'OPERATION_CONFLICT',
        `${op}: delivery ${original!.id} references a missing message`,
        'reconcile'
      )
    }

    // pre-check BEFORE the reply insert — applyDeliveryAck re-checks
    // authoritatively, but refusing early means no reply row can be left
    // behind even if the caller ever runs this op outside a transaction.
    if (original!.recipient_member_id !== member.id) {
      fail(
        'SCOPE_DENIED',
        `${op}: delivery ${original!.id} belongs to another member's inbox`,
        'none'
      )
    }
    if (original!.status === 'fenced') {
      fail('STALE_EXECUTION', `${op}: delivery ${original!.id} is fenced`, 'reconcile')
    }
    if (original!.status === 'acknowledged') {
      fail(
        'OPERATION_CONFLICT',
        `${op}: delivery ${original!.id} is already acknowledged at revision ${original!.revision}`,
        'reconcile'
      )
    }
    if (original!.consumer_generation !== member.generation) {
      fail(
        'STALE_EXECUTION',
        `${op}: delivery ${original!.id} is bound to consumer generation ${original!.consumer_generation}`,
        'reconcile'
      )
    }
    if (
      payload.expectedDeliveryRevision !== undefined &&
      original!.revision !== payload.expectedDeliveryRevision
    ) {
      fail(
        'STALE_REVISION',
        `${op}: delivery ${original!.id} is at revision ${original!.revision}, expected ${payload.expectedDeliveryRevision}`,
        'reconcile'
      )
    }

    // reply recipients: explicit, else the original sender's member mailbox.
    // A service-principal original has no member mailbox — explicit recipients
    // are then mandatory.
    const recipientIds = uniqueStrings(
      payload.recipients ??
        (originalMessage!.sender_member_id ? [originalMessage!.sender_member_id] : [])
    )
    if (recipientIds.length === 0) {
      fail(
        'SCOPE_DENIED',
        `${op}: no addressable Member recipient — the original sender has no member mailbox and none were given`,
        'none'
      )
    }

    deps.authorize(txn.ctx, op, [
      { kind: 'delivery', id: original!.id },
      { kind: 'member', id: member.id },
      ...recipientIds.map((id) => ({ kind: 'member', id }))
    ])
    assertArtifactRefsExist(txn.db, payload.artifactRefs)

    // 1) enqueue the reply (same tx as the ack below)
    const { messageId: replyMessageId, deliveryIds } = insertMessageWithDeliveries(
      deps,
      txn.db,
      {
        runId: originalMessage!.run_id,
        senderPrincipalId: txn.ctx.principalId as string,
        senderMemberId: member.id,
        kind: 'reply',
        body: payload.replyBody,
        links: {
          replyTo: { messageId: originalMessage!.id, deliveryId: original!.id },
          artifactRefs: payload.artifactRefs
        },
        recipientMemberIds: recipientIds
      },
      op
    )

    // 2) ack the original — durably-deferred may cite the just-stored reply
    //    (a durable follow-up record) when no explicit followupRef was given.
    const followupRef =
      payload.followupRef ??
      (payload.handling === 'durably-deferred' ? `message:${replyMessageId}` : undefined)
    const ackRevision = applyDeliveryAck(
      deps,
      txn.db,
      member.id,
      member.generation,
      member.run_id,
      original!,
      payload.expectedDeliveryRevision,
      payload.handling,
      followupRef,
      op
    )

    const result: MessageReplyAndAckResult = { replyMessageId, deliveryIds, ackRevision }
    return result
  }
}
