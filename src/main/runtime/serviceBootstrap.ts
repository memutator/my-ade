import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

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

function nodeCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates = [env.MAHAS_NODE, env.NODE_BINARY]
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (directory)
      candidates.push(join(directory, process.platform === 'win32' ? 'node.exe' : 'node'))
  }
  candidates.push('/usr/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node')
  const nvmRoot = env.NVM_DIR ?? join(homedir(), '.nvm')
  const versions = join(nvmRoot, 'versions', 'node')
  try {
    for (const version of readdirSync(versions).sort().reverse()) {
      candidates.push(join(versions, version, 'bin', 'node'))
    }
  } catch {
    // nvm is optional
  }
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))]
}

function usableNode(candidate: string): boolean {
  if (!existsSync(candidate)) return false
  const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 2_000 })
  const major = /^v(\d+)/.exec(result.stdout.trim())?.[1]
  return result.status === 0 && major !== undefined && Number(major) >= 24
}

export function resolveServiceBootstrapPaths(
  options: ResolveServiceBootstrapOptions
): ServiceBootstrapPaths | null {
  const env = options.env ?? process.env
  const node = nodeCandidates(env).find(usableNode)
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
