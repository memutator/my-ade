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
const FORWARD_FILE = path.join(CONFIG_DIR, 'notify-forward.json')

function configHome() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
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

// Map each harness's raw hook event name to an ade event.
function normalizeEvent(raw, fallback) {
  const name = String(raw || fallback || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '')
  switch (name) {
    case 'stop':
    case 'stopped':
    case 'agentturncomplete':
    case 'stopcancelled':
    case 'stopfailure':
    case 'taskcomplete':
      return 'turn-complete'
    case 'notification':
      return 'turn-complete' // grok idle_prompt / permission pings settle the turn
    case 'sessionstart':
      return 'session-start'
    case 'sessionend':
      return 'session-end'
    case 'userpromptsubmit':
      return 'turn-start'
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
    argEvent
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
  const message = clip(
    firstString(
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
  emit(buildEvent(provider, argEvent, payload))
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
