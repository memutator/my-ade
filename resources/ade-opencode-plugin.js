// ade opencode plugin — emits an ade event when an opencode session goes idle.
// Installed to ~/.config/opencode/plugins/ade-events.js by ade's "Agent hooks"
// installer. OpenCode loads every file in that directory; `directory` is the
// project dir the session was opened in.
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = process.env.ADE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ade')
const file = process.env.ADE_EVENTS_FILE || join(dir, 'agent-events.log')

export const AdeEventsPlugin = async ({ directory }) => ({
  event: async ({ event }) => {
    if (!event || event.type !== 'session.idle') return
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(
        file,
        JSON.stringify({
          v: 1,
          provider: 'opencode',
          event: 'turn-complete',
          cwd: directory,
          sessionId: event.properties?.sessionID,
          ts: Date.now()
        }) + '\n',
        { flag: 'a' }
      )
    } catch {
      /* never disturb opencode */
    }
  }
})
