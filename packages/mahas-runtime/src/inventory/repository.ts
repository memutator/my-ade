import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'
import type {
  HarnessInstallation,
  HarnessProviderBinding,
  InstallationRevision,
  InventoryEvidenceRef,
  Machine,
  ProviderConnection,
  ProviderCredential,
  ProviderIdentityClaim,
  QuotaPoolClaim
} from '../../../mahas-contracts/src/inventory/index.ts'
import { mahasError } from '../api/handler-ports.ts'
import type { Versioned } from '../catalog/repository.ts'

type Row = Record<string, unknown>

function fail(code: 'MODEL_INVALID' | 'STALE_REVISION' | 'INVALID_TRANSITION', message: string): never {
  throw mahasError(code, message, code === 'STALE_REVISION' ? 'reconcile' : 'none')
}

function validateId(value: string, field = 'id'): void {
  if (!value.trim()) fail('MODEL_INVALID', `${field} must be non-empty`)
}

function validateTime(at: number, field: string): void {
  if (!Number.isSafeInteger(at)) fail('MODEL_INVALID', `${field} must be integer milliseconds`)
}

function validateRange(from: number, until: number | null | undefined, field: string): void {
  validateTime(from, `${field}.from`)
  if (until != null) {
    validateTime(until, `${field}.until`)
    if (until < from) fail('MODEL_INVALID', `${field}.until precedes ${field}.from`)
  }
}

function parse<T>(raw: unknown, field: string): T {
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    throw mahasError('CONTROL_UNAVAILABLE', `stored ${field} is invalid JSON`, 'reconcile')
  }
}

function currentRevision(db: DatabaseSync, table: string, id: string): number | undefined {
  const row = db.prepare(`SELECT revision FROM ${table} WHERE id=?`).get(id) as Row | undefined
  return row ? Number(row.revision) : undefined
}

function requireRef(db: DatabaseSync, table: string, id: string, field: string): Row {
  validateId(id, field)
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Row | undefined
  if (!row) fail('MODEL_INVALID', `${field} ${id} does not exist`)
  return row
}

function requireStable(
  row: Row,
  expected: Readonly<Record<string, SQLInputValue>>,
  id: string
): void {
  for (const [column, value] of Object.entries(expected)) {
    if (row[column] !== value) fail('INVALID_TRANSITION', `${id}.${column} is immutable`)
  }
}

function assertExpected(actual: number | undefined, expected: number | undefined, id: string): void {
  if (expected === undefined) return
  if ((actual ?? 0) !== expected) {
    throw mahasError(
      'STALE_REVISION',
      `inventory object ${id} expected revision ${expected}, current revision ${actual ?? 0}`,
      'reconcile',
      { id, expectedRevision: expected, actualRevision: actual ?? 0 }
    )
  }
}

function insertOnly(
  db: DatabaseSync,
  table: string,
  id: string,
  columns: readonly string[],
  values: readonly SQLInputValue[],
  expectedRevision?: number
): number {
  validateId(id)
  const actual = currentRevision(db, table, id)
  assertExpected(actual, expectedRevision, id)
  if (actual !== undefined) fail('INVALID_TRANSITION', `${id} already exists`)
  const qs = Array(columns.length + 2).fill('?').join(',')
  db.prepare(`INSERT INTO ${table}(id,${columns.join(',')},revision) VALUES(${qs})`).run(
    id,
    ...values,
    1
  )
  return 1
}

function updateRevision(
  db: DatabaseSync,
  table: string,
  id: string,
  expectedRevision: number | undefined,
  assignments: string,
  values: readonly SQLInputValue[]
): number {
  const actual = currentRevision(db, table, id)
  if (actual === undefined) fail('MODEL_INVALID', `${id} does not exist`)
  assertExpected(actual, expectedRevision, id)
  const next = actual + 1
  const result = db
    .prepare(`UPDATE ${table} SET ${assignments},revision=? WHERE id=? AND revision=?`)
    .run(...values, next, id, actual)
  if (Number(result.changes) !== 1) fail('STALE_REVISION', `${id} changed concurrently`)
  return next
}

/**
 * Ending a connection or installation ends the bindings that were still
 * current on it. Later config evidence opens new history; it never revives a
 * closed row, and closed rows are left byte-identical.
 */
function endActiveBindings(
  db: DatabaseSync,
  scope: 'connection_id' | 'installation_id',
  key: string,
  at: number
): void {
  const bindings = db
    .prepare(
      `SELECT id,revision,observed_from FROM inventory_harness_provider_bindings WHERE ${scope}=? AND observed_until IS NULL`
    )
    .all(key) as Row[]
  for (const binding of bindings) {
    updateRevision(
      db,
      'inventory_harness_provider_bindings',
      String(binding.id),
      Number(binding.revision),
      'observed_until=?',
      [Math.max(at, Number(binding.observed_from))]
    )
  }
}

/**
 * An open-ended claim describes a live connection. Once the connection ends,
 * the claim is bounded at the same instant instead of outliving its subject.
 */
function closeOpenClaims(db: DatabaseSync, connectionId: string, at: number): void {
  for (const table of ['inventory_identity_claims', 'inventory_quota_pool_claims']) {
    const claims = db
      .prepare(`SELECT id,revision,observed_at FROM ${table} WHERE connection_id=? AND valid_until IS NULL`)
      .all(connectionId) as Row[]
    for (const claim of claims) {
      updateRevision(db, table, String(claim.id), Number(claim.revision), 'valid_until=?', [
        Math.max(at, Number(claim.observed_at))
      ])
    }
  }
}

/**
 * Confirmed end of a connection: the connection, its current bindings and its
 * open-ended claims close together. Already-closed history is never rewritten.
 */
function endConnectionHistory(db: DatabaseSync, connectionId: string, at: number): number | undefined {
  const row = db
    .prepare(
      'SELECT revision,first_seen_at,observed_until FROM inventory_provider_connections WHERE id=?'
    )
    .get(connectionId) as Row | undefined
  if (!row || row.observed_until != null) return undefined
  const closedAt = Math.max(at, Number(row.first_seen_at))
  const revision = updateRevision(
    db,
    'inventory_provider_connections',
    connectionId,
    Number(row.revision),
    'observed_until=?,availability=?',
    [closedAt, 'unavailable']
  )
  endActiveBindings(db, 'connection_id', connectionId, closedAt)
  closeOpenClaims(db, connectionId, closedAt)
  return revision
}

export function putMachine(
  db: DatabaseSync,
  value: Machine,
  expectedRevision?: number
): Versioned<Machine> {
  validateRange(value.firstSeenAt, value.lastSeenAt, 'machine observation')
  const actual = currentRevision(db, 'inventory_machines', value.id)
  assertExpected(actual, expectedRevision, value.id)
  let revision: number
  if (actual === undefined) {
    revision = insertOnly(
      db,
      'inventory_machines',
      value.id,
      ['label', 'first_seen_at', 'last_seen_at', 'metadata_json'],
      [value.label, value.firstSeenAt, value.lastSeenAt, JSON.stringify(value.metadata)],
      expectedRevision
    )
  } else {
    const old = db
      .prepare('SELECT first_seen_at,last_seen_at FROM inventory_machines WHERE id=?')
      .get(value.id) as Row
    revision = updateRevision(
      db,
      'inventory_machines',
      value.id,
      expectedRevision,
      'label=?,first_seen_at=?,last_seen_at=?,metadata_json=?',
      [
        value.label,
        Math.min(Number(old.first_seen_at), value.firstSeenAt),
        Math.max(Number(old.last_seen_at), value.lastSeenAt),
        JSON.stringify(value.metadata)
      ]
    )
  }
  return { value, revision }
}

export function putInstallation(
  db: DatabaseSync,
  value: HarnessInstallation,
  expectedRevision?: number
): Versioned<HarnessInstallation> {
  validateRange(value.firstSeenAt, value.lastSeenAt, 'installation observation')
  requireRef(db, 'inventory_machines', value.machineId, 'machineId')
  requireRef(db, 'catalog_harnesses', value.harnessId, 'harnessId')
  const actual = currentRevision(db, 'inventory_installations', value.id)
  assertExpected(actual, expectedRevision, value.id)
  let revision: number
  if (actual === undefined) {
    revision = insertOnly(
      db,
      'inventory_installations',
      value.id,
      [
        'machine_id',
        'harness_id',
        'executable_locator',
        'config_namespace',
        'data_namespace',
        'first_seen_at',
        'last_seen_at',
        'presence',
        'origin'
      ],
      [
        value.machineId,
        value.harnessId,
        value.executableLocator ?? null,
        value.configNamespace,
        value.dataNamespace,
        value.firstSeenAt,
        value.lastSeenAt,
        value.presence,
        value.origin
      ],
      expectedRevision
    )
  } else {
    const old = db
      .prepare('SELECT * FROM inventory_installations WHERE id=?')
      .get(value.id) as Row
    requireStable(
      old,
      {
        machine_id: value.machineId,
        harness_id: value.harnessId,
        config_namespace: value.configNamespace,
        data_namespace: value.dataNamespace
      },
      value.id
    )
    revision = updateRevision(
      db,
      'inventory_installations',
      value.id,
      expectedRevision,
      'machine_id=?,harness_id=?,executable_locator=?,config_namespace=?,data_namespace=?,first_seen_at=?,last_seen_at=?,presence=?,origin=?',
      [
        value.machineId,
        value.harnessId,
        value.executableLocator ?? null,
        value.configNamespace,
        value.dataNamespace,
        Math.min(Number(old.first_seen_at), value.firstSeenAt),
        Math.max(Number(old.last_seen_at), value.lastSeenAt),
        value.presence,
        value.origin
      ]
    )
  }
  return { value, revision }
}

export function appendInstallationRevision(db: DatabaseSync, value: InstallationRevision): void {
  validateId(value.id)
  validateTime(value.observedAt, 'observedAt')
  requireRef(db, 'inventory_installations', value.installationId, 'installationId')
  const last = db
    .prepare(
      'SELECT MAX(installation_revision) AS revision FROM inventory_installation_revisions WHERE installation_id=?'
    )
    .get(value.installationId) as Row
  const expected = Number(last.revision ?? 0) + 1
  if (value.revision !== expected) {
    fail(
      'STALE_REVISION',
      `installation ${value.installationId} next revision is ${expected}, got ${value.revision}`
    )
  }
  db.prepare(
    'INSERT INTO inventory_installation_revisions(id,installation_id,installation_revision,executable_identity_json,version,config_structure_digest,observed_at,evidence_json) VALUES(?,?,?,?,?,?,?,?)'
  ).run(
    value.id,
    value.installationId,
    value.revision,
    JSON.stringify(value.executableIdentity),
    value.version ?? null,
    value.configStructureDigest ?? null,
    value.observedAt,
    JSON.stringify(value.evidence)
  )
}

export function registerCredential(
  db: DatabaseSync,
  value: ProviderCredential,
  expectedRevision?: number
): Versioned<ProviderCredential> {
  validateRange(value.firstSeenAt, value.lastSeenAt, 'credential observation')
  if (!value.materialRef.trim()) fail('MODEL_INVALID', 'materialRef must be a non-secret locator')
  if (!Number.isSafeInteger(value.materialRevision) || value.materialRevision < 1) {
    fail('MODEL_INVALID', 'materialRevision must be a positive integer')
  }
  requireRef(db, 'inventory_machines', value.machineId, 'machineId')
  const revision = insertOnly(
    db,
    'inventory_provider_credentials',
    value.id,
    [
      'machine_id',
      'material_ref',
      'material_revision',
      'ownership',
      'availability',
      'first_seen_at',
      'last_seen_at',
      'observed_until',
      'replaced_by_credential_id'
    ],
    [
      value.machineId,
      value.materialRef,
      value.materialRevision,
      value.ownership,
      value.availability,
      value.firstSeenAt,
      value.lastSeenAt,
      null,
      null
    ],
    expectedRevision
  )
  return { value, revision }
}

/** A token refresh is accepted only with affirmative same-account evidence. */
export function refreshCredential(
  db: DatabaseSync,
  input: {
    credentialId: string
    expectedRevision?: number
    expectedMaterialRevision: number
    nextMaterialRevision: number
    observedAt: number
    accountContinuity: 'confirmed-same'
    availability?: ProviderCredential['availability']
  }
): number {
  validateTime(input.observedAt, 'observedAt')
  if (input.nextMaterialRevision <= input.expectedMaterialRevision) {
    fail('MODEL_INVALID', 'nextMaterialRevision must advance')
  }
  const row = db
    .prepare(
      'SELECT material_revision,observed_until,last_seen_at,availability FROM inventory_provider_credentials WHERE id=?'
    )
    .get(input.credentialId) as Row | undefined
  if (!row) fail('MODEL_INVALID', `credential ${input.credentialId} does not exist`)
  if (row.observed_until != null) fail('INVALID_TRANSITION', 'cannot refresh a replaced credential')
  if (Number(row.material_revision) !== input.expectedMaterialRevision) {
    fail('STALE_REVISION', 'credential material revision changed')
  }
  if (input.observedAt < Number(row.last_seen_at)) {
    fail('MODEL_INVALID', 'refresh observation predates the credential state')
  }
  // A refresh proves new material, not new availability: keep the last known
  // availability unless the caller observed a change.
  const availability =
    input.availability ?? (String(row.availability) as ProviderCredential['availability'])
  return updateRevision(
    db,
    'inventory_provider_credentials',
    input.credentialId,
    input.expectedRevision,
    'material_revision=?,last_seen_at=?,availability=?',
    [input.nextMaterialRevision, input.observedAt, availability]
  )
}

/**
 * Account replacement splits history. Active connections/bindings are ended;
 * the caller may register fresh connections against the returned credential.
 */
export function replaceCredential(
  db: DatabaseSync,
  input: {
    oldCredentialId: string
    oldExpectedRevision?: number
    replacement: ProviderCredential
    replacedAt: number
  }
): { oldRevision: number; replacement: Versioned<ProviderCredential> } {
  validateTime(input.replacedAt, 'replacedAt')
  if (input.oldCredentialId === input.replacement.id) {
    fail('INVALID_TRANSITION', 'account replacement requires a new credential id')
  }
  const old = db
    .prepare(
      'SELECT first_seen_at,last_seen_at,observed_until,machine_id,revision FROM inventory_provider_credentials WHERE id=?'
    )
    .get(input.oldCredentialId) as Row | undefined
  if (!old) fail('MODEL_INVALID', `credential ${input.oldCredentialId} does not exist`)
  if (old.observed_until != null) fail('INVALID_TRANSITION', 'credential was already replaced')
  assertExpected(Number(old.revision), input.oldExpectedRevision, input.oldCredentialId)
  if (input.replacedAt < Number(old.first_seen_at)) fail('MODEL_INVALID', 'replacement predates credential')
  if (input.replacement.machineId !== old.machine_id) {
    fail('INVALID_TRANSITION', 'account replacement must preserve the credential machine identity')
  }
  if (input.replacement.firstSeenAt !== input.replacedAt) {
    fail('MODEL_INVALID', 'replacement.firstSeenAt must equal replacedAt')
  }
  if (currentRevision(db, 'inventory_provider_credentials', input.replacement.id) !== undefined) {
    fail('INVALID_TRANSITION', `replacement credential ${input.replacement.id} already exists`)
  }
  const replacement = registerCredential(db, input.replacement, 0)
  const oldRevision = updateRevision(
    db,
    'inventory_provider_credentials',
    input.oldCredentialId,
    input.oldExpectedRevision,
    'availability=?,observed_until=?,last_seen_at=?,replaced_by_credential_id=?',
    [
      'unavailable',
      input.replacedAt,
      Math.max(Number(old.last_seen_at), input.replacedAt),
      input.replacement.id
    ]
  )
  const connections = db
    .prepare('SELECT id FROM inventory_provider_connections WHERE credential_id=? AND observed_until IS NULL')
    .all(input.oldCredentialId) as Row[]
  for (const connection of connections) {
    endConnectionHistory(db, String(connection.id), input.replacedAt)
  }
  return { oldRevision, replacement }
}

export function putProviderConnection(
  db: DatabaseSync,
  value: ProviderConnection,
  expectedRevision?: number
): Versioned<ProviderConnection> {
  validateRange(value.firstSeenAt, value.observedUntil, 'connection observation')
  requireRef(db, 'catalog_offerings', value.offeringId, 'offeringId')
  const credential = requireRef(
    db,
    'inventory_provider_credentials',
    value.credentialId,
    'credentialId'
  )
  const actual = currentRevision(db, 'inventory_provider_connections', value.id)
  let revision: number
  const columns = [
    'offering_id',
    'credential_id',
    'auth_scope_json',
    'first_seen_at',
    'observed_until',
    'availability',
    'origin'
  ]
  const values = [
    value.offeringId,
    value.credentialId,
    value.authScope == null ? null : JSON.stringify(value.authScope),
    value.firstSeenAt,
    value.observedUntil ?? null,
    value.availability,
    value.origin
  ]
  if (actual === undefined) {
    if (credential.observed_until != null) {
      fail(
        'INVALID_TRANSITION',
        `credential ${value.credentialId} was replaced; connect to its replacement instead`
      )
    }
    revision = insertOnly(
      db,
      'inventory_provider_connections',
      value.id,
      columns,
      values,
      expectedRevision
    )
  } else {
    const existing = requireRef(db, 'inventory_provider_connections', value.id, 'connectionId')
    requireStable(
      existing,
      { offering_id: value.offeringId, credential_id: value.credentialId, first_seen_at: value.firstSeenAt },
      value.id
    )
    const storedUntil = existing.observed_until == null ? null : Number(existing.observed_until)
    if (storedUntil != null) {
      if (value.observedUntil == null) {
        fail('INVALID_TRANSITION', `connection ${value.id} is closed and cannot be reopened`)
      }
      if (value.observedUntil < storedUntil) {
        fail(
          'INVALID_TRANSITION',
          `connection ${value.id} validity cannot shrink from ${storedUntil} to ${value.observedUntil}`
        )
      }
    }
    revision = updateRevision(
      db,
      'inventory_provider_connections',
      value.id,
      expectedRevision,
      columns.map((column) => `${column}=?`).join(','),
      values
    )
  }
  return { value, revision }
}

function putClaim<T extends ProviderIdentityClaim | QuotaPoolClaim>(
  db: DatabaseSync,
  table: string,
  value: T,
  expectedRevision: number | undefined,
  columns: readonly string[],
  values: readonly SQLInputValue[]
): Versioned<T> {
  validateRange(value.observedAt, value.validUntil, 'claim')
  const actual = currentRevision(db, table, value.id)
  let revision: number
  if (actual === undefined) {
    revision = insertOnly(db, table, value.id, columns, values, expectedRevision)
  } else {
    const existing = requireRef(db, table, value.id, 'claimId')
    requireStable(existing, { connection_id: value.connectionId, observed_at: value.observedAt }, value.id)
    const storedUntil = existing.valid_until == null ? null : Number(existing.valid_until)
    if (storedUntil != null) {
      if (value.validUntil == null) {
        fail('INVALID_TRANSITION', `claim ${value.id} is closed and cannot be reopened`)
      }
      if (value.validUntil < storedUntil) {
        fail(
          'INVALID_TRANSITION',
          `claim ${value.id} validity cannot shrink from ${storedUntil} to ${value.validUntil}`
        )
      }
    }
    revision = updateRevision(
      db,
      table,
      value.id,
      expectedRevision,
      columns.map((column) => `${column}=?`).join(','),
      values
    )
  }
  return { value, revision }
}

export function putIdentityClaim(
  db: DatabaseSync,
  value: ProviderIdentityClaim,
  expectedRevision?: number
): Versioned<ProviderIdentityClaim> {
  requireRef(db, 'inventory_provider_connections', value.connectionId, 'connectionId')
  return putClaim(
    db,
    'inventory_identity_claims',
    value,
    expectedRevision,
    [
      'connection_id',
      'kind',
      'claim_value',
      'observed_at',
      'valid_until',
      'confidence',
      'evidence_json'
    ],
    [
      value.connectionId,
      value.kind,
      value.value,
      value.observedAt,
      value.validUntil ?? null,
      value.confidence,
      JSON.stringify(value.evidence)
    ]
  )
}

export function putQuotaPoolClaim(
  db: DatabaseSync,
  value: QuotaPoolClaim,
  expectedRevision?: number
): Versioned<QuotaPoolClaim> {
  requireRef(db, 'inventory_provider_connections', value.connectionId, 'connectionId')
  return putClaim(
    db,
    'inventory_quota_pool_claims',
    value,
    expectedRevision,
    [
      'connection_id',
      'provider_pool_key',
      'scope',
      'observed_at',
      'valid_until',
      'evidence_json'
    ],
    [
      value.connectionId,
      value.providerPoolKey,
      value.scope,
      value.observedAt,
      value.validUntil ?? null,
      JSON.stringify(value.evidence)
    ]
  )
}

export function putBinding(
  db: DatabaseSync,
  value: HarnessProviderBinding,
  expectedRevision?: number
): Versioned<HarnessProviderBinding> {
  validateRange(value.observedFrom, value.observedUntil, 'binding observation')
  requireRef(db, 'inventory_installations', value.installationId, 'installationId')
  const connection = requireRef(
    db,
    'inventory_provider_connections',
    value.connectionId,
    'connectionId'
  )
  const actual = currentRevision(db, 'inventory_harness_provider_bindings', value.id)
  const columns = [
    'installation_id',
    'connection_id',
    'config_slot',
    'selector_json',
    'origin',
    'observed_from',
    'observed_until',
    'evidence_json'
  ]
  const values = [
    value.installationId,
    value.connectionId,
    value.configSlot,
    value.selector == null ? null : JSON.stringify(value.selector),
    value.origin,
    value.observedFrom,
    value.observedUntil ?? null,
    JSON.stringify(value.evidence)
  ]
  let revision: number
  if (actual === undefined) {
    if (value.revision !== 1) fail('STALE_REVISION', 'new binding revision must be 1')
    if (value.observedUntil == null && connection.observed_until != null) {
      fail(
        'INVALID_TRANSITION',
        `binding cannot be current for closed connection ${value.connectionId}`
      )
    }
    const duplicate = db
      .prepare(
        'SELECT id FROM inventory_harness_provider_bindings WHERE installation_id=? AND config_slot=? AND connection_id=? AND observed_until IS NULL AND id<>?'
      )
      .get(value.installationId, value.configSlot, value.connectionId, value.id) as
      | Row
      | undefined
    if (duplicate) {
      fail(
        'INVALID_TRANSITION',
        `current binding ${String(duplicate.id)} already covers ${value.configSlot}`
      )
    }
    revision = insertOnly(
      db,
      'inventory_harness_provider_bindings',
      value.id,
      columns,
      values,
      expectedRevision
    )
  } else {
    const existing = requireRef(db, 'inventory_harness_provider_bindings', value.id, 'bindingId')
    requireStable(
      existing,
      {
        installation_id: value.installationId,
        connection_id: value.connectionId,
        config_slot: value.configSlot,
        selector_json: value.selector == null ? null : JSON.stringify(value.selector),
        origin: value.origin,
        observed_from: value.observedFrom
      },
      value.id
    )
    const storedUntil = existing.observed_until == null ? null : Number(existing.observed_until)
    if (storedUntil != null) {
      if (value.observedUntil == null) {
        fail('INVALID_TRANSITION', `binding ${value.id} is closed and cannot be reopened`)
      }
      if (value.observedUntil < storedUntil) {
        fail(
          'INVALID_TRANSITION',
          `binding ${value.id} validity cannot shrink from ${storedUntil} to ${value.observedUntil}`
        )
      }
    }
    revision = updateRevision(
      db,
      'inventory_harness_provider_bindings',
      value.id,
      expectedRevision,
      columns.map((column) => `${column}=?`).join(','),
      values
    )
  }
  return { value: { ...value, revision }, revision }
}

export type InventoryObservationOutcome = 'observed' | 'missing' | 'removed' | 'failed'

/**
 * Records scan honesty. `missing` and `failed` never close or delete state;
 * only an explicit `removed` observation changes presence/availability/history.
 */
export function recordInventoryObservation(
  db: DatabaseSync,
  input: {
    id: string
    subjectKind: 'installation' | 'credential' | 'connection' | 'binding' | string
    subjectId?: string
    outcome: InventoryObservationOutcome
    observedAt: number
    sourceRef?: string
    evidence?: readonly InventoryEvidenceRef[]
  }
): void {
  validateId(input.id)
  validateTime(input.observedAt, 'observedAt')
  db.prepare(
    'INSERT INTO inventory_observations(id,subject_kind,subject_id,outcome,observed_at,source_ref,evidence_json) VALUES(?,?,?,?,?,?,?)'
  ).run(
    input.id,
    input.subjectKind,
    input.subjectId ?? null,
    input.outcome,
    input.observedAt,
    input.sourceRef ?? null,
    JSON.stringify(input.evidence ?? [])
  )
  if (input.outcome !== 'removed' || !input.subjectId) return
  const id = input.subjectId
  if (input.subjectKind === 'installation') {
    const row = db
      .prepare('SELECT revision,presence,last_seen_at,first_seen_at FROM inventory_installations WHERE id=?')
      .get(id) as Row | undefined
    if (row && row.presence !== 'absent') {
      const at = Math.max(input.observedAt, Number(row.first_seen_at))
      updateRevision(
        db,
        'inventory_installations',
        id,
        Number(row.revision),
        'presence=?,last_seen_at=?',
        ['absent', Math.max(Number(row.last_seen_at), at)]
      )
      endActiveBindings(db, 'installation_id', id, at)
    }
  } else if (input.subjectKind === 'credential') {
    const row = db
      .prepare(
        'SELECT revision,availability,last_seen_at,first_seen_at FROM inventory_provider_credentials WHERE id=?'
      )
      .get(id) as Row | undefined
    if (row && row.availability !== 'unavailable')
      updateRevision(
        db,
        'inventory_provider_credentials',
        id,
        Number(row.revision),
        'availability=?,last_seen_at=?',
        [
          'unavailable',
          Math.max(Number(row.last_seen_at), input.observedAt, Number(row.first_seen_at))
        ]
      )
  } else if (input.subjectKind === 'connection') {
    // A removed connection ends its current bindings and open-ended claims:
    // config evidence that outlives its subject would be a false current fact.
    endConnectionHistory(db, id, input.observedAt)
  } else if (input.subjectKind === 'binding') {
    const row = db
      .prepare(
        'SELECT revision,observed_from,observed_until FROM inventory_harness_provider_bindings WHERE id=?'
      )
      .get(id) as Row | undefined
    if (row && row.observed_until == null)
      updateRevision(
        db,
        'inventory_harness_provider_bindings',
        id,
        Number(row.revision),
        'observed_until=?',
        [Math.max(input.observedAt, Number(row.observed_from))]
      )
  }
}

export interface InventorySnapshot {
  machines: Versioned<Machine>[]
  installations: Versioned<HarnessInstallation>[]
  installationRevisions: InstallationRevision[]
  credentials: Versioned<ProviderCredential>[]
  connections: Versioned<ProviderConnection>[]
  identityClaims: Versioned<ProviderIdentityClaim>[]
  quotaPoolClaims: Versioned<QuotaPoolClaim>[]
  bindings: Versioned<HarnessProviderBinding>[]
}

function all(db: DatabaseSync, sql: string): Row[] {
  return db.prepare(sql).all() as Row[]
}

function nullableText(raw: unknown): string | null {
  return raw == null ? null : String(raw)
}

export function getInventorySnapshot(db: DatabaseSync): InventorySnapshot {
  return {
    machines: all(db, 'SELECT * FROM inventory_machines ORDER BY id').map((r) => ({
      revision: Number(r.revision),
      value: {
        id: String(r.id),
        label: String(r.label),
        firstSeenAt: Number(r.first_seen_at),
        lastSeenAt: Number(r.last_seen_at),
        metadata: parse(r.metadata_json, 'machine metadata')
      }
    })),
    installations: all(db, 'SELECT * FROM inventory_installations ORDER BY id').map((r) => ({
      revision: Number(r.revision),
      value: {
        id: String(r.id),
        machineId: String(r.machine_id),
        harnessId: String(r.harness_id),
        executableLocator: nullableText(r.executable_locator),
        configNamespace: String(r.config_namespace),
        dataNamespace: String(r.data_namespace),
        firstSeenAt: Number(r.first_seen_at),
        lastSeenAt: Number(r.last_seen_at),
        presence: String(r.presence) as HarnessInstallation['presence'],
        origin: String(r.origin) as HarnessInstallation['origin']
      }
    })),
    installationRevisions: all(
      db,
      'SELECT * FROM inventory_installation_revisions ORDER BY installation_id,installation_revision'
    ).map((r) => ({
      id: String(r.id),
      installationId: String(r.installation_id),
      revision: Number(r.installation_revision),
      executableIdentity: parse(r.executable_identity_json, 'executable identity'),
      version: nullableText(r.version),
      configStructureDigest: nullableText(r.config_structure_digest),
      observedAt: Number(r.observed_at),
      evidence: parse(r.evidence_json, 'installation evidence')
    })),
    credentials: all(db, 'SELECT * FROM inventory_provider_credentials ORDER BY id').map((r) => ({
      revision: Number(r.revision),
      value: {
        id: String(r.id),
        machineId: String(r.machine_id),
        materialRef: String(r.material_ref),
        materialRevision: Number(r.material_revision),
        ownership: String(r.ownership) as ProviderCredential['ownership'],
        availability: String(r.availability) as ProviderCredential['availability'],
        firstSeenAt: Number(r.first_seen_at),
        lastSeenAt: Number(r.last_seen_at)
      }
    })),
    connections: all(db, 'SELECT * FROM inventory_provider_connections ORDER BY id').map((r) => ({
      revision: Number(r.revision),
      value: {
        id: String(r.id),
        offeringId: String(r.offering_id),
        credentialId: String(r.credential_id),
        authScope: r.auth_scope_json == null ? null : parse(r.auth_scope_json, 'auth scope'),
        firstSeenAt: Number(r.first_seen_at),
        observedUntil: r.observed_until == null ? null : Number(r.observed_until),
        availability: String(r.availability) as ProviderConnection['availability'],
        origin: String(r.origin) as ProviderConnection['origin']
      }
    })),
    identityClaims: all(db, 'SELECT * FROM inventory_identity_claims ORDER BY id').map((r) => ({
      revision: Number(r.revision),
      value: {
        id: String(r.id),
        connectionId: String(r.connection_id),
        kind: String(r.kind),
        value: String(r.claim_value),
        observedAt: Number(r.observed_at),
        validUntil: r.valid_until == null ? null : Number(r.valid_until),
        confidence: String(r.confidence) as ProviderIdentityClaim['confidence'],
        evidence: parse(r.evidence_json, 'identity evidence')
      }
    })),
    quotaPoolClaims: all(db, 'SELECT * FROM inventory_quota_pool_claims ORDER BY id').map((r) => ({
      revision: Number(r.revision),
      value: {
        id: String(r.id),
        connectionId: String(r.connection_id),
        providerPoolKey: String(r.provider_pool_key),
        scope: String(r.scope),
        observedAt: Number(r.observed_at),
        validUntil: r.valid_until == null ? null : Number(r.valid_until),
        evidence: parse(r.evidence_json, 'pool evidence')
      }
    })),
    bindings: all(
      db,
      'SELECT * FROM inventory_harness_provider_bindings ORDER BY installation_id,observed_from,id'
    ).map((r) => ({
      revision: Number(r.revision),
      value: {
        id: String(r.id),
        installationId: String(r.installation_id),
        connectionId: String(r.connection_id),
        configSlot: String(r.config_slot),
        selector: r.selector_json == null ? null : parse(r.selector_json, 'binding selector'),
        origin: String(r.origin) as HarnessProviderBinding['origin'],
        observedFrom: Number(r.observed_from),
        observedUntil: r.observed_until == null ? null : Number(r.observed_until),
        evidence: parse(r.evidence_json, 'binding evidence'),
        revision: Number(r.revision)
      }
    }))
  }
}

export function resolveInventoryRevisions(
  db: DatabaseSync,
  entityIds: readonly string[]
): Record<string, number | undefined> {
  const tables = [
    'inventory_machines',
    'inventory_installations',
    'inventory_provider_credentials',
    'inventory_provider_connections',
    'inventory_identity_claims',
    'inventory_quota_pool_claims',
    'inventory_harness_provider_bindings'
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
