import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RpcCredential } from './rpc.ts'

export const MAHASD_ENDPOINT_ENV = 'MAHASD_ENDPOINT'
export const MAHAS_OPERATOR_FILE_ENV = 'MAHAS_OPERATOR_FILE'
export const OPERATOR_CONNECTION_FILENAME = 'operator-connection.json'

export interface OperatorConnection {
  endpoint: string
  credential: RpcCredential
  source: string
}

export interface OperatorConnectionOptions {
  configDir: string
  env?: NodeJS.ProcessEnv
  endpoint?: string
  connectionFile?: string
}

/** Resolve endpoint and proof together; the desktop must not guess a token. */
export async function resolveOperatorConnection(
  options: OperatorConnectionOptions
): Promise<OperatorConnection> {
  const env = options.env ?? process.env
  const path =
    options.connectionFile ??
    env[MAHAS_OPERATOR_FILE_ENV] ??
    join(options.configDir, OPERATOR_CONNECTION_FILENAME)
  let file: Record<string, unknown> | null = null
  try {
    const info = await stat(path)
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw new Error(`operator connection file ${path} must have mode 600`)
    }
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`operator connection file ${path} is not an object`)
    }
    file = parsed as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const credential = file?.credential
  if (credential !== undefined && (typeof credential !== 'object' || credential === null)) {
    throw new Error(`operator connection file ${path} has no valid credential`)
  }
  if (
    credential !== undefined &&
    ((credential as Record<string, unknown>).kind !== 'operator' ||
      ((credential as Record<string, unknown>).secret !== undefined &&
        typeof (credential as Record<string, unknown>).secret !== 'string'))
  ) {
    throw new Error(`operator connection file ${path} has an invalid operator credential`)
  }
  return {
    endpoint:
      options.endpoint ??
      env[MAHASD_ENDPOINT_ENV] ??
      (typeof file?.endpoint === 'string' ? file.endpoint : join(options.configDir, 'mahasd.sock')),
    credential: credential ?? { kind: 'operator' },
    source: file ? `operator connection file ${path}` : 'operator endpoint (no credential file)'
  }
}
