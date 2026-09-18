// mahas-cli connection — resolve {endpoint, credential} for this process.
//
// spec/contracts/access-cli.md §1: worker and operator credential paths are
// separate; worker mode has NO fallback-admin path — when the caller asks
// for a worker connection we consult the worker connection file and nothing
// else. Secrets are never accepted on argv (no --token flag exists) and
// never printed; they arrive only via the approved connection file or
// environment.

import { join } from 'node:path'
import {
  mahasError,
  mahasdOperatorEndpoint,
  operatorConnectionPath,
  readOperatorConnectionFile,
  readWorkerConnectionFile,
  workerConnectionPath,
  MAHAS_CONNECTION_FILE_ENV,
  MAHAS_ROLE_ENV,
  type OperatorCredential,
  type WorkerCredential
} from '../../mahas-runtime/src/rpc/index.ts'
import { MAHASD_ENDPOINT_ENV } from '../../mahas-runtime/src/index.ts'

export type CliRole = 'worker' | 'operator'

/** everything connectRpc needs, plus human-readable provenance (no secrets) */
export interface ResolvedConnection {
  role: CliRole
  endpoint: string
  credential: WorkerCredential | OperatorCredential
  /** where the credential came from — safe for stderr diagnostics */
  source: string
}

export interface ResolveOptions {
  configDir: string
  env?: NodeJS.ProcessEnv
  /** explicit role (--as); absent → infer from environment */
  role?: CliRole
  /** explicit connection-file path (--connection-file) for either role */
  connectionFile?: string
}

/**
 * Which side of mahasd this process talks to. Worker context is detected by
 * the launch-stamped MAHAS_CONNECTION_FILE; MAHAS_ROLE pins explicitly.
 * Default (a human at a shell) is operator.
 */
export function inferRole(env: NodeJS.ProcessEnv, explicit?: CliRole): CliRole {
  if (explicit) return explicit
  const pinned = env[MAHAS_ROLE_ENV]
  if (pinned === 'worker' || pinned === 'operator') return pinned
  return workerConnectionPath(env) !== null ? 'worker' : 'operator'
}

/**
 * Resolve the worker connection: the launch-issued connection file ONLY.
 * No operator fallback, no synthesized admin credential — a missing file
 * means this process is not an issued worker, and calls will authenticate
 * as nothing (the server decides; typically UNAUTHENTICATED).
 */
async function resolveWorker(
  env: NodeJS.ProcessEnv,
  override?: string
): Promise<ResolvedConnection> {
  const path = workerConnectionPath(env, override)
  if (path === null) {
    throw mahasError(
      'UNAUTHENTICATED',
      `no worker connection file — set ${MAHAS_CONNECTION_FILE_ENV} or run ` +
        'inside a launched execution (worker mode has no admin fallback)'
    )
  }
  const file = await readWorkerConnectionFile(path)
  return {
    role: 'worker',
    endpoint: env[MAHASD_ENDPOINT_ENV] ?? file.endpoint,
    credential: file.credential,
    source: `worker connection file ${path}`
  }
}

/**
 * Resolve the operator connection: operator connection file when present,
 * else the operator endpoint with a secret-less credential — the server's
 * authenticator decides admissibility (typically local-user checks or
 * UNAUTHENTICATED). Never reaches for worker material.
 */
async function resolveOperator(
  env: NodeJS.ProcessEnv,
  configDir: string,
  override?: string
): Promise<ResolvedConnection> {
  const path = operatorConnectionPath(env, configDir, override)
  const file = await readOperatorConnectionFile(path)
  return {
    role: 'operator',
    endpoint: env[MAHASD_ENDPOINT_ENV] ?? file?.endpoint ?? mahasdOperatorEndpoint(configDir),
    credential: file?.credential ?? { kind: 'operator' },
    source: file ? `operator connection file ${path}` : 'operator endpoint (no credential file)'
  }
}

export async function resolveConnection(opts: ResolveOptions): Promise<ResolvedConnection> {
  const env = opts.env ?? process.env
  const role = inferRole(env, opts.role)
  return role === 'worker'
    ? resolveWorker(env, opts.connectionFile)
    : resolveOperator(env, opts.configDir, opts.connectionFile)
}

export function defaultConfigDir(env: NodeJS.ProcessEnv): string {
  return env.MAHAS_CONFIG_DIR ?? join(env.HOME ?? '/', '.config', 'mahas')
}
