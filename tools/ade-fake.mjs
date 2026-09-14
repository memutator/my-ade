#!/usr/bin/env node
// ade-fake — a fake agent harness for testing ADE end-to-end.
//
// Run it inside an ADE terminal tab exactly like a real agent CLI. It inherits
// ADE_SESSION/ADE_PANE/ADE_TAB from the spawned shell's env (stamped by
// pty-host), emits lifecycle events through the real hook script
// (ade-hook.cjs), and stays alive until told to exit — so the pty agent
// detector, hook normalization, attention policy and resume machinery all
// exercise the real code path.
//
//   node tools/ade-fake.mjs                    interactive — single keys emit events
//   node tools/ade-fake.mjs --session-id X     pin the session id
//   node tools/ade-fake.mjs --resume X         re-attach to session id X
//   node tools/ade-fake.mjs --emit <ev> [--session-id X] [--message M]
//                                              emit one event and exit
//   node tools/ade-fake.mjs --quiet            no session-start/session-end around the hold
//
// Interactive keys: n needs-input · c turn-complete · e error · i idle ·
//                   u user-prompt (turn-start) · r session-rename ·
//                   x session-end + exit
//
// The provider id is `fake` (manifest.json) — detection matches `ade-fake` in
// the cmdline, and `resume` replays `node tools/ade-fake.mjs --resume '<sid>'`
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
  if (process.env.ADE_HOOK) return process.env.ADE_HOOK
  const configDir =
    process.env.ADE_CONFIG_DIR ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ade')
  const installed = join(configDir, 'ade-hook.cjs')
  if (existsSync(installed)) return installed
  // last resort: the repo copy next to this script — covers runs outside ADE
  return join(HERE, '..', 'resources', 'ade-hook.cjs')
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
  if (r.status !== 0) console.error(`[ade-fake] hook emit failed: ${event}`)
}

if (has('--emit')) {
  emit(opt('emit'), opt('message', null) ? { message: opt('message') } : {})
  process.exit(0)
}

const quiet = has('--quiet')
const resumed = has('--resume')
if (!quiet) emit('session-start', resumed ? { reason: 'resume' } : {})

console.log(`[ade-fake] session ${sessionId}${resumed ? ' (resumed)' : ''}`)
console.log('[ade-fake] keys: n needs-input · c turn-complete · e error · i idle · u turn-start · r rename · x end+exit')

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
    console.log(`[ade-fake] → ${ev}`)
  })
}
