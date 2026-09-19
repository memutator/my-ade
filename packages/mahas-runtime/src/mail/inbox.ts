// mahas-runtime/mail — inbox.check (C-MAIL).
//
// Semantics (spec/domains/messaging-outcomes.md §2, REQ-18/19):
//   * Member is the durable mailbox address — the batch comes from the
//     deliveries/messages ledger, never from PTY input or wake attempts.
//   * Reading is NOT acking: an InboxRead is a response snapshot and the
//     same batch may be returned again until delivery.ack lands.
//   * The caller's credential must carry the member's CURRENT consumer
//     generation (fence: STALE_EXECUTION). Outstanding rows still pointing
//     at an older generation are re-bound to the current one — status and
//     identity preserved, message never duplicated.

import type { DatabaseSync } from 'node:sqlite'
import type { OperationHandler } from '../api/registry.ts'
import type { Id } from '../../../mahas-contracts/src/common.ts'
import type { InboxCheckPayload, InboxCheckResult, InboxItem, MailDeps } from './api.ts'
import {
  asObject,
  makeInboxRead,
  messageArtifactRefs,
  optInt,
  parseCursor,
  rebindOutstandingDeliveries,
  requireCurrentMember,
  rowToDelivery,
  rowToMessage,
  type MemberRow,
  type MessageRow
} from './shared.ts'

export const DEFAULT_BATCH_LIMIT = 50

interface OutstandingRow {
  seq: number
  // deliveries d.*
  id: string
  message_id: string
  recipient_member_id: string
  consumer_generation: number
  status: 'outstanding' | 'acknowledged' | 'fenced'
  revision: number
  acked_at: number | null
  handling_json: string
  // messages m.*
  m_run_id: string
  m_sender_principal_id: string
  m_sender_member_id: string | null
  m_kind: string
  m_body: string
  m_links_json: string
  m_created_at: number
}

const OUTSTANDING_SQL = `
  SELECT d.rowid AS seq,
         d.id, d.message_id, d.recipient_member_id, d.consumer_generation,
         d.status, d.revision, d.acked_at, d.handling_json,
         m.run_id            AS m_run_id,
         m.sender_principal_id AS m_sender_principal_id,
         m.sender_member_id  AS m_sender_member_id,
         m.kind              AS m_kind,
         m.body              AS m_body,
         m.links_json        AS m_links_json,
         m.created_at        AS m_created_at
    FROM deliveries d
    JOIN messages m ON m.id = d.message_id
   WHERE d.recipient_member_id = ?
     AND d.status = 'outstanding'
     AND d.rowid > ?
   ORDER BY d.rowid ASC
   LIMIT ?`

/**
 * FIFO page of outstanding deliveries for `member`, after `afterSeq`
 * (0 = head). Delivery status is the 정본; the cursor is only a paging aid.
 */
export function queryOutstanding(
  db: DatabaseSync,
  member: MemberRow,
  afterSeq: number,
  limit: number
): { items: InboxItem[]; cursor: string; deliveryIds: Id[] } {
  const rows = db
    .prepare(OUTSTANDING_SQL)
    .all(member.id, afterSeq, limit) as unknown as OutstandingRow[]
  let lastSeq = afterSeq
  const items: InboxItem[] = []
  const deliveryIds: Id[] = []
  for (const r of rows) {
    lastSeq = r.seq
    const msgRow: MessageRow = {
      id: r.message_id,
      run_id: r.m_run_id,
      sender_principal_id: r.m_sender_principal_id,
      sender_member_id: r.m_sender_member_id,
      kind: r.m_kind,
      body: r.m_body,
      links_json: r.m_links_json,
      created_at: r.m_created_at
    }
    items.push({
      delivery: rowToDelivery(r),
      message: rowToMessage(msgRow),
      artifactRefs: messageArtifactRefs(msgRow)
    })
    deliveryIds.push(r.id as Id)
  }
  return { items, cursor: String(lastSeq), deliveryIds }
}

export function effectiveLimit(deps: MailDeps, requested: number | undefined): number {
  const cap = deps.limits?.maxBatch ?? 200
  const lim = requested ?? DEFAULT_BATCH_LIMIT
  return Math.max(1, Math.min(lim, cap))
}

/**
 * Converge the member's mailbox for a member-scoped op: verify the
 * credential's generation, then re-bind outstanding rows left behind by an
 * older generation. Cheap (two indexed statements) and idempotent.
 */
export function openMailbox(
  db: DatabaseSync,
  deps: MailDeps,
  ctx: Parameters<typeof requireCurrentMember>[1],
  operation: string
): MemberRow {
  const member = requireCurrentMember(db, ctx)
  rebindOutstandingDeliveries(db, member.id, member.generation)
  deps.authorize(ctx, operation, [{ kind: 'member', id: member.id }])
  return member
}

export function inboxCheck(deps: MailDeps): OperationHandler {
  return (txn, raw) => {
    const op = 'inbox.check'
    const p = asObject(raw, op)
    const payload: InboxCheckPayload = {
      cursor: p.cursor === undefined ? undefined : String(parseCursor(p, op)),
      limit: optInt(p, 'limit', op, 1)
    }
    const member = openMailbox(txn.db, deps, txn.ctx, op)
    const after = parseCursor(p, op)
    const { items, cursor, deliveryIds } = queryOutstanding(
      txn.db,
      member,
      after,
      effectiveLimit(deps, payload.limit)
    )
    const result: InboxCheckResult = {
      read: makeInboxRead(member, cursor, deliveryIds),
      items,
      cursor
    }
    return result
  }
}
