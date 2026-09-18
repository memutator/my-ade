// compiler.ts — the deterministic role-component compiler.
//
// IMP-08 · C-REALIZATION `context.build`
// (spec/contracts/realization.md · spec/injection.md §2–4 · D-ROLE §4–5)
//
// build(interfaceDigest, implementationRevision, effectiveCommandSurface,
// sourceSnapshotPins) → ContextBundle. Given identical input bytes the build
// emits identical bytes and an identical digest: component order is the
// topo-sorted `consumes` graph, every serialized form goes through
// canonicalJson (sorted keys), and no timestamp / run / task / credential /
// scope value ever enters reusable bundle content (instruction §4.5,
// REQ-05/22).
//
// What the compiler does NOT do (hard spec boundaries):
//   - no ad-hoc summarization or truncation of authored content — REQ-06,
//     "빌더는 즉석 요약하지 않는다" / "자동 요약·절단 금지"
//   - no unconditional full-source injection — a source file's bytes are
//     injected only where a verbatim binding's section pins them
//   - reexpressed coverage injects the implementation's own phrasing, never
//     the original 상위 문서 (enforced in coverage.ts)
//   - no silent route downgrades: a mandatory skill never degrades to a
//     catalog entry, a subagent never degrades to plain text — unsupported
//     profiles get INJECTION_UNSUPPORTED, not a quieter bundle
//   - no recording "a path was passed" as text delivery: the required text
//     blob contains the actual instruction bytes
//
// Layout produced (spec/injection.md §3): the manifest's per-component
// installPath lives under role/components/; the mandatory text blob is what
// becomes role/mandatory.md at materialization (IMP-09); task/, surface/ and
// connection/ are WorkEnvelope / launch concerns, not bundle content.

import type { DatabaseSync } from 'node:sqlite'
import { appendDomainEvent } from '../storage/db.ts'
import type { OperationRegistry } from '../api/registry.ts'
import type { RoleInterfaceDigest } from '../../../mahas-contracts/src/common.ts'
import type { CommandSurface } from '../../../mahas-contracts/src/access.ts'
import {
  bundleDigestOf,
  canonicalJson,
  digestText,
  fail,
  getContextBundle,
  insertContextBundle,
  putBlob,
  utf8,
  utf8Decode,
  type BundleManifest,
  type ComponentManifestEntry,
  type ContextBundleRecord,
  type MaintenanceBasisEntry
} from './bundle-store.ts'
import {
  makeFilesystemReader,
  observeSources,
  persistObservedSources,
  type ObservedSource,
  type SourceReader,
  type SourceSnapshotPin
} from './source-snapshots.ts'
import {
  validateCoverage,
  type BindingNode,
  type ComponentNode,
  type RequirementNode,
  type SectionNode
} from './coverage.ts'

// ---------------------------------------------------------------------------
// public operation surface

/** context.build payload (spec/contracts/realization.md §context.build). */
export interface ContextBuildInput {
  interfaceDigest: string
  implementationId: string
  implementationRevision: number
  surfaceDigest: string
  /** pins the caller asserts for every source file the build may observe;
   *  every section.source a component references MUST be pinned here */
  sourceSnapshotPins?: SourceSnapshotPin[]
  /** absolute root the pin paths resolve under (a checkout/repository root);
   *  falls back to the deps' sourceRoot */
  sourceRoot?: string
}

export interface ContextBuildResult {
  bundleDigest: string
  requiredTextDigest: string
  manifest: BundleManifest
  /** true when an identical bundle row already existed (deterministic
   *  rebuild is a no-op, not a new revision) */
  reused: boolean
}

export interface ContextOpsDeps {
  sourceRoot?: string
  readSourceFile?: SourceReader
}

export interface ContextBuildDeps extends ContextOpsDeps {
  db: DatabaseSync
}

// ---------------------------------------------------------------------------
// pure compile pipeline

/** Everything compileContextBundle needs, already loaded and normalized.
 *  Field types mirror the canonical domain names (IMP-02): requirements are
 *  ContextRequirement, components ImplementationComponent+coverage,
 *  maintenanceBasis MaintenanceBinding — see the row normalizers below. */
export interface CompileInput {
  interfaceDigest: RoleInterfaceDigest | string
  roleId: string
  roleName?: string
  modelVersion: string
  requirements: readonly RequirementNode[]
  /** requirement.contextId → repo-relative source path (rdd_contexts) */
  contextPaths: ReadonlyMap<string, string>
  implementationId: string
  implementationRevision: number
  /** components MUST be passable in any order — the compiler topo-sorts */
  components: readonly ComponentNode[]
  /** HarnessProfile supportedComponents / injectionRoutes; null = the
   *  profile declares nothing (counts as "cannot confirm" for anything that
   *  needs confirmation) */
  supportedComponents: readonly string[] | null
  injectionRoutes: readonly string[] | null
  surfaceDigest: string
  /** parsed command_surfaces.actions_and_schemas_json — the effective
   *  CommandSurface payload (opaque here; only action names are read) */
  surface: CommandSurface | unknown
  /** observed sources keyed by repo-relative path (already pin-verified) */
  sources: ReadonlyMap<string, ObservedSource>
  maintenanceBasis: readonly MaintenanceBasisEntry[]
}

export interface ComponentArtifact {
  componentId: string
  installPath: string
  mediaType: string
  bytes: Uint8Array
  digest: string
}

export interface CompiledBundle {
  bundleDigest: string
  mandatoryText: string
  requiredTextDigest: string
  manifest: BundleManifest
  /** rendered per-component artifacts to persist as content_blobs */
  artifacts: ComponentArtifact[]
}

// ---------------------------------------------------------------------------
// small validation helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value))
    fail('MODEL_INVALID', `${what} must be an object, got ${JSON.stringify(value)}`)
  return value
}

function optString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseJsonColumn(raw: unknown, what: string): unknown {
  if (typeof raw !== 'string') fail('MODEL_INVALID', `${what} column is not stored JSON text`)
  try {
    return JSON.parse(raw as string)
  } catch {
    fail('MODEL_INVALID', `${what} column is not valid JSON`)
  }
}

function stringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) fail('MODEL_INVALID', `${what} must be an array`)
  return value.map((item, i) => {
    if (typeof item !== 'string' || item.length === 0) {
      fail('MODEL_INVALID', `${what}[${i}] must be a non-empty string`)
    }
    return item
  })
}

// ---------------------------------------------------------------------------
// payload + row normalization (DB JSON → typed nodes; tolerant to the minor
// key variants IMP-02/IMP-07 may emit, strict on what semantics need)

function parseBuildInput(raw: unknown): ContextBuildInput {
  const o = asRecord(raw, 'context.build payload')
  const need = (key: string): string => {
    const v = o[key]
    if (typeof v !== 'string' || v.length === 0) {
      fail('MODEL_INVALID', `context.build payload needs a non-empty string "${key}"`)
    }
    return v
  }
  const rev = o.implementationRevision
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1) {
    fail('MODEL_INVALID', 'context.build payload needs a positive integer "implementationRevision"')
  }
  let pins: SourceSnapshotPin[] | undefined
  if (o.sourceSnapshotPins !== undefined) {
    if (!Array.isArray(o.sourceSnapshotPins))
      fail('MODEL_INVALID', 'sourceSnapshotPins must be an array')
    pins = o.sourceSnapshotPins.map((p, i) => {
      const pin = asRecord(p, `sourceSnapshotPins[${i}]`)
      const out: SourceSnapshotPin = { path: '', digest: '' }
      if (typeof pin.path !== 'string' || typeof pin.digest !== 'string') {
        fail('MODEL_INVALID', `sourceSnapshotPins[${i}] needs string path and digest`)
      }
      out.path = pin.path
      out.digest = pin.digest
      if (pin.mediaType !== undefined) {
        if (typeof pin.mediaType !== 'string')
          fail('MODEL_INVALID', `sourceSnapshotPins[${i}].mediaType must be a string`)
        out.mediaType = pin.mediaType
      }
      return out
    })
  }
  const sourceRoot = optString(o.sourceRoot)
  return {
    interfaceDigest: need('interfaceDigest'),
    implementationId: need('implementationId'),
    implementationRevision: rev,
    surfaceDigest: need('surfaceDigest'),
    ...(pins !== undefined ? { sourceSnapshotPins: pins } : {}),
    ...(sourceRoot !== undefined ? { sourceRoot } : {})
  }
}

function requirementNode(raw: unknown): RequirementNode {
  const o = asRecord(raw, 'context requirement')
  const clauseId = optString(o.clauseId) ?? optString(o.clause) ?? optString(o.id)
  if (!clauseId) fail('MODEL_INVALID', `context requirement has no clauseId: ${canonicalJson(o)}`)
  const deliveryClass = optString(o.deliveryClass) ?? optString(o.delivery) ?? 'initial'
  if (deliveryClass !== 'initial' && deliveryClass !== 'conditional') {
    fail(
      'MODEL_INVALID',
      `requirement ${clauseId} has unknown deliveryClass ${JSON.stringify(deliveryClass)}`
    )
  }
  const node: RequirementNode = { clauseId, deliveryClass }
  const contextId = optString(o.contextId)
  const criterionRef = optString(o.criterionRef)
  const requiredMeaning = optString(o.requiredMeaning)
  const readerPerspective = optString(o.readerPerspective)
  if (contextId) node.contextId = contextId
  if (criterionRef) node.criterionRef = criterionRef
  if (requiredMeaning) node.requiredMeaning = requiredMeaning
  if (readerPerspective) node.readerPerspective = readerPerspective
  return node
}

/** requirements_json may be a bare array or an object wrapping the list. */
function requirementNodes(requirementsJson: unknown): RequirementNode[] {
  let list: unknown
  if (Array.isArray(requirementsJson)) list = requirementsJson
  else if (isRecord(requirementsJson)) {
    list = requirementsJson.contextRequirements ?? requirementsJson.requirements ?? []
  } else {
    fail('MODEL_INVALID', 'role_interfaces.requirements_json is neither array nor object')
  }
  if (!Array.isArray(list)) fail('MODEL_INVALID', 'interface requirements payload is not an array')
  return list.map(requirementNode)
}

function sectionNode(raw: unknown, componentId: string): SectionNode {
  const o = asRecord(raw, `section of component ${componentId}`)
  const key = optString(o.key)
  if (!key) fail('MODEL_INVALID', `component ${componentId} has a section with no key`)
  const node: SectionNode = { key }
  const heading = optString(o.heading) ?? optString(o.title)
  const text = optString(o.text) ?? (typeof o.text === 'string' ? o.text : undefined)
  if (heading) node.heading = heading
  if (o.source !== undefined) {
    const src = asRecord(o.source, `source of section ${componentId}/${key}`)
    const path = optString(src.path)
    if (!path) fail('MODEL_INVALID', `section ${componentId}/${key} source needs a path`)
    node.source = { path }
    const digest = optString(src.digest)
    if (digest) node.source.digest = digest
  }
  if (o.text !== undefined) {
    if (typeof o.text !== 'string')
      fail('MODEL_INVALID', `section ${componentId}/${key} text must be a string`)
    node.text = o.text
  }
  void text
  if (node.text === undefined && node.source === undefined) {
    fail('MODEL_INVALID', `section ${componentId}/${key} carries neither text nor a source pin`)
  }
  if (node.text !== undefined && node.source !== undefined) {
    fail(
      'MODEL_INVALID',
      `section ${componentId}/${key} has both text and source — pick one (ambiguous authored binding)`
    )
  }
  return node
}

function bindingNode(raw: unknown, componentId: string): BindingNode {
  const o = asRecord(raw, `coverage binding of component ${componentId}`)
  const clauseId = optString(o.clauseId)
  const realization = optString(o.realization)
  const requiredLoadPhase = optString(o.requiredLoadPhase) ?? optString(o.loadPhase)
  if (!clauseId || !realization || !requiredLoadPhase) {
    fail(
      'MODEL_INVALID',
      `component ${componentId} has a coverage binding missing clauseId/realization/requiredLoadPhase`,
      {
        componentId,
        binding: o
      }
    )
  }
  return { clauseId, sectionKey: optString(o.sectionKey) ?? '', realization, requiredLoadPhase }
}

function componentNode(row: Record<string, unknown>): ComponentNode {
  const id = optString(row.id)
  const kind = optString(row.kind)
  const activation = optString(row.activation)
  if (!id || !kind || !activation) {
    fail(
      'MODEL_INVALID',
      `implementation_components row missing id/kind/activation: ${canonicalJson(row)}`
    )
  }
  if (activation !== 'initial' && activation !== 'conditional') {
    fail('MODEL_INVALID', `component ${id} has unknown activation ${JSON.stringify(activation)}`)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    fail('MODEL_INVALID', `component id ${JSON.stringify(id)} is not path-safe`)
  }
  const binding = asRecord(
    parseJsonColumn(row.binding_json, `binding_json of component ${id}`),
    `binding of component ${id}`
  )
  const rawSections = binding.sections ?? []
  if (!Array.isArray(rawSections))
    fail('MODEL_INVALID', `component ${id} binding.sections is not an array`)
  const sections = rawSections.map((s) => sectionNode(s, id))
  const seenKeys = new Set<string>()
  for (const s of sections) {
    if (seenKeys.has(s.key))
      fail('MODEL_INVALID', `component ${id} declares duplicate section key ${s.key}`)
    seenKeys.add(s.key)
  }
  const consumes = stringArray(
    parseJsonColumn(row.consumes_json, `consumes_json of component ${id}`) ?? [],
    `consumes of component ${id}`
  )
  const rawCoverage = parseJsonColumn(row.coverage_json, `coverage_json of component ${id}`) ?? []
  if (!Array.isArray(rawCoverage))
    fail('MODEL_INVALID', `component ${id} coverage_json is not an array`)
  const coverage = rawCoverage.map((b) => bindingNode(b, id))
  return { id, kind, activation, sections, binding, consumes, coverage }
}

// ---------------------------------------------------------------------------
// component graph — topo order over `consumes`, deterministic by id

function topoOrder(components: readonly ComponentNode[]): ComponentNode[] {
  const byId = new Map(components.map((c) => [c.id, c]))
  if (byId.size !== components.length) {
    fail('MODEL_INVALID', 'duplicate component id in implementation_components')
  }
  const dependents = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  for (const c of components) {
    indegree.set(c.id, 0)
    for (const dep of c.consumes) {
      if (!byId.has(dep)) {
        fail('MODEL_INVALID', `component ${c.id} consumes unknown component ${JSON.stringify(dep)}`)
      }
      if (dep === c.id) {
        fail('MODEL_INVALID', `component ${c.id} consumes itself`)
      }
      dependents.set(dep, [...(dependents.get(dep) ?? []), c.id])
      indegree.set(c.id, (indegree.get(c.id) ?? 0) + 1)
    }
  }
  const ready = components
    .filter((c) => indegree.get(c.id) === 0)
    .map((c) => c.id)
    .sort()
  const ordered: ComponentNode[] = []
  while (ready.length > 0) {
    const id = ready.shift()!
    ordered.push(byId.get(id)!)
    for (const consumer of dependents.get(id) ?? []) {
      const d = indegree.get(consumer)! - 1
      indegree.set(consumer, d)
      if (d === 0) {
        const at = ready.findIndex((r) => r > consumer)
        ready.splice(at === -1 ? ready.length : at, 0, consumer)
      }
    }
  }
  if (ordered.length !== components.length) {
    const remaining = [...indegree.entries()].filter(([, d]) => d > 0).map(([id]) => id)
    fail('MODEL_INVALID', `component consumes graph is cyclic: ${remaining.sort().join(', ')}`, {
      cyclic: remaining.sort()
    })
  }
  return ordered
}

// ---------------------------------------------------------------------------
// surfaces — the effective command surface is opaque JSON; extract a stable
// action list from whichever shape it takes (array / {actions:[…]} / map).

interface SurfaceAction {
  name: string
  detail: unknown
}

function surfaceActionList(surface: unknown): SurfaceAction[] {
  let entries: SurfaceAction[]
  const fromArray = (items: unknown[]): SurfaceAction[] =>
    items.map((item) => {
      if (isRecord(item)) {
        const name = optString(item.name) ?? optString(item.operation) ?? optString(item.id)
        if (!name)
          fail('MODEL_INVALID', `command surface action has no name: ${canonicalJson(item)}`)
        return { name, detail: item }
      }
      if (typeof item === 'string' && item.length > 0) return { name: item, detail: item }
      fail('MODEL_INVALID', `unreadable command surface action: ${JSON.stringify(item)}`)
    })
  if (Array.isArray(surface)) {
    entries = fromArray(surface)
  } else if (isRecord(surface)) {
    if (Array.isArray(surface.actions)) entries = fromArray(surface.actions)
    else if (isRecord(surface.actions)) {
      entries = Object.entries(surface.actions).map(([name, detail]) => ({ name, detail }))
    } else {
      entries = Object.entries(surface).map(([name, detail]) => ({ name, detail }))
    }
  } else {
    fail('MODEL_INVALID', 'command surface payload is neither array nor object')
  }
  for (const e of entries) {
    if (!e.name) fail('MODEL_INVALID', 'command surface contains an unnamed action')
  }
  const seen = new Set<string>()
  return entries
    .sort((a, b) =>
      a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : canonicalJson(a.detail) < canonicalJson(b.detail)
            ? -1
            : 1
    )
    .filter((e) => {
      const key = `${e.name}${canonicalJson(e.detail)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

// ---------------------------------------------------------------------------
// rendering — deterministic per kind; the compiler assembles, never authors

const INSTALL_ROOT = 'role/components/'

function defaultInstallPath(component: ComponentNode): string {
  switch (component.kind) {
    case 'instruction':
      return `${INSTALL_ROOT}instructions/${component.id}.md`
    case 'skill':
      return `${INSTALL_ROOT}skills/${component.id}/SKILL.md`
    case 'subagent':
      return `${INSTALL_ROOT}agents/${component.id}.md`
    case 'tool-config':
      return `${INSTALL_ROOT}tools/${component.id}.json`
    default:
      return `${INSTALL_ROOT}launch/${component.id}.json`
  }
}

function assertInstallPath(path: string, componentId: string): void {
  if (
    !path.startsWith(INSTALL_ROOT) ||
    path.length === INSTALL_ROOT.length ||
    path.endsWith('/') ||
    path.includes('//') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((s) => s === '' || s === '.' || s === '..')
  ) {
    fail(
      'MODEL_INVALID',
      `component ${componentId} installPath ${JSON.stringify(path)} must stay under ${INSTALL_ROOT} as a clean relative path`
    )
  }
}

/** spec/injection.md §2: tool-config "secret 별도" — credentials never enter
 *  bundle content. Reject secret-shaped field names anywhere in the
 *  structural binding (section `text` leaves are authored prose, skipped). */
const SECRETISH_KEY = /secret|token|passw(or)?d|credential|api[_-]?key|private[_-]?key/i

function scanForSecrets(value: unknown, where: string, componentId: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanForSecrets(item, `${where}[${i}]`, componentId))
    return
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (SECRETISH_KEY.test(k)) {
        fail(
          'MODEL_INVALID',
          `component ${componentId} declares a secret-shaped field ${JSON.stringify(k)} at ${where} — credentials are provisioned separately, never baked into a bundle`,
          {
            componentId,
            field: `${where}.${k}`
          }
        )
      }
      if (k === 'text') continue // authored prose, not a config field
      scanForSecrets(v, `${where}.${k}`, componentId)
    }
  }
}

/** spec/injection.md §2 launch-config: "승인된 recipe만, 임의 shell 문자열
 *  실행 금지" — a launch-config names profile options and component load
 *  map; executable recipe keys are a compile error. */
const FORBIDDEN_EXECUTABLE_KEYS = new Set([
  'exec',
  'shell',
  'command',
  'cmd',
  'argv',
  'script',
  'sh',
  'eval',
  'spawn'
])

function scanForExecutableRecipe(value: unknown, where: string, componentId: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanForExecutableRecipe(item, `${where}[${i}]`, componentId))
    return
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_EXECUTABLE_KEYS.has(k.toLowerCase())) {
        fail(
          'MODEL_INVALID',
          `launch-config ${componentId} declares executable key ${JSON.stringify(k)} — only approved profile recipes may run`,
          {
            componentId,
            field: `${where}.${k}`
          }
        )
      }
      scanForExecutableRecipe(v, `${where}.${k}`, componentId)
    }
  }
}

function yamlScalar(value: unknown): string {
  if (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9 _.,:;/()'"+@-]*$/.test(value) &&
    !/\s$/.test(value)
  ) {
    return value
  }
  return JSON.stringify(value)
}

function renderFrontmatter(meta: Record<string, unknown>): string {
  const keys = Object.keys(meta).sort()
  if (keys.length === 0) return ''
  return `---\n${keys.map((k) => `${k}: ${yamlScalar(meta[k])}`).join('\n')}\n---\n\n`
}

function resolveSectionText(
  section: SectionNode,
  componentId: string,
  sources: ReadonlyMap<string, ObservedSource>
): string {
  if (section.source) {
    const observed = sources.get(section.source.path)
    if (!observed) {
      fail(
        'SNAPSHOT_REQUIRED',
        `section ${componentId}/${section.key} references source ${section.source.path} which is not covered by sourceSnapshotPins`,
        {
          componentId,
          sectionKey: section.key,
          path: section.source.path
        }
      )
    }
    if (section.source.digest !== undefined && section.source.digest !== observed.observedDigest) {
      fail(
        'INTERFACE_STALE',
        `section ${componentId}/${section.key} pins digest that differs from the sourceSnapshotPin`,
        {
          componentId,
          sectionKey: section.key,
          path: section.source.path,
          sectionDigest: section.source.digest,
          observedDigest: observed.observedDigest
        }
      )
    }
    return utf8Decode(observed.bytes, `source ${section.source.path}`)
  }
  return section.text!
}

/** Render the installable artifact for one component (deterministic). */
function renderArtifact(
  component: ComponentNode,
  sources: ReadonlyMap<string, ObservedSource>
): { bytes: Uint8Array; mediaType: string } {
  const binding = component.binding
  const name = optString(binding.name) ?? optString(binding.title) ?? component.id
  const description = optString(binding.description)
  const body = component.sections
    .map((s) => resolveSectionText(s, component.id, sources))
    .join('\n\n')

  switch (component.kind) {
    case 'instruction':
      return { bytes: utf8(body === '' ? body : `${body}\n`), mediaType: 'text/markdown' }
    case 'skill':
    case 'subagent': {
      const metadata = isRecord(binding.metadata) ? { ...binding.metadata } : {}
      scanForSecrets(metadata, 'binding.metadata', component.id)
      const meta: Record<string, unknown> = { ...metadata, name: optString(metadata.name) ?? name }
      if (description) meta.description = description
      return { bytes: utf8(`${renderFrontmatter(meta)}${body}\n`), mediaType: 'text/markdown' }
    }
    case 'tool-config': {
      const requiredActions =
        binding.requiredActions === undefined
          ? []
          : stringArray(binding.requiredActions, `requiredActions of component ${component.id}`)
      const tools =
        binding.tools === undefined
          ? {}
          : asRecord(binding.tools, `tools of component ${component.id}`)
      scanForSecrets({ requiredActions, tools }, 'binding', component.id)
      const doc = {
        format: 'tool-config/1',
        componentId: component.id,
        name,
        ...(description !== undefined ? { description } : {}),
        requiredActions,
        tools
      }
      return { bytes: utf8(canonicalJson(doc)), mediaType: 'application/json' }
    }
    default: {
      // launch-config
      const launch =
        binding.launch === undefined
          ? {}
          : asRecord(binding.launch, `launch of component ${component.id}`)
      scanForSecrets(launch, 'binding.launch', component.id)
      scanForExecutableRecipe(launch, 'binding.launch', component.id)
      const doc = { format: 'launch-config/1', componentId: component.id, name, ...launch }
      return { bytes: utf8(canonicalJson(doc)), mediaType: 'application/json' }
    }
  }
}

// ---------------------------------------------------------------------------
// mandatory text — spec/injection.md §3 order:
//   role & judgment scope → required context → contract meaning → permitted
//   command usage → bootstrap/collaboration. Slots 1–3 are authored in the
//   implementation's own instruction/skill sections (the compiler never
//   writes role meaning); commands + bootstrap are deterministic blocks.

const BOOTSTRAP_BLOCK = `## Collaboration bootstrap

This execution was launched by mahas with a compiled context bundle.
- Before doing other work, call \`mahas execution join\` with the bundle, surface and work-envelope digests provided at launch.
- If this launch carries a task assignment, call \`mahas task accept\` with the exact TaskRevision and WorkEnvelope digest.
- Use \`mahas inbox.check\` for peer messages; reply and acknowledge per the collaboration contract.
- Only the permitted commands listed above exist for this role; anything not listed is unavailable.`

function renderCommandsSection(actions: readonly SurfaceAction[]): string {
  const lines = [
    '## Permitted commands',
    '',
    'Only the operations listed below are available to this role. Any operation not listed is not permitted.'
  ]
  if (actions.length === 0) {
    lines.push('', '_No operations are exposed to this role._')
  }
  for (const action of actions) {
    lines.push('', `### \`${action.name}\``, '', '```json', canonicalJson(action.detail), '```')
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// the pure compile

export function compileContextBundle(input: CompileInput): CompiledBundle {
  const ordered = topoOrder(input.components)
  const coverage = validateCoverage(input.requirements, ordered, input.contextPaths)
  const surfaceActions = surfaceActionList(input.surface)
  const actionNames = new Set(surfaceActions.map((a) => a.name))

  // profile must support every used component kind — no silent downgrades
  if (ordered.length > 0) {
    if (input.supportedComponents === null) {
      fail(
        'INJECTION_UNSUPPORTED',
        `harness profile declares no supportedComponents — cannot confirm ${ordered.length} component(s)`,
        {
          implementationId: input.implementationId,
          kinds: [...new Set(ordered.map((c) => c.kind))]
        }
      )
    }
    for (const component of ordered) {
      if (!input.supportedComponents.includes(component.kind)) {
        fail(
          'INJECTION_UNSUPPORTED',
          `harness profile does not support component kind ${component.kind} required by ${component.id}`,
          {
            componentId: component.id,
            kind: component.kind
          }
        )
      }
    }
  }

  // per-component artifacts + install paths + collision check
  const installPaths = new Map<string, string>()
  const artifacts: ComponentArtifact[] = []
  const coversByComponent = new Map<string, string[]>()
  for (const record of coverage) {
    coversByComponent.set(record.componentId, [
      ...(coversByComponent.get(record.componentId) ?? []),
      record.clauseId
    ])
  }
  const loadRoutesByComponent = new Map<string, string[]>()
  const inlineBound = new Map<string, Set<string>>() // componentId → sectionKeys inlined
  for (const record of coverage) {
    if (record.delivery !== 'mandatory-text') continue
    inlineBound.set(
      record.componentId,
      [...(inlineBound.get(record.componentId) ?? [])].reduce(
        (set, k) => set.add(k),
        new Set<string>()
      )
    )
    const routes = loadRoutesByComponent.get(record.componentId) ?? []
    if (!routes.includes('mandatory-text')) routes.push('mandatory-text')
    loadRoutesByComponent.set(record.componentId, routes)
  }

  for (const component of ordered) {
    const installPath = optString(component.binding.installPath) ?? defaultInstallPath(component)
    assertInstallPath(installPath, component.id)
    const holder = installPaths.get(installPath)
    if (holder !== undefined) {
      fail(
        'MODEL_INVALID',
        `install path collision: components ${holder} and ${component.id} both claim ${installPath}`,
        {
          path: installPath,
          components: [holder, component.id]
        }
      )
    }
    installPaths.set(installPath, component.id)

    // tool-config required actions must exist in the effective surface —
    // the surface IS the role's current action ceiling at build time
    // (instruction §4.5, REQ-09/10).
    if (component.kind === 'tool-config') {
      const required =
        component.binding.requiredActions === undefined
          ? []
          : stringArray(
              component.binding.requiredActions,
              `requiredActions of component ${component.id}`
            )
      for (const action of required) {
        if (!actionNames.has(action)) {
          fail(
            'REQUIRED_ACTION_DENIED',
            `component ${component.id} requires action ${JSON.stringify(action)} which the effective command surface does not permit`,
            {
              componentId: component.id,
              action,
              surfaceDigest: input.surfaceDigest
            }
          )
        }
      }
    }

    const rendered = renderArtifact(component, input.sources)
    const digest = digestText(new TextDecoder().decode(rendered.bytes)) === '' ? '' : ''
    void digest
    artifacts.push({
      componentId: component.id,
      installPath,
      mediaType: rendered.mediaType,
      bytes: rendered.bytes,
      digest: '' // filled below via putBlob — but manifest needs it now
    })
    // load routes (default by kind/activation; inline bindings add mandatory-text)
    const routes = loadRoutesByComponent.get(component.id) ?? []
    switch (component.kind) {
      case 'instruction':
        if (component.activation === 'initial' && !routes.includes('mandatory-text'))
          routes.unshift('mandatory-text')
        if (component.activation === 'conditional' && !routes.includes('catalog'))
          routes.push('catalog')
        break
      case 'skill': {
        const inlined = inlineBound.get(component.id) ?? new Set<string>()
        const allInlined =
          component.sections.length > 0 && component.sections.every((s) => inlined.has(s.key))
        if (component.activation === 'initial') {
          if (!allInlined && !routes.includes('confirmed-preload')) routes.push('confirmed-preload')
        } else if (!routes.includes('catalog')) routes.push('catalog')
        break
      }
      case 'subagent':
        routes.push('native-definition')
        break
      case 'tool-config':
        routes.push('scoped-config')
        break
      default:
        routes.push('load-map')
    }
    loadRoutesByComponent.set(component.id, routes)
  }

  // confirmed preload must be a profile-declared route — a mandatory skill
  // can never silently degrade to a catalog entry (spec/injection.md §4.3)
  const needsPreload = ordered.some((c) =>
    (loadRoutesByComponent.get(c.id) ?? []).includes('confirmed-preload')
  )
  if (needsPreload) {
    const routes = input.injectionRoutes
    const confirmed = routes !== null && routes.some((r) => r.toLowerCase().includes('preload'))
    if (!confirmed) {
      fail(
        'INJECTION_UNSUPPORTED',
        `a mandatory skill requires the confirmed preload route but the harness profile does not declare it`,
        {
          implementationId: input.implementationId,
          declaredRoutes: routes
        }
      )
    }
  }

  // mandatory text assembly (spec §3 order)
  const blocks: string[] = []
  blocks.push(
    [
      '# Role context',
      '',
      `role: ${input.roleId}${input.roleName !== undefined ? ` (${input.roleName})` : ''}`,
      `model: ${input.modelVersion}`,
      `implementation: ${input.implementationId}@${input.implementationRevision}`,
      `interface: ${input.interfaceDigest}`
    ].join('\n')
  )
  const injected = new Set<string>()
  for (const component of ordered) {
    if (component.kind !== 'instruction' || component.activation !== 'initial') continue
    const text = component.sections
      .map((s) => resolveSectionText(s, component.id, input.sources))
      .join('\n\n')
    for (const s of component.sections) injected.add(`${component.id}/${s.key}`)
    if (text !== '') blocks.push(text)
  }
  for (const record of coverage) {
    if (record.delivery !== 'mandatory-text') continue
    const key = `${record.componentId}/${record.sectionKey}`
    if (injected.has(key)) continue
    injected.add(key)
    const component = ordered.find((c) => c.id === record.componentId)!
    const section = component.sections.find((s) => s.key === record.sectionKey)!
    blocks.push(resolveSectionText(section, component.id, input.sources))
  }
  blocks.push(renderCommandsSection(surfaceActions))
  blocks.push(BOOTSTRAP_BLOCK)
  const mandatoryText = `${blocks.join('\n\n')}\n`
  const requiredTextDigest = digestText(mandatoryText)

  // fill artifact digests now that rendering is complete
  for (const artifact of artifacts) {
    artifact.digest = digestText(new TextDecoder().decode(artifact.bytes))
  }

  const components: ComponentManifestEntry[] = ordered.map((component) => {
    const artifact = artifacts.find((a) => a.componentId === component.id)!
    const entry: ComponentManifestEntry = {
      componentId: component.id,
      kind: component.kind,
      activation: component.activation,
      installPath: artifact.installPath,
      blobDigest: artifact.digest,
      byteLength: artifact.bytes.byteLength,
      mediaType: artifact.mediaType,
      loadRoutes: loadRoutesByComponent.get(component.id) ?? [],
      consumes: [...component.consumes],
      covers: coversByComponent.get(component.id) ?? []
    }
    return entry
  })

  const manifest: BundleManifest = {
    format: 'context-bundle/1',
    role: {
      id: input.roleId,
      ...(input.roleName !== undefined ? { name: input.roleName } : {}),
      modelVersion: input.modelVersion
    },
    interfaceDigest: String(input.interfaceDigest),
    implementationId: input.implementationId,
    implementationRevision: input.implementationRevision,
    surfaceDigest: input.surfaceDigest,
    requiredText: {
      digest: requiredTextDigest,
      byteLength: utf8(mandatoryText).byteLength,
      mediaType: 'text/markdown'
    },
    components,
    coverage,
    sourceObservations: [...input.sources.values()]
      .map((obs) => ({
        path: obs.path,
        pinnedDigest: obs.pinnedDigest,
        observedDigest: obs.observedDigest,
        blobDigest: obs.blobDigest,
        byteLength: obs.byteLength,
        mediaType: obs.mediaType
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
    maintenanceBasis: [...input.maintenanceBasis].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    ),
    surface: { digest: input.surfaceDigest, actions: [...actionNames].sort() }
  }

  return {
    bundleDigest: bundleDigestOf(manifest),
    mandatoryText,
    requiredTextDigest,
    manifest,
    artifacts
  }
}

// ---------------------------------------------------------------------------
// DB-backed build — loads the pinned rows, observes sources, compiles,
// persists. Runs inside the registry's write transaction when invoked as an
// operation (txn.db); callable directly by the launch service too.

function one(
  db: DatabaseSync,
  sql: string,
  ...args: (string | number)[]
): Record<string, unknown> | undefined {
  return db.prepare(sql).get(...args) as Record<string, unknown> | undefined
}

function many(
  db: DatabaseSync,
  sql: string,
  ...args: (string | number)[]
): Record<string, unknown>[] {
  return db.prepare(sql).all(...args) as Record<string, unknown>[]
}

export function buildContextBundle(deps: ContextBuildDeps, rawInput: unknown): ContextBuildResult {
  const input = parseBuildInput(rawInput)
  const db = deps.db

  // 1. pinned interface snapshot (role_interfaces)
  const ifaceRow = one(
    db,
    `SELECT model_version, role_id, requirements_json, judgment_scope_json FROM role_interfaces WHERE digest = ?`,
    input.interfaceDigest
  )
  if (!ifaceRow) {
    fail('INTERFACE_STALE', `role interface ${input.interfaceDigest} is not a stored snapshot`, {
      interfaceDigest: input.interfaceDigest
    })
  }
  const modelVersion = optString(ifaceRow!.model_version)!
  const roleId = optString(ifaceRow!.role_id)!
  const requirements = requirementNodes(
    parseJsonColumn(ifaceRow!.requirements_json, 'role_interfaces.requirements_json')
  )

  // 2. the implementation revision must exist, be published (or retired —
  // rebuilds for pinned running executions stay reproducible), and target
  // exactly the pinned interface
  const implRow = one(
    db,
    `SELECT interface_digest, profile_id, profile_revision, status, maintainer_role_id
       FROM role_implementations WHERE id = ? AND revision = ?`,
    input.implementationId,
    input.implementationRevision
  )
  if (!implRow) {
    fail(
      'IMPLEMENTATION_MISSING',
      `role implementation ${input.implementationId}@${input.implementationRevision} not found`,
      {
        implementationId: input.implementationId,
        implementationRevision: input.implementationRevision
      }
    )
  }
  if (optString(implRow!.interface_digest) !== input.interfaceDigest) {
    fail(
      'INTERFACE_STALE',
      `implementation ${input.implementationId}@${input.implementationRevision} realizes ${optString(implRow!.interface_digest)}, not the pinned ${input.interfaceDigest}`,
      {
        interfaceDigest: input.interfaceDigest,
        implementationInterfaceDigest: optString(implRow!.interface_digest)
      }
    )
  }
  const implStatus = optString(implRow!.status) ?? ''
  if (implStatus !== 'published' && implStatus !== 'retired') {
    fail(
      'INVALID_TRANSITION',
      `implementation ${input.implementationId}@${input.implementationRevision} is ${implStatus}, not a published revision`,
      {
        implementationId: input.implementationId,
        implementationRevision: input.implementationRevision,
        status: implStatus
      }
    )
  }

  // 3. harness profile capabilities (support matrix for component kinds)
  const profileId = optString(implRow!.profile_id)!
  const profileRevision = implRow!.profile_revision
  const profileRow = one(
    db,
    `SELECT state, recipe_json, capabilities_json FROM harness_profiles WHERE id = ? AND revision = ?`,
    profileId,
    typeof profileRevision === 'number' ? profileRevision : Number(profileRevision)
  )
  if (!profileRow) {
    fail(
      'MODEL_INVALID',
      `implementation ${input.implementationId} references missing harness profile ${profileId}`,
      {
        profileId,
        profileRevision
      }
    )
  }
  if (optString(profileRow!.state) === 'disabled') {
    fail('INJECTION_UNSUPPORTED', `harness profile ${profileId} is disabled`, {
      profileId,
      profileRevision
    })
  }
  const capabilities = asRecord(
    parseJsonColumn(profileRow!.capabilities_json, 'harness_profiles.capabilities_json') ?? {},
    'harness profile capabilities'
  )
  const recipe = asRecord(
    parseJsonColumn(profileRow!.recipe_json, 'harness_profiles.recipe_json') ?? {},
    'harness profile recipe'
  )
  const supportedComponents =
    stringListOrNull(capabilities.supportedComponents) ??
    stringListOrNull(recipe.supportedComponents)
  const injectionRoutes =
    stringListOrNull(capabilities.injectionRoutes) ?? stringListOrNull(recipe.injectionRoutes)

  // 4. the effective command surface snapshot (derived by C-ACCESS)
  const surfRow = one(
    db,
    `SELECT actions_and_schemas_json FROM command_surfaces WHERE digest = ?`,
    input.surfaceDigest
  )
  if (!surfRow) {
    fail(
      'SNAPSHOT_REQUIRED',
      `command surface ${input.surfaceDigest} is not a stored snapshot`,
      {
        surfaceDigest: input.surfaceDigest
      },
      'same-operation'
    )
  }
  const surface = parseJsonColumn(
    surfRow!.actions_and_schemas_json,
    'command_surfaces.actions_and_schemas_json'
  )

  // 5. components, maintenance trace, context→path map, role name
  const componentRows = many(
    db,
    `SELECT id, kind, activation, binding_json, consumes_json, coverage_json
       FROM implementation_components WHERE implementation_id = ? AND implementation_revision = ? ORDER BY id`,
    input.implementationId,
    input.implementationRevision
  )
  const components = componentRows.map(componentNode)
  const maintenanceBasis: MaintenanceBasisEntry[] = many(
    db,
    `SELECT id, basis_ref_json, component_ref_json FROM maintenance_bindings
       WHERE implementation_id = ? AND implementation_revision = ? ORDER BY id`,
    input.implementationId,
    input.implementationRevision
  ).map((row) => ({
    id: String(row.id),
    basisRef: parseJsonColumn(row.basis_ref_json, 'maintenance_bindings.basis_ref_json'),
    componentRef: parseJsonColumn(row.component_ref_json, 'maintenance_bindings.component_ref_json')
  }))
  const contextPaths = new Map<string, string>()
  for (const row of many(
    db,
    `SELECT id, path FROM rdd_contexts WHERE model_version = ?`,
    modelVersion
  )) {
    const id = optString(row.id)
    const path = optString(row.path)
    if (id && path) contextPaths.set(id, path)
  }
  const roleRow = one(
    db,
    `SELECT name FROM rdd_roles WHERE model_version = ? AND id = ?`,
    modelVersion,
    roleId
  )
  const roleName = optString(roleRow?.name)

  // 6. observe pinned sources — real bytes, verified against the pins,
  // stored as content blobs. Sections may only pull pinned sources.
  const sourceRoot = input.sourceRoot ?? deps.sourceRoot
  const reader =
    deps.readSourceFile ?? (sourceRoot !== undefined ? makeFilesystemReader(sourceRoot) : undefined)
  const pins = input.sourceSnapshotPins ?? []
  let observed: ObservedSource[] = []
  if (pins.length > 0) {
    if (!reader) {
      fail(
        'SNAPSHOT_REQUIRED',
        'sourceSnapshotPins were given but no sourceRoot or source reader is available',
        {
          pinCount: pins.length
        },
        'same-operation'
      )
    }
    observed = observeSources(pins, reader)
  }
  const sources = new Map(observed.map((o) => [o.path, o]))

  // 7. deterministic compile
  const compiled = compileContextBundle({
    interfaceDigest: input.interfaceDigest as RoleInterfaceDigest,
    roleId,
    ...(roleName !== undefined ? { roleName } : {}),
    modelVersion,
    requirements,
    contextPaths,
    implementationId: input.implementationId,
    implementationRevision: input.implementationRevision,
    components,
    supportedComponents,
    injectionRoutes,
    surfaceDigest: input.surfaceDigest,
    surface: surface as CommandSurface,
    sources,
    maintenanceBasis
  })

  // 8. persist: source observations → component artifacts → required text →
  // bundle row. Everything content-addressed; identical build = idempotent.
  persistObservedSources(db, observed)
  for (const artifact of compiled.artifacts) {
    const blob = putBlob(db, artifact.bytes, artifact.mediaType)
    if (blob.digest !== artifact.digest) {
      fail('MODEL_INVALID', `artifact digest drift for component ${artifact.componentId}`, {
        componentId: artifact.componentId,
        computed: artifact.digest,
        stored: blob.digest
      })
    }
  }
  putBlob(db, utf8(compiled.mandatoryText), 'text/markdown')

  const record: ContextBundleRecord = {
    digest: compiled.bundleDigest,
    implementationId: input.implementationId,
    implementationRevision: input.implementationRevision,
    interfaceDigest: input.interfaceDigest,
    surfaceDigest: input.surfaceDigest,
    requiredTextDigest: compiled.requiredTextDigest,
    manifest: compiled.manifest,
    sourceObservations: compiled.manifest.sourceObservations
  }
  const reused = getContextBundle(db, compiled.bundleDigest) !== null
  insertContextBundle(db, record)
  appendDomainEvent(
    db,
    compiled.bundleDigest,
    1,
    'context.built',
    {
      implementationId: input.implementationId,
      implementationRevision: input.implementationRevision
    },
    {
      bundleDigest: compiled.bundleDigest,
      interfaceDigest: input.interfaceDigest,
      surfaceDigest: input.surfaceDigest,
      requiredTextDigest: compiled.requiredTextDigest,
      reused
    }
  )

  return {
    bundleDigest: compiled.bundleDigest,
    requiredTextDigest: compiled.requiredTextDigest,
    manifest: compiled.manifest,
    reused
  }
}

function stringListOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out = value.filter((v): v is string => typeof v === 'string')
  return out.length === value.length ? out : null
}

// ---------------------------------------------------------------------------
// operation registration (IMP-11 OperationRegistry — the registry owns
// visibility → authorize → idempotency → tx → receipt, so the handler is the
// pure domain step).

/**
 * Registers the C-REALIZATION build operation:
 *   context.build — visibility 'service' (role configuration / launch
 *   service; never exposed to general execution agents — the contract bars
 *   these commands from being a self-modification API), mutation true.
 */
export function registerContextOps(registry: OperationRegistry, deps: ContextOpsDeps = {}): void {
  registry.register(
    { name: 'context.build', visibility: 'service', mutation: true },
    (txn, payload) =>
      buildContextBundle(
        { db: txn.db, sourceRoot: deps.sourceRoot, readSourceFile: deps.readSourceFile },
        payload
      )
  )
}
