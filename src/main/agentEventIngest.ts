// Durable ingest port for hook events — the desktop half of the contract the
// control plane owns.
//
// DAEMON API (implemented by the control plane in
// packages/mahas-runtime/src/sessions/hook-ingest.ts; types live in
// mahas-contracts → operations/hooks.ts):
//
//   operation   session.hook.ingest                      visibility: service
//   payload     AgentHookIngestRequest
//                 { source: AgentHookIngestSource,
//                   records: AgentHookIngestRecord[] }
//   receipt     CommandReceipt
//                 { status: 'committed',
//                   result: { committed: true, recordKeys: string[] } }
//               | { status: 'rejected'|'unknown'|'pending',
//                   error: { code, message, retry } }
//
//   semantics   · Resolve only after the events, their session rows (including
//                 child/parent links) and the source cursor are committed in one
//                 transaction — the caller forwards to attention straight after.
//               · A retry with the same sourceRecordKey is idempotent; the
//                 desktop retries the *same* batch until it commits.
//               · Identity fields (child, parentSessionId, internalRun, external,
//                 paneId, tabId) and the recorded policy are stored as evidence,
//                 never stripped to express an exclusion.
//               · transport failure answers retryable: true; a schema/contract
//                 rejection answers retryable: false and the desktop drops the
//                 record's attention delivery (it stays in the NDJSON file).
//
// Nothing here fabricates a receipt: an unknown verdict is retryable, and the
// desktop never treats "no answer" as committed.

import type {
  AgentHookIngestRecord,
  AgentHookIngestRequest
} from '../../packages/mahas-contracts/src/index.ts'
import type { AgentEventIngestAck, AgentEventIngestPort, AgentEventRecord } from './eventsFile'

/** Structural view of the runtime client the desktop already holds. */
export interface RuntimeIngestClient {
  call(operation: string, payload: unknown, options?: { operationId?: string }): Promise<unknown>
}

export interface RuntimeIngestOptions {
  operation?: string
  /** hook stream identity; defaults to the desktop's event log */
  sourceKey?: string
  locatorPath?: string
  generation?: string
  /** injected for tests */
  now?: () => number
  operationId?: () => string
}

export const INGEST_OPERATION = 'session.hook.ingest'

export function createRuntimeIngestPort(
  client: RuntimeIngestClient | null | undefined,
  options: RuntimeIngestOptions = {}
): AgentEventIngestPort {
  const operation = options.operation ?? INGEST_OPERATION
  const operationId =
    options.operationId ?? (() => 'hook-ingest-' + Math.random().toString(36).slice(2))
  return {
    name: 'mahasd:' + operation,
    async ingest(records: readonly AgentEventRecord[]): Promise<AgentEventIngestAck> {
      if (!client)
        return { committed: false, retryable: true, reason: 'runtime client is not attached' }
      const first = records[0]
      const payload = {
        source: {
          sourceKey: options.sourceKey ?? 'hook:' + (first?.file ?? 'agent-events.log'),
          kind: 'hook-stream' as const,
          locator: { path: options.locatorPath ?? first?.file ?? 'agent-events.log' },
          generation: options.generation ?? 'ndjson-v2'
        },
        records: records.map((record) => ({
          sourceRecordKey: record.sourceRecordKey,
          offset: record.offset,
          generation: record.generation,
          raw: record.raw,
          event: record.event
        }))
      }
      let answer: unknown
      try {
        answer = await callChunked(client, operation, payload, operationId)
      } catch (error) {
        return {
          committed: false,
          retryable: true,
          reason: 'ingest call failed: ' + String(error instanceof Error ? error.message : error)
        }
      }
      return interpretIngestReceipt(answer, records)
    }
  }
}

/**
 * The desktop's live ingest port: resolves the runtime handle on EVERY call
 * rather than capturing a client at startup.
 *
 * Two reasons the indirection is load-bearing:
 *
 *   · startup order. `startEventIngest` runs beside `initDesktopRuntime`, and
 *     the daemon takes seconds to become reachable (it may even be spawned
 *     lazily). A port that captured `runtimeHandle()` once would either be null
 *     forever or hold a handle that was later dropped by a reconnect.
 *   · reconnect. `disconnectDesktopRuntime()` sets the handle to null on
 *     quit and a failed connect drops the cached client, so a stale reference
 *     would keep calling a dead socket.
 *
 * With no handle the call throws — the gate classifies a throw as retryable,
 * so records queue in memory (bounded, and still durable in the NDJSON file)
 * until the control plane answers. An unavailable runtime never looks like a
 * committed batch.
 */
export function createLiveRuntimeIngestPort(
  resolveHandle: () => { client: RuntimeIngestClient } | null,
  options: RuntimeIngestOptions = {}
): AgentEventIngestPort {
  return createRuntimeIngestPort(
    {
      call: (operation, payload, callOptions) => {
        const handle = resolveHandle()
        if (!handle) throw new Error('runtime not bootstrapped')
        return handle.client.call(operation, payload, callOptions)
      }
    },
    options
  )
}

/** The daemon rejects a batch over 512 records or 2 MiB of raw lines. */
const MAX_BATCH_RECORDS = 512
const MAX_BATCH_BYTES = 2 * 1024 * 1024

/**
 * Send the batch in daemon-sized chunks and merge the verdicts. Chunking is a
 * transport concern only: the gate still owns retry policy, and a chunk that did
 * not commit makes the merged verdict non-committed so the records stay queued.
 */
async function callChunked(
  client: RuntimeIngestClient,
  operation: string,
  payload: AgentHookIngestRequest,
  nextOperationId: () => string
): Promise<unknown> {
  const chunks: AgentHookIngestRequest[] = []
  let current: AgentHookIngestRecord[] = []
  let bytes = 0
  for (const record of payload.records) {
    const size = Buffer.byteLength(record.raw)
    if (current.length && (current.length >= MAX_BATCH_RECORDS || bytes + size > MAX_BATCH_BYTES)) {
      chunks.push({ source: payload.source, records: current })
      current = []
      bytes = 0
    }
    current.push(record)
    bytes += size
  }
  if (current.length) chunks.push({ source: payload.source, records: current })
  const recordKeys: string[] = []
  for (const chunkPayload of chunks) {
    const receipt = await client.call(operation, chunkPayload, { operationId: nextOperationId() })
    const ack = interpretIngestReceipt(receipt, chunkPayload.records)
    if (!ack.committed) return ack
    recordKeys.push(...chunkPayload.records.map((record) => record.sourceRecordKey))
  }
  return { committed: true, recordKeys }
}

function confirmedRecords(
  value: Record<string, unknown>,
  records: readonly { sourceRecordKey: string }[]
): AgentEventIngestAck {
  const keys = new Set(Array.isArray(value.recordKeys) ? value.recordKeys : [])
  if (value.committed !== true || records.some((record) => !keys.has(record.sourceRecordKey))) {
    return { committed: false, retryable: true, reason: 'ingest did not confirm every record' }
  }
  return { committed: true, recordKeys: records.map((record) => record.sourceRecordKey) }
}

/**
 * Map a control-plane verdict onto the port's ack. Rejected/unknown receipts are
 * never read as committed; only an explicit commit (or an explicit committed
 * value list) releases the records to attention.
 */
export function interpretIngestReceipt(
  answer: unknown,
  records: readonly { sourceRecordKey: string }[]
): AgentEventIngestAck {
  const outer = (answer && typeof answer === 'object' ? answer : {}) as Record<string, unknown>
  // 1) CommandReceipt — what the daemon's operation registry returns. The
  //    verdict lives in `result`; `status` alone never means committed.
  if (typeof outer.status === 'string') {
    const status = outer.status
    const receiptResult = (
      outer.result && typeof outer.result === 'object' ? outer.result : null
    ) as Record<string, unknown> | null
    if (status === 'committed') {
      const value = receiptResult ?? {}
      if (value.committed === false) {
        return {
          committed: false,
          retryable: value.retryable !== false,
          reason: typeof value.reason === 'string' ? value.reason : 'ingest did not commit'
        }
      }
      return confirmedRecords(value, records)
    }
    const error = (outer.error && typeof outer.error === 'object' ? outer.error : {}) as Record<
      string,
      unknown
    >
    const code = typeof error.code === 'string' ? error.code : 'RECEIPT_' + status.toUpperCase()
    const retry = typeof error.retry === 'string' ? error.retry : 'none'
    const indeterminate = status === 'pending' || status === 'unknown'
    // the daemon answered but does not accept hook events (operation or contract
    // absent): degrade locally instead of retrying forever
    const unavailable = UNAVAILABLE_CODES.has(code)
    return {
      committed: false,
      ...(unavailable ? { unavailable: true as const } : {}),
      retryable:
        !unavailable && (indeterminate || retry === 'same-operation' || retry === 'reconcile'),
      reason: code + ': ' + String(error.message ?? 'ingest was ' + status)
    }
  }
  // 2) ControlResult envelope from the desktop's own client wrapper
  if (outer.ok === false) {
    const error = (outer.error && typeof outer.error === 'object' ? outer.error : {}) as Record<
      string,
      unknown
    >
    const code = typeof error.code === 'string' ? error.code : 'CONTROL_ERROR'
    return {
      committed: false,
      ...(UNAVAILABLE_CODES.has(code) ? { unavailable: true as const } : {}),
      retryable:
        !UNAVAILABLE_CODES.has(code) &&
        (error.retryable === true || code === 'CONTROL_UNAVAILABLE'),
      reason: code + ': ' + String(error.message ?? 'ingest rejected')
    }
  }
  // 3) a bare verdict (test doubles, future transports)
  const value = (outer.value ?? outer) as Record<string, unknown>
  if (value.committed === true) {
    return confirmedRecords(value, records)
  }
  if (value.committed === false) {
    return {
      committed: false,
      ...(value.unavailable === true ? { unavailable: true as const } : {}),
      retryable: value.retryable !== false,
      reason: typeof value.reason === 'string' ? value.reason : 'ingest did not commit'
    }
  }
  // no verdict at all (streaming/unknown receipt) — never assume commit
  return { committed: false, retryable: true, reason: 'ingest returned no verdict' }
}

/** Error codes that mean "this daemon cannot take hook events yet". */
const UNAVAILABLE_CODES = new Set([
  'UNAVAILABLE_OPERATION',
  'UNSUPPORTED_OPERATION',
  'OPERATION_NOT_FOUND',
  'ENTITY_NOT_FOUND',
  'MODEL_INVALID'
])
