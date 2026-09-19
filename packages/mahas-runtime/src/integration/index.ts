import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { PackRegistryError, PackRegistry } from './registry.ts'
import type { RegisteredPackRevision } from './types.ts'

/**
 * Directories under `packsRoot` that hold a manifest.json, deepest-first
 * ordered by path. A directory WITH a manifest is a Pack root and is not
 * descended into (its subdirectories — hooks/, fixtures/, … — are Pack content,
 * not packs). Nested packs therefore need their own directory, e.g.
 * `providers/builtin-offerings`.
 *
 * The walk refuses symbolic links: a Pack snapshot must be reproducible from
 * real files, and a symlinked subtree would let the hashed content change
 * without the digest noticing (registerDirectory rejects them inside a Pack
 * for the same reason).
 */
export function discoverPackRoots(packsRoot: string): string[] {
  const root = resolve(packsRoot)
  const found: string[] = []
  const walk = (directory: string): void => {
    if (hasManifest(directory)) {
      found.push(directory)
      return
    }
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new PackRegistryError(
          'INVALID_MANIFEST',
          `Pack discovery does not follow symbolic links: ${relative(root, path)}`
        )
      }
      if (entry.isDirectory()) walk(path)
    }
  }
  walk(root)
  return found
}

function hasManifest(directory: string): boolean {
  try {
    return statSync(join(directory, 'manifest.json')).isFile()
  } catch {
    return false
  }
}

/**
 * Explicit boot/control-migration follow-up. It never scans user config or
 * invokes a Pack: it snapshots every built-in Pack revision it discovers and
 * registers it synchronously (the composition root runs this BEFORE the
 * runtime service accepts commands, so there is no admission transaction to
 * split). Runtime registration of a NEW Pack goes through
 * `integration.pack.register`, whose snapshot+commit is split across the
 * durable outside-transaction admission path.
 */
export function registerCanonicalCollectorPacks(
  registry: PackRegistry,
  packsRoot: string
): RegisteredPackRevision[] {
  return discoverPackRoots(packsRoot).map((directory) => registry.registerDirectory(directory))
}

export {
  checkPackCapability,
  evaluateCapabilityCheck,
  recordCapabilityCheck
} from './conformance.ts'
export type { CapabilityCheckPlan, ConformanceOptions, ConformanceResult } from './conformance.ts'
export {
  CANONICAL_CONTRACT_REVISION,
  CANONICAL_CONTRACT_NAMESPACE,
  BUILTIN_CONTRACTS,
  CONTRACT_ID_PREFIX,
  CONTRACT_PUBLISHED_AT,
  RUNNER_PROTOCOL,
  canonicalContractId,
  canonicalContractIds,
  contractForCapability,
  createCanonicalContractRegistry,
  declaredConformanceCases,
  legacyContractId,
  resolveBuiltinContract,
  resolveCanonicalContract,
  validateContractDeclarations
} from './contracts.ts'
export type {
  CanonicalContractRegistry,
  CanonicalContractRegistryOptions,
  ContractDeclarationIssue,
  ManifestContractDeclaration
} from './contracts.ts'
export { INTEGRATION_SCHEMA_SQL } from './migration.ts'
export { INTEGRATION_OPERATION_NAMES, registerIntegrationOperations } from './operations.ts'
export type { IntegrationOperationDeps, IntegrationOperationRegistry } from './operations.ts'
export { PackRegistry, PackRegistryError, packEntrypoint } from './registry.ts'
export { runPack, PackRunnerError } from './runner.ts'
export type {
  PackActionResultIdentity,
  PackActionRunResult,
  PackRunRequest,
  PackRunResult,
  PackRunnerOptions
} from './runner.ts'
export { canonicalJson, redactText, redactValue, sha256 } from './safety.ts'
export * from './types.ts'
