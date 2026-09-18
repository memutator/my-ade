// mahas-runtime/model — the atomic publication write (D-RDD §3, C-MODEL
// model.change.commit).
//
// Publication is ONE write transaction covering, in order:
//   1. active-pointer CAS — projects.active_model_version must still equal
//      the caller's expectedActiveVersion (STALE_REVISION otherwise)
//   2. the new model_versions row + the entire rdd_* payload
//      (boundaries/criteria/edges/roles/contexts/contracts/consumers/
//      non-goals) — a NEW revision, never a mutation of published rows
//   3. the previous published version → 'superseded'
//   4. role_search_rows/fts projection rebuild — IMP-05's synchronous
//      publication port (writeSearchProjection) runs inside this same tx
//   5. stale-review candidate intents — IMP-05's computeModelImpact diffs
//      the base/published row sets and writes impact_candidates with
//      deterministic ids (replay-safe)
//   6. the ModelPublished domain event + the committed model_changes row
//
// The registry wraps the handler call in the write tx and stores the
// CommandReceipt — everything below happens inside that tx or not at all.

import type { DatabaseSync } from 'node:sqlite'
import { appendDomainEvent, sha256Hex } from '../storage/db.ts'
import type { ModelVersionId } from '../../../mahas-contracts/src/common.ts'
import type { Project } from '../../../mahas-contracts/src/rdd.ts'
import type { Diagnostic } from './structural-rules.ts'
import { computeModelImpact, type ModelImpactResult } from './impact-candidates.ts'
import { writeSearchProjection } from './indices.ts'
import {
  canonicalJson,
  casActiveModelVersion,
  changeFields,
  insertSnapshot,
  loadModelVersion,
  rootBoundaryIdOf,
  setVersionStatus,
  snapshotDigest,
  updateModelChange,
  type ModelSnapshot,
  type StoredModelChange
} from './repository.ts'
import { mahasError, type ModelEdit } from './change-set.ts'

/* ------------------------------------------------------------------ */
/* digests                                                             */
/* ------------------------------------------------------------------ */

/**
 * candidateDigest binds base + ordered edits + the materialized result. The
 * same inputs always reproduce the same digest, so commit can recompute it
 * from the stored edits and prove the candidate was not mutated.
 */
export function computeCandidateDigest(
  baseVersion: string,
  edits: ModelEdit[],
  snapshot: ModelSnapshot
): { candidateDigest: string; snapshotDigest: string } {
  const sDigest = snapshotDigest(snapshot)
  const candidateDigest = sha256Hex(
    canonicalJson({ baseVersion, edits: edits as unknown[], snapshotDigest: sDigest })
  )
  return { candidateDigest, snapshotDigest: sDigest }
}

/* ------------------------------------------------------------------ */
/* ModelPublished — the publication event payload (§6 deliverable)     */
/* ------------------------------------------------------------------ */

export interface ModelPublishedPayload {
  projectId: string
  modelVersion: string
  parentVersion: string | null
  changeId: string
  baseVersion: string
  digest: string
  rootBoundaryId: string
  goalSnapshot: string
  counts: {
    boundaries: number
    criteria: number
    paths: number
    contracts: number
    roles: number
    horizontalRoles: number
    contexts: number
    nonGoals: number
  }
  /** batch identity of the stale-review candidates written in the same tx */
  impactBatchId: string
  impact: { candidateIds: string[]; counts: Record<string, number> }
  /** proof the synchronous search projection was rebuilt for THIS version */
  searchProjection: { kind: 'role_search_rows'; roleCount: number }
  semanticReviewItems: Diagnostic[]
  semanticDecision: string
  publishedAt: number
}

export const MODEL_PUBLISHED_EVENT = 'ModelPublished'
export const MODEL_CHANGE_PREPARED_EVENT = 'ModelChangePrepared'
export const PROJECT_REGISTERED_EVENT = 'ProjectRegistered'

/* ------------------------------------------------------------------ */
/* the publish write                                                   */
/* ------------------------------------------------------------------ */

export interface PublishInput {
  project: Project
  change: StoredModelChange
  /** re-materialized candidate — caller has already re-verified its digest */
  snapshot: ModelSnapshot
  snapshotDigest: string
  expectedActiveVersion: string | null
  semanticDecision: string
  semanticReviewItems: Diagnostic[]
  now: number
  newVersionId: string
}

export interface PublishResult {
  publishedVersion: string
  digest: string
  impactBatchId: string
  impact: ModelImpactResult
  searchRoleCount: number
}

/**
 * Write the published model atomically. MUST be called inside the caller's
 * write transaction (withTx / the registry dispatch tx).
 */
export function publishCandidate(db: DatabaseSync, input: PublishInput): PublishResult {
  const { project, change, snapshot } = input
  const cf = changeFields(change)

  const rootBoundaryId = rootBoundaryIdOf(snapshot)
  if (rootBoundaryId === null) {
    // caller runs validateCandidate first — reaching here is a logic bug,
    // but publish never proceeds without a single root regardless
    throw mahasError('MODEL_INVALID', 'publish requires exactly one root boundary')
  }

  // 1. active-pointer CAS — the optimistic-concurrency check on the CURRENT
  //    base (D-RDD: "commit은 현재 base CAS")
  const swapped = casActiveModelVersion(
    db,
    project.id,
    input.expectedActiveVersion,
    input.newVersionId,
    snapshot.goal
  )
  if (!swapped) {
    throw mahasError(
      'STALE_REVISION',
      `active model for project ${project.id} is no longer ${input.expectedActiveVersion ?? '(none)'} — re-prepare on the current base`,
      'reconcile',
      { expectedActiveVersion: input.expectedActiveVersion }
    )
  }

  // 2. whole new version payload — new rows, never an update of published ones
  const baseRow = loadModelVersion(db, cf.baseVersion)
  insertSnapshot(
    db,
    input.newVersionId,
    project.id,
    cf.baseVersion,
    snapshot,
    'published',
    input.now
  )

  // 3. previous published version retires to 'superseded'
  if (baseRow !== null && (baseRow as { status?: string }).status === 'published') {
    setVersionStatus(db, cf.baseVersion, 'superseded')
  }

  // 4. synchronous search-projection rebuild for THIS version (IMP-05 port)
  const { roleCount } = writeSearchProjection(db, input.newVersionId as ModelVersionId)

  // 5. stale-review candidate intents — deterministic ids; a replayed commit
  //    is a no-op (INSERT OR IGNORE inside computeModelImpact)
  const impact = computeModelImpact(db, {
    baseVersion: cf.baseVersion as ModelVersionId,
    newVersion: input.newVersionId as ModelVersionId,
    changeRef: cf.id
  })

  // 6. change row → committed, carrying the maintainer's semantic decision
  const priorDiagnostics =
    cf.diagnostics !== null && typeof cf.diagnostics === 'object'
      ? (cf.diagnostics as Record<string, unknown>)
      : {}
  updateModelChange(db, cf.id, 'committed', {
    ...priorDiagnostics,
    semanticDecision: { decision: input.semanticDecision, at: input.now },
    publishedVersion: input.newVersionId
  })

  // 7. ModelPublished domain event — aggregate = project, revision = the
  //    project revision after the CAS bump
  const projectRevision = projectRevisionAfter(project)
  const payload: ModelPublishedPayload = {
    projectId: project.id,
    modelVersion: input.newVersionId,
    parentVersion: cf.baseVersion,
    changeId: cf.id,
    baseVersion: cf.baseVersion,
    digest: input.snapshotDigest,
    rootBoundaryId,
    goalSnapshot: snapshot.goal,
    counts: {
      boundaries: snapshot.boundaries.size,
      criteria: [...snapshot.boundaries.values()].reduce((n, b) => n + b.criteria.length, 0),
      paths: [...snapshot.boundaries.values()].reduce((n, b) => n + b.paths.length, 0),
      contracts: snapshot.contracts.size,
      roles: snapshot.roles.size,
      horizontalRoles: snapshot.horizontalRoles.size,
      contexts: snapshot.contexts.size,
      nonGoals: snapshot.nonGoals.size
    },
    impactBatchId: impact.changeRef,
    impact: {
      candidateIds: impact.candidateIds.map((x) => x as string),
      counts: impact.counts as Record<string, number>
    },
    searchProjection: { kind: 'role_search_rows', roleCount },
    semanticReviewItems: input.semanticReviewItems,
    semanticDecision: input.semanticDecision,
    publishedAt: input.now
  }
  appendDomainEvent(
    db,
    project.id,
    projectRevision,
    MODEL_PUBLISHED_EVENT,
    { projectId: project.id, modelVersion: input.newVersionId },
    payload
  )

  return {
    publishedVersion: input.newVersionId,
    digest: input.snapshotDigest,
    impactBatchId: impact.changeRef,
    impact,
    searchRoleCount: roleCount
  }
}

function projectRevisionAfter(project: Project): number {
  const rev = (project as { revision?: number }).revision
  return (typeof rev === 'number' ? rev : 0) + 1
}
