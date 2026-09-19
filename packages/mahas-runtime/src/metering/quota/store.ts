import type { DatabaseSync } from 'node:sqlite'
import type {
  CollectionDiagnostic,
  MeteringEvidenceRef,
  QuotaEntitlement,
  QuotaMeter,
  QuotaPlanClaim,
  QuotaReading
} from '../../../../mahas-contracts/src/metering/index.ts'
import type { ProviderIdentityClaim } from '../../../../mahas-contracts/src/inventory/index.ts'
import { withTx } from '../../storage/transaction.ts'

type Row = Record<string, unknown>
const json = (value: unknown): string => JSON.stringify(value ?? null)
const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T
  } catch {
    return fallback
  }
}

function assertTime(value: number | null | undefined, field: string): void {
  if (value != null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${field} must be a non-negative integer timestamp`)
  }
}

export function assertQuotaReading(reading: QuotaReading): void {
  if (reading.payloadSchema !== 'mahas.quota-reading/v1')
    throw new Error('unsupported quota payload schema')
  if (
    !reading.observationId ||
    !reading.batchId ||
    !reading.sourceRecordKey ||
    !reading.payload.connectionId
  ) {
    throw new Error('quota reading identity fields must be non-empty')
  }
  assertTime(reading.observedAt, 'observedAt')
  assertTime(reading.occurredAt, 'occurredAt')
  assertTime(reading.payload.observedAt, 'payload.observedAt')
  assertTime(reading.payload.providerMeasuredAt, 'providerMeasuredAt')
  if (reading.payload.observedAt !== reading.observedAt) {
    throw new Error('quota payload observedAt must equal reading observedAt')
  }
  for (const meter of reading.payload.meters) {
    for (const [key, value] of Object.entries({
      used: meter.used,
      limit: meter.limit,
      remaining: meter.remaining,
      utilization: meter.utilization
    })) {
      if (value != null && !Number.isFinite(value))
        throw new Error(`quota meter ${meter.key}.${key} must be finite`)
    }
  }
  for (const claim of reading.payload.identityClaims) {
    if (claim.connectionId !== reading.payload.connectionId) {
      throw new Error(`identity claim ${claim.id} belongs to another connection`)
    }
  }
}

const requiredObject = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${field} must be an object`)
  return value as Record<string, unknown>
}

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`${field} must be a non-empty string`)
  return value
}

const requiredNumber = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative integer`)
  return value
}

const optionalString = (value: unknown, field: string): string | null | undefined => {
  if (value == null) return value as null | undefined
  return requiredString(value, field)
}

const array = (value: unknown, field: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value
}

/** Validate every field before admitting an untrusted operation payload. */
export function decodeQuotaReading(value: unknown): QuotaReading {
  const row = requiredObject(value, 'reading')
  const payload = requiredObject(row.payload, 'reading.payload')
  const status = requiredString(payload.status, 'reading.payload.status')
  if (!['success', 'partial', 'failure'].includes(status))
    throw new Error('reading.payload.status is invalid')
  if (row.payloadSchema !== 'mahas.quota-reading/v1')
    throw new Error('reading.payloadSchema is invalid')
  const reading: QuotaReading = {
    observationId: requiredString(row.observationId, 'reading.observationId'),
    batchId: requiredString(row.batchId, 'reading.batchId'),
    sourceRecordKey: requiredString(row.sourceRecordKey, 'reading.sourceRecordKey'),
    sourceRecordRevision: optionalString(row.sourceRecordRevision, 'reading.sourceRecordRevision'),
    observedAt: requiredNumber(row.observedAt, 'reading.observedAt'),
    occurredAt:
      row.occurredAt == null
        ? (row.occurredAt as null | undefined)
        : requiredNumber(row.occurredAt, 'reading.occurredAt'),
    payloadSchema: 'mahas.quota-reading/v1',
    evidence: array(row.evidence, 'reading.evidence').map((item, index) =>
      requiredObject(item, `reading.evidence[${index}]`)
    ) as MeteringEvidenceRef[],
    payload: {
      connectionId: requiredString(payload.connectionId, 'reading.payload.connectionId'),
      observedAt: requiredNumber(payload.observedAt, 'reading.payload.observedAt'),
      providerMeasuredAt:
        payload.providerMeasuredAt == null
          ? (payload.providerMeasuredAt as null | undefined)
          : requiredNumber(payload.providerMeasuredAt, 'reading.payload.providerMeasuredAt'),
      identityClaims: array(payload.identityClaims, 'reading.payload.identityClaims').map(
        (item, index) => {
          const claim = requiredObject(item, `identityClaims[${index}]`)
          const confidence = requiredString(claim.confidence, `identityClaims[${index}].confidence`)
          if (!['declared', 'observed', 'verified'].includes(confidence))
            throw new Error(`identityClaims[${index}].confidence is invalid`)
          return {
            id: requiredString(claim.id, `identityClaims[${index}].id`),
            connectionId: requiredString(
              claim.connectionId,
              `identityClaims[${index}].connectionId`
            ),
            kind: requiredString(claim.kind, `identityClaims[${index}].kind`),
            value: requiredString(claim.value, `identityClaims[${index}].value`),
            observedAt: requiredNumber(claim.observedAt, `identityClaims[${index}].observedAt`),
            validUntil:
              claim.validUntil == null
                ? (claim.validUntil as null | undefined)
                : requiredNumber(claim.validUntil, `identityClaims[${index}].validUntil`),
            confidence: confidence as ProviderIdentityClaim['confidence'],
            evidence: array(claim.evidence, `identityClaims[${index}].evidence`).map(
              (entry, evidenceIndex) =>
                requiredObject(entry, `identityClaims[${index}].evidence[${evidenceIndex}]`)
            )
          }
        }
      ),
      planClaims: array(payload.planClaims, 'reading.payload.planClaims').map((item, index) =>
        requiredObject(item, `planClaims[${index}]`)
      ) as unknown as QuotaPlanClaim[],
      meters: array(payload.meters, 'reading.payload.meters').map((item, index) =>
        requiredObject(item, `meters[${index}]`)
      ) as unknown as QuotaMeter[],
      entitlements: array(payload.entitlements, 'reading.payload.entitlements').map((item, index) =>
        requiredObject(item, `entitlements[${index}]`)
      ) as unknown as QuotaEntitlement[],
      status: status as QuotaReading['payload']['status'],
      diagnostics: array(payload.diagnostics, 'reading.payload.diagnostics').map((item, index) =>
        requiredObject(item, `diagnostics[${index}]`)
      ) as unknown as CollectionDiagnostic[],
      sourceEvidence: requiredObject(payload.sourceEvidence, 'reading.payload.sourceEvidence')
    }
  }
  assertQuotaReading(reading)
  return reading
}

function rowToReading(row: Row): QuotaReading {
  return {
    observationId: String(row.observation_id),
    batchId: String(row.batch_id),
    sourceRecordKey: String(row.source_record_key),
    sourceRecordRevision:
      row.source_record_revision == null ? null : String(row.source_record_revision),
    observedAt: Number(row.reading_observed_at),
    occurredAt: row.occurred_at == null ? null : Number(row.occurred_at),
    payloadSchema: 'mahas.quota-reading/v1',
    evidence: parse<MeteringEvidenceRef[]>(row.evidence_json, []),
    payload: {
      connectionId: String(row.connection_id),
      observedAt: Number(row.reading_observed_at),
      providerMeasuredAt:
        row.provider_measured_at == null ? null : Number(row.provider_measured_at),
      identityClaims: parse<ProviderIdentityClaim[]>(row.identity_claims_json, []),
      planClaims: parse<QuotaPlanClaim[]>(row.plan_claims_json, []),
      meters: parse<QuotaMeter[]>(row.meters_json, []),
      entitlements: parse<QuotaEntitlement[]>(row.entitlements_json, []),
      status: String(row.status) as QuotaReading['payload']['status'],
      diagnostics: parse<CollectionDiagnostic[]>(row.diagnostics_json, []),
      sourceEvidence: parse(row.source_evidence_json, {})
    }
  }
}

function sameReading(left: QuotaReading, right: QuotaReading): boolean {
  return json(left) === json(right)
}

/** Caller must already be in the collection transaction. */
export function recordQuotaReadingInTransaction(
  db: DatabaseSync,
  reading: QuotaReading
): QuotaReading {
  assertQuotaReading(reading)
  const prior = getQuotaReading(db, reading.observationId)
  if (prior) {
    if (!sameReading(prior, reading))
      throw new Error(`quota observation ${reading.observationId} is immutable`)
    return prior
  }

  db.prepare(
    `INSERT INTO observations
       (id,execution_id,dispatch_id,source,fact_type,observed_at,payload_json,identity_evidence_json)
     VALUES (?,NULL,NULL,?,'quota-reading',?,?,?)`
  ).run(
    reading.observationId,
    `quota:${reading.batchId}`,
    reading.observedAt,
    json({ payloadSchema: reading.payloadSchema, payload: reading.payload }),
    json({
      batchId: reading.batchId,
      sourceRecordKey: reading.sourceRecordKey,
      sourceRecordRevision: reading.sourceRecordRevision ?? null,
      evidence: reading.evidence
    })
  )
  db.prepare(
    `INSERT INTO quota_reading_facets
       (observation_id,batch_id,source_record_key,source_record_revision,occurred_at,payload_schema,
        connection_id,reading_observed_at,provider_measured_at,status,identity_claims_json,
        plan_claims_json,meters_json,entitlements_json,diagnostics_json,source_evidence_json,evidence_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    reading.observationId,
    reading.batchId,
    reading.sourceRecordKey,
    reading.sourceRecordRevision ?? null,
    reading.occurredAt ?? null,
    reading.payloadSchema,
    reading.payload.connectionId,
    reading.observedAt,
    reading.payload.providerMeasuredAt ?? null,
    reading.payload.status,
    json(reading.payload.identityClaims),
    json(reading.payload.planClaims),
    json(reading.payload.meters),
    json(reading.payload.entitlements),
    json(reading.payload.diagnostics),
    json(reading.payload.sourceEvidence),
    json(reading.evidence)
  )

  const identity = db.prepare(
    `INSERT INTO quota_reading_identity_claims
       (observation_id,claim_id,connection_id,kind,claim_value,observed_at,valid_until,confidence,evidence_json)
     VALUES (?,?,?,?,?,?,?,?,?)`
  )
  for (const claim of reading.payload.identityClaims) {
    identity.run(
      reading.observationId,
      claim.id,
      claim.connectionId,
      claim.kind,
      claim.value,
      claim.observedAt,
      claim.validUntil ?? null,
      claim.confidence,
      json(claim.evidence)
    )
  }
  const pool = db.prepare(
    `INSERT INTO quota_reading_pool_claims
       (observation_id,provider_pool_key,scope,observed_at,meter_key) VALUES (?,?,?,?,?)`
  )
  for (const meter of reading.payload.meters) {
    if (meter.sharedPoolKey)
      pool.run(
        reading.observationId,
        meter.sharedPoolKey,
        meter.scope,
        reading.observedAt,
        meter.key
      )
  }
  return reading
}

export function recordQuotaReading(db: DatabaseSync, reading: QuotaReading): QuotaReading {
  return withTx(db, (tx) => recordQuotaReadingInTransaction(tx, reading))
}

export function getQuotaReading(db: DatabaseSync, observationId: string): QuotaReading | null {
  const row = db
    .prepare('SELECT * FROM quota_reading_facets WHERE observation_id=?')
    .get(observationId) as Row | undefined
  return row ? rowToReading(row) : null
}

export function listQuotaReadings(
  db: DatabaseSync,
  input: {
    connectionId: string
    beforeObservedAt?: number
    limit?: number
  }
): QuotaReading[] {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1_000))
  const rows =
    input.beforeObservedAt == null
      ? db
          .prepare(
            `SELECT * FROM quota_reading_facets WHERE connection_id=?
        ORDER BY reading_observed_at DESC,rowid DESC LIMIT ?`
          )
          .all(input.connectionId, limit)
      : db
          .prepare(
            `SELECT * FROM quota_reading_facets WHERE connection_id=? AND reading_observed_at<?
        ORDER BY reading_observed_at DESC,rowid DESC LIMIT ?`
          )
          .all(input.connectionId, input.beforeObservedAt, limit)
  return (rows as unknown as Row[]).map(rowToReading)
}

export interface QuotaCurrent {
  connectionId: string
  latest: QuotaReading | null
  lastSuccess: QuotaReading | null
  currentFailure: QuotaReading | null
}

export function getQuotaCurrent(db: DatabaseSync, connectionId: string): QuotaCurrent {
  const latestRow = db
    .prepare(
      `SELECT * FROM quota_reading_facets WHERE connection_id=?
    ORDER BY reading_observed_at DESC,rowid DESC LIMIT 1`
    )
    .get(connectionId) as Row | undefined
  const successRow = db
    .prepare(
      `SELECT * FROM quota_reading_facets
    WHERE connection_id=? AND status='success'
    ORDER BY reading_observed_at DESC,rowid DESC LIMIT 1`
    )
    .get(connectionId) as Row | undefined
  const latest = latestRow ? rowToReading(latestRow) : null
  return {
    connectionId,
    latest,
    lastSuccess: successRow ? rowToReading(successRow) : null,
    currentFailure: latest?.payload.status === 'failure' ? latest : null
  }
}
