#!/usr/bin/env node
// Runs the domain smoke scripts against synthetic fixtures in scratch
// directories. Each script builds its own throwaway SQLite database and Pack
// snapshot, so this touches no real profile, credential, or session log.
//
// The suites exist because they need different Node behaviour and time:
//
//   unit      — catalog/inventory repositories, storage migration. Plain
//               `node <file>.ts` works: these files use erasable syntax only.
//   pipeline  — the external-Pack → scheduler → ledger → stored-query path.
//               It needs `--experimental-transform-types`, because it loads a
//               real Pack through the registry and enums/namespaces are not
//               erasable syntax. Without the flag Node fails with
//               ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX before any assertion runs.
//   daemon    — starts a real `startMahasd` in a scratch config dir and drives
//               it over its real socket against a synthetic Pack source. This is
//               the only suite that proves the daemon's own lifetime (collector
//               keeps running after the client disconnects, restart preserves
//               stored data, a repeated UI read does not collect), and a full
//               pass waits on the collection timer (~30 s).
//   packs     — the shipped collectors, each exercised through the real registry
//               + `runPack` against synthetic vendor fixtures, plus the
//               seven-Pack acceptance that commits a batch into the real ledger.
//
// `--unit-only`, `--pipeline-only`, `--daemon-only`, `--packs-only`, and
// `--include-runtime` select a subset. The launch/access suite, the daemon
// acceptance, and the Pack conformance are opt-in, so the default run stays fast.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './boundary-policy.mjs'

const RUNTIME = 'packages/mahas-runtime/src'

const SUITES = {
  unit: [
    [`${RUNTIME}/storage/domain-migration.smoke.ts`, []],
    [`${RUNTIME}/catalog/repository.smoke.ts`, []],
    [`${RUNTIME}/inventory/repository.smoke.ts`, []],
    // recovery-side canonical session/handle bridge + legacy backfill over the
    // real control schema (schema v3 reference table, v4 progress table)
    [`${RUNTIME}/recovery/session-handles.smoke.ts`, []],
    // hook event stream: cursor durability, partial line, rotation, dedup,
    // cross-producer identity, and the reader's own lifecycle
    [`${RUNTIME}/sessions/hook-stream.smoke.ts`, []],
    // desktop legacy resume records: true migration before the store query,
    // placement-only metadata, unknown harnesses reported not guessed
    [`${RUNTIME}/sessions/desktop-import.smoke.ts`, []],
    // inspector wire contract against the runtime's canonical responses
    [`${RUNTIME}/inspector/inspector-contract.smoke.ts`, []],
    [`${RUNTIME}/coordination/dispatch-revoke.smoke.ts`, []],
    [`${RUNTIME}/lifecycle/recovery-map.smoke.ts`, []],
    // mahas-client connector: operator connection file, reconnect, receipt
    // mapping — pure client side, no daemon or database
    ['packages/mahas-client/src/client.smoke.ts', []]
  ],
  pipeline: [
    [`${RUNTIME}/domain-pipeline.smoke.ts`, ['--experimental-transform-types']],
    [`${RUNTIME}/integration/pack.smoke.ts`, []],
    [`${RUNTIME}/integration/builtin-packs.smoke.ts`, []],
    [`${RUNTIME}/observation/collection/collection.smoke.ts`, ['--experimental-transform-types']],
    [`${RUNTIME}/metering/usage/ledger.smoke.ts`, ['--experimental-transform-types']],
    [`${RUNTIME}/metering/aggregates/aggregates.smoke.ts`, ['--experimental-transform-types']],
    [`${RUNTIME}/metering/statistics/statistics.smoke.ts`, ['--experimental-transform-types']],
    [`${RUNTIME}/inventory/auth/auth.smoke.ts`, ['--experimental-transform-types']],
    [`${RUNTIME}/inventory/auth/locator-import.smoke.ts`, ['--experimental-transform-types']],
    // durable user-channel completion: atomic rollback/retry, idempotent
    // status, autonomous callback, local machine
    [`${RUNTIME}/inventory/auth/channel-workflow.smoke.ts`, ['--experimental-transform-types']],
    [`${RUNTIME}/metering/quota/poll.smoke.ts`, ['--experimental-transform-types']],
    [`${RUNTIME}/api/registry.smoke.ts`, ['--experimental-transform-types']],
    [`${RUNTIME}/api/admission.deferred.smoke.ts`, ['--experimental-transform-types']]
  ],
  // These scripts import modules that use non-erasable TypeScript syntax, so
  // they need the transform-types flag (plain `node file.ts` fails with
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  runtime: [
    [`${RUNTIME}/access/f062-assignment-service.smoke.ts`, ['--experimental-transform-types']],
    [`${RUNTIME}/launch/workspace-gate.smoke.ts`, ['--experimental-transform-types']],
    [`${RUNTIME}/launch/f064-recovery.smoke.ts`, ['--experimental-transform-types']],
    [`${RUNTIME}/launch/launch-host-integration.smoke.ts`, ['--experimental-transform-types']]
  ],
  daemon: [
    [`${RUNTIME}/domain-daemon.smoke.ts`, ['--experimental-transform-types']],
    // assembled daemon + built-in Pack + real auth socket with synthetic
    // secrets; fetch is stubbed in-process so nothing reaches the network
    [`${RUNTIME}/domain-auth.smoke.ts`, ['--experimental-transform-types']]
  ],
  // Each entrypoint is the Pack's own conformance fixture; the acceptance smoke
  // then runs all seven end to end through the registry and the ledger.
  packs: [
    // registry/runner level: digest, immutability, identity echo, admission
    [`${RUNTIME}/integration/pack.smoke.ts`, []],
    [`${RUNTIME}/integration/builtin-packs.smoke.ts`, []],
    // each shipped collector's own conformance fixture
    ['integrations/packs/claude/conformance.smoke.ts', []],
    ['integrations/packs/cline/conformance.smoke.ts', []],
    ['integrations/packs/codex/conformance.smoke.ts', []],
    ['integrations/packs/devin/conformance.smoke.ts', []],
    ['integrations/packs/grok/conformance.smoke.ts', []],
    ['integrations/packs/opencode/conformance.smoke.ts', []],
    ['integrations/packs/zcode/conformance.smoke.ts', []],
    ['integrations/packs/harness-runtime/conformance.smoke.ts', []],
    ['integrations/packs/providers/builtin-offerings/auth.test.mjs', []],
    ['integrations/packs/providers/builtin-offerings/locators.test.mjs', []],
    ['integrations/packs/providers/builtin-offerings/quota.test.mjs', []],
    ['integrations/all-packs.acceptance.smoke.ts', []]
  ],
  // Renderer-side pure logic (no control plane, no database, no provider API).
  renderer: [
    ['src/renderer/src/workbench/store.smoke.ts', []],
    ['src/renderer/src/shell/tabs.smoke.ts', []],
    ['src/renderer/src/shell/hydration.smoke.ts', []],
    ['src/main/agentEventIngest.smoke.ts', []],
    ['src/main/state/persistence.smoke.ts', []],
    ['src/main/runtime/serviceBootstrap.smoke.ts', []],
    ['src/main/runtime/authResponse.smoke.ts', []],
    ['src/renderer/src/features/sessions/view-model.smoke.ts', []],
    ['src/renderer/src/features/usage/rollup.smoke.ts', []]
  ]
}

function selectedSuites() {
  if (process.argv.includes('--unit-only')) return ['unit']
  if (process.argv.includes('--pipeline-only')) return ['pipeline']
  if (process.argv.includes('--daemon-only')) return ['daemon']
  if (process.argv.includes('--packs-only')) return ['packs']
  if (process.argv.includes('--include-runtime'))
    return ['unit', 'pipeline', 'renderer', 'runtime', 'daemon', 'packs']
  return ['unit', 'pipeline']
}

function run() {
  let failures = 0
  let ran = 0
  // A script may belong to more than one suite (the registry smokes are part of
  // both the pipeline path and the Pack surface). Run it once per invocation so
  // `--include-runtime` neither repeats work nor hides coverage.
  const alreadyRun = new Set()
  for (const suite of selectedSuites()) {
    process.stdout.write(`\n${suite} smoke suite\n`)
    for (const [script, nodeArgs] of SUITES[suite]) {
      const file = join(REPO_ROOT, script)
      if (alreadyRun.has(file)) {
        process.stdout.write(`  -- ${script} (already run in an earlier suite)\n`)
        continue
      }
      alreadyRun.add(file)
      if (!existsSync(file)) {
        process.stderr.write(`  missing smoke script: ${script}\n`)
        failures++
        continue
      }
      const started = Date.now()
      const result = spawnSync(process.execPath, [...nodeArgs, file], {
        cwd: REPO_ROOT,
        stdio: 'inherit'
      })
      ran++
      const elapsed = ((Date.now() - started) / 1000).toFixed(1)
      if (result.status === 0) {
        process.stdout.write(`  ok ${script} (${elapsed}s)\n`)
      } else {
        failures++
        process.stderr.write(`  FAILED ${script} (exit ${String(result.status)})\n`)
      }
    }
  }
  if (failures > 0) {
    process.stderr.write(`\ndomain smoke failed: ${failures} of ${ran} script(s)\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`\ndomain smoke passed: ${ran} script(s)\n`)
}

run()
