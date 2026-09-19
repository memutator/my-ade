// Convert a stored harness profile row into the LaunchRecipe the planner
// consumes.
//
// harness.profile.register persists ProfileRecipe `{injection,resume,wake}`
// (IMP-07); the recipe body itself is Pack data. This adapter maps both stored
// shapes and, when the stored JSON carries no process block, lowers the
// builtin.harness-runtime Pack profile with the same id — process argv, stdio and
// injection routes all come from the Pack revision, so no harness name is
// compared here and a new harness needs no core change.
//
// Preserved behaviors:
//   · a stored recipe with an absolute executable + argv passes through untouched;
//   · executable resolution is envOverride → PATH search, and a relative result
//     is never accepted (the planner turns that into INJECTION_UNSUPPORTED);
//   · an unknown profile id yields null — the caller reports INJECTION_UNSUPPORTED
//     rather than substituting a different harness;
//   · the Pack pin (packId/revision/implementationId) is exposed through
//     launchProfilePin so a LaunchPlan can record which revision it was built
//     from. `contentDigest` is filled in by the caller from the registered
//     revision (the adapter only reads Pack data).

import { statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HARNESS_RUNTIME_PACK_DIR,
  argvFromProfile,
  harnessRuntimeHookScriptPath,
  launchProfile,
  loadHarnessRuntimePack,
  locatorFromProfile,
  routesFromProfile,
  type HarnessRuntimePack
} from '../../../mahas-harness-config/src/runtime-pack.ts'
import type { ArgvEntry, InjectionRoute, LaunchRecipe } from './initial-attachment.ts'

export interface ProfileRecipeSource {
  id: string
  recipe_json: string
  executable_identity_json: string
}

export interface LaunchProfilePin {
  packId: string
  revision: number
  capability: string
  implementationId?: string
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

function asProcessRecipe(raw: Record<string, unknown>): LaunchRecipe | null {
  const process = rec(raw.process)
  if (!process) return null
  const exe = process.executable
  if (typeof exe !== 'string' || !exe.startsWith('/') || !Array.isArray(process.argv)) return null
  return raw as unknown as LaunchRecipe
}

/* ------------------------------------------------------------ Pack loading */

let cachedPack: { dir: string; pack: HarnessRuntimePack | null } | null = null

/** Pack root: env (service spawn) → repo checkout next to this module. */
export function builtinPacksDir(
  env: Record<string, string | undefined> = process.env
): string | null {
  if (env.MAHAS_BUILTIN_PACKS_DIR) return env.MAHAS_BUILTIN_PACKS_DIR
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return join(here, '..', '..', '..', '..', 'integrations', 'packs')
  } catch {
    return null
  }
}

export function loadBuiltinHarnessPack(
  env: Record<string, string | undefined> = process.env
): HarnessRuntimePack | null {
  const root = builtinPacksDir(env)
  if (!root) return null
  const dir = join(root, HARNESS_RUNTIME_PACK_DIR)
  if (cachedPack && cachedPack.dir === dir) return cachedPack.pack
  try {
    const pack = loadHarnessRuntimePack(dir)
    cachedPack = { dir, pack }
    return pack
  } catch {
    cachedPack = { dir, pack: null }
    return null
  }
}

/** Reset the memoized Pack (tests and profile re-registration). */
export function resetHarnessPackCache(): void {
  cachedPack = null
}

function packOf(options?: {
  pack?: HarnessRuntimePack | null
  packsDir?: string
}): HarnessRuntimePack | null {
  if (options?.pack !== undefined) return options.pack
  if (options?.packsDir) {
    try {
      return loadHarnessRuntimePack(join(options.packsDir, HARNESS_RUNTIME_PACK_DIR))
    } catch {
      return null
    }
  }
  return loadBuiltinHarnessPack()
}

export interface LaunchRecipeOptions {
  pack?: HarnessRuntimePack | null
  packsDir?: string
}

/** Execute the Pack profile's locator: envOverride → commands → PATH. */
export function resolveProfileExecutable(
  profileId: string,
  identityJson?: string,
  options: LaunchRecipeOptions = {}
): string | null {
  const pack = packOf(options)
  if (!pack) return null
  const profile = launchProfile(pack, profileId)
  if (!profile) return null
  const locator = locatorFromProfile(profile, identityJson)
  if (locator.envOverride) {
    const fromEnv = process.env[locator.envOverride]
    if (fromEnv && executableFile(fromEnv)) return fromEnv
  }
  for (const cmd of locator.commands) {
    const hit = which(cmd)
    if (hit) return hit
  }
  return null
}

/** The Pack revision a LaunchPlan built from this profile must pin. */
export function launchProfilePin(
  profileId: string,
  options: LaunchRecipeOptions = {}
): LaunchProfilePin | null {
  const pack = packOf(options)
  if (!pack) return null
  const profile = launchProfile(pack, profileId)
  const declared = profile?.pack
  if (!profile || !declared?.packId || !declared.revision) return null
  return {
    packId: declared.packId,
    revision: declared.revision,
    capability: declared.capability ?? 'launch',
    ...(declared.implementationId ? { implementationId: declared.implementationId } : {})
  }
}

/** The Pack's own hook transport — the runtime can install/refresh it too. */
export function packHookScriptPath(options: LaunchRecipeOptions = {}): string | null {
  const pack = packOf(options)
  return pack ? harnessRuntimeHookScriptPath(pack) : null
}

/* --------------------------------------------------------------- lowering */

/** documented-recipe → LaunchRecipe, or null when no absolute executable exists */
export function launchRecipeFromProfile(
  profile: ProfileRecipeSource,
  options: LaunchRecipeOptions = {}
): LaunchRecipe | null {
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

  const pack = packOf(options)
  if (!pack) return null
  const packProfile = launchProfile(pack, profile.id)
  if (!packProfile) return null
  const exe = resolveProfileExecutable(profile.id, profile.executable_identity_json, options)
  if (!exe || !exe.startsWith('/')) return null

  const injection = rec(obj.injection) ?? rec(obj.injectionRecipe) ?? {}
  const firstInput = rec(injection.firstInput)
  const method = typeof firstInput?.method === 'string' ? firstInput.method : ''
  const initialKind: InjectionRoute['kind'] =
    method === 'argv-positional-prompt' ? 'argv-text' : 'stdin'
  const declaredStdio = packProfile.recipe?.process?.stdio
  const stdio = injection.stdio === 'pipes' ? 'pipes' : declaredStdio === 'pipes' ? 'pipes' : 'pty'
  return {
    process: {
      executable: exe,
      argv: argvFromProfile(packProfile, exe) as unknown as ArgvEntry[],
      stdio,
      ...(Array.isArray(injection.envExports)
        ? {
            envAllowlist: (injection.envExports as unknown[]).filter(
              (x): x is string => typeof x === 'string'
            )
          }
        : {})
    },
    routes: routesFromProfile(packProfile, initialKind) as unknown as InjectionRoute[]
  }
}
