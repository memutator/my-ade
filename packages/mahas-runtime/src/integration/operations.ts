// integration/operations.ts — the AdapterPack operation surface.
//
// Operation ownership (SHARED-APIS: cross-domain work goes through the
// OperationRegistry, never sibling imports):
//
//   integration.pack.register       operator  mutation  EFFECT OUTSIDE TX
//   integration.pack.list           operator  query
//   integration.capability.state    operator  query
//   integration.capability.check    operator  mutation  EFFECT OUTSIDE TX
//   integration.capability.invoke   service   query     (no transaction)
//
// The two mutations declare `deferEffects: 'outside-transaction'`
// (admission.deferredSpec): a snapshot materialization and a conformance run
// spawn filesystem writes and CHILD PROCESSES, which must not happen with
// BEGIN holding the single writer. Admission therefore
//
//   1. persists a durable admitted request (effect_intents row) and COMMITS,
//   2. runs the handler here with NO transaction / NO serialization held,
//   3. runs the returned `complete(txn)` closure in a second transaction that
//      commits the domain rows + events + the operation receipt together.
//
// A failure that provably applied nothing (bad manifest, unknown capability,
// unreadable fixture) is raised as MahasError from the effect phase: admission
// releases the durable admission and answers with an unpersisted rejection, so
// the caller can retry 'same-operation'. Anything else leaves the admission in
// the pending set for reconcile — never silently re-executed.
//
// `integration.capability.invoke` is a QUERY that spawns a child too: it is
// declared `longPoll` (admission's sanctioned "no BEGIN around the handler"),
// which for a query means autocommit reads — no receipt is written, so the
// longPoll shortcut cannot hide a half-committed mutation.

import type { IntegrationContract } from '../../../mahas-contracts/src/integration/index.ts'
import { asDeferredHandler, deferredSpec } from '../api/admission.ts'
import type { OperationHandler, OperationSpec } from '../api/registry.ts'
import { mahasError } from '../api/handler-ports.ts'
import { evaluateCapabilityCheck, recordCapabilityCheck } from './conformance.ts'
import { PackRegistry, PackRegistryError } from './registry.ts'
import { PackRunnerError, runPack, type PackRunRequest } from './runner.ts'
import { INTEGRATION_CAPABILITIES, type IntegrationCapability } from './types.ts'

export const INTEGRATION_OPERATION_NAMES = {
  packRegister: 'integration.pack.register',
  packList: 'integration.pack.list',
  capabilityState: 'integration.capability.state',
  capabilityCheck: 'integration.capability.check',
  capabilityInvoke: 'integration.capability.invoke'
} as const

export interface IntegrationOperationRegistry {
  register(spec: OperationSpec, handler: OperationHandler): void
}

export interface IntegrationOperationDeps {
  packs: PackRegistry
  /** canonical resolver: createCanonicalContractRegistry() from ./contracts.ts */
  resolveContract(id: string, revision: number): IntegrationContract | null
}

function record(value: unknown, name = 'payload'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw mahasError('MODEL_INVALID', `${name} must be an object`, 'none')
  }
  return value as Record<string, unknown>
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw mahasError('MODEL_INVALID', `${name} must be a non-empty string`, 'none')
  return value
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw mahasError('MODEL_INVALID', `${name} must be a positive integer`, 'none')
  return Number(value)
}

function capability(value: unknown): IntegrationCapability {
  if (!INTEGRATION_CAPABILITIES.includes(value as IntegrationCapability))
    throw mahasError('MODEL_INVALID', 'capability is unknown', 'none')
  return value as IntegrationCapability
}

/**
 * Pack-layer failures → the shared error taxonomy (spec/common.md §4). There
 * is no generic NOT_FOUND code, so:
 *   PACK_NOT_FOUND      → IMPLEMENTATION_MISSING (the named implementation
 *                         does not exist here) — retry 'none'
 *   IMMUTABLE_REVISION  → STALE_REVISION (the revision already exists with
 *                         different content; only a new revision may be
 *                         published) — retry 'none'
 *   CONTENT_DRIFT       → ARTIFACT_MISMATCH (a stored snapshot no longer
 *                         matches its digest; integrity, not business) —
 *                         retry 'reconcile'
 *   INVALID_MANIFEST    → MODEL_INVALID
 * Runner failures: an invalid request is a payload problem, an unsupported
 * capability has no implementation, and a forbidden conformance invocation is
 * a caller mistake — never a Pack verdict.
 */
function translate(error: unknown): never {
  if (error instanceof PackRegistryError) {
    switch (error.code) {
      case 'PACK_NOT_FOUND':
        throw mahasError('IMPLEMENTATION_MISSING', error.message, 'none')
      case 'IMMUTABLE_REVISION':
        throw mahasError('STALE_REVISION', error.message, 'none')
      case 'CONTENT_DRIFT':
        throw mahasError('ARTIFACT_MISMATCH', error.message, 'reconcile')
      case 'INVALID_MANIFEST':
        throw mahasError('MODEL_INVALID', error.message, 'none')
    }
  }
  if (error instanceof PackRunnerError) {
    switch (error.code) {
      case 'INVALID_REQUEST':
        throw mahasError('MODEL_INVALID', error.message, 'none')
      case 'UNSUPPORTED':
      case 'RUNNER_UNSUPPORTED':
        throw mahasError('IMPLEMENTATION_MISSING', error.message, 'none')
      case 'EFFECTFUL_CHECK_FORBIDDEN':
        throw mahasError('INVALID_TRANSITION', error.message, 'none')
    }
  }
  throw error
}

const objectInput = (
  required: readonly string[],
  properties: Record<string, unknown>
): unknown => ({
  type: 'object',
  required,
  properties,
  additionalProperties: false
})

/**
 * Operator operations manage immutable Pack revisions and explicit conformance.
 * The service-only invoke operation is the scheduler seam; it never commits Pack
 * output to a domain repository by itself.
 */
export function registerIntegrationOperations(
  operations: IntegrationOperationRegistry,
  deps: IntegrationOperationDeps
): void {
  operations.register(
    deferredSpec({
      name: INTEGRATION_OPERATION_NAMES.packRegister,
      visibility: 'operator',
      mutation: true,
      summary: 'snapshot and register one immutable AdapterPack revision',
      inputSchema: objectInput(['directory'], { directory: { type: 'string' } })
    }),
    // effect phase — filesystem only, no transaction open
    asDeferredHandler(async (effect) => {
      const directory = string(record(effect.payload).directory, 'directory')
      let prepared
      try {
        prepared = deps.packs.prepareRegistration(directory)
      } catch (error) {
        return translate(error)
      }
      const published = prepared.existing === null
      return {
        // completion transaction — rows + receipt in one COMMIT
        complete: (txn) => {
          const registered = deps.packs.commitRegistration(prepared)
          if (published) {
            txn.emitEvent({
              aggregateId: registered.packId,
              aggregateRevision: registered.revision,
              eventType: 'integration.pack.registered',
              payload: {
                packId: registered.packId,
                revision: registered.revision,
                contentDigest: registered.contentDigest
              }
            })
          }
          return registered
        }
      }
    })
  )

  operations.register(
    {
      name: INTEGRATION_OPERATION_NAMES.packList,
      visibility: 'operator',
      mutation: false,
      summary: 'list registered immutable AdapterPack revisions',
      inputSchema: objectInput([], {})
    },
    () => deps.packs.list()
  )

  operations.register(
    {
      name: INTEGRATION_OPERATION_NAMES.capabilityState,
      visibility: 'operator',
      mutation: false,
      summary: 'inspect support and conformance state for one Pack capability',
      inputSchema: objectInput(['packId', 'revision', 'capability'], {
        packId: { type: 'string' },
        revision: { type: 'integer' },
        capability: { type: 'string' }
      })
    },
    (_txn, raw) => {
      const input = record(raw)
      return deps.packs.capabilityState(
        string(input.packId, 'packId'),
        integer(input.revision, 'revision'),
        capability(input.capability)
      )
    }
  )

  operations.register(
    deferredSpec({
      name: INTEGRATION_OPERATION_NAMES.capabilityCheck,
      visibility: 'operator',
      mutation: true,
      summary: 'perform an explicit capability-scoped Pack conformance check',
      inputSchema: objectInput(
        ['packId', 'revision', 'capability', 'contractId', 'contractRevision'],
        {
          packId: { type: 'string' },
          revision: { type: 'integer' },
          capability: { type: 'string' },
          contractId: { type: 'string' },
          contractRevision: { type: 'integer' },
          runCases: { type: 'boolean' },
          target: { type: 'object' }
        }
      ),
      // the check is scoped to one immutable Pack revision
      resolveTargets: (_txn, raw) => {
        const input = record(raw)
        return [{ kind: 'packRevision', id: `${String(input.packId)}@${String(input.revision)}` }]
      }
    }),
    // effect phase — reads Pack files and spawns fixture children, no transaction open
    asDeferredHandler(async (effect) => {
      const input = record(effect.payload)
      const packId = string(input.packId, 'packId')
      const revision = integer(input.revision, 'revision')
      const selectedCapability = capability(input.capability)
      const contractId = string(input.contractId, 'contractId')
      const contractRevision = integer(input.contractRevision, 'contractRevision')
      const contract = deps.resolveContract(contractId, contractRevision)
      if (!contract) {
        throw mahasError(
          'MODEL_INVALID',
          `integration contract ${contractId}@${contractRevision} is not registered`,
          'none'
        )
      }
      let plan
      try {
        plan = await evaluateCapabilityCheck(
          deps.packs,
          packId,
          revision,
          selectedCapability,
          contract,
          {
            runCases: input.runCases === true,
            ...(input.target ? { target: input.target as never } : {})
          }
        )
      } catch (error) {
        return translate(error)
      }
      return {
        complete: (txn) => {
          const checked = recordCapabilityCheck(deps.packs, plan)
          txn.emitEvent({
            aggregateId: packId,
            aggregateRevision: revision,
            eventType: 'integration.capability.checked',
            payload: { capability: selectedCapability, ...checked }
          })
          return checked
        }
      }
    })
  )

  operations.register(
    {
      name: INTEGRATION_OPERATION_NAMES.capabilityInvoke,
      visibility: 'service',
      mutation: false,
      // spawns a child process: admission must not hold BEGIN across it
      longPoll: true,
      summary: 'invoke one pinned Pack capability without committing its output',
      inputSchema: objectInput(['request'], { request: { type: 'object' } })
    },
    async (_txn, raw) => {
      try {
        return await runPack(deps.packs, record(raw).request as PackRunRequest)
      } catch (error) {
        return translate(error)
      }
    }
  )
}
