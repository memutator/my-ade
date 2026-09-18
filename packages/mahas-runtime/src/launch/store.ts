// mahas-runtime — launch/access internal row store.
//
// IMP-20 (worker bootstrap·join·명시 Task 인수). Private to the launch
// boundary: snake_case projections of spec/storage.md §3 rows plus the
// payload/error helpers the join/acceptance handlers share. These row
// interfaces are NOT contract types — they mirror DDL columns exactly and
// never cross the boundary.

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ErrorCode, ErrorRetry } from '../../../mahas-contracts/src/index.ts'
import { mahasError } from '../api/handler-ports.ts'

/** throw a contract-shaped MahasError; the admission pipeline rejects the receipt */
export function fail(
  code: ErrorCode,
  message: string,
  retry: ErrorRetry = 'none',
  details?: unknown
): never {
  throw mahasError(code, message, retry, details)
}

export function newId(): string {
  return randomUUID()
}

// ---------- payload field readers (payload is unknown at the boundary) ----------

export function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  if (typeof value !== 'string' || value.length === 0) {
    fail('INPUT_NOT_READY', `payload.${field} must be a non-empty string`, 'none')
  }
  return value
}

export function requireInt(payload: Record<string, unknown>, field: string): number {
  const value = payload[field]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail('INPUT_NOT_READY', `payload.${field} must be an integer`, 'none')
  }
  return value
}

export function optionalString(
  payload: Record<string, unknown>,
  field: string
): string | undefined {
  const value = payload[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    fail('INPUT_NOT_READY', `payload.${field} must be a string when present`, 'none')
  }
  return value
}

export function asPayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('INPUT_NOT_READY', 'payload must be an object', 'none')
  }
  return raw as Record<string, unknown>
}

// ---------- row projections (spec/storage.md §3 column names verbatim) ----------

export interface ExecutionRow {
  id: string
  member_id: string
  generation: number
  host_id: string
  launch_plan_id: string
  state: string
  liveness: string
  terminal_id: string | null
  process_identity_json: string
  native_conversation_json: string
  revision: number
}

export interface LaunchPlanRow {
  id: string
  assignment_id: string
  assignment_revision: number
  digest: string
  bundle_digest: string
  envelope_digest: string
  surface_digest: string
  state: string
  process_spec_json: string
  pins_json: string
  reservations_json: string
}

export interface AssignmentRow {
  id: string
  revision: number
  member_id: string
  kind: string // 'coordination' | 'task'
  mandate_text: string
  grant_id: string
  task_id: string | null
  task_revision: number | null
  scope_json: string
}

export interface GrantRow {
  id: string
  revision: number
  kind: string
  principal_id: string
  parent_grant_id: string | null
  policy_id: string | null
  policy_revision: number | null
  expires_at: number | null
  revoked_at: number | null
  scope_json: string
  actions_json: string
}

export interface CredentialRow {
  id: string
  secret_hash: string
  principal_id: string
  execution_id: string
  generation: number
  mode: string // 'bootstrap' | 'full'
  revoked_at: number | null
  revision: number
}

export interface DispatchRow {
  id: string
  task_id: string
  task_revision: number
  member_id: string
  execution_id: string
  generation: number
  envelope_digest: string
  phase: string
  authority_state: string // 'active' | 'settled' | 'revoked'
  assignment_delivery_id: string | null
  revision: number
}

export interface DeliveryRow {
  id: string
  message_id: string
  recipient_member_id: string
  consumer_generation: number
  status: string // 'outstanding' | 'acknowledged' | 'fenced'
  revision: number
  acked_at: number | null
  handling_json: string
}

export interface WorkerJoinRow {
  execution_id: string
  generation: number
  bundle_digest: string
  surface_digest: string
  envelope_digest: string
  joined_at: number
}

export interface MemberRow {
  id: string
  run_id: string
  model_version: string
  role_id: string
  implementation_id: string
  implementation_revision: number
  generation: number
  current_execution_id: string | null
  state: string
  revision: number
}

// ---------- loaders ----------

function get<T>(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): T | null {
  const row = db.prepare(sql).get(...(params as never[])) as T | undefined
  return row === undefined ? null : row
}

export function loadExecution(db: DatabaseSync, id: string): ExecutionRow | null {
  return get<ExecutionRow>(db, 'SELECT * FROM executions WHERE id = ?', id)
}

export function loadLaunchPlan(db: DatabaseSync, id: string): LaunchPlanRow | null {
  return get<LaunchPlanRow>(db, 'SELECT * FROM launch_plans WHERE id = ?', id)
}

export function loadAssignment(
  db: DatabaseSync,
  id: string,
  revision: number
): AssignmentRow | null {
  return get<AssignmentRow>(
    db,
    'SELECT * FROM assignments WHERE id = ? AND revision = ?',
    id,
    revision
  )
}

export function loadGrant(db: DatabaseSync, id: string): GrantRow | null {
  return get<GrantRow>(db, 'SELECT * FROM grants WHERE id = ?', id)
}

export function loadMember(db: DatabaseSync, id: string): MemberRow | null {
  return get<MemberRow>(db, 'SELECT * FROM members WHERE id = ?', id)
}

export function loadDispatch(db: DatabaseSync, id: string): DispatchRow | null {
  return get<DispatchRow>(db, 'SELECT * FROM dispatches WHERE id = ?', id)
}

export function loadDelivery(db: DatabaseSync, id: string): DeliveryRow | null {
  return get<DeliveryRow>(db, 'SELECT * FROM deliveries WHERE id = ?', id)
}

export function loadWorkerJoin(
  db: DatabaseSync,
  executionId: string,
  generation: number
): WorkerJoinRow | null {
  return get<WorkerJoinRow>(
    db,
    'SELECT * FROM worker_joins WHERE execution_id = ? AND generation = ?',
    executionId,
    generation
  )
}

/** the live credential a principal holds for an execution+generation, if any */
export function findLiveCredential(
  db: DatabaseSync,
  executionId: string,
  generation: number,
  principalId: string
): CredentialRow | null {
  return get<CredentialRow>(
    db,
    `SELECT * FROM execution_credentials
     WHERE execution_id = ? AND generation = ? AND principal_id = ? AND revoked_at IS NULL
     ORDER BY revision DESC LIMIT 1`,
    executionId,
    generation,
    principalId
  )
}

export function loadCredentialById(db: DatabaseSync, id: string): CredentialRow | null {
  return get<CredentialRow>(db, 'SELECT * FROM execution_credentials WHERE id = ?', id)
}

/** the grant bound to the execution's assignment (via its launch plan) */
export function grantForExecution(
  db: DatabaseSync,
  execution: ExecutionRow
): { assignment: AssignmentRow; grant: GrantRow } | null {
  const plan = loadLaunchPlan(db, execution.launch_plan_id)
  if (!plan) return null
  const assignment = loadAssignment(db, plan.assignment_id, plan.assignment_revision)
  if (!assignment) return null
  const grant = loadGrant(db, assignment.grant_id)
  if (!grant) return null
  return { assignment, grant }
}

/** reject when the assignment grant was revoked or expired — re-read inside the tx */
export function requireLiveGrant(grant: GrantRow | null, now: number, what: string): GrantRow {
  if (!grant) fail('SCOPE_DENIED', `no grant bound to ${what}`, 'none')
  if (grant.revoked_at !== null) {
    fail('GRANT_REVOKED', `grant ${grant.id} for ${what} was revoked`, 'replan')
  }
  if (grant.expires_at !== null && grant.expires_at <= now) {
    fail('GRANT_REVOKED', `grant ${grant.id} for ${what} expired`, 'replan')
  }
  return grant
}

/**
 * resolveRevisions helper: current revision for any entity id the caller
 * pins via CommandRequest.expectedRevisions — read inside the write tx by
 * the admission pipeline (spec/common.md §3).
 */
export function revisionsOf(
  db: DatabaseSync,
  entityIds: readonly string[]
): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {}
  const probes: ((id: string) => { revision: number } | null)[] = [
    (id) => get<{ revision: number }>(db, 'SELECT revision FROM executions WHERE id = ?', id),
    (id) => get<{ revision: number }>(db, 'SELECT revision FROM dispatches WHERE id = ?', id),
    (id) => get<{ revision: number }>(db, 'SELECT revision FROM members WHERE id = ?', id),
    (id) => get<{ revision: number }>(db, 'SELECT revision FROM deliveries WHERE id = ?', id),
    (id) => get<{ revision: number }>(db, 'SELECT revision FROM grants WHERE id = ?', id)
  ]
  for (const id of entityIds) {
    out[id] = undefined
    for (const probe of probes) {
      const row = probe(id)
      if (row) {
        out[id] = row.revision
        break
      }
    }
  }
  return out
}

/** current controller epoch — runtime_instances holds the single writer's epoch */
export function currentControllerEpoch(db: DatabaseSync): number {
  const row = get<{ controller_epoch: number }>(
    db,
    'SELECT controller_epoch FROM runtime_instances ORDER BY controller_epoch DESC LIMIT 1'
  )
  return row?.controller_epoch ?? 0
}
