// revocation.ts — grant revocation + invalidation events
// (spec/domains/access.md §4, spec/common.md §3, C-ACCESS `access.revoke`).
//
// Revocation applies immediately at the server: the row is marked, its
// revision advances, descendants issued under it lose their basis, and a
// revoke event plus a surface/credential invalidation event go out in the
// same transaction. In-flight effects are REPORTED, never rewritten — a
// spawn that may already have started is not retroactively marked
// never-started; stopping executions is C-RECOVERY's contract, not this
// module's.

import type { DatabaseSync } from 'node:sqlite'
import { appendDomainEvent } from '../storage/db.ts'
import { ensureTx, fail } from './internal.ts'
import { getGrantRecord, type GrantRecord } from './grant.ts'

export interface RevocationResult {
  grantId: string
  /** the grant's revision after the revoke bump */
  revocationRevision: number
  /** root + descendants marked revoked in this transaction */
  revokedGrantIds: string[]
  /** executions whose members lose authority (live or unverifiable) */
  affectedExecutions: string[]
  /** effect intents still in flight that touched the revoked scope */
  inFlightEffects: string[]
}

/**
 * Revoke a grant and every standing descendant (a child's authority derives
 * from its parent chain, so it cannot outlive it). expectedRevision, when
 * given, is compared inside the same transaction — STALE_REVISION on drift.
 */
export function revokeGrantTree(
  db: DatabaseSync,
  grantId: string,
  at: number,
  options?: { expectedRevision?: number; reason?: string }
): RevocationResult {
  return ensureTx(db, (tx) => {
    const root = getGrantRecord(tx, grantId)
    if (!root) fail('INPUT_NOT_READY', `grant '${grantId}' does not exist`)
    if (options?.expectedRevision != null && root.revision !== options.expectedRevision) {
      fail(
        'STALE_REVISION',
        `grant '${grantId}' is at revision ${root.revision}, expected ${options.expectedRevision}`
      )
    }
    const subtree = collectSubtree(tx, grantId)
    const toRevoke = subtree.filter((g) => g.revokedAt == null)
    for (const g of toRevoke) {
      const nextRevision = g.revision + 1
      tx.prepare(
        'UPDATE grants SET revoked_at = ?, revision = ? WHERE id = ? AND revoked_at IS NULL'
      ).run(at, nextRevision, g.id)
      appendDomainEvent(
        tx,
        g.id,
        nextRevision,
        'access.grant.revoked',
        { domain: 'access', principalId: g.principalId, kind: g.kind },
        { reason: options?.reason ?? null, cascadeRoot: grantId }
      )
      appendDomainEvent(
        tx,
        g.principalId,
        0,
        'access.invalidated',
        { domain: 'access', principalId: g.principalId },
        { reason: 'grant-revoked', grantId: g.id }
      )
    }
    const affectedExecutions = affectedExecutionsFor(tx, toRevoke)
    const inFlightEffects = inFlightEffectsFor(tx, toRevoke, affectedExecutions)
    return {
      grantId,
      revocationRevision: root.revision + 1,
      revokedGrantIds: toRevoke.map((g) => g.id),
      affectedExecutions,
      inFlightEffects
    }
  })
}

/** SHARED-APIS signature — mechanics identical to revokeGrantTree. */
export function revokeGrant(db: DatabaseSync, grantId: string, at: number): void {
  revokeGrantTree(db, grantId, at)
}

/** Root + all descendants via parent_grant_id, cycle-guarded. */
function collectSubtree(db: DatabaseSync, rootId: string): GrantRecord[] {
  const seen = new Set<string>()
  const out: GrantRecord[] = []
  const queue: string[] = [rootId]
  const children = db.prepare('SELECT id FROM grants WHERE parent_grant_id = ?')
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    const grant = getGrantRecord(db, id)
    if (!grant) continue
    out.push(grant)
    for (const kid of children.all(id) as { id: string }[]) queue.push(kid.id)
  }
  return out
}

/**
 * Members touched by the revoked grants → their still-running executions.
 * scope.memberId / continuation.memberId plus the grant's own principal id
 * (member principals are conventionally keyed by member id — a deliberate
 * superset, marked in evidence).
 */
function affectedExecutionsFor(db: DatabaseSync, grants: GrantRecord[]): string[] {
  const memberIds = new Set<string>()
  for (const g of grants) {
    if (g.scope.memberId) memberIds.add(g.scope.memberId)
    if (g.scope.continuation?.memberId) memberIds.add(g.scope.continuation.memberId)
    memberIds.add(g.principalId)
  }
  if (memberIds.size === 0) return []
  const marks = [...memberIds].map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT id FROM executions WHERE member_id IN (${marks}) AND liveness IN ('live','unverifiable')`
    )
    .all(...[...memberIds]) as { id: string }[]
  return rows.map((r) => r.id)
}

/**
 * In-flight effects referencing the revoked grants / affected executions /
 * members — read-only reporting. 'unknown' state effects are included: they
 * are reconcile candidates, NOT terminal failures, and must never be
 * reported as gone or never-started (common.md §5).
 */
function inFlightEffectsFor(
  db: DatabaseSync,
  grants: GrantRecord[],
  affectedExecutions: string[]
): string[] {
  const rows = db
    .prepare(
      "SELECT id, payload_json FROM effect_intents WHERE state IN ('prepared','attempting','unknown')"
    )
    .all() as { id: string; payload_json: string }[]
  const execSet = new Set(affectedExecutions)
  const grantSet = new Set(grants.map((g) => g.id))
  const memberSet = new Set<string>()
  for (const g of grants) {
    if (g.scope.memberId) memberSet.add(g.scope.memberId)
    if (g.scope.continuation?.memberId) memberSet.add(g.scope.continuation.memberId)
    memberSet.add(g.principalId)
  }
  const out: string[] = []
  for (const row of rows) {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>
    } catch {
      continue
    }
    const executionId = payload.executionId ?? payload.execution_id
    const memberId = payload.memberId ?? payload.member_id
    const grantId = payload.grantId ?? payload.grant_id
    if (
      (typeof executionId === 'string' && execSet.has(executionId)) ||
      (typeof memberId === 'string' && memberSet.has(memberId)) ||
      (typeof grantId === 'string' && grantSet.has(grantId))
    ) {
      out.push(row.id)
    }
  }
  return out
}
