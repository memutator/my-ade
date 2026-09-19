// mahas-harness-config — the harness profile registry port.
//
// Per-harness knowledge (process-match patterns, icons, resume recipes,
// hook capability) is DATA owned here — not a provider adapter and not an
// App Server client (spec/architecture.md §1). IMP-01 provides the real
// loader for the existing manifest format so runtime/CLI read profiles
// from one place; the renderer keeps its own copy via the agents:manifest
// IPC until the workbench rewires (see packages/README.md migration table).
//
// Source format — the file resources/agents/manifest.json already uses:
//   { "<provider-id>": { label, match[], domain?, color?, resume?{cmd,args[]} } }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface HarnessResumeSpec {
  /** the CLI that reopens a session, e.g. `claude` */
  cmd: string
  /** static args placed BEFORE the session id, e.g. ['--resume'] */
  args?: string[]
}

export interface HarnessProfile {
  label?: string
  /** process-signature patterns (comm/argv basenames) used for detection */
  match?: string[]
  /** vendor domain — favicon source for the provider icon */
  domain?: string
  /** brand color — letter-monogram fallback */
  color?: string
  /** how to reopen a native session; absent = resume not supported */
  resume?: HarnessResumeSpec
}

export const HARNESS_MANIFEST_FILE = 'manifest.json'

/** load <dir>/manifest.json — {} when absent or malformed, same as today */
export function loadHarnessProfiles(dir: string): Record<string, HarnessProfile> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, HARNESS_MANIFEST_FILE), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, HarnessProfile>
  } catch {
    return {}
  }
}

/**
 * `<cmd> <args…> '<sessionId>'` — the command line typed into a session's
 * shell to reopen it (mirrors src/renderer/src/agents.ts:resumeCommand).
 * Single-quote escaping matches the existing renderer implementation.
 */
export function resumeCommand(
  profile: HarnessProfile | undefined,
  sessionId: string
): string | null {
  const spec = profile?.resume
  if (!spec?.cmd) return null
  const quoted = `'${sessionId.replace(/'/g, `'\\''`)}'`
  return [spec.cmd, ...(spec.args ?? []), quoted].join(' ')
}

/* ---------------------------------------------------------------- IMP-24
 * File-based harness realization — the claude-code profile: component
 * lowering (role/components/* + plugin), the S-INJECTION §5 argv recipe,
 * and the settings/write policy. Consumers: IMP-09 materialization,
 * IMP-19 worker.prepare LaunchPlan, IMP-30 role-implementation tooling.
 */

export {
  COMPONENT_KINDS,
  CLAUDE_LAYOUT,
  planComponents,
  pluginManifestJson,
  readFrontmatter
} from './claude/components.ts'
export type {
  ComponentBinding,
  ComponentContent,
  ComponentKind,
  ComponentPlan,
  Frontmatter,
  InjectionRouteEntry,
  PlannedFile,
  SkillDelivery,
  SubagentRole
} from './claude/components.ts'

export {
  MAX_ARGV_TOTAL_BYTES,
  MAX_ARG_STRLEN_BYTES,
  MAHAS_ENV,
  attachRouteIndices,
  buildClaudeArgv,
  buildClaudeLaunch,
  buildClaudeResumeArgv,
  launchInputFromPlan
} from './claude/recipe.ts'
export type {
  ClaudeLaunch,
  ClaudeLaunchInput,
  ClaudePermissionMode,
  ClaudeResumeInput
} from './claude/recipe.ts'

export {
  EXECUTION_SETTINGS_KEYS,
  FORBIDDEN_ENV_PATTERN,
  FORBIDDEN_SETTINGS_KEYS,
  assertExecutionScoped,
  buildExecutionSettings,
  claudeInheritedLoadPaths,
  claudeSharedRoots,
  executionSettingsPath,
  probeInheritedPaths
} from './claude/settings-policy.ts'
export type { ExecutionSettingsResult, InheritedLoadPath } from './claude/settings-policy.ts'

export {
  CLAUDE_PERMISSION_MODES,
  CLAUDE_PROFILE_ID,
  CLAUDE_PROFILE_REVISION,
  SUPPORTED_COMPONENT_KINDS,
  claudeProfileDraft,
  resolveClaudeExecutable
} from './claude/profile.ts'
export type {
  ExecutableResolution,
  HarnessProfileDraft,
  HarnessProfileState
} from './claude/profile.ts'

// IMP-25 — config-body harness realization for Codex CLI (spec/injection.md
// §6 path B): TOML developer_instructions emission, .agents/skills catalog
// materialization, scoped-CLI env port, launch/resume recipe, and the
// settingsPolicy + profile revision registered via harness.profile.register.
export * from './codex/components.ts'
export * from './codex/settings-policy.ts'
export * from './codex/recipe.ts'

// IMP-D — builtin.harness-runtime Pack data. The Pack revision
// (integrations/packs/harness-runtime) owns harness labels, match patterns,
// resume/launch recipes, hook installers and maintenance declarations; these
// helpers are the only core readers, so adding a harness is a data change.
export {
  EVENT_SLOT,
  HARNESS_RUNTIME_PACK_DIR,
  HARNESS_RUNTIME_PACK_ID,
  SESSION_SLOT,
  argvFromProfile,
  expandInstallerPath,
  expandInstallerTemplate,
  harnessManifestProjection,
  harnessResumeSupport,
  harnessRuntimeHookScriptPath,
  harnessesWithMaintenance,
  hookCommandText,
  installerPlan,
  installerTokenContext,
  launchProfile,
  loadHarnessRuntimePack,
  locatorFromProfile,
  lockSweepDeclaration,
  maintenanceActions,
  resolveBuiltinPacksDir,
  resumeCommandText,
  routesFromProfile
} from './runtime-pack.ts'
export type {
  HarnessInstallerFile,
  HarnessLaunchProfile,
  HarnessManifestEntry,
  HarnessRuntimeHarness,
  HarnessRuntimeInstaller,
  HarnessRuntimePack,
  InstallerPlan,
  InstallerTokenContext,
  LockSweepDeclaration
} from './runtime-pack.ts'
export type { HarnessResumeSupport } from './runtime-pack.ts'
export { SESSION_SLOT as SESSION_SLOT_TEXT } from './resume-recipe.ts'
export type { HarnessResumeRecipe } from './resume-recipe.ts'

// Session-lock safety core — pure decision rules with injected IO.
export { decideSessionLock, sweepSessionLocks } from './session-locks.ts'
export type {
  SessionLockDeclaration,
  SessionLockSweepIo,
  SessionLockVerdict
} from './session-locks.ts'
