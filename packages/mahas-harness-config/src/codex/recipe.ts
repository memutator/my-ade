// codex/recipe.ts — the codex launch recipe IMP-19's worker.prepare consumes.
//
// Turns a compiled ContextBundle's rendered inputs (component set + authored
// content + initial task text) into the exact spawn recipe for Codex CLI —
// spec/injection.md §6, implementation path B:
//
//   executable = resolved codex binary       (locator below; launch resolves it)
//   argv       = ["-c", "developer_instructions=<TOML-basic-string>", initialText]
//   cwd        = allocated execution checkout
//   env        = additive allowlist only (scoped CLI port); secrets never
//   stdio      = pty (interactive TUI is the baseline surface)
//
// Hard rules honored here (instruction §4.2, spec §4/§6):
//   * NUL anywhere in argv/env            → explicit INJECTION_UNSUPPORTED
//   * argv element or total over OS limit → explicit INJECTION_UNSUPPORTED,
//     never a silently invented file route, never truncation
//   * no shell expansion, no unvalidated file flags — argv is an array and
//     `$(cat …)`-style interpolation does not exist in this code path
//   * secrets never enter argv/env/body — the scoped CLI port is a PATH
//     prepend + MAHAS_CLI pointer; the credential file stays outside the
//     model input (connection/worker, materialized by IMP-09/IMP-19)
//
// The recipe is deterministic: identical inputs → identical argv/env/files/
// routes. Verification of the real installed binary is VER-10's job — the
// profile revision registers 'documented', never 'verified'.

import {
  codexErr,
  codexOk,
  encodeDeveloperInstructionsOverride,
  planCodexComponents,
  sha256Hex
} from './components.ts'
import type {
  CodexComponentContent,
  CodexComponentKind,
  CodexComponentPlan,
  CodexInjectionRoute,
  CodexPlannedFile,
  CodexResult
} from './components.ts'
import type { ImplementationComponent } from '../../../mahas-contracts/src/index.ts'
import { CODEX_SETTINGS_POLICY, checkCodexEnv, isCodexOverrideAllowed } from './settings-policy.ts'
import type { CodexSettingsPolicy } from './settings-policy.ts'

// ---------------------------------------------------------------------------
// physical limits — checked as byte counts, never assumed (spec §4:
// "물리 한도 초과는 … launch를 block한다. 자동 요약·절단 금지")
// ---------------------------------------------------------------------------

export interface CodexLimits {
  /**
   * Max bytes in ONE argv element including its NUL terminator.
   * Linux MAX_ARG_STRLEN = 32 × PAGE_SIZE = 131072 — a single config
   * override string must stay strictly below it.
   */
  singleArgBytes: number
  /**
   * Total budget for argv + env bytes this recipe emits. Linux ARG_MAX is
   * typically 2 MiB and covers ambient env too, so the default leaves a
   * 64 KiB headroom for the inherited environment. The real execve check
   * still happens host-side; this is the recipe-level gate.
   */
  argvEnvTotalBytes: number
}

export const CODEX_ARG_LIMITS: CodexLimits = {
  singleArgBytes: 131072, // Linux MAX_ARG_STRLEN incl. terminator
  argvEnvTotalBytes: 2 * 1024 * 1024 - 64 * 1024 // ARG_MAX minus env headroom
}

// ---------------------------------------------------------------------------
// input — the materializer's view: component rows + authored content map,
// exactly like claude/recipe consumes planComponents' output.
// ---------------------------------------------------------------------------

export interface CodexCliAccess {
  /** directory of the scoped `mahas` launcher (execution-root bin/) — prepended to PATH */
  binDir: string
  /** absolute path of the scoped CLI wrapper the agent invokes */
  cliPath: string
}

export interface CodexLaunchInput {
  /** resolved codex binary (launcher resolves the profile's executableLocator) */
  executablePath: string
  /** canonical allocated checkout — cwd of the spawn and skill install root */
  checkoutDir: string
  /** the implementation's component rows (ImplementationComponent) */
  components: readonly ImplementationComponent[]
  /** authored bodies/bindings keyed by component id */
  content?: Record<string, CodexComponentContent>
  /**
   * Full UTF-8 body of task/initial.txt — the ACTUAL task text (goal, this
   * requirement's body, scope/constraints, exact inputs, direct peers,
   * outputs/settlement, join/accept request). A path name is not accepted.
   */
  initialText: string
  /** scoped CLI access port — required iff a tool-config component is present */
  cliAccess?: CodexCliAccess
  /** extra non-secret env (e.g. MAHAS_PANE-style attribution) — policy-checked */
  extraEnv?: Record<string, string>
  /** default 'pty' — the interactive TUI surface; 'pipes' for non-tty runs */
  stdio?: 'pty' | 'pipes'
  limits?: Partial<CodexLimits>
}

// ---------------------------------------------------------------------------
// output — the recipe half of ProcessSpec. IMP-19 composes the host-level
// ProcessSpec (spawnNonce, executionId, generation, resourceClaimToken,
// processLifetime) around this; this module never invents those identities.
// ---------------------------------------------------------------------------

export interface CodexProcessSpec {
  executable: string
  /** full argv array — argv[0]-less form per C-HOST ProcessSpec convention */
  argv: string[]
  cwd: string
  /** additive env — the launcher merges over its own allowlisted base env */
  env: Record<string, string>
  /** PATH-style prepends the launcher applies to the ambient value */
  envPrepend: Record<string, string[]>
  stdio: 'pty' | 'pipes'
}

export interface CodexLaunchSpec {
  processSpec: CodexProcessSpec
  /** checkout-relative files to write BEFORE spawn (skills), fail-on-conflict */
  materialize: CodexPlannedFile[]
  /** InjectionReceipt rows for every delivered component */
  routes: CodexInjectionRoute[]
  mandatoryTextDigest: string
  initialTextDigest: string
  /** argv index carrying the initial task text — the 'initial_attached' evidence */
  initialTextArgvIndex: number
  /** byte accounting the limit gate actually measured */
  argBytes: { perArg: number[]; envBytes: number; totalBytes: number }
  /** the component plan the spec was built from (diagnostics included) */
  plan: CodexComponentPlan
}

function hasNul(s: string): boolean {
  return s.includes('\u0000')
}

/** every launch-carried string is scanned; any NUL is a hard refusal */
function rejectNulInLaunch(input: CodexLaunchInput): CodexResult<never> | null {
  const haystack: Array<[string, string]> = [
    ['executablePath', input.executablePath],
    ['checkoutDir', input.checkoutDir],
    ['initialText', input.initialText],
    ...(input.extraEnv
      ? Object.entries(input.extraEnv).map(([k, v]) => [`env:${k}`, v] as [string, string])
      : []),
    ...(input.cliAccess
      ? ([
          ['cliAccess.binDir', input.cliAccess.binDir],
          ['cliAccess.cliPath', input.cliAccess.cliPath]
        ] as [string, string][])
      : [])
  ]
  for (const [where, s] of haystack) {
    if (hasNul(s)) {
      return codexErr('INJECTION_UNSUPPORTED', `NUL byte in ${where}`, {
        reason: 'nul-byte',
        field: where
      })
    }
  }
  return null
}

/**
 * Build the codex launch recipe. Returns named refusals instead of throwing:
 *   MANDATORY_COMPONENT_MISSING — no/empty instruction body; tool-config
 *                                 without cliAccess
 *   INJECTION_UNSUPPORTED       — plan-level refusals, NUL, oversize argv/env
 * The full diagnostic list rides details.planErrors so implementation.prepare
 * and worker.prepare see every blocker, not the first.
 */
export function buildCodexLaunchSpec(input: CodexLaunchInput): CodexResult<CodexLaunchSpec> {
  const limits: CodexLimits = { ...CODEX_ARG_LIMITS, ...input.limits }

  const nul = rejectNulInLaunch(input)
  if (nul) return nul

  // ---- component plan — diagnostics collected, then gated ------------------
  const plan = planCodexComponents(input.components, input.content ?? {})
  if (plan.errors.length > 0) {
    const first = plan.errors[0].error
    return codexErr(first.code, first.message, {
      reason: 'component-plan-errors',
      planErrors: plan.errors
    })
  }
  if (plan.mandatoryText === undefined) {
    // unreachable while the planner gates instruction presence — tripwire
    return codexErr(
      'MANDATORY_COMPONENT_MISSING',
      'mandatory instruction body is empty — the required clauses have no carrier',
      { reason: 'missing-mandatory-text' }
    )
  }
  if (plan.requiresCliAccess && !input.cliAccess) {
    return codexErr(
      'MANDATORY_COMPONENT_MISSING',
      'a tool-config component requires the scoped CLI access port ' +
        '(cliAccess.binDir/cliPath) but none was provided',
      { reason: 'cli-access-required' }
    )
  }

  // ---- config override: developer_instructions=<TOML basic string> --------
  const override = encodeDeveloperInstructionsOverride(plan.mandatoryText)
  if (!override.ok) return override
  if (!isCodexOverrideAllowed('developer_instructions')) {
    // unreachable under the current policy — kept as a tripwire so a future
    // edit cannot emit an unwhitelisted key without failing loudly
    return codexErr(
      'INJECTION_UNSUPPORTED',
      'developer_instructions removed from override whitelist',
      { reason: 'override-not-allowed' }
    )
  }

  // ---- argv: ["-c", override, initialText] ---------------------------------
  const argv = ['-c', override.value, input.initialText]
  const initialTextArgvIndex = argv.length - 1

  // ---- env: scoped CLI port + launch-config env + policy-checked extras ----
  const env: Record<string, string> = {}
  const envPrepend: Record<string, string[]> = {}
  if (input.cliAccess) {
    env.MAHAS_CLI = input.cliAccess.cliPath
    envPrepend.PATH = [input.cliAccess.binDir]
  }
  const envMerged = { ...plan.launch.env, ...input.extraEnv }
  const envCheck = checkCodexEnv(envMerged)
  if (!envCheck.ok) return envCheck
  Object.assign(env, envMerged)

  // ---- byte-limit gate ------------------------------------------------------
  const perArg = argv.map((a) => Buffer.byteLength(a, 'utf8'))
  for (let i = 0; i < argv.length; i++) {
    // +1 for the NUL terminator inside MAX_ARG_STRLEN accounting
    if (perArg[i] + 1 > limits.singleArgBytes) {
      return codexErr(
        'INJECTION_UNSUPPORTED',
        `argv[${i}] is ${perArg[i]} bytes — over the ${limits.singleArgBytes}-byte ` +
          `single-arg limit; no file route exists for this delivery, so the ` +
          `launch is blocked rather than truncated`,
        {
          reason: 'argv-too-large',
          argvIndex: i,
          bytes: perArg[i],
          limit: limits.singleArgBytes
        }
      )
    }
  }
  const envBytes =
    Object.entries(env).reduce((n, [k, v]) => n + Buffer.byteLength(`${k}=${v}`, 'utf8') + 1, 0) +
    Object.values(envPrepend)
      .flat()
      .reduce((n, v) => n + Buffer.byteLength(v, 'utf8') + 1, 0)
  const totalBytes = perArg.reduce((a, b) => a + b + 1, 0) + envBytes
  if (totalBytes > limits.argvEnvTotalBytes) {
    return codexErr(
      'INJECTION_UNSUPPORTED',
      `argv+env total ${totalBytes} bytes exceeds the ${limits.argvEnvTotalBytes}-byte ` +
        `recipe budget (ARG_MAX minus ambient-env headroom)`,
      { reason: 'argv-env-budget-exceeded', bytes: totalBytes, limit: limits.argvEnvTotalBytes }
    )
  }

  // ---- injection routes -----------------------------------------------------
  // planner emitted per-component routes; fix argvIndex now that argv exists
  const mandatoryDigest = sha256Hex(plan.mandatoryText)
  const routes: CodexInjectionRoute[] = plan.routes.map((r) =>
    r.route === 'config-argv' ? { ...r, argvIndex: 1, byteDigest: mandatoryDigest } : r
  )

  return codexOk({
    processSpec: {
      executable: input.executablePath,
      argv,
      cwd: input.checkoutDir,
      env,
      envPrepend,
      stdio: input.stdio ?? plan.launch.stdio ?? 'pty'
    },
    materialize: plan.files,
    routes,
    mandatoryTextDigest: mandatoryDigest,
    initialTextDigest: sha256Hex(input.initialText),
    initialTextArgvIndex,
    argBytes: { perArg, envBytes, totalBytes },
    plan
  })
}

// ---------------------------------------------------------------------------
// native resume — `codex resume <sessionId>` (mirrors resources/agents/
// manifest.json's codex entry so the shell-typed resume and the spawn-time
// native-resume route agree). Only valid when the resume is the same
// role/interface/bundle on a verified route (spec §8); a changed role or
// required instruction means a fresh conversation, not a resume.
// ---------------------------------------------------------------------------

export const CODEX_RESUME_RECIPE = {
  cmd: 'codex',
  args: ['resume'],
  sessionIdPosition: 'trailing'
} as const

export function buildCodexResumeArgv(sessionId: string): CodexResult<string[]> {
  if (!sessionId || sessionId.includes('\u0000')) {
    return codexErr('INJECTION_UNSUPPORTED', 'resume session id is empty or contains NUL', {
      reason: 'nul-byte'
    })
  }
  return codexOk([...CODEX_RESUME_RECIPE.args, sessionId])
}

// no wake recipe: an idle codex TUI cannot be poked programmatically by an
// approved route — execution.wake answers INJECTION_UNSUPPORTED and the
// delivery stays queued for manual resume (spec C-LAUNCH execution.wake).

// ---------------------------------------------------------------------------
// profile revision — the harness.profile.register payload for
// "instruction + optional skill + scoped CLI" (instruction §6 deliverable).
// ---------------------------------------------------------------------------

export const CODEX_INJECTION_RECIPE_ID = 'codex-config-body@v1'

export interface CodexProfileRegistration {
  profileId: string
  revision: number
  /** how the launcher resolves the binary — PATH lookup, admission-probed */
  executableLocator: { kind: 'PATH'; name: string }
  /** no verified installed version yet — documented basis only */
  versionRange: string
  supportedComponents: readonly CodexComponentKind[]
  /** kinds this revision refuses outright */
  unsupportedComponents: readonly CodexComponentKind[]
  /** skill is supported only as conditional catalog — required skills refused */
  conditionalOnlyComponents: readonly CodexComponentKind[]
  injectionRecipe: string
  resumeRecipe: typeof CODEX_RESUME_RECIPE
  wakeRecipe: null
  settingsPolicy: CodexSettingsPolicy
  /** documented — install-version verification is VER-10's, never pre-claimed */
  admissionState: 'documented'
  provenance: {
    basis: string
    verifiedInstall: false
  }
}

/**
 * The codex profile revision for instruction+optional-skill+scoped-CLI
 * implementations. Fresh object per call — registrations are immutable once
 * stored, so callers get a detached copy.
 */
export function codexProfileRegistration(): CodexProfileRegistration {
  return {
    profileId: 'codex-cli',
    revision: 1,
    executableLocator: { kind: 'PATH', name: 'codex' },
    versionRange: '*',
    supportedComponents: ['instruction', 'skill', 'tool-config', 'launch-config'],
    unsupportedComponents: ['subagent'],
    conditionalOnlyComponents: ['skill'],
    injectionRecipe: CODEX_INJECTION_RECIPE_ID,
    resumeRecipe: CODEX_RESUME_RECIPE,
    wakeRecipe: null,
    settingsPolicy: CODEX_SETTINGS_POLICY,
    admissionState: 'documented',
    provenance: {
      basis:
        'OpenAI Codex config reference (developer_instructions, -c override), ' +
        'CLI reference, and skills loading docs as cited by spec/injection.md §6 ' +
        '(retrieved 2026-09-18); installed-version behavior unverified pending VER-10',
      verifiedInstall: false
    }
  }
}
