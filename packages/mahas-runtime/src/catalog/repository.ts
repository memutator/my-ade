import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'
import type {
  CatalogEvidenceRef,
  Harness,
  InferenceModel,
  ModelAliasResolution,
  NativeModelAlias,
  Offering,
  Organization,
  Provider
} from '../../../mahas-contracts/src/catalog/index.ts'
import { mahasError } from '../api/handler-ports.ts'

export interface Versioned<T> {
  value: T
  revision: number
}

type Row = Record<string, unknown>

function json<T>(value: unknown, field: string): T {
  try {
    return JSON.parse(String(value)) as T
  } catch {
    throw mahasError('CONTROL_UNAVAILABLE', `stored ${field} is not valid JSON`, 'reconcile')
  }
}

function text(value: unknown): string {
  return String(value)
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function revisionOf(row: Row | undefined, id: string): number {
  if (!row) throw mahasError('MODEL_INVALID', `catalog object ${id} does not exist`, 'none')
  return Number(row.revision)
}

function assertExpected(actual: number | undefined, expected: number | undefined, id: string): void {
  if (expected === undefined) return
  const normalized = actual ?? 0
  if (normalized !== expected) {
    throw mahasError(
      'STALE_REVISION',
      `catalog object ${id} expected revision ${expected}, current revision ${normalized}`,
      'reconcile',
      { id, expectedRevision: expected, actualRevision: normalized }
    )
  }
}

function validateId(id: string, field = 'id'): void {
  if (!id.trim()) throw mahasError('MODEL_INVALID', `${field} must be non-empty`, 'none')
}

function validateText(value: string, field: string): void {
  if (!value.trim()) throw mahasError('MODEL_INVALID', `${field} must be non-empty`, 'none')
}

/**
 * A second row claiming the same unique identity must fail as a domain error:
 * a raw SQLite constraint message would leave the caller without an ErrorCode
 * or retry verdict. `where` is built from module constants, never caller input.
 */
function rejectDuplicateIdentity(
  db: DatabaseSync,
  table: string,
  id: string,
  where: string,
  params: readonly SQLInputValue[],
  field: string
): void {
  const row = db
    .prepare(`SELECT id FROM ${table} WHERE ${where} AND id<>?`)
    .get(...params, id) as Row | undefined
  if (row) {
    throw mahasError(
      'INVALID_TRANSITION',
      `${field} is already claimed by ${String(row.id)}`,
      'none'
    )
  }
}

function validateTimeRange(from: number, until: number | null | undefined, field: string): void {
  if (!Number.isSafeInteger(from) || (until != null && !Number.isSafeInteger(until))) {
    throw mahasError('MODEL_INVALID', `${field} timestamps must be integer milliseconds`, 'none')
  }
  if (until != null && until < from) {
    throw mahasError('MODEL_INVALID', `${field}.validUntil precedes validFrom`, 'none')
  }
}

function currentRevision(db: DatabaseSync, table: string, id: string): number | undefined {
  // table is selected only from module constants, never caller input.
  const row = db.prepare(`SELECT revision FROM ${table} WHERE id=?`).get(id) as Row | undefined
  return row ? Number(row.revision) : undefined
}

function requireRef(db: DatabaseSync, table: string, id: string, field: string): void {
  validateId(id, field)
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id)) {
    throw mahasError('MODEL_INVALID', `${field} ${id} does not exist`, 'none')
  }
}

function upsert(
  db: DatabaseSync,
  table: string,
  id: string,
  columns: readonly string[],
  values: readonly SQLInputValue[],
  expectedRevision?: number
): number {
  validateId(id)
  const current = currentRevision(db, table, id)
  assertExpected(current, expectedRevision, id)
  if (current === undefined) {
    const qs = Array(columns.length + 2).fill('?').join(',')
    db.prepare(`INSERT INTO ${table}(id,${columns.join(',')},revision) VALUES(${qs})`).run(
      id,
      ...values,
      1
    )
    return 1
  }
  const next = current + 1
  const assignments = columns.map((column) => `${column}=?`).join(',')
  const result = db
    .prepare(`UPDATE ${table} SET ${assignments},revision=? WHERE id=? AND revision=?`)
    .run(...values, next, id, current)
  if (Number(result.changes) !== 1) {
    throw mahasError('STALE_REVISION', `catalog object ${id} changed concurrently`, 'reconcile')
  }
  return next
}

export function putOrganization(
  db: DatabaseSync,
  value: Organization,
  expectedRevision?: number
): Versioned<Organization> {
  validateText(value.name, 'name')
  const revision = upsert(
    db,
    'catalog_organizations',
    value.id,
    ['name', 'metadata_json'],
    [value.name, JSON.stringify(value.metadata)],
    expectedRevision
  )
  return { value, revision }
}

export function putHarness(
  db: DatabaseSync,
  value: Harness,
  expectedRevision?: number
): Versioned<Harness> {
  validateText(value.label, 'label')
  if (value.publisherOrganizationId) {
    requireRef(db, 'catalog_organizations', value.publisherOrganizationId, 'publisherOrganizationId')
  }
  const revision = upsert(
    db,
    'catalog_harnesses',
    value.id,
    ['publisher_organization_id', 'label', 'identity_metadata_json'],
    [value.publisherOrganizationId ?? null, value.label, JSON.stringify(value.identityMetadata)],
    expectedRevision
  )
  return { value, revision }
}

export function putProvider(
  db: DatabaseSync,
  value: Provider,
  expectedRevision?: number
): Versioned<Provider> {
  validateText(value.label, 'label')
  validateText(value.realm, 'realm')
  if (value.operatorOrganizationId) {
    requireRef(db, 'catalog_organizations', value.operatorOrganizationId, 'operatorOrganizationId')
  }
  rejectDuplicateIdentity(
    db,
    'catalog_providers',
    value.id,
    'realm=?',
    [value.realm],
    `provider realm ${value.realm}`
  )
  const revision = upsert(
    db,
    'catalog_providers',
    value.id,
    ['operator_organization_id', 'label', 'realm', 'metadata_json'],
    [
      value.operatorOrganizationId ?? null,
      value.label,
      value.realm,
      JSON.stringify(value.metadata)
    ],
    expectedRevision
  )
  return { value, revision }
}

export function putOffering(
  db: DatabaseSync,
  value: Offering,
  expectedRevision?: number
): Versioned<Offering> {
  validateText(value.key, 'key')
  validateText(value.label, 'label')
  requireRef(db, 'catalog_providers', value.providerId, 'providerId')
  rejectDuplicateIdentity(
    db,
    'catalog_offerings',
    value.id,
    'provider_id=? AND offering_key=?',
    [value.providerId, value.key],
    `offering ${value.providerId}/${value.key}`
  )
  const revision = upsert(
    db,
    'catalog_offerings',
    value.id,
    ['provider_id', 'offering_key', 'label', 'metadata_json'],
    [value.providerId, value.key, value.label, JSON.stringify(value.metadata)],
    expectedRevision
  )
  return { value, revision }
}

export function putInferenceModel(
  db: DatabaseSync,
  value: InferenceModel,
  expectedRevision?: number
): Versioned<InferenceModel> {
  validateText(value.label, 'label')
  if (value.publisherOrganizationId) {
    requireRef(db, 'catalog_organizations', value.publisherOrganizationId, 'publisherOrganizationId')
  }
  const revision = upsert(
    db,
    'catalog_inference_models',
    value.id,
    ['publisher_organization_id', 'label', 'model_version', 'metadata_json'],
    [
      value.publisherOrganizationId ?? null,
      value.label,
      value.version ?? null,
      JSON.stringify(value.metadata)
    ],
    expectedRevision
  )
  return { value, revision }
}

export function observeNativeModelAlias(
  db: DatabaseSync,
  value: NativeModelAlias,
  expectedRevision?: number
): Versioned<NativeModelAlias> {
  validateTimeRange(value.firstObservedAt, value.lastObservedAt, 'alias')
  validateText(value.nativeName, 'nativeName')
  const namespaceTable =
    value.namespaceKind === 'harness' ? 'catalog_harnesses' : 'catalog_offerings'
  if (!db.prepare(`SELECT 1 FROM ${namespaceTable} WHERE id=?`).get(value.namespaceId)) {
    throw mahasError(
      'MODEL_INVALID',
      `${value.namespaceKind} namespace ${value.namespaceId} does not exist`,
      'none'
    )
  }
  const previous = db
    .prepare(
      'SELECT namespace_kind,namespace_id,native_name,first_observed_at,last_observed_at FROM catalog_native_model_aliases WHERE id=?'
    )
    .get(value.id) as Row | undefined
  if (
    previous &&
    (previous.namespace_kind !== value.namespaceKind ||
      previous.namespace_id !== value.namespaceId ||
      previous.native_name !== value.nativeName)
  ) {
    throw mahasError('INVALID_TRANSITION', `native alias identity ${value.id} is immutable`, 'none')
  }
  rejectDuplicateIdentity(
    db,
    'catalog_native_model_aliases',
    value.id,
    'namespace_kind=? AND namespace_id=? AND native_name=?',
    [value.namespaceKind, value.namespaceId, value.nativeName],
    `native name ${value.nativeName} in ${value.namespaceKind} ${value.namespaceId}`
  )
  const firstObservedAt = previous
    ? Math.min(Number(previous.first_observed_at), value.firstObservedAt)
    : value.firstObservedAt
  const lastObservedAt = previous
    ? Math.max(Number(previous.last_observed_at), value.lastObservedAt)
    : value.lastObservedAt
  const revision = upsert(
    db,
    'catalog_native_model_aliases',
    value.id,
    [
      'namespace_kind',
      'namespace_id',
      'native_name',
      'first_observed_at',
      'last_observed_at',
      'metadata_json'
    ],
    [
      value.namespaceKind,
      value.namespaceId,
      value.nativeName,
      firstObservedAt,
      lastObservedAt,
      JSON.stringify(value.metadata)
    ],
    expectedRevision
  )
  return { value: { ...value, firstObservedAt, lastObservedAt }, revision }
}

interface AliasInterval {
  id: string
  aliasId: string
  modelId: string
  validFrom: number
  validUntil: number | null
  revision: number
}

function aliasInterval(row: Row): AliasInterval {
  return {
    id: text(row.id),
    aliasId: text(row.alias_id),
    modelId: text(row.model_id),
    validFrom: Number(row.valid_from),
    validUntil: row.valid_until == null ? null : Number(row.valid_until),
    revision: Number(row.revision)
  }
}

function readAliasInterval(db: DatabaseSync, id: string): AliasInterval | undefined {
  const row = db
    .prepare('SELECT * FROM catalog_model_alias_resolutions WHERE id=?')
    .get(id) as Row | undefined
  return row ? aliasInterval(row) : undefined
}

function readCurrentAliasInterval(db: DatabaseSync, aliasId: string): AliasInterval | undefined {
  const row = db
    .prepare('SELECT * FROM catalog_model_alias_resolutions WHERE alias_id=? AND valid_until IS NULL')
    .get(aliasId) as Row | undefined
  return row ? aliasInterval(row) : undefined
}

/**
 * Mappings of one alias partition time, so an interval can only be extended
 * into unused range. The one tolerated overlap is the confirmed change of the
 * current mapping: that still-open row is closed at the new start, which keeps
 * every historical interval non-degenerate instead of rewriting it.
 */
function assertNoAliasOverlap(
  db: DatabaseSync,
  input: {
    id: string
    aliasId: string
    validFrom: number
    validUntil: number | null
    closingCurrentId?: string
  }
): void {
  // An open interval has no upper bound, so it is expressed as an absent
  // predicate rather than an i64 sentinel: past Number.MAX_SAFE_INTEGER a bind
  // parameter would silently lose precision.
  const bounded = input.validUntil != null
  const params: SQLInputValue[] = [input.aliasId, input.id, input.validFrom]
  if (bounded) params.push(input.validUntil as number)
  const overlapping = db
    .prepare(
      `SELECT id,valid_until FROM catalog_model_alias_resolutions
        WHERE alias_id=? AND id<>? AND (valid_until IS NULL OR valid_until > ?)
          ${bounded ? 'AND valid_from < ?' : ''}`
    )
    .all(...params) as Row[]
  for (const row of overlapping) {
    const tolerated =
      input.closingCurrentId !== undefined &&
      input.validUntil == null &&
      row.valid_until == null &&
      String(row.id) === input.closingCurrentId
    if (!tolerated) {
      throw mahasError(
        'INVALID_TRANSITION',
        `alias resolution interval overlaps ${String(row.id)}`,
        'none'
      )
    }
  }
}

/**
 * Start or amend a time-scoped mapping. A changed canonical model closes the
 * old mapping; it never rewrites old usage attribution.
 */
export function putModelAliasResolution(
  db: DatabaseSync,
  value: ModelAliasResolution,
  expectedCurrentRevision?: number
): Versioned<ModelAliasResolution> {
  validateId(value.id)
  validateTimeRange(value.validFrom, value.validUntil, 'resolution')
  if (value.validUntil != null && value.validUntil <= value.validFrom) {
    throw mahasError('MODEL_INVALID', 'resolution interval must be non-degenerate', 'none')
  }
  requireRef(db, 'catalog_native_model_aliases', value.aliasId, 'aliasId')
  requireRef(db, 'catalog_inference_models', value.modelId, 'modelId')
  const existing = readAliasInterval(db, value.id)
  if (existing) {
    if (
      existing.aliasId !== value.aliasId ||
      existing.modelId !== value.modelId ||
      existing.validFrom !== value.validFrom
    ) {
      throw mahasError('INVALID_TRANSITION', `alias resolution identity ${value.id} is immutable`, 'none')
    }
    assertExpected(existing.revision, expectedCurrentRevision, value.id)
    const storedUntil = existing.validUntil
    if (storedUntil == null) {
      if (value.validUntil != null) {
        throw mahasError(
          'INVALID_TRANSITION',
          'the current alias mapping is closed by starting the next resolution',
          'none'
        )
      }
    } else if (value.validUntil == null) {
      throw mahasError(
        'INVALID_TRANSITION',
        `closed alias mapping ${value.id} cannot be reopened`,
        'none'
      )
    } else if (value.validUntil < storedUntil) {
      throw mahasError(
        'INVALID_TRANSITION',
        `alias mapping validity cannot shrink from ${storedUntil} to ${value.validUntil}`,
        'none'
      )
    }
    assertNoAliasOverlap(db, {
      id: value.id,
      aliasId: value.aliasId,
      validFrom: value.validFrom,
      validUntil: value.validUntil ?? null
    })
    const revision = existing.revision + 1
    db.prepare(
      'UPDATE catalog_model_alias_resolutions SET valid_until=?,confidence=?,evidence_json=?,revision=? WHERE id=? AND revision=?'
    ).run(
      value.validUntil ?? null,
      value.confidence,
      JSON.stringify(value.evidence),
      revision,
      value.id,
      existing.revision
    )
    return { value: { ...value, revision }, revision }
  }

  assertExpected(undefined, expectedCurrentRevision, value.id)
  if (value.revision !== 1) {
    throw mahasError(
      'STALE_REVISION',
      `new alias resolution ${value.id} must start at revision 1`,
      'reconcile'
    )
  }
  const current = readCurrentAliasInterval(db, value.aliasId)
  // A bounded interval may be recorded into unmapped time, including time that
  // precedes the current mapping (backfill). Opening a *new current* mapping
  // is the case that has to move forward, because the open row is closed there.
  if (current && value.validUntil == null) {
    if (value.validFrom < current.validFrom) {
      throw mahasError('MODEL_INVALID', 'new alias resolution predates the current mapping', 'none')
    }
    if (value.validFrom === current.validFrom) {
      throw mahasError(
        'INVALID_TRANSITION',
        'a new alias resolution must start after the mapping it replaces',
        'none'
      )
    }
  }
  assertNoAliasOverlap(db, {
    id: value.id,
    aliasId: value.aliasId,
    validFrom: value.validFrom,
    validUntil: value.validUntil ?? null,
    closingCurrentId: value.validUntil == null ? current?.id : undefined
  })
  // Only a new current mapping closes the open one; a bounded interval leaves
  // it untouched.
  if (current && value.validUntil == null) {
    const closedRevision = current.revision + 1
    db.prepare(
      'UPDATE catalog_model_alias_resolutions SET valid_until=?,revision=? WHERE id=? AND revision=?'
    ).run(value.validFrom, closedRevision, current.id, current.revision)
  }
  db.prepare(
    'INSERT INTO catalog_model_alias_resolutions(id,alias_id,model_id,valid_from,valid_until,confidence,evidence_json,revision) VALUES(?,?,?,?,?,?,?,?)'
  ).run(
    value.id,
    value.aliasId,
    value.modelId,
    value.validFrom,
    value.validUntil ?? null,
    value.confidence,
    JSON.stringify(value.evidence),
    1
  )
  return { value: { ...value, revision: 1 }, revision: 1 }
}

export interface CatalogSnapshot {
  organizations: Versioned<Organization>[]
  harnesses: Versioned<Harness>[]
  providers: Versioned<Provider>[]
  offerings: Versioned<Offering>[]
  models: Versioned<InferenceModel>[]
  aliases: Versioned<NativeModelAlias>[]
  aliasResolutions: Versioned<ModelAliasResolution>[]
}

function rows(db: DatabaseSync, sql: string): Row[] {
  return db.prepare(sql).all() as Row[]
}

export function getCatalogSnapshot(db: DatabaseSync): CatalogSnapshot {
  return {
    organizations: rows(db, 'SELECT * FROM catalog_organizations ORDER BY id').map((r) => ({
      revision: Number(r.revision),
      value: { id: text(r.id), name: text(r.name), metadata: json(r.metadata_json, 'metadata') }
    })),
    harnesses: rows(db, 'SELECT * FROM catalog_harnesses ORDER BY id').map((r) => ({
      revision: Number(r.revision),
      value: {
        id: text(r.id),
        publisherOrganizationId: nullable(r.publisher_organization_id),
        label: text(r.label),
        identityMetadata: json(r.identity_metadata_json, 'identity metadata')
      }
    })),
    providers: rows(db, 'SELECT * FROM catalog_providers ORDER BY id').map((r) => ({
      revision: Number(r.revision),
      value: {
        id: text(r.id),
        operatorOrganizationId: nullable(r.operator_organization_id),
        label: text(r.label),
        realm: text(r.realm),
        metadata: json(r.metadata_json, 'metadata')
      }
    })),
    offerings: rows(db, 'SELECT * FROM catalog_offerings ORDER BY id').map((r) => ({
      revision: Number(r.revision),
      value: {
        id: text(r.id),
        providerId: text(r.provider_id),
        key: text(r.offering_key),
        label: text(r.label),
        metadata: json(r.metadata_json, 'metadata')
      }
    })),
    models: rows(db, 'SELECT * FROM catalog_inference_models ORDER BY id').map((r) => ({
      revision: Number(r.revision),
      value: {
        id: text(r.id),
        publisherOrganizationId: nullable(r.publisher_organization_id),
        label: text(r.label),
        version: nullable(r.model_version),
        metadata: json(r.metadata_json, 'metadata')
      }
    })),
    aliases: rows(db, 'SELECT * FROM catalog_native_model_aliases ORDER BY id').map((r) => ({
      revision: Number(r.revision),
      value: {
        id: text(r.id),
        namespaceKind: text(r.namespace_kind) as NativeModelAlias['namespaceKind'],
        namespaceId: text(r.namespace_id),
        nativeName: text(r.native_name),
        firstObservedAt: Number(r.first_observed_at),
        lastObservedAt: Number(r.last_observed_at),
        metadata: json(r.metadata_json, 'metadata')
      }
    })),
    aliasResolutions: rows(
      db,
      'SELECT * FROM catalog_model_alias_resolutions ORDER BY alias_id,valid_from,id'
    ).map((r) => ({
      revision: Number(r.revision),
      value: {
        id: text(r.id),
        aliasId: text(r.alias_id),
        modelId: text(r.model_id),
        validFrom: Number(r.valid_from),
        validUntil: r.valid_until == null ? null : Number(r.valid_until),
        confidence: text(r.confidence) as ModelAliasResolution['confidence'],
        evidence: json<readonly CatalogEvidenceRef[]>(r.evidence_json, 'evidence'),
        revision: Number(r.revision)
      }
    }))
  }
}

export function resolveCatalogRevisions(
  db: DatabaseSync,
  entityIds: readonly string[]
): Record<string, number | undefined> {
  const tables = [
    'catalog_organizations',
    'catalog_harnesses',
    'catalog_providers',
    'catalog_offerings',
    'catalog_inference_models',
    'catalog_native_model_aliases',
    'catalog_model_alias_resolutions'
  ]
  const statements: StatementSync[] = tables.map((table) =>
    db.prepare(`SELECT revision FROM ${table} WHERE id=?`)
  )
  return Object.fromEntries(
    entityIds.map((id) => {
      for (const statement of statements) {
        const row = statement.get(id) as Row | undefined
        if (row) return [id, Number(row.revision)]
      }
      return [id, undefined]
    })
  )
}

export function requireCatalogRevision(db: DatabaseSync, id: string): number {
  return revisionOf(
    [
      'catalog_organizations',
      'catalog_harnesses',
      'catalog_providers',
      'catalog_offerings',
      'catalog_inference_models',
      'catalog_native_model_aliases',
      'catalog_model_alias_resolutions'
    ]
      .map((table) => db.prepare(`SELECT revision FROM ${table} WHERE id=?`).get(id) as Row | undefined)
      .find(Boolean),
    id
  )
}
