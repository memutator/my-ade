import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { findNodeBinary } from '../platform/nodeBinary.ts'

export interface ServiceBootstrapPaths {
  node: string
  mahasd: string
  executionHost: string
  builtinPacksDir: string
  logsDir: string
  /**
   * This profile's pre-inventory credential directory (`<userData>/usage-accounts`),
   * or null when it does not exist.
   *
   * The auth domain adopts the credential files a profile registered before the
   * inventory domain existed, and it must never GUESS a desktop userData path —
   * only the desktop knows its own profile root (dev runs and an installed app
   * keep different ones). So the desktop resolves it and passes it in. Null when
   * there is nothing to adopt: the daemon then starts with an empty legacy set
   * instead of being pointed at a directory that is not there.
   */
  legacyUsageAccountsRoot: string | null
}

export interface ResolveServiceBootstrapOptions {
  packaged: boolean
  appPath: string
  resourcesPath: string
  configDir: string
  env?: NodeJS.ProcessEnv
  /** `<userData>/usage-accounts` for this profile — see ServiceBootstrapPaths */
  legacyUsageAccountsRoot?: string
}

export function resolveServiceBootstrapPaths(
  options: ResolveServiceBootstrapOptions
): ServiceBootstrapPaths | null {
  const env = options.env ?? process.env
  const node = findNodeBinary(env, { minMajor: 24 })
  if (!node) return null
  const mahasd = options.packaged
    ? join(options.resourcesPath, 'services', 'mahasd.mjs')
    : join(options.appPath, 'packages', 'mahas-runtime', 'src', 'main.ts')
  const executionHost = options.packaged
    ? join(options.resourcesPath, 'services', 'execution-host.mjs')
    : join(options.appPath, 'packages', 'mahas-execution-host', 'src', 'main.ts')
  if (!existsSync(mahasd) || !existsSync(executionHost)) return null
  return {
    node,
    mahasd,
    executionHost,
    builtinPacksDir: options.packaged
      ? join(options.resourcesPath, 'integrations', 'packs')
      : join(options.appPath, 'integrations', 'packs'),
    logsDir: join(options.configDir, 'logs'),
    legacyUsageAccountsRoot:
      options.legacyUsageAccountsRoot && existsSync(options.legacyUsageAccountsRoot)
        ? options.legacyUsageAccountsRoot
        : null
  }
}

export function logServiceBootstrap(configDir: string, message: string): void {
  const logsDir = join(configDir, 'logs')
  mkdirSync(logsDir, { recursive: true })
  appendFileSync(join(logsDir, 'desktop-bootstrap.log'), `${new Date().toISOString()} ${message}\n`)
}

/**
 * Start both detached services. Their stdout/stderr remain diagnosable under
 * configDir/logs; the desktop never treats process spawn itself as readiness.
 */
export function spawnControlPlane(
  paths: ServiceBootstrapPaths,
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
  /** env NAME the auth domain reads the legacy root from — passed by the
   *  caller that owns the auth channel's contract (runtime/authClient.ts),
   *  so this module stays free of that boundary's knowledge */
  legacyRootEnvName?: string
): void {
  mkdirSync(paths.logsDir, { recursive: true })
  let stdinFd: number | null = null
  try {
    stdinFd = openSync(process.platform === 'win32' ? 'NUL' : '/dev/zero', 'r')
    for (const [name, script] of [
      ['execution-host', paths.executionHost],
      ['mahasd', paths.mahasd]
    ] as const) {
      const logFd = openSync(join(paths.logsDir, `${name}.log`), 'a')
      try {
        const child = spawn(paths.node, [script, '--config-dir', configDir], {
          detached: true,
          stdio: [stdinFd, logFd, logFd],
          env: {
            ...env,
            MAHAS_CONFIG_DIR: configDir,
            MAHAS_BUILTIN_PACKS_DIR: paths.builtinPacksDir,
            ...(paths.legacyUsageAccountsRoot && legacyRootEnvName
              ? { [legacyRootEnvName]: paths.legacyUsageAccountsRoot }
              : {})
          }
        })
        child.unref()
        logServiceBootstrap(
          configDir,
          `spawned ${name} pid=${child.pid ?? 'unknown'} using ${paths.node}` +
            (paths.legacyUsageAccountsRoot
              ? ` legacy-credentials=${paths.legacyUsageAccountsRoot}`
              : ' legacy-credentials=none')
        )
      } finally {
        closeSync(logFd)
      }
    }
  } finally {
    if (stdinFd !== null) closeSync(stdinFd)
  }
}
