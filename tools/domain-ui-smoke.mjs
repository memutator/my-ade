#!/usr/bin/env node
// Built desktop → real daemon/collector → stored domain API → rendered widgets.
// Synthetic logs and an unavailable credential locator only; no provider calls or real secrets.
//   node tools/domain-ui-smoke.mjs
//   node tools/domain-ui-smoke.mjs --app /path/to/linux-unpacked/mahas
// Linux /proc identities keep cleanup confined to this fixture, including the
// detached services that intentionally survive closing an Electron window.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
assert(args.length === 0 || (args.length === 2 && args[0] === '--app'),
  'usage: node tools/domain-ui-smoke.mjs [--app /path/to/executable]')
assert.equal(process.platform, 'linux', 'fixture cleanup requires Linux process identities')
assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ required by the daemon')
const executable = args.length ? resolve(args[1]) : createRequire(import.meta.url)('electron')
assert(existsSync(executable), `missing executable: ${executable}`)
if (!args.length) assert(existsSync(join(ROOT, 'out/main/index.js')), 'build the app first')

const scratch = mkdtempSync(join(tmpdir(), 'mahas-domain-ui-'))
const configHome = join(scratch, 'config')
const configDir = join(configHome, 'mahas')
const fixtureHome = join(configDir, 'test-home')
const project = join(scratch, 'synthetic-project')
const sessionId = '11111111-2222-3333-4444-555555555555'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
let child, ws, tracker, spawnError
let electronLog = ''
let checks = 0
let failed = 0
const renderErrors = []
const tracked = new Map()
const services = new Map()
const pending = new Map()

function check(condition, label) {
  checks++
  if (!condition) failed++
  console.log(`  ${condition ? '✓' : '✗'} ${label}`)
}

function proc(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
    return { pid, state: fields[0], parent: Number(fields[1]), birth: fields[19] }
  } catch { return null }
}

function alive(identity) {
  const current = proc(identity.pid)
  // A zombie has exited and cannot write files; its parent owns reaping it.
  return current?.birth === identity.birth && !['Z', 'X'].includes(current.state)
}

function remember(identity) {
  if (identity) tracked.set(`${identity.pid}:${identity.birth}`, identity)
}

function trackProcesses() {
  const snapshot = readdirSync('/proc').filter((name) => /^\d+$/.test(name))
    .map((name) => proc(Number(name))).filter(Boolean)
  const owned = new Set([...tracked.values()].filter(alive).map((p) => p.pid))
  // Exact spawn receipts cover the interval before endpoint publication.
  // Only inspect argv for PIDs recorded in this fixture's bootstrap log.
  try {
    const log = readFileSync(join(configDir, 'logs/desktop-bootstrap.log'), 'utf8')
    for (const match of log.matchAll(/spawned (?:mahasd|execution-host) pid=(\d+)/g)) {
      const identity = proc(Number(match[1]))
      if (!identity) continue
      try {
        const argv = readFileSync(`/proc/${identity.pid}/cmdline`, 'utf8').split('\0')
        if (argv.some((arg, i) => arg === '--config-dir' && argv[i + 1] === configDir)) {
          remember(identity)
          owned.add(identity.pid)
        }
      } catch { /* process exited during the snapshot */ }
    }
  } catch { /* bootstrap has not spawned services yet */ }
  let changed = true
  while (changed) {
    changed = false
    for (const identity of snapshot) {
      if (!owned.has(identity.pid) && owned.has(identity.parent)) {
        remember(identity)
        owned.add(identity.pid)
        changed = true
      }
    }
  }
  for (const filename of ['mahasd.endpoint.json', 'execution-host.sock.endpoint.json']) {
    try {
      const endpoint = JSON.parse(readFileSync(join(configDir, filename), 'utf8'))
      const identity = endpoint.processIdentity ?? endpoint
      const live = proc(identity.pid)
      assert(endpoint.endpoint.startsWith(`${configDir}/`), 'service endpoint escaped fixture')
      assert(live && String(identity.birthEvidence) === live.birth, 'service identity mismatch')
      assert.equal(identity.bootId, readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim())
      remember(live)
      services.set(filename, { pid: live.pid, birth: live.birth, endpoint: endpoint.endpoint })
    } catch (error) {
      // Missing or stale endpoints are normal during startup/shutdown. An
      // unverified endpoint never supplies a PID for cleanup.
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        services.delete(filename)
      }
    }
  }
}

async function cleanup() {
  clearInterval(tracker)
  for (const request of pending.values()) request.reject(new Error('fixture shutting down'))
  pending.clear()
  ws?.close()
  // Stop Electron and service roots gracefully, then any surviving descendants.
  // Refresh identity checks before every signal, so PID reuse never hits a peer.
  for (const [signal, budget] of [['SIGTERM', 5000], ['SIGKILL', 3000]]) {
    const deadline = Date.now() + budget
    do {
      trackProcesses()
      const running = [...tracked.values()].filter(alive)
      if (!running.length) {
        rmSync(scratch, { recursive: true, force: true })
        console.log(`  ✓ cleanup: ${tracked.size} tracked processes exited; scratch removed`)
        return
      }
      for (const identity of running) {
        if (!alive(identity)) continue
        try { process.kill(identity.pid, signal) } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
      await sleep(100)
    } while (Date.now() < deadline)
  }
  throw new Error(`fixture processes still alive; retained ${scratch}: ` +
    [...tracked.values()].filter(alive).map((p) => `${p.pid}:${p.birth}`).join(', '))
}

async function until(work, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  let last
  do {
    if (spawnError) throw spawnError
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`Electron exited before ${label}: ${child.exitCode ?? child.signalCode}`)
    }
    last = await work()
    if (last) return last
    await sleep(200)
  } while (Date.now() < deadline)
  throw new Error(`timed out: ${label}`)
}

async function freePort() {
  const server = createServer()
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const port = server.address().port
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()))
  return port
}

let sequence = 0
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP timed out: ${method}`))
    }, 12000)
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (error) => { clearTimeout(timer); reject(error) }
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (reply.exceptionDetails) throw new Error(`renderer evaluation: ${JSON.stringify(reply.exceptionDetails)}`)
  return reply.result?.value
}

async function stored(method, request) {
  return evaluate(`window.mahas.domain[${JSON.stringify(method)}](${JSON.stringify(request) ?? ''})`)
}

async function openWidget(widget) {
  return evaluate(`(() => {
    const store = window.__mahasTest.getState()
    const wsId = store.activeWorkspaceId
    store.newBlock('widget', wsId, ${JSON.stringify(widget)})
    const workspace = window.__mahasTest.getState().workspaces.find(w => w.id === wsId)
    const pane = Object.values(workspace.panes).find(p => p.tabs.some(t => t.widget === ${JSON.stringify(widget)}))
    return pane.tabs.find(t => t.widget === ${JSON.stringify(widget)}).id
  })()`)
}

async function run() {
  for (const directory of [fixtureHome, project, configHome, join(scratch, 'data'),
    join(scratch, 'cache'), join(scratch, 'state'), join(scratch, 'runtime')]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  // Same small session_meta/token_count fixture as codex/conformance.smoke.ts.
  // Move it inside a completed week so the rolling statistics have a stable
  // window. Missing reasoning/cache-write fields intentionally remain unknown.
  const at = new Date()
  at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7) - 7)
  at.setUTCHours(12, 0, 0, 0)
  const sourceDir = join(fixtureHome, '.codex', 'sessions', 'fixture')
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(sourceDir, `rollout-${sessionId}.jsonl`), [
    { type: 'session_meta', timestamp: at.toISOString(), payload: { id: sessionId, cwd: project } },
    { type: 'event_msg', timestamp: new Date(at.getTime() + 5000).toISOString(), payload: {
      type: 'token_count', model: 'gpt-5', info: { total_token_usage: {
        input_tokens: 10, output_tokens: 4, total_tokens: 14, cached_input_tokens: 6
      } }
    } }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')

  // Preseed favicon cache with a synthetic one-pixel PNG: brand rendering
  // should exercise the real icon IPC without making any external requests.
  const icons = join(configDir, 'agent-icons')
  mkdirSync(icons, { recursive: true })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  for (const id of Object.keys(JSON.parse(readFileSync(join(ROOT, 'resources/agents/manifest.json'), 'utf8')))) {
    writeFileSync(join(icons, `${id}.img`), png)
  }
  // Allowlist desktop transport variables only. In particular, do not inherit
  // CODEX_HOME, credential/provider env, runtime endpoints, or a real XDG home.
  const env = Object.fromEntries(['DISPLAY', 'XAUTHORITY'].filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]))
  Object.assign(env, {
    HOME: fixtureHome, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: join(scratch, 'data'),
    XDG_CACHE_HOME: join(scratch, 'cache'), XDG_STATE_HOME: join(scratch, 'state'),
    XDG_RUNTIME_DIR: join(scratch, 'runtime'), TMPDIR: scratch,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, MAHAS_NODE: process.execPath,
    MAHAS_CONFIG_DIR: configDir, MAHAS_TEST: '1', MAHAS_FAKE_FOCUS: 'focused',
    MAHAS_EVENTS_FILE: join(configDir, 'agent-events.log'),
    MAHAS_NOTIFY_LOG: join(configDir, 'notify-decisions.log'),
    MAHAS_LEGACY_USAGE_ACCOUNTS_ROOT: join(configDir, 'usage-accounts'),
    ELECTRON_DISABLE_SANDBOX: '1', LANG: 'en_US.UTF-8', TZ: 'UTC'
  })
  const port = await freePort()
  console.log(`Domain UI smoke: ${args.length ? executable : 'built out/ desktop'}; ${scratch}`)
  child = spawn(executable, [...(args.length ? [] : ['.']), '--no-sandbox', '--ozone-platform=x11',
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.on('error', (error) => { spawnError = error })
  remember(proc(child.pid))
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data) => { electronLog = (electronLog + data).slice(-12000) })
  }
  tracker = setInterval(trackProcesses, 100)
  const target = await until(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`,
        { signal: AbortSignal.timeout(1000) })).json()
      return list.find((target) => target.type === 'page' && !target.url.includes('detached'))
    } catch { return null }
  }, 'built renderer CDP target', 20000)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 5000)
    ws.onopen = () => { clearTimeout(timer); done() }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP connection failed')) }
  })
  ws.onmessage = ({ data }) => {
    const reply = JSON.parse(data)
    if (reply.id && pending.has(reply.id)) {
      const request = pending.get(reply.id)
      pending.delete(reply.id)
      if (reply.error) request.reject(new Error(reply.error.message))
      else request.resolve(reply.result)
    } else if (reply.method === 'Runtime.exceptionThrown') {
      renderErrors.push(JSON.stringify(reply.params.exceptionDetails))
    } else if (reply.method === 'Runtime.consoleAPICalled' && reply.params.type === 'error') {
      renderErrors.push(reply.params.args.map((arg) => arg.description ?? arg.value ?? '').join(' '))
    }
  }
  await send('Runtime.enable')
  await until(() => evaluate('!!(window.__mahasTest && window.mahas?.domain)'), 'domain preload and hydrated store')
  await evaluate(`window.__mahasTest.getState().updateSettings({language:'en', osNotifications:false})`)

  // These are read operations only: discovery/collection must happen on the
  // daemon's automatic timer before any widget/refresh button is mounted.
  const ledger = await until(async () => {
    const result = await stored('usageLedger', { harnessId: 'codex', limit: 20 })
    return result.ok && result.value.items.length ? result.value : null
  }, 'automatic Codex collection into stored ledger', 70000)
  const counted = ledger.items.filter((item) => item.entry.accountingStatus === 'counted')
  check(counted.length === 1 && counted[0].entry.normalizedTokens.total === 14,
    'automatic collection stored exactly 14 tokens without a UI collection request')
  check(counted[0].entry.normalizedTokens.reasoningOutput === null,
    'stored missing reasoning component remains null')
  const sessions = await stored('sessions', { harnessId: 'codex', limit: 20 })
  check(sessions.ok && sessions.value.items.some((row) => row.nativeSessionKey === sessionId),
    'session.list reaches the desktop stored session API')
  const session = sessions.value.items.find((row) => row.nativeSessionKey === sessionId)
  const detail = await stored('sessionDetail', session.id)
  check(detail.ok && Array.isArray(detail.value.attachments) && detail.value.handles.length > 0,
    'session detail preserves attachments and collected resume handles')
  const auth = await stored('authStatus', '__fixture_missing_flow__')
  check(auth.ok && auth.value?.flowId === '__fixture_missing_flow__' && auth.value.state === 'unknown',
    'dedicated authenticated channel answers a read without provider login')
  if (!auth.ok || auth.value?.state !== 'unknown') console.error('Auth channel:', JSON.stringify(auth))
  const published = await until(async () => {
    const results = await Promise.all([
      stored('usageSummaries', { grain: 'all-time' }),
      stored('usageStatistics', { metric: 'weekly-average' }),
      stored('usageStatistics', { metric: 'hourly-by-date' })
    ])
    return results.every((r) => r.ok && r.value.items.length && r.value.readiness.state === 'ready')
      && !results[0].value.pending ? results : null
  }, 'published summaries and weekly/hourly statistics', 40000)
  const summaryRows = published[0].value.items
  const globalRows = summaryRows.filter(row => Object.keys(row.dimensions).length === 0)
  check(globalRows.length === 1 && globalRows[0].totals.total === 14,
    'public summary preserves the unique stored global rollup')
  check(summaryRows.some(row => Object.hasOwn(row.dimensions, 'providerId') && row.dimensions.providerId === null),
    'an unknown provider group retains its grouping axis')
  check(summaryRows.some(row => row.dimensions.servedModel?.nativeName === 'gpt-5' &&
    row.dimensions.servedModel.modelId == null),
    'native served model survives the desktop projection without an invented catalog identity')
  check(new Set(summaryRows.map(row => JSON.stringify(row.dimensions))).size === summaryRows.length,
    'distinct stored rollup shapes remain distinct through preload')
  const globalOnly = await stored('usageSummaries', { grain: 'all-time', dimensionKeys: [], limit: 1 })
  check(globalOnly.ok && globalOnly.value.items.length === 1 &&
    Object.keys(globalOnly.value.items[0].dimensions).length === 0 && globalOnly.value.items[0].totals.total === 14,
    'exact empty-axis query reads the grand total independently of list pagination')
  trackProcesses()
  check(services.size === 2, 'both service endpoints match isolated config and live process identities')
  for (const [name, identity] of services) console.log(`    ${name}: pid=${identity.pid} birth=${identity.birth}`)

  await evaluate(`(() => {
    const s = window.__mahasTest.getState()
    const project = s.addProject(${JSON.stringify(project)})
    s.createWorkspace(project.id, 'Domain fixture')
  })()`)
  await openWidget('tokens')
  await until(() => evaluate(`document.querySelector('.dash-sess') && document.querySelectorAll('.stats-card').length >= 3`),
    'tokens, statistics and stored sessions rendered')
  const tokens = await evaluate(`(() => {
    const card = document.querySelector('.dash-stats')?.closest('.dash-card')
    const stats = [...document.querySelectorAll('.stats-card')]
    return {
      total: card?.querySelector('.dash-card-v')?.textContent.trim(),
      headline: document.querySelector('.dash-kpi-v')?.textContent.replace(/^≈/, '').trim(),
      harnessCards: document.querySelectorAll('.dash-stats').length,
      input: card?.querySelector('.dash-stats .in')?.textContent, output: card?.querySelector('.dash-stats .out')?.textContent,
      cached: card?.querySelector('.dash-stats .cache')?.textContent, reasoning: card?.querySelector('.dash-stats .think')?.textContent,
      coverage: card?.querySelector('.dash-covline')?.textContent,
      segments: [...(card?.querySelectorAll('.dash-mix-seg') ?? [])].map(el => el.className),
      stats: stats.map(el => ({text: el.textContent, coverage: el.querySelector('.cov-chip').textContent})),
      sessions: [...document.querySelectorAll('.dash-sess')].map(el => ({text: el.textContent, value: el.querySelector('.dash-sess-v')?.textContent})),
      fresh: document.querySelector('.dash-fresh')?.textContent
    }
  })()`)
  check(tokens.total === '14' && tokens.headline === '14' && tokens.harnessCards === 1 &&
    tokens.input === '10' && tokens.output === '4' && tokens.cached === '6',
    'tokens widget renders the stored total and known components')
  check(tokens.reasoning === '—', 'unknown reasoning displays —, never 0')
  const axes = await evaluate(`([...document.querySelectorAll('.dash-axis')].map(el => ({ title: el.querySelector('.dash-axis-t')?.textContent, text: el.textContent })))`)
  check(axes.some(axis => /Provider/i.test(axis.title) && /14/.test(axis.text)) &&
    axes.some(axis => /Offering|Product/i.test(axis.title) && /14/.test(axis.text)),
    'provider and offering analysis render stored unknown groups')
  check(axes.some(axis => /served/i.test(axis.title) && /gpt-5/.test(axis.text)),
    'served-model analysis renders the native model from stored attribution')

  check(tokens.segments.length === 2 && tokens.segments.every((name) => !/cache|think|reason/.test(name)),
    'token bar does not infer cache/reasoning containment')
  check(/computed/.test(tokens.coverage) && /complete|partial|unknown/.test(tokens.coverage) && /stored/.test(tokens.fresh),
    'token coverage and stored/computed freshness are visible')
  check(tokens.stats.some((card) => /Weekly average/.test(card.text) && /periods covered/.test(card.text)) &&
    tokens.stats.some((card) => /Hourly usage/.test(card.text)) &&
    tokens.stats.every((card) => /as of/.test(card.text) && /complete|partial|unknown/.test(card.coverage)),
    'weekly/hourly statistics show coverage, period denominator and freshness')
  check(tokens.sessions.some((row) => row.value === '≥14' && row.text.includes(session.id.slice(0, 12))),
    'stored session row renders collected usage with an explicit lower-bound marker')
  check(tokens.stats.every((card) => /unknown/.test(card.coverage) && card.text.includes('—')),
    'uncovered weekly/hourly amounts remain unknown rather than zero')
  if (process.env.MAHAS_UI_SCREENSHOT) {
    // Electron cannot capture a window that has never been mapped. Maximize
    // shows the fixture without requesting focus; MAHAS_FAKE_FOCUS keeps the
    // attention policy deterministic during this optional visual check.
    await evaluate('window.mahas.win.maximize()')
    await sleep(300)
    const screenshot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(process.env.MAHAS_UI_SCREENSHOT), Buffer.from(screenshot.data, 'base64'))
    console.log(`    screenshot: ${resolve(process.env.MAHAS_UI_SCREENSHOT)}`)
  }
  if (failed) {
    console.error('Tokens DOM:', JSON.stringify(tokens))
    console.error('Stored summary shapes:', JSON.stringify(published[0].value.items.map((row) => ({
      dimensions: row.dimensions, totals: row.totals, key: row.key
    }))))
  }

  await until(() => evaluate(`document.querySelector('.dash-sess-c')?.textContent.includes('resumable')`),
    'stored canonical session resume support loaded')
  check(true, 'bounded canonical detail read exposes resume support in the session row')
  // Qualified synthetic live evidence exercises the actual native-key click
  // callback. Identity/namespace collision cases are covered by the pure join
  // fixture; this checks its consumer restores the target workspace/pane/tab.
  const navigationTarget = await evaluate(`(() => {
    const s = window.__mahasTest.getState()
    const original = s.activeWorkspaceId
    const projectId = s.workspaces.find(w => w.id === original).projectId
    s.createWorkspace(projectId, 'Session target')
    const w = window.__mahasTest.getState().workspaces.find(w => w.id === window.__mahasTest.getState().activeWorkspaceId)
    s.newBlock('term', w.id)
    const next = window.__mahasTest.getState().workspaces.find(ws => ws.id === w.id)
    const pane = Object.values(next.panes).find(p => p.tabs.some(t => t.kind === 'term'))
    const tab = pane.tabs.find(t => t.kind === 'term')
    s.updatePane(pane.id, { tabs: pane.tabs.map(t => t.id === tab.id ? { ...t, minimized: true } : t) }, w.id)
    s.minimizePane(pane.id, w.id)
    s.upsertAgentSession(${JSON.stringify(sessionId)}, { provider: 'codex', namespace: ${JSON.stringify(session.namespace)}, wsId: w.id, paneId: pane.id, tabId: tab.id })
    s.activateWorkspace(original)
    return { original, wsId: w.id, paneId: pane.id, tabId: tab.id }
  })()`)
  await until(() => evaluate(`document.querySelectorAll('.dash-sess').length === 1 && !document.querySelector('.dash-sess').disabled`),
    'canonical stored row joined with qualified native live entry')
  await evaluate(`document.querySelector('.dash-sess').click()`)
  const jumped = await evaluate(`(() => {
    const s = window.__mahasTest.getState(), target = ${JSON.stringify(navigationTarget)}
    const p = s.workspaces.find(w => w.id === target.wsId)?.panes[target.paneId]
    return s.activeWorkspaceId === target.wsId && p && !p.minimized &&
      p.activeTabId === target.tabId && !p.tabs.find(t => t.id === target.tabId).minimized
  })()`)
  check(jumped, 'stored session click restores the correct workspace, minimized pane and native tab')
  await evaluate(`(() => {
    window.__mahasTest.setState({agentSessions:{}})
    window.__mahasTest.getState().activateWorkspace(${JSON.stringify(navigationTarget.original)})
  })()`)

  // The shell's separate live-session widget is named "agents"; canonical
  // stored sessions are the SessionsPanel inside the tokens widget above.
  await openWidget('agents')
  await until(() => evaluate("!!document.querySelector('.widget .ag-wrap')"), 'agents session-list widget')
  check(true, 'existing agents session-list widget mounts through newBlock')
  await openWidget('usage')
  await until(() => evaluate(`[...document.querySelectorAll('.widget .usage-note')].some(el => el.textContent.includes('no harness connection in the domain store yet'))`),
    'usage widget empty stored connection state')
  const sources = await stored('usageSources')
  check(sources.ok && sources.value.readiness.state === 'ready' && !sources.value.sources.length && !sources.value.quota.length,
    'usage widget honestly shows no stored connection/quota without credentials')
  // Seed a connection with explicitly unavailable material through the real
  // operation boundary. It must remain visible without inventing a harness
  // binding, and cannot reach a provider even when refresh is requested.
  const seed = await evaluate(`(async () => {
    const op = async (operation, payload) => {
      const r = await window.mahas.exec.op({ operation, payload, operationId: crypto.randomUUID() })
      if (!r.ok) throw new Error(JSON.stringify(r.error))
      return r.value
    }
    const inventory = await op('inventory.snapshot', {})
    const machineId = inventory.machines[0].value.id
    const now = Date.now()
    await op('inventory.credential.register', { value: {
      id: 'fixture-unavailable-credential', machineId, materialRef: 'fixture:unavailable',
      materialRevision: 1, ownership: 'unknown', availability: 'unavailable',
      firstSeenAt: now, lastSeenAt: now
    } })
    await op('inventory.connection.put', { value: {
      id: 'fixture-unbound-connection', offeringId: 'openai/chatgpt',
      credentialId: 'fixture-unavailable-credential', firstSeenAt: now,
      availability: 'unavailable', origin: 'registered'
    } })
    return true
  })()`)
  check(seed, 'synthetic unavailable connection commits through the real operation channel')
  const unbound = await stored('usageSources')
  const unboundSource = unbound.ok && unbound.value.sources.find(row => row.connectionId === 'fixture-unbound-connection')
  check(unboundSource && !unboundSource.harnessId && unboundSource.offeringId === 'openai/chatgpt',
    'unbound stored connection remains visible without an invented harness')
  await evaluate(`(() => {
    const s = window.__mahasTest.getState()
    const w = s.workspaces.find(w => w.id === s.activeWorkspaceId)
    for (const p of Object.values(w.panes)) {
      if (p.tabs.some(t => t.widget === 'usage')) s.closePane(p.id, w.id)
    }
  })()`)
  await openWidget('usage')
  await until(() => evaluate(`/connections without a harness binding/i.test(document.body.innerText)`),
    'unbound connection group rendered')
  check(await evaluate(`[...document.querySelectorAll('.dash-card-n')].some(el => /ChatGPT/.test(el.textContent))`),
    'unbound account card uses the stored offering label')
  const refresh = await stored('requestCollection', { capability: 'quota', reason: 'fixture-unavailable-only' })
  check(refresh.ok && refresh.value.requested === true,
    'quota refresh signals the daemon auth poller with unavailable material')
  // Deliberately no access token: the built-in parser/probe cannot call a provider.
  // This file sits outside every discovery root and enters only through explicit IPC.
  const pickedFile = join(scratch, 'picked-auth.json')
  writeFileSync(pickedFile, '{}')
  const imported = await stored('authImportFile', { offeringId: 'openai/chatgpt', path: pickedFile })
  check(imported.ok && typeof imported.value.connectionId === 'string' && typeof imported.value.credentialId === 'string',
    'selected file registers a canonical credential and connection through main/preload')
  assert(imported.ok, JSON.stringify(imported))
  const again = await stored('authImportFile', { offeringId: 'openai/chatgpt', path: pickedFile })
  check(again.ok && again.value.connectionId === imported.value.connectionId && !again.value.imported,
    'repeated selected-file import reuses its canonical connection')
  const importedSources = await stored('usageSources', { legacySources: [
    { id: 'fixture-legacy-file', harnessId: 'codex', path: pickedFile, label: 'Fixture legacy' }
  ] })
  check(importedSources.ok && importedSources.value.sources.some(source => source.connectionId === imported.value.connectionId) &&
    !importedSources.value.sources.some(source => source.key === 'legacy:fixture-legacy-file'),
    'canonical file connection suppresses its duplicate legacy display hint')
  const removed = await stored('removeSource', { connectionId: imported.value.connectionId })
  check(removed.ok && readFileSync(pickedFile, 'utf8') === '{}',
    'removing a file connection preserves the user-owned credential file')
  const closed = await stored('authImportFile', { offeringId: 'openai/chatgpt', path: pickedFile })
  check(!closed.ok, 'import does not report success or revive a previously removed connection')
  await sleep(300)
  check(renderErrors.length === 0, 'no renderer exceptions or console errors')
  assert.equal(failed, 0, `${failed}/${checks} domain UI checks failed`)
  console.log(`PASS: ${checks} domain UI checks`)
}

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    void cleanup().then(() => process.exit(signal === 'SIGINT' ? 130 : 143), (error) => {
      console.error(error)
      process.exit(1)
    })
  })
}

try {
  await run()
} catch (error) {
  console.error(`FAIL: ${error.stack ?? error}`)
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      console.error('Rendered UI:', await evaluate('document.body.innerText.slice(-9000)'))
      console.error('Widget state:', await evaluate(`window.__mahasTest && JSON.stringify({
        active: window.__mahasTest.getState().activeWorkspaceId,
        workspaces: window.__mahasTest.getState().workspaces
      })`))
    } catch { /* a renderer crash can make diagnostics unavailable */ }
  }
  if (renderErrors.length) console.error('Renderer errors:', renderErrors.join('\n'))
  console.error('Electron log tail:', electronLog)
  for (const name of ['desktop-bootstrap', 'mahasd', 'execution-host']) {
    try { console.error(`${name} log tail:`, readFileSync(join(configDir, 'logs', `${name}.log`), 'utf8').slice(-5000)) }
    catch { /* startup may not have created it */ }
  }
  process.exitCode = 1
} finally {
  if (!stopping) {
    stopping = true
    try { await cleanup() } catch (error) { console.error(error); process.exitCode = 1 }
  }
}
