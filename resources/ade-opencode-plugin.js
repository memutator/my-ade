// ade opencode plugin — emits an ade event when an opencode session goes idle,
// errors, or waits on a user decision. Installed to
// ~/.config/opencode/plugins/ade-events.js by ade's "Agent hooks" installer.
// OpenCode loads every file in that directory; `directory` is the project dir
// the session was opened in.
//
// Every observed event is also captured to hook-raw.log (always on, tail-kept)
// — that file is the evidence base for the per-harness event table in
// docs/notifications.md.
import { appendFileSync, mkdirSync, openSync, readSync, closeSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = process.env.ADE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ade')
const file = process.env.ADE_EVENTS_FILE || join(dir, 'agent-events.log')
const rawFile = join(dir, 'hook-raw.log')
const RAW_CAP = 1024 * 1024

const KIND = {
  'session.idle': 'turn-complete',
  'session.error': 'error',
  'session.created': 'session-start',
  'session.deleted': 'session-end',
  'permission.asked': 'needs-input',
  'permission.updated': 'needs-input',
  'question.asked': 'needs-input'
}

// user pressed Esc — a cancel, not a failure (spec: user aborts never notify)
function isAbort(p) {
  const e = p.error
  const s = String(e && (e.name || e.message || e.data?.message) || '')
  return /abort/i.test(s)
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function clipJson(obj, n) {
  try {
    const s = JSON.stringify(obj)
    return s && s.length > n ? s.slice(0, n - 1) + '…' : obj
  } catch {
    return undefined
  }
}

function logRaw(entry) {
  try {
    mkdirSync(dir, { recursive: true })
    try {
      const size = statSync(rawFile).size
      if (size > RAW_CAP) {
        const keep = Buffer.alloc(RAW_CAP >> 1)
        const fd = openSync(rawFile, 'r')
        const n = readSync(fd, keep, 0, keep.length, size - keep.length)
        closeSync(fd)
        writeFileSync(rawFile, keep.subarray(0, n))
      }
    } catch {
      /* fresh file */
    }
    appendFileSync(rawFile, JSON.stringify(entry) + '\n')
  } catch {
    /* never disturb opencode */
  }
}

// sessions spawned by the task tool are sub-agents — their own lifecycle is
// tracked via session.created/updated (info.parentID), and their idle is
// demoted to tracking: the parent session's idle is the user-visible unit
const childSessions = new Set()
const lastLoggedType = new Map()

export const AdeEventsPlugin = async ({ directory }) => ({
  event: async ({ event }) => {
    try {
      const p = event.properties || {}

      // learn session parentage before classifying idles
      if (event.type === 'session.created' || event.type === 'session.updated') {
        const info = p.info || p.session || {}
        const parent = info.parentID ?? info.parentId ?? info.parent
        if (info.id && parent) childSessions.add(info.id)
      }

      const now = Date.now()
      let kind = KIND[event.type]
      if (kind) {
        if (event.type === 'session.error' && isAbort(p)) kind = 'turn-cancelled'
        const sid = p.sessionID || p.info?.id
        if (
          (event.type === 'session.idle' ||
            event.type === 'session.created' ||
            event.type === 'session.deleted') &&
          childSessions.has(sid)
        )
          kind = 'other' // sub-agent lifecycles aren't resumable targets
      }

      // raw capture — mapped kinds always; unmapped types throttled to one
      // line per 10s each so the stream stays readable
      if (KIND[event.type] || now - (lastLoggedType.get(event.type) || 0) > 10_000) {
        lastLoggedType.set(event.type, now)
        logRaw({
          v: 1,
          ts: now,
          provider: 'opencode',
          type: event.type,
          event: kind,
          sessionId: p.sessionID || p.info?.id,
          cwd: directory,
          payload: clipJson(p, 4000)
        })
      }

      if (!kind) return

      mkdirSync(dir, { recursive: true })
      appendFileSync(
        file,
        JSON.stringify({
          v: 1,
          provider: 'opencode',
          event: kind,
          cwd: directory,
          sessionId: p.sessionID || p.info?.id,
          message: messageFor(event.type, p) || undefined,
          adeSession: process.env.ADE_SESSION || undefined,
          ts: now
        }) + '\n',
        { flag: 'a' }
      )
    } catch {
      /* never disturb opencode */
    }
  }
})

function messageFor(type, p) {
  if (type === 'permission.asked' || type === 'permission.updated')
    return clip([p.permission, ...(p.patterns || [])].filter(Boolean).join(' '), 300)
  if (type === 'session.error') {
    const e = p.error
    return clip(e && (e.data?.message || e.message || e.name), 300)
  }
  if (type === 'question.asked') {
    const q = (p.questions || [])[0]
    return clip(q && (q.question || q.header), 300)
  }
  return undefined
}
