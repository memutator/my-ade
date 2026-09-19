#!/usr/bin/env node
// Grok local session collector (AdapterPack capability: identify, sessions, usage).
//
// Read-only. Grok writes one `usage.json` snapshot per session under
// `~/.grok/sessions/**`, so the source is a mutable snapshot rather than an
// append-only log: the cursor is the content signature, and an unchanged
// signature ends the sweep without re-emitting rows. A rewritten snapshot
// re-emits the same stable record key with a new revision, which the ledger
// treats as a correction of the same counter scope/epoch.
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const HARNESS = 'grok'
const COLLECTOR_REVISION = '1'
const SOURCE_LIMIT = 4000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const MODEL_NAMESPACE = 'grok.session.usage'
const MEASUREMENT_KEY = 'grok.session.tokens'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const string = (value) => (typeof value === 'string' && value ? value : null)
const number = (value) => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (
    typeof value === 'string' &&
    value.trim() &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0
  )
    return Number(value)
  return null
}
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
  'grok-installation:' + sha(resolve(configRoot) + String.fromCharCode(0) + resolve(dataRoot))

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
      else if (entry.isFile() && entry.name === 'usage.json') found.push(path)
    }
  }
  await visit(root)
  return found
}

function sourceFor(path, namespace) {
  const real = realpathSync(path)
  const stat = statSync(real)
  return {
    sourceKey: 'grok:usage:' + sha(namespace + String.fromCharCode(0) + real),
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
    cacheReadInput: number(
      raw.cachedReadTokens ?? raw.cache_read_input_tokens ?? raw.cache_read_tokens
    ),
    cacheWriteInput: null,
    reasoningOutput: number(raw.reasoningTokens ?? raw.reasoning_output_tokens)
  }
}

function usageSemantics(values, raw) {
  const reported = number(raw.totalTokens ?? raw.total_tokens)
  return {
    unit: 'tokens',
    componentRelations: [
      { component: 'inputTotal', relation: 'includes', other: 'cacheReadInput' },
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
      total: 'totalTokens',
      cacheReadInput: 'cachedReadTokens',
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
  const namespace = String(locator.namespace || 'grok-data:' + sha(resolve(path)))
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
  const stat = statSync(path)
  if (stat.size > maxBytes) {
    return empty(
      cursorIn,
      false,
      {
        completeness: 'gap',
        gapReason: 'snapshot.byte-limit',
        watermark: JSON.stringify({
          strategy: 'snapshot-signature',
          status: 'deferred',
          sourceSize: stat.size,
          maxBytes
        })
      },
      [
        diagnostic(
          'snapshot.byte-limit',
          'The snapshot exceeds maxBytes and was not parsed partially; the cursor was not advanced.',
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
  if (
    cursorIn.collectorRevision === COLLECTOR_REVISION &&
    cursorIn.sourceGeneration === current.generation &&
    cursorIn.signature === signature
  ) {
    return empty(
      cursorIn,
      true,
      {
        completeness: 'complete',
        watermark: JSON.stringify({
          strategy: 'snapshot-signature',
          status: 'unchanged',
          signature: revision
        })
      },
      []
    )
  }
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
          strategy: 'snapshot-signature',
          status: 'unreadable',
          sourceSize: stat.size
        })
      },
      [
        diagnostic(
          'snapshot.invalid-json',
          'The snapshot could not be parsed; the cursor was not advanced.'
        )
      ]
    )
  }
  const root = object(document)
  const session = object(root.session)
  const native = String(
    root.sessionId ?? root.session_id ?? session.sessionId ?? basename(dirname(path))
  )
  const parent = string(root.parentSessionId) ?? string(session.parentSessionId)
  const observedAt =
    timestamp(root.updatedAt ?? root.updated_at ?? session.updatedAt) ?? Math.trunc(stat.mtimeMs)
  const sessionRecordKey = supplied.sourceKey + ':session:' + encodeURIComponent(native)
  const measured = Object.keys(session).length ? session : root
  const values = usageValues(measured)
  const at = timestamp(
    measured.updatedAt ?? measured.updated_at ?? root.updatedAt ?? root.updated_at
  )
  const model = string(session.model) ?? string(root.model)
  const usageReadings = [
    {
      sourceRecordKey: sessionRecordKey + ':usage',
      sourceRecordRevision: revision,
      sessionNativeKey: native,
      measurementKey: MEASUREMENT_KEY,
      mode: 'cumulative',
      counterScope: namespace + ':' + native + ':session-usage',
      counterEpoch: current.generation,
      values,
      semantics: usageSemantics(values, measured),
      timeCoverage:
        at === null
          ? { kind: 'unknown', reason: 'the usage snapshot has no trustworthy timestamp' }
          : { kind: 'point', at, basis: 'native-snapshot' },
      sourceEvidence: { sourceKey: supplied.sourceKey, snapshotRevision: revision }
    }
  ]
  const usageAttributionHints = model
    ? [
        {
          sourceRecordKey: sessionRecordKey + ':usage',
          servedModel: { nativeName: model, namespace: MODEL_NAMESPACE },
          basis: 'reported',
          confidence: 'observed',
          evidence: [
            {
              sourceRecordKey: sessionRecordKey + ':usage',
              description: 'Model recorded on the session snapshot'
            }
          ]
        }
      ]
    : []
  const sessions = [
    {
      sourceRecordKey: sessionRecordKey,
      harnessId: HARNESS,
      namespace,
      nativeSessionKey: native,
      ...(parent ? { parentNativeSessionKey: parent } : {}),
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      metadata: { sourceKey: supplied.sourceKey }
    }
  ]
  const handles = [
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
            'Session snapshot directory carries the native session id used by the CLI resume command.'
        }
      ]
    }
  ]
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
      signature
    },
    exhausted: true,
    coverage: {
      completeness: 'complete',
      watermark: JSON.stringify({
        strategy: 'snapshot-signature',
        status: 'replaced',
        signature: revision
      })
    },
    diagnostics: []
  }
}

function rootsFor(candidate) {
  const root = resolve(String(candidate))
  if (existsSync(join(root, 'sessions'))) return { config: root, data: join(root, 'sessions') }
  return { config: root, data: root }
}

function identify(payload) {
  // Every absolute candidate root can arrive here (config and data alike), so
  // collapse candidates that resolve to the same data namespace.
  const byData = new Map()
  for (const candidate of Array.isArray(payload.candidateLocators)
    ? payload.candidateLocators
    : []) {
    if (typeof candidate !== 'string') continue
    const roots = rootsFor(candidate)
    if (!existsSync(roots.data)) continue
    if (byData.has(roots.data) && byData.get(roots.data).config !== byData.get(roots.data).data)
      continue
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
          description: 'Grok sessions namespace exists',
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
