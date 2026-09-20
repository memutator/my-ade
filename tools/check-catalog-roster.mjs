#!/usr/bin/env node
// Fail the build when Pack harness/offering ids drift from catalog seed constants.
// Seed stays insert-only; this check does not upsert user rows.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value, i) => value === right[i])
}

function arrayBlock(source, name) {
  const match = source.match(new RegExp(`export const ${name}[\\s\\S]*?=\\s*\\[([\\s\\S]*?)\\n\\]`))
  if (!match) throw new Error(`could not find ${name} in catalog/seed.ts`)
  return match[1]
}

const seed = readFileSync(join(root, 'packages/mahas-runtime/src/catalog/seed.ts'), 'utf8')
const seedHarnessIds = [...arrayBlock(seed, 'BUILTIN_HARNESSES').matchAll(/id: '([^']+)'/g)].map(
  (match) => match[1]
)
const seedOfferingIds = [
  ...arrayBlock(seed, 'BUILTIN_PROVIDERS').matchAll(/offeringId: '([^']+)'/g)
].map((match) => match[1])

const harnesses = JSON.parse(
  readFileSync(join(root, 'integrations/packs/harness-runtime/harnesses.json'), 'utf8')
)
const packHarnessIds = Object.keys(harnesses.harnesses ?? {})
const providers = JSON.parse(
  readFileSync(
    join(root, 'integrations/packs/providers/builtin-offerings/providers.json'),
    'utf8'
  )
)
const packOfferingIds = Object.keys(providers).filter((key) => key !== 'comment')

const seedHarness = [...seedHarnessIds].sort()
const packHarness = [...packHarnessIds].sort()
const seedOffering = [...seedOfferingIds].sort()
const packOffering = [...packOfferingIds].sort()

if (!sameSet(seedHarness, packHarness)) {
  fail(
    `harness roster drift:\n  seed ${seedHarness.join(',')}\n  pack ${packHarness.join(',')}`
  )
}
if (!sameSet(seedOffering, packOffering)) {
  fail(
    `offering roster drift:\n  seed ${seedOffering.join(',')}\n  pack ${packOffering.join(',')}`
  )
}

if (process.exitCode) process.exit(process.exitCode)
process.stdout.write(
  `catalog roster matches Pack data (${packHarness.length} harnesses, ${packOffering.length} offerings)\n`
)
