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
