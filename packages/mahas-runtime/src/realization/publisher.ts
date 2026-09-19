// realization/publisher.ts — RoleImplementation publication lifecycle ops.
//
// C-REALIZATION `implementation.prepare/publish/retire`. The split mirrors
// the contract:
//
//   prepare — the role.implement-delegated author stores a CANDIDATE: the
//     full component graph + coverage bindings + structural diagnostics.
//     A candidate is never executable; it exists so publish can verify and
//     pin EXACTLY the stored content.
//   publish — a separate publication authority replays the checks against
//     the stored rows, pins (interfaceDigest, profileRevision,
//     maintainerRoleId, semanticDecision) and activates — one transaction,
//     "store all components+coverage then activate".
//   retire  — marks a published revision excluded from NEW assignment
//     selection; stored rows and running bundles are never touched.
//
// Guards (instruction §4.4, §5): publication is a distinct authority — an
// active worker may not publish under its own grant, and no path here turns
// a helper subagent into an independent Member or lets an execution member
// rewrite the very implementation it is running.

import type { ContextRequirement, RoleImplementation } from '../../../mahas-contracts/src/role.ts'
import type { TxnContext } from '../api/registry.ts'
import { appendDomainEvent } from '../storage/db.ts'
import {
  evaluateCoverage,
  parseComponentGraph,
  type ComponentGraphInput,
  type CoverageBindingInput,
  type CoverageReport
} from './component-graph.ts'
import { loadInterfaceByDigest, type InterfaceJudgmentScope } from './interfaces.ts'
import {
  activateCandidate,
  implementationContentDigest,
  listImplementationRevisions,
  loadImplementation,
  markRetired,
  referencingExecutions,
  storeCandidate,
  toRoleImplementation,
  type ReferencingExecution
} from './implementation-repository.ts'
import { asRecord, fail, nowMs, optString, reqInteger, reqString } from './util.ts'

/* ------------------------------------------------------------------ *
 * shared checks
 * ------------------------------------------------------------------ */

interface InterfaceContext {
  requirements: ContextRequirement[]
  scope: InterfaceJudgmentScope
  modelVersion: string
  roleId: string
  modelStatus: string
}

/** stored interface + its model freshness — prepare/publish entry check */
function requireInterface(txn: TxnContext, digest: string, op: string): InterfaceContext {
  const stored = loadInterfaceByDigest(txn.db, digest)
  if (stored === undefined) {
    fail('INTERFACE_STALE', `unknown interface digest ${digest} — run interface.get first`, {
      retry: 'replan'
    })
  }
  const model = txn.db
    .prepare('SELECT status FROM model_versions WHERE id = ?')
    .get(stored.iface.modelVersion) as unknown as { status: string } | undefined
  if (model === undefined) {
    fail(
      'MODEL_INVALID',
      `interface ${digest} references missing model ${stored.iface.modelVersion}`
    )
  }
  if (model.status === 'superseded') {
    // a superseded model's interface stays valid history but must not gain
    // NEW implementations — the author re-reads the current interface first.
    fail(
      'INTERFACE_STALE',
      `interface ${digest} derives from superseded model ${stored.iface.modelVersion}`,
      { retry: 'replan', details: { op } }
    )
  }
  return {
    requirements: stored.requirements,
    scope: stored.scope,
    modelVersion: stored.iface.modelVersion,
    roleId: stored.iface.roleId,
    modelStatus: model.status
  }
}

interface ProfileContext {
  supportedKinds: Set<string>
  admissionState: string
}

/** profile row must exist and be usable — disabled profiles host nothing */
function requireProfile(txn: TxnContext, profileId: string, revision: number): ProfileContext {
  const row = txn.db
    .prepare('SELECT state, capabilities_json FROM harness_profiles WHERE id = ? AND revision = ?')
    .get(profileId, revision) as unknown as { state: string; capabilities_json: string } | undefined
  if (row === undefined) {
    fail('MODEL_INVALID', `unknown harness profile ${profileId}@${revision}`)
  }
  if (row.state === 'disabled') {
    fail('INJECTION_UNSUPPORTED', `harness profile ${profileId}@${revision} is disabled`)
  }
  const caps = JSON.parse(row.capabilities_json) as { supportedComponents?: string[] }
  return {
    supportedKinds: new Set(caps.supportedComponents ?? []),
    admissionState: row.state
  }
}

/**
 * instruction §5 / contract 전제·인가: "self-active implementation 변경 권한
 * 미부여" — an execution member may not prepare or publish changes to the
 * very implementation family it is currently running under. The grant
 * question (does this principal hold role.implement / publish scope for the
 * resolved targets) is the admission pipeline's authorize step; this check
 * is the additional self-reference rule the grant layer cannot express.
 */
function refuseSelfActiveChange(txn: TxnContext, implementationId: string, op: string): void {
  if (txn.ctx.memberId === undefined) return
  const member = txn.db
    .prepare('SELECT implementation_id FROM members WHERE id = ?')
    .get(txn.ctx.memberId) as unknown as { implementation_id: string } | undefined
  if (member !== undefined && member.implementation_id === implementationId) {
    fail(
      'SCOPE_DENIED',
      `${op}: member ${txn.ctx.memberId} may not modify the implementation it is running under ` +
        `(self-active ${implementationId}) — publication is a separate authority`
    )
  }
}

/** maintainer scope resolves via the interface's model — role must exist there */
function requireMaintainerRole(txn: TxnContext, modelVersion: string, roleId: string): void {
  const row = txn.db
    .prepare('SELECT 1 AS x FROM rdd_roles WHERE model_version = ? AND id = ?')
    .get(modelVersion, roleId) as unknown as { x: number } | undefined
  if (row === undefined) {
    fail(
      'MODEL_INVALID',
      `maintainerRoleId ${roleId} is not a role of model ${modelVersion} — ` +
        'maintainer scope must resolve through the interface’s model'
    )
  }
}

function unsupportedComponentKinds(graph: ComponentGraphInput, supported: Set<string>): string[] {
  return [...new Set(graph.components.map((c) => c.kind).filter((k) => !supported.has(k)))].sort()
}

/* ------------------------------------------------------------------ *
 * implementation.prepare  (role.implement 위임)
 * ------------------------------------------------------------------ */

export interface ImplementationPrepareInput {
  interfaceDigest: string
  profileId: string
  profileRevision: number
  componentGraph: { components: unknown[] }
  coverageBindings?: unknown[]
  maintenanceBindings?: unknown[]
  maintainerRoleId: string
  /** continue an existing implementation family; omit for a new implementation */
  baseImplementationId?: string
}

export interface ImplementationPrepareResult {
  candidateImplementation: {
    implementationId: string
    revision: number
    status: 'candidate'
  }
  /** content digest the publisher must echo — binds publish to stored rows */
  digest: string
  uncoveredClauses: string[]
  conditionalOnlyClauses: string[]
  orphanBindings: CoverageBindingInput[]
  unsupportedComponents: string[]
  coverage: CoverageReport
}

export function implementationPrepare(
  txn: TxnContext,
  payload: unknown
): ImplementationPrepareResult {
  const p = asRecord(payload, 'implementation.prepare payload')
  const interfaceDigest = reqString(p, 'interfaceDigest')
  const profileId = reqString(p, 'profileId')
  const profileRevision = reqInteger(p, 'profileRevision')
  const maintainerRoleId = reqString(p, 'maintainerRoleId')
  const baseImplementationId = optString(p, 'baseImplementationId')

  const graphRaw = asRecord(p['componentGraph'], 'componentGraph')
  const graph = parseComponentGraph({
    components: graphRaw['components'],
    coverageBindings: p['coverageBindings'] ?? graphRaw['coverageBindings'],
    maintenanceBindings: p['maintenanceBindings'] ?? graphRaw['maintenanceBindings']
  })

  const iface = requireInterface(txn, interfaceDigest, 'implementation.prepare')
  const profile = requireProfile(txn, profileId, profileRevision)
  requireMaintainerRole(txn, iface.modelVersion, maintainerRoleId)
  if (baseImplementationId !== undefined) {
    refuseSelfActiveChange(txn, baseImplementationId, 'implementation.prepare')
  }

  const coverage = evaluateCoverage(iface.requirements, graph)
  const unsupported = unsupportedComponentKinds(graph, profile.supportedKinds)

  const { implementationId, revision, candidateDigest } = storeCandidate(txn.db, {
    interfaceDigest,
    profileId,
    profileRevision,
    maintainerRoleId,
    graph,
    ...(baseImplementationId !== undefined ? { baseImplementationId } : {})
  })

  txn.emitEvent({
    aggregateId: implementationId,
    aggregateRevision: revision,
    eventType: 'implementation.candidate.stored',
    scope: { interfaceDigest, profileId, profileRevision, maintainerRoleId },
    payload: {
      candidateDigest,
      diagnostics: {
        uncoveredClauses: coverage.uncoveredClauses,
        conditionalOnlyClauses: coverage.conditionalOnlyClauses,
        orphanBindingCount: coverage.orphanBindings.length,
        unsupportedComponents: unsupported
      }
    }
  })

  return {
    candidateImplementation: { implementationId, revision, status: 'candidate' },
    digest: candidateDigest,
    uncoveredClauses: coverage.uncoveredClauses,
    conditionalOnlyClauses: coverage.conditionalOnlyClauses,
    orphanBindings: coverage.orphanBindings,
    unsupportedComponents: unsupported,
    coverage
  }
}

/* ------------------------------------------------------------------ *
 * implementation.publish  (구현 공개 권한자)
 * ------------------------------------------------------------------ */

export interface ImplementationPublishInput {
  candidateId: string
  /** required when the family holds more than one stored candidate */
  candidateRevision?: number
  candidateDigest: string
  expectedInterfaceDigest: string
  /** the implementing expert's semantic-fit declaration — REQUIRED, recorded as given */
  semanticDecision: { statement: string; [k: string]: unknown }
}

export interface ImplementationPublishResult {
  implementationId: string
  revision: number
  status: 'published'
  interfaceDigest: string
  implementation: RoleImplementation
}

function resolveCandidateRevision(txn: TxnContext, candidateId: string, revision?: number): number {
  if (revision !== undefined) return revision
  const candidates = listImplementationRevisions(txn.db, candidateId).filter(
    (s) => s.status === 'candidate'
  )
  if (candidates.length === 1) return candidates[0]!.revision
  fail(
    'MODEL_INVALID',
    candidates.length === 0
      ? `no stored candidate for ${candidateId}`
      : `candidateRevision required — ${candidateId} has ${candidates.length} stored candidates`
  )
}

export function implementationPublish(
  txn: TxnContext,
  payload: unknown
): ImplementationPublishResult {
  const p = asRecord(payload, 'implementation.publish payload')
  const candidateId = reqString(p, 'candidateId')
  const candidateDigest = reqString(p, 'candidateDigest')
  const expectedInterfaceDigest = reqString(p, 'expectedInterfaceDigest')
  const decision = asRecord(p['semanticDecision'], 'semanticDecision')
  const statement = reqString(decision, 'statement')
  const candidateRevision =
    p['candidateRevision'] === undefined ? undefined : reqInteger(p, 'candidateRevision')

  const revision = resolveCandidateRevision(txn, candidateId, candidateRevision)
  const stored = loadImplementation(txn.db, candidateId, revision)
  if (stored === undefined) {
    fail('STALE_REVISION', `no stored implementation ${candidateId}@${revision}`, {
      retry: 'replan'
    })
  }
  if (stored.status !== 'candidate') {
    fail(
      'INVALID_TRANSITION',
      `implementation ${candidateId}@${revision} is '${stored.status}' — published revisions are immutable`
    )
  }

  // publish activates exactly what was stored — digest pins the stored rows
  const storedDigest = implementationContentDigest(stored)
  if (storedDigest !== candidateDigest) {
    fail(
      'STALE_REVISION',
      `candidateDigest does not match stored candidate ${candidateId}@${revision}`,
      {
        retry: 'reconcile',
        details: { storedDigest, presentedDigest: candidateDigest }
      }
    )
  }
  if (stored.interfaceDigest !== expectedInterfaceDigest) {
    fail(
      'INTERFACE_STALE',
      `candidate ${candidateId}@${revision} was prepared against interface ${stored.interfaceDigest}, ` +
        `not ${expectedInterfaceDigest}`,
      { retry: 'replan' }
    )
  }

  const iface = requireInterface(txn, stored.interfaceDigest, 'implementation.publish')
  const profile = requireProfile(txn, stored.profileId, stored.profileRevision)
  requireMaintainerRole(txn, iface.modelVersion, stored.maintainerRoleId)
  refuseSelfActiveChange(txn, candidateId, 'implementation.publish')

  // machine checks are re-run against the STORED rows — and reported as
  // structural facts only. They never substitute for the expert's
  // semanticDecision ("기계 검사를 의미 보증으로 표시 금지").
  const coverage = evaluateCoverage(iface.requirements, {
    components: stored.components,
    coverageBindings: stored.coverageBindings,
    maintenanceBindings: stored.maintenanceBindings
  })
  if (coverage.uncoveredClauses.length > 0) {
    fail('MANDATORY_COMPONENT_MISSING', 'required clauses lack initial coverage', {
      retry: 'replan',
      details: {
        uncoveredClauses: coverage.uncoveredClauses,
        conditionalOnlyClauses: coverage.conditionalOnlyClauses
      }
    })
  }
  const unsupported = unsupportedComponentKinds(
    { components: stored.components, coverageBindings: stored.coverageBindings },
    profile.supportedKinds
  )
  if (unsupported.length > 0) {
    fail(
      'INJECTION_UNSUPPORTED',
      `profile ${stored.profileId}@${stored.profileRevision} does not support component kinds`,
      { retry: 'replan', details: { unsupportedComponents: unsupported } }
    )
  }

  const pinnedDecision = {
    ...decision,
    statement,
    declaredBy: txn.ctx.principalId,
    declaredAt: nowMs()
  }
  activateCandidate(txn.db, candidateId, revision, pinnedDecision)

  txn.emitEvent({
    aggregateId: candidateId,
    aggregateRevision: revision,
    eventType: 'implementation.published',
    scope: { interfaceDigest: stored.interfaceDigest, profileId: stored.profileId },
    payload: {
      profileRevision: stored.profileRevision,
      maintainerRoleId: stored.maintainerRoleId,
      declaredBy: txn.ctx.principalId
    }
  })

  const published = loadImplementation(txn.db, candidateId, revision)!
  return {
    implementationId: candidateId,
    revision,
    status: 'published',
    interfaceDigest: stored.interfaceDigest,
    implementation: toRoleImplementation(published)
  }
}

/* ------------------------------------------------------------------ *
 * implementation.retire  (구현 유지 담당자)
 * ------------------------------------------------------------------ */

export interface ImplementationRetireInput {
  implementationId: string
  revision: number
  reason: string
}

export interface ImplementationRetireResult {
  implementationId: string
  revision: number
  status: 'retired'
  /** executions still pinned — reported, never stopped or unpublished */
  referencingExecutions: ReferencingExecution[]
}

export function implementationRetire(
  txn: TxnContext,
  payload: unknown
): ImplementationRetireResult {
  const p = asRecord(payload, 'implementation.retire payload')
  const implementationId = reqString(p, 'implementationId')
  const revision = reqInteger(p, 'revision')
  const reason = reqString(p, 'reason')

  const stored = loadImplementation(txn.db, implementationId, revision)
  if (stored === undefined) {
    fail('STALE_REVISION', `unknown implementation ${implementationId}@${revision}`, {
      retry: 'replan'
    })
  }

  markRetired(txn.db, implementationId, revision)
  const pinned = referencingExecutions(txn.db, implementationId, revision)

  appendDomainEvent(
    txn.db,
    implementationId,
    revision,
    'implementation.retired',
    { interfaceDigest: stored.interfaceDigest, implementationId },
    { reason, referencingExecutions: pinned.map((e) => e.executionId) }
  )

  return { implementationId, revision, status: 'retired', referencingExecutions: pinned }
}
