import type { OperationRegistry } from '../../api/registry.ts'
import {
  decodeQuotaReading,
  getQuotaCurrent,
  listQuotaReadings,
  recordQuotaReadingInTransaction
} from './store.ts'
import {
  buildQuotaFailure,
  buildQuotaReading,
  decodeQuotaProbePayload,
  type QuotaObservationInput
} from './service.ts'

export const QUOTA_OPERATION_NAMES = [
  'metering.quota.record',
  'metering.quota.observe',
  'metering.quota.observeFailure',
  'metering.quota.current',
  'metering.quota.list'
] as const

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('payload must be an object')
  return value as Record<string, unknown>
}

const reqString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(field + ' must be a non-empty string')
  return value
}

const reqTime = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(field + ' must be a non-negative integer timestamp')
  }
  return Number(value)
}

const optTime = (value: unknown, field: string): number | null => {
  if (value == null) return null
  return reqTime(value, field)
}

/** Scheduler seam: a probe result commits as one observation plus its reading. */
function observationInput(payload: Record<string, unknown>): QuotaObservationInput {
  return {
    connectionId: reqString(payload.connectionId, 'connectionId'),
    batchId: reqString(payload.batchId, 'batchId'),
    sourceRecordKey: reqString(payload.sourceRecordKey, 'sourceRecordKey'),
    sourceRecordRevision:
      typeof payload.sourceRecordRevision === 'string' ? payload.sourceRecordRevision : null,
    observedAt: reqTime(payload.observedAt, 'observedAt'),
    occurredAt: optTime(payload.occurredAt, 'occurredAt'),
    providerMeasuredAt: optTime(payload.providerMeasuredAt, 'providerMeasuredAt'),
    payload: decodeQuotaProbePayload(payload.payload),
    evidence: (payload.evidence ?? []) as QuotaObservationInput['evidence']
  }
}

/** Root composition hook; consumer code only calls operations and never branches on providers. */
export function registerQuotaOps(registry: OperationRegistry): void {
  registry.register(
    {
      name: 'metering.quota.record',
      visibility: 'service',
      mutation: true,
      summary: 'record an immutable typed quota observation'
    },
    (txn, payload) =>
      recordQuotaReadingInTransaction(txn.db, decodeQuotaReading(object(payload).reading))
  )
  registry.register(
    {
      name: 'metering.quota.observe',
      visibility: 'service',
      mutation: true,
      summary: 'commit one provider quota probe as an observation plus typed reading'
    },
    (txn, payload) =>
      recordQuotaReadingInTransaction(txn.db, buildQuotaReading(observationInput(object(payload))))
  )
  registry.register(
    {
      name: 'metering.quota.observeFailure',
      visibility: 'service',
      mutation: true,
      summary: 'commit a failed quota probe without disturbing the last successful reading'
    },
    (txn, payload) => {
      const input = object(payload)
      const failure = buildQuotaFailure({
        connectionId: reqString(input.connectionId, 'connectionId'),
        batchId: reqString(input.batchId, 'batchId'),
        sourceRecordKey: reqString(input.sourceRecordKey, 'sourceRecordKey'),
        sourceRecordRevision:
          typeof input.sourceRecordRevision === 'string' ? input.sourceRecordRevision : null,
        observedAt: reqTime(input.observedAt, 'observedAt'),
        occurredAt: optTime(input.occurredAt, 'occurredAt'),
        code: reqString(input.code, 'code'),
        message: reqString(input.message, 'message')
      })
      return recordQuotaReadingInTransaction(txn.db, buildQuotaReading(failure))
    }
  )
  registry.register(
    {
      name: 'metering.quota.current',
      visibility: 'member',
      mutation: false,
      summary: 'read latest quota, last success and current failure independently'
    },
    (txn, payload) => getQuotaCurrent(txn.db, String(object(payload).connectionId ?? ''))
  )
  registry.register(
    {
      name: 'metering.quota.list',
      visibility: 'member',
      mutation: false,
      summary: 'list durable quota observations for a connection'
    },
    (txn, payload) => {
      const input = object(payload)
      return listQuotaReadings(txn.db, {
        connectionId: String(input.connectionId ?? ''),
        ...(typeof input.beforeObservedAt === 'number'
          ? { beforeObservedAt: input.beforeObservedAt }
          : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {})
      })
    }
  )
}
