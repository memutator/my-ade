// inventory/repository.smoke.ts — inventory persistence, credential CAS,
// reference and lifecycle fixtures.
//
// Run:  node packages/mahas-runtime/src/inventory/repository.smoke.ts
//
// Synthetic-only: SQLite control DBs (in-memory plus one temp file), an
// in-memory LocalMachineIo instead of the host config directory, no real
// credential material and no provider access.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  HarnessProviderBinding,
  InstallationRevision,
  ProviderConnection,
  ProviderCredential
} from '../../../mahas-contracts/src/inventory/index.ts'
import { CATALOG_SCHEMA_SQL } from '../catalog/migration.ts'
import { seedBuiltinCatalog } from '../catalog/seed.ts'
import { ensureHarnessInstallation, ensureLocalMachine, LOCAL_MACHINE_ID_FILENAME } from './local.ts'
import type { LocalMachineIo } from './local.ts'
import { INVENTORY_SCHEMA_SQL } from './migration.ts'
import {
  appendInstallationRevision,
  getInventorySnapshot,
  putBinding,
  putIdentityClaim,
  putProviderConnection,
  putQuotaPoolClaim,
  recordInventoryObservation,
  refreshCredential,
  registerCredential,
  replaceCredential,
  resolveInventoryRevisions,
  type InventorySnapshot
} from './repository.ts'

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON;')
  db.exec(CATALOG_SCHEMA_SQL)
  db.exec(INVENTORY_SCHEMA_SQL)
  seedBuiltinCatalog(db)
  return db
}

/** Runs `body`, asserting it fails with the given MahasError code. */
function failsWith(code: string, body: () => unknown): void {
  let thrown: unknown
  try {
    body()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== undefined, `expected ${code}, but the call succeeded`)
  assert.equal((thrown as { code?: string }).code, code)
}

function namedError(code: string): Error {
  const error = new Error(code) as NodeJS.ErrnoException
  error.code = code
  return error
}

/** Config-directory double: no host file is read or written. */
function memoryIo(initial: Record<string, string> = {}): {
  files: Map<string, string>
  io: LocalMachineIo
} {
  const files = new Map(Object.entries(initial))
  return {
    files,
    io: {
      readText: (path) => {
        const value = files.get(path)
        if (value === undefined) throw namedError('ENOENT')
        return value
      },
      writeNewText: (path, value) => {
        if (files.has(path)) throw namedError('EEXIST')
        files.set(path, value)
      },
      ensureDir: () => {},
      randomId: () => 'fixture-uuid',
      hostname: () => 'fixture-host'
    }
  }
}

function credentialOf(snapshot: InventorySnapshot, id: string): ProviderCredential | undefined {
  return snapshot.credentials.find((row) => row.value.id === id)?.value
}

function connectionOf(snapshot: InventorySnapshot, id: string): ProviderConnection | undefined {
  return snapshot.connections.find((row) => row.value.id === id)?.value
}

function bindingOf(snapshot: InventorySnapshot, id: string): HarnessProviderBinding | undefined {
  return snapshot.bindings.find((row) => row.value.id === id)?.value
}

const db = openDb()

// ── local machine identity comes from the config directory, once ───────────

const machineDir = '/fixture/config'
const machineIo = memoryIo()
const machine = ensureLocalMachine(db, { configDir: machineDir, observedAt: 1_000, io: machineIo.io })
assert.equal(machine.value.id, 'machine.fixture-uuid')
assert.equal(machine.value.label, 'fixture-host')
assert.equal(machine.value.metadata.configDir, machineDir)
assert.equal(machineIo.files.get(join(machineDir, LOCAL_MACHINE_ID_FILENAME)), 'machine.fixture-uuid\n')
const machineAgain = ensureLocalMachine(db, {
  configDir: machineDir,
  observedAt: 1_050,
  io: machineIo.io
})
assert.equal(machineAgain.value.id, machine.value.id)
assert.equal(machineAgain.revision, 2)
// An unreadable identity is reported, never silently regenerated.
failsWith('CONTROL_UNAVAILABLE', () =>
  ensureLocalMachine(db, {
    configDir: '/fixture/empty',
    observedAt: 1_000,
    io: memoryIo({ '/fixture/empty/machine-id': '   \n' }).io
  })
)
const machineId = machine.value.id

// ── installations: discovery output only, identity is stable ──────────────

const codex = ensureHarnessInstallation(db, {
  machineId,
  harnessId: 'codex',
  configNamespace: 'config/codex',
  dataNamespace: 'data/codex',
  observedAt: 1_100,
  origin: 'discovered'
})
assert.equal(codex.revision, 1)
const codexAgain = ensureHarnessInstallation(db, {
  machineId,
  harnessId: 'codex',
  configNamespace: 'config/codex',
  dataNamespace: 'data/codex',
  observedAt: 1_200,
  presence: 'present',
  origin: 'discovered'
})
assert.equal(codexAgain.value.id, codex.value.id)
assert.equal(codexAgain.revision, 2)
failsWith('MODEL_INVALID', () =>
  ensureHarnessInstallation(db, {
    machineId: 'machine.missing',
    harnessId: 'codex',
    configNamespace: 'config/codex',
    dataNamespace: 'data/codex',
    observedAt: 1_100,
    origin: 'discovered'
  })
)
failsWith('MODEL_INVALID', () =>
  ensureHarnessInstallation(db, {
    machineId,
    harnessId: 'harness.missing',
    configNamespace: 'config/other',
    dataNamespace: 'data/other',
    observedAt: 1_100,
    origin: 'discovered'
  })
)
const claude = ensureHarnessInstallation(db, {
  machineId,
  harnessId: 'claude',
  configNamespace: 'config/claude',
  dataNamespace: 'data/claude',
  observedAt: 1_150,
  origin: 'discovered'
})

// Installation revisions are append-only evidence, never renumbered.
const revision: InstallationRevision = {
  id: 'installation-revision.1',
  installationId: codex.value.id,
  revision: 1,
  executableIdentity: { path: '/fixture/bin/codex', size: 1 },
  version: '0.0.0-fixture',
  configStructureDigest: 'digest-fixture',
  observedAt: 1_300,
  evidence: [{ description: 'fixture' }]
}
appendInstallationRevision(db, revision)
failsWith('STALE_REVISION', () =>
  appendInstallationRevision(db, { ...revision, id: 'installation-revision.1-copy' })
)
failsWith('STALE_REVISION', () =>
  appendInstallationRevision(db, { ...revision, id: 'installation-revision.gap', revision: 3 })
)
failsWith('MODEL_INVALID', () =>
  appendInstallationRevision(db, { ...revision, id: 'installation-revision.orphan', revision: 2, installationId: 'installation.missing' })
)
const revisionAfterAppend = getInventorySnapshot(db).installationRevisions
assert.deepEqual(
  revisionAfterAppend.map((row) => [row.installationId, row.revision]),
  [[codex.value.id, 1]]
)

// ── credentials: locators only, inserted once ──────────────────────────────

const oldCredential: ProviderCredential = {
  id: 'credential.old',
  machineId,
  materialRef: '/fixture/config/auth.json',
  materialRevision: 3,
  ownership: 'user',
  availability: 'available',
  firstSeenAt: 1_400,
  lastSeenAt: 1_400
}
assert.equal(registerCredential(db, oldCredential).revision, 1)
failsWith('INVALID_TRANSITION', () => registerCredential(db, oldCredential))
failsWith('MODEL_INVALID', () =>
  registerCredential(db, { ...oldCredential, id: 'credential.zero', materialRevision: 0 })
)
failsWith('MODEL_INVALID', () =>
  registerCredential(db, { ...oldCredential, id: 'credential.blank', materialRef: '   ' })
)
failsWith('MODEL_INVALID', () =>
  registerCredential(db, { ...oldCredential, id: 'credential.orphan', machineId: 'machine.missing' })
)

// ── credentials: refresh is a serialized material CAS ──────────────────────

const refreshable: ProviderCredential = {
  id: 'credential.refreshable',
  machineId,
  materialRef: '/fixture/config/refresh.json',
  materialRevision: 1,
  ownership: 'user',
  availability: 'unknown',
  firstSeenAt: 2_000,
  lastSeenAt: 2_000
}
registerCredential(db, refreshable)
type RefreshInput = Parameters<typeof refreshCredential>[1]
const refresh = (over: Partial<RefreshInput> = {}): RefreshInput => ({
  credentialId: refreshable.id,
  expectedMaterialRevision: 1,
  nextMaterialRevision: 2,
  observedAt: 2_100,
  accountContinuity: 'confirmed-same',
  ...over
})
failsWith('MODEL_INVALID', () => refreshCredential(db, refresh({ nextMaterialRevision: 1 })))
failsWith('MODEL_INVALID', () => refreshCredential(db, refresh({ observedAt: 1_900 })))
failsWith('STALE_REVISION', () =>
  refreshCredential(db, refresh({ expectedMaterialRevision: 9, nextMaterialRevision: 10 }))
)
failsWith('STALE_REVISION', () => refreshCredential(db, refresh({ expectedRevision: 9 })))
assert.equal(refreshCredential(db, refresh()), 2)
const refreshed = credentialOf(getInventorySnapshot(db), refreshable.id)
// A refresh proves new material, not new availability.
assert.equal(refreshed?.materialRevision, 2)
assert.equal(refreshed?.availability, 'unknown')
assert.equal(refreshed?.lastSeenAt, 2_100)

// ── connections and bindings: references and closed history ───────────────

const oldConnection: ProviderConnection = {
  id: 'connection.old-chatgpt',
  offeringId: 'openai/chatgpt',
  credentialId: oldCredential.id,
  authScope: ['openai'],
  firstSeenAt: 1_500,
  observedUntil: null,
  availability: 'available',
  origin: 'discovered'
}
assert.equal(putProviderConnection(db, oldConnection).revision, 1)
failsWith('MODEL_INVALID', () =>
  putProviderConnection(db, { ...oldConnection, id: 'connection.orphan-offering', offeringId: 'openai/missing' })
)
failsWith('MODEL_INVALID', () =>
  putProviderConnection(db, { ...oldConnection, id: 'connection.orphan-credential', credentialId: 'credential.missing' })
)
putProviderConnection(db, {
  ...oldConnection,
  id: 'connection.old-claude',
  offeringId: 'anthropic/claude',
  observedUntil: 1_600,
  availability: 'unavailable'
})
failsWith('INVALID_TRANSITION', () =>
  putProviderConnection(db, { ...oldConnection, id: 'connection.old-claude', observedUntil: null })
)
failsWith('INVALID_TRANSITION', () =>
  putProviderConnection(db, { ...oldConnection, id: 'connection.old-claude', observedUntil: 1_550 })
)

const binding = (
  over: Partial<HarnessProviderBinding> = {}
): HarnessProviderBinding => ({
  id: 'binding.old-current',
  installationId: codex.value.id,
  connectionId: oldConnection.id,
  configSlot: 'default',
  selector: { model: 'gpt-5-fixture' },
  origin: 'discovered',
  observedFrom: 1_520,
  observedUntil: null,
  evidence: [],
  revision: 1,
  ...over
})
assert.equal(putBinding(db, binding()).revision, 1)
putBinding(db, binding({ id: 'binding.old-historical', configSlot: 'model:gpt-5-fixture', observedFrom: 1_510, observedUntil: 1_540 }))
failsWith('MODEL_INVALID', () => putBinding(db, binding({ id: 'binding.orphan-installation', installationId: 'installation.missing' })))
failsWith('MODEL_INVALID', () => putBinding(db, binding({ id: 'binding.orphan-connection', connectionId: 'connection.missing' })))
failsWith('STALE_REVISION', () => putBinding(db, binding({ id: 'binding.bad-revision', revision: 2 })))
failsWith('INVALID_TRANSITION', () =>
  putBinding(db, binding({ id: 'binding.duplicate-current', configSlot: 'default' }))
)
failsWith('INVALID_TRANSITION', () =>
  putBinding(db, binding({ id: 'binding.on-closed', connectionId: 'connection.old-claude' }))
)
assert.equal(
  putBinding(
    db,
    binding({
      id: 'binding.on-closed-historical',
      connectionId: 'connection.old-claude',
      configSlot: 'provider:claude',
      observedFrom: 1_520,
      observedUntil: 1_700
    })
  ).revision,
  1
)
const extendedBinding = putBinding(
  db,
  binding({
    id: 'binding.old-historical',
    configSlot: 'model:gpt-5-fixture',
    observedFrom: 1_510,
    observedUntil: 1_600
  })
)
assert.equal(extendedBinding.revision, 2)
failsWith('INVALID_TRANSITION', () =>
  putBinding(
    db,
    binding({
      id: 'binding.old-historical',
      configSlot: 'model:gpt-5-fixture',
      observedFrom: 1_510,
      observedUntil: 1_530
    })
  )
)
failsWith('INVALID_TRANSITION', () =>
  putBinding(
    db,
    binding({
      id: 'binding.old-historical',
      configSlot: 'model:gpt-5-fixture',
      observedFrom: 1_510,
      observedUntil: null
    })
  )
)

// ── identity and pool claims stay sourced and time-scoped ─────────────────

putIdentityClaim(db, {
  id: 'claim.old-email',
  connectionId: oldConnection.id,
  kind: 'email',
  value: 'fixture@invalid',
  observedAt: 1_530,
  validUntil: null,
  confidence: 'observed',
  evidence: [{ description: 'fixture' }]
})
putQuotaPoolClaim(db, {
  id: 'claim.old-pool',
  connectionId: oldConnection.id,
  providerPoolKey: 'pool.fixture',
  scope: 'account',
  observedAt: 1_535,
  validUntil: 1_580,
  evidence: []
})
failsWith('MODEL_INVALID', () =>
  putIdentityClaim(db, {
    id: 'claim.orphan',
    connectionId: 'connection.missing',
    kind: 'email',
    value: 'fixture@invalid',
    observedAt: 1_530,
    validUntil: null,
    confidence: 'observed',
    evidence: []
  })
)
// The observation instant is the claim's identity: only evidence may change.
const amendedClaim = putIdentityClaim(db, {
  id: 'claim.old-email',
  connectionId: oldConnection.id,
  kind: 'email',
  value: 'fixture@invalid',
  observedAt: 1_530,
  validUntil: null,
  confidence: 'declared',
  evidence: [{ description: 'amended' }]
})
assert.equal(amendedClaim.revision, 2)
failsWith('INVALID_TRANSITION', () =>
  putIdentityClaim(db, {
    id: 'claim.old-email',
    connectionId: oldConnection.id,
    kind: 'email',
    value: 'other@invalid',
    observedAt: 1_531,
    validUntil: null,
    confidence: 'declared',
    evidence: []
  })
)
failsWith('INVALID_TRANSITION', () =>
  putQuotaPoolClaim(db, {
    id: 'claim.old-pool',
    connectionId: oldConnection.id,
    providerPoolKey: 'pool.fixture',
    scope: 'account',
    observedAt: 1_535,
    validUntil: null,
    evidence: []
  })
)
failsWith('INVALID_TRANSITION', () =>
  putQuotaPoolClaim(db, {
    id: 'claim.old-pool',
    connectionId: oldConnection.id,
    providerPoolKey: 'pool.fixture',
    scope: 'account',
    observedAt: 1_535,
    validUntil: 1_560,
    evidence: []
  })
)

// ── account replacement splits history and ends live attachments ──────────

const before = getInventorySnapshot(db)
const oldBefore = before.credentials.find((row) => row.value.id === oldCredential.id)
const historicalBefore = before.bindings.find((row) => row.value.id === 'binding.old-historical')
const closedConnectionBefore = before.connections.find((row) => row.value.id === 'connection.old-claude')
const boundedClaimBefore = before.quotaPoolClaims.find((row) => row.value.id === 'claim.old-pool')
assert.ok(oldBefore && historicalBefore && closedConnectionBefore && boundedClaimBefore)

const replacement: ProviderCredential = {
  id: 'credential.new',
  machineId,
  materialRef: '/fixture/config/auth.json',
  materialRevision: 1,
  ownership: 'user',
  availability: 'available',
  firstSeenAt: 3_000,
  lastSeenAt: 3_000
}
failsWith('INVALID_TRANSITION', () =>
  replaceCredential(db, {
    oldCredentialId: oldCredential.id,
    replacement: { ...replacement, id: oldCredential.id },
    replacedAt: 3_000
  })
)
failsWith('INVALID_TRANSITION', () =>
  replaceCredential(db, {
    oldCredentialId: oldCredential.id,
    replacement: { ...replacement, machineId: 'machine.other' },
    replacedAt: 3_000
  })
)
failsWith('MODEL_INVALID', () =>
  replaceCredential(db, {
    oldCredentialId: oldCredential.id,
    replacement: { ...replacement, firstSeenAt: 2_999 },
    replacedAt: 3_000
  })
)
const replaced = replaceCredential(db, {
  oldCredentialId: oldCredential.id,
  oldExpectedRevision: oldBefore.revision,
  replacement,
  replacedAt: 3_000
})
assert.equal(replaced.replacement.revision, 1)
assert.equal(replaced.oldRevision, oldBefore.revision + 1)

const after = getInventorySnapshot(db)
assert.equal(credentialOf(after, oldCredential.id)?.availability, 'unavailable')
// The replacement marker and observation bound live below the wire contract.
const storedOld = db
  .prepare('SELECT * FROM inventory_provider_credentials WHERE id=?')
  .get(oldCredential.id) as Record<string, unknown>
assert.equal(Number(storedOld.observed_until), 3_000)
assert.equal(String(storedOld.replaced_by_credential_id), 'credential.new')
assert.ok(Number(storedOld.last_seen_at) >= 3_000)
assert.deepEqual(
  [connectionOf(after, oldConnection.id)?.observedUntil, connectionOf(after, oldConnection.id)?.availability],
  [3_000, 'unavailable']
)
assert.equal(bindingOf(after, 'binding.old-current')?.observedUntil, 3_000)
// Closed history is evidence: it keeps its window and its revision.
assert.deepEqual(
  [bindingOf(after, 'binding.old-historical')?.observedUntil, bindingOf(after, 'binding.old-historical')?.revision],
  [historicalBefore.value.observedUntil, historicalBefore.value.revision]
)
assert.deepEqual(
  [connectionOf(after, 'connection.old-claude')?.observedUntil, connectionOf(after, 'connection.old-claude')?.availability],
  [closedConnectionBefore.value.observedUntil, closedConnectionBefore.value.availability]
)
assert.equal(after.identityClaims.find((row) => row.value.id === 'claim.old-email')?.value.validUntil, 3_000)
assert.deepEqual(
  [
    after.quotaPoolClaims.find((row) => row.value.id === 'claim.old-pool')?.value.validUntil,
    after.quotaPoolClaims.find((row) => row.value.id === 'claim.old-pool')?.revision
  ],
  [boundedClaimBefore.value.validUntil, boundedClaimBefore.revision]
)

// Fresh connections may only attach to the replacement credential.
failsWith('INVALID_TRANSITION', () =>
  putProviderConnection(db, { ...oldConnection, id: 'connection.new-on-old' })
)
failsWith('INVALID_TRANSITION', () =>
  refreshCredential(db, {
    credentialId: oldCredential.id,
    expectedMaterialRevision: 3,
    nextMaterialRevision: 4,
    observedAt: 3_100,
    accountContinuity: 'confirmed-same'
  })
)
failsWith('INVALID_TRANSITION', () =>
  replaceCredential(db, { oldCredentialId: oldCredential.id, replacement: { ...replacement, id: 'credential.newer' }, replacedAt: 3_100 })
)
const newConnection: ProviderConnection = {
  ...oldConnection,
  id: 'connection.new-chatgpt',
  credentialId: replacement.id,
  firstSeenAt: 3_050,
  observedUntil: null
}
assert.equal(putProviderConnection(db, newConnection).revision, 1)
assert.equal(
  putBinding(db, binding({ id: 'binding.new-current', connectionId: newConnection.id })).revision,
  1
)

// ── observations: missing/failed never destroy, removed ends live state ───

const beforeMissing = getInventorySnapshot(db)
recordInventoryObservation(db, {
  id: 'observation.missing-connection',
  subjectKind: 'connection',
  subjectId: newConnection.id,
  outcome: 'missing',
  observedAt: 3_200
})
recordInventoryObservation(db, {
  id: 'observation.failed-installation',
  subjectKind: 'installation',
  subjectId: claude.value.id,
  outcome: 'failed',
  observedAt: 3_200,
  sourceRef: 'fixture'
})
const afterMissing = getInventorySnapshot(db)
assert.deepEqual(
  [
    connectionOf(afterMissing, newConnection.id)?.observedUntil,
    afterMissing.connections.find((row) => row.value.id === newConnection.id)?.revision
  ],
  [null, beforeMissing.connections.find((row) => row.value.id === newConnection.id)?.revision]
)
assert.equal(afterMissing.installations.find((row) => row.value.id === claude.value.id)?.value.presence, 'present')
assert.equal(
  (db.prepare('SELECT outcome FROM inventory_observations WHERE id=?').get('observation.missing-connection') as Record<string, unknown>).outcome,
  'missing'
)
// An unknown subject still records the observation instead of throwing.
recordInventoryObservation(db, {
  id: 'observation.unknown-subject',
  subjectKind: 'connection',
  subjectId: 'connection.unknown',
  outcome: 'removed',
  observedAt: 3_200
})

// Removing an installation ends the bindings that were still current on it.
putBinding(
  db,
  binding({ id: 'binding.claude-current', installationId: claude.value.id, connectionId: newConnection.id })
)
recordInventoryObservation(db, {
  id: 'observation.removed-installation',
  subjectKind: 'installation',
  subjectId: claude.value.id,
  outcome: 'removed',
  observedAt: 3_300,
  sourceRef: 'fixture'
})
const afterInstallationRemoval = getInventorySnapshot(db)
assert.equal(
  afterInstallationRemoval.installations.find((row) => row.value.id === claude.value.id)?.value.presence,
  'absent'
)
assert.equal(bindingOf(afterInstallationRemoval, 'binding.claude-current')?.observedUntil, 3_300)
assert.equal(connectionOf(afterInstallationRemoval, newConnection.id)?.observedUntil, null)

// Removing a connection ends its current bindings and its open-ended claims.
recordInventoryObservation(db, {
  id: 'observation.removed-connection',
  subjectKind: 'connection',
  subjectId: newConnection.id,
  outcome: 'removed',
  observedAt: 3_400
})
const afterConnectionRemoval = getInventorySnapshot(db)
assert.deepEqual(
  [connectionOf(afterConnectionRemoval, newConnection.id)?.observedUntil, connectionOf(afterConnectionRemoval, newConnection.id)?.availability],
  [3_400, 'unavailable']
)
assert.equal(bindingOf(afterConnectionRemoval, 'binding.new-current')?.observedUntil, 3_400)

// Repeating the removal is a no-op on already-closed history.
const closedRevision = afterConnectionRemoval.connections.find((row) => row.value.id === newConnection.id)?.revision
recordInventoryObservation(db, {
  id: 'observation.removed-connection-again',
  subjectKind: 'connection',
  subjectId: newConnection.id,
  outcome: 'removed',
  observedAt: 3_500
})
recordInventoryObservation(db, {
  id: 'observation.removed-installation-again',
  subjectKind: 'installation',
  subjectId: claude.value.id,
  outcome: 'removed',
  observedAt: 3_500
})
const afterRepeat = getInventorySnapshot(db)
assert.equal(afterRepeat.connections.find((row) => row.value.id === newConnection.id)?.revision, closedRevision)
assert.equal(bindingOf(afterRepeat, 'binding.new-current')?.observedUntil, 3_400)

// A confirmed credential removal marks availability, it does not delete rows.
recordInventoryObservation(db, {
  id: 'observation.removed-credential',
  subjectKind: 'credential',
  subjectId: refreshable.id,
  outcome: 'removed',
  observedAt: 3_600
})
assert.equal(credentialOf(getInventorySnapshot(db), refreshable.id)?.availability, 'unavailable')

// ── revision resolution ────────────────────────────────────────────────────

const resolved = resolveInventoryRevisions(db, [
  machineId,
  oldCredential.id,
  oldConnection.id,
  'binding.old-current',
  'claim.old-email',
  'credential.missing'
])
assert.equal(typeof resolved[machineId], 'number')
assert.equal(typeof resolved[oldConnection.id], 'number')
assert.equal(resolved['credential.missing'], undefined)

// ── persistence: the rows survive a close/reopen of the control file ──────

const scratch = mkdtempSync(join(tmpdir(), 'mahas-inventory-smoke-'))
try {
  const file = join(scratch, 'control.db')
  const written = new DatabaseSync(file)
  written.exec('PRAGMA foreign_keys=ON;')
  written.exec(CATALOG_SCHEMA_SQL)
  written.exec(INVENTORY_SCHEMA_SQL)
  seedBuiltinCatalog(written)
  const fileMachine = ensureLocalMachine(written, {
    configDir: '/fixture/persisted',
    observedAt: 4_000,
    io: memoryIo().io
  })
  registerCredential(written, { ...oldCredential, id: 'credential.file', machineId: fileMachine.value.id })
  putProviderConnection(written, {
    ...oldConnection,
    id: 'connection.file',
    credentialId: 'credential.file',
    firstSeenAt: 4_100
  })
  const fileInstallation = ensureHarnessInstallation(written, {
    machineId: fileMachine.value.id,
    harnessId: 'codex',
    configNamespace: 'config/codex',
    dataNamespace: 'data/codex',
    observedAt: 4_050,
    origin: 'discovered'
  })
  putBinding(
    written,
    binding({
      id: 'binding.file',
      connectionId: 'connection.file',
      installationId: fileInstallation.value.id
    })
  )
  written.close()

  const reopened = new DatabaseSync(file)
  const snapshot = getInventorySnapshot(reopened)
  assert.equal(snapshot.machines.length, 1)
  assert.equal(snapshot.installations.length, 1)
  assert.equal(snapshot.credentials.find((row) => row.value.id === 'credential.file')?.value.materialRevision, 3)
  assert.equal(connectionOf(snapshot, 'connection.file')?.offeringId, 'openai/chatgpt')
  assert.equal(bindingOf(snapshot, 'binding.file')?.evidence.length, 0)
  reopened.close()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

db.close()
console.log('inventory repository smoke: ok')
