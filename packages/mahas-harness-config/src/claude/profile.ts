// claude/profile.ts — the publishable claude-code harness profile revision.
//
// C-REALIZATION `harness.profile.register` takes {executableLocator,
// versionRange, supportedComponents, injectionRecipe, resumeRecipe?,
// wakeRecipe?, settingsPolicy} — this file composes exactly that draft for
// the file-based Claude Code profile. State is 'documented': the recipe is
// implemented from the vendor's published CLI docs (S-INJECTION §5 cites
// 2026-09-18); verified activation on a real installed version is a
// VER-09 SupportAttestation + harness.profile.admit decision, not a flag
// this file may set itself (IMP-24 §4.5, C-LAUNCH §"제한된 launch").

import { statSync } from 'node:fs'
import type { MahasError } from '../../../mahas-contracts/src/index.ts'
import type { ComponentKind } from './components.ts'
import { CLAUDE_LAYOUT, COMPONENT_KINDS } from './components.ts'
import type { ClaudePermissionMode } from './recipe.ts'
import { MAX_ARG_STRLEN_BYTES, MAX_ARGV_TOTAL_BYTES, MAHAS_ENV } from './recipe.ts'

/* ------------------------------------------------------------ profile id */

export const CLAUDE_PROFILE_ID = 'claude-code'
export const CLAUDE_PROFILE_REVISION = 1

/** profile lifecycle states — only 'documented' is settable at registration */
export type HarnessProfileState = 'documented' | 'verified' | 'disabled'

/* ------------------------------------------------- registration payload */

/**
 * The register-operation input shape. Every field is plain JSON so the
 * service can store it as recipe_json/capabilities_json/
 * executable_identity_json without transformation.
 */
export interface HarnessProfileDraft {
  profileId: string
  revision: number
  state: HarnessProfileState
  /** how the service/host finds the binary — probe is an inspect-time effect */
  executableLocator: {
    commands: string[]
    /** env override honoured before PATH search */
    envOverride: string
    versionFlag: string[]
  }
  versionRange: {
    constraint: string
    /** what the range claim rests on — 'docs', never an executed test */
    basis: 'docs'
    sources: string[]
  }
  /** component-kind → the routes this profile can lower it to */
  supportedComponents: Record<ComponentKind, { routes: string[]; notes?: string }>
  injectionRecipe: {
    kind: 'file-based'
    /** argv slot order as buildClaudeArgv emits them */
    argvOrder: string[]
    firstInput: { method: 'argv-positional-prompt'; position: 'last' }
    stdio: 'pty' | 'pipes'
    envExports: string[]
    pathPrepend: string[]
    limits: { maxArgStrlenBytes: number; maxArgvTotalBytes: number }
    executionLayout: Record<string, string>
  }
  resumeRecipe?: {
    argv: string[]
    constraints: string[]
  }
  wakeRecipe?: {
    route: 'terminal-input'
    automatic: false
    notes: string
  }
  settingsPolicy: {
    executionSettingsFlag: string
    executionSettingsPath: string
    inheritedRecordedAs: string
    neverWrites: string
    forbiddenSettingsKeys: readonly string[]
    forbiddenEnvPattern: string
  }
  /** process-detection block, same shape as resources/agents/manifest.json */
  detection: {
    match: string[]
    label: string
    domain: string
    color: string
    resume: { cmd: string; args: string[] }
  }
  provenance: {
    implementedBy: string
    specBasis: string
    checkedAt: string
    honesty: string
  }
}

const PERMISSION_MODES: readonly ClaudePermissionMode[] = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'dontAsk',
  'manual',
  'plan'
]

/**
 * The documented-state claude-code profile draft. Deterministic — same
 * call, same object — so a registration receipt's fingerprint is stable.
 */
export function claudeProfileDraft(): HarnessProfileDraft {
  return {
    profileId: CLAUDE_PROFILE_ID,
    revision: CLAUDE_PROFILE_REVISION,
    state: 'documented',

    executableLocator: {
      commands: ['claude'],
      envOverride: 'MAHAS_CLAUDE_EXECUTABLE',
      versionFlag: ['--version']
    },

    versionRange: {
      constraint: '>=2.0.0',
      basis: 'docs',
      sources: [
        'https://code.claude.com/docs/en/cli-reference',
        'https://code.claude.com/docs/en/sub-agents',
        'spec/injection.md §5 (feature basis cited 2026-09-18)'
      ]
    },

    supportedComponents: {
      instruction: {
        routes: ['instruction-file'],
        notes:
          '--append-system-prompt-file carries the whole mandatory.md; exactly one instruction component per implementation'
      },
      skill: {
        routes: ['inline', 'preload', 'catalog'],
        notes:
          'required ⇒ inline (mandatory.md) or preload (primary agent skills: list + plugin file); catalog is optional-only, discovery is never initial delivery'
      },
      subagent: {
        routes: ['plugin-agent', 'primary-agent'],
        notes:
          'plugin agents/<name>.md; agentRole=primary adds --agent and is the confirmed skill-preload carrier. Native helpers are never separate mahas Members'
      },
      'tool-config': {
        routes: ['mcp-config', 'settings-file', 'argv-flags'],
        notes:
          'scoped mcp.json via --mcp-config (+--strict-mcp-config); permissions/settings merged into the execution --settings file; tool lists via --allowedTools/--disallowedTools'
      },
      'launch-config': {
        routes: ['argv'],
        notes: 'model/sessionId/permissionMode/addDirs/stdio/env merge into the single launch argv'
      }
    },

    injectionRecipe: {
      kind: 'file-based',
      argvOrder: [
        '--append-system-prompt-file <role/mandatory.md>',
        '--plugin-dir <role/components/claude-plugin>?',
        '--mcp-config <role/components/mcp.json> + --strict-mcp-config?',
        '--settings <role/components/claude-settings.json>?',
        '--agent <primary>?',
        '--session-id <uuid>?',
        '--model <model>?',
        '--permission-mode <mode>?',
        '--add-dir <dirs…>?',
        '--allowedTools <tools…>?',
        '--disallowedTools <tools…>?',
        '<extraArgs…>?',
        '<initial.txt body>  ← first input, trailing positional'
      ],
      firstInput: { method: 'argv-positional-prompt', position: 'last' },
      stdio: 'pty',
      envExports: [
        MAHAS_ENV.executionRoot,
        MAHAS_ENV.binDir,
        MAHAS_ENV.profile,
        MAHAS_ENV.bundleDigest,
        MAHAS_ENV.surfaceDigest,
        MAHAS_ENV.envelopeDigest
      ],
      pathPrepend: ['<execution-root>/bin'],
      limits: {
        maxArgStrlenBytes: MAX_ARG_STRLEN_BYTES,
        maxArgvTotalBytes: MAX_ARGV_TOTAL_BYTES
      },
      executionLayout: { ...CLAUDE_LAYOUT }
    },

    resumeRecipe: {
      argv: ['claude', '--resume', '<nativeSessionId>', '<prompt>?'],
      constraints: [
        'same cwd (native sessions live under the project dir of their cwd)',
        'same bundle/interface/role — changed mandatory instructions ⇒ fresh conversation',
        'same component route flags re-passed verbatim',
        'verified route only — docs-based recipe needs VER-09 attestation before work purpose'
      ]
    },

    wakeRecipe: {
      route: 'terminal-input',
      automatic: false,
      notes:
        'idle TUI cannot be poked programmatically — execution.wake delivers an attention pointer via host.terminal.input; undelivered inbox stays durable for manual resume'
    },

    settingsPolicy: {
      executionSettingsFlag: '--settings',
      executionSettingsPath: CLAUDE_LAYOUT.settings,
      inheritedRecordedAs:
        'EffectiveContextReceipt.inherited — user/project/managed auto-load paths are probed and shown, never silently removed',
      neverWrites:
        '~/.claude/**, <checkout>/.claude/**, managed-settings.json — every planned file resolves under the execution root (assertExecutionScoped)',
      forbiddenSettingsKeys: [
        'hooks',
        'apiKeyHelper',
        'awsCredentialExport',
        'awsAuthRefresh',
        'forceLoginMethod',
        'forceLoginOrgUUID'
      ],
      forbiddenEnvPattern:
        '(_API_KEY|_AUTH_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS|API_KEY_HELPER|^ANTHROPIC_|^CLAUDE_CODE_OAUTH)'
    },

    detection: {
      // identical to resources/agents/manifest.json — one source of truth
      match: ['claude'],
      label: 'Claude',
      domain: 'claude.ai',
      color: '#D97757',
      resume: { cmd: 'claude', args: ['--resume'] }
    },

    provenance: {
      implementedBy: 'IMP-24',
      specBasis: 'S-INJECTION §5 (file-based instruction + native components)',
      checkedAt: '2026-09-18',
      honesty:
        'documented recipe from public CLI docs — no installed-version execution test; activation requires SupportAttestation + admit'
    }
  }
}

/* ------------------------------------------------- executable resolution */

export interface ExecutableResolution {
  path?: string
  source?: 'env-override' | 'absolute' | 'path-search'
  error?: MahasError
}

/**
 * Resolve the claude binary without executing it: env override → absolute
 * path → PATH search (exists + executable bit). Version probing is an
 * inspect-time effect owned by harness.profile.inspect — not done here.
 */
export function resolveClaudeExecutable(
  opts: {
    env?: Record<string, string | undefined>
    explicitPath?: string
  } = {}
): ExecutableResolution {
  const env = opts.env ?? (process.env as Record<string, string | undefined>)

  const check = (p: string): boolean => {
    try {
      const st = statSync(p)
      return st.isFile() && (st.mode & 0o111) !== 0
    } catch {
      return false
    }
  }

  const override = env[claudeProfileDraft().executableLocator.envOverride]
  if (override) {
    return check(override)
      ? { path: override, source: 'env-override' }
      : {
          error: {
            code: 'INPUT_NOT_READY',
            message: `MAHAS_CLAUDE_EXECUTABLE=${override} is not an executable file`,
            retry: 'none'
          }
        }
  }
  if (opts.explicitPath) {
    return check(opts.explicitPath)
      ? { path: opts.explicitPath, source: 'absolute' }
      : {
          error: {
            code: 'INPUT_NOT_READY',
            message: `claude executable not found/executable at ${opts.explicitPath}`,
            retry: 'none'
          }
        }
  }
  const pathEnv = env.PATH ?? ''
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue
    const candidate = `${dir}/claude`
    if (check(candidate)) return { path: candidate, source: 'path-search' }
  }
  return {
    error: {
      code: 'INPUT_NOT_READY',
      message: 'claude executable not found on PATH',
      retry: 'none'
    }
  }
}

/** advertised component kinds — parity check for register consumers */
export const SUPPORTED_COMPONENT_KINDS: readonly ComponentKind[] = COMPONENT_KINDS

/** permission-mode values accepted by --permission-mode */
export const CLAUDE_PERMISSION_MODES: readonly string[] = PERMISSION_MODES
