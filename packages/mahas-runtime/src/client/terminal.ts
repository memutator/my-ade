// mahas-runtime — C-CLIENT terminal.* handlers.
//
// Semantics (spec/contracts/client-terminal.md + execution-lifecycle.md §4):
//   · attach = observe by default; a view is a ClientViewBinding, never an
//     Execution/Terminal. inputIntent:'claim' performs an InputLease CAS in
//     the SAME transaction — an operator attach never silently steals input
//     ownership from another client.
//   · input/resize proxy to the execution host only for the current
//     InputLease owner; passive viewers cannot move size or type.
//   · detach releases the subscription + THIS client's lease only; the
//     terminal, process and other clients' leases are untouched.
//
// Ordering inside every handler: the InputLease CAS is staged BEFORE the
// host proxy call so a failed C-HOST round-trip rolls it back — no input
// grant survives a failed attach. The binding write lands after the host
// answers, inside the same tx. The one remaining gap (host succeeded →
// commit failed) leaves only an orphan subscription the host can GC.
// NOTE: the host call currently executes inside the registry's mutation tx
// (SHARED-APIS dispatch gives handlers no pre-tx hook) — bounded local
// socket call, flagged for IMP-11/IMP-17 follow-up.

import type { ErrorCode, ErrorRetry } from '../../../mahas-contracts/src/index.ts'
import {
  ClientOpError,
  asRecord,
  controlUnavailable,
  isClientOpError,
  optNumber,
  reqInt,
  reqString,
  scopeDenied,
  snapshotRequired
} from './errors.ts'
import {
  claimInputLease,
  clearBindingSubscription,
  getBindingBySubscription,
  getExecutionForTerminal,
  getTerminal,
  releaseOwnLease,
  requireLeaseOwner,
  upsertBinding,
  type TerminalRow
} from './store.ts'
import type {
  ClientOpsDeps,
  ClientTxn,
  HostCaller,
  InputLeaseGrant,
  TerminalAttachResult,
  TerminalDetachResult,
  TerminalInputResult,
  TerminalResizeResult,
  TerminalSnapshotResult
} from './types.ts'

export const DEFAULT_INPUT_LEASE_TTL_MS = 5 * 60 * 1000

interface ResolvedDeps {
  host?: HostCaller
  authorize: ClientOpsDeps['authorize']
  appendDomainEvent: ClientOpsDeps['appendDomainEvent']
  now: () => number
  inputLeaseTtlMs: number
}

export function resolveDeps(deps: ClientOpsDeps): ResolvedDeps {
  return {
    host: deps.host,
    authorize: deps.authorize,
    appendDomainEvent: deps.appendDomainEvent,
    now: deps.now ?? (() => Date.now()),
    inputLeaseTtlMs: deps.inputLeaseTtlMs ?? DEFAULT_INPUT_LEASE_TTL_MS
  }
}

const HOST_ERROR_CODES: ReadonlySet<string> = new Set([
  'SCOPE_DENIED',
  'STALE_REVISION',
  'SNAPSHOT_REQUIRED',
  'CONTROL_UNAVAILABLE',
  'OPERATION_CONFLICT',
  'PROCESS_UNVERIFIABLE',
  'HOST_PROTOCOL_MISMATCH',
  'UNAUTHENTICATED'
])

function requireHost(deps: ResolvedDeps, op: string): HostCaller {
  if (!deps.host) {
    controlUnavailable(
      `${op}: no execution-host transport wired — the control plane cannot ` +
        `proxy C-HOST operations until IMP-17 lands a host session`
    )
  }
  return deps.host!
}

/** pass through MahasError-shaped host refusals; wrap everything else */
function mapHostError(e: unknown, op: string): never {
  if (isClientOpError(e)) throw e
  const err = e as { code?: unknown; message?: unknown; retry?: unknown; details?: unknown }
  if (typeof err?.code === 'string' && HOST_ERROR_CODES.has(err.code)) {
    throw new ClientOpError(
      err.code as ErrorCode,
      typeof err.message === 'string' ? err.message : `${op} refused by execution-host`,
      (typeof err.retry === 'string' ? err.retry : 'none') as ErrorRetry,
      err.details
    )
  }
  controlUnavailable(`${op}: execution-host call failed`, {
    cause: e instanceof Error ? e.message : String(e)
  })
}

function target(kind: string, id: string): { kind: string; id: string } {
  return { kind, id }
}

function requireTerminal(txn: ClientTxn, terminalId: string, op: string): TerminalRow {
  const term = getTerminal(txn.db, terminalId)
  if (!term) {
    // C-CLIENT: "unknown terminal 또는 stale epoch에는 snapshot fallback 명시"
    snapshotRequired(
      `${op}: unknown terminal ${terminalId} — rebuild the view from runtime.snapshot`,
      { terminalId }
    )
  }
  return term!
}

// ── terminal.attach ─────────────────────────────────────────────────────────

export async function terminalAttach(
  txn: ClientTxn,
  payload: unknown,
  deps: ClientOpsDeps
): Promise<TerminalAttachResult> {
  const d = resolveDeps(deps)
  const p = asRecord(payload)
  const terminalId = reqString(p.terminalId, 'terminalId')
  const viewId = reqString(p.viewId, 'viewId')
  // F-039: host epochs are opaque strings — accept the native string form
  // (numbers coerce losslessly for cursor-mismatch purposes; anything else
  // is a payload defect → TypeError → MODEL_INVALID via admission, never an
  // 'unknown' control-plane failure).
  const outputEpoch = optEpochStr(p.outputEpoch, 'outputEpoch')
  const lastSequence = optNumber(p.lastSequence, 'lastSequence')
  const expectedInputLeaseRevision = optNumber(
    p.expectedInputLeaseRevision,
    'expectedInputLeaseRevision'
  )
  const intent = p.inputIntent === undefined ? 'observe' : p.inputIntent
  if (intent !== 'observe' && intent !== 'claim') {
    throw new TypeError("inputIntent must be 'observe' or 'claim'")
  }

  const ctx = txn.ctx
  d.authorize(ctx, 'terminal.attach', [target('terminal', terminalId)])
  const term = requireTerminal(txn, terminalId, 'terminal.attach')
  const host = requireHost(d, 'terminal.attach')

  // claim path: explicit user control request — input scope + CAS in the
  // same tx as the binding write, never a silent takeover.
  let lease: InputLeaseGrant | null = null
  if (intent === 'claim') {
    d.authorize(ctx, 'terminal.input', [target('terminal', terminalId)])
    const row = claimInputLease(
      txn.db,
      terminalId,
      ctx.principalId,
      expectedInputLeaseRevision,
      d.inputLeaseTtlMs,
      d.now()
    )
    lease = {
      leaseId: row.terminal_id,
      terminalId,
      principalId: row.principal_id,
      revision: row.revision,
      expiresAt: row.expires_at
    }
  }

  // C-HOST proxy — the last fallible external step; a failure here rolls
  // back the lease CAS staged above so no grant survives a failed attach
  let hostRes: Record<string, unknown>
  try {
    hostRes = (await host.call('host.terminal.attach', {
      terminalId,
      outputEpoch: outputEpoch ?? term.output_epoch,
      lastSequence
    })) as Record<string, unknown>
  } catch (e) {
    mapHostError(e, 'terminal.attach')
  }

  const subscriptionId = extractSubscriptionId(hostRes!)
  if (!subscriptionId) {
    controlUnavailable('terminal.attach: host returned no subscription handle', {
      host: hostRes
    })
  }

  // persist the view binding with the live subscription — re-attach to the
  // same view replaces any stale subscription id
  const exec = getExecutionForTerminal(txn.db, terminalId)
  const binding = upsertBinding(
    txn.db,
    ctx.principalId,
    {
      viewId,
      terminalId,
      executionId: exec?.id ?? null,
      subscriptionId,
      inputIntent: intent,
      keepSubscription: false
    },
    d.now()
  )

  const nowMs = d.now()
  d.appendDomainEvent(
    txn.db,
    terminalId,
    binding.revision ?? 1,
    'client.terminal.attached',
    { clientId: ctx.principalId, viewId },
    { subscriptionId, inputIntent: intent, at: nowMs }
  )
  if (lease) {
    d.appendDomainEvent(
      txn.db,
      terminalId,
      lease.revision,
      'client.input_lease.claimed',
      { clientId: ctx.principalId, viewId },
      { revision: lease.revision, expiresAt: lease.expiresAt }
    )
  }

  const gap = extractGap(hostRes!, lastSequence)
  const replay = normalizeReplay(hostRes!.replay)
  return {
    attached: true,
    terminalId,
    subscriptionId: subscriptionId!,
    outputEpoch: asStr(hostRes!.outputEpoch),
    replayFromSequence: replay.length > 0 ? replay[0]!.sequence : (gap ? gap.availableFromSequence : null),
    gap,
    ...(replay.length > 0 ? { replay } : {}),
    snapshot: hostRes!.snapshot ?? hostRes!.screen,
    inputLease: lease,
    bindingRevision: binding.revision ?? 1
  }
}

function extractSubscriptionId(res: Record<string, unknown>): string | null {
  for (const key of ['subscriptionId', 'streamId', 'streamHandle'] as const) {
    const v = res[key]
    if (typeof v === 'string' && v) return v
  }
  const sub = res.subscription
  if (typeof sub === 'object' && sub !== null) {
    const id = (sub as Record<string, unknown>).id
    if (typeof id === 'string' && id) return id
  }
  return null
}

function extractGap(
  res: Record<string, unknown>,
  requestedLastSequence?: number
): { expectedSequence: number; availableFromSequence: number } | null {
  const gap = res.gap
  if (typeof gap === 'object' && gap !== null) {
    const g = gap as Record<string, unknown>
    // F-038: the host emits {droppedThrough} + a replay array — translate to
    // the client contract instead of dropping both. availableFrom is the
    // first replayed sequence when the host sent one, else droppedThrough+1.
    const dropped = asOptNum(g.droppedThrough)
    if (dropped !== undefined) {
      const replay = normalizeReplay(res.replay)
      const available = replay.length > 0 ? replay[0]!.sequence : dropped + 1
      return { expectedSequence: requestedLastSequence ?? dropped, availableFromSequence: available }
    }
    const expected = asOptNum(g.expectedSequence ?? g.expected)
    const available = asOptNum(g.availableFromSequence ?? g.availableFrom)
    if (expected !== undefined && available !== undefined) {
      return { expectedSequence: expected, availableFromSequence: available }
    }
  }
  return null
}

/** F-038: validate host replay chunks — malformed entries are dropped, never
 *  fatal (host shape drift must not break attach). */
function normalizeReplay(v: unknown): Array<{ sequence: number; dataB64: string }> {
  if (!Array.isArray(v)) return []
  const out: Array<{ sequence: number; dataB64: string }> = []
  for (const c of v) {
    if (c === null || typeof c !== 'object') continue
    const r = c as Record<string, unknown>
    if (typeof r.sequence !== 'number' || !Number.isFinite(r.sequence)) continue
    if (typeof r.d !== 'string') continue
    out.push({ sequence: r.sequence, dataB64: r.d })
  }
  return out
}

/** F-039: host-epoch input — native string form, numbers coerce. */
function optEpochStr(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string' && v.length > 0) return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  throw new TypeError(`${field} must be a non-empty string`)
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function asOptNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

// ── terminal.input ──────────────────────────────────────────────────────────

export async function terminalInput(
  txn: ClientTxn,
  payload: unknown,
  deps: ClientOpsDeps
): Promise<TerminalInputResult> {
  const d = resolveDeps(deps)
  const p = asRecord(payload)
  const terminalId = reqString(p.terminalId, 'terminalId')
  const inputLeaseRevision = reqInt(p.inputLeaseRevision, 'inputLeaseRevision', 1, 2 ** 31 - 1)
  const inputBytes = reqString(p.inputBytes, 'inputBytes')

  const ctx = txn.ctx
  d.authorize(ctx, 'terminal.input', [target('terminal', terminalId)])
  const term = requireTerminal(txn, terminalId, 'terminal.input')
  requireLeaseOwner(txn.db, terminalId, ctx.principalId, inputLeaseRevision, d.now())
  const host = requireHost(d, 'terminal.input')

  let res: Record<string, unknown>
  try {
    res = (await host.call('host.terminal.input', {
      terminalId,
      inputLeaseRevision,
      inputBytes,
      expectedHostIncarnation: term.host_incarnation
    })) as Record<string, unknown>
  } catch (e) {
    mapHostError(e, 'terminal.input')
  }

  return {
    admitted: res!.admitted !== false,
    bytesAdmitted: asOptNum(res!.bytesAdmitted),
    atSequence: asOptNum(res!.atSequence ?? res!.sequence),
    receipt: res
  }
}

// ── terminal.resize ─────────────────────────────────────────────────────────

export async function terminalResize(
  txn: ClientTxn,
  payload: unknown,
  deps: ClientOpsDeps
): Promise<TerminalResizeResult> {
  const d = resolveDeps(deps)
  const p = asRecord(payload)
  const terminalId = reqString(p.terminalId, 'terminalId')
  const inputLeaseRevision = reqInt(p.inputLeaseRevision, 'inputLeaseRevision', 1, 2 ** 31 - 1)
  const columns = reqInt(p.columns, 'columns', 1, 1000)
  const rows = reqInt(p.rows, 'rows', 1, 1000)

  const ctx = txn.ctx
  d.authorize(ctx, 'terminal.resize', [target('terminal', terminalId)])
  requireTerminal(txn, terminalId, 'terminal.resize')
  requireLeaseOwner(txn.db, terminalId, ctx.principalId, inputLeaseRevision, d.now())
  const host = requireHost(d, 'terminal.resize')

  let res: Record<string, unknown>
  try {
    res = (await host.call('host.terminal.resize', {
      terminalId,
      inputLeaseRevision,
      columns,
      rows
    })) as Record<string, unknown>
  } catch (e) {
    mapHostError(e, 'terminal.resize')
  }

  const sizeRevision = asOptNum(res!.sizeRevision ?? res!.revision)
  if (sizeRevision === undefined) {
    controlUnavailable('terminal.resize: host returned no size revision', { host: res })
  }
  return { resized: true, terminalId, sizeRevision: sizeRevision! }
}

// ── terminal.snapshot ───────────────────────────────────────────────────────

export async function terminalSnapshot(
  txn: ClientTxn,
  payload: unknown,
  deps: ClientOpsDeps
): Promise<TerminalSnapshotResult> {
  const d = resolveDeps(deps)
  const p = asRecord(payload)
  const terminalId = reqString(p.terminalId, 'terminalId')
  const expectedEpoch = optEpochStr(p.expectedEpoch ?? p.expectedOutputEpoch, 'expectedEpoch')

  const ctx = txn.ctx
  d.authorize(ctx, 'terminal.snapshot', [target('terminal', terminalId)])
  requireTerminal(txn, terminalId, 'terminal.snapshot')
  const host = requireHost(d, 'terminal.snapshot')

  let res: Record<string, unknown>
  try {
    res = (await host.call('host.terminal.snapshot', {
      terminalId,
      expectedOutputEpoch: expectedEpoch
    })) as Record<string, unknown>
  } catch (e) {
    mapHostError(e, 'terminal.snapshot')
  }

  return {
    terminalId,
    outputEpoch: asStr(res!.outputEpoch),
    lastSequence: asOptNum(res!.lastSequence),
    screen: res!.screen ?? res!.snapshot,
    truncated: res!.truncated === true,
    unavailable: res!.unavailable === true,
    host: res
  }
}

// ── terminal.detach ─────────────────────────────────────────────────────────

export async function terminalDetach(
  txn: ClientTxn,
  payload: unknown,
  deps: ClientOpsDeps
): Promise<TerminalDetachResult> {
  const d = resolveDeps(deps)
  const p = asRecord(payload)
  const subscriptionId = reqString(p.subscriptionId, 'subscriptionId')

  const ctx = txn.ctx
  const binding = getBindingBySubscription(txn.db, subscriptionId)

  // ownership: a tracked subscription belongs to exactly one client —
  // touching another client's stream is a scope violation
  if (binding && binding.client_id !== ctx.principalId) {
    scopeDenied('terminal.detach: subscription owned by a different client', {
      subscriptionId
    })
  }
  if (binding?.terminal_id) {
    d.authorize(ctx, 'terminal.detach', [target('terminal', binding.terminal_id)])
  } else {
    d.authorize(ctx, 'terminal.detach', [target('subscription', subscriptionId)])
  }

  const host = requireHost(d, 'terminal.detach')
  const nowMs = d.now()

  let leaseReleased = false
  if (binding?.terminal_id) {
    // release only THIS client's lease — others' leases and the process
    // are untouched (C-CLIENT terminal.detach)
    leaseReleased = releaseOwnLease(txn.db, binding.terminal_id, ctx.principalId)
    clearBindingSubscription(txn.db, binding.id, nowMs)
  }

  try {
    await host.call('host.terminal.detach', { subscriptionId })
  } catch (e) {
    mapHostError(e, 'terminal.detach')
  }

  if (binding) {
    d.appendDomainEvent(
      txn.db,
      binding.terminal_id ?? binding.id,
      nowMs,
      'client.terminal.detached',
      { clientId: ctx.principalId, viewId: binding.view_id },
      { subscriptionId, leaseReleased }
    )
    if (leaseReleased) {
      d.appendDomainEvent(
        txn.db,
        binding.terminal_id ?? binding.id,
        nowMs,
        'client.input_lease.released',
        { clientId: ctx.principalId, viewId: binding.view_id },
        { reason: 'detach' }
      )
    }
  }

  return {
    detached: true,
    leaseReleased,
    bindingCleared: binding !== null
  }
}
