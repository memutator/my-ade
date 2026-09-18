// resources/mod.ts — C-RESOURCE operation registration seam.
//
// IMP-16 owns workspace.prepare / workspace.inspect / claim.handoff /
// claim.release. IMP-30 wires the surface by calling
//   registerResourceOps(registry, deps)
// — nothing self-registers at import time (SHARED-APIS §IMP-11 pattern).
// Each spec carries resolveTargets so admission authorizes the ACTUAL
// targets (D-ACCESS §2: payload intent is never the auth basis).
//
// deps is deliberately narrow: the only cross-boundary reach this service
// needs is a HostClient for physical effects (IMP-17's
// packages/mahas-runtime/src/hostClient.ts). Everything else stays inside
// the operation's own transaction on the control DB.

import type { OperationRegistry } from '../api/registry.ts'
import type { HostClient } from '../hostClient.ts'
import type { Id } from '../../../mahas-contracts/src/common.ts'
import {
  workspaceInspectHandler,
  workspaceInspectTargets,
  workspacePrepareHandler,
  workspacePrepareTargets
} from './workspace.ts'
import { claimHandoffHandler, claimHandoffTargets } from './transfer.ts'
import { claimReleaseHandler, claimReleaseTargets } from './release.ts'

export interface ResourceDeps {
  /**
   * Resolve a connected HostClient for a control-mirror execution_hosts.id.
   * Implementations (IMP-17/30) own endpoint lookup + lease negotiation; this
   * service only names the host the checkout lives on.
   */
  hostClient(hostId: Id): Promise<HostClient>
  /** host used when placementIntent.hostId is absent — the local default */
  defaultHostId: Id
  /** authority clock, epoch-ms (default Date.now) */
  now?(): number
}

/** ResourceDeps with defaults applied — what the handlers consume */
export interface ResolvedResourceDeps extends ResourceDeps {
  now(): number
}

/**
 * Register all four C-RESOURCE operations. OperationSpec.visibility choices:
 * prepare/inspect/handoff are member-scope ops (placement 팀장·launch
 * service·조율); release is operator-scope (자원 처분 권한자). Flagged for
 * IMP-11/IMP-30 review — adjust visibility there if the surface taxonomy
 * lands differently; the handlers do not depend on it.
 */
export function registerResourceOps(registry: OperationRegistry, deps: ResourceDeps): void {
  const d: ResolvedResourceDeps = {
    hostClient: deps.hostClient,
    defaultHostId: deps.defaultHostId,
    now: deps.now ?? (() => Date.now())
  }

  registry.register(
    {
      name: 'workspace.prepare',
      visibility: 'member',
      mutation: true,
      summary: 'reserve a write claim on a canonical checkout and materialize it on the host',
      resolveTargets: workspacePrepareTargets
    },
    (txn, payload) => workspacePrepareHandler(txn, payload, d)
  )
  registry.register(
    {
      name: 'workspace.inspect',
      visibility: 'member',
      mutation: false,
      summary: 'checkout identity, claims, dirtiness evidence and retain reasons for a workspace',
      resolveTargets: workspaceInspectTargets
    },
    (txn, payload) => workspaceInspectHandler(txn, payload, d)
  )
  registry.register(
    {
      name: 'claim.handoff',
      visibility: 'member',
      mutation: true,
      summary: 'explicit write-claim ownership transfer after old-writer quiescence',
      resolveTargets: claimHandoffTargets
    },
    (txn, payload) => claimHandoffHandler(txn, payload, d)
  )
  registry.register(
    {
      name: 'claim.release',
      visibility: 'operator',
      mutation: true,
      summary: 'release/retain/abandon a resource claim with retention + liveness checks',
      resolveTargets: claimReleaseTargets
    },
    (txn, payload) => claimReleaseHandler(txn, payload, d)
  )
}
