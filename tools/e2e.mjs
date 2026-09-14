#!/usr/bin/env node
// ADE e2e driver — boots the built app (`npm run build` → out/) under an
// isolated XDG_CONFIG_HOME and drives the real UI over Chrome DevTools
// Protocol. Every scenario exercises the production path end to end:
// store actions mount real TerminalTabViews → real ptys spawn with stamped
// ADE_PANE/ADE_TAB env → ade-fake inherits them → real ade-hook.cjs
// normalizes → events file → tailer → renderer store.
//
//   node tools/e2e.mjs [scenario...]        (default: all)
//
// Scenarios: orphans · resume · attention
//
// The test app window pops up on the real desktop — focus-dependent checks
// (attended vs ambient) assume it keeps focus for the few seconds it runs.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')
const FAKE = 'node tools/ade-fake.mjs'
const BASE = mkdtempSync(join(tmpdir(), 'ade-e2e-'))

let passed = 0
let failed = 0
const ok = (cond, label) => {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pgrep(pattern) {
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean) : []
}

function readEvents(cfg) {
  const f = join(cfg, 'ade', 'agent-events.log')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// ---------- CDP plumbing ----------

async function cdpTarget(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && !t.url.includes('detached'))
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error(`no CDP page target on :${port}`)
}

async function boot(tag) {
  const cfg = join(BASE, tag)
  const port = 9300 + Math.floor(Math.random() * 400)
  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: cfg,
      ELECTRON_DISABLE_SANDBOX: '1',
      ADE_HOOK_DEBUG: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr.on('data', () => {}) // drain
  const target = await cdpTarget(port, Date.now() + 20000)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const r = JSON.parse(m.data)
    if (r.id && pending.has(r.id)) {
      pending.get(r.id)(r)
      pending.delete(r.id)
    }
  }
  const send = (method, params) =>
    new Promise((res, rej) => {
      const id = ++seq
      pending.set(id, (r) => (r.error ? rej(new Error(r.error.message)) : res(r.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails)
      throw new Error(
        `eval failed: ${expression.slice(0, 120)} → ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`
      )
    return r.result?.value
  }
  // wait for the renderer + hydration
  const deadline = Date.now() + 20000
  for (;;) {
    const ready = await ev(
      `!!(window.__ade && window.ade && window.ade.pty)`
    ).catch(() => false)
    if (ready) break
    if (Date.now() > deadline) throw new Error('renderer never came up')
    await sleep(300)
  }
  await sleep(800) // manifest load + initial settle

  const waitFor = async (expr, label, timeout = 12000) => {
    const dl = Date.now() + timeout
    for (;;) {
      const v = await ev(expr).catch(() => null)
      if (v) return v
      if (Date.now() > dl) throw new Error(`timeout waiting for: ${label ?? expr.slice(0, 80)}`)
      await sleep(200)
    }
  }
  const quit = async () => {
    try {
      await ev('window.ade.win.close()')
    } catch {
      /* context died first — fine */
    }
    const exited = await Promise.race([
      new Promise((r) => child.on('exit', () => r(true))),
      sleep(8000).then(() => false)
    ])
    if (!exited) child.kill('SIGKILL')
    await sleep(400)
  }
  const dump = () => {
    for (const f of ['agent-events.log', 'notify-decisions.log']) {
      const p = join(cfg, 'ade', f)
      if (existsSync(p))
        console.log(`  --- ${f} (tail) ---\n${readFileSync(p, 'utf8').split('\n').slice(-12).join('\n')}`)
    }
  }
  const focusState = () => ev(`document.hasFocus()`).catch(() => null)
  const term = async () =>
    waitFor(
      `(() => {
        const s = window.__ade.getState()
        for (const w of s.workspaces)
          for (const p of Object.values(w.panes))
            if (p.type === 'terminal')
              for (const t of p.tabs) if (t.pty) return { wsId: w.id, paneId: p.id, tabId: t.id, pty: t.pty }
        return null
      })()`,
      'a terminal tab with a live pty'
    )
  const type = (pty, s) => ev(`window.ade.pty.write(${JSON.stringify(pty)}, ${JSON.stringify(s)})`)
  return { cfg, child, ev, waitFor, quit, term, type, dump, focusState }
}

// ---------- helpers shared by scenarios ----------

const mkws = async (h) => {
  const pid = await h.ev(`window.__ade.getState().addProject(${JSON.stringify(ROOT)}).id`)
  const wsId = await h.ev(`(() => {
    window.__ade.getState().createWorkspace(${JSON.stringify(pid)})
    const s = window.__ade.getState()
    const w = s.workspaces.at(-1)
    s.activateWorkspace(w.id)
    s.newPane('terminal', w.id)
    return w.id
  })()`)
  return { pid, wsId }
}

const addTermTab = (h, wsId, paneId) =>
  h.ev(`(() => {
    const s = window.__ade.getState()
    const w = s.workspaces.find((x) => x.id === ${JSON.stringify(wsId)})
    const p = w.panes[${JSON.stringify(paneId)}]
    const t = { id: crypto.randomUUID() }
    s.updatePane(p.id, { tabs: [...p.tabs, t], activeTabId: t.id }, w.id)
    return t.id
  })()`)

const ptyForTab = (h, tabId) =>
  h.waitFor(
    `(() => {
      const s = window.__ade.getState()
      for (const w of s.workspaces)
        for (const p of Object.values(w.panes))
          if (p.type === 'terminal')
            for (const t of p.tabs) if (t.id === ${JSON.stringify(tabId)} && t.pty) return t.pty
      return null
    })()`,
    `pty for tab ${tabId}`
  )

// ---------- scenarios ----------

async function scOrphans() {
  console.log('\n■ orphans — app quit must kill agent processes')
  const h = await boot('orphans')
  await mkws(h)
  const t = await h.term()
  await h.type(t.pty, `${FAKE} --session-id s-orphan\n`)
  await sleep(1500)
  ok(pgrep('ade-fake.mjs --session-id s-orphan').length > 0, 'fake agent is running')
  await h.quit()
  await sleep(800)
  ok(
    pgrep('ade-fake.mjs --session-id s-orphan').length === 0,
    'fake agent is dead after app quit'
  )
}

async function scResume() {
  console.log('\n■ resume — two sessions in one pane restore to their own tabs')
  const h = await boot('resume')
  const { wsId } = await mkws(h)
  const t1 = await h.term()
  const tabB = await addTermTab(h, wsId, t1.paneId)
  const ptyB = await ptyForTab(h, tabB)
  await h.type(t1.pty, `${FAKE} --session-id sess-A\n`)
  await h.type(ptyB, `${FAKE} --session-id sess-B\n`)

  await h.waitFor(
    `(() => {
      const r = window.__ade.getState().resumeSessions
      return r['sess-A'] && r['sess-B'] ? r : null
    })()`,
    'both sessions registered'
  )
  const recs = await h.ev(
    `(() => { const r = window.__ade.getState().resumeSessions; return {A: r['sess-A'].tabId, B: r['sess-B'].tabId} })()`
  )
  ok(recs.A === t1.tabId, 'sess-A attributed to tab 1 (env-stamped)')
  ok(recs.B === tabB, 'sess-B attributed to tab 2 (env-stamped)')
  await h.quit()

  // boot 2 — same config dir; state rehydrates, prompt appears, accept it
  const h2 = await boot('resume')
  const rows = await h2.waitFor(
    `document.querySelectorAll('.resume-list .resume-row').length`,
    'resume prompt with rows'
  )
  ok(rows === 2, `resume prompt offers both sessions (got ${rows})`)
  await h2.ev(`document.querySelector('.resume-actions .sbtn.accent').click()`)

  // resumed fakes re-emit session-start — the event's tabId proves which
  // shell the command landed in
  const dl = Date.now() + 15000
  let evs = []
  while (Date.now() < dl) {
    evs = readEvents(h2.cfg).filter(
      (e) => e.event === 'session-start' && (e.sessionId === 'sess-A' || e.sessionId === 'sess-B')
    )
    if (evs.length >= 2) break
    await sleep(300)
  }
  const bySid = Object.fromEntries(evs.map((e) => [e.sessionId, e.tabId]))
  ok(bySid['sess-A'] === t1.tabId, 'sess-A resumed inside tab 1')
  ok(bySid['sess-B'] === tabB, 'sess-B resumed inside tab 2')
  await h2.quit()
}

async function scAttention() {
  console.log('\n■ attention — ambient toasts + read-on-view')
  const h = await boot('attention')
  const { wsId: ws1 } = await mkws(h)
  const t1 = await h.term()
  // second workspace (inactive) with its own terminal
  const ws2 = await h.ev(`(() => {
    let s = window.__ade.getState()
    s.createWorkspace(s.projects[0].id)
    s = window.__ade.getState()
    const w = s.workspaces.at(-1)
    s.newPane('terminal', w.id)
    s.activateWorkspace(${JSON.stringify(ws1)})
    return w.id
  })()`)
  await sleep(400)
  const t2 = await h.waitFor(
    `(() => {
      const w = window.__ade.getState().workspaces.find((x) => x.id === ${JSON.stringify(ws2)})
      const p = Object.values(w.panes).find((p) => p.type === 'terminal')
      const t = p?.tabs?.[0]
      return t?.pty ? { paneId: p.id, tabId: t.id, pty: t.pty } : null
    })()`,
    'ws2 terminal'
  )
  // fake in ws2's tab; 'n' keypress emits needs-input through the real path
  await h.type(t2.pty, `${FAKE} --session-id s-amb\n`)
  await sleep(1200)
  await h.type(t2.pty, 'n')
  const toasted = await h
    .waitFor(`window.__ade.getState().toasts.length > 0`, 'ambient toast', 8000)
    .then(() => true)
    .catch(async () => {
      console.log(`  [debug] focused=${await h.focusState()}`)
      console.log(`  [debug] notifications=${JSON.stringify(await h.ev(`window.__ade.getState().notifications`))}`)
      h.dump()
      return false
    })
  ok(toasted, 'ambient needs-input produced an in-app toast')
  const unread = await h.ev(
    `window.__ade.getState().notifications.filter((n) => !n.read).length`
  )
  ok(unread > 0, 'ambient notification is unread')

  // read-on-view: activate ws2 → the pending ping settles to read
  await h.ev(`window.__ade.getState().activateWorkspace(${JSON.stringify(ws2)})`)
  await sleep(600)
  const stillUnread = await h.ev(
    `window.__ade.getState().notifications.filter((n) => !n.read && n.tabId === ${JSON.stringify(t2.tabId)}).length`
  )
  ok(stillUnread === 0, 'viewing the tab clears its unread ping')
  await h.quit()
}

// ---------- runner ----------

const ALL = { orphans: scOrphans, resume: scResume, attention: scAttention }
const picked = process.argv.slice(2).filter((s) => s in ALL)
const list = picked.length ? picked : Object.keys(ALL)

if (!existsSync(join(ROOT, 'out/main/index.js'))) {
  console.error('out/main/index.js missing — run `npm run build` first')
  process.exit(1)
}
console.log(`test config root: ${BASE}`)
for (const name of list) {
  try {
    await ALL[name]()
  } catch (e) {
    failed++
    console.log(`  ✗ scenario "${name}" threw: ${e.message}`)
  }
}
console.log(`\n${passed} passed, ${failed} failed`)
rmSync(BASE, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
