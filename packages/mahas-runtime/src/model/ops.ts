// mahas-runtime/model — C-MODEL operation handlers (spec/contracts/model.md).
//
//   project.create        — operator; Project + initial draft ModelVersion
//   project.get           — project.read scope; goal/active/root metadata
//   model.snapshot        — model.read scope; structural|coordination|role
//   model.change.prepare  — model.maintain; candidate + diagnostics, no publish
//   model.change.commit   — model.maintain; atomic publish (publisher.ts)
//
// Registration: `registerModelOps(registry, deps)` — IMP-11's OperationRegistry
// owns admission (visibility → authorize → idempotency → write tx → receipt +
// outbox). These handlers run INSIDE that tx: they compute the ACTUAL touched
// targets from the real before/after diff and hand them to IMP-10's decide —
// the access resolver never sees request-claimed scope (instruction §4.4).

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { AuthenticatedContext } from '../../../mahas-contracts/src/common.ts'
import { decide, type TargetRef } from '../access/authorize.ts'
import type { OperationRegistry, TxnContext } from '../api/registry.ts'
import { appendDomainEvent } from '../storage/db.ts'
import {
  applyEdits,
  bad,
  diffSnapshots,
  isObj,
  mahasError,
  normalizeEdits,
  optStr,
  reqStr,
  reviewItemsFromDiff,
  touchedTargetsFromDiff
} from './change-set.ts'
import { errorsOnly, reviewOnly, validateCandidate, type Diagnostic } from './structural-rules.ts'
import {
  MODEL_CHANGE_PREPARED_EVENT,
  PROJECT_REGISTERED_EVENT,
  computeCandidateDigest,
  publishCandidate
} from './publisher.ts'
import {
  canonicalJson,
  changeFields,
  emptySnapshot,
  insertModelChange,
  insertProject,
  insertSnapshot,
  loadModelChange,
  loadModelVersion,
  loadProject,
  loadSnapshot,
  rootBoundaryIdOf,
  snapshotPayload,
  findProjectByRoot,
  type ModelSnapshot
} from './repository.ts'

export interface ModelOpsDeps {
  /** authority clock — epoch ms (DB stores integers, S-COMMON §1) */
  now?: () => number
  /** id minting — prefix + unique suffix */
  newId?: (prefix: string) => string
}

const defaultDeps: Required<ModelOpsDeps> = {
  now: () => Date.now(),
  newId: (prefix: string) => `${prefix}_${randomUUID()}`
}

/** recorded decision → deny on !allow (decision row is IMP-10's audit trail) */
function requireScope(ctx: AuthenticatedContext, operation: string, targets: TargetRef[]): void {
  const { allow } = decide(ctx, operation, targets)
  if (!allow) {
    throw mahasError(
      'SCOPE_DENIED',
      `${operation}: principal ${ctx.principalId} lacks scope over ${targets
        .map((t) => `${t.kind}:${t.id}`)
        .join(', ')}`
    )
  }
}

const asPayload = (p: unknown): Record<string, unknown> => {
  if (!isObj(p)) bad('operation payload must be an object')
  return p
}

/* ------------------------------------------------------------------ */
/* project.create                                                      */
/* ------------------------------------------------------------------ */

function handleProjectCreate(
  txn: TxnContext,
  payload: unknown,
  deps: Required<ModelOpsDeps>
): unknown {
  const p = asPayload(payload)
  const name = reqStr(p, 'name')
  const repositoryRoot = reqStr(p, 'repositoryRoot')
  const goal = reqStr(p, 'goal')
  if (!isAbsolute(repositoryRoot)) {
    throw mahasError(
      'MODEL_INVALID',
      `repositoryRoot "${repositoryRoot}" must be an absolute local path`
    )
  }
  const canonicalRoot = resolvePath(repositoryRoot)

  const db = txn.db
  const projectId = deps.newId('prj')

  // authorization on the actual target before any existence reveal or write
  requireScope(txn.ctx, 'project.create', [{ kind: 'project', id: projectId }])

  const existing = findProjectByRoot(db, canonicalRoot)
  if (existing !== null) {
    const existingId = (existing as { id?: string }).id ?? '(unknown)'
    throw mahasError(
      'OPERATION_CONFLICT',
      `a project is already registered for root ${canonicalRoot}`,
      'none',
      { projectId: existingId }
    )
  }

  // root probe — unconfirmed means registration PENDING, never a fake success
  let rootVerified = false
  let probeDetail = 'root verified as directory'
  try {
    const st = statSync(canonicalRoot)
    rootVerified = st.isDirectory()
    if (!rootVerified) probeDetail = 'path exists but is not a directory'
  } catch (e) {
    probeDetail = `repositoryRoot probe failed: ${e instanceof Error ? e.message : String(e)}`
  }

  const draft = emptySnapshot(goal)
  const draftVersionId = deps.newId('mv')
  const now = deps.now()
  insertProject(db, {
    id: projectId,
    name,
    goal,
    repositoryRoot: canonicalRoot,
    activeModelVersion: null,
    revision: 1
  } as never)
  insertSnapshot(db, draftVersionId, projectId, null, draft, 'draft', now)

  const registrationState = rootVerified ? 'registered' : 'pending'
  appendDomainEvent(
    db,
    projectId,
    1,
    PROJECT_REGISTERED_EVENT,
    { projectId },
    {
      projectId,
      name,
      repositoryRoot: canonicalRoot,
      draftModelVersion: draftVersionId,
      rootVerified,
      registrationState,
      registeredAt: now
    }
  )

  return {
    projectId,
    revision: 1,
    draftModelVersion: draftVersionId,
    registrationState,
    rootProbe: { path: canonicalRoot, verified: rootVerified, detail: probeDetail }
  }
}

/* ------------------------------------------------------------------ */
/* project.get                                                         */
/* ------------------------------------------------------------------ */

function handleProjectGet(txn: TxnContext, payload: unknown): unknown {
  const p = asPayload(payload)
  const projectId = reqStr(p, 'projectId')
  const db = txn.db

  // scope check on the claimed target BEFORE existence is revealed
  requireScope(txn.ctx, 'project.get', [{ kind: 'project', id: projectId }])

  const project = loadProject(db, projectId)
  if (project === null) {
    throw mahasError('MODEL_INVALID', `project ${projectId} not found`, 'none', { projectId })
  }
  const pf = project as unknown as {
    id: string
    name: string
    goal: string
    repositoryRoot: string
    activeModelVersion: string | null
    revision: number
  }

  // root metadata — the active version's root boundary summary, when one is
  // published; a project with only a draft reports rootBoundary: null
  let rootBoundary: { id: string; name: string; responsibilityStatement: string } | null = null
  if (pf.activeModelVersion !== null) {
    const s = loadSnapshot(db, pf.activeModelVersion)
    if (s !== null) {
      const rid = rootBoundaryIdOf(s)
      const rb = rid === null ? undefined : s.boundaries.get(rid)
      if (rb) {
        rootBoundary = {
          id: rb.id,
          name: rb.name,
          responsibilityStatement: rb.responsibilityStatement
        }
      }
    }
  }

  return {
    projectId: pf.id,
    name: pf.name,
    goal: pf.goal,
    repositoryRoot: pf.repositoryRoot,
    activeModelVersion: pf.activeModelVersion,
    revision: pf.revision,
    rootBoundary
  }
}

/* ------------------------------------------------------------------ */
/* model.snapshot — structural | coordination | role projections       */
/* ------------------------------------------------------------------ */

const PROJECTIONS = ['structural', 'coordination', 'role'] as const
type Projection = (typeof PROJECTIONS)[number]

function handleModelSnapshot(txn: TxnContext, payload: unknown): unknown {
  const p = asPayload(payload)
  const projectId = reqStr(p, 'projectId')
  const requestedVersion = optStr(p, 'modelVersion') ?? null
  const projection = (optStr(p, 'projection') ?? 'structural') as Projection
  if (!PROJECTIONS.includes(projection)) {
    bad(`projection must be one of ${PROJECTIONS.join('|')}`, { projection })
  }
  const roleId = optStr(p, 'roleId') ?? null
  if (projection === 'role' && roleId === null) {
    bad('role projection requires roleId')
  }

  const db = txn.db
  const project = loadProject(db, projectId)
  const versionId =
    requestedVersion ??
    (project as { activeModelVersion?: string | null } | null)?.activeModelVersion ??
    null

  // authorize against the concrete targets (role-scoped projection adds the
  // role target; a global structural dump is gated to operator/maintainer by
  // the resolver's scope for 'model-version')
  const targets: TargetRef[] = [{ kind: 'project', id: projectId }]
  if (versionId !== null) targets.push({ kind: 'model-version', id: versionId })
  if (roleId !== null) targets.push({ kind: 'role', id: roleId })
  requireScope(txn.ctx, 'model.snapshot', targets)

  if (project === null) {
    throw mahasError('MODEL_INVALID', `project ${projectId} not found`, 'none', { projectId })
  }
  if (versionId === null) {
    throw mahasError(
      'STALE_REVISION',
      `project ${projectId} has no active model version yet`,
      'reconcile',
      { projectId }
    )
  }
  const version = loadModelVersion(db, versionId)
  const vf = version as unknown as {
    id: string
    projectId: string
    status: string
    digest: string | null
    parentVersion: string | null
    createdAt: number
  } | null
  if (vf === null || vf.projectId !== projectId) {
    throw mahasError(
      'STALE_REVISION',
      `model version ${versionId} does not belong to project ${projectId}`,
      'reconcile',
      { projectId, modelVersion: versionId }
    )
  }
  const snapshot = loadSnapshot(db, versionId)
  if (snapshot === null) {
    throw mahasError('MODEL_INVALID', `model version ${versionId} has no stored payload`)
  }

  const meta = {
    projectId,
    modelVersion: versionId,
    activeModelVersion:
      (project as { activeModelVersion?: string | null }).activeModelVersion ?? null,
    status: vf.status,
    parentVersion: vf.parentVersion,
    digest: vf.digest,
    createdAt: vf.createdAt,
    projection
  }

  if (projection === 'structural') {
    return {
      ...meta,
      rootBoundaryId: rootBoundaryIdOf(snapshot),
      snapshot: snapshotPayload(snapshot)
    }
  }
  if (projection === 'coordination') {
    return {
      ...meta,
      rootBoundaryId: rootBoundaryIdOf(snapshot),
      coordination: coordinationView(snapshot)
    }
  }
  return { ...meta, role: roleView(snapshot, roleId!, db, versionId) }
}

/** coordinator-facing view — responsibility/contract/team structure, no raw
 * context bodies (paths resolve to files the coordinator can read anyway) */
function coordinationView(s: ModelSnapshot): Record<string, unknown> {
  return {
    goal: s.goal,
    boundaries: [...s.boundaries.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((b) => ({
        id: b.id,
        name: b.name,
        responsibilityStatement: b.responsibilityStatement,
        parentId: b.parentId,
        paths: b.paths,
        criteria: b.criteria
      })),
    contracts: [...s.contracts.values()].sort((a, b) => a.id.localeCompare(b.id)),
    roles: [...s.roles.values()].sort((a, b) => a.id.localeCompare(b.id)),
    horizontalRoles: [...s.horizontalRoles.keys()].sort(),
    nonGoals: [...s.nonGoals.values()].sort((a, b) => a.id.localeCompare(b.id))
  }
}

/** role-scoped view — the role's own boundary, ancestor chain, contracts it
 * produces/consumes, sibling roles, linked contexts and non-goals */
function roleView(
  s: ModelSnapshot,
  roleId: string,
  db: TxnContext['db'],
  versionId: string
): Record<string, unknown> {
  const role = s.roles.get(roleId)
  if (!role) {
    throw mahasError(
      'MODEL_INVALID',
      `role ${roleId} does not exist in model version ${versionId}`,
      'none',
      { roleId }
    )
  }
  void db
  const boundary = s.boundaries.get(role.boundaryId) ?? null
  const ancestors: { id: string; name: string; responsibilityStatement: string }[] = []
  const seen = new Set<string>()
  let cur = boundary?.parentId ?? null
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur)
    const b = s.boundaries.get(cur)
    if (!b) break
    ancestors.push({ id: b.id, name: b.name, responsibilityStatement: b.responsibilityStatement })
    cur = b.parentId
  }
  const contracts = [...s.contracts.values()].filter(
    (c) =>
      c.providerBoundaryId === role.boundaryId || c.consumerBoundaryIds.includes(role.boundaryId)
  )
  const horizontal = s.horizontalRoles.get(role.horizontalRoleName) ?? null
  const boundaryContexts = (boundary?.contextIds ?? [])
    .map((id) => s.contexts.get(id))
    .filter((x): x is NonNullable<typeof x> => x !== undefined)
  const horizontalContexts = (horizontal?.contextIds ?? [])
    .map((id) => s.contexts.get(id))
    .filter((x): x is NonNullable<typeof x> => x !== undefined)
  return {
    role,
    boundary,
    ancestors,
    siblingRoles: [...s.roles.values()].filter(
      (r) => r.boundaryId === role.boundaryId && r.id !== role.id
    ),
    contracts,
    horizontalRole: horizontal === null ? null : { name: horizontal.name },
    boundaryContexts,
    horizontalContexts,
    nonGoals: [...s.nonGoals.values()].filter((n) => n.boundaryId === role.boundaryId)
  }
}

/* ------------------------------------------------------------------ */
/* model.change.prepare                                                */
/* ------------------------------------------------------------------ */

function handleModelChangePrepare(
  txn: TxnContext,
  payload: unknown,
  deps: Required<ModelOpsDeps>
): unknown {
  const p = asPayload(payload)
  const projectId = reqStr(p, 'projectId')
  const baseVersion = reqStr(p, 'baseVersion')
  const edits = normalizeEdits(p.edits)

  const db = txn.db
  const project = loadProject(db, projectId)
  const version = loadModelVersion(db, baseVersion)

  // materialize the candidate BEFORE authorizing — the diff, not the
  // request, decides which targets the resolver sees
  const base = loadSnapshot(db, baseVersion)
  const candidate = base === null ? null : applyEdits(base, edits)
  const diagnostics = candidate?.diagnostics ?? []
  const structural = candidate === null ? [] : validateCandidate(candidate.snapshot)
  const diff = base === null || candidate === null ? null : diffSnapshots(base, candidate.snapshot)
  const touched =
    diff === null
      ? [
          { kind: 'project', id: projectId },
          { kind: 'model-version', id: baseVersion }
        ]
      : touchedTargetsFromDiff(projectId, baseVersion, diff)
  requireScope(txn.ctx, 'model.change.prepare', touched)

  if (project === null) {
    throw mahasError('MODEL_INVALID', `project ${projectId} not found`, 'none', { projectId })
  }
  if (version === null || (version as { projectId?: string }).projectId !== projectId) {
    throw mahasError(
      'STALE_REVISION',
      `base model version ${baseVersion} does not belong to project ${projectId}`,
      'reconcile',
      { projectId, baseVersion }
    )
  }
  if (base === null || candidate === null || diff === null) {
    throw mahasError('MODEL_INVALID', `base model version ${baseVersion} has no stored payload`)
  }

  const reviewItems = [...reviewItemsFromDiff(diff), ...reviewOnly(structural)]
  const structuralErrors = [...diagnostics, ...errorsOnly(structural)]
  const { candidateDigest } = computeCandidateDigest(baseVersion, edits, candidate.snapshot)

  const changeId = deps.newId('mc')
  const storedDiagnostics = {
    structuralErrors,
    semanticReviewItems: reviewItems,
    preparedAt: deps.now()
  }
  insertModelChange(db, {
    id: changeId,
    projectId,
    baseVersion,
    candidateDigest,
    state: 'prepared',
    edits: edits as unknown[],
    touchedTargets: touched as unknown[],
    diagnostics: storedDiagnostics
  } as never)

  appendDomainEvent(
    db,
    projectId,
    (project as { revision?: number }).revision ?? 1,
    MODEL_CHANGE_PREPARED_EVENT,
    { projectId, changeId },
    {
      changeId,
      projectId,
      baseVersion,
      candidateDigest,
      touchedTargets: touched,
      structuralErrors,
      semanticReviewItems: reviewItems
    }
  )

  return {
    changeId,
    candidateDigest,
    touchedTargets: touched,
    structuralErrors,
    semanticReviewItems: reviewItems
  }
}

/* ------------------------------------------------------------------ */
/* model.change.commit                                                 */
/* ------------------------------------------------------------------ */

function handleModelChangeCommit(
  txn: TxnContext,
  payload: unknown,
  deps: Required<ModelOpsDeps>
): unknown {
  const p = asPayload(payload)
  const changeId = reqStr(p, 'changeId')
  const candidateDigest = reqStr(p, 'candidateDigest')
  const expectedRaw = p.expectedActiveVersion
  const expectedActiveVersion =
    expectedRaw === undefined || expectedRaw === null ? null : (expectedRaw as string)
  if (expectedActiveVersion !== null && typeof expectedActiveVersion !== 'string') {
    bad('expectedActiveVersion must be a string or null')
  }
  const semanticDecision = reqStr(p, 'semanticDecision')

  const db = txn.db
  const change = loadModelChange(db, changeId)

  // authorize on the claimed change before existence/state is revealed
  const preTargets: TargetRef[] = [{ kind: 'model-change', id: changeId }]
  if (change !== null) {
    const cf0 = changeFields(change)
    preTargets.push({ kind: 'project', id: cf0.projectId })
    preTargets.push({ kind: 'model-version', id: cf0.baseVersion })
    for (const t of cf0.touchedTargets as TargetRef[]) {
      if (isObj(t) && typeof t.kind === 'string' && typeof t.id === 'string') {
        preTargets.push({ kind: t.kind, id: t.id })
      }
    }
  }
  requireScope(txn.ctx, 'model.change.commit', preTargets)

  if (change === null) {
    throw mahasError('MODEL_INVALID', `model change ${changeId} not found`, 'none', { changeId })
  }
  const cf = changeFields(change)
  if (cf.state !== 'prepared') {
    throw mahasError(
      'INVALID_TRANSITION',
      `model change ${changeId} is ${cf.state}, not prepared`,
      'none',
      { changeId, state: cf.state }
    )
  }
  if (cf.candidateDigest !== candidateDigest) {
    throw mahasError(
      'OPERATION_CONFLICT',
      `candidateDigest mismatch — the stored candidate ${cf.candidateDigest.slice(0, 12)}… is not ${candidateDigest.slice(0, 12)}…`,
      'none',
      { changeId }
    )
  }
  const project = loadProject(db, cf.projectId)
  if (project === null) {
    throw mahasError('MODEL_INVALID', `project ${cf.projectId} for change ${changeId} not found`)
  }
  const actualActive =
    (project as { activeModelVersion?: string | null }).activeModelVersion ?? null
  if (actualActive !== expectedActiveVersion) {
    throw mahasError(
      'STALE_REVISION',
      `expected active version ${expectedActiveVersion ?? '(none)'} but project ${cf.projectId} is at ${actualActive ?? '(none)'} — re-prepare on the current base`,
      'reconcile',
      { expectedActiveVersion, actualActiveVersion: actualActive }
    )
  }
  if (expectedActiveVersion !== null && cf.baseVersion !== expectedActiveVersion) {
    throw mahasError(
      'STALE_REVISION',
      `change ${changeId} was prepared on base ${cf.baseVersion} which is not the active version ${expectedActiveVersion} — publishing it would silently discard the active model`,
      'replan',
      { baseVersion: cf.baseVersion, expectedActiveVersion }
    )
  }

  // re-materialize the candidate from stored base+edits and re-verify the
  // immutable digest — the candidate that was authorized is the one published
  const base = loadSnapshot(db, cf.baseVersion)
  if (base === null) {
    throw mahasError('MODEL_INVALID', `base model version ${cf.baseVersion} has no stored payload`)
  }
  const edits = normalizeEdits(cf.edits)
  const applied = applyEdits(base, edits)
  const recomputed = computeCandidateDigest(cf.baseVersion, edits, applied.snapshot)
  if (recomputed.candidateDigest !== cf.candidateDigest) {
    throw mahasError(
      'OPERATION_CONFLICT',
      `stored candidate ${changeId} no longer materializes to its recorded digest — refusing to publish a mutated candidate`,
      'none',
      { changeId }
    )
  }

  // re-run the publish rules on the materialized candidate — edit-apply and
  // structural errors are MODEL_INVALID, exactly as prepare reported them
  const structural = validateCandidate(applied.snapshot)
  const structuralErrors = [...applied.diagnostics, ...errorsOnly(structural)]
  if (structuralErrors.length > 0) {
    throw mahasError(
      'MODEL_INVALID',
      `candidate ${changeId} fails publish rules (${structuralErrors.length} structural error(s))`,
      'none',
      { changeId, diagnostics: structuralErrors }
    )
  }

  const diff = diffSnapshots(base, applied.snapshot)
  const reviewItems = [...reviewItemsFromDiff(diff), ...reviewOnly(structural)]

  const result = publishCandidate(db, {
    project,
    change,
    snapshot: applied.snapshot,
    snapshotDigest: recomputed.snapshotDigest,
    expectedActiveVersion,
    semanticDecision,
    semanticReviewItems: reviewItems,
    now: deps.now(),
    newVersionId: deps.newId('mv')
  })

  return {
    publishedVersion: result.publishedVersion,
    digest: result.digest,
    impactBatchId: result.impactBatchId
  }
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

/**
 * Register the C-MODEL operations this task owns:
 *   project.create · project.get · model.snapshot ·
 *   model.change.prepare · model.change.commit
 * (model.impact.list / .classify belong to IMP-27 over IMP-05's port.)
 */
export function registerModelOps(registry: OperationRegistry, deps: ModelOpsDeps = {}): void {
  const d: Required<ModelOpsDeps> = { ...defaultDeps, ...deps }
  registry.register(
    { name: 'project.create', visibility: 'operator', mutation: true },
    (txn, payload) => handleProjectCreate(txn, payload, d)
  )
  registry.register(
    { name: 'project.get', visibility: 'member', mutation: false },
    (txn, payload) => handleProjectGet(txn, payload)
  )
  registry.register(
    { name: 'model.snapshot', visibility: 'member', mutation: false },
    (txn, payload) => handleModelSnapshot(txn, payload)
  )
  registry.register(
    { name: 'model.change.prepare', visibility: 'member', mutation: true },
    (txn, payload) => handleModelChangePrepare(txn, payload, d)
  )
  registry.register(
    { name: 'model.change.commit', visibility: 'member', mutation: true },
    (txn, payload) => handleModelChangeCommit(txn, payload, d)
  )
}

// re-exported so consumers/tests can build inputs without re-implementing
export { canonicalJson }
export type { Diagnostic }
