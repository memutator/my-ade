import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveServiceBootstrapPaths } from './serviceBootstrap.ts'

const directory = await mkdtemp(join(tmpdir(), 'mahas-bootstrap-'))
try {
  const services = join(directory, 'resources', 'services')
  await mkdir(services, { recursive: true })
  await writeFile(join(services, 'mahasd.mjs'), '')
  await writeFile(join(services, 'execution-host.mjs'), '')
  const resolved = resolveServiceBootstrapPaths({
    packaged: true,
    appPath: join(directory, 'app'),
    resourcesPath: join(directory, 'resources'),
    configDir: join(directory, 'config'),
    env: { MAHAS_NODE: process.execPath, PATH: '' }
  })
  assert.ok(resolved)
  assert.equal(resolved.node, process.execPath)
  assert.equal(resolved.mahasd, join(services, 'mahasd.mjs'))
  assert.equal(resolved.executionHost, join(services, 'execution-host.mjs'))
  assert.equal(resolved.builtinPacksDir, join(directory, 'resources', 'integrations', 'packs'))
  // no legacy root given -> nothing to adopt (the daemon must not be pointed
  // at a path that does not exist)
  assert.equal(resolved.legacyUsageAccountsRoot, null)

  // a profile WITH pre-inventory credential files passes its root through
  const accounts = join(directory, 'usage-accounts')
  await mkdir(accounts, { recursive: true })
  const withLegacy = resolveServiceBootstrapPaths({
    packaged: true,
    appPath: join(directory, 'app'),
    resourcesPath: join(directory, 'resources'),
    configDir: join(directory, 'config'),
    env: { MAHAS_NODE: process.execPath, PATH: '' },
    legacyUsageAccountsRoot: accounts
  })
  assert.equal(withLegacy?.legacyUsageAccountsRoot, accounts)
  // a root that is not there resolves to null rather than a dead path
  const stale = resolveServiceBootstrapPaths({
    packaged: true,
    appPath: join(directory, 'app'),
    resourcesPath: join(directory, 'resources'),
    configDir: join(directory, 'config'),
    env: { MAHAS_NODE: process.execPath, PATH: '' },
    legacyUsageAccountsRoot: join(directory, 'never-created')
  })
  assert.equal(stale?.legacyUsageAccountsRoot, null)

  const missing = resolveServiceBootstrapPaths({
    packaged: true,
    appPath: join(directory, 'app'),
    resourcesPath: join(directory, 'missing'),
    configDir: join(directory, 'config'),
    env: { MAHAS_NODE: process.execPath, PATH: '' }
  })
  assert.equal(missing, null)
} finally {
  await rm(directory, { recursive: true, force: true })
}

console.log('service bootstrap smoke: ok')
