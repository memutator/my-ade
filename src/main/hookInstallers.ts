// Per-harness hook installers. Electron-free (node builtins only) so the whole
// module can be exercised with plain node against a fake HOME.
//
// Each provider knows how to detect its CLI, report whether the mahas hook is
// installed, and install it. Installers are additive and idempotent: they never
// remove the user's existing hooks, they back up any file they mutate
// (<file>.mahas-bak), and they only run when the user clicks Install in Settings.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { mahasConfigDir } from './eventsFile'

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
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.mahas-bak')
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
  const hadMahas = arr.some((g) => JSON.stringify(g).includes('mahas-hook'))
  const kept = arr.filter((g) => !JSON.stringify(g).includes('ade-hook'))
  const strippedLegacy = kept.length !== arr.length
  if (hadMahas) {
    if (!strippedLegacy) return { ok: true, detail: 'already installed' }
    container[event] = kept
    fs.mkdirSync(path.dirname(file), { recursive: true })
    backup(file)
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
    return { ok: true, detail: 'removed legacy ade-hook' }
  }
  // a pre-rename 'ade-hook' group is ours — replace it, don't double-register
  kept.push(group)
  container[event] = kept
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

const HOOK_MARK = 'mahas-hook'

const PROVIDERS: ProviderDef[] = [
  {
    id: 'claude',
    label: 'Claude',
    bin: 'claude',
    mechanism: 'Stop + Notification + SessionStart/End hooks — ~/.claude/settings.json',
    configPath: (home) => path.join(home, '.claude', 'settings.json'),
    installed: (home) => fileMentions(path.join(home, '.claude', 'settings.json'), HOOK_MARK),
    install: (home, cmd) => {
      const file = path.join(home, '.claude', 'settings.json')
      const group = { hooks: [{ type: 'command', command: cmd, timeout: 10 }] }
      // Stop = turn end; Notification = permission prompts / idle waits;
      // SessionStart/SessionEnd track resumable sessions. Installing all
      // gives each event once — grok/devin compat-load this file too, but
      // the script relabels provider by env and the tailer dedupes the
      // double fire.
      const rs = ['Stop', 'Notification', 'SessionStart', 'SessionEnd'].map((ev) =>
        appendJsonHook(file, ev, group)
      )
      return {
        ok: rs.every((r) => r.ok),
        detail:
          rs
            .map((r) => r.detail)
            .filter(Boolean)
            .join('; ') || undefined
      }
    }
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
          return 'existing notify command is kept — mahas forwards the payload to it'
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
        // A pre-rename 'ade-hook' line is ours — replace it, don't chain it.
        const legacy = lines[idx].includes('ade-hook')
        const prev = parseTomlStringArray(lines[idx])
        if (!legacy && prev.length) {
          const fwdFile = path.join(mahasConfigDir(home), 'notify-forward.json')
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
        return { ok: true, detail: 'previous notify command chained after mahas' }
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
    mechanism:
      'Stop/StopCancelled/StopFailure + Notification + SessionStart/End — ~/.grok/hooks/mahas.json',
    configPath: (home) => path.join(home, '.grok', 'hooks', 'mahas.json'),
    installed: (home) => fileMentions(path.join(home, '.grok', 'hooks', 'mahas.json'), HOOK_MARK),
    install: (home, cmd) => {
      const file = path.join(home, '.grok', 'hooks', 'mahas.json')
      const doc = {
        description: 'mahas turn notifications',
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: cmd, timeout: 10 }] }],
          StopCancelled: [{ hooks: [{ type: 'command', command: cmd }] }],
          StopFailure: [{ hooks: [{ type: 'command', command: cmd }] }],
          // no matcher: the hook script classifies notificationType itself —
          // permission_prompt → needs-input, idle_prompt → silent backstop
          Notification: [{ hooks: [{ type: 'command', command: cmd }] }],
          // lifecycle — powers the restart-resume session set (no-ops if the
          // harness never emits them)
          SessionStart: [{ hooks: [{ type: 'command', command: cmd }] }],
          SessionEnd: [{ hooks: [{ type: 'command', command: cmd }] }]
        }
      }
      const text = JSON.stringify(doc, null, 2) + '\n'
      try {
        if (fs.readFileSync(file, 'utf8') === text) {
          return { ok: true, detail: 'already installed' }
        }
      } catch {
        /* fresh file */
      }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      backup(file)
      fs.writeFileSync(file, text, 'utf8')
      return { ok: true }
    }
  },
  {
    id: 'devin',
    label: 'Devin',
    bin: 'devin',
    mechanism: 'Stop + PermissionRequest + SessionStart/End hooks — ~/.config/devin/config.json',
    configPath: (home) => path.join(configHome(home), 'devin', 'config.json'),
    installed: (home) =>
      fileMentions(path.join(configHome(home), 'devin', 'config.json'), HOOK_MARK),
    install: (home, cmd) => {
      const file = path.join(configHome(home), 'devin', 'config.json')
      const group = { hooks: [{ type: 'command', command: cmd, timeout: 10 }] }
      // passive observer: the script prints no decision, so the normal
      // permission prompt still runs — mahas just gets told it's waiting.
      // SessionStart/End feed the restart-resume set.
      const rs = ['Stop', 'PermissionRequest', 'SessionStart', 'SessionEnd'].map((ev) =>
        appendJsonHook(file, ev, group)
      )
      return {
        ok: rs.every((r) => r.ok),
        detail:
          rs
            .map((r) => r.detail)
            .filter(Boolean)
            .join('; ') || undefined
      }
    }
  },
  {
    id: 'zcode',
    label: 'ZCode',
    bin: 'zcode',
    mechanism: 'Stop + PermissionRequest + SessionStart/End — ~/.zcode/cli/config.json',
    configPath: (home) => path.join(home, '.zcode', 'cli', 'config.json'),
    installed: (home) => fileMentions(path.join(home, '.zcode', 'cli', 'config.json'), HOOK_MARK),
    install: (home, cmd) => {
      const file = path.join(home, '.zcode', 'cli', 'config.json')
      const group = { hooks: [{ type: 'command', command: cmd }] }
      const opts = { eventsKey: true, enable: true }
      const rs = ['Stop', 'PermissionRequest', 'SessionStart', 'SessionEnd'].map((ev) =>
        appendJsonHook(file, ev, group, opts)
      )
      return {
        ok: rs.every((r) => r.ok),
        detail:
          rs
            .map((r) => r.detail)
            .filter(Boolean)
            .join('; ') || undefined
      }
    }
  },
  {
    id: 'cline',
    label: 'Cline',
    bin: 'cline',
    mechanism: 'event-named hook files — ~/.cline/hooks/<Event>',
    configPath: (home) => path.join(home, '.cline', 'hooks'),
    installed: (home) =>
      fileMentions(path.join(home, '.cline', 'hooks', 'TaskComplete'), HOOK_MARK),
    install: (home, cmd) => {
      // cline runs every file named after an event in its hooks search dirs,
      // piping the JSON payload on stdin. Each of our files forwards stdin to
      // mahas-hook, then chains a displaced user hook kept at <file>.mahas-bak
      // (same preserve-the-incumbent rule as codex's notify forward).
      const dir = path.join(home, '.cline', 'hooks')
      const events = [
        'TaskStart',
        'TaskComplete',
        'TaskError',
        'TaskCancel',
        'UserPromptSubmit',
        'SessionShutdown'
      ]
      const script = (ev: string): string =>
        [
          '#!/bin/sh',
          `# mahas-hook — cline ${ev} lifecycle event`,
          'PAYLOAD="$(cat)"',
          `printf '%s' "$PAYLOAD" | ${cmd}`,
          'BAK="$(dirname "$0")/$(basename "$0").mahas-bak"',
          'if [ -f "$BAK" ]; then',
          '  printf \'%s\' "$PAYLOAD" | "$BAK" 2>/dev/null || printf \'%s\' "$PAYLOAD" | sh "$BAK" 2>/dev/null || true',
          'fi',
          'exit 0',
          ''
        ].join('\n')
      let displaced = 0
      fs.mkdirSync(dir, { recursive: true })
      for (const ev of events) {
        const file = path.join(dir, ev)
        const text = script(ev)
        let cur = ''
        try {
          cur = fs.readFileSync(file, 'utf8')
        } catch {
          /* absent */
        }
        if (cur === text) continue
        if (cur && !cur.includes(HOOK_MARK)) {
          displaced++
          backup(file)
        }
        fs.writeFileSync(file, text, { mode: 0o755 })
        // a stale .mahas-bak holding OUR old script would re-invoke
        // mahas-hook through the chain — drop it; a user-owned bak stays
        const bak = `${file}.mahas-bak`
        try {
          if (fs.readFileSync(bak, 'utf8').includes(HOOK_MARK)) fs.unlinkSync(bak)
        } catch {
          /* no bak to clean */
        }
      }
      return {
        ok: true,
        detail: displaced
          ? `${displaced} existing hook file(s) kept at .mahas-bak — chained after mahas`
          : undefined
      }
    }
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    mechanism: 'plugin session.idle/error + permission/question.asked — ~/.config/opencode/plugins',
    configPath: (home) => path.join(configHome(home), 'opencode', 'plugins', 'mahas-events.js'),
    installed: (home) =>
      fileMentions(
        path.join(configHome(home), 'opencode', 'plugins', 'mahas-events.js'),
        'MahasEventsPlugin'
      ),
    install: (home, _cmd, _argv, pluginSrc) => {
      const dest = path.join(configHome(home), 'opencode', 'plugins', 'mahas-events.js')
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      let same = false
      try {
        same = fs.readFileSync(dest, 'utf8') === fs.readFileSync(pluginSrc, 'utf8')
      } catch {
        /* dest absent or unreadable */
      }
      if (same) return { ok: true, detail: 'already installed' }
      backup(dest)
      fs.copyFileSync(pluginSrc, dest)
      return { ok: true }
    }
  }
]

function ensureHookCopy(home: string, hookScriptSrc: string): string {
  const dest = path.join(mahasConfigDir(home), 'mahas-hook.cjs')
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

function hasLegacyHook(file: string): boolean {
  return fileMentions(file, 'ade-hook') || fileMentions(file, 'AdeEventsPlugin')
}

// Refresh mahas-owned hook artifacts at startup. The hook script copy under
// ~/.config/mahas and grok's hook file are ours end-to-end, and the opencode
// plugin file is a file we own inside opencode's plugins dir — those track
// the shipped version so fixes land without a re-Install click.
//
// User-owned configs (claude settings.json, devin/zcode config.json, codex
// config.toml) are not claimed from scratch here. But a leftover `ade-hook`
// pointer is ours: the ade→mahas rename moved ~/.config/ade, so those
// absolute paths 404 and completion events never arrive. Rewrite them the
// same way Install does.
export function refreshInstalledHooks(
  hookScriptSrc: string,
  pluginSrc: string,
  home: string = os.homedir()
): void {
  try {
    const dest = ensureHookCopy(home, hookScriptSrc)
    // sweep pre-rename ade-owned leftovers — they point at ~/.config/ade
    // paths that no longer exist.
    for (const f of [
      path.join(configHome(home), 'opencode', 'plugins', 'ade-events.js'),
      path.join(home, '.grok', 'hooks', 'ade.json'),
      path.join(mahasConfigDir(home), 'ade-hook.cjs')
    ]) {
      try {
        if (hasLegacyHook(f)) fs.unlinkSync(f)
      } catch {
        /* best-effort */
      }
    }
    const cmd = (id: string): string => hookCommand(dest, id)
    const argv = (id: string): string[] => ['node', dest, id]
    for (const p of PROVIDERS) {
      try {
        const ours = p.installed(home)
        const legacy = hasLegacyHook(p.configPath(home))
        const grokLegacy =
          p.id === 'grok' &&
          [
            path.join(home, '.grok', 'hooks', 'ade.json'),
            path.join(home, '.grok', 'hooks', 'ade.json.ade-bak'),
            path.join(home, '.grok', 'hooks', 'ade.json.mahas-bak')
          ].some(hasLegacyHook)
        if (p.id === 'grok' || p.id === 'opencode' || p.id === 'cline') {
          if (ours || grokLegacy) p.install(home, cmd(p.id), argv(p.id), pluginSrc)
          continue
        }
        if (legacy) p.install(home, cmd(p.id), argv(p.id), pluginSrc)
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}
