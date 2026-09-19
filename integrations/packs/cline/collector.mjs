#!/usr/bin/env node
// Cline local session collector (AdapterPack capability: identify, sessions, usage).
//
// Read-only. A Cline session lives in `<data>/sessions/<sessionId>/`: an
// optional `<sessionId>.json` manifest (cwd, prompt) plus one
// `<name>.messages.json` conversation per run (main run and team/sub-agent runs
// alike). Each file is one collection source; assistant messages carry
// per-request `metrics`, so readings are deltas keyed by the native message id.
// A page is bounded by maxRecords and the cursor holds the file signature plus
// the message index, so a rewritten file restarts the sweep at index 0.
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const HARNESS = 'cline'
const COLLECTOR_REVISION = '1'
const SOURCE_LIMIT = 4000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_RECORDS = 500
const MODEL_NAMESPACE = 'cline.message.metrics'
const MEASUREMENT_KEY = 'cline.assistant.message.metrics'

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
  'cline-installation:' + sha(resolve(configRoot) + String.fromCharCode(0) + resolve(dataRoot))

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
      else if (entry.isFile() && entry.name.endsWith('.messages.json')) found.push(path)
    }
  }
  await visit(root)
  return found
}

function sourceFor(path, namespace) {
  const real = realpathSync(path)
  const stat = statSync(real)
  return {
    sourceKey: 'cline:messages:' + sha(namespace + String.fromCharCode(0) + real),
    kind: 'file',
    locator: { path: real, format: 'json-snapshot', namespace },
    generation: generation(stat),
    identityEvidence: {
      device: String(stat.dev),
      inode: String(stat.ino),
      birthtimeMs: Math.trunc(stat.birthtimeMs),
      format: 'json-snapshot'
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

function empty(nextCursor, exhausted, coverage, diagnostics) {
  return {
    observations: [],
    sessions: [],
    handles: [],
    attachments: [],
    events: [],
    usageReadings: [],
    usageAttributionHints: [],
    quotaReadings: [],
    nextCursor,
    exhausted,
    coverage,
    diagnostics
  }
}

function usageValues(raw) {
  const input = number(raw.inputTokens ?? raw.input_tokens)
  const output = number(raw.outputTokens ?? raw.output_tokens)
  const explicitTotal = number(raw.totalTokens ?? raw.total_tokens)
  return {
    inputTotal: input,
    outputTotal: output,
    total: explicitTotal ?? (input !== null && output !== null ? input + output : null),
    cacheReadInput: number(raw.cacheReadTokens ?? raw.cache_read_input_tokens),
    cacheWriteInput: number(raw.cacheWriteTokens ?? raw.cache_creation_input_tokens),
    reasoningOutput: number(raw.reasoningTokens ?? raw.reasoning_output_tokens)
  }
}

function usageSemantics(values, raw) {
  const reported = number(raw.totalTokens ?? raw.total_tokens)
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
      inputTotal: 'inputTokens',
      outputTotal: 'outputTokens',
      cacheReadInput: 'cacheReadTokens',
      cacheWriteInput: 'cacheWriteTokens',
      reasoningOutput: 'reasoningTokens'
    }
  }
}

async function collect(request, payload) {
  const cursorIn = object(payload.cursor ?? request.cursor)
  const supplied = object(payload.source)
  const locator = object(supplied.locator)
  const path = String(locator.path || '')
  if (!path) {
    return empty(cursorIn, true, { completeness: 'gap', gapReason: 'source.invalid-locator' }, [
      diagnostic('source.invalid-locator', 'The collection source carries no file locator.')
    ])
  }
  if (!existsSync(path)) {
    return empty(cursorIn, true, { completeness: 'gap', gapReason: 'source.deleted' }, [
      diagnostic('source.deleted', 'The discovered source file no longer exists.', { path })
    ])
  }
  const namespace = String(locator.namespace || 'cline-data:' + sha(resolve(path)))
  const current = sourceFor(path, namespace)
  if (typeof supplied.generation === 'string' && supplied.generation !== current.generation) {
    return empty(cursorIn, true, { completeness: 'gap', gapReason: 'source.generation-changed' }, [
      diagnostic(
        'source.generation-changed',
        'Source identity changed; rediscovery is required before collecting again.',
        {
          expected: supplied.generation,
          actual: current.generation
        }
      )
    ])
  }
  const maxBytes = Math.max(1, Math.floor(Number(payload.maxBytes) || DEFAULT_MAX_BYTES))
  const maxRecords = Math.max(
    1,
    Math.min(Math.floor(Number(payload.maxRecords) || DEFAULT_MAX_RECORDS), 1000)
  )
  const stat = statSync(path)
  if (stat.size > maxBytes) {
    return empty(
      cursorIn,
      false,
      {
        completeness: 'gap',
        gapReason: 'snapshot.byte-limit',
        watermark: JSON.stringify({
          strategy: 'bounded-message-index',
          status: 'deferred',
          sourceSize: stat.size,
          maxBytes
        })
      },
      [
        diagnostic(
          'snapshot.byte-limit',
          'The conversation snapshot exceeds maxBytes and was not parsed partially; the cursor was not advanced.',
          {
            sourceSize: stat.size,
            maxBytes
          }
        )
      ]
    )
  }
  const bytes = await readFile(path)
  const signature = sha(bytes)
  const revision = 'sha256:' + signature
  let document
  try {
    document = JSON.parse(bytes.toString('utf8'))
  } catch {
    return empty(
      cursorIn,
      false,
      {
        completeness: 'gap',
        gapReason: 'snapshot.invalid-json',
        watermark: JSON.stringify({
          strategy: 'bounded-message-index',
          status: 'unreadable',
          sourceSize: stat.size
        })
      },
      [
        diagnostic(
          'snapshot.invalid-json',
          'The conversation snapshot could not be parsed; the cursor was not advanced.'
        )
      ]
    )
  }
  const root = Array.isArray(document) ? { messages: document } : object(document)
  const messages = Array.isArray(root.messages) ? root.messages : []
  const compatible =
    cursorIn.collectorRevision === COLLECTOR_REVISION &&
    cursorIn.sourceGeneration === current.generation &&
    cursorIn.signature === signature &&
    Number.isInteger(cursorIn.afterIndex) &&
    cursorIn.afterIndex >= 0
  const afterIndex = compatible ? Math.min(cursorIn.afterIndex, messages.length) : 0
  const page = messages.slice(afterIndex, afterIndex + maxRecords)
  const nextIndex = afterIndex + page.length
  const exhausted = nextIndex >= messages.length

  const native = string(root.sessionId) ?? basename(dirname(path))
  const parent = string(root.parentSessionId) ?? string(root.parent_session_id)
  const observedAt = timestamp(root.updatedAt ?? root.createdAt) ?? Math.trunc(stat.mtimeMs)
  const sessionRecordKey = supplied.sourceKey + ':session:' + encodeURIComponent(native)

  const usageReadings = []
  const usageAttributionHints = []
  page.forEach((value, offset) => {
    const message = object(value)
    const raw = object(message.metrics)
    if (!Object.keys(raw).length) return
    const index = afterIndex + offset
    const nativeRecordId = string(message.id) ?? string(message.messageId)
    const key = nativeRecordId
      ? 'cline:message:' + nativeRecordId
      : supplied.sourceKey + ':generation:' + current.generation + ':index:' + index
    const values = usageValues(raw)
    const at = timestamp(message.timestamp ?? message.createdAt ?? message.ts)
    usageReadings.push({
      sourceRecordKey: key,
      sourceRecordRevision: 'sha256:' + sha(JSON.stringify(raw)),
      sessionNativeKey: native,
      measurementKey: MEASUREMENT_KEY,
      mode: 'delta',
      values,
      semantics: usageSemantics(values, raw),
      timeCoverage:
        at === null
          ? { kind: 'unknown', reason: 'the native message carries no trustworthy timestamp' }
          : { kind: 'point', at, basis: 'native-record' },
      sourceEvidence: {
        sourceKey: supplied.sourceKey,
        snapshotRevision: revision,
        recordIndex: index,
        sessionNamespace: namespace,
        containmentBasis:
          'legacy-ledger-subset-semantics: cache read and cache write are contained in inputTokens'
      }
    })
    const model = string(message.model) ?? string(raw.model)
    if (model) {
      usageAttributionHints.push({
        sourceRecordKey: key,
        servedModel: { nativeName: model, namespace: MODEL_NAMESPACE },
        basis: 'reported',
        confidence: 'observed',
        evidence: [
          { sourceRecordKey: key, description: 'Model recorded on the native assistant message' }
        ]
      })
    }
  })

  let cwd = null
  let title = null
  try {
    const manifest = object(
      JSON.parse(await readFile(join(dirname(path), native + '.json'), 'utf8'))
    )
    cwd = string(manifest.cwd) ?? string(manifest.workspace_root)
    const prompt = string(manifest.prompt)
    if (prompt) {
      const unwrapped = prompt
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
      title = unwrapped || null
    }
  } catch {
    // The manifest is optional; metrics still count without it.
  }

  const emitSession = usageReadings.length > 0 || request.capability === 'sessions'
  const sessions = emitSession
    ? [
        {
          sourceRecordKey: sessionRecordKey,
          harnessId: HARNESS,
          namespace,
          nativeSessionKey: native,
          ...(parent ? { parentNativeSessionKey: parent } : {}),
          ...(title ? { title } : {}),
          firstObservedAt: observedAt,
          lastObservedAt: observedAt,
          metadata: {
            sourceKey: supplied.sourceKey,
            ...(cwd ? { workingDirectory: cwd } : {})
          }
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
          locator: { path: dirname(path) },
          resumeSupport: 'unknown',
          observedAt,
          evidence: [
            {
              sourceRecordKey: sessionRecordKey,
              description:
                'Session directory identity; no verified native resume invocation was established.'
            }
          ]
        }
      ]
    : []

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
      signature,
      afterIndex: nextIndex
    },
    exhausted,
    coverage: {
      completeness: exhausted ? 'complete' : 'partial',
      watermark: JSON.stringify({
        strategy: 'bounded-message-index',
        status: exhausted ? 'swept' : 'paging',
        messageCount: messages.length,
        fromIndex: afterIndex,
        throughIndex: nextIndex,
        signature: revision
      })
    },
    diagnostics: exhausted
      ? []
      : [
          diagnostic(
            'pagination.pending',
            'More native messages remain in this source; the cursor continues at the next index.'
          )
        ]
  }
}

function rootsFor(candidate) {
  const root = resolve(String(candidate))
  if (existsSync(join(root, 'sessions'))) return { config: root, data: join(root, 'sessions') }
  if (existsSync(join(root, 'data', 'sessions')))
    return { config: root, data: join(root, 'data', 'sessions') }
  return { config: root, data: root }
}

function identify(payload) {
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
          description: 'Cline sessions namespace exists',
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
      const payload = await collect(request, object(request.payload))
      const status = payload.coverage.completeness === 'complete' ? 'success' : 'partial'
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
