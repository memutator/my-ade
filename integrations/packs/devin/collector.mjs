import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Devin local database collector (AdapterPack capability: identify, sessions, usage).
//
// Read-only. Only session metadata and the small `metadata.metrics` object of
// `message_nodes.chat_message` are read; prompts, responses and other transcript
// content are never emitted. Streaming and retries can write several rows for
// one message, so usage is keyed by `session_id + message_id` and the latest
// SQLite row is the deterministic representative; rows without a message id
// keep their own row identity instead of being merged into a neighbour.
// The ATIF transcript export is deliberately not used: it is a compacted export
// that undercounts cache reads.
//
// Neither table exposes an update watermark, so collection reconciles the
// logical keyspace in bounded keyset pages and re-emits every row it reads with
// a content revision. A wrapped sweep is what makes absence observable to the
// runtime; the collector itself never claims a deletion.
const HARNESS = 'devin'
const DB_NAME = 'sessions.db'
const COLLECTOR_REVISION = '1'
const DEFAULT_MAX_RECORDS = 200
const MODEL_NAMESPACE = 'devin.message_nodes'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const string = (value) => (typeof value === 'string' && value ? value : null)
const numberOrNull = (value) => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'bigint') return Number(value) >= 0 ? Number(value) : null
  if (
    typeof value === 'string' &&
    value.trim() &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0
  )
    return Number(value)
  return null
}
const diagnostic = (code, severity, message, details) => ({
  code,
  severity,
  message,
  ...(details ? { details } : {})
})
const timestamp = (value) => {
  if (typeof value === 'number' && Number.isFinite(value))
    return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value === 'string' && value) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function databasePath(namespace) {
  const root = resolve(String(namespace || ''))
  return basename(root) === DB_NAME ? root : join(root, 'cli', DB_NAME)
}

function openDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  // Both pragmas are hardening: a driver that rejects them still reads the
  // database read-only, which is the property this collector depends on.
  try {
    db.exec('PRAGMA query_only=ON')
  } catch {
    // Unsupported pragma on this build; the connection is already read-only.
  }
  try {
    db.exec('PRAGMA busy_timeout=5000')
  } catch {
    // Unsupported pragma on this build; a busy database surfaces as an error.
  }
  return db
}

function tableInfo(db, table) {
  return db.prepare('PRAGMA table_info(' + table + ')').all()
}

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
}

function dataNamespaceFor(path) {
  return 'devin-data:' + sha(resolve(dirname(path), '..')).slice(0, 32)
}

/**
 * Counter epoch = the numbering space of the stored counters, taken from the
 * database file identity. A schema change still changes the generation digest
 * and forces rediscovery, but it does not by itself open a new counter space.
 */
function counterEpochFor(stat) {
  return [
    'db',
    stat.dev,
    'ino',
    stat.ino,
    'birth',
    Math.trunc(stat.birthtimeMs || stat.ctimeMs)
  ].join(':')
}

function sourceFor(path, capability) {
  const actual = realpathSync(path)
  const stat = statSync(actual)
  const table = capability === 'sessions' ? 'sessions' : 'message_nodes'
  const db = openDatabase(actual)
  try {
    if (!hasTable(db, table)) throw new Error('the ' + table + ' table is unavailable')
    const schema = tableInfo(db, table)
      .map((row) => ({ name: String(row.name), type: String(row.type), pk: Number(row.pk) }))
      .sort((left, right) => left.name.localeCompare(right.name))
    const namespace = dataNamespaceFor(actual)
    return {
      sourceKey: namespace + ':' + table,
      kind: 'database',
      locator: {
        path: actual,
        table,
        namespace,
        keyColumn: table === 'sessions' ? 'id' : 'session_id+message_id',
        counterEpoch: counterEpochFor(stat)
      },
      generation: sha(
        JSON.stringify({
          dev: String(stat.dev),
          ino: String(stat.ino),
          birthtimeMs: stat.birthtimeMs,
          table,
          schema
        })
      ),
      identityEvidence: {
        database: DB_NAME,
        table,
        schemaDigest: sha(JSON.stringify(schema)),
        ...(table === 'message_nodes' ? { metricsPath: '$.metadata.metrics' } : {})
      }
    }
  } finally {
    db.close()
  }
}

function discover(payload) {
  const path = databasePath(payload.dataNamespace)
  if (!existsSync(path)) return { sources: [] }
  try {
    return { sources: [sourceFor(path, payload.capability)] }
  } catch {
    return { sources: [] }
  }
}

/** Identify accepts any database that carries a stream this Pack can read. */
function identifiableSource(path) {
  for (const capability of ['sessions', 'usage']) {
    try {
      return sourceFor(path, capability)
    } catch {
      // Try the next readable stream.
    }
  }
  return null
}

function quoted(name) {
  return '"' + String(name).replaceAll('"', '""') + '"'
}

function expr(cols, name) {
  return cols.has(name) ? quoted(name) : 'NULL AS ' + quoted(name)
}

function sessionPage(db, afterKey, limit) {
  const cols = new Set(tableInfo(db, 'sessions').map((row) => String(row.name)))
  if (!cols.has('id')) throw new Error('sessions.id is required')
  const wanted = ['id', 'parent_id', 'parent_session_id', 'title', 'working_directory']
  return db
    .prepare(
      'SELECT ' +
        wanted.map((name) => expr(cols, name)).join(', ') +
        ' FROM sessions WHERE CAST(id AS TEXT) > ? ORDER BY CAST(id AS TEXT), rowid LIMIT ?'
    )
    .all(afterKey || '', limit + 1)
}

const USAGE_KEY_SQL =
  "CAST(session_id AS TEXT) || char(31) || COALESCE(CAST(json_extract(chat_message, '$.message_id') AS TEXT), 'rowid:' || printf('%020d', rowid))"

function usagePage(db, afterKey, limit) {
  const cols = new Set(tableInfo(db, 'message_nodes').map((row) => String(row.name)))
  if (!cols.has('session_id') || !cols.has('chat_message')) {
    throw new Error('message_nodes.session_id and message_nodes.chat_message are required')
  }
  const sql =
    'WITH ranked AS (' +
    ' SELECT ' +
    USAGE_KEY_SQL +
    ' AS __key,' +
    ' CAST(session_id AS TEXT) AS session_id,' +
    " json_extract(chat_message, '$.message_id') AS message_id," +
    " json_extract(chat_message, '$.metadata.metrics.input_tokens') AS input_tokens," +
    " json_extract(chat_message, '$.metadata.metrics.output_tokens') AS output_tokens," +
    " json_extract(chat_message, '$.metadata.metrics.cache_read_tokens') AS cache_read_tokens," +
    " json_extract(chat_message, '$.metadata.metrics.reasoning_tokens') AS reasoning_tokens," +
    " COALESCE(json_extract(chat_message, '$.metadata.model'), json_extract(chat_message, '$.metadata.model_id')) AS model," +
    " COALESCE(json_extract(chat_message, '$.metadata.provider'), json_extract(chat_message, '$.metadata.provider_id')) AS provider," +
    " COALESCE(json_extract(chat_message, '$.metadata.metrics.timestamp'), json_extract(chat_message, '$.created_at')) AS occurred_at," +
    ' row_number() OVER (PARTITION BY ' +
    USAGE_KEY_SQL +
    ' ORDER BY rowid DESC) AS rank' +
    ' FROM message_nodes' +
    " WHERE json_extract(chat_message, '$.metadata.metrics.input_tokens') IS NOT NULL" +
    ') SELECT * FROM ranked WHERE rank=1 AND __key > ? ORDER BY __key LIMIT ?'
  return db.prepare(sql).all(afterKey || '', limit + 1)
}

function sessionRecord(row, revision, namespace, observedAt, sourceKey) {
  const id = String(row.id)
  const parent = row.parent_session_id ?? row.parent_id
  return {
    sourceRecordKey: namespace + ':session:' + encodeURIComponent(id),
    harnessId: HARNESS,
    namespace,
    nativeSessionKey: id,
    ...(parent == null ? {} : { parentNativeSessionKey: String(parent) }),
    ...(string(row.title) ? { title: string(row.title) } : {}),
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    metadata: {
      sourceKey,
      rowRevision: revision,
      ...(string(row.working_directory) ? { workingDirectory: string(row.working_directory) } : {})
    }
  }
}

/**
 * Usage rows reference a session by id; the ledger resolves session identity
 * from the same batch, so a usage page reports one session record per distinct
 * referenced session instead of inventing a record from a message row.
 */
function usageSessionRecords(rows, namespace, observedAt, sourceKey) {
  const seen = new Map()
  for (const row of rows) {
    const sessionId = row.session_id == null ? null : String(row.session_id)
    if (!sessionId || seen.has(sessionId)) continue
    seen.set(sessionId, {
      sourceRecordKey: namespace + ':session:' + encodeURIComponent(sessionId),
      harnessId: HARNESS,
      namespace,
      nativeSessionKey: sessionId,
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      metadata: { sourceKey, referencedBy: 'message-usage-row' }
    })
  }
  return [...seen.values()]
}

function usageRecord(row, revision, namespace, sourceKey) {
  const input = numberOrNull(row.input_tokens)
  const output = numberOrNull(row.output_tokens)
  const cacheRead = numberOrNull(row.cache_read_tokens)
  const reasoning = numberOrNull(row.reasoning_tokens)
  // Native accounting: cache read is additional to input. Nothing establishes
  // the containment of reasoning tokens, so they stay out of the total.
  const total =
    input !== null && output !== null && cacheRead !== null ? input + output + cacheRead : null
  const at = timestamp(row.occurred_at)
  const key = String(row.__key)
  return {
    sourceRecordKey: namespace + ':message:' + encodeURIComponent(key),
    sourceRecordRevision: revision,
    sessionNativeKey: String(row.session_id),
    measurementKey: 'devin.message.metrics',
    mode: 'delta',
    values: {
      inputTotal: input,
      outputTotal: output,
      total,
      cacheReadInput: cacheRead,
      cacheWriteInput: null,
      reasoningOutput: reasoning
    },
    semantics: {
      unit: 'tokens',
      componentRelations: [
        { component: 'inputTotal', relation: 'excludes', other: 'cacheReadInput' },
        { component: 'outputTotal', relation: 'unknown', other: 'reasoningOutput' }
      ],
      calculatedTotal: total,
      completeness: total === null ? 'partial' : 'complete',
      nativeFields: {
        inputTotal: 'input_tokens',
        outputTotal: 'output_tokens',
        cacheReadInput: 'cache_read_tokens',
        reasoningOutput: 'reasoning_tokens'
      }
    },
    timeCoverage:
      at === null
        ? { kind: 'unknown', reason: 'the message metrics carry no trustworthy timestamp' }
        : { kind: 'point', at, basis: 'message-metric-timestamp' },
    sourceEvidence: {
      sourceKey,
      table: 'message_nodes',
      rowKey: key,
      dedupeKey: 'session_id+message_id',
      ...(row.message_id == null ? { messageIdUnavailable: true } : {})
    }
  }
}

function attributionHint(row, sourceRecordKey) {
  const provider = string(row.provider)
  const model = string(row.model)
  if (!provider && !model) return null
  return {
    sourceRecordKey,
    ...(model ? { servedModel: { nativeName: model, namespace: MODEL_NAMESPACE } } : {}),
    basis: 'reported',
    confidence: 'observed',
    // The native provider string is not a canonical Provider identity, so it is
    // preserved as evidence instead of being asserted as a catalog id.
    evidence: [
      {
        sourceRecordKey,
        description: 'Attribution field stored in the same message metadata',
        data: {
          ...(provider ? { nativeProviderName: provider } : {}),
          ...(model ? { nativeModelName: model } : {})
        }
      }
    ]
  }
}

function collect(request, payload) {
  const observedAt = Date.now()
  const cursorIn = object(payload.cursor ?? request.cursor)
  const supplied = object(payload.source)
  const locator = object(supplied.locator)
  const path = resolve(String(locator.path || ''))
  if (basename(path) !== DB_NAME) throw new Error('source locator is not a Devin database')
  if (!existsSync(path)) throw new Error('source database is missing; rediscovery is required')
  const current = sourceFor(path, request.capability)
  if (typeof supplied.generation === 'string' && supplied.generation !== current.generation) {
    throw new Error('source generation changed; rediscovery is required before collecting again')
  }
  if (locator.table !== current.locator.table)
    throw new Error('the source stream changed; rediscovery is required')
  const generation = current.generation
  const compatible =
    cursorIn.collectorRevision === COLLECTOR_REVISION &&
    cursorIn.sourceGeneration === generation &&
    typeof cursorIn.afterKey === 'string'
  const afterKey = compatible ? cursorIn.afterKey : ''
  const sweep =
    compatible && Number.isInteger(cursorIn.sweep) && cursorIn.sweep >= 0 ? cursorIn.sweep : 0
  const maxRecords = Math.max(
    1,
    Math.min(Math.floor(Number(payload.maxRecords) || DEFAULT_MAX_RECORDS), 1000)
  )
  const db = openDatabase(path)
  let rows
  try {
    rows =
      request.capability === 'sessions'
        ? sessionPage(db, afterKey, maxRecords)
        : usagePage(db, afterKey, maxRecords)
  } finally {
    db.close()
  }
  const hasMore = rows.length > maxRecords
  if (hasMore) rows.length = maxRecords
  const projected = rows.map((row) => ({ row, revision: 'sha256:' + sha(JSON.stringify(row)) }))
  const namespace = current.locator.namespace
  const sourceKey = supplied.sourceKey
  const readings =
    request.capability === 'usage'
      ? projected.map(({ row, revision }) => usageRecord(row, revision, namespace, sourceKey))
      : []
  const lastKey = rows.length
    ? String(request.capability === 'sessions' ? rows.at(-1).id : rows.at(-1).__key)
    : afterKey
  const swept = !hasMore
  return {
    observations: [],
    sessions:
      request.capability === 'sessions'
        ? projected.map(({ row, revision }) =>
            sessionRecord(row, revision, namespace, observedAt, sourceKey)
          )
        : usageSessionRecords(rows, namespace, observedAt, sourceKey),
    handles: [],
    attachments: [],
    events: [],
    usageReadings: readings,
    usageAttributionHints: readings
      .map((reading, index) => attributionHint(rows[index], reading.sourceRecordKey))
      .filter(Boolean),
    quotaReadings: [],
    nextCursor: {
      collectorRevision: COLLECTOR_REVISION,
      sourceGeneration: generation,
      sweep: swept ? sweep + 1 : sweep,
      afterKey: swept ? '' : lastKey,
      sweptAt: swept ? observedAt : null
    },
    exhausted: swept,
    coverage: {
      completeness: hasMore ? 'partial' : 'complete',
      watermark: JSON.stringify({
        strategy: 'bounded-keyspace-reconciliation',
        sweep,
        stream: current.locator.table,
        rangeStartExclusive: afterKey || null,
        rangeEndInclusive: rows.length ? lastKey : afterKey || null,
        revisionCoverage: 'every row re-emitted each sweep',
        deletionCoverage: hasMore ? 'pending' : 'complete-sweep-absence',
        keyspaceWrapped: swept,
        duplicateMetrics:
          'latest row per session_id and message_id; rows without a message id keep their own row identity'
      })
    },
    diagnostics: hasMore
      ? [
          diagnostic(
            'reconciliation.pending',
            'info',
            'More rows remain in this reconciliation sweep.'
          )
        ]
      : []
  }
}

function identify(payload) {
  // Both the config root and the data root can arrive as candidates; the
  // database is the identity, so one installation is reported per database
  // file under the enclosing config root when that candidate is present.
  const candidates = (Array.isArray(payload.candidateLocators) ? payload.candidateLocators : [])
    .filter((candidate) => typeof candidate === 'string')
    .map((candidate) => resolve(candidate))
  const configs = candidates.filter((candidate) => !existsSync(join(candidate, DB_NAME)))
  const installations = []
  const seen = new Set()
  for (const candidate of candidates) {
    const path = databasePath(candidate)
    if (!existsSync(path) || seen.has(path)) continue
    try {
      const source = identifiableSource(path)
      if (!source) continue
      seen.add(path)
      const enclosing = configs.find((config) => path === join(config, 'cli', DB_NAME))
      installations.push({
        harnessId: HARNESS,
        configNamespace: enclosing ?? resolve(dirname(path), '..'),
        dataNamespace: resolve(dirname(path), '..'),
        presence: 'present',
        evidence: [
          {
            sourceRecordKey: source.sourceKey,
            description: 'Devin SQLite schema observed',
            data: source.identityEvidence
          }
        ]
      })
    } catch {
      // A candidate without the expected schema is not this installation.
    }
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
  try {
    if (request.action === 'discover-sources') {
      return envelope(request, 'success', discover(object(request.payload)), [], startedAt)
    }
    if (request.action === 'collect' || !request.action) {
      if (request.capability === 'sessions' || request.capability === 'usage') {
        const payload = collect(request, object(request.payload))
        return envelope(
          request,
          payload.coverage.completeness === 'complete' ? 'success' : 'partial',
          payload,
          [],
          startedAt
        )
      }
      if (request.capability === 'identify' && !request.action) {
        return envelope(request, 'success', identify(object(request.payload)), [], startedAt)
      }
    }
  } catch (error) {
    return envelope(
      request,
      'failed',
      null,
      [
        diagnostic(
          'collector.failed',
          'error',
          error instanceof Error ? error.message : String(error)
        )
      ],
      startedAt
    )
  }
  return envelope(
    request,
    'failed',
    null,
    [diagnostic('capability.unsupported', 'error', 'Unsupported capability.')],
    startedAt
  )
}

let input = ''
for await (const chunk of process.stdin) input += chunk
process.stdout.write(JSON.stringify(await main(JSON.parse(input))) + '\n')
