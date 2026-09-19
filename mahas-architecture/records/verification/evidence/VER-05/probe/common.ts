// VER-05 shared harness — real implementation modules via absolute file:// URLs.
// World: in-process composeRuntime (real op registry + real admission) attached
// to a REAL mahas-execution-host over a unix socket. No mahasd socket is used —
// worker.* ops are invoked through runtime.registry.dispatch, and ctx shapes the
// socket authenticator cannot mint (memberId/executionGeneration/grantRevisions)
// are constructed in-process, the same method VER-01/VER-03 recorded.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { openControlDb, sha256Hex } from 'file:///tmp/mahas-ver-05/src/packages/mahas-runtime/src/storage/db.ts'
import { composeRuntime, type ComposedRuntime } from 'file:///tmp/mahas-ver-05/src/packages/mahas-runtime/src/composition.ts'

export { openControlDb, sha256Hex }
export type { ComposedRuntime }

export const ROOT = '/tmp/mahas-ver-05'
export const SRC_ROOT = '/tmp/mahas-ver-05/src'
export const OUT = `${ROOT}/out`
export const STATE_PATH = `${ROOT}/state.json`
export const REPO_ROOT = `${ROOT}/repo`          // model repository root (source files)
export const CHECKOUT_A = `${ROOT}/checkout-a`   // shared member checkout (cwd under test)
export const EXEC_ROOTS = `${ROOT}/executions`   // materializer executionRootsDir
export const COOP = `${ROOT}/coop/recorder.mjs`  // cooperative executable
export const NODE_BIN = process.execPath         // absolute node binary for argv[0]

export const CONFIG = `${ROOT}/config`
export const DB = `${ROOT}/db/mahas.sqlite`
export const HOST_SOCK = `${CONFIG}/execution-host.sock`

export function ensureDirs(): void {
  for (const d of [`${ROOT}/db`, CONFIG, OUT, REPO_ROOT, CHECKOUT_A, EXEC_ROOTS]) {
    mkdirSync(d, { recursive: true })
  }
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
    if (extra !== undefined) console.log('       extra:', JSON.stringify(extra)?.slice(0, 800))
  }
  artifact(key: string, value: unknown): void {
    this.artifacts[key] = value
  }
  flush(extra?: Record<string, unknown>): string {
    const file = join(OUT, `${this.stepId}.json`)
    writeFileSync(
      file,
      JSON.stringify(
        { stepId: this.stepId, at: Date.now(), checks: this.checks, artifacts: this.artifacts, ...extra },
        null,
        2
      )
    )
    const fails = this.checks.filter((c) => !c.ok)
    console.log(`\n[${this.stepId}] ${this.checks.length - fails.length}/${this.checks.length} checks ok → ${file}`)
    return file
  }
}

// ------------------------------------------------------------- receipts --
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

// ------------------------------------------------------------- runtime ---
export interface Wired {
  db: DatabaseSync
  runtime: ComposedRuntime
  dispatch: (
    ctx: Record<string, unknown>,
    operation: string,
    payload?: unknown,
    operationId?: string
  ) => Promise<Receipt>
  opSeq: () => string
  hostId: string | null
  epoch: number
}
export function currentEpoch(): number {
  return Number(loadState().epoch ?? 0)
}
/** the epoch the host's stored lease is on — takeover needs strictly higher. */
function hostLeaseEpoch(): number {
  try {
    const hostDb = new DatabaseSync(`${CONFIG}/execution-host.sqlite`, { readOnly: true })
    const row = hostDb.prepare('SELECT epoch FROM host_controller_lease WHERE id=1').get() as
      | { epoch: number }
      | undefined
    hostDb.close()
    return Number(row?.epoch ?? 0)
  } catch {
    return 0
  }
}
let seq = 0
export async function wire(tag: string): Promise<Wired> {
  ensureDirs()
  const db = openControlDb(DB)
  const epoch = Math.max(currentEpoch(), hostLeaseEpoch()) + 1
  saveState({ epoch })
  const runtime = await composeRuntime({
    db,
    configDir: CONFIG,
    endpoint: `${ROOT}/mahasd.sock`, // logical identity only — nothing binds it
    controllerEpoch: epoch,
    controllerIdentity: { pid: process.pid, label: `ver-05:${tag}` },
    hostEndpoint: HOST_SOCK,
    log: (line) => {
      const t = (line as { t?: string }).t ?? ''
      if (!t.includes('host-absent')) console.log('   [compose]', JSON.stringify(line).slice(0, 240))
    }
  })
  // runtime_instances row — lifecycle.acquireControllerEpoch does this for the
  // real daemon; the in-process composition leaves it to us.
  db.prepare("UPDATE runtime_instances SET state='stopped' WHERE state='ready'").run()
  db.prepare(
    "INSERT INTO runtime_instances(id, controller_epoch, state, process_identity_json, endpoint_incarnation) VALUES(?,?,?,?,?)"
  ).run(
    `rt-ver05-${epoch}-${process.pid}`,
    epoch,
    'ready',
    JSON.stringify({ pid: process.pid, label: `ver-05:${tag}` }),
    `inproc-${epoch}`
  )
  const opSeq = () => `ver05:${tag}:${epoch}:${String(++seq).padStart(3, '0')}`
  return {
    db,
    runtime,
    hostId: runtime.localHost?.hostId ?? null,
    epoch,
    opSeq,
    dispatch: (ctx, operation, payload, operationId) =>
      runtime.registry.dispatch(ctx as never, {
        protocolVersion: 'ver-05/1',
        operation,
        operationId: operationId ?? opSeq(),
        payload
      } as never) as Promise<Receipt>
  }
}

/** operator-local ctx — seeded by composeRuntime's seedLocalOperator. */
export function opCtx(
  extraGrants: Record<string, number> = {},
  epoch?: number
): Record<string, unknown> {
  return {
    principalId: 'operator-local',
    controllerEpoch: epoch ?? currentEpoch(),
    grantRevisions: { 'grant-operator-local': 1, ...extraGrants },
    transportSessionId: `ver05:${process.pid}`
  }
}

/** member ctx — principalId IS the member id; can carry the execution binding
 *  a worker credential would attest (executionId/executionGeneration). */
export function memberCtx(
  memberId: string,
  grants: Record<string, number>,
  exec?: { executionId: string; generation: number; principalId?: string },
  epoch?: number
): Record<string, unknown> {
  return {
    principalId: exec?.principalId ?? memberId,
    memberId,
    controllerEpoch: epoch ?? currentEpoch(),
    grantRevisions: grants,
    ...(exec ? { executionId: exec.executionId, executionGeneration: exec.generation } : {}),
    transportSessionId: `ver05:${process.pid}:${memberId}`
  }
}

// --------------------------------------------------------------- sql -----
export function q1(
  db: DatabaseSync,
  sql: string,
  ...p: unknown[]
): Record<string, unknown> | undefined {
  return db.prepare(sql).get(...(p as never[])) as Record<string, unknown> | undefined
}
export function qa(db: DatabaseSync, sql: string, ...p: unknown[]): Record<string, unknown>[] {
  return db.prepare(sql).all(...(p as never[])) as Record<string, unknown>[]
}
export function cnt(db: DatabaseSync, table: string, where = '', ...p: unknown[]): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`)
    .get(...(p as never[])) as { n: number }
  return Number(r.n)
}

export function writeJson(name: string, value: unknown): string {
  const file = join(OUT, name)
  writeFileSync(file, JSON.stringify(value, null, 2))
  return file
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
