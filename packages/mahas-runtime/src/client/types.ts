// mahas-runtime — C-CLIENT operation payloads and dependency ports.
//
// IMP-28 owns the workbench surface: terminal.attach/input/resize/snapshot/
// detach + client.view.bind/unbind (spec/contracts/client-terminal.md).
//
// Dependency ports (ClientOpsDeps / ClientOpsRegistry / ClientTxn) are
// STRUCTURAL mirrors of the fixed kernel signatures in
// packages/SHARED-APIS.md — IMP-03 (storage), IMP-10 (authorize), IMP-11
// (OperationRegistry/makeCaller) and IMP-17 (HostClient) are landing in
// parallel, so this module cannot import their files yet. When they land,
// the composition site passes the real implementations: they satisfy these
// shapes by structural typing with no changes here. Nothing below
// re-implements kernel behaviour — every dep is invoked, never inlined.

import type { DatabaseSync } from 'node:sqlite'
import type {
  AuthenticatedContext,
  ControlResult,
  ExecutionId,
  OperationId,
  TerminalId,
  ViewId
} from '../../../mahas-contracts/src/index.ts'

// ── kernel mirrors (packages/SHARED-APIS.md) ────────────────────────────────

/** IMP-11 TxnContext — handler-scoped tx + authenticated principal */
export interface ClientTxn {
  db: DatabaseSync
  ctx: AuthenticatedContext
}

/** IMP-11 OperationSpec */
export interface ClientOperationSpec {
  name: string
  visibility: 'operator' | 'member' | 'service' | 'host'
  mutation: boolean
}

/** IMP-11 OperationHandler */
export type ClientOperationHandler = (
  txn: ClientTxn,
  payload: unknown
) => unknown | Promise<unknown>

/** IMP-11 OperationRegistry — only the surface this module consumes */
export interface ClientOpsRegistry {
  register(spec: ClientOperationSpec, handler: ClientOperationHandler): void
}

/** IMP-10 authorize() signature */
export type AuthorizeFn = (
  ctx: AuthenticatedContext,
  operation: string,
  targets: { kind: string; id: string }[]
) => void

/** IMP-03 appendDomainEvent() signature */
export type AppendDomainEventFn = (
  db: DatabaseSync,
  aggregateId: string,
  aggregateRevision: number,
  eventType: string,
  scope: unknown,
  payload: unknown
) => void

/** IMP-17 HostClient.call() signature — the C-HOST transport */
export interface HostCaller {
  call<T = unknown>(operation: string, payload?: unknown): Promise<T>
}

/** IMP-11 makeCaller() product — cross-domain ops by name (e.g. IMP-26's
 *  runtime.snapshot / runtime.subscribe under C-OBSERVATION) */
export type OperationCaller = (
  operation: string,
  payload?: unknown,
  expectedRevisions?: Record<string, number>
) => Promise<unknown>

/** dependencies injected at composition (mahasd bootstrap / IMP-11 wiring) */
export interface ClientOpsDeps {
  /**
   * C-HOST transport for host.terminal.* proxying. Absent → terminal ops
   * answer CONTROL_UNAVAILABLE honestly; view bind/unbind still work.
   */
  host?: HostCaller
  /**
   * Operation-name caller for sibling ops (IMP-26 runtime.snapshot /
   * runtime.subscribe). Reserved for handlers that need the projection;
   * the desktop reaches those ops directly through the same registry.
   */
  call?: OperationCaller
  /** IMP-10 kernel authorization — every op runs a resource-level check */
  authorize: AuthorizeFn
  /** IMP-03 domain-event append (same write tx as the mutation) */
  appendDomainEvent: AppendDomainEventFn
  /** testable clock; defaults to Date.now */
  now?: () => number
  /** InputLease lifetime; default DEFAULT_INPUT_LEASE_TTL_MS */
  inputLeaseTtlMs?: number
}

// ── C-CLIENT payload shapes ─────────────────────────────────────────────────
// Canonical homes for these live in mahas-contracts once IMP-02 lands the
// observation/resource modules; field names follow C-CLIENT verbatim.

export type TerminalInputIntent = 'observe' | 'claim'

/** C-CLIENT terminal.attach input */
export interface TerminalAttachRequest {
  terminalId: TerminalId
  viewId: ViewId
  outputEpoch?: number
  lastSequence?: number
  /** default 'observe' — never grants input ownership */
  inputIntent?: TerminalInputIntent
  expectedInputLeaseRevision?: number
}

/** InputLease handle returned on a successful claim. The lease row is keyed
 *  by terminal_id, so `leaseId` is the terminal id and `revision` is the CAS
 *  fencing token every input/resize must echo. */
export interface InputLeaseGrant {
  leaseId: string
  terminalId: TerminalId
  principalId: string
  revision: number
  expiresAt: number
}

export interface TerminalAttachResult {
  attached: true
  terminalId: TerminalId
  /** host-side stream/subscription handle — required for terminal.detach */
  subscriptionId: string
  outputEpoch?: number
  /** replay start, or null when the host answered with a fresh snapshot */
  replayFromSequence?: number | null
  /** present when the requested cursor fell outside the retained range */
  gap?: { expectedSequence: number; availableFromSequence: number } | null
  /** bounded screen/history payload as returned by the host */
  snapshot?: unknown
  /** set only when inputIntent:'claim' succeeded */
  inputLease?: InputLeaseGrant | null
  /** the persisted ClientViewBinding revision for viewId */
  bindingRevision: number
}

/** C-CLIENT terminal.input input — inputBytes is base64 on the wire */
export interface TerminalInputRequest {
  terminalId: TerminalId
  inputLeaseRevision: number
  inputBytes: string
}

/** admission receipt — NOT evidence the shell/agent processed the bytes */
export interface TerminalInputResult {
  admitted: boolean
  bytesAdmitted?: number
  atSequence?: number
  receipt?: unknown
}

/** C-CLIENT terminal.resize input */
export interface TerminalResizeRequest {
  terminalId: TerminalId
  inputLeaseRevision: number
  columns: number
  rows: number
}

export interface TerminalResizeResult {
  resized: true
  terminalId: TerminalId
  sizeRevision: number
}

/** C-CLIENT terminal.snapshot input */
export interface TerminalSnapshotRequest {
  terminalId: TerminalId
  expectedEpoch?: number
}

export interface TerminalSnapshotResult {
  terminalId: TerminalId
  outputEpoch?: number
  lastSequence?: number
  /** bounded screen/history as returned by the host */
  screen?: unknown
  truncated?: boolean
  unavailable?: boolean
  /** unmodified host payload for forward compatibility */
  host?: unknown
}

/** C-CLIENT terminal.detach input */
export interface TerminalDetachRequest {
  subscriptionId: string
}

export interface TerminalDetachResult {
  detached: true
  /** true when this client held an input lease that was released */
  leaseReleased: boolean
  /** true when a stored view binding carried this subscription */
  bindingCleared: boolean
}

/** C-CLIENT client.view.unbind result */
export interface ClientViewUnbindResult {
  unbound: true
  viewId: ViewId
}

// ── client-side port (desktop IPC seam) ─────────────────────────────────────

/** the op-name caller every client transport ultimately provides
 *  (IMP-12 connectRpc result, or any equivalent) */
export type ClientOpCaller = (
  operation: string,
  payload?: unknown,
  opts?: { operationId?: OperationId | string; expectedRevisions?: Record<string, number> }
) => Promise<unknown>

/**
 * Typed desktop surface for the C-CLIENT terminal ops. View bind/unbind are
 * deliberately absent — they already ride the RuntimeClient port
 * (exec:bindView / exec:unbindView channels).
 */
export interface ClientTerminalOps {
  terminalAttach(req: TerminalAttachRequest): Promise<ControlResult<TerminalAttachResult>>
  terminalInput(req: TerminalInputRequest): Promise<ControlResult<TerminalInputResult>>
  terminalResize(req: TerminalResizeRequest): Promise<ControlResult<TerminalResizeResult>>
  terminalSnapshot(req: TerminalSnapshotRequest): Promise<ControlResult<TerminalSnapshotResult>>
  terminalDetach(req: TerminalDetachRequest): Promise<ControlResult<TerminalDetachResult>>
}

/** op names this module owns — single source for server registration and
 *  the client port (spec/operations.md C-CLIENT block) */
export const CLIENT_OPERATION_NAMES = [
  'terminal.attach',
  'terminal.input',
  'terminal.resize',
  'terminal.snapshot',
  'terminal.detach',
  'client.view.bind',
  'client.view.unbind'
] as const

export type ClientOperationName = (typeof CLIENT_OPERATION_NAMES)[number]

export type { ExecutionId, TerminalId, ViewId }
