import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations, CONTROL_MIGRATIONS, CONTROL_SCHEMA_VERSION, schemaVersion } from './migrations.ts'

const root = mkdtempSync(join(tmpdir(), 'mahas-domain-upgrade-'))
const databases: DatabaseSync[] = []
function open(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys=ON')
  databases.push(db)
  return db
}
try {
  const fresh = open()
  assert.equal(applyMigrations(fresh, CONTROL_MIGRATIONS, 'control').length, CONTROL_MIGRATIONS.length)
  assert.equal(schemaVersion(fresh), CONTROL_SCHEMA_VERSION)
  assert.deepEqual(fresh.prepare('PRAGMA foreign_key_check').all(), [])
  assert.deepEqual(applyMigrations(fresh, CONTROL_MIGRATIONS, 'control'), [])

  const old = open(join(root, 'old.sqlite'))
  applyMigrations(old, CONTROL_MIGRATIONS.slice(0, 1), 'control')
  old.prepare('INSERT INTO principals(id,kind,status) VALUES(?,?,?)').run('existing', 'operator', 'active')
  assert.deepEqual(applyMigrations(old, CONTROL_MIGRATIONS, 'control'), CONTROL_MIGRATIONS.slice(1).map((m) => m.id))
  assert.equal(old.prepare('SELECT status FROM principals WHERE id=?').get('existing')?.status, 'active')
  old.prepare(`INSERT INTO catalog_organizations(id,name,metadata_json,revision) VALUES(?,?,?,?)`).run('fixture', 'Fixture', '{}', 1)
  const snapshot = join(root, 'snapshot.sqlite')
  old.prepare('VACUUM INTO ?').run(snapshot)
  const restored = open(snapshot)
  assert.equal(schemaVersion(restored), CONTROL_SCHEMA_VERSION)
  assert.equal(restored.prepare('SELECT name FROM catalog_organizations WHERE id=?').get('fixture')?.name, 'Fixture')
  assert.deepEqual(applyMigrations(restored, CONTROL_MIGRATIONS, 'control'), [])
  assert.throws(() => applyMigrations(restored, CONTROL_MIGRATIONS.slice(0, 1), 'control'), /newer/)

  const failed = open()
  applyMigrations(failed, CONTROL_MIGRATIONS.slice(0, 1), 'control')
  assert.throws(() => applyMigrations(failed, [CONTROL_MIGRATIONS[0]!, {
    id: 'deliberate-failure', fromVersion: 1, toVersion: 2,
    ddl: 'CREATE TABLE must_rollback(id TEXT); INSERT INTO absent_table VALUES(1);'
  }], 'control'))
  assert.equal(schemaVersion(failed), 1)
  assert.equal(failed.prepare("SELECT name FROM sqlite_master WHERE name='must_rollback'").get(), undefined)
  assert.equal(failed.prepare('SELECT id FROM migration_receipts WHERE id=?').get('deliberate-failure'), undefined)
  const foreign = open()
  foreign.exec('CREATE TABLE foreign_data(id TEXT)')
  assert.throws(() => applyMigrations(foreign, CONTROL_MIGRATIONS, 'control'), /unmanaged\/foreign/)
  console.log('domain migration smoke: fresh, v1 upgrade, reopen, backup image, rollback and downgrade passed')
} finally {
  for (const db of databases) db.close()
  rmSync(root, { recursive: true, force: true })
}
