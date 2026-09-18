#!/usr/bin/env node
// Devin Stop with a TUI error banner must classify as `error`, not turn-complete.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const hook = join(ROOT, 'resources', 'mahas-hook.cjs')
const dir = mkdtempSync(join(tmpdir(), 'mahas-err-banner-'))
const events = join(dir, 'agent-events.log')

function emit(payload) {
  const r = spawnSync(process.execPath, [hook, 'devin'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, MAHAS_EVENTS_FILE: events, MAHAS_CONFIG_DIR: dir }
  })
  if (r.status !== 0) {
    console.error(r.stderr)
    rmSync(dir, { recursive: true, force: true })
    process.exit(r.status || 1)
  }
}

emit({
  hook_event_name: 'Stop',
  last_assistant_message:
    '[Error] Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model.'
})
emit({
  hook_event_name: 'Stop',
  last_assistant_message: '조사 다 팠다 — rate limit 이야기를 본문에 넣어도 완료다.'
})

const lines = readFileSync(events, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
const fail = (msg) => {
  console.error('FAIL', msg, lines)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
if (lines[0]?.event !== 'error') fail('banner Stop should be error')
if (lines[1]?.event !== 'turn-complete') fail('prose mentioning rate limit should stay complete')
console.log('ok — failed Stop classified, prose Stop left as turn-complete')
rmSync(dir, { recursive: true, force: true })
