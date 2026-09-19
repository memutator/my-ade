// sessions/operations.ts — durable session reads for the desktop, CLI and
// resume consumers. Sessions are stored facts: these operations never create a
// Task or an Execution, and child/foreign sessions are returned as their own
// rows (with origin machine and parent link) instead of being merged away.

import type { OperationHandler, OperationSpec } from '../api/registry.ts'
import { mahasError } from '../api/handler-ports.ts'
import {
  getSessionDetail,
  queryHarnessSessions,
  querySessionEvents,
  querySessionHandles
} from './query.ts'

export const SESSION_OPERATION_NAMES = {
  list: 'session.list',
  get: 'session.get',
  eventList: 'session.event.list',
  handleList: 'session.handle.list'
} as const

export interface SessionOperationRegistry {
  register(spec: OperationSpec, handler: OperationHandler): void
}

/** Every session query accepts an omitted or empty payload. */
function optionalObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw mahasError('MODEL_INVALID', 'payload must be an object', 'none')
  }
  return value as Record<string, unknown>
}

function optionalString(source: Record<string, unknown>, field: string): string | undefined {
  const value = source[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw mahasError('MODEL_INVALID', field + ' must be a non-empty string', 'none')
  }
  return value
}

function requiredString(source: Record<string, unknown>, field: string): string {
  const value = optionalString(source, field)
  if (!value) throw mahasError('MODEL_INVALID', field + ' is required', 'none')
  return value
}

function optionalBoolean(source: Record<string, unknown>, field: string): boolean {
  const value = source[field]
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') {
    throw mahasError('MODEL_INVALID', field + ' must be a boolean', 'none')
  }
  return value
}

function optionalLimit(source: Record<string, unknown>, fallback: number): number {
  const value = source['limit']
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw mahasError('MODEL_INVALID', 'limit must be a positive integer', 'none')
  }
  return Number(value)
}

const objectInput = (properties: Record<string, unknown>): unknown => ({
  type: 'object', properties, additionalProperties: false
})

export function registerSessionOperations(registry: SessionOperationRegistry): void {
  registry.register(
    {
      name: SESSION_OPERATION_NAMES.list,
      visibility: 'member',
      mutation: false,
      summary: 'page persisted harness sessions, including child and foreign ones',
      inputSchema: objectInput({
        harnessId: { type: 'string' },
        originMachineId: { type: 'string' },
        parentSessionId: { type: 'string' },
        installationId: { type: 'string' },
        rootsOnly: { type: 'boolean' },
        afterId: { type: 'string' },
        limit: { type: 'integer' }
      })
    },
    (txn, payload) => {
      const source = optionalObject(payload)
      const parentSessionId = optionalString(source, 'parentSessionId')
      return queryHarnessSessions(txn.db, {
        ...(optionalString(source, 'harnessId')
          ? { harnessId: source['harnessId'] as string } : {}),
        ...(optionalString(source, 'originMachineId')
          ? { originMachineId: source['originMachineId'] as string } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(optionalString(source, 'installationId')
          ? { installationId: source['installationId'] as string } : {}),
        ...(optionalBoolean(source, 'rootsOnly') ? { rootsOnly: true } : {}),
        ...(optionalString(source, 'afterId') ? { afterId: source['afterId'] as string } : {}),
        limit: optionalLimit(source, 100)
      })
    }
  )
  registry.register(
    {
      name: SESSION_OPERATION_NAMES.get,
      visibility: 'member',
      mutation: false,
      summary: 'read one session with its handles, attachments and child sessions',
      inputSchema: objectInput({ sessionId: { type: 'string' }, id: { type: 'string' } })
    },
    (txn, payload) => {
      const source = optionalObject(payload)
      const sessionId = optionalString(source, 'sessionId') ?? requiredString(source, 'id')
      return getSessionDetail(txn.db, sessionId)
    }
  )
  registry.register(
    {
      name: SESSION_OPERATION_NAMES.eventList,
      visibility: 'member',
      mutation: false,
      summary: 'read persisted session events for one session',
      inputSchema: objectInput({ sessionId: { type: 'string' }, limit: { type: 'integer' } })
    },
    (txn, payload) => {
      const source = optionalObject(payload)
      return querySessionEvents(txn.db, requiredString(source, 'sessionId'),
        { limit: optionalLimit(source, 200) })
    }
  )
  registry.register(
    {
      name: SESSION_OPERATION_NAMES.handleList,
      visibility: 'member',
      mutation: false,
      summary: 'read stored session handles (resume locators) for one session',
      inputSchema: objectInput({ sessionId: { type: 'string' } })
    },
    (txn, payload) => querySessionHandles(txn.db, requiredString(optionalObject(payload), 'sessionId'))
  )
}
