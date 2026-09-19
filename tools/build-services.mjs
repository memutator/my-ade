#!/usr/bin/env node
// Bundles the daemon-side services the desktop spawns under *system* Node
// (spec/architecture.md §1). They run outside Electron's asar and outside the
// Electron ABI, so the bundle targets Node 24 and leaves Node builtins and
// installed/native packages (`@homebridge/node-pty-prebuilt-multiarch`)
// external — electron-builder.yml's extraResources ships what they need.
//
// The output paths are the packaged contract:
// src/main/runtime/serviceBootstrap.ts resolves
// `<resources>/services/{mahasd,execution-host}.mjs`, and
// electron-builder.yml copies `out/services` to `resources/services`.
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outdir = join(root, 'out', 'services')

const entryPoints = {
  mahasd: 'packages/mahas-runtime/src/main.ts',
  'execution-host': 'packages/mahas-execution-host/src/main.ts',
  mahas: 'packages/mahas-cli/src/main.ts'
}

// The CLI reports the app version. A bundle has no package.json beside it, so
// the value is injected here instead of hardcoded in the source.
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (typeof manifest.version !== 'string' || !manifest.version) {
  fail('package.json has no version to stamp into the CLI bundle')
}
const define = { __MAHAS_CLI_VERSION__: JSON.stringify(manifest.version) }

function fail(message) {
  process.stderr.write(`build-services: ${message}\n`)
  process.exit(1)
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

let build
try {
  ;({ build } = await import('esbuild'))
} catch (error) {
  fail(
    'esbuild is not installed. It is a devDependency of this repo, so run ' +
      `npm install --ignore-scripts` +
      ` (then retry). Import failed with: ${error instanceof Error ? error.message : String(error)}`
  )
}

await mkdir(outdir, { recursive: true })
await build({
  absWorkingDir: root,
  entryPoints,
  outdir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  define,
  sourcemap: false,
  logLevel: 'info'
})

// Verify the real artifacts instead of trusting esbuild's log line: a missing
// or unparsable bundle must fail the build here, not at app start.
const artifacts = []
for (const name of Object.keys(entryPoints)) {
  const file = join(outdir, `${name}.mjs`)
  const info = await stat(file).catch(() => null)
  if (!info) fail(`expected artifact was not produced: ${relative(root, file)}`)
  const parsed = run(process.execPath, ['--check', file])
  if (parsed.status !== 0) {
    fail(`emitted bundle does not parse: ${relative(root, file)}\n${parsed.stderr ?? ''}`)
  }
  artifacts.push(`${name}.mjs (${(info.size / 1024).toFixed(1)} KiB)`)
}
process.stdout.write(
  `service artifacts written to ${relative(root, outdir)}/: ${artifacts.join(', ')}\n`
)

// ── boot test ──────────────────────────────────────────────────────────────
// Parsing is not starting. Each entrypoint decides whether it *is* the process
// entrypoint, and that guard is exactly what bundling can change, so the real
// checks are behavioural and read the artifact's own output. Both daemons are
// long-running, so a probe watches stdout and stops the process once it has a
// verdict — a closed stdin is not used as a shutdown signal here.
//
// Isolation matters more than the assertion: mahasd composes the integration
// domains on boot, and those resolve discovery roots from `homedir()` and the
// Pack root from `MAHAS_BUILTIN_PACKS_DIR` (falling back to the repo's real
// `integrations/packs`). Without an override the scheduler would point a
// collector at real provider directories. So every probe runs with:
//
//   · HOME, XDG_CONFIG_HOME, XDG_DATA_HOME → an empty scratch directory
//   · MAHAS_CONFIG_DIR                    → the same scratch directory
//   · MAHAS_BUILTIN_PACKS_DIR             → an empty scratch directory
//   · MAHAS_EVENTS_FILE / MAHAS_NOTIFY_LOG → explicit files inside it
//
// No provider API, network call, or user credential is reachable from there.
// The probe only ever reads process output; it never issues a request.

function jsonLine(output, predicate) {
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (predicate(parsed)) return parsed
    } catch {
      // not a complete JSON line yet — keep reading
    }
  }
  return null
}

function isolatedEnv(home) {
  return {
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    MAHAS_CONFIG_DIR: home,
    MAHAS_BUILTIN_PACKS_DIR: join(home, 'packs'),
    MAHAS_EVENTS_FILE: join(home, 'agent-events.log'),
    MAHAS_NOTIFY_LOG: join(home, 'notify-decisions.log')
  }
}

/** Resolves the first verdict `inspect` returns, then reaps the child. */
function probe(name, args, inspect, timeoutMs = 20_000) {
  const home = mkdtempSync(join(tmpdir(), `mahas-boot-${name}-`))
  for (const directory of ['config', 'data', 'packs']) mkdirSync(join(home, directory), { recursive: true })
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(outdir, `${name}.mjs`), '--config-dir', home, ...args],
      { env: isolatedEnv(home), stdio: ['pipe', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    // Graceful stop first: a daemon may be mid-write. Escalate only if it does
    // not leave, and never delete the scratch directory under a live child.
    const reap = (then) => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
        then(true)
        return
      }
      let done = false
      const finishReap = (exited) => {
        if (done) return
        done = true
        clearTimeout(escalate)
        clearTimeout(deadline)
        then(exited)
      }
      const escalate = setTimeout(() => {
        child.kill('SIGKILL')
      }, 3_000)
      const deadline = setTimeout(() => finishReap(false), 6_000)
      child.once('exit', () => finishReap(true))
      child.kill('SIGTERM')
    }
    const finish = (verdict) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reap((exited) => {
        if (!exited) {
          resolve({ ok: false, reason: `child ${child.pid} did not exit; retained ${home}` })
          return
        }
        rmSync(home, { recursive: true, force: true })
        resolve(verdict)
      })
    }
    const consider = () => {
      const verdict = inspect({ status: null, stdout, stderr, timedOut: false })
      if (verdict) finish(verdict)
    }
    const timer = setTimeout(
      () => finish(inspect({ status: null, stdout, stderr, timedOut: true })),
      timeoutMs
    )
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      consider()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      consider()
    })
    child.on('error', (error) => finish({ ok: false, reason: `could not be started: ${error.message}` }))
    child.on('close', (code) =>
      finish(
        inspect({ status: code, stdout, stderr, timedOut: false }) ?? {
          ok: false,
          reason: `exited ${String(code)} without a verdict: ${(stderr || stdout).slice(0, 400)}`
        }
      )
    )
  })
}

async function bootTest(name, args, inspect, timeoutMs) {
  const outcome = await probe(name, args, inspect, timeoutMs)
  if (!outcome.ok) fail(`${name}.mjs boot test failed: ${outcome.reason}`)
  process.stdout.write(`boot test ${name}.mjs: ${outcome.detail}\n`)
}

await bootTest('mahas', ['--version'], ({ status, stdout, stderr }) => {
  if (status === null) return null
  const version = stdout.trim()
  if (status !== 0) return { ok: false, reason: `expected exit 0, got ${String(status)} (${stderr.trim()})` }
  if (version !== manifest.version) return { ok: false, reason: `--version printed ${JSON.stringify(version)}, expected ${manifest.version}` }
  return { ok: true, detail: `--version printed ${version}` }
})

await bootTest('execution-host', [], ({ status, stdout, stderr, timedOut }) => {
  const ready = jsonLine(stdout, (entry) => entry.t === 'ready')
  if (ready) {
    if (!ready.hostId || !ready.endpoint) {
      return { ok: false, reason: `ready line is missing identity: ${JSON.stringify(ready)}` }
    }
    return { ok: true, detail: `published ready for host ${String(ready.hostId)} in an isolated config dir` }
  }
  const failure = jsonLine(stdout, (entry) => typeof entry.code === 'string' && entry.code !== '')
  if (failure) {
    return { ok: false, reason: `refused to start with ${String(failure.code)}: ${String(failure.msg ?? '')}` }
  }
  if (timedOut) return { ok: false, reason: `no ready line within the boot budget: ${(stderr || stdout).slice(0, 400)}` }
  return status === null ? null : { ok: false, reason: `exited ${String(status)} without ready: ${(stderr || stdout).slice(0, 400)}` }
})

await bootTest('mahasd', [], ({ status, stdout, stderr, timedOut }) => {
  if (jsonLine(stdout, (entry) => entry.t === 'mahasd.ready')) {
    return { ok: true, detail: 'reached mahasd.ready in an isolated config dir' }
  }
  const refusal = jsonLine(stdout, (entry) => typeof entry.code === 'string' && entry.code !== '')
  if (refusal) {
    return { ok: false, reason: `refused to start with structured code ${String(refusal.code)} (exit ${String(status)})` }
  }
  if (timedOut) return { ok: false, reason: `no ready line within the boot budget: ${(stderr || stdout).slice(0, 400)}` }
  return status === null ? null : { ok: false, reason: `exited ${String(status)} without ready: ${(stderr || stdout).slice(0, 400)}` }
})
