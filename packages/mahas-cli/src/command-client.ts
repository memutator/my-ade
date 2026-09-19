// mahas-cli command-client — invoke one operation and map the outcome to
// the spec/common.md §2 output rules: one JSON value on stdout, diagnostics
// on stderr, nonzero exit on error.
//
// REQ-14 rules wired here:
//   - the operationId is generated ONCE per invocation (or supplied via
//     --operation-id); on timeout or disconnect we print it and point at
//     `mahas operation get` — the client NEVER mints a fresh id and resends
//     a mutation;
//   - receipts are printed verbatim — a rejected or unknown receipt is the
//     truth about the operation, not something to soften;
//   - connect/handshake failures are CONTROL_UNAVAILABLE honesty: we do not
//     report the request as received when nothing answered it.

import { randomUUID } from 'node:crypto'
import type { CommandReceipt, MahasError } from '../../mahas-contracts/src/index.ts'
import { isMahasError, mahasError, type RpcClient } from '../../mahas-runtime/src/rpc/index.ts'

/** exit codes — stable for scripts and hooks (documented in `mahas help`) */
export const EXIT = {
  OK: 0,
  /** rejected receipt / operation-level failure */
  FAILED: 1,
  /** usage error, or the operation is not in your surface */
  USAGE: 2,
  /** control plane unreachable / socket dropped before answer */
  CONTROL_UNAVAILABLE: 3,
  /** credential refused */
  UNAUTHENTICATED: 4,
  /** outcome unknown — timeout/disconnect after the request was sent; reconcile via operation.get */
  UNKNOWN_OUTCOME: 5
} as const

export interface InvokeOptions {
  /** caller-fixed idempotency id — for re-asking after an ambiguous outcome */
  operationId?: string
  expectedRevisions?: Record<string, number>
  /** 0/undefined = wait forever (bounded waits belong in payload, e.g. inbox.wait maxWaitMs) */
  timeoutMs?: number
}

export type InvokeOutcome =
  | { kind: 'receipt'; receipt: CommandReceipt; operationId: string }
  | { kind: 'timeout'; operationId: string }
  | { kind: 'transport'; error: MahasError; operationId: string }

/**
 * Invoke `op` on `client` exactly once. On timeout the socket is closed
 * (the pending answer is abandoned, not retried) and the operationId is
 * returned so the caller can reconcile via operation.get.
 */
export async function invokeOperation(
  client: RpcClient,
  op: string,
  payload: unknown,
  opts: InvokeOptions = {}
): Promise<InvokeOutcome> {
  const operationId = opts.operationId ?? randomUUID()
  const call = client.call(op, payload, {
    operationId,
    expectedRevisions: opts.expectedRevisions
  })
  if (!opts.timeoutMs || opts.timeoutMs <= 0) {
    try {
      const receipt = await call
      return { kind: 'receipt', receipt, operationId }
    } catch (e) {
      return {
        kind: 'transport',
        error: isMahasError(e) ? e : mahasError('CONTROL_UNAVAILABLE', String(e)),
        operationId
      }
    }
  }
  let timer: NodeJS.Timeout | undefined
  try {
    const result = await Promise.race([
      call.then((receipt) => ({ kind: 'receipt' as const, receipt, operationId })),
      new Promise<{ kind: 'timeout'; operationId: string }>((res) => {
        timer = setTimeout(() => res({ kind: 'timeout', operationId }), opts.timeoutMs)
      })
    ])
    if (result.kind === 'timeout') client.close() // abandon the socket — never resend
    return result
  } catch (e) {
    return {
      kind: 'transport',
      error: isMahasError(e) ? e : mahasError('CONTROL_UNAVAILABLE', String(e)),
      operationId
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** print the receipt as the single JSON value on stdout */
export function emitReceipt(receipt: CommandReceipt): void {
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n')
}

/** diagnostic line for a failed/ambiguous outcome (stderr only) */
export function describeOutcome(outcome: InvokeOutcome, op: string): string {
  switch (outcome.kind) {
    case 'receipt':
      return outcome.receipt.error
        ? `${op}: ${outcome.receipt.status} — ${outcome.receipt.error.code}: ${outcome.receipt.error.message}`
        : `${op}: ${outcome.receipt.status}`
    case 'timeout':
      return (
        `${op}: timed out — outcome unknown; operationId=${outcome.operationId}\n` +
        `reconcile: mahas operation get --operation ${op} --operationId ${outcome.operationId}`
      )
    case 'transport':
      return (
        `${op}: ${outcome.error.code} — ${outcome.error.message} ` +
        `(operationId=${outcome.operationId})`
      )
  }
}

/** map an outcome to its exit code */
export function exitCodeFor(outcome: InvokeOutcome): number {
  switch (outcome.kind) {
    case 'timeout':
      return EXIT.UNKNOWN_OUTCOME
    case 'transport':
      return outcome.error.code === 'UNAUTHENTICATED'
        ? EXIT.UNAUTHENTICATED
        : EXIT.CONTROL_UNAVAILABLE
    case 'receipt': {
      const r = outcome.receipt
      if (r.status === 'committed') return EXIT.OK
      const code = r.error?.code
      if (code === 'UNAVAILABLE_OPERATION' || code === 'MODEL_INVALID') return EXIT.USAGE
      if (code === 'CONTROL_UNAVAILABLE') return EXIT.CONTROL_UNAVAILABLE
      if (code === 'UNAUTHENTICATED') return EXIT.UNAUTHENTICATED
      if (r.status === 'unknown' || r.status === 'pending') return EXIT.UNKNOWN_OUTCOME
      return EXIT.FAILED
    }
  }
}
