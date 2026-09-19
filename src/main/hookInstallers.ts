// Hook installer engine — Electron-free (node builtins only) so the whole
// module can be exercised with plain node against a synthetic HOME.
//
// The engine owns the *mechanics* (backups, chaining, idempotence, owned-file
// refresh); every vendor detail — which events exist, where a config lives,
// what a hook group looks like, when a refresh is allowed — comes from the
// builtin.harness-runtime Pack (installers.json / harnesses.json) through
// packages/mahas-harness-config/src/runtime-pack.ts.
//
// Safety rules preserved from the previous per-vendor installers:
//   · installs are additive and idempotent — an existing user hook group is
//     kept, never replaced by us;
//   · any file we mutate is backed up (<file>.mahas-bak);
//   · a displaced single-slot command (codex notify) is recorded and chained;
//   · pre-rename ade-hook pointers are ours and are rewritten in place;
//   · install only runs from an explicit user click — Pack maintenance never
//     auto-installs (see the Pack's neverAutoInstalls declaration).

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import {
  expandInstallerPath,
  installerPlan,
  installerTokenContext,
  type HarnessRuntimePack,
  type InstallerPlan
} from '../../packages/mahas-harness-config/src/runtime-pack.ts'
import { loadHarnessRuntimePack } from '../../packages/mahas-harness-config/src/runtime-pack.ts'
import { harnessRuntimeHookScriptPath } from '../../packages/mahas-harness-config/src/runtime-pack.ts'

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

export interface HookInstallerSources {
  pack: HarnessRuntimePack | null
  hookScriptPath: string | null
}

/**
 * Sources for a pack directory — used by tools that exercise the installer
 * engine without electron (tools/test-hook-migrate.mjs) and by the desktop
 * through src/main/harnessPack.ts.
 */
export function hookInstallerSourcesFromDir(packDir: string): HookInstallerSources {
  try {
    const pack = loadHarnessRuntimePack(packDir)
    return { pack, hookScriptPath: harnessRuntimeHookScriptPath(pack) }
  } catch {
    return { pack: null, hookScriptPath: null }
  }
}

function binAvailable(bin: string): boolean {
  return spawnSync('sh', ['-c', 'command -v ' + bin], { stdio: 'ignore' }).status === 0
}

function backup(file: string): void {
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.mahas-bak')
  } catch {
    /* backup is best-effort */
  }
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  backup(file)
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function mentions(file: string, needle: string): boolean {
  return readText(file).includes(needle)
}

function hasLegacy(pack: HarnessRuntimePack | null, text: string): boolean {
  const markers = pack?.installers.legacy.legacyMarkers ?? ['ade-hook', 'AdeEventsPlugin']
  return markers.some((marker) => text.includes(marker))
}

/** Plan for one installer id, or null when the Pack does not declare it. */
function planFor(
  pack: HarnessRuntimePack | null,
  hookScriptPath: string | null,
  id: string,
  home: string
): InstallerPlan | null {
  if (!pack || !hookScriptPath) return null
  if (!pack.installers.byId[id]) return null
  return installerPlan(pack, id, hookScriptPath, home)
}

/* --------------------------------------------------------------- detection */

export function hookStatuses(
  sources: HookInstallerSources,
  home: string = os.homedir()
): HookStatus[] {
  const pack = sources.pack
  if (!pack || !sources.hookScriptPath) return []
  const statuses: HookStatus[] = []
  for (const id of Object.keys(pack.installers.byId)) {
    const plan = planFor(pack, sources.hookScriptPath, id, home)
    if (!plan) continue
    if (!binAvailable(plan.installer.bin)) continue
    statuses.push({
      id,
      label: plan.installer.label,
      mechanism: plan.installer.mechanism,
      available: true,
      installed: isInstalled(plan),
      detail: installedDetail(plan),
      configPath: plan.configPath
    })
  }
  return statuses
}

function isInstalled(plan: InstallerPlan): boolean {
  const kind = plan.installer.kind
  if (kind === 'plugin-files') {
    // every file of the set must be present — a lone entry cannot resolve its
    // sibling at import time, which is exactly how the opencode plugin breaks
    return plan.files.every((file) => mentions(file.to, plan.marker))
  }
  if (kind === 'hook-files') {
    return plan.events.every((event) => mentions(path.join(plan.configDir, event), plan.marker))
  }
  if (kind === 'notify-slot') {
    const line = readText(plan.configPath)
      .split('\n')
      .find((l) => /^\s*notify\s*=/.test(l))
    return Boolean(line && line.includes(plan.marker))
  }
  return mentions(plan.configPath, plan.marker)
}

function installedDetail(plan: InstallerPlan): string | undefined {
  const kind = plan.installer.kind
  if (kind === 'notify-slot') {
    const line = readText(plan.configPath)
      .split('\n')
      .find((l) => /^\s*notify\s*=/.test(l))
    if (line && !line.includes(plan.marker)) {
      return 'existing notify command is kept — mahas forwards the payload to it'
    }
    return undefined
  }
  if (kind !== 'plugin-files') return undefined
  const missing = plan.files
    .filter((file) => !fs.existsSync(file.to))
    .map((file) => path.basename(file.to))
  const incomplete = plan.files.filter(
    (file) => fs.existsSync(file.to) && !mentions(file.to, plan.marker)
  )
  if (missing.length) return 'missing plugin file(s): ' + missing.join(', ')
  if (incomplete.length) return 'plugin file(s) do not match the shipped revision'
  return undefined
}

/* ------------------------------------------------------------------ install */

export function installHook(
  id: string,
  sources: HookInstallerSources,
  home: string = os.homedir()
): InstallResult {
  const pack = sources.pack
  if (!pack || !sources.hookScriptPath) {
    return { ok: false, error: 'harness runtime Pack is unavailable — cannot install hooks' }
  }
  const plan = planFor(pack, sources.hookScriptPath, id, home)
  if (!plan) return { ok: false, error: 'unknown provider ' + id }
  if (!binAvailable(plan.installer.bin)) {
    return { ok: false, error: plan.installer.bin + ' not found on PATH' }
  }
  try {
    ensureHookCopy(home, sources.hookScriptPath)
    switch (plan.installer.kind) {
      case 'json-hooks':
        return installJsonHooks(plan)
      case 'notify-slot':
        return installNotifySlot(plan)
      case 'owned-json-hooks':
        return installOwnedHooks(plan)
      case 'hook-files':
        return installHookFiles(plan)
      case 'plugin-files':
        return installPluginFiles(plan)
      default:
        return { ok: false, error: 'unsupported installer kind ' + String(plan.installer.kind) }
    }
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}

/**
 * The installed transport is a copy of the Pack's own vendor-facing script; the
 * config-dir path is what every harness hook command points at, so refreshing
 * the copy updates every installed harness at once.
 */
function ensureHookCopy(home: string, hookScriptSource: string): string {
  const configDir =
    process.env.MAHAS_CONFIG_DIR ||
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'mahas')
  const dest = path.join(configDir, 'mahas-hook.cjs')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const source = readText(hookScriptSource)
  if (!source) throw new Error('hook transport is missing at ' + hookScriptSource)
  if (readText(dest) !== source) {
    try {
      fs.copyFileSync(dest, dest + '.mahas-bak')
    } catch {
      /* fresh copy */
    }
    fs.writeFileSync(dest, source, { mode: 0o755 })
  }
  return dest
}

function hooksContainer(plan: InstallerPlan): {
  doc: Record<string, unknown>
  container: Record<string, unknown>
} {
  const doc = readJson(plan.configPath) ?? {}
  const hooks = (doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : {}) as Record<
    string,
    unknown
  >
  doc.hooks = hooks
  if (plan.installer.enableContainer) hooks.enabled = true
  if (!plan.installer.container) return { doc, container: hooks }
  const existing = hooks[plan.installer.container]
  const nested = (existing && typeof existing === 'object' ? existing : {}) as Record<
    string,
    unknown
  >
  hooks[plan.installer.container] = nested
  return { doc, container: nested }
}

function installJsonHooks(plan: InstallerPlan): InstallResult {
  if (!plan.group) return { ok: false, error: 'installer declares no hook group template' }
  const details: string[] = []
  let wrote = false
  for (const event of plan.events) {
    const { doc, container } = hooksContainer(plan)
    const current = Array.isArray(container[event]) ? (container[event] as unknown[]) : []
    const ours = current.some((entry) => JSON.stringify(entry).includes(plan.marker))
    const kept = current.filter((entry) => !hasLegacy(null, JSON.stringify(entry)))
    const strippedLegacy = kept.length !== current.length
    if (ours && !strippedLegacy) {
      details.push('already installed')
      continue
    }
    if (!ours) kept.push(plan.group)
    container[event] = kept
    writeJson(plan.configPath, doc)
    wrote = true
    details.push(ours ? 'removed legacy ade-hook' : '')
  }
  void wrote
  return { ok: true, detail: details.filter(Boolean).join('; ') || undefined }
}

function installNotifySlot(plan: InstallerPlan): InstallResult {
  const file = plan.configPath
  if (!plan.argv.length) return { ok: false, error: 'installer declares no notify argv' }
  const notifyLine = 'notify = [' + plan.argv.map((a) => JSON.stringify(a)).join(', ') + ']'
  const lines = readText(file).split('\n')
  const index = lines.findIndex((l) => /^\s*notify\s*=/.test(l))
  if (index >= 0) {
    if (lines[index]!.includes(plan.marker)) return { ok: true, detail: 'already installed' }
    const legacy = hasLegacy(null, lines[index]!)
    const previous = parseTomlStringArray(lines[index]!)
    if (!legacy && previous.length) {
      // Preserve the displaced command: the hook script re-invokes it with the
      // same payload, so taking over the single notify slot is not destructive.
      const table = readJson(plan.forwardFile) ?? {}
      table[plan.forwardKey ?? plan.id] = previous
      writeJson(plan.forwardFile, table)
    }
    lines[index] = notifyLine
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

function parseTomlStringArray(line: string): string[] {
  const start = line.indexOf('[')
  const end = line.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"/g
  let match: RegExpExecArray | null
  const inner = line.slice(start + 1, end)
  while ((match = re.exec(inner))) {
    try {
      out.push(JSON.parse('"' + match[1] + '"'))
    } catch {
      out.push(match[1]!)
    }
  }
  return out
}

function installOwnedHooks(plan: InstallerPlan): InstallResult {
  if (!plan.owned) return { ok: false, error: 'installer declares no owned document' }
  const text = JSON.stringify(plan.owned, null, 2) + '\n'
  if (readText(plan.configPath) === text) return { ok: true, detail: 'already installed' }
  fs.mkdirSync(path.dirname(plan.configPath), { recursive: true })
  backup(plan.configPath)
  fs.writeFileSync(plan.configPath, text, 'utf8')
  return { ok: true }
}

function installHookFiles(plan: InstallerPlan): InstallResult {
  if (!plan.scriptTemplate.length) {
    return { ok: false, error: 'installer declares no script template' }
  }
  fs.mkdirSync(plan.configDir, { recursive: true })
  let displaced = 0
  for (const event of plan.events) {
    const file = path.join(plan.configDir, event)
    // cline runs every file named after an event, piping the JSON payload on
    // stdin: our script forwards stdin to mahas-hook, then chains a displaced
    // user hook kept at <file>.mahas-bak (same preserve-the-incumbent rule as
    // codex's notify forward).
    const text = plan.scriptTemplate
      .map((line) => line.split('$' + '{event}').join(event))
      .join('\n')
    const current = readText(file)
    if (current === text) continue
    if (current && !current.includes(plan.marker)) {
      displaced++
      backup(file)
    }
    fs.writeFileSync(file, text, { mode: 0o755 })
    // a stale .mahas-bak holding OUR old script would re-invoke mahas-hook
    // through the chain — drop it; a user-owned bak stays
    const bak = file + '.mahas-bak'
    if (readText(bak).includes(plan.marker)) {
      try {
        fs.unlinkSync(bak)
      } catch {
        /* nothing to clean */
      }
    }
  }
  return {
    ok: true,
    detail: displaced
      ? displaced + ' existing hook file(s) kept at .mahas-bak — chained after mahas'
      : undefined
  }
}

/**
 * Copy a plugin file *set*. The entry file imports its sibling by relative
 * path, so a partial install is broken by construction — every file is written
 * together and the status check treats a missing dependency as not installed.
 */
function installPluginFiles(plan: InstallerPlan): InstallResult {
  if (!plan.files.length) return { ok: false, error: 'installer declares no file set' }
  const missing = plan.files
    .filter((file) => !fs.existsSync(file.from))
    .map((file) => path.basename(file.from))
  if (missing.length) return { ok: false, error: 'Pack file(s) missing: ' + missing.join(', ') }
  let changed = false
  for (const file of plan.files) {
    const source = readText(file.from)
    if (readText(file.to) === source) continue
    fs.mkdirSync(path.dirname(file.to), { recursive: true })
    backup(file.to)
    fs.writeFileSync(file.to, source, 'utf8')
    changed = true
  }
  return { ok: true, detail: changed ? undefined : 'already installed' }
}

/* ------------------------------------------------------------------ refresh */

/**
 * Refresh mahas-owned hook artifacts at startup.
 *
 * Owned artifacts (the installed transport copy, grok's hook document, cline's
 * event files, opencode's plugin set) track the shipped Pack revision so fixes
 * land without a re-Install click. User-owned configs (claude settings.json,
 * devin/zcode config.json, codex config.toml) are never claimed from scratch —
 * except for a leftover ade-hook pointer, which is ours: the ade→mahas rename
 * moved ~/.config/ade, so those absolute paths 404 and completion events never
 * arrive. Rewriting them is the same write Install performs.
 */
export function refreshInstalledHooks(
  sources: HookInstallerSources,
  home: string = os.homedir()
): void {
  const pack = sources.pack
  if (!pack || !sources.hookScriptPath) return
  try {
    ensureHookCopy(home, sources.hookScriptPath)
    for (const artifact of pack.installers.legacy.artifacts) {
      const file = expandInstallerPath(
        artifact.path,
        installerTokenContext({
          home,
          hookScriptPath: sources.hookScriptPath,
          harnessId: 'mahas'
        })
      )
      try {
        if (hasLegacy(pack, readText(file))) fs.unlinkSync(file)
      } catch {
        /* best-effort */
      }
    }
    for (const id of Object.keys(pack.installers.byId)) {
      const plan = planFor(pack, sources.hookScriptPath, id, home)
      if (!plan) continue
      try {
        const installed = isInstalled(plan)
        const legacy =
          hasLegacy(pack, readText(plan.configPath)) ||
          plan.legacyArtifacts.some((file) => hasLegacy(pack, readText(file)))
        if (plan.refresh === 'owned') {
          if (installed || legacy) installHook(id, sources, home)
          continue
        }
        if (plan.refresh === 'legacy' && legacy) installHook(id, sources, home)
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Refresh ONLY the config-dir transport copy (`<configDir>/mahas-hook.cjs`),
 * leaving every harness config under $HOME untouched.
 *
 * Split out from refreshInstalledHooks for test runs: the event channel is
 * config-dir scoped and safe to write, while harness configs live in the real
 * HOME and must never be rewritten by a test. A run that skips BOTH loses the
 * transport the Pack's own hook commands point at, so its events can never be
 * produced in the first place.
 */
export function refreshHookTransportCopy(sources: HookInstallerSources): void {
  if (!sources.pack || !sources.hookScriptPath) return
  try {
    ensureHookCopy(os.homedir(), sources.hookScriptPath)
  } catch {
    /* best-effort: a missing copy surfaces as a failing harness hook */
  }
}

/** Ids whose owned artifacts are refreshed on every start. */
export function ownedInstallerIds(sources: HookInstallerSources): string[] {
  const pack = sources.pack
  if (!pack) return []
  return Object.entries(pack.installers.byId)
    .filter(([, installer]) => (installer.refresh ?? 'legacy') === 'owned')
    .map(([id]) => id)
}
