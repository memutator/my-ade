// workspaces/mod.ts — registration seam for the host.workspace.* primitives.
//
// IMP-16 owns host.workspace.prepare / host.workspace.probe /
// host.workspace.release (spec/operations.md C-HOST block). IMP-17's daemon
// dispatch wires them by calling
//   registerWorkspaceHostOps(register, deps)
// where `register` is whatever (spec, handler) callback the daemon's op
// registry exposes — kept structural so the seam lands without this module
// knowing IMP-17's registry class. Nothing self-registers at import time.

import { resolveDeps, type WorkspaceHostDeps, type WorkspaceOpRegister } from './common.ts'
import { hostWorkspacePrepare } from './prepare.ts'
import { hostWorkspaceProbe } from './probe.ts'
import { hostWorkspaceRelease } from './release.ts'

export function registerWorkspaceHostOps(
  register: WorkspaceOpRegister,
  deps: WorkspaceHostDeps
): void {
  const d = resolveDeps(deps)
  register({ name: 'host.workspace.prepare', mutation: true }, (call, payload) =>
    hostWorkspacePrepare(call, payload, d)
  )
  register({ name: 'host.workspace.probe', mutation: false }, (call, payload) =>
    hostWorkspaceProbe(call, payload, d)
  )
  register({ name: 'host.workspace.release', mutation: true }, (call, payload) =>
    hostWorkspaceRelease(call, payload, d)
  )
}
