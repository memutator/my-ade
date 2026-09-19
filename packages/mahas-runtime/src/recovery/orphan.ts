// recovery/orphan.ts — quarantine for processes/effects that match no
// execution, and explicit operator resolution of those orphans.
//
// Rules (C-RECOVERY restart algorithm step 4, D-EXEC §3, instruction §4.1):
//   · a host process whose spawnNonce/identity matches NO execution row is
//     an orphan — it is quarantined and left 'unknown', NEVER auto-adopted,
//     NEVER killed on pid evidence alone, NEVER re-placed.
//   · a process whose spawnNonce matches an execution but whose birth
//     identity conflicts is 'conflicting' — quarantined the same way, and
//     the execution it collides with degrades to unverifiable.
//   · resolution is an explicit operator decision recorded against the
//     orphan observation — this module never signals the process itself.

import type { ProcessIncarnation } from '../../../mahas-contracts/src/index.ts'
import { failure, type DatabaseSync, type ExecutionRow, type RecoveryDeps } from './ports.ts'
import { compareProcessIncarnation } from './identity-probe.ts'

export type OrphanReason =
  /** host reports a process no execution row claims */
  | 'unmatched-process'
  /** spawnNonce collides with an execution but birth identity differs */
  | 'conflicting-identity'
  /** host effect receipt exists for a key the control DB never recorded */
  | 'unmatched-effect-receipt'
  /** execution references a process the host no longer inventories */
  | 'unverifiable-execution'

export type OrphanState = 'quarantined' | 'resolved'

export interface OrphanRecord {
  observationId: string
  hostId: string
  identity: ProcessIncarnation
  reason: OrphanReason
  state: OrphanState
  /** executionId an orphan collides with, when the conflict names one */
  relatedExecutionId?: string
  detectedAt: number
  resolution?: { action: string; evidence?: unknown; at: number; by?: string }
}

interface OrphanPayload {
  hostId: string
  identity: ProcessIncarnation
  reason: OrphanReason
  state: OrphanState
  relatedExecutionId?: string
  detectedAt: number
  resolution?: { action: string; evidence?: unknown; at: number; by?: string }
}

function rowToOrphan(r: Record<string, unknown>): OrphanRecord | null {
  try {
    const payload = JSON.parse(r.payload_json as string) as OrphanPayload
    return {
      observationId: r.id as string,
      hostId: payload.hostId,
      identity: payload.identity,
      reason: payload.reason,
      state: payload.state,
      relatedExecutionId: payload.relatedExecutionId,
      detectedAt: payload.detectedAt,
      resolution: payload.resolution
    }
  } catch {
    return null
  }
}

function loadOrphanRow(
  db: DatabaseSync,
  observationId: string
): { payload: OrphanPayload; raw: Record<string, unknown> } | null {
  const r = db.prepare('SELECT * FROM observations WHERE id=?').get(observationId) as
    Record<string, unknown> | undefined
  if (!r) return null
  const payload = JSON.parse(r.payload_json as string) as OrphanPayload
  return { payload, raw: r }
}

function findExistingOrphan(
  db: DatabaseSync,
  hostId: string,
  identity: ProcessIncarnation
): OrphanRecord | null {
  const rows = db
    .prepare(
      `SELECT * FROM observations
       WHERE source='recovery' AND fact_type='recovery.orphan'
         AND json_extract(identity_evidence_json,'$.spawnNonce')=?`
    )
    .all(identity.spawnNonce ?? '') as Array<Record<string, unknown>>
  for (const r of rows) {
    const o = rowToOrphan(r)
    if (o && o.hostId === hostId && o.state === 'quarantined') return o
  }
  return null
}

/**
 * Record a quarantined orphan. Idempotent per (hostId, spawnNonce): a second
 * detection returns the existing record instead of stacking observations.
 * A retention pin is placed so no cleanup path can mistake quarantine for
 * releasable residue — the pin releases only via resolveOrphan.
 */
export function quarantineOrphan(
  deps: RecoveryDeps,
  db: DatabaseSync,
  hostId: string,
  identity: ProcessIncarnation,
  reason: OrphanReason,
  relatedExecutionId?: string
): OrphanRecord {
  const existing = findExistingOrphan(db, hostId, identity)
  if (existing) return existing

  const now = deps.now()
  const id = deps.newId()
  const payload: OrphanPayload = {
    hostId,
    identity,
    reason,
    state: 'quarantined',
    relatedExecutionId,
    detectedAt: now
  }
  db.prepare(
    `INSERT INTO observations (id, execution_id, dispatch_id, source, fact_type, observed_at, payload_json, identity_evidence_json)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    id,
    relatedExecutionId ?? null,
    null,
    'recovery',
    'recovery.orphan',
    now,
    JSON.stringify(payload),
    JSON.stringify(identity)
  )
  const pinId = `orphan:${hostId}:${identity.spawnNonce ?? id}`
  db.prepare(
    `INSERT OR IGNORE INTO retention_pins (id, target_kind, target_id, holder_kind, holder_id, reason)
     VALUES (?,?,?,?,?,?)`
  ).run(
    pinId,
    'process',
    identity.spawnNonce ?? id,
    'recovery',
    'recovery.orphan',
    `quarantined orphan (${reason}) — no automatic adoption, cleanup or kill`
  )
  deps.appendDomainEvent(
    db,
    hostId,
    0,
    'recovery.orphan-quarantined',
    { observationId: id },
    { identity, reason, relatedExecutionId: relatedExecutionId ?? null }
  )
  return {
    observationId: id,
    hostId,
    identity,
    reason,
    state: 'quarantined',
    relatedExecutionId,
    detectedAt: now
  }
}

export function listOrphans(
  db: DatabaseSync,
  opts?: { hostId?: string; includeResolved?: boolean }
): OrphanRecord[] {
  const rows = db
    .prepare(`SELECT * FROM observations WHERE source='recovery' AND fact_type='recovery.orphan'`)
    .all() as Array<Record<string, unknown>>
  const out: OrphanRecord[] = []
  for (const r of rows) {
    const o = rowToOrphan(r)
    if (!o) continue
    if (opts?.hostId && o.hostId !== opts.hostId) continue
    if (!opts?.includeResolved && o.state !== 'quarantined') continue
    out.push(o)
  }
  return out
}

export type OrphanResolutionAction =
  /** positive exit evidence presented — record it; NO signal is sent */
  | 'mark-exited'
  /** operator confirmed the orphan is foreign residue to be released by the resource path */
  | 'release-by-resource-op'
  /** keep the quarantine — examined and deliberately left unknown */
  | 'keep-quarantined'

/**
 * Explicit orphan resolution. This is the ONLY way a quarantined orphan
 * leaves quarantine, and it still never kills, adopts or respawns: the
 * action records an operator decision + evidence; physical cleanup flows
 * through the resource operations (claim.release / host.workspace.release)
 * by their owners.
 */
export function resolveOrphan(
  deps: RecoveryDeps,
  db: DatabaseSync,
  observationId: string,
  action: OrphanResolutionAction,
  evidence?: unknown,
  principalId?: string
): OrphanRecord {
  const found = loadOrphanRow(db, observationId)
  if (!found) {
    throw failure(
      'INVALID_TRANSITION',
      `orphan observation ${observationId} does not exist`,
      'none'
    )
  }
  const { payload } = found
  if (payload.state === 'resolved') {
    return rowToOrphan(found.raw) as OrphanRecord
  }
  if (action === 'mark-exited' && evidence === undefined) {
    throw failure(
      'INVALID_TRANSITION',
      'mark-exited requires positive exit evidence — an orphan is never declared dead on absence alone',
      'none'
    )
  }
  const now = deps.now()
  const next: OrphanPayload = {
    ...payload,
    state: action === 'keep-quarantined' ? 'quarantined' : 'resolved',
    resolution: { action, evidence, at: now, by: principalId }
  }
  db.prepare('UPDATE observations SET payload_json=? WHERE id=?').run(
    JSON.stringify(next),
    observationId
  )
  if (action !== 'keep-quarantined') {
    const pinId = `orphan:${payload.hostId}:${payload.identity.spawnNonce ?? observationId}`
    db.prepare('DELETE FROM retention_pins WHERE id=?').run(pinId)
  }
  deps.appendDomainEvent(
    db,
    payload.hostId,
    0,
    'recovery.orphan-resolved',
    { observationId },
    { action, evidence: evidence ?? null, by: principalId ?? null }
  )
  return {
    observationId,
    hostId: payload.hostId,
    identity: payload.identity,
    reason: payload.reason,
    state: next.state,
    relatedExecutionId: payload.relatedExecutionId,
    detectedAt: payload.detectedAt,
    resolution: next.resolution
  }
}

/**
 * Decide how a host-reported process maps to the control DB: 'matched' when
 * an execution claims the same spawnNonce AND birth identity, 'conflict'
 * when the nonce matches but identity doesn't, 'orphan' when nothing claims
 * it. Used by the reconciler — a conflict is NEVER silently re-pointed.
 */
export function classifyHostProcess(
  executions: ExecutionRow[],
  identity: ProcessIncarnation
):
  | { kind: 'matched'; exec: ExecutionRow }
  | { kind: 'conflict'; exec: ExecutionRow }
  | { kind: 'orphan' } {
  for (const exec of executions) {
    if (
      exec.processIdentity.spawnNonce &&
      exec.processIdentity.spawnNonce === identity.spawnNonce
    ) {
      const verdict = compareProcessIncarnation(exec.processIdentity, identity)
      if (verdict.match === 'mismatch') return { kind: 'conflict', exec }
      return { kind: 'matched', exec }
    }
  }
  return { kind: 'orphan' }
}
