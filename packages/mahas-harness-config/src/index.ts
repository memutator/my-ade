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
