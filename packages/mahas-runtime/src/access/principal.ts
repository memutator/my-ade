// principal.ts — Principal store (spec/domains/access.md §1,
// spec/storage.md §3 `principals`).
//
// A Principal is the credential-facing identity: operator / member /
// service. Workers never choose it from payload — the server builds
// AuthenticatedContext.principalId from the credential. Status vocabulary is
// deliberately small in this module: only 'active' authorizes. Every other
// status denies; a missing env/credential NEVER falls back to an operator
// path (spec §3, REQ-09).

import type { DatabaseSync } from 'node:sqlite'
import type { Id, Principal } from '../../../mahas-contracts/src/index.ts'
import { fail } from './internal.ts'

export type PrincipalKind = 'operator' | 'member' | 'service'
export const PRINCIPAL_STATUS_ACTIVE = 'active'

/** Row shape of spec/storage.md §3 `principals` (id, kind, status). */
export interface PrincipalRow {
  id: string
  kind: string
  status: string
}

export function getPrincipalRow(db: DatabaseSync, id: string): PrincipalRow | null {
  const row = db.prepare('SELECT id, kind, status FROM principals WHERE id = ?').get(id) as
    PrincipalRow | undefined
  return row ?? null
}

/** Contract view of a principal row (field names follow access.md §1). */
export function getPrincipal(db: DatabaseSync, id: string): Principal | null {
  const row = getPrincipalRow(db, id)
  if (!row) return null
  return {
    id: row.id as Id,
    kind: row.kind as Principal['kind'],
    status: row.status
  }
}

export function upsertPrincipal(
  db: DatabaseSync,
  input: { id: string; kind: PrincipalKind; status?: string }
): void {
  db.prepare(
    `INSERT INTO principals (id, kind, status) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, status = excluded.status`
  ).run(input.id, input.kind, input.status ?? PRINCIPAL_STATUS_ACTIVE)
}

export function setPrincipalStatus(db: DatabaseSync, id: string, status: string): void {
  const result = db.prepare('UPDATE principals SET status = ? WHERE id = ?').run(status, id)
  if (result.changes === 0) fail('INPUT_NOT_READY', `unknown principal '${id}'`)
}

/**
 * Load a principal and require it to be currently usable. Anything else is
 * UNAUTHENTICATED — suspension/unknown identities are never silently
 * re-scoped to another principal.
 */
export function requireActivePrincipal(db: DatabaseSync, id: string): PrincipalRow {
  const row = getPrincipalRow(db, id)
  if (!row) fail('UNAUTHENTICATED', `unknown principal '${id}'`)
  if (row.status !== PRINCIPAL_STATUS_ACTIVE) {
    fail('UNAUTHENTICATED', `principal '${id}' has status '${row.status}'`)
  }
  return row
}
