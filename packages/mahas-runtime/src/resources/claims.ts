// resources/claims.ts — ResourceClaim rows + the one-writer-per-resource rule.
//
// IMP-16 (C-RESOURCE claim.*; DDL spec/storage.md §3 resource_claims /
// resource_transfers / retention_pins).
//
// Exclusivity is enforced two ways, deliberately redundant:
//   1. the partial unique index one_writer_per_resource
//      (resource_id WHERE mode='write' AND state IN
//      ('held','transferring','unknown')) — the DB-level last word;
//   2. explicit scans here so rejections carry evidence (which claim, which
//      owner) instead of a bare constraint error.
// Claims are never TTL-revoked: a 'held' or 'unknown' writer blocks new
// writers until an explicit claim.handoff / claim.release records the
// ownership decision (REQ-16).

import type { DatabaseSync } from 'node:sqlite'
import type {
  ResourceClaim,
  ResourceTransfer,
  RetentionPin
} from '../../../mahas-contracts/src/resource.ts'
import type { ExecutionGeneration, Id, Revision } from '../../../mahas-contracts/src/common.ts'
import { fail, mintId } from './checkout.ts'

// ---------------------------------------------------------------------------
// owner identity — the polymorphic owner column (C-RESOURCE resolver verifies
// kind-specific existence; the DDL stores owner_kind + owner_id plainly)
// ---------------------------------------------------------------------------

export interface ClaimOwner {
  ownerKind: string
  ownerId: string
  generation: number
}

/** serialized form stored in resource_transfers.from_owner / to_owner (TEXT) */
export function encodeOwner(o: { ownerKind: string; ownerId: string }): string {
  return JSON.stringify({ kind: o.ownerKind, id: o.ownerId })
}

export function sameOwner(
  claim: { owner_kind: string; owner_id: string; generation: number },
  owner: ClaimOwner,
  checkGeneration: boolean
): boolean {
  if (claim.owner_kind !== owner.ownerKind || claim.owner_id !== owner.ownerId) return false
  return !checkGeneration || claim.generation === owner.generation
}

// ---------------------------------------------------------------------------
// rows ↔ objects
// ---------------------------------------------------------------------------

export interface ClaimRow {
  id: string
  resource_id: string
  owner_kind: string
  owner_id: string
  mode: string
  generation: number
  state: string
  revision: number
}

export interface TransferRow {
  id: string
  claim_id: string
  expected_revision: number
  from_owner: string
  to_owner: string
  state: string
  evidence_json: string
}

export interface PinRow {
  id: string
  target_kind: string
  target_id: string
  holder_kind: string
  holder_id: string
  reason: string
}

const CLAIM_COLS = 'id, resource_id, owner_kind, owner_id, mode, generation, state, revision'

export function toClaim(row: ClaimRow): ResourceClaim {
  return {
    id: row.id as Id,
    resourceId: row.resource_id as Id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    mode: row.mode,
    generation: row.generation as ExecutionGeneration,
    state: row.state,
    revision: row.revision as Revision
  } as unknown as ResourceClaim
}

export function toTransfer(row: TransferRow): ResourceTransfer {
  return {
    id: row.id as Id,
    claimId: row.claim_id as Id,
    expectedRevision: row.expected_revision as Revision,
    fromOwner: row.from_owner,
    toOwner: row.to_owner,
    state: row.state,
    evidence: JSON.parse(row.evidence_json)
  } as unknown as ResourceTransfer
}

export function toPin(row: PinRow): RetentionPin {
  return {
    id: row.id as Id,
    targetKind: row.target_kind,
    targetId: row.target_id as Id,
    holderKind: row.holder_kind,
    holderId: row.holder_id as Id,
    reason: row.reason
  } as unknown as RetentionPin
}

// ---------------------------------------------------------------------------
// claim reads
// ---------------------------------------------------------------------------

export function getClaim(db: DatabaseSync, id: string): ClaimRow | null {
  const row = db.prepare(`SELECT ${CLAIM_COLS} FROM resource_claims WHERE id=?`).get(id) as
    ClaimRow | undefined
  return row ?? null
}

/**
 * THE exclusivity question: does this actual resource currently have a
 * write-mode claim in a blocking state? Mirrors the partial unique index
 * predicate exactly — 'held', 'transferring' AND 'unknown' all block, because
 * an unverified writer is still a writer (REQ-16: no TTL revocation).
 */
export function activeWriteClaim(db: DatabaseSync, resourceId: string): ClaimRow | null {
  const row = db
    .prepare(
      `SELECT ${CLAIM_COLS} FROM resource_claims WHERE resource_id=? AND mode='write' AND state IN ('held','transferring','unknown')`
    )
    .get(resourceId) as ClaimRow | undefined
  return row ?? null
}

export function claimsForResource(db: DatabaseSync, resourceId: string): ClaimRow[] {
  return db
    .prepare(`SELECT ${CLAIM_COLS} FROM resource_claims WHERE resource_id=? ORDER BY revision DESC`)
    .all(resourceId) as unknown as ClaimRow[]
}

// ---------------------------------------------------------------------------
// claim writes
// ---------------------------------------------------------------------------

export function insertClaim(
  db: DatabaseSync,
  args: {
    id?: string
    resourceId: string
    owner: ClaimOwner
    mode: 'read' | 'write'
    state?: 'held' | 'transferring' | 'released' | 'unknown'
  }
): ClaimRow {
  const row: ClaimRow = {
    id: args.id ?? mintId('claim'),
    resource_id: args.resourceId,
    owner_kind: args.owner.ownerKind,
    owner_id: args.owner.ownerId,
    mode: args.mode,
    generation: args.owner.generation,
    state: args.state ?? 'held',
    revision: 1
  }
  try {
    db.prepare(
      `INSERT INTO resource_claims (id, resource_id, owner_kind, owner_id, mode, generation, state, revision)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      row.id,
      row.resource_id,
      row.owner_kind,
      row.owner_id,
      row.mode,
      row.generation,
      row.state,
      row.revision
    )
  } catch (e) {
    // the partial unique index is the final arbiter of one-writer-per-resource
    if (String((e as Error).message).includes('one_writer_per_resource')) {
      const holder = activeWriteClaim(db, args.resourceId)
      fail('RESOURCE_BUSY', 'resource already has a live or unverified write claim', 'none', {
        blockingClaimId: holder?.id,
        blockingOwner: holder ? { kind: holder.owner_kind, id: holder.owner_id } : undefined
      })
    }
    throw e
  }
  return row
}

/** revision-checked mutation — caller already verified expectedRevision */
export function updateClaim(
  db: DatabaseSync,
  id: string,
  patch: { owner?: ClaimOwner; state?: string },
  expectedRevision: number
): ClaimRow {
  const current = getClaim(db, id)
  if (!current) fail('INPUT_NOT_READY', `claim ${id} not found`, 'none', { claimId: id })
  if (current.revision !== expectedRevision) {
    fail('STALE_REVISION', 'claim revision mismatch', 'same-operation', {
      claimId: id,
      expectedRevision,
      actualRevision: current.revision
    })
  }
  const next: ClaimRow = {
    ...current,
    owner_kind: patch.owner?.ownerKind ?? current.owner_kind,
    owner_id: patch.owner?.ownerId ?? current.owner_id,
    generation: patch.owner?.generation ?? current.generation,
    state: patch.state ?? current.state,
    revision: current.revision + 1
  }
  db.prepare(
    `UPDATE resource_claims SET owner_kind=?, owner_id=?, generation=?, state=?, revision=? WHERE id=? AND revision=?`
  ).run(
    next.owner_kind,
    next.owner_id,
    next.generation,
    next.state,
    next.revision,
    id,
    expectedRevision
  )
  return next
}

export function insertTransfer(
  db: DatabaseSync,
  args: {
    claimId: string
    expectedRevision: number
    fromOwner: string
    toOwner: string
    state: string
    evidence: unknown
  }
): TransferRow {
  const row: TransferRow = {
    id: mintId('transfer'),
    claim_id: args.claimId,
    expected_revision: args.expectedRevision,
    from_owner: args.fromOwner,
    to_owner: args.toOwner,
    state: args.state,
    evidence_json: JSON.stringify(args.evidence ?? {})
  }
  db.prepare(
    `INSERT INTO resource_transfers (id, claim_id, expected_revision, from_owner, to_owner, state, evidence_json)
     VALUES (?,?,?,?,?,?,?)`
  ).run(
    row.id,
    row.claim_id,
    row.expected_revision,
    row.from_owner,
    row.to_owner,
    row.state,
    row.evidence_json
  )
  return row
}

// ---------------------------------------------------------------------------
// retention pins — GC/retain evidence; pins on the resource, its checkout row
// or the workspace all retain the physical checkout (D-RESOURCE §1)
// ---------------------------------------------------------------------------

export function pinsForTargets(db: DatabaseSync, targetIds: string[]): PinRow[] {
  if (targetIds.length === 0) return []
  const marks = targetIds.map(() => '?').join(',')
  return db
    .prepare(
      `SELECT id, target_kind, target_id, holder_kind, holder_id, reason FROM retention_pins WHERE target_id IN (${marks})`
    )
    .all(...targetIds) as unknown as PinRow[]
}

// ---------------------------------------------------------------------------
// live/unknown-execution evidence for release — reads the control mirror only.
// liveness is the authoritative column (executions.liveness IN
// 'live'|'unverifiable'|'exited'); a MISSING row is unverifiable, not exited.
// ---------------------------------------------------------------------------

export type OwnerLiveness = 'live' | 'unverifiable' | 'exited' | 'not-applicable'

export function ownerLiveness(db: DatabaseSync, owner: ClaimOwner): OwnerLiveness {
  if (owner.ownerKind === 'execution') {
    const row = db.prepare('SELECT liveness FROM executions WHERE id=?').get(owner.ownerId) as
      { liveness: string } | undefined
    if (!row) return 'unverifiable'
    return row.liveness === 'live' || row.liveness === 'exited'
      ? (row.liveness as OwnerLiveness)
      : 'unverifiable'
  }
  if (owner.ownerKind === 'dispatch') {
    const row = db
      .prepare(
        'SELECT e.liveness AS liveness FROM dispatches d JOIN executions e ON e.id=d.execution_id WHERE d.id=?'
      )
      .get(owner.ownerId) as { liveness: string } | undefined
    if (!row) return 'unverifiable'
    return row.liveness === 'live' || row.liveness === 'exited'
      ? (row.liveness as OwnerLiveness)
      : 'unverifiable'
  }
  // member/operation/etc owners have no process incarnation to probe — the
  // caller's evidence carries the quiescence argument instead
  return 'not-applicable'
}
