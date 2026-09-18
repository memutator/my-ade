// mahas-runtime/recovery — C-RECOVERY operation entrypoint (IMP-22/23).
//
// worker.stop and worker.resume are the two recovery mutations that must be
// reachable exactly when the plane is not writable (they are in the
// pre-ready allowlist). Both handlers assert the current controller epoch
// and caller generation before touching anything — an old generation's
// request must never stop or resume a live execution (REQ-15).
//
// worker.release (post-settlement resource disposition) is not implemented
// yet; it is deliberately left unregistered so the surface never advertises
// an operation that cannot run.

import type { OperationRegistry, OperationHandler } from '../api/registry.ts'
import { makeStopHandler } from './stop.ts'
import { makeResumeHandler } from './resume.ts'
import type { RecoveryDeps } from './ports.ts'

export function registerRecoveryOps(registry: OperationRegistry, deps: RecoveryDeps): void {
  registry.register(
    {
      name: 'worker.stop',
      visibility: 'member',
      mutation: true,
      summary:
        'request stop of a specific process incarnation; unknown stays unknown until positive evidence'
    },
    makeStopHandler(deps) as OperationHandler
  )
  registry.register(
    {
      name: 'worker.resume',
      visibility: 'member',
      mutation: true,
      summary: 'reattach/native-resume/fresh generation for a member with explicit admission'
    },
    makeResumeHandler(deps) as OperationHandler
  )
}

export type { RecoveryDeps } from './ports.ts'
export { reconcileExecutions } from './reconciler.ts'
export { reattachExecution } from './reattach.ts'
export { makeStopHandler } from './stop.ts'
export { makeResumeHandler } from './resume.ts'
