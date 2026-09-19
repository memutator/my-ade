// mahas-runtime/src/discovery/deps.ts — the seam to peer boundaries.
//
// Discovery never imports sibling service internals (SHARED-APIS rule).
// Every cross-boundary function arrives here as an injected dependency
// whose signature is the coordinator-fixed one:
//   - IMP-10 ../access/authorize.ts : authorize / decide / TargetRef
//   - IMP-11 ../api/registry.ts     : OperationRegistry / TxnContext
// IMP-03's withTx is NOT needed — the registry already wraps handlers in
// the operation transaction (TxnContext.db).
//
// Composition (a later daemon task) wires these deps to the real modules;
// the smoke harness wires them to scoped fakes. registerDiscoveryOps fails
// fast when a required dep is absent — never a silent no-op path.

import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import type { TargetRef } from '../access/authorize.ts'
import type { DiscoveryTarget } from './types.ts'

export interface DiscoveryDeps {
  /**
   * IMP-10: throws MahasError SCOPE_DENIED / GRANT_REVOKED /
   * UNAUTHENTICATED on denial. Used for op-level scope checks.
   */
  authorize(ctx: AuthenticatedContext, operation: string, targets: TargetRef[]): void
  /**
   * IMP-10: non-throwing check used for the per-candidate visibility
   * filter — denied items are dropped without leaking their existence
   * (no hidden counts/snippets per C-DISCOVERY).
   */
  decide(ctx: AuthenticatedContext, operation: string, targets: TargetRef[]): { allow: boolean }
  /**
   * HMAC secret protecting selectionToken and page-cursor integrity.
   * Provided by the daemon's key configuration — this boundary does not
   * mint its own authority.
   */
  tokenSecret: string | Uint8Array
  /** optional key identifier stamped into issued tokens for rotation */
  tokenKeyId?: string
  /** clock — injected for deterministic tests; defaults to Date.now */
  now?(): number
}

export function requireDeps(deps: DiscoveryDeps): Required<DiscoveryDeps> {
  if (typeof deps?.authorize !== 'function')
    throw new Error('registerDiscoveryOps: deps.authorize (IMP-10) is required')
  if (typeof deps?.decide !== 'function')
    throw new Error('registerDiscoveryOps: deps.decide (IMP-10) is required')
  if (deps.tokenSecret === undefined || deps.tokenSecret === null)
    throw new Error('registerDiscoveryOps: deps.tokenSecret is required')
  return { now: () => Date.now(), ...deps } as Required<DiscoveryDeps>
}

/** structural bridge: DiscoveryTarget is TargetRef-shaped by design */
export function asTargetRefs(targets: DiscoveryTarget[]): TargetRef[] {
  return targets as unknown as TargetRef[]
}
