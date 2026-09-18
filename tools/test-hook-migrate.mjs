#!/usr/bin/env node
// Exercises refreshInstalledHooks against a fake HOME: leftover ade-hook
// pointers in user-owned configs must become mahas-hook without a click.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = mkdtempSync(join(tmpdir(), 'mahas-hook-mig-'))
const hookSrc = join(ROOT, 'resources', 'mahas-hook.cjs')
const pluginSrc = join(ROOT, 'resources', 'mahas-opencode-plugin.js')

mkdirSync(join(home, '.codex'), { recursive: true })
mkdirSync(join(home, '.claude'), { recursive: true })
mkdirSync(join(home, '.config', 'devin'), { recursive: true })
mkdirSync(join(home, '.zcode', 'cli'), { recursive: true })
mkdirSync(join(home, 'bin'), { recursive: true })
for (const bin of ['codex', 'claude', 'devin', 'zcode', 'grok', 'opencode']) {
  writeFileSync(join(home, 'bin', bin), '#!/bin/sh\n', { mode: 0o755 })
}

writeFileSync(
  join(home, '.codex', 'config.toml'),
  'notify = ["node", "/home/u/.config/ade/ade-hook.cjs", "codex"]\nmodel = "x"\n'
)
writeFileSync(
  join(home, '.claude', 'settings.json'),
  JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            { type: 'command', command: 'node "/home/u/.config/ade/ade-hook.cjs" claude', timeout: 10 }
          ]
        }
      ]
    }
  })
)
writeFileSync(
  join(home, '.config', 'devin', 'config.json'),
  JSON.stringify({
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'node "/home/u/.config/ade/ade-hook.cjs" devin' }] }
      ]
    }
  })
)
writeFileSync(
  join(home, '.zcode', 'cli', 'config.json'),
  JSON.stringify({
    hooks: {
      events: {
        Stop: [
          { hooks: [{ type: 'command', command: 'node "/home/u/.config/ade/ade-hook.cjs" zcode' }] }
        ]
      }
    }
  })
)

const bundle = join(home, 'hookInstallers.cjs')
const bundled = spawnSync(
  join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    join(ROOT, 'src/main/hookInstallers.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${bundle}`
  ],
  { encoding: 'utf8' }
)
if (bundled.status !== 0) {
  console.error(bundled.stderr || bundled.stdout)
  rmSync(home, { recursive: true, force: true })
  process.exit(bundled.status || 1)
}

const runner = `
const { refreshInstalledHooks, hookStatuses } = require(${JSON.stringify(bundle)})
refreshInstalledHooks(${JSON.stringify(hookSrc)}, ${JSON.stringify(pluginSrc)}, ${JSON.stringify(home)})
const st = hookStatuses(${JSON.stringify(hookSrc)}, ${JSON.stringify(pluginSrc)}, ${JSON.stringify(home)})
console.log(JSON.stringify(st.map((s) => ({ id: s.id, installed: s.installed }))))
`

const env = {
  ...process.env,
  HOME: home,
  PATH: join(home, 'bin') + ':' + process.env.PATH,
  XDG_CONFIG_HOME: join(home, '.config')
}
delete env.MAHAS_CONFIG_DIR
delete env.MAHAS_EVENTS_FILE

const r = spawnSync(process.execPath, ['-e', runner], { encoding: 'utf8', env })
if (r.status !== 0) {
  console.error(r.stderr || r.stdout)
  rmSync(home, { recursive: true, force: true })
  process.exit(r.status || 1)
}

const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
const claude = readFileSync(join(home, '.claude', 'settings.json'), 'utf8')
const fail = (msg) => {
  console.error('FAIL', msg)
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}
if (toml.includes('ade-hook')) fail('codex still points at ade-hook:\n' + toml)
if (!toml.includes('mahas-hook')) fail('codex missing mahas-hook:\n' + toml)
if (claude.includes('ade-hook')) fail('claude still points at ade-hook')
if (!claude.includes('mahas-hook')) fail('claude missing mahas-hook')
console.log('ok — migrated', r.stdout.trim())
rmSync(home, { recursive: true, force: true })
