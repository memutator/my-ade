// integration/conformance.ts — capability conformance for one Pack revision.
//
// A check has two halves, deliberately separable because the second one must
// run inside a DB transaction while the first one must NOT:
//
//   evaluateCapabilityCheck()  — schema/digest/entrypoint/semantics checks plus
//                                the fixture invocations. Reads pack files and
//                                SPAWNS CHILD PROCESSES: never call this with a
//                                transaction open (admission runs it through
//                                the durable outside-transaction path).
//   recordCapabilityCheck()    — writes integration_checks +
//                                integration_capability_implementations and
//                                opens an integration_issues row. Pure DB work,
//                                safe inside the completion transaction.
//   checkPackCapability()      — both halves in order (tests, callers that
//                                already own the transaction decision).
//
// A revision change begins unchecked; this module only records incompatible
// after concrete schema/case evidence.

import { readFileSync } from 'node:fs'
import type {
  IntegrationCapability,
  IntegrationCheckResult,
  IntegrationContract,
  IntegrationDiagnostic,
  IntegrationTargetRef
} from '../../../mahas-contracts/src/integration/index.ts'
import {
  CAPABILITY_PAYLOAD_SCHEMAS,
  validateIntegrationSchema
} from '../../../mahas-contracts/src/integration/index.ts'
import { canonicalJson, redactText, sha256 } from './safety.ts'
import { packEntrypoint, PackRegistry } from './registry.ts'
import { runPack, type PackRunRequest } from './runner.ts'

const EFFECTFUL_CAPABILITIES = new Set<IntegrationCapability>([
  'launch',
  'resume',
  'wake',
  'maintenance',
  'auth'
])

export interface ConformanceOptions {
  target?: IntegrationTargetRef
  /** False performs a passive schema/registration check only. */
  runCases?: boolean
  signal?: AbortSignal
}

export interface ConformanceResult {
  checkId: string
  result: Exclude<IntegrationCheckResult, 'unchecked'>
  semanticsVerified: boolean
  diagnostics: readonly IntegrationDiagnostic[]
  issueId?: string
}

/** everything one check observed — the DB-write-free half of a check */
export interface CapabilityCheckPlan {
  packId: string
  packRevision: number
  capability: IntegrationCapability
  contract: IntegrationContract
  implementationId: string
  target: IntegrationTargetRef
  result: Exclude<IntegrationCheckResult, 'unchecked'>
  semanticsVerified: boolean
  diagnostics: readonly IntegrationDiagnostic[]
  /** non-null when result !== 'compatible' — the issue to open on record */
  issueReason: 'schema-violation' | 'conformance-failure' | null
  evidence: readonly { kind: string; ref?: string }[]
}

function diag(
  code: string,
  severity: IntegrationDiagnostic['severity'],
  message: string
): IntegrationDiagnostic {
  return { code, severity, message: redactText(message) }
}

function fixtureRequest(value: unknown): PackRunRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const candidate = record.request ?? record
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as PackRunRequest)
    : null
}

/**
 * The effect-free half: everything that needs to read Pack files, inspect the
 * registered schema and invoke fixture cases. No DB write, no transaction.
 */
export async function evaluateCapabilityCheck(
  registry: PackRegistry,
  packId: string,
  packRevision: number,
  capability: IntegrationCapability,
  contract: IntegrationContract,
  options: ConformanceOptions = {}
): Promise<CapabilityCheckPlan> {
  const revision = registry.resolve(packId, packRevision)
  const implementation = registry.implementation(packId, packRevision, capability)
  const target = options.target ?? { kind: 'harness', harnessId: 'unscoped-conformance' }
  const diagnostics: IntegrationDiagnostic[] = []
  let result: CapabilityCheckPlan['result'] = 'compatible'
  let semanticsVerified = false

  const expectedSchemas = CAPABILITY_PAYLOAD_SCHEMAS[capability]
  const actualSchemaDigest = sha256(
    canonicalJson({
      request: contract.requestSchema,
      response: contract.responseSchema
    })
  )
  if (contract.schemaDigest !== actualSchemaDigest) {
    result = 'incompatible'
    diagnostics.push(
      diag('conformance.schema-digest', 'error', 'contract schemaDigest does not match its schemas')
    )
  } else if (
    canonicalJson(contract.requestSchema) !== canonicalJson(expectedSchemas.request) ||
    canonicalJson(contract.responseSchema) !== canonicalJson(expectedSchemas.response)
  ) {
    result = 'incompatible'
    diagnostics.push(
      diag(
        'conformance.noncanonical-schema',
        'error',
        'contract schemas do not match the canonical capability schemas'
      )
    )
  }
  if (!contract.semanticsDigest.trim()) {
    result = 'incompatible'
    diagnostics.push(
      diag('conformance.semantics-digest', 'error', 'contract semanticsDigest is empty')
    )
  }

  if (!implementation) {
    result = 'incompatible'
    diagnostics.push(diag('conformance.undeclared', 'error', `Pack does not declare ${capability}`))
  } else if (
    implementation.contract.id !== contract.id ||
    implementation.contract.revision !== contract.revision ||
    contract.capability !== capability
  ) {
    result = 'incompatible'
    diagnostics.push(
      diag(
        'conformance.contract-mismatch',
        'error',
        'implementation and requested contract revisions do not match'
      )
    )
  } else if (implementation.support.state === 'unsupported') {
    semanticsVerified = true
    diagnostics.push(diag('conformance.unsupported', 'info', implementation.support.reason))
  } else if (!implementation.entrypoint) {
    result = 'incompatible'
    diagnostics.push(
      diag('conformance.entrypoint-missing', 'error', 'implemented capability has no entrypoint')
    )
  } else {
    try {
      packEntrypoint(revision, implementation.entrypoint.resource)
    } catch (error) {
      result = 'incompatible'
      diagnostics.push(
        diag(
          'conformance.entrypoint-missing',
          'error',
          error instanceof Error ? error.message : String(error)
        )
      )
    }
  }

  if (result === 'compatible' && implementation?.support.state === 'implemented') {
    if (!options.runCases || contract.conformanceCases.length === 0) {
      diagnostics.push(
        diag(
          'conformance.semantics-unverified',
          'warning',
          'schema is compatible; semantic behavior has not been verified'
        )
      )
    } else if (EFFECTFUL_CAPABILITIES.has(capability)) {
      diagnostics.push(
        diag(
          'conformance.effectful-not-run',
          'warning',
          'effectful capability cases require the normal intent and receipt path and were not invoked by conformance'
        )
      )
    } else {
      let executedAcceptCase = false
      for (const testCase of contract.conformanceCases) {
        let fixture: unknown
        try {
          fixture = JSON.parse(readFileSync(packEntrypoint(revision, testCase.fixtureRef), 'utf8'))
        } catch (error) {
          result = 'degraded'
          diagnostics.push(
            diag(
              'conformance.fixture-unreadable',
              'error',
              `${testCase.id}: ${error instanceof Error ? error.message : String(error)}`
            )
          )
          continue
        }
        const fixtureEnvelope = fixtureRequest(fixture)
        const request =
          fixtureEnvelope &&
          revision.manifest.revision.runnerProtocol === fixtureEnvelope.protocolVersion
            ? ({
                ...fixtureEnvelope,
                capability,
                target,
                contract: implementation.contract,
                pack: {
                  packId,
                  revision: packRevision,
                  contentDigest: revision.contentDigest
                }
              } as PackRunRequest)
            : null
        if (!request) {
          result = 'degraded'
          diagnostics.push(
            diag(
              'conformance.fixture-invalid',
              'error',
              `${testCase.id}: fixture has no request envelope`
            )
          )
          continue
        }
        const requestIssues = validateIntegrationSchema(contract.requestSchema, request.payload)
        if (testCase.expected === 'reject') {
          if (requestIssues.length === 0) {
            result = 'degraded'
            diagnostics.push(
              diag(
                'conformance.expected-rejection',
                'error',
                `${testCase.id}: invalid fixture was accepted by the request schema`
              )
            )
          }
          continue
        }
        if (requestIssues.length > 0) {
          result = 'degraded'
          diagnostics.push(
            diag(
              'conformance.request-schema',
              'error',
              `${testCase.id}: accepted fixture violates the request schema`
            )
          )
          continue
        }
        const invocation = await runPack(registry, request, {
          purpose: 'conformance',
          signal: options.signal
        })
        if (invocation.status !== 'success' && invocation.status !== 'partial') {
          result = 'degraded'
          diagnostics.push(
            diag(
              'conformance.invocation',
              'error',
              `${testCase.id}: Pack returned ${invocation.status}`
            )
          )
          continue
        }
        const responseIssues = validateIntegrationSchema(
          contract.responseSchema,
          invocation.payload
        )
        if (responseIssues.length > 0) {
          result = 'degraded'
          diagnostics.push(
            diag(
              'conformance.response-schema',
              'error',
              `${testCase.id}: Pack output violates the response schema`
            )
          )
          continue
        }
        const expected =
          fixture && typeof fixture === 'object' && !Array.isArray(fixture)
            ? (fixture as Record<string, unknown>).expectedPayload
            : undefined
        if (
          expected !== undefined &&
          canonicalJson(expected) !== canonicalJson(invocation.payload)
        ) {
          result = 'degraded'
          diagnostics.push(
            diag(
              'conformance.semantic-mismatch',
              'error',
              `${testCase.id}: output did not match the semantic fixture`
            )
          )
          continue
        }
        executedAcceptCase = true
      }
      semanticsVerified = result === 'compatible' && executedAcceptCase
      if (!semanticsVerified && result === 'compatible')
        diagnostics.push(
          diag(
            'conformance.semantics-unverified',
            'warning',
            'no accepting semantic case was executed'
          )
        )
    }
  }

  return {
    packId,
    packRevision,
    capability,
    contract,
    implementationId: implementation?.id ?? `${packId}:${capability}:undeclared`,
    target,
    result,
    semanticsVerified,
    diagnostics,
    issueReason:
      result === 'compatible'
        ? null
        : result === 'incompatible'
          ? 'schema-violation'
          : 'conformance-failure',
    evidence: contract.conformanceCases.map((item) => ({ kind: 'fixture', ref: item.fixtureRef }))
  }
}

/**
 * The DB half: persist the check and open an issue when the check is not
 * compatible. Pure row writes — safe (and expected) inside the caller's
 * transaction.
 */
export function recordCapabilityCheck(
  registry: PackRegistry,
  plan: CapabilityCheckPlan
): ConformanceResult {
  const checkId = registry.recordCheck({
    packId: plan.packId,
    packRevision: plan.packRevision,
    implementationId: plan.implementationId,
    capability: plan.capability,
    contractId: plan.contract.id,
    contractRevision: plan.contract.revision,
    target: plan.target,
    result: plan.result,
    semanticsVerified: plan.semanticsVerified,
    diagnostics: plan.diagnostics,
    evidence: plan.evidence
  })
  let issueId: string | undefined
  if (plan.issueReason) {
    issueId = registry.openIssue({
      packId: plan.packId,
      packRevision: plan.packRevision,
      capability: plan.capability,
      target: { packId: plan.packId, revision: plan.packRevision },
      reason: plan.issueReason,
      evidence: [{ kind: 'check', ref: checkId }],
      diagnostics: plan.diagnostics
    })
  }
  return {
    checkId,
    result: plan.result,
    semanticsVerified: plan.semanticsVerified,
    diagnostics: plan.diagnostics,
    ...(issueId ? { issueId } : {})
  }
}

/**
 * Evaluate + record in one call. Prefer the split API when the caller owns a
 * transaction boundary: the evaluation spawns child processes.
 */
export async function checkPackCapability(
  registry: PackRegistry,
  packId: string,
  packRevision: number,
  capability: IntegrationCapability,
  contract: IntegrationContract,
  options: ConformanceOptions = {}
): Promise<ConformanceResult> {
  const plan = await evaluateCapabilityCheck(
    registry,
    packId,
    packRevision,
    capability,
    contract,
    options
  )
  return recordCapabilityCheck(registry, plan)
}
