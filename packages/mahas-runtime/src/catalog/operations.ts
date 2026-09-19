import type {
  Harness,
  InferenceModel,
  ModelAliasResolution,
  NativeModelAlias,
  Offering,
  Organization,
  Provider
} from '../../../mahas-contracts/src/catalog/index.ts'
import type { OperationHandler, OperationSpec, TxnContext } from '../api/registry.ts'
import { mahasError } from '../api/handler-ports.ts'
import {
  getCatalogSnapshot,
  observeNativeModelAlias,
  putHarness,
  putInferenceModel,
  putModelAliasResolution,
  putOffering,
  putOrganization,
  putProvider,
  resolveCatalogRevisions
} from './repository.ts'
import { seedBuiltinCatalog } from './seed.ts'

export const CATALOG_OPERATION_NAMES = {
  snapshot: 'catalog.snapshot',
  seed: 'catalog.seed',
  organizationPut: 'catalog.organization.put',
  harnessPut: 'catalog.harness.put',
  providerPut: 'catalog.provider.put',
  offeringPut: 'catalog.offering.put',
  modelPut: 'catalog.model.put',
  aliasObserve: 'catalog.alias.observe',
  aliasResolve: 'catalog.alias.resolve'
} as const

export interface CatalogOperationRegistry {
  register(spec: OperationSpec, handler: OperationHandler): void
}

function record(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw mahasError('MODEL_INVALID', `${field} must be an object`, 'none')
  }
  return raw as Record<string, unknown>
}

function value<T>(raw: unknown): T {
  const payload = record(raw, 'payload')
  const entity = record(payload.value, 'payload.value')
  if (typeof entity.id !== 'string' || !entity.id.trim()) {
    throw mahasError('MODEL_INVALID', 'payload.value.id must be a non-empty string', 'none')
  }
  return entity as T
}

function revisions(txn: TxnContext, ids: readonly string[]): Record<string, number | undefined> {
  return resolveCatalogRevisions(txn.db, ids)
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

function mutation<T>(
  eventType: string,
  write: (txn: TxnContext, entity: T) => { value: T; revision: number }
): OperationHandler {
  return (txn, payload) => {
    const entity = value<T>(payload)
    const result = write(txn, entity)
    const id = String((entity as { id: string }).id)
    txn.emitEvent({ aggregateId: id, aggregateRevision: result.revision, eventType, payload: entity })
    return result
  }
}

export function registerCatalogOperations(registry: CatalogOperationRegistry): void {
  registry.register(
    {
      name: CATALOG_OPERATION_NAMES.snapshot,
      visibility: 'operator',
      mutation: false,
      summary: 'read the persisted organization, harness, provider, offering and model catalog'
    },
    (txn) => getCatalogSnapshot(txn.db)
  )

  registry.register(
    {
      name: CATALOG_OPERATION_NAMES.seed,
      visibility: 'operator',
      mutation: true,
      summary: 'idempotently seed catalog subjects demonstrated by built-in integrations',
      inputSchema: { type: 'object', additionalProperties: false }
    },
    (txn) => {
      seedBuiltinCatalog(txn.db)
      txn.emitEvent({
        aggregateId: 'catalog:builtin',
        aggregateRevision: 1,
        eventType: 'catalog.builtin.seeded',
        payload: { additive: true }
      })
      return getCatalogSnapshot(txn.db)
    }
  )

  registry.register(
    mutationSpec(CATALOG_OPERATION_NAMES.organizationPut, 'create or revise an organization'),
    mutation<Organization>('catalog.organization.put', (txn, entity) =>
      putOrganization(txn.db, entity)
    )
  )
  registry.register(
    mutationSpec(CATALOG_OPERATION_NAMES.harnessPut, 'create or revise a harness identity'),
    mutation<Harness>('catalog.harness.put', (txn, entity) => putHarness(txn.db, entity))
  )
  registry.register(
    mutationSpec(CATALOG_OPERATION_NAMES.providerPut, 'create or revise a provider realm'),
    mutation<Provider>('catalog.provider.put', (txn, entity) => putProvider(txn.db, entity))
  )
  registry.register(
    mutationSpec(CATALOG_OPERATION_NAMES.offeringPut, 'create or revise a provider offering'),
    mutation<Offering>('catalog.offering.put', (txn, entity) => putOffering(txn.db, entity))
  )
  registry.register(
    mutationSpec(CATALOG_OPERATION_NAMES.modelPut, 'create or revise an inference model'),
    mutation<InferenceModel>('catalog.model.put', (txn, entity) =>
      putInferenceModel(txn.db, entity)
    )
  )
  registry.register(
    mutationSpec(CATALOG_OPERATION_NAMES.aliasObserve, 'record a native model spelling'),
    mutation<NativeModelAlias>('catalog.alias.observed', (txn, entity) =>
      observeNativeModelAlias(txn.db, entity)
    )
  )
  registry.register(
    mutationSpec(
      CATALOG_OPERATION_NAMES.aliasResolve,
      'time-scope a native model alias to a canonical model'
    ),
    mutation<ModelAliasResolution>('catalog.alias.resolved', (txn, entity) =>
      putModelAliasResolution(txn.db, entity)
    )
  )
}
