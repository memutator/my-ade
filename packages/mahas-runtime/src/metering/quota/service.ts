// metering/quota/service.ts — quota observation commits.
//
// A quota probe is a provider-API observation: it happens outside any window, it
// may fail while a previously successful reading stays valid, and a retried batch
// must not double-count. The service therefore owns exactly one commit shape:
//
//   buildQuotaReading()      — deterministic observation id per
//                              (connection, source record, revision), so a replayed
//                              batch lands on the same row and is compared, not
//                              appended;
//   commitQuotaObservation() — observation row + typed reading facet (+ the coverage
//                              the caller supplied) in ONE transaction.
//
// The failure path keeps the last success intact: 'failure' is stored as its own
// reading, and getQuotaCurrent() returns latest/lastSuccess/currentFailure
// independently.

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { JsonObject } from '../../../../mahas-contracts/src/common.ts'
import type {
  CollectionCoverage,
  CollectionDiagnostic,
  MeteringEvidenceRef,
  QuotaEntitlement,
  QuotaMeter,
  QuotaPlanClaim,
  QuotaReading
} from '../../../../mahas-contracts/src/metering/index.ts'
import type { ProviderIdentityClaim } from '../../../../mahas-contracts/src/inventory/index.ts'
import { withTx } from '../../storage/transaction.ts'
import {
  assertQuotaReading,
  getQuotaCurrent,
  listQuotaReadings,
  recordQuotaReadingInTransaction,
  type QuotaCurrent
} from './store.ts'

/**
 * The typed probe result. The Pack contract schema is deliberately loose
 * (jsonRecord fields), so everything a probe returns is decoded here before it can
 * reach the typed reading.
 */
export interface QuotaProbePayload {
  connectionId?: string
  observedAt?: number
  providerMeasuredAt?: number | null
  identityClaims?: readonly ProviderIdentityClaim[]
  planClaims?: readonly QuotaPlanClaim[]
  meters?: readonly QuotaMeter[]
  entitlements?: readonly QuotaEntitlement[]
  status: 'success' | 'partial' | 'failure'
  diagnostics?: readonly CollectionDiagnostic[]
  sourceEvidence?: JsonObject
}

export const QUOTA_READING_SCHEMA = 'mahas.quota-reading/v1'

/** Coverage rows belong to the collection domain; the scheduler injects its writer. */
export interface QuotaCoverageWriter {
  writeCoverage(db: DatabaseSync, coverage: readonly CollectionCoverage[]): void
}

export interface QuotaServiceDeps {
  db: DatabaseSync
  now?: () => number
  coverageWriter?: QuotaCoverageWriter
}

export interface QuotaObservationInput {
  connectionId: string
  batchId: string
  sourceRecordKey: string
  sourceRecordRevision?: string | null
  observedAt: number
  occurredAt?: number | null
  providerMeasuredAt?: number | null
  payload: QuotaProbePayload
  evidence?: readonly MeteringEvidenceRef[]
  coverage?: readonly CollectionCoverage[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const needString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value)
    throw new Error('quota payload ' + field + ' must be a string')
  return value
}

const needTime = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('quota payload ' + field + ' must be a timestamp')
  }
  return Number(value)
}

const optNumber = (value: unknown, field: string): number | null | undefined => {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('quota payload ' + field + ' must be a finite number')
  }
  return value
}

/**
 * Decode an untrusted probe payload into the typed reading input. Required fields
 * of each meter/claim are enforced here; a probe cannot smuggle a partially shaped
 * object into the ledger.
 */
export function decodeQuotaProbePayload(value: unknown): QuotaProbePayload {
  if (!isRecord(value)) throw new Error('quota payload must be an object')
  const status = needString(value.status, 'status')
  if (!['success', 'partial', 'failure'].includes(status)) {
    throw new Error('quota payload status is invalid')
  }
  const arrays = (raw: unknown, field: string): unknown[] => {
    if (raw === undefined) return []
    if (!Array.isArray(raw)) throw new Error('quota payload ' + field + ' must be an array')
    return raw
  }
  const identityClaims = arrays(value.identityClaims, 'identityClaims').map((item, index) => {
    if (!isRecord(item)) throw new Error('identityClaims[' + index + '] must be an object')
    const confidence = needString(item.confidence, 'identityClaims[].confidence')
    if (!['declared', 'observed', 'verified'].includes(confidence)) {
      throw new Error('identityClaims[' + index + '].confidence is invalid')
    }
    if (item.evidence !== undefined && !Array.isArray(item.evidence)) {
      throw new Error('identityClaims[' + index + '].evidence must be an array')
    }
    return {
      id: needString(item.id, 'identityClaims[].id'),
      connectionId: needString(item.connectionId, 'identityClaims[].connectionId'),
      kind: needString(item.kind, 'identityClaims[].kind'),
      value: needString(item.value, 'identityClaims[].value'),
      observedAt: needTime(item.observedAt, 'identityClaims[].observedAt'),
      validUntil:
        item.validUntil == null ? null : needTime(item.validUntil, 'identityClaims[].validUntil'),
      confidence: confidence as ProviderIdentityClaim['confidence'],
      evidence: (item.evidence ?? []) as ProviderIdentityClaim['evidence']
    }
  })
  const planClaims = arrays(value.planClaims, 'planClaims').map((item, index) => {
    if (!isRecord(item)) throw new Error('planClaims[' + index + '] must be an object')
    return {
      key: needString(item.key, 'planClaims[].key'),
      label: item.label == null ? null : needString(item.label, 'planClaims[].label'),
      value: needString(item.value, 'planClaims[].value'),
      observedAt: needTime(item.observedAt, 'planClaims[].observedAt'),
      evidence: (item.evidence ?? []) as QuotaPlanClaim['evidence']
    }
  })
  const meters = arrays(value.meters, 'meters').map((item, index) => {
    if (!isRecord(item)) throw new Error('meters[' + index + '] must be an object')
    const availability = needString(item.availability, 'meters[].availability')
    if (!['known', 'unknown', 'unlimited'].includes(availability)) {
      throw new Error('meters[' + index + '].availability is invalid')
    }
    return {
      key: needString(item.key, 'meters[].key'),
      label: needString(item.label, 'meters[].label'),
      resource: needString(item.resource, 'meters[].resource'),
      scope: needString(item.scope, 'meters[].scope'),
      sharedPoolKey:
        item.sharedPoolKey == null
          ? null
          : needString(item.sharedPoolKey, 'meters[].sharedPoolKey'),
      unit: needString(item.unit, 'meters[].unit'),
      used: optNumber(item.used, 'meters[].used') ?? null,
      limit: optNumber(item.limit, 'meters[].limit') ?? null,
      remaining: optNumber(item.remaining, 'meters[].remaining') ?? null,
      utilization: optNumber(item.utilization, 'meters[].utilization') ?? null,
      period: isRecord(item.period) ? (item.period as never) : null,
      availability: availability as QuotaMeter['availability']
    }
  })
  const entitlements = arrays(value.entitlements, 'entitlements').map((item, index) => {
    if (!isRecord(item)) throw new Error('entitlements[' + index + '] must be an object')
    return {
      key: needString(item.key, 'entitlements[].key'),
      scope: needString(item.scope, 'entitlements[].scope'),
      value: (item.value ?? null) as QuotaEntitlement['value'],
      validFrom:
        item.validFrom == null ? null : needTime(item.validFrom, 'entitlements[].validFrom'),
      validUntil:
        item.validUntil == null ? null : needTime(item.validUntil, 'entitlements[].validUntil'),
      evidence: (item.evidence ?? []) as QuotaEntitlement['evidence']
    }
  })
  const diagnostics = arrays(value.diagnostics, 'diagnostics').map((item, index) => {
    if (!isRecord(item)) throw new Error('diagnostics[' + index + '] must be an object')
    const severity = needString(item.severity, 'diagnostics[].severity')
    if (!['info', 'warning', 'error'].includes(severity)) {
      throw new Error('diagnostics[' + index + '].severity is invalid')
    }
    return {
      code: needString(item.code, 'diagnostics[].code'),
      severity: severity as CollectionDiagnostic['severity'],
      message: needString(item.message, 'diagnostics[].message')
    }
  })
  if (value.sourceEvidence !== undefined && !isRecord(value.sourceEvidence)) {
    throw new Error('quota payload sourceEvidence must be an object')
  }
  return {
    ...(value.connectionId === undefined
      ? {}
      : { connectionId: needString(value.connectionId, 'connectionId') }),
    ...(value.observedAt === undefined
      ? {}
      : { observedAt: needTime(value.observedAt, 'observedAt') }),
    providerMeasuredAt: optNumber(value.providerMeasuredAt, 'providerMeasuredAt') ?? null,
    identityClaims,
    planClaims,
    meters,
    entitlements,
    status: status as QuotaProbePayload['status'],
    diagnostics,
    sourceEvidence: (value.sourceEvidence ?? {}) as JsonObject
  }
}

export interface QuotaCommitResult {
  reading: QuotaReading
  replayed: boolean
}

export interface QuotaBatchResult {
  readings: QuotaReading[]
  committed: number
  replayed: number
}

export interface QuotaServiceStatus {
  state: 'stopped' | 'ready'
  startedAt?: number
  connections: number
  readings: number
  lastObservedAt: number | null
  stoppedReason?: string
}

/** Stable observation identity: retrying a batch re-uses the same row. */
export function quotaObservationId(input: {
  connectionId: string
  batchId: string
  sourceRecordKey: string
  sourceRecordRevision?: string | null
}): string {
  const digest = createHash('sha256')
    .update(
      [
        input.connectionId,
        input.batchId,
        input.sourceRecordKey,
        input.sourceRecordRevision ?? ''
      ].join('\u0000')
    )
    .digest('hex')
  return 'quota_' + digest.slice(0, 40)
}

/**
 * Build the reading a probe commits. `payload.observedAt` is normalised to the
 * reading's observedAt: collection time and provider measurement time are
 * different facts and only the latter may be absent.
 */
export function buildQuotaReading(input: QuotaObservationInput): QuotaReading {
  const reading: QuotaReading = {
    observationId: quotaObservationId(input),
    batchId: input.batchId,
    sourceRecordKey: input.sourceRecordKey,
    sourceRecordRevision: input.sourceRecordRevision ?? null,
    observedAt: input.observedAt,
    occurredAt: input.occurredAt ?? null,
    payloadSchema: QUOTA_READING_SCHEMA,
    evidence: input.evidence ?? [],
    payload: {
      connectionId: input.connectionId,
      observedAt: input.observedAt,
      providerMeasuredAt: input.providerMeasuredAt ?? input.payload.providerMeasuredAt ?? null,
      identityClaims: input.payload.identityClaims ?? [],
      planClaims: input.payload.planClaims ?? [],
      meters: input.payload.meters ?? [],
      entitlements: input.payload.entitlements ?? [],
      status: input.payload.status,
      diagnostics: input.payload.diagnostics ?? [],
      sourceEvidence: input.payload.sourceEvidence ?? {}
    }
  }
  assertQuotaReading(reading)
  return reading
}

const shortMessage = (value: string): string =>
  value.length > 400 ? value.slice(0, 400) + '…' : value

/**
 * A probe that never reached the provider is still a fact. Storing it keeps
 * "uncollected" and "collected and empty" distinguishable and preserves the last
 * successful reading for queries.
 */
export function buildQuotaFailure(input: {
  connectionId: string
  batchId: string
  sourceRecordKey: string
  sourceRecordRevision?: string | null
  observedAt: number
  occurredAt?: number | null
  code: string
  message: string
  evidence?: readonly MeteringEvidenceRef[]
  sourceEvidence?: JsonObject
  coverage?: readonly CollectionCoverage[]
}): QuotaObservationInput {
  const diagnostic: CollectionDiagnostic = {
    code: input.code,
    severity: 'error',
    message: shortMessage(input.message)
  }
  return {
    connectionId: input.connectionId,
    batchId: input.batchId,
    sourceRecordKey: input.sourceRecordKey,
    sourceRecordRevision: input.sourceRecordRevision ?? null,
    observedAt: input.observedAt,
    occurredAt: input.occurredAt ?? null,
    payload: {
      providerMeasuredAt: null,
      identityClaims: [],
      planClaims: [],
      meters: [],
      entitlements: [],
      status: 'failure',
      diagnostics: [diagnostic],
      sourceEvidence: input.sourceEvidence ?? {}
    },
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.coverage ? { coverage: input.coverage } : {})
  }
}

export class QuotaService {
  readonly #db: DatabaseSync
  readonly #now: () => number
  readonly #coverageWriter: QuotaCoverageWriter | undefined
  #state: QuotaServiceStatus['state'] = 'stopped'
  #startedAt: number | undefined
  #stoppedReason: string | undefined

  constructor(deps: QuotaServiceDeps) {
    this.#db = deps.db
    this.#now = deps.now ?? Date.now
    this.#coverageWriter = deps.coverageWriter
  }

  boot(): QuotaServiceStatus {
    this.#state = 'ready'
    this.#startedAt = this.#now()
    this.#stoppedReason = undefined
    return this.status()
  }

  shutdown(reason = 'daemon shutdown'): QuotaServiceStatus {
    this.#state = 'stopped'
    this.#stoppedReason = reason
    return this.status()
  }

  status(): QuotaServiceStatus {
    const row = this.#db
      .prepare(
        'SELECT COUNT(DISTINCT connection_id) AS connections, COUNT(*) AS readings,' +
          ' MAX(reading_observed_at) AS last_observed FROM quota_reading_facets'
      )
      .get() as { connections: number; readings: number; last_observed: number | null }
    return {
      state: this.#state,
      ...(this.#startedAt !== undefined ? { startedAt: this.#startedAt } : {}),
      connections: Number(row.connections ?? 0),
      readings: Number(row.readings ?? 0),
      lastObservedAt: row.last_observed == null ? null : Number(row.last_observed),
      ...(this.#stoppedReason ? { stoppedReason: this.#stoppedReason } : {})
    }
  }

  /**
   * Commit one probe observation. Re-committing the identical reading is a no-op
   * that returns the stored row; a different reading under the same identity is a
   * conflict rather than an overwrite.
   */
  commitObservation(input: QuotaObservationInput): QuotaCommitResult {
    const reading = buildQuotaReading(input)
    const existing = this.#exists(reading.observationId)
    const committed = withTx(this.#db, (db) => {
      const stored = recordQuotaReadingInTransaction(db, reading)
      if (input.coverage && input.coverage.length > 0) {
        this.#coverageWriter?.writeCoverage(db, input.coverage)
      }
      return stored
    })
    return { reading: committed, replayed: existing }
  }

  /** Failures are observations too; they never overwrite the last success. */
  commitFailure(input: Parameters<typeof buildQuotaFailure>[0]): QuotaCommitResult {
    return this.commitObservation(buildQuotaFailure(input))
  }

  /** One batch = one transaction: every reading in it commits or none does. */
  commitBatch(input: { observations: readonly QuotaObservationInput[] }): QuotaBatchResult {
    const readings = input.observations.map(buildQuotaReading)
    const replays = readings.map((reading) => this.#exists(reading.observationId))
    const committed = withTx(this.#db, (db) => {
      const stored: QuotaReading[] = []
      for (let index = 0; index < readings.length; index += 1) {
        stored.push(recordQuotaReadingInTransaction(db, readings[index]))
        const coverage = input.observations[index].coverage
        if (coverage && coverage.length > 0) this.#coverageWriter?.writeCoverage(db, coverage)
      }
      return stored
    })
    const replayed = replays.filter(Boolean).length
    return { readings: committed, committed: committed.length - replayed, replayed }
  }

  current(connectionId: string): QuotaCurrent {
    return getQuotaCurrent(this.#db, connectionId)
  }

  list(input: { connectionId: string; beforeObservedAt?: number; limit?: number }): QuotaReading[] {
    return listQuotaReadings(this.#db, input)
  }

  #exists(observationId: string): boolean {
    const row = this.#db
      .prepare('SELECT 1 AS present FROM quota_reading_facets WHERE observation_id=?')
      .get(observationId) as { present: number } | undefined
    return row !== undefined
  }
}

export function createQuotaService(deps: QuotaServiceDeps): QuotaService {
  return new QuotaService(deps)
}
