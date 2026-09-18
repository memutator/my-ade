// mahas-runtime rpc — worker-side credential material (spec C-ACCESS §1,
// spec/architecture.md §6).
//
// A worker's scope-bound connection file is issued by launch (IMP-19/20)
// into an execution-owned directory. It pairs the worker endpoint with a
// credential whose SECRET is the proof — the file path itself is not the
// auth factor (spec C-ACCESS: "파일 path 자체를 인증으로 쓰지 않고
// credential proof를 별도로 검사한다"). The secret travels only inside the
// hello frame over the owner-only socket; this module never prints it to
// argv, stdout, or diagnostics — redactCredential() is the only
// representation allowed in logs.

import { readFile, stat } from 'node:fs/promises'
import { mahasError } from './framing.ts'
import type { MahasError } from '../../../mahas-contracts/src/index.ts'
import { MAHAS_CONNECTION_FILE_ENV } from './endpoints.ts'

/**
 * The on-wire worker credential. `credentialId` + `secret` resolve to a row
 * of execution_credentials (spec/storage.md §3: secret_hash, principal_id,
 * execution_id, generation, mode) — the server's authenticator derives the
 * whole AuthenticatedContext from it. The client claims nothing: no
 * principalId/memberId/role fields exist here to be trusted.
 */
export interface WorkerCredential {
  kind: 'worker'
  /** execution_credentials.id the secret belongs to */
  credentialId: string
  /** raw proof — server compares against secret_hash via verifySecret */
  secret: string
}

/** shape of the worker connection file (version allows future fields) */
export interface WorkerConnectionFile {
  version: number
  /** worker endpoint — e.g. <configDir>/mahasd-worker.sock */
  endpoint: string
  credential: WorkerCredential
  /** optional hints from launch — informational only */
  issuedAt?: string
  expiresAt?: string
}

/** safe diagnostic view — secret replaced by its length for log lines */
export function redactCredential(c: WorkerCredential): {
  kind: string
  credentialId: string
  secret: string
} {
  return {
    kind: c.kind,
    credentialId: c.credentialId,
    secret: `<redacted:${c.secret.length} chars>`
  }
}

function invalid(reason: string): MahasError {
  return mahasError('UNAUTHENTICATED', `worker connection file: ${reason}`)
}

function parseWorkerConnectionFile(raw: string): WorkerConnectionFile {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    throw invalid('not valid JSON')
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw invalid('root is not an object')
  }
  const f = v as Record<string, unknown>
  if (typeof f.endpoint !== 'string' || f.endpoint.length === 0) {
    throw invalid('missing endpoint')
  }
  const c = f.credential
  if (typeof c !== 'object' || c === null) throw invalid('missing credential')
  const cred = c as Record<string, unknown>
  if (cred.kind !== 'worker') throw invalid(`credential.kind must be 'worker'`)
  if (typeof cred.credentialId !== 'string' || cred.credentialId.length === 0) {
    throw invalid('missing credential.credentialId')
  }
  if (typeof cred.secret !== 'string' || cred.secret.length === 0) {
    throw invalid('missing credential.secret')
  }
  return {
    version: typeof f.version === 'number' ? f.version : 1,
    endpoint: f.endpoint,
    credential: { kind: 'worker', credentialId: cred.credentialId, secret: cred.secret },
    issuedAt: typeof f.issuedAt === 'string' ? f.issuedAt : undefined,
    expiresAt: typeof f.expiresAt === 'string' ? f.expiresAt : undefined
  }
}

/**
 * Read + validate a worker connection file. On POSIX the file must not be
 * group/world-readable — a permissive mode is a hard refusal, not a warning,
 * because the secret inside is the whole proof.
 */
export async function readWorkerConnectionFile(path: string): Promise<WorkerConnectionFile> {
  let st
  try {
    st = await stat(path)
  } catch {
    throw invalid(`unreadable: ${path}`)
  }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw invalid(
      `mode ${(st.mode & 0o777).toString(8)} is too permissive — expected 600 ` +
        `(execution-owned secret material)`
    )
  }
  return parseWorkerConnectionFile(await readFile(path, 'utf8'))
}

/**
 * Resolve the worker connection file path from the environment launch
 * stamped (MAHAS_CONNECTION_FILE) or an explicit override. Returns null
 * when the caller is not in a worker context — that is a normal state for
 * the operator CLI, not an error.
 */
export function workerConnectionPath(env: NodeJS.ProcessEnv, override?: string): string | null {
  return override ?? env[MAHAS_CONNECTION_FILE_ENV] ?? null
}
