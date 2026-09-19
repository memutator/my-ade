// realization/interfaces.ts — RoleInterface snapshot builder + `interface.get`.
//
// spec/domains/role-realization.md §1-2: a RoleInterface is the semantic
// contract "role + 책임에 필요한 context" — WHAT must hold, never the
// instructions themselves. It is computed deterministically from the RDD
// model (rdd_roles + boundary responsibility + criteria + bound contexts +
// contracts + non-goals) and stored content-addressed in role_interfaces.
//
// REQ-22 / contract `interface.get`: the interface carries requirement
// BINDINGS (clauseId -> contextId/criterionRef), not context bodies — reading
// source text is a separate permission the snapshot does not exercise.
// RDD roles get no provider config or task requirements baked in
// (instruction §4.1): those live in WorkEnvelope / LaunchPlan, not here.

import type { DatabaseSync } from 'node:sqlite'
import type { ModelVersionId, RoleInterfaceDigest } from '../../../mahas-contracts/src/common.ts'
import type {
  ContextRequirement,
  RoleInterface,
  RoleInterfaceRequirements
} from '../../../mahas-contracts/src/role.ts'
import type { TargetRef, TxnContext } from '../api/registry.ts'
import { asRecord, canonicalJson, digestOf, fail, reqString } from './util.ts'

/* ------------------------------------------------------------------ *
 * interface derivation — pure function of stored model rows
 * ------------------------------------------------------------------ */

/** one bound context source — boundary (영토) or horizontal (전문) binding */
type ContextBindingSource = 'boundary' | 'horizontal'

/**
 * Derivation rules (documented so a changed model diff is explainable):
 *  - every criterion of the role's boundary       -> required clause (criterion:<id>)
 *  - every boundary/horizontal bound context      -> required clause (context:<id>)
 *  - contracts the boundary PROVIDES              -> responsibilityRefs
 *  - contracts the boundary CONSUMES + non-goals  -> invariantRefs
 *  - owner criteria copy RDD criterion text into requiredMeaning with
 *    readerPerspective 'performer'; a coordination-perspective clause is
 *    also emitted from the boundary responsibility (and contract tensions)
 *    so inspect is not always missing.
 */
export interface DerivedRequirement {
  clauseId: string
  contextId?: string
  /** bare criterion id from the role's boundary — mapped to the contract's
   *  {boundaryId, criterionId} CriterionRef only at the RoleInterface edge */
  criterionRef?: string
  requiredMeaning: string
  deliveryClass: 'initial' | 'conditional'
  readerPerspective: string
}

/** refs the maintenance/impact story (IMP-27) keys staleness checks on */
export interface InterfaceMaintenanceRef {
  kind: 'context' | 'criterion' | 'contract' | 'non-goal' | 'boundary' | 'model'
  id: string
  /** context rows only — repo-relative path of the authored source file */
  path?: string
}

interface RoleRow {
  id: string
  name: string
  description: string
  boundary_id: string
  horizontal_role_name: string
}

interface BoundaryRow {
  id: string
  name: string
  responsibility_statement: string
}

interface CriterionRow {
  id: string
  criterion: string
  description: string
  ordinal: number
}

interface ContextRow {
  id: string
  path: string
}

interface ContractRow {
  id: string
  name: string
}

interface NonGoalRow {
  id: string
  statement: string
}

/** the stored judgment_scope_json payload — everything that is not a clause row */
export interface InterfaceJudgmentScope {
  scopeOfJudgment: {
    roleId: string
    roleName: string
    boundaryId: string
    boundaryName: string
    horizontalRole: string
    /** role.description — the model's own statement of the judgment scope */
    summary: string
    responsibility: string
  }
  responsibilityRefs: string[]
  invariantRefs: string[]
  maintenanceRefs: InterfaceMaintenanceRef[]
}

/** fully derived interface content — the digest covers exactly this */
export interface DerivedInterface {
  modelVersion: string
  roleId: string
  contextRequirements: DerivedRequirement[]
  scope: InterfaceJudgmentScope
}

/**
 * Compute the semantic interface of (modelVersion, roleId) from the RDD
 * tables. Pure read — deterministic for a fixed model snapshot. Throws
 * MODEL_INVALID when the role or its boundary does not exist in the version.
 */
export function deriveInterface(
  db: DatabaseSync,
  modelVersion: string,
  roleId: string
): DerivedInterface {
  const role = db
    .prepare(
      'SELECT id, name, description, boundary_id, horizontal_role_name ' +
        'FROM rdd_roles WHERE model_version = ? AND id = ?'
    )
    .get(modelVersion, roleId) as unknown as RoleRow | undefined
  if (role === undefined) {
    fail('MODEL_INVALID', `no role ${roleId} in model version ${modelVersion}`)
  }

  const boundary = db
    .prepare(
      'SELECT id, name, responsibility_statement FROM rdd_boundaries ' +
        'WHERE model_version = ? AND id = ?'
    )
    .get(modelVersion, role.boundary_id) as unknown as BoundaryRow | undefined
  if (boundary === undefined) {
    fail('MODEL_INVALID', `role ${roleId} references missing boundary ${role.boundary_id}`)
  }

  const criteria = db
    .prepare(
      'SELECT id, criterion, description, ordinal FROM rdd_criteria ' +
        'WHERE model_version = ? AND boundary_id = ? ORDER BY ordinal, id'
    )
    .all(modelVersion, boundary.id) as unknown as CriterionRow[]

  const boundContexts = db
    .prepare(
      "SELECT bc.context_id AS id, c.path AS path, 'boundary' AS via " +
        'FROM boundary_contexts bc JOIN rdd_contexts c ' +
        '  ON c.model_version = bc.model_version AND c.id = bc.context_id ' +
        'WHERE bc.model_version = ? AND bc.boundary_id = ? ' +
        'UNION ALL ' +
        "SELECT hc.context_id AS id, c.path AS path, 'horizontal' AS via " +
        'FROM horizontal_contexts hc JOIN rdd_contexts c ' +
        '  ON c.model_version = hc.model_version AND c.id = hc.context_id ' +
        'WHERE hc.model_version = ? AND hc.horizontal_role_name = ?'
    )
    .all(modelVersion, boundary.id, modelVersion, role.horizontal_role_name) as unknown as Array<
    ContextRow & { via: ContextBindingSource }
  >

  const providedContracts = db
    .prepare(
      'SELECT id, name FROM rdd_contracts WHERE model_version = ? AND provider_boundary_id = ? ' +
        'ORDER BY id'
    )
    .all(modelVersion, boundary.id) as unknown as ContractRow[]

  const consumedContracts = db
    .prepare(
      'SELECT c.id AS id, c.name AS name FROM contract_consumers cc ' +
        'JOIN rdd_contracts c ON c.model_version = cc.model_version AND c.id = cc.contract_id ' +
        'WHERE cc.model_version = ? AND cc.consumer_boundary_id = ? ORDER BY c.id'
    )
    .all(modelVersion, boundary.id) as unknown as ContractRow[]

  const nonGoals = db
    .prepare(
      'SELECT id, statement FROM rdd_non_goals WHERE model_version = ? AND boundary_id = ? ORDER BY id'
    )
    .all(modelVersion, boundary.id) as unknown as NonGoalRow[]

  /* clauses — deterministic order: clauseId sort after dedup by id */
  const clauseById = new Map<string, DerivedRequirement>()
  for (const c of criteria) {
    const meaning = [c.criterion, c.description].filter((s) => s && s.length > 0).join(' — ')
    clauseById.set(`criterion:${c.id}`, {
      clauseId: `criterion:${c.id}`,
      criterionRef: c.id,
      requiredMeaning: meaning || c.criterion,
      deliveryClass: 'initial',
      readerPerspective: 'performer'
    })
  }
  const contextSources = new Map<string, Set<ContextBindingSource>>()
  for (const ctx of boundContexts) {
    const clauseId = `context:${ctx.id}`
    if (!clauseById.has(clauseId)) {
      clauseById.set(clauseId, {
        clauseId,
        contextId: ctx.id,
        requiredMeaning: ctx.path || `context ${ctx.id}`,
        deliveryClass: 'initial',
        readerPerspective: 'performer'
      })
    }
    const set = contextSources.get(ctx.id) ?? new Set<ContextBindingSource>()
    set.add(ctx.via)
    contextSources.set(ctx.id, set)
  }
  if (boundary.responsibility_statement) {
    clauseById.set(`coordination:responsibility:${boundary.id}`, {
      clauseId: `coordination:responsibility:${boundary.id}`,
      requiredMeaning: boundary.responsibility_statement,
      deliveryClass: 'initial',
      readerPerspective: 'coordination'
    })
  }
  for (const c of consumedContracts) {
    clauseById.set(`coordination:tension:${c.id}`, {
      clauseId: `coordination:tension:${c.id}`,
      requiredMeaning: `contract tension: ${c.name || c.id}`,
      deliveryClass: 'initial',
      readerPerspective: 'coordination'
    })
  }
  const contextRequirements = [...clauseById.values()].sort((a, b) =>
    a.clauseId.localeCompare(b.clauseId)
  )

  const responsibilityRefs = [
    `responsibility:${boundary.id}`,
    ...providedContracts.map((c) => `contract:${c.id}`)
  ]
  const invariantRefs = [
    ...nonGoals.map((g) => `non-goal:${g.id}`),
    ...consumedContracts.map((c) => `contract:${c.id}`)
  ]

  const maintenanceRefs: InterfaceMaintenanceRef[] = [
    { kind: 'model', id: modelVersion },
    { kind: 'boundary', id: boundary.id },
    ...criteria.map((c): InterfaceMaintenanceRef => ({ kind: 'criterion', id: c.id })),
    ...[...contextSources.keys()].sort().map((id): InterfaceMaintenanceRef => {
      const row = boundContexts.find((r) => r.id === id)!
      return { kind: 'context', id, path: row.path }
    }),
    ...[...providedContracts, ...consumedContracts].map((c): InterfaceMaintenanceRef => ({
      kind: 'contract',
      id: c.id
    })),
    ...nonGoals.map((g): InterfaceMaintenanceRef => ({ kind: 'non-goal', id: g.id }))
  ]

  return {
    modelVersion,
    roleId,
    contextRequirements,
    scope: {
      scopeOfJudgment: {
        roleId: role.id,
        roleName: role.name,
        boundaryId: boundary.id,
        boundaryName: boundary.name,
        horizontalRole: role.horizontal_role_name,
        summary: role.description,
        responsibility: boundary.responsibility_statement
      },
      responsibilityRefs,
      invariantRefs,
      maintenanceRefs
    }
  }
}

/** content-addressed digest — same interface content, same digest */
export function interfaceDigestOf(derived: DerivedInterface): RoleInterfaceDigest {
  return digestOf({
    modelVersion: derived.modelVersion,
    roleId: derived.roleId,
    contextRequirements: derived.contextRequirements,
    scope: derived.scope
  }) as RoleInterfaceDigest
}

/**
 * Map one flat derived requirement onto the contract's ContextRequirement.
 * The derived criterionRef is a bare criterion id already scoped by the
 * role's boundary (deriveInterface reads rdd_criteria for that boundary), so
 * the boundary id carried in the derived scope completes the contract's
 * {boundaryId, criterionId} CriterionRef.
 */
export function toContextRequirement(
  req: DerivedRequirement,
  boundaryId: string
): ContextRequirement {
  return {
    clauseId: req.clauseId,
    ...(req.contextId !== undefined ? { contextId: req.contextId } : {}),
    ...(req.criterionRef !== undefined
      ? { criterionRef: { boundaryId, criterionId: req.criterionRef } }
      : {}),
    requiredMeaning: req.requiredMeaning,
    deliveryClass: req.deliveryClass,
    readerPerspective: req.readerPerspective
  }
}

/** map a derived requirement list onto the contract's ContextRequirement[] */
export function toContextRequirements(
  requirements: readonly DerivedRequirement[],
  boundaryId: string
): ContextRequirement[] {
  return requirements.map((req) => toContextRequirement(req, boundaryId))
}

/** assemble the contract-facing RoleInterface view (canonical nested shape) */
export function toRoleInterface(derived: DerivedInterface): RoleInterface {
  const boundaryId = derived.scope.scopeOfJudgment.boundaryId
  return {
    digest: interfaceDigestOf(derived),
    modelVersion: derived.modelVersion as ModelVersionId,
    roleId: derived.roleId,
    requirements: {
      responsibilityRefs: derived.scope.responsibilityRefs,
      contextRequirements: toContextRequirements(derived.contextRequirements, boundaryId)
    },
    judgmentScope: {
      // the derived object's `summary` is role.description — the model's own
      // statement of the judgment scope; the full derived object stays in
      // InterfaceJudgmentScope for callers that need its structured detail
      scopeOfJudgment: derived.scope.scopeOfJudgment.summary,
      invariantRefs: derived.scope.invariantRefs
    }
  }
}

interface StoredInterfaceRow {
  digest: string
  model_version: string
  role_id: string
  requirements_json: string
  judgment_scope_json: string
}

/** load a stored snapshot by digest — undefined when unknown */
export function loadInterfaceByDigest(
  db: DatabaseSync,
  digest: string
):
  | { iface: RoleInterface; requirements: ContextRequirement[]; scope: InterfaceJudgmentScope }
  | undefined {
  const row = db
    .prepare(
      'SELECT digest, model_version, role_id, requirements_json, judgment_scope_json ' +
        'FROM role_interfaces WHERE digest = ?'
    )
    .get(digest) as unknown as StoredInterfaceRow | undefined
  if (row === undefined) return undefined
  const parsed = JSON.parse(row.requirements_json) as unknown
  const scope = JSON.parse(row.judgment_scope_json) as InterfaceJudgmentScope
  const boundaryId = scope.scopeOfJudgment.boundaryId
  const requirements = parseStoredRequirements(parsed, boundaryId)
  const storedRefs =
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Array.isArray((parsed as RoleInterfaceRequirements).responsibilityRefs)
      ? (parsed as RoleInterfaceRequirements).responsibilityRefs
      : scope.responsibilityRefs
  const iface: RoleInterface = {
    digest: row.digest as RoleInterfaceDigest,
    modelVersion: row.model_version as ModelVersionId,
    roleId: row.role_id,
    requirements: {
      responsibilityRefs: storedRefs,
      contextRequirements: requirements
    },
    judgmentScope: {
      scopeOfJudgment: scope.scopeOfJudgment.summary,
      invariantRefs: scope.invariantRefs
    }
  }
  return { iface, requirements, scope }
}

/**
 * Persist a derived snapshot — INSERT OR IGNORE: the digest IS the identity.
 * Returns { digest, stored } — `stored` false means the identical snapshot
 * was already recorded (content addressing makes recompute idempotent).
 */
function parseStoredRequirements(parsed: unknown, boundaryId: string): ContextRequirement[] {
  if (Array.isArray(parsed)) return toContextRequirements(parsed as DerivedRequirement[], boundaryId)
  if (parsed !== null && typeof parsed === 'object') {
    const o = parsed as RoleInterfaceRequirements
    if (Array.isArray(o.contextRequirements)) return o.contextRequirements
  }
  return []
}

function requirementsPayload(derived: DerivedInterface): RoleInterfaceRequirements {
  return {
    responsibilityRefs: derived.scope.responsibilityRefs,
    contextRequirements: toContextRequirements(
      derived.contextRequirements,
      derived.scope.scopeOfJudgment.boundaryId
    )
  }
}

export function storeInterfaceSnapshot(
  db: DatabaseSync,
  derived: DerivedInterface
): { digest: RoleInterfaceDigest; stored: boolean } {
  const digest = interfaceDigestOf(derived)
  const res = db
    .prepare(
      'INSERT OR IGNORE INTO role_interfaces (digest, model_version, role_id, requirements_json, judgment_scope_json) ' +
        'VALUES (?, ?, ?, ?, ?)'
    )
    .run(
      digest,
      derived.modelVersion,
      derived.roleId,
      canonicalJson(requirementsPayload(derived)),
      canonicalJson(derived.scope)
    )
  return { digest, stored: res.changes > 0 }
}

/* ------------------------------------------------------------------ *
 * interface.get  (C-REALIZATION — role 구현 담당자 / role.read)
 * ------------------------------------------------------------------ */

export interface InterfaceGetInput {
  modelVersion: string
  roleId: string
}

export interface InterfaceGetResult {
  interface: RoleInterface
  digest: RoleInterfaceDigest
  contextRequirements: ContextRequirement[]
  maintenanceRefs: InterfaceMaintenanceRef[]
  /** model status at read time — consumers decide freshness policy */
  modelStatus: string
}

/** admission target resolution — read-only, called by the registry pipeline */
export function interfaceGetTargets(_txn: TxnContext, payload: unknown): TargetRef[] {
  const p = asRecord(payload, 'interface.get payload')
  const targets: TargetRef[] = []
  if (typeof p['modelVersion'] === 'string') {
    targets.push({ kind: 'modelVersion', id: p['modelVersion'] })
  }
  if (typeof p['roleId'] === 'string') targets.push({ kind: 'role', id: p['roleId'] })
  return targets
}

/**
 * Compute-or-load the role's semantic interface snapshot and store it in
 * role_interfaces. NOT an RDD mutation: the snapshot is a derived, content-
 * addressed view; recomputation after model edits produces a NEW digest
 * (existing digests stay valid history for stale analysis).
 */
export function interfaceGet(txn: TxnContext, payload: unknown): InterfaceGetResult {
  const p = asRecord(payload, 'interface.get payload')
  const modelVersion = reqString(p, 'modelVersion')
  const roleId = reqString(p, 'roleId')

  const model = txn.db
    .prepare('SELECT status FROM model_versions WHERE id = ?')
    .get(modelVersion) as unknown as { status: string } | undefined
  if (model === undefined) {
    fail('MODEL_INVALID', `unknown model version ${modelVersion}`)
  }

  const derived = deriveInterface(txn.db, modelVersion, roleId)
  const { digest, stored } = storeInterfaceSnapshot(txn.db, derived)

  if (stored) {
    txn.emitEvent({
      aggregateId: digest,
      aggregateRevision: 1,
      eventType: 'interface.snapshot.stored',
      scope: { modelVersion, roleId },
      payload: { requirements: derived.contextRequirements.length }
    })
  }

  return {
    interface: toRoleInterface(derived),
    digest,
    contextRequirements: toContextRequirements(
      derived.contextRequirements,
      derived.scope.scopeOfJudgment.boundaryId
    ),
    maintenanceRefs: derived.scope.maintenanceRefs,
    modelStatus: model.status
  }
}
