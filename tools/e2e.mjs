#!/usr/bin/env node
// Mahas e2e driver — boots the built app (`npm run build` → out/) under an
// isolated XDG_CONFIG_HOME and drives the real UI over Chrome DevTools
// Protocol. Every scenario exercises the production path end to end:
// store actions mount real TerminalTabViews → real ptys spawn with stamped
// MAHAS_PANE/MAHAS_TAB env → mahas-fake inherits them → real mahas-hook.cjs
// normalizes → events file → tailer → renderer store.
//
//   node tools/e2e.mjs [scenario...]        (default: all)
//
// Scenarios: orphans · resume · attention · status · adopt · projectrm ·
//            browserfile · tabdnd
//
// The test app window pops up on the real desktop — focus-dependent checks
// (attended vs ambient) assume it keeps focus for the few seconds it runs.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')
const FAKE = 'node tools/mahas-fake.mjs'
const BASE = mkdtempSync(join(tmpdir(), 'mahas-e2e-'))

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
  const f = join(cfg, 'mahas', 'agent-events.log')
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

async function boot(tag, opts = {}) {
  const cfg = join(BASE, tag)
  const port = 9300 + Math.floor(Math.random() * 400)
  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: cfg,
      ELECTRON_DISABLE_SANDBOX: '1',
      MAHAS_HOOK_DEBUG: '1',
      // headless: window never maps, can't steal focus; MAHAS_FAKE_FOCUS pins
      // the win:state verdict ('focused' | 'visible' | 'minimized')
      MAHAS_TEST: '1',
      ...(opts.focus ? { MAHAS_FAKE_FOCUS: opts.focus } : {})
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
  // real input pipeline — hold-drag exercises paneDnd.ts (pointer events,
  // elementFromPoint, drop indicators), not just store actions
  const input = (type, x, y, opts = {}) =>
    send('Input.dispatchMouseEvent', { type, x, y, ...opts })
  // wait for the renderer + hydration
  const deadline = Date.now() + 20000
  for (;;) {
    const ready = await ev(
      `!!(window.__mahas && window.mahas && window.mahas.pty)`
    ).catch(() => false)
    if (ready) break
    if (Date.now() > deadline) throw new Error('renderer never came up')
    await sleep(300)
  }
  await sleep(800) // manifest load + initial settle
  // keep verdicts quiet — 'away' verdicts must not pop a real OS banner on
  // the developer's desktop
  await ev(`window.__mahas.getState().updateSettings({ osNotifications: false })`).catch(() => {})

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
      await ev('window.mahas.win.close()')
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
      const p = join(cfg, 'mahas', f)
      if (existsSync(p))
        console.log(`  --- ${f} (tail) ---\n${readFileSync(p, 'utf8').split('\n').slice(-12).join('\n')}`)
    }
  }
  const focusState = () => ev(`document.hasFocus()`).catch(() => null)
  const term = async () =>
    waitFor(
      `(() => {
        const s = window.__mahas.getState()
        for (const w of s.workspaces)
          for (const p of Object.values(w.panes))
            for (const t of p.tabs)
              if (t.kind === 'term' && t.pty)
                return { wsId: w.id, paneId: p.id, tabId: t.id, pty: t.pty }
        return null
      })()`,
      'a terminal tab with a live pty'
    )
  const type = (pty, s) => ev(`window.mahas.pty.write(${JSON.stringify(pty)}, ${JSON.stringify(s)})`)
  const decisions = () => {
    const f = join(cfg, 'mahas', 'notify-decisions.log')
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
  const decisionFor = async (sessionId, event) => {
    const dl = Date.now() + 8000
    for (;;) {
      const d = decisions().find((x) => x.ev?.sessionId === sessionId && x.ev?.event === event)
      if (d) return d
      if (Date.now() > dl) return null
      await sleep(250)
    }
  }
  return { cfg, child, ev, input, waitFor, quit, term, type, dump, focusState, decisions, decisionFor }
}

// ---------- helpers shared by scenarios ----------

const mkws = async (h) => {
  const pid = await h.ev(`window.__mahas.getState().addProject(${JSON.stringify(ROOT)}).id`)
  const wsId = await h.ev(`(() => {
    window.__mahas.getState().createWorkspace(${JSON.stringify(pid)})
    const s = window.__mahas.getState()
    const w = s.workspaces.at(-1)
    s.activateWorkspace(w.id)
    s.newBlock('term', w.id)
    return w.id
  })()`)
  return { pid, wsId }
}

const addTermTab = (h, wsId, paneId) =>
  h.ev(`(() => {
    const s = window.__mahas.getState()
    const w = s.workspaces.find((x) => x.id === ${JSON.stringify(wsId)})
    const p = w.panes[${JSON.stringify(paneId)}]
    const t = { id: crypto.randomUUID(), kind: 'term' }
    s.updatePane(p.id, { tabs: [...p.tabs, t], activeTabId: t.id }, w.id)
    return t.id
  })()`)

const ptyForTab = (h, tabId) =>
  h.waitFor(
    `(() => {
      const s = window.__mahas.getState()
      for (const w of s.workspaces)
        for (const p of Object.values(w.panes))
          for (const t of p.tabs)
            if (t.id === ${JSON.stringify(tabId)} && t.kind === 'term' && t.pty) return t.pty
      return null
    })()`,
    `pty for tab ${tabId}`
  )

// ---------- tab drag & drop ----------

// element center in viewport coords — selectors are evaluated in the page
const center = (sel) => `(() => {
  const el = document.querySelector(${sel})
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})()`

// hold-press a tab (HOLD_MS=180 arms the engine), walk to the target, release
const dragTab = async (h, tabId, toExpr) => {
  const from = await h.ev(center(`'.pane-tabs .ctab[data-tab-id="${tabId}"]'`))
  if (!from) throw new Error(`tab ${tabId} not found in a leaf strip`)
  const to = await h.ev(toExpr)
  if (!to) throw new Error('drop target not found')
  await h.input('mousePressed', from.x, from.y, { button: 'left', buttons: 1, clickCount: 1 })
  await sleep(300) // arm
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await h.input(
      'mouseMoved',
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
      { button: 'left', buttons: 1 }
    )
    await sleep(25)
  }
  await h.input('mouseReleased', to.x, to.y, { button: 'left', buttons: 1, clickCount: 1 })
  await sleep(350)
}

const paneTabIds = (h, wsId, paneId) =>
  h.ev(`(() => {
    const w = window.__mahas.getState().workspaces.find((x) => x.id === ${JSON.stringify(wsId)})
    return w?.panes[${JSON.stringify(paneId)}]?.tabs.map((t) => t.id) ?? null
  })()`)

// ---------- scenarios ----------

async function scOrphans() {
  console.log('\n■ orphans — app quit must kill agent processes')
  const h = await boot('orphans')
  await mkws(h)
  const t = await h.term()
  await h.type(t.pty, `${FAKE} --session-id s-orphan\n`)
  await sleep(1500)
  ok(pgrep('mahas-fake.mjs --session-id s-orphan').length > 0, 'fake agent is running')
  await h.quit()
  await sleep(800)
  ok(
    pgrep('mahas-fake.mjs --session-id s-orphan').length === 0,
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
      const r = window.__mahas.getState().resumeSessions
      return r['sess-A'] && r['sess-B'] ? r : null
    })()`,
    'both sessions registered'
  )
  const recs = await h.ev(
    `(() => { const r = window.__mahas.getState().resumeSessions; return {A: r['sess-A'].tabId, B: r['sess-B'].tabId} })()`
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
  console.log('\n■ attention — attended/ambient/away levels + read-on-view')
  // focused boot: the emitting tab is on screen → attended; another
  // workspace's tab is off-screen → ambient
  const h = await boot('attention', { focus: 'focused' })
  const { wsId: ws1 } = await mkws(h)
  const t1 = await h.term()
  await h.type(t1.pty, `${FAKE} --session-id s-att\n`)
  const ws2 = await h.ev(`(() => {
    let s = window.__mahas.getState()
    s.createWorkspace(s.projects[0].id)
    s = window.__mahas.getState()
    const w = s.workspaces.at(-1)
    s.newBlock('term', w.id)
    s.activateWorkspace(${JSON.stringify(ws1)})
    return w.id
  })()`)
  const t2 = await h.waitFor(
    `(() => {
      const w = window.__mahas.getState().workspaces.find((x) => x.id === ${JSON.stringify(ws2)})
      const p = Object.values(w.panes).find((p) => p.tabs.some((t) => t.kind === 'term'))
      const t = p?.tabs?.find((t) => t.kind === 'term')
      return t?.pty ? { paneId: p.id, tabId: t.id, pty: t.pty } : null
    })()`,
    'ws2 terminal'
  )
  await h.type(t2.pty, `${FAKE} --session-id s-amb\n`)
  await sleep(1200)

  // attended: 'c' in the on-screen tab → silent pre-read record
  await h.type(t1.pty, 'c')
  const dAtt = await h.decisionFor('s-att', 'turn-complete')
  ok(dAtt?.reason?.startsWith('attended'), `on-screen turn-complete judged attended (${dAtt?.reason})`)
  const attNotif = await h.ev(
    `window.__mahas.getState().notifications.find((n) => n.sessionId === 's-att')`
  )
  ok(attNotif?.read === true, 'attended event recorded pre-read')

  // ambient: 'n' in the off-screen workspace's tab → unread + in-app toast
  await h.type(t2.pty, 'n')
  const dAmb = await h.decisionFor('s-amb', 'needs-input')
  ok(dAmb?.reason?.startsWith('ambient'), `off-screen needs-input judged ambient (${dAmb?.reason})`)
  const toasted = await h
    .waitFor(`window.__mahas.getState().toasts.length > 0`, 'ambient toast', 8000)
    .then(() => true)
    .catch(() => false)
  ok(toasted, 'ambient needs-input produced an in-app toast')
  const unread = await h.ev(
    `window.__mahas.getState().notifications.filter((n) => !n.read && n.sessionId === 's-amb').length`
  )
  ok(unread > 0, 'ambient notification is unread')

  // read-on-view: hidden window never holds DOM focus — stub it so the sweep
  // runs, then activate ws2 → the pending ping settles to read
  await h.ev(`document.hasFocus = () => true`)
  await h.ev(`window.__mahas.getState().activateWorkspace(${JSON.stringify(ws2)})`)
  await sleep(600)
  const stillUnread = await h.ev(
    `window.__mahas.getState().notifications.filter((n) => !n.read && n.tabId === ${JSON.stringify(t2.tabId)}).length`
  )
  ok(stillUnread === 0, 'viewing the tab clears its unread ping')
  await h.quit()

  // away boot: 'visible' (unfocused) → verdict takes the OS path; the banner
  // itself is suppressed via osNotifications=false
  const h2 = await boot('attention-away', { focus: 'visible' })
  await mkws(h2)
  const ta = await h2.term()
  await h2.type(ta.pty, `${FAKE} --session-id s-away\n`)
  await sleep(1200)
  await h2.type(ta.pty, 'n')
  const dAway = await h2.decisionFor('s-away', 'needs-input')
  ok(dAway?.action === 'os', `unfocused-window verdict used OS notification (${dAway?.reason})`)
  await h2.quit()
}

async function scAdopt() {
  console.log('\n■ adopt — previous-run orphan events re-register their session')
  const h = await boot('adopt')
  await mkws(h)
  const t = await h.term()
  const hook = join(h.cfg, 'mahas', 'mahas-hook.cjs')
  await h.waitFor(`true`, 'warmup', 500) // let the app copy the hook script over
  const emit = (sessionId, extraEnv = {}) =>
    spawnSync(
      process.execPath,
      [hook, 'fake', 'turn-complete', JSON.stringify({ session_id: sessionId, cwd: ROOT })],
      {
        env: {
          ...process.env,
          MAHAS_CONFIG_DIR: join(h.cfg, 'mahas'),
          MAHAS_SESSION: 'dead-run-uuid',
          ...extraEnv
        }
      }
    )
  // a previous-run orphan: foreign mahasSession but exact pane/tab stamps
  emit('sess-orph', { MAHAS_PANE: t.paneId, MAHAS_TAB: t.tabId })
  const got = await h
    .waitFor(`window.__mahas.getState().resumeSessions['sess-orph']`, 'orphan re-registered', 8000)
    .catch(() => null)
  ok(got?.tabId === t.tabId, 'orphan event adopted → session re-registered to its tab')
  // an unstamped foreign event must still be dropped
  emit('sess-foreign')
  await sleep(800)
  const foreign = await h.ev(`window.__mahas.getState().resumeSessions['sess-foreign'] ?? null`)
  ok(!foreign, 'unstamped foreign event still dropped')
  await h.quit()
}

async function scProjectRm() {
  console.log('\n■ projectrm — removing a project drops its workspaces + cleans state')
  const h = await boot('projectrm')
  const { pid: pidA } = await mkws(h)
  const t = await h.term()
  await h.type(t.pty, `${FAKE} --session-id s-prm\n`)
  await h.waitFor(`window.__mahas.getState().resumeSessions['s-prm']`, 'session registered')

  // a second project+ws (distinct path — addProject dedupes on path) so
  // removing A exercises the active-workspace fallback
  const { pid: pidB, wsId: wsB } = await h.ev(`(() => {
    const s = window.__mahas.getState()
    const p = s.addProject('/tmp')
    s.createWorkspace(p.id)
    const w = window.__mahas.getState().workspaces.at(-1)
    s.activateWorkspace(w.id)
    return { pid: p.id, wsId: w.id }
  })()`)
  // re-activate A's workspace — deleting must fix a dangling activeWorkspaceId
  const wsA = await h.ev(
    `(() => { const w = window.__mahas.getState().workspaces.find((x) => x.projectId === ${JSON.stringify(pidA)}); window.__mahas.getState().activateWorkspace(w.id); return w.id })()`
  )

  await h.ev(`window.__mahas.getState().removeProject(${JSON.stringify(pidA)})`)
  await sleep(300)
  const after = await h.ev(`(() => {
    const s = window.__mahas.getState()
    return {
      projGone: !s.projects.some((p) => p.id === ${JSON.stringify(pidA)}),
      wsLeft: s.workspaces.filter((w) => w.projectId === ${JSON.stringify(pidA)}).length,
      active: s.activeWorkspaceId,
      recGone: !s.resumeSessions['s-prm']
    }
  })()`)
  ok(after.projGone, 'project removed from registry')
  ok(after.wsLeft === 0, 'its workspaces are gone')
  ok(after.active === wsB, `activeWorkspaceId fell back to a surviving workspace (${after.active})`)
  ok(after.recGone, 'resume records under the dead workspaces were dropped')
  ok(existsSync(ROOT), 'the project directory on disk is untouched')
  await sleep(800)
  ok(
    pgrep('mahas-fake.mjs --session-id s-prm').length === 0,
    'agent running in the removed workspace was killed with its tab'
  )

  // removing the last project must leave a valid empty state
  await h.ev(`window.__mahas.getState().removeProject(${JSON.stringify(pidB)})`)
  await sleep(300)
  const empty = await h.ev(`(() => {
    const s = window.__mahas.getState()
    return { ws: s.workspaces.length, active: s.activeWorkspaceId, dom: !!document.querySelector('.empty-state') }
  })()`)
  ok(empty.ws === 0 && empty.active === null, 'last project removed → no workspaces, no active id')
  ok(empty.dom, 'empty state screen renders')
  await h.quit()
}

async function scBrowserFile() {
  console.log('\n■ browserfile — html opens as a file:// tab in a browser pane')
  const h = await boot('browserfile')
  await mkws(h)
  const page = join(BASE, 'pa ge#1.html') // space + '#' — encoding must survive
  writeFileSync(page, '<h1>hi</h1>')
  const f1 = 'file://' + page.split('/').map(encodeURIComponent).join('/')
  const f2 = 'file:///tmp/other.html'

  // a fresh workspace has one leaf — the single-leaf exception splits it
  // right and the web block lands in the new pane instead of stacking
  await h.ev(`window.__mahas.getState().openUrlInBrowser(${JSON.stringify(f1)}, undefined, true)`)
  const first = await h.ev(`(() => {
    const s = window.__mahas.getState()
    const w = s.workspaces[0]
    const leaf = Object.values(w.panes).find((p) =>
      p.tabs.some((t) => t.kind === 'web'))
    const wt = leaf?.tabs.find((t) => t.kind === 'web')
    return Object.keys(w.panes).length === 2 && leaf?.tabs.length === 1 &&
      wt?.url === ${JSON.stringify(f1)} && leaf.activeTabId === wt.id
  })()`)
  ok(first === true, 'file url on a one-leaf workspace split it right')

  const loaded = await h
    .waitFor(
      `(() => {
        const wv = document.querySelector('webview')
        return wv && wv.getURL() === ${JSON.stringify(f1)} ? wv.getURL() : null
      })()`,
      'webview loaded the file url'
    )
    .catch(() => null)
  ok(loaded === f1, `webview navigated to the file (${loaded})`)

  // two leaves now — a second file open stacks into the focused leaf and
  // the loaded page must not be clobbered
  await h.ev(`window.__mahas.getState().openUrlInBrowser(${JSON.stringify(f2)}, undefined, true)`)
  const after = await h.ev(`(() => {
    const leaf = Object.values(window.__mahas.getState().workspaces[0].panes)
      .find((p) => p.tabs.some((t) => t.kind === 'web'))
    const wts = leaf.tabs.filter((t) => t.kind === 'web')
    return { urls: wts.map((t) => t.url), active: wts.at(-1).id === leaf.activeTabId }
  })()`)
  ok(
    after.urls.length === 2 && after.urls[0] === f1 && after.urls[1] === f2 && after.active,
    'second open appended a tab instead of replacing the page'
  )
  await h.quit()
}

async function scTabDnd() {
  console.log('\n■ tabdnd — hold-drag a tab: reorder, split, stack, cross-workspace')
  const h = await boot('tabdnd')
  const { wsId } = await mkws(h)
  const t1 = await h.term()
  const paneA = t1.paneId
  const tabB = await addTermTab(h, wsId, paneA)
  const tabC = await addTermTab(h, wsId, paneA)
  const ptyB = await ptyForTab(h, tabB)
  const ptyC = await ptyForTab(h, tabC)

  // 1) reorder: drag tab A past tab C → [B, C, A]
  await dragTab(h, t1.tabId, center(`'.pane-tabs .tstrip'`))
  // the strip's right edge lands past every midpoint → gap index = end.
  // aim just left of the '+' add-control instead (safer than the wrap edge)
  let ids = await paneTabIds(h, wsId, paneA)
  // if the first attempt didn't move it (timing), try the explicit position
  if (ids?.[0] === t1.tabId) {
    await dragTab(h, t1.tabId, `(() => {
      const el = document.querySelector('.pane-tabs .tab-add')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left - 2, y: r.top + r.height / 2 }
    })()`)
    ids = await paneTabIds(h, wsId, paneA)
  }
  ok(
    ids?.join() === [tabB, tabC, t1.tabId].join(),
    `in-strip drag reordered tabs (got ${ids})`
  )

  // 2) split: drag tab B onto the right edge of its own pane → new leaf
  await dragTab(
    h,
    tabB,
    `(() => {
      const el = document.querySelector('.pane[data-pane-id="${paneA}"]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.right - 4, y: r.top + r.height / 2 }
    })()`
  )
  const split = await h.ev(`(() => {
    const w = window.__mahas.getState().workspaces.find((x) => x.id === ${JSON.stringify(wsId)})
    const panes = Object.values(w.panes)
    const host = panes.find((p) => p.tabs.some((t) => t.id === ${JSON.stringify(tabB)}))
    return { leaves: panes.length, host: host?.id, srcTabs: w.panes[${JSON.stringify(paneA)}]?.tabs.length }
  })()`)
  ok(
    split.leaves === 2 && split.host && split.host !== paneA && split.srcTabs === 2,
    `edge drop split a tab into a new leaf (${JSON.stringify(split)})`
  )

  // 3) stack: drag tab B's tab back onto the source pane's strip → rejoin
  await dragTab(h, tabB, center(`'.pane[data-pane-id="${paneA}"] .tstrip'`))
  const restacked = await h.ev(`(() => {
    const w = window.__mahas.getState().workspaces.find((x) => x.id === ${JSON.stringify(wsId)})
    const p = w.panes[${JSON.stringify(paneA)}]
    return { panes: Object.keys(w.panes).length, tabs: p?.tabs.map((t) => t.id), active: p?.activeTabId }
  })()`)
  ok(
    restacked.panes === 1 && restacked.tabs?.join() === [tabC, t1.tabId, tabB].join() &&
      restacked.active === tabB,
    `strip drop restacked the tab (${JSON.stringify(restacked)})`
  )

  // 4) cross-workspace: drag tab C onto ws2's workspace tab → new leaf there
  const ws2 = await h.ev(`(() => {
    const s = window.__mahas.getState()
    s.createWorkspace(s.projects[0].id)
    return s.workspaces.at(-1).id
  })()`)
  await h.ev(`window.__mahas.getState().activateWorkspace(${JSON.stringify(wsId)})`)
  await dragTab(h, tabC, center(`'.ws-strip .ctab[data-tab-id="${ws2}"]'`))
  const moved = await h.ev(`(() => {
    const s = window.__mahas.getState()
    const w2 = s.workspaces.find((x) => x.id === ${JSON.stringify(ws2)})
    const host = Object.values(w2.panes).find((p) =>
      p.tabs.some((t) => t.id === ${JSON.stringify(tabC)}))
    const w1 = s.workspaces.find((x) => x.id === ${JSON.stringify(wsId)})
    return {
      active: s.activeWorkspaceId,
      inWs2: !!host,
      w1Tabs: w1.panes[${JSON.stringify(paneA)}]?.tabs.map((t) => t.id)
    }
  })()`)
  ok(
    moved.active === ws2 && moved.inWs2 && moved.w1Tabs?.join() === [t1.tabId, tabB].join(),
    `ws-tab drop moved the tab to a new leaf in ws2 (${JSON.stringify(moved)})`
  )

  // 5) moved terminals keep their live pty sessions — no respawn
  const ptys = await h.ev(`(() => {
    const s = window.__mahas.getState()
    const find = (id) => {
      for (const w of s.workspaces)
        for (const p of Object.values(w.panes)) {
          const t = p.tabs.find((x) => x.id === id)
          if (t) return t.pty
        }
      return null
    }
    return { b: find(${JSON.stringify(tabB)}), c: find(${JSON.stringify(tabC)}) }
  })()`)
  ok(
    ptys.b === ptyB && ptys.c === ptyC,
    `moved tabs kept their pty sessions (b:${ptys.b === ptyB} c:${ptys.c === ptyC})`
  )
  await h.quit()
}

async function scStatus() {
  console.log('\n■ status — close-slot agent dots: working pulse / input amber / error red')
  const h = await boot('status', { focus: 'focused' })
  const { wsId: ws1 } = await mkws(h)
  const t1 = await h.term()
  await h.type(t1.pty, `${FAKE} --storm --session-id s-st\n`)
  await sleep(1500)

  // data-st on the tab's close button = the rendered status (null → plain X)
  const stOf = (tabId) => `(() => {
    const b = document.querySelector('.pane-tabs .ctab[data-tab-id="${tabId}"] .ctab-close')
    return b ? (b.dataset.st ?? null) : 'NO-BUTTON'
  })()`
  const tabWorking = (tabId) => `(() => {
    for (const w of window.__mahas.getState().workspaces)
      for (const p of Object.values(w.panes)) {
        const t = p.tabs.find((x) => x.id === ${JSON.stringify(tabId)})
        if (t) return t.working === true
      }
    return null
  })()`

  // turn-start → working flag + the pulsing dot on the emitting tab
  await h.type(t1.pty, 'u')
  await h.waitFor(tabWorking(t1.tabId), 'working flag after turn-start')
  await h.waitFor(`${stOf(t1.tabId)} === 'working'`, 'working dot renders')
  ok(true, 'turn-start lit the working pulse on the emitting tab')

  // turn-complete drops it — back to the plain X
  await h.type(t1.pty, 'c')
  await h.waitFor(`${tabWorking(t1.tabId)} === false`, 'working cleared after turn-complete')
  const afterDone = await h.ev(stOf(t1.tabId))
  ok(afterDone !== 'working', `close slot left working state (got ${afterDone})`)
  // fake --storm keeps painting for ~2.5s like Codex's idle TUI; that must
  // not relight the pulse (hook turn-complete latches idle)
  await sleep(3000)
  const afterStorm = await h.ev(tabWorking(t1.tabId))
  ok(afterStorm === false, `post-turn output storm did not relight working (got ${afterStorm})`)

  // needs-input on an off-screen workspace tab → unread → amber dot.
  // (attended would still badge but read-on-view sweeps it instantly, so the
  // stable observable case is ambient)
  const ws2 = await h.ev(`(() => {
    let s = window.__mahas.getState()
    s.createWorkspace(s.projects[0].id)
    s = window.__mahas.getState()
    const w = s.workspaces.at(-1)
    s.newBlock('term', w.id)
    s.activateWorkspace(${JSON.stringify(ws1)})
    return w.id
  })()`)
  const t2 = await h.waitFor(
    `(() => {
      const w = window.__mahas.getState().workspaces.find((x) => x.id === ${JSON.stringify(ws2)})
      const p = Object.values(w.panes).find((p) => p.tabs.some((t) => t.kind === 'term'))
      const t = p?.tabs?.find((t) => t.kind === 'term')
      return t?.pty ? { paneId: p.id, tabId: t.id, pty: t.pty } : null
    })()`,
    'ws2 terminal'
  )
  await h.type(t2.pty, `${FAKE} --session-id s-st2\n`)
  await sleep(1500)
  // Devin-style `[Error]` banner with no hook — off-screen so the unread
  // error dot stays (attended would pre-read it)
  await h.type(t2.pty, 'b')
  await h.waitFor(`${stOf(t2.tabId)} === 'error'`, 'pty rate-limit banner shows error dot')
  ok(true, 'pty error banner lit the error dot without a hook')
  await h.type(t2.pty, 'n')
  await h.waitFor(`${stOf(t2.tabId)} === 'input'`, 'amber dot for pending needs-input')
  ok(true, 'unread needs-input shows the input dot')

  // turn-complete settles the ask, then error → red dot
  await h.type(t2.pty, 'c')
  await h.type(t2.pty, 'e')
  await h.waitFor(`${stOf(t2.tabId)} === 'error'`, 'red dot for unread error')
  ok(true, 'unread error shows the error dot')

  // checking it (read-on-view) returns the close slot to the plain X — the
  // working flag also falls once the fake goes quiet (~1.6 s silence)
  await h.ev(`document.hasFocus = () => true`)
  await h.ev(`window.__mahas.getState().activateWorkspace(${JSON.stringify(ws2)})`)
  await h.waitFor(`${stOf(t2.tabId)} === null`, 'status cleared after attending', 10000)
  ok(true, 'seen state restores the plain close X')
  await h.quit()
}

// ---------- runner ----------

const ALL = {
  orphans: scOrphans,
  resume: scResume,
  attention: scAttention,
  status: scStatus,
  adopt: scAdopt,
  projectrm: scProjectRm,
  browserfile: scBrowserFile,
  tabdnd: scTabDnd
}
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
