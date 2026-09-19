// resources/release.ts — claim.release (C-RESOURCE).
//
// IMP-16. Releasing a claim is a control-plane ownership decision; physical
// cleanup is a SEPARATE declared host effect that needs explicit dirty
// handling and retention-pin checks first. Live or unverifiable owner
// executions block release unless the caller explicitly accepts the risk
// ('abandon' — recorded as risk acceptance, never as a clean exit, and never
// auto-attaching the next writer). Failed/unknown cleanup preserves the real
// leftover path as a residual in the committed event + result — it is not
// erased from the record (REQ-13/16, D-RESOURCE §4).

import type { TargetRef, TxnContext } from '../api/registry.ts'
import type { ResourceClaim } from '../../../mahas-contracts/src/resource.ts'
import type { Id } from '../../../mahas-contracts/src/common.ts'
import { fail, getCheckoutByResource, getResource, getWorkspaceByCheckout } from './checkout.ts'
import {
  getClaim,
  ownerLiveness,
  pinsForTargets,
  toClaim,
  updateClaim,
  type ClaimOwner
} from './claims.ts'
import { claimResourceTargets } from './transfer.ts'
import { inTx, type EffectSummary, type HostProbeResult } from './workspace.ts'
import type { ResolvedResourceDeps } from './mod.ts'

// ---------------------------------------------------------------------------
// payload / result (C-RESOURCE §claim.release)
// ---------------------------------------------------------------------------

/**
 * disposition decides what happens to the PHYSICAL resource after the claim
 * is released:
 *   'release'  → also run host.workspace.release cleanup (needs dirtyDecision
 *                when the checkout is dirty)
 *   'retain'   → release the claim, keep the checkout on disk
 *   'abandon'  → release the claim despite live/unverifiable evidence — the
 *                operator's explicit risk acceptance, recorded as such
 */
export type ReleaseDisposition = 'release' | 'retain' | 'abandon'
export type DirtyDecision = 'discard' | 'keep' | 'archive'

export interface ClaimReleasePayload {
  claimId: Id
  expectedRevision: number
  disposition: ReleaseDisposition
  dirtyDecision?: DirtyDecision
  /** caller-supplied justification — recorded in the release event */
  reason?: string
}

export interface ClaimReleaseResult {
  claim: ResourceClaim
  /** 'released' | 'retained' | 'unknown' per C-RESOURCE */
  result: 'released' | 'retained' | 'unknown'
  effect?: EffectSummary
  residuals?: unknown[]
  /** machine-readable checks that drove the decision — evidence, not hidden */
  checks: {
    liveness: string
    retentionPins: number
    workspaceState?: string
  }
}

interface HostReleaseResult {
  effectKey: string
  state: 'confirmed' | 'rejected' | 'unknown'
  receipt?: unknown
  residuals?: unknown[]
  reason?: { code: string; message: string }
}

/** admission target resolution: the claim + its resource + checkout */
export function claimReleaseTargets(txn: TxnContext, payload: unknown): TargetRef[] {
  const p = payload as Partial<ClaimReleasePayload>
  if (typeof p?.claimId !== 'string' || !p.claimId) return []
  return claimResourceTargets(txn, p.claimId)
}

export async function claimReleaseHandler(
  txn: TxnContext,
  payload: unknown,
  deps: ResolvedResourceDeps
): Promise<ClaimReleaseResult> {
  const p = payload as Partial<ClaimReleasePayload>
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
  const disposition = p.disposition
  if (disposition !== 'release' && disposition !== 'retain' && disposition !== 'abandon') {
    fail('INPUT_NOT_READY', 'disposition must be release|retain|abandon', 'none', {
      field: 'disposition'
    })
  }
  const dirtyDecision = p.dirtyDecision
  if (
    dirtyDecision !== undefined &&
    dirtyDecision !== 'discard' &&
    dirtyDecision !== 'keep' &&
    dirtyDecision !== 'archive'
  ) {
    fail('INPUT_NOT_READY', 'dirtyDecision must be discard|keep|archive', 'none', {
      field: 'dirtyDecision'
    })
  }

  const db = txn.db

  // ---- verify + commit the control-plane release decision ----------------
  const committed = inTx(db, () => {
    const claim = getClaim(db, claimId)
    if (!claim) fail('INPUT_NOT_READY', 'claim not found', 'none', { claimId })

    if (claim.state === 'released') {
      // benign re-release of an already-decided claim — no new effect
      return { claim, alreadyReleased: true as const }
    }
    if (claim.state === 'transferring') {
      fail(
        'RESOURCE_BUSY',
        'claim has an in-flight transfer; resolve it before release',
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

    const owner: ClaimOwner = {
      ownerKind: claim.owner_kind,
      ownerId: claim.owner_id,
      generation: claim.generation
    }

    // live/unknown execution check — executions.liveness is authoritative;
    // 'unverifiable' blocks just like 'live' (an unverified writer is still a
    // writer). Only an explicit 'abandon' disposition overrides, recorded as
    // risk acceptance in the emitted event.
    const liveness = ownerLiveness(db, owner)
    if ((liveness === 'live' || liveness === 'unverifiable') && disposition !== 'abandon') {
      fail(
        'RESOURCE_BUSY',
        `claim owner is ${liveness}; release requires an explicit abandon`,
        'none',
        { claimId, owner: { kind: owner.ownerKind, id: owner.ownerId }, liveness }
      )
    }

    // retention pins — a pinned checkout cannot be physically released
    const resource = getResource(db, claim.resource_id)
    const checkout = resource ? getCheckoutByResource(db, resource.id) : null
    const workspace = checkout ? getWorkspaceByCheckout(db, checkout.id) : null
    const pinTargets = [claim.resource_id, checkout?.id, workspace?.id].filter(
      (x): x is string => typeof x === 'string'
    )
    const pins = pinsForTargets(db, pinTargets)
    if (disposition === 'release' && pins.length > 0) {
      fail('RESOURCE_BUSY', 'checkout is retained by retention pins', 'none', {
        claimId,
        pins: pins.map((pin) => ({
          id: pin.id,
          holder: `${pin.holder_kind}:${pin.holder_id}`,
          reason: pin.reason
        }))
      })
    }

    const updated = updateClaim(db, claimId, { state: 'released' }, expectedRevision)
    const nextWorkspaceState =
      disposition === 'retain' ? 'retained' : disposition === 'abandon' ? 'abandoned' : 'releasing'
    if (workspace) {
      db.prepare('UPDATE workspaces SET state=? WHERE id=?').run(nextWorkspaceState, workspace.id)
    }

    // declare the cleanup effect — only 'release' on a checkout resource has
    // physical work; the intent id doubles as the host effectKey
    let effectId: string | undefined
    let hostPayload: Record<string, unknown> | undefined
    if (disposition === 'release' && checkout) {
      hostPayload = {
        canonicalPath: checkout.canonical_path,
        expectedFilesystemIdentity: checkout.filesystem_identity,
        expectedWorktreeIdentity: (
          JSON.parse(checkout.repository_json) as { worktreeIdentity?: string }
        ).worktreeIdentity,
        expectedClaimRevision: updated.revision,
        dirtyDisposition: dirtyDecision ?? 'keep',
        claimToken: claimId
      }
      effectId = txn.intendEffect({
        kind: 'host.workspace.release',
        hostId: checkout.host_id,
        payload: hostPayload
      })
    }

    txn.emitEvent({
      aggregateId: claimId,
      aggregateRevision: updated.revision,
      eventType: disposition === 'abandon' ? 'claim.abandoned-risk-accepted' : 'claim.released',
      scope: { resourceId: claim.resource_id },
      payload: {
        claimId,
        disposition,
        dirtyDecision: dirtyDecision ?? null,
        reason: p.reason ?? null,
        liveness,
        pins: pins.length,
        effectId: effectId ?? null
      }
    })
    return {
      claim: updated,
      alreadyReleased: false as const,
      effectId,
      hostPayload,
      checkout,
      workspace,
      liveness,
      pinCount: pins.length
    }
  })

  if (committed.alreadyReleased) {
    return {
      claim: toClaim(committed.claim),
      result: 'released',
      checks: { liveness: 'not-checked', retentionPins: 0 }
    }
  }

  // ---- host cleanup effect — only 'release' on a checkout resource -------
  if (
    disposition !== 'release' ||
    !committed.checkout ||
    !committed.effectId ||
    !committed.hostPayload
  ) {
    return {
      claim: toClaim(committed.claim),
      result: disposition === 'retain' ? 'retained' : 'released',
      checks: {
        liveness: committed.liveness ?? 'not-applicable',
        retentionPins: committed.pinCount ?? 0,
        workspaceState: committed.workspace
          ? disposition === 'retain'
            ? 'retained'
            : 'abandoned'
          : undefined
      }
    }
  }

  const checkout = committed.checkout
  const workspace = committed.workspace
  const effectId = committed.effectId

  // live dirtiness probe first — the release contract checks dirty state
  // before destructive cleanup; an unverifiable probe means the cleanup
  // decision itself is unverifiable → STOP_UNKNOWN path, not blind delete
  let probe: HostProbeResult | null = null
  let hostResult: HostReleaseResult | null = null
  let hostError: unknown = null
  try {
    const client = await deps.hostClient(checkout.host_id as Id)
    try {
      probe = await client.call<HostProbeResult>('host.workspace.probe', {
        canonicalPath: checkout.canonical_path,
        expectedFilesystemIdentity: checkout.filesystem_identity
      })
    } catch {
      probe = { state: 'unverifiable' }
    }
    if (probe && probe.dirty === 'dirty' && !dirtyDecision) {
      // dirty with no declared decision — refuse BEFORE any destructive call
      hostResult = {
        effectKey: effectId,
        state: 'rejected',
        reason: {
          code: 'RESOURCE_BUSY',
          message: 'checkout is dirty; explicit dirtyDecision required'
        }
      }
    } else {
      hostResult = await client.call<HostReleaseResult>(
        'host.workspace.release',
        committed.hostPayload,
        { effectKey: effectId }
      )
    }
  } catch (e) {
    hostError = e
  }

  // ---- finalize: workspace state + event; residuals stay on record -------
  return inTx(db, () => {
    const residuals: unknown[] = [...(hostResult?.residuals ?? [])]
    let effectState: string
    let receipt: unknown
    let resultState: 'released' | 'retained' | 'unknown'
    let workspaceState: string

    if (hostResult?.state === 'confirmed') {
      effectState = 'confirmed'
      receipt = { state: 'confirmed', hostReceipt: hostResult.receipt, probe }
      resultState = 'released'
      workspaceState = 'released'
    } else if (hostResult?.state === 'rejected') {
      effectState = 'rejected'
      receipt = {
        state: 'rejected',
        reason: hostResult.reason,
        hostReceipt: hostResult.receipt,
        probe
      }
      // a clean reject = positively not removed → the resource is retained
      resultState = 'retained'
      workspaceState = 'retained'
    } else {
      // failed/unknown cleanup: preserve the real leftover path as residual
      effectState = 'unknown'
      receipt = {
        state: 'unknown',
        reason: hostError
          ? {
              code: 'CONTROL_UNAVAILABLE',
              message: String((hostError as Error).message ?? hostError)
            }
          : (hostResult?.reason ?? { code: 'STOP_UNKNOWN', message: 'host returned no verdict' }),
        hostReceipt: hostResult?.receipt,
        probe
      }
      resultState = 'unknown'
      workspaceState = 'release-unknown'
      residuals.push({
        resourceRef: checkout.id,
        reason: 'cleanup-outcome-unverified',
        liveEvidence: { canonicalPath: checkout.canonical_path, probe },
        cleanupPolicy: 'preserve-until-reconciled'
      })
    }

    if (workspace) {
      db.prepare('UPDATE workspaces SET state=? WHERE id=?').run(workspaceState, workspace.id)
    }
    txn.emitEvent({
      aggregateId: claimId,
      aggregateRevision: committed.claim.revision,
      eventType: `claim.release-cleanup.${effectState}`,
      scope: { resourceId: committed.claim.resource_id },
      payload: { effectId, effectState, resultState, residuals }
    })
    return {
      claim: toClaim(committed.claim),
      result: resultState,
      effect: {
        intentId: effectId,
        kind: 'host.workspace.release',
        state: effectState,
        receipt,
        residuals
      },
      residuals,
      checks: {
        liveness: committed.liveness ?? 'not-applicable',
        retentionPins: committed.pinCount ?? 0,
        workspaceState
      }
    }
  })
}
