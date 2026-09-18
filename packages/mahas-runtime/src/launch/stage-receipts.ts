// mahas-runtime/launch — cumulative stage receipts (IMP-19).
//
// C-LAUNCH: `admitted → inputs_pinned → resources_claimed →
// components_materialized → process_attempting → process_confirmed →
// initial_attached → awaiting_join → joined → task_accepted`.
// A coordination assignment ends at `coordination_ready` instead of
// `task_accepted`. Every stage lands in ONE cumulative receipt so a caller
// (or IMP-22 reconcile after a controller crash) can diff plan vs effects.
//
// Persistence: the receipt lives in a dedicated effect_intents row
// (kind='launch.progress', id=`launch-progress:<planId>`) — the schema has
// no launch-stage table and the progress row doubles as the durable intent
// record. Each external effect (workspace claim, materialize, host spawn)
// additionally gets its own effect_intents row keyed `<planId>:<effect>`
// so host calls share one stable effect key across retries (REQ-14:
// same key → same receipt, never a fresh effect).

import type { DatabaseSync } from 'node:sqlite'
import type { EffectState } from '../../../mahas-contracts/src/common.ts'
import type { ResidualResource } from '../../../mahas-contracts/src/work.ts'
import { canonicalJson, getRow, runSql, type ResolvedDeps } from './deps.ts'

/** stages the worker.start coordinator drives, in fixed order */
export const DRIVEN_STAGES = [
  'admitted',
  'inputs_pinned',
  'resources_claimed',
  'components_materialized',
  'process_attempting',
  'process_confirmed',
  'initial_attached',
  'awaiting_join'
] as const

/** agent-side stages recorded but never performed by worker.start */
export const AGENT_STAGES = ['joined', 'task_accepted', 'coordination_ready'] as const

export type DrivenStageName = (typeof DRIVEN_STAGES)[number]
export type LaunchStageName = DrivenStageName | (typeof AGENT_STAGES)[number]

export type StageStatus = 'pending' | 'attempting' | 'confirmed' | 'failed' | 'unknown'

export interface StageEntry {
  stage: LaunchStageName
  status: StageStatus
  at?: number
  /** effect_intents id backing this stage, when it performs an effect */
  effectId?: string
  receipt?: unknown
  error?: { code: string; message: string; retry?: string }
  residuals?: unknown[]
  nextAllowedActions?: string[]
}

export interface LaunchReceipt {
  launchPlanId: string
  planDigest: string
  assignmentKind: 'task' | 'coordination'
  operationIds: string[]
  executionId?: string
  generation?: number
  dispatchId?: string
  stages: StageEntry[]
  failedStage?: LaunchStageName
  residuals: unknown[]
  nextAllowedActions: string[]
  /** set once the coordinator's work is done */
  terminal?: 'awaiting_join'
  updatedAt: number
}

/** ordered stage list for this assignment kind (spec stage order) */
export function stageList(kind: 'task' | 'coordination'): LaunchStageName[] {
  return [...DRIVEN_STAGES, 'joined', kind === 'task' ? 'task_accepted' : 'coordination_ready']
}

export function newReceipt(
  planId: string,
  planDigest: string,
  kind: 'task' | 'coordination',
  operationId: string,
  now: number
): LaunchReceipt {
  return {
    launchPlanId: planId,
    planDigest,
    assignmentKind: kind,
    operationIds: [operationId],
    stages: stageList(kind).map((stage) => ({ stage, status: 'pending' as const })),
    residuals: [],
    nextAllowedActions: [],
    updatedAt: now
  }
}

// ---------------------------------------------------------------------------
// persistence — progress row + per-effect rows in effect_intents

const PROGRESS_KIND = 'launch.progress'

export function progressRowId(planId: string): string {
  return `launch-progress:${planId}`
}

export function effectId(planId: string, name: string): string {
  return `${planId}:effect:${name}`
}

interface EffectRow {
  id: string
  operation_key: string
  kind: string
  fingerprint: string
  host_id: string | null
  state: EffectState
  payload_json: string
  receipt_json: string
  residuals_json: string
}

export interface StoredEffect {
  id: string
  operationKey: string
  kind: string
  fingerprint: string
  hostId?: string
  state: EffectState
  payload: unknown
  receipt: unknown
  residuals: unknown[]
}

function toEffect(row: EffectRow): StoredEffect {
  return {
    id: row.id,
    operationKey: row.operation_key,
    kind: row.kind,
    fingerprint: row.fingerprint,
    ...(row.host_id ? { hostId: row.host_id } : {}),
    state: row.state,
    payload: JSON.parse(row.payload_json),
    receipt: JSON.parse(row.receipt_json),
    residuals: JSON.parse(row.residuals_json) as unknown[]
  }
}

export function getEffect(db: DatabaseSync, id: string): StoredEffect | null {
  const row = getRow<EffectRow>(db, 'SELECT * FROM effect_intents WHERE id=?', id)
  return row ? toEffect(row) : null
}

export function putEffect(
  db: DatabaseSync,
  deps: ResolvedDeps,
  e: {
    id: string
    operationKey: string
    kind: string
    hostId?: string
    state: EffectState
    payload: unknown
    receipt?: unknown
    residuals?: unknown[]
  }
): void {
  const fingerprint = deps.digest(canonicalJson(e.payload))
  runSql(
    db,
    `INSERT INTO effect_intents(id,operation_key,kind,fingerprint,host_id,state,payload_json,receipt_json,residuals_json)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET state=excluded.state, receipt_json=excluded.receipt_json,
       residuals_json=excluded.residuals_json`,
    e.id,
    e.operationKey,
    e.kind,
    fingerprint,
    e.hostId ?? null,
    e.state,
    JSON.stringify(e.payload ?? {}),
    JSON.stringify(e.receipt ?? {}),
    JSON.stringify(e.residuals ?? [])
  )
}

export function setEffectState(
  db: DatabaseSync,
  id: string,
  state: EffectState,
  receipt?: unknown,
  residuals?: unknown[]
): void {
  runSql(
    db,
    'UPDATE effect_intents SET state=?, receipt_json=?, residuals_json=? WHERE id=?',
    state,
    JSON.stringify(receipt ?? {}),
    JSON.stringify(residuals ?? []),
    id
  )
}

// ---------------------------------------------------------------------------
// journal load/save

function aggregateState(r: LaunchReceipt): EffectState {
  if (r.terminal) return 'confirmed'
  if (r.failedStage) {
    const failed = r.stages.find((s) => s.stage === r.failedStage)
    return failed?.status === 'unknown' ? 'unknown' : 'rejected'
  }
  return 'attempting'
}

export function saveReceipt(db: DatabaseSync, deps: ResolvedDeps, r: LaunchReceipt): void {
  r.updatedAt = deps.now()
  runSql(
    db,
    `INSERT INTO effect_intents(id,operation_key,kind,fingerprint,host_id,state,payload_json,receipt_json,residuals_json)
     VALUES (?,?,?,?,NULL,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET state=excluded.state, receipt_json=excluded.receipt_json,
       residuals_json=excluded.residuals_json`,
    progressRowId(r.launchPlanId),
    `worker.start:${r.launchPlanId}`,
    PROGRESS_KIND,
    r.planDigest,
    aggregateState(r),
    JSON.stringify({ launchPlanId: r.launchPlanId }),
    JSON.stringify(r),
    JSON.stringify(r.residuals)
  )
}

/**
 * Loads the cumulative receipt. A stage or effect left 'attempting' by a
 * crash is normalized to 'unknown' — never silently retried, never called
 * failed (S-LIFECYCLE cut points; REQ-14 ambiguous = unknown).
 */
export function loadReceipt(db: DatabaseSync, planId: string): LaunchReceipt | null {
  const row = getRow<EffectRow>(
    db,
    'SELECT * FROM effect_intents WHERE id=? AND kind=?',
    progressRowId(planId),
    PROGRESS_KIND
  )
  if (!row) return null
  const r = JSON.parse(row.receipt_json) as LaunchReceipt
  for (const s of r.stages) {
    if (s.status === 'attempting') s.status = 'unknown'
    if (s.status === 'unknown' && s.effectId) {
      const eff = getEffect(db, s.effectId)
      if (eff && (eff.state === 'attempting' || eff.state === 'prepared')) {
        setEffectState(db, s.effectId, 'unknown', eff.receipt, eff.residuals)
      }
    }
  }
  return r
}

/** first stage that still needs coordinator work */
export function currentStage(r: LaunchReceipt): StageEntry | null {
  return (
    r.stages.find(
      (s) => s.status === 'pending' || s.status === 'failed' || s.status === 'unknown'
    ) ?? null
  )
}

export function recordStage(
  r: LaunchReceipt,
  stage: LaunchStageName,
  patch: Partial<StageEntry>,
  now: number
): StageEntry {
  const entry = r.stages.find((s) => s.stage === stage)
  if (!entry) throw new Error(`stage ${stage} not in receipt`)
  Object.assign(entry, patch, { at: now })
  r.updatedAt = now
  return entry
}

export function addResiduals(r: LaunchReceipt, residuals: unknown[] | undefined): void {
  if (!residuals || residuals.length === 0) return
  r.residuals.push(...residuals)
}

/** ResidualResource construction — kept structural here; the contract type
 *  is IMP-02's and this shape (kind/ref/state/note) is what worker.release
 *  and IMP-22 reconcile read back. */
export function residual(
  kind: string,
  ref: string,
  state: string,
  note?: string
): ResidualResource {
  return { kind, ref, state, ...(note ? { note } : {}) } as unknown as ResidualResource
}
