// mahas-runtime/launch — dependency ports and kernel helpers (IMP-19).
//
// The launch boundary deliberately touches peer boundaries ONLY through
// these injected ports or `import type` references, so the module loads and
// is testable while IMP-02/03/09/10/11/14/16/17/18 are in flight. The
// composition root (IMP-17/IMP-23 service bootstrap) wires each port to the
// owning boundary's real entrypoint:
//
//   call           → makeCaller(registry, serviceCtx) — IMP-11 api/registry.ts
//   host           → connectHost(endpoint) cache      — IMP-17 hostClient.ts
//   materialize    → realization/materializer.ts      — IMP-09
//   ensureEnvelope → coordination/work-envelope.ts    — IMP-14
//   digest         → storage/db.ts sha256Hex          — IMP-03
//   appendDomainEvent → storage/db.ts                 — IMP-03
//
// Where a peer handoff fixes a different signature, this port is the seam
// to reconcile — documented in the IMP-19 handoff, not silently forked.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AuthenticatedContext,
  ErrorCode,
  MahasError
} from '../../../mahas-contracts/src/common.ts'
import type { HostClient } from '../hostClient.ts'
import type { Assignment, Member, Run } from '../../../mahas-contracts/src/work.ts'

/** cross-domain operation call by name — the makeCaller equivalent. */
export interface CrossDomainCaller {
  (ctx: AuthenticatedContext, operation: string, payload?: unknown): Promise<unknown>
}

/** resolves the NDJSON client for a given execution host (IMP-17 hostClient). */
export interface HostResolver {
  (hostId: string): Promise<HostClient> | HostClient
}

/**
 * A file whose bytes are written into the execution root but NEVER appear in
 * the manifest, receipts, logs or argv/env (S-INJECTION §3 connection/worker).
 */
export interface MaterializeSecretFile {
  /** execution-root-relative path */
  path: string
  bytes: Uint8Array
}

/**
 * IMP-09 materializer port — staged write + atomic publish of a context
 * bundle into an execution-private directory inside the claimed checkout.
 * Exact signature reconciles with handoff:IMP-09 when it lands.
 */
export interface MaterializeRequest {
  executionId: string
  bundleDigest: string
  /** canonical path of the claimed checkout the execution root lives under */
  checkoutPath: string
  workspaceId?: string
  /** relative paths whose bytes must come back for argv-text/stdin routes */
  wantBytes?: string[]
  secretFiles?: MaterializeSecretFile[]
}

export interface MaterializedFile {
  /** execution-root-relative path */
  path: string
  digest: string
  byteLength: number
  /** present when listed in wantBytes */
  bytes?: Uint8Array
  /** evidence the file exists where a preload route expects it */
  verified?: boolean
}

export interface MaterializeResult {
  executionRoot: string
  manifestDigest: string
  files: MaterializedFile[]
  /** materializer's own receipts (staging/publish evidence) */
  receipts?: unknown
  /** staging paths left behind on partial failure — preserved, never cleaned here */
  residuals?: unknown[]
}

export type MaterializePort = (req: MaterializeRequest) => Promise<MaterializeResult>

/**
 * IMP-14 work-envelope port — returns the WorkEnvelope digest pinned for
 * this assignment (kind 'task' or 'coordination'), building/storing it if
 * the envelope does not exist yet. Reconciles with handoff:IMP-14.
 */
export type EnvelopePort = (
  db: DatabaseSync,
  req: { assignment: Assignment; member: Member; run: Run }
) => { digest: string } | null | Promise<{ digest: string } | null>

export interface LaunchDeps {
  /** cross-domain ops: context.build, workspace.prepare. Absent → those stages block honestly. */
  call?: CrossDomainCaller
  /** execution-host client resolver. Absent → spawn/inspect-probe cannot run. */
  host?: HostResolver
  /** IMP-09 component materializer. Absent → components_materialized fails as unwired. */
  materialize?: MaterializePort
  /** IMP-14 WorkEnvelope provider. Absent → envelope must already exist in work_envelopes. */
  ensureEnvelope?: EnvelopePort
  /** storage/db.ts appendDomainEvent — default writes the domain_events row directly. */
  appendDomainEvent?: (
    db: DatabaseSync,
    aggregateId: string,
    aggregateRevision: number,
    eventType: string,
    scope: unknown,
    payload: unknown
  ) => void
  /** sha256 lowercase-hex. Wire storage/db.ts sha256Hex; default is node:crypto (identical contract). */
  digest?: (data: string | Uint8Array) => string
  /** opaque id factory (spec/common.md §1 — never a label/path/native id). */
  newId?: (kind: string) => string
  now?: () => number
  /** mahasd endpoint advertised to workers via env + connection/worker file. */
  endpoint?: string
}

export interface ResolvedDeps extends LaunchDeps {
  digest: (data: string | Uint8Array) => string
  newId: (kind: string) => string
  now: () => number
}

export function resolveDeps(deps: LaunchDeps): ResolvedDeps {
  return {
    ...deps,
    // identical contract to storage/db.ts sha256Hex (lowercase hex, no
    // prefix); the composition root should inject the shared helper so all
    // boundaries share one implementation.
    digest: deps.digest ?? ((data) => createHash('sha256').update(data).digest('hex')),
    newId: deps.newId ?? ((kind) => `${kind}-${randomUUID()}`),
    now: deps.now ?? (() => Date.now())
  }
}

/** fresh bootstrap credential secret — memory only; the raw value is NEVER
 *  written to any table, argv, env, receipt or log (spec §C-LAUNCH join,
 *  execution_credentials.secret_hash only). */
export function newCredentialSecret(): string {
  return randomBytes(32).toString('hex')
}

// ---------------------------------------------------------------------------
// errors

export function mahasError(
  code: ErrorCode,
  message: string,
  retry: MahasError['retry'] = 'none',
  details?: unknown
): MahasError {
  return { code, message, retry, ...(details === undefined ? {} : { details }) }
}

export function isMahasError(e: unknown): e is MahasError {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'string' &&
    typeof (e as { message?: unknown }).message === 'string'
  )
}

/** best-effort error → {code,message} for stage/journal recording */
export function describeError(e: unknown): { code: string; message: string; retry?: string } {
  if (isMahasError(e)) return { code: e.code, message: e.message, retry: e.retry }
  if (e instanceof Error) return { code: 'INTERNAL', message: e.message }
  return { code: 'INTERNAL', message: String(e) }
}

// ---------------------------------------------------------------------------
// canonical JSON — stable digest input for pins/plans (sorted keys)

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

// ---------------------------------------------------------------------------
// transaction boundary helper.
//
// INTEGRATION NOTE (handoff): worker.start performs durable intent commits
// BETWEEN external effects (S-LIFECYCLE §3 spawn cut points). That is only
// possible if the registry does NOT wrap the whole async handler in one
// synchronous transaction. When txn.db is already inside a transaction we
// cannot safely COMMIT it (that would release the caller's atomicity), so
// this helper degrades to inline execution and relies on the outer commit —
// correct only if the outer frame commits before effects fire. IMP-11 must
// give effect-ful mutation ops their own commit boundaries; flagged in the
// IMP-19 handoff as an unresolved coordination point.
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn()
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* already rolled back */
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// row helpers — DatabaseSync returns null-prototype records; cast at the edge

export function getRow<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T | null {
  const r = db.prepare(sql).get(...(params as never[]))
  return (r ?? null) as T | null
}

export function allRows<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as unknown as T[]
}

export function runSql(db: DatabaseSync, sql: string, ...params: unknown[]): void {
  db.prepare(sql).run(...(params as never[]))
}

export function emitEvent(
  db: DatabaseSync,
  deps: ResolvedDeps,
  aggregateId: string,
  aggregateRevision: number,
  eventType: string,
  scope: unknown,
  payload: unknown
): void {
  if (deps.appendDomainEvent) {
    deps.appendDomainEvent(db, aggregateId, aggregateRevision, eventType, scope, payload)
    return
  }
  runSql(
    db,
    'INSERT INTO domain_events(aggregate_id,aggregate_revision,event_type,scope_json,payload_json) VALUES (?,?,?,?,?)',
    aggregateId,
    aggregateRevision,
    eventType,
    JSON.stringify(scope ?? {}),
    JSON.stringify(payload ?? {})
  )
}
