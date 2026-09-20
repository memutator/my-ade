// mahas-runtime rpc — endpoint and connection-file path conventions.
//
// spec/architecture.md §6 + spec/contracts/access-cli.md §1: worker and
// operator endpoints/credential paths are SEPARATE, and worker mode has no
// fallback-admin path. mahasd binds both sockets; every collaborator picks
// exactly one side by which connection file it was issued.

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Profile directory for sockets, hook events, operator connection file.
 * MAHAS_CONFIG_DIR wins; otherwise XDG_CONFIG_HOME/mahas; otherwise ~/.config/mahas.
 */
export function resolveMahasConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME || env.USERPROFILE || homedir()
): string {
  if (env.MAHAS_CONFIG_DIR) return env.MAHAS_CONFIG_DIR
  const base = env.XDG_CONFIG_HOME || join(home, '.config')
  return join(base, 'mahas')
}

/**
 * Operator control socket — same path IMP-01's defaultMahasdEndpoint
 * resolves, kept in sync here so desktop/operator CLI share ONE endpoint.
 */
export function mahasdOperatorEndpoint(configDir: string): string {
  return join(configDir, 'mahasd.sock')
}

/**
 * Worker socket — the scope-bound endpoint stamped into execution-owned
 * connection files. Worker shells never learn the operator path from us.
 */
export function mahasdWorkerEndpoint(configDir: string): string {
  return join(configDir, 'mahasd-worker.sock')
}

/** filename of the worker connection file inside an execution-owned dir */
export const WORKER_CONNECTION_FILENAME = 'worker-connection.json'

/** filename of the operator connection file inside the operator config dir */
export const OPERATOR_CONNECTION_FILENAME = 'operator-connection.json'

/**
 * env vars collaborators consult. MAHASD_ENDPOINT already exists (IMP-01);
 * the two connection-file vars are new — launch (IMP-19/20) stamps
 * MAHAS_CONNECTION_FILE into a worker's environment pointing at the
 * execution-owned file; operators get MAHAS_OPERATOR_FILE or the config-dir
 * default.
 */
export const MAHAS_CONNECTION_FILE_ENV = 'MAHAS_CONNECTION_FILE'
export const MAHAS_OPERATOR_FILE_ENV = 'MAHAS_OPERATOR_FILE'
export const MAHAS_ROLE_ENV = 'MAHAS_ROLE'

export function defaultWorkerConnectionFile(executionDir: string): string {
  return join(executionDir, WORKER_CONNECTION_FILENAME)
}

export function defaultOperatorConnectionFile(configDir: string): string {
  return join(configDir, OPERATOR_CONNECTION_FILENAME)
}
