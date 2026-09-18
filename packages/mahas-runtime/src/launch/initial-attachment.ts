// mahas-runtime/launch — initial input attachment & injection receipts
// (IMP-19, S-INJECTION §3–4, §7).
//
// The planner binds every required delivery (role mandatory text, task
// initial text, required skills) to one of the three explicit S-INJECTION
// routes — instruction FILE, instruction TEXT, or confirmed PRELOAD. The
// coordinator resolves the pinned argv template against materialized bytes
// at spawn time and records `componentId → actualPath/argvIndex/configKey
// → byteDigest → loadingPhase` per route in injection_receipts.
//
// Hard rules honoured here:
//   - a literal initialText is the file's actual BYTES, never a path name
//   - no `$(cat ...)` shell interpolation anywhere — argv arrays only
//   - credential/secret bytes never enter argv, env, receipts or logs
//   - native hidden prompt bytes we cannot read stay 'unknown' — never
//     claimed as verified context

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SpawnSpec } from '../hostClient.ts'
import { runSql, type MaterializedFile } from './deps.ts'

// ---------------------------------------------------------------------------
// recipe/plan shapes (launch-owned; the profile's recipe_json provides them)

/** the three S-INJECTION §4 route families, resolved structurally */
export type RouteKind =
  | 'argv-file' // explicit instruction FILE route: flag + materialized path
  | 'argv-text' // explicit instruction TEXT route: file bytes as an argument
  | 'argv-config-text' // config override carrying text, e.g. codex -c key=text
  | 'stdin' // initial bytes via ProcessSpec.initialStdin ContentRef
  | 'config-file' // harness config file placed at a fixed path (e.g. mcp config)
  | 'native-preload' // confirmed preload: file where the native agent loads it

export interface InjectionRoute {
  /** execution-root-relative source (e.g. 'role/mandatory.md') or logical
   *  component ref for directory routes (e.g. 'plugin') */
  source: string
  kind: RouteKind
  /** argv flag ('--append-system-prompt-file'), config key
   *  ('developer_instructions'), or target path for config-file */
  target?: string
  /** text format for argv-config-text ('toml-basic-string') */
  format?: string
  required: boolean
}

/**
 * One argv template entry stored verbatim in the LaunchPlan's
 * process_spec_json. Literal entries are fixed bytes; slot entries are
 * deterministic references resolved at spawn against the materialized
 * execution root and claimed checkout — the plan stays exact because the
 * resolution rules and the inputs' digests are pinned.
 */
export type ArgvEntry =
  | { literal: string }
  | { slot: 'file'; source: string; flag?: string }
  | { slot: 'fileText'; source: string }
  | { slot: 'configText'; key: string; format?: 'toml-basic-string'; source: string }
  | { slot: 'dir'; source: string; flag?: string }
  | { slot: 'checkoutPath' }
  | { slot: 'executionRoot' }

export interface PlannedProcessSpec {
  executable: string
  argv: ArgvEntry[]
  stdio: 'pty' | 'pipes'
  terminalSize?: { cols: number; rows: number }
  /** fixed literal env from the recipe — recipes may not carry secrets;
   *  the credential is delivered via the connection file only */
  env?: Record<string, string>
  /** controller env keys passed through verbatim (allowlist) */
  envAllowlist?: string[]
  /** file whose bytes become ProcessSpec.initialStdin */
  stdin?: { source: string }
}

/** the recipe_json subset launch consumes from a HarnessProfile */
export interface LaunchRecipe {
  process: {
    executable: string
    stdio?: 'pty' | 'pipes'
    terminalSize?: { cols: number; rows: number }
    argv: ArgvEntry[]
    env?: Record<string, string>
    envAllowlist?: string[]
  }
  /** required source → route bindings; sources not bound are undelivered */
  routes?: InjectionRoute[]
}

// ---------------------------------------------------------------------------
// route planning (used by worker.prepare → INJECTION_UNSUPPORTED blockers)

export interface RouteBlocker {
  code: 'INJECTION_UNSUPPORTED' | 'MANDATORY_COMPONENT_MISSING' | 'INPUT_NOT_READY'
  detail: string
}

/** deliveries that must reach the first model input (REQ-07) */
export const REQUIRED_SOURCES = ['role/mandatory.md', 'task/initial.txt'] as const

interface ManifestComponent {
  id?: string
  kind?: string
  activation?: string
  path?: string
}

/**
 * Validates that every required delivery and every required component has
 * an explicit route, that the profile supports the component kinds used,
 * and that no two components claim the same materialized path.
 */
export function planRoutes(
  recipe: LaunchRecipe | null,
  manifest: unknown,
  supportedComponentKinds: readonly string[]
): { routes: InjectionRoute[]; blockers: RouteBlocker[] } {
  const blockers: RouteBlocker[] = []
  const routes = [...(recipe?.routes ?? [])]
  const components = manifestComponents(manifest)

  // fixed deliveries → explicit route required
  for (const source of REQUIRED_SOURCES) {
    if (!routes.some((r) => r.source === source)) {
      blockers.push({
        code: 'INJECTION_UNSUPPORTED',
        detail: `recipe binds no explicit route for required input '${source}'`
      })
    }
  }

  // component kinds the profile cannot express → unsupported, never silent
  for (const c of components) {
    const kind = c.kind ?? 'unknown'
    if (supportedComponentKinds.length > 0 && !supportedComponentKinds.includes(kind)) {
      blockers.push({
        code: 'INJECTION_UNSUPPORTED',
        detail: `profile supports [${supportedComponentKinds.join(',')}] but component '${c.id ?? '?'}' is kind '${kind}'`
      })
    }
  }

  // required skills need inline/preload delivery; optional may be catalog
  for (const c of components) {
    if (c.kind === 'skill' && (c.activation === 'required' || c.activation === 'mandatory')) {
      const bound = routes.some((r) => r.source === (c.path ?? c.id))
      if (!bound) {
        blockers.push({
          code: 'MANDATORY_COMPONENT_MISSING',
          detail: `required skill '${c.id ?? '?'}' has no preload/inline route`
        })
      }
    }
  }

  // path collisions — materialization must fail rather than overwrite
  const seen = new Map<string, string>()
  for (const c of components) {
    if (!c.path) continue
    const prev = seen.get(c.path)
    if (prev) {
      blockers.push({
        code: 'MANDATORY_COMPONENT_MISSING',
        detail: `components '${prev}' and '${c.id ?? '?'}' collide on path '${c.path}'`
      })
    } else {
      seen.set(c.path, c.id ?? '?')
    }
  }

  return { routes, blockers }
}

function manifestComponents(manifest: unknown): ManifestComponent[] {
  if (typeof manifest === 'object' && manifest !== null) {
    const list = (manifest as { components?: unknown }).components
    if (Array.isArray(list)) return list as ManifestComponent[]
  }
  return []
}

// ---------------------------------------------------------------------------
// argv / spec resolution at spawn time

export interface AttachEvidence {
  source: string
  kind: RouteKind | 'argv-slot'
  target?: string
  argvIndex?: number
  actualPath?: string
  configKey?: string
  byteDigest?: string
  loadingPhase: 'spawn-argv' | 'spawn-stdin' | 'spawn-config' | 'preload'
}

export interface ResolveContext {
  executionRoot: string
  checkoutPath: string
  /** materialized file bytes for text routes (wantBytes) */
  fileBytes: Map<string, MaterializedFile>
  digest: (data: string | Uint8Array) => string
}

export class ResolveFailure extends Error {
  readonly code = 'MANDATORY_COMPONENT_MISSING' as const
  constructor(message: string) {
    super(message)
    this.name = 'ResolveFailure'
  }
}

function fileFor(ctx: ResolveContext, source: string): MaterializedFile {
  const f = ctx.fileBytes.get(source)
  if (!f) {
    throw new ResolveFailure(`materialized file '${source}' absent from execution root`)
  }
  return f
}

function fileBytes(ctx: ResolveContext, source: string): Uint8Array {
  const f = fileFor(ctx, source)
  if (!f.bytes) {
    throw new ResolveFailure(
      `route needs bytes of '${source}' but materializer did not return them (wantBytes)`
    )
  }
  return f.bytes
}

/** TOML basic string escaping for config-override routes (S-INJECTION §6) */
export function tomlBasicString(text: string): string {
  if (text.includes('')) throw new ResolveFailure('NUL byte cannot enter a TOML basic string')
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[-]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return `"${escaped}"`
}

/**
 * Resolves the pinned argv template into the final argument array.
 * Produces the per-route evidence (source → argvIndex → byteDigest) that
 * lands in the injection receipt. Throws ResolveFailure BEFORE spawn when
 * a required input cannot be attached — never silently drops it.
 */
export function resolveArgv(
  spec: PlannedProcessSpec,
  ctx: ResolveContext
): { argv: string[]; evidence: AttachEvidence[] } {
  const argv: string[] = []
  const evidence: AttachEvidence[] = []
  const push = (s: string): number => argv.push(s) - 1

  for (const entry of spec.argv) {
    if ('literal' in entry) {
      push(entry.literal)
      continue
    }
    switch (entry.slot) {
      case 'file': {
        const f = fileFor(ctx, entry.source)
        const path = joinRoot(ctx.executionRoot, entry.source)
        if (entry.flag) push(entry.flag)
        const idx = push(path)
        evidence.push({
          source: entry.source,
          kind: 'argv-file',
          ...(entry.flag ? { target: entry.flag } : {}),
          argvIndex: idx,
          actualPath: path,
          byteDigest: f.digest,
          loadingPhase: 'spawn-argv'
        })
        break
      }
      case 'fileText': {
        const bytes = fileBytes(ctx, entry.source)
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        const idx = push(text)
        evidence.push({
          source: entry.source,
          kind: 'argv-text',
          argvIndex: idx,
          byteDigest: ctx.digest(bytes),
          loadingPhase: 'spawn-argv'
        })
        break
      }
      case 'configText': {
        const bytes = fileBytes(ctx, entry.source)
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        const value =
          entry.format === 'toml-basic-string'
            ? `${entry.key}=${tomlBasicString(text)}`
            : `${entry.key}=${text}`
        push('-c')
        const idx = push(value)
        evidence.push({
          source: entry.source,
          kind: 'argv-config-text',
          configKey: entry.key,
          argvIndex: idx,
          byteDigest: ctx.digest(bytes),
          loadingPhase: 'spawn-config'
        })
        break
      }
      case 'dir': {
        const path = joinRoot(ctx.executionRoot, entry.source)
        if (entry.flag) push(entry.flag)
        const idx = push(path)
        evidence.push({
          source: entry.source,
          kind: 'config-file',
          ...(entry.flag ? { target: entry.flag } : {}),
          argvIndex: idx,
          actualPath: path,
          loadingPhase: 'spawn-argv'
        })
        break
      }
      case 'checkoutPath':
        push(ctx.checkoutPath)
        break
      case 'executionRoot':
        push(ctx.executionRoot)
        break
    }
  }
  return { argv, evidence }
}

export function joinRoot(root: string, rel: string): string {
  return root.endsWith('/') ? `${root}${rel}` : `${root}/${rel}`
}

/**
 * Builds the SpawnSpec for host.process.spawn. Env is the recipe's fixed
 * map + allowlisted controller env + launch bookkeeping (endpoint, ids) —
 * the credential secret is never placed here (spec C-HOST §launch
 * primitive: account secrets use the credential provider, not argv/env).
 */
export function buildSpawnSpec(
  spec: PlannedProcessSpec,
  ctx: ResolveContext,
  launchEnv: Record<string, string>
): { spec: SpawnSpec; evidence: AttachEvidence[]; stdinBytes?: Uint8Array } {
  const { argv, evidence } = resolveArgv(spec, ctx)
  const env: Record<string, string> = { ...(spec.env ?? {}), ...launchEnv }
  for (const key of spec.envAllowlist ?? []) {
    const v = process.env[key]
    if (v !== undefined) env[key] = v
  }
  const spawn: SpawnSpec = {
    argv,
    cwd: ctx.checkoutPath,
    env,
    ...(spec.stdio === 'pty' ? { pty: spec.terminalSize ?? { cols: 120, rows: 32 } } : {})
  }
  let stdinBytes: Uint8Array | undefined
  if (spec.stdin) {
    stdinBytes = fileBytes(ctx, spec.stdin.source)
    evidence.push({
      source: spec.stdin.source,
      kind: 'stdin',
      byteDigest: ctx.digest(stdinBytes),
      loadingPhase: 'spawn-stdin'
    })
  }
  return { spec: spawn, evidence, stdinBytes }
}

// ---------------------------------------------------------------------------
// connection/worker — private credential file (S-INJECTION §3)
//
// Content is written into the execution root for the scoped mahas CLI to
// read. It carries the bootstrap secret, so it is routed through the
// materializer's secretFiles channel and is excluded from every receipt,
// manifest and model-facing input.

export function buildConnectionFile(input: {
  endpoint?: string
  executionId: string
  generation: number
  token: string
}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      protocolVersion: 0,
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
      executionId: input.executionId,
      generation: input.generation,
      credential: input.token
    })
  )
}

// ---------------------------------------------------------------------------
// injection receipt row (spec/storage.md injection_receipts)

export function writeInjectionReceipt(
  db: DatabaseSync,
  input: {
    executionId: string
    phase: string
    components: AttachEvidence[]
    inherited: unknown
    evidence: unknown
  }
): number {
  const prev = db
    .prepare(
      'SELECT COALESCE(MAX(revision),0) AS r FROM injection_receipts WHERE execution_id=? AND phase=?'
    )
    .get(input.executionId, input.phase) as { r: number }
  const revision = prev.r + 1
  runSql(
    db,
    'INSERT INTO injection_receipts(execution_id,phase,revision,components_json,inherited_json,evidence_json) VALUES (?,?,?,?,?,?)',
    input.executionId,
    input.phase,
    revision,
    JSON.stringify(input.components),
    JSON.stringify(input.inherited ?? {}),
    JSON.stringify(input.evidence ?? {})
  )
  return revision
}

/** sha256 of stdin bytes — used to mint the initialStdin ContentRef digest */
export function stdinDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
