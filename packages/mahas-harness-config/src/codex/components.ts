// codex/components.ts — S-INJECTION §2 component lowering for the Codex CLI.
//
// Implementation path B (spec/injection.md §6): the mandatory instruction
// body rides INSIDE a TOML `developer_instructions` value on the `-c` argv —
// no instruction files, no path-env indirection. Optional skills materialize
// into the execution checkout's `.agents/skills/<name>/SKILL.md` catalog; the
// required meaning of every clause is already inside the mandatory text, so
// a skill mapped to a required clause is refused rather than silently
// demoted to discovery (spec §2 closed classification, §6).
//
// Native `subagent` components are outside this baseline profile revision —
// refused with INJECTION_UNSUPPORTED; a different RoleImplementation
// revision (different component combination or an attested profile) is the
// correct vehicle (instruction §4.5, spec §2).
//
// Same planner contract as the sibling claude profile
// (claude/components.ts): components arrive as ImplementationComponent rows,
// authored bytes/bindings arrive via the content map, and diagnostics are
// COLLECTED into plan.errors — implementation.prepare needs the full
// unsupportedComponents list, not the first failure. Pure planning only:
// the materializer (IMP-09) writes the bytes, the recipe (recipe.ts) wires
// the argv/env. The route records are the recipe-side input to its
// InjectionReceipt (spec §4: componentId → actualPath/argvIndex/configKey →
// byteDigest → loadingPhase).

import { createHash } from 'node:crypto'
import type {
  ErrorCode,
  MahasError,
  ImplementationComponent
} from '../../../mahas-contracts/src/index.ts'

// ---------------------------------------------------------------------------
// result plumbing — named refusals ride MahasError (spec/common.md ErrorCode).
// The planner collects MahasError entries; the recipe/encoder return
// CodexResult for hard single-value failures (encoding, limits).
// ---------------------------------------------------------------------------

export type CodexResult<T> = { ok: true; value: T } | { ok: false; error: MahasError }

export function codexOk<T>(value: T): CodexResult<T> {
  return { ok: true, value }
}

export function codexErr(code: ErrorCode, message: string, details?: unknown): CodexResult<never> {
  return { ok: false, error: { code, message, retry: 'replan', details } }
}

const componentErr = (code: ErrorCode, message: string, details?: unknown): MahasError => ({
  code,
  message,
  retry: 'replan',
  details
})

// ---------------------------------------------------------------------------
// content port — the authored side, keyed by component id (mirrors the
// sibling's ComponentContent/ComponentBinding split: the component row
// carries descriptors, this map carries rendered bodies + per-kind binding).
// ---------------------------------------------------------------------------

/** S-INJECTION §2 closed component-kind set */
export const CODEX_COMPONENT_KINDS = [
  'instruction',
  'skill',
  'subagent',
  'tool-config',
  'launch-config'
] as const
export type CodexComponentKind = (typeof CODEX_COMPONENT_KINDS)[number]

/** structured per-kind payload carried beside the authored body bytes */
export interface CodexComponentBinding {
  /**
   * skill — explicit catalog directory name under .agents/skills/.
   * Defaults: frontmatter `name:` of the SKILL.md, else slug(componentId).
   */
  skillName?: string
  /** launch-config — recipe inputs this profile may consume */
  launch?: {
    /** default 'pty' — the interactive TUI surface */
    stdio?: 'pty' | 'pipes'
    /** additional non-secret env — checked against the settings policy */
    env?: Record<string, string>
    /**
     * arbitrary argv flags. Only the approved recipe argv is emitted
     * (spec §2 launch-config row) — any value here is refused, never
     * filtered or passed through.
     */
    extraArgs?: string[]
  }
}

/** authored content for one component, resolved by the materializer */
export interface CodexComponentContent {
  /** UTF-8 body: mandatory.md text, SKILL.md doc, tool config description */
  body?: string
  binding?: CodexComponentBinding
}

// ---------------------------------------------------------------------------
// plan output — aligned with the sibling's PlannedFile / InjectionRouteEntry /
// ComponentPlan field names so IMP-09 treats both harness planners uniformly.
// ---------------------------------------------------------------------------

/** one file the materializer must write verbatim inside the execution checkout */
export interface CodexPlannedFile {
  componentId: string
  /** checkout-relative install path — never absolute, never '..' */
  relativePath: string
  mediaType: string
  /** exact UTF-8 bytes to write; the materializer must not transform */
  content: string
  byteDigest: string
  /** existing file at path ⇒ fail the materialization, never overwrite (§3) */
  onConflict: 'fail'
}

/** recipe-side InjectionReceipt row (spec/injection.md §4 route shape) */
export interface CodexInjectionRoute {
  componentId: string
  route:
    | 'config-argv' // developer_instructions inside the -c override arg
    | 'checkout-file' // .agents/skills/<name>/SKILL.md catalog install
    | 'env' // scoped CLI access port (MAHAS_CLI / PATH prepend)
    | 'process-spec' // launch-config → this recipe's ProcessSpec
    | 'first-input' // positional initial prompt arg
  /** flag or key that carries it, e.g. '-c' */
  via?: string
  /** index into ProcessSpec.argv once the recipe fixes it */
  argvIndex?: number
  /** TOML key inside the -c value, e.g. 'developer_instructions' */
  configKey?: string
  /** checkout-relative path for file-delivered components */
  relativePath?: string
  /** env var names for the environment-delivered CLI access port */
  envKeys?: string[]
  /** sha256 hex of the delivered bytes — same digest ContentBlob dedup uses */
  byteDigest?: string
  loadingPhase: 'spawn-argv' | 'startup-config' | 'first-input'
}

export interface CodexComponentPlan {
  files: CodexPlannedFile[]
  routes: CodexInjectionRoute[]
  /** merged launch-config binding the recipe consumes */
  launch: { stdio?: 'pty' | 'pipes'; env: Record<string, string> }
  /**
   * the single instruction component's rendered body — what the recipe
   * encodes into developer_instructions. Absent ⇒ plan.errors explains why.
   */
  mandatoryText?: string
  instructionComponentId?: string
  /** true when a tool-config component requires the scoped CLI access port */
  requiresCliAccess: boolean
  /** every component the profile could not lower, with the contract error */
  errors: { componentId: string; error: MahasError }[]
  warnings: string[]
}

// lowercase hex sha256 — same algorithm as IMP-03's canonical sha256Hex
// (packages/mahas-runtime/src/storage/db.ts); duplicated as a leaf primitive
// so this package stays free of control-plane storage imports.
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

// ---------------------------------------------------------------------------
// TOML basic-string encoding — the only escape path allowed into `-c`.
// Covers every code point a TOML 1.0 basic string may express; anything it
// cannot express (NUL — argv physically cannot carry it; lone surrogates —
// not UTF-8 encodable) is an explicit error, never a substitution.
// ---------------------------------------------------------------------------

const TOML_SHORT_ESCAPES: Record<number, string> = {
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\'
}

/**
 * `text` → `"…"` TOML basic string (quotes included). Escapes every code
 * point TOML requires escaped: C0 controls (tab included, for byte-level
 * determinism), U+007F, quote and backslash. Astral characters pass through
 * as raw UTF-8 — legal inside TOML basic strings.
 */
export function encodeTomlBasicString(text: string): CodexResult<string> {
  if (text.includes('\u0000')) {
    return codexErr('INJECTION_UNSUPPORTED', 'NUL byte in config value — argv cannot carry it', {
      reason: 'nul-byte'
    })
  }
  let out = '"'
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number
    if (cp >= 0xd800 && cp <= 0xdfff) {
      return codexErr(
        'INJECTION_UNSUPPORTED',
        'lone surrogate in mandatory text — not UTF-8 encodable',
        { reason: 'invalid-unicode', codePoint: cp }
      )
    }
    const short = TOML_SHORT_ESCAPES[cp]
    if (short !== undefined) {
      out += short
    } else if (cp <= 0x1f || cp === 0x7f) {
      out += `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`
    } else {
      out += ch
    }
  }
  return codexOk(`${out}"`)
}

/** `developer_instructions=<toml-basic-string>` — the whole `-c` value arg */
export function encodeDeveloperInstructionsOverride(mandatoryText: string): CodexResult<string> {
  const encoded = encodeTomlBasicString(mandatoryText)
  if (!encoded.ok) return encoded
  return codexOk(`developer_instructions=${encoded.value}`)
}

// ---------------------------------------------------------------------------
// skill catalog install — `.agents/skills/<name>/SKILL.md` inside the
// execution-dedicated checkout (spec §6). Checkout-relative only; the
// materializer owns the write and the fail-on-conflict enforcement.
// ---------------------------------------------------------------------------

const SKILL_ROOT = '.agents/skills'
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

/** name → directory slug usable under .agents/skills/ */
export function codexSkillSlug(name: string): CodexResult<string> {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug || !SAFE_SLUG.test(slug)) {
    return codexErr(
      'INJECTION_UNSUPPORTED',
      `skill name ${JSON.stringify(name)} produces no usable .agents/skills directory`,
      { reason: 'bad-slug', name }
    )
  }
  return codexOk(slug)
}

/**
 * The directory name codex keys a skill on: binding.skillName when the
 * implementation pins it, else the SKILL.md frontmatter `name:` — the value
 * the harness itself reads — else a slug of the component id. Minimal
 * frontmatter read, not a YAML parser: top-level `name:` scalar only.
 */
export function codexSkillName(
  componentId: string,
  content: CodexComponentContent
): CodexResult<string> {
  const pinned = content.binding?.skillName
  if (pinned !== undefined) return codexSkillSlug(pinned)
  const body = content.body ?? ''
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end !== -1) {
      const m = /^name\s*:\s*(.+)\s*$/m.exec(body.slice(3, end))
      if (m?.[1]) {
        const name = m[1].trim().replace(/^['"]|['"]$/g, '')
        if (name) return codexSkillSlug(name)
      }
    }
  }
  return codexSkillSlug(componentId)
}

// ---------------------------------------------------------------------------
// the planner — same (components, content) signature as claude/components.ts
// so IMP-09 dispatches both profiles through one call shape.
// ---------------------------------------------------------------------------

/**
 * Lower every implementation component into planned files + load routes.
 * Refusals (collected, not thrown):
 *  - subagent                              → INJECTION_UNSUPPORTED
 *  - skill whose activation is 'required'  → INJECTION_UNSUPPORTED — the only
 *    codex skill route is the conditional catalog; required meaning must
 *    ride inside developer_instructions or a preload-capable profile revision
 *  - launch-config carrying extraArgs      → INJECTION_UNSUPPORTED
 *  - ≠1 instruction components             → MANDATORY_COMPONENT_MISSING /
 *    INJECTION_UNSUPPORTED (one developer_instructions key carries one body)
 *  - duplicate skill install path          → OPERATION_CONFLICT
 *  - tool-config without cliAccess         → flagged via requiresCliAccess;
 *    the recipe turns it into MANDATORY_COMPONENT_MISSING
 */
export function planCodexComponents(
  components: readonly ImplementationComponent[],
  content: Record<string, CodexComponentContent> = {}
): CodexComponentPlan {
  const plan: CodexComponentPlan = {
    files: [],
    routes: [],
    launch: { env: {} },
    requiresCliAccess: false,
    errors: [],
    warnings: []
  }
  const seenPaths = new Map<string, string>() // relativePath → componentId
  const fail = (componentId: string, e: MahasError): void => {
    plan.errors.push({ componentId, error: e })
  }

  let instructionCount = 0
  let launchConfigCount = 0

  for (const c of components) {
    const cId = c.id
    const cContent = content[cId] ?? {}
    switch (c.kind as CodexComponentKind) {
      case 'instruction': {
        instructionCount++
        if (instructionCount > 1) {
          fail(
            cId,
            componentErr(
              'INJECTION_UNSUPPORTED',
              'codex accepts exactly one developer_instructions value; merge instruction components into the single mandatory.md upstream'
            )
          )
          continue
        }
        const body = cContent.body
        if (body === undefined || body.length === 0) {
          fail(
            cId,
            componentErr(
              'MANDATORY_COMPONENT_MISSING',
              'instruction component has no mandatory.md body'
            )
          )
          continue
        }
        plan.mandatoryText = body
        plan.instructionComponentId = cId
        plan.routes.push({
          componentId: cId,
          route: 'config-argv',
          via: '-c',
          configKey: 'developer_instructions',
          byteDigest: sha256Hex(body),
          loadingPhase: 'spawn-argv'
        })
        continue
      }

      case 'skill': {
        if (c.activation === 'required') {
          fail(
            cId,
            componentErr(
              'INJECTION_UNSUPPORTED',
              `required skill '${cId}' cannot be demoted to the optional ` +
                `${SKILL_ROOT} catalog — fold its initial meaning into ` +
                `developer_instructions (or use a profile revision with a ` +
                `confirmed preload route)`,
              { reason: 'required-skill-demoted' }
            )
          )
          continue
        }
        const body = cContent.body
        if (body === undefined || body.length === 0) {
          fail(
            cId,
            componentErr('MANDATORY_COMPONENT_MISSING', `skill ${cId} has no SKILL.md body`)
          )
          continue
        }
        if (body.includes('\u0000')) {
          fail(cId, componentErr('MODEL_INVALID', `skill ${cId} body contains NUL bytes`))
          continue
        }
        const name = codexSkillName(cId, cContent)
        if (!name.ok) {
          fail(cId, name.error)
          continue
        }
        const relativePath = `${SKILL_ROOT}/${name.value}/SKILL.md`
        const owner = seenPaths.get(relativePath)
        if (owner !== undefined && owner !== cId) {
          fail(
            cId,
            componentErr(
              'OPERATION_CONFLICT',
              `skill install path collision at '${relativePath}' (already claimed by ${owner})`
            )
          )
          continue
        }
        seenPaths.set(relativePath, cId)
        plan.files.push({
          componentId: cId,
          relativePath,
          mediaType: 'text/markdown',
          content: body,
          byteDigest: sha256Hex(body),
          onConflict: 'fail'
        })
        plan.routes.push({
          componentId: cId,
          route: 'checkout-file',
          relativePath,
          byteDigest: sha256Hex(body),
          loadingPhase: 'startup-config'
        })
        continue
      }

      case 'tool-config': {
        // The codex-baseline tool-config is the scoped mahas CLI access port:
        // PATH prepend + MAHAS_CLI pointer — secrets never in argv/body/env
        // (the credential file lives in connection/worker, outside the model
        // input). recipe.ts attaches the actual env values; here we declare
        // the requirement and the environment-delivered route.
        plan.requiresCliAccess = true
        plan.routes.push({
          componentId: cId,
          route: 'env',
          envKeys: ['MAHAS_CLI', 'PATH'],
          byteDigest: cContent.body !== undefined ? sha256Hex(cContent.body) : undefined,
          loadingPhase: 'spawn-argv'
        })
        continue
      }

      case 'launch-config': {
        launchConfigCount++
        if (launchConfigCount > 1) {
          fail(
            cId,
            componentErr(
              'INJECTION_UNSUPPORTED',
              'only one launch-config component per implementation'
            )
          )
          continue
        }
        const launch = cContent.binding?.launch
        if (launch?.extraArgs && launch.extraArgs.length > 0) {
          fail(
            cId,
            componentErr(
              'INJECTION_UNSUPPORTED',
              `launch-config '${cId}' asks for argv flags ` +
                `[${launch.extraArgs.join(', ')}] — only the approved recipe ` +
                `argv is emitted; unvalidated file/flag routes are refused`,
              { reason: 'unvalidated-flag', flags: launch.extraArgs }
            )
          )
          continue
        }
        if (launch?.stdio !== undefined) plan.launch.stdio = launch.stdio
        if (launch?.env) Object.assign(plan.launch.env, launch.env)
        plan.routes.push({
          componentId: cId,
          route: 'process-spec',
          byteDigest: cContent.body !== undefined ? sha256Hex(cContent.body) : undefined,
          loadingPhase: 'spawn-argv'
        })
        continue
      }

      case 'subagent':
        fail(
          cId,
          componentErr(
            'INJECTION_UNSUPPORTED',
            `native subagent '${cId}' is outside the codex baseline profile ` +
              `revision — implement the interface with a different component ` +
              `combination or a profile revision that attests it`,
            { reason: 'unsupported-component', kind: c.kind }
          )
        )
        continue

      default:
        fail(
          cId,
          componentErr(
            'INJECTION_UNSUPPORTED',
            `component kind ${JSON.stringify(c.kind)} is not lowerable by the ` +
              `codex config-body profile — write a separate implementation ` +
              `for another harness`
          )
        )
    }
  }

  // required instruction must exist — the recipe refuses to build without it
  if (instructionCount === 0) {
    plan.errors.push({
      componentId: '(implementation)',
      error: componentErr(
        'MANDATORY_COMPONENT_MISSING',
        'no instruction component: role body cannot reach the first model run'
      )
    })
  }

  return plan
}
