#!/usr/bin/env node
// Regenerate the desktop's harness descriptor file from this Pack revision.
//
// resources/agents/manifest.json is the projection the main process reads for
// the agents:manifest IPC, the pty-host match patterns and the favicon domain.
// The Pack owns the data; this script writes the file, and the Pack's own
// conformance smoke asserts they stay identical (drift fails the fixture).
//
//   node integrations/packs/harness-runtime/project.mjs           # write
//   node integrations/packs/harness-runtime/project.mjs --check   # verify only

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  harnessManifestProjection,
  loadHarnessRuntimePack
} from '../../../packages/mahas-harness-config/src/runtime-pack.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pack = loadHarnessRuntimePack(here)
const target = join(here, '..', '..', '..', 'resources', 'agents', 'manifest.json')
const text = JSON.stringify(harnessManifestProjection(pack), null, 2) + '\n'
const check = process.argv.includes('--check')
if (check) {
  let current = ''
  try {
    current = readFileSync(target, 'utf8')
  } catch {
    /* missing counts as drift */
  }
  if (current !== text) {
    process.stderr.write(
      'resources/agents/manifest.json is not the Pack projection — run project.mjs\n'
    )
    process.exit(1)
  }
  process.stdout.write('resources/agents/manifest.json matches ' + pack.dir + '\n')
} else {
  writeFileSync(target, text)
  process.stdout.write('wrote ' + target + '\n')
}
