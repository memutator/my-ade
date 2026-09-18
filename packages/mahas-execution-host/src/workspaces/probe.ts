// workspaces/probe.ts — host.workspace.probe (C-HOST).
//
// IMP-16. Observation only — answers exists/dirty/live-use evidence against
// the REAL canonical resource identity. The contract's sharp edge:
// "unverifiable는 absent 아님" — an unverifiable verdict is never collapsed
// into a negative. Only a genuine ENOENT is 'absent'.

import {
  assertLease,
  canonicalTarget,
  detectRepo,
  dirtyEvidence,
  fail,
  statIdentity,
  type ResolvedDeps,
  type WorkspaceOpCall
} from './common.ts'

// ---------------------------------------------------------------------------
// wire shapes
// ---------------------------------------------------------------------------

export interface HostWorkspaceProbePayload {
  /** host_workspaces row id — optional lookup shortcut */
  checkoutId?: string
  canonicalPath?: string
  expectedFilesystemIdentity?: string
  expectedWorktreeIdentity?: string
}

export interface HostWorkspaceProbeResult {
  /** 'exists' | 'absent' | 'unverifiable' — never a guessed verdict */
  state: 'exists' | 'absent' | 'unverifiable'
  canonicalPath?: string
  filesystemIdentity?: string
  /** false when the live inode differs from the expected one — the expected
   *  resource is GONE (replaced); that is positive evidence, not absence */
  identityMatch?: boolean
  worktreeIdentityMatch?: boolean | null
  isRepo?: boolean
  headCommit?: string
  dirty?: 'clean' | 'dirty' | 'unverifiable' | null
  liveUse?: 'unverifiable' | 'none-detected'
  evidence?: unknown
}

export function hostWorkspaceProbe(
  call: WorkspaceOpCall,
  payload: unknown,
  deps: ResolvedDeps
): HostWorkspaceProbeResult {
  const p = payload as Partial<HostWorkspaceProbePayload>
  if (deps.verifyLease) assertLease(call.db, call.envelope, deps.now())

  let canonicalPath =
    typeof p?.canonicalPath === 'string' && p.canonicalPath ? p.canonicalPath : null
  if (!canonicalPath && typeof p?.checkoutId === 'string' && p.checkoutId) {
    const row = call.db
      .prepare('SELECT canonical_path FROM host_workspaces WHERE id=?')
      .get(p.checkoutId) as { canonical_path: string } | undefined
    canonicalPath = row?.canonical_path ?? null
  }
  if (!canonicalPath) {
    fail('INPUT_NOT_READY', 'probe requires canonicalPath or a known checkoutId', 'none', {
      field: 'canonicalPath'
    })
  }
  const target = canonicalTarget(canonicalPath)
  const st = statIdentity(target)

  if (st.status === 'absent') {
    return {
      state: 'absent',
      canonicalPath: target,
      evidence: { stat: 'ENOENT', at: deps.now() }
    }
  }
  if (st.status === 'unverifiable' || !st.identity) {
    // NOT absent — the caller must treat this as unverified evidence
    return {
      state: 'unverifiable',
      canonicalPath: target,
      evidence: { stat: st.error ?? 'unverifiable', at: deps.now() }
    }
  }

  const fsid = st.identity
  const repo = detectRepo(target, deps.gitBin)
  const dirty = repo.isRepo ? dirtyEvidence(target, deps.gitBin) : null
  const identityMatch =
    p.expectedFilesystemIdentity === undefined ? null : st.identity === p.expectedFilesystemIdentity
  const worktreeIdentityMatch =
    p.expectedWorktreeIdentity === undefined
      ? null
      : repo.worktreeIdentity === p.expectedWorktreeIdentity

  return {
    state: 'exists',
    canonicalPath: target,
    filesystemIdentity: fsid,
    identityMatch: identityMatch ?? undefined,
    worktreeIdentityMatch,
    isRepo: repo.isRepo,
    headCommit: repo.headCommit,
    dirty,
    // honest about what this host cannot prove: we report inode/repo/dirty
    // facts; we do NOT claim to detect open writers (that evidence comes from
    // host.process.probe / the claim row, not the filesystem)
    liveUse: 'unverifiable',
    evidence: { at: deps.now(), isDir: st.isDir }
  }
}
