// lease.ts — ControllerLease storage, CAS admission, and fencing for the
// execution-host (spec/contracts/execution-host.md `host.acquire`,
// spec/domains/execution.md §3, spec/execution-lifecycle.md §5).
//
// Invariants this file enforces — the safety core of IMP-17:
//   * TAKEOVER requires positive evidence: a verifiable-dead recorded owner
//     (pid gone, or pid reused with different birth evidence) or an explicit
//     handoff token planted by the previous owner. TTL expiry and socket
//     disconnect NEVER move the lease (spec: "TTL alone 금지").
//   * FENCING: every mutation must carry the CURRENT epoch + the lease
//     proof (fence token) issued at acquire time. Stale epochs are refused
//     before any effect runs (REQ-15).
//   * The lease row (host_controller_lease, id=1) is the single-writer CAS
//     record; proof_json carries the fence token + evidence trail.

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ControllerEpoch } from '../../mahas-contracts/src/common.ts'
import { sha256Hex, withTx } from './storage.ts'

/** Wire-level refusal. `code` follows spec/common.md §4 where one fits;
 * 'INVALID_ARGUMENT'/'UNIMPLEMENTED' are wire additions (the common list
 * has no malformed-input code). */
export class HostOpError extends Error {
  readonly code: string
  readonly retry: 'none' | 'same-operation' | 'reconcile' | 'replan'
  readonly details?: unknown
  constructor(
    code: string,
    message: string,
    retry: HostOpError['retry'] = 'none',
    details?: unknown
  ) {
    super(message)
    this.code = code
    this.retry = retry
    this.details = details
  }
}

/**
 * What a controller claims about the OS process it runs in. pid alone is
 * not an identity (REQ-15); birthEvidence is the strongest available
 * platform proof (Linux: /proc/<pid>/stat starttime). Missing birth
 * evidence weakens verification — never silently strengthens it.
 */
export interface ControllerProcessIdentity {
  pid: number
  birthEvidence?: string
  bootId?: string
  /** diagnostic only — who the caller says it is (mahasd instance id) */
  label?: string
}

export interface TakeoverProof {
  kind: 'dead-evidence' | 'explicit-handoff'
  /** for explicit-handoff: the token a previous owner planted in proof_json */
  handoffToken?: string
  /** caller-supplied observation note, recorded as evidence (not trusted) */
  note?: string
}

export interface StoredLease {
  epoch: number
  revision: number
  expiresAt: number
  proof: {
    controllerIdentity: ControllerProcessIdentity
    /** secret the holder presents on mutations — the fence token */
    fenceToken: string
    /** optional token the holder may pass to a successor for clean handoff */
    handoffToken?: string
    grantedAt: number
    takeoverEvidence: {
      kind: 'initial' | 'self-epoch-advance' | 'dead-evidence' | 'explicit-handoff'
      probedAt?: number
      note?: string
    }
  }
}

export interface ControllerLeaseView {
  hostId: string
  epoch: number
  revision: number
  /** advisory only — expiry alone never transfers nor revokes ownership */
  expiresAt: number
  /** present to the host on every mutation as the fence */
  leaseProof: string
  /** revealable to a chosen successor for explicit handoff */
  handoffToken: string
  grantedAt: number
}

interface LeaseRow {
  epoch: number
  revision: number
  expires_at: number
  proof_json: string
}

function rowToLease(row: LeaseRow): StoredLease {
  return {
    epoch: row.epoch,
    revision: row.revision,
    expiresAt: row.expires_at,
    proof: JSON.parse(row.proof_json) as StoredLease['proof']
  }
}

export function readLease(db: DatabaseSync): StoredLease | null {
  const row = db
    .prepare('SELECT epoch, revision, expires_at, proof_json FROM host_controller_lease WHERE id=1')
    .get() as LeaseRow | undefined
  return row ? rowToLease(row) : null
}

export type ProbeVerdict = 'alive' | 'dead' | 'unverifiable'

/**
 * Linux /proc starttime of `pid` — our strongest same-machine birth
 * evidence. Returns null when the process is gone or /proc is unreadable.
 */
function procStarttime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm may contain spaces/parens — parse fields after the LAST ')'.
    // Field 22 (starttime) is index 19 of the post-')' field list
    // (field 3 'state' is index 0).
    const close = stat.lastIndexOf(')')
    if (close < 0) return null
    const fields = stat
      .slice(close + 1)
      .trim()
      .split(/\s+/)
    return fields[19] ?? null
  } catch {
    return null
  }
}

/**
 * Positive evidence about a recorded controller identity (D-EXEC §3 —
 * "pid+birth identity를 probe").
 *   dead         — pid absent (ESRCH) or pid reused under a different
 *                  recorded starttime: the recorded process is verifiably
 *                  gone.
 *   alive        — pid exists AND recorded birth evidence still matches
 *                  (or none was recorded — weaker but positive existence).
 *   unverifiable — we cannot tell (non-Linux, /proc unreadable while a
 *                  birth check was required, pid missing). Unknown is
 *                  honest; it never resolves toward takeover.
 */
export function probeProcessIdentity(
  identity: ControllerProcessIdentity | undefined
): ProbeVerdict {
  if (!identity || typeof identity.pid !== 'number' || identity.pid <= 0) return 'unverifiable'
  let exists = false
  try {
    process.kill(identity.pid, 0)
    exists = true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return 'dead'
    if (code === 'EPERM')
      exists = true // exists, owned by another uid
    else return 'unverifiable'
  }
  if (!exists) return 'dead'
  const starttime = procStarttime(identity.pid)
  if (identity.birthEvidence !== undefined) {
    if (starttime === null) return 'unverifiable' // cannot confirm the recorded birth
    return starttime === identity.birthEvidence ? 'alive' : 'dead'
  }
  return 'alive' // pid exists and no birth evidence was recorded to contradict
}

/** Own birth evidence for this host process (same form we ask of controllers). */
export function ownProcessIdentity(): ControllerProcessIdentity {
  let bootId: string | undefined
  try {
    bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    bootId = undefined // non-Linux — weaker evidence, recorded as absent
  }
  const birthEvidence = procStarttime(process.pid) ?? undefined
  return { pid: process.pid, birthEvidence, bootId }
}

function toView(hostId: string, lease: StoredLease): ControllerLeaseView {
  return {
    hostId,
    epoch: lease.epoch,
    revision: lease.revision,
    expiresAt: lease.expiresAt,
    leaseProof: lease.proof.fenceToken,
    handoffToken: lease.proof.handoffToken ?? '',
    grantedAt: lease.proof.grantedAt
  }
}

export interface AcquireInput {
  controllerEpoch: number
  controllerProcessIdentity: ControllerProcessIdentity
  takeoverProof?: TakeoverProof
  priorLeaseRevision?: number
  /** advisory lease lifetime the controller asks for; default 30s */
  ttlMs?: number
}

const DEFAULT_LEASE_TTL_MS = 30_000

/**
 * host.acquire — grant/renew/take over the controller lease.
 * Runs the check-and-set inside one write transaction (the CAS).
 */
export function acquireControllerLease(
  db: DatabaseSync,
  hostId: string,
  input: AcquireInput
): ControllerLeaseView {
  const { controllerEpoch: epoch, controllerProcessIdentity: claimant } = input
  if (!Number.isInteger(epoch) || epoch < 1) {
    throw new HostOpError('INVALID_ARGUMENT', 'controllerEpoch must be a positive integer', 'none')
  }
  if (!claimant || typeof claimant.pid !== 'number' || claimant.pid < 1) {
    throw new HostOpError('INVALID_ARGUMENT', 'controllerProcessIdentity.pid is required', 'none')
  }
  if (input.priorLeaseRevision !== undefined && !Number.isInteger(input.priorLeaseRevision)) {
    throw new HostOpError('INVALID_ARGUMENT', 'priorLeaseRevision must be an integer', 'none')
  }
  const ttl = input.ttlMs && input.ttlMs > 0 ? Math.min(input.ttlMs, 300_000) : DEFAULT_LEASE_TTL_MS

  return withTx(db, (tx) => {
    const stored = readLease(tx)
    const now = Date.now()

    const grant = (
      revision: number,
      evidence: StoredLease['proof']['takeoverEvidence'],
      handoffToken?: string
    ): ControllerLeaseView => {
      const proof: StoredLease['proof'] = {
        controllerIdentity: claimant,
        fenceToken: `lease-${epoch}-${randomUUID()}`,
        handoffToken: handoffToken ?? randomUUID(),
        grantedAt: now,
        takeoverEvidence: evidence
      }
      tx.prepare(
        'INSERT INTO host_controller_lease(id,epoch,revision,expires_at,proof_json) VALUES(1,?,?,?,?) ' +
          'ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch, revision=excluded.revision, ' +
          'expires_at=excluded.expires_at, proof_json=excluded.proof_json'
      ).run(epoch, revision, now + ttl, JSON.stringify(proof))
      return toView(hostId, { epoch, revision, expiresAt: now + ttl, proof })
    }

    // First controller ever — nothing to take over from.
    if (!stored) return grant(1, { kind: 'initial' })

    const holderAlive = probeProcessIdentity(stored.proof.controllerIdentity) === 'alive'
    // Same OS process re-acquiring: the recorded identity verifiably lives
    // at the pid the claimant also claims — a different process cannot hold
    // that pid, so the claimant IS the recorded owner.
    const sameOwner = stored.proof.controllerIdentity.pid === claimant.pid && holderAlive

    // F-017: a fresh control DB restarts its epoch counter at 1, so a
    // regenerated/recovered controller legitimately arrives with
    // epoch < stored.epoch. The permanent STALE_EXECUTION below used to brick
    // that scenario. Same dead-evidence bar as the epoch> takeover path: a
    // verifiably dead recorded owner may be reclaimed (the grant resets the
    // stored epoch to the claimant's), a live owner still refuses, and an
    // unverifiable owner stays honest instead of resolving toward takeover.
    if (epoch < stored.epoch) {
      if (sameOwner) {
        return grant(stored.revision + 1, { kind: 'self-epoch-advance' }, stored.proof.handoffToken)
      }
      const verdict = probeProcessIdentity(stored.proof.controllerIdentity)
      if (verdict === 'dead') {
        return grant(stored.revision + 1, {
          kind: 'dead-evidence',
          probedAt: now,
          note:
            input.takeoverProof?.note ??
            `stale-epoch reclaim of epoch ${stored.epoch} by epoch ${epoch}`
        })
      }
      if (verdict === 'alive') {
        throw new HostOpError(
          'STALE_EXECUTION',
          `controllerEpoch ${epoch} is behind current lease epoch ${stored.epoch} held by a live controller (pid ${stored.proof.controllerIdentity.pid})`,
          'reconcile',
          { currentEpoch: stored.epoch, holderPid: stored.proof.controllerIdentity.pid }
        )
      }
      throw new HostOpError(
        'PROCESS_UNVERIFIABLE',
        `cannot verify that recorded controller pid ${stored.proof.controllerIdentity.pid} (lease epoch ${stored.epoch}) is dead — lease stays`,
        'reconcile'
      )
    }
    if (input.priorLeaseRevision !== undefined && input.priorLeaseRevision !== stored.revision) {
      throw new HostOpError(
        'STALE_REVISION',
        `priorLeaseRevision ${input.priorLeaseRevision} != stored revision ${stored.revision}`,
        'reconcile',
        { currentRevision: stored.revision }
      )
    }

    if (epoch === stored.epoch) {
      if (!sameOwner) {
        // A different live-or-unverifiable claimant cannot share an epoch.
        throw new HostOpError(
          'SCOPE_DENIED',
          `epoch ${epoch} is held by a different controller identity`,
          'none'
        )
      }
      // Idempotent renew of one's own lease (re-acquire = stored receipt).
      const proof: StoredLease['proof'] = {
        ...stored.proof,
        controllerIdentity: claimant, // refresh any newly supplied evidence fields
        grantedAt: stored.proof.grantedAt
      }
      tx.prepare(
        'UPDATE host_controller_lease SET revision=?, expires_at=?, proof_json=? WHERE id=1'
      ).run(stored.revision + 1, now + ttl, JSON.stringify(proof))
      return toView(hostId, { epoch, revision: stored.revision + 1, expiresAt: now + ttl, proof })
    }

    // epoch > stored.epoch — takeover or self-advance; both need the same
    // evidence bar: a dead-verified recorded owner or explicit handoff.
    if (sameOwner) {
      return grant(stored.revision + 1, { kind: 'self-epoch-advance' }, stored.proof.handoffToken)
    }
    const handoffOk =
      input.takeoverProof?.kind === 'explicit-handoff' &&
      !!stored.proof.handoffToken &&
      input.takeoverProof.handoffToken === stored.proof.handoffToken
    if (handoffOk) {
      return grant(stored.revision + 1, {
        kind: 'explicit-handoff',
        note: input.takeoverProof?.note
      })
    }
    const verdict = probeProcessIdentity(stored.proof.controllerIdentity)
    if (verdict === 'dead') {
      return grant(stored.revision + 1, {
        kind: 'dead-evidence',
        probedAt: now,
        note: input.takeoverProof?.note
      })
    }
    if (verdict === 'alive') {
      throw new HostOpError(
        'SCOPE_DENIED',
        `recorded controller for epoch ${stored.epoch} is verifiably alive — takeover refused (TTL expiry is not evidence)`,
        'none',
        { holderPid: stored.proof.controllerIdentity.pid }
      )
    }
    throw new HostOpError(
      'PROCESS_UNVERIFIABLE',
      `cannot verify that recorded controller pid ${stored.proof.controllerIdentity.pid} is dead — lease stays`,
      'reconcile'
    )
  })
}

/**
 * Mutation fence for every effect-running op (spec: "mutation에서 epoch과
 * lease proof를 검사한다"). Call before ANY state change. Throws:
 *   CONTROL_UNAVAILABLE — no lease has ever been granted on this host
 *   STALE_EXECUTION     — epoch missing or != current lease epoch
 *   SCOPE_DENIED        — right epoch, wrong/absent proof token
 */
export function requireLeaseProof(
  db: DatabaseSync,
  controllerEpoch: number | undefined,
  leaseProof: string | undefined,
  now: number = Date.now()
): StoredLease {
  const lease = readLease(db)
  if (!lease) {
    throw new HostOpError(
      'CONTROL_UNAVAILABLE',
      'no controller lease exists on this host — host.acquire first',
      'reconcile'
    )
  }
  if (typeof controllerEpoch !== 'number' || controllerEpoch !== lease.epoch) {
    throw new HostOpError(
      'STALE_EXECUTION',
      `controllerEpoch ${String(controllerEpoch)} does not match current lease epoch ${lease.epoch}`,
      'reconcile',
      { currentEpoch: lease.epoch }
    )
  }
  if (!leaseProof || leaseProof !== lease.proof.fenceToken) {
    throw new HostOpError('SCOPE_DENIED', 'leaseProof does not match the held lease', 'none')
  }
  // F-035: TTL expiry is enforced on the mutation path — an expired lease
  // authorizes nothing, even with the right epoch + fence token. A live
  // controller renews by re-acquiring (same epoch + same owner extends
  // expires_at); a dead controller's leftover fence therefore stops working
  // instead of authorizing spawns indefinitely. Expiry alone still never
  // justifies TAKEOVER (acquireControllerLease still demands dead-evidence
  // or handoff) — these are two different questions.
  if (lease.expiresAt <= now) {
    throw new HostOpError(
      'SCOPE_DENIED',
      `controller lease epoch ${lease.epoch} expired — re-acquire to renew`,
      'reconcile',
      { leaseEpoch: lease.epoch, expiredAt: lease.expiresAt }
    )
  }
  return lease
}

/** host_incarnation check shared by read + mutation ops (C-HOST: "stale
 * incarnation" is a named refusal). */
export function requireCurrentIncarnation(expected: string | undefined, actual: string): void {
  if (expected !== undefined && expected !== actual) {
    throw new HostOpError(
      'STALE_EXECUTION',
      `expectedHostIncarnation ${expected} is not this host's incarnation ${actual}`,
      'reconcile',
      { currentIncarnation: actual }
    )
  }
}

/** fingerprint helper exposed for effect-intent dedup (payload canonical). */
export function fingerprintPayload(payload: unknown): string {
  return sha256Hex(stableStringify(payload))
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`
}

export type { ControllerEpoch }
