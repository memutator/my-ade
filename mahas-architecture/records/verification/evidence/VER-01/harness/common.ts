// VER-01 shared harness — real implementation modules via absolute file:// URLs.
// Everything under test runs through the REAL composition root (composeRuntime)
// and the REAL admission pipeline (registry.dispatch). SQLite lives only in
// /tmp/mahas-ver-01/db/; secrets/config only in /tmp/mahas-ver-01/config/.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { openControlDb, sha256Hex } from 'file:///tmp/mahas-ver-01/src-83a6d21/packages/mahas-runtime/src/storage/db.ts'
import { composeRuntime, type ComposedRuntime } from 'file:///tmp/mahas-ver-01/src-83a6d21/packages/mahas-runtime/src/composition.ts'
import { verifySelectionToken } from 'file:///tmp/mahas-ver-01/src-83a6d21/packages/mahas-runtime/src/discovery/index.ts'

export { openControlDb, sha256Hex, verifySelectionToken }
export type { ComposedRuntime }

export const ROOT = '/tmp/mahas-ver-01'
export const DB_PATH = `${ROOT}/db/mahas.sqlite`
export const CONFIG_DIR = `${ROOT}/config`
export const OUT = `${ROOT}/out`
export const STATE_PATH = `${ROOT}/state.json`
export const REPO_ROOT = `${ROOT}/repo`

export function ensureDirs(): void {
  for (const d of [`${ROOT}/db`, CONFIG_DIR, OUT, REPO_ROOT]) mkdirSync(d, { recursive: true })
}

// ---------------------------------------------------------------- state --
export interface State {
  [k: string]: unknown
}
export function loadState(): State {
  return existsSync(STATE_PATH) ? (JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State) : {}
}
export function saveState(patch: Record<string, unknown>): void {
  const s = { ...loadState(), ...patch }
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2))
}

// ------------------------------------------------------------- recorder --
export interface Check {
  name: string
  ok: boolean
  expected: string
  observed: string
  extra?: unknown
}
export class Recorder {
  readonly stepId: string
  readonly checks: Check[] = []
  readonly artifacts: Record<string, unknown> = {}
  constructor(stepId: string) {
    this.stepId = stepId
    mkdirSync(OUT, { recursive: true })
  }
  check(name: string, ok: boolean, expected: string, observed: string, extra?: unknown): void {
    this.checks.push({ name, ok, expected, observed, extra })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} — exp ${expected} | obs ${observed}`)
    if (extra !== undefined) console.log('       extra:', JSON.stringify(extra)?.slice(0, 500))
  }
  artifact(key: string, value: unknown): void {
    this.artifacts[key] = value
  }
  flush(extra?: Record<string, unknown>): string {
    const file = join(OUT, `${this.stepId}.json`)
    writeFileSync(
      file,
      JSON.stringify({ stepId: this.stepId, at: Date.now(), checks: this.checks, artifacts: this.artifacts, ...extra }, null, 2)
    )
    const fails = this.checks.filter((c) => !c.ok)
    console.log(`\n[${this.stepId}] ${this.checks.length - fails.length}/${this.checks.length} checks ok → ${file}`)
    return file
  }
}

// ------------------------------------------------------------- runtime ---
export interface Wired {
  db: DatabaseSync
  runtime: ComposedRuntime
  dispatch: (ctx: Record<string, unknown>, operation: string, payload?: unknown, operationId?: string) => Promise<Receipt>
  opSeq: () => string
}
export interface Receipt {
  operationId: string
  fingerprint: string
  status: string
  result?: unknown
  error?: { code: string; message: string; retry: string; details?: unknown }
  effects: unknown[]
  domainRevision: number
  eventCursor: number
}

let seq = 0
/** open the control DB + compose the REAL runtime (all ops wired). */
export async function wire(tag: string): Promise<Wired> {
  ensureDirs()
  const db = openControlDb(DB_PATH)
  const runtime = await composeRuntime({
    db,
    configDir: CONFIG_DIR,
    endpoint: `${ROOT}/mahasd.sock`,
    controllerEpoch: 1,
    controllerIdentity: { pid: process.pid, label: `ver-01:${tag}` },
    hostEndpoint: `${ROOT}/execution-host.sock`,
    log: (line) => {
      const t = (line as { t?: string }).t ?? ''
      if (!t.includes('host-absent')) console.log('   [compose]', JSON.stringify(line).slice(0, 200))
    }
  })
  const opSeq = () => `ver01:${tag}:${String(++seq).padStart(3, '0')}`
  return {
    db,
    runtime,
    opSeq,
    dispatch: (ctx, operation, payload, operationId) =>
      runtime.registry.dispatch(ctx as never, {
        protocolVersion: 'ver-01/1',
        operation,
        operationId: operationId ?? opSeq(),
        payload
      } as never) as Promise<Receipt>
  }
}

/** operator-local ctx — seeded by composeRuntime's seedLocalOperator. */
export function opCtx(extraGrants: Record<string, number> = {}): Record<string, unknown> {
  return {
    principalId: 'operator-local',
    controllerEpoch: 1,
    grantRevisions: { 'grant-operator-local': 1, ...extraGrants },
    transportSessionId: `ver01:${process.pid}`
  }
}

/** member ctx — principalId IS the member id (member is its own principal). */
export function memberCtx(memberId: string, grants: Record<string, number>): Record<string, unknown> {
  return {
    principalId: memberId,
    memberId,
    controllerEpoch: 1,
    grantRevisions: grants,
    transportSessionId: `ver01:${process.pid}:${memberId}`
  }
}

// --------------------------------------------------------------- sql -----
export function q1(db: DatabaseSync, sql: string, ...p: unknown[]): Record<string, unknown> | undefined {
  return db.prepare(sql).get(...(p as never[])) as Record<string, unknown> | undefined
}
export function qa(db: DatabaseSync, sql: string, ...p: unknown[]): Record<string, unknown>[] {
  return db.prepare(sql).all(...(p as never[])) as Record<string, unknown>[]
}
export function cnt(db: DatabaseSync, table: string, where = '', ...p: unknown[]): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...(p as never[])) as { n: number }
  return Number(r.n)
}

/** dump the model rows for one version — the SQLite-side evidence view. */
export function dumpModelRows(db: DatabaseSync, mv: string): Record<string, unknown> {
  return {
    model_versions: qa(db, 'SELECT * FROM model_versions WHERE id=?', mv),
    rdd_boundaries: qa(db, 'SELECT * FROM rdd_boundaries WHERE model_version=? ORDER BY id', mv),
    rdd_criteria: qa(db, 'SELECT * FROM rdd_criteria WHERE model_version=? ORDER BY boundary_id,id', mv),
    boundary_paths: qa(db, 'SELECT * FROM boundary_paths WHERE model_version=? ORDER BY boundary_id,path', mv),
    boundary_edges: qa(db, 'SELECT * FROM boundary_edges WHERE model_version=? ORDER BY child_id', mv),
    boundary_contexts: qa(db, 'SELECT * FROM boundary_contexts WHERE model_version=? ORDER BY boundary_id,context_id', mv),
    horizontal_roles: qa(db, 'SELECT * FROM horizontal_roles WHERE model_version=? ORDER BY name', mv),
    horizontal_contexts: qa(db, 'SELECT * FROM horizontal_contexts WHERE model_version=? ORDER BY horizontal_role_name', mv),
    rdd_roles: qa(db, 'SELECT * FROM rdd_roles WHERE model_version=? ORDER BY id', mv),
    rdd_contexts: qa(db, 'SELECT * FROM rdd_contexts WHERE model_version=? ORDER BY id', mv),
    rdd_contracts: qa(db, 'SELECT * FROM rdd_contracts WHERE model_version=? ORDER BY id', mv),
    contract_consumers: qa(db, 'SELECT * FROM contract_consumers WHERE model_version=? ORDER BY contract_id', mv),
    rdd_non_goals: qa(db, 'SELECT * FROM rdd_non_goals WHERE model_version=? ORDER BY id', mv),
    role_search_rows: qa(db, 'SELECT * FROM role_search_rows WHERE model_version=? ORDER BY role_id', mv)
  }
}

/** sha256 over canonical-ish JSON for cross-process comparison. */
export function digestOf(value: unknown): string {
  return sha256Hex(JSON.stringify(value))
}

export function writeJson(name: string, value: unknown): string {
  const file = join(OUT, name)
  writeFileSync(file, JSON.stringify(value, null, 2))
  return file
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
