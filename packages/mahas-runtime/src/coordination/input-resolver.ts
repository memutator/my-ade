// mahas-runtime / coordination — the pinnedInput port.
//
// IMP-14 (dispatch side of C-WORK). Resolves a TaskSpec's inputBindings into
// dispatch-time pins. The one rule that matters (D-WORK §4, instruction §4.2):
// a future task-output is ready ONLY when an exact ArtifactRef exists for the
// required output slot — "the producer finished" is not evidence. Concretely
// that means: an outcomes row for the producer task, with an ACCEPTING
// settlement on that outcome revision, and an outcome_outputs row binding the
// required slot to an existing artifact revision. Anything less stays
// unresolved and a required unresolved input fails dispatch start with
// INPUT_NOT_READY (it is a normal pending condition, not a fault).
//
// Consumers never read a producer's live directory: resolution always lands
// on an immutable artifacts(id,revision) row.
//
// Storage contract: spec/storage.md §3 — artifacts, outcomes, outcome_outputs,
// settlements (read-only here), rdd_contracts (contract binding existence).

import type { DatabaseSync } from 'node:sqlite'
import { fail } from './internal.ts'
import type { ArtifactRef } from '../../../mahas-contracts/src/common.ts'

/**
 * Settlement decisions that count as "the output is accepted and may be
 * consumed downstream". The spec does not enumerate the decision vocabulary;
 * 'accepted' is the task-state literal used across D-WORK/D-MAIL. Exported so
 * IMP-21 (outcome.decide) writes the same literal — align in integration if
 * the settlement owner picks a different canonical string.
 */
export const ACCEPTING_DECISIONS: readonly string[] = ['accepted', 'accept']

// ── binding wire shape ──────────────────────────────────────────────────────
//
// InputBinding objects arrive as JSON (task_specs.inputs_json). The canonical
// TS shape lands with IMP-02; this is the structural contract we resolve:
//
//   { slot: string, kind: 'artifact' | 'task-output' | 'contract',
//     required?: boolean                       // default true
//     // kind 'artifact'    → artifactId, artifactRevision? (absent = latest)
//     // kind 'task-output' → taskId (producer), outputSlot, taskRevision?
//     // kind 'contract'    → contractId, revision?, modelVersion?
//   }

export type BindingKind = 'artifact' | 'task-output' | 'contract'

export interface BindingSpec {
  slot: string
  kind: BindingKind
  required: boolean
  artifactId?: string
  artifactRevision?: number
  taskId?: string
  taskRevision?: number
  outputSlot?: string
  contractId?: string
  contractRevision?: number
  modelVersion?: string
}

export interface PinnedInput {
  slot: string
  kind: BindingKind
  required: boolean
  status: 'pinned'
  /** present for artifact + task-output pins */
  artifactRef?: ArtifactRef
  /** present for contract pins */
  contractRef?: { contractId: string; revision?: number; modelVersion?: string }
  /** provenance for task-output pins — which accepted outcome satisfied it */
  source?: { taskId: string; taskRevision: number; outcomeId: string; outcomeRevision: number }
}

export interface UnresolvedInput {
  slot: string
  kind: BindingKind
  required: boolean
  status: 'unresolved'
  reason: string
}

export type ResolvedInput = PinnedInput | UnresolvedInput

export function parseBinding(raw: unknown): BindingSpec {
  if (typeof raw !== 'object' || raw === null)
    fail('MODEL_INVALID', 'input binding is not an object', 'none', { raw })
  const b = raw as Record<string, unknown>
  const identity =
    b.identity !== null && typeof b.identity === 'object' && !Array.isArray(b.identity)
      ? (b.identity as Record<string, unknown>)
      : {}
  const slot =
    typeof b.slot === 'string' && b.slot
      ? b.slot
      : fail('MODEL_INVALID', 'input binding missing slot', 'none', { raw })
  const kind =
    b.kind === 'artifact' || b.kind === 'task-output' || b.kind === 'contract'
      ? b.kind
      : fail('MODEL_INVALID', `input binding ${slot} has unknown kind`, 'none', { raw })
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) ? v : undefined
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  return {
    slot,
    kind,
    required: b.required === false ? false : true,
    artifactId: str(b.artifactId) ?? str(identity.artifactId),
    artifactRevision: num(b.artifactRevision) ?? num(identity.revision) ?? num(identity.artifactRevision),
    taskId: str(b.taskId) ?? str(identity.taskId) ?? str(identity.fromTaskId) ?? str(identity.task),
    taskRevision: num(b.taskRevision) ?? num(identity.taskRevision),
    outputSlot: str(b.outputSlot) ?? str(identity.outputSlot) ?? str(identity.output),
    contractId: str(b.contractId) ?? str(identity.contractId) ?? str(identity.id),
    contractRevision: num(b.contractRevision ?? b.revision ?? identity.revision),
    modelVersion: str(b.modelVersion) ?? str(identity.modelVersion)
  }
}

/** persist as the contract's top-level InputBinding (no nested identity) */
export function encodeBinding(b: BindingSpec): Record<string, unknown> {
  return {
    slot: b.slot,
    kind: b.kind,
    required: b.required,
    ...(b.artifactId !== undefined ? { artifactId: b.artifactId } : {}),
    ...(b.artifactRevision !== undefined ? { artifactRevision: b.artifactRevision } : {}),
    ...(b.taskId !== undefined ? { taskId: b.taskId } : {}),
    ...(b.taskRevision !== undefined ? { taskRevision: b.taskRevision } : {}),
    ...(b.outputSlot !== undefined ? { outputSlot: b.outputSlot } : {}),
    ...(b.contractId !== undefined ? { contractId: b.contractId } : {}),
    ...(b.contractRevision !== undefined ? { contractRevision: b.contractRevision } : {}),
    ...(b.modelVersion !== undefined ? { modelVersion: b.modelVersion } : {})
  }
}

// ── resolution ──────────────────────────────────────────────────────────────

interface ArtifactRow {
  id: string
  revision: number
  digest: string
  run_id?: string
}

function loadArtifact(db: DatabaseSync, artifactId: string, revision?: number): ArtifactRow | null {
  const row =
    revision === undefined
      ? (db
          .prepare(
            'SELECT id, revision, digest, run_id FROM artifacts WHERE id = ? ORDER BY revision DESC LIMIT 1'
          )
          .get(artifactId) as ArtifactRow | undefined)
      : (db
          .prepare(
            'SELECT id, revision, digest, run_id FROM artifacts WHERE id = ? AND revision = ?'
          )
          .get(artifactId, revision) as ArtifactRow | undefined)
  return row ?? null
}

/**
 * The exact-artifact lookup for a future task-output: latest outcome of the
 * producer task that (a) carries an ACCEPTING settlement on the same outcome
 * revision and (b) binds the required output slot to a real artifact row.
 * Producer liveness/state is deliberately not consulted.
 */
function resolveTaskOutput(
  db: DatabaseSync,
  b: BindingSpec,
  consumerRunId?: string
): {
  artifact: ArtifactRow
  outcomeId: string
  outcomeRevision: number
  taskRevision: number
} | null {
  const decisions = ACCEPTING_DECISIONS.map(() => '?').join(',')
  const revFilter = b.taskRevision === undefined ? '' : ' AND o.task_revision = ?'
  const runFilter = consumerRunId === undefined ? '' : ' AND t.run_id = ? AND a.run_id = ?'
  const params: (string | number)[] = [b.taskId!, b.outputSlot!, ...ACCEPTING_DECISIONS]
  if (b.taskRevision !== undefined) params.push(b.taskRevision)
  if (consumerRunId !== undefined) {
    params.push(consumerRunId, consumerRunId)
  }
  const row = db
    .prepare(
      'SELECT a.id AS a_id, a.revision AS a_rev, a.digest AS a_digest,' +
        ' o.id AS o_id, o.revision AS o_rev, o.task_revision AS o_task_rev' +
        ' FROM outcome_outputs oo' +
        ' JOIN outcomes o ON o.id = oo.outcome_id AND o.revision = oo.outcome_revision' +
        ' JOIN settlements s ON s.outcome_id = o.id AND s.outcome_revision = o.revision' +
        ' JOIN artifacts a ON a.id = oo.artifact_id AND a.revision = oo.artifact_revision' +
        ' JOIN tasks t ON t.id = o.task_id' +
        ` WHERE o.task_id = ? AND oo.slot = ? AND s.decision IN (${decisions})${revFilter}${runFilter}` +
        ' ORDER BY o.revision DESC, oo.outcome_revision DESC LIMIT 1'
    )
    .get(...params) as
    | {
        a_id: string
        a_rev: number
        a_digest: string
        o_id: string
        o_rev: number
        o_task_rev: number
      }
    | undefined
  if (!row) return null
  return {
    artifact: { id: row.a_id, revision: row.a_rev, digest: row.a_digest },
    outcomeId: row.o_id,
    outcomeRevision: row.o_rev,
    taskRevision: row.o_task_rev
  }
}

/**
 * F-031: is this override artifact genuinely the declared producer's output?
 * A caller pin for a task-output slot must name an artifact that the declared
 * producer task bound to the declared slot in an outcome carrying an
 * ACCEPTING settlement (same bar as resolveTaskOutput — otherwise the
 * override door reopens F-029's rejected-output consumption), in the
 * consumer's run when known. A foreign producer's artifact — even a real one
 * from the same run — is not provenance for this slot.
 */
function overrideProvenanceOk(
  db: DatabaseSync,
  b: BindingSpec,
  artifactId: string,
  revision: number,
  consumerRunId?: string
): { outcomeId: string; outcomeRevision: number; taskRevision: number } | null {
  if (!b.taskId || !b.outputSlot) return null
  const decisions = ACCEPTING_DECISIONS.map(() => '?').join(',')
  const revFilter = b.taskRevision === undefined ? '' : ' AND o.task_revision = ?'
  const runFilter = consumerRunId === undefined ? '' : ' AND t.run_id = ?'
  const params: (string | number)[] = [
    b.taskId,
    b.outputSlot,
    artifactId,
    revision,
    ...ACCEPTING_DECISIONS
  ]
  if (b.taskRevision !== undefined) params.push(b.taskRevision)
  if (consumerRunId !== undefined) params.push(consumerRunId)
  const row = db
    .prepare(
      'SELECT o.id AS o_id, o.revision AS o_rev, o.task_revision AS o_task_rev FROM outcome_outputs oo' +
        ' JOIN outcomes o ON o.id = oo.outcome_id AND o.revision = oo.outcome_revision' +
        ' JOIN settlements s ON s.outcome_id = o.id AND s.outcome_revision = o.revision' +
        ' JOIN tasks t ON t.id = o.task_id' +
        ` WHERE o.task_id = ? AND oo.slot = ? AND oo.artifact_id = ? AND oo.artifact_revision = ? AND s.decision IN (${decisions})${revFilter}${runFilter}` +
        ' ORDER BY o.revision DESC LIMIT 1'
    )
    .get(...params) as { o_id: string; o_rev: number; o_task_rev: number } | undefined
  return row
    ? { outcomeId: row.o_id, outcomeRevision: row.o_rev, taskRevision: row.o_task_rev }
    : null
}

function resolveOne(
  db: DatabaseSync,
  b: BindingSpec,
  overrides: Readonly<Record<string, ArtifactRef>> | undefined,
  consumerRunId?: string
): ResolvedInput {
  const base = { slot: b.slot, kind: b.kind, required: b.required }

  const overridden = overrides?.[b.slot]
  if (overridden !== undefined) {
    const a = loadArtifact(
      db,
      overridden.artifactId as unknown as string,
      overridden.revision as unknown as number
    )
    if (!a) {
      return {
        ...base,
        status: 'unresolved',
        reason: `override artifact ${overridden.artifactId}@${overridden.revision} does not exist`
      }
    }
    // F-031: the member.ts pre-check covers existence/run/digest on the
    // dispatch path, but pinInputs is also reached directly (prepare path) —
    // enforce run scope and digest here so no caller can smuggle a cross-run
    // or forged artifact through an override.
    if (consumerRunId !== undefined && a.run_id !== undefined && a.run_id !== consumerRunId) {
      return {
        ...base,
        status: 'unresolved',
        reason: `override artifact ${a.id} belongs to run ${a.run_id}, not ${consumerRunId}`
      }
    }
    const wantDigest = (overridden as { digest?: unknown }).digest
    if (wantDigest !== undefined && wantDigest !== a.digest) {
      fail('ARTIFACT_MISMATCH', `override artifact digest mismatch for ${a.id}`, 'none', {
        slot: b.slot
      })
    }
    if (b.kind === 'task-output') {
      const provenance = overrideProvenanceOk(db, b, a.id, a.revision, consumerRunId)
      if (!provenance) {
        return {
          ...base,
          status: 'unresolved',
          reason:
            `override artifact ${a.id}@${a.revision} is not an accepted output of ` +
            `task ${b.taskId ?? '?'} slot '${b.outputSlot ?? '?'}'` +
            (consumerRunId !== undefined ? ` in run ${consumerRunId}` : '')
        }
      }
      return {
        ...base,
        status: 'pinned',
        artifactRef: { artifactId: a.id, revision: a.revision, digest: a.digest } as ArtifactRef,
        source: {
          taskId: b.taskId!,
          taskRevision: provenance.taskRevision,
          outcomeId: provenance.outcomeId,
          outcomeRevision: provenance.outcomeRevision
        }
      }
    }
    return {
      ...base,
      status: 'pinned',
      artifactRef: { artifactId: a.id, revision: a.revision, digest: a.digest } as ArtifactRef
    }
  }

  switch (b.kind) {
    case 'artifact': {
      if (!b.artifactId)
        return { ...base, status: 'unresolved', reason: 'artifact binding missing artifactId' }
      const a = loadArtifact(db, b.artifactId, b.artifactRevision)
      if (!a) {
        return {
          ...base,
          status: 'unresolved',
          reason: `artifact ${b.artifactId}@${b.artifactRevision ?? 'latest'} not found`
        }
      }
      if (consumerRunId !== undefined && a.run_id !== undefined && a.run_id !== consumerRunId) {
        return {
          ...base,
          status: 'unresolved',
          reason: `artifact ${b.artifactId} belongs to run ${a.run_id}, not ${consumerRunId}`
        }
      }
      return {
        ...base,
        status: 'pinned',
        artifactRef: { artifactId: a.id, revision: a.revision, digest: a.digest } as ArtifactRef
      }
    }
    case 'task-output': {
      if (!b.taskId || !b.outputSlot) {
        return {
          ...base,
          status: 'unresolved',
          reason: 'task-output binding missing taskId/outputSlot'
        }
      }
      const hit = resolveTaskOutput(db, b, consumerRunId)
      return hit
        ? {
            ...base,
            status: 'pinned',
            artifactRef: {
              artifactId: hit.artifact.id,
              revision: hit.artifact.revision,
              digest: hit.artifact.digest
            } as ArtifactRef,
            source: {
              taskId: b.taskId,
              taskRevision: hit.taskRevision,
              outcomeId: hit.outcomeId,
              outcomeRevision: hit.outcomeRevision
            }
          }
        : {
            ...base,
            status: 'unresolved',
            reason: `no accepted outcome of task ${b.taskId} binds output slot '${b.outputSlot}' to an artifact`
          }
    }
    case 'contract': {
      if (!b.contractId)
        return { ...base, status: 'unresolved', reason: 'contract binding missing contractId' }
      // a contract pin is a reference, not a produced byte stream — existence is
      // checked only when the caller pins modelVersion, since rdd_contracts is
      // keyed (model_version, id).
      if (b.modelVersion !== undefined) {
        const row = db
          .prepare('SELECT 1 AS ok FROM rdd_contracts WHERE model_version = ? AND id = ?')
          .get(b.modelVersion, b.contractId) as { ok: number } | undefined
        if (!row) {
          return {
            ...base,
            status: 'unresolved',
            reason: `contract ${b.contractId} not in model version ${b.modelVersion}`
          }
        }
      }
      return {
        ...base,
        status: 'pinned',
        contractRef: {
          contractId: b.contractId,
          revision: b.contractRevision,
          modelVersion: b.modelVersion
        }
      }
    }
  }
}

/**
 * Resolve every binding. Pure read — the caller decides whether unresolved is
 * pending (plan.commit) or fatal (dispatch start via pinInputs).
 */
export function resolveInputs(
  db: DatabaseSync,
  bindings: readonly unknown[],
  opts?: { overrides?: Readonly<Record<string, ArtifactRef>>; consumerRunId?: string }
): { inputs: ResolvedInput[]; unresolvedRequired: UnresolvedInput[] } {
  const inputs = bindings.map((raw) =>
    resolveOne(db, parseBinding(raw), opts?.overrides, opts?.consumerRunId)
  )
  const unresolvedRequired = inputs.filter(
    (i): i is UnresolvedInput => i.status === 'unresolved' && i.required
  )
  return { inputs, unresolvedRequired }
}

/**
 * The dispatch-time pin. Every REQUIRED binding must land on an immutable ref;
 * optional bindings may stay unresolved and are reported, not hidden.
 * Throws INPUT_NOT_READY listing exactly what is missing.
 */
export function pinInputs(
  db: DatabaseSync,
  bindings: readonly unknown[],
  opts?: { overrides?: Readonly<Record<string, ArtifactRef>>; consumerRunId?: string }
): ResolvedInput[] {
  const { inputs, unresolvedRequired } = resolveInputs(db, bindings, opts)
  if (unresolvedRequired.length > 0) {
    fail('INPUT_NOT_READY', `${unresolvedRequired.length} required input(s) unresolved`, 'none', {
      unresolved: unresolvedRequired.map((u) => ({ slot: u.slot, kind: u.kind, reason: u.reason }))
    })
  }
  return inputs
}
