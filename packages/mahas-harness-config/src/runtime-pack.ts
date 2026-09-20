// Harness runtime Pack data — the single vendor-knowledge surface for process
// identification, hook installation, event classification, launch/resume
// recipes and harness maintenance.
//
// The data lives in the `builtin.harness-runtime` Pack revision
// (integrations/packs/harness-runtime/{harnesses.json,installers.json}) and ships
// next to that revision's entrypoints; this module is the only place core reads
// it. Adding a harness means editing Pack data — never a provider switch in the
// Electron main process, the control-plane runtime or the renderer.
//
// Consumers:
//   src/main/harnessPack.ts        — desktop source resolution + hook artifacts
//   src/main/hookInstallers.ts     — data-driven install/status/refresh engine
//   src/main/devinLocks.ts         — session-lock sweep declaration
//   src/renderer/src/agents.ts     — resume recipe projection
//   runtime launch/recipe-adapter  — profile → LaunchRecipe lowering

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export { EVENT_SLOT, SESSION_SLOT, resumeCommandText } from './resume-recipe.ts'
export type { HarnessDescriptor, HarnessResumeRecipe } from './resume-recipe.ts'
import { SESSION_SLOT, type HarnessDescriptor, type HarnessResumeRecipe } from './resume-recipe.ts'
export type HarnessManifestEntry = HarnessDescriptor

export interface HarnessRuntimeHarness {
  label: string
  /** publisher organization id, shared with the catalog seed */
  publisher?: string
  match: string[]
  domain?: string
  color?: string
  /** environment variables that identify this harness inside a shared hook */
  envSignals?: string[]
  /** native payload fields this harness's hook relies on */
  payloadSignals?: string[]
  resume?: HarnessResumeRecipe
  /** installer id in installers.json */
  hooks?: string
  maintenance?: string[]
  /** stale-lock declaration, e.g. devin's session_locks */
  lockDir?: string
  lockPattern?: string
  lockHolder?: string
  testOnly?: boolean
}

export interface HarnessLaunchProfile {
  harnessId: string
  revision: number
  executableLocator?: { commands?: string[]; envOverride?: string }
  supportedComponents?: string[]
  recipe?: {
    process?: {
      executableLocator?: { commands?: string[]; envOverride?: string }
      argv?: Record<string, unknown>[]
      stdio?: string
    }
    routes?: Record<string, unknown>[]
  }
  pack?: { packId?: string; revision?: number; capability?: string; implementationId?: string }
}

export interface HarnessInstallerFile {
  from: string
  to: string
}

export interface HarnessRuntimeInstaller {
  label: string
  bin: string
  harnessId: string
  mechanism: string
  /**
   * json-hooks        append a matcher group per event (claude, devin, zcode)
   * notify-slot       replace a single notify command, chaining the displaced one (codex)
   * owned-json-hooks  write the whole hook document we own (grok)
   * hook-files        write one event-named script file per event (cline)
   * plugin-files      copy a file set into a plugin directory (opencode)
   */
  kind: 'json-hooks' | 'notify-slot' | 'owned-json-hooks' | 'hook-files' | 'plugin-files'
  config: string
  refresh?: 'owned' | 'legacy' | 'none'
  events?: string[]
  group?: Record<string, unknown>
  container?: string
  enableContainer?: boolean
  owned?: Record<string, unknown>
  script?: string[]
  backupSuffix?: string
  files?: HarnessInstallerFile[]
  marker?: string
  notifyArgv?: string[]
  forwardKey?: string
  legacyArtifacts?: string[]
}

export interface HarnessRuntimePack {
  dir: string
  schemaVersion: number
  organizations: Record<string, string>
  harnesses: Record<string, HarnessRuntimeHarness>
  profiles: Record<string, HarnessLaunchProfile>
  hookStream: {
    transport?: string
    generation?: string
    identityFields?: string[]
    policyFields?: string[]
    scoping?: string
  }
  installers: {
    runtime: { hookScript?: string; hookCommand?: string }
    legacy: {
      markers: string[]
      legacyMarkers: string[]
      artifacts: { path: string }[]
      forwardFile: string
    }
    byId: Record<string, HarnessRuntimeInstaller>
  }
}

export const HARNESS_RUNTIME_PACK_ID = 'builtin.harness-runtime'
export const HARNESS_RUNTIME_PACK_DIR = 'harness-runtime'

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Load one Pack revision directory. Malformed data throws — a Pack that cannot
 * be read must surface as a capability issue, never as a silently empty roster.
 */
export function loadHarnessRuntimePack(dir: string): HarnessRuntimePack {
  const catalog = recordOf(readJson(join(dir, 'harnesses.json')))
  const installerFile = recordOf(readJson(join(dir, 'installers.json')))
  const harnesses = recordOf(catalog.harnesses) as unknown as Record<string, HarnessRuntimeHarness>
  const installers = recordOf(installerFile.installers) as unknown as Record<
    string,
    HarnessRuntimeInstaller
  >
  const legacy = recordOf(installerFile.legacy)
  const runtime = recordOf(installerFile.runtime)
  for (const [id, harness] of Object.entries(harnesses)) {
    if (!harness || typeof harness.label !== 'string' || !Array.isArray(harness.match)) {
      throw new Error('harness ' + id + ' must declare a label and match patterns')
    }
    if (harness.hooks && !installers[harness.hooks]) {
      throw new Error(
        'harness ' + id + ' declares hooks installers.' + harness.hooks + ' which does not exist'
      )
    }
    if (harness.resume && typeof harness.resume.executable !== 'string') {
      throw new Error('harness ' + id + ' declares a resume recipe without an executable')
    }
  }
  for (const [id, installer] of Object.entries(installers)) {
    if (!installer || typeof installer.kind !== 'string')
      throw new Error('installer ' + id + ' must declare a kind')
    if (typeof installer.bin !== 'string' || typeof installer.config !== 'string') {
      throw new Error('installer ' + id + ' must declare bin and config')
    }
    if (
      installer.kind === 'plugin-files' &&
      (!Array.isArray(installer.files) || installer.files.length === 0)
    ) {
      throw new Error('installer ' + id + ' copies a file set and must declare files[]')
    }
    if (installer.kind === 'hook-files' && !Array.isArray(installer.script)) {
      throw new Error('installer ' + id + ' writes hook files and must declare a script template')
    }
  }
  return {
    dir,
    schemaVersion: Number(catalog.schemaVersion ?? 0),
    organizations: recordOf(catalog.organizations) as unknown as Record<string, string>,
    harnesses,
    profiles: recordOf(catalog.profiles) as unknown as Record<string, HarnessLaunchProfile>,
    hookStream: recordOf(catalog.hookStream) as HarnessRuntimePack['hookStream'],
    installers: {
      runtime: {
        hookScript:
          typeof runtime.hookScript === 'string' ? runtime.hookScript : 'hooks/mahas-hook.cjs',
        hookCommand: typeof runtime.hookCommand === 'string' ? runtime.hookCommand : undefined
      },
      legacy: {
        markers: Array.isArray(legacy.markers) ? (legacy.markers as string[]) : ['mahas-hook'],
        legacyMarkers: Array.isArray(legacy.legacyMarkers)
          ? (legacy.legacyMarkers as string[])
          : ['ade-hook', 'AdeEventsPlugin'],
        artifacts: Array.isArray(legacy.artifacts) ? (legacy.artifacts as { path: string }[]) : [],
        forwardFile:
          typeof legacy.forwardFile === 'string'
            ? legacy.forwardFile
            : '$' + '{configDir}/notify-forward.json'
      },
      byId: installers
    }
  }
}

/** Absolute path of the hook transport inside a loaded pack revision. */
export function harnessRuntimeHookScriptPath(pack: HarnessRuntimePack): string {
  return join(pack.dir, pack.installers.runtime.hookScript ?? 'hooks/mahas-hook.cjs')
}

/** Where the builtin Packs live: env override → packaged resources → app dir. */
export function resolveBuiltinPacksDir(options: {
  packaged: boolean
  appPath: string
  resourcesPath: string
  env?: Record<string, string | undefined>
}): string {
  const env = options.env ?? (process.env as Record<string, string | undefined>)
  if (env.MAHAS_BUILTIN_PACKS_DIR) return env.MAHAS_BUILTIN_PACKS_DIR
  return options.packaged
    ? join(options.resourcesPath, 'integrations', 'packs')
    : join(options.appPath, 'integrations', 'packs')
}

/* ------------------------------------------------------------------ tokens */

export interface InstallerTokenContext {
  home: string
  configHome: string
  configDir: string
  dataHome: string
  hookScriptPath: string
  harnessId: string
}

export function installerTokenContext(options: {
  home: string
  hookScriptPath: string
  harnessId: string
  env?: Record<string, string | undefined>
}): InstallerTokenContext {
  const env = options.env ?? (process.env as Record<string, string | undefined>)
  const home = options.home
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config')
  const configDir = env.MAHAS_CONFIG_DIR || join(configHome, 'mahas')
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share')
  return {
    home,
    configHome,
    configDir,
    dataHome,
    hookScriptPath: options.hookScriptPath,
    harnessId: options.harnessId
  }
}

function token(name: string): string {
  return '$' + '{' + name + '}'
}

export function hookCommandText(hookScriptPath: string, harnessId: string): string {
  return 'node "' + hookScriptPath + '" ' + harnessId
}

/**
 * Expand the shared path/command tokens. Tokens are the only templating the
 * installer engine understands, so Pack data can never execute code.
 */
export function expandInstallerTemplate(template: string, ctx: InstallerTokenContext): string {
  return template
    .split(token('hookScriptPath'))
    .join(ctx.hookScriptPath)
    .split(token('hookCommand'))
    .join(hookCommandText(ctx.hookScriptPath, ctx.harnessId))
    .split(token('harnessId'))
    .join(ctx.harnessId)
    .split(token('configDir'))
    .join(ctx.configDir)
    .split(token('configHome'))
    .join(ctx.configHome)
    .split(token('dataHome'))
    .join(ctx.dataHome)
    .split(token('home'))
    .join(ctx.home)
}

export function expandInstallerPath(template: string, ctx: InstallerTokenContext): string {
  const expanded = expandInstallerTemplate(template, ctx)
  if (expanded === '~') return ctx.home
  return expanded.startsWith('~/') ? join(ctx.home, expanded.slice(2)) : expanded
}

function expandDeep(value: unknown, ctx: InstallerTokenContext): unknown {
  if (typeof value === 'string') return expandInstallerTemplate(value, ctx)
  if (Array.isArray(value)) return value.map((item) => expandDeep(item, ctx))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = expandDeep(item, ctx)
    }
    return out
  }
  return value
}

/** An installer declaration resolved against a concrete HOME. */
export interface InstallerPlan {
  id: string
  installer: HarnessRuntimeInstaller
  configPath: string
  /** directory owning event-named hook files or plugin files */
  configDir: string
  hookCommand: string
  events: string[]
  /** document written verbatim by owned-json-hooks */
  owned?: Record<string, unknown>
  group?: Record<string, unknown>
  /** script template lines for hook-files installers (EVENT_SLOT per file) */
  scriptTemplate: string[]
  /** file copies for plugin-files installers; all are installed together */
  files: { from: string; to: string }[]
  argv: string[]
  forwardKey?: string
  refresh: 'owned' | 'legacy' | 'none'
  marker: string
  legacyArtifacts: string[]
  /** displaced-command table used when we take over a single-slot hook */
  forwardFile: string
}

export function installerPlan(
  pack: HarnessRuntimePack,
  id: string,
  hookScriptPath: string,
  home: string,
  env?: Record<string, string | undefined>
): InstallerPlan {
  const installer = pack.installers.byId[id]
  if (!installer) throw new Error('unknown installer ' + id)
  const ctx = installerTokenContext({
    home,
    hookScriptPath,
    harnessId: installer.harnessId || id,
    ...(env ? { env } : {})
  })
  const configPath = expandInstallerPath(installer.config, ctx)
  // hook-files installers write one file per event *inside* the declared path;
  // every other kind declares the file it mutates, so the directory is its parent
  const configDir =
    installer.kind === 'hook-files'
      ? configPath
      : configPath.includes('/')
        ? configPath.slice(0, configPath.lastIndexOf('/'))
        : configPath
  return {
    id,
    installer,
    configPath,
    configDir,
    hookCommand: hookCommandText(hookScriptPath, ctx.harnessId),
    events: installer.events ? [...installer.events] : [],
    ...(installer.owned
      ? { owned: expandDeep(installer.owned, ctx) as Record<string, unknown> }
      : {}),
    ...(installer.group
      ? { group: expandDeep(installer.group, ctx) as Record<string, unknown> }
      : {}),
    scriptTemplate: (installer.script ?? []).map((line) => expandInstallerTemplate(line, ctx)),
    files: (installer.files ?? []).map((file) => ({
      from: join(pack.dir, file.from),
      to: expandInstallerPath(file.to, ctx)
    })),
    argv: (installer.notifyArgv ?? []).map((arg) => expandInstallerTemplate(arg, ctx)),
    ...(installer.forwardKey ? { forwardKey: installer.forwardKey } : {}),
    refresh: installer.refresh ?? 'legacy',
    marker: installer.marker ?? pack.installers.legacy.markers[0] ?? 'mahas-hook',
    legacyArtifacts: (installer.legacyArtifacts ?? []).map((template) =>
      expandInstallerPath(template, ctx)
    ),
    forwardFile: expandInstallerPath(pack.installers.legacy.forwardFile, ctx)
  }
}

/* -------------------------------------------------------------- manifest */

/**
 * Legacy descriptor shape read by the desktop's agents:manifest IPC and the
 * pty-host detector. Generated from Pack data; recipe carries the Pack's
 * session-slot form so callers stop hard-coding argument order, while resume
 * keeps the historical cmd/args pair for older readers.
 */
export function harnessManifestProjection(
  pack: HarnessRuntimePack
): Record<string, HarnessManifestEntry> {
  const out: Record<string, HarnessManifestEntry> = {}
  for (const [id, harness] of Object.entries(pack.harnesses)) {
    const args = harness.resume?.args ?? []
    const slot = args.findIndex((arg) => arg.includes(SESSION_SLOT))
    const legacy = slot >= 0 ? [...args.slice(0, slot), ...args.slice(slot + 1)] : args
    out[id] = {
      match: [...harness.match],
      label: harness.label,
      ...(harness.domain ? { domain: harness.domain } : {}),
      ...(harness.color ? { color: harness.color } : {}),
      ...(harness.resume
        ? {
            resume: { cmd: harness.resume.executable, args: legacy },
            recipe: { executable: harness.resume.executable, args: [...args] }
          }
        : {}),
      ...(harness.hooks ? { hooks: harness.hooks } : {}),
      ...(harness.maintenance ? { maintenance: [...harness.maintenance] } : {}),
      ...(harness.publisher ? { publisher: harness.publisher } : {}),
      ...(harness.testOnly ? { testOnly: true } : {})
    }
  }
  return out
}

/* -------------------------------------------------------------- profiles */

export function launchProfile(
  pack: HarnessRuntimePack,
  profileId: string
): HarnessLaunchProfile | undefined {
  return pack.profiles[profileId]
}

/**
 * Lower a Pack profile's declarative recipe into the LaunchRecipe argv/routes
 * the planner consumes. Pure mapping: no harness name is compared anywhere.
 */
export function argvFromProfile(
  profile: HarnessLaunchProfile,
  executable: string
): Record<string, unknown>[] {
  const argv = profile.recipe?.process?.argv ?? []
  return argv.length ? [{ literal: executable }, ...argv] : [{ literal: executable }]
}

export function routesFromProfile(
  profile: HarnessLaunchProfile,
  fallbackKind: string
): Record<string, unknown>[] {
  const routes = profile.recipe?.routes
  if (Array.isArray(routes) && routes.length) return routes
  return [{ source: 'task/initial.txt', kind: fallbackKind, required: true }]
}

export function locatorFromProfile(
  profile: HarnessLaunchProfile,
  identityJson?: string
): { commands: string[]; envOverride?: string } {
  let fromIdentity: { commands: string[]; envOverride?: string } | null = null
  if (identityJson) {
    try {
      const parsed = recordOf(JSON.parse(identityJson))
      const locator = recordOf(parsed.locator ?? parsed)
      fromIdentity = {
        commands: Array.isArray(locator.commands) ? (locator.commands as string[]) : [],
        ...(typeof locator.envOverride === 'string' ? { envOverride: locator.envOverride } : {})
      }
    } catch {
      fromIdentity = null
    }
  }
  const declared = profile.recipe?.process?.executableLocator ?? profile.executableLocator ?? {}
  const commands =
    fromIdentity && fromIdentity.commands.length ? fromIdentity.commands : (declared.commands ?? [])
  const envOverride = fromIdentity?.envOverride ?? declared.envOverride
  return { commands, ...(envOverride ? { envOverride } : {}) }
}

/* ----------------------------------------------------------- maintenance */

/**
 * Pack-declared resume support, as the runtime needs it.
 *
 * This is the single answer to "may this harness's native session be offered for
 * resume?" — the session store (hook commit, desktop import) asks this instead
 * of guessing from a native id, and the renderer asks the same question through
 * the descriptor projection. `map` is a plain boolean per harness id so it can
 * be handed to a constructor or serialized.
 */
export interface HarnessResumeSupport {
  hasResumeRecipe(harnessId: string): boolean
  map: ReadonlyMap<string, boolean>
  harnessIds: string[]
}

export function harnessResumeSupport(pack: HarnessRuntimePack): HarnessResumeSupport {
  const map = new Map<string, boolean>()
  for (const [id, harness] of Object.entries(pack.harnesses)) {
    map.set(id, Boolean(harness.resume?.executable))
  }
  return {
    hasResumeRecipe: (harnessId: string) => map.get(harnessId) === true,
    map,
    harnessIds: [...map.keys()]
  }
}

export interface LockSweepDeclaration {
  harnessId: string
  lockDirTemplate: string
  lockPattern: string
  holder: string
}

export function maintenanceActions(pack: HarnessRuntimePack, harnessId: string): string[] {
  return pack.harnesses[harnessId]?.maintenance ?? []
}

export function harnessesWithMaintenance(pack: HarnessRuntimePack, action: string): string[] {
  return Object.entries(pack.harnesses)
    .filter(([, harness]) => (harness.maintenance ?? []).includes(action))
    .map(([id]) => id)
}

export function lockSweepDeclaration(
  pack: HarnessRuntimePack,
  harnessId: string
): LockSweepDeclaration | null {
  const harness = pack.harnesses[harnessId]
  if (!harness?.lockDir || !(harness.maintenance ?? []).includes('sweep-session-locks')) return null
  return {
    harnessId,
    lockDirTemplate: harness.lockDir,
    lockPattern: harness.lockPattern ?? '*.lock',
    holder: harness.lockHolder ?? harnessId
  }
}
