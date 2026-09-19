// builtin.harness-runtime conformance + safety fixtures.
//
// Run: node integrations/packs/harness-runtime/conformance.smoke.ts
//
// Everything here is synthetic: a temp config dir for the hook stream, a temp
// HOME with fake CLIs on PATH for the installer engine, and injected IO for the
// session-lock rules. No real harness, credential, CLI config or home directory
// is read or written.
//
// Covered:
//   · Pack registration and identify/launch/resume/wake/maintenance/events runs
//     through the real PackRegistry + runPack (schema validation included)
//   · hook attribution: subagent, internal thread, foreign run and failure
//     banner payloads keep their native identity; the attention projection
//     reproduces the previous user-facing behavior
//   · durable ingest: child sessions keep their parent link, foreign-harness
//     lines are skipped per source, partial lines never advance the cursor
//   · installer safety: displaced user hooks, chained notify, event-file
//     displacement, plugin file sets installed together, legacy rewrite
//   · session-lock safety: flock/pid rules on synthetic locks
//   · the checked-in resources/agents/manifest.json is the Pack projection

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

// imported module-by-module on purpose: the integration barrel is owned by other
// work in flight and a Pack fixture must not depend on its export surface
import { INTEGRATION_SCHEMA_SQL } from '../../../packages/mahas-runtime/src/integration/migration.ts'
import { PackRegistry } from '../../../packages/mahas-runtime/src/integration/registry.ts'
import {
  runPack,
  type PackRunRequest
} from '../../../packages/mahas-runtime/src/integration/runner.ts'
import {
  harnessManifestProjection,
  harnessRuntimeHookScriptPath,
  expandInstallerPath,
  installerTokenContext,
  loadHarnessRuntimePack,
  lockSweepDeclaration,
  resumeCommandText
} from '../../../packages/mahas-harness-config/src/runtime-pack.ts'
import {
  decideSessionLock,
  sweepSessionLocks,
  type SessionLockSweepIo
} from '../../../packages/mahas-harness-config/src/session-locks.ts'
import {
  AgentEventGate,
  EventLogTailer,
  attentionProjection,
  type AgentEventRecord
} from '../../../src/main/eventsFile.ts'
import {
  hookStatuses,
  installHook,
  refreshInstalledHooks,
  type HookInstallerSources
} from '../../../src/main/hookInstallers.ts'

const PACK_DIR = dirname(fileURLToPath(import.meta.url))
const REPO = join(PACK_DIR, '..', '..', '..')
const pack = loadHarnessRuntimePack(PACK_DIR)
const hookScript = harnessRuntimeHookScriptPath(pack)

function scratch(name: string): string {
  return mkdtempSync(join(tmpdir(), 'mahas-harness-' + name + '-'))
}

/* ------------------------------------------------------- registry + runner */

const registryDb = new DatabaseSync(':memory:')
registryDb.exec(INTEGRATION_SCHEMA_SQL)
const registry = new PackRegistry({
  db: registryDb,
  contentRoot: join(scratch('packs'), 'content')
})
const revision = registry.registerDirectory(PACK_DIR)
assert.equal(revision.packId, 'builtin.harness-runtime')
assert.equal(revision.revision, 2, 'pack revision')
assert.ok(revision.contentDigest.length === 64, 'digest recorded')

const target = { kind: 'installation', installationId: 'fixture' } as const
const envelope = (
  capability: string,
  contractId: string,
  payload: Record<string, unknown>,
  operationId: string
): PackRunRequest =>
  ({
    protocolVersion: '1',
    operationId,
    capability,
    target,
    contract: { id: contractId, revision: 1 },
    pack: {
      packId: revision.packId,
      revision: revision.revision,
      contentDigest: revision.contentDigest
    },
    payload
  }) as unknown as PackRunRequest

const actionEnvelope = (
  action: 'discover-sources' | 'collect',
  capability: string,
  contractId: string,
  payload: Record<string, unknown>,
  operationId: string
): PackRunRequest =>
  ({
    protocolVersion: '1',
    operationId,
    action,
    capability,
    target,
    contract: { id: contractId, revision: 1 },
    pack: {
      packId: revision.packId,
      revision: revision.revision,
      contentDigest: revision.contentDigest
    },
    payload
  }) as unknown as PackRunRequest

/* -------------------------------------------------------------- identify */

{
  const result = await runPack(
    registry,
    envelope(
      'identify',
      'mahas.integration.identify',
      { machineId: 'machine-fixture', candidateLocators: ['/usr/bin/claude'] },
      'identify-1'
    )
  )
  assert.equal(result.status, 'success')
  const payload = (
    result as {
      payload: {
        installations: { harnessId: string; presence: string; executableLocator?: string }[]
      }
    }
  ).payload
  const ids = payload.installations.map((row) => row.harnessId)
  assert.ok(ids.includes('claude') && ids.includes('codex'))
  assert.ok(!ids.includes('fake'), 'test-only harness is not an installation candidate')
  assert.equal(payload.installations.find((row) => row.harnessId === 'claude')?.presence, 'present')
}

/* -------------------------------------------------- launch / resume / wake */

{
  const launch = await runPack(
    registry,
    envelope(
      'launch',
      'mahas.integration.launch',
      {
        installationId: 'fixture',
        workingDirectory: '/work',
        inputs: { profileId: 'claude-code' }
      },
      'launch-1'
    )
  )
  assert.equal(launch.status, 'success')
  const payload = (
    launch as {
      payload: {
        support: { pin: Record<string, unknown>; profileRevision: number }
        recipe: { preconditions: string[] }
      }
    }
  ).payload
  assert.equal(payload.support.pin.packId, 'builtin.harness-runtime')
  assert.equal(payload.support.pin.revision, revision.revision)
  assert.equal(payload.support.pin.contentDigest, revision.contentDigest)
  assert.equal(payload.support.pin.implementationId, 'harness-runtime.launch.v2')
  assert.equal(payload.support.profileRevision, 1)
  assert.ok(
    payload.recipe.preconditions.some(
      (line) =>
        line.includes('pack:builtin.harness-runtime@') && line.includes(revision.contentDigest)
    ),
    'the recipe carries the pinned revision digest'
  )

  const unknown = await runPack(
    registry,
    envelope(
      'launch',
      'mahas.integration.launch',
      {
        installationId: 'fixture',
        workingDirectory: '/work',
        inputs: { profileId: 'no-such-profile' }
      },
      'launch-2'
    )
  )
  assert.equal(unknown.status, 'failed', 'an unknown profile is never substituted')
  assert.ok(unknown.diagnostics.some((d) => d.code === 'profile.unknown'))
}

{
  const supported = await runPack(
    registry,
    envelope(
      'resume',
      'mahas.integration.resume',
      {
        installationId: 'fixture',
        sessionHandle: { harnessId: 'claude', nativeId: 'sess-1' },
        workingDirectory: '/work'
      },
      'resume-1'
    )
  )
  assert.equal(supported.status, 'success')
  const payload = (
    supported as {
      payload: { support: string; recipe: { args: string[]; preconditions: string[] } }
    }
  ).payload
  assert.equal(payload.support, 'supported')
  assert.deepEqual(payload.recipe.args, ['--resume', 'sess-1'])
  assert.ok(payload.recipe.preconditions.some((line) => line.includes(revision.contentDigest)))

  const noId = await runPack(
    registry,
    envelope(
      'resume',
      'mahas.integration.resume',
      { installationId: 'fixture', sessionHandle: { harnessId: 'claude' } },
      'resume-2'
    )
  )
  assert.equal((noId as { payload: { support: string } }).payload.support, 'unknown')

  const child = await runPack(
    registry,
    envelope(
      'resume',
      'mahas.integration.resume',
      {
        installationId: 'fixture',
        sessionHandle: { harnessId: 'claude', nativeId: 'sub-1', policy: { stripSession: true } }
      },
      'resume-3'
    )
  )
  assert.equal((child as { payload: { support: string } }).payload.support, 'unsupported')

  const wake = await runPack(
    registry,
    envelope(
      'wake',
      'mahas.integration.wake',
      { installationId: 'fixture', sessionHandle: {}, input: 'deliver queued work' },
      'wake-1'
    )
  )
  assert.equal(wake.status, 'success')
  assert.equal((wake as { payload: { support: string } }).payload.support, 'unsupported')
}

/* ---------------------------------------------------------- maintenance */

{
  const install = await runPack(
    registry,
    envelope(
      'maintenance',
      'mahas.integration.maintenance',
      {
        installationId: 'fixture',
        action: 'install-hook',
        target: { harnessId: 'claude' },
        dryRun: false
      },
      'maint-1'
    )
  )
  assert.equal(install.status, 'success')
  const payload = (
    install as {
      payload: {
        applicable: boolean
        effects: { neverAutoInstalls: boolean; installer: { kind: string } }[]
      }
    }
  ).payload
  assert.equal(payload.applicable, true)
  assert.equal(payload.effects[0]!.neverAutoInstalls, true)
  assert.equal(payload.effects[0]!.installer.kind, 'json-hooks')

  const devin = await runPack(
    registry,
    envelope(
      'maintenance',
      'mahas.integration.maintenance',
      {
        installationId: 'fixture',
        action: 'sweep-session-locks',
        target: { harnessId: 'devin' },
        dryRun: true
      },
      'maint-2'
    )
  )
  assert.equal((devin as { payload: { applicable: boolean } }).payload.applicable, true)
  assert.deepEqual(
    (devin as { payload: { effects: { safety: string[] }[] } }).payload.effects[0]!.safety,
    ['flock-absent', 'recorded-pid-dead-or-not-harness']
  )

  const claude = await runPack(
    registry,
    envelope(
      'maintenance',
      'mahas.integration.maintenance',
      {
        installationId: 'fixture',
        action: 'sweep-session-locks',
        target: { harnessId: 'claude' },
        dryRun: true
      },
      'maint-3'
    )
  )
  assert.equal((claude as { payload: { applicable: boolean } }).payload.applicable, false)
}

/* ------------------------------------------------ hook attribution fixture */

const configDir = scratch('cfg')
const eventsFile = join(configDir, 'agent-events.log')

interface EmitInput {
  provider: string
  payload: Record<string, unknown>
  env?: Record<string, string>
}

function emitHook(input: EmitInput): void {
  const result = spawnSync(process.execPath, [hookScript, input.provider], {
    input: JSON.stringify(input.payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: configDir,
      MAHAS_CONFIG_DIR: configDir,
      MAHAS_EVENTS_FILE: eventsFile,
      MAHAS_SESSION: 'run-fixture',
      MAHAS_PANE: 'pane-1',
      MAHAS_TAB: 'tab-1',
      ...(input.env ?? {})
    }
  })
  assert.equal(result.status, 0, 'transport must always exit 0: ' + result.stderr)
}

emitHook({
  provider: 'claude',
  payload: { hook_event_name: 'SessionStart', session_id: 'sess-A', cwd: '/work' }
})
emitHook({
  provider: 'claude',
  payload: {
    hook_event_name: 'Stop',
    session_id: 'sess-A',
    cwd: '/work',
    'last-assistant-message': 'turn finished'
  }
})
emitHook({
  provider: 'claude',
  payload: {
    hook_event_name: 'SubagentStop',
    session_id: 'sub-B',
    parent_agent_id: 'sess-A',
    cwd: '/work'
  }
})
emitHook({
  provider: 'codex',
  payload: {
    hook_event_name: 'Stop',
    'thread-id': 'thr-X',
    'input-messages': ['Write a brief catch-up'],
    'last-assistant-message': 'ok'
  }
})
emitHook({
  provider: 'grok',
  payload: {
    hook_event_name: 'Stop',
    session_id: 'sess-A',
    reason: 'rate_limit',
    'last-assistant-message': '[Error] rate limited'
  }
})
emitHook({
  provider: 'claude',
  payload: {
    hook_event_name: 'Notification',
    session_id: 'sess-A',
    notification_type: 'permission_prompt',
    message: 'allow bash?'
  }
})
// an agent running outside mahas: no MAHAS_SESSION
emitHook({
  provider: 'grok',
  payload: { hook_event_name: 'Stop', session_id: 'foreign-1', cwd: '/elsewhere' },
  env: { MAHAS_SESSION: '', MAHAS_PANE: '', MAHAS_TAB: '' }
})

const lines = readFileSync(eventsFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Record<string, unknown>)

assert.equal(lines.length, 7, 'every transport invocation is recorded')
const byNative = (native: string, sessionId?: string): Record<string, unknown> => {
  const found = lines.find(
    (line) =>
      line.nativeEvent === native && (sessionId === undefined || line.sessionId === sessionId)
  )
  assert.ok(found, 'missing ' + native)
  return found!
}

const subagent = byNative('SubagentStop')
assert.equal(subagent.child, true, 'subagent identity is preserved')
assert.equal(subagent.sessionId, 'sub-B', 'subagent session id survives to the durable record')
assert.equal(subagent.parentSessionId, 'sess-A')
assert.equal(subagent.event, 'other', 'subagent turns are not user-facing signals')
assert.deepEqual(subagent.policy, { demote: true, stripSession: true })

const internal = byNative('Stop', 'thr-X')
assert.equal(internal.internalRun, true)
assert.equal(internal.demotedFrom, 'turn-complete')

const foreign = byNative('Stop', 'foreign-1')
assert.equal(foreign.external, true, 'a run without MAHAS_SESSION is marked external')
assert.equal(foreign.mahasSession, undefined)

const failure = lines.find((line) => line.provider === 'grok' && line.event === 'error')
assert.ok(failure, 'the rate-limit banner classifies as error')

// attention projection reproduces the previous user-facing behavior, while the
// durable line keeps the identity it was built from
const projectedChild = attentionProjection(subagent as never) as Record<string, unknown>
assert.equal(projectedChild.sessionId, undefined, 'child runs never claim a resume record')
assert.equal(projectedChild.event, 'other')
const projectedTurn = attentionProjection(byNative('Stop', 'sess-A') as never) as Record<
  string,
  unknown
>
assert.equal(projectedTurn.sessionId, 'sess-A', 'ordinary turns keep their session claim')
assert.equal(projectedTurn.event, 'turn-complete')

/* --------------------------------------------------------- durable ingest */

{
  const discover = await runPack(
    registry,
    actionEnvelope(
      'discover-sources',
      'events',
      'mahas.integration.events',
      {
        installationId: 'fixture',
        configNamespace: 'claude',
        dataNamespace: configDir,
        capability: 'events'
      },
      'events-discover'
    )
  )
  assert.equal(discover.status, 'success')
  const source = (discover as { payload: { sources: Record<string, unknown>[] } }).payload
    .sources[0]!
  assert.equal(source.kind, 'hook-stream')
  assert.equal((source.locator as Record<string, unknown>).harnessId, 'claude')

  // a partial last line must not advance the cursor
  writeFileSync(
    eventsFile,
    '{"provider":"claude","event":"turn-complete","sessionId":"sess-A","nativeEvent":"Stop"}',
    { flag: 'a' }
  )

  const collect = async (
    cursor: Record<string, unknown>,
    maxRecords = 50
  ): Promise<Record<string, unknown>> => {
    const result = await runPack(
      registry,
      actionEnvelope(
        'collect',
        'events',
        'mahas.integration.events',
        {
          installationId: 'fixture',
          source,
          cursor,
          maxRecords,
          maxBytes: 1_000_000,
          deadlineAt: Date.now() + 10_000
        },
        'events-collect'
      )
    )
    assert.equal(result.status, 'success')
    return (result as { payload: Record<string, unknown> }).payload
  }

  const first = await collect({})
  const firstEvents = first.events as Record<string, unknown>[]
  assert.equal(firstEvents.length, 4, "only this harness' events are collected")
  assert.equal(
    (first.coverage as Record<string, unknown>).gapReason,
    'incomplete-trailing-record',
    'an unfinished trailing line is reported, not consumed'
  )
  assert.equal(first.exhausted, false)
  const childEvent = firstEvents.find(
    (event) => (event.payload as Record<string, unknown>).child === true
  )
  assert.ok(childEvent, 'child event is ingested')
  const childPayload = childEvent.payload as Record<string, unknown>
  assert.equal(childPayload.parentNativeSessionId, 'sess-A')
  assert.equal(childPayload.externalRun, false)
  assert.deepEqual(childPayload.policy, { demote: true, stripSession: true })
  assert.equal(childEvent.sessionNativeKey, 'sub-B')

  const childSessions = (first.sessions as Record<string, unknown>[]).filter(
    (row) => row.nativeSessionKey === 'sub-B'
  )
  assert.equal(childSessions.length, 1)
  assert.equal(
    childSessions[0]!.parentNativeSessionKey,
    'sess-A',
    'child session keeps its parent link'
  )
  assert.equal((childSessions[0]!.metadata as Record<string, unknown>).child, true)
  assert.ok(
    (first.sessions as Record<string, unknown>[]).some((row) => row.nativeSessionKey === 'sess-A'),
    'the parent session row travels with the child link'
  )
  const subHandle = (first.handles as Record<string, unknown>[]).find(
    (row) => row.sessionNativeKey === 'sub-B'
  )!
  assert.equal(subHandle.resumeSupport, 'unsupported', 'a child run is not a resume target')
  assert.equal((subHandle.locator as Record<string, unknown>).child, true)

  assert.equal(
    (first.diagnostics as Record<string, unknown>[]).some(
      (d) => d.code === 'events.foreign-harness-skipped'
    ),
    true,
    'lines from another harness are skipped for this source'
  )

  // the same shared stream, scoped to another harness: the run that had no
  // MAHAS_SESSION is collected as an external session — exclusion from
  // notifications is a policy decision, not a collection filter
  const grokSource = (
    (await runPack(
      registry,
      actionEnvelope(
        'discover-sources',
        'events',
        'mahas.integration.events',
        // the same installation, scoped to another harness: a hook stream is
        // shared, so the harness id travels in the source's config namespace
        {
          installationId: 'fixture',
          configNamespace: 'grok',
          dataNamespace: configDir,
          capability: 'events'
        },
        'events-discover-grok'
      )
    )) as { payload: { sources: Record<string, unknown>[] } }
  ).payload.sources[0]!
  const grokCollect = (
    (await runPack(
      registry,
      actionEnvelope(
        'collect',
        'events',
        'mahas.integration.events',
        {
          installationId: 'fixture',
          source: grokSource,
          cursor: {},
          maxRecords: 50,
          maxBytes: 1_000_000,
          deadlineAt: Date.now() + 10_000
        },
        'events-collect-grok'
      )
    )) as { payload: Record<string, unknown> }
  ).payload
  const externalEvent = (grokCollect.events as Record<string, unknown>[]).find(
    (event) => (event.payload as Record<string, unknown>).externalRun === true
  )
  assert.ok(externalEvent, 'foreign runs are collected with their identity intact')
  const externalHandle = (grokCollect.handles as Record<string, unknown>[]).find(
    (row) => row.sessionNativeKey === 'foreign-1'
  )!
  assert.equal(
    externalHandle.resumeSupport,
    'unknown',
    'an external run is not claimed as resumable and not declared unsupported'
  )
  assert.equal(
    (grokCollect.sessions as Record<string, unknown>[]).some(
      (row) => row.nativeSessionKey === 'foreign-1'
    ),
    true,
    'the external session is preserved'
  )

  // completing the partial line and replaying from the returned cursor consumes
  // exactly that line
  writeFileSync(eventsFile, '\n', { flag: 'a' })
  const second = await collect(first.nextCursor as Record<string, unknown>)
  assert.equal((second.events as unknown[]).length, 1)
  assert.equal(second.exhausted, true)
}

/* -------------------------------------------------------- installer safety */

{
  const home = scratch('home')
  const cfgHome = join(home, '.config')
  const binDir = join(home, 'bin')
  mkdirSync(binDir, { recursive: true })
  for (const bin of ['claude', 'codex', 'grok', 'devin', 'zcode', 'cline', 'opencode']) {
    const file = join(binDir, bin)
    writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 })
    chmodSync(file, 0o755)
  }
  process.env.PATH = binDir + ':' + (process.env.PATH ?? '')
  process.env.XDG_CONFIG_HOME = cfgHome
  delete process.env.MAHAS_CONFIG_DIR
  const sources: HookInstallerSources = { pack, hookScriptPath: hookScript }

  // claude: an existing user hook group plus a legacy ade-hook group
  mkdirSync(join(home, '.claude'), { recursive: true })
  const claudeSettings = {
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'node "/home/u/.config/ade/ade-hook.cjs" claude' }] },
        { hooks: [{ type: 'command', command: 'echo user-hook' }] }
      ]
    }
  }
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(claudeSettings, null, 2))

  const claudeInstall = installHook('claude', sources, home)
  assert.equal(claudeInstall.ok, true)
  const claudeText = readFileSync(join(home, '.claude', 'settings.json'), 'utf8')
  assert.ok(!claudeText.includes('ade-hook'), 'the legacy pointer is replaced')
  assert.ok(claudeText.includes('echo user-hook'), 'the user hook group is kept')
  assert.ok(
    claudeText.includes('mahas-hook'),
    'the transport is installed for every declared event'
  )
  assert.ok(
    existsSync(join(home, '.claude', 'settings.json.mahas-bak')),
    'the mutated file is backed up'
  )

  // codex: a displaced notify command is recorded and chained
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(
    join(home, '.codex', 'config.toml'),
    'notify = ["old-cmd", "--flag"]\nmodel = "x"\n'
  )
  assert.equal(installHook('codex', sources, home).ok, true)
  const forwarded = JSON.parse(readFileSync(join(cfgHome, 'mahas', 'notify-forward.json'), 'utf8'))
  assert.deepEqual(forwarded.codex, ['old-cmd', '--flag'])
  const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
  assert.ok(/^notify = \["node", ".*mahas-hook\.cjs", "codex"\]$/m.test(toml), toml)

  // cline: a displaced user event file is kept and chained
  mkdirSync(join(home, '.cline', 'hooks'), { recursive: true })
  writeFileSync(join(home, '.cline', 'hooks', 'TaskComplete'), '#!/bin/sh\necho user\n', {
    mode: 0o755
  })
  assert.equal(installHook('cline', sources, home).ok, true)
  const clineHook = readFileSync(join(home, '.cline', 'hooks', 'TaskComplete'), 'utf8')
  assert.ok(clineHook.includes('mahas-bak'), 'the displaced user hook is chained')
  assert.equal(
    readFileSync(join(home, '.cline', 'hooks', 'TaskComplete.mahas-bak'), 'utf8').includes(
      'echo user'
    ),
    true
  )
  assert.equal(
    statSync(join(home, '.cline', 'hooks', 'TaskComplete')).mode & 0o111 ? true : false,
    true
  )

  // opencode: a partial install (entry file only) is detected and repaired —
  // the entry cannot resolve ./opencode-runtime.js on its own
  const plugins = join(cfgHome, 'opencode', 'plugins')
  mkdirSync(plugins, { recursive: true })
  writeFileSync(
    join(plugins, 'mahas-events.js'),
    readFileSync(join(PACK_DIR, 'hooks', 'mahas-opencode-plugin.js'), 'utf8')
  )
  const partial = hookStatuses(sources, home).find((s) => s.id === 'opencode')!
  assert.equal(partial.installed, false, 'a plugin set missing its dependency is not installed')
  assert.ok((partial.detail ?? '').includes('opencode-runtime.js'))
  assert.equal(installHook('opencode', sources, home).ok, true)
  assert.equal(
    readFileSync(join(plugins, 'opencode-runtime.js'), 'utf8'),
    readFileSync(join(PACK_DIR, 'hooks', 'opencode-runtime.js'), 'utf8'),
    'dependencies install together'
  )
  const repaired = hookStatuses(sources, home)
  assert.equal(repaired.find((s) => s.id === 'opencode')!.installed, true)
  assert.equal(
    repaired.every((s) => typeof s.mechanism === 'string' && s.mechanism.length > 0),
    true
  )

  // refresh: a legacy devin pointer is rewritten without a click; a status
  // listing never invents installers for CLIs the Pack does not declare
  mkdirSync(join(cfgHome, 'devin'), { recursive: true })
  writeFileSync(
    join(cfgHome, 'devin', 'config.json'),
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/old/ade-hook.cjs" devin' }] }] }
    })
  )
  refreshInstalledHooks(sources, home)
  assert.ok(!readFileSync(join(cfgHome, 'devin', 'config.json'), 'utf8').includes('ade-hook'))
  assert.equal(
    hookStatuses(sources, home).some((s) => s.id === 'gemini'),
    false,
    'a harness without an installer is absent, not guessed'
  )
}

/* ---------------------------------------------------------- lock safety */

{
  assert.equal(decideSessionLock({ flockHeld: true, pid: 10, holderAlive: false }), 'keep')
  assert.equal(decideSessionLock({ flockHeld: false, pid: 10, holderAlive: true }), 'keep')
  assert.equal(decideSessionLock({ flockHeld: false, pid: 10, holderAlive: false }), 'remove')
  assert.equal(decideSessionLock({ flockHeld: false, pid: null, holderAlive: false }), 'remove')

  const declaration = lockSweepDeclaration(pack, 'devin')
  assert.ok(declaration, 'devin declares a session-lock sweep')
  assert.equal(declaration!.lockPattern, '*.lock')
  assert.equal(
    lockSweepDeclaration(pack, 'claude'),
    null,
    'a harness without the declaration is not swept'
  )
  assert.equal(
    expandInstallerPath(
      declaration!.lockDirTemplate,
      installerTokenContext({ home: '/home/u', hookScriptPath: '', harnessId: 'devin' })
    ),
    '/home/u/.local/share/devin/cli/session_locks',
    'the declared lock directory resolves from the shared tokens'
  )

  const lockDir = '/synthetic/session_locks'
  const removed: string[] = []
  const io: SessionLockSweepIo = {
    list: () => ['held.lock', 'dead.lock', 'alive.lock', 'nopid.lock', 'broken.lock', 'notes.txt'],
    inode: (file) =>
      ['held.lock', 'dead.lock', 'alive.lock', 'nopid.lock', 'broken.lock'].indexOf(
        file.split('/').pop()!
      ) + 1,
    read: (file) => {
      const name = file.split('/').pop()
      if (name === 'broken.lock') return null
      if (name === 'nopid.lock') return 'not-a-pid'
      if (name === 'alive.lock') return '4242'
      return '7777'
    },
    flockHeld: (inode) => inode === 1,
    pidIsLiveHolder: (pid) => pid === 4242,
    unlink: (file) => {
      removed.push(file.split('/').pop()!)
    }
  }
  const verdicts = sweepSessionLocks(
    {
      harnessId: declaration!.harnessId,
      lockDir: lockDir,
      lockPattern: declaration!.lockPattern,
      holder: declaration!.holder
    },
    io
  )
  assert.deepEqual(
    removed.sort(),
    ['dead.lock', 'nopid.lock'],
    'only provably-dead holders are dropped'
  )
  assert.equal(verdicts.find((v) => v.file.endsWith('held.lock'))?.reason, 'flock-held')
  assert.equal(verdicts.find((v) => v.file.endsWith('alive.lock'))?.reason, 'holder-alive')
  assert.equal(verdicts.find((v) => v.file.endsWith('broken.lock'))?.reason, 'unreadable')
  assert.equal(
    verdicts.some((v) => v.file.endsWith('notes.txt')),
    false,
    'unrelated files are ignored'
  )
}

/* -------------------------------------------------- projection and parity */

{
  const manifestPath = join(REPO, 'resources', 'agents', 'manifest.json')
  // composition resolves the active hook transport from the Pack metadata, so
  // these keys are part of the contract, not documentation
  assert.equal(pack.installers.runtime.hookScript, 'hooks/mahas-hook.cjs')
  const packMetadata = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8')).pack
    .metadata as Record<string, unknown>
  assert.equal(packMetadata.hookTransportResource, 'hooks/mahas-hook.cjs')
  assert.equal(packMetadata.hookCapability, 'events')
  assert.equal(packMetadata.hookTransportGeneration, 'ndjson-v2')
  assert.deepEqual(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
    harnessManifestProjection(pack),
    'resources/agents/manifest.json must be the Pack projection (run integrations/packs/harness-runtime/project.mjs)'
  )
  const script = readFileSync(hookScript, 'utf8')
  for (const [id, harness] of Object.entries(pack.harnesses)) {
    for (const signal of harness.envSignals ?? []) {
      assert.ok(script.includes(signal), 'transport must know ' + id + "'s env signal " + signal)
    }
    for (const signal of harness.payloadSignals ?? []) {
      assert.ok(script.includes(signal), 'transport must know ' + id + "'s payload field " + signal)
    }
    if (harness.hooks) {
      const installer = pack.installers.byId[harness.hooks]
      assert.ok(installer, 'harness ' + id + ' declares a missing installer')
      assert.equal(installer!.harnessId, id, 'installer ' + id + ' belongs to another harness')
    }
    if (harness.resume) {
      // the projection keeps both shapes and they must produce the same command
      const viaRecipe = resumeCommandText(harness.resume, "a'b")
      const viaLegacy = resumeCommandText(
        {
          executable: harness.resume.executable,
          args: harness.resume.args?.filter((a) => !a.includes('$' + '{sessionId}'))
        },
        "a'b"
      )
      assert.equal(viaRecipe, viaLegacy, 'resume recipe shapes disagree for ' + id)
      assert.ok((viaRecipe ?? '').includes("'a'\\''b'"), 'session id quoting changed for ' + id)
    }
  }
}

/* ------------------------------------------- durable relay and replay fixture */

/** byte offset of the START of each line (the contract both readers share) */
function lineStartOffsets(text: string): number[] {
  const offsets: number[] = []
  let offset = 0
  for (const line of text.split('\n')) {
    if (!line) break
    offsets.push(offset)
    offset += Buffer.byteLength(line) + 1
  }
  return offsets
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs)
      throw new Error('fixture timed out waiting for a condition')
    await wait(25)
  }
}

{
  // the collector's offsets are byte STARTS, matching the desktop tailer
  const relayDir = scratch('relay')
  const relayFile = join(relayDir, 'agent-events.log')
  const lines = [
    { provider: 'claude', event: 'session-start', sessionId: 'r-1', nativeEvent: 'SessionStart' },
    { provider: 'claude', event: 'turn-complete', sessionId: 'r-1', nativeEvent: 'Stop' }
  ]
  const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  writeFileSync(relayFile, text)
  const expected = lineStartOffsets(text)
  const collected = (
    (await runPack(
      registry,
      actionEnvelope(
        'collect',
        'events',
        'mahas.integration.events',
        {
          installationId: 'fixture',
          source: {
            sourceKey: 'hook:fixture:claude',
            kind: 'hook-stream',
            locator: { path: relayFile, harnessId: 'claude' },
            generation: 'ndjson-v2',
            identityEvidence: {}
          },
          cursor: {},
          maxRecords: 10,
          maxBytes: 1_000_000,
          deadlineAt: Date.now() + 10_000
        },
        'events-offsets'
      )
    )) as { payload: Record<string, unknown> }
  ).payload
  assert.deepEqual(
    (collected.events as Record<string, unknown>[]).map((event) => event.sourceRecordKey),
    expected.map((offset) => 'hook:fixture:claude:' + offset + ':r-1'),
    'collector offsets are line-start byte offsets'
  )

  // crash backlog: the tailer resumes from its persisted cursor instead of EOF
  const cursorFile = join(relayDir, 'hook-tail-cursor.json')
  const firstSeen: string[] = []
  const firstTailer = new EventLogTailer(
    relayFile,
    (event) => firstSeen.push(event.sessionId ?? '?'),
    undefined,
    undefined,
    { cursorFile }
  )
  firstTailer.start()
  writeFileSync(
    relayFile,
    JSON.stringify({ provider: 'claude', event: 'turn-complete', sessionId: 'r-2' }) + '\n',
    { flag: 'a' }
  )
  await waitFor(() => firstSeen.length === 1)
  firstTailer.stop()

  // mahas is down while the harness keeps emitting
  writeFileSync(
    relayFile,
    JSON.stringify({ provider: 'claude', event: 'turn-complete', sessionId: 'r-3' }) + '\n',
    { flag: 'a' }
  )
  const replayed: string[] = []
  const secondTailer = new EventLogTailer(
    relayFile,
    (event) => replayed.push(event.sessionId ?? '?'),
    undefined,
    undefined,
    { cursorFile }
  )
  secondTailer.start()
  await waitFor(() => replayed.length >= 1)
  assert.equal(replayed[0], 'r-3', 'events written while mahas was down are replayed')
  secondTailer.stop()

  // rotation: the generation moves so a reused offset cannot collide
  const rotated: string[] = []
  const thirdTailer = new EventLogTailer(
    relayFile,
    (event) => rotated.push(event.sourceRecordKey ?? ''),
    undefined,
    undefined,
    { cursorFile }
  )
  thirdTailer.start()
  writeFileSync(relayFile, '')
  writeFileSync(
    relayFile,
    JSON.stringify({ provider: 'claude', event: 'turn-complete', sessionId: 'r-4' }) + '\n'
  )
  await waitFor(() => rotated.length >= 1)
  thirdTailer.stop()
  assert.match(rotated[rotated.length - 1]!, /#2:0$/, 'a truncated stream advances the generation')
}

{
  // the gate: nothing reaches attention before a durable ack
  const records: AgentEventRecord[] = ['k1', 'k2'].map((key, index) => ({
    sourceRecordKey: key,
    file: '/fixture/agent-events.log',
    offset: index * 10,
    generation: 1,
    raw: '{}',
    event: { provider: 'claude', event: 'turn-complete', sessionId: 's-' + index }
  }))
  const delivered: string[] = []
  const dropped: [string, string][] = []
  let mode: 'unavailable' | 'commit' | 'reject' = 'unavailable'
  const gate = new AgentEventGate({
    port: {
      name: 'fixture',
      ingest: async () => {
        if (mode === 'commit') return { committed: true }
        if (mode === 'reject')
          return { committed: false, retryable: false, reason: 'contract rejected' }
        return {
          committed: false,
          unavailable: true,
          reason: 'session.hook.ingest is not registered'
        }
      }
    },
    onCommitted: (record) => delivered.push(record.sourceRecordKey),
    onDropped: (record, reason) => dropped.push([record.sourceRecordKey, reason]),
    retryDelaysMs: [5]
  })
  gate.enqueue(records[0]!)
  gate.enqueue(records[1]!)
  await wait(120)
  assert.equal(delivered.length, 0, 'an unavailable ingest never delivers')
  assert.equal(gate.stats().pending, 2, 'records wait for the ack')
  mode = 'commit'
  await waitFor(() => delivered.length === 2)
  assert.deepEqual(delivered, ['k1', 'k2'], 'delivery follows the ack in order')
  mode = 'reject'
  gate.enqueue(records[0]!)
  await waitFor(() => dropped.length === 1)
  assert.equal(delivered.length, 2, 'a rejected record is never delivered')
  assert.equal(gate.stats().dropped, 1)
  gate.stop()
}

for (const dir of [configDir]) rmSync(dir, { recursive: true, force: true })
console.log(
  'harness runtime pack fixtures passed (' +
    Object.keys(pack.harnesses).length +
    ' harnesses, ' +
    Object.keys(pack.installers.byId).length +
    ' installers)'
)
