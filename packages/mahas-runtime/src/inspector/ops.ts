// mahas-runtime/inspector — the workbench inspector's operation surface.
//
// IMP-32 (workbench): the role-configuration workbench consumes domain
// operations BY NAME through the collaboration op surface — never domain
// internals (packages/SHARED-APIS.md; spec/architecture.md §2 "workbench").
// This module pins the exact operation set the inspector is allowed to
// reach. Anything outside it is answered UNAVAILABLE_OPERATION without
// revealing whether the registry has it — the same refusal shape the
// server registry itself uses (spec/domains/access.md §3).
//
// The caller port matches the canonical client op surface: IMP-12's
// connectRpc().call and IMP-11's makeCaller share this signature, so the
// desktop (IMP-30 wiring) or the operator CLI can bind either without
// reshaping this module.

/** operations the role-configuration workbench consumes (spec/operations.md) */
export const WORKBENCH_INSPECTOR_OPS = [
  // C-REALIZATION (IMP-07/09) — role implementation authoring + effective context
  'interface.get',
  'implementation.prepare',
  'implementation.publish',
  'implementation.retire',
  'harness.profile.inspect',
  'context.inspect',
  // C-DISCOVERY (IMP-06) — published implementations for an interface
  'role.implementations',
  // C-ACCESS (IMP-10/11) — allowed-command surface vs actual grants
  'surface.describe',
  'access.inspect',
  // C-LAUNCH (IMP-19) — spawn plan + execution inspection (observation only;
  // worker.start is deliberately NOT here — the inspector never launches)
  'worker.prepare',
  'worker.inspect',
  // C-OBSERVATION (IMP-26) — authoritative snapshot/event projection
  'runtime.snapshot',
  'runtime.subscribe'
] as const

export type WorkbenchInspectorOp = (typeof WORKBENCH_INSPECTOR_OPS)[number]

export function isWorkbenchInspectorOp(op: string): op is WorkbenchInspectorOp {
  return (WORKBENCH_INSPECTOR_OPS as readonly string[]).includes(op)
}

/** mutation ops — REQ-14 requires an operationId; the IPC layer enforces it */
export const WORKBENCH_MUTATION_OPS: readonly WorkbenchInspectorOp[] = [
  'implementation.prepare',
  'implementation.publish',
  'implementation.retire',
  'worker.prepare'
]

export function isWorkbenchMutationOp(op: WorkbenchInspectorOp): boolean {
  return WORKBENCH_MUTATION_OPS.includes(op)
}

export interface InspectorOpCallOpts {
  /** REQ-14 idempotency key — required on every mutation */
  operationId?: string
  expectedRevisions?: Record<string, number>
}

/**
 * The op-surface port this module is written against. Same shape as
 * connectRpc().call (IMP-12) and the makeCaller() function (IMP-11):
 * `call(op, payload?, opts?)` resolves the operation RESULT (the receipt's
 * `result` field when the transport hands back a CommandReceipt envelope).
 */
export type InspectorOpCaller = (
  operation: string,
  payload?: unknown,
  opts?: InspectorOpCallOpts
) => Promise<unknown>

/**
 * Inspector error — keeps the server's verbatim ErrorCode. Collapsing
 * MANDATORY_COMPONENT_MISSING or SNAPSHOT_REQUIRED into 'UNKNOWN' would
 * hide the named refusals the contracts define (they are semantics, not
 * strings), so `code` stays a free-form string here.
 */
export interface InspectorError {
  code: string
  message: string
  retryable?: boolean
  details?: unknown
}

export type InspectorResult<T> = { ok: true; value: T } | { ok: false; error: InspectorError }

interface ErrorLike {
  code?: unknown
  message?: unknown
  retry?: unknown
  retryable?: unknown
  details?: unknown
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** map any thrown/returned failure into an InspectorError, verbatim code */
export function toInspectorError(e: unknown): InspectorError {
  if (isRecord(e)) {
    const err = e as ErrorLike
    const code = typeof err.code === 'string' ? err.code : 'UNKNOWN'
    const message =
      typeof err.message === 'string' ? err.message : 'operation failed without message'
    const retry = err.retry ?? err.retryable
    return {
      code,
      message,
      retryable: retry === 'same-operation' || retry === 'reconcile' || retry === true,
      details: err.details
    }
  }
  return { code: 'UNKNOWN', message: String(e) }
}

interface ReceiptLike {
  status?: unknown
  result?: unknown
  error?: unknown
  operationId?: unknown
}

/**
 * Some transports resolve the raw op result; others hand back the
 * CommandReceipt envelope. Unwrap the envelope honestly: a rejected
 * receipt is an InspectorError (never silent success), an
 * unknown/pending receipt stays an unknown outcome — REQ-14.
 */
function unwrapResult(v: unknown): InspectorResult<unknown> {
  if (isRecord(v) && typeof (v as ReceiptLike).status === 'string') {
    const r = v as ReceiptLike
    if (r.status === 'committed') return { ok: true, value: r.result }
    if (r.status === 'rejected') {
      return { ok: false, error: toInspectorError(r.error ?? 'operation rejected') }
    }
    // pending | unknown — the honest ambiguous outcome
    return {
      ok: false,
      error: {
        code: 'UNKNOWN',
        message: `operation outcome is '${r.status}' — re-check with operation.get before assuming`,
        retryable: true,
        details: v
      }
    }
  }
  return { ok: true, value: v }
}

/**
 * Invoke one workbench operation through the caller port. Throws are
 * converted to InspectorError; resolved CommandReceipt envelopes are
 * unwrapped. The result value is NOT interpreted here — narrowing to the
 * per-op envelope shape is the caller's cast (documented in protocol.ts).
 */
export async function invokeInspectorOp(
  call: InspectorOpCaller,
  op: WorkbenchInspectorOp,
  payload?: unknown,
  opts?: InspectorOpCallOpts
): Promise<InspectorResult<unknown>> {
  try {
    return unwrapResult(await call(op, payload, opts))
  } catch (e) {
    return { ok: false, error: toInspectorError(e) }
  }
}
