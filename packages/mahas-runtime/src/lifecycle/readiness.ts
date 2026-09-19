// mahas-runtime / lifecycle — startup readiness and the mutation gate.
//
// spec/architecture.md §5 + IMP-23 instruction §4.2: writable readiness is
// published only AFTER the startup sequence finishes — schema check → new
// ControllerEpoch → host lease reconciliation → pending effect/claim
// 대조. Until then every mutation must fail CONTROL_UNAVAILABLE: a CLI or
// desktop must never be told its write was accepted while the control plane
// is still re-establishing what it owns ("message acceptance must never
// lie").
//
// A reconcile pass that FINISHES with unresolved scopes (unreachable host,
// unverifiable process) does not hold readiness forever — that would turn a
// dead host into permanent control-plane death, which the spec does not
// ask for. Instead the blockers stay listed in runtime.status, and ops
// touching unresolved resources fail on their own epoch/lease checks.

import type { LifecycleState } from './types.ts'
import type { MahasError } from '../../../mahas-contracts/src/index.ts'

export type StartupStage =
  | 'lock-acquired'
  | 'db-opened'
  | 'epoch-acquired'
  | 'endpoint-published'
  | 'reconcile-pass'
  | 'writable'

export interface ReadinessSnapshot {
  state: LifecycleState
  writableReady: boolean
  completedStages: StartupStage[]
  blockers: string[]
}

export function controlUnavailable(detail: string): MahasError {
  return { code: 'CONTROL_UNAVAILABLE', message: detail, retry: 'reconcile' }
}

/** handlers throw MahasError values (SHARED-APIS authorize convention) */
export function fail(err: MahasError): never {
  throw err
}

export class ReadinessTracker {
  private completed = new Set<StartupStage>()
  private blockers: string[] = []
  private state: LifecycleState = 'starting'
  private draining = false
  private extraPreReady = new Set<string>()

  mark(stage: StartupStage): void {
    this.completed.add(stage)
    if (stage === 'writable') this.state = 'ready'
  }

  setState(state: LifecycleState): void {
    this.state = state
  }

  addBlocker(reason: string): void {
    if (!this.blockers.includes(reason)) this.blockers.push(reason)
  }

  clearBlocker(reason: string): void {
    this.blockers = this.blockers.filter((b) => b !== reason)
  }

  /** begin a drain — new admissions stop immediately and permanently */
  beginDrain(): void {
    this.draining = true
    if (this.state !== 'stopping' && this.state !== 'stopped') this.state = 'draining'
  }

  /**
   * The admission check every mutation must pass. Not-writable-yet and
   * draining both refuse with CONTROL_UNAVAILABLE — the difference is only
   * the message, because both are the same honest verdict: this write was
   * NOT accepted.
   */
  assertWritable(operation: string): void {
    if (this.draining) {
      fail(
        controlUnavailable(`${operation}: runtime is draining/stopping — new admissions are closed`)
      )
    }
    if (this.state !== 'ready') {
      fail(
        controlUnavailable(
          `${operation}: mahasd is ${this.state} — startup reconciliation has not ` +
            `published writable readiness yet (stages done: ${[...this.completed].join(',') || 'none'})`
        )
      )
    }
  }

  /**
   * Operations that must stay reachable while not writable — the operator's
   * only window into why the plane is unavailable and the reconcile lever
   * to fix it. Everything else fails the gate.
   */
  isPreReadyAllowed(operation: string): boolean {
    return this.extraPreReady.has(operation) || PRE_READY_ALLOWED.has(operation)
  }

  /**
   * Widen the pre-ready read window (MahasdOptions.preReadyAllowedExtra).
   * Additive only — the fixed operator/recovery allowlist can never shrink.
   */
  allowPreReady(operations: Iterable<string>): void {
    for (const op of operations) this.extraPreReady.add(op)
  }

  /** gate an operation: pre-ready only the allowlist passes; drains refuse all mutations */
  check(operation: string, mutation: boolean): void {
    if (this.draining && mutation) {
      fail(controlUnavailable(`${operation}: runtime is draining — mutations are closed`))
    }
    if (this.state !== 'ready' && !this.isPreReadyAllowed(operation)) {
      fail(
        controlUnavailable(
          `${operation}: mahasd is ${this.state} — startup reconciliation incomplete`
        )
      )
    }
  }

  snapshot(): ReadinessSnapshot {
    return {
      state: this.state,
      writableReady: this.state === 'ready' && !this.draining,
      completedStages: [...this.completed],
      blockers: [...this.blockers]
    }
  }
}

/**
 * operations allowed before writable readiness: the operator's read window
 * plus the recovery levers. domain mutations (run.create, worker.*, mail)
 * are deliberately NOT here — they need a reconciled plane.
 */
export const PRE_READY_ALLOWED: ReadonlySet<string> = new Set([
  'runtime.status',
  'runtime.reconcile',
  'runtime.shutdown',
  'surface.describe',
  'operation.get'
])
