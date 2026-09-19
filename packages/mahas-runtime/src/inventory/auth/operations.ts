// inventory/auth/operations.ts — the auth operations UI/CLI call.
//
// Everything here is secret-free by construction: no operation accepts material, and
// none returns it. Sign-in material travels only over the dedicated channel
// (channel-server.ts), so an operator replaying a receipt from these operations sees
// references and identity claims, never a token.
//
// The operations take their dependencies as ports, so composition decides whether the
// auth domain exists at all — a daemon without the providers Pack simply never
// registers them.

import type { OperationHandler, OperationSpec } from '../../api/registry.ts'
import { deferredMutation } from '../../api/admission.ts'
import { mahasError } from '../../api/handler-ports.ts'
import type { AuthFlowView } from './coordinator.ts'
import type { AuthIntent, AuthIntentKind, AuthServiceStatus } from './service.ts'

export const AUTH_OPERATION_NAMES = {
  status: 'auth.status',
  intentBegin: 'auth.intent.begin',
  intentRecord: 'auth.intent.record',
  intentComplete: 'auth.intent.complete',
  intentList: 'auth.intent.list',
  flowList: 'auth.flow.list',
  flowStatus: 'auth.flow.status',
  flowCancel: 'auth.flow.cancel',
  flowRefresh: 'auth.flow.refresh',
  connectionInventory: 'auth.connection.inventory',
  locatorImport: 'auth.locator.import',
  locatorAdopt: 'auth.locator.adopt',
  quotaCollect: 'auth.quota.collect',
  quotaCurrent: 'auth.quota.current'
} as const

export interface AuthOperationRegistry {
  register(spec: OperationSpec, handler: OperationHandler): void
}

export interface AuthOperationPorts {
  status(): AuthServiceStatus
  beginIntent(input: {
    kind: AuthIntentKind
    offeringId: string
    connectionId?: string
    credentialId?: string
    expectedMaterialRevision?: number
  }): AuthIntent
  getIntent(intentId: string): AuthIntent | null
  listIntents(filter: {
    state?: AuthIntent['state']
    offeringId?: string
    limit?: number
  }): AuthIntent[]
  recordFlow(intentId: string, view: AuthFlowView): AuthIntent
  completeIntent(intentId: string): Promise<{
    completed: boolean
    credentialId?: string
    connectionId?: string
    identityClaimIds: readonly string[]
    replacedCredentialId?: string
  }>
  listFlows(): readonly AuthFlowView[]
  flowStatus(flowId: string): AuthFlowView
  cancelFlow(flowId: string, reason?: string): AuthFlowView
  refresh(input: {
    credentialRef: string
    expectedMaterialRevision: number
    offeringId: string
    connectionId: string
  }): Promise<AuthFlowView>
  /** credentials + connections + bindings for the settings UI, without material */
  inventory(): {
    credentials: readonly {
      id: string
      offeringId: string | null
      materialRef: string
      materialRevision: number
      ownership: string
      availability: string
      origin: string | null
      locatorRef: string | null
    }[]
    connections: readonly {
      id: string
      offeringId: string
      credentialId: string
      availability: string
    }[]
  }
  importLocators(input: { machineId: string }): Promise<unknown>
  adoptLocator(input: {
    machineId: string
    offeringId: string
    credentialId: string
    accountContinuity: 'confirmed-same'
    format: string
  }): Promise<unknown>
  collectQuota(): Promise<unknown>
  quotaCurrent(connectionId: string): unknown
  /**
   * The deferred halves. An operation that touches the filesystem or a provider must run
   * its IO in the effect phase (no transaction held) and its writes in the completion
   * phase (inside tx-2). These ports are how the registration below reaches them.
   */
  prepareLocatorImport(input: {
    /** the machine the credentials register against; the factory defaults it to the
     *  daemon local machine when the caller does not (or cannot) name one */
    machineId?: string
    /** explicit single-file import: the offering whose Pack catalog entry decides the
     *  credential format — the runtime never guesses a vendor format from bytes */
    offeringId?: string
    /** explicit single-file import: absolute path of the existing credential file */
    path?: string
  }): Promise<unknown>
  commitLocatorImportInTransaction(
    db: import('node:sqlite').DatabaseSync,
    prepared: unknown
  ): unknown
  prepareAdoption(input: {
    machineId: string
    offeringId: string
    credentialId: string
    accountContinuity: 'confirmed-same'
    format: string
  }): Promise<unknown>
  commitAdoptionInTransaction(db: import('node:sqlite').DatabaseSync, prepared: unknown): unknown
  /** read the flow status through the driver (network); no transaction held */
  flowViewForIntent(intentId: string): AuthFlowView | null
  commitCompletionInTransaction(
    db: import('node:sqlite').DatabaseSync,
    intentId: string,
    view: AuthFlowView
  ): unknown
  /** signal the quota loop; the loop's own tick does the provider call */
  signalQuotaCollect(): unknown
}

function record(value: unknown, name = 'payload'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw mahasError('MODEL_INVALID', name + ' must be an object', 'none')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw mahasError('MODEL_INVALID', name + ' must be a non-empty string', 'none')
  }
  return value
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw mahasError('MODEL_INVALID', name + ' must be a positive integer', 'none')
  }
  return Number(value)
}

const objectInput = (
  required: readonly string[],
  properties: Record<string, unknown>
): unknown => ({
  type: 'object',
  required,
  properties,
  additionalProperties: false
})

/**
 * Registers the secret-free auth surface. Every mutation is receipted like any other
 * operation — which is exactly why none of them may carry material.
 */
export function registerAuthOperations(
  operations: AuthOperationRegistry,
  ports: AuthOperationPorts
): void {
  operations.register(
    {
      name: AUTH_OPERATION_NAMES.status,
      visibility: 'member',
      mutation: false,
      summary: 'auth service status: flows, pending intents and quota polling state'
    },
    () => ports.status()
  )

  operations.register(
    {
      name: AUTH_OPERATION_NAMES.intentBegin,
      visibility: 'member',
      mutation: true,
      summary: 'open a sign-in/refresh intent before starting its provider flow',
      inputSchema: objectInput(['kind', 'offeringId'], {
        kind: { type: 'string' },
        offeringId: { type: 'string' },
        connectionId: { type: 'string' },
        credentialId: { type: 'string' },
        expectedMaterialRevision: { type: 'integer' }
      })
    },
    (txn, raw) => {
      const input = record(raw)
      const kind = text(input.kind, 'kind') as AuthIntentKind
      if (!['login', 'add-account', 'replace-account', 'refresh', 'repair'].includes(kind)) {
        throw mahasError('MODEL_INVALID', 'kind is not a supported auth intent', 'none')
      }
      const intent = ports.beginIntent({
        kind,
        offeringId: text(input.offeringId, 'offeringId'),
        ...(optionalText(input.connectionId)
          ? { connectionId: optionalText(input.connectionId) as string }
          : {}),
        ...(optionalText(input.credentialId)
          ? { credentialId: optionalText(input.credentialId) as string }
          : {}),
        ...(optionalInteger(input.expectedMaterialRevision, 'expectedMaterialRevision') !==
        undefined
          ? {
              expectedMaterialRevision: optionalInteger(
                input.expectedMaterialRevision,
                'expectedMaterialRevision'
              ) as number
            }
          : {})
      })
      txn.emitEvent({
        aggregateId: intent.id,
        aggregateRevision: intent.revision,
        eventType: 'auth.intent.begun',
        payload: { intentId: intent.id, kind: intent.kind, offeringId: intent.offeringId }
      })
      return intent
    }
  )

  operations.register(
    {
      name: AUTH_OPERATION_NAMES.intentRecord,
      visibility: 'member',
      mutation: true,
      summary: 'record the public state of a flow (never its material) on its intent',
      inputSchema: objectInput(['intentId', 'state'], {
        intentId: { type: 'string' },
        state: { type: 'string' },
        flowId: { type: 'string' },
        error: { type: 'string' }
      })
    },
    (_txn, raw) => {
      const input = record(raw)
      const intentId = text(input.intentId, 'intentId')
      const state = text(input.state, 'state') as AuthFlowView['state']
      if (!['complete', 'needs-input', 'effect-required', 'failed', 'unknown'].includes(state)) {
        throw mahasError('MODEL_INVALID', 'state is not a flow state', 'none')
      }
      const view: AuthFlowView = {
        flowId: optionalText(input.flowId) ?? '',
        state,
        ...(optionalText(input.error) ? { error: optionalText(input.error) as string } : {})
      }
      return ports.recordFlow(intentId, view)
    }
  )

  operations.register(
    ...deferredMutation(
      {
        name: AUTH_OPERATION_NAMES.intentComplete,
        visibility: 'member',
        mutation: true,
        summary: 'commit a completed flow into credential, connection and identity claims',
        inputSchema: objectInput(['intentId'], { intentId: { type: 'string' } })
      },
      (effect) => {
        const intentId = text(record(effect.payload).intentId, 'intentId')
        // Effect phase: ask the driver for the flow's public state. No transaction is open.
        const view = ports.flowViewForIntent(intentId)
        if (!view)
          throw mahasError('MODEL_INVALID', 'auth intent ' + intentId + ' does not exist', 'none')
        return {
          complete: (txn) => {
            const completion = ports.commitCompletionInTransaction(txn.db, intentId, view) as {
              completed: boolean
              credentialId?: string
              connectionId?: string
              replacedCredentialId?: string
            }
            txn.emitEvent({
              aggregateId: intentId,
              aggregateRevision: 1,
              eventType: completion.completed ? 'auth.intent.committed' : 'auth.intent.incomplete',
              payload: {
                intentId,
                credentialId: completion.credentialId ?? null,
                connectionId: completion.connectionId ?? null,
                replacedCredentialId: completion.replacedCredentialId ?? null
              }
            })
            return completion
          }
        }
      }
    )
  )

  operations.register(
    {
      name: AUTH_OPERATION_NAMES.intentList,
      visibility: 'member',
      mutation: false,
      summary: 'list auth intents with their public state'
    },
    (_txn, raw) => {
      const input = raw ? record(raw) : {}
      return ports.listIntents({
        ...(optionalText(input.state)
          ? { state: optionalText(input.state) as AuthIntent['state'] }
          : {}),
        ...(optionalText(input.offeringId)
          ? { offeringId: optionalText(input.offeringId) as string }
          : {}),
        ...(optionalInteger(input.limit, 'limit') !== undefined
          ? { limit: optionalInteger(input.limit, 'limit') as number }
          : {})
      })
    }
  )

  operations.register(
    {
      name: AUTH_OPERATION_NAMES.flowList,
      visibility: 'member',
      mutation: false,
      summary: 'list live provider flows (references only, never material)'
    },
    () => ports.listFlows()
  )

  operations.register(
    {
      name: AUTH_OPERATION_NAMES.flowStatus,
      visibility: 'member',
      mutation: false,
      summary: 'read one flow status'
    },
    (_txn, raw) => ports.flowStatus(text(record(raw).flowId, 'flowId'))
  )

  operations.register(
    {
      name: AUTH_OPERATION_NAMES.flowCancel,
      visibility: 'member',
      mutation: true,
      summary: 'cancel a flow and drop its pending secret deposits',
      inputSchema: objectInput(['flowId'], {
        flowId: { type: 'string' },
        reason: { type: 'string' }
      })
    },
    (txn, raw) => {
      const input = record(raw)
      const flowId = text(input.flowId, 'flowId')
      const view = ports.cancelFlow(flowId, optionalText(input.reason))
      txn.emitEvent({
        aggregateId: flowId,
        aggregateRevision: 1,
        eventType: 'auth.flow.cancelled',
        payload: { flowId }
      })
      return view
    }
  )

  operations.register(
    ...deferredMutation(
      {
        name: AUTH_OPERATION_NAMES.flowRefresh,
        visibility: 'member',
        mutation: true,
        summary: 'refresh a credential through its Pack; the revision advances only with evidence',
        inputSchema: objectInput(
          ['credentialRef', 'expectedMaterialRevision', 'offeringId', 'connectionId'],
          {
            credentialRef: { type: 'string' },
            expectedMaterialRevision: { type: 'integer' },
            offeringId: { type: 'string' },
            connectionId: { type: 'string' }
          }
        )
      },
      async (effect) => {
        const input = record(effect.payload)
        // Effect phase: the provider round trip. The Pack's coordinator DOES write — it
        // rotates the managed secret material — so a throw after that write is not provably a
        // no-op: the caller must reconcile rather than assume nothing happened. A MahasError
        // raised before any write (bad input, missing credential) is released for retry.
        const view = await ports.refresh({
          credentialRef: text(input.credentialRef, 'credentialRef'),
          expectedMaterialRevision: optionalInteger(
            input.expectedMaterialRevision,
            'expectedMaterialRevision'
          ) as number,
          offeringId: text(input.offeringId, 'offeringId'),
          connectionId: text(input.connectionId, 'connectionId')
        })
        return { complete: () => view }
      }
    )
  )

  operations.register(
    {
      name: AUTH_OPERATION_NAMES.connectionInventory,
      visibility: 'member',
      mutation: false,
      summary: 'credentials, connections and provenance for the settings UI (no material)'
    },
    () => ports.inventory()
  )

  operations.register(
    ...deferredMutation(
      {
        name: AUTH_OPERATION_NAMES.locatorImport,
        visibility: 'member',
        mutation: true,
        summary:
          'import existing credential files as read-only locator references ' +
          '(Pack catalog probe, or one explicit offeringId+path file)',
        inputSchema: objectInput([], {
          machineId: { type: 'string' },
          offeringId: { type: 'string' },
          path: { type: 'string' }
        })
      },
      async (effect) => {
        const input = record(effect.payload)
        const offeringId = optionalText(input.offeringId)
        const path = optionalText(input.path)
        // An explicit file import names ONE file for ONE offering; the Pack catalog
        // resolves the credential format from the offering, never from the bytes. A
        // path without its offering would force the runtime to guess a vendor format
        // — exactly the vendor knowledge this seam must not carry.
        if (
          (input.offeringId !== undefined || input.path !== undefined) &&
          (!offeringId || !path)
        ) {
          throw mahasError(
            'MODEL_INVALID',
            'an explicit file import needs offeringId and path together',
            'none'
          )
        }
        if (path !== undefined && (!path.startsWith('/') || path.includes('\0'))) {
          throw mahasError('MODEL_INVALID', 'path must be an absolute filesystem path', 'none')
        }
        // Effect phase: probe the filesystem. The registration writes happen in tx-2.
        const prepared = await ports.prepareLocatorImport({
          ...(optionalText(input.machineId)
            ? { machineId: optionalText(input.machineId) as string }
            : {}),
          ...(offeringId ? { offeringId } : {}),
          ...(path ? { path } : {})
        })
        return {
          complete: (txn) => {
            const result = ports.commitLocatorImportInTransaction(txn.db, prepared)
            txn.emitEvent({
              aggregateId: 'auth.locators',
              aggregateRevision: 1,
              eventType: 'auth.locators.imported',
              payload: result as Record<string, unknown>
            })
            return result
          }
        }
      }
    )
  )

  operations.register(
    ...deferredMutation(
      {
        name: AUTH_OPERATION_NAMES.locatorAdopt,
        visibility: 'member',
        mutation: true,
        summary: 'copy a locator credential into managed storage and start rotating it',
        inputSchema: objectInput(['machineId', 'offeringId', 'credentialId', 'format'], {
          machineId: { type: 'string' },
          offeringId: { type: 'string' },
          credentialId: { type: 'string' },
          format: { type: 'string' }
        })
      },
      async (effect) => {
        const input = record(effect.payload)
        // Effect phase: read the user's file and copy the material into the managed store.
        // The credential/connection swap is the completion.
        const prepared = await ports.prepareAdoption({
          machineId: text(input.machineId, 'machineId'),
          offeringId: text(input.offeringId, 'offeringId'),
          credentialId: text(input.credentialId, 'credentialId'),
          accountContinuity: 'confirmed-same',
          format: text(input.format, 'format')
        })
        return { complete: (txn) => ports.commitAdoptionInTransaction(txn.db, prepared) }
      }
    )
  )

  operations.register(
    {
      name: AUTH_OPERATION_NAMES.quotaCollect,
      visibility: 'member',
      // A command, not a query: it has receipt/idempotency semantics and must never be used as
      // a read side effect. The write is only the signal row — the probe is scheduled AFTER
      // this handler returns, so no network wait can happen inside the transaction (the loop
      // then takes its own serialization section).
      mutation: true,
      summary: 'signal the daemon quota loop to collect now (the loop performs the probes)'
    },
    (txn) => {
      const signal = ports.signalQuotaCollect()
      txn.emitEvent({
        aggregateId: 'auth.quota',
        aggregateRevision: 1,
        eventType: 'auth.quota.collect-requested',
        payload: { requestedAt: Date.now() }
      })
      return signal
    }
  )

  operations.register(
    {
      name: AUTH_OPERATION_NAMES.quotaCurrent,
      visibility: 'member',
      mutation: false,
      summary: 'latest quota reading, last success and current failure for a connection',
      inputSchema: objectInput(['connectionId'], { connectionId: { type: 'string' } })
    },
    (_txn, raw) => ports.quotaCurrent(text(record(raw).connectionId, 'connectionId'))
  )
}
