// realization/implementation-repository.ts — role_implementations storage.
//
// Publication lifecycle (C-REALIZATION + instruction §4.2/§4.4):
//
//   candidate  (implementation.prepare stores graph+diagnostics)
//      │  implementation.publish — ONE tx: verify stored content, flip
//      ▼  status, pin semanticDecision — no content is written at publish
//   published  — immutable: this module exposes NO update path for a
//      │         published row's content (revision identity is the pin)
//      ▼  implementation.retire — status only; rows/bundles never deleted
//   retired
//
// revision semantics: an implementation family (id) may carry several
// revisions — rev 1 published, rev 2 candidate, rev 2 later published —
// each revision's stored content is fixed at its own row set. There is no
// "latest" rewrite: consumers pin (implementationId, revision) exactly.

import type { DatabaseSync } from 'node:sqlite'
import type {
  ImplementationRevision,
  RoleInterfaceDigest
} from '../../../mahas-contracts/src/common.ts'
import type {
  ImplementationComponent,
  RoleImplementation
} from '../../../mahas-contracts/src/role.ts'
import {
  bindingsByComponent,
  componentBindingJson,
  componentFromRow,
  type ComponentGraphInput,
  type ComponentInput,
  type CoverageBindingInput,
  type MaintenanceBindingInput
} from './component-graph.ts'
import { canonicalJson, digestOf, fail, mintId } from './util.ts'

export type ImplementationStatus = 'candidate' | 'published' | 'retired'

interface ImplementationRow {
  id: string
  revision: number
  interface_digest: string
  profile_id: string
  profile_revision: number
  status: string
  maintainer_role_id: string
  semantic_decision: string | null
}

interface ComponentRow {
  id: string
  kind: string
  activation: string
  binding_json: string
  consumes_json: string
  coverage_json: string
}

interface MaintenanceRow {
  id: string
  basis_ref_json: string
  component_ref_json: string
}

/** stored candidate/implementation content — the publish-verified pin set */
export interface StoredImplementation {
  implementationId: string
  revision: number
  interfaceDigest: string
  profileId: string
  profileRevision: number
  status: ImplementationStatus
  maintainerRoleId: string
  semanticDecision: unknown | null
  components: ComponentInput[]
  coverageBindings: CoverageBindingInput[]
  maintenanceBindings: MaintenanceBindingInput[]
}

/**
 * Content digest of one stored revision — covers exactly the fields the
 * author pinned at prepare time (interface, profile pair, maintainer,
 * components, coverage, maintenance bindings). semanticDecision is excluded:
 * it is the publish-time declaration ABOUT this content, not part of it.
 */
export function implementationContentDigest(s: {
  interfaceDigest: string
  profileId: string
  profileRevision: number
  maintainerRoleId: string
  components: ComponentInput[]
  coverageBindings: CoverageBindingInput[]
  maintenanceBindings: MaintenanceBindingInput[]
}): string {
  const components = [...s.components]
    .map((c) => ({ ...c }))
    .sort((a, b) => a.componentId.localeCompare(b.componentId))
  const coverageBindings = [...s.coverageBindings].sort(
    (a, b) =>
      a.clauseId.localeCompare(b.clauseId) ||
      a.componentId.localeCompare(b.componentId) ||
      a.sectionKey.localeCompare(b.sectionKey)
  )
  const maintenanceBindings = [...s.maintenanceBindings].sort((a, b) =>
    a.bindingId.localeCompare(b.bindingId)
  )
  return digestOf({
    interfaceDigest: s.interfaceDigest,
    profileId: s.profileId,
    profileRevision: s.profileRevision,
    maintainerRoleId: s.maintainerRoleId,
    components,
    coverageBindings,
    maintenanceBindings
  })
}

function loadComponentRows(db: DatabaseSync, id: string, revision: number): ComponentRow[] {
  return db
    .prepare(
      'SELECT id, kind, activation, binding_json, consumes_json, coverage_json ' +
        'FROM implementation_components WHERE implementation_id = ? AND implementation_revision = ? ' +
        'ORDER BY id'
    )
    .all(id, revision) as unknown as ComponentRow[]
}

function loadMaintenanceRows(db: DatabaseSync, id: string, revision: number): MaintenanceRow[] {
  return db
    .prepare(
      'SELECT id, basis_ref_json, component_ref_json FROM maintenance_bindings ' +
        'WHERE implementation_id = ? AND implementation_revision = ? ORDER BY id'
    )
    .all(id, revision) as unknown as MaintenanceRow[]
}

function rowToStored(db: DatabaseSync, row: ImplementationRow): StoredImplementation {
  const components: ComponentInput[] = []
  const coverageBindings: CoverageBindingInput[] = []
  for (const cr of loadComponentRows(db, row.id, row.revision)) {
    const { component, bindings } = componentFromRow(cr)
    components.push(component)
    coverageBindings.push(...bindings)
  }
  const maintenanceBindings = loadMaintenanceRows(db, row.id, row.revision).map((m) => ({
    bindingId: m.id,
    basisRef: JSON.parse(m.basis_ref_json) as unknown,
    componentRef: JSON.parse(m.component_ref_json) as { componentId: string; sectionKey?: string }
  }))
  return {
    implementationId: row.id,
    revision: row.revision,
    interfaceDigest: row.interface_digest,
    profileId: row.profile_id,
    profileRevision: row.profile_revision,
    status: row.status as ImplementationStatus,
    maintainerRoleId: row.maintainer_role_id,
    semanticDecision:
      row.semantic_decision === null ? null : (JSON.parse(row.semantic_decision) as unknown),
    components,
    coverageBindings,
    maintenanceBindings
  }
}

/** load any revision row — undefined when (id, revision) is unknown */
export function loadImplementation(
  db: DatabaseSync,
  implementationId: string,
  revision: number
): StoredImplementation | undefined {
  const row = db
    .prepare(
      'SELECT id, revision, interface_digest, profile_id, profile_revision, status, ' +
        'maintainer_role_id, semantic_decision FROM role_implementations ' +
        'WHERE id = ? AND revision = ?'
    )
    .get(implementationId, revision) as unknown as ImplementationRow | undefined
  return row === undefined ? undefined : rowToStored(db, row)
}

/** contract-facing view of a stored revision */
export function toRoleImplementation(s: StoredImplementation): RoleImplementation {
  return {
    implementationId: s.implementationId,
    revision: s.revision as ImplementationRevision,
    interfaceDigest: s.interfaceDigest as RoleInterfaceDigest,
    harnessProfileId: s.profileId,
    profileRevision: s.profileRevision,
    status: s.status,
    maintainerRoleId: s.maintainerRoleId,
    componentGraph: {
      components: s.components as unknown as ImplementationComponent[],
      coverageBindings: s.coverageBindings
    },
    coverageBindings: s.coverageBindings,
    semanticDecision: s.semanticDecision
  } as unknown as RoleImplementation
}

/** revisions of one family, newest first — for discovery/listing consumers */
export function listImplementationRevisions(
  db: DatabaseSync,
  implementationId: string
): StoredImplementation[] {
  const rows = db
    .prepare(
      'SELECT id, revision, interface_digest, profile_id, profile_revision, status, ' +
        'maintainer_role_id, semantic_decision FROM role_implementations ' +
        'WHERE id = ? ORDER BY revision DESC'
    )
    .all(implementationId) as unknown as ImplementationRow[]
  return rows.map((r) => rowToStored(db, r))
}

/** all revisions bound to one interface digest — IMP-06/IMP-08 read path */
export function listByInterface(
  db: DatabaseSync,
  interfaceDigest: string,
  opts: { status?: ImplementationStatus } = {}
): StoredImplementation[] {
  const rows = (opts.status === undefined
    ? db
        .prepare(
          'SELECT id, revision, interface_digest, profile_id, profile_revision, status, ' +
            'maintainer_role_id, semantic_decision FROM role_implementations ' +
            'WHERE interface_digest = ? ORDER BY id, revision'
        )
        .all(interfaceDigest)
    : db
        .prepare(
          'SELECT id, revision, interface_digest, profile_id, profile_revision, status, ' +
            'maintainer_role_id, semantic_decision FROM role_implementations ' +
            'WHERE interface_digest = ? AND status = ? ORDER BY id, revision'
        )
        .all(interfaceDigest, opts.status)) as unknown as ImplementationRow[]
  return rows.map((r) => rowToStored(db, r))
}

/* ------------------------------------------------------------------ *
 * writes
 * ------------------------------------------------------------------ */

export interface StoreCandidateInput {
  interfaceDigest: string
  profileId: string
  profileRevision: number
  maintainerRoleId: string
  graph: ComponentGraphInput
  /** continue an existing implementation family instead of minting a new id */
  baseImplementationId?: string
}

/**
 * Store a prepared candidate: role_implementations(status='candidate') +
 * implementation_components + maintenance_bindings, in the caller's tx.
 * Candidate revision = next free revision of the family id. Returns the
 * coordinates + content digest the publish step must echo back.
 */
export function storeCandidate(
  db: DatabaseSync,
  input: StoreCandidateInput
): { implementationId: string; revision: number; candidateDigest: string } {
  const implementationId = input.baseImplementationId ?? mintId('impl')
  const maxRow = db
    .prepare('SELECT MAX(revision) AS m FROM role_implementations WHERE id = ?')
    .get(implementationId) as unknown as { m: number | null }
  const revision = (maxRow.m ?? 0) + 1

  const candidateDigest = implementationContentDigest({
    interfaceDigest: input.interfaceDigest,
    profileId: input.profileId,
    profileRevision: input.profileRevision,
    maintainerRoleId: input.maintainerRoleId,
    components: input.graph.components,
    coverageBindings: input.graph.coverageBindings,
    maintenanceBindings: input.graph.maintenanceBindings ?? []
  })

  db.prepare(
    'INSERT INTO role_implementations (id, revision, interface_digest, profile_id, ' +
      'profile_revision, status, maintainer_role_id, semantic_decision) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, NULL)'
  ).run(
    implementationId,
    revision,
    input.interfaceDigest,
    input.profileId,
    input.profileRevision,
    'candidate',
    input.maintainerRoleId
  )

  const byComponent = bindingsByComponent(input.graph)
  const insertComponent = db.prepare(
    'INSERT INTO implementation_components (implementation_id, implementation_revision, id, ' +
      'kind, activation, binding_json, consumes_json, coverage_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (const c of input.graph.components) {
    insertComponent.run(
      implementationId,
      revision,
      c.componentId,
      c.kind,
      JSON.stringify(c.activation),
      componentBindingJson(c),
      JSON.stringify(c.consumes),
      canonicalJson(byComponent.get(c.componentId) ?? [])
    )
  }

  const insertMaintenance = db.prepare(
    'INSERT INTO maintenance_bindings (implementation_id, implementation_revision, id, ' +
      'basis_ref_json, component_ref_json) VALUES (?, ?, ?, ?, ?)'
  )
  for (const m of input.graph.maintenanceBindings ?? []) {
    insertMaintenance.run(
      implementationId,
      revision,
      m.bindingId,
      canonicalJson(m.basisRef),
      canonicalJson(m.componentRef)
    )
  }

  return { implementationId, revision, candidateDigest }
}

/**
 * Activate a stored candidate — the ONLY candidate→published transition.
 * Flips status and pins semanticDecision in the caller's tx; component rows
 * are already stored, so "store all components+coverage then activate" is
 * literally one UPDATE inside the operation's transaction.
 */
export function activateCandidate(
  db: DatabaseSync,
  implementationId: string,
  revision: number,
  semanticDecision: unknown
): void {
  const res = db
    .prepare(
      "UPDATE role_implementations SET status = 'published', semantic_decision = ? " +
        "WHERE id = ? AND revision = ? AND status = 'candidate'"
    )
    .run(canonicalJson(semanticDecision), implementationId, revision)
  if (res.changes === 0) {
    fail(
      'INVALID_TRANSITION',
      `implementation ${implementationId}@${revision} is not a stored candidate`
    )
  }
}

/**
 * published → retired. Status-only transition: bundles, snapshots and
 * running executions keep their pins (contract: 기존 snapshot 파괴 금지,
 * 진행 execution pin 유지). The `reason` rides the domain event, not the row.
 */
export function markRetired(db: DatabaseSync, implementationId: string, revision: number): void {
  const res = db
    .prepare(
      "UPDATE role_implementations SET status = 'retired' " +
        "WHERE id = ? AND revision = ? AND status = 'published'"
    )
    .run(implementationId, revision)
  if (res.changes === 0) {
    fail(
      'INVALID_TRANSITION',
      `implementation ${implementationId}@${revision} is not a published revision`
    )
  }
}

export interface ReferencingExecution {
  executionId: string
  memberId: string
  state: string
  liveness: string
}

/**
 * Executions still pinned to (id, revision) through their member — retire
 * reports these so the coordinator sees what keeps running; nothing here is
 * stopped or unpinned.
 */
export function referencingExecutions(
  db: DatabaseSync,
  implementationId: string,
  revision: number
): ReferencingExecution[] {
  const rows = db
    .prepare(
      'SELECT e.id AS execution_id, m.id AS member_id, e.state AS state, e.liveness AS liveness ' +
        'FROM members m JOIN executions e ON e.member_id = m.id ' +
        'WHERE m.implementation_id = ? AND m.implementation_revision = ? ' +
        "AND e.liveness IN ('live','unverifiable') ORDER BY e.id"
    )
    .all(implementationId, revision) as unknown as Array<{
    execution_id: string
    member_id: string
    state: string
    liveness: string
  }>
  return rows.map((r) => ({
    executionId: r.execution_id,
    memberId: r.member_id,
    state: r.state,
    liveness: r.liveness
  }))
}
