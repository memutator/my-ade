// recovery/ports.ts — injected kernel ports, storage row shapes, helpers.
//
// IMP-22 owns the recovery boundary. Every cross-boundary function this
// package consumes is a SHARED-APIS.md canonical signature owned by a peer
// task that lands in parallel (IMP-03 storage, IMP-10 access, IMP-11
// registry, IMP-17 hostClient). Those modules do not exist in the tree yet,
// so recovery code never value-imports them: the composition root
// (IMP-23's mahasd bootstrap) injects the real implementations through
// RecoveryDeps, and this file type-checks the injected references against
// the canonical signatures via `import type`. Nothing here re-implements a
// kernel API — a stub is never shipped, only a port.
//
// Row interfaces below mirror spec/storage.md §3 columns (snake_case →
// camelCase); they are storage-internal shapes, not contract types.

import type { DatabaseSync } from 'node:sqlite'
import type {
  AuthenticatedContext,
  CommandReceipt,
  EffectState,
  ErrorCode,
  ErrorRetry,
  ExecutionLiveness,
  ExecutionState,
  MahasError,
  ProcessIncarnation
} from '../../../mahas-contracts/src/index.ts'
import type { HostClient } from '../hostClient.ts' // IMP-17 — type only
import type { OperationRegistry } from '../api/registry.ts' // IMP-11 — type only
import type { TargetRef } from '../access/authorize.ts' // IMP-10 — type only

// ---------------------------------------------------------------------------
// Injected ports (SHARED-APIS.md signatures; wired by the composition root)
// ---------------------------------------------------------------------------

/** makeCaller(registry, ctx) — IMP-11 internal cross-domain caller */
export type OperationCaller = (
  operation: string,
  payload?: unknown,
  expectedRevisions?: Record<string, number>
) => Promise<unknown>

export interface RecoveryDeps {
  /** IMP-03 `withTx` — BEGIN IMMEDIATE … COMMIT/ROLLBACK around fn */
  withTx<T>(db: DatabaseSync, fn: (db: DatabaseSync) => T): T
  /** IMP-03 `appendDomainEvent` — domain_events projection feed */
  appendDomainEvent(
    db: DatabaseSync,
    aggregateId: string,
    aggregateRevision: number,
    eventType: string,
    scope: unknown,
    payload: unknown
  ): void
  /** IMP-03 `sha256Hex` — canonical digest for fingerprints/effect keys */
  sha256Hex(data: string | Uint8Array): string
  /** IMP-10 `authorize` — throws MahasError on SCOPE_DENIED/GRANT_REVOKED/UNAUTHENTICATED */
  authorize(ctx: AuthenticatedContext, operation: string, targets: TargetRef[]): void
  /** IMP-17 `connectHost` — NDJSON client to one execution-host endpoint */
  connectHost(endpoint: string): Promise<HostClient>
  /** IMP-11 `makeCaller` — sibling-operation caller bound to a ctx */
  makeCaller(registry: OperationRegistry, ctx: AuthenticatedContext): OperationCaller
  /** authority clock, epoch-ms (S-COMMON §1) */
  now(): number
  /** id minting; defaults to crypto.randomUUID at the composition root */
  newId(): string
  /** bound for a single host round-trip; unknown on expiry (never death) */
  hostCallTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// Errors — MahasError is a plain interface; thrown as a shaped object
// ---------------------------------------------------------------------------

export function failure(
  code: ErrorCode,
  message: string,
  retry: ErrorRetry,
  details?: unknown
): MahasError {
  return details === undefined ? { code, message, retry } : { code, message, retry, details }
}

export function isMahasError(x: unknown): x is MahasError {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { code?: unknown }).code === 'string' &&
    typeof (x as { message?: unknown }).message === 'string'
  )
}

/** wrap an unknown throw into a MahasError without inventing a verdict */
export function asMahasError(x: unknown, fallbackCode: ErrorCode, context: string): MahasError {
  if (isMahasError(x)) return x
  return failure(
    fallbackCode,
    `${context}: ${x instanceof Error ? x.message : String(x)}`,
    'reconcile'
  )
}

// ---------------------------------------------------------------------------
// misc helpers
// ---------------------------------------------------------------------------

/** deterministic JSON (sorted keys) — fingerprint/effect-key input */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value).sort())
      out[k] = sortDeep((value as Record<string, unknown>)[k])
    return out
  }
  return value
}

/** race a host call against the honesty budget — expiry means unknown, never death */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(failure('CONTROL_UNAVAILABLE', `host call exceeded ${ms}ms`, 'reconcile')),
      ms
    )
    promise.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

export function parseJsonColumn<T>(raw: unknown, what: string): T {
  if (typeof raw !== 'string')
    throw failure('INVALID_TRANSITION', `${what}: missing JSON column`, 'none')
  try {
    return JSON.parse(raw) as T
  } catch {
    throw failure('INVALID_TRANSITION', `${what}: malformed JSON column`, 'none')
  }
}

export function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0)
    throw failure('INVALID_TRANSITION', `payload.${field}: non-empty string required`, 'none')
  return v
}

export function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

export function requireNumber(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw failure('INVALID_TRANSITION', `payload.${field}: finite number required`, 'none')
  return v
}

// ---------------------------------------------------------------------------
// storage row shapes (spec/storage.md §3 → camelCase; storage-internal)
// ---------------------------------------------------------------------------

/** D-EXEC §1 — executions.native_conversation_json payload shape */
export interface NativeConversation {
  harnessProfileId: string
  nativeId: string
  capturedBy: string
  capturedAt: number
  resumeSupport?: 'supported' | 'unsupported' | 'unknown'
}

export interface RuntimeInstanceRow {
  id: string
  controllerEpoch: number
  state: string
  processIdentity: unknown
  endpointIncarnation: string
}

export interface ExecutionHostRow {
  id: string
  incarnation: string
  protocolVersion: string
  state: string
  /** identity_json — includes `endpoint` when the host published one */
  identity: { endpoint?: string } & Record<string, unknown>
}

export interface ControllerLeaseRow {
  hostId: string
  epoch: number
  revision: number
  expiresAt: number
  state: string
  proof: unknown
}

export interface ExecutionRow {
  id: string
  memberId: string
  generation: number
  hostId: string
  launchPlanId: string
  state: ExecutionState
  liveness: ExecutionLiveness
  terminalId: string | null
  processIdentity: ProcessIncarnation
  nativeConversation: NativeConversation | null
  revision: number
}

export interface MemberRow {
  id: string
  runId: string
  modelVersion: string
  roleId: string
  implementationId: string
  implementationRevision: number
  generation: number
  currentExecutionId: string | null
  state: string
  revision: number
}

export interface LaunchPlanRow {
  id: string
  assignmentId: string
  assignmentRevision: number
  digest: string
  bundleDigest: string
  envelopeDigest: string
  surfaceDigest: string
  state: string
  processSpec: unknown
  pins: Record<string, unknown>
  reservations: unknown
}

export interface EffectIntentRow {
  id: string
  operationKey: string
  kind: string
  fingerprint: string
  hostId: string | null
  state: EffectState
  payload: unknown
  receipt: unknown
  residuals: unknown[]
}

export interface ResourceClaimRow {
  id: string
  resourceId: string
  ownerKind: string
  ownerId: string
  mode: 'read' | 'write'
  generation: number
  state: 'held' | 'transferring' | 'released' | 'unknown'
  revision: number
}

export interface ResumeCandidateRow {
  id: string
  executionId: string
  supportState: string
  nativeHandle: NativeConversation
  evidence: unknown
}

export interface TerminalRecordRow {
  id: string
  hostId: string
  resourceId: string
  hostIncarnation: string
  ptyId: string
  outputEpoch: string
  lastSequence: number
  state: string
  processIdentity: ProcessIncarnation
}

// ---------------------------------------------------------------------------
// row loaders — NULL means absent, never invented
// ---------------------------------------------------------------------------

type SqlRow = Record<string, unknown>

export function loadExecution(db: DatabaseSync, id: string): ExecutionRow | null {
  const r = db.prepare('SELECT * FROM executions WHERE id=?').get(id) as SqlRow | undefined
  if (!r) return null
  return {
    id: r.id as string,
    memberId: r.member_id as string,
    generation: r.generation as number,
    hostId: r.host_id as string,
    launchPlanId: r.launch_plan_id as string,
    state: r.state as ExecutionState,
    liveness: r.liveness as ExecutionLiveness,
    terminalId: (r.terminal_id as string | null) ?? null,
    processIdentity: parseJsonColumn<ProcessIncarnation>(
      r.process_identity_json,
      `executions.${id}.process_identity_json`
    ),
    nativeConversation: parseJsonColumn<NativeConversation | null>(
      r.native_conversation_json,
      `executions.${id}.native_conversation_json`
    ),
    revision: r.revision as number
  }
}

export function loadHost(db: DatabaseSync, id: string): ExecutionHostRow | null {
  const r = db.prepare('SELECT * FROM execution_hosts WHERE id=?').get(id) as SqlRow | undefined
  if (!r) return null
  return {
    id: r.id as string,
    incarnation: r.incarnation as string,
    protocolVersion: r.protocol_version as string,
    state: r.state as string,
    identity: parseJsonColumn<ExecutionHostRow['identity']>(
      r.identity_json,
      `execution_hosts.${id}.identity_json`
    )
  }
}

export function loadMember(db: DatabaseSync, id: string): MemberRow | null {
  const r = db.prepare('SELECT * FROM members WHERE id=?').get(id) as SqlRow | undefined
  if (!r) return null
  return {
    id: r.id as string,
    runId: r.run_id as string,
    modelVersion: r.model_version as string,
    roleId: r.role_id as string,
    implementationId: r.implementation_id as string,
    implementationRevision: r.implementation_revision as number,
    generation: r.generation as number,
    currentExecutionId: (r.current_execution_id as string | null) ?? null,
    state: r.state as string,
    revision: r.revision as number
  }
}

export function loadLaunchPlan(db: DatabaseSync, id: string): LaunchPlanRow | null {
  const r = db.prepare('SELECT * FROM launch_plans WHERE id=?').get(id) as SqlRow | undefined
  if (!r) return null
  return {
    id: r.id as string,
    assignmentId: r.assignment_id as string,
    assignmentRevision: r.assignment_revision as number,
    digest: r.digest as string,
    bundleDigest: r.bundle_digest as string,
    envelopeDigest: r.envelope_digest as string,
    surfaceDigest: r.surface_digest as string,
    state: r.state as string,
    processSpec: parseJsonColumn<unknown>(
      r.process_spec_json,
      `launch_plans.${id}.process_spec_json`
    ),
    pins: parseJsonColumn<Record<string, unknown>>(r.pins_json, `launch_plans.${id}.pins_json`),
    reservations: parseJsonColumn<unknown>(
      r.reservations_json,
      `launch_plans.${id}.reservations_json`
    )
  }
}

export function loadEffectIntent(db: DatabaseSync, id: string): EffectIntentRow | null {
  const r = db.prepare('SELECT * FROM effect_intents WHERE id=?').get(id) as SqlRow | undefined
  if (!r) return null
  return {
    id: r.id as string,
    operationKey: r.operation_key as string,
    kind: r.kind as string,
    fingerprint: r.fingerprint as string,
    hostId: (r.host_id as string | null) ?? null,
    state: r.state as EffectState,
    payload: parseJsonColumn<unknown>(r.payload_json, `effect_intents.${id}.payload_json`),
    receipt: parseJsonColumn<unknown>(r.receipt_json, `effect_intents.${id}.receipt_json`),
    residuals: parseJsonColumn<unknown[]>(r.residuals_json, `effect_intents.${id}.residuals_json`)
  }
}

export function loadTerminal(db: DatabaseSync, id: string): TerminalRecordRow | null {
  const r = db.prepare('SELECT * FROM terminal_records WHERE id=?').get(id) as SqlRow | undefined
  if (!r) return null
  return {
    id: r.id as string,
    hostId: r.host_id as string,
    resourceId: r.resource_id as string,
    hostIncarnation: r.host_incarnation as string,
    ptyId: r.pty_id as string,
    outputEpoch: r.output_epoch as string,
    lastSequence: r.last_sequence as number,
    state: r.state as string,
    processIdentity: parseJsonColumn<ProcessIncarnation>(
      r.process_identity_json,
      `terminal_records.${id}.process_identity_json`
    )
  }
}

export function currentRuntimeInstance(db: DatabaseSync): RuntimeInstanceRow | null {
  const r = db
    .prepare('SELECT * FROM runtime_instances ORDER BY controller_epoch DESC LIMIT 1')
    .get() as SqlRow | undefined
  if (!r) return null
  return {
    id: r.id as string,
    controllerEpoch: r.controller_epoch as number,
    state: r.state as string,
    processIdentity: parseJsonColumn<unknown>(
      r.process_identity_json,
      'runtime_instances.process_identity_json'
    ),
    endpointIncarnation: r.endpoint_incarnation as string
  }
}

export function controllerLeaseFor(db: DatabaseSync, hostId: string): ControllerLeaseRow | null {
  const r = db.prepare('SELECT * FROM controller_leases WHERE host_id=?').get(hostId) as
    SqlRow | undefined
  if (!r) return null
  return {
    hostId: r.host_id as string,
    epoch: r.epoch as number,
    revision: r.revision as number,
    expiresAt: r.expires_at as number,
    state: r.state as string,
    proof: parseJsonColumn<unknown>(r.proof_json, `controller_leases.${hostId}.proof_json`)
  }
}

export function claimsOwnedBy(
  db: DatabaseSync,
  ownerKind: string,
  ownerId: string
): ResourceClaimRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM resource_claims WHERE owner_kind=? AND owner_id=? AND state IN ('held','transferring','unknown')"
    )
    .all(ownerKind, ownerId) as SqlRow[]
  return rows.map((r) => ({
    id: r.id as string,
    resourceId: r.resource_id as string,
    ownerKind: r.owner_kind as string,
    ownerId: r.owner_id as string,
    mode: r.mode as 'read' | 'write',
    generation: r.generation as number,
    state: r.state as ResourceClaimRow['state'],
    revision: r.revision as number
  }))
}

export function activeExecutions(db: DatabaseSync, hostId?: string): ExecutionRow[] {
  const states = ['starting', 'start_unknown', 'awaiting_join', 'ready', 'stopping', 'stop_unknown']
  const sql = hostId
    ? `SELECT * FROM executions WHERE host_id=? AND state IN (${states.map(() => '?').join(',')})`
    : `SELECT * FROM executions WHERE state IN (${states.map(() => '?').join(',')})`
  const rows = (
    hostId ? db.prepare(sql).all(hostId, ...states) : db.prepare(sql).all(...states)
  ) as SqlRow[]
  const out: ExecutionRow[] = []
  for (const r of rows) {
    const e = loadExecution(db, r.id as string)
    if (e) out.push(e)
  }
  return out
}

export function unresolvedEffectIntents(db: DatabaseSync, hostId?: string): EffectIntentRow[] {
  const sql = hostId
    ? "SELECT id FROM effect_intents WHERE host_id=? AND state IN ('prepared','attempting','unknown')"
    : "SELECT id FROM effect_intents WHERE state IN ('prepared','attempting','unknown')"
  const rows = (hostId ? db.prepare(sql).all(hostId) : db.prepare(sql).all()) as SqlRow[]
  const out: EffectIntentRow[] = []
  for (const r of rows) {
    const e = loadEffectIntent(db, r.id as string)
    if (e) out.push(e)
  }
  return out
}

export function resumeCandidatesFor(db: DatabaseSync, executionId: string): ResumeCandidateRow[] {
  const rows = db
    .prepare('SELECT * FROM resume_candidates WHERE execution_id=?')
    .all(executionId) as SqlRow[]
  return rows.map((r) => ({
    id: r.id as string,
    executionId: r.execution_id as string,
    supportState: r.support_state as string,
    nativeHandle: parseJsonColumn<NativeConversation>(
      r.native_handle_json,
      `resume_candidates.${r.id}.native_handle_json`
    ),
    evidence: parseJsonColumn<unknown>(r.evidence_json, `resume_candidates.${r.id}.evidence_json`)
  }))
}

// ---------------------------------------------------------------------------
// result vocabulary shared across recovery modules
// ---------------------------------------------------------------------------

/** per-resource disposition outcome — worker.release never reports a blanket success */
export interface ResidualResourceResult {
  claimId: string
  resourceId: string
  mode: 'read' | 'write'
  outcome: 'retained' | 'transferred' | 'released' | 'busy' | 'unknown' | 'stale' | 'skipped'
  receipt?: unknown
  reason?: string
}

/** shape returned inside a CommandReceipt.result for recovery operations */
export interface RecoveryOperationResult {
  outcome: string
  code?: ErrorCode
  detail?: string
  [k: string]: unknown
}

export type { CommandReceipt, DatabaseSync, AuthenticatedContext }
