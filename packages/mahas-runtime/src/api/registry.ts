// api/registry.ts — the server-side operation registry (IMP-11 owns).
//
// packages/SHARED-APIS.md pins this file's public contract:
//   TxnContext, OperationHandler, OperationSpec {name,visibility,mutation},
//   OperationRegistry {register, describe(ctx): CommandSurface,
//                      dispatch(ctx, req): Promise<CommandReceipt>},
//   makeCaller(registry, ctx), OPERATION_NAMES.
// The supporting types live in handler-ports.ts and are re-exported here so
// consumers import everything from the one promised path.
//
//   • register() connects name·schema·target resolver·handler·event surface
//     for each operation (instruction §4.1); business handlers themselves are
//     owned by each domain IMP.
//   • dispatch() is the single admission every transport shares (C-ACCESS) —
//     the pipeline lives in admission.ts.
//   • describe() is the registry's authoritative CommandSurface projection —
//     role ceiling ∩ current grants (IMP-10 surfaceFor) ∩ registered and
//     implemented operations (surface.ts). CLI guide/help/schema/completion/
//     MCP lists are generated from THIS, never from a second dictionary.
//   • C-HOST service-only operations are simply never registered in a
//     worker-facing registry — they answer UNAVAILABLE_OPERATION like any
//     other unknown name.
//
// Peer value-imports are NOT static: IMP-03 (storage/db.ts) and IMP-10
// (access/authorize.ts) land in parallel, so registry.ts binds them through
// the async createOperationRegistry() factory — which keeps this module
// loadable and lets tests inject boundary doubles.

import { randomUUID } from 'node:crypto'
import { INTEGRATION_DOMAIN_OPERATIONS } from '../../../mahas-contracts/src/operations/domains.ts'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AuthenticatedContext,
  CommandReceipt,
  CommandRequest,
  CommandSurface
} from '../../../mahas-contracts/src/index.ts'
import { runAdmission } from './admission.ts'
import { describeSurface, projectCommandSurface } from './surface.ts'
import { mahasError, OperationCallError } from './handler-ports.ts'
import type {
  AccessBoundary,
  OperationHandler,
  OperationRegistryDeps,
  OperationSpec,
  RegisteredOperation,
  StorageBoundary
} from './handler-ports.ts'

export type {
  AccessBoundary,
  AdmissionTrace,
  DomainEventInput,
  EffectIntentInput,
  OperationHandler,
  OperationRegistryDeps,
  OperationSpec,
  OperationVisibility,
  RegisteredOperation,
  StorageBoundary,
  TargetRef,
  TxnContext
} from './handler-ports.ts'
export { OperationCallError, isMahasError, mahasError } from './handler-ports.ts'
export {
  canonicalJson,
  currentEventCursor,
  fingerprintPayload,
  principalScopeOf,
  runInTransaction
} from './admission.ts'
export { projectCommandSurface } from './surface.ts'
export type { SurfaceDescribeInput } from './surface.ts'
export type { SurfaceDescribeResult, SurfaceOperationDescriptor } from './surface.ts'

// ── operation name 정본 (spec/operations.md — 93 entries, F-025 추가 runtime.unsubscribe) ────────────────────
// IMP-02 may also export name constants; until it lands this table is the
// contract. 'contract' records the C-* authority for each operation so
// registrations/traces can link back without reading the spec table again.

export interface OperationNameEntry {
  name: string
  contract: string
  owner: string
}

export const OPERATION_TABLE: readonly OperationNameEntry[] = [
  ...INTEGRATION_DOMAIN_OPERATIONS,
  { name: 'project.create', contract: 'C-MODEL', owner: 'IMP-04' },
  { name: 'project.get', contract: 'C-MODEL', owner: 'IMP-04' },
  { name: 'model.snapshot', contract: 'C-MODEL', owner: 'IMP-04' },
  { name: 'model.change.prepare', contract: 'C-MODEL', owner: 'IMP-04' },
  { name: 'model.change.commit', contract: 'C-MODEL', owner: 'IMP-04' },
  { name: 'model.impact.list', contract: 'C-MODEL', owner: 'IMP-27' },
  { name: 'model.impact.classify', contract: 'C-MODEL', owner: 'IMP-27' },
  { name: 'responsibility.search', contract: 'C-DISCOVERY', owner: 'IMP-06' },
  { name: 'responsibility.inspect', contract: 'C-DISCOVERY', owner: 'IMP-06' },
  { name: 'responsibility.locate', contract: 'C-DISCOVERY', owner: 'IMP-06' },
  { name: 'responsibility.collaborators', contract: 'C-DISCOVERY', owner: 'IMP-06' },
  { name: 'role.implementations', contract: 'C-DISCOVERY', owner: 'IMP-06' },
  { name: 'assignment.preview', contract: 'C-DISCOVERY', owner: 'IMP-13' },
  { name: 'interface.get', contract: 'C-REALIZATION', owner: 'IMP-07' },
  { name: 'implementation.prepare', contract: 'C-REALIZATION', owner: 'IMP-07' },
  { name: 'implementation.publish', contract: 'C-REALIZATION', owner: 'IMP-07' },
  { name: 'implementation.retire', contract: 'C-REALIZATION', owner: 'IMP-07' },
  { name: 'harness.profile.register', contract: 'C-REALIZATION', owner: 'IMP-07' },
  { name: 'harness.profile.inspect', contract: 'C-REALIZATION', owner: 'IMP-07' },
  { name: 'harness.profile.admit', contract: 'C-REALIZATION', owner: 'IMP-07' },
  { name: 'context.build', contract: 'C-REALIZATION', owner: 'IMP-08' },
  { name: 'context.inspect', contract: 'C-REALIZATION', owner: 'IMP-09' },
  { name: 'surface.describe', contract: 'C-ACCESS', owner: 'IMP-11' },
  { name: 'access.policy.publish', contract: 'C-ACCESS', owner: 'IMP-10' },
  { name: 'access.grant', contract: 'C-ACCESS', owner: 'IMP-10' },
  { name: 'access.revoke', contract: 'C-ACCESS', owner: 'IMP-10' },
  { name: 'access.inspect', contract: 'C-ACCESS', owner: 'IMP-10' },
  { name: 'run.create', contract: 'C-WORK', owner: 'IMP-13' },
  { name: 'run.get', contract: 'C-WORK', owner: 'IMP-13' },
  { name: 'run.close', contract: 'C-WORK', owner: 'IMP-13' },
  { name: 'plan.prepare', contract: 'C-WORK', owner: 'IMP-13' },
  { name: 'plan.commit', contract: 'C-WORK', owner: 'IMP-13' },
  { name: 'team.assign', contract: 'C-WORK', owner: 'IMP-13' },
  { name: 'team.retire', contract: 'C-WORK', owner: 'IMP-13' },
  { name: 'assignment.show', contract: 'C-WORK', owner: 'IMP-13' },
  { name: 'task.accept', contract: 'C-WORK', owner: 'IMP-20' },
  { name: 'task.report', contract: 'C-WORK', owner: 'IMP-21' },
  { name: 'outcome.decide', contract: 'C-WORK', owner: 'IMP-21' },
  { name: 'inbox.check', contract: 'C-MAIL', owner: 'IMP-15' },
  { name: 'inbox.wait', contract: 'C-MAIL', owner: 'IMP-15' },
  { name: 'delivery.ack', contract: 'C-MAIL', owner: 'IMP-15' },
  { name: 'message.send', contract: 'C-MAIL', owner: 'IMP-15' },
  { name: 'message.replyAndAck', contract: 'C-MAIL', owner: 'IMP-15' },
  { name: 'artifact.publish', contract: 'C-MAIL', owner: 'IMP-15' },
  { name: 'artifact.read', contract: 'C-MAIL', owner: 'IMP-15' },
  { name: 'operation.get', contract: 'C-MAIL', owner: 'IMP-12' },
  { name: 'worker.prepare', contract: 'C-LAUNCH', owner: 'IMP-19' },
  { name: 'worker.start', contract: 'C-LAUNCH', owner: 'IMP-19' },
  { name: 'worker.inspect', contract: 'C-LAUNCH', owner: 'IMP-19' },
  { name: 'execution.join', contract: 'C-LAUNCH', owner: 'IMP-20' },
  { name: 'execution.heartbeat', contract: 'C-LAUNCH', owner: 'IMP-20' },
  { name: 'worker.stop', contract: 'C-LAUNCH', owner: 'IMP-22' },
  { name: 'worker.resume', contract: 'C-LAUNCH', owner: 'IMP-22' },
  { name: 'worker.release', contract: 'C-LAUNCH', owner: 'IMP-22' },
  { name: 'execution.wake', contract: 'C-LAUNCH', owner: 'IMP-21' },
  { name: 'host.hello', contract: 'C-HOST', owner: 'IMP-17' },
  { name: 'host.acquire', contract: 'C-HOST', owner: 'IMP-17' },
  { name: 'host.inventory', contract: 'C-HOST', owner: 'IMP-17' },
  { name: 'host.effect.get', contract: 'C-HOST', owner: 'IMP-17' },
  { name: 'host.process.spawn', contract: 'C-HOST', owner: 'IMP-18' },
  { name: 'host.process.probe', contract: 'C-HOST', owner: 'IMP-18' },
  { name: 'host.process.stop', contract: 'C-HOST', owner: 'IMP-18' },
  { name: 'host.terminal.attach', contract: 'C-HOST', owner: 'IMP-18' },
  { name: 'host.terminal.input', contract: 'C-HOST', owner: 'IMP-18' },
  { name: 'host.terminal.resize', contract: 'C-HOST', owner: 'IMP-18' },
  { name: 'host.terminal.snapshot', contract: 'C-HOST', owner: 'IMP-18' },
  { name: 'host.terminal.detach', contract: 'C-HOST', owner: 'IMP-18' },
  { name: 'host.workspace.prepare', contract: 'C-HOST', owner: 'IMP-16' },
  { name: 'host.workspace.probe', contract: 'C-HOST', owner: 'IMP-16' },
  { name: 'host.workspace.release', contract: 'C-HOST', owner: 'IMP-16' },
  { name: 'workspace.prepare', contract: 'C-RESOURCE', owner: 'IMP-16' },
  { name: 'workspace.inspect', contract: 'C-RESOURCE', owner: 'IMP-16' },
  { name: 'claim.handoff', contract: 'C-RESOURCE', owner: 'IMP-16' },
  { name: 'claim.release', contract: 'C-RESOURCE', owner: 'IMP-16' },
  { name: 'runtime.status', contract: 'C-RECOVERY', owner: 'IMP-23' },
  { name: 'runtime.reconcile', contract: 'C-RECOVERY', owner: 'IMP-23' },
  { name: 'runtime.shutdown', contract: 'C-RECOVERY', owner: 'IMP-23' },
  { name: 'backup.create', contract: 'C-RECOVERY', owner: 'IMP-29' },
  { name: 'backup.restore', contract: 'C-RECOVERY', owner: 'IMP-29' },
  { name: 'observation.ingest', contract: 'C-OBSERVATION', owner: 'IMP-26' },
  { name: 'intervention.raise', contract: 'C-OBSERVATION', owner: 'IMP-26' },
  { name: 'intervention.resolve', contract: 'C-OBSERVATION', owner: 'IMP-26' },
  { name: 'runtime.snapshot', contract: 'C-OBSERVATION', owner: 'IMP-26' },
  { name: 'runtime.subscribe', contract: 'C-OBSERVATION', owner: 'IMP-26' },
  { name: 'runtime.unsubscribe', contract: 'C-OBSERVATION', owner: 'IMP-26' },
  { name: 'terminal.attach', contract: 'C-CLIENT', owner: 'IMP-28' },
  { name: 'terminal.input', contract: 'C-CLIENT', owner: 'IMP-28' },
  { name: 'terminal.resize', contract: 'C-CLIENT', owner: 'IMP-28' },
  { name: 'terminal.snapshot', contract: 'C-CLIENT', owner: 'IMP-28' },
  { name: 'terminal.detach', contract: 'C-CLIENT', owner: 'IMP-28' },
  { name: 'client.view.bind', contract: 'C-CLIENT', owner: 'IMP-28' },
  { name: 'client.view.unbind', contract: 'C-CLIENT', owner: 'IMP-28' },
  { name: 'task.dispatch', contract: 'C-WORK', owner: 'IMP-21' }
] as const

export const OPERATION_NAMES: readonly string[] = OPERATION_TABLE.map((e) => e.name)

// ── registry ────────────────────────────────────────────────────────────────

const OPERATION_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/

export class OperationRegistry {
  private readonly deps: OperationRegistryDeps
  private readonly ops = new Map<string, RegisteredOperation>()

  constructor(deps: OperationRegistryDeps) {
    this.deps = deps
    // the operation this task owns (instruction §6) — present in every
    // registry; whether a principal sees it is IMP-10's surface decision.
    this.register(
      {
        name: 'surface.describe',
        visibility: 'member',
        mutation: false,
        summary: 'describe the caller-visible command surface and its digest',
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string' },
            expectedSurfaceDigest: { type: 'string' }
          },
          additionalProperties: false
        }
      },
      (txn, payload) => describeSurface(this.deps, this.ops, txn.ctx, payload)
    )
  }

  /**
   * Connect an operation's name/schema/target resolver/handler into the
   * single registry. `handler` may be omitted to pre-declare a spec — such
   * operations stay out of surfaces and dispatch as UNAVAILABLE_OPERATION.
   */
  register(spec: OperationSpec, handler?: OperationHandler): void {
    if (!OPERATION_NAME_PATTERN.test(spec.name)) {
      throw mahasError(
        'INVALID_TRANSITION',
        `operation name ${JSON.stringify(spec.name)} must be dotted lowerCamel segments`,
        'none'
      )
    }
    if (this.ops.has(spec.name)) {
      throw mahasError('INVALID_TRANSITION', `operation ${spec.name} is already registered`, 'none')
    }
    this.ops.set(spec.name, { spec, handler })
  }

  /** is this name registered (regardless of handler/visibility)? */
  has(operation: string): boolean {
    return this.ops.has(operation)
  }

  /**
   * The authoritative CommandSurface for this principal: IMP-10's
   * surfaceFor (role ceiling ∩ current grants) ∩ registered+implemented
   * operations, projected with canonical schemas and a fresh digest.
   */
  describe(ctx: AuthenticatedContext): CommandSurface {
    return projectCommandSurface(this.deps, this.ops, ctx)
  }

  /** the single admission pipeline every transport shares */
  dispatch(ctx: AuthenticatedContext, req: CommandRequest): Promise<CommandReceipt> {
    return runAdmission(this.deps, this.ops, ctx, req)
  }
}

// ── makeCaller — the internal cross-domain caller ────────────────────────────

/** protocolVersion stamped on internally-minted CommandRequests */
export const INTERNAL_PROTOCOL_VERSION = 'internal/1'

/**
 * Every service's route to a sibling domain: name-based dispatch through the
 * SAME admission pipeline (never a sibling import). A fresh operationId is
 * minted per call — internal calls are not client-idempotent; replay
 * semantics belong to the outer client request.
 */
export function makeCaller(
  registry: OperationRegistry,
  ctx: AuthenticatedContext
): (
  operation: string,
  payload?: unknown,
  expectedRevisions?: Record<string, number>
) => Promise<unknown> {
  return async (operation, payload, expectedRevisions) => {
    const receipt = await registry.dispatch(ctx, {
      protocolVersion: INTERNAL_PROTOCOL_VERSION,
      operation,
      operationId: `internal:${operation}:${randomUUID()}`,
      expectedRevisions,
      payload
    })
    if (receipt.status === 'committed') return receipt.result
    throw new OperationCallError(
      operation,
      receipt.error ??
        mahasError(
          'CONTROL_UNAVAILABLE',
          `operation ${operation} ended without a verdict (status ${receipt.status})`,
          'reconcile'
        )
    )
  }
}

// ── composition-root factory — binds the real peer boundaries ────────────────

/**
 * Bind IMP-03's storage helpers and IMP-10's access boundary to a registry.
 * Dynamic imports keep this module loadable while those peers are still in
 * flight; pass `overrides` to inject boundary doubles in tests.
 */
export async function createOperationRegistry(
  db: DatabaseSync,
  overrides?: {
    access?: AccessBoundary
    storage?: StorageBoundary
    trace?: OperationRegistryDeps['trace']
    clock?: OperationRegistryDeps['clock']
  }
): Promise<OperationRegistry> {
  const access =
    overrides?.access ?? ((await import('../access/authorize.ts')) as unknown as AccessBoundary)
  const storage =
    overrides?.storage ?? ((await import('../storage/db.ts')) as unknown as StorageBoundary)
  return new OperationRegistry({
    db,
    access,
    storage,
    trace: overrides?.trace,
    clock: overrides?.clock
  })
}
