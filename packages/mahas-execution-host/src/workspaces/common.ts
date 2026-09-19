// workspaces/common.ts — shared kernel for the host.workspace.* primitives.
//
// IMP-16 (C-HOST, spec/contracts/execution-host.md; host DDL spec/storage.md
// §4). These are the REAL filesystem primitives — checkout dir
// materialization, dev:ino filesystem identity, repo detection — journaled
// into execution-host.sqlite's host_effects/host_workspaces so an ambiguous
// crash window replays the stored receipt instead of inventing a new effect.
//
// Lease admission: the host enforces controller_lease itself ("host가 OS
// mutation admission을 최종 집행") — a mutation with no/stale-epoch/expired
// lease is refused here even if the transport already vetted the caller.
// F-035: expiry stops authorization (re-acquire to renew); expiry alone is
// still not death — takeover needs dead-evidence (match requireLeaseProof).

import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { withTx } from '../storage.ts' // IMP-03 host-side twin — openHostDb/withTx/sha256Hex
import type { ErrorCode, ErrorRetry, MahasError } from '../../../mahas-contracts/src/common.ts'

// ---------------------------------------------------------------------------
// op plumbing — IMP-17's dispatch seam hands each call a host-DB handle and
// the admission-relevant HostEnvelope fields. Kept structural + minimal so the
// seam lands without reshaping this module.
// ---------------------------------------------------------------------------

export interface WorkspaceOpEnvelope {
  /** HostEnvelope.controllerEpoch — matched against host_controller_lease */
  controllerEpoch?: number
  leaseProof?: unknown
  /** HostEnvelope.effectKey — durable idempotency key for the journaled effect */
  effectKey?: string
  /** HostEnvelope.payloadFingerprint — replay equality check */
  payloadFingerprint?: string
}

export interface WorkspaceOpCall {
  /** execution-host.sqlite handle (IMP-03 openHostDb) */
  db: DatabaseSync
  envelope: WorkspaceOpEnvelope
}

export interface WorkspaceOpSpec {
  name: string
  mutation: boolean
}

export type WorkspaceOpHandler = (
  call: WorkspaceOpCall,
  payload: unknown
) => unknown | Promise<unknown>

export type WorkspaceOpRegister = (spec: WorkspaceOpSpec, handler: WorkspaceOpHandler) => void

export interface WorkspaceHostDeps {
  /** authority clock epoch-ms (default Date.now) */
  now?(): number
  /** git executable (default 'git' on PATH) */
  gitBin?: string
  /**
   * verify the controller lease row against envelope.controllerEpoch
   * (default true). IMP-17's dispatcher may set false when it already
   * enforces the same check upstream.
   */
  verifyLease?: boolean
}

export interface ResolvedDeps {
  now(): number
  gitBin: string
  verifyLease: boolean
}

export function resolveDeps(deps: WorkspaceHostDeps): ResolvedDeps {
  return {
    now: deps.now ?? (() => Date.now()),
    gitBin: deps.gitBin ?? 'git',
    verifyLease: deps.verifyLease ?? true
  }
}

// ---------------------------------------------------------------------------
// errors — fixed codes (spec/common.md §4); thrown as MahasError shapes
// ---------------------------------------------------------------------------

export function fail(
  code: ErrorCode,
  message: string,
  retry: ErrorRetry = 'none',
  details?: unknown
): never {
  const err: MahasError = { code, message, retry }
  if (details !== undefined) err.details = details
  throw err
}

// ---------------------------------------------------------------------------
// lease admission (C-HOST §host.acquire — "TTL alone 금지" applies to grant;
// here expiry is just a fence the host enforces on every mutation)
// ---------------------------------------------------------------------------

interface LeaseRow {
  epoch: number
  revision: number
  expires_at: number
  proof_json: string
}

export function assertLease(db: DatabaseSync, envelope: WorkspaceOpEnvelope, now: number): void {
  const row = db
    .prepare('SELECT epoch, revision, expires_at, proof_json FROM host_controller_lease WHERE id=1')
    .get() as LeaseRow | undefined
  if (!row) {
    fail('CONTROL_UNAVAILABLE', 'no controller lease has been acquired on this host', 'reconcile')
  }
  if (envelope.controllerEpoch === undefined || envelope.controllerEpoch !== row.epoch) {
    fail('SCOPE_DENIED', 'controller epoch does not match the current lease', 'none', {
      leaseEpoch: row.epoch,
      presentedEpoch: envelope.controllerEpoch ?? null
    })
  }
  // F-035: same expiry semantics as requireLeaseProof (lease.ts) — an
  // expired lease refuses workspace effects too. Expiry alone is still not
  // death (takeover needs dead-evidence); it just stops authorizing.
  if (row.expires_at <= now) {
    fail('SCOPE_DENIED', 'controller lease expired — re-acquire to renew', 'reconcile', {
      leaseEpoch: row.epoch,
      expiredAt: row.expires_at
    })
  }
  const presented = typeof envelope.leaseProof === 'string' ? envelope.leaseProof : undefined
  if (presented !== undefined) {
    let fence: string | undefined
    try {
      const proof = JSON.parse(row.proof_json) as { fenceToken?: string }
      fence = proof.fenceToken
    } catch {
      fence = undefined
    }
    if (fence !== undefined && presented !== fence) {
      fail('SCOPE_DENIED', 'leaseProof does not match the held lease', 'none')
    }
  }
}

// ---------------------------------------------------------------------------
// effect journal — C-HOST: "host가 effect_started를 저장한 뒤 OS를 호출한다.
// 동일 effectKey/payload는 기존 receipt." host_effects is the durable record.
// ---------------------------------------------------------------------------

export interface EffectOutcome {
  state: 'confirmed' | 'rejected' | 'unknown'
  /** receipt evidence — stored verbatim in host_effects.receipt_json */
  receipt?: unknown
  residuals?: unknown[]
  /** operation result payload — returned to the caller, not journaled twice */
  result?: unknown
}

export interface JournaledResult {
  effectKey: string
  state: 'confirmed' | 'rejected' | 'unknown'
  receipt: unknown
  residuals: unknown[]
  /** true when this call replayed an existing receipt — no OS work re-ran */
  replayed: boolean
  result?: unknown
}

interface HostEffectRow {
  effect_key: string
  fingerprint: string
  kind: string
  state: string
  intent_json: string
  receipt_json: string
}

export function runJournaledEffect(
  db: DatabaseSync,
  args: { effectKey: string; fingerprint: string; kind: string; intent: unknown },
  work: () => EffectOutcome
): JournaledResult {
  const existing = db
    .prepare('SELECT * FROM host_effects WHERE effect_key=?')
    .get(args.effectKey) as HostEffectRow | undefined

  if (existing) {
    if (existing.fingerprint !== args.fingerprint) {
      fail('OPERATION_CONFLICT', 'same effect key with a different payload', 'none', {
        effectKey: args.effectKey
      })
    }
    const receipt = JSON.parse(existing.receipt_json) as {
      state?: string
      receipt?: unknown
      residuals?: unknown[]
      result?: unknown
    }
    return {
      effectKey: args.effectKey,
      state: (receipt.state ?? existing.state) as JournaledResult['state'],
      receipt: receipt.receipt ?? receipt,
      residuals: receipt.residuals ?? [],
      replayed: true,
      result: receipt.result
    }
  }

  db.prepare(
    `INSERT INTO host_effects (effect_key, fingerprint, kind, state, intent_json, receipt_json)
     VALUES (?,?,?,?,?,?)`
  ).run(
    args.effectKey,
    args.fingerprint,
    args.kind,
    'attempting',
    JSON.stringify(args.intent ?? {}),
    JSON.stringify({ state: 'attempting' })
  )

  let outcome: EffectOutcome
  try {
    outcome = work()
  } catch (e) {
    // crash/unexpected window — the honest verdict is 'unknown', and the
    // stored intent stays for reconciliation (never re-run with a new key)
    const receipt = {
      state: 'unknown',
      receipt: { error: String((e as Error).message ?? e) },
      residuals: []
    }
    db.prepare('UPDATE host_effects SET state=?, receipt_json=? WHERE effect_key=?').run(
      'unknown',
      JSON.stringify(receipt),
      args.effectKey
    )
    throw e
  }

  const stored = {
    state: outcome.state,
    receipt: outcome.receipt ?? {},
    residuals: outcome.residuals ?? [],
    result: outcome.result
  }
  db.prepare('UPDATE host_effects SET state=?, receipt_json=? WHERE effect_key=?').run(
    outcome.state,
    JSON.stringify(stored),
    args.effectKey
  )
  return {
    effectKey: args.effectKey,
    state: outcome.state,
    receipt: outcome.receipt ?? {},
    residuals: outcome.residuals ?? [],
    replayed: false,
    result: outcome.result
  }
}

// ---------------------------------------------------------------------------
// host_workspaces rows — physical workspace records owned by THIS db
// ---------------------------------------------------------------------------

export function insertHostWorkspace(
  db: DatabaseSync,
  args: { id: string; effectKey: string; canonicalPath: string; identity: unknown; state: string }
): void {
  db.prepare(
    `INSERT INTO host_workspaces (id, effect_key, canonical_path, identity_json, state)
     VALUES (?,?,?,?,?)`
  ).run(args.id, args.effectKey, args.canonicalPath, JSON.stringify(args.identity), args.state)
}

export function updateHostWorkspaceState(db: DatabaseSync, id: string, state: string): void {
  db.prepare('UPDATE host_workspaces SET state=? WHERE id=?').run(state, id)
}

export function findHostWorkspaceByPath(
  db: DatabaseSync,
  canonicalPath: string
): {
  id: string
  effect_key: string
  canonical_path: string
  identity_json: string
  state: string
} | null {
  const row = db
    .prepare(
      'SELECT id, effect_key, canonical_path, identity_json, state FROM host_workspaces WHERE canonical_path=? ORDER BY rowid DESC'
    )
    .get(canonicalPath) as
    | {
        id: string
        effect_key: string
        canonical_path: string
        identity_json: string
        state: string
      }
    | undefined
  return row ?? null
}

// ---------------------------------------------------------------------------
// filesystem identity + canonicalization — the real primitives
// ---------------------------------------------------------------------------

/** dev:ino — the "filesystem identity" the control plane compares claims on */
export function filesystemIdentityOf(st: { dev: number | bigint; ino: number | bigint }): string {
  return `devino:${st.dev.toString()}:${st.ino.toString()}`
}

export function statIdentity(path: string): {
  status: 'present' | 'absent' | 'unverifiable'
  identity?: string
  isDir?: boolean
  error?: string
} {
  try {
    const st = statSync(path)
    return { status: 'present', identity: filesystemIdentityOf(st), isDir: st.isDirectory() }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'absent' }
    return { status: 'unverifiable', error: `stat:${code ?? String(e)}` }
  }
}

/** canonicalize an existing path (must exist — realpath resolves symlinks) */
export function canonicalExisting(path: string): string {
  return realpathSync.native(resolve(path))
}

/** canonicalize a not-yet-existing target through its nearest existing ancestor */
export function canonicalTarget(path: string): string {
  const abs = resolve(path)
  try {
    return realpathSync.native(abs)
  } catch {
    /* tail does not exist */
  }
  let cursor = abs
  const tail: string[] = []
  for (;;) {
    const parent = resolve(cursor, '..')
    tail.unshift(cursor.slice(parent.length + 1))
    cursor = parent
    try {
      const real = realpathSync.native(cursor)
      return tail.length ? [real, ...tail].join('/') : real
    } catch {
      if (parent === cursor) return abs
    }
  }
}

/** approved-path containment: resolved target must stay inside resolved root */
export function isContained(rootReal: string, targetCanonical: string): boolean {
  const rel = relative(rootReal, targetCanonical)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// ---------------------------------------------------------------------------
// git — repo detection + worktree ops, always -C anchored, never via shell
// ---------------------------------------------------------------------------

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
}

export function git(
  gitBin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {}
): GitResult {
  try {
    const stdout = execFileSync(gitBin, args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024
    })
    return { ok: true, stdout, stderr: '', status: 0 }
  } catch (e) {
    const err = e as {
      status?: number
      stderr?: Buffer | string
      stdout?: Buffer | string
      message?: string
    }
    return {
      ok: false,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() || (err.message ?? 'git failed'),
      status: typeof err.status === 'number' ? err.status : null
    }
  }
}

export interface RepoInfo {
  isRepo: boolean
  /** canonical path of the (common) git dir — the repository identity */
  repositoryIdentity?: string
  /** worktrees/<name> basename for linked worktrees */
  worktreeIdentity?: string
  headCommit?: string
}

/** detect repository/worktree identity for an existing checkout dir */
export function detectRepo(dirCanonical: string, gitBin: string): RepoInfo {
  if (!existsSync(dirCanonical)) return { isRepo: false }
  const common = git(gitBin, ['-C', dirCanonical, 'rev-parse', '--git-common-dir'], {})
  const gitdir = git(gitBin, ['-C', dirCanonical, 'rev-parse', '--absolute-git-dir'], {})
  if (!gitdir.ok) return { isRepo: false }
  const absGit = gitdir.stdout.trim()
  let repositoryIdentity: string | undefined
  try {
    repositoryIdentity = realpathSync.native(
      common.ok ? resolve(dirCanonical, common.stdout.trim()) : absGit
    )
  } catch {
    repositoryIdentity = absGit
  }
  const head = git(gitBin, ['-C', dirCanonical, 'rev-parse', 'HEAD'], {})
  // linked worktree iff the per-worktree gitdir lives under <common>/worktrees/
  let worktreeIdentity: string | undefined
  if (absGit.includes('/worktrees/')) {
    worktreeIdentity = absGit.slice(absGit.lastIndexOf('/') + 1)
  }
  return {
    isRepo: true,
    repositoryIdentity,
    worktreeIdentity,
    headCommit: head.ok ? head.stdout.trim() : undefined
  }
}

/** bounded dirty check — porcelain is evidence, cap the blast radius */
export function dirtyEvidence(
  dirCanonical: string,
  gitBin: string
): 'clean' | 'dirty' | 'unverifiable' {
  const r = git(
    gitBin,
    ['-C', dirCanonical, 'status', '--porcelain=v1', '--untracked-files=normal'],
    {
      timeoutMs: 20000
    }
  )
  if (!r.ok) return 'unverifiable'
  return r.stdout.trim().length === 0 ? 'clean' : 'dirty'
}

export { withTx }
