// claude/settings-policy.ts — what Claude Code auto-loads vs what mahas writes.
//
// IMP-24 §4.4: record the project/user/org auto-loading paths and the
// permission/tool settings in the manifest — and NEVER overwrite shared
// files. Two halves:
//
//   1. claudeInheritedLoadPaths() — the settings/instruction/skill/agent
//      paths Claude Code reads on its own (user ~/.claude, project .claude,
//      managed policy dirs). These are INHERITED INPUTS: they ride the
//      launch whether we ask or not, so the receipt must show them. We probe
//      existence; we never write them (no silent removal of org policy).
//
//   2. buildExecutionSettings() — the ONE settings file this profile may
//      emit, under the execution root, passed via `--settings`. Additive
//      session settings; validation keeps credentials and hook installs out
//      of component payloads (secrets stay in connection/, hooks stay an
//      explicit observation-domain install).

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { ErrorCode, MahasError } from '../../../mahas-contracts/src/index.ts'
import type { ComponentBinding, PlannedFile } from './components.ts'
import { CLAUDE_LAYOUT } from './components.ts'

/* ------------------------------------------------- inherited load paths */

export interface InheritedLoadPath {
  /** whose config this is — managed = org/policy, user, project, local */
  scope: 'managed' | 'user' | 'project' | 'local'
  kind: 'settings' | 'instructions' | 'skills' | 'agents' | 'commands' | 'plugins'
  /** absolute path as the harness resolves it */
  path: string
  /** filled by probeInheritedPaths — honest observation, undefined unprobed */
  exists?: boolean
}

/**
 * Every path Claude Code may auto-load for a session at `cwd`. Not
 * exhaustive by plugin marketplace — the well-known fixed locations only.
 * `env` is the spawn environment: CLAUDE_CONFIG_DIR relocates the user dir.
 */
export function claudeInheritedLoadPaths(opts: {
  cwd: string
  env?: Record<string, string | undefined>
  home?: string
  platform?: NodeJS.Platform
}): InheritedLoadPath[] {
  const env = opts.env ?? (process.env as Record<string, string | undefined>)
  const home = opts.home ?? homedir()
  const platform = opts.platform ?? process.platform
  const userDir = env.CLAUDE_CONFIG_DIR?.length ? env.CLAUDE_CONFIG_DIR : join(home, '.claude')
  const cwd = opts.cwd

  const paths: InheritedLoadPath[] = [
    // managed / org policy — highest precedence, read-only by design
    ...managedSettingsPaths(platform).map((p): InheritedLoadPath => ({
      scope: 'managed',
      kind: 'settings',
      path: p
    })),
    // user level
    { scope: 'user', kind: 'settings', path: join(userDir, 'settings.json') },
    { scope: 'user', kind: 'instructions', path: join(userDir, 'CLAUDE.md') },
    { scope: 'user', kind: 'skills', path: join(userDir, 'skills') },
    { scope: 'user', kind: 'agents', path: join(userDir, 'agents') },
    { scope: 'user', kind: 'commands', path: join(userDir, 'commands') },
    { scope: 'user', kind: 'plugins', path: join(userDir, 'plugins') },
    // project level (checkout root = cwd of the session)
    { scope: 'project', kind: 'instructions', path: join(cwd, 'CLAUDE.md') },
    { scope: 'project', kind: 'settings', path: join(cwd, '.claude', 'settings.json') },
    { scope: 'project', kind: 'agents', path: join(cwd, '.claude', 'agents') },
    { scope: 'project', kind: 'commands', path: join(cwd, '.claude', 'commands') },
    { scope: 'project', kind: 'skills', path: join(cwd, '.claude', 'skills') },
    // local — machine-local overrides inside the project
    { scope: 'local', kind: 'settings', path: join(cwd, '.claude', 'settings.local.json') }
  ]
  return paths
}

function managedSettingsPaths(platform: NodeJS.Platform): string[] {
  switch (platform) {
    case 'darwin':
      return ['/Library/Application Support/ClaudeCode/managed-settings.json']
    case 'win32':
      return ['C:\\ProgramData\\ClaudeCode\\managed-settings.json']
    default:
      return ['/etc/claude-code/managed-settings.json']
  }
}

/**
 * Probe which inherited paths actually exist — observation only.
 * Results feed EffectiveContextReceipt.inherited, never a write plan.
 */
export function probeInheritedPaths(paths: readonly InheritedLoadPath[]): InheritedLoadPath[] {
  return paths.map((p) => {
    try {
      const st = statSync(p.path)
      return { ...p, exists: st.isFile() || st.isDirectory() }
    } catch {
      return { ...p, exists: false }
    }
  })
}

/* ------------------------------------------------- execution settings */

/**
 * Settings keys this profile accepts into the execution file — the
 * auditable minimum. Everything else is rejected loudly (rejected[]), so
 * a component can never smuggle config past the manifest.
 */
export const EXECUTION_SETTINGS_KEYS = [
  'permissions',
  'env',
  'model',
  'includeCoAuthoredBy',
  'cleanupPeriodDays',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'enableAllProjectMcpServers'
] as const

/**
 * Keys refused outright — credential carriers and channel hijacks.
 *   hooks / apiKeyHelper / awsCredentialExport / awsAuthRefresh — code or
 *   secret injection, not component payload.
 */
export const FORBIDDEN_SETTINGS_KEYS = [
  'hooks',
  'apiKeyHelper',
  'awsCredentialExport',
  'awsAuthRefresh',
  'forceLoginMethod',
  'forceLoginOrgUUID'
] as const

/** env names that would smuggle provider credentials into the process env */
export const FORBIDDEN_ENV_PATTERN =
  /(_API_KEY|_AUTH_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS|API_KEY_HELPER|^ANTHROPIC_|^CLAUDE_CODE_OAUTH)/i

const err = (code: ErrorCode, message: string, details?: unknown): MahasError => ({
  code,
  message,
  retry: 'none',
  details
})

export interface ExecutionSettingsResult {
  /** file body for role/components/claude-settings.json (pretty JSON) */
  content: string
  /** keys that made it in — receipt visibility */
  applied: string[]
  /** keys refused, with the reason — surfaced, never silently dropped */
  rejected: { key: string; reason: string }[]
}

/**
 * Build the execution-scoped `--settings` file body from merged
 * tool-config payloads. Returns null when there is nothing worth writing —
 * callers then omit --settings entirely (no empty config flag noise).
 */
export function buildExecutionSettings(input: {
  permissions?: ComponentBinding['permissions']
  settings?: Record<string, unknown>
}): ExecutionSettingsResult | null {
  const out: Record<string, unknown> = {}
  const applied: string[] = []
  const rejected: ExecutionSettingsResult['rejected'] = []

  const p = input.permissions ?? {}
  const permissions: Record<string, unknown> = {}
  if (p.allow?.length) permissions.allow = p.allow
  if (p.deny?.length) permissions.deny = p.deny
  if (p.defaultMode) permissions.defaultMode = p.defaultMode
  if (p.additionalDirectories?.length) permissions.additionalDirectories = p.additionalDirectories
  if (Object.keys(permissions).length) {
    out.permissions = permissions
    applied.push('permissions')
  }

  for (const [key, value] of Object.entries(input.settings ?? {})) {
    if ((FORBIDDEN_SETTINGS_KEYS as readonly string[]).includes(key)) {
      rejected.push({
        key,
        reason:
          key === 'hooks'
            ? 'hook installation is an explicit observation-domain operation — not a component payload'
            : 'credential/login carrier — never in an execution settings file'
      })
      continue
    }
    if (!(EXECUTION_SETTINGS_KEYS as readonly string[]).includes(key)) {
      rejected.push({ key, reason: 'not in EXECUTION_SETTINGS_KEYS allowlist' })
      continue
    }
    if (key === 'env' && value && typeof value === 'object') {
      const envIn = value as Record<string, string>
      const envOut: Record<string, string> = {}
      for (const [name, v] of Object.entries(envIn)) {
        if (FORBIDDEN_ENV_PATTERN.test(name)) {
          rejected.push({ key: `env.${name}`, reason: 'credential-looking env name refused' })
          continue
        }
        envOut[name] = v
      }
      if (Object.keys(envOut).length) {
        out.env = envOut
        applied.push('env')
      }
      continue
    }
    out[key] = value
    applied.push(key)
  }

  if (!Object.keys(out).length) return rejected.length ? { content: '', applied, rejected } : null
  return { content: JSON.stringify(out, null, 2) + '\n', applied, rejected }
}

/** canonical execution-settings slot (CLAUDE_LAYOUT.settings) */
export function executionSettingsPath(executionRoot: string): string {
  return join(executionRoot, CLAUDE_LAYOUT.settings)
}

/* ------------------------------------------------- shared-file guards */

/**
 * Roots a mahas launch must never write into — the shared/user/managed
 * config space. The materializer checks planned targets against these; a
 * collision is a failure, never an overwrite (S-INJECTION §3).
 */
export function claudeSharedRoots(opts: {
  cwd: string
  env?: Record<string, string | undefined>
  home?: string
  platform?: NodeJS.Platform
}): string[] {
  const inherited = claudeInheritedLoadPaths(opts)
  const roots = new Set<string>()
  for (const p of inherited) {
    // files → their dir; dirs → themselves
    roots.add(p.path.endsWith('.json') || p.path.endsWith('.md') ? dirname(p.path) : p.path)
  }
  return [...roots]
}

/**
 * Every planned file must resolve strictly under the execution root —
 * relative only, no '..', no absolute paths, no NUL. This is what makes
 * "공용 파일을 덮어쓰지 않는다" structural instead of a promise.
 */
export function assertExecutionScoped(
  files: readonly PlannedFile[],
  executionRoot: string
): MahasError | null {
  const root = resolve(executionRoot)
  for (const f of files) {
    const rel = f.relativePath
    if (rel.includes('\0')) {
      return err('MODEL_INVALID', `planned path contains NUL: ${JSON.stringify(rel)}`)
    }
    if (isAbsolute(rel)) {
      return err(
        'OPERATION_CONFLICT',
        `planned path is absolute — components must stay under the execution root: ${rel}`
      )
    }
    const resolved = resolve(root, rel)
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      return err(
        'OPERATION_CONFLICT',
        `planned path escapes the execution root: ${rel} → ${resolved}`
      )
    }
  }
  return null
}
