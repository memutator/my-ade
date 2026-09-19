// workspaces/prepare.ts — host.workspace.prepare (C-HOST).
//
// IMP-16. Materializes the physical checkout the control plane reserved a
// claim on: folder → mkdir/existing-dir adoption, worktree → git worktree
// add. Returns the CANONICAL identity (realpath + dev:ino + repo/worktree
// evidence) — mahasd's checkout row is provisional until this receipt lands.
// Precondition: approved-path containment + target collision + Git base, all
// verified HERE against the real filesystem — never trusted from the wire.

import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { sha256Hex } from '../storage.ts' // IMP-03 host twin
import {
  assertLease,
  canonicalExisting,
  canonicalTarget,
  detectRepo,
  fail,
  git,
  insertHostWorkspace,
  isContained,
  runJournaledEffect,
  statIdentity,
  type ResolvedDeps,
  type WorkspaceOpCall
} from './common.ts'

// ---------------------------------------------------------------------------
// wire shapes — mirrored by mahas-runtime resources/workspace.ts
// ---------------------------------------------------------------------------

export interface HostWorkspacePreparePayload {
  /** durable effect key; envelope.effectKey wins when both are present */
  effectKey?: string
  kind: 'folder' | 'worktree'
  /** approved containment root (canonicalized here before use) */
  projectRoot: string
  targetPath: string
  expectedRepositoryIdentity?: string
  /** worktree base ref, or required HEAD for folder checkouts */
  baseCommit?: string
  branch?: string
  /** control-plane claim id — journaled for correlation only */
  claimToken?: string
}

export interface HostWorkspacePrepareResult {
  effectKey: string
  state: 'confirmed' | 'rejected' | 'unknown'
  replayed: boolean
  receipt: unknown
  residuals: unknown[]
  checkout?: {
    canonicalPath: string
    filesystemIdentity: string
    repositoryIdentity?: string
    worktreeIdentity?: string
    headCommit?: string
    isRepo: boolean
  }
  reason?: { code: string; message: string }
}

export function hostWorkspacePrepare(
  call: WorkspaceOpCall,
  payload: unknown,
  deps: ResolvedDeps
): HostWorkspacePrepareResult {
  const p = payload as Partial<HostWorkspacePreparePayload>
  if (!p || (p.kind !== 'folder' && p.kind !== 'worktree')) {
    fail('INPUT_NOT_READY', 'payload.kind must be folder|worktree', 'none', { field: 'kind' })
  }
  if (typeof p.projectRoot !== 'string' || !p.projectRoot) {
    fail('INPUT_NOT_READY', 'payload.projectRoot required', 'none', { field: 'projectRoot' })
  }
  if (typeof p.targetPath !== 'string' || !p.targetPath) {
    fail('INPUT_NOT_READY', 'payload.targetPath required', 'none', { field: 'targetPath' })
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
    { effectKey, fingerprint, kind: 'host.workspace.prepare', intent: p },
    () => doPrepare(call, p as HostWorkspacePreparePayload, effectKey, deps)
  )
  const out = journaled.result as HostWorkspacePrepareResult | undefined
  return {
    effectKey,
    state: journaled.state,
    replayed: journaled.replayed,
    receipt: journaled.receipt,
    residuals: journaled.residuals,
    checkout: out?.checkout,
    reason: out?.reason
  }
}

function doPrepare(
  call: WorkspaceOpCall,
  p: HostWorkspacePreparePayload,
  effectKey: string,
  deps: ResolvedDeps
): {
  state: 'confirmed' | 'rejected' | 'unknown'
  receipt?: unknown
  residuals?: unknown[]
  result?: HostWorkspacePrepareResult
} {
  const db = call.db

  // --- containment: the approved root must exist and hold the target ------
  let rootReal: string
  try {
    rootReal = canonicalExisting(p.projectRoot)
  } catch {
    return rejected('INPUT_NOT_READY', `projectRoot is not an existing directory: ${p.projectRoot}`)
  }
  const rootStat = statIdentity(rootReal)
  if (rootStat.status !== 'present' || !rootStat.isDir) {
    return rejected('INPUT_NOT_READY', 'projectRoot is not a directory', {
      projectRoot: p.projectRoot
    })
  }
  const targetCanonical = canonicalTarget(p.targetPath)
  if (!isContained(rootReal, targetCanonical)) {
    return rejected('SCOPE_DENIED', 'target path escapes the approved placement root', {
      projectRoot: rootReal,
      target: targetCanonical
    })
  }

  // --- the physical effect ------------------------------------------------
  const before = statIdentity(targetCanonical)
  if (p.kind === 'folder') {
    if (before.status === 'present' && !before.isDir) {
      return rejected('RESOURCE_BUSY', 'target exists and is not a directory', {
        target: targetCanonical
      })
    }
    if (before.status === 'unverifiable') {
      return rejected('PROCESS_UNVERIFIABLE', 'target path cannot be verified', {
        target: targetCanonical,
        error: before.error
      })
    }
    if (before.status === 'absent') {
      try {
        mkdirSync(targetCanonical, { recursive: true })
      } catch (e) {
        return {
          state: 'unknown',
          receipt: { error: `mkdir:${(e as NodeJS.ErrnoException).code ?? String(e)}` },
          result: unknownResult(
            'START_UNKNOWN',
            `mkdir failed or is unverifiable: ${(e as NodeJS.ErrnoException).code ?? String(e)}`
          ),
          residuals: [
            {
              resourceRef: targetCanonical,
              reason: 'mkdir-partial-or-unverified',
              liveEvidence: String((e as Error).message ?? e),
              cleanupPolicy: 'preserve-until-reconciled'
            }
          ]
        }
      }
    }
  } else {
    // worktree: target must not exist, and the root must be a real git repo
    if (before.status === 'present') {
      return rejected('RESOURCE_BUSY', 'worktree target already exists', {
        target: targetCanonical
      })
    }
    if (before.status === 'unverifiable') {
      return rejected('PROCESS_UNVERIFIABLE', 'target path cannot be verified', {
        target: targetCanonical,
        error: before.error
      })
    }
    const repo = detectRepo(rootReal, deps.gitBin)
    if (!repo.isRepo) {
      return rejected(
        'INPUT_NOT_READY',
        'projectRoot is not a git repository — cannot add a worktree',
        {
          projectRoot: rootReal
        }
      )
    }
    if (
      p.expectedRepositoryIdentity !== undefined &&
      repo.repositoryIdentity !== undefined &&
      p.expectedRepositoryIdentity !== repo.repositoryIdentity
    ) {
      return rejected(
        'ARTIFACT_MISMATCH',
        'expected repositoryIdentity does not match the repo at projectRoot',
        {
          expected: p.expectedRepositoryIdentity,
          actual: repo.repositoryIdentity
        }
      )
    }
    const base = p.baseCommit ?? 'HEAD'
    const args = p.branch
      ? ['-C', rootReal, 'worktree', 'add', '-b', p.branch, targetCanonical, base]
      : ['-C', rootReal, 'worktree', 'add', '--detach', targetCanonical, base]
    const r = git(deps.gitBin, args, { timeoutMs: 120000 })
    if (!r.ok) {
      // git may have left a partial worktree — record the path as residual
      const after = statIdentity(targetCanonical)
      return {
        state: 'unknown',
        receipt: {
          error: 'git worktree add failed',
          stderr: r.stderr.slice(0, 4000),
          status: r.status
        },
        result: unknownResult(
          'START_UNKNOWN',
          'git worktree add failed or left an unverifiable partial'
        ),
        residuals:
          after.status === 'present'
            ? [
                {
                  resourceRef: targetCanonical,
                  reason: 'worktree-partial-or-unverified',
                  liveEvidence: {
                    filesystemIdentity: after.identity,
                    stderr: r.stderr.slice(0, 1000)
                  },
                  cleanupPolicy: 'preserve-until-reconciled'
                }
              ]
            : []
      }
    }
  }

  // --- identity: dev:ino + repo evidence are now authoritative ------------
  const after = statIdentity(targetCanonical)
  if (after.status !== 'present' || !after.isDir || !after.identity) {
    return {
      state: 'unknown',
      receipt: { error: 'checkout not verifiable after materialization' },
      result: unknownResult('START_UNKNOWN', 'checkout not verifiable after materialization'),
      residuals: [
        {
          resourceRef: targetCanonical,
          reason: 'post-effect-identity-unverified',
          liveEvidence: after.error ?? 'absent-after-effect',
          cleanupPolicy: 'preserve-until-reconciled'
        }
      ]
    }
  }
  const canonicalPath = canonicalExisting(targetCanonical)
  const repo = detectRepo(canonicalPath, deps.gitBin)
  if (
    p.baseCommit !== undefined &&
    p.kind === 'folder' &&
    repo.isRepo &&
    repo.headCommit !== p.baseCommit
  ) {
    return rejected('STALE_REVISION', 'expected base commit does not match checkout HEAD', {
      expected: p.baseCommit,
      actual: repo.headCommit
    })
  }

  const workspaceRowId = `wsp_${randomUUID()}`
  insertHostWorkspace(db, {
    id: workspaceRowId,
    effectKey,
    canonicalPath,
    identity: {
      filesystemIdentity: after.identity,
      repositoryIdentity: repo.repositoryIdentity,
      worktreeIdentity: repo.worktreeIdentity,
      kind: p.kind,
      claimToken: p.claimToken ?? null
    },
    state: 'prepared'
  })

  return {
    state: 'confirmed',
    receipt: {
      state: 'confirmed',
      at: deps.now(),
      workspaceRowId,
      canonicalPath,
      filesystemIdentity: after.identity
    },
    residuals: [],
    result: {
      effectKey,
      state: 'confirmed',
      replayed: false,
      receipt: { workspaceRowId },
      residuals: [],
      checkout: {
        canonicalPath,
        filesystemIdentity: after.identity,
        repositoryIdentity: repo.repositoryIdentity,
        worktreeIdentity: repo.worktreeIdentity,
        headCommit: repo.headCommit,
        isRepo: repo.isRepo
      }
    }
  }
}

function rejected(
  code: string,
  message: string,
  details?: unknown
): { state: 'rejected'; receipt: unknown; residuals: []; result: HostWorkspacePrepareResult } {
  const reason = { code, message, details }
  return {
    state: 'rejected',
    receipt: { state: 'rejected', reason },
    residuals: [],
    result: {
      effectKey: '',
      state: 'rejected',
      replayed: false,
      receipt: { reason },
      residuals: [],
      reason
    }
  }
}

function unknownResult(code: string, message: string): HostWorkspacePrepareResult {
  return {
    effectKey: '',
    state: 'unknown',
    replayed: false,
    receipt: { reason: { code, message } },
    residuals: [],
    reason: { code, message }
  }
}
