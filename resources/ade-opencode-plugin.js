// ade opencode plugin — emits an ade event when an opencode session goes idle,
// errors, or waits on a user decision. Installed to
// ~/.config/opencode/plugins/ade-events.js by ade's "Agent hooks" installer.
// OpenCode loads every file in that directory; `directory` is the project dir
// the session was opened in.
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = process.env.ADE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ade')
const file = process.env.ADE_EVENTS_FILE || join(dir, 'agent-events.log')

const KIND = {
  'session.idle': 'turn-complete',
  'session.error': 'error',
  'permission.asked': 'needs-input',
  'permission.updated': 'needs-input',
  'question.asked': 'needs-input'
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

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

export const AdeEventsPlugin = async ({ directory }) => ({
  event: async ({ event }) => {
    const kind = event && KIND[event.type]
    if (!kind) return
    try {
      const p = event.properties || {}
      mkdirSync(dir, { recursive: true })
      appendFileSync(
        file,
        JSON.stringify({
          v: 1,
          provider: 'opencode',
          event: kind,
          cwd: directory,
          sessionId: p.sessionID,
          message: messageFor(event.type, p) || undefined,
          adeSession: process.env.ADE_SESSION || undefined,
          ts: Date.now()
        }) + '\n',
        { flag: 'a' }
      )
    } catch {
      /* never disturb opencode */
    }
  }
})
