// resources/checkout.ts — canonical Checkout identity + shared resources kernel.
//
// IMP-16 (C-RESOURCE, spec/contracts/resources.md; D-RESOURCE §1/4/5,
// spec/domains/resources-observation.md; DDL spec/storage.md §3).
//
// The central invariant this module exists for: a Workspace is a LOGICAL
// handle, a Checkout is the PHYSICAL directory identity. Write-claim
// exclusivity is decided on Checkout(hostId, canonicalPath,
// filesystemIdentity) — never on workspaceId or project name (D-RESOURCE §4).
// filesystemIdentity is the host-reported "dev:ino" (or equivalent) birth
// evidence of the directory; a deleted-and-recreated directory is a NEW
// resource even at the same path.

import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Checkout, Resource, Workspace } from '../../../mahas-contracts/src/resource.ts'
import type {
  ErrorCode,
  ErrorRetry,
  Id,
  MahasError,
  Revision
} from '../../../mahas-contracts/src/common.ts'

// ---------------------------------------------------------------------------
// errors — spec/common.md §4 fixed codes only. Helpers THROW MahasError-shaped
// objects; OperationRegistry.dispatch (IMP-11) converts them into receipts.
// ---------------------------------------------------------------------------

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

export function isMahasError(e: unknown): e is MahasError {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'string' &&
    typeof (e as { message?: unknown }).message === 'string'
  )
}

// ---------------------------------------------------------------------------
// ids / time — deps may override for deterministic wiring (mod.ts defaults
// call these). IDs are opaque (S-COMMON §1): the prefix is debugging sugar,
// never parse it back out.
// ---------------------------------------------------------------------------

export function mintId(kind: string): Id {
  return `${kind}_${randomUUID()}` as Id
}

// ---------------------------------------------------------------------------
// canonical path + filesystem identity
// ---------------------------------------------------------------------------

/**
 * Best-effort LOCAL canonicalization of a path the caller asked for. The
 * authoritative identity always comes back from the execution-host effect —
 * this guess only drives the pre-flight overlap scan, so two writers racing
 * for the same target path collide here instead of inside git/mkdir.
 *
 * Resolves '..'/'.', then realpaths the deepest existing ancestor and
 * re-appends the non-existing tail (a not-yet-created worktree has no inode
 * yet, but its parent does — symlinked parents still canonicalize).
 */
export function canonicalPathGuess(targetPath: string): string {
  const abs = resolve(targetPath)
  try {
    return realpathSync.native(abs)
  } catch {
    // path (or a parent) does not exist yet — canonicalize what exists
  }
  // walk up until something exists
  let cursor = abs
  const tail: string[] = []
  for (;;) {
    const parent = resolve(cursor, '..')
    tail.unshift(cursor.slice(parent.length + 1))
    cursor = parent
    try {
      const real = realpathSync.native(cursor)
      return tail.length ? [real, ...tail].join('/') : real
    } catch {
      if (parent === cursor) return abs // filesystem root unreachable — give up
    }
  }
}

/** dev:ino filesystem identity — the "or equivalent" fallback for filesystems without ino is documented in the handoff */
export function filesystemIdentityOf(st: { dev: number | bigint; ino: number | bigint }): string {
  return `devino:${st.dev.toString()}:${st.ino.toString()}`
}

/** stat a path → dev:ino identity, or null when positively absent (ENOENT/ENOTDIR). Other errors = unverifiable. */
export function liveFilesystemIdentity(path: string): {
  status: 'present' | 'absent'
  identity?: string
  error?: string
} {
  try {
    const st = statSync(path)
    return { status: 'present', identity: filesystemIdentityOf(st) }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'absent' }
    return { status: 'absent', error: `stat-unverifiable:${code ?? String(e)}` }
  }
}

// ---------------------------------------------------------------------------
// rows ↔ contract objects (field names = camelCase of DDL columns, SHARED-APIS)
// ---------------------------------------------------------------------------

export interface ResourceRow {
  id: string
  kind: string
  host_id: string | null
  identity_json: string
}

export interface CheckoutRow {
  id: string
  resource_id: string
  host_id: string
  canonical_path: string
  filesystem_identity: string
  repository_json: string
  revision: number
}

export interface WorkspaceRow {
  id: string
  project_id: string
  checkout_id: string
  kind: string
  state: string
}

/** repository_json payload shape — kept as one JSON column per DDL */
export interface CheckoutRepository {
  repositoryIdentity?: string
  worktreeIdentity?: string
  headCommit?: string
  isRepo?: boolean
}

export function toResource(row: ResourceRow): Resource {
  return {
    id: row.id as Id,
    kind: row.kind,
    hostId: (row.host_id ?? undefined) as Id | undefined,
    identity: JSON.parse(row.identity_json)
  } as unknown as Resource
}

export function toCheckout(row: CheckoutRow): Checkout {
  return {
    id: row.id as Id,
    resourceId: row.resource_id as Id,
    hostId: row.host_id as Id,
    canonicalPath: row.canonical_path,
    filesystemIdentity: row.filesystem_identity,
    repository: JSON.parse(row.repository_json) as CheckoutRepository,
    revision: row.revision as Revision
  } as unknown as Checkout
}

export function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id as Id,
    projectId: row.project_id as Id,
    checkoutId: row.checkout_id as Id,
    kind: row.kind,
    state: row.state
  } as unknown as Workspace
}

// ---------------------------------------------------------------------------
// row access
// ---------------------------------------------------------------------------

export function getCheckout(db: DatabaseSync, id: string): CheckoutRow | null {
  const row = db
    .prepare(
      'SELECT id, resource_id, host_id, canonical_path, filesystem_identity, repository_json, revision FROM checkouts WHERE id=?'
    )
    .get(id) as CheckoutRow | undefined
  return row ?? null
}

export function getCheckoutByResource(db: DatabaseSync, resourceId: string): CheckoutRow | null {
  const row = db
    .prepare(
      'SELECT id, resource_id, host_id, canonical_path, filesystem_identity, repository_json, revision FROM checkouts WHERE resource_id=?'
    )
    .get(resourceId) as CheckoutRow | undefined
  return row ?? null
}

export function getResource(db: DatabaseSync, id: string): ResourceRow | null {
  const row = db
    .prepare('SELECT id, kind, host_id, identity_json FROM resources WHERE id=?')
    .get(id) as ResourceRow | undefined
  return row ?? null
}

export function getWorkspace(db: DatabaseSync, id: string): WorkspaceRow | null {
  const row = db
    .prepare('SELECT id, project_id, checkout_id, kind, state FROM workspaces WHERE id=?')
    .get(id) as WorkspaceRow | undefined
  return row ?? null
}

export function getWorkspaceByCheckout(db: DatabaseSync, checkoutId: string): WorkspaceRow | null {
  const row = db
    .prepare('SELECT id, project_id, checkout_id, kind, state FROM workspaces WHERE checkout_id=?')
    .get(checkoutId) as WorkspaceRow | undefined
  return row ?? null
}

/** all checkout rows registered at (hostId, canonicalPath) — any filesystem identity */
export function checkoutsAt(
  db: DatabaseSync,
  hostId: string,
  canonicalPath: string
): CheckoutRow[] {
  return db
    .prepare(
      'SELECT id, resource_id, host_id, canonical_path, filesystem_identity, repository_json, revision FROM checkouts WHERE host_id=? AND canonical_path=?'
    )
    .all(hostId, canonicalPath) as unknown as CheckoutRow[]
}

/** a provisional identity marks a checkout whose host effect has not finalized */
export const PENDING_IDENTITY_PREFIX = 'pending:'

export function isPendingIdentity(filesystemIdentity: string): boolean {
  return filesystemIdentity.startsWith(PENDING_IDENTITY_PREFIX)
}
