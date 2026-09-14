#!/usr/bin/env node
'use strict'
// ade-hook.cjs — harness-agnostic event bridge for ade.
//
// Agent harnesses invoke this script from their lifecycle hooks; it appends a
// single NDJSON event line to the ade event log, which the Electron main
// process tails and forwards to the renderer as `agent:event`.
//
//   node ade-hook.cjs <provider>               reads the hook payload JSON on stdin
//   node ade-hook.cjs <provider> <event>       stdin payload, explicit ade event name
//   node ade-hook.cjs codex '<json-payload>'   codex `notify`: payload arrives as last argv
//
// Event log: $ADE_EVENTS_FILE or ~/.config/ade/agent-events.log
// The script never writes to stdout (harness hook protocols read it), never
// throws, and always exits 0 — hook failures must not disturb the agent.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

const CONFIG_DIR = process.env.ADE_CONFIG_DIR || path.join(configHome(), 'ade')
const EVENTS_FILE = process.env.ADE_EVENTS_FILE || path.join(CONFIG_DIR, 'agent-events.log')
const RAW_FILE = path.join(CONFIG_DIR, 'hook-raw.log')
const FORWARD_FILE = path.join(CONFIG_DIR, 'notify-forward.json')
const RAW_CAP = 1024 * 1024 // tail-kept — oldest lines dropped past this

function configHome() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
}

// Every hook invocation lands here, always on: the raw payload is the
// evidence base for the per-harness event table in docs/notifications.md.
// Tail-kept — when the file exceeds RAW_CAP the newest half survives.
function logRaw(entry) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    try {
      const size = fs.statSync(RAW_FILE).size
      if (size > RAW_CAP) {
        const keep = Buffer.alloc(RAW_CAP >> 1)
        const fd = fs.openSync(RAW_FILE, 'r')
        const n = fs.readSync(fd, keep, 0, keep.length, size - keep.length)
        fs.closeSync(fd)
        fs.writeFileSync(RAW_FILE, keep.subarray(0, n))
      }
    } catch {
      /* fresh file */
    }
    fs.appendFileSync(RAW_FILE, JSON.stringify(entry) + '\n')
  } catch {
    /* logging must never disturb the agent */
  }
}

function debug(msg) {
  if (process.env.ADE_HOOK_DEBUG) {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true })
      fs.appendFileSync(path.join(CONFIG_DIR, 'hook-debug.log'), `[${new Date().toISOString()}] ${msg}\n`)
    } catch {
      /* never fail */
    }
  }
}

// Harnesses that compat-load ~/.claude/settings.json hooks (grok, devin) run
// this script too; relabel the provider by environment so events are correctly
// attributed and the app's dedupe can collapse the double registration.
function resolveProvider(argProvider) {
  if (process.env.GROK_SESSION_ID || process.env.GROK_HOOK_EVENT) return 'grok'
  if (process.env.DEVIN_PROJECT_DIR || process.env.DEVIN_SESSION_ID) return 'devin'
  return argProvider || 'unknown'
}

// Map each harness's raw hook event name to an ade event. Three kinds notify —
// `turn-complete`, `needs-input`, `error`; everything else is tracking-only:
// `turn-start`, `session-start`, `session-end`, `turn-cancelled` (user stopped
// the turn themselves), `idle` (grok's post-settle backstop ping — redundant
// with the turn-end report), `other`, `session-rename` (renderer-internal).
function normalizeEvent(raw, fallback, payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  const name = String(raw || fallback || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '')
  switch (name) {
    case 'stop':
    case 'stopped':
    case 'agentturncomplete':
    case 'taskcomplete':
      return 'turn-complete'
    case 'stopfailure':
      return 'error'
    case 'stopcancelled': {
      // cancelledBy === 'user' (or a user-* reason) = the user stopped it —
      // they know; runtime cancels (max_turns, no_progress, …) are failures
      const by = String(p.cancelledBy || p.cancelled_by || '').toLowerCase()
      const reason = String(p.reason || '').toLowerCase()
      const userish =
        by === 'user' ||
        reason === 'user_interrupt' ||
        reason === 'permission_rejected' ||
        reason === 'permission_cancelled'
      return userish ? 'turn-cancelled' : 'error'
    }
    case 'notification': {
      // grok discriminates by notificationType; claude only sends a display
      // message, so fall back to matching its idle phrasing
      const ntype = String(
        firstString(p.notificationType, p.notification_type, p.notifType)
      )
        .toLowerCase()
        .replace(/[\s_-]/g, '')
      if (ntype === 'idleprompt') return 'idle'
      if (ntype === 'taskcomplete') return 'turn-complete'
      if (ntype) return 'needs-input' // permission_prompt + any new attention type
      // no notificationType → claude-style message payloads. claude only
      // fires Notification for permission prompts and the ≥60s "waiting for
      // your input" idle — both mean the user must respond.
      return 'needs-input'
    }
    case 'permissionrequest':
    case 'permissionprompt':
    case 'permissionneeded':
    case 'elicitation':
    case 'questionasked':
    case 'question':
      return 'needs-input'
    case 'permissiondenied':
      return 'other' // policy auto-deny — the agent keeps going
    case 'sessionstart':
      return 'session-start'
    case 'sessionend':
      return 'session-end'
    case 'userpromptsubmit':
      return 'turn-start'
    // already-canonical names pass through — tools, tests, and any harness
    // speaking ade's taxonomy directly stay idempotent
    case 'needsinput':
      return 'needs-input'
    case 'turncomplete':
      return 'turn-complete'
    case 'turnstart':
      return 'turn-start'
    case 'turncancelled':
      return 'turn-cancelled'
    case 'sessionrename':
      return 'session-rename'
    case 'idle':
    case 'error':
    case 'other':
      return name
    default:
      return name ? 'other' : 'turn-complete'
  }
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function buildEvent(provider, argEvent, payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  let event = normalizeEvent(
    p.hook_event_name || p.hookEventName || p.type || p.event,
    argEvent,
    p
  )
  // grok fires an extra observe-only Stop at teardown; reclassify it.
  if (
    event === 'turn-complete' &&
    (p.reason === 'channel_closed' || p.reason === 'shutdown')
  ) {
    event = 'session-end'
  }
  const cwd = firstString(
    p.cwd,
    p.workingDirectory,
    p.workspace_root,
    p.workspaceRoot,
    process.env.GROK_WORKSPACE_ROOT,
    process.env.DEVIN_PROJECT_DIR,
    process.env.CLAUDE_PROJECT_DIR,
    process.env.CODEX_WORKSPACE_ROOT
  )
  const sessionId = firstString(
    p.session_id,
    p.sessionId,
    p['thread-id'],
    p.thread_id,
    p.threadId,
    process.env.GROK_SESSION_ID
  )
  const tool = firstString(p.tool_name, p.toolName, p.tool)
  const toolInput = p.tool_input || p.toolInput
  const toolCmd = clip(
    toolInput && typeof toolInput === 'object' ? firstString(toolInput.command) : '',
    80
  )
  const cause = firstString(p.error, p.errorType, p.error_type, p.reason)
  const detail = firstString(
    p['last-assistant-message'],
    p.lastAssistantMessage,
    p.last_assistant_message,
    p.errorDetails,
    p.error_details,
    p.reasonDetails,
    p.reason_details,
    p.message
  )
  const message = clip(
    event === 'needs-input'
      ? // permission/question payloads name the ask, not an answer — claude and
        // grok put display text in `message`, devin/zcode put `tool_name`
        firstString(p.message, p.title, toolCmd ? `${tool}: ${toolCmd}` : tool, p.reason)
      : event === 'error'
        ? // prefix the classified cause (rate_limit, max_turns, …) when the
          // detail doesn't already lead with it
          cause && detail && !detail.startsWith(cause)
          ? `${cause}: ${detail}`
          : detail || cause
        : firstString(
            p['last-assistant-message'],
            p.lastAssistantMessage,
            p.last_assistant_message,
            p.responsePreview,
            p.responseText,
            p.message
          ),
    300
  )
  return {
    v: 1,
    provider,
    event,
    cwd: cwd || undefined,
    sessionId: sessionId || undefined,
    message: message || undefined,
    // stamped by the shell env chain (pty spawn → agent → hook) so ade can
    // tell our sessions' events apart from agents running elsewhere
    adeSession: process.env.ADE_SESSION || undefined,
    // pty spawn stamps the hosting pane/tab — exact attribution, no cwd
    // guessing (tabs sharing a directory resolve to the first match)
    paneId: process.env.ADE_PANE || undefined,
    tabId: process.env.ADE_TAB || undefined,
    ts: Date.now()
  }
}

function emit(ev) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(ev) + '\n', { flag: 'a' })
  } catch (e) {
    debug(`emit failed: ${e && e.message}`)
  }
}

// codex `notify` is a single slot; when ade took it over, the displaced command
// is recorded here and we re-invoke it with the same payload so nothing breaks.
function forwardCodex(rawPayload) {
  try {
    const table = JSON.parse(fs.readFileSync(FORWARD_FILE, 'utf8'))
    const cmd = table && table.codex
    if (!Array.isArray(cmd) || !cmd.length || !rawPayload) return
    const child = spawn(cmd[0], [...cmd.slice(1), rawPayload], {
      detached: true,
      stdio: 'ignore'
    })
    child.on('error', (e) => debug(`forward failed: ${e.message}`))
    child.unref()
  } catch {
    /* no forward configured */
  }
}

function isJsonArg(s) {
  return typeof s === 'string' && s.trim().startsWith('{')
}

function finish(provider, argEvent, payload, rawArg) {
  const ev = buildEvent(provider, argEvent, payload)
  emit(ev)
  // raw capture: which env tagged this run (provider relabeling + ours
  // stamping), what the harness sent, and what ade normalized it to
  let raw
  try {
    const s = JSON.stringify(payload ?? rawArg ?? null)
    raw = s && s.length > 4000 ? s.slice(0, 4000) + '…' : (payload ?? rawArg ?? null)
  } catch {
    raw = rawArg ?? null
  }
  logRaw({
    v: 1,
    ts: Date.now(),
    provider,
    via: rawArg != null ? 'argv' : 'stdin',
    arg: argEvent || undefined,
    env: {
      ade: !!process.env.ADE_SESSION,
      grok: !!process.env.GROK_SESSION_ID || !!process.env.GROK_HOOK_EVENT,
      devin: !!process.env.DEVIN_PROJECT_DIR || !!process.env.DEVIN_SESSION_ID,
      claude: !!process.env.CLAUDE_PROJECT_DIR,
      codex: !!process.env.CODEX_WORKSPACE_ROOT
    },
    event: ev.event,
    sessionId: ev.sessionId,
    cwd: ev.cwd,
    payload: raw
  })
  if (provider === 'codex' && rawArg) forwardCodex(rawArg)
  process.exit(0)
}

function main() {
  const argProvider = process.argv[2] || ''
  const provider = resolveProvider(argProvider)
  const rest = process.argv.slice(3)
  const jsonArg = rest.find(isJsonArg)
  const argEvent = rest.find((a) => !isJsonArg(a))

  if (jsonArg !== undefined) {
    let payload = null
    try {
      payload = JSON.parse(jsonArg)
    } catch {
      payload = null
    }
    return finish(provider, argEvent, payload, jsonArg)
  }

  // stdin mode — read the hook payload to EOF, but never hang the harness.
  let buf = ''
  let done = false
  const onDone = () => {
    if (done) return
    done = true
    let payload = null
    try {
      payload = JSON.parse(buf)
    } catch {
      payload = null
    }
    finish(provider, argEvent, payload, null)
  }
  const timer = setTimeout(onDone, 4000)
  timer.unref()
  if (process.stdin.isTTY) return onDone()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => (buf += d))
  process.stdin.on('end', onDone)
  process.stdin.on('error', onDone)
}

try {
  main()
} catch (e) {
  debug(`fatal: ${e && e.message}`)
  process.exit(0)
}
