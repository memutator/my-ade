// mahas-runtime/src/discovery/visibility.ts — the server-side visibility
// filter every discovery read passes through (access.md §2 applied to
// reads: "읽기에도 적용하여 list counts, 검색 snippets ... 를 타 scope로
// 유출하지 않는다").
//
// Each check delegates to IMP-10's `decide` — grant semantics stay owned
// by the access boundary; discovery only consumes the verdict. Results
// are cached per request so one candidate set costs one decision per
// distinct target, and denied items vanish silently (no counts/snippets).

import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import type { DiscoveryDeps } from './deps.ts'
import { asTargetRefs } from './deps.ts'
import { target } from './types.ts'
import type { DiscoveryTarget } from './types.ts'

export interface Visibility {
  /** op-level gate — throws on denial */
  require(extraTargets?: DiscoveryTarget[]): void
  boundaryVisible(boundaryId: string): boolean
  roleVisible(roleId: string, boundaryId: string): boolean
  runVisible(runId: string): boolean
}

export function makeVisibility(
  ctx: AuthenticatedContext,
  deps: DiscoveryDeps,
  operation: string,
  modelVersion: string,
  baseTargets: DiscoveryTarget[]
): Visibility {
  const boundaryCache = new Map<string, boolean>()
  const roleCache = new Map<string, boolean>()
  const runCache = new Map<string, boolean>()

  const boundaryVisible = (boundaryId: string): boolean => {
    let v = boundaryCache.get(boundaryId)
    if (v === undefined) {
      v = deps.decide(
        ctx,
        operation,
        asTargetRefs([
          ...baseTargets,
          target('modelVersion', modelVersion),
          target('boundary', boundaryId)
        ])
      ).allow
      boundaryCache.set(boundaryId, v)
    }
    return v
  }

  const roleVisible = (roleId: string, boundaryId: string): boolean => {
    let v = roleCache.get(roleId)
    if (v === undefined) {
      v =
        deps.decide(
          ctx,
          operation,
          asTargetRefs([
            ...baseTargets,
            target('modelVersion', modelVersion),
            target('boundary', boundaryId),
            target('role', roleId)
          ])
        ).allow && boundaryVisible(boundaryId)
      roleCache.set(roleId, v)
    }
    return v
  }

  const runVisible = (runId: string): boolean => {
    let v = runCache.get(runId)
    if (v === undefined) {
      v = deps.decide(ctx, operation, asTargetRefs([target('run', runId)])).allow
      runCache.set(runId, v)
    }
    return v
  }

  return {
    require(extra: DiscoveryTarget[] = []) {
      deps.authorize(
        ctx,
        operation,
        asTargetRefs([...baseTargets, target('modelVersion', modelVersion), ...extra])
      )
    },
    boundaryVisible,
    roleVisible,
    runVisible
  }
}
