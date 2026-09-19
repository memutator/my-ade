import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// OpenCode local database collector (AdapterPack capability: identify, sessions, usage).
//
// Read-only. The `session` table is a mutable cumulative source without a
// trustworthy update watermark, so collection reconciles the keyspace in
// bounded keyset pages and re-emits every row it reads with a content-derived
// row revision. A page that ends the keyspace wraps the sweep: the next call
// starts a new sweep from the first key. `exhausted: true` therefore means
// "this sweep wrapped", not "the source is complete forever" — rows deleted
// between sweeps are observable only as absence from a wrapped sweep, which the
// runtime compares against its stored checkpoint, so the collector never claims
// deletion by itself.
const HARNESS = 'opencode'
const DB_NAME = 'opencode.db'
const COLLECTOR_REVISION = '1'
const DEFAULT_MAX_RECORDS = 200
const MEASUREMENT_KEY = 'opencode.session.tokens'

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

function databasePath(namespace) {
  const root = resolve(String(namespace || ''))
  return basename(root) === DB_NAME ? root : join(root, DB_NAME)
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

function columns(db, table) {
  return new Set(
    db
      .prepare('PRAGMA table_info(' + table + ')')
      .all()
      .map((row) => String(row.name))
  )
}

function dataNamespaceFor(path) {
  return 'opencode-data:' + sha(resolve(path)).slice(0, 32)
}

/**
 * Counter epoch = the numbering space of the stored counters. It follows the
 * database file identity rather than the table schema: an upgrade that adds a
 * column keeps the same counters, while a replaced database file starts a new
 * space. A schema change still changes the generation digest, which forces
 * rediscovery instead of silently reusing a stale checkpoint.
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

function sourceFor(path) {
  const actual = realpathSync(path)
  const stat = statSync(actual)
  const db = openDatabase(actual)
  try {
    const cols = [...columns(db, 'session')].sort()
    if (!cols.includes('id')) throw new Error('the session table with an id column is required')
    const namespace = dataNamespaceFor(actual)
    return {
      sourceKey: namespace + ':session-table',
      kind: 'database',
      locator: {
        path: actual,
        table: 'session',
        namespace,
        keyColumn: 'id',
        counterEpoch: counterEpochFor(stat)
      },
      generation: sha(
        JSON.stringify({
          dev: String(stat.dev),
          ino: String(stat.ino),
          birthtimeMs: stat.birthtimeMs,
          table: 'session',
          schema: cols
        })
      ),
      identityEvidence: {
        database: DB_NAME,
        table: 'session',
        schemaDigest: sha(JSON.stringify(cols))
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
    return { sources: [sourceFor(path)] }
  } catch {
    return { sources: [] }
  }
}

function selectExpr(cols, name) {
  return cols.has(name) ? '"' + name + '"' : 'NULL AS "' + name + '"'
}

function page(db, afterKey, limit) {
  const cols = columns(db, 'session')
  const wanted = [
    'id',
    'parent_id',
    'title',
    'directory',
    'tokens_input',
    'tokens_output',
    'tokens_reasoning',
    'tokens_cache_read',
    'tokens_cache_write',
    'cost'
  ]
  const sql =
    'SELECT ' +
    wanted.map((name) => selectExpr(cols, name)).join(', ') +
    ' FROM session WHERE CAST(id AS TEXT) > ? ORDER BY CAST(id AS TEXT), rowid LIMIT ?'
  return db.prepare(sql).all(afterKey || '', limit + 1)
}

function usageValues(row) {
  const input = numberOrNull(row.tokens_input)
  const output = numberOrNull(row.tokens_output)
  const reasoning = numberOrNull(row.tokens_reasoning)
  const cacheRead = numberOrNull(row.tokens_cache_read)
  const cacheWrite = numberOrNull(row.tokens_cache_write)
  // The legacy ledger and its source notes establish that cache reads are
  // additional to tokens_input. Nothing establishes the containment of
  // tokens_cache_write, so it is preserved without entering the total.
  const total =
    input !== null && output !== null && reasoning !== null && cacheRead !== null
      ? input + output + reasoning + cacheRead
      : null
  return {
    inputTotal: input,
    outputTotal: output,
    total,
    cacheReadInput: cacheRead,
    cacheWriteInput: cacheWrite,
    reasoningOutput: reasoning
  }
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

function usageRecord(row, revision, generation, namespace, sourceKey) {
  const id = String(row.id)
  const values = usageValues(row)
  const cost = numberOrNull(row.cost)
  return {
    sourceRecordKey: namespace + ':session:' + encodeURIComponent(id) + ':usage',
    sourceRecordRevision: revision,
    sessionNativeKey: id,
    measurementKey: MEASUREMENT_KEY,
    mode: 'cumulative',
    counterScope: namespace + ':session:' + id + ':tokens',
    counterEpoch: generation,
    values,
    semantics: {
      unit: 'tokens',
      componentRelations: [
        { component: 'inputTotal', relation: 'excludes', other: 'cacheReadInput' },
        { component: 'inputTotal', relation: 'unknown', other: 'cacheWriteInput' },
        { component: 'outputTotal', relation: 'unknown', other: 'reasoningOutput' }
      ],
      calculatedTotal: values.total,
      completeness:
        values.total === null || values.cacheWriteInput === null ? 'partial' : 'complete',
      nativeFields: {
        inputTotal: 'tokens_input',
        outputTotal: 'tokens_output',
        reasoningOutput: 'tokens_reasoning',
        cacheReadInput: 'tokens_cache_read',
        cacheWriteInput: 'tokens_cache_write'
      }
    },
    timeCoverage: {
      kind: 'unknown',
      reason: 'OpenCode session counters do not identify when tokens were consumed'
    },
    sourceEvidence: {
      sourceKey,
      table: 'session',
      rowKey: id,
      ...(cost === null ? {} : { reportedCostUsd: cost }),
      ...(row.parent_id == null ? {} : { parentNativeSessionKey: String(row.parent_id) })
    }
  }
}

function collect(request, payload) {
  const observedAt = Date.now()
  const cursorIn = object(payload.cursor ?? request.cursor)
  const supplied = object(payload.source)
  const locator = object(supplied.locator)
  const path = resolve(String(locator.path || ''))
  if (basename(path) !== DB_NAME) throw new Error('source locator is not an OpenCode database')
  if (!existsSync(path)) throw new Error('source database is missing; rediscovery is required')
  const current = sourceFor(path)
  if (typeof supplied.generation === 'string' && supplied.generation !== current.generation) {
    throw new Error('source generation changed; rediscovery is required before collecting again')
  }
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
    rows = page(db, afterKey, maxRecords)
  } finally {
    db.close()
  }
  const hasMore = rows.length > maxRecords
  if (hasMore) rows.length = maxRecords
  const projected = rows.map((row) => ({
    row,
    revision:
      'sha256:' +
      sha(
        JSON.stringify({
          id: String(row.id),
          parent: row.parent_id ?? null,
          title: row.title ?? null,
          directory: row.directory ?? null,
          input: numberOrNull(row.tokens_input),
          output: numberOrNull(row.tokens_output),
          reasoning: numberOrNull(row.tokens_reasoning),
          cacheRead: numberOrNull(row.tokens_cache_read),
          cacheWrite: numberOrNull(row.tokens_cache_write),
          cost: numberOrNull(row.cost)
        })
      )
  }))
  const capability = request.capability
  const namespace = current.locator.namespace
  const sourceKey = supplied.sourceKey
  const lastKey = rows.length ? String(rows.at(-1).id) : afterKey
  const swept = !hasMore
  return {
    observations: [],
    sessions: projected.map(({ row, revision }) =>
      sessionRecord(row, revision, namespace, observedAt, sourceKey)
    ),
    handles: [],
    attachments: [],
    events: [],
    usageReadings:
      capability === 'usage'
        ? projected.map(({ row, revision }) =>
            usageRecord(row, revision, current.locator.counterEpoch, namespace, sourceKey)
          )
        : [],
    usageAttributionHints: [],
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
        rangeStartExclusive: afterKey || null,
        rangeEndInclusive: rows.length ? lastKey : afterKey || null,
        revisionCoverage: 'every row re-emitted each sweep',
        deletionCoverage: hasMore ? 'pending' : 'complete-sweep-absence',
        keyspaceWrapped: swept
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
  // The scheduler hands over both the config root and the data root of one
  // installation. The database is the identity: one data namespace per
  // database file, reported under the enclosing config root when that
  // candidate is present.
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
      const source = sourceFor(path)
      seen.add(path)
      const enclosing = configs.find((config) => path === join(config, DB_NAME))
      installations.push({
        harnessId: HARNESS,
        configNamespace: enclosing ?? resolve(dirname(path)),
        dataNamespace: resolve(dirname(path)),
        presence: 'present',
        evidence: [
          {
            sourceRecordKey: source.sourceKey,
            description: 'OpenCode SQLite schema observed',
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
