// coverage.ts — clause-coverage validation and delivery resolution.
//
// The semantic core of the compiler (spec/injection.md §1, D-ROLE §5):
// coverageBindings declare WHICH component/section realizes each interface
// clause and HOW (verbatim | reexpressed); the compiler only enforces the
// structure — it never writes, summarizes or appends meaning itself.
//
// Rules enforced here:
//   - every binding resolves: clauseId ∈ interface requirements, sectionKey
//     ∈ the component's declared sections (for text-carrying kinds)
//   - load phase ↔ activation consistency: 'inline'/'preload' bindings only
//     on activation='initial' components, 'catalog' only on 'conditional'
//   - every deliveryClass='initial' requirement has ≥1 binding that actually
//     delivers at start (inline into the mandatory text or confirmed
//     preload). Mapping an initial requirement to a conditional catalog
//     entry alone is a compile error → MANDATORY_COMPONENT_MISSING
//     (instruction §4.2 — "optional skill 설명만으로 완료하지 않는다")
//   - reexpressed means reexpressed: once a clause is bound with
//     realization='reexpressed', no binding for that clause may pull the
//     requirement's OWN source file — the implementation phrasing is the
//     injection, the original 장문 is never appended (instruction §4.3,
//     spec/injection.md §1)
//
// This module is pure: no I/O, no DB. `ComponentNode`/`RequirementNode` are
// the compiler's normalized views — compiler.ts builds them from
// implementation_components / role_interfaces rows.

import { fail, type CoverageRecord } from './bundle-store.ts'

export const COMPONENT_KINDS = new Set([
  'instruction',
  'skill',
  'subagent',
  'tool-config',
  'launch-config'
])
export const LOAD_PHASES = new Set(['inline', 'preload', 'catalog'])
/** IMP-07 authoring vocab accepted and mapped onto LOAD_PHASES */
export const AUTHORING_LOAD_PHASES = new Set(['initial', 'conditional'])
export const REALIZATIONS = new Set(['verbatim', 'reexpressed'])

/**
 * Unify IMP-07 ('initial'|'conditional') with compiler
 * ('inline'|'preload'|'catalog'). initial → inline (instruction) or
 * preload (skill/subagent); conditional → catalog.
 */
export function normalizeLoadPhase(phase: string, kind?: string): string {
  if (phase === 'inline' || phase === 'preload' || phase === 'catalog') return phase
  if (phase === 'conditional') return 'catalog'
  if (phase === 'initial') {
    if (kind === 'skill' || kind === 'subagent') return 'preload'
    return 'inline'
  }
  return phase
}

/** activation column may be a phase string or JSON `{phase,route}` */
export function normalizeActivation(activation: string): string {
  if (activation === 'initial' || activation === 'conditional') return activation
  const trimmed = activation.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed === 'initial' || parsed === 'conditional') return parsed
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const phase = (parsed as { phase?: unknown }).phase
        if (phase === 'initial' || phase === 'conditional') return phase
      }
    } catch {
      /* fall through */
    }
  }
  return activation
}

/** kinds whose bindings must point at a real section of authored text */
const TEXT_CARRYING_KINDS = new Set(['instruction', 'skill', 'subagent'])

export interface RequirementNode {
  clauseId: string
  contextId?: string
  criterionRef?: string
  requiredMeaning?: string
  deliveryClass: string
  readerPerspective?: string
}

export interface SectionNode {
  key: string
  heading?: string
  text?: string
  source?: { path: string; digest?: string }
}

export interface BindingNode {
  clauseId: string
  sectionKey: string
  realization: string
  requiredLoadPhase: string
}

export interface ComponentNode {
  id: string
  kind: string
  activation: string
  sections: SectionNode[]
  binding: Record<string, unknown>
  consumes: string[]
  coverage: BindingNode[]
}

interface Clause {
  requirement: RequirementNode
  bindings: { component: ComponentNode; binding: BindingNode }[]
}

const DELIVERY_BY_PHASE: Record<string, CoverageRecord['delivery']> = {
  inline: 'mandatory-text',
  preload: 'confirmed-preload',
  catalog: 'catalog'
}

/**
 * Validate all coverageBindings and return the ordered coverage records.
 * `components` must already be in graph order (topo over `consumes`);
 * `contextPaths` maps requirement.contextId → repo-relative source path for
 * the reexpressed-original guard.
 */
export function validateCoverage(
  requirements: readonly RequirementNode[],
  components: readonly ComponentNode[],
  contextPaths: ReadonlyMap<string, string>
): CoverageRecord[] {
  const clauseOrder = new Map<string, number>()
  const clauses = new Map<string, Clause>()
  requirements.forEach((req, i) => {
    if (clauseOrder.has(req.clauseId)) {
      fail('MODEL_INVALID', `duplicate clauseId in interface requirements: ${req.clauseId}`)
    }
    clauseOrder.set(req.clauseId, i)
    clauses.set(req.clauseId, { requirement: req, bindings: [] })
  })

  for (const component of components) {
    if (!COMPONENT_KINDS.has(component.kind)) {
      fail(
        'MODEL_INVALID',
        `component ${component.id} has unknown kind ${JSON.stringify(component.kind)}`
      )
    }
    const activation = normalizeActivation(component.activation)
    component.activation = activation
    for (const binding of component.coverage) {
      binding.requiredLoadPhase = normalizeLoadPhase(binding.requiredLoadPhase, component.kind)
      const clause = clauses.get(binding.clauseId)
      if (!clause) {
        fail(
          'MODEL_INVALID',
          `component ${component.id} binds unknown clause ${JSON.stringify(binding.clauseId)}`,
          {
            componentId: component.id,
            clauseId: binding.clauseId
          }
        )
      }
      if (!LOAD_PHASES.has(binding.requiredLoadPhase) && !AUTHORING_LOAD_PHASES.has(binding.requiredLoadPhase)) {
        fail(
          'MODEL_INVALID',
          `component ${component.id} binding ${binding.clauseId} has unknown requiredLoadPhase`,
          {
            componentId: component.id,
            clauseId: binding.clauseId,
            requiredLoadPhase: binding.requiredLoadPhase
          }
        )
      }
      if (!REALIZATIONS.has(binding.realization)) {
        fail(
          'MODEL_INVALID',
          `component ${component.id} binding ${binding.clauseId} has unknown realization`,
          {
            componentId: component.id,
            clauseId: binding.clauseId,
            realization: binding.realization
          }
        )
      }
      // a binding that promises initial delivery cannot live on a component
      // the implementation itself marked conditional — and vice versa.
      // Non-text kinds carry no injectable section: their only meaningful
      // binding is 'catalog' (the artifact ships with the bundle and is
      // discoverable via the manifest) on either activation.
      const textKind = TEXT_CARRYING_KINDS.has(component.kind)
      if (!textKind) {
        if (binding.requiredLoadPhase !== 'catalog') {
          fail(
            'MODEL_INVALID',
            `${component.kind} component ${component.id} cannot deliver clause text — only 'catalog' bindings are meaningful`,
            {
              componentId: component.id,
              kind: component.kind,
              clauseId: binding.clauseId,
              requiredLoadPhase: binding.requiredLoadPhase
            }
          )
        }
      } else {
        const initialPhase =
          binding.requiredLoadPhase === 'inline' || binding.requiredLoadPhase === 'preload'
        if (initialPhase && activation !== 'initial') {
          fail(
            'MODEL_INVALID',
            `component ${component.id} is conditional but binds clause ${binding.clauseId} for initial delivery`,
            {
              componentId: component.id,
              clauseId: binding.clauseId,
              activation,
              requiredLoadPhase: binding.requiredLoadPhase
            }
          )
        }
        if (binding.requiredLoadPhase === 'catalog' && activation !== 'conditional') {
          fail(
            'MODEL_INVALID',
            `component ${component.id} is initial but binds clause ${binding.clauseId} as catalog-only`,
            {
              componentId: component.id,
              clauseId: binding.clauseId,
              activation: component.activation,
              requiredLoadPhase: binding.requiredLoadPhase
            }
          )
        }
        const section = component.sections.find((s) => s.key === binding.sectionKey)
        if (!section) {
          fail(
            'MODEL_INVALID',
            `component ${component.id} binding ${binding.clauseId} references missing section`,
            {
              componentId: component.id,
              clauseId: binding.clauseId,
              sectionKey: binding.sectionKey
            }
          )
        }
      }
      clause.bindings.push({ component, binding })
    }
  }

  // reexpressed-original guard (per clause, needs all bindings collected)
  for (const clause of clauses.values()) {
    const req = clause.requirement
    const originalPath = req.contextId !== undefined ? contextPaths.get(req.contextId) : undefined
    if (originalPath === undefined) continue // criterionRef clauses have no source file to guard
    const hasReexpressed = clause.bindings.some((b) => b.binding.realization === 'reexpressed')
    if (!hasReexpressed) continue
    for (const { component, binding } of clause.bindings) {
      const section = component.sections.find((s) => s.key === binding.sectionKey)
      if (section?.source?.path === originalPath) {
        fail(
          'MODEL_INVALID',
          `clause ${req.clauseId} is realized as reexpressed but component ${component.id} still injects the original source ${originalPath}`,
          {
            clauseId: req.clauseId,
            componentId: component.id,
            sectionKey: binding.sectionKey,
            path: originalPath
          }
        )
      }
    }
  }

  // every initial requirement must be satisfied by real initial delivery
  for (const clause of clauses.values()) {
    const req = clause.requirement
    if (req.deliveryClass !== 'initial') continue
    const delivered = clause.bindings.some(
      ({ binding }) =>
        binding.requiredLoadPhase === 'inline' || binding.requiredLoadPhase === 'preload'
    )
    if (!delivered) {
      fail(
        'MANDATORY_COMPONENT_MISSING',
        `initial requirement ${req.clauseId} has no instruction or confirmed preload coverage`,
        {
          clauseId: req.clauseId,
          contextId: req.contextId,
          criterionRef: req.criterionRef,
          boundPhases: clause.bindings.map((b) => b.binding.requiredLoadPhase)
        }
      )
    }
  }

  // deterministic record order: interface clause order → component graph
  // order (the `components` arg is already topo-sorted) → section key.
  const componentOrder = new Map(components.map((c, i) => [c.id, i]))
  const records: CoverageRecord[] = []
  for (const clause of clauses.values()) {
    for (const { component, binding } of clause.bindings) {
      records.push({
        clauseId: clause.requirement.clauseId,
        componentId: component.id,
        sectionKey: binding.sectionKey,
        realization: binding.realization as CoverageRecord['realization'],
        requiredLoadPhase: binding.requiredLoadPhase as CoverageRecord['requiredLoadPhase'],
        delivery: DELIVERY_BY_PHASE[binding.requiredLoadPhase]
      })
    }
  }
  records.sort(
    (a, b) =>
      clauseOrder.get(a.clauseId)! - clauseOrder.get(b.clauseId)! ||
      componentOrder.get(a.componentId)! - componentOrder.get(b.componentId)! ||
      (a.sectionKey < b.sectionKey ? -1 : a.sectionKey > b.sectionKey ? 1 : 0)
  )
  return records
}
