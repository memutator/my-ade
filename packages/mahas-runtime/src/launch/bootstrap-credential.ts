// mahas-runtime — execution bootstrap credential lifecycle (launch/access).
//
// IMP-20. Owns the secret material behind execution_credentials:
//   issue      — worker.start (IMP-19) mints a bootstrap credential inside its
//                admission transaction; the RAW SECRET is returned once for the
//                private connection file and is never stored, logged, or put on
//                argv/env/model input (spec/domains/access.md ExecutionCredential).
//   authenticate — IMP-12's worker-auth resolves a presented credential id +
//                secret into the execution binding used to build
//                AuthenticatedContext. Returns null on any failure — never
//                reveals which part failed.
//   promotion  — execution.join flips mode bootstrap→full in the same tx as
//                the WorkerJoin (server-side 승격, spec/contracts/launch.md).
//   fence/rebind — a new execution generation revokes the old generation's
//                credentials and re-binds outstanding Deliveries to the new
//                consumer generation (spec/domains/messaging-outcomes.md §2).
//
// Secret hash format: `sha256:<lowercase hex>` via the shared sha256Hex
// helper. The secret itself is 256-bit random, so the threat model is not
// offline brute force; the scheme prefix lets IMP-10's verifySecret dispatch
// on format (and remains comparable as a bare sha256 if the prefix is
// stripped). Documented for handoff:IMP-10 — verifySecret MUST accept this
// format for worker authentication to succeed.

import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  ControllerEpoch,
  ExecutionGeneration,
  Id
} from '../../../mahas-contracts/src/index.ts'
import type { ExecutionCredential } from '../../../mahas-contracts/src/index.ts'
import { sha256Hex } from '../storage/db.ts'
import { verifySecret } from '../access/authorize.ts'
import {
  currentControllerEpoch,
  fail,
  loadCredentialById,
  loadExecution,
  loadGrant,
  loadMember,
  newId,
  requireString,
  asPayload,
  type CredentialRow
} from './store.ts'

/** bootstrap mode admits only these operations — spec/domains/access.md §3 */
export const BOOTSTRAP_ALLOWED_ACTIONS: readonly string[] = [
  'execution.join',
  'assignment.show',
  'surface.describe',
  'operation.get'
] as const

/** worker-auth (IMP-12) pre-dispatch check: bootstrap credentials may not reach beyond this surface */
export function isBootstrapOperationAllowed(operation: string): boolean {
  return BOOTSTRAP_ALLOWED_ACTIONS.includes(operation)
}

export function hashWorkerSecret(secret: string): string {
  return `sha256:${sha256Hex(secret)}`
}

export function generateWorkerSecret(): string {
  return randomBytes(32).toString('hex')
}

export interface IssuedBootstrapCredential {
  /** state identifier — safe to return/log */
  credentialId: string
  /** raw secret — returned ONCE for the private connection file only */
  secret: string
  executionId: string
  generation: number
  principalId: string
}

/**
 * Mint a bootstrap-mode ExecutionCredential for an execution. Called inside
 * worker.start's admission transaction (IMP-19) — the caller passes the
 * execution it just committed and the member principal that will
 * authenticate. The operator credential is never minted or forwarded here.
 */
export function issueBootstrapCredential(
  db: DatabaseSync,
  input: { executionId: string; generation: number; principalId: string; at?: number }
): IssuedBootstrapCredential {
  const execution = loadExecution(db, input.executionId)
  if (!execution) {
    fail('STALE_EXECUTION', `execution ${input.executionId} does not exist`, 'reconcile')
  }
  if (execution.generation !== input.generation) {
    fail(
      'STALE_EXECUTION',
      `execution ${input.executionId} is generation ${execution.generation}, not ${input.generation}`,
      'reconcile'
    )
  }
  const secret = generateWorkerSecret()
  const credentialId = newId()
  db.prepare(
    `INSERT INTO execution_credentials
       (id, secret_hash, principal_id, execution_id, generation, mode, revoked_at, revision)
     VALUES (?, ?, ?, ?, ?, 'bootstrap', NULL, 1)`
  ).run(
    credentialId,
    hashWorkerSecret(secret),
    input.principalId,
    input.executionId,
    input.generation
  )
  return {
    credentialId,
    secret,
    executionId: input.executionId,
    generation: input.generation,
    principalId: input.principalId
  }
}

/** what worker-auth needs to build AuthenticatedContext (spec/common.md §2) */
export interface WorkerCredentialBinding {
  credentialId: string
  mode: 'bootstrap' | 'full'
  principalId: string
  memberId: string
  executionId: string
  executionGeneration: number
  controllerEpoch: number
  grantRevisions: Record<string, number>
}

/** ctx fragment callers may spread into a transport-level AuthenticatedContext */
export function bindingToContextFields(binding: WorkerCredentialBinding): {
  principalId: Id
  memberId: Id
  executionId: Id
  executionGeneration: ExecutionGeneration
  controllerEpoch: ControllerEpoch
  grantRevisions: Record<string, number>
} {
  return {
    principalId: binding.principalId as Id,
    memberId: binding.memberId as Id,
    executionId: binding.executionId as Id,
    executionGeneration: binding.executionGeneration as ExecutionGeneration,
    controllerEpoch: binding.controllerEpoch as ControllerEpoch,
    grantRevisions: binding.grantRevisions
  }
}

/**
 * Resolve a presented credential to its execution binding, or null.
 * Deliberately returns null for unknown id / revoked / bad secret alike —
 * the failure mode must not disclose which check failed. The caller
 * (IMP-12 worker-auth) additionally enforces the bootstrap surface via
 * isBootstrapOperationAllowed when binding.mode === 'bootstrap'.
 */
export function authenticateWorkerCredential(
  db: DatabaseSync,
  credentialId: string,
  secret: string
): WorkerCredentialBinding | null {
  const row = loadCredentialById(db, credentialId)
  if (!row || row.revoked_at !== null) return null
  if (!verifySecret(secret, row.secret_hash)) return null
  const execution = loadExecution(db, row.execution_id)
  if (!execution) return null
  const member = loadMember(db, execution.member_id)
  if (!member) return null
  const grantRevisions: Record<string, number> = {}
  const assignment = latestAssignmentGrant(db, member.id)
  if (assignment) {
    const grant = loadGrant(db, assignment)
    if (grant) grantRevisions[grant.id] = grant.revision
  }
  return {
    credentialId: row.id,
    mode: row.mode === 'bootstrap' ? 'bootstrap' : 'full',
    principalId: row.principal_id,
    memberId: member.id,
    executionId: execution.id,
    executionGeneration: row.generation,
    controllerEpoch: currentControllerEpoch(db),
    grantRevisions
  }
}

function latestAssignmentGrant(db: DatabaseSync, memberId: string): string | null {
  const row = db
    .prepare(
      `SELECT grant_id FROM assignments WHERE member_id = ?
       ORDER BY revision DESC LIMIT 1`
    )
    .get(memberId) as { grant_id: string } | undefined
  return row?.grant_id ?? null
}

/**
 * Server-side promotion executed inside execution.join's transaction.
 * Only a live bootstrap credential is promoted — a no-op on anything else
 * keeps replayed joins honest instead of silently re-mutating.
 */
export function promoteCredentialToFull(db: DatabaseSync, credentialId: string): boolean {
  const result = db
    .prepare(
      `UPDATE execution_credentials
       SET mode = 'full', revision = revision + 1
       WHERE id = ? AND mode = 'bootstrap' AND revoked_at IS NULL`
    )
    .run(credentialId)
  return result.changes > 0
}

/**
 * Fence every credential of the member's superseded generations. Invoked by
 * the generation-bump path (worker.start of a new generation / worker.resume)
 * together with rebindConsumerGeneration — a past generation's secret must
 * never authenticate a current authority mutation.
 */
export function fenceSupersededCredentials(
  db: DatabaseSync,
  input: { memberId: string; newGeneration: number; at: number }
): number {
  const result = db
    .prepare(
      `UPDATE execution_credentials SET revoked_at = ?, revision = revision + 1
       WHERE revoked_at IS NULL AND execution_id IN (
         SELECT id FROM executions WHERE member_id = ? AND generation <> ?
       )`
    )
    .run(input.at, input.memberId, input.newGeneration)
  return Number(result.changes)
}

/**
 * Consumer-generation 조정 포트 (instruction §4.5): when a member's new
 * execution generation actually starts, fence old credentials and rebind
 * outstanding Deliveries to the new consumer generation. Deliveries are
 * re-pointed, never duplicated (spec/domains/messaging-outcomes.md §2).
 * Returns what changed so the caller can put it in its own receipt.
 */
export function rebindConsumerGeneration(
  db: DatabaseSync,
  input: { memberId: string; newGeneration: number; at: number }
): { fencedCredentials: number; reboundDeliveries: number } {
  const fencedCredentials = fenceSupersededCredentials(db, input)
  const result = db
    .prepare(
      `UPDATE deliveries SET consumer_generation = ?, revision = revision + 1
       WHERE recipient_member_id = ? AND status = 'outstanding' AND consumer_generation <> ?`
    )
    .run(input.newGeneration, input.memberId, input.newGeneration)
  return { fencedCredentials, reboundDeliveries: Number(result.changes) }
}

/** typed view of a stored credential row for callers that inspect mode/state */
export function describeCredential(row: CredentialRow): ExecutionCredential {
  return {
    id: row.id as ExecutionCredential['id'],
    secretHash: row.secret_hash,
    principalId: row.principal_id as ExecutionCredential['principalId'],
    executionId: row.execution_id as ExecutionCredential['executionId'],
    generation: row.generation as ExecutionCredential['generation'],
    mode: row.mode as ExecutionCredential['mode'],
    revokedAt: row.revoked_at ?? undefined,
    revision: row.revision as ExecutionCredential['revision']
  }
}

/** internal: parse an authenticate payload {credentialId, secret} if exposed as an operation later */
export function parseCredentialPayload(raw: unknown): { credentialId: string; secret: string } {
  const payload = asPayload(raw)
  return {
    credentialId: requireString(payload, 'credentialId'),
    secret: requireString(payload, 'secret')
  }
}
