// Per-harness hook installers. Electron-free (node builtins only) so the whole
// module can be exercised with plain node against a fake HOME.
//
// Each provider knows how to detect its CLI, report whether the ade hook is
// installed, and install it. Installers are additive and idempotent: they never
// remove the user's existing hooks, they back up any file they mutate
// (<file>.ade-bak), and they only run when the user clicks Install in Settings.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { adeConfigDir } from './eventsFile'

export interface HookStatus {
  id: string
  label: string
  mechanism: string
  available: boolean
  installed: boolean
  detail?: string
  configPath: string
}

export interface InstallResult {
  ok: boolean
  error?: string
  detail?: string
}

interface ProviderDef {
  id: string
  label: string
  bin: string
  mechanism: string
  configPath: (home: string) => string
  installed: (home: string) => boolean
  install: (home: string, cmd: string, argv: string[], pluginSrc: string) => InstallResult
  detail?: (home: string) => string | undefined
}

function configHome(home: string): string {
  return process.env.XDG_CONFIG_HOME || path.join(home, '.config')
}

function binAvailable(bin: string): boolean {
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' })
  return r.status === 0
}

function backup(file: string): void {
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.ade-bak')
  } catch {
    /* backup is best-effort */
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function fileMentions(file: string, needle: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').includes(needle)
  } catch {
    return false
  }
}

// Append one matcher-group `{hooks:[…command…]}` to `hooks.<event>[]` inside a
// settings file (`hooks` key for devin, `hooks.events` for zcode, top-level
// `hooks` for claude). Returns false when nothing was added.
function appendJsonHook(
  file: string,
  event: string,
  group: Record<string, unknown>,
  opts: { eventsKey?: boolean; enable?: boolean } = {}
): InstallResult {
  const cfg = readJson(file) ?? {}
  const hooks = (cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : {}) as Record<
    string,
    unknown
  >
  cfg.hooks = hooks
  if (opts.enable) hooks.enabled = true
  const container = (
    opts.eventsKey
      ? ((hooks.events && typeof hooks.events === 'object' ? hooks.events : {}) as Record<
          string,
          unknown
        >)
      : hooks
  ) as Record<string, unknown>
  if (opts.eventsKey) hooks.events = container
  const arr = Array.isArray(container[event]) ? (container[event] as unknown[]) : []
  if (arr.some((g) => JSON.stringify(g).includes('ade-hook')))
    return { ok: true, detail: 'already installed' }
  arr.push(group)
  container[event] = arr
  fs.mkdirSync(path.dirname(file), { recursive: true })
  backup(file)
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  return { ok: true }
}

function parseTomlStringArray(line: string): string[] {
  const i = line.indexOf('[')
  const j = line.lastIndexOf(']')
  if (i < 0 || j <= i) return []
  const inner = line.slice(i + 1, j)
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(inner))) {
    try {
      out.push(JSON.parse(`"${m[1]}"`))
    } catch {
      out.push(m[1])
    }
  }
  return out
}

const HOOK_MARK = 'ade-hook'

const PROVIDERS: ProviderDef[] = [
  {
    id: 'claude',
    label: 'Claude',
    bin: 'claude',
    mechanism: 'Stop hook — ~/.claude/settings.json',
    configPath: (home) => path.join(home, '.claude', 'settings.json'),
    installed: (home) => fileMentions(path.join(home, '.claude', 'settings.json'), HOOK_MARK),
    install: (home, cmd) =>
      appendJsonHook(path.join(home, '.claude', 'settings.json'), 'Stop', {
        hooks: [{ type: 'command', command: cmd, timeout: 10 }]
      })
  },
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    mechanism: 'notify — ~/.codex/config.toml',
    configPath: (home) => path.join(home, '.codex', 'config.toml'),
    detail: (home) => {
      const file = path.join(home, '.codex', 'config.toml')
      try {
        const line = fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .find((l) => /^\s*notify\s*=/.test(l))
        if (line && !line.includes(HOOK_MARK))
          return 'existing notify command is kept — ade forwards the payload to it'
      } catch {
        /* no file */
      }
      return undefined
    },
    installed: (home) => {
      const file = path.join(home, '.codex', 'config.toml')
      try {
        const line = fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .find((l) => /^\s*notify\s*=/.test(l))
        return !!line && line.includes(HOOK_MARK)
      } catch {
        return false
      }
    },
    install: (home, _cmd, argv) => {
      const file = path.join(home, '.codex', 'config.toml')
      const notifyLine = `notify = [${argv.map((a) => JSON.stringify(a)).join(', ')}]`
      let text = ''
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        /* fresh config */
      }
      const lines = text.split('\n')
      const idx = lines.findIndex((l) => /^\s*notify\s*=/.test(l))
      if (idx >= 0) {
        if (lines[idx].includes(HOOK_MARK)) return { ok: true, detail: 'already installed' }
        // Preserve the displaced command: the hook script re-invokes it with the payload.
        const prev = parseTomlStringArray(lines[idx])
        if (prev.length) {
          const fwdFile = path.join(adeConfigDir(home), 'notify-forward.json')
          let table: Record<string, unknown> = {}
          try {
            table = JSON.parse(fs.readFileSync(fwdFile, 'utf8'))
          } catch {
            /* none yet */
          }
          table.codex = prev
          fs.mkdirSync(path.dirname(fwdFile), { recursive: true })
          fs.writeFileSync(fwdFile, JSON.stringify(table, null, 2) + '\n', 'utf8')
        }
        lines[idx] = notifyLine
        backup(file)
        fs.writeFileSync(file, lines.join('\n'), 'utf8')
        return { ok: true, detail: 'previous notify command chained after ade' }
      }
      // `notify` is a top-level key: it must precede the first [table] header.
      const firstTable = lines.findIndex((l) => /^\s*\[/.test(l))
      if (firstTable >= 0) lines.splice(firstTable, 0, notifyLine)
      else lines.push(notifyLine)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      backup(file)
      fs.writeFileSync(file, lines.join('\n'), 'utf8')
      return { ok: true }
    }
  },
  {
    id: 'grok',
    label: 'Grok',
    bin: 'grok',
    mechanism: 'Stop + idle hooks — ~/.grok/hooks/ade.json',
    configPath: (home) => path.join(home, '.grok', 'hooks', 'ade.json'),
    installed: (home) => fileMentions(path.join(home, '.grok', 'hooks', 'ade.json'), HOOK_MARK),
    install: (home, cmd) => {
      const file = path.join(home, '.grok', 'hooks', 'ade.json')
      const doc = {
        description: 'ade turn notifications',
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: cmd, timeout: 10 }] }],
          StopCancelled: [{ hooks: [{ type: 'command', command: cmd }] }],
          StopFailure: [{ hooks: [{ type: 'command', command: cmd }] }],
          Notification: [{ matcher: 'idle_prompt', hooks: [{ type: 'command', command: cmd }] }]
        }
      }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8')
      return { ok: true }
    }
  },
  {
    id: 'devin',
    label: 'Devin',
    bin: 'devin',
    mechanism: 'Stop hook — ~/.config/devin/config.json',
    configPath: (home) => path.join(configHome(home), 'devin', 'config.json'),
    installed: (home) =>
      fileMentions(path.join(configHome(home), 'devin', 'config.json'), HOOK_MARK),
    install: (home, cmd) =>
      appendJsonHook(path.join(configHome(home), 'devin', 'config.json'), 'Stop', {
        hooks: [{ type: 'command', command: cmd, timeout: 10 }]
      })
  },
  {
    id: 'zcode',
    label: 'ZCode',
    bin: 'zcode',
    mechanism: 'Stop hook — ~/.zcode/cli/config.json',
    configPath: (home) => path.join(home, '.zcode', 'cli', 'config.json'),
    installed: (home) => fileMentions(path.join(home, '.zcode', 'cli', 'config.json'), HOOK_MARK),
    install: (home, cmd) =>
      appendJsonHook(
        path.join(home, '.zcode', 'cli', 'config.json'),
        'Stop',
        { hooks: [{ type: 'command', command: cmd }] },
        { eventsKey: true, enable: true }
      )
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    mechanism: 'plugin session.idle — ~/.config/opencode/plugins',
    configPath: (home) => path.join(configHome(home), 'opencode', 'plugins', 'ade-events.js'),
    installed: (home) =>
      fileMentions(
        path.join(configHome(home), 'opencode', 'plugins', 'ade-events.js'),
        'AdeEventsPlugin'
      ),
    install: (home, _cmd, _argv, pluginSrc) => {
      const dest = path.join(configHome(home), 'opencode', 'plugins', 'ade-events.js')
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(pluginSrc, dest)
      return { ok: true }
    }
  }
]

function ensureHookCopy(home: string, hookScriptSrc: string): string {
  const dest = path.join(adeConfigDir(home), 'ade-hook.cjs')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try {
    if (
      !fs.existsSync(dest) ||
      fs.readFileSync(dest, 'utf8') !== fs.readFileSync(hookScriptSrc, 'utf8')
    ) {
      fs.copyFileSync(hookScriptSrc, dest)
    }
  } catch {
    fs.copyFileSync(hookScriptSrc, dest)
  }
  return dest
}

function hookCommand(dest: string, provider: string): string {
  return `node "${dest}" ${provider}`
}

export function hookStatuses(
  hookScriptSrc: string,
  pluginSrc: string,
  home: string = os.homedir()
): HookStatus[] {
  void hookScriptSrc
  void pluginSrc
  return PROVIDERS.filter((p) => binAvailable(p.bin)).map((p) => ({
    id: p.id,
    label: p.label,
    mechanism: p.mechanism,
    available: true,
    installed: p.installed(home),
    detail: p.detail?.(home),
    configPath: p.configPath(home)
  }))
}

export function installHook(
  providerId: string,
  hookScriptSrc: string,
  pluginSrc: string,
  home: string = os.homedir()
): InstallResult {
  const p = PROVIDERS.find((x) => x.id === providerId)
  if (!p) return { ok: false, error: `unknown provider ${providerId}` }
  if (!binAvailable(p.bin)) return { ok: false, error: `${p.bin} not found on PATH` }
  try {
    const dest = ensureHookCopy(home, hookScriptSrc)
    const cmd = hookCommand(dest, p.id)
    const argv = ['node', dest, p.id]
    return p.install(home, cmd, argv, pluginSrc)
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
}
