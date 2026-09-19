// claude/recipe.ts — S-INJECTION §5 launch recipe for Claude Code.
//
// Builds the exact ProcessSpec IMP-19's LaunchPlan carries:
//
//   executable = resolved claude binary
//   argv = ["--append-system-prompt-file", mandatoryPath,
//           ...(pluginDir      ? ["--plugin-dir", pluginDir]            : []),
//           ...(mcpConfigPath  ? ["--mcp-config", mcpConfigPath,
//                               "--strict-mcp-config"]                  : []),
//           ...(settingsPath   ? ["--settings", settingsPath]           : []),
//           ...(primaryAgent   ? ["--agent", primaryAgent]              : []),
//           ...(sessionId      ? ["--session-id", sessionId]            : []),
//           ...(model          ? ["--model", model]                     : []),
//           ...(permissionMode ? ["--permission-mode", permissionMode]  : []),
//           ...(addDirs        ? ["--add-dir", ...addDirs]              : []),
//           ...(allowedTools   ? ["--allowedTools", ...allowedTools]    : []),
//           ...(disallowedTools? ["--disallowedTools", ...disallowed]   : []),
//           ...extraArgs,
//           initialText]                                   ← first input
//   cwd = allocated checkout
//   stdio = pty (interactive TUI) — pipes only when the caller asks
//
// This is an argv ARRAY — never a shell string; no `$(cat ...)` interpolation
// (S-INJECTION §4.2). initialText is the real body of task/initial.txt, not
// its path (§5). Environment carries paths/digests only — credentials live in
// connection/worker, read by the scoped CLI itself, never in env/argv.

import { createHash } from 'node:crypto'
import type { ErrorCode, MahasError, ProcessSpec } from '../../../mahas-contracts/src/index.ts'
import type { ComponentPlan, InjectionRouteEntry } from './components.ts'
import { CLAUDE_LAYOUT } from './components.ts'

/* ------------------------------------------------------------- constants */

/**
 * Linux MAX_ARG_STRLEN — hard kernel ceiling for ONE argv string
 * (PAGE_SIZE * 32 = 128 KiB). S-INJECTION §4: on physical-limit overflow do
 * not truncate/summarize — return INJECTION_UNSUPPORTED and block the launch.
 */
export const MAX_ARG_STRLEN_BYTES = 131_072

/** conservative whole-argv guard (ARG_MAX is ~2 MiB on Linux) */
export const MAX_ARGV_TOTAL_BYTES = 1_500_000

/** env keys this recipe owns — callers may not override them silently */
export const MAHAS_ENV = {
  executionRoot: 'MAHAS_EXECUTION_ROOT',
  binDir: 'MAHAS_BIN_DIR',
  bundleDigest: 'MAHAS_BUNDLE_DIGEST',
  surfaceDigest: 'MAHAS_SURFACE_DIGEST',
  envelopeDigest: 'MAHAS_ENVELOPE_DIGEST',
  profile: 'MAHAS_HARNESS_PROFILE'
} as const

export type ClaudePermissionMode =
  'acceptEdits' | 'auto' | 'bypassPermissions' | 'dontAsk' | 'manual' | 'plan'

/* ------------------------------------------------------------------ input */

/** everything the recipe needs, already resolved by materialize+prepare */
export interface ClaudeLaunchInput {
  /** resolved claude binary (profile executableLocator output) */
  executable: string
  /** allocated checkout — the session's cwd */
  cwd: string
  /** absolute path of the materialized mandatory.md */
  mandatoryPath: string
  /** FULL UTF-8 body of task/initial.txt — positional argv, not a path */
  initialText: string
  /** absolute plugin root when the plan emitted plugin files */
  pluginDir?: string
  /** absolute scoped mcp.json path (only when mcpServers were configured) */
  mcpConfigPath?: string
  /**
   * `--strict-mcp-config` — keep the MCP surface to the scoped file.
   * Default true whenever mcpConfigPath is set (the action-surface
   * intersection rule); set false only when inherited MCP config is
   * deliberately part of the surface.
   */
  strictMcp?: boolean
  /** absolute execution-settings JSON path (settings-policy output) */
  settingsPath?: string
  /** primary native agent name — becomes `--agent <name>` */
  primaryAgent?: string
  /** pre-assigned native conversation id — `--session-id <uuid>` */
  sessionId?: string
  model?: string
  permissionMode?: ClaudePermissionMode
  /** `--add-dir` entries beyond the checkout cwd */
  addDirs?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  /** launch-config extras appended verbatim before the prompt */
  extraArgs?: string[]
  /** interactive TUI wants a pty (default); pipes only for non-interactive use */
  stdio?: 'pty' | 'pipes'
  terminal?: { cols: number; rows: number }
  /** execution root — exported as MAHAS_EXECUTION_ROOT (+ bin/ as MAHAS_BIN_DIR) */
  executionRoot?: string
  /** pinned digests exported for the join/accept bootstrap (not secrets) */
  digests?: { bundle?: string; surface?: string; envelope?: string }
  /** extra env entries; colliding with MAHAS_* keys is an error */
  env?: Record<string, string>
}

/** recipe output — ProcessSpec + the receipt-facing load map */
export interface ClaudeLaunch {
  processSpec: ProcessSpec
  /** argv[0]-relative indices for every routed component (InjectionReceipt) */
  routes: InjectionRouteEntry[]
  /** `<executionRoot>/bin` — host prepends to PATH so `mahas` resolves */
  pathPrepend: string[]
  /** how the first task body reaches the model */
  firstInput: { method: 'argv-positional-prompt'; argvIndex: number; byteLength: number }
  warnings: string[]
}

const err = (code: ErrorCode, message: string, details?: unknown): MahasError => ({
  code,
  message,
  retry: 'none',
  details
})

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')

function checkArg(arg: string, what: string): void {
  if (arg.includes('\0')) {
    throw err('MODEL_INVALID', `${what} contains NUL — argv cannot carry it`)
  }
  if (byteLen(arg) >= MAX_ARG_STRLEN_BYTES) {
    throw err(
      'INJECTION_UNSUPPORTED',
      `${what} is ${byteLen(arg)} bytes ≥ MAX_ARG_STRLEN (${MAX_ARG_STRLEN_BYTES}) — launch blocked rather than truncated`
    )
  }
}

/* ------------------------------------------------------------ argv build */

/**
 * Assemble the S-INJECTION §5 argv array (without the executable at [0] —
 * buildClaudeLaunch prepends it). The initial.txt body is always the
 * trailing positional element.
 */
export function buildClaudeArgv(input: ClaudeLaunchInput): string[] {
  const argv: string[] = []

  argv.push('--append-system-prompt-file', input.mandatoryPath)
  if (input.pluginDir) argv.push('--plugin-dir', input.pluginDir)
  if (input.mcpConfigPath) {
    argv.push('--mcp-config', input.mcpConfigPath)
    const strict = input.strictMcp ?? true
    if (strict) argv.push('--strict-mcp-config')
  }
  if (input.settingsPath) argv.push('--settings', input.settingsPath)
  if (input.primaryAgent) argv.push('--agent', input.primaryAgent)
  if (input.sessionId) argv.push('--session-id', input.sessionId)
  if (input.model) argv.push('--model', input.model)
  if (input.permissionMode) argv.push('--permission-mode', input.permissionMode)
  if (input.addDirs?.length) argv.push('--add-dir', ...input.addDirs)
  if (input.allowedTools?.length) argv.push('--allowedTools', ...input.allowedTools)
  if (input.disallowedTools?.length) argv.push('--disallowedTools', ...input.disallowedTools)
  if (input.extraArgs?.length) argv.push(...input.extraArgs)

  // first input — the actual initial.txt body as the trailing positional
  argv.push(input.initialText)

  return argv
}

/**
 * the full launch: validated argv + env + cwd + load-map.
 * Pass the ComponentPlan to get routes with argv indices resolved.
 */
export function buildClaudeLaunch(input: ClaudeLaunchInput, plan?: ComponentPlan): ClaudeLaunch {
  if (!input.executable) throw err('INPUT_NOT_READY', 'claude executable not resolved')
  if (!input.cwd) throw err('INPUT_NOT_READY', 'no allocated checkout cwd')
  if (!input.mandatoryPath)
    throw err('MANDATORY_COMPONENT_MISSING', 'no materialized mandatory.md path')
  if (input.initialText === undefined || input.initialText.length === 0)
    throw err('INPUT_NOT_READY', 'initial.txt body is empty — first input is required')

  const argv = buildClaudeArgv(input)
  checkArg(input.executable, 'executable path')
  for (const a of argv) checkArg(a, 'argv element')
  const total = byteLen(input.executable) + argv.reduce((n, a) => n + byteLen(a) + 1, 0)
  if (total >= MAX_ARGV_TOTAL_BYTES) {
    throw err(
      'INJECTION_UNSUPPORTED',
      `assembled argv is ${total} bytes ≥ ${MAX_ARGV_TOTAL_BYTES} — launch blocked rather than truncated`
    )
  }

  const warnings: string[] = []
  if (input.stdio === 'pipes') {
    warnings.push(
      'stdio=pipes: interactive claude is a TUI — pipes mode is only sane for non-interactive (-p) launches'
    )
  }

  const env: Record<string, string> = {}
  const reserved = new Set<string>(Object.values(MAHAS_ENV))
  for (const [k, v] of Object.entries(input.env ?? {})) {
    if (reserved.has(k)) {
      throw err('OPERATION_CONFLICT', `env key ${k} is reserved by the recipe`)
    }
    checkArg(v, `env ${k}`)
    env[k] = v
  }
  if (input.executionRoot) {
    env[MAHAS_ENV.executionRoot] = input.executionRoot
    env[MAHAS_ENV.binDir] = `${input.executionRoot}/${CLAUDE_LAYOUT.binDir}`
    env[MAHAS_ENV.profile] = 'claude-code'
  }
  if (input.digests?.bundle) env[MAHAS_ENV.bundleDigest] = input.digests.bundle
  if (input.digests?.surface) env[MAHAS_ENV.surfaceDigest] = input.digests.surface
  if (input.digests?.envelope) env[MAHAS_ENV.envelopeDigest] = input.digests.envelope

  const processSpec: ProcessSpec = {
    argv: [input.executable, ...argv],
    cwd: input.cwd,
    env,
    ...(input.stdio !== 'pipes' ? { terminal: input.terminal ?? { cols: 80, rows: 24 } } : {})
  }

  const launch: ClaudeLaunch = {
    processSpec,
    routes: [],
    pathPrepend: input.executionRoot ? [`${input.executionRoot}/${CLAUDE_LAYOUT.binDir}`] : [],
    firstInput: {
      method: 'argv-positional-prompt',
      argvIndex: argv.length, // last element of processSpec.argv (executable at [0])
      byteLength: byteLen(input.initialText)
    },
    warnings
  }
  if (plan) {
    launch.routes = [
      ...attachRouteIndices(plan, launch),
      {
        componentId: '(task)',
        route: 'first-input',
        argvIndex: launch.firstInput.argvIndex,
        byteDigest: createHash('sha256').update(input.initialText, 'utf8').digest('hex'),
        loadingPhase: 'first-input'
      }
    ]
  }
  return launch
}

/**
 * Merge a ComponentPlan into launch input — the recipe-facing half of
 * planComponents(). Callers still supply executable/cwd/initialText/paths.
 */
export function launchInputFromPlan(
  plan: ComponentPlan,
  base: Omit<
    ClaudeLaunchInput,
    | 'primaryAgent'
    | 'allowedTools'
    | 'disallowedTools'
    | 'model'
    | 'sessionId'
    | 'permissionMode'
    | 'addDirs'
    | 'extraArgs'
    | 'stdio'
    | 'env'
  >
): ClaudeLaunchInput {
  return {
    ...base,
    primaryAgent: plan.primaryAgent,
    allowedTools: plan.allowedTools,
    disallowedTools: plan.disallowedTools,
    model: plan.launch.model,
    sessionId: plan.launch.sessionId,
    permissionMode: plan.launch.permissionMode as ClaudePermissionMode | undefined,
    addDirs: plan.launch.addDirs,
    extraArgs: plan.launch.extraArgs,
    stdio: plan.launch.stdio,
    env: plan.launch.env
  }
}

/**
 * Attach argv indices to a plan's routes once the launch is built — the
 * InjectionReceipt-facing join between components and the spawned argv.
 * Mutates nothing; returns a new routes array.
 */
export function attachRouteIndices(
  plan: ComponentPlan,
  launch: ClaudeLaunch
): InjectionRouteEntry[] {
  const argv = launch.processSpec.argv
  const flagIndex = (needle: string): number | undefined => {
    const i = argv.indexOf(needle)
    return i === -1 ? undefined : i + 1 // value slot follows the flag
  }
  return plan.routes.map((r) => {
    switch (r.route) {
      case 'instruction-file':
        return { ...r, argvIndex: flagIndex('--append-system-prompt-file') }
      case 'plugin-skill':
      case 'plugin-agent':
        return { ...r, argvIndex: flagIndex('--plugin-dir') }
      case 'primary-agent':
        return { ...r, argvIndex: flagIndex('--agent') }
      case 'mcp-config':
        return { ...r, argvIndex: flagIndex('--mcp-config') }
      case 'settings-file':
        return { ...r, argvIndex: flagIndex('--settings') }
      case 'argv-flags':
        return {
          ...r,
          argvIndex: flagIndex('--allowedTools') ?? flagIndex('--disallowedTools')
        }
      default:
        return r
    }
  })
}

/* ----------------------------------------------------------------- resume */

export interface ClaudeResumeInput {
  executable: string
  /** native conversation id recorded at first spawn */
  sessionId: string
  cwd: string
  /** same config flags as the original launch — resume keeps the route */
  mandatoryPath?: string
  pluginDir?: string
  mcpConfigPath?: string
  strictMcp?: boolean
  settingsPath?: string
  primaryAgent?: string
  model?: string
  /** optional wake/continuation prompt after --resume <id> */
  prompt?: string
}

/**
 * Native-resume argv: `claude --resume <sessionId>` with the SAME component
 * route flags. S-INJECTION §8 — allowed only for the same
 * role/interface/bundle on a verified route; the caller enforces that.
 */
export function buildClaudeResumeArgv(input: ClaudeResumeInput): string[] {
  if (!input.sessionId) throw err('INPUT_NOT_READY', 'no native session id to resume')
  const argv: string[] = [input.executable]
  if (input.mandatoryPath) argv.push('--append-system-prompt-file', input.mandatoryPath)
  if (input.pluginDir) argv.push('--plugin-dir', input.pluginDir)
  if (input.mcpConfigPath) {
    argv.push('--mcp-config', input.mcpConfigPath)
    if (input.strictMcp ?? true) argv.push('--strict-mcp-config')
  }
  if (input.settingsPath) argv.push('--settings', input.settingsPath)
  if (input.primaryAgent) argv.push('--agent', input.primaryAgent)
  if (input.model) argv.push('--model', input.model)
  argv.push('--resume', input.sessionId)
  if (input.prompt) {
    checkArg(input.prompt, 'resume prompt')
    argv.push(input.prompt)
  }
  for (const a of argv) checkArg(a, 'resume argv element')
  return argv
}
