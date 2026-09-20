import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

function newestNodeUnder(base: string): string | null {
  try {
    const dirs = readdirSync(base)
      .map((v) => ({ v, m: v.match(/^v?(\d+)\.(\d+)\.(\d+)/) }))
      .filter((x): x is { v: string; m: RegExpMatchArray } => !!x.m)
      .sort((a, b) => [1, 2, 3].reduce((d, i) => d || Number(b.m[i]) - Number(a.m[i]), 0))
    for (const { v } of dirs) {
      for (const c of [
        join(base, v, 'bin', 'node'),
        join(base, v, 'installation', 'bin', 'node')
      ]) {
        if (existsSync(c)) return c
      }
    }
  } catch {
    /* dir absent */
  }
  return null
}

/** Ordered unique Node paths: env overrides, PATH, well-known, version managers. */
export function nodeBinaryCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string[] {
  const candidates: Array<string | undefined> = [env.MAHAS_NODE, env.NODE_BINARY]
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (directory) candidates.push(join(directory, process.platform === 'win32' ? 'node.exe' : 'node'))
  }
  candidates.push(
    '/usr/bin/node',
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    '/snap/bin/node',
    '/home/linuxbrew/.linuxbrew/bin/node',
    join(home, '.volta/bin/node'),
    join(home, '.local/bin/node'),
    join(home, '.asdf/shims/node')
  )
  const nvmRoot = env.NVM_DIR ?? join(home, '.nvm')
  candidates.push(newestNodeUnder(join(nvmRoot, 'versions', 'node')) ?? undefined)
  for (const base of [
    join(home, '.local/share/mise/installs/node'),
    join(home, '.local/share/fnm/node-versions'),
    join(home, '.asdf/installs/nodejs')
  ]) {
    candidates.push(newestNodeUnder(base) ?? undefined)
  }
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))]
}

export function nodeMajor(candidate: string): number | null {
  const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 2_000 })
  const major = /^v(\d+)/.exec(result.stdout.trim())?.[1]
  return result.status === 0 && major !== undefined ? Number(major) : null
}

/**
 * Resolve a system Node. `minMajor` (services: 24) skips too-old binaries.
 * Without it, a PATH `node` that launches is accepted even if we cannot stat it
 * (desktop PTY host).
 */
export function findNodeBinary(
  env: NodeJS.ProcessEnv = process.env,
  options: { minMajor?: number } = {}
): string | null {
  const minMajor = options.minMajor
  if (minMajor === undefined) {
    if (env.MAHAS_NODE) return env.MAHAS_NODE
    if (env.NODE_BINARY) return env.NODE_BINARY
    if (!spawnSync('node', ['--version'], { stdio: 'ignore' }).error) return 'node'
    return nodeBinaryCandidates(env).find((p) => existsSync(p)) ?? 'node'
  }
  for (const candidate of nodeBinaryCandidates(env)) {
    if (!existsSync(candidate)) continue
    const major = nodeMajor(candidate)
    if (major !== null && major >= minMajor) return candidate
  }
  return null
}
