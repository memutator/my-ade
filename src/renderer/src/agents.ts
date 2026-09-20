import type { AgentProviderInfo, HarnessDescriptor } from './types'

// Harness descriptors come from the builtin.harness-runtime Pack (projected to
// resources/agents/manifest.json, which the main process reads). The Pack's
// recipe uses a session slot; the legacy cmd/args pair stays readable so an
// older manifest keeps working.
//
// The renderer formats the resume command from the descriptor it is handed: the
// boundary keeps UI code off the control-plane packages, so the mirror of this
// function lives in packages/mahas-harness-config (resumeCommandText) and the
// Pack fixture asserts the projected descriptor carries the same session slot.

type AgentDescriptor = HarnessDescriptor
type AgentRecipe = NonNullable<HarnessDescriptor['recipe']>

let manifest: Record<string, AgentDescriptor> = {}

export async function loadAgentManifest(): Promise<Record<string, AgentProviderInfo>> {
  try {
    manifest = (await window.mahas.agents.manifest()) as Record<string, AgentDescriptor>
  } catch {
    manifest = {}
  }
  return manifest
}

export function agentProviders(): Record<string, AgentDescriptor> {
  return manifest
}

export function agentLabel(id: string): string {
  return manifest[id]?.label ?? id
}

export function agentColor(id: string): string | undefined {
  return manifest[id]?.color
}

/** The Pack's resume recipe for a harness, falling back to the legacy pair. */
export function agentResumeRecipe(id: string): AgentRecipe | undefined {
  const entry = manifest[id]
  if (!entry) return undefined
  if (entry.recipe?.executable) return entry.recipe
  const legacy = entry.resume
  return legacy?.cmd ? { executable: legacy.cmd, args: legacy.args ?? [] } : undefined
}

// `<executable> <args…> '<sessionId>'` typed into the session's old shell — null
// for providers with no resume recipe (their sessions aren't offered).
export function resumeCommand(provider: string, sessionId: string): string | null {
  const recipe = agentResumeRecipe(provider)
  if (!recipe?.executable) return null
  const escaped = sessionId.split("'").join("'\\''")
  const quoted = "'" + escaped + "'"
  const slot = '$' + '{sessionId}'
  const declared = recipe.args ?? []
  const hasSlot = declared.some((arg) => arg.includes(slot))
  const args = declared.map((arg) => (arg.includes(slot) ? quoted : arg))
  return [recipe.executable, ...args, ...(hasSlot ? [] : [quoted])].join(' ')
}

// one fetch per provider per session — the main side disk-caches the image
const iconCache = new Map<string, Promise<string | null>>()

export function agentIcon(id: string): Promise<string | null> {
  let p = iconCache.get(id)
  if (!p) {
    p = window.mahas.agents.icon?.(id).catch(() => null) ?? Promise.resolve(null)
    iconCache.set(id, p)
  }
  return p
}
