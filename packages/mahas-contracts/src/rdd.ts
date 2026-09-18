// mahas-contracts — RDD: the responsibility-structure model (IMP-02).
//
// spec/domains/rdd.md §1 object table + spec/storage.md §3 DDL. A published
// ModelVersion is an immutable snapshot: `projects.active_model_version`
// points at the active one (REQ-02); JSON import/export is an API format,
// never a second writer. Field names follow the DDL columns in camelCase;
// `*_json` payload columns keep their spec object shape.
//
// Structural invariants carried by the types (REQ-03):
//   - every Boundary has exactly ONE responsibility statement
//   - every Boundary has ≥1 Criterion (no numeric pass thresholds)
//   - boundary_edges is a single-parent connected acyclic tree
//   - a Contract has one provider boundary and ≥1 consumer boundary

import type {
  EpochMillis,
  BoundaryId,
  CriterionId,
  ModelChangeId,
  NonGoalId,
  ProjectId,
  RddContextId,
  RddContractId,
  RoleId
} from './ids.ts'
import type { ModelVersionId, Revision } from './common.ts'

/** projects — model_versions is nullable until a first publish */
export interface Project {
  id: ProjectId
  name: string
  goal: string
  repositoryRoot: string
  /** null on drafts that have never published (root-less draft is legal) */
  activeModelVersion?: ModelVersionId | null
  revision: Revision
}

export type ModelVersionStatus = 'draft' | 'published' | 'superseded'

/** model_versions — published payload is immutable (S-COMMON §6) */
export interface ModelVersion {
  id: ModelVersionId
  projectId: ProjectId
  parentVersion?: ModelVersionId | null
  /** null while the draft has no root boundary; published requires exactly one */
  rootBoundaryId?: BoundaryId | null
  goalSnapshot: string
  status: ModelVersionStatus
  digest?: string | null
  createdAt: EpochMillis
}

/** rdd_boundaries — exactly one responsibility statement, never a list */
export interface Boundary {
  modelVersion: ModelVersionId
  id: BoundaryId
  name: string
  responsibilityStatement: string
}

/** rdd_criteria — ≥1 per boundary; criteria are review text, not thresholds */
export interface Criterion {
  modelVersion: ModelVersionId
  boundaryId: BoundaryId
  id: CriterionId
  criterion: string
  description: string
  ordinal: number
}

export type BoundaryPathKind = 'file' | 'directory'

/** boundary_paths — repo-relative territory index (NOT a security ACL,
 *  rdd.md §2). Registration is legal for files that do not exist yet. */
export interface BoundaryPath {
  modelVersion: ModelVersionId
  boundaryId: BoundaryId
  path: string
  kind: BoundaryPathKind
}

/** boundary_edges — the contains tree: ≤1 parent per child, acyclic */
export interface BoundaryEdge {
  modelVersion: ModelVersionId
  childId: BoundaryId
  parentId: BoundaryId
}

/** horizontal_roles — name + specialist guidance only; no grant/agent config */
export interface HorizontalRole {
  modelVersion: ModelVersionId
  name: string
}

/** rdd_roles — description is the professional duty for joint-responsibility
 *  formation; it is not a task instruction (rdd.md §1) */
export interface Role {
  modelVersion: ModelVersionId
  id: RoleId
  name: string
  description: string
  boundaryId: BoundaryId
  horizontalRoleName: string
}

/** rdd_contexts — the id is storage identity; the body canonical source is
 *  the file at `path` (rdd.md §1, REQ-22) */
export interface RddContext {
  modelVersion: ModelVersionId
  id: RddContextId
  path: string
}

/** boundary_contexts — reusable-guidance link for one territory */
export interface BoundaryContext {
  modelVersion: ModelVersionId
  boundaryId: BoundaryId
  contextId: RddContextId
}

/** horizontal_contexts — specialist-guidance link for one horizontal role */
export interface HorizontalContext {
  modelVersion: ModelVersionId
  horizontalRoleName: string
  contextId: RddContextId
}

/** rdd_contracts — schemaPath anchors the I/O promise's canonical location */
export interface RddContract {
  modelVersion: ModelVersionId
  id: RddContractId
  name: string
  schemaPath: string
  providerBoundaryId: BoundaryId
}

/** contract_consumers — consumer side of a contract; there is no duplicated
 *  "dependency" field (rdd.md §1) */
export interface ContractConsumer {
  modelVersion: ModelVersionId
  contractId: RddContractId
  consumerBoundaryId: BoundaryId
}

/** rdd_non_goals — placed on a real boundary; never an "unassigned" label
 *  masquerading as responsibility structure */
export interface NonGoal {
  modelVersion: ModelVersionId
  id: NonGoalId
  boundaryId: BoundaryId
  statement: string
}

/* ── model.change prepared candidates (rdd.md §3) ─────────────────────── */

export type ModelChangeState = 'prepared' | 'committed' | 'rejected'

/** target kinds a typed edit may touch */
export type ModelChangeTargetKind =
  'boundary' | 'contract' | 'role' | 'horizontalRole' | 'context' | 'nonGoal' | 'goal'

/** one entry of touched_targets_json — the actual changed relations, e.g.
 *  reparent records old parent + new parent + the moved subtree (rdd.md §3) */
export interface ModelChangeTarget {
  kind: ModelChangeTargetKind
  id: string
  /** optional note on the actual relation that changed */
  relation?: string
}

export type DiagnosticSeverity = 'info' | 'warning' | 'error'

/** one entry of diagnostics_json — tree/FK/criterion violations and
 *  `ambiguous` territory findings (rdd.md §2) */
export interface ModelDiagnostic {
  code: string
  severity: DiagnosticSeverity
  message: string
  targets?: ModelChangeTarget[]
}

/**
 * Typed edits inside one model.change candidate (rdd.md §3). These are
 * ChangeSet operations — they are NOT exposed as global admin commands.
 * Discriminated on `type`; each member carries exactly the fields that edit
 * needs (split explicitly remaps children/roles/contracts, reparent records
 * the moved subtree in touchedTargets).
 */
export type ModelChangeEdit =
  | {
      type: 'boundary.create'
      boundaryId: BoundaryId
      name: string
      responsibilityStatement: string
      paths?: BoundaryPath[]
      parentBoundaryId?: BoundaryId
    }
  | {
      type: 'boundary.revise'
      boundaryId: BoundaryId
      name?: string
      responsibilityStatement?: string
      paths?: BoundaryPath[]
    }
  | {
      type: 'boundary.split'
      boundaryId: BoundaryId
      /** new children with their own responsibility/criteria/paths/role and
       *  contract remapping — the split is incomplete without them */
      children: {
        boundaryId: BoundaryId
        name: string
        responsibilityStatement: string
        paths?: BoundaryPath[]
      }[]
      contractRemap?: Record<RddContractId, BoundaryId>
      roleRemap?: Record<RoleId, BoundaryId>
    }
  | {
      type: 'boundary.reparent'
      boundaryId: BoundaryId
      newParentBoundaryId: BoundaryId
    }
  | { type: 'boundary.retire'; boundaryId: BoundaryId }
  | {
      type: 'contract.bind'
      contractId: RddContractId
      name: string
      schemaPath: string
      providerBoundaryId: BoundaryId
      consumerBoundaryIds: BoundaryId[]
    }
  | {
      type: 'contract.revise'
      contractId: RddContractId
      name?: string
      schemaPath?: string
      providerBoundaryId?: BoundaryId
      consumerBoundaryIds?: BoundaryId[]
    }
  | { type: 'contract.retire'; contractId: RddContractId }
  | {
      type: 'role.define'
      roleId: RoleId
      name: string
      description: string
      boundaryId: BoundaryId
      horizontalRoleName: string
    }
  | {
      type: 'role.revise'
      roleId: RoleId
      name?: string
      description?: string
      boundaryId?: BoundaryId
      horizontalRoleName?: string
    }
  | { type: 'role.retire'; roleId: RoleId }
  | { type: 'horizontalRole.revise'; horizontalRoleName: string }
  | { type: 'context.register'; contextId: RddContextId; path: string }
  | {
      type: 'context.link'
      contextId: RddContextId
      boundaryId?: BoundaryId
      horizontalRoleName?: string
    }
  | {
      type: 'context.unlink'
      contextId: RddContextId
      boundaryId?: BoundaryId
      horizontalRoleName?: string
    }
  | { type: 'goal.revise'; goal: string }
  | {
      type: 'nonGoal.revise'
      nonGoalId: NonGoalId
      statement: string
      boundaryId: BoundaryId
    }

/** model_changes — a prepared candidate; commit is a CAS on baseVersion +
 *  candidateDigest and publishes the whole snapshot in one transaction */
export interface ModelChange {
  id: ModelChangeId
  projectId: ProjectId
  baseVersion: ModelVersionId
  candidateDigest: string
  state: ModelChangeState
  edits: ModelChangeEdit[]
  touchedTargets: ModelChangeTarget[]
  diagnostics: ModelDiagnostic[]
}

/** role_search_rows — regenerable projection built in the SAME transaction
 *  as the publication (rdd.md §4); never an independent source of truth */
export interface SearchRow {
  modelVersion: ModelVersionId
  roleId: RoleId
  normalizedText: string
}
