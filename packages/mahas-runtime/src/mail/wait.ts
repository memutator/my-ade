// mahas-runtime/mail — inbox.wait (C-MAIL).
//
// Bounded wait for a running agent's tool call (D-MAIL §5, REQ-19):
//   * Polls the deliveries ledger until an outstanding batch appears or the
//     bound elapses. Timeout is an honest EMPTY result — never an error,
//     never a task failure, and it changes NO message state.
//   * Connection close / process death mid-wait mutates nothing: the ledger
//     keeps every delivery.
//   * No automatic wake/spawn is triggered on timeout — wake is a separate
//     service interface (IMP-21 execution.wake), orthogonal to the mailbox.
//   * The consumer-generation fence is re-verified each poll: if the
//     member's execution generation moved underneath the wait, the
//     credential is fenced (STALE_EXECUTION).
//
// DISPATCH CONSTRAINT (handoff note): this handler must run OUTSIDE any
// wrapping transaction — it re-issues autocommit SELECTs while sleeping
// between polls, so a snapshot pinned by an ambient tx would make it blind
// and a write tx would hold the single-writer lock for the whole wait.
// It is registered with mutation:false for exactly that reason.

import type { OperationHandler } from '../api/registry.ts'
import type { InboxWaitPayload, InboxWaitResult, MailDeps } from './api.ts'
import { effectiveLimit, openMailbox, queryOutstanding } from './inbox.ts'
import {
  asObject,
  assertCurrentGeneration,
  defaultNow,
  loadMember,
  makeInboxRead,
  optInt,
  parseCursor,
  rebindOutstandingDeliveries
} from './shared.ts'

const DEFAULT_MAX_WAIT_MS = 60_000
const DEFAULT_POLL_MS = 100

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function inboxWait(deps: MailDeps): OperationHandler {
  return async (txn, raw) => {
    const op = 'inbox.wait'
    const o = asObject(raw, op)
    const payload: InboxWaitPayload = {
      cursor: o.cursor === undefined ? undefined : String(parseCursor(o, op)),
      maxWaitMs: optInt(o, 'maxWaitMs', op, 0) ?? 0,
      limit: optInt(o, 'limit', op, 1)
    }
    const now = deps.now ?? defaultNow
    const bound = Math.min(payload.maxWaitMs, deps.limits?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS)
    const pollMs = Math.max(10, deps.limits?.pollIntervalMs ?? DEFAULT_POLL_MS)
    const after = parseCursor(o, op)
    const limit = effectiveLimit(deps, payload.limit)

    const member = openMailbox(txn.db, deps, txn.ctx, op)
    const deadline = now() + bound
    const started = now()

    for (;;) {
      // converge outstanding rows onto the current generation, then read
      rebindOutstandingDeliveries(txn.db, member.id, member.generation)
      const { items, cursor, deliveryIds } = queryOutstanding(txn.db, member, after, limit)
      const elapsed = now() - started
      if (items.length > 0) {
        const result: InboxWaitResult = {
          read: makeInboxRead(member, cursor, deliveryIds),
          items,
          cursor,
          timedOut: false,
          waitedMs: elapsed
        }
        return result
      }
      const remaining = deadline - now()
      if (remaining <= 0) {
        const result: InboxWaitResult = {
          read: makeInboxRead(member, cursor, deliveryIds),
          items: [],
          cursor,
          timedOut: true,
          waitedMs: now() - started
        }
        return result
      }
      await sleep(Math.min(pollMs, remaining))
      // re-verify the fence: a generation bump mid-wait fences this credential
      const fresh = loadMember(txn.db, member.id)
      if (fresh) {
        member.generation = fresh.generation
        member.revision = fresh.revision
        member.state = fresh.state
      }
      assertCurrentGeneration(txn.ctx, member)
    }
  }
}
