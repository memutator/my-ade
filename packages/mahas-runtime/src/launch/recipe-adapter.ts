// Convert a stored harness profile row into the LaunchRecipe planner consumes.
//
// harness.profile.register persists ProfileRecipe `{injection,resume,wake}`
// (IMP-07). worker.prepare used to JSON.parse that as `{process.executable,argv}`
// and always emit INJECTION_UNSUPPORTED. This adapter maps both shapes, and
// fills process/routes from mahas-harness-config documented recipes when the
// stored JSON has no process block.

import { statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import {
  CLAUDE_PROFILE_ID,
  resolveClaudeExecutable
} from '../../../mahas-harness-config/src/index.ts'
import type { ArgvEntry, InjectionRoute, LaunchRecipe } from './initial-attachment.ts'

export interface ProfileRecipeSource {
  id: string
  recipe_json: string
  executable_identity_json: string
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function executableFile(p: string): boolean {
  try {
    const st = statSync(p)
    return st.isFile() && (st.mode & 0o111) !== 0
  } catch {
    return false
  }
}

function which(cmd: string): string | null {
  if (cmd.includes('/') && executableFile(cmd)) return cmd
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, cmd)
    if (executableFile(p)) return p
  }
  return null
}

function resolveLocator(identityJson: string): string | null {
  let identity: Record<string, unknown> = {}
  try {
    identity = rec(JSON.parse(identityJson)) ?? {}
  } catch {
    identity = {}
  }
  const locator = rec(identity.locator) ?? identity
  const envOverride = typeof locator.envOverride === 'string' ? locator.envOverride : undefined
  if (envOverride) {
    const fromEnv = process.env[envOverride]
    if (fromEnv && executableFile(fromEnv)) return fromEnv
  }
  const commands = Array.isArray(locator.commands)
    ? locator.commands.filter((c): c is string => typeof c === 'string')
    : []
  for (const cmd of commands) {
    const hit = which(cmd)
    if (hit) return hit
  }
  return null
}

function asProcessRecipe(raw: Record<string, unknown>): LaunchRecipe | null {
  const process = rec(raw.process)
  if (!process) return null
  const exe = process.executable
  if (typeof exe !== 'string' || !exe.startsWith('/') || !Array.isArray(process.argv)) return null
  return raw as unknown as LaunchRecipe
}

function defaultRoutes(profileId: string, injection: Record<string, unknown>): InjectionRoute[] {
  const first = rec(injection.firstInput)
  const method = typeof first?.method === 'string' ? first.method : ''
  const initialKind: InjectionRoute['kind'] =
    method === 'argv-positional-prompt' ? 'argv-text' : 'stdin'
  if (profileId.includes('codex')) {
    return [
      {
        source: 'role/mandatory.md',
        kind: 'argv-config-text',
        target: 'developer_instructions',
        format: 'toml-basic-string',
        required: true
      },
      { source: 'task/initial.txt', kind: initialKind, required: true }
    ]
  }
  return [
    {
      source: 'role/mandatory.md',
      kind: 'argv-file',
      target: '--append-system-prompt-file',
      required: true
    },
    { source: 'task/initial.txt', kind: initialKind, required: true }
  ]
}

function defaultArgv(profileId: string, exe: string): ArgvEntry[] {
  if (profileId.includes('codex')) {
    return [
      { literal: exe },
      {
        slot: 'configText',
        key: 'developer_instructions',
        format: 'toml-basic-string',
        source: 'role/mandatory.md'
      },
      { slot: 'fileText', source: 'task/initial.txt' }
    ]
  }
  return [
    { literal: exe },
    { slot: 'file', source: 'role/mandatory.md', flag: '--append-system-prompt-file' },
    { slot: 'fileText', source: 'task/initial.txt' }
  ]
}

/** documented-recipe → LaunchRecipe, or null when no absolute executable exists */
export function launchRecipeFromProfile(profile: ProfileRecipeSource): LaunchRecipe | null {
  let raw: unknown
  try {
    raw = JSON.parse(profile.recipe_json)
  } catch {
    return null
  }
  const obj = rec(raw)
  if (!obj) return null
  const direct = asProcessRecipe(obj)
  if (direct) return direct

  let exe: string | null = null
  if (profile.id === CLAUDE_PROFILE_ID || profile.id.includes('claude')) {
    const resolved = resolveClaudeExecutable()
    if (resolved.path && executableFile(resolved.path)) exe = resolved.path
  }
  exe ??= resolveLocator(profile.executable_identity_json)
  if (!exe || !exe.startsWith('/')) return null

  const injection = rec(obj.injection) ?? rec(obj.injectionRecipe) ?? {}
  const stdio = injection.stdio === 'pipes' ? 'pipes' : 'pty'
  return {
    process: {
      executable: exe,
      argv: defaultArgv(profile.id, exe),
      stdio,
      envAllowlist: Array.isArray(injection.envExports)
        ? injection.envExports.filter((x): x is string => typeof x === 'string')
        : undefined
    },
    routes: defaultRoutes(profile.id, injection)
  }
}
