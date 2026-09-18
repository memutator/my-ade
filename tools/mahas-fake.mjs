#!/usr/bin/env node
// mahas-fake — a fake agent harness for testing Mahas end-to-end.
//
// Run it inside a Mahas terminal tab exactly like a real agent CLI. It inherits
// MAHAS_SESSION/MAHAS_PANE/MAHAS_TAB from the spawned shell's env (stamped by
// pty-host), emits lifecycle events through the real hook script
// (mahas-hook.cjs), and stays alive until told to exit — so the pty agent
// detector, hook normalization, attention policy and resume machinery all
// exercise the real code path.
//
//   node tools/mahas-fake.mjs                    interactive — single keys emit events
//   node tools/mahas-fake.mjs --session-id X     pin the session id
//   node tools/mahas-fake.mjs --resume X         re-attach to session id X
//   node tools/mahas-fake.mjs --emit <ev> [--session-id X] [--message M]
//                                              emit one event and exit
//   node tools/mahas-fake.mjs --quiet            no session-start/session-end around the hold
//
// Interactive keys: n needs-input · c turn-complete · e error · i idle ·
//                   u user-prompt (turn-start) · r session-rename ·
//                   x session-end + exit
//
// The provider id is `fake` (manifest.json) — detection matches `mahas-fake` in
// the cmdline, and `resume` replays `node tools/mahas-fake.mjs --resume '<sid>'`
// (run from the repo root).

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

function opt(name, dflt) {
  const i = args.indexOf('--' + name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt
}
const has = (name) => args.includes('--' + name)

function hookPath() {
  if (process.env.MAHAS_HOOK) return process.env.MAHAS_HOOK
  const configDir =
    process.env.MAHAS_CONFIG_DIR ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'mahas')
  const installed = join(configDir, 'mahas-hook.cjs')
  if (existsSync(installed)) return installed
  // last resort: the repo copy next to this script — covers runs outside Mahas
  return join(HERE, '..', 'resources', 'mahas-hook.cjs')
}

const sessionId =
  opt('resume', null) || opt('session-id', null) || 'fake-' + Math.random().toString(36).slice(2, 10)

function emit(event, extra = {}) {
  const payload = JSON.stringify({
    session_id: sessionId,
    cwd: process.cwd(),
    ...extra
  })
  const r = spawnSync(process.execPath, [hookPath(), 'fake', event, payload], {
    stdio: 'inherit'
  })
  if (r.status !== 0) console.error(`[mahas-fake] hook emit failed: ${event}`)
}

if (has('--emit')) {
  emit(opt('emit'), opt('message', null) ? { message: opt('message') } : {})
  process.exit(0)
}

const quiet = has('--quiet')
const resumed = has('--resume')
if (!quiet) emit('session-start', resumed ? { reason: 'resume' } : {})

console.log(`[mahas-fake] session ${sessionId}${resumed ? ' (resumed)' : ''}`)
console.log('[mahas-fake] keys: n needs-input · c turn-complete · e error · i idle · u turn-start · r rename · x end+exit')

let ending = false
function end(code = 0) {
  if (ending) return
  ending = true
  if (!quiet) emit('session-end')
  process.exit(code)
}
process.on('SIGINT', () => end(130))
process.on('SIGTERM', () => end(143))
process.on('SIGHUP', () => end(129))

if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.on('keypress', (_s, k) => {
    if (k.ctrl && k.name === 'c') return end(130)
    const table = {
      n: 'needs-input',
      c: 'turn-complete',
      e: 'error',
      i: 'idle',
      u: 'userpromptsubmit',
      r: 'session-rename'
    }
    if (k.name === 'x') return end(0)
    const ev = table[k.name]
    if (!ev) return
    emit(ev, k.name === 'r' ? { name: 'renamed session' } : {})
    console.log(`[mahas-fake] → ${ev}`)
  })
}
