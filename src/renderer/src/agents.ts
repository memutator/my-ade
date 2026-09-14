import type { AgentProviderInfo } from './types'

let manifest: Record<string, AgentProviderInfo> = {}

export async function loadAgentManifest(): Promise<Record<string, AgentProviderInfo>> {
  try {
    manifest = await window.ade.agents.manifest()
  } catch {
    manifest = {}
  }
  return manifest
}

export function agentProviders(): Record<string, AgentProviderInfo> {
  return manifest
}

export function agentLabel(id: string): string {
  return manifest[id]?.label ?? id
}

export function agentColor(id: string): string | undefined {
  return manifest[id]?.color
}

// `<cmd> <args…> '<sessionId>'` typed into the session's old shell — null for
// providers with no manifest resume spec (their sessions aren't offered).
export function resumeCommand(provider: string, sessionId: string): string | null {
  const spec = manifest[provider]?.resume
  if (!spec?.cmd) return null
  const q = `'${sessionId.replace(/'/g, `'\\''`)}'`
  return [spec.cmd, ...(spec.args ?? []), q].join(' ')
}

// one fetch per provider per session — the main side disk-caches the image
const iconCache = new Map<string, Promise<string | null>>()

export function agentIcon(id: string): Promise<string | null> {
  let p = iconCache.get(id)
  if (!p) {
    p = window.ade.agents.icon?.(id).catch(() => null) ?? Promise.resolve(null)
    iconCache.set(id, p)
  }
  return p
}
