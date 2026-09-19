import { createHash } from 'node:crypto'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { UsageAttribution, UsageEntry, UsageModelRef } from '../../../../mahas-contracts/src/metering/index.ts'
import {
  getUsageAttribution, getUsageEntry, listUsageAttributions, scanUsageEntries
} from '../usage/index.ts'
import type {
  AggregateChange, AggregateChangeBatch, AggregateChangeSource, AggregateCursor,
  AggregateEntryProjection, ModelDimension
} from './types.ts'

const MAX_PAGE = 5_000
/** `IN (…)` binding chunk so a page never trips the variable limit. */
const BIND_CHUNK = 400

const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>()

function sql(db: DatabaseSync, text: string): StatementSync {
  let cache = statements.get(db)
  if (!cache) { cache = new Map(); statements.set(db, cache) }
  let found = cache.get(text)
  if (!found) { found = db.prepare(text); cache.set(text, found) }
  return found as StatementSync
}

function model(value: UsageModelRef | null | undefined): ModelDimension | null {
  return value ? { nativeName: value.nativeName, namespace: value.namespace,
    ...(value.modelId ? { modelId: value.modelId } : {}) } : null
}

interface ConnectionOffering { offering_id: string; provider_id: string }

function connectionOfferings(db: DatabaseSync, connectionIds: readonly string[]): Map<string, ConnectionOffering> {
  const found = new Map<string, ConnectionOffering>()
  const ids = [...new Set(connectionIds)]
  for (let at = 0; at < ids.length; at += BIND_CHUNK) {
    const chunk = ids.slice(at, at + BIND_CHUNK)
  const rows = sql(db, `SELECT c.id,c.offering_id,o.provider_id
      FROM inventory_provider_connections c JOIN catalog_offerings o ON o.id=c.offering_id
      WHERE c.id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as unknown as Array<ConnectionOffering & { id: string }>
    for (const row of rows) found.set(row.id, row)
  }
  return found
}

function projectionOf(
  entry: UsageEntry,
  attribution: UsageAttribution | null,
  connections: Map<string, ConnectionOffering>
): AggregateEntryProjection {
  let offeringId = attribution?.offeringId ?? null
  let providerId = attribution?.providerId ?? null
  if (attribution?.connectionId) {
    const derived = connections.get(attribution.connectionId)
    if (derived) { offeringId = derived.offering_id; providerId = derived.provider_id }
  }
  return {
    id: entry.id, revision: entry.revision, accountingStatus: entry.accountingStatus,
    totals: entry.normalizedTokens,
    dimensions: { sessionId: entry.sessionId ?? undefined, machineId: entry.originMachineId ?? undefined,
      harnessId: entry.harnessId, providerId, offeringId, connectionId: attribution?.connectionId ?? null,
      requestedModel: model(attribution?.requestedModel), servedModel: model(attribution?.servedModel) },
    usageTime: entry.usageTime.kind === 'unknown' ? { kind: 'unknown' }
      : entry.usageTime.kind === 'point' ? { kind: 'point', at: entry.usageTime.at, basis: entry.usageTime.basis }
        : { kind: 'interval', startExclusive: entry.usageTime.startExclusive,
          endInclusive: entry.usageTime.endInclusive, precision: entry.usageTime.precision ?? undefined },
    attributionRevision: attribution?.revision ?? 0,
    attributionStatus: attribution?.status === 'superseded' ? 'unknown' : (attribution?.status ?? 'unknown')
  }
}

function projectionFor(db: DatabaseSync, entryId: string): AggregateEntryProjection | null {
  const entry = getUsageEntry(db, entryId)
  if (!entry) return null
  const attribution = getUsageAttribution(db, entryId)
  return projectionOf(entry, attribution,
    connectionOfferings(db, attribution?.connectionId ? [attribution.connectionId] : []))
}

/* ── verified pool claims ────────────────────────────────────────────────────
 * Claims live in the inventory domain and are corrected in place (a `revision`
 * bump on the same row), so no rowid/sequence expresses their state. The feed
 * position is therefore an opaque digest of the whole evidence table: any
 * insert, revision bump or validity edit changes it. A claim row *removal*
 * cannot be attributed to a connection from here, so it requires an explicit
 * full rebuild — recorded as a cross-boundary dependency, not guessed at. */

export function poolClaimDigest(db: DatabaseSync): string {
  const rows = sql(db, `SELECT id,connection_id,provider_pool_key,scope,
    observed_at,valid_until,revision FROM inventory_quota_pool_claims ORDER BY id`).all() as unknown as
    Array<Record<string, unknown>>
  if (!rows.length) return ''
  const hash = createHash('sha256')
  for (const row of rows) {
    hash.update([row['id'], row['connection_id'], row['provider_pool_key'], row['scope'],
      row['observed_at'], row['valid_until'] ?? '', row['revision']].join('\u0000'))
    hash.update('\n')
  }
  return `sha256:${hash.digest('hex')}`
}

function poolClaimConnections(db: DatabaseSync): string[] {
  return (sql(db, `SELECT DISTINCT connection_id FROM inventory_quota_pool_claims
    ORDER BY connection_id`).all() as unknown as Array<{ connection_id: string }>).map((r) => r.connection_id)
}

/** Counted entries attributed to one connection, keyset-ordered by entry id. */
function entriesForConnection(db: DatabaseSync, connectionId: string, afterEntryId: string, limit: number): string[] {
  return (sql(db, `SELECT e.id FROM usage_entries e
    JOIN usage_attributions a ON a.entry_id=e.id
      AND a.revision=(SELECT MAX(x.revision) FROM usage_attributions x WHERE x.entry_id=e.id)
    WHERE a.connection_id=? AND e.id>?
      AND e.revision=(SELECT MAX(y.revision) FROM usage_entries y WHERE y.id=e.id)
      AND e.accounting_status='counted'
    ORDER BY e.id LIMIT ?`).all(connectionId, afterEntryId,
    Math.max(1, Math.min(limit, MAX_PAGE))) as unknown as Array<{ id: string }>).map((r) => r.id)
}

interface PoolClaimPass {
  changes: AggregateChange[]
  resume: { connectionId: string; entryId: string } | null
  complete: boolean
}

function expandPoolClaimChanges(db: DatabaseSync, resume: AggregateCursor['poolClaimResume'], limit: number): PoolClaimPass {
  const changes: AggregateChange[] = []
  let remaining = limit
  const after = resume ?? null
  for (const connectionId of poolClaimConnections(db)) {
    if (after && connectionId < after.connectionId) continue
    const afterEntryId = after && connectionId === after.connectionId ? after.entryId : ''
    const ids = entriesForConnection(db, connectionId, afterEntryId, remaining)
    for (const entryId of ids) changes.push({ ledgerSequence: null, kind: 'poolClaim', entryId, connectionId })
    remaining -= ids.length
    if (remaining <= 0) {
      const last = ids[ids.length - 1]
      return { changes, resume: last ? { connectionId, entryId: last } : null, complete: false }
    }
  }
  return { changes, resume: null, complete: true }
}

function ledgerPending(db: DatabaseSync, after: number): boolean {
  return sql(db, 'SELECT 1 AS present FROM usage_ledger_changes WHERE sequence>? LIMIT 1')
    .get(after) !== undefined
}

/* ── counted-entry snapshot scan ─────────────────────────────────────────── */

function eligibleEntries(db: DatabaseSync, entries: readonly UsageEntry[], sequence: number): Set<string> {
  const eligible = new Set<string>()
  const revisions = new Map(entries.map((entry) => [entry.id, entry.revision]))
  const ids = [...revisions.keys()]
  for (let at = 0; at < ids.length; at += BIND_CHUNK) {
    const chunk = ids.slice(at, at + BIND_CHUNK)
    const rows = sql(db, `SELECT entry_id,entry_revision
      FROM usage_ledger_changes WHERE kind='entry' AND sequence<=?
        AND entry_id IN (${chunk.map(() => '?').join(',')})`)
      .all(sequence, ...chunk) as unknown as Array<{ entry_id: string; entry_revision: number }>
    for (const row of rows) {
      if (revisions.get(row.entry_id) === row.entry_revision) eligible.add(row.entry_id)
    }
  }
  return eligible
}

/** Concrete adapter for the shared usage ledger. The source is deliberately
 * narrow, keeping aggregation independent of native logs and collectors. */
export function usageLedgerAggregateSource(db: DatabaseSync): AggregateChangeSource {
  return {
    readChanges(after: AggregateCursor, limit: number): AggregateChangeBatch {
      const page = Math.max(1, Math.min(limit, MAX_PAGE))
      /* Read the claim digest before expanding, never after: a claim committed
       * mid-expansion is then still "unconsumed" on the next read and is
       * re-derived instead of being silently marked as applied. */
      const digest = poolClaimDigest(db)
      const changes: AggregateChange[] = []
      const rows = sql(db,
        `SELECT sequence,entry_id,kind FROM usage_ledger_changes WHERE sequence>? ORDER BY sequence LIMIT ?`)
        .all(after.ledger, page) as unknown as Array<{ sequence: number; entry_id: string; kind: 'entry' | 'attribution' }>
      const cursor: AggregateCursor = { ledger: after.ledger, attribution: after.attribution,
        poolClaim: after.poolClaim, poolClaimResume: after.poolClaimResume ?? null }
      for (const row of rows) {
        changes.push({ ledgerSequence: row.sequence, kind: row.kind, entryId: row.entry_id })
        cursor.ledger = row.sequence
        cursor.attribution = Math.max(cursor.attribution, row.sequence)
      }
      let pending = rows.length >= page || ledgerPending(db, cursor.ledger)
      if (digest !== cursor.poolClaim || cursor.poolClaimResume) {
        const remaining = page - changes.length
        if (remaining <= 0) {
          pending = true
        } else {
          const pass = expandPoolClaimChanges(db, cursor.poolClaimResume, remaining)
          changes.push(...pass.changes)
          cursor.poolClaimResume = pass.resume
          if (pass.complete) { cursor.poolClaim = digest; cursor.poolClaimResume = null }
          else pending = true
        }
      }
      if (cursor.poolClaim !== digest) pending = true
      return { changes, cursor, pending }
    },
    readEntryProjection(entryId) {
      return projectionFor(db, entryId)
    },
    highWatermarks(): AggregateCursor {
      const row = sql(db, 'SELECT COALESCE(MAX(sequence),0) AS watermark FROM usage_ledger_changes')
        .get() as { watermark: number }
      return { ledger: row.watermark, attribution: row.watermark, poolClaim: poolClaimDigest(db),
        poolClaimResume: null }
    },
    verifiedPoolForConnection(connectionId, at) {
      const row = sql(db, `SELECT provider_pool_key,scope
        FROM inventory_quota_pool_claims WHERE connection_id=?
          AND (? IS NULL OR (observed_at<=? AND (valid_until IS NULL OR valid_until>=?)))
        ORDER BY observed_at DESC,revision DESC,id DESC LIMIT 1`).get(connectionId, at, at, at) as
        { provider_pool_key: string; scope: string } | undefined
      return row ? { providerPoolKey: row.provider_pool_key, scope: row.scope } : null
    },
    scanCountedEntries(afterId, limit, snapshot) {
      const page = Math.max(1, Math.min(limit, MAX_PAGE))
      const result: AggregateEntryProjection[] = []
      let cursor = afterId ?? ''
      while (result.length < page) {
        const requested = page - result.length
        const raw = scanUsageEntries(db, { afterId: cursor, status: 'counted', limit: requested })
        if (!raw.length) break
        cursor = raw[raw.length - 1]!.id
        const eligible = eligibleEntries(db, raw, snapshot.ledger)
        const kept = raw.filter((entry) => eligible.has(entry.id))
        const attributions = new Map(listUsageAttributions(db, kept.map((entry) => entry.id))
          .map((attribution) => [attribution.entryId, attribution]))
        const connections = connectionOfferings(db, kept
          .map((entry) => attributions.get(entry.id)?.connectionId)
          .filter((id): id is string => !!id))
        for (const entry of kept) result.push(projectionOf(entry, attributions.get(entry.id) ?? null, connections))
        if (raw.length < requested) break
      }
      return result
    }
  }
}
