// mahas-runtime / lifecycle — shared types for the mahasd service-lifetime
// boundary (platform/recovery, IMP-23).
//
// Row interfaces mirror spec/storage.md §3 column names exactly (snake_case
// on disk); report interfaces are THIS boundary's runtime.* payload shapes —
// camelCase per spec/common.md §1 conventions. Domain record names
// (RuntimeInstance, ExecutionHost, ControllerLease, RuntimeShutdown,
// ExecutionRecord, ResidualResource) are imported as types from
// mahas-contracts — IMP-02 lands them; until then these imports resolve at
// type-strip time only, which is why they are `import type` exclusively.

import type { DatabaseSync } from 'node:sqlite'
import type {
  ControllerEpoch,
  ExecutionGeneration,
  HostIncarnation,
  Id,
  ProcessIncarnation as _PI
} from '../../../mahas-contracts/src/index.ts'
import type {
  RuntimeInstance,
  ExecutionHost,
  ControllerLease,
  ExecutionRecord,
  ResidualResource
} from '../../../mahas-contracts/src/work.ts'
import type { RuntimeShutdown } from '../../../mahas-contracts/src/observation.ts'
import type { HostClient } from '../hostClient.ts'

// re-exported so lifecycle consumers see the contract names this boundary
// persists without re-importing contracts themselves
export type {
  RuntimeInstance,
  ExecutionHost,
  ControllerLease,
  ExecutionRecord,
  ResidualResource,
  RuntimeShutdown,
  HostClient,
  DatabaseSync,
  ControllerEpoch,
  ExecutionGeneration,
  HostIncarnation,
  Id
}

/** process identity evidence stored in runtime_instances.process_identity_json */
export interface ProcessIdentity {
  pid: number
  /** Linux /proc/<pid> starttime ticks, or platform equivalent; absent = unverifiable */
  birthEvidence?: string
  /** /proc/sys/kernel/random/boot_id when the platform exposes it */
  bootId?: string
  hostname: string
  startedAt: number
}

/** service endpoint file payload — spec/execution-lifecycle.md §5 */
export interface ServiceEndpointFile {
  service: 'mahasd'
  protocolVersion: number
  serviceId: string
  pid: number
  processIdentity: ProcessIdentity
  launchNonce: string
  endpointIncarnation: string
  endpoint: string
  publishedAt: number
}

// ---------------------------------------------------------------------------
// storage rows (spec/storage.md §3 — column names verbatim)
// ---------------------------------------------------------------------------

export interface RuntimeInstanceRow {
  id: string
  controller_epoch: number
  state: string
  process_identity_json: string
  endpoint_incarnation: string
}

export interface ExecutionHostRow {
  id: string
  incarnation: string
  protocol_version: string
  state: string
  identity_json: string
}

export interface ControllerLeaseRow {
  host_id: string
  epoch: number
  revision: number
  expires_at: number
  state: string
  proof_json: string
}

export interface ExecutionRow {
  id: string
  member_id: string
  generation: number
  host_id: string
  launch_plan_id: string
  state: string
  liveness: string
  terminal_id: string | null
  process_identity_json: string
  native_conversation_json: string
  revision: number
}

export interface EffectIntentRow {
  id: string
  operation_key: string
  kind: string
  fingerprint: string
  host_id: string | null
  state: string
  payload_json: string
  receipt_json: string
  residuals_json: string
}

export interface ResourceClaimRow {
  id: string
  resource_id: string
  owner_kind: string
  owner_id: string
  mode: string
  generation: number
  state: string
  revision: number
}

export interface RuntimeShutdownRow {
  operation_id: string
  mode: string
  state: string
  stages_json: string
  residuals_json: string
}

// ---------------------------------------------------------------------------
// runtime.* report shapes (this boundary's C-RECOVERY payload contract)
// ---------------------------------------------------------------------------

export type ShutdownMode = 'drain-and-stop' | 'leave-executions'

export type LifecycleState =
  'starting' | 'reconciling' | 'ready' | 'draining' | 'stopping' | 'stopped'

export interface HostStatusItem {
  hostId: string
  incarnation: string | null
  reachable: boolean | 'unverifiable'
  leaseEpoch: number | null
  leaseState: string | null
  detail?: string
}

export interface ReconcileDecision {
  targetKind:
    'execution' | 'effect' | 'claim' | 'terminal' | 'host' | 'runtime-instance' | 'shutdown'
  targetId: string
  decision:
    | 'reattached'
    | 'confirmed-exited'
    | 'left-unknown'
    | 'quarantined'
    | 'lease-acquired'
    | 'lease-failed'
    | 'host-unreachable'
    | 'host-protocol-mismatch'
    | 'claim-preserved'
    | 'effect-settled'
    | 'marked-crashed'
    | 'marked-stopped'
    | 'marked-interrupted'
  evidence: string
}

export interface ReconcileReport {
  controllerEpoch: number
  startedAt: number
  finishedAt: number
  decisions: ReconcileDecision[]
  unresolvedResources: Array<{ kind: string; id: string; reason: string }>
  nextAllowedActions: string[]
}

export interface ShutdownStage {
  name:
    | 'admission-stopped'
    | 'stop-intents'
    | 'evidence-recorded'
    | 'resources-preserved'
    | 'db-checkpoint-close'
  state: 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped'
  at?: number
  detail?: string
}

export interface ShutdownResidual {
  kind: 'execution' | 'effect' | 'claim' | 'terminal'
  id: string
  disposition:
    | 'left-running'
    | 'stop-confirmed'
    | 'stop-unknown'
    | 'stop-not-attempted'
    | 'claim-preserved'
    | 'unknown-preserved'
  detail: string
}

export interface RuntimeStatusReport {
  service: 'mahasd'
  state: LifecycleState
  writableReady: boolean
  controllerEpoch: number
  runtimeInstance: {
    id: string
    pid: number
    startedAt: number
    endpointIncarnation: string
  } | null
  schemaVersion: number | null
  hosts: HostStatusItem[]
  reconciliation: {
    state: 'never-run' | 'running' | 'completed' | 'blocked'
    lastReport?: ReconcileReport
    blockers: string[]
  }
  pendingEffects: number
  unresolvedResources: number
  shutdown: {
    inProgress: boolean
    operationId?: string
    mode?: string
    state?: string
  }
  uptimeMs: number
}

// ---------------------------------------------------------------------------
// dependency seam — everything external is injected so IMP-30 wires the real
// pieces (IMP-03 storage, IMP-11 registry, IMP-12 rpc, IMP-17 host client,
// IMP-22 worker.stop) without this boundary importing sibling internals.
// ---------------------------------------------------------------------------

export type { _PI as ProcessIncarnation }

/** cross-domain caller — makeCaller(registry, ctx) product (IMP-11) */
export type CrossDomainCaller = (
  operation: string,
  payload?: unknown,
  expectedRevisions?: Record<string, number>
) => Promise<unknown>

export type ConnectHostFn = (endpoint: string) => Promise<HostClient>
export type WithTxFn = <T>(db: DatabaseSync, fn: (db: DatabaseSync) => T) => T

export interface LifecycleDeps {
  db: DatabaseSync
  withTx: WithTxFn
  connectHost: ConnectHostFn
  /** makeCaller product used for cross-domain ops (e.g. worker.stop during drain) */
  caller: CrossDomainCaller | null
  now: () => number
  log: (line: Record<string, unknown>) => void
  /** resolve a host row to its reachable endpoint; default in lifecycle.ts */
  hostEndpoint?: (host: ExecutionHostRow) => string | null
  /** max wall-clock ms a drain waits for stop confirmations before residualizing */
  defaultDrainBudgetMs: number
}
