#!/usr/bin/env node
// Claude Code local session collector (AdapterPack capability: identify, sessions, usage).
//
// Read-only. `~/.claude/projects/**/<sessionId>.jsonl` is append-only, so the
// checkpoint is a confirmed-newline byte offset and the cursor only advances
// past records whose terminating newline was observed. Each assistant message
// carries its own usage object, so the reading mode is `delta` and the stable
// record key is the native message uuid.
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const HARNESS = 'claude'
const COLLECTOR_REVISION = '1'
const SOURCE_LIMIT = 4000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_RECORDS = 500
const MODEL_NAMESPACE = 'claude.message.usage'
const MEASUREMENT_KEY = 'claude.assistant.message.usage'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const string = (value) => (typeof value === 'string' && value ? value : null)
const number = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const diagnostic = (code, message, details) => ({
  code,
  severity: 'warning',
  message,
  ...(details ? { details } : {})
})
const timestamp = (value) => {
  if (typeof value === 'number' && Number.isFinite(value))
    return value < 10_000_000_000 ? value * 1000 : value
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : null
}
const generation = (stat) =>
  ['dev', stat.dev, 'ino', stat.ino, 'birth', Math.trunc(stat.birthtimeMs || stat.ctimeMs)].join(
    ':'
  )
const namespaceFor = (configRoot, dataRoot) =>
  'claude-installation:' + sha(resolve(configRoot) + String.fromCharCode(0) + resolve(dataRoot))

async function walk(root) {
  const found = []
  async function visit(directory) {
    if (found.length >= SOURCE_LIMIT) return
    let entries = []
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (found.length >= SOURCE_LIMIT) break
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path)
    }
  }
  await visit(root)
  return found
}

function sourceFor(path, namespace) {
  const real = realpathSync(path)
  const stat = statSync(real)
  return {
    sourceKey: 'claude:jsonl:' + sha(namespace + String.fromCharCode(0) + real),
    kind: 'file',
    locator: { path: real, format: 'jsonl', namespace },
    generation: generation(stat),
    identityEvidence: {
      device: String(stat.dev),
      inode: String(stat.ino),
      birthtimeMs: Math.trunc(stat.birthtimeMs),
      format: 'jsonl'
    }
  }
}

async function discover(payload) {
  const dataRoot = resolve(String(payload.dataNamespace || ''))
  const configRoot = resolve(String(payload.configNamespace || dataRoot))
  const namespace = namespaceFor(configRoot, dataRoot)
  const sources = existsSync(dataRoot)
    ? (await walk(dataRoot)).map((path) => sourceFor(path, namespace))
    : []
  return { sources }
}

function gap(cursor, code, message, gapReason, details) {
  return {
    observations: [],
    sessions: [],
    handles: [],
    attachments: [],
    events: [],
    usageReadings: [],
    usageAttributionHints: [],
    quotaReadings: [],
    nextCursor: cursor,
    exhausted: true,
    coverage: { completeness: 'gap', gapReason },
    diagnostics: [diagnostic(code, message, details)]
  }
}

function readChunk(path, source, rawCursor, maxBytes, maxRecords) {
  const stat = statSync(path)
  const cursor = object(rawCursor)
  const compatible =
    cursor.collectorRevision === COLLECTOR_REVISION && cursor.sourceGeneration === source.generation
  let offset =
    compatible && Number.isInteger(cursor.offset) && cursor.offset >= 0 ? cursor.offset : 0
  const diagnostics = []
  if (offset > stat.size) {
    diagnostics.push(
      diagnostic(
        'source.truncated',
        'The JSONL file shrank; collection restarted from the beginning of the file.',
        {
          previousOffset: offset,
          sourceSize: stat.size
        }
      )
    )
    offset = 0
  }
  const length = Math.max(0, Math.min(maxBytes, stat.size - offset))
  const bytes = Buffer.alloc(length)
  if (length) {
    const fd = openSync(path, 'r')
    try {
      readSync(fd, bytes, 0, length, offset)
    } finally {
      closeSync(fd)
    }
  }
  const lines = []
  let position = 0
  while (lines.length < maxRecords) {
    const newline = bytes.indexOf(10, position)
    if (newline < 0) break
    lines.push({
      start: offset + position,
      end: offset + newline + 1,
      bytes: bytes.subarray(position, newline)
    })
    position = newline + 1
  }
  const nextOffset = lines.length ? lines.at(-1).end : offset
  if (!lines.length && stat.size > offset && length === maxBytes && bytes.indexOf(10) < 0) {
    diagnostics.push(
      diagnostic(
        'record.byte-limit',
        'The next complete JSONL record exceeds maxBytes; the cursor was not advanced.',
        {
          offset,
          maxBytes
        }
      )
    )
  }
  return { stat, lines, diagnostics, offset, nextOffset }
}

function usageValues(raw) {
  const input = number(raw.input_tokens ?? raw.inputTokens)
  const output = number(raw.output_tokens ?? raw.outputTokens)
  const explicitTotal = number(raw.total_tokens ?? raw.totalTokens)
  return {
    inputTotal: input,
    outputTotal: output,
    // Claude's input/output components are disjoint from each other; cache
    // details are contained in input, so they are never added a second time.
    total: explicitTotal ?? (input !== null && output !== null ? input + output : null),
    cacheReadInput: number(raw.cache_read_input_tokens ?? raw.cacheReadTokens),
    cacheWriteInput: number(raw.cache_creation_input_tokens ?? raw.cacheWriteTokens),
    reasoningOutput: number(raw.reasoning_output_tokens ?? raw.reasoningTokens)
  }
}

function usageSemantics(values, raw) {
  const reported = number(raw.total_tokens ?? raw.totalTokens)
  return {
    unit: 'tokens',
    componentRelations: [
      { component: 'inputTotal', relation: 'includes', other: 'cacheReadInput' },
      { component: 'inputTotal', relation: 'includes', other: 'cacheWriteInput' },
      { component: 'outputTotal', relation: 'unknown', other: 'reasoningOutput' }
    ],
    reportedTotal: reported,
    calculatedTotal: values.total,
    totalMismatch: reported !== null && values.total !== null && reported !== values.total,
    completeness:
      values.inputTotal !== null && values.outputTotal !== null ? 'complete' : 'partial',
    nativeFields: {
      inputTotal: 'input_tokens',
      outputTotal: 'output_tokens',
      cacheReadInput: 'cache_read_input_tokens',
      cacheWriteInput: 'cache_creation_input_tokens',
      reasoningOutput: 'reasoning_output_tokens'
    }
  }
}

function collect(request, payload) {
  const cursorIn = object(payload.cursor ?? request.cursor)
  const supplied = object(payload.source)
  const locator = object(supplied.locator)
  const path = String(locator.path || '')
  if (!path) {
    return gap(
      cursorIn,
      'source.invalid-locator',
      'The collection source carries no file locator.',
      'source.invalid-locator'
    )
  }
  if (!existsSync(path)) {
    return gap(
      cursorIn,
      'source.deleted',
      'The discovered source file no longer exists.',
      'source.deleted',
      { path }
    )
  }
  const namespace = String(locator.namespace || 'claude-data:' + sha(resolve(path)))
  const current = sourceFor(path, namespace)
  if (typeof supplied.generation === 'string' && supplied.generation !== current.generation) {
    return gap(
      cursorIn,
      'source.generation-changed',
      'Source identity changed; rediscovery is required before collecting again.',
      'source.generation-changed',
      { expected: supplied.generation, actual: current.generation }
    )
  }
  const maxBytes = Math.max(1, Math.floor(Number(payload.maxBytes) || DEFAULT_MAX_BYTES))
  const maxRecords = Math.max(
    1,
    Math.min(Math.floor(Number(payload.maxRecords) || DEFAULT_MAX_RECORDS), 1000)
  )
  const chunk = readChunk(path, current, cursorIn, maxBytes, maxRecords)
  const records = []
  let malformed = false
  for (const line of chunk.lines) {
    if (!line.bytes.length) continue
    try {
      records.push({ ...line, value: JSON.parse(line.bytes.toString('utf8')) })
    } catch {
      malformed = true
      chunk.diagnostics.push(
        diagnostic(
          'record.invalid-json',
          'A complete JSONL record could not be parsed and was skipped.',
          {
            byteOffset: line.start
          }
        )
      )
    }
  }
  const capability = request.capability
  const nativeFromRecord = records
    .map(({ value }) => string(object(value).sessionId))
    .find((value) => value)
  let native = string(cursorIn.sessionNativeKey) ?? nativeFromRecord ?? basename(path, '.jsonl')
  const parentFromRecord = records
    .map(
      ({ value }) =>
        string(object(value).parentSessionId) ?? string(object(value).parent_session_id)
    )
    .find((value) => value)
  const observedAt =
    records
      .map(({ value }) => timestamp(object(value).timestamp))
      .find((value) => value !== null) ?? Math.trunc(chunk.stat.mtimeMs)
  const sessionRecordKey = supplied.sourceKey + ':session:' + encodeURIComponent(native)

  const usageReadings = []
  const usageAttributionHints = []
  if (capability === 'usage') {
    for (const record of records) {
      const item = object(record.value)
      if (item.type !== 'assistant') continue
      const message = object(item.message)
      const raw = object(message.usage)
      if (!Object.keys(raw).length) continue
      const key =
        string(item.uuid) ??
        string(message.id) ??
        supplied.sourceKey + ':generation:' + current.generation + ':byte:' + record.start
      const values = usageValues(raw)
      const at = timestamp(item.timestamp)
      usageReadings.push({
        sourceRecordKey: key,
        sourceRecordRevision: 'sha256:' + sha(record.bytes),
        sessionNativeKey: string(item.sessionId) ?? native,
        measurementKey: MEASUREMENT_KEY,
        mode: 'delta',
        values,
        semantics: usageSemantics(values, raw),
        timeCoverage:
          at === null
            ? { kind: 'unknown', reason: 'assistant record has no trustworthy timestamp' }
            : {
                kind: 'point',
                at,
                basis: 'native-record',
                nativeTimestamp: String(item.timestamp)
              },
        sourceEvidence: {
          sourceKey: supplied.sourceKey,
          byteStart: record.start,
          byteEnd: record.end,
          containmentBasis:
            'legacy-ledger-subset-semantics: cache read and cache creation are contained in input_tokens'
        }
      })
      const model = string(message.model)
      if (model) {
        usageAttributionHints.push({
          sourceRecordKey: key,
          servedModel: { nativeName: model, namespace: MODEL_NAMESPACE },
          basis: 'reported',
          confidence: 'observed',
          evidence: [
            { sourceRecordKey: key, description: 'Model name stored on the assistant message' }
          ]
        })
      }
    }
  }

  const emitSession = capability === 'sessions' || usageReadings.length > 0
  const sessions = emitSession
    ? [
        {
          sourceRecordKey: sessionRecordKey,
          harnessId: HARNESS,
          namespace,
          nativeSessionKey: native,
          ...(parentFromRecord ? { parentNativeSessionKey: parentFromRecord } : {}),
          firstObservedAt: observedAt,
          lastObservedAt: observedAt,
          metadata: { sourceKey: supplied.sourceKey }
        }
      ]
    : []
  const handles = emitSession
    ? [
        {
          sourceRecordKey: sessionRecordKey,
          sessionNativeKey: native,
          installationId: request.target?.installationId,
          nativeId: native,
          locator: { path },
          resumeSupport: 'supported',
          observedAt,
          evidence: [
            {
              sourceRecordKey: sessionRecordKey,
              description:
                'Project JSONL carries the native session id; the CLI resumes it by that id.'
            }
          ]
        }
      ]
    : []

  const exhausted = chunk.nextOffset === chunk.stat.size
  const completeness = malformed ? 'gap' : exhausted ? 'complete' : 'partial'
  const watermark = JSON.stringify({
    strategy: 'append-only-byte-cursor',
    from: chunk.offset,
    through: chunk.nextOffset,
    sourceSize: chunk.stat.size,
    incompleteTailBytes: chunk.stat.size - chunk.nextOffset
  })
  return {
    observations: [],
    sessions,
    handles,
    attachments: [],
    events: [],
    usageReadings,
    usageAttributionHints,
    quotaReadings: [],
    nextCursor: {
      collectorRevision: COLLECTOR_REVISION,
      sourceGeneration: current.generation,
      sessionNativeKey: native,
      offset: chunk.nextOffset
    },
    exhausted,
    coverage: {
      completeness,
      ...(malformed ? { gapReason: 'record.invalid-json' } : {}),
      watermark
    },
    diagnostics: chunk.diagnostics
  }
}

function rootsFor(candidate) {
  const root = resolve(String(candidate))
  if (existsSync(join(root, 'projects'))) return { config: root, data: join(root, 'projects') }
  return { config: root, data: root }
}

function identify(payload) {
  // The scheduler hands every absolute candidate root to identify, so the
  // config root and the data root of one installation can both arrive here.
  // Keep one installation per data namespace, preferring the candidate that
  // also names the enclosing config root.
  const byData = new Map()
  for (const candidate of Array.isArray(payload.candidateLocators)
    ? payload.candidateLocators
    : []) {
    if (typeof candidate !== 'string') continue
    const roots = rootsFor(candidate)
    if (!existsSync(roots.data)) continue
    const previous = byData.get(roots.data)
    if (previous && previous.config !== previous.data) continue
    byData.set(roots.data, roots)
  }
  const installations = []
  for (const roots of byData.values()) {
    installations.push({
      harnessId: HARNESS,
      configNamespace: roots.config,
      dataNamespace: roots.data,
      presence: 'present',
      evidence: [
        {
          description: 'Claude projects namespace exists',
          data: { namespace: namespaceFor(roots.config, roots.data) }
        }
      ]
    })
  }
  return { installations }
}

/** The runner requires action results to echo the pinned identity as well. */
function envelope(request, status, payload, diagnostics, startedAt) {
  return {
    protocolVersion: string(request.protocolVersion) ?? '1',
    operationId: request.operationId,
    ...(request.action ? { action: request.action } : {}),
    ...(request.capability ? { capability: request.capability } : {}),
    target: request.target,
    contract: request.contract,
    pack: request.pack,
    status,
    ...(payload ? { payload } : {}),
    diagnostics,
    startedAt,
    completedAt: Date.now()
  }
}

async function main(request) {
  const startedAt = Date.now()
  if (request.action === 'discover-sources') {
    return envelope(request, 'success', await discover(object(request.payload)), [], startedAt)
  }
  if (request.action === 'collect' || !request.action) {
    if (request.capability === 'sessions' || request.capability === 'usage') {
      const payload = collect(request, object(request.payload))
      const status =
        payload.exhausted && payload.coverage.completeness !== 'gap' ? 'success' : 'partial'
      return envelope(request, status, payload, [], startedAt)
    }
    if (request.capability === 'identify' && !request.action) {
      return envelope(request, 'success', identify(object(request.payload)), [], startedAt)
    }
  }
  return envelope(
    request,
    'failed',
    null,
    [diagnostic('capability.unsupported', 'Unsupported capability.')],
    startedAt
  )
}

let input = ''
for await (const chunk of process.stdin) input += chunk
try {
  process.stdout.write(JSON.stringify(await main(JSON.parse(input))) + '\n')
} catch (error) {
  let request = {}
  try {
    request = JSON.parse(input)
  } catch {
    request = {}
  }
  process.stdout.write(
    JSON.stringify(
      envelope(
        request,
        'failed',
        null,
        [diagnostic('collector.failed', error instanceof Error ? error.message : String(error))],
        Date.now()
      )
    ) + '\n'
  )
}
