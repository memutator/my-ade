// inventory/auth/locator-import.smoke.ts — focused locator import regressions.
//
// Run:  node --experimental-transform-types packages/mahas-runtime/src/inventory/auth/locator-import.smoke.ts
//
// Everything is synthetic: an in-memory control DB, scratch /tmp roots and explicit
// Pack locator candidates. No real credential file, provider endpoint or desktop
// path is read.
//
// What is verified:
//   • first import registers a read-only locator credential AND a 'discovered'
//     connection — no harness binding is claimed;
//   • an unchanged re-import is idempotent;
//   • a locator credential missing its connection is repaired;
//   • a connection the user removed, and a closed credential, are not revived;
//   • an adopted locator is not revived;
//   • changed file evidence splits credential history and connects the successor —
//     an mtime bump alone is never 'confirmed-same' account evidence;
//   • the same physical file as a candidate for two offerings gets one credential
//     lineage per offering — the provenance lookup by locator_ref is offering-scoped.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { serializeDatabase } from '../../api/admission.ts'
import { putOffering, putProvider } from '../../catalog/repository.ts'
import { CONTROL_MIGRATIONS, applyMigrations } from '../../storage/migrations.ts'
import { ensureLocalMachine } from '../local.ts'
import { AUTH_SCHEMA_SQL } from './migrations.ts'
import { FileManagedSecretStore } from './secret-store.ts'
import { AuthService, type SerializedDatabase } from './service.ts'
import type { ProviderAuthDriver } from './coordinator.ts'
import {
  locatorConnectionId,
  locatorCredentialId,
  locatorRefFor,
  type LocatorCandidate,
  type ProviderLocatorCatalog
} from './locators.ts'

const scratch = mkdtempSync(join(tmpdir(), 'mahas-locator-import-'))
// The service never consults the environment itself (roots come from deps), but point
// every legacy-discovery variable at the scratch so a stray lookup can never reach the
// real home or config directories.
process.env.HOME = join(scratch, 'env-home')
process.env.XDG_CONFIG_HOME = join(scratch, 'env-xdg-config')
process.env.XDG_DATA_HOME = join(scratch, 'env-xdg-data')

let checks = 0
const ok = (name: string): void => {
  checks += 1
  process.stdout.write('  ok ' + name + '\n')
}

/** Locator imports never start a flow; any driver call from this smoke is a bug. */
const driver: ProviderAuthDriver = {
  start: () => Promise.reject(new Error('locator smoke has no auth flows')),
  submitCode: () => Promise.reject(new Error('locator smoke has no auth flows')),
  submitSecret: () => Promise.reject(new Error('locator smoke has no auth flows')),
  poll: () => Promise.reject(new Error('locator smoke has no auth flows')),
  cancel: () => {
    throw new Error('locator smoke has no auth flows')
  },
  status: () => {
    throw new Error('locator smoke has no auth flows')
  },
  refresh: () => Promise.reject(new Error('locator smoke has no auth flows'))
}

interface Ctx {
  home: string
  db: DatabaseSync
  machineId: string
  service: AuthService
  /** the synthetic Pack's candidate list; scenarios may append offerings */
  candidates: LocatorCandidate[]
  /** the one credential file every scenario starts with */
  file: string
}

function setup(name: string): Ctx {
  const dir = join(scratch, name)
  const home = join(dir, 'home')
  mkdirSync(join(home, '.synthetic'), { recursive: true })
  const file = join(home, '.synthetic', 'auth.json')
  writeFileSync(
    file,
    JSON.stringify({ accessToken: 'locator-token', refreshToken: 'locator-refresh' })
  )

  const db = new DatabaseSync(':memory:')
  // The real control migrations plus the auth fragment the composition appends — the
  // smoke runs against the schema the daemon actually gets, not a hand-made subset.
  applyMigrations(db, CONTROL_MIGRATIONS, 'control')
  db.exec(AUTH_SCHEMA_SQL)
  putProvider(db, {
    id: 'provider.synthetic',
    operatorOrganizationId: null,
    label: 'Synthetic provider',
    realm: 'example.test',
    metadata: {}
  })
  putOffering(db, {
    id: 'synthetic/one',
    providerId: 'provider.synthetic',
    key: 'one',
    label: 'Synthetic one',
    metadata: {}
  })
  putOffering(db, {
    id: 'synthetic/two',
    providerId: 'provider.synthetic',
    key: 'two',
    label: 'Synthetic two',
    metadata: {}
  })
  const machine = ensureLocalMachine(db, {
    configDir: join(dir, 'config'),
    observedAt: 1000
  }).value

  const candidates: LocatorCandidate[] = [
    {
      offeringId: 'synthetic/one',
      format: 'synthetic-auth-json',
      ownership: 'user',
      label: 'synthetic CLI',
      path: file
    }
  ]
  const catalog: ProviderLocatorCatalog = {
    candidates: () => candidates,
    parseMaterial: (_format, content) => JSON.parse(content) as Record<string, unknown>
  }
  const database: SerializedDatabase = (work) => serializeDatabase(db, work)
  let clock = 5_000
  let idSeq = 0
  const service = new AuthService({
    db,
    database,
    secrets: new FileManagedSecretStore(join(dir, 'secrets')),
    driver,
    catalog,
    roots: {
      home,
      configHome: join(home, '.config'),
      dataHome: join(home, '.local', 'share')
    },
    machineId: machine.id,
    now: () => (clock += 1_000),
    id: () => 'generated-' + ++idSeq
  })
  return { home, db, machineId: machine.id, service, candidates, file }
}

interface CredentialRow {
  id: string
  material_ref: string
  ownership: string
  availability: string
  observed_until: number | null
  replaced_by_credential_id: string | null
  last_seen_at: number
}
const credentialRows = (db: DatabaseSync): CredentialRow[] =>
  db
    .prepare('SELECT * FROM inventory_provider_credentials ORDER BY rowid')
    .all() as unknown as CredentialRow[]

interface ConnectionRow {
  id: string
  offering_id: string
  credential_id: string
  observed_until: number | null
  availability: string
  origin: string
}
const connectionRows = (db: DatabaseSync): ConnectionRow[] =>
  db
    .prepare('SELECT * FROM inventory_provider_connections ORDER BY rowid')
    .all() as unknown as ConnectionRow[]

try {
  // ── first import + idempotent re-import ───────────────────────────────────
  {
    const ctx = setup('first-import')
    const ref = locatorRefFor(ctx.file)
    const credId = locatorCredentialId(ctx.machineId, 'synthetic/one', ref)

    const first = await ctx.service.importLocators({ machineId: ctx.machineId })
    assert.deepEqual(first.imported, [credId])
    assert.deepEqual(first.unavailable, [])
    const cred = credentialRows(ctx.db).find((row) => row.id === credId)
    assert.ok(cred, 'the credential row exists')
    assert.equal(cred.material_ref, ref, 'the row references the file, never its bytes')
    assert.equal(cred.ownership, 'user', 'a harness-owned file stays user-owned')
    assert.equal(cred.availability, 'available')
    assert.equal(cred.observed_until, null)
    const provenance = ctx.service.provenance(credId)
    assert.equal(provenance?.origin, 'imported-locator')
    assert.equal(provenance?.locatorRef, ref)

    const connections = connectionRows(ctx.db)
    assert.equal(connections.length, 1)
    assert.equal(connections[0].id, locatorConnectionId(credId))
    assert.equal(connections[0].offering_id, 'synthetic/one')
    assert.equal(connections[0].credential_id, credId)
    assert.equal(connections[0].origin, 'discovered')
    assert.equal(connections[0].observed_until, null)
    const bindings = ctx.db
      .prepare(
        'SELECT COUNT(*) AS n FROM inventory_harness_provider_bindings WHERE connection_id=?'
      )
      .get(connections[0].id) as { n: number }
    assert.equal(Number(bindings.n), 0, 'import must not claim a harness binding')
    ok('first import registers the locator credential and a discovered connection')

    const second = await ctx.service.importLocators({ machineId: ctx.machineId })
    assert.deepEqual(second.imported, [])
    assert.deepEqual(second.unchanged, [credId])
    assert.equal(credentialRows(ctx.db).length, 1)
    assert.equal(connectionRows(ctx.db).length, 1)
    const reread = credentialRows(ctx.db)[0]
    assert.ok(reread.last_seen_at > cred.last_seen_at, 're-import only advances last_seen_at')
    ok('an unchanged re-import is idempotent')
  }

  // ── repair: imported credential whose connection row is gone ──────────────
  {
    const ctx = setup('repair')
    const ref = locatorRefFor(ctx.file)
    const credId = locatorCredentialId(ctx.machineId, 'synthetic/one', ref)
    await ctx.service.importLocators({ machineId: ctx.machineId })
    // Databases from before imports registered connections (and lost rows) leave an
    // imported credential with no connection at all — the row is gone, not closed.
    ctx.db.prepare('DELETE FROM inventory_provider_connections WHERE credential_id=?').run(credId)
    assert.equal(connectionRows(ctx.db).length, 0)

    const result = await ctx.service.importLocators({ machineId: ctx.machineId })
    assert.deepEqual(result.imported, [])
    assert.deepEqual(result.unchanged, [credId])
    const connections = connectionRows(ctx.db)
    assert.equal(connections.length, 1, 'the missing connection is re-registered')
    assert.equal(connections[0].id, locatorConnectionId(credId))
    assert.equal(connections[0].offering_id, 'synthetic/one')
    assert.equal(connections[0].observed_until, null)
    ok('a locator credential missing its connection is repaired')
  }

  // ── no revival: user-removed connection, closed credential ────────────────
  {
    const ctx = setup('removed-connection')
    const ref = locatorRefFor(ctx.file)
    const credId = locatorCredentialId(ctx.machineId, 'synthetic/one', ref)
    await ctx.service.importLocators({ machineId: ctx.machineId })
    // The user removed the account link: the connection is closed, not deleted.
    ctx.db
      .prepare('UPDATE inventory_provider_connections SET observed_until=? WHERE id=?')
      .run(9_000, locatorConnectionId(credId))

    const again = await ctx.service.importLocators({ machineId: ctx.machineId })
    assert.deepEqual(again.imported, [])
    assert.deepEqual(again.unchanged, [credId])
    const connections = connectionRows(ctx.db)
    assert.equal(connections.length, 1, 'no new connection appears')
    assert.equal(connections[0].observed_until, 9_000, 'the closed connection stays closed')
    ok('a connection the user removed is not revived by re-import')
  }

  {
    const ctx = setup('closed-credential')
    const ref = locatorRefFor(ctx.file)
    const credId = locatorCredentialId(ctx.machineId, 'synthetic/one', ref)
    await ctx.service.importLocators({ machineId: ctx.machineId })
    // Removing the credential itself closes both rows.
    ctx.db
      .prepare('UPDATE inventory_provider_connections SET observed_until=? WHERE credential_id=?')
      .run(9_000, credId)
    ctx.db
      .prepare('UPDATE inventory_provider_credentials SET observed_until=? WHERE id=?')
      .run(9_000, credId)

    const again = await ctx.service.importLocators({ machineId: ctx.machineId })
    assert.deepEqual(again.imported, [])
    assert.equal(credentialRows(ctx.db).length, 1, 'no replacement credential is registered')
    assert.equal(connectionRows(ctx.db).length, 1)
    assert.equal(connectionRows(ctx.db)[0].observed_until, 9_000)
    ok('a closed credential is not revived by re-import')
  }

  // ── no revival: adopted locator ───────────────────────────────────────────
  {
    const ctx = setup('adopted')
    const ref = locatorRefFor(ctx.file)
    const credId = locatorCredentialId(ctx.machineId, 'synthetic/one', ref)
    await ctx.service.importLocators({ machineId: ctx.machineId })
    const adopted = await ctx.service.adoptLocator({
      machineId: ctx.machineId,
      offeringId: 'synthetic/one',
      credentialId: credId,
      accountContinuity: 'confirmed-same',
      format: 'synthetic-auth-json'
    })
    assert.ok(adopted.materialRef.startsWith('mahas-secret://'))

    const again = await ctx.service.importLocators({ machineId: ctx.machineId })
    assert.deepEqual(again.imported, [])
    assert.deepEqual(again.unchanged, [adopted.credentialId])
    const live = credentialRows(ctx.db).filter((row) => row.observed_until === null)
    assert.equal(live.length, 1)
    assert.equal(live[0].id, adopted.credentialId)
    assert.equal(
      credentialRows(ctx.db).filter(
        (row) => row.material_ref === ref && row.observed_until === null
      ).length,
      0,
      'the on-disk file is not re-registered after adoption'
    )
    const open = connectionRows(ctx.db).filter((row) => row.observed_until === null)
    assert.equal(open.length, 1)
    assert.equal(open[0].credential_id, adopted.credentialId)
    ok('an adopted locator is not revived by re-import')
  }

  // ── changed evidence: conservative history split ──────────────────────────
  {
    const ctx = setup('metadata-split')
    const ref = locatorRefFor(ctx.file)
    const credId = locatorCredentialId(ctx.machineId, 'synthetic/one', ref)
    await ctx.service.importLocators({ machineId: ctx.machineId })
    // A different account's file lands at the same path: new content, new size.
    writeFileSync(
      ctx.file,
      JSON.stringify({
        accessToken: 'other-token',
        refreshToken: 'other-refresh',
        extra: 'field'
      })
    )

    const split = await ctx.service.importLocators({ machineId: ctx.machineId })
    assert.equal(split.imported.length, 1)
    const successor = split.imported[0]
    assert.notEqual(successor, credId)
    const oldCred = credentialRows(ctx.db).find((row) => row.id === credId)
    assert.ok(
      oldCred && oldCred.observed_until !== null,
      'the old credential keeps its closed history'
    )
    assert.equal(oldCred.replaced_by_credential_id, successor)
    const oldConn = connectionRows(ctx.db).find((row) => row.credential_id === credId)
    assert.ok(
      oldConn && oldConn.observed_until !== null,
      'the old connection closes with the credential'
    )
    const newConn = connectionRows(ctx.db).find((row) => row.credential_id === successor)
    assert.ok(newConn, 'the successor gets a connection')
    assert.equal(newConn.offering_id, 'synthetic/one')
    assert.equal(newConn.observed_until, null)
    assert.equal(ctx.service.provenance(successor)?.locatorRef, ref)
    ok('changed file evidence splits history and connects the successor')

    // An mtime bump alone is not same-account evidence either: touch the file without
    // changing its bytes and the history splits again instead of refreshing in place.
    const before = credentialRows(ctx.db).length
    utimesSync(ctx.file, new Date(), new Date(Date.now() + 60_000))
    const reSplit = await ctx.service.importLocators({ machineId: ctx.machineId })
    assert.equal(reSplit.imported.length, 1, 'an mtime-only change is not confirmed-same')
    assert.notEqual(reSplit.imported[0], successor)
    assert.equal(credentialRows(ctx.db).length, before + 1)
    ok('an mtime-only change splits history instead of confirming the same account')
  }

  // ── one file, two offerings: no conflation ────────────────────────────────
  {
    const ctx = setup('cross-offering')
    const ref = locatorRefFor(ctx.file)
    const credOne = locatorCredentialId(ctx.machineId, 'synthetic/one', ref)
    const credTwo = locatorCredentialId(ctx.machineId, 'synthetic/two', ref)
    assert.notEqual(credOne, credTwo, 'deterministic credential ids are per offering')

    const first = await ctx.service.importLocators({ machineId: ctx.machineId })
    assert.deepEqual(first.imported, [credOne])
    // The Pack declares the same file as evidence for a second offering.
    ctx.candidates.push({
      offeringId: 'synthetic/two',
      format: 'synthetic-auth-json',
      ownership: 'user',
      label: 'synthetic CLI',
      path: ctx.file
    })
    const second = await ctx.service.importLocators({ machineId: ctx.machineId })
    assert.deepEqual(second.unchanged, [credOne])
    assert.deepEqual(second.imported, [credTwo], 'the second offering gets its own credential')
    const creds = credentialRows(ctx.db)
    assert.equal(creds.length, 2)
    assert.ok(creds.every((row) => row.material_ref === ref && row.observed_until === null))
    const conns = connectionRows(ctx.db)
    assert.equal(conns.length, 2)
    const connOne = conns.find((row) => row.offering_id === 'synthetic/one')
    const connTwo = conns.find((row) => row.offering_id === 'synthetic/two')
    assert.equal(connOne?.credential_id, credOne)
    assert.equal(
      connTwo?.credential_id,
      credTwo,
      "offering two connects to its own credential, not offering one's"
    )

    // Re-import stays separated: each lineage reports its own credential unchanged.
    const third = await ctx.service.importLocators({ machineId: ctx.machineId })
    assert.deepEqual(third.imported, [])
    assert.deepEqual(third.unchanged, [credOne, credTwo])
    assert.equal(credentialRows(ctx.db).length, 2)
    assert.equal(connectionRows(ctx.db).length, 2)
    ok('the same file as a candidate for two offerings is not conflated')
  }

  // ── unavailable candidates are reported, not imported ─────────────────────
  {
    const ctx = setup('unavailable')
    const missing = join(ctx.home, '.synthetic', 'missing.json')
    ctx.candidates.push({
      offeringId: 'synthetic/two',
      format: 'synthetic-auth-json',
      ownership: 'user',
      label: 'missing CLI',
      path: missing
    })
    const result = await ctx.service.importLocators({ machineId: ctx.machineId })
    assert.deepEqual(result.imported, [
      locatorCredentialId(ctx.machineId, 'synthetic/one', locatorRefFor(ctx.file))
    ])
    assert.deepEqual(result.unavailable, [locatorRefFor(missing)])
    assert.equal(credentialRows(ctx.db).length, 1)
    ok('unavailable files are reported, not imported')
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

process.stdout.write('locator-import smoke: ' + checks + ' checks passed\n')
