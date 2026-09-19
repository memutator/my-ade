// claude/components.ts — S-INJECTION §2 component lowering for Claude Code.
//
// Turns an implementation's components into the exact file set the harness
// reads (plugin manifest, SKILL.md dirs, agent definitions, scoped MCP /
// settings JSON) plus the load-route entries an InjectionReceipt records.
// Pure planning only: the materializer (IMP-09) writes the bytes, the recipe
// (recipe.ts) wires the paths into argv. No filesystem access here.
//
// Honest-failure rules implemented (S-INJECTION §2, IMP-24 §4.2/4.3):
//   - a component kind this profile cannot lower  → INJECTION_UNSUPPORTED
//   - a required skill bound to catalog/discovery → MANDATORY_COMPONENT_MISSING
//     (a helper definition existing does NOT mean the primary agent received
//     the body — required skills ride mandatory.md inline or a confirmed
//     preload via the primary native agent's `skills:` list)
//   - malformed authored content (missing frontmatter, path-unsafe id)
//                                                → MODEL_INVALID
//   - colliding file paths / merge conflicts      → OPERATION_CONFLICT

import { createHash } from 'node:crypto'
import type {
  ErrorCode,
  ImplementationComponent,
  MahasError
} from '../../../mahas-contracts/src/index.ts'

/* ------------------------------------------------------------------ types */

/** S-INJECTION §2 closed component-kind set */
export const COMPONENT_KINDS = [
  'instruction',
  'skill',
  'subagent',
  'tool-config',
  'launch-config'
] as const
export type ComponentKind = (typeof COMPONENT_KINDS)[number]

/**
 * How a required skill's FULL body reaches the model's first context.
 *   inline  — bytes are compiled into mandatory.md (no separate delivery)
 *   preload — plugin SKILL.md + the primary agent's `skills:` list preloads it
 *   catalog — plugin SKILL.md discovered on demand; OPTIONAL skills only
 */
export type SkillDelivery = 'inline' | 'preload' | 'catalog'

/** subagent placement: one primary per launch, helpers are plain agents/ defs */
export type SubagentRole = 'primary' | 'helper'

/** structured per-kind payload carried beside the authored body bytes */
export interface ComponentBinding {
  /** skill — delivery fixation; required ⇒ 'inline' (default) or 'preload' */
  delivery?: SkillDelivery
  /** skill — preload carrier; only 'primary-agent' is a confirmed route */
  preloadVia?: 'primary-agent'
  /** subagent — 'helper' default; 'primary' adds `--agent <name>` to argv */
  agentRole?: SubagentRole
  /** tool-config — scoped MCP registry, written to role/components/mcp.json */
  mcpServers?: Record<string, unknown>
  /** tool-config — permissions merged into the execution settings file */
  permissions?: {
    allow?: string[]
    deny?: string[]
    defaultMode?: string
    additionalDirectories?: string[]
  }
  /** tool-config — extra execution-settings keys (validated in settings-policy) */
  settings?: Record<string, unknown>
  /** tool-config — argv tool lists (`--allowedTools` / `--disallowedTools`) */
  allowedTools?: string[]
  disallowedTools?: string[]
  /** launch-config — ProcessSpec inputs the recipe consumes */
  launch?: {
    model?: string
    sessionId?: string
    permissionMode?: string
    addDirs?: string[]
    extraArgs?: string[]
    stdio?: 'pty' | 'pipes'
    env?: Record<string, string>
  }
}

/** authored content for one component, resolved by the materializer */
export interface ComponentContent {
  /** UTF-8 body: mandatory.md text, SKILL.md doc, agent def doc, mcp JSON */
  body?: string
  binding?: ComponentBinding
}

/** where one component lands in the launch — InjectionReceipt row shape */
export interface InjectionRouteEntry {
  componentId: string
  route:
    | 'instruction-file' // --append-system-prompt-file <path>
    | 'inline' // body embedded in mandatory.md bytes
    | 'plugin-skill' // <plugin>/skills/<name>/SKILL.md
    | 'plugin-agent' // <plugin>/agents/<name>.md
    | 'primary-agent' // --agent <name> (native preload carrier)
    | 'mcp-config' // --mcp-config <path>
    | 'settings-file' // --settings <path>
    | 'argv-flags' // --allowedTools / --disallowedTools / extras
    | 'first-input' // positional initial prompt
    | 'env' // spawn environment entry
  /** flag or config key that carries it, e.g. '--append-system-prompt-file' */
  via?: string
  /** index into ProcessSpec.argv once the recipe fixes it (undefined pre-recipe) */
  argvIndex?: number
  /** execution-relative path it materializes at (empty for inline/env/argv) */
  relativePath?: string
  /** sha256 hex of the delivered bytes — same digest ContentBlob dedup uses */
  byteDigest?: string
  loadingPhase: 'spawn-argv' | 'startup-config' | 'native-preload' | 'first-input'
}

/** one file the materializer must write verbatim under the execution root */
export interface PlannedFile {
  /** path relative to the execution root — never absolute, never '..' */
  relativePath: string
  mediaType: string
  /** exact UTF-8 bytes to write; the materializer must not transform */
  content: string
  byteDigest: string
}

/** planning outcome: files + routes + launch parameters + honest diagnostics */
export interface ComponentPlan {
  files: PlannedFile[]
  routes: InjectionRouteEntry[]
  /** merged launch-config bindings the recipe consumes (empty when absent) */
  launch: NonNullable<ComponentBinding['launch']>
  /** merged tool-config argv lists */
  allowedTools: string[]
  disallowedTools: string[]
  /** merged scoped MCP servers ({} when none — no mcp.json emitted) */
  mcpServers: Record<string, unknown>
  /** merged execution-settings payload for settings-policy.buildExecutionSettings */
  permissions: NonNullable<ComponentBinding['permissions']>
  settings: Record<string, unknown>
  /** primary native agent name when a subagent claimed it (--agent value) */
  primaryAgent?: string
  /** every component the profile could not lower, with the contract error */
  errors: { componentId: string; error: MahasError }[]
  warnings: string[]
}

/* ------------------------------------------------------- execution layout */

/**
 * File slots inside the execution root — extends S-INJECTION §3's layout
 * with the claude plugin root under role/components/. Materializer and
 * recipe both take paths from HERE so they can never disagree.
 */
export const CLAUDE_LAYOUT = {
  mandatory: 'role/mandatory.md',
  initial: 'task/initial.txt',
  pluginRoot: 'role/components/claude-plugin',
  pluginManifest: 'role/components/claude-plugin/.claude-plugin/plugin.json',
  mcpConfig: 'role/components/mcp.json',
  settings: 'role/components/claude-settings.json',
  binDir: 'bin'
} as const

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

const err = (code: ErrorCode, message: string, details?: unknown): MahasError => ({
  code,
  message,
  retry: 'none',
  details
})

/** component ids become file paths — refuse anything that could escape */
const SAFE_COMPONENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
function idSafe(id: string): boolean {
  return SAFE_COMPONENT_ID.test(id) && !id.includes('..') && !id.includes('\0')
}

/* ------------------------------------------------------- frontmatter reads
 *
 * Minimal YAML-frontmatter reader — validates that authored SKILL.md /
 * agent docs carry the keys Claude Code actually requires (`name`,
 * `description`, and for preload checks `skills`). Not a YAML parser:
 * top-level `key:` scalars and `key: [a, b]` / dash lists only.
 */
export interface Frontmatter {
  name?: string
  description?: string
  skills?: string[]
  tools?: string[]
  raw: Record<string, string | string[]>
}

export function readFrontmatter(body: string): Frontmatter | null {
  if (!body.startsWith('---')) return null
  const end = body.indexOf('\n---', 3)
  if (end === -1) return null
  const block = body.slice(3, end).trim()
  const raw: Record<string, string | string[]> = {}
  let lastKey: string | null = null
  for (const line of block.split('\n')) {
    const item = /^\s*-\s+(.+)$/.exec(line)
    if (item && lastKey) {
      const arr = Array.isArray(raw[lastKey]) ? (raw[lastKey] as string[]) : []
      arr.push(item[1].trim().replace(/^['"]|['"]$/g, ''))
      raw[lastKey] = arr
      continue
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    lastKey = kv[1]
    const value = kv[2].trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      raw[lastKey] = value
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
    } else if (value !== '') {
      raw[lastKey] = value.replace(/^['"]|['"]$/g, '')
    }
  }
  const asArr = (k: string): string[] | undefined => {
    const v = raw[k]
    if (v === undefined) return undefined
    return Array.isArray(v) ? v : [v]
  }
  return {
    name: typeof raw.name === 'string' ? raw.name : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    skills: asArr('skills'),
    tools: asArr('tools'),
    raw
  }
}

/** `.claude-plugin/plugin.json` — emitted only when plugin files exist */
export function pluginManifestJson(pluginName: string): string {
  return (
    JSON.stringify(
      {
        name: pluginName,
        version: '0.0.0',
        description:
          'mahas execution-scoped components — materialized for one launch, never installed globally'
      },
      null,
      2
    ) + '\n'
  )
}

/* ------------------------------------------------------------ the planner */

const PLUGIN_NAME = 'mahas-execution'

/**
 * Lower every implementation component into planned files + load routes.
 * Collects diagnostics instead of throwing — implementation.prepare needs
 * the full unsupportedComponents list, not the first failure.
 *
 * `content[componentId]` supplies authored bytes/bindings resolved by the
 * materializer (component rows carry descriptors, not bodies).
 */
export function planComponents(
  components: readonly ImplementationComponent[],
  content: Record<string, ComponentContent> = {}
): ComponentPlan {
  const plan: ComponentPlan = {
    files: [],
    routes: [],
    launch: {},
    allowedTools: [],
    disallowedTools: [],
    mcpServers: {},
    permissions: {},
    settings: {},
    errors: [],
    warnings: []
  }
  const seenPaths = new Map<string, string>() // relativePath → componentId
  const claim = (path: string, componentId: string): boolean => {
    const owner = seenPaths.get(path)
    if (owner && owner !== componentId) return false
    seenPaths.set(path, componentId)
    return true
  }
  const addFile = (
    componentId: string,
    relativePath: string,
    mediaType: string,
    fileContent: string
  ): PlannedFile | null => {
    if (!claim(relativePath, componentId)) {
      plan.errors.push({
        componentId,
        error: err(
          'OPERATION_CONFLICT',
          `path collision at ${relativePath} (already claimed by ${seenPaths.get(relativePath)})`
        )
      })
      return null
    }
    const file: PlannedFile = {
      relativePath,
      mediaType,
      content: fileContent,
      byteDigest: sha256(fileContent)
    }
    plan.files.push(file)
    return file
  }
  const fail = (componentId: string, e: MahasError): void => {
    plan.errors.push({ componentId, error: e })
  }

  let instructionCount = 0
  let launchConfigCount = 0
  const skillFiles = new Map<string, { name: string; delivery: SkillDelivery }>()

  for (const c of components) {
    const cId = c.id
    const cContent = content[cId] ?? {}
    if (!idSafe(cId)) {
      fail(cId, err('MODEL_INVALID', `component id is not path-safe: ${JSON.stringify(cId)}`))
      continue
    }
    switch (c.kind as ComponentKind) {
      case 'instruction': {
        instructionCount++
        if (instructionCount > 1) {
          fail(
            cId,
            err(
              'INJECTION_UNSUPPORTED',
              'claude accepts exactly one --append-system-prompt-file; merge instruction components into the single mandatory.md upstream'
            )
          )
          continue
        }
        const body = cContent.body
        if (body === undefined || body.length === 0) {
          fail(
            cId,
            err('MANDATORY_COMPONENT_MISSING', 'instruction component has no mandatory.md body')
          )
          continue
        }
        if (body.includes('\0')) {
          fail(cId, err('MODEL_INVALID', 'mandatory.md contains NUL bytes'))
          continue
        }
        const file = addFile(cId, CLAUDE_LAYOUT.mandatory, 'text/markdown', body)
        if (file) {
          plan.routes.push({
            componentId: cId,
            route: 'instruction-file',
            via: '--append-system-prompt-file',
            relativePath: file.relativePath,
            byteDigest: file.byteDigest,
            loadingPhase: 'spawn-argv'
          })
        }
        continue
      }

      case 'skill': {
        const required = c.activation === 'required'
        const delivery: SkillDelivery =
          cContent.binding?.delivery ?? (required ? 'inline' : 'catalog')
        if (required && delivery === 'catalog') {
          fail(
            cId,
            err(
              'MANDATORY_COMPONENT_MISSING',
              'required skill bound to catalog/discovery only — fix delivery to inline or preload (initial full-body delivery cannot be inferred from a definition existing)'
            )
          )
          continue
        }
        if (delivery === 'inline') {
          // bytes ride mandatory.md — no plugin file, no separate discovery.
          // The compiler embeds the body; the route records the same file
          // slot so the receipt still maps componentId → bytes → argv.
          plan.routes.push({
            componentId: cId,
            route: 'inline',
            via: CLAUDE_LAYOUT.mandatory,
            relativePath: CLAUDE_LAYOUT.mandatory,
            byteDigest: cContent.body !== undefined ? sha256(cContent.body) : undefined,
            loadingPhase: 'spawn-argv'
          })
          continue
        }
        const body = cContent.body
        if (body === undefined || body.length === 0) {
          fail(cId, err('MANDATORY_COMPONENT_MISSING', `skill ${cId} has no SKILL.md body`))
          continue
        }
        const fm = readFrontmatter(body)
        if (!fm?.name || !fm.description) {
          fail(
            cId,
            err(
              'MODEL_INVALID',
              `skill ${cId}: SKILL.md needs frontmatter 'name' and 'description'`
            )
          )
          continue
        }
        const relPath = `${CLAUDE_LAYOUT.pluginRoot}/skills/${fm.name}/SKILL.md`
        const file = addFile(cId, relPath, 'text/markdown', body)
        if (!file) continue
        skillFiles.set(cId, { name: fm.name, delivery })
        plan.routes.push({
          componentId: cId,
          route: 'plugin-skill',
          via: '--plugin-dir',
          relativePath: relPath,
          byteDigest: file.byteDigest,
          loadingPhase: delivery === 'preload' ? 'native-preload' : 'startup-config'
        })
        continue
      }

      case 'subagent': {
        const body = cContent.body
        if (body === undefined || body.length === 0) {
          fail(cId, err('MANDATORY_COMPONENT_MISSING', `subagent ${cId} has no agent definition`))
          continue
        }
        const fm = readFrontmatter(body)
        if (!fm?.name || !fm.description) {
          fail(
            cId,
            err(
              'MODEL_INVALID',
              `subagent ${cId}: agent doc needs frontmatter 'name' and 'description'`
            )
          )
          continue
        }
        const role: SubagentRole = cContent.binding?.agentRole ?? 'helper'
        if (role === 'primary') {
          if (plan.primaryAgent !== undefined && plan.primaryAgent !== fm.name) {
            fail(
              cId,
              err(
                'OPERATION_CONFLICT',
                `two primary agents declared (${plan.primaryAgent}, ${fm.name}) — claude takes one --agent`
              )
            )
            continue
          }
          plan.primaryAgent = fm.name
        }
        const relPath = `${CLAUDE_LAYOUT.pluginRoot}/agents/${fm.name}.md`
        const file = addFile(cId, relPath, 'text/markdown', body)
        if (!file) continue
        plan.routes.push({
          componentId: cId,
          route: role === 'primary' ? 'primary-agent' : 'plugin-agent',
          via: role === 'primary' ? '--agent' : '--plugin-dir',
          relativePath: relPath,
          byteDigest: file.byteDigest,
          loadingPhase: 'startup-config'
        })
        continue
      }

      case 'tool-config': {
        const b = cContent.binding ?? {}
        if (b.mcpServers) {
          for (const [name, cfg] of Object.entries(b.mcpServers)) {
            const prev = plan.mcpServers[name]
            if (prev !== undefined && JSON.stringify(prev) !== JSON.stringify(cfg)) {
              fail(
                cId,
                err('OPERATION_CONFLICT', `mcp server ${name} defined twice with different config`)
              )
              continue
            }
            plan.mcpServers[name] = cfg
          }
        }
        if (b.allowedTools) plan.allowedTools.push(...b.allowedTools)
        if (b.disallowedTools) plan.disallowedTools.push(...b.disallowedTools)
        if (b.permissions) {
          const p = plan.permissions
          p.allow = [...(p.allow ?? []), ...(b.permissions.allow ?? [])]
          p.deny = [...(p.deny ?? []), ...(b.permissions.deny ?? [])]
          p.additionalDirectories = [
            ...(p.additionalDirectories ?? []),
            ...(b.permissions.additionalDirectories ?? [])
          ]
          if (b.permissions.defaultMode !== undefined) {
            if (p.defaultMode !== undefined && p.defaultMode !== b.permissions.defaultMode) {
              fail(
                cId,
                err(
                  'OPERATION_CONFLICT',
                  `conflicting permissions.defaultMode (${p.defaultMode} vs ${b.permissions.defaultMode})`
                )
              )
              continue
            }
            p.defaultMode = b.permissions.defaultMode
          }
        }
        if (b.settings) {
          for (const [k, v] of Object.entries(b.settings)) {
            if (
              plan.settings[k] !== undefined &&
              JSON.stringify(plan.settings[k]) !== JSON.stringify(v)
            ) {
              fail(cId, err('OPERATION_CONFLICT', `execution settings key '${k}' defined twice`))
              continue
            }
            plan.settings[k] = v
          }
        }
        plan.routes.push({
          componentId: cId,
          route: 'settings-file',
          via: '--settings',
          relativePath: CLAUDE_LAYOUT.settings,
          loadingPhase: 'spawn-argv'
        })
        continue
      }

      case 'launch-config': {
        launchConfigCount++
        if (launchConfigCount > 1) {
          fail(
            cId,
            err('INJECTION_UNSUPPORTED', 'only one launch-config component per implementation')
          )
          continue
        }
        plan.launch = { ...cContent.binding?.launch }
        continue
      }

      default:
        fail(
          cId,
          err(
            'INJECTION_UNSUPPORTED',
            `component kind ${JSON.stringify(c.kind)} is not lowerable by the claude file-based profile — write a separate implementation for another harness`
          )
        )
    }
  }

  /* ---- cross-component consistency ---------------------------------- */

  // required instruction must exist — the recipe refuses to build without it
  if (instructionCount === 0) {
    plan.errors.push({
      componentId: '(implementation)',
      error: err(
        'MANDATORY_COMPONENT_MISSING',
        'no instruction component: role body cannot reach the first model run'
      )
    })
  }

  // preload skills need a primary agent whose `skills:` frontmatter lists
  // the skill NAME — the file existing is not delivery by itself
  for (const c of components) {
    if (c.kind !== 'skill') continue
    const delivery = skillFiles.get(c.id)?.delivery
    if (delivery !== 'preload') continue
    const skillName = skillFiles.get(c.id)!.name
    if (content[c.id]?.binding?.preloadVia !== 'primary-agent') {
      plan.errors.push({
        componentId: c.id,
        error: err(
          'MANDATORY_COMPONENT_MISSING',
          `skill ${c.id}: preload requested without preloadVia='primary-agent' — no confirmed carrier`
        )
      })
      continue
    }
    const primary = components.find(
      (o) => o.kind === 'subagent' && content[o.id]?.binding?.agentRole === 'primary'
    )
    const primaryFm = primary ? readFrontmatter(content[primary.id]?.body ?? '') : null
    if (!primary || !primaryFm?.skills?.includes(skillName)) {
      plan.errors.push({
        componentId: c.id,
        error: err(
          'MANDATORY_COMPONENT_MISSING',
          `skill ${c.id}: primary agent does not preload '${skillName}' — add it to the primary agent doc's skills: frontmatter`
        )
      })
    }
  }

  // plugin manifest only when the plugin actually ships files
  const pluginUsed = plan.files.some((f) => f.relativePath.startsWith(CLAUDE_LAYOUT.pluginRoot))
  if (pluginUsed) {
    const manifest = pluginManifestJson(PLUGIN_NAME)
    plan.files.push({
      relativePath: CLAUDE_LAYOUT.pluginManifest,
      mediaType: 'application/json',
      content: manifest,
      byteDigest: sha256(manifest)
    })
  }

  // scoped mcp.json materializes only when servers were configured
  if (Object.keys(plan.mcpServers).length > 0) {
    const mcpBody = JSON.stringify({ mcpServers: plan.mcpServers }, null, 2) + '\n'
    const file = addFile('(tool-config)', CLAUDE_LAYOUT.mcpConfig, 'application/json', mcpBody)
    if (file) {
      plan.routes.push({
        componentId: '(tool-config)',
        route: 'mcp-config',
        via: '--mcp-config',
        relativePath: file.relativePath,
        byteDigest: file.byteDigest,
        loadingPhase: 'spawn-argv'
      })
    }
  }

  if (plan.allowedTools.length || plan.disallowedTools.length) {
    plan.routes.push({
      componentId: '(tool-config)',
      route: 'argv-flags',
      via: '--allowedTools/--disallowedTools',
      loadingPhase: 'spawn-argv'
    })
  }

  return plan
}
