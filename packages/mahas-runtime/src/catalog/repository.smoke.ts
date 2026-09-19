// catalog/repository.smoke.ts — catalog persistence, identity/reference and
// alias-interval fixtures.
//
// Run:  node packages/mahas-runtime/src/catalog/repository.smoke.ts
//
// Synthetic-only: SQLite control DBs (in-memory plus one temp file), the real
// repository functions, no host config, credential or provider access.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ModelAliasResolution,
  NativeModelAlias
} from '../../../mahas-contracts/src/catalog/index.ts'
import { CATALOG_SCHEMA_SQL } from './migration.ts'
import {
  getCatalogSnapshot,
  observeNativeModelAlias,
  putHarness,
  putInferenceModel,
  putModelAliasResolution,
  putOffering,
  putOrganization,
  putProvider,
  requireCatalogRevision,
  resolveCatalogRevisions
} from './repository.ts'
import { seedBuiltinCatalog } from './seed.ts'

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON;')
  db.exec(CATALOG_SCHEMA_SQL)
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

const db = openDb()

// ── seed: additive, idempotent, identity stays split ───────────────────────

seedBuiltinCatalog(db)
const firstSeed = getCatalogSnapshot(db)
assert.equal(firstSeed.providers.length, 9)
assert.equal(firstSeed.offerings.length, 9)
seedBuiltinCatalog(db)
const reseeded = getCatalogSnapshot(db)
assert.deepEqual(
  reseeded.harnesses.map((row) => [row.value.id, row.revision]),
  firstSeed.harnesses.map((row) => [row.value.id, row.revision])
)

const chatgpt = reseeded.offerings.find((row) => row.value.id === 'openai/chatgpt')
assert.ok(chatgpt, 'seeded offering openai/chatgpt')
assert.equal(chatgpt.value.providerId, 'openai')
const openai = reseeded.providers.find((row) => row.value.id === 'openai')
assert.equal(openai?.value.operatorOrganizationId, 'org.openai')
// The harness named codex neither owns nor implies the account realm.
const codex = reseeded.harnesses.find((row) => row.value.id === 'codex')
assert.equal(codex?.value.publisherOrganizationId, 'org.openai')

// ── revision CAS and reference validation ──────────────────────────────────

const organization = { id: 'org.fixture', name: 'Fixture', metadata: {} }
assert.equal(putOrganization(db, organization).revision, 1)
assert.equal(putOrganization(db, { ...organization, name: 'Fixture v2' }, 1).revision, 2)
failsWith('STALE_REVISION', () => putOrganization(db, { ...organization, name: 'stale' }, 1))
failsWith('MODEL_INVALID', () => putOrganization(db, { ...organization, name: '   ' }))
failsWith('MODEL_INVALID', () =>
  putHarness(db, {
    id: 'harness.orphan',
    publisherOrganizationId: 'org.missing',
    label: 'Orphan',
    identityMetadata: {}
  })
)
failsWith('MODEL_INVALID', () => putHarness(db, { id: 'harness.unnamed', label: '', identityMetadata: {} }))

assert.equal(
  putHarness(db, {
    id: 'harness.fixture',
    publisherOrganizationId: 'org.fixture',
    label: 'Fixture harness',
    identityMetadata: { domain: 'fixture.invalid' }
  }).revision,
  1
)

// A provider realm is a shared identity: two providers cannot claim it.
putProvider(db, {
  id: 'provider.a',
  operatorOrganizationId: 'org.fixture',
  label: 'Provider A',
  realm: 'a.fixture.invalid',
  metadata: {}
})
failsWith('INVALID_TRANSITION', () =>
  putProvider(db, { id: 'provider.b', label: 'Provider B', realm: 'a.fixture.invalid', metadata: {} })
)
failsWith('MODEL_INVALID', () =>
  putProvider(db, { id: 'provider.c', label: 'Provider C', realm: '  ', metadata: {} })
)

putOffering(db, {
  id: 'provider.a/basic',
  providerId: 'provider.a',
  key: 'basic',
  label: 'Basic',
  metadata: {}
})
failsWith('INVALID_TRANSITION', () =>
  putOffering(db, {
    id: 'provider.a/basic-copy',
    providerId: 'provider.a',
    key: 'basic',
    label: 'Basic copy',
    metadata: {}
  })
)
failsWith('MODEL_INVALID', () =>
  putOffering(db, {
    id: 'provider.missing/basic',
    providerId: 'provider.missing',
    key: 'basic',
    label: 'Basic',
    metadata: {}
  })
)

// An unknown model publisher is null, never guessed from the model id.
const alpha = putInferenceModel(db, {
  id: 'model.alpha',
  publisherOrganizationId: 'org.fixture',
  label: 'Alpha',
  version: '2026-01',
  metadata: {}
})
assert.equal(alpha.revision, 1)
putInferenceModel(db, { id: 'model.beta', label: 'Beta', metadata: {} })
assert.equal(
  getCatalogSnapshot(db).models.find((row) => row.value.id === 'model.beta')?.value
    .publisherOrganizationId,
  null
)
failsWith('MODEL_INVALID', () =>
  putInferenceModel(db, {
    id: 'model.gamma',
    publisherOrganizationId: 'org.missing',
    label: 'Gamma',
    metadata: {}
  })
)

// ── native aliases: identity is immutable, the window only widens ──────────

const alias: NativeModelAlias = {
  id: 'alias.alpha-native',
  namespaceKind: 'harness',
  namespaceId: 'harness.fixture',
  nativeName: 'alpha-native',
  firstObservedAt: 1_000,
  lastObservedAt: 1_500,
  metadata: {}
}
const observed = observeNativeModelAlias(db, alias)
assert.equal(observed.revision, 1)
// A second row cannot claim the same (namespace, native name) identity.
failsWith('INVALID_TRANSITION', () =>
  observeNativeModelAlias(db, { ...alias, id: 'alias.alpha-native-copy' })
)
const widened = observeNativeModelAlias(
  db,
  { ...alias, firstObservedAt: 900, lastObservedAt: 1_200 },
  1
)
assert.deepEqual([widened.value.firstObservedAt, widened.value.lastObservedAt], [900, 1_500])
assert.equal(widened.revision, 2)
failsWith('INVALID_TRANSITION', () =>
  observeNativeModelAlias(db, { ...alias, nativeName: 'renamed' }, 2)
)
failsWith('MODEL_INVALID', () =>
  observeNativeModelAlias(db, {
    ...alias,
    id: 'alias.orphan',
    namespaceKind: 'offering',
    namespaceId: 'provider.a/missing'
  })
)
failsWith('MODEL_INVALID', () =>
  observeNativeModelAlias(db, { ...alias, id: 'alias.orphan-2', firstObservedAt: 2_000, lastObservedAt: 1_000 })
)

// ── alias resolutions: intervals partition time ────────────────────────────

const resolution = (over: Partial<ModelAliasResolution> = {}): ModelAliasResolution => ({
  id: 'resolution.alpha-1',
  aliasId: alias.id,
  modelId: 'model.alpha',
  validFrom: 2_000,
  validUntil: null,
  confidence: 'observed',
  evidence: [{ sourceRecordKey: 'fixture/1' }],
  revision: 1,
  ...over
})

failsWith('MODEL_INVALID', () => putModelAliasResolution(db, resolution({ aliasId: 'alias.missing' })))
failsWith('MODEL_INVALID', () => putModelAliasResolution(db, resolution({ modelId: 'model.missing' })))
failsWith('STALE_REVISION', () => putModelAliasResolution(db, resolution({ revision: 2 })))
failsWith('MODEL_INVALID', () => putModelAliasResolution(db, resolution({ validUntil: 2_000 })))

const opened = putModelAliasResolution(db, resolution())
assert.equal(opened.revision, 1)
assert.equal(opened.value.validUntil, null)

// Amending keeps the mapping identity and its start: only evidence/confidence
// or an extension into unmapped time may change.
failsWith('INVALID_TRANSITION', () =>
  putModelAliasResolution(db, resolution({ validFrom: 2_500 }))
)
failsWith('INVALID_TRANSITION', () =>
  putModelAliasResolution(db, resolution({ modelId: 'model.beta' }))
)
failsWith('INVALID_TRANSITION', () => putModelAliasResolution(db, resolution({ validUntil: 3_000 })))
const amended = putModelAliasResolution(db, resolution({ confidence: 'verified' }), 1)
assert.equal(amended.revision, 2)
assert.equal(amended.value.confidence, 'verified')
failsWith('STALE_REVISION', () =>
  putModelAliasResolution(db, resolution({ confidence: 'declared' }), 1)
)

// A changed canonical model closes the current mapping at the new start and
// never rewrites the interval that already existed.
const changed = putModelAliasResolution(
  db,
  resolution({ id: 'resolution.beta-1', modelId: 'model.beta', validFrom: 3_000, confidence: 'declared' })
)
assert.equal(changed.revision, 1)
const history = getCatalogSnapshot(db).aliasResolutions
const closed = history.find((row) => row.value.id === 'resolution.alpha-1')
assert.deepEqual([closed?.value.validUntil, closed?.revision], [3_000, 3])
assert.equal(history.find((row) => row.value.id === 'resolution.beta-1')?.value.validUntil, null)

// The replacement must start after the mapping it replaces, and cannot reach
// back over it.
failsWith('INVALID_TRANSITION', () =>
  putModelAliasResolution(
    db,
    resolution({ id: 'resolution.same-start', modelId: 'model.alpha', validFrom: 3_000 })
  )
)
failsWith('MODEL_INVALID', () =>
  putModelAliasResolution(
    db,
    resolution({ id: 'resolution.earlier', modelId: 'model.alpha', validFrom: 2_500 })
  )
)
failsWith('INVALID_TRANSITION', () =>
  putModelAliasResolution(
    db,
    resolution({ id: 'resolution.overlap', modelId: 'model.alpha', validFrom: 2_100, validUntil: 2_500 })
  )
)

// Closed intervals are frozen: no reopen, no shrinking, no growth over a
// successor.
failsWith('INVALID_TRANSITION', () => putModelAliasResolution(db, resolution({ validUntil: null })))
failsWith('INVALID_TRANSITION', () => putModelAliasResolution(db, resolution({ validUntil: 2_500 })))
failsWith('INVALID_TRANSITION', () => putModelAliasResolution(db, resolution({ validUntil: 3_500 })))

// Unmapped time is honest: an explicitly closed mapping may be extended into a
// gap and a bounded interval may be backfilled before the current mapping, but
// no interval may ever reach into a neighbour.
const gapAlias: NativeModelAlias = {
  ...alias,
  id: 'alias.beta-native',
  nativeName: 'beta-native',
  firstObservedAt: 900,
  lastObservedAt: 4_500
}
observeNativeModelAlias(db, gapAlias)
putModelAliasResolution(
  db,
  resolution({ id: 'resolution.gap-1', aliasId: gapAlias.id, validFrom: 1_000, validUntil: 2_000 })
)
putModelAliasResolution(
  db,
  resolution({ id: 'resolution.gap-2', aliasId: gapAlias.id, modelId: 'model.beta', validFrom: 3_000 })
)
failsWith('INVALID_TRANSITION', () =>
  putModelAliasResolution(
    db,
    resolution({
      id: 'resolution.gap-overlap',
      aliasId: gapAlias.id,
      modelId: 'model.beta',
      validFrom: 1_500,
      validUntil: 1_800
    })
  )
)
putModelAliasResolution(
  db,
  resolution({
    id: 'resolution.gap-backfill',
    aliasId: gapAlias.id,
    modelId: 'model.beta',
    validFrom: 2_500,
    validUntil: 2_800
  })
)
const extended = putModelAliasResolution(
  db,
  resolution({ id: 'resolution.gap-1', aliasId: gapAlias.id, validFrom: 1_000, validUntil: 2_500 }),
  1
)
assert.equal(extended.value.validUntil, 2_500)
assert.equal(extended.revision, 2)
failsWith('INVALID_TRANSITION', () =>
  putModelAliasResolution(
    db,
    resolution({ id: 'resolution.gap-1', aliasId: gapAlias.id, validFrom: 1_000, validUntil: 2_900 }),
    2
  )
)
failsWith('INVALID_TRANSITION', () =>
  putModelAliasResolution(
    db,
    resolution({ id: 'resolution.gap-1', aliasId: gapAlias.id, validFrom: 1_000, validUntil: null }),
    2
  )
)

// ── revision resolution over the whole catalog ─────────────────────────────

assert.equal(requireCatalogRevision(db, 'model.alpha'), 1)
assert.equal(requireCatalogRevision(db, 'provider.a/basic'), 1)
assert.equal(requireCatalogRevision(db, 'alias.alpha-native'), 2)
const resolved = resolveCatalogRevisions(db, ['model.alpha', 'resolution.beta-1', 'model.missing'])
assert.equal(resolved['model.alpha'], 1)
assert.equal(resolved['resolution.beta-1'], 1)
assert.equal(resolved['model.missing'], undefined)

// ── persistence: the rows survive a close/reopen of the control file ───────

const scratch = mkdtempSync(join(tmpdir(), 'mahas-catalog-smoke-'))
try {
  const file = join(scratch, 'control.db')
  const written = new DatabaseSync(file)
  written.exec('PRAGMA foreign_keys=ON;')
  written.exec(CATALOG_SCHEMA_SQL)
  seedBuiltinCatalog(written)
  putOrganization(written, organization)
  putHarness(written, {
    id: 'harness.fixture',
    publisherOrganizationId: 'org.fixture',
    label: 'Fixture harness',
    identityMetadata: {}
  })
  observeNativeModelAlias(written, alias)
  written.close()

  const reopened = new DatabaseSync(file)
  const snapshot = getCatalogSnapshot(reopened)
  assert.equal(snapshot.organizations.find((row) => row.value.id === 'org.fixture')?.revision, 1)
  assert.equal(snapshot.harnesses.length, 14)
  assert.equal(
    snapshot.aliases.find((row) => row.value.id === 'alias.alpha-native')?.value.nativeName,
    'alpha-native'
  )
  reopened.close()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

db.close()
console.log('catalog repository smoke: ok')
