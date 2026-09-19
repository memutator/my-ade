// mahas-runtime / coordination — Outcome revisions (IMP-21, C-WORK task.report).
//
// An Outcome is pinned to the exact (taskId, taskRevision, dispatchId) triple
// of the still-authoritative attempt. A new revision never inherits a prior
// Settlement (D-MAIL §4). This module only writes outcomes + output bindings;
// Settlement / Dispatch phase moves live in settlement.ts.

import type { DatabaseSync } from 'node:sqlite'
import type { ArtifactRef } from '../../../mahas-contracts/src/common.ts'
import type { Outcome, OutcomeResult } from '../../../mahas-contracts/src/mail.ts'
import type { Dispatch, SettlementPolicy, TaskSpec } from '../../../mahas-contracts/src/work.ts'
import { appendDomainEvent } from '../storage/db.ts'
import {
  asObject,
  badInput,
  fail,
  newId,
  one,
  optArr,
  optInt,
  optObj,
  optStr,
  parseJson,
  reqStr,
  run
} from './internal.ts'
import { checkAttemptAuthority, type AttemptCheck } from './dispatch-authority.ts'

export const OUTCOME_RESULTS: readonly OutcomeResult[] = ['succeeded', 'failed', 'blocked']

export interface ReportedOutput {
  slot: string
  artifactId: string
  artifactRevision: number
  digest?: string
}

export interface InsertOutcomeInput {
  taskId: string
  taskRevision: number
  dispatchId: string
  result: OutcomeResult
  rationale: string
  assessment: unknown
  outputs: ReportedOutput[]
  contractEffects: unknown
}

export interface StoredOutcome {
  outcome: Outcome
  outputs: ReportedOutput[]
}

export function normalizeResult(raw: string): OutcomeResult {
  const v = raw.trim().toLowerCase()
  if (v === 'succeeded' || v === 'success' || v === 'ok') return 'succeeded'
  if (v === 'failed' || v === 'fail' || v === 'failure') return 'failed'
  if (v === 'blocked' || v === 'block') return 'blocked'
  fail('MODEL_INVALID', `result must be succeeded|failed|blocked, got ${JSON.stringify(raw)}`)
}

export function policyOf(spec: TaskSpec): SettlementPolicy {
  const raw = spec.settlementPolicy
  if (typeof raw === 'string') {
    if (raw === 'owner-declaration' || raw === 'designated-acceptance') return { mode: raw }
    return { mode: raw }
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as SettlementPolicy
  }
  // unspecified policy: the assignee may declare (REQ-20 — not every result
  // waits for a coordinator re-approval)
  return { mode: 'owner-declaration' }
}

export function policyMode(policy: SettlementPolicy): string {
  const rec = policy as Record<string, unknown>
  const mode = rec.mode ?? rec.kind ?? rec.type
  return typeof mode === 'string' && mode.length > 0 ? mode : 'owner-declaration'
}

export function isOwnerDeclaration(policy: SettlementPolicy): boolean {
  const mode = policyMode(policy)
  return mode === 'owner-declaration' || mode === 'owner' || mode === 'self'
}

export function isDesignatedAcceptance(policy: SettlementPolicy): boolean {
  const mode = policyMode(policy)
  return mode === 'designated-acceptance' || mode === 'designated'
}

/**
 * Gate task.report: the named dispatch must still be THE active attempt on
 * the exact pinned (taskId, taskRevision, dispatchId) triple.
 */
export function requireActiveAttempt(
  db: DatabaseSync,
  check: AttemptCheck
): ReturnType<typeof checkAttemptAuthority> {
  return checkAttemptAuthority(db, check)
}

export function parseReportedOutputs(
  raw: unknown,
  op: string
): ReportedOutput[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) badInput(`${op}: 'outputs' must be an array`)
  return raw.map((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      badInput(`${op}: outputs[${i}] must be an object`)
    }
    const o = item as Record<string, unknown>
    const slot = optStr(o, 'slot', op) ?? optStr(o, 'outputSlot', op) ?? optStr(o, 'name', op)
    const artifactId =
      optStr(o, 'artifactId', op) ??
      (typeof o.artifactRef === 'object' && o.artifactRef !== null
        ? optStr(o.artifactRef as Record<string, unknown>, 'artifactId', op)
        : undefined)
    const artifactRevision =
      optInt(o, 'artifactRevision', op) ??
      optInt(o, 'revision', op) ??
      (typeof o.artifactRef === 'object' && o.artifactRef !== null
        ? optInt(o.artifactRef as Record<string, unknown>, 'revision', op)
        : undefined)
    if (!slot || !artifactId || artifactRevision === undefined) {
      badInput(
        `${op}: outputs[${i}] needs slot + artifactId + artifactRevision`,
        { item }
      )
    }
    const digest =
      optStr(o, 'digest', op) ??
      (typeof o.artifactRef === 'object' && o.artifactRef !== null
        ? optStr(o.artifactRef as Record<string, unknown>, 'digest', op)
        : undefined)
    return {
      slot,
      artifactId,
      artifactRevision,
      ...(digest !== undefined ? { digest } : {})
    }
  })
}

function outputSlotsOf(spec: TaskSpec): { slot: string; required: boolean }[] {
  const raw = (spec.outputs ?? spec.outputSlots) as unknown
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    if (item === null || typeof item !== 'object') return { slot: String(item), required: false }
    const o = item as Record<string, unknown>
    const slot = typeof o.slot === 'string' ? o.slot : typeof o.name === 'string' ? o.name : ''
    return { slot, required: o.required === true }
  }).filter((s) => s.slot.length > 0)
}

function assertArtifactPin(
  db: DatabaseSync,
  dispatch: Dispatch,
  out: ReportedOutput,
  op: string
): { digest: string } {
  const row = one(
    db,
    'SELECT id, revision, digest, producer_dispatch_id, output_slot FROM artifacts WHERE id = ? AND revision = ?',
    out.artifactId,
    out.artifactRevision
  )
  if (!row) {
    fail(
      'ARTIFACT_MISMATCH',
      `${op}: artifact ${out.artifactId}@${out.artifactRevision} does not exist`,
      'none',
      out
    )
  }
  if (String(row.producer_dispatch_id) !== String(dispatch.id)) {
    fail(
      'ARTIFACT_MISMATCH',
      `${op}: artifact ${out.artifactId} was not produced by dispatch ${dispatch.id}`,
      'none',
      { producer: row.producer_dispatch_id, dispatchId: dispatch.id }
    )
  }
  const storedSlot = typeof row.output_slot === 'string' ? row.output_slot : ''
  if (storedSlot.length > 0 && storedSlot !== out.slot) {
    fail(
      'ARTIFACT_MISMATCH',
      `${op}: artifact ${out.artifactId} is slot '${storedSlot}', not '${out.slot}'`,
      'none',
      { storedSlot, claimed: out.slot }
    )
  }
  if (out.digest !== undefined && out.digest !== String(row.digest)) {
    fail(
      'ARTIFACT_MISMATCH',
      `${op}: artifact ${out.artifactId} digest mismatch`,
      'none',
      { expected: out.digest, actual: row.digest }
    )
  }
  return { digest: String(row.digest) }
}

/**
 * Insert a new Outcome revision pinned to the dispatch's exact triple.
 * Re-reports of the same dispatch (designated-acceptance still pending)
 * reuse the outcome id and bump revision — old settlements do not follow.
 */
export function insertOutcomeRevision(db: DatabaseSync, input: InsertOutcomeInput): StoredOutcome {
  const existing = one(
    db,
    'SELECT id, revision FROM outcomes WHERE dispatch_id = ? ORDER BY revision DESC LIMIT 1',
    input.dispatchId
  )
  const outcomeId = existing ? String(existing.id) : (newId('out') as string)
  const revision = existing ? Number(existing.revision) + 1 : 1
  const assessmentJson = JSON.stringify(input.assessment ?? [])
  const effectsJson = JSON.stringify(input.contractEffects ?? null)
  run(
    db,
    'INSERT INTO outcomes (id, revision, task_id, task_revision, dispatch_id, result, rationale, assessment_json, contract_effects_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    outcomeId,
    revision,
    input.taskId,
    input.taskRevision,
    input.dispatchId,
    input.result,
    input.rationale,
    assessmentJson,
    effectsJson
  )
  const insOut = db.prepare(
    'INSERT INTO outcome_outputs (outcome_id, outcome_revision, slot, artifact_id, artifact_revision) VALUES (?, ?, ?, ?, ?)'
  )
  for (const o of input.outputs) {
    insOut.run(outcomeId, revision, o.slot, o.artifactId, o.artifactRevision)
  }
  appendDomainEvent(
    db,
    outcomeId,
    revision,
    'outcome.reported',
    { taskId: input.taskId, dispatchId: input.dispatchId },
    {
      taskRevision: input.taskRevision,
      result: input.result,
      slots: input.outputs.map((o) => o.slot)
    }
  )
  const refs: ArtifactRef[] = input.outputs.map((o) => ({
    artifactId: o.artifactId as ArtifactRef['artifactId'],
    revision: o.artifactRevision as ArtifactRef['revision'],
    digest: o.digest ?? ''
  }))
  const outcome: Outcome = {
    id: outcomeId as Outcome['id'],
    revision: revision as Outcome['revision'],
    taskId: input.taskId as Outcome['taskId'],
    taskRevision: input.taskRevision as Outcome['taskRevision'],
    dispatchId: input.dispatchId as Outcome['dispatchId'],
    result: input.result,
    rationale: input.rationale,
    assessment: input.assessment,
    outputRefs: refs,
    contractEffects: input.contractEffects
  }
  return { outcome, outputs: input.outputs }
}

export function loadOutcome(
  db: DatabaseSync,
  outcomeId: string,
  revision: number
): Outcome | null {
  const r = one(
    db,
    'SELECT * FROM outcomes WHERE id = ? AND revision = ?',
    outcomeId,
    revision
  )
  if (!r) return null
  const outputs = db
    .prepare(
      'SELECT slot, artifact_id, artifact_revision FROM outcome_outputs WHERE outcome_id = ? AND outcome_revision = ?'
    )
    .all(outcomeId, revision) as {
    slot: string
    artifact_id: string
    artifact_revision: number
  }[]
  return {
    id: r.id as Outcome['id'],
    revision: Number(r.revision) as Outcome['revision'],
    taskId: r.task_id as Outcome['taskId'],
    taskRevision: Number(r.task_revision) as Outcome['taskRevision'],
    dispatchId: r.dispatch_id as Outcome['dispatchId'],
    result: r.result as OutcomeResult,
    rationale: String(r.rationale),
    assessment: parseJson(r.assessment_json, 'outcomes.assessment_json'),
    outputRefs: outputs.map((o) => ({
      artifactId: o.artifact_id as ArtifactRef['artifactId'],
      revision: o.artifact_revision as ArtifactRef['revision'],
      digest: ''
    })),
    contractEffects: parseJson(r.contract_effects_json, 'outcomes.contract_effects_json')
  }
}

export interface TaskReportInput {
  dispatchId: string
  taskRevision: number
  envelopeDigest?: string
  result: string
  rationale: string
  criterionAssessment: unknown
  outputs: ReportedOutput[]
  contractEffects: unknown
}

export function parseTaskReportPayload(raw: unknown): TaskReportInput {
  const op = 'task.report'
  const p = asObject(raw, op)
  const result = reqStr(p, 'result', op)
  const outputsRaw = p.outputs ?? p.outputRefs
  return {
    dispatchId: reqStr(p, 'dispatchId', op),
    taskRevision: optInt(p, 'taskRevision', op) ?? optInt(p, 'taskRev', op) ?? -1,
    envelopeDigest: optStr(p, 'envelopeDigest', op),
    result,
    rationale: optStr(p, 'rationale', op) ?? '',
    criterionAssessment: p.criterionAssessment ?? p.assessment ?? optArr(p, 'criterionAssessment', op),
    outputs: parseReportedOutputs(outputsRaw, op),
    contractEffects: p.contractEffects ?? optObj(p, 'contractEffects', op) ?? null
  }
}

/**
 * Validate reported outputs against the artifacts ledger and the TaskSpec
 * slots. Succeeded reports must pin every required slot; failed/blocked may
 * omit them (the body is the explicit judgment — D-MAIL §4).
 */
export function assertReportOutputs(
  db: DatabaseSync,
  dispatch: Dispatch,
  spec: TaskSpec,
  result: OutcomeResult,
  outputs: ReportedOutput[],
  op: string
): ReportedOutput[] {
  const seen = new Set<string>()
  const pinned: ReportedOutput[] = []
  for (const o of outputs) {
    if (seen.has(o.slot)) badInput(`${op}: duplicate output slot '${o.slot}'`)
    seen.add(o.slot)
    const { digest } = assertArtifactPin(db, dispatch, o, op)
    pinned.push({ ...o, digest })
  }
  if (result === 'succeeded') {
    for (const slot of outputSlotsOf(spec)) {
      if (slot.required && !seen.has(slot.slot)) {
        fail(
          'ARTIFACT_MISMATCH',
          `${op}: required output slot '${slot.slot}' is not bound to an artifact`,
          'none',
          { slot: slot.slot }
        )
      }
    }
  }
  return pinned
}
