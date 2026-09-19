// mahas-runtime/artifacts — retention_pins helpers (spec/storage.md §3).
//
// RetentionPin is a typed resolver row: WHO holds a retention claim on WHAT
// and why. artifact.publish records a retention intent in the same
// transaction as the artifact metadata — for git-commit artifacts the pin
// is what keeps the underlying git object honest to retain; for
// content-blob artifacts the blob itself is already content-addressed and
// the pin documents the artifact's claim on it.
//
// GC/reclaim policy is NOT this boundary's job — these are the primitives.

import type { DatabaseSync } from 'node:sqlite'

export interface RetentionPinInput {
  targetKind: string
  targetId: string
  holderKind: string
  holderId: string
  reason: string
}

export interface RetentionPinRow extends RetentionPinInput {
  id: string
  target_kind: string
  target_id: string
  holder_kind: string
  holder_id: string
}

/** insert a retention pin; returns the pin id (caller supplies id via newId) */
export function addRetentionPin(db: DatabaseSync, id: string, pin: RetentionPinInput): string {
  db.prepare(
    `INSERT INTO retention_pins (id, target_kind, target_id, holder_kind, holder_id, reason)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, pin.targetKind, pin.targetId, pin.holderKind, pin.holderId, pin.reason)
  return id
}

/** all pins a holder currently has (e.g. one artifact revision) */
export function pinsForHolder(
  db: DatabaseSync,
  holderKind: string,
  holderId: string
): RetentionPinInput[] {
  const rows = db
    .prepare('SELECT * FROM retention_pins WHERE holder_kind = ? AND holder_id = ?')
    .all(holderKind, holderId) as unknown as RetentionPinRow[]
  return rows.map((r) => ({
    targetKind: r.target_kind,
    targetId: r.target_id,
    holderKind: r.holder_kind,
    holderId: r.holder_id,
    reason: r.reason
  }))
}

/** all holders pinning a target — the resolver view a reclaimer would consult */
export function pinsForTarget(
  db: DatabaseSync,
  targetKind: string,
  targetId: string
): RetentionPinInput[] {
  const rows = db
    .prepare('SELECT * FROM retention_pins WHERE target_kind = ? AND target_id = ?')
    .all(targetKind, targetId) as unknown as RetentionPinRow[]
  return rows.map((r) => ({
    targetKind: r.target_kind,
    targetId: r.target_id,
    holderKind: r.holder_kind,
    holderId: r.holder_id,
    reason: r.reason
  }))
}

/** explicit release — a named operation, never an implicit TTL drop (REQ-16 spirit) */
export function releaseRetentionPins(
  db: DatabaseSync,
  holderKind: string,
  holderId: string
): number {
  const r = db
    .prepare('DELETE FROM retention_pins WHERE holder_kind = ? AND holder_id = ?')
    .run(holderKind, holderId)
  return Number(r.changes)
}
