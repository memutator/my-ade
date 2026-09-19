// mahas-runtime rpc — operator-side credential material (spec C-ACCESS §1,
// spec/architecture.md §6).
//
// The operator path is deliberately separate from worker-auth: different
// socket, different file, different credential kind. There is NO
// fallback-admin path reachable from worker mode — nothing in this module
// is called by worker credential resolution, and the CLI never substitutes
// an operator file when a worker file was asked for.
//
// v1 operator proof: a secret token in <configDir>/operator-connection.json
// (mode 0600), verified server-side against whatever principal store the
// authenticator consults. As with workers, the file's path proves nothing;
// the secret inside does.

import { readFile, stat } from 'node:fs/promises'
import { mahasError } from './framing.ts'
import type { MahasError } from '../../../mahas-contracts/src/index.ts'
import { defaultOperatorConnectionFile, MAHAS_OPERATOR_FILE_ENV } from './endpoints.ts'

/** on-wire operator credential — secret verified server-side */
export interface OperatorCredential {
  kind: 'operator'
  /** raw proof from the operator connection file */
  secret?: string
}

export interface OperatorConnectionFile {
  version: number
  /** operator endpoint — e.g. <configDir>/mahasd.sock */
  endpoint?: string
  credential: OperatorCredential
}

function invalid(reason: string): MahasError {
  return mahasError('UNAUTHENTICATED', `operator connection file: ${reason}`)
}

function parseOperatorConnectionFile(raw: string): OperatorConnectionFile {
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
  const c = f.credential
  if (typeof c !== 'object' || c === null) throw invalid('missing credential')
  const cred = c as Record<string, unknown>
  if (cred.kind !== 'operator') throw invalid(`credential.kind must be 'operator'`)
  if (cred.secret !== undefined && typeof cred.secret !== 'string') {
    throw invalid('credential.secret must be a string')
  }
  return {
    version: typeof f.version === 'number' ? f.version : 1,
    endpoint: typeof f.endpoint === 'string' ? f.endpoint : undefined,
    credential: { kind: 'operator', secret: cred.secret as string | undefined }
  }
}

/**
 * Read the operator connection file when present. Returns null when no file
 * exists — an operator CLI may still attempt the connection (the server's
 * authenticator decides whether a secret-less operator hello is admissible);
 * a PRESENT but malformed/permissive file is a hard error, not a skip.
 */
export async function readOperatorConnectionFile(
  path: string
): Promise<OperatorConnectionFile | null> {
  let st
  try {
    st = await stat(path)
  } catch {
    return null // absent is normal — caller proceeds without a file credential
  }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw invalid(`mode ${(st.mode & 0o777).toString(8)} is too permissive — expected 600`)
  }
  return parseOperatorConnectionFile(await readFile(path, 'utf8'))
}

/**
 * Resolve the operator connection file path: explicit override >
 * MAHAS_OPERATOR_FILE > <configDir>/operator-connection.json. Worker mode
 * never consults this — keeping the two resolution paths disjoint is what
 * "no fallback-admin" means in code.
 */
export function operatorConnectionPath(
  env: NodeJS.ProcessEnv,
  configDir: string,
  override?: string
): string {
  return override ?? env[MAHAS_OPERATOR_FILE_ENV] ?? defaultOperatorConnectionFile(configDir)
}
