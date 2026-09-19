// component-store — deterministic planning of materialized component files.
//
// IMP-09 · realization/launch boundary (spec/injection.md §3–4).
// Pure functions only: no DB, no filesystem, no clock. Given a ContextBundle
// manifest (IMP-08 output, context_bundles.manifest_json) and the pinned blob
// bytes, produce the exact PlannedFile set. Same bundle digest + same blobs
// must yield the same file set — nothing here reads wall-clock or random
// input, and all output bytes are either blob bytes or canonicalJson renders.
//
// Path discipline (instruction §4.2): every component target is canonicalized;
// escapes, absolute paths, NULs, duplicate canonical targets, symlink
// overwrite requests, and requests to (re)write shared CLAUDE.md/AGENTS.md
// instruction files under a checkout are rejected before any byte is staged.

import type { BundleDigest, ErrorCode, ErrorRetry } from '../../../mahas-contracts/src/index.ts'
import { mahasError } from '../api/handler-ports.ts'

// ---------------------------------------------------------------------------
// errors — kernel MahasError factory (api/handler-ports.ts is import-safe:
// it carries only type imports)

export function fail(
  code: ErrorCode,
  message: string,
  retry: ErrorRetry = 'none',
  details?: unknown
): never {
  throw mahasError(code, message, retry, details)
}

// ---------------------------------------------------------------------------
// manifest contract consumed from IMP-08's ContextBundle.manifest_json.
// Field names follow the spec vocabulary (spec/injection.md §3:
// "component digest, clause coverage, load route"). This is the consumer-side
// contract; deviations are reconciled with IMP-08 at the parse boundary only.

export type ComponentKind = 'instruction' | 'skill' | 'subagent' | 'tool-config' | 'launch-config'

/** 'execution' → under the private per-execution root; 'checkout' →
 *  project auto-discovery path inside the member's canonical checkout
 *  (requires an exclusive write claim, see materializer.ts). */
export type ComponentScope = 'execution' | 'checkout'

export interface BundleManifestComponent {
  componentId: string
  kind: ComponentKind
  /** content_blobs digest of the component's exact bytes */
  digest: string
  /** relative install target (execution-root-relative or checkout-relative) */
  path: string
  scope?: ComponentScope
  /** file mode; default 0o644 */
  mode?: number
  activation?: 'initial' | 'conditional'
  /** route evidence recorded into InjectionReceipt (spec/injection.md §4) */
  loadPhase?: string
  route?: {
    type: 'file' | 'argv' | 'config' | 'preload'
    argvIndex?: number
    configKey?: string
  }
}

export interface BundleManifest {
  /** required role text → role/mandatory.md (defaults to requiredTextDigest blob) */
  requiredText?: { digest: string; path?: string }
  components: BundleManifestComponent[]
  coverage?: unknown
  loadRoutes?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// planned file — the deterministic output unit

export interface PlannedFile {
  /** canonical relative path within its scope root */
  relativePath: string
  scope: ComponentScope
  bytes: Uint8Array
  /** sha256Hex of bytes — verified against the manifest's declared digest */
  digest: string
  mode: number
  componentId?: string
  /** private files (connection/worker) are never listed in model-facing
   *  manifests and are staged with 0600 perms */
  private?: boolean
}

export type DigestFn = (data: string | Uint8Array) => string

/** the only file names a checkout-scoped component may never install or
 *  overwrite — shared human/project instruction files are not component
 *  output territory (spec/injection.md §3). */
const RESERVED_CHECKOUT_BASENAMES = new Set(['claude.md', 'agents.md'])

export function isReservedSharedPath(canonicalRelPath: string): boolean {
  const base = canonicalRelPath.slice(canonicalRelPath.lastIndexOf('/') + 1)
  return RESERVED_CHECKOUT_BASENAMES.has(base.toLowerCase())
}

// ---------------------------------------------------------------------------
// canonicalization

/**
 * Canonicalize a manifest-declared relative path. Rejects absolute paths,
 * NUL, `.`/`..` segments, empty segments, backslashes (never a path
 * separator on the POSIX v1 host) and trailing separators — MODEL_INVALID.
 */
export function canonicalRelPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    fail('MODEL_INVALID', 'component path is empty')
  }
  if (path.includes('\0')) {
    fail('MODEL_INVALID', 'component path contains NUL', 'none', { path })
  }
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) {
    fail('MODEL_INVALID', 'component path must be relative', 'none', { path })
  }
  if (path.includes('\\')) {
    fail('MODEL_INVALID', 'component path must use / separators', 'none', { path })
  }
  const segments = path.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      fail('MODEL_INVALID', 'component path escapes or is not canonical', 'none', { path })
    }
  }
  return segments.join('/')
}

// ---------------------------------------------------------------------------
// manifest parsing

const COMPONENT_KINDS: ReadonlySet<string> = new Set([
  'instruction',
  'skill',
  'subagent',
  'tool-config',
  'launch-config'
])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function loadPhaseFromRoutes(routes: unknown[]): string | undefined {
  const names = routes.filter((r): r is string => typeof r === 'string')
  if (names.includes('mandatory-text') || names.includes('inline')) return 'inline'
  if (names.includes('confirmed-preload') || names.includes('preload')) return 'preload'
  if (names.includes('catalog')) return 'catalog'
  return undefined
}

/** execution-root role/manifest.json must not carry maintenanceBasis */
export function executionFacingManifestJson(raw: string): string {
  try {
    const value = JSON.parse(raw) as unknown
    if (!isRecord(value) || value.maintenanceBasis === undefined) return raw
    const { maintenanceBasis: _drop, ...rest } = value
    void _drop
    return canonicalJson(rest)
  } catch {
    return raw
  }
}

export function parseBundleManifest(raw: unknown): BundleManifest {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!isRecord(value)) {
    fail('MODEL_INVALID', 'bundle manifest is not an object')
  }
  const componentsRaw = value['components']
  if (!Array.isArray(componentsRaw)) {
    fail('MODEL_INVALID', 'bundle manifest has no components array')
  }
  const components: BundleManifestComponent[] = componentsRaw.map((c, i) => {
    if (!isRecord(c)) {
      fail('MODEL_INVALID', `manifest component[${i}] is not an object`)
    }
    const { componentId, kind, scope, mode, activation, route } = c
    const digest =
      typeof c.digest === 'string' && c.digest.length > 0
        ? c.digest
        : typeof c.blobDigest === 'string'
          ? c.blobDigest
          : undefined
    const path =
      typeof c.path === 'string' && c.path.length > 0
        ? c.path
        : typeof c.installPath === 'string'
          ? c.installPath
          : undefined
    const loadPhase =
      typeof c.loadPhase === 'string'
        ? c.loadPhase
        : Array.isArray(c.loadRoutes)
          ? loadPhaseFromRoutes(c.loadRoutes)
          : undefined
    if (typeof componentId !== 'string' || componentId.length === 0) {
      fail('MODEL_INVALID', `manifest component[${i}] missing componentId`)
    }
    if (typeof kind !== 'string' || !COMPONENT_KINDS.has(kind)) {
      fail('MODEL_INVALID', `manifest component[${i}] has unknown kind`, 'none', { kind })
    }
    if (typeof digest !== 'string' || digest.length === 0) {
      fail('MODEL_INVALID', `manifest component[${i}] missing digest`)
    }
    if (typeof path !== 'string') {
      fail('MODEL_INVALID', `manifest component[${i}] missing path`)
    }
    if (scope !== undefined && scope !== 'execution' && scope !== 'checkout') {
      fail('MODEL_INVALID', `manifest component[${i}] has unknown scope`, 'none', { scope })
    }
    if (
      mode !== undefined &&
      (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o777)
    ) {
      fail('MODEL_INVALID', `manifest component[${i}] has invalid mode`)
    }
    if (route !== undefined && !isRecord(route)) {
      fail('MODEL_INVALID', `manifest component[${i}] route is not an object`)
    }
    return {
      componentId,
      kind: kind as ComponentKind,
      digest,
      path,
      scope: scope as ComponentScope | undefined,
      mode: mode as number | undefined,
      activation: activation as 'initial' | 'conditional' | undefined,
      loadPhase: loadPhase as string | undefined,
      route: route as BundleManifestComponent['route']
    }
  })
  const requiredTextRaw = value['requiredText']
  let requiredText: BundleManifest['requiredText']
  if (requiredTextRaw !== undefined) {
    if (!isRecord(requiredTextRaw) || typeof requiredTextRaw['digest'] !== 'string') {
      fail('MODEL_INVALID', 'manifest requiredText must carry a digest')
    }
    requiredText = {
      digest: requiredTextRaw['digest'],
      path: typeof requiredTextRaw['path'] === 'string' ? requiredTextRaw['path'] : undefined
    }
  }
  return {
    requiredText,
    components,
    coverage: value['coverage'],
    loadRoutes: isRecord(value['loadRoutes'])
      ? (value['loadRoutes'] as Record<string, unknown>)
      : undefined
  }
}

// ---------------------------------------------------------------------------
// deterministic renders

/** stable JSON: object keys sorted recursively, 2-space indent, trailing \n */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize)
    if (isRecord(v)) {
      if (seen.has(v)) fail('MODEL_INVALID', 'cannot canonicalize cyclic value')
      seen.add(v)
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(v).sort()) out[key] = normalize(v[key])
      return out
    }
    return v
  }
  return JSON.stringify(normalize(value), null, 2) + '\n'
}

/**
 * Render surface/commands.md — the human/agent-readable description of the
 * exact allowed-command surface (spec/injection.md §3). Deterministic: the
 * surface JSON's own action order is authoritative; only whitespace is ours.
 */
export function renderCommandsMd(surfaceJson: unknown): string {
  const lines: string[] = [
    '# Allowed mahas commands',
    '',
    'This execution may use only the operations below. Anything not listed',
    'here is outside the current grant and will be rejected.',
    ''
  ]
  const actions = extractSurfaceActions(surfaceJson)
  if (actions.length === 0) {
    lines.push('(empty surface — no operations are currently allowed)')
  }
  for (const action of actions) {
    lines.push(`## ${action.name}`)
    if (action.description) lines.push('', action.description)
    if (action.schema !== undefined) {
      lines.push('', '```json', JSON.stringify(action.schema, null, 2), '```')
    }
    lines.push('')
  }
  return lines.join('\n')
}

interface SurfaceAction {
  name: string
  description?: string
  schema?: unknown
}

/** Tolerate the CommandSurface payload shapes IMP-10/IMP-02 may emit:
 *  {actions:[...]}, {operations:[...]}, or a bare array. Entries keep the
 *  declared order — the surface digest already pins it. */
function extractSurfaceActions(surfaceJson: unknown): SurfaceAction[] {
  const list = Array.isArray(surfaceJson)
    ? surfaceJson
    : isRecord(surfaceJson)
      ? Array.isArray(surfaceJson['actions'])
        ? surfaceJson['actions']
        : Array.isArray(surfaceJson['operations'])
          ? surfaceJson['operations']
          : []
      : []
  return list.filter(isRecord).map((a) => ({
    name:
      typeof a['name'] === 'string'
        ? a['name']
        : typeof a['operation'] === 'string'
          ? a['operation']
          : '(unnamed)',
    description: typeof a['description'] === 'string' ? a['description'] : undefined,
    schema: a['schema'] ?? a['inputSchema'] ?? a['input']
  }))
}

// ---------------------------------------------------------------------------
// file planning

export interface PlanExecutionFilesArgs {
  bundleDigest: BundleDigest
  manifest: BundleManifest
  /** raw manifest_json text — staged verbatim as role/manifest.json */
  manifestRaw: string
  /** content blob fetcher (getContentBlob shape) */
  blob: (digest: string) => { bytes: Uint8Array; mediaType: string } | null
  digest: DigestFn
  /** pinned work-envelope payload → task/initial.txt + task/envelope.json */
  envelope?: { initialText: string; envelopeJson: unknown }
  /** command surface row payload → surface/commands.json + commands.md */
  surface?: { actionsJson: unknown }
  /** private worker connection files → connection/ (0600, excluded from
   *  model-facing manifests; credentials never enter text manifests) */
  connection?: { files: { name: string; bytes: Uint8Array }[] }
  /** scoped CLI launcher → bin/mahas (0755) */
  cli?: { executablePath: string; endpoint: string; extraEnv?: Record<string, string> }
}

const enc = new TextEncoder()

export function planExecutionFiles(args: PlanExecutionFilesArgs): PlannedFile[] {
  const files: PlannedFile[] = []
  const seen = new Map<string, string>() // canonicalPath → source label

  const claim = (rel: string, label: string): string => {
    const canonical = canonicalRelPath(rel)
    const prior = seen.get(`${canonical}`)
    if (prior !== undefined) {
      fail('OPERATION_CONFLICT', 'component output path collision', 'none', {
        path: canonical,
        first: prior,
        second: label
      })
    }
    seen.set(canonical, label)
    return canonical
  }

  const push = (
    rel: string,
    bytes: Uint8Array,
    opts: {
      scope?: ComponentScope
      mode?: number
      componentId?: string
      private?: boolean
      expectDigest?: string
      label: string
    }
  ): void => {
    const canonical = claim(rel, opts.label)
    const scope = opts.scope ?? 'execution'
    if (scope === 'checkout' && isReservedSharedPath(canonical)) {
      fail('MODEL_INVALID', 'component may not overwrite shared instruction files', 'none', {
        path: canonical,
        label: opts.label
      })
    }
    const digest = args.digest(bytes)
    if (opts.expectDigest !== undefined && opts.expectDigest !== digest) {
      fail('ARTIFACT_MISMATCH', 'component blob digest does not match manifest', 'reconcile', {
        label: opts.label,
        declared: opts.expectDigest,
        actual: digest
      })
    }
    files.push({
      relativePath: canonical,
      scope,
      bytes,
      digest,
      mode: opts.mode ?? 0o644,
      componentId: opts.componentId,
      private: opts.private
    })
  }

  // role/mandatory.md — the required role text (full body, never summarized)
  if (args.manifest.requiredText !== undefined) {
    const rt = args.manifest.requiredText
    const b = args.blob(rt.digest)
    if (b === null) {
      fail('MANDATORY_COMPONENT_MISSING', 'required role text blob is missing', 'reconcile', {
        digest: rt.digest
      })
    }
    push(rt.path ?? 'role/mandatory.md', b.bytes, {
      mode: 0o444,
      expectDigest: rt.digest,
      label: 'requiredText'
    })
  }

  // role/manifest.json — execution-facing: strip maintenanceBasis (inspector-only)
  push('role/manifest.json', enc.encode(executionFacingManifestJson(args.manifestRaw)), {
    label: 'manifest'
  })

  // declared components
  for (const c of args.manifest.components) {
    const b = args.blob(c.digest)
    if (b === null) {
      fail('MANDATORY_COMPONENT_MISSING', 'component blob is missing', 'reconcile', {
        componentId: c.componentId,
        digest: c.digest
      })
    }
    push(c.path, b.bytes, {
      scope: c.scope ?? 'execution',
      mode: c.mode,
      componentId: c.componentId,
      expectDigest: c.digest,
      label: `component:${c.componentId}`
    })
  }

  // task/* — first-input text and the exact envelope revisions (real bytes,
  // not a path registration — REQ-07)
  if (args.envelope !== undefined) {
    push('task/initial.txt', enc.encode(args.envelope.initialText), {
      mode: 0o444,
      label: 'task/initial.txt'
    })
    push('task/envelope.json', enc.encode(canonicalJson(args.envelope.envelopeJson)), {
      mode: 0o444,
      label: 'task/envelope.json'
    })
  }

  // surface/*
  if (args.surface !== undefined) {
    push('surface/commands.json', enc.encode(canonicalJson(args.surface.actionsJson)), {
      mode: 0o444,
      label: 'surface/commands.json'
    })
    push('surface/commands.md', enc.encode(renderCommandsMd(args.surface.actionsJson)), {
      mode: 0o444,
      label: 'surface/commands.md'
    })
  }

  // connection/* — private credentials/endpoint files
  if (args.connection !== undefined) {
    for (const f of args.connection.files) {
      push(`connection/${f.name}`, f.bytes, {
        mode: 0o600,
        private: true,
        label: `connection:${f.name}`
      })
    }
  }

  // bin/mahas — scoped CLI launcher (argv array semantics: a real script,
  // never a shell-interpolated instruction)
  if (args.cli !== undefined) {
    push('bin/mahas', enc.encode(renderCliLauncher(args.cli)), {
      mode: 0o755,
      label: 'bin/mahas'
    })
  }

  return files
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function renderCliLauncher(cli: {
  executablePath: string
  endpoint: string
  extraEnv?: Record<string, string>
}): string {
  const lines = ['#!/bin/sh', '# scoped mahas CLI launcher — generated by the materializer.']
  const envs = Object.entries({ MAHASD_ENDPOINT: cli.endpoint, ...(cli.extraEnv ?? {}) }).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
  )
  for (const [k, v] of envs) lines.push(`export ${k}=${shQuote(v)}`)
  lines.push(`exec ${shQuote(cli.executablePath)} "$@"`, '')
  return lines.join('\n')
}
