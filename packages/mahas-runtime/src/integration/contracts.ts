// integration/contracts.ts — the canonical capability contracts.
//
// A Pack's manifest is authored by hand; the request/response schemas of a
// capability are not. They come from CAPABILITY_PAYLOAD_SCHEMAS in mahas-contracts,
// so a Pack cannot describe a shape the runtime would refuse, and a contract digest
// is derived from those schemas instead of being copied.
//
// A Pack revision MAY declare the contracts it was authored against
// (revision.conformanceContracts): contract id + revision, the digests it expects,
// and its conformance cases. validateContractDeclarations() is the check — a
// declaration that does not match the canonical contract is an error, never a
// silently accepted override.

import type {
  IntegrationCapability,
  IntegrationContract
} from '../../../mahas-contracts/src/integration/index.ts'
import { CAPABILITY_PAYLOAD_SCHEMAS } from '../../../mahas-contracts/src/integration/index.ts'
import { canonicalJson, sha256 } from './safety.ts'

export const CONTRACT_ID_PREFIX = 'mahas.integration.'
export const RUNNER_PROTOCOL = '1'
/** Contracts are versioned by revision; this is the publication stamp of revision 1. */
export const CONTRACT_PUBLISHED_AT = 1770000000000

/**
 * What each capability promises beyond its schema. The digest pins the wording so a
 * semantic change forces a contract revision instead of riding along unnoticed.
 */
const SEMANTICS: Record<IntegrationCapability, string> = {
  identify:
    'Report observed installations with their namespaces; absence is an observation, never a deletion.',
  launch:
    'Describe how a harness is started; the runtime owns the process, the Pack only supplies the recipe.',
  resume:
    'Describe how an existing native session is reopened; a missing session is reported, not invented.',
  wake: 'Describe how a dormant harness is woken; unsupported states are declared, not guessed.',
  events:
    'Return harness events with stable source record keys; the runtime owns checkpointing and notification policy.',
  sessions:
    'Return session/handle/attachment observations; completeness and deletions are declared per source.',
  usage:
    'Return measured usage with its counter scope, epoch and time coverage; unknown axes stay unknown.',
  bindings:
    'Report which connections a harness configuration refers to, with the config slot that proves it.',
  maintenance:
    'Propose maintenance actions and their effects; the runtime decides whether they are applicable.',
  auth: 'Drive provider sign-in and return a credential change with identity claims; material never leaves the secret store.',
  quota:
    'Probe a provider quota endpoint and return typed meters; a failed probe is an observation, not a zero.'
}

function build(capability: IntegrationCapability): IntegrationContract {
  const schemas = CAPABILITY_PAYLOAD_SCHEMAS[capability]
  return {
    id: CONTRACT_ID_PREFIX + capability,
    revision: 1,
    capability,
    requestSchema: schemas.request,
    responseSchema: schemas.response,
    schemaDigest: sha256(canonicalJson({ request: schemas.request, response: schemas.response })),
    semanticsDigest: sha256(canonicalJson({ capability, semantics: SEMANTICS[capability] })),
    compatibility: { minimumRunnerProtocol: RUNNER_PROTOCOL, backwardCompatibleWith: [] },
    conformanceCases: [],
    publishedAt: CONTRACT_PUBLISHED_AT
  }
}

export const BUILTIN_CONTRACTS: readonly IntegrationContract[] = (
  Object.keys(CAPABILITY_PAYLOAD_SCHEMAS) as IntegrationCapability[]
).map(build)

export function resolveBuiltinContract(id: string, revision: number): IntegrationContract | null {
  return (
    BUILTIN_CONTRACTS.find((contract) => contract.id === id && contract.revision === revision) ??
    null
  )
}

export function contractForCapability(capability: IntegrationCapability): IntegrationContract {
  const contract = BUILTIN_CONTRACTS.find((candidate) => candidate.capability === capability)
  if (!contract) throw new Error('no canonical contract for capability ' + capability)
  return contract
}

/** One contract declaration inside a Pack manifest revision. */
export interface ManifestContractDeclaration {
  contract: { id: string; revision: number }
  capability: string
  schemaDigest?: string
  semanticsDigest?: string
  conformanceCases?: readonly {
    id: string
    fixtureRef: string
    expected: 'accept' | 'reject'
    description: string
  }[]
}

export interface ContractDeclarationIssue {
  code: string
  declaration: string
  message: string
}

function declarationsOf(revision: unknown): ManifestContractDeclaration[] {
  if (!revision || typeof revision !== 'object') return []
  const raw = (revision as Record<string, unknown>).conformanceContracts
  return Array.isArray(raw) ? (raw as ManifestContractDeclaration[]) : []
}

/**
 * Compare a Pack revision's declared contracts with the canonical ones. Declared
 * digests are required to match: a stale digest means the Pack was authored against
 * a contract the runtime no longer implements.
 */
export function validateContractDeclarations(revision: unknown): ContractDeclarationIssue[] {
  const issues: ContractDeclarationIssue[] = []
  for (const declaration of declarationsOf(revision)) {
    const label =
      String(declaration?.contract?.id ?? 'unknown') +
      '@' +
      String(declaration?.contract?.revision ?? '?')
    const contract = declaration?.contract
      ? resolveBuiltinContract(declaration.contract.id, declaration.contract.revision)
      : null
    if (!contract) {
      issues.push({
        code: 'contract.unknown',
        declaration: label,
        message: 'no canonical contract matches this declaration'
      })
      continue
    }
    if (declaration.capability !== contract.capability) {
      issues.push({
        code: 'contract.capability-mismatch',
        declaration: label,
        message:
          'declared capability ' +
          String(declaration.capability) +
          ' but the contract is ' +
          contract.capability
      })
    }
    if (declaration.schemaDigest !== contract.schemaDigest) {
      issues.push({
        code: 'contract.schema-digest',
        declaration: label,
        message: 'declared schemaDigest does not match the canonical schema digest'
      })
    }
    if (declaration.semanticsDigest !== contract.semanticsDigest) {
      issues.push({
        code: 'contract.semantics-digest',
        declaration: label,
        message: 'declared semanticsDigest does not match the canonical semantics digest'
      })
    }
  }
  return issues
}

/** The contract a Pack's conformance cases belong to, declaration included. */
export function declaredConformanceCases(revision: unknown): readonly {
  contract: IntegrationContract
  cases: ManifestContractDeclaration['conformanceCases']
}[] {
  const out: {
    contract: IntegrationContract
    cases: ManifestContractDeclaration['conformanceCases']
  }[] = []
  for (const declaration of declarationsOf(revision)) {
    if (!declaration?.contract) continue
    const contract = resolveBuiltinContract(declaration.contract.id, declaration.contract.revision)
    if (contract) out.push({ contract, cases: declaration.conformanceCases ?? [] })
  }
  return out
}

// ── registry facade — the stable consumer API ───────────────────────────────
//
// Everything below is a thin layer over BUILTIN_CONTRACTS / resolveBuiltinContract
// (one source of truth: the canonical schemas and their digests). It exists
// because consumers — the integration operations, the conformance entry points
// and the composition root — need a resolver OBJECT plus the accepted id
// spellings, not just a lookup function:
//
//   const contracts = createCanonicalContractRegistry()
//   registerIntegrationOperations(ops, { packs, resolveContract: contracts.resolve })

/** the only canonical contract revision published so far */
export const CANONICAL_CONTRACT_REVISION = 1
/** canonical id namespace (same value as CONTRACT_ID_PREFIX) */
export const CANONICAL_CONTRACT_NAMESPACE = 'mahas.integration'

/** canonical contract id for one capability: `mahas.integration.<capability>` */
export function canonicalContractId(capability: IntegrationCapability): string {
  return CONTRACT_ID_PREFIX + capability
}

/**
 * The spelling some early Pack manifests use for the same contract
 * (`integration.<capability>`, no publisher prefix). Accepted so those
 * revisions still resolve; new Packs must spell the canonical id.
 */
export function legacyContractId(capability: IntegrationCapability): string {
  return 'integration.' + capability
}

/** every resolvable contract id: canonical and legacy spellings, then extras */
export function canonicalContractIds(): readonly string[] {
  return (Object.keys(CAPABILITY_PAYLOAD_SCHEMAS) as IntegrationCapability[]).flatMap(
    (capability) => [canonicalContractId(capability), legacyContractId(capability)]
  )
}

export interface CanonicalContractRegistryOptions {
  /** contract revision to publish (defaults to the canonical revision 1) */
  revision?: number
  /**
   * Pack-relative conformance cases per capability (fixtureRef resolves inside
   * the Pack's snapshot). Empty by default: schema compatibility is checkable
   * without fixtures, semantics is not.
   */
  conformanceCases?: Partial<
    Record<IntegrationCapability, readonly IntegrationContract['conformanceCases'][number][]>
  >
  /** contracts layered on top (a Pack's declared contracts, experiments) */
  extraContracts?: readonly IntegrationContract[]
  publishedAt?: number
}

export interface CanonicalContractRegistry {
  /** every contract this registry resolves */
  contracts: readonly IntegrationContract[]
  /** every resolvable id, canonical and accepted legacy spellings */
  ids: readonly string[]
  resolve(id: string, revision: number): IntegrationContract | null
  list(): readonly IntegrationContract[]
}

/**
 * Build the resolver the integration operations and the conformance entry
 * points use. `resolve` accepts every id spelling a Pack manifest may declare
 * and returns the contract under the REFERENCED id, so an implementation's
 * declared contract still compares equal to the contract it names while the
 * schemas and digests stay canonical.
 *
 * Returns null (instead of throwing) for an unknown id or revision — the
 * caller decides whether that is a payload, availability or authorization
 * failure.
 */
export function createCanonicalContractRegistry(
  options: CanonicalContractRegistryOptions = {}
): CanonicalContractRegistry {
  const revision = options.revision ?? CANONICAL_CONTRACT_REVISION
  const byId = new Map<string, IntegrationContract>()
  const withOverrides = (contract: IntegrationContract, id: string): IntegrationContract => {
    const cases = options.conformanceCases?.[contract.capability]
    const publishedAt = options.publishedAt
    const next: IntegrationContract = {
      ...contract,
      id,
      ...(cases ? { conformanceCases: cases } : {}),
      ...(publishedAt === undefined ? {} : { publishedAt })
    }
    return next
  }
  for (const contract of BUILTIN_CONTRACTS) {
    if (contract.revision !== revision) continue
    byId.set(contract.id, withOverrides(contract, contract.id))
    const legacy = legacyContractId(contract.capability)
    byId.set(legacy, withOverrides(contract, legacy))
  }
  for (const extra of options.extraContracts ?? []) byId.set(extra.id, extra)
  const contracts = [...byId.values()]
  return {
    contracts,
    ids: [...byId.keys()],
    resolve: (id, requested) => (requested === revision ? (byId.get(id) ?? null) : null),
    list: () => contracts
  }
}

/** resolve one contract without holding a registry (canonical revision) */
export function resolveCanonicalContract(
  id: string,
  revision: number,
  options: CanonicalContractRegistryOptions = {}
): IntegrationContract | null {
  return createCanonicalContractRegistry(options).resolve(id, revision)
}
