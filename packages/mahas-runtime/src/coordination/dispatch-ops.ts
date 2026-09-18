// mahas-runtime / coordination — composed dispatch creation + the
// service-facing op registrations.
//
// IMP-14 (dispatch side of C-WORK). `createDispatch` is the single path that
// makes an attempt: it resolves the TaskSpec revision's inputs to exact
// artifact pins, builds the pinned WorkEnvelope (or reuses one already pinned
// by worker.prepare), and reserves the one active Dispatch — atomically
// inside the caller's transaction. It is invoked by:
//   IMP-19 worker.start  — after a LaunchPlan pinned envelope_digest at
//                          prepare; passes `envelopeDigest`, no re-resolution
//   IMP-21 task.dispatch — reusing a joined execution; passes `envelope` input
//                          so envelope + dispatch are built in one transaction
//   IMP-20 task.accept   — uses checkAttemptAuthority / acceptDispatch ops
//
// `registerDispatchOps` exposes these as service-visibility operations on the
// OperationRegistry so cross-boundary consumers reach them by op name through
// makeCaller — never by importing this module (SHARED-APIS.md rule).
//
// These `dispatch.*`/`taskSpec.*`/`inputs.*`/`envelope.*` names are INTERNAL
// service ops — they are not member-visible surface operations and are
// intentionally absent from spec/operations.md's public list.

import type { DatabaseSync } from 'node:sqlite'
import type { OperationRegistry } from '../api/registry.ts'
import {
  asObject,
  badInput,
  fail,
  newId,
  optInt,
  optObj,
  optStr,
  reqInt,
  reqStr
} from './internal.ts'
import {
  getTaskSpec,
  getCurrentTaskSpec,
  createTask,
  putTaskSpecRevision,
  type TaskSpecContent
} from './task-spec.ts'
import { pinInputs, resolveInputs } from './input-resolver.ts'
import {
  buildCoordinationEnvelope,
  buildTaskEnvelope,
  getWorkEnvelope,
  type PeerRef,
  type StoredEnvelope
} from './work-envelope.ts'
import {
  acceptDispatch,
  advanceDispatchPhase,
  checkAttemptAuthority,
  fenceDispatch,
  getActiveDispatchForExecution,
  getActiveDispatchForTask,
  getDispatch,
  linkAssignmentDelivery,
  reserveDispatch,
  settleDispatch,
  type DispatchPhase
} from './dispatch-authority.ts'
import type { ArtifactRef } from '../../../mahas-contracts/src/common.ts'
import type { Dispatch } from '../../../mahas-contracts/src/work.ts'

export const DISPATCH_OPS = {
  taskSpecGet: 'taskSpec.get',
  taskSpecCreate: 'taskSpec.create',
  taskSpecRevise: 'taskSpec.revise',
  inputsPin: 'inputs.pin',
  envelopeCreateTask: 'envelope.createTask',
  envelopeCreateCoordination: 'envelope.createCoordination',
  envelopeGet: 'envelope.get',
  dispatchCreate: 'dispatch.create',
  dispatchGet: 'dispatch.get',
  dispatchActive: 'dispatch.active',
  dispatchCheckAttempt: 'dispatch.checkAttempt',
  dispatchAccept: 'dispatch.accept',
  dispatchAdvancePhase: 'dispatch.advancePhase',
  dispatchFence: 'dispatch.fence',
  dispatchSettle: 'dispatch.settle',
  dispatchLinkDelivery: 'dispatch.linkDelivery'
} as const

export interface DispatchServiceDeps {
  /** id factory — injectable so callers/tests can keep ids deterministic */
  makeId?: (kind: 'task' | 'dispatch' | 'envelope') => string
}

// ── createDispatch ──────────────────────────────────────────────────────────

export interface CreateDispatchInput {
  taskId: string
  /** exact spec pin — never resolves "latest" itself */
  taskRevision: number
  memberId: string
  executionId: string
  generation: number
  /**
   * Envelope source — exactly one of:
   *   envelopeDigest — an already-pinned task envelope (worker.start path:
   *                    worker.prepare pinned it into the LaunchPlan)
   *   envelope       — build a fresh one now (task.dispatch path): inputs are
   *                    re-pinned here and INPUT_NOT_READY propagates
   */
  envelopeDigest?: string
  envelope?: {
    assignmentId: string
    assignmentRevision: number
    peers?: PeerRef[]
    inputOverrides?: Record<string, ArtifactRef>
  }
  /** caller-chosen dispatch id (idempotent retries reuse the same id) */
  dispatchId?: string
  /** set when the assignment Message/Delivery already exists in this tx */
  assignmentDeliveryId?: string
}

export interface CreateDispatchResult {
  dispatch: Dispatch
  envelope: StoredEnvelope
  /** the resolved inputs baked into the envelope (when built here) */
  inputs?: unknown
}

export function createDispatch(
  db: DatabaseSync,
  input: CreateDispatchInput,
  deps?: DispatchServiceDeps
): CreateDispatchResult {
  const dispatchId = input.dispatchId ?? deps?.makeId?.('dispatch') ?? newId('dsp')

  let envelope: StoredEnvelope
  let inputs: unknown
  if (input.envelope !== undefined) {
    // fresh envelope — dispatchId is known here so the pinned body names it
    const built = buildTaskEnvelope(db, {
      assignmentId: input.envelope.assignmentId,
      assignmentRevision: input.envelope.assignmentRevision,
      taskId: input.taskId,
      taskRevision: input.taskRevision,
      dispatchId,
      peers: input.envelope.peers,
      inputOverrides: input.envelope.inputOverrides
    })
    envelope = built
    inputs = built.bindings.inputs
  } else if (input.envelopeDigest !== undefined) {
    const stored = getWorkEnvelope(db, input.envelopeDigest)
    if (!stored || stored.kind !== 'task') {
      fail(
        'ARTIFACT_MISMATCH',
        `envelope ${input.envelopeDigest} is not a pinned task envelope`,
        'none',
        {
          envelopeDigest: input.envelopeDigest
        }
      )
    }
    envelope = stored
  } else {
    fail(
      'MODEL_INVALID',
      'createDispatch needs envelopeDigest or an envelope build input',
      'none',
      {
        taskId: input.taskId
      }
    )
  }

  const dispatch = reserveDispatch(db, {
    dispatchId,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    memberId: input.memberId,
    executionId: input.executionId,
    generation: input.generation,
    envelopeDigest: envelope.digest,
    assignmentDeliveryId: input.assignmentDeliveryId
  })
  return { dispatch, envelope, inputs }
}

// ── op registration ─────────────────────────────────────────────────────────

type Payload = Record<string, unknown>

function specContent(p: Payload, op: string): TaskSpecContent {
  return {
    title: reqStr(p, 'title', op),
    requirementText: reqStr(p, 'requirementText', op),
    ownerRoleId: reqStr(p, 'ownerRoleId', op),
    assignedMemberId: optStr(p, 'assignedMemberId', op),
    inputBindings: Array.isArray(p.inputBindings) ? p.inputBindings : [],
    outputSlots: Array.isArray(p.outputSlots) ? p.outputSlots : [],
    settlementPolicy: p.settlementPolicy
  }
}

/**
 * Register IMP-14's internal service ops. Handlers run inside the registry's
 * transaction/admission envelope (txn.db is the control DB). Visibility
 * 'service' keeps them off member/operator surfaces — they exist for
 * makeCaller cross-boundary use by IMP-15/19/20/21.
 */
export function registerDispatchOps(registry: OperationRegistry, deps?: DispatchServiceDeps): void {
  const svc = { visibility: 'service' } as const

  registry.register({ name: DISPATCH_OPS.taskSpecGet, ...svc, mutation: false }, (txn, payload) => {
    const op = DISPATCH_OPS.taskSpecGet
    const p = asObject(payload, op)
    const revision = optInt(p, 'revision', op)
    if (revision !== undefined) return getTaskSpec(txn.db, reqStr(p, 'taskId', op), revision)
    return getCurrentTaskSpec(txn.db, reqStr(p, 'taskId', op))
  })

  registry.register(
    { name: DISPATCH_OPS.taskSpecCreate, ...svc, mutation: true },
    (txn, payload) => {
      const op = DISPATCH_OPS.taskSpecCreate
      const p = asObject(payload, op)
      return createTask(txn.db, {
        taskId: optStr(p, 'taskId', op) ?? deps?.makeId?.('task') ?? newId('task'),
        runId: reqStr(p, 'runId', op),
        ...specContent(p, op)
      })
    }
  )

  registry.register(
    { name: DISPATCH_OPS.taskSpecRevise, ...svc, mutation: true },
    (txn, payload) => {
      const op = DISPATCH_OPS.taskSpecRevise
      const p = asObject(payload, op)
      const revised = putTaskSpecRevision(txn.db, reqStr(p, 'taskId', op), {
        ...specContent(p, op),
        expectedCurrentRevision: optInt(p, 'expectedCurrentRevision', op)
      })
      // explicit attempt disposition travels with the revision — 'fence' closes
      // the kept attempt's authority in the same transaction so its result can
      // never be adopted by the new requirement revision.
      const disposition = optStr(p, 'activeAttemptDisposition', op)
      if (disposition === 'fence') {
        const active = getActiveDispatchForTask(txn.db, revised.task.id as unknown as string)
        if (active)
          fenceDispatch(txn.db, active.id as unknown as string, { reason: 'taskSpec superseded' })
      } else if (disposition !== undefined && disposition !== 'keep') {
        badInput(`${op}: activeAttemptDisposition must be 'keep' or 'fence'`)
      }
      return revised
    }
  )

  registry.register({ name: DISPATCH_OPS.inputsPin, ...svc, mutation: false }, (txn, payload) => {
    const op = DISPATCH_OPS.inputsPin
    const p = asObject(payload, op)
    const bindings = Array.isArray(p.bindings) ? p.bindings : []
    if (p.dryRun === true) return resolveInputs(txn.db, bindings)
    return { inputs: pinInputs(txn.db, bindings) }
  })

  registry.register(
    { name: DISPATCH_OPS.envelopeCreateTask, ...svc, mutation: true },
    (txn, payload) => {
      const op = DISPATCH_OPS.envelopeCreateTask
      const p = asObject(payload, op)
      return buildTaskEnvelope(txn.db, {
        assignmentId: reqStr(p, 'assignmentId', op),
        assignmentRevision: reqInt(p, 'assignmentRevision', op),
        taskId: reqStr(p, 'taskId', op),
        taskRevision: reqInt(p, 'taskRevision', op),
        dispatchId: optStr(p, 'dispatchId', op),
        peers: Array.isArray(p.peers) ? (p.peers as PeerRef[]) : [],
        inputOverrides: p.inputOverrides as Record<string, ArtifactRef> | undefined
      })
    }
  )

  registry.register(
    { name: DISPATCH_OPS.envelopeCreateCoordination, ...svc, mutation: true },
    (txn, payload) => {
      const op = DISPATCH_OPS.envelopeCreateCoordination
      const p = asObject(payload, op)
      const roleContext = optObj(p, 'roleContext', op) as
        | {
            roleId: string
            implementationId: string
            implementationRevision: number
            interfaceDigest?: string
          }
        | undefined
      if (!roleContext) badInput(`${op}: 'roleContext' is required`)
      return buildCoordinationEnvelope(txn.db, {
        assignmentId: reqStr(p, 'assignmentId', op),
        assignmentRevision: reqInt(p, 'assignmentRevision', op),
        roleContext: roleContext!,
        peers: Array.isArray(p.peers) ? (p.peers as PeerRef[]) : []
      })
    }
  )

  registry.register({ name: DISPATCH_OPS.envelopeGet, ...svc, mutation: false }, (txn, payload) => {
    const op = DISPATCH_OPS.envelopeGet
    const p = asObject(payload, op)
    return getWorkEnvelope(txn.db, reqStr(p, 'digest', op))
  })

  registry.register(
    { name: DISPATCH_OPS.dispatchCreate, ...svc, mutation: true },
    (txn, payload) => {
      const op = DISPATCH_OPS.dispatchCreate
      const p = asObject(payload, op)
      const envelopeInput = optObj(p, 'envelope', op)
      return createDispatch(
        txn.db,
        {
          taskId: reqStr(p, 'taskId', op),
          taskRevision: reqInt(p, 'taskRevision', op),
          memberId: reqStr(p, 'memberId', op),
          executionId: reqStr(p, 'executionId', op),
          generation: reqInt(p, 'generation', op),
          envelopeDigest: optStr(p, 'envelopeDigest', op),
          envelope: envelopeInput
            ? {
                assignmentId: reqStr(envelopeInput, 'assignmentId', op),
                assignmentRevision: reqInt(envelopeInput, 'assignmentRevision', op),
                peers: Array.isArray(envelopeInput.peers) ? (envelopeInput.peers as PeerRef[]) : [],
                inputOverrides: envelopeInput.inputOverrides as
                  Record<string, ArtifactRef> | undefined
              }
            : undefined,
          dispatchId: optStr(p, 'dispatchId', op),
          assignmentDeliveryId: optStr(p, 'assignmentDeliveryId', op)
        },
        deps
      )
    }
  )

  registry.register({ name: DISPATCH_OPS.dispatchGet, ...svc, mutation: false }, (txn, payload) => {
    const op = DISPATCH_OPS.dispatchGet
    const p = asObject(payload, op)
    return getDispatch(txn.db, reqStr(p, 'dispatchId', op))
  })

  registry.register(
    { name: DISPATCH_OPS.dispatchActive, ...svc, mutation: false },
    (txn, payload) => {
      const op = DISPATCH_OPS.dispatchActive
      const p = asObject(payload, op)
      const taskId = optStr(p, 'taskId', op)
      const executionId = optStr(p, 'executionId', op)
      if (taskId) return getActiveDispatchForTask(txn.db, taskId)
      if (executionId) return getActiveDispatchForExecution(txn.db, executionId)
      badInput(`${op}: payload needs 'taskId' or 'executionId'`)
    }
  )

  registry.register(
    { name: DISPATCH_OPS.dispatchCheckAttempt, ...svc, mutation: false },
    (txn, payload) => {
      const op = DISPATCH_OPS.dispatchCheckAttempt
      const p = asObject(payload, op)
      return checkAttemptAuthority(txn.db, {
        dispatchId: reqStr(p, 'dispatchId', op),
        taskRevision: optInt(p, 'taskRevision', op),
        executionId: optStr(p, 'executionId', op),
        generation: optInt(p, 'generation', op),
        envelopeDigest: optStr(p, 'envelopeDigest', op)
      })
    }
  )

  registry.register(
    { name: DISPATCH_OPS.dispatchAccept, ...svc, mutation: true },
    (txn, payload) => {
      const op = DISPATCH_OPS.dispatchAccept
      const p = asObject(payload, op)
      return acceptDispatch(txn.db, reqStr(p, 'dispatchId', op), {
        taskRevision: optInt(p, 'taskRevision', op),
        executionId: optStr(p, 'executionId', op),
        generation: optInt(p, 'generation', op),
        envelopeDigest: optStr(p, 'envelopeDigest', op)
      })
    }
  )

  registry.register(
    { name: DISPATCH_OPS.dispatchAdvancePhase, ...svc, mutation: true },
    (txn, payload) => {
      const op = DISPATCH_OPS.dispatchAdvancePhase
      const p = asObject(payload, op)
      return advanceDispatchPhase(
        txn.db,
        reqStr(p, 'dispatchId', op),
        reqStr(p, 'phase', op) as DispatchPhase,
        optInt(p, 'expectedRevision', op)
      )
    }
  )

  registry.register(
    { name: DISPATCH_OPS.dispatchFence, ...svc, mutation: true },
    (txn, payload) => {
      const op = DISPATCH_OPS.dispatchFence
      const p = asObject(payload, op)
      return fenceDispatch(txn.db, reqStr(p, 'dispatchId', op), {
        reason: optStr(p, 'reason', op),
        expectedRevision: optInt(p, 'expectedRevision', op)
      })
    }
  )

  registry.register(
    { name: DISPATCH_OPS.dispatchSettle, ...svc, mutation: true },
    (txn, payload) => {
      const op = DISPATCH_OPS.dispatchSettle
      const p = asObject(payload, op)
      return settleDispatch(txn.db, reqStr(p, 'dispatchId', op), optInt(p, 'expectedRevision', op))
    }
  )

  registry.register(
    { name: DISPATCH_OPS.dispatchLinkDelivery, ...svc, mutation: true },
    (txn, payload) => {
      const op = DISPATCH_OPS.dispatchLinkDelivery
      const p = asObject(payload, op)
      return linkAssignmentDelivery(
        txn.db,
        reqStr(p, 'dispatchId', op),
        reqStr(p, 'deliveryId', op),
        optInt(p, 'expectedRevision', op)
      )
    }
  )
}
