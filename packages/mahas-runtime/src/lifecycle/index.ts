// mahas-runtime / lifecycle — public surface of the IMP-23 boundary.
//
// Consumers:
//   IMP-30 (integrator)  — startMahasd from ../main.ts; registerRuntimeOps
//                          for the registry it assembles; MahasdLifecycle
//                          for shutdown hooks and the readiness gate.
//   IMP-28/29 (clients)  — the runtime.* operation payload types.

export { MahasdLifecycle } from './lifecycle.ts'
export type { LifecycleOptions } from './lifecycle.ts'
export { registerRuntimeOps } from './operations.ts'
export type { RuntimeOpsDeps } from './operations.ts'
export { ReadinessTracker, PRE_READY_ALLOWED, controlUnavailable, fail } from './readiness.ts'
export type { ReadinessSnapshot, StartupStage } from './readiness.ts'
export {
  MAHASD_PROTOCOL_VERSION,
  SERVICE_ID,
  BootstrapError,
  acquireServiceLock,
  assessExistingService,
  buildEndpointFile,
  checkCrashLoop,
  collectProcessIdentity,
  lifecyclePaths,
  publishEndpointFile,
  readBootId,
  readEndpointFile,
  readProcessBirthEvidence,
  recordBootMarker,
  removeEndpointFile,
  verdictForProcess,
  DEFAULT_CRASH_LOOP
} from './service-bootstrap.ts'
export type { CrashLoopPolicy, ProcessVerdict, ServiceLock } from './service-bootstrap.ts'
export { runReconcile, markPriorInstancesStopped } from './reconcile.ts'
export type { ReconcileDeps, ReconcileScope } from './reconcile.ts'
export { beginShutdownRecord, latestShutdown, readShutdown, runShutdownStages } from './shutdown.ts'
export type { ShutdownDeps, ShutdownRequest } from './shutdown.ts'
export type {
  CrossDomainCaller,
  HostStatusItem,
  LifecycleDeps,
  LifecycleState,
  ProcessIdentity,
  ReconcileDecision,
  ReconcileReport,
  RuntimeStatusReport,
  ServiceEndpointFile,
  ShutdownMode,
  ShutdownResidual,
  ShutdownStage
} from './types.ts'
