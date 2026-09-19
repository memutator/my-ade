// mahas main — agent manifest / provider icon / OS notification IPC.
//
// Provider icons follow Chrome's favicon model: the manifest names a domain,
// we fetch one icon, sniff its real type (a favicon endpoint happily returns
// PNG, ICO or JPEG for the same URL) and cache the bytes under userData. The
// renderer gets a data URL, or null to fall back to a letter monogram — a
// missing icon is never an error the user should see.
//
// Notifications are OS banners only: the click is forwarded back so the
// renderer's own navigation (workspace/pane/tab) runs, because main does not
// know the shell state.

import { app, ipcMain, net, Notification, shell } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { appendCapped, decisionsFilePath } from '../eventsFile'

export interface AgentIpcDeps {
  /** OS-notification click target */
  focusMain: () => void
  mainWindow: () => Electron.BrowserWindow | null
  icon?: string
  /** push the manifest's match patterns to the pty host */
  configureAgents: (patterns: Record<string, string[]>) => void
}

const agentsDir = (): string =>
  is.dev ? join(app.getAppPath(), 'resources', 'agents') : join(process.resourcesPath, 'agents')

/** read + parse the agent manifest; {} when it is missing or malformed */
function readManifest(): Record<string, { domain?: string; match?: string[] }> {
  try {
    return JSON.parse(readFileSync(join(agentsDir(), 'manifest.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** image type from magic bytes — the URL's extension proves nothing */
function sniffImageType(b: Buffer): string | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 1) return 'image/x-icon'
  if (b.length > 2 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b.length > 6 && b.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  if (b.length > 12 && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

export function registerAgentIpc(deps: AgentIpcDeps): void {
  ipcMain.handle('agents:manifest', () => readManifest())

  ipcMain.on('agents:config', (_e, patterns: Record<string, string[]>) => {
    if (patterns && typeof patterns === 'object') deps.configureAgents(patterns)
  })

  ipcMain.handle('agents:icon', async (_e, id: string) => {
    try {
      const domain = readManifest()[id]?.domain
      if (!domain || !/^[\w.-]+\.[a-z]{2,}$/.test(domain)) return null
      const dir = join(app.getPath('userData'), 'agent-icons')
      const file = join(dir, `${id}.img`)
      if (existsSync(file)) {
        const buf = readFileSync(file)
        return `data:${sniffImageType(buf) ?? 'image/png'};base64,` + buf.toString('base64')
      }
      // s2 favicons normalizes everything to PNG; the site's own
      // /favicon.ico is the fallback source
      for (const url of [
        `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
        `https://${domain}/favicon.ico`
      ]) {
        try {
          const res = await net.fetch(url, { signal: AbortSignal.timeout(5000) })
          if (!res.ok) continue
          const buf = Buffer.from(await res.arrayBuffer())
          const mime = sniffImageType(buf)
          if (!mime || buf.length > 512 * 1024) continue
          mkdirSync(dir, { recursive: true })
          writeFileSync(file, buf)
          return `data:${mime};base64,` + buf.toString('base64')
        } catch {
          /* try next source */
        }
      }
      return null
    } catch {
      return null
    }
  })

  ipcMain.on('notify:show', (_e, m: { title: string; body?: string }) => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: m.title, body: m.body ?? '', icon: deps.icon })
    n.on('click', () => {
      deps.focusMain()
      deps.mainWindow()?.webContents.send('notify:clicked', m)
    })
    n.show()
  })
  // renderer notification-policy verdicts — see docs/notifications.md
  ipcMain.on('notify:decision', (_e, rec: unknown) => {
    appendCapped(decisionsFilePath(), rec)
  })

  ipcMain.on('shell:openExternal', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) void shell.openExternal(url)
  })
}

/** Push the manifest's match patterns into the pty host at boot. The host
 *  walks process trees against them to detect agent CLIs. */
export function pushAgentConfig(configureAgents: (p: Record<string, string[]>) => void): void {
  const manifest = readManifest()
  const patterns: Record<string, string[]> = {}
  for (const [id, info] of Object.entries(manifest)) {
    if (Array.isArray(info.match) && info.match.length) patterns[id] = info.match
  }
  if (Object.keys(patterns).length) configureAgents(patterns)
}
