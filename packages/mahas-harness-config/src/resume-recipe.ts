// Resume recipe helpers — deliberately free of node builtins so the renderer
// can import them (the Pack data loader itself reads the filesystem and is
// main/runtime-only).
//
// The Pack declares a resume recipe as `{executable, args[]}` with the session
// slot marked; the legacy manifest pair keeps the id appended by the caller.

/** Marker Pack data uses for the native session id argument. */
export const SESSION_SLOT = '$' + '{sessionId}'

/** Marker the hook-file installer uses for the event name. */
export const EVENT_SLOT = '$' + '{event}'

export interface HarnessResumeRecipe {
  /** the CLI that reopens a session, e.g. claude */
  executable: string
  /** args placed before the session id; SESSION_SLOT marks the slot */
  args?: string[]
}

export type { HarnessDescriptor } from '../../mahas-contracts/src/harness-descriptor.ts'

/**
 * `<executable> <args…> '<sessionId>'` for a shell. Accepts the Pack recipe and
 * the legacy manifest shape (`cmd`/`args` with the id appended); single-quote
 * escaping matches the previous renderer implementation byte for byte.
 */
export function resumeCommandText(
  recipe: { executable?: string; cmd?: string; args?: string[] } | undefined,
  sessionId: string
): string | null {
  const executable = recipe?.executable ?? recipe?.cmd
  if (!executable) return null
  const escaped = sessionId.split("'").join("'\\''")
  const quoted = "'" + escaped + "'"
  const declared = recipe?.args ?? []
  const hasSlot = declared.some((arg) => arg.includes(SESSION_SLOT))
  const args = declared.map((arg) => (arg.includes(SESSION_SLOT) ? quoted : arg))
  return [executable, ...args, ...(hasSlot ? [] : [quoted])].join(' ')
}
