// mahas-runtime/mail — internal shared helpers (boundary-private).
//
// Row shapes mirror spec/storage.md §3 columns; returned objects use the
// canonical contract names (IMP-02 mahas-contracts). Nothing here is a
// public API — the public surface is mail/api.ts + registerMailOps.

import type { DatabaseSync } from 'node:sqlite'
import type {
  ArtifactRef,
  AuthenticatedContext,
  ErrorCode,
  ErrorRetry,
  ExecutionGeneration,
  Id,
  MahasError,
  Revision
} from '../../../mahas-contracts/src/common.ts'
import type { Artifact, Delivery, InboxRead, Message } from '../../../mahas-contracts/src/mail.ts'

/** throw a spec-shaped MahasError — the only failure channel these ops use */
export function fail(
  code: ErrorCode,
  message: string,
  retry: ErrorRetry = 'none',
  details?: unknown
): never {
  const err: MahasError = { code, message, retry }
  if (details !== undefined) err.details = details
  throw err
}

export const isMahasError = (e: unknown): e is MahasError =>
  typeof e === 'object' && e !== null && typeof (e as MahasError).code === 'string'

// ---------------------------------------------------------------------------
// rows (spec/storage.md §3 — snake_case as stored)
// ---------------------------------------------------------------------------

export interface MemberRow {
  id: string
  run_id: string
  generation: number
  current_execution_id: string | null
  state: string
  revision: number
}

export interface DeliveryRow {
  id: string
  message_id: string
  recipient_member_id: string
  consumer_generation: number
  status: 'outstanding' | 'acknowledged' | 'fenced'
  revision: number
  acked_at: number | null
  handling_json: string
}

export interface MessageRow {
  id: string
  run_id: string
  sender_principal_id: string
  sender_member_id: string | null
  kind: string
  body: string
  links_json: string
  created_at: number
}

export interface ArtifactRow {
  id: string
  revision: number
  run_id: string
  producer_dispatch_id: string
  output_slot: string
  digest: string
  media_type: string
  byte_length: number
  storage_ref_json: string
}

export interface DispatchRow {
  id: string
  task_id: string
  task_revision: number
  member_id: string
  execution_id: string
  generation: number
  phase: string
  authority_state: 'active' | 'settled' | 'revoked'
  revision: number
}

// ---------------------------------------------------------------------------
// loaders
// ---------------------------------------------------------------------------

export function loadMember(db: DatabaseSync, memberId: string): MemberRow | null {
  const r = db
    .prepare(
      'SELECT id, run_id, generation, current_execution_id, state, revision FROM members WHERE id = ?'
    )
    .get(memberId)
  return (r as MemberRow | undefined) ?? null
}

export function loadDelivery(db: DatabaseSync, deliveryId: string): DeliveryRow | null {
  const r = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId)
  return (r as DeliveryRow | undefined) ?? null
}

export function loadMessage(db: DatabaseSync, messageId: string): MessageRow | null {
  const r = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId)
  return (r as MessageRow | undefined) ?? null
}

export function loadArtifact(
  db: DatabaseSync,
  artifactId: string,
  revision: number
): ArtifactRow | null {
  const r = db
    .prepare('SELECT * FROM artifacts WHERE id = ? AND revision = ?')
    .get(artifactId, revision)
  return (r as ArtifactRow | undefined) ?? null
}

export function loadDispatch(db: DatabaseSync, dispatchId: string): DispatchRow | null {
  const r = db
    .prepare(
      'SELECT id, task_id, task_revision, member_id, execution_id, generation, phase, authority_state, revision FROM dispatches WHERE id = ?'
    )
    .get(dispatchId)
  return (r as DispatchRow | undefined) ?? null
}

export function principalKind(db: DatabaseSync, principalId: string): string | null {
  const r = db.prepare('SELECT kind FROM principals WHERE id = ?').get(principalId) as
    { kind: string } | undefined
  return r?.kind ?? null
}

// ---------------------------------------------------------------------------
// member credential fence (REQ-15/REQ-18, D-MAIL §2)
// ---------------------------------------------------------------------------

/**
 * Resolve the caller's Member and enforce the consumer-generation fence:
 * a credential minted for an older execution generation is fenced and must
 * not read, ack or send as the current one (STALE_EXECUTION).
 */
export function requireCurrentMember(db: DatabaseSync, ctx: AuthenticatedContext): MemberRow {
  if (!ctx.memberId) {
    fail('UNAUTHENTICATED', 'this operation requires a Member-scoped credential', 'none')
  }
  const member = loadMember(db, ctx.memberId as string)
  if (!member) {
    fail('UNAUTHENTICATED', `member ${ctx.memberId} not found`, 'none')
  }
  assertCurrentGeneration(ctx, member)
  return member!
}

export function assertCurrentGeneration(ctx: AuthenticatedContext, member: MemberRow): void {
  if (ctx.executionGeneration === undefined || ctx.executionGeneration === null) {
    fail(
      'STALE_EXECUTION',
      'credential carries no execution generation — cannot prove it is the current consumer',
      'reconcile'
    )
  }
  if (Number(ctx.executionGeneration) !== member.generation) {
    fail(
      'STALE_EXECUTION',
      `credential generation ${ctx.executionGeneration} is fenced — member ${member.id} is at generation ${member.generation}`,
      'reconcile'
    )
  }
}

// ---------------------------------------------------------------------------
// generation rebinding + fencing (D-MAIL §2)
// ---------------------------------------------------------------------------

/**
 * Re-bind this member's unprocessed (outstanding) deliveries to its current
 * consumer generation. Outstanding status is preserved — the message is
 * neither duplicated nor resent; only the consumer generation pointer moves.
 * Idempotent; invoked lazily by member ops so the ledger converges even if
 * the generation bump was recorded by the execution boundary first.
 */
export function rebindOutstandingDeliveries(
  db: DatabaseSync,
  memberId: string,
  generation: number
): number {
  const r = db
    .prepare(
      `UPDATE deliveries
         SET consumer_generation = ?, revision = revision + 1
       WHERE recipient_member_id = ? AND status = 'outstanding' AND consumer_generation < ?`
    )
    .run(generation, memberId, generation)
  return Number(r.changes)
}

/**
 * Close receipt entirely: outstanding deliveries become 'fenced'. Used when
 * a Member is retired — the rows stay as history but can never be read or
 * acked. Exported for the retirement/stop path (IMP-13/IMP-22 composition).
 */
export function fenceDeliveriesForMember(db: DatabaseSync, memberId: string): number {
  const r = db
    .prepare(
      `UPDATE deliveries
         SET status = 'fenced', revision = revision + 1
       WHERE recipient_member_id = ? AND status = 'outstanding'`
    )
    .run(memberId)
  return Number(r.changes)
}

// ---------------------------------------------------------------------------
// row → contract mapping
// ---------------------------------------------------------------------------

export function rowToMessage(r: MessageRow): Message {
  const m: Message = {
    id: r.id as Id,
    runId: r.run_id as Id,
    senderPrincipalId: r.sender_principal_id as Id,
    senderMemberId: (r.sender_member_id as Id | null) ?? null,
    kind: r.kind,
    body: r.body,
    links: parseJson(r.links_json, {}),
    createdAt: r.created_at
  }
  return m
}

export function rowToDelivery(r: DeliveryRow): Delivery {
  const d: Delivery = {
    id: r.id as Id,
    messageId: r.message_id as Id,
    recipientMemberId: r.recipient_member_id as Id,
    consumerGeneration: r.consumer_generation as ExecutionGeneration,
    status: r.status,
    revision: r.revision as Revision,
    ackedAt: r.acked_at,
    handling: parseJson(r.handling_json, {})
  }
  return d
}

export function rowToArtifact(r: ArtifactRow): Artifact {
  const a: Artifact = {
    id: r.id as Id,
    revision: r.revision as Revision,
    runId: r.run_id as Id,
    producerDispatchId: r.producer_dispatch_id as Id,
    outputSlot: r.output_slot,
    digest: r.digest,
    mediaType: r.media_type,
    byteLength: r.byte_length,
    storageRef: parseJson(r.storage_ref_json, {})
  }
  return a
}

export function makeInboxRead(
  member: MemberRow,
  batchCursor: string,
  deliveryIds: Id[]
): InboxRead {
  const read: InboxRead = {
    memberId: member.id as Id,
    executionGeneration: member.generation as ExecutionGeneration,
    batchCursor,
    deliveryIds
  }
  return read
}

function parseJson(text: string, fallback: unknown): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** artifact refs attached to a message via links_json.artifactRefs */
export function messageArtifactRefs(m: MessageRow): ArtifactRef[] {
  const links = parseJson(m.links_json, {}) as { artifactRefs?: unknown }
  return Array.isArray(links.artifactRefs) ? (links.artifactRefs as ArtifactRef[]) : []
}

/** every referenced artifact must exist at that exact id+revision (+digest when given) */
export function assertArtifactRefsExist(db: DatabaseSync, refs: ArtifactRef[] | undefined): void {
  for (const ref of refs ?? []) {
    const row = db
      .prepare('SELECT digest FROM artifacts WHERE id = ? AND revision = ?')
      .get(ref.artifactId, ref.revision) as { digest: string } | undefined
    if (!row) {
      fail(
        'ARTIFACT_MISMATCH',
        `referenced artifact ${ref.artifactId}@${ref.revision} does not exist`,
        'none'
      )
    }
    if (ref.digest && row.digest !== ref.digest) {
      fail(
        'ARTIFACT_MISMATCH',
        `referenced artifact ${ref.artifactId}@${ref.revision} has a different digest`,
        'none'
      )
    }
  }
}

// ---------------------------------------------------------------------------
// payload validation (runtime — payloads arrive as `unknown` off the wire)
// ---------------------------------------------------------------------------

export function asObject(v: unknown, op: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    fail('INPUT_NOT_READY', `${op}: payload must be an object`, 'none')
  }
  return v as Record<string, unknown>
}

export function reqString(o: Record<string, unknown>, key: string, op: string): string {
  const v = o[key]
  if (typeof v !== 'string' || v.length === 0) {
    fail('INPUT_NOT_READY', `${op}: '${key}' must be a non-empty string`, 'none')
  }
  return v
}

export function optString(o: Record<string, unknown>, key: string, op: string): string | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || v.length === 0) {
    fail('INPUT_NOT_READY', `${op}: '${key}' must be a non-empty string when present`, 'none')
  }
  return v
}

export function reqInt(o: Record<string, unknown>, key: string, op: string, min = 0): number {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    fail('INPUT_NOT_READY', `${op}: '${key}' must be an integer >= ${min}`, 'none')
  }
  return v
}

export function optInt(
  o: Record<string, unknown>,
  key: string,
  op: string,
  min = 0
): number | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  return reqInt({ [key]: v }, key, op, min)
}

export function reqStringArray(o: Record<string, unknown>, key: string, op: string): string[] {
  const v = o[key]
  if (
    !Array.isArray(v) ||
    v.length === 0 ||
    !v.every((x) => typeof x === 'string' && x.length > 0)
  ) {
    fail(
      'INPUT_NOT_READY',
      `${op}: '${key}' must be a non-empty array of non-empty strings`,
      'none'
    )
  }
  return v as string[]
}

export function optStringArray(
  o: Record<string, unknown>,
  key: string,
  op: string
): string[] | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.length > 0)) {
    fail('INPUT_NOT_READY', `${op}: '${key}' must be an array of non-empty strings`, 'none')
  }
  return v as string[]
}

export function optArtifactRefs(
  o: Record<string, unknown>,
  key: string,
  op: string
): ArtifactRef[] | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (
    !Array.isArray(v) ||
    !v.every(
      (x) =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as ArtifactRef).artifactId === 'string' &&
        typeof (x as ArtifactRef).revision === 'number'
    )
  ) {
    fail(
      'INPUT_NOT_READY',
      `${op}: '${key}' must be an array of {artifactId, revision, digest?}`,
      'none'
    )
  }
  return v as ArtifactRef[]
}

export function reqHandling(
  o: Record<string, unknown>,
  key: string,
  op: string
): 'completed' | 'durably-deferred' {
  const v = o[key]
  if (v !== 'completed' && v !== 'durably-deferred') {
    fail('INPUT_NOT_READY', `${op}: '${key}' must be 'completed' | 'durably-deferred'`, 'none')
  }
  return v
}

/** opaque inbox cursor = last returned deliveries.rowid; absent cursor = from the head */
export function parseCursor(o: Record<string, unknown>, op: string): number {
  const v = o.cursor
  if (v === undefined || v === null) return 0
  if (typeof v !== 'string' || !/^\d+$/.test(v)) {
    fail(
      'INPUT_NOT_READY',
      `${op}: 'cursor' must be an opaque string returned by a previous inbox op`,
      'none'
    )
  }
  return Number(v)
}

export function uniqueStrings(ids: string[]): string[] {
  return [...new Set(ids)]
}

export function defaultNow(): number {
  return Date.now()
}

export function defaultNewId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}
