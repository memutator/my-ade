// api/surface.ts — CommandSurface projection + the `surface.describe` operation.
//
// Spec basis:
//   D-ACCESS §3     operation registry의 정본 schema에서 surface.describe를
//                   구성한다 — the registry projects the authoritative surface;
//                   worker binaries never carry the full admin schema.
//   C-ACCESS        --help/completion/schema/MCP lists are generated ONLY from
//                   the current surface; the same projection feeds all of them.
//   common.md §2    a hidden operation name answers UNAVAILABLE_OPERATION.
//   access-cli.md   surface.describe: query only; returns allowed command
//                   summary/schema + surfaceDigest; stale surface → new digest.
//
// The visible set is IMP-10's surfaceFor (role ceiling ∩ current grants); this
// module intersects it with REGISTERED + IMPLEMENTED operations (an action
// without a handler never enters a usable surface) and attaches the registry's
// canonical schemas. The projected digest is what ContextBundle/LaunchPlan/
// WorkerJoin pin as surfaceDigest — so the derived snapshot is persisted to
// command_surfaces for the FK to resolve.

import type { DatabaseSync } from 'node:sqlite'
import type { AuthenticatedContext, CommandSurface } from '../../../mahas-contracts/src/index.ts'
import { mahasError } from './handler-ports.ts'
import type { OperationRegistryDeps, OperationSpec, RegisteredOperation } from './handler-ports.ts'
import { canonicalJson } from './admission.ts'

/** per-operation descriptor carried in CommandSurface.schemas — what CLI
 *  help/schema/completion and MCP tool lists are generated from. */
export interface SurfaceOperationDescriptor {
  name: string
  summary: string | null
  mutation: boolean
  visibility: OperationSpec['visibility']
  inputSchema: unknown
  outputSchema: unknown
}

/** the JSON document persisted to command_surfaces.actions_and_schemas_json
 *  and covered by the surface digest */
export interface SurfaceActionsAndSchemas {
  effectiveActions: string[]
  schemas: Record<string, SurfaceOperationDescriptor>
}

/** policy evidence pinned alongside the projection
 *  (command_surfaces.policy_pins_json) */
export interface SurfacePolicyPins {
  rolePolicyRevision: unknown
  visibilityScope: unknown
  policyPins: unknown
}

/**
 * Registry-side describe(): surfaceFor(ctx) ∩ registered-with-handler, with
 * canonical schemas attached and a fresh digest over the projection.
 * IMP-02 owns the CommandSurface shape — the grant-derived fields are carried
 * through from surfaceFor's result; this projection only narrows
 * effectiveActions/schemas and re-digests so the digest covers exactly what
 * the worker sees.
 */
export function projectCommandSurface(
  deps: OperationRegistryDeps,
  ops: ReadonlyMap<string, RegisteredOperation>,
  ctx: AuthenticatedContext
): CommandSurface {
  const granted = deps.access.surfaceFor(ctx, deps.db)
  const grantedRecord = granted as unknown as Record<string, unknown>

  const schemas: Record<string, SurfaceOperationDescriptor> = {}
  const effectiveActions: string[] = []
  for (const name of [...ops.keys()].sort()) {
    const entry = ops.get(name)!
    if (!entry.handler) continue // 미구현 handler → usable surface 제외
    if (!deps.access.isOperationVisible(granted, name)) continue
    effectiveActions.push(name)
    schemas[name] = {
      name,
      summary: entry.spec.summary ?? null,
      mutation: entry.spec.mutation,
      visibility: entry.spec.visibility,
      inputSchema: entry.spec.inputSchema ?? null,
      outputSchema: entry.spec.outputSchema ?? null
    }
  }

  const actionsAndSchemas: SurfaceActionsAndSchemas = { effectiveActions, schemas }
  const policyPins: SurfacePolicyPins = {
    rolePolicyRevision: grantedRecord['rolePolicyRevision'] ?? null,
    visibilityScope: grantedRecord['visibilityScope'] ?? null,
    policyPins: grantedRecord['policyPins'] ?? null
  }
  const digest = deps.storage.sha256Hex(canonicalJson({ actionsAndSchemas, policyPins }))
  persistSurfaceSnapshot(deps.db, digest, actionsAndSchemas, policyPins)

  return {
    ...granted,
    digest,
    effectiveActions,
    schemas
  } as CommandSurface
}

/** derived immutable snapshot (S-STORAGE §2) — INSERT OR IGNORE: the digest is
 *  a content key, so an identical projection never rewrites the row. */
function persistSurfaceSnapshot(
  db: DatabaseSync,
  digest: string,
  actionsAndSchemas: SurfaceActionsAndSchemas,
  policyPins: SurfacePolicyPins
): void {
  db.prepare(
    `INSERT OR IGNORE INTO command_surfaces (digest, actions_and_schemas_json, policy_pins_json)
     VALUES (?, ?, ?)`
  ).run(digest, JSON.stringify(actionsAndSchemas), JSON.stringify(policyPins))
}

// ── surface.describe operation ───────────────────────────────────────────────

export interface SurfaceDescribeInput {
  operation?: string
  expectedSurfaceDigest?: string
}

export interface SurfaceDescribeResult {
  surfaceDigest: string
  /** true when the caller pinned a different digest — the fresh one is returned */
  stale: boolean
  operations: SurfaceOperationDescriptor[]
}

/**
 * The `surface.describe` handler (C-ACCESS — query only; UNAUTHENTICATED /
 * UNAVAILABLE_OPERATION are the only business denials). Bootstrap principals
 * reach it because IMP-10's surfaceFor includes it in the bootstrap surface —
 * no bootstrap branching lives here.
 */
export function describeSurface(
  deps: OperationRegistryDeps,
  ops: ReadonlyMap<string, RegisteredOperation>,
  ctx: AuthenticatedContext,
  payload: unknown
): SurfaceDescribeResult {
  const input = (payload ?? {}) as SurfaceDescribeInput
  const surface = projectCommandSurface(deps, ops, ctx)
  const surfaceRecord = surface as unknown as {
    effectiveActions?: unknown
    schemas?: unknown
  }
  const visible = Array.isArray(surfaceRecord.effectiveActions)
    ? (surfaceRecord.effectiveActions as string[])
    : []
  const schemas = (surfaceRecord.schemas ?? {}) as Record<string, SurfaceOperationDescriptor>
  const stale =
    input.expectedSurfaceDigest !== undefined && input.expectedSurfaceDigest !== surface.digest

  if (input.operation !== undefined) {
    if (!visible.includes(input.operation)) {
      // naming a hidden/unknown operation must not reveal which it is
      throw mahasError('UNAVAILABLE_OPERATION', `operation is not available`)
    }
    return { surfaceDigest: surface.digest, stale, operations: [schemas[input.operation]!] }
  }
  return {
    surfaceDigest: surface.digest,
    stale,
    operations: visible.map((name) => schemas[name]!)
  }
}
