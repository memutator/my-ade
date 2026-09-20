// integration/builtin-packs.smoke.ts — the built-in Pack boot path.
//
// Run:  node packages/mahas-runtime/src/integration/builtin-packs.smoke.ts
//
// This is the check the composition root needs BEFORE it calls
// registerCanonicalCollectorPacks() at boot: every Pack under integrations/packs
// is discovered recursively, its manifest validates, its snapshot digests, every
// declared contract resolves through createCanonicalContractRegistry(), and
// every implemented capability has a readable entrypoint inside the snapshot.
//
// It does NOT invoke a collector: collection belongs to the scheduler and its
// own fixtures (a Pack whose collector is wrong can still register).

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createCanonicalContractRegistry } from './contracts.ts'
import { discoverPackRoots, registerCanonicalCollectorPacks } from './index.ts'
import { INTEGRATION_SCHEMA_SQL } from './migration.ts'
import { PackRegistry, isPackIdentityFile, packEntrypoint } from './registry.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const packsRoot = join(repoRoot, 'integrations', 'packs')
const scratch = mkdtempSync(join(tmpdir(), 'mahas-builtin-packs-'))

try {
  const roots = discoverPackRoots(packsRoot)
  assert.ok(roots.length > 0, 'no built-in Pack was discovered under integrations/packs')

  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(INTEGRATION_SCHEMA_SQL)
  const registry = new PackRegistry({ db, contentRoot: join(scratch, 'snapshots') })
  const revisions = registerCanonicalCollectorPacks(registry, packsRoot)
  assert.equal(revisions.length, roots.length)

  const contracts = createCanonicalContractRegistry()
  const rows: string[] = []
  assert.equal(isPackIdentityFile('README.md'), false)
  assert.equal(isPackIdentityFile('conformance.smoke.ts'), false)
  assert.equal(isPackIdentityFile('collector.mjs'), true)
  assert.equal(isPackIdentityFile('hooks/mahas-hook.cjs'), true)
  for (const revision of revisions) {
    const implementations = revision.manifest.revision.implementations
    assert.ok(implementations.length > 0, `${revision.packId} declares no capability`)
    // the registered snapshot must still digest to the registered content
    assert.equal(
      registry.resolve(revision.packId, revision.revision).contentDigest,
      revision.contentDigest
    )
    for (const implementation of implementations) {
      const resolved = contracts.resolve(
        implementation.contract.id,
        implementation.contract.revision
      )
      assert.ok(
        resolved,
        `${revision.packId}: contract ${implementation.contract.id}@${implementation.contract.revision} does not resolve`
      )
      assert.equal(resolved.capability, implementation.capability)
      if (implementation.support.state === 'implemented') {
        assert.ok(implementation.entrypoint, `${revision.packId}: no entrypoint`)
        // throws when the resource is missing or escapes the snapshot
        packEntrypoint(revision, implementation.entrypoint.resource)
      }
    }
    assert.equal(
      existsSync(join(revision.snapshotPath, 'README.md')),
      false,
      `${revision.packId} snapshot must not include README.md`
    )
    assert.equal(
      existsSync(join(revision.snapshotPath, 'conformance.smoke.ts')),
      false,
      `${revision.packId} snapshot must not include conformance.smoke.ts`
    )
    rows.push(
      `  ${revision.packId}@${revision.revision} ${revision.contentDigest.slice(0, 12)} ` +
        implementations.map((i) => i.capability).join(',')
    )
  }
  process.stdout.write(`${rows.join('\n')}\n`)
  process.stdout.write(`${revisions.length} built-in Pack revisions registered and verified\n`)
  db.close()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
