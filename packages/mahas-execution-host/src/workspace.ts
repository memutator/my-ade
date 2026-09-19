// workspace.ts — public entrypoint of the host workspace primitive module.
//
// IMP-16. IMP-17's daemon composition imports registerWorkspaceHostOps from
// here; the op implementations live in workspaces/{prepare,probe,release}.ts
// and the shared plumbing (lease check, effect journal, dev:ino identity,
// git detection) in workspaces/common.ts.

export { registerWorkspaceHostOps } from './workspaces/mod.ts'
export type {
  WorkspaceHostDeps,
  WorkspaceOpCall,
  WorkspaceOpEnvelope,
  WorkspaceOpHandler,
  WorkspaceOpRegister,
  WorkspaceOpSpec
} from './workspaces/common.ts'
export type {
  HostWorkspacePreparePayload,
  HostWorkspacePrepareResult
} from './workspaces/prepare.ts'
export type { HostWorkspaceProbePayload, HostWorkspaceProbeResult } from './workspaces/probe.ts'
export type {
  HostWorkspaceReleasePayload,
  HostWorkspaceReleaseResult
} from './workspaces/release.ts'
