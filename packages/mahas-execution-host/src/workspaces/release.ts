// workspaces/release.ts — host.workspace.release (C-HOST).
//
// IMP-16. Physical cleanup: intent → remove → confirm. The contract's hard
// line: "경로만 보고 재귀 삭제 금지" — we NEVER recursively delete a path
// whose live dev:ino differs from the expected filesystemIdentity, because
// that would delete a DIFFERENT resource than the one the claim covered.
// No live/unverifiable writer + explicit dirty handling are preconditions
// the control plane checks; the identity check is re-verified here anyway.

import { rmSync } from 'node:fs'
import { sha256Hex } from '../storage.ts' // IMP-03 host twin
import {
  assertLease,
  canonicalTarget,
  detectRepo,
  dirtyEvidence,
  fail,
  findHostWorkspaceByPath,
  git,
  runJournaledEffect,
  statIdentity,
  updateHostWorkspaceState,
  type ResolvedDeps,
  type WorkspaceOpCall
} from './common.ts'

// ---------------------------------------------------------------------------
// wire shapes — mirrored by mahas-runtime resources/release.ts
// ---------------------------------------------------------------------------

export interface HostWorkspaceReleasePayload {
  effectKey?: string
  canonicalPath: string
  /** REQUIRED — the identity pin the delete is conditioned on */
  expectedFilesystemIdentity: string
  expectedWorktreeIdentity?: string
  expectedClaimRevision?: number
  /** 'discard' permits deleting a dirty checkout; 'keep'/'archive' refuse it */
  dirtyDisposition: 'discard' | 'keep' | 'archive'
  claimToken?: string
}

export interface HostWorkspaceReleaseResult {
  effectKey: string
  state: 'confirmed' | 'rejected' | 'unknown'
  replayed: boolean
  receipt: unknown
  residuals: unknown[]
  removed?: boolean
  reason?: { code: string; message: string }
}

export function hostWorkspaceRelease(
  call: WorkspaceOpCall,
  payload: unknown,
  deps: ResolvedDeps
): HostWorkspaceReleaseResult {
  const p = payload as Partial<HostWorkspaceReleasePayload>
  if (!p || typeof p.canonicalPath !== 'string' || !p.canonicalPath) {
    fail('INPUT_NOT_READY', 'payload.canonicalPath required', 'none', { field: 'canonicalPath' })
  }
  if (typeof p.expectedFilesystemIdentity !== 'string' || !p.expectedFilesystemIdentity) {
    fail(
      'INPUT_NOT_READY',
      'expectedFilesystemIdentity is required — path-only recursive delete is forbidden',
      'none',
      {
        field: 'expectedFilesystemIdentity'
      }
    )
  }
  if (
    p.dirtyDisposition !== 'discard' &&
    p.dirtyDisposition !== 'keep' &&
    p.dirtyDisposition !== 'archive'
  ) {
    fail('INPUT_NOT_READY', 'dirtyDisposition must be discard|keep|archive', 'none', {
      field: 'dirtyDisposition'
    })
  }
  if (deps.verifyLease) assertLease(call.db, call.envelope, deps.now())

  const effectKey = call.envelope.effectKey ?? p.effectKey
  if (typeof effectKey !== 'string' || !effectKey) {
    fail(
      'INPUT_NOT_READY',
      'an effect key is required (envelope.effectKey or payload.effectKey)',
      'none',
      {
        field: 'effectKey'
      }
    )
  }
  const fingerprint =
    call.envelope.payloadFingerprint ?? sha256Hex(JSON.stringify({ ...p, effectKey: '<envelope>' }))

  const journaled = runJournaledEffect(
    call.db,
    { effectKey, fingerprint, kind: 'host.workspace.release', intent: p },
    () => doRelease(call, p as HostWorkspaceReleasePayload, effectKey, deps)
  )
  const out = journaled.result as HostWorkspaceReleaseResult | undefined
  return {
    effectKey,
    state: journaled.state,
    replayed: journaled.replayed,
    receipt: journaled.receipt,
    residuals: journaled.residuals,
    removed: out?.removed,
    reason: out?.reason
  }
}

function doRelease(
  call: WorkspaceOpCall,
  p: HostWorkspaceReleasePayload,
  effectKey: string,
  deps: ResolvedDeps
): {
  state: 'confirmed' | 'rejected' | 'unknown'
  receipt?: unknown
  residuals?: unknown[]
  result?: HostWorkspaceReleaseResult
} {
  const db = call.db
  const target = canonicalTarget(p.canonicalPath)
  const st = statIdentity(target)
  const wsRow = findHostWorkspaceByPath(db, target)

  if (st.status === 'absent') {
    // positively gone — idempotent confirm, nothing was removed by us
    if (wsRow) updateHostWorkspaceState(db, wsRow.id, 'released')
    return confirmed(effectKey, deps, { removed: false, absent: true })
  }
  if (st.status === 'unverifiable' || !st.identity) {
    return unknown(
      effectKey,
      'STOP_UNKNOWN',
      `target cannot be verified: ${st.error ?? 'unverifiable'}`,
      [
        {
          resourceRef: target,
          reason: 'release-target-unverified',
          liveEvidence: st.error ?? 'unverifiable',
          cleanupPolicy: 'preserve-until-reconciled'
        }
      ]
    )
  }

  // THE safety check: the inode must be the one the claim covered
  if (st.identity !== p.expectedFilesystemIdentity) {
    return rejected(
      effectKey,
      'RESOURCE_BUSY',
      'live filesystem identity differs from the expected resource — refusing to delete a different directory',
      {
        expected: p.expectedFilesystemIdentity,
        actual: st.identity,
        target
      }
    )
  }
  const repo = detectRepo(target, deps.gitBin)
  if (
    p.expectedWorktreeIdentity !== undefined &&
    repo.worktreeIdentity !== undefined &&
    p.expectedWorktreeIdentity !== repo.worktreeIdentity
  ) {
    return rejected(
      effectKey,
      'RESOURCE_BUSY',
      'live worktree identity differs from the expected resource',
      {
        expected: p.expectedWorktreeIdentity,
        actual: repo.worktreeIdentity
      }
    )
  }

  // explicit dirty handling — a dirty checkout is never silently discarded
  const dirty = repo.isRepo ? dirtyEvidence(target, deps.gitBin) : null
  if (dirty === 'dirty' && p.dirtyDisposition !== 'discard') {
    return rejected(
      effectKey,
      'RESOURCE_BUSY',
      `checkout is dirty and dirtyDisposition='${p.dirtyDisposition}' — refusing removal`,
      {
        target,
        headCommit: repo.headCommit
      }
    )
  }

  // remove: worktrees go through git so the repo metadata is pruned too;
  // plain dirs go through rm. A failed removal is 'unknown' + residual —
  // never a silent half-delete claim.
  let removeError: string | null = null
  if (repo.isRepo && repo.worktreeIdentity !== undefined) {
    const mainRepo = repo.repositoryIdentity
      ? repo.repositoryIdentity.slice(0, repo.repositoryIdentity.length - '.git'.length)
      : null
    const args = ['-C', mainRepo ?? target, 'worktree', 'remove']
    if (p.dirtyDisposition === 'discard') args.push('--force')
    args.push(target)
    const r = git(deps.gitBin, args, { timeoutMs: 60000 })
    if (!r.ok) removeError = `git worktree remove: ${r.stderr.slice(0, 2000)}`
  } else {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
    } catch (e) {
      removeError = `rm:${(e as NodeJS.ErrnoException).code ?? String(e)}`
    }
  }

  const after = statIdentity(target)
  if (removeError !== null || after.status !== 'absent') {
    if (wsRow) updateHostWorkspaceState(db, wsRow.id, 'release-unknown')
    return unknown(
      effectKey,
      'STOP_UNKNOWN',
      removeError ?? 'path still present after removal attempt',
      [
        {
          resourceRef: target,
          reason: 'cleanup-failed-or-unverified',
          liveEvidence: {
            removeError,
            postState: after.status,
            filesystemIdentity: after.identity
          },
          cleanupPolicy: 'preserve-until-reconciled'
        }
      ]
    )
  }

  if (wsRow) updateHostWorkspaceState(db, wsRow.id, 'released')
  return confirmed(effectKey, deps, {
    removed: true,
    wasWorktree: repo.worktreeIdentity !== undefined,
    wasDirty: dirty === 'dirty'
  })
}

function confirmed(
  effectKey: string,
  deps: ResolvedDeps,
  receipt: Record<string, unknown>
): { state: 'confirmed'; receipt: unknown; residuals: []; result: HostWorkspaceReleaseResult } {
  const full = { state: 'confirmed', at: deps.now(), ...receipt }
  return {
    state: 'confirmed',
    receipt: full,
    residuals: [],
    result: {
      effectKey,
      state: 'confirmed',
      replayed: false,
      receipt: full,
      residuals: [],
      removed: receipt.removed as boolean
    }
  }
}

function rejected(
  effectKey: string,
  code: string,
  message: string,
  details?: unknown
): { state: 'rejected'; receipt: unknown; residuals: []; result: HostWorkspaceReleaseResult } {
  const reason = { code, message, details }
  return {
    state: 'rejected',
    receipt: { state: 'rejected', reason },
    residuals: [],
    result: {
      effectKey,
      state: 'rejected',
      replayed: false,
      receipt: { reason },
      residuals: [],
      removed: false,
      reason
    }
  }
}

function unknown(
  effectKey: string,
  code: string,
  message: string,
  residuals: unknown[]
): {
  state: 'unknown'
  receipt: unknown
  residuals: unknown[]
  result: HostWorkspaceReleaseResult
} {
  const reason = { code, message }
  return {
    state: 'unknown',
    receipt: { state: 'unknown', reason },
    residuals,
    result: {
      effectKey,
      state: 'unknown',
      replayed: false,
      receipt: { reason },
      residuals,
      removed: false,
      reason
    }
  }
}
