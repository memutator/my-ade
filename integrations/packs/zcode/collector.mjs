import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// ZCode local database collector (AdapterPack capability: identify, sessions, usage).
//
// Read-only. `model_usage` is the per-request metering stream (main turns,
// subagents, compaction, verification); `turn_usage` is a per-turn rollup that
// drops some of those rows and is used only when `model_usage` is absent, with
// the degraded stream reported in coverage. Neither stream exposes a trusted
// update watermark, so both are reconciled in bounded keyset pages: every row
// read is re-emitted with a content-derived revision, and a wrapped sweep is
// what lets the runtime observe absence. Provider/model/time are attributed
// only from fields present on the usage row itself.
const HARNESS = 'zcode'
const DB_NAME = 'db.sqlite'
const COLLECTOR_REVISION = '1'
const DEFAULT_MAX_RECORDS = 200
const MODEL_NAMESPACE = 'zcode.sqlite'

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
  return basename(root) === DB_NAME ? root : join(root, 'cli', 'db', DB_NAME)
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
  return 'zcode-data:' + sha(resolve(dirname(path), '..', '..')).slice(0, 32)
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

function usageTable(db, capability) {
  if (capability === 'sessions') return 'session'
  if (hasTable(db, 'model_usage')) return 'model_usage'
  if (hasTable(db, 'turn_usage')) return 'turn_usage'
  return ''
}

function sourceFor(path, capability) {
  const actual = realpathSync(path)
  const stat = statSync(actual)
  const db = openDatabase(actual)
  try {
    const table = usageTable(db, capability)
    if (!table || !hasTable(db, table))
      throw new Error('the ' + capability + ' table is unavailable')
    const schema = tableInfo(db, table)
      .map((row) => ({ name: String(row.name), type: String(row.type), pk: Number(row.pk) }))
      .sort((left, right) => left.name.localeCompare(right.name))
    const namespace = dataNamespaceFor(actual)
    const streamRole =
      capability === 'usage' ? (table === 'model_usage' ? 'primary' : 'fallback') : 'sessions'
    return {
      sourceKey: namespace + ':' + table,
      kind: 'database',
      locator: {
        path: actual,
        table,
        namespace,
        keyColumn: keyPlan(schema).kind,
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
        usageStreamRole: streamRole
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

/** Identify accepts any database that carries a stream this Pack can read, so a
 *  database with only the usage tables is still a real installation. */
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

function keyPlan(info) {
  const names = new Set(info.map((row) => String(row.name)))
  const pk = info
    .filter((row) => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
  if (pk.length === 1)
    return { expression: 'CAST(' + quoted(pk[0].name) + ' AS TEXT)', kind: 'pk:' + pk[0].name }
  if (names.has('id')) return { expression: 'CAST("id" AS TEXT)', kind: 'id' }
  return { expression: "printf('%020d', rowid)", kind: 'rowid' }
}

function expr(cols, name) {
  return cols.has(name) ? quoted(name) : 'NULL AS ' + quoted(name)
}

function page(db, table, afterKey, limit, capability) {
  const info = tableInfo(db, table)
  const cols = new Set(info.map((row) => String(row.name)))
  const key = keyPlan(info)
  const wanted =
    capability === 'sessions'
      ? ['id', 'parent_id', 'title', 'directory']
      : [
          'session_id',
          'input_tokens',
          'output_tokens',
          'cache_read_input_tokens',
          'reasoning_tokens',
          'model',
          'model_id',
          'provider',
          'provider_id',
          'created_at',
          'timestamp',
          'kind',
          'type'
        ]
  const sql =
    'SELECT ' +
    key.expression +
    ' AS __key, ' +
    wanted.map((name) => expr(cols, name)).join(', ') +
    ' FROM ' +
    quoted(table) +
    ' WHERE ' +
    key.expression +
    ' > ? ORDER BY ' +
    key.expression +
    ' LIMIT ?'
  return { rows: db.prepare(sql).all(afterKey || '', limit + 1), keyKind: key.kind }
}

function sessionRecord(row, revision, namespace, observedAt, sourceKey) {
  const id = String(row.id)
  return {
    sourceRecordKey: namespace + ':session:' + encodeURIComponent(id),
    harnessId: HARNESS,
    namespace,
    nativeSessionKey: id,
    ...(row.parent_id == null ? {} : { parentNativeSessionKey: String(row.parent_id) }),
    ...(string(row.title) ? { title: string(row.title) } : {}),
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    metadata: {
      sourceKey,
      rowRevision: revision,
      ...(string(row.directory) ? { workingDirectory: string(row.directory) } : {})
    }
  }
}

/**
 * Usage rows reference a session by id; the ledger resolves session identity
 * from the same batch, so a usage page reports one session record per distinct
 * referenced session instead of inventing a record from a usage row.
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
      metadata: { sourceKey, referencedBy: 'usage-row' }
    })
  }
  return [...seen.values()]
}

function observedText(row, names) {
  for (const name of names) if (string(row[name])) return row[name]
  return null
}

function usageRecord(row, revision, table, keyKind, namespace, sourceKey) {
  const key = String(row.__key)
  const sessionId = row.session_id == null ? null : String(row.session_id)
  const input = numberOrNull(row.input_tokens)
  const output = numberOrNull(row.output_tokens)
  const cacheRead = numberOrNull(row.cache_read_input_tokens)
  const reasoning = numberOrNull(row.reasoning_tokens)
  // Native accounting: cache read is contained in input, reasoning in output.
  const total = input !== null && output !== null ? input + output : null
  const at = timestamp(row.created_at ?? row.timestamp)
  return {
    sourceRecordKey: namespace + ':' + table + ':' + encodeURIComponent(key),
    sourceRecordRevision: revision,
    ...(sessionId === null ? {} : { sessionNativeKey: sessionId }),
    measurementKey: 'zcode.' + table + '.tokens',
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
        { component: 'inputTotal', relation: 'includes', other: 'cacheReadInput' },
        { component: 'outputTotal', relation: 'includes', other: 'reasoningOutput' }
      ],
      calculatedTotal: total,
      completeness: total === null ? 'partial' : 'complete',
      nativeFields: {
        inputTotal: 'input_tokens',
        outputTotal: 'output_tokens',
        cacheReadInput: 'cache_read_input_tokens',
        reasoningOutput: 'reasoning_tokens'
      }
    },
    timeCoverage:
      at === null
        ? { kind: 'unknown', reason: 'the usage row carries no trustworthy timestamp' }
        : { kind: 'point', at, basis: 'usage-row-timestamp' },
    sourceEvidence: {
      sourceKey,
      table,
      rowKey: key,
      rowKeyKind: keyKind,
      ...(observedText(row, ['kind', 'type'])
        ? { nativeKind: observedText(row, ['kind', 'type']) }
        : {})
    }
  }
}

function attributionHint(row, sourceRecordKey) {
  const provider = observedText(row, ['provider_id', 'provider'])
  const model = observedText(row, ['model_id', 'model'])
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
        description: 'Attribution field stored on the same usage row',
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
  if (basename(path) !== DB_NAME) throw new Error('source locator is not a ZCode database')
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
  let result
  try {
    result = page(db, current.locator.table, afterKey, maxRecords, request.capability)
  } finally {
    db.close()
  }
  const rows = result.rows
  const hasMore = rows.length > maxRecords
  if (hasMore) rows.length = maxRecords
  const projected = rows.map((row) => ({ row, revision: 'sha256:' + sha(JSON.stringify(row)) }))
  const namespace = current.locator.namespace
  const sourceKey = supplied.sourceKey
  const readings =
    request.capability === 'usage'
      ? projected.map(({ row, revision }) =>
          usageRecord(row, revision, current.locator.table, result.keyKind, namespace, sourceKey)
        )
      : []
  const lastKey = rows.length ? String(rows.at(-1).__key) : afterKey
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
        streamRole: current.identityEvidence.usageStreamRole,
        rangeStartExclusive: afterKey || null,
        rangeEndInclusive: rows.length ? lastKey : afterKey || null,
        revisionCoverage: 'every row re-emitted each sweep',
        deletionCoverage: hasMore ? 'pending' : 'complete-sweep-absence',
        keyspaceWrapped: swept
      })
    },
    diagnostics: [
      ...(current.locator.table === 'turn_usage' && request.capability === 'usage'
        ? [
            diagnostic(
              'usage.fallback-stream',
              'warning',
              'model_usage is unavailable; turn_usage can omit auxiliary inference usage.'
            )
          ]
        : []),
      ...(hasMore
        ? [
            diagnostic(
              'reconciliation.pending',
              'info',
              'More rows remain in this reconciliation sweep.'
            )
          ]
        : [])
    ]
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
      const enclosing = configs.find((config) => path === join(config, 'cli', 'db', DB_NAME))
      installations.push({
        harnessId: HARNESS,
        configNamespace: enclosing ?? resolve(dirname(path)),
        dataNamespace: resolve(dirname(path), '..', '..'),
        presence: 'present',
        evidence: [
          {
            sourceRecordKey: source.sourceKey,
            description: 'ZCode SQLite schema observed',
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
