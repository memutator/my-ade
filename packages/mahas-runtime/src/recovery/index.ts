// mahas-runtime/recovery — C-RECOVERY operation entrypoint (IMP-22/23).
//
// worker.stop, worker.resume and worker.release are the recovery mutations
// that must be reachable exactly when the plane is not writable (they are in
// the pre-ready allowlist). Handlers assert the current controller epoch
// and caller generation before touching anything — an old generation's
// request must never stop or resume a live execution (REQ-15).

import type { OperationRegistry, OperationHandler } from '../api/registry.ts'
import { makeStopHandler } from './stop.ts'
import { makeResumeHandler } from './resume.ts'
import { makeReleaseHandler } from './reconciler.ts'
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
  registry.register(
    {
      name: 'worker.release',
      visibility: 'member',
      mutation: true,
      summary:
        'retain/transfer/release residual resource claims of a settled execution — never inferred from stop'
    },
    makeReleaseHandler(deps, registry) as OperationHandler
  )
}

export type { RecoveryDeps } from './ports.ts'
export { reconcileExecutions } from './reconciler.ts'
export { reattachExecution } from './reattach.ts'
export { makeStopHandler } from './stop.ts'
export { makeResumeHandler } from './resume.ts'
export { makeReleaseHandler } from './reconciler.ts'

// canonical session bridge — the destination of the LegacyNativeConversation
// migration (recovery/session-handles.ts). Exported so the composition root and
// a migration operation can drive the explicit, evidence-required backfill
// without importing recovery internals.
export {
  backfillExecutionSession,
  backfillLegacyExecutionSessions,
  canonicalSessionStorePresent,
  handleProfileEvidence,
  installationNamespace,
  legacyHandleFacts,
  normalizeResumeSupport,
  resolveExecutionSession,
  resolveResumeRecipe,
  runExecutionSessionBackfillPass,
  stableSessionAttachmentId,
  stableSessionHandleId,
  stableSessionId
} from './session-handles.ts'
export type {
  BackfillInput,
  BackfillOutcome,
  CanonicalSessionRef,
  ExecutionSessionBackfillPassPlan,
  ExecutionSessionBackfillPassResult,
  HarnessEvidence,
  LegacyBackfillPlan,
  LegacyBackfillPointer,
  LegacyBackfillReport,
  LegacyHandleFacts,
  SessionRecipeResolution,
  SessionRecipeSelection,
  SessionRefEvidence,
  SessionResolution,
  SessionUnresolved,
  SessionUnresolvedReason
} from './session-handles.ts'

// production harness/installation evidence for the backfill (registered profile
// → Pack launcher evidence → local installation; never a name heuristic)
export {
  harnessEvidenceResolver,
  profileHarnessEvidence,
  registeredProfileEvidence
} from './harness-evidence.ts'
export type {
  HarnessEvidenceOptions,
  HarnessEvidenceOverride,
  ProfileHarnessEvidence,
  RegisteredProfileEvidence
} from './harness-evidence.ts'

// additive schema for the canonical reference + backfill progress (schema v3/v4)
export {
  EXECUTION_SESSION_BACKFILL_STATE_SCHEMA_SQL,
  EXECUTION_SESSION_BACKFILL_STATE_TABLE,
  EXECUTION_SESSION_REF_SCHEMA_SQL,
  EXECUTION_SESSION_REF_TABLE,
  LEGACY_NATIVE_CONVERSATION_BACKFILL_ID
} from './session-reference-migration.ts'
