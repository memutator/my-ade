// mahas-contracts — service endpoint / readiness / shutdown vocabulary.
//
// architecture.md §1 + §5: mahasd and execution-host run as service
// entrypoints reached over local authenticated RPC. The desktop is a
// client; UI close = detach, and operator shutdown is an explicit
// `drain-and-stop` or `leave-executions` request — never implied by a
// window closing.

import type { OperationId } from './identity.ts'

/** how to reach a service entrypoint. v1 is single local host only (REQ-28) */
export interface ServiceEndpoint {
  kind: 'unix-socket' | 'tcp' | 'stdio'
  /** unix-socket: filesystem path · tcp: host:port · stdio: command argv[0] */
  address: string
  /** which service this endpoint names — e.g. 'mahasd', 'mahas-execution-host' */
  service: string
}

/**
 * Honest readiness a client may report. There is no 'connected' pretense:
 * a reachable socket that has not negotiated the versioned protocol is
 * 'degraded', and 'unverifiable' means the client cannot tell.
 */
export type ServiceReadiness =
  'starting' | 'ready' | 'degraded' | 'unavailable' | 'unverifiable' | 'stopped'

export interface ServiceStatus {
  service: string
  readiness: ServiceReadiness
  endpoint?: ServiceEndpoint
  /** free-form evidence for the verdict — why degraded/unavailable */
  detail?: string
  /** epoch ms of the last check that produced this verdict */
  checkedAt?: number
}

/** spec §5 — the only two shutdown semantics a runtime shutdown may request */
export type ShutdownMode = 'drain-and-stop' | 'leave-executions'

export interface ShutdownRequest {
  mode: ShutdownMode
  /** REQ-14 — every mutation carries an operation id */
  operationId: OperationId
  reason?: string
}

export interface ShutdownAck {
  accepted: boolean
  mode?: ShutdownMode
  detail?: string
}
