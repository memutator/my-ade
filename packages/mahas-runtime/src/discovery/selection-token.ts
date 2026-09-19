// mahas-runtime/src/discovery/selection-token.ts — integrity-protected
// opaque values: the selectionToken on every CandidateCard and the page
// cursor on every paged result.
//
// Contract (spec/contracts/discovery-assignment.md §14):
//   selectionToken binds project/modelVersion/roleId/roleRevision/
//   implementation 후보 digest + scope. It is NOT bearer authorization —
//   team.assign re-checks current grants and versions against the claims.
//   verifySelectionToken therefore returns a verdict, never a permission.
//
// Cursor binding (S-COMMON §3, S-STORAGE §6): the cursor carries
// modelVersion + visibilityDigest so a caller cannot mix pages across
// model snapshots or across changed visibility.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SelectionTokenClaims, SelectionTokenVerification } from './types.ts'

const TOKEN_INFO = 'mahas/discovery/selection-token/v1'
const CURSOR_INFO = 'mahas/discovery/page-cursor/v1'

function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url')
}
function unb64url(s: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(s, 'base64url'))
  } catch {
    return null
  }
}

function mac(secret: string | Uint8Array, info: string, body: string): Uint8Array {
  return new Uint8Array(
    createHmac('sha256', secret).update(info).update('\0').update(body).digest()
  )
}

/** seal an opaque value: base64url(json) + '.' + base64url(hmac) */
export function sealOpaque(secret: string | Uint8Array, info: string, payload: unknown): string {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)))
  return `${body}.${b64url(mac(secret, info, body))}`
}

/** open an opaque value — null when malformed or the signature fails */
export function openOpaque<T>(secret: string | Uint8Array, info: string, token: string): T | null {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = unb64url(token.slice(dot + 1))
  if (sig === null) return null
  const expect = mac(secret, info, body)
  if (sig.length !== expect.length || !timingSafeEqual(sig, expect)) return null
  const raw = unb64url(body)
  if (raw === null) return null
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as T
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// selectionToken — issued per CandidateCard, verified by team.assign (IMP-13)
// ---------------------------------------------------------------------------

export interface IssueSelectionTokenInput {
  projectId: string
  modelVersion: string
  roleId: string
  /** sha256 of the role row as shown — the roleRevision pin */
  roleDigest: string
  /** interface digest the implementation candidate must satisfy */
  interfaceDigest?: string
  implementationId?: string
  implementationRevision?: number
  implementationDigest?: string
  /** digest of the shown implementation, or of the published candidate set */
  implementationCandidateDigest?: string
  scope?: { scopeBoundaryId?: string; runId?: string }
  issuedAt: number
  keyId?: string
}

export function issueSelectionToken(
  secret: string | Uint8Array,
  input: IssueSelectionTokenInput
): string {
  const claims: SelectionTokenClaims = {
    v: 1,
    tokenId: randomBytes(16).toString('hex'),
    projectId: input.projectId,
    modelVersion: input.modelVersion,
    roleId: input.roleId,
    roleDigest: input.roleDigest,
    ...(input.interfaceDigest !== undefined ? { interfaceDigest: input.interfaceDigest } : {}),
    ...(input.implementationId !== undefined ? { implementationId: input.implementationId } : {}),
    ...(input.implementationRevision !== undefined
      ? { implementationRevision: input.implementationRevision }
      : {}),
    ...(input.implementationDigest !== undefined
      ? { implementationDigest: input.implementationDigest }
      : {}),
    ...(input.implementationCandidateDigest !== undefined
      ? { implementationCandidateDigest: input.implementationCandidateDigest }
      : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    issuedAt: input.issuedAt,
    ...(input.keyId !== undefined ? { keyId: input.keyId } : {})
  }
  return sealOpaque(secret, TOKEN_INFO, claims)
}

/**
 * Verify integrity and return the pinned claims. A positive result means
 * "this is what discovery showed" — authorization and version freshness
 * are re-checked by team.assign (IMP-13), never by this token.
 */
export function verifySelectionToken(
  secret: string | Uint8Array,
  token: string
): SelectionTokenVerification {
  if (typeof token !== 'string' || token.length === 0 || token.length > 8192)
    return { ok: false, reason: 'malformed' }
  const claims = openOpaque<SelectionTokenClaims>(secret, TOKEN_INFO, token)
  if (claims === null) return { ok: false, reason: 'bad-signature' }
  if (claims.v !== 1) return { ok: false, reason: 'unsupported-version' }
  if (
    typeof claims.projectId !== 'string' ||
    typeof claims.modelVersion !== 'string' ||
    typeof claims.roleId !== 'string' ||
    typeof claims.roleDigest !== 'string' ||
    typeof claims.issuedAt !== 'number'
  )
    return { ok: false, reason: 'malformed' }
  return { ok: true, claims }
}

/** read claims without verifying — diagnostics only, never a trust path */
export function readSelectionTokenUnsafe(token: string): SelectionTokenClaims | null {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const raw = unb64url(token.slice(0, dot))
  if (raw === null) return null
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as SelectionTokenClaims
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// page cursor — binds modelVersion + visibilityDigest + filter to the page
// ---------------------------------------------------------------------------

export interface PageCursorClaims {
  v: 1
  modelVersion: string
  /** digest of {principalId, grantRevisions, modelVersion} at issue time */
  visibilityDigest: string
  /** the normalized filter the first page ran with — pages can't mix */
  filter: unknown
  offset: number
  limit: number
}

export function sealPageCursor(secret: string | Uint8Array, claims: PageCursorClaims): string {
  return sealOpaque(secret, CURSOR_INFO, claims)
}

export function openPageCursor(
  secret: string | Uint8Array,
  token: string
): PageCursorClaims | null {
  const claims = openOpaque<PageCursorClaims>(secret, CURSOR_INFO, token)
  if (claims === null) return null
  if (
    claims.v !== 1 ||
    typeof claims.modelVersion !== 'string' ||
    typeof claims.visibilityDigest !== 'string' ||
    typeof claims.offset !== 'number' ||
    typeof claims.limit !== 'number'
  )
    return null
  return claims
}
