// VER-10 leg runner — spawn codex with the recipe's exact argv (plus `exec`
// subcommand for non-interactive legs), recipe env merged over ambient env,
// recipe envPrepend applied to PATH. Captures stdout/stderr/exit to out/.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const ROOT = '/tmp/mahas-ver-10'
const spec = JSON.parse(readFileSync(`${ROOT}/out/launch-spec.json`, 'utf8'))
const leg = process.argv[2] ?? 'r1'
const promptFile = process.argv[3]
const extraArgv = process.argv.slice(4) // e.g. resume args

const ps = spec.processSpec
// --skip-git-repo-check: leg-level flag (not recipe argv) — the isolated /tmp
// checkout isn't a trusted project in the user's codex config, and the config
// must not be modified for the run.
const argv = promptFile
  ? ['exec', '--skip-git-repo-check', ...ps.argv.slice(0, -1), readFileSync(promptFile, 'utf8')]
  : ['exec', '--skip-git-repo-check', ...ps.argv, ...extraArgv]

const env = {
  ...process.env,
  ...ps.env,
  MAHAS_CONFIG_DIR: `${ROOT}/config`,
  MAHAS_SESSION: randomUUID(), // hook-event ours attribution
  PATH: [...(ps.envPrepend?.PATH ?? []), process.env.PATH].join(':')
}

mkdirSync(`${ROOT}/out`, { recursive: true })
const t0 = Date.now()
console.log(`[${leg}] spawn: ${ps.executable} ${argv.map(a => a.length > 80 ? a.slice(0, 80) + '…' : a).join(' ')}`)
const child = spawn(ps.executable, argv, {
  cwd: ps.cwd,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
let out = '', err = ''
child.stdout.on('data', d => { out += d; process.stdout.write(d) })
child.stderr.on('data', d => { err += d; process.stderr.write(d) })
child.on('exit', (code, sig) => {
  const rec = { leg, argv: argv.map(a => a.length > 400 ? a.slice(0, 400) + '…' : a), cwd: ps.cwd, code, sig, ms: Date.now() - t0, stdoutBytes: out.length, stderrBytes: err.length }
  writeFileSync(`${ROOT}/out/${leg}-result.json`, JSON.stringify(rec, null, 2))
  writeFileSync(`${ROOT}/out/${leg}-stdout.txt`, out)
  writeFileSync(`${ROOT}/out/${leg}-stderr.txt`, err)
  console.log(`\n[${leg}] exit=${code} sig=${sig} ${rec.ms}ms out=${out.length}B err=${err.length}B`)
  process.exit(code ?? 1)
})
setTimeout(() => { child.kill('SIGKILL'); console.log('TIMEOUT kill') }, 240000)
