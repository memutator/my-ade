import type {
  HarnessInstallation,
  HarnessProviderBinding,
  InstallationRevision,
  Machine,
  ProviderConnection,
  ProviderCredential,
  ProviderIdentityClaim,
  QuotaPoolClaim
} from '../../../mahas-contracts/src/inventory/index.ts'
import type { OperationHandler, OperationSpec, TxnContext } from '../api/registry.ts'
import { mahasError } from '../api/handler-ports.ts'
import {
  appendInstallationRevision,
  getInventorySnapshot,
  putBinding,
  putIdentityClaim,
  putInstallation,
  putMachine,
  putProviderConnection,
  putQuotaPoolClaim,
  recordInventoryObservation,
  refreshCredential,
  registerCredential,
  replaceCredential,
  resolveInventoryRevisions,
  type InventoryObservationOutcome
} from './repository.ts'

export const INVENTORY_OPERATION_NAMES = {
  snapshot: 'inventory.snapshot',
  machinePut: 'inventory.machine.put',
  installationPut: 'inventory.installation.put',
  installationRevisionAppend: 'inventory.installationRevision.append',
  credentialRegister: 'inventory.credential.register',
  credentialRefresh: 'inventory.credential.refresh',
  credentialReplace: 'inventory.credential.replace',
  connectionPut: 'inventory.connection.put',
  identityClaimPut: 'inventory.identityClaim.put',
  quotaPoolClaimPut: 'inventory.quotaPoolClaim.put',
  bindingPut: 'inventory.binding.put',
  observationRecord: 'inventory.observation.record'
} as const

export interface InventoryOperationRegistry {
  register(spec: OperationSpec, handler: OperationHandler): void
}

function record(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw mahasError('MODEL_INVALID', `${field} must be an object`, 'none')
  }
  return raw as Record<string, unknown>
}

function reqString(source: Record<string, unknown>, field: string): string {
  const value = source[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw mahasError('MODEL_INVALID', `${field} must be a non-empty string`, 'none')
  }
  return value
}

function reqInteger(source: Record<string, unknown>, field: string): number {
  const value = source[field]
  if (!Number.isSafeInteger(value)) {
    throw mahasError('MODEL_INVALID', `${field} must be an integer`, 'none')
  }
  return value as number
}

function entity<T>(raw: unknown): T {
  const payload = record(raw, 'payload')
  const value = record(payload.value, 'payload.value')
  reqString(value, 'id')
  return value as T
}

function revisions(txn: TxnContext, ids: readonly string[]): Record<string, number | undefined> {
  return resolveInventoryRevisions(txn.db, ids)
}

function mutationSpec(name: string, summary: string): OperationSpec {
  return {
    name,
    visibility: 'operator',
    mutation: true,
    summary,
    resolveRevisions: revisions,
    inputSchema: {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'object', required: ['id'] } },
      additionalProperties: false
    }
  }
}

function putHandler<T>(
  eventType: string,
  write: (txn: TxnContext, value: T) => { value: T; revision: number }
): OperationHandler {
  return (txn, payload) => {
    const value = entity<T>(payload)
    const result = write(txn, value)
    txn.emitEvent({
      aggregateId: String((value as { id: string }).id),
      aggregateRevision: result.revision,
      eventType,
      payload: value
    })
    return result
  }
}

export function registerInventoryOperations(registry: InventoryOperationRegistry): void {
  registry.register(
    {
      name: INVENTORY_OPERATION_NAMES.snapshot,
      visibility: 'operator',
      mutation: false,
      summary: 'read persisted machines, installations, credentials, connections and histories'
    },
    (txn) => getInventorySnapshot(txn.db)
  )
  registry.register(
    mutationSpec(INVENTORY_OPERATION_NAMES.machinePut, 'observe or register a machine'),
    putHandler<Machine>('inventory.machine.put', (txn, value) => putMachine(txn.db, value))
  )
  registry.register(
    mutationSpec(
      INVENTORY_OPERATION_NAMES.installationPut,
      'observe or register a harness installation without deleting missing history'
    ),
    putHandler<HarnessInstallation>('inventory.installation.put', (txn, value) =>
      putInstallation(txn.db, value)
    )
  )
  registry.register(
    mutationSpec(
      INVENTORY_OPERATION_NAMES.installationRevisionAppend,
      'append immutable installation shape evidence'
    ),
    (txn, payload) => {
      const value = entity<InstallationRevision>(payload)
      appendInstallationRevision(txn.db, value)
      txn.emitEvent({
        aggregateId: value.installationId,
        aggregateRevision: value.revision,
        eventType: 'inventory.installation.revision-appended',
        payload: value
      })
      return value
    }
  )
  registry.register(
    mutationSpec(
      INVENTORY_OPERATION_NAMES.credentialRegister,
      'register a credential locator without storing secret material'
    ),
    putHandler<ProviderCredential>('inventory.credential.registered', (txn, value) =>
      registerCredential(txn.db, value)
    )
  )
  registry.register(
    {
      name: INVENTORY_OPERATION_NAMES.credentialRefresh,
      visibility: 'operator',
      mutation: true,
      summary: 'record a same-account material refresh using material revision CAS',
      resolveRevisions: revisions,
      inputSchema: {
        type: 'object',
        required: [
          'credentialId',
          'expectedMaterialRevision',
          'nextMaterialRevision',
          'observedAt',
          'accountContinuity'
        ],
        properties: {
          credentialId: { type: 'string' },
          expectedMaterialRevision: { type: 'integer' },
          nextMaterialRevision: { type: 'integer' },
          observedAt: { type: 'integer' },
          accountContinuity: { const: 'confirmed-same' },
          availability: { enum: ['available', 'unavailable', 'unknown'] }
        },
        additionalProperties: false
      }
    },
    (txn, raw) => {
      const payload = record(raw, 'payload')
      const credentialId = reqString(payload, 'credentialId')
      if (payload.accountContinuity !== 'confirmed-same') {
        throw mahasError(
          'INVALID_TRANSITION',
          'refresh requires confirmed-same account continuity; use credential.replace for a changed account',
          'none'
        )
      }
      const revision = refreshCredential(txn.db, {
        credentialId,
        expectedMaterialRevision: reqInteger(payload, 'expectedMaterialRevision'),
        nextMaterialRevision: reqInteger(payload, 'nextMaterialRevision'),
        observedAt: reqInteger(payload, 'observedAt'),
        accountContinuity: 'confirmed-same',
        availability: payload.availability as ProviderCredential['availability'] | undefined
      })
      txn.emitEvent({
        aggregateId: credentialId,
        aggregateRevision: revision,
        eventType: 'inventory.credential.refreshed',
        payload: { materialRevision: payload.nextMaterialRevision, observedAt: payload.observedAt }
      })
      return { credentialId, revision, materialRevision: payload.nextMaterialRevision }
    }
  )
  registry.register(
    {
      name: INVENTORY_OPERATION_NAMES.credentialReplace,
      visibility: 'operator',
      mutation: true,
      summary: 'split credential, connection and binding history for a confirmed account replacement',
      resolveRevisions: revisions,
      inputSchema: {
        type: 'object',
        required: ['oldCredentialId', 'replacement', 'replacedAt'],
        properties: {
          oldCredentialId: { type: 'string' },
          replacement: { type: 'object', required: ['id', 'materialRef'] },
          replacedAt: { type: 'integer' }
        },
        additionalProperties: false
      }
    },
    (txn, raw) => {
      const payload = record(raw, 'payload')
      const replacement = record(payload.replacement, 'replacement') as unknown as ProviderCredential
      reqString(replacement as unknown as Record<string, unknown>, 'id')
      const result = replaceCredential(txn.db, {
        oldCredentialId: reqString(payload, 'oldCredentialId'),
        replacement,
        replacedAt: reqInteger(payload, 'replacedAt')
      })
      txn.emitEvent({
        aggregateId: String(payload.oldCredentialId),
        aggregateRevision: result.oldRevision,
        eventType: 'inventory.credential.replaced',
        payload: { replacementCredentialId: replacement.id, replacedAt: payload.replacedAt }
      })
      return result
    }
  )
  registry.register(
    mutationSpec(INVENTORY_OPERATION_NAMES.connectionPut, 'register or revise an offering connection'),
    putHandler<ProviderConnection>('inventory.connection.put', (txn, value) =>
      putProviderConnection(txn.db, value)
    )
  )
  registry.register(
    mutationSpec(
      INVENTORY_OPERATION_NAMES.identityClaimPut,
      'record a sourced, time-scoped account identity claim'
    ),
    putHandler<ProviderIdentityClaim>('inventory.identity-claim.put', (txn, value) =>
      putIdentityClaim(txn.db, value)
    )
  )
  registry.register(
    mutationSpec(
      INVENTORY_OPERATION_NAMES.quotaPoolClaimPut,
      'record a sourced, time-scoped provider quota pool claim'
    ),
    putHandler<QuotaPoolClaim>('inventory.quota-pool-claim.put', (txn, value) =>
      putQuotaPoolClaim(txn.db, value)
    )
  )
  registry.register(
    mutationSpec(
      INVENTORY_OPERATION_NAMES.bindingPut,
      'record a time-scoped configuration binding without attributing usage'
    ),
    putHandler<HarnessProviderBinding>('inventory.binding.put', (txn, value) =>
      putBinding(txn.db, value)
    )
  )
  registry.register(
    {
      name: INVENTORY_OPERATION_NAMES.observationRecord,
      visibility: 'operator',
      mutation: true,
      summary: 'distinguish observed, missing, confirmed removed and failed discovery outcomes',
      resolveRevisions: revisions,
      inputSchema: {
        type: 'object',
        required: ['id', 'subjectKind', 'outcome', 'observedAt'],
        properties: {
          id: { type: 'string' },
          subjectKind: { type: 'string' },
          subjectId: { type: 'string' },
          outcome: { enum: ['observed', 'missing', 'removed', 'failed'] },
          observedAt: { type: 'integer' },
          sourceRef: { type: 'string' },
          evidence: { type: 'array' }
        },
        additionalProperties: false
      }
    },
    (txn, raw) => {
      const payload = record(raw, 'payload')
      const outcome = payload.outcome as InventoryObservationOutcome
      if (!['observed', 'missing', 'removed', 'failed'].includes(outcome)) {
        throw mahasError('MODEL_INVALID', 'outcome is invalid', 'none')
      }
      const input = {
        id: reqString(payload, 'id'),
        subjectKind: reqString(payload, 'subjectKind'),
        subjectId: typeof payload.subjectId === 'string' ? payload.subjectId : undefined,
        outcome,
        observedAt: reqInteger(payload, 'observedAt'),
        sourceRef: typeof payload.sourceRef === 'string' ? payload.sourceRef : undefined,
        evidence: Array.isArray(payload.evidence) ? payload.evidence : undefined
      }
      recordInventoryObservation(txn.db, input)
      txn.emitEvent({
        aggregateId: input.subjectId ?? input.id,
        aggregateRevision:
          input.subjectId == null
            ? 1
            : (resolveInventoryRevisions(txn.db, [input.subjectId])[input.subjectId] ?? 1),
        eventType: 'inventory.observation.recorded',
        payload: input
      })
      return input
    }
  )
}
