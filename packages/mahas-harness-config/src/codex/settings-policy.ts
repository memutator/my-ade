// codex/settings-policy.ts — the settingsPolicy for the codex profile.
//
// Registered verbatim inside the HarnessProfile revision (C-REALIZATION
// `harness.profile.register` input). It states what mahas may and may not do
// to the harness's configuration surface, and gives the recipe its guard
// functions. Two load-bearing rules (instruction §4.4, spec §6):
//
//   1. Existing account/org settings are never reinitialized. CODEX_HOME is
//      not relocated, `~/.codex/{config.toml,auth.json,AGENTS.md}` are never
//      written, and the user's existing org/repo instructions stay loaded —
//      they are disclosed on the EffectiveContextReceipt, not removed.
//   2. Secrets never travel in config bodies, argv or env. The scoped CLI
//      access port exposes a launcher path + PATH prepend; the private
//      credential lives in connection/worker, outside the model input.
//
// admissionState stays 'documented' until VER-10 performs the real install
// verification — this policy describes intent, not verified behavior.

import { codexErr, codexOk } from './components.ts'
import type { CodexResult } from './components.ts'

// ---------------------------------------------------------------------------
// -c override whitelist — only developer_instructions may be set per launch.
// ---------------------------------------------------------------------------

/**
 * Config keys this profile will emit through `-c`. Baseline: exactly one.
 * The guard below is whitelist-based — everything not listed is refused —
 * and `forbiddenOverrides` documents the tempting-but-refused keys:
 *  - model_instructions_file REPLACES the base instructions; conflating it
 *    with developer_instructions (which appends) silently drops Codex's own
 *    system guidance (spec §6 warning).
 *  - credential-shaped keys never belong in argv even if codex accepted them.
 */
export const CODEX_ALLOWED_OVERRIDES: readonly string[] = ['developer_instructions']

export const CODEX_FORBIDDEN_OVERRIDES: readonly string[] = [
  'model_instructions_file', // base-instruction replacement — not an append
  'api_key',
  'openai_api_key',
  'model_provider', // provider swap changes account/billing surface
  'preferred_auth_method',
  'experimental_resume' // unvalidated file route — not a launch input path
]

/** is `key` permitted as a `-c key=value` override under this policy? */
export function isCodexOverrideAllowed(key: string): boolean {
  return CODEX_ALLOWED_OVERRIDES.includes(key)
}

// ---------------------------------------------------------------------------
// env guardrail — additive env vars the recipe will stamp on the ProcessSpec.
// ---------------------------------------------------------------------------

/**
 * Denylist for caller-supplied env keys. Belt-and-suspenders: secrets must
 * never be pushed into a worker's env by config code (D-ACCESS: "secret은
 * context/argv/log에 넣지 않음"), CODEX_HOME relocation is forbidden by the
 * preserve policy, and loader-hijack vars are never a launch input.
 */
const ENV_DENY_PATTERN =
  /(?:^|_)(API_?KEY|KEY|TOKEN|SECRET|PASS(?:WORD|PHRASE)?|CREDENTIALS?|COOKIE)(?:_|$)/i

const ENV_DENY_EXACT: readonly string[] = [
  'CODEX_HOME', // relocating the config home forfeits account/org settings
  'HOME', // same class of silent environment swap
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'PATH' // PATH additions go through envPrepend, never a blind overwrite
]

export function isCodexEnvKeyAllowed(key: string): boolean {
  if (ENV_DENY_EXACT.includes(key.toUpperCase())) return false
  return !ENV_DENY_PATTERN.test(key)
}

/** validate a caller-supplied additive env map against the guardrail */
export function checkCodexEnv(env: Record<string, string>): CodexResult<true> {
  for (const [key, value] of Object.entries(env)) {
    if (!isCodexEnvKeyAllowed(key)) {
      return codexErr(
        'INJECTION_UNSUPPORTED',
        `env var '${key}' refused by codex settings policy ` +
          `(secret-shaped name, config-home relocation, or loader hijack)`,
        { reason: 'env-key-denied', envKey: key }
      )
    }
    if (value.includes('\u0000')) {
      return codexErr('INJECTION_UNSUPPORTED', `NUL byte in env var '${key}'`, {
        reason: 'nul-byte',
        envKey: key
      })
    }
  }
  return codexOk(true)
}

// ---------------------------------------------------------------------------
// the registered policy object
// ---------------------------------------------------------------------------

export const CODEX_SETTINGS_POLICY = {
  /**
   * Existing account/org settings are preserved: CODEX_HOME is never
   * relocated, `~/.codex/config.toml` / `auth.json` / `AGENTS.md` are never
   * written by mahas, and no user/org/repo instruction source is removed.
   */
  configHome: 'preserve-existing',

  /**
   * All mahas configuration arrives as per-launch `-c` argv overrides —
   * nothing is persisted into the user's codex config. Reversing that (a
   * config.toml write path) is a different profile revision, not a flag.
   */
  persistentMutation: 'none',

  /** `-c` keys this profile may emit — see whitelist above */
  allowedOverrides: CODEX_ALLOWED_OVERRIDES,
  forbiddenOverrides: CODEX_FORBIDDEN_OVERRIDES,

  /**
   * Optional skill catalog: installed only inside the execution-dedicated
   * checkout; a pre-existing file at the target fails the materialization
   * rather than being overwritten (spec §3).
   */
  skillInstall: {
    root: '.agents/skills',
    scope: 'execution-checkout',
    onConflict: 'fail'
  },

  /**
   * Instruction sources codex auto-loads OUTSIDE mahas control. These are
   * disclosed on the EffectiveContextReceipt so a reviewer can tell bundle
   * bytes from inherited environment text (spec §6: "repo/user/admin의 기존
   * 자동 로딩 경로도 EffectiveContextReceipt에 표시한다"). Listing here is
   * disclosure, not endorsement — the runtime marks them inherited/unknown.
   */
  autoLoadDisclosure: [
    'AGENTS.md files discovered from the checkout root upward (repo/project instructions)',
    '~/.codex/AGENTS.md (user-level instructions)',
    '$CODEX_HOME/config.toml or ~/.codex/config.toml (user/admin/org config)',
    '~/.agents/skills (user-level skill catalog, when the installed version supports it)'
  ],

  /**
   * How the harness shell reaches the scoped mahas CLI: the launcher's bin
   * dir is prepended to PATH and MAHAS_CLI points at the scoped wrapper
   * (execution-root bin/mahas). The private credential/endpoint lives in
   * connection/worker — a file the wrapper reads internally — so secrets
   * never appear in argv, env, or any model-visible body.
   */
  cliAccessPort: {
    cliPathEnv: 'MAHAS_CLI',
    pathPrepend: true,
    secretPolicy: 'credential-file-outside-model-input'
  },

  /** stays 'documented' until VER-10 verifies a real install (instruction §4.5) */
  admissionState: 'documented'
} as const

export type CodexSettingsPolicy = typeof CODEX_SETTINGS_POLICY
