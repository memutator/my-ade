// mahas-runtime rpc — the `operation.get` operation (spec/contracts/
// mail-artifacts.md, IMP-12's 담당 operation).
//
// After a timeout or a connection drop the caller holds an operationId and
// an ambiguous outcome. operation.get is the ONLY sanctioned reconciliation
// path: it returns the stored CommandReceipt for (principalScope, operation,
// operationId) — never re-invokes the operation, never turns a timeout into
// a fresh mutation, and answers UNAVAILABLE_OPERATION for a key that is not
// in the caller's own scope so receipt existence across principals is not
// revealed (spec/common.md §2–3, C-MAIL "재호출 없이 상태 조회").

import type { DatabaseSync } from 'node:sqlite'
import type {
  AuthenticatedContext,
  CommandReceipt,
  MahasError
} from '../../../mahas-contracts/src/index.ts'
import { mahasError } from './framing.ts'

/**
 * Signature-compatible with IMP-03's `findReceipt` (SHARED-APIS:
 * `findReceipt(db, principalScope, operation, operationId) → CommandReceipt
 * | null`, operation_receipts read path). Injected rather than imported so
 * the composition root wires IMP-03's real implementation the moment it
 * lands — this file does not smuggle a second receipt store.
 */
export type ReceiptLookup = (
  db: DatabaseSync,
  principalScope: string,
  operation: string,
  operationId: string
) => CommandReceipt | null

/**
 * How a receipt's row scope is derived from the caller's context. Default
 * is the principal id — IMP-11's dispatch computes the SAME scope when it
 * persists receipts; if its derivation differs (e.g. member-scoped), the
 * composition root MUST pass IMP-11's own function here or operation.get
 * will not find receipts dispatch wrote.
 */
export type PrincipalScopeOf = (ctx: AuthenticatedContext) => string

export interface OperationGetDeps {
  findReceipt: ReceiptLookup
  principalScope?: PrincipalScopeOf
}

/**
 * Structural twin of IMP-11's registration port — an OperationRegistry
 * instance satisfies this. Spec fields mirror SHARED-APIS OperationSpec.
 */
export interface OperationRegistrar {
  register(
    spec: {
      name: string
      visibility: 'operator' | 'member' | 'service' | 'host'
      mutation: boolean
    },
    handler: (txn: { db: DatabaseSync; ctx: AuthenticatedContext }, payload: unknown) => unknown
  ): void
}

export const OPERATION_GET_SPEC = {
  name: 'operation.get',
  visibility: 'member',
  mutation: false
} as const

export function defaultPrincipalScope(ctx: AuthenticatedContext): string {
  return String(ctx.principalId)
}

function invalidPayload(): MahasError {
  return mahasError('MODEL_INVALID', 'operation.get payload must be {operation, operationId}')
}

/**
 * Register operation.get on `registry`. The handler runs inside the
 * registry's normal admission pipeline (visibility → authorize →
 * idempotency → tx), so the "current read rights" requirement is enforced
 * by admission itself — this handler only needs the scope-narrowed lookup.
 */
export function registerOperationGet(registry: OperationRegistrar, deps: OperationGetDeps): void {
  const scopeOf = deps.principalScope ?? defaultPrincipalScope
  registry.register(OPERATION_GET_SPEC, (txn, payload) => {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw invalidPayload()
    }
    const p = payload as Record<string, unknown>
    if (typeof p.operation !== 'string' || p.operation.length === 0) throw invalidPayload()
    if (typeof p.operationId !== 'string' || p.operationId.length === 0) throw invalidPayload()

    const receipt = deps.findReceipt(txn.db, scopeOf(txn.ctx), p.operation, p.operationId)
    if (receipt === null) {
      // own-scope miss: never issued, belongs to another principal, or the
      // write never committed — the caller cannot tell these apart, and
      // must not (spec §2: existence across scopes is not revealed)
      throw mahasError(
        'UNAVAILABLE_OPERATION',
        `no receipt for ${p.operation}/${p.operationId} in this scope`,
        'none'
      )
    }
    return receipt
  })
}
