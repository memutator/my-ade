// resources/transfer.ts — claim.handoff (C-RESOURCE).
//
// IMP-16. Explicit ownership change only: the caller must prove the OLD
// writer is quiescent (quiescenceEvidence) AND pin the current claim revision
// (expectedRevision). A missing heartbeat or an expired TTL is NEVER enough —
// the live/unverified writer keeps its claim until an authorized decision is
// recorded (REQ-16, D-RESOURCE §4/§5). The transfer row and the owner-pointer
// swap commit atomically in the operation's transaction.

import type { TargetRef, TxnContext } from '../api/registry.ts'
import type { ResourceClaim, ResourceTransfer } from '../../../mahas-contracts/src/resource.ts'
import type { Id } from '../../../mahas-contracts/src/common.ts'
import { fail, getCheckoutByResource } from './checkout.ts'
import {
  encodeOwner,
  getClaim,
  insertTransfer,
  sameOwner,
  toClaim,
  toTransfer,
  updateClaim,
  type ClaimOwner
} from './claims.ts'
import { inTx } from './workspace.ts'
import type { ResolvedResourceDeps } from './mod.ts'

// ---------------------------------------------------------------------------
// payload / result (C-RESOURCE §claim.handoff)
// ---------------------------------------------------------------------------

export interface HandoffOwner {
  ownerKind: string
  ownerId: string
  /** owner incarnation; compared when provided */
  generation?: number
}

/**
 * Evidence that the old writer stopped writing. `kind` is caller-declared and
 * recorded verbatim — this boundary cannot re-verify domain evidence (that is
 * IMP-22 worker.release / host.process.probe's job), but it CAN refuse the
 * kinds that are never sufficient on their own.
 */
export interface QuiescenceEvidence {
  kind: string
  [key: string]: unknown
}

export interface ClaimHandoffPayload {
  claimId: Id
  expectedRevision: number
  fromOwner: HandoffOwner
  toOwner: HandoffOwner
  quiescenceEvidence: QuiescenceEvidence
}

export interface ClaimHandoffResult {
  transfer: ResourceTransfer
  claim: ResourceClaim
}

/**
 * Evidence kinds that never justify a handoff by themselves — REQ-16's
 * "TTL이나 heartbeat 누락만으로 인계하지 않는다". Everything else is recorded
 * opaquely for review.
 */
const INSUFFICIENT_QUIESCENCE_KINDS = new Set([
  'ttl-expired',
  'heartbeat-timeout',
  'lease-expired',
  'silence',
  'unknown'
])

function parseOwner(v: unknown, name: string): ClaimOwner & { generationProvided: boolean } {
  const o = v as Partial<HandoffOwner> | undefined
  if (
    !o ||
    typeof o.ownerKind !== 'string' ||
    !o.ownerKind ||
    typeof o.ownerId !== 'string' ||
    !o.ownerId
  ) {
    fail('INPUT_NOT_READY', `${name} requires {ownerKind, ownerId}`, 'none', { field: name })
  }
  const generationProvided = typeof o.generation === 'number' && o.generation > 0
  return {
    ownerKind: o.ownerKind,
    ownerId: o.ownerId,
    generation: generationProvided ? o.generation! : 1,
    generationProvided
  }
}

/** admission target resolution: the claim + the actual resource it covers */
export function claimHandoffTargets(txn: TxnContext, payload: unknown): TargetRef[] {
  const p = payload as Partial<ClaimHandoffPayload>
  if (typeof p?.claimId !== 'string' || !p.claimId) return []
  const targets: TargetRef[] = [{ kind: 'claim', id: p.claimId }]
  const claim = getClaim(txn.db, p.claimId)
  if (claim) targets.push({ kind: 'resource', id: claim.resource_id })
  return targets
}

export function claimHandoffHandler(
  txn: TxnContext,
  payload: unknown,
  deps: ResolvedResourceDeps
): ClaimHandoffResult {
  const p = payload as Partial<ClaimHandoffPayload>
  if (typeof p?.claimId !== 'string' || !p.claimId) {
    fail('INPUT_NOT_READY', 'payload.claimId required', 'none', { field: 'claimId' })
  }
  const claimId = p.claimId
  const expectedRevision = p.expectedRevision
  if (typeof expectedRevision !== 'number' || expectedRevision <= 0) {
    fail('INPUT_NOT_READY', 'payload.expectedRevision must be a positive integer', 'none', {
      field: 'expectedRevision'
    })
  }
  const from = parseOwner(p.fromOwner, 'fromOwner')
  const to = parseOwner(p.toOwner, 'toOwner')
  const evidence = p.quiescenceEvidence
  if (
    !evidence ||
    typeof evidence !== 'object' ||
    typeof evidence.kind !== 'string' ||
    !evidence.kind
  ) {
    fail(
      'INPUT_NOT_READY',
      'quiescenceEvidence {kind, ...} is required — a handoff needs explicit old-writer quiescence evidence',
      'none',
      { field: 'quiescenceEvidence' }
    )
  }
  if (INSUFFICIENT_QUIESCENCE_KINDS.has(evidence.kind)) {
    fail(
      'REQUIRED_ACTION_DENIED',
      `quiescence evidence kind '${evidence.kind}' never justifies a handoff alone — no TTL/heartbeat-only takeover`,
      'replan',
      { evidenceKind: evidence.kind }
    )
  }
  if (from.ownerKind === to.ownerKind && from.ownerId === to.ownerId) {
    fail('INVALID_TRANSITION', 'handoff to the current owner is not a transfer', 'none', {
      claimId
    })
  }

  const db = txn.db
  return inTx(db, () => {
    const claim = getClaim(db, claimId)
    if (!claim) fail('INPUT_NOT_READY', 'claim not found', 'none', { claimId })

    if (claim.state === 'released') {
      fail('INVALID_TRANSITION', 'cannot hand off a released claim', 'none', { claimId })
    }
    if (claim.state === 'transferring') {
      fail('RESOURCE_BUSY', 'claim already has an in-flight transfer', 'same-operation', {
        claimId
      })
    }
    if (claim.state === 'unknown') {
      // ownership is unverified — there is no confirmed old writer to
      // quiesce, so there is nothing to transfer FROM yet
      fail(
        'PROCESS_UNVERIFIABLE',
        'claim ownership is unverified; reconcile before handoff',
        'reconcile',
        { claimId }
      )
    }
    if (claim.revision !== expectedRevision) {
      fail('STALE_REVISION', 'claim revision mismatch', 'same-operation', {
        claimId,
        expectedRevision,
        actualRevision: claim.revision
      })
    }
    if (!sameOwner(claim, from, from.generationProvided)) {
      fail('INVALID_TRANSITION', 'fromOwner does not match the current claim owner', 'none', {
        claimId,
        currentOwner: {
          kind: claim.owner_kind,
          id: claim.owner_id,
          generation: claim.generation
        }
      })
    }

    // atomic: transfer record + owner pointer swap (C-RESOURCE §handoff)
    const transfer = insertTransfer(db, {
      claimId,
      expectedRevision,
      fromOwner: encodeOwner(from),
      toOwner: encodeOwner(to),
      state: 'confirmed',
      evidence: {
        quiescence: evidence,
        generationChecked: from.generationProvided,
        at: deps.now()
      }
    })
    const updated = updateClaim(
      db,
      claimId,
      {
        owner: {
          ownerKind: to.ownerKind,
          ownerId: to.ownerId,
          // keep the recorded generation when the caller did not pin a new
          // owner incarnation — inventing one would be fake evidence
          generation: to.generationProvided ? to.generation : claim.generation
        },
        state: 'held'
      },
      expectedRevision
    )
    txn.emitEvent({
      aggregateId: claimId,
      aggregateRevision: updated.revision,
      eventType: 'claim.ownership-transferred',
      scope: { resourceId: claim.resource_id },
      payload: {
        transferId: transfer.id,
        fromOwner: encodeOwner(from),
        toOwner: encodeOwner(to),
        expectedRevision
      }
    })
    return { transfer: toTransfer(transfer), claim: toClaim(updated) }
  })
}

// re-exported for release.ts's target resolver — same claim→resource mapping
export function claimResourceTargets(txn: TxnContext, claimId: string): TargetRef[] {
  const targets: TargetRef[] = [{ kind: 'claim', id: claimId }]
  const claim = getClaim(txn.db, claimId)
  if (claim) {
    targets.push({ kind: 'resource', id: claim.resource_id })
    const checkout = getCheckoutByResource(txn.db, claim.resource_id)
    if (checkout) targets.push({ kind: 'checkout', id: checkout.id })
  }
  return targets
}
