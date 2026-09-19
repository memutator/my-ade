// workbench/client.ts — the workbench's control-plane call seam.
//
// `OpCaller` mirrors IMP-12's connectRpc call signature exactly (SHARED-APIS
// §IMP-12): call(op, payload?, {operationId?, expectedRevisions?}) →
// Promise<unknown>. In the desktop the transport is the exec:* IPC seam —
// `window.mahas.exec.op` forwards to the runtime attachment in the main
// process, which owns the negotiated session (IMP-12/IMP-30 wire the real
// connectRpc call behind it). The renderer never touches a socket itself
// and never imports mahas-runtime (IMP-01 boundary rule).
//
// A different caller can be injected (IMP-30 composition, tests). When the
// control plane is unreachable the seam answers honestly —
// CONTROL_UNAVAILABLE — and every view renders that as itself, never as a
// fake empty result (REQ-27).

/** one rejected op — code vocabulary follows MahasError/ControlErrorCode */
export class WorkbenchOpError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'WorkbenchOpError'
    this.code = code
    this.retryable = retryable
  }
}

/** SHARED-APIS connectRpc call signature — payload is a plain JSON value;
 //  the server owns admission, revision checks and idempotency. */
export type OpCaller = <T = unknown>(
  operation: string,
  payload?: unknown,
  opts?: { operationId?: string; expectedRevisions?: Record<string, number> }
) => Promise<T>

/** pushed runtime event — mirrors contracts.ts RuntimeEvent but stays
 //  local to the seam so subscribe plumbing can evolve with IMP-26. */
export interface WorkbenchEvent {
  subscriptionId: string
  sequence: number
  kind?: string
  entity?: unknown
  snapshotRequired?: boolean
}

/** subscribe seam — mirrors connectRpc-style streaming: resolves to an
 //  unsubscribe function or rejects (CONTROL_UNAVAILABLE while no session
 //  transport exists). The workbench falls back to manual snapshot refresh
 //  when a subscription can't be opened — events are a convenience, never
 //  required for correctness (snapshot+cursor restores state, REQ-23). */
export type OpSubscriber = (
  request: {
    scope?: unknown
    epoch: number
    afterSequence: number
    visibilityDigest?: string
  },
  onEvent: (event: WorkbenchEvent) => void
) => Promise<() => void>

/** normalize any thrown value to a workbench error code — MahasError.code
 //  vocabulary (STALE_REVISION, SCOPE_DENIED, …) or CONTROL_UNAVAILABLE. */
export function opError(err: unknown): WorkbenchOpError {
  if (err instanceof WorkbenchOpError) return err
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown; retryable?: unknown }
    return new WorkbenchOpError(
      typeof e.code === 'string' ? e.code : 'UNKNOWN',
      typeof e.message === 'string' ? e.message : String(err),
      e.retryable === true
    )
  }
  return new WorkbenchOpError('UNKNOWN', String(err))
}

/** UI-facing classification — no-match / ambiguous / stale / denied /
 //  unavailable are DIFFERENT states with different actions (IMP-31 §4.3). */
export type OpErrorKind =
  | 'unavailable'
  | 'stale'
  | 'denied'
  | 'no-match'
  | 'ambiguous'
  | 'missing-impl'
  | 'input-pending'
  | 'error'

export function opErrorKind(err: unknown): OpErrorKind {
  const code = opError(err).code
  switch (code) {
    case 'CONTROL_UNAVAILABLE':
      return 'unavailable'
    case 'STALE_REVISION':
    case 'STALE_EXECUTION':
    case 'INTERFACE_STALE':
      return 'stale'
    case 'SCOPE_DENIED':
    case 'GRANT_REVOKED':
    case 'UNAUTHENTICATED':
    case 'REQUIRED_ACTION_DENIED':
      return 'denied'
    case 'NO_RESPONSIBLE_ROLE':
      return 'no-match'
    case 'AMBIGUOUS_TERRITORY':
      return 'ambiguous'
    case 'IMPLEMENTATION_MISSING':
    case 'MANDATORY_COMPONENT_MISSING':
      return 'missing-impl'
    case 'INPUT_NOT_READY':
      return 'input-pending'
    default:
      return 'error'
  }
}

// ── desktop transport ───────────────────────────────────────────

/** adapt the exec:* IPC seam to the connectRpc-shaped OpCaller. The
 //  ControlResult envelope unwraps here — a rejected op THROWS
 //  WorkbenchOpError so view code handles errors uniformly. */
function desktopOpCaller(): OpCaller {
  return async <T>(
    operation: string,
    payload?: unknown,
    opts?: { operationId?: string; expectedRevisions?: Record<string, number> }
  ): Promise<T> => {
    const res = await window.mahas.exec.op({
      operation,
      operationId: opts?.operationId,
      payload,
      expectedRevisions: opts?.expectedRevisions
    })
    if (!res.ok) throw new WorkbenchOpError(res.error.code, res.error.message, res.error.retryable)
    // IPC transports JSON and has no generic runtime metadata. This is the
    // single typed boundary; each operation maps its actual shared DTO before
    // exposing a view model to React.
    return res.value as T
  }
}

function desktopOpSubscriber(): OpSubscriber {
  return (request, onEvent) => {
    let subscriptionId = ''
    let offEvents: (() => void) | null = null
    let cancelled = false
    const opened = window.mahas.exec.subscribe(request).then((res) => {
      if (!res.ok) {
        throw new WorkbenchOpError(res.error.code, res.error.message, res.error.retryable)
      }
      subscriptionId = res.value
      offEvents = window.mahas.exec.onEvent((e) => {
        if (e.subscriptionId === subscriptionId) {
          onEvent({
            subscriptionId,
            sequence: e.sequence,
            kind: e.kind,
            entity: e.entity,
            snapshotRequired: e.snapshotRequired
          })
        }
      })
      // unsubscribed while the open was still in flight — tear down now
      if (cancelled) void window.mahas.exec.unsubscribe(subscriptionId)
    })
    return opened.then(() => () => {
      cancelled = true
      offEvents?.()
      if (subscriptionId) void window.mahas.exec.unsubscribe(subscriptionId)
    })
  }
}

let caller: OpCaller | null = null
let subscriber: OpSubscriber | null = null

/** the caller every view composes over — the desktop exec:* adapter unless
 //  IMP-30/tests injected another transport. */
export function workbenchCaller(): OpCaller {
  caller ??= desktopOpCaller()
  return caller
}

export function workbenchSubscriber(): OpSubscriber {
  subscriber ??= desktopOpSubscriber()
  return subscriber
}

/** injection seam — a real connectRpc call (or a test double) drops in
 //  without touching view code. Passing null restores the desktop default. */
export function setWorkbenchCaller(c: OpCaller | null): void {
  caller = c
}

export function setWorkbenchSubscriber(s: OpSubscriber | null): void {
  subscriber = s
}

/** REQ-14 idempotency key for a mutation call */
export function newOperationId(): string {
  return crypto.randomUUID()
}
