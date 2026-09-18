// mahas-runtime — C-CLIENT persistence (spec/storage.md §3).
//
// Row access for the three tables this boundary reads/writes inside the
// registry's transaction:
//   terminal_records      — control mirror of host terminals (IMP-18 writes)
//   terminal_input_leases — InputLease CAS row keyed by terminal_id
//   client_view_bindings  — UI-owned view ↔ execution/terminal binding
// Plus a read-only executions lookup to enrich bindings.
//
// Internal row shapes are deliberately NOT the canonical IMP-02 domain
// types (TerminalRecord / InputLease / ClientViewBinding) — they map the
// DDL columns 1:1 and stay private to this module's handlers.

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ClientViewBinding } from '../../../mahas-contracts/src/index.ts'
import { conflict, staleRevision } from './errors.ts'

export interface TerminalRow {
  id: string
  host_id: string
  resource_id: string
  host_incarnation: string
  pty_id: string
  output_epoch: string
  last_sequence: number
  state: string
  process_identity_json: string
}

export interface InputLeaseRow {
  terminal_id: string
  principal_id: string
  revision: number
  expires_at: number
}

export interface ViewBindingRow {
  id: string
  client_id: string
  view_id: string
  execution_id: string | null
  terminal_id: string | null
  layout_binding_json: string
}

/** binding metadata carried inside layout_binding_json. `revision` is the
 *  binding CAS counter — the table has no dedicated revision column, so the
 *  binding revision lives in its own payload (S-STORAGE §2: subscription
 *  cursor is a server response value, not a stored column). */
export interface LayoutBinding {
  revision: number
  boundAt: number
  updatedAt: number
  /** host subscription while a terminal stream is attached */
  subscriptionId?: string | null
  inputIntent?: 'observe' | 'claim'
  /** free-form client layout hints (pane position etc.) — opaque to us */
  layout?: unknown
}

export function getTerminal(db: DatabaseSync, terminalId: string): TerminalRow | null {
  const row = db
    .prepare(
      `SELECT id, host_id, resource_id, host_incarnation, pty_id,
              output_epoch, last_sequence, state, process_identity_json
       FROM terminal_records WHERE id = ?`
    )
    .get(terminalId)
  return (row as TerminalRow | undefined) ?? null
}

/** execution that owns this terminal, if the launch linked one */
export function getExecutionForTerminal(
  db: DatabaseSync,
  terminalId: string
): { id: string; state: string; liveness: string } | null {
  const row = db
    .prepare(`SELECT id, state, liveness FROM executions WHERE terminal_id = ?`)
    .get(terminalId)
  return (row as { id: string; state: string; liveness: string } | undefined) ?? null
}

export function executionExists(db: DatabaseSync, executionId: string): boolean {
  return db.prepare(`SELECT 1 FROM executions WHERE id = ?`).get(executionId) !== undefined
}

// ── InputLease ──────────────────────────────────────────────────────────────

export function getInputLease(db: DatabaseSync, terminalId: string): InputLeaseRow | null {
  const row = db
    .prepare(
      `SELECT terminal_id, principal_id, revision, expires_at
       FROM terminal_input_leases WHERE terminal_id = ?`
    )
    .get(terminalId)
  return (row as InputLeaseRow | undefined) ?? null
}

/**
 * C-CLIENT terminal.attach claim CAS (spec: "inputIntent=claim이면 같은
 * transaction에서 단일 InputLease를 CAS로 생성/갱신한다").
 *
 * Allowed: fresh claim on absent/expired lease; renewal by the current
 * owner. Refused: takeover of another principal's live lease —
 * OPERATION_CONFLICT, never silent preemption. expectedInputLeaseRevision
 * is checked against the current revision (0 when no row exists) —
 * mismatch is STALE_REVISION.
 */
export function claimInputLease(
  db: DatabaseSync,
  terminalId: string,
  principalId: string,
  expectedRevision: number | undefined,
  ttlMs: number,
  now: number
): InputLeaseRow {
  const current = getInputLease(db, terminalId)
  const currentRevision = current?.revision ?? 0

  if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
    staleRevision(
      `input lease revision mismatch on ${terminalId}: expected ${expectedRevision}, current ${currentRevision}`,
      { terminalId, expected: expectedRevision, current: currentRevision }
    )
  }

  if (current && current.expires_at > now && current.principal_id !== principalId) {
    conflict(
      `input lease on ${terminalId} is held by another principal until ${current.expires_at}`,
      { terminalId, expiresAt: current.expires_at }
    )
  }

  const next: InputLeaseRow = {
    terminal_id: terminalId,
    principal_id: principalId,
    revision: currentRevision + 1,
    expires_at: now + ttlMs
  }
  db.prepare(
    `INSERT INTO terminal_input_leases (terminal_id, principal_id, revision, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(terminal_id) DO UPDATE SET
       principal_id = excluded.principal_id,
       revision = excluded.revision,
       expires_at = excluded.expires_at`
  ).run(next.terminal_id, next.principal_id, next.revision, next.expires_at)
  return next
}

/**
 * terminal.input / terminal.resize gate: only the current InputLease owner
 * may proxy — a passive viewer's lease revision is simply stale
 * (S-LIFECYCLE §4: "resize는 가장 최근 유효 InputLease owner만 수행한다").
 */
export function requireLeaseOwner(
  db: DatabaseSync,
  terminalId: string,
  principalId: string,
  leaseRevision: number,
  now: number
): InputLeaseRow {
  const lease = getInputLease(db, terminalId)
  if (!lease) {
    staleRevision(`no input lease on ${terminalId} — claim one via terminal.attach`, {
      terminalId
    })
  }
  if (lease!.principal_id !== principalId || lease!.revision !== leaseRevision) {
    staleRevision(`stale input lease on ${terminalId} (revision ${leaseRevision})`, {
      terminalId,
      currentRevision: lease!.revision
    })
  }
  if (lease!.expires_at <= now) {
    staleRevision(`input lease on ${terminalId} expired — re-claim via terminal.attach`, {
      terminalId,
      expiredAt: lease!.expires_at
    })
  }
  return lease!
}

/** release this principal's lease on the terminal — never touches other
 *  clients' leases (C-CLIENT terminal.detach). Returns true if one was held. */
export function releaseOwnLease(
  db: DatabaseSync,
  terminalId: string,
  principalId: string
): boolean {
  const res = db
    .prepare(`DELETE FROM terminal_input_leases WHERE terminal_id = ? AND principal_id = ?`)
    .run(terminalId, principalId)
  return Number(res.changes) > 0
}

// ── ClientViewBinding ───────────────────────────────────────────────────────

export function getBinding(
  db: DatabaseSync,
  clientId: string,
  viewId: string
): ViewBindingRow | null {
  const row = db
    .prepare(
      `SELECT id, client_id, view_id, execution_id, terminal_id, layout_binding_json
       FROM client_view_bindings WHERE client_id = ? AND view_id = ?`
    )
    .get(clientId, viewId)
  return (row as ViewBindingRow | undefined) ?? null
}

export function getBindingBySubscription(
  db: DatabaseSync,
  subscriptionId: string
): ViewBindingRow | null {
  const row = db
    .prepare(
      `SELECT id, client_id, view_id, execution_id, terminal_id, layout_binding_json
       FROM client_view_bindings
       WHERE json_extract(layout_binding_json, '$.subscriptionId') = ?`
    )
    .get(subscriptionId)
  return (row as ViewBindingRow | undefined) ?? null
}

export function parseLayout(row: ViewBindingRow): LayoutBinding {
  try {
    const parsed = JSON.parse(row.layout_binding_json) as Partial<LayoutBinding>
    return {
      revision: typeof parsed.revision === 'number' ? parsed.revision : 1,
      boundAt: typeof parsed.boundAt === 'number' ? parsed.boundAt : 0,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      subscriptionId: parsed.subscriptionId ?? null,
      inputIntent: parsed.inputIntent,
      layout: parsed.layout
    }
  } catch {
    return { revision: 1, boundAt: 0, updatedAt: 0 }
  }
}

export interface UpsertBindingInput {
  viewId: string
  executionId?: string | null
  terminalId?: string | null
  subscriptionId?: string | null
  inputIntent?: 'observe' | 'claim'
  /** preserve an existing subscription when only re-targeting the binding */
  keepSubscription?: boolean
}

/**
 * One binding per (client, view) — a view is a binding, never an Execution
 * or Terminal (REQ-11). Re-binding bumps the stored revision; the row id
 * is stable for the life of the binding.
 */
export function upsertBinding(
  db: DatabaseSync,
  clientId: string,
  input: UpsertBindingInput,
  now: number
): ClientViewBinding {
  const existing = getBinding(db, clientId, input.viewId)
  const nowMs = now

  if (existing) {
    const layout = parseLayout(existing)
    const nextTerminalId = input.terminalId !== undefined ? input.terminalId : existing.terminal_id
    // a re-targeted binding can never keep the old terminal's subscription
    const terminalChanged = nextTerminalId !== existing.terminal_id
    const next: LayoutBinding = {
      ...layout,
      revision: layout.revision + 1,
      updatedAt: nowMs,
      subscriptionId: terminalChanged
        ? null
        : input.subscriptionId !== undefined
          ? input.subscriptionId
          : input.keepSubscription
            ? layout.subscriptionId
            : null,
      inputIntent: input.inputIntent ?? layout.inputIntent
    }
    db.prepare(
      `UPDATE client_view_bindings
       SET execution_id = ?, terminal_id = ?, layout_binding_json = ?
       WHERE id = ?`
    ).run(
      input.executionId !== undefined ? input.executionId : existing.execution_id,
      nextTerminalId,
      JSON.stringify(next),
      existing.id
    )
    return {
      viewId: input.viewId,
      executionId: (input.executionId !== undefined
        ? input.executionId
        : existing.execution_id) as ClientViewBinding['executionId'],
      terminalId: nextTerminalId as ClientViewBinding['terminalId'],
      revision: next.revision,
      boundAt: layout.boundAt
    }
  }

  const id = randomUUID()
  const layout: LayoutBinding = {
    revision: 1,
    boundAt: nowMs,
    updatedAt: nowMs,
    subscriptionId: input.subscriptionId ?? null,
    inputIntent: input.inputIntent
  }
  db.prepare(
    `INSERT INTO client_view_bindings
       (id, client_id, view_id, execution_id, terminal_id, layout_binding_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    clientId,
    input.viewId,
    input.executionId ?? null,
    input.terminalId ?? null,
    JSON.stringify(layout)
  )
  return {
    viewId: input.viewId,
    executionId: input.executionId as ClientViewBinding['executionId'],
    terminalId: input.terminalId as ClientViewBinding['terminalId'],
    revision: 1,
    boundAt: nowMs
  }
}

/** detach clears the subscription but keeps the binding — unbind removes it */
export function clearBindingSubscription(db: DatabaseSync, bindingId: string, now: number): void {
  const row = db
    .prepare(`SELECT layout_binding_json FROM client_view_bindings WHERE id = ?`)
    .get(bindingId) as { layout_binding_json: string } | undefined
  if (!row) return
  let layout: LayoutBinding
  try {
    layout = {
      revision: 1,
      boundAt: 0,
      updatedAt: 0,
      ...(JSON.parse(row.layout_binding_json) as object)
    }
  } catch {
    layout = { revision: 1, boundAt: 0, updatedAt: 0 }
  }
  layout.subscriptionId = null
  layout.updatedAt = now
  db.prepare(`UPDATE client_view_bindings SET layout_binding_json = ? WHERE id = ?`).run(
    JSON.stringify(layout),
    bindingId
  )
}

export function deleteBinding(db: DatabaseSync, bindingId: string): void {
  db.prepare(`DELETE FROM client_view_bindings WHERE id = ?`).run(bindingId)
}
