// observation/collection/operations.ts — collection request and query surface.
//
// The request operation is a durable mutation that only writes a queue row: the
// scheduler claims the row and runs the bounded Pack batch outside this
// transaction. Queries read persisted rows and always answer with an explicit
// DTO (coverage, freshness, watermark, unidentified) instead of a bare array, so
// "nothing collected yet" can never look like zero usage.

import type {
  CollectionBatchQueryResult,
  CollectionCoverageQueryResult,
  CollectionRequest,
  CollectionRequestQueryResult,
  CollectionSource,
  CollectionSourceQueryResult
} from '../../../../mahas-contracts/src/metering/index.ts'
import type { OperationHandler, OperationSpec, TxnContext } from '../../api/registry.ts'
import { mahasError } from '../../api/handler-ports.ts'
import { getCollectionSource, getCollectionStatus, lastSuccessfulCollectionAt, listCollectionBatches, listCollectionCoverage, queryCollectionSources } from './query.ts'
import {
  cancelCollectionRequest,
  claimCollectionRequests,
  completeCollectionRequest,
  listCollectionRequests,
  requestCollection,
  type CollectionRequestOutcome
} from './requests.ts'
import { upsertCollectionSource } from './commit.ts'

export const COLLECTION_OPERATION_NAMES = {
  sourceList: 'collection.source.list',
  sourceGet: 'collection.source.get',
  sourceObserve: 'collection.source.observe',
  batchList: 'collection.batch.list',
  coverageList: 'collection.coverage.list',
  request: 'collection.request',
  requestList: 'collection.request.list',
  requestCancel: 'collection.request.cancel',
  requestClaim: 'collection.request.claim',
  requestComplete: 'collection.request.complete'
} as const

export interface CollectionOperationRegistry {
  register(spec: OperationSpec, handler: OperationHandler): void
}

const CAPABILITIES = ['events', 'sessions', 'usage', 'quota'] as const
const REQUEST_STATUSES = ['pending', 'claimed', 'processed', 'failed', 'cancelled'] as const
const SOURCE_STATUSES = ['active', 'missing', 'unavailable', 'retired', 'unknown'] as const

/** Every collection query accepts an omitted or empty payload. */
function optionalObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw mahasError('MODEL_INVALID', 'payload must be an object', 'none')
  }
  return value as Record<string, unknown>
}

function optionalString(source: Record<string, unknown>, field: string): string | undefined {
  const value = source[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw mahasError('MODEL_INVALID', field + ' must be a non-empty string', 'none')
  }
  return value
}

function requiredString(source: Record<string, unknown>, field: string): string {
  const value = optionalString(source, field)
  if (!value) throw mahasError('MODEL_INVALID', field + ' is required', 'none')
  return value
}

function optionalLimit(source: Record<string, unknown>, fallback: number): number {
  const value = source['limit']
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw mahasError('MODEL_INVALID', 'limit must be a positive integer', 'none')
  }
  return Number(value)
}

function optionalInteger(source: Record<string, unknown>, field: string): number | undefined {
  const value = source[field]
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value)) {
    throw mahasError('MODEL_INVALID', field + ' must be an integer', 'none')
  }
  return Number(value)
}

function optionalEnum<T extends string>(source: Record<string, unknown>, field: string,
  allowed: readonly T[]): T | undefined {
  const value = optionalString(source, field)
  if (value === undefined) return undefined
  if (!allowed.includes(value as T)) {
    throw mahasError('MODEL_INVALID', field + ' is unknown', 'none')
  }
  return value as T
}

const objectInput = (properties: Record<string, unknown>, required?: readonly string[]): unknown => ({
  type: 'object', properties, additionalProperties: false,
  ...(required === undefined ? {} : { required })
})

function envelopeFreshness(txn: TxnContext): { asOf: number; lastSuccessfulCollectionAt: number | null } {
  return { asOf: Date.now(), lastSuccessfulCollectionAt: lastSuccessfulCollectionAt(txn.db) }
}

function sourceEnvelope(txn: TxnContext, items: readonly CollectionSource[],
  nextCursor?: string): CollectionSourceQueryResult {
  const unidentified: Array<{ axis: string; amount: number | null; reason: string }> = []
  const inactive = items.filter((item) => item.status !== 'active')
  if (inactive.length > 0) {
    unidentified.push({ axis: 'source', amount: null,
      reason: inactive.length + ' sources are not currently collectable' })
  }
  return {
    items, coverage: [], unidentified, freshness: envelopeFreshness(txn), watermark: {},
    ...(nextCursor === undefined ? {} : { nextCursor })
  }
}

function sourceOrThrow(txn: TxnContext, sourceId: string): CollectionSource {
  const source = getCollectionSource(txn.db, sourceId)
  if (!source) throw mahasError('MODEL_INVALID', 'unknown collection source ' + sourceId, 'none')
  return source
}

export function registerCollectionOperations(registry: CollectionOperationRegistry): void {
  registry.register(
    {
      name: COLLECTION_OPERATION_NAMES.sourceList,
      visibility: 'member',
      mutation: false,
      summary: 'page stored collection sources with their identity evidence',
      inputSchema: objectInput({
        machineId: { type: 'string' }, status: { type: 'string' },
        afterId: { type: 'string' }, limit: { type: 'integer' }
      })
    },
    (txn, payload) => {
      const source = optionalObject(payload)
      const page = queryCollectionSources(txn.db, {
        ...(optionalString(source, 'machineId')
          ? { machineId: source['machineId'] as string } : {}),
        ...(optionalEnum(source, 'status', SOURCE_STATUSES)
          ? { status: source['status'] as CollectionSource['status'] } : {}),
        ...(optionalString(source, 'afterId') ? { afterId: source['afterId'] as string } : {}),
        limit: optionalLimit(source, 100)
      })
      return sourceEnvelope(txn, page.items, page.nextCursor)
    }
  )
  registry.register(
    {
      name: COLLECTION_OPERATION_NAMES.sourceGet,
      visibility: 'member',
      mutation: false,
      summary: 'read one source with cursor, coverage, batches and pending requests',
      inputSchema: objectInput({ sourceId: { type: 'string' }, id: { type: 'string' } })
    },
    (txn, payload) => {
      const source = optionalObject(payload)
      const sourceId = optionalString(source, 'sourceId') ?? requiredString(source, 'id')
      return getCollectionStatus(txn.db, sourceId, {
        ...(optionalInteger(source, 'batchLimit')
          ? { batchLimit: source['batchLimit'] as number } : {}),
        ...(optionalInteger(source, 'coverageLimit')
          ? { coverageLimit: source['coverageLimit'] as number } : {})
      })
    }
  )
  registry.register(
    {
      name: COLLECTION_OPERATION_NAMES.batchList,
      visibility: 'member',
      mutation: false,
      summary: 'list committed collection batches for one source',
      inputSchema: objectInput({ sourceId: { type: 'string' }, limit: { type: 'integer' } },
        ['sourceId'])
    },
    (txn, payload): CollectionBatchQueryResult => {
      const source = optionalObject(payload)
      const sourceId = requiredString(source, 'sourceId')
      const stored = sourceOrThrow(txn, sourceId)
      const batches = listCollectionBatches(txn.db, sourceId, optionalLimit(source, 100))
      const unidentified: Array<{ axis: string; amount: number | null; reason: string }> = []
      const failed = batches.filter((batch) => batch.result === 'failed' || batch.result === 'cancelled')
      if (failed.length > 0) {
        unidentified.push({ axis: 'batch-result', amount: null,
          reason: failed.length + ' batches failed or were cancelled' })
      }
      void stored
      return { items: batches, coverage: [], unidentified, freshness: envelopeFreshness(txn),
        watermark: {} }
    }
  )
  registry.register(
    {
      name: COLLECTION_OPERATION_NAMES.coverageList,
      visibility: 'member',
      mutation: false,
      summary: 'list stored coverage records (complete, partial, gap, unknown) for one source',
      inputSchema: objectInput({ sourceId: { type: 'string' }, limit: { type: 'integer' } },
        ['sourceId'])
    },
    (txn, payload): CollectionCoverageQueryResult => {
      const source = optionalObject(payload)
      const sourceId = requiredString(source, 'sourceId')
      sourceOrThrow(txn, sourceId)
      const coverage = listCollectionCoverage(txn.db, sourceId, optionalLimit(source, 500))
      const unidentified: Array<{ axis: string; amount: number | null; reason: string }> = []
      const gaps = coverage.filter((item) => item.completeness !== 'complete')
      if (gaps.length > 0) {
        unidentified.push({ axis: 'coverage', amount: null,
          reason: gaps.length + ' coverage records report a gap, partial or unknown range' })
      }
      return { items: coverage, coverage, unidentified, freshness: envelopeFreshness(txn),
        watermark: {} }
    }
  )
  registry.register(
    {
      name: COLLECTION_OPERATION_NAMES.request,
      visibility: 'member',
      mutation: true,
      summary: 'queue one bounded collection request for a source (the scheduler runs it)',
      inputSchema: objectInput({
        sourceId: { type: 'string' }, capability: { type: 'string' },
        maxRecords: { type: 'integer' }, maxBytes: { type: 'integer' },
        notBefore: { type: 'integer' }, reason: { type: 'string' },
        idempotencyKey: { type: 'string' }
      }, ['sourceId', 'capability'])
    },
    (txn, payload): CollectionRequest => {
      const source = optionalObject(payload)
      const sourceId = requiredString(source, 'sourceId')
      const capability = optionalEnum(source, 'capability', CAPABILITIES)
      if (!capability) throw mahasError('MODEL_INVALID', 'capability is required', 'none')
      sourceOrThrow(txn, sourceId)
      const request = requestCollection(txn.db, {
        sourceId, capability, requestedBy: txn.ctx.principalId, requestedAt: Date.now(),
        ...(optionalInteger(source, 'maxRecords')
          ? { maxRecords: source['maxRecords'] as number } : {}),
        ...(optionalInteger(source, 'maxBytes')
          ? { maxBytes: source['maxBytes'] as number } : {}),
        ...(optionalInteger(source, 'notBefore')
          ? { notBefore: source['notBefore'] as number } : {}),
        ...(optionalString(source, 'reason') ? { reason: source['reason'] as string } : {}),
        ...(optionalString(source, 'idempotencyKey')
          ? { idempotencyKey: source['idempotencyKey'] as string } : {})
      })
      txn.emitEvent({
        aggregateId: request.id, aggregateRevision: 1, eventType: 'collection.requested',
        payload: { sourceId, capability, status: request.status }
      })
      return request
    }
  )
  registry.register(
    {
      name: COLLECTION_OPERATION_NAMES.requestList,
      visibility: 'member',
      mutation: false,
      summary: 'list collection requests with their queue state and outcomes',
      inputSchema: objectInput({ sourceId: { type: 'string' }, status: { type: 'string' },
        limit: { type: 'integer' } })
    },
    (txn, payload): CollectionRequestQueryResult => {
      const source = optionalObject(payload)
      const items = listCollectionRequests(txn.db, {
        ...(optionalString(source, 'sourceId')
          ? { sourceId: source['sourceId'] as string } : {}),
        ...(optionalEnum(source, 'status', REQUEST_STATUSES)
          ? { status: source['status'] as CollectionRequest['status'] } : {}),
        limit: optionalLimit(source, 100)
      })
      const unidentified: Array<{ axis: string; amount: number | null; reason: string }> = []
      const unsettled = items.filter((item) => item.status === 'pending' || item.status === 'claimed')
      if (unsettled.length > 0) {
        unidentified.push({ axis: 'pending-collection', amount: null,
          reason: unsettled.length + ' requests have not been collected yet' })
      }
      return { items, coverage: [], unidentified, freshness: envelopeFreshness(txn),
        watermark: {} }
    }
  )
  registry.register(
    {
      name: COLLECTION_OPERATION_NAMES.requestCancel,
      visibility: 'member',
      mutation: true,
      summary: 'cancel a collection request that has not settled yet',
      inputSchema: objectInput({ id: { type: 'string' }, reason: { type: 'string' } }, ['id'])
    },
    (txn, payload) => {
      const source = optionalObject(payload)
      const stored = cancelCollectionRequest(txn.db, {
        id: requiredString(source, 'id'), cancelledAt: Date.now(),
        ...(optionalString(source, 'reason') ? { reason: source['reason'] as string } : {})
      })
      txn.emitEvent({ aggregateId: stored.id, aggregateRevision: 1,
        eventType: 'collection.request.cancelled', payload: { sourceId: stored.sourceId } })
      return stored
    }
  )
  registry.register(
    {
      name: COLLECTION_OPERATION_NAMES.sourceObserve,
      visibility: 'service',
      mutation: true,
      summary: 'store a discovered source with its generation and identity evidence',
      inputSchema: objectInput({ source: { type: 'object' } }, ['source'])
    },
    (txn, payload) => {
      const source = optionalObject(payload)['source']
      if (typeof source !== 'object' || source === null || Array.isArray(source)) {
        throw mahasError('MODEL_INVALID', 'source must be an object', 'none')
      }
      const record = source as Record<string, unknown>
      if (typeof record['id'] !== 'string' || typeof record['machineId'] !== 'string' ||
          typeof record['kind'] !== 'string' || typeof record['sourceGeneration'] !== 'string') {
        throw mahasError('MODEL_INVALID', 'source requires id, machineId, kind, sourceGeneration', 'none')
      }
      upsertCollectionSource(txn.db, record as unknown as CollectionSource)
      txn.emitEvent({ aggregateId: String(record['id']), aggregateRevision: 1,
        eventType: 'collection.source.observed', payload: record })
      return getCollectionSource(txn.db, String(record['id']))
    }
  )
  registry.register(
    {
      name: COLLECTION_OPERATION_NAMES.requestClaim,
      visibility: 'service',
      mutation: true,
      summary: 'claim due collection requests for one scheduler pass (lease based)',
      inputSchema: objectInput({ claimId: { type: 'string' }, sourceId: { type: 'string' },
        limit: { type: 'integer' }, leaseMs: { type: 'integer' } }, ['claimId'])
    },
    (txn, payload) => {
      const source = optionalObject(payload)
      const claimId = requiredString(source, 'claimId')
      return claimCollectionRequests(txn.db, {
        claimId, now: Date.now(), limit: optionalLimit(source, 10),
        ...(optionalInteger(source, 'leaseMs') ? { leaseMs: source['leaseMs'] as number } : {}),
        ...(optionalString(source, 'sourceId')
          ? { sourceId: source['sourceId'] as string } : {})
      })
    }
  )
  registry.register(
    {
      name: COLLECTION_OPERATION_NAMES.requestComplete,
      visibility: 'service',
      mutation: true,
      summary: 'settle a claimed collection request with its batch outcome',
      inputSchema: objectInput({
        id: { type: 'string' }, claimId: { type: 'string' }, outcome: { type: 'string' },
        batchId: { type: 'string' }, diagnostics: { type: 'array' }
      }, ['id', 'claimId', 'outcome'])
    },
    (txn, payload) => {
      const source = optionalObject(payload)
      const outcome = optionalEnum(source, 'outcome', ['processed', 'failed', 'cancelled'] as const)
      if (!outcome) throw mahasError('MODEL_INVALID', 'outcome is required', 'none')
      const stored = completeCollectionRequest(txn.db, {
        id: requiredString(source, 'id'), claimId: requiredString(source, 'claimId'),
        outcome: outcome as CollectionRequestOutcome,
        ...(optionalString(source, 'batchId') ? { batchId: source['batchId'] as string } : {}),
        ...(Array.isArray(source['diagnostics'])
          ? { diagnostics: source['diagnostics'] as CollectionRequest['diagnostics'] } : {}),
        processedAt: Date.now()
      })
      txn.emitEvent({ aggregateId: stored.id, aggregateRevision: 1,
        eventType: 'collection.request.' + outcome,
        payload: { sourceId: stored.sourceId, batchId: stored.batchId } })
      return stored
    }
  )
}
