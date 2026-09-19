import type { DatabaseSync } from 'node:sqlite'
import type { JsonObject } from '../../../mahas-contracts/src/common.ts'

interface SeedOrganization {
  id: string
  name: string
}

interface SeedHarness {
  id: string
  label: string
  publisherOrganizationId?: string
  metadata: JsonObject
}

interface SeedProvider {
  id: string
  offeringId: string
  label: string
  realm: string
  operatorOrganizationId?: string
  evidence: string
}

/**
 * Built-ins are limited to subjects demonstrated by the checked-in manifest
 * and usage probes. Harness/provider rows remain independent: matching keys
 * do not assert that a harness used an account or produced usage.
 */
export const BUILTIN_ORGANIZATIONS: readonly SeedOrganization[] = [
  { id: 'org.anthropic', name: 'Anthropic' },
  { id: 'org.cline', name: 'Cline' },
  { id: 'org.cognition', name: 'Cognition' },
  { id: 'org.github', name: 'GitHub' },
  { id: 'org.google', name: 'Google' },
  { id: 'org.openai', name: 'OpenAI' },
  { id: 'org.opencode', name: 'OpenCode' },
  { id: 'org.xai', name: 'xAI' },
  { id: 'org.zai', name: 'Z.ai' }
]

export const BUILTIN_HARNESSES: readonly SeedHarness[] = [
  {
    id: 'claude',
    label: 'Claude',
    publisherOrganizationId: 'org.anthropic',
    metadata: { domain: 'claude.ai', color: '#D97757', match: ['claude'] }
  },
  {
    id: 'codex',
    label: 'Codex',
    publisherOrganizationId: 'org.openai',
    metadata: { domain: 'openai.com', color: '#10A37F', match: ['codex'] }
  },
  {
    id: 'gemini',
    label: 'Gemini',
    publisherOrganizationId: 'org.google',
    metadata: { domain: 'gemini.google.com', color: '#1B72E8', match: ['gemini'] }
  },
  {
    id: 'grok',
    label: 'Grok',
    publisherOrganizationId: 'org.xai',
    metadata: { domain: 'grok.com', color: '#8B8B8B', match: ['grok'] }
  },
  {
    id: 'devin',
    label: 'Devin',
    publisherOrganizationId: 'org.cognition',
    metadata: { domain: 'devin.ai', color: '#7C7CFF', match: ['devin'] }
  },
  {
    id: 'zcode',
    label: 'ZCode',
    publisherOrganizationId: 'org.zai',
    metadata: { domain: 'z.ai', color: '#084CCF', match: ['zcode'] }
  },
  {
    id: 'cursor',
    label: 'Cursor',
    metadata: { domain: 'cursor.com', color: '#9A9A9A', match: ['cursor-agent', 'cursor'] }
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    publisherOrganizationId: 'org.github',
    metadata: { domain: 'github.com', color: '#9678E0', match: ['copilot', 'gh copilot'] }
  },
  {
    id: 'aider',
    label: 'Aider',
    metadata: { domain: 'aider.chat', color: '#65B741', match: ['aider'] }
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    publisherOrganizationId: 'org.opencode',
    metadata: { domain: 'opencode.ai', color: '#E5C07B', match: ['opencode'] }
  },
  {
    id: 'amp',
    label: 'Amp',
    metadata: { domain: 'ampcode.com', color: '#FF5543', match: ['amp'] }
  },
  {
    id: 'cline',
    label: 'Cline',
    publisherOrganizationId: 'org.cline',
    metadata: { domain: 'cline.bot', color: '#7C3AED', match: ['cline'] }
  },
  {
    id: 'fake',
    label: 'Fake',
    metadata: { color: '#8A8A8A', match: ['mahas-fake'], testOnly: true }
  }
]

export const BUILTIN_PROVIDERS: readonly SeedProvider[] = [
  {
    id: 'anthropic',
    offeringId: 'anthropic/claude',
    label: 'Claude account',
    realm: 'claude.ai',
    operatorOrganizationId: 'org.anthropic',
    evidence: 'src/main/usage.ts api.anthropic.com quota probe'
  },
  {
    id: 'openai',
    offeringId: 'openai/chatgpt',
    label: 'ChatGPT account',
    realm: 'chatgpt.com',
    operatorOrganizationId: 'org.openai',
    evidence: 'src/main/usage.ts chatgpt.com backend quota probe'
  },
  {
    id: 'google-cloud-code',
    offeringId: 'google/cloud-code',
    label: 'Google Cloud Code account',
    realm: 'cloudcode-pa.googleapis.com',
    operatorOrganizationId: 'org.google',
    evidence: 'src/main/usage.ts Cloud Code quota probe'
  },
  {
    id: 'github',
    offeringId: 'github/copilot',
    label: 'GitHub Copilot account',
    realm: 'github.com/copilot',
    operatorOrganizationId: 'org.github',
    evidence: 'src/main/usage.ts GitHub Copilot quota probe'
  },
  {
    id: 'xai',
    offeringId: 'xai/grok',
    label: 'Grok account',
    realm: 'grok.com',
    operatorOrganizationId: 'org.xai',
    evidence: 'src/main/usage.ts Grok billing probe'
  },
  {
    id: 'zai',
    offeringId: 'zai/coding-plan',
    label: 'Z.ai coding account',
    realm: 'api.z.ai',
    operatorOrganizationId: 'org.zai',
    evidence: 'src/main/usage.ts Z.ai coding quota probe'
  },
  {
    id: 'opencode',
    offeringId: 'opencode/go',
    label: 'OpenCode Zen account',
    realm: 'opencode.ai/zen',
    operatorOrganizationId: 'org.opencode',
    evidence: 'src/main/usage.ts OpenCode Zen usage probe'
  },
  {
    id: 'windsurf',
    offeringId: 'windsurf/account',
    label: 'Windsurf account',
    realm: 'server.codeium.com',
    evidence: 'src/main/usage.ts GetUserStatus probe'
  },
  {
    id: 'cline',
    offeringId: 'cline/account',
    label: 'Cline account',
    realm: 'api.cline.bot',
    operatorOrganizationId: 'org.cline',
    evidence: 'src/main/usage.ts Cline account probe'
  }
]

/** Canonical provider-to-product identities shared by auth and migration adapters. */
export const BUILTIN_PROVIDER_OFFERING_IDS = {
  anthropic: 'anthropic/claude',
  openai: 'openai/chatgpt',
  'google-cloud-code': 'google/cloud-code',
  github: 'github/copilot',
  xai: 'xai/grok',
  zai: 'zai/coding-plan',
  opencode: 'opencode/go',
  windsurf: 'windsurf/account',
  cline: 'cline/account'
} as const satisfies Readonly<Record<(typeof BUILTIN_PROVIDERS)[number]['id'], string>>

export function seedBuiltinCatalog(db: DatabaseSync): void {
  const organization = db.prepare(
    'INSERT INTO catalog_organizations(id,name,metadata_json,revision) VALUES(?,?,?,1) ON CONFLICT(id) DO NOTHING'
  )
  for (const value of BUILTIN_ORGANIZATIONS) {
    organization.run(value.id, value.name, JSON.stringify({ source: 'mahas-builtin' }))
  }

  const harness = db.prepare(
    'INSERT INTO catalog_harnesses(id,publisher_organization_id,label,identity_metadata_json,revision) VALUES(?,?,?,?,1) ON CONFLICT(id) DO NOTHING'
  )
  for (const value of BUILTIN_HARNESSES) {
    harness.run(
      value.id,
      value.publisherOrganizationId ?? null,
      value.label,
      JSON.stringify({ ...value.metadata, source: 'resources/agents/manifest.json' })
    )
  }

  const provider = db.prepare(
    'INSERT INTO catalog_providers(id,operator_organization_id,label,realm,metadata_json,revision) VALUES(?,?,?,?,?,1) ON CONFLICT(id) DO NOTHING'
  )
  const offering = db.prepare(
    'INSERT INTO catalog_offerings(id,provider_id,offering_key,label,metadata_json,revision) VALUES(?,?,?,?,?,1) ON CONFLICT(id) DO NOTHING'
  )
  for (const value of BUILTIN_PROVIDERS) {
    provider.run(
      value.id,
      value.operatorOrganizationId ?? null,
      value.label,
      value.realm,
      JSON.stringify({ source: value.evidence })
    )
    // The current probes expose one product per demonstrated service realm.
    // This relation says nothing about which harness consumed it.
    offering.run(
      value.offeringId,
      value.id,
      'default',
      value.label.replace(/ account$/, ''),
      JSON.stringify({ source: value.evidence })
    )
  }
}
