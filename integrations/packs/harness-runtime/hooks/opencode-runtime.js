// mahas opencode runtime — the event bridge the installed plugin entry
// (`mahas-opencode-plugin.js`) re-exports. Owned by `builtin.harness-runtime`;
// both files are installed together by the `opencode` installer, so this
// module must stay a sibling of the entry file inside opencode's plugins dir.
//
// Emits a mahas event when an opencode session goes idle, errors, or waits on
// a user decision. Every observed event is also captured to hook-raw.log
// (always on, tail-kept) — the evidence base for the per-harness event table
// in docs/notifications.md.
//
// Identity contract (v2): child sessions keep their native session id and
// record `child`/`parentSessionId`; the notification policy is recorded in
// `policy` instead of being applied by deleting identity.
import { appendFileSync, mkdirSync, openSync, readSync, closeSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = process.env.MAHAS_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'mahas')
const file = process.env.MAHAS_EVENTS_FILE || join(dir, 'agent-events.log')
const rawFile = join(dir, 'hook-raw.log')
const RAW_CAP = 1024 * 1024

const KIND = {
  'session.idle': 'turn-complete',
  'session.error': 'error',
  'session.created': 'session-start',
  'session.deleted': 'session-end',
  'permission.asked': 'needs-input',
  'question.asked': 'needs-input'
}

// permission/question asks can be answered almost instantly — auto-approve
// rules and "always" grants reply within ~20ms. Hold needs-input for a short
// grace window and cancel it when the matching *.replied arrives, so asks the
// user never actually had to answer don't ring the bell.
const ASK_GRACE_MS = 800
const pendingAsks = new Map() // requestId → timeout

// user pressed Esc — a cancel, not a failure (spec: user aborts never notify)
function isAbort(p) {
  const e = p.error
  const s = String((e && (e.name || e.message || (e.data && e.data.message))) || '')
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

function messageFor(type, p) {
  if (type === 'permission.asked' || type === 'permission.updated')
    return clip([p.permission, ...(p.patterns || [])].filter(Boolean).join(' '), 300)
  if (type === 'session.error') {
    const e = p.error
    return clip(e && ((e.data && e.data.message) || e.message || e.name), 300)
  }
  if (type === 'question.asked') {
    const q = (p.questions || [])[0]
    return clip(q && (q.question || q.header), 300)
  }
  return undefined
}

// sessions spawned by the task tool are sub-agents — their own lifecycle is
// tracked via session.created/updated (info.parentID), and their idle is
// demoted to tracking: the parent session's idle is the user-visible unit
const childSessions = new Set()
const lastLoggedType = new Map()

export const MahasEventsPlugin = async ({ directory }) => ({
  event: async ({ event }) => {
    try {
      const p = event.properties || {}

      // learn session parentage before classifying idles
      if (event.type === 'session.created' || event.type === 'session.updated') {
        const info = p.info || p.session || {}
        const parent = info.parentID !== undefined ? info.parentID : info.parentId !== undefined ? info.parentId : info.parent
        if (info.id && parent) childSessions.add(info.id)
      }

      const now = Date.now()
      let kind = KIND[event.type]
      const sid = p.sessionID || (p.info && p.info.id) || (p.session && p.session.id)
      const parentSessionId =
        (p.info && (p.info.parentID || p.info.parentId)) ||
        (p.session && (p.session.parentID || p.session.parentId))
      const child = Boolean(parentSessionId) || (sid ? childSessions.has(sid) : false)
      if (kind) {
        if (event.type === 'session.error' && isAbort(p)) kind = 'turn-cancelled'
        if (
          (event.type === 'session.idle' ||
            event.type === 'session.created' ||
            event.type === 'session.deleted') &&
          child
        )
          kind = 'other' // sub-agent lifecycles aren't resumable targets
      }

      // an answered ask cancels its pending needs-input; replies never emit
      if (event.type === 'permission.replied' || event.type === 'question.replied') {
        const timer = p.requestID && pendingAsks.get(p.requestID)
        if (timer) {
          clearTimeout(timer)
          pendingAsks.delete(p.requestID)
        }
      }

      // raw capture — mapped kinds always; unmapped types throttled to one
      // line per 10s each so the stream stays readable
      if (KIND[event.type] || now - (lastLoggedType.get(event.type) || 0) > 10_000) {
        lastLoggedType.set(event.type, now)
        logRaw({
          v: 2,
          ts: now,
          provider: 'opencode',
          type: event.type,
          event: kind,
          nativeEvent: event.type,
          sessionId: sid,
          parentSessionId: parentSessionId,
          child: child,
          cwd: directory,
          payload: clipJson(p, 4000)
        })
      }

      if (!kind) return

      // identity is preserved; the exclusion policy for child sessions rides
      // separately (same shape as the shared CLI transport)
      const policy = child ? { demote: true } : undefined
      const write = () =>
        appendFileSync(
          file,
          JSON.stringify({
            v: 2,
            provider: 'opencode',
            event: kind,
            nativeEvent: event.type,
            cwd: directory,
            sessionId: sid,
            parentSessionId: parentSessionId,
            child: child || undefined,
            mahasSession: process.env.MAHAS_SESSION || undefined,
            external: process.env.MAHAS_SESSION ? undefined : true,
            policy: policy,
            message: messageFor(event.type, p) || undefined,
            // pty-stamped hosting pane/tab — exact event attribution
            paneId: process.env.MAHAS_PANE || undefined,
            tabId: process.env.MAHAS_TAB || undefined,
            namespace: 'hook',
            installationId: process.env.MAHAS_INSTALLATION_ID || undefined,
            machineId: process.env.MAHAS_MACHINE_ID || undefined,
            ts: now
          }) + '\n',
          { flag: 'a' }
        )

      mkdirSync(dir, { recursive: true })
      if (
        kind === 'needs-input' &&
        (event.type === 'permission.asked' || event.type === 'question.asked') &&
        p.id
      ) {
        // grace window — auto-approved asks resolve in ~20ms; only ring the
        // bell when the request is still open
        const prev = pendingAsks.get(p.id)
        if (prev) clearTimeout(prev)
        pendingAsks.set(
          p.id,
          setTimeout(() => {
            pendingAsks.delete(p.id)
            try {
              write()
            } catch {
              /* never disturb opencode */
            }
          }, ASK_GRACE_MS)
        )
        return
      }
      write()
    } catch {
      /* never disturb opencode */
    }
  }
})
