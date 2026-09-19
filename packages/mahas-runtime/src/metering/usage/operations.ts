// metering/usage/operations.ts — durable query surface for the usage ledger.
//
// These are reads over persisted rows: no operation rescans a native log and
// no query recomputes a total from source files. The two worker operations
// (scan + deferred counter recompute) are the explicit service seams the
// aggregate/usage worker drives outside ordinary UI access.

import type {
  UsageAccountingStatus,
  UsageAttributionQueryResult,
  UsageEntryQueryResult
} from '../../../../mahas-contracts/src/metering/index.ts'
import type { OperationHandler, OperationSpec, TxnContext } from '../../api/registry.ts'
import { mahasError } from '../../api/handler-ports.ts'
import { lastSuccessfulCollectionAt } from '../../observation/collection/query.ts'
import { listCounterRecomputeIntents } from './counters.ts'
import {
  drainCounterRecomputeIntents,
  getUsageEntryWithAttribution,
  listUsageLedgerChanges,
  queryUsageEntries,
  usageLedgerWatermark
} from './ledger.ts'

export const USAGE_OPERATION_NAMES = {
  entryGet: 'usage.entry.get',
  entryList: 'usage.entry.list',
  ledgerChanges: 'usage.ledger.changes',
  counterRecomputeList: 'usage.counterRecompute.list',
  counterRecomputeDrain: 'usage.counterRecompute.drain'
} as const

export interface UsageOperationRegistry {
  register(spec: OperationSpec, handler: OperationHandler): void
}

const STATUSES: readonly UsageAccountingStatus[] = [
  'counted', 'duplicate', 'unresolved', 'superseded'
]

/** Every query accepts an omitted or empty payload. */
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

function optionalStatus(source: Record<string, unknown>): UsageAccountingStatus | undefined {
  const value = source['status']
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !STATUSES.includes(value as UsageAccountingStatus)) {
    throw mahasError('MODEL_INVALID', 'status is unknown', 'none')
  }
  return value as UsageAccountingStatus
}

function optionalLimit(source: Record<string, unknown>, fallback: number): number {
  const value = source['limit']
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw mahasError('MODEL_INVALID', 'limit must be a positive integer', 'none')
  }
  return Number(value)
}

const objectInput = (properties: Record<string, unknown>): unknown => ({
  type: 'object', properties, additionalProperties: false
})

/**
 * Unaccounted amounts are reported, never folded into a zero: an entry the
 * ledger held, or one whose attribution is missing, is visible in the query.
 */
function unidentifiedFor(items: UsageEntryQueryResult['items']): Array<{
  axis: string; amount: number | null; reason: string
}> {
  const out: Array<{ axis: string; amount: number | null; reason: string }> = []
  const unresolved = items.filter((item) => item.entry.accountingStatus === 'unresolved')
  if (unresolved.length > 0) {
    out.push({ axis: 'accounting', amount: null,
      reason: unresolved.length + ' ledger entries are held unresolved and not counted' })
  }
  const unattributed = items.filter((item) => item.attribution === null)
  if (unattributed.length > 0) {
    out.push({ axis: 'attribution', amount: null,
      reason: unattributed.length + ' entries have no connection or model attribution' })
  }
  const inferred = items.filter((item) => item.attribution?.status === 'inferred' ||
    item.attribution?.status === 'unknown')
  if (inferred.length > 0) {
    out.push({ axis: 'attribution-confidence', amount: null,
      reason: inferred.length + ' entries carry inferred or unknown attribution evidence' })
  }
  const unknownTotals = items.filter((item) =>
    item.entry.accountingStatus === 'counted' && item.entry.normalizedTokens.total === null)
  if (unknownTotals.length > 0) {
    out.push({ axis: 'tokens.total', amount: null,
      reason: unknownTotals.length + ' counted entries never observed a total' })
  }
  return out
}

function entryEnvelope(txn: TxnContext, items: UsageEntryQueryResult['items'],
  nextCursor?: string): UsageEntryQueryResult {
  return {
    items, coverage: [], unidentified: unidentifiedFor(items),
    freshness: { asOf: Date.now(), lastSuccessfulCollectionAt: lastSuccessfulCollectionAt(txn.db) },
    watermark: { ledger: String(usageLedgerWatermark(txn.db)) },
    ...(nextCursor === undefined ? {} : { nextCursor })
  }
}

export function registerUsageOperations(registry: UsageOperationRegistry): void {
  registry.register(
    {
      name: USAGE_OPERATION_NAMES.entryGet,
      visibility: 'member',
      mutation: false,
      summary: 'read one persisted usage entry with its current attribution',
      inputSchema: objectInput({ id: { type: 'string' }, revision: { type: 'integer' } })
    },
    (txn, payload): UsageAttributionQueryResult | null => {
      const source = optionalObject(payload)
      const id = optionalString(source, 'id')
      if (!id) throw mahasError('MODEL_INVALID', 'id is required', 'none')
      return getUsageEntryWithAttribution(txn.db, id)
    }
  )
  registry.register(
    {
      name: USAGE_OPERATION_NAMES.entryList,
      visibility: 'member',
      mutation: false,
      summary: 'page persisted usage entries with attribution, coverage and watermarks',
      inputSchema: objectInput({
        harnessId: { type: 'string' }, status: { type: 'string' },
        afterId: { type: 'string' }, limit: { type: 'integer' }
      })
    },
    (txn, payload): UsageEntryQueryResult => {
      const source = optionalObject(payload)
      const page = queryUsageEntries(txn.db, {
        ...(optionalString(source, 'harnessId') ? { harnessId: source['harnessId'] as string } : {}),
        ...(optionalStatus(source) ? { status: optionalStatus(source)! } : {}),
        ...(optionalString(source, 'afterId') ? { afterId: source['afterId'] as string } : {}),
        limit: optionalLimit(source, 500)
      })
      return entryEnvelope(txn, page.items, page.nextCursor)
    }
  )
  registry.register(
    {
      name: USAGE_OPERATION_NAMES.ledgerChanges,
      visibility: 'member',
      mutation: false,
      summary: 'read the durable usage-ledger change feed after a watermark',
      inputSchema: objectInput({ after: { type: 'integer' }, limit: { type: 'integer' } })
    },
    (txn, payload) => {
      const source = optionalObject(payload)
      const after = source['after']
      const watermark = usageLedgerWatermark(txn.db)
      return {
        watermark: String(watermark),
        items: listUsageLedgerChanges(txn.db,
          typeof after === 'number' && Number.isSafeInteger(after) ? after : 0,
          optionalLimit(source, 500))
      }
    }
  )
  registry.register(
    {
      name: USAGE_OPERATION_NAMES.counterRecomputeList,
      visibility: 'service',
      mutation: false,
      summary: 'list deferred cumulative-counter corrections for the usage worker',
      inputSchema: objectInput({ state: { type: 'string' }, limit: { type: 'integer' } })
    },
    (txn, payload) => {
      const source = optionalObject(payload)
      const state = source['state'] === 'applied' ? 'applied' : 'pending'
      return {
        items: listCounterRecomputeIntents(txn.db, { state, limit: optionalLimit(source, 100) })
      }
    }
  )
  registry.register(
    {
      name: USAGE_OPERATION_NAMES.counterRecomputeDrain,
      visibility: 'service',
      mutation: true,
      summary: 're-normalize the next bounded pages of deferred counter corrections',
      inputSchema: objectInput({ limit: { type: 'integer' } })
    },
    (txn, payload) => {
      const source = optionalObject(payload)
      return drainCounterRecomputeIntents(txn.db,
        { limit: optionalLimit(source, 10), now: Date.now() })
    }
  )
}
