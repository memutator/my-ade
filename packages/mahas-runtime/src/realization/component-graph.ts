// realization/component-graph.ts — ImplementationComponent graph + clause coverage.
//
// injection.md §2 closes the component-kind set: instruction / skill /
// subagent / tool-config / launch-config. The graph records what the
// implementation AUTHOR designed — kind, authored content binding, declared
// outputs, activation phase, permission requirements — never a summary the
// runtime invents (REQ-06: 빌더는 즉석 요약하지 않는다).
//
// coverageBindings are the clause-level claim "component X realizes clause Y
// as verbatim|reexpressed at load-phase Z" (role-realization.md §2). The
// coverage model here decides which required clauses the graph actually
// delivers: a clause whose only bindings sit on 'conditional' components is
// reported unsatisfied — the existence of a conditional skill is never proof
// that required meaning was delivered (role-realization.md §4, injection.md
// §4: conditional-only mapping of an initial requirement is a compile error).

import type { ContextRequirement } from '../../../mahas-contracts/src/role.ts'
import { asRecord, fail, optArray, optString, reqArray, reqString } from './util.ts'

/* ------------------------------------------------------------------ *
 * component model
 * ------------------------------------------------------------------ */

export const COMPONENT_KINDS = [
  'instruction',
  'skill',
  'subagent',
  'tool-config',
  'launch-config'
] as const
export type ComponentKind = (typeof COMPONENT_KINDS)[number]

export type ActivationPhase = 'initial' | 'conditional'

/**
 * Wire-facing component input — structurally identical to the canonical
 * ImplementationComponent minus fields the store assigns. `contentBinding`
 * and `config` stay opaque JSON: the runtime stores them verbatim, the
 * compiler (IMP-08/IMP-24/25) interprets them.
 */
export interface ComponentInput {
  componentId: string
  kind: ComponentKind
  contentBinding?: unknown
  config?: unknown
  consumes: string[]
  outputs: string[]
  activation: { phase: ActivationPhase; route?: string }
  permissionRequirements: unknown[]
  /** required when kind === 'subagent' — primary drives the loop, helper is invoked */
  subagentRole?: 'primary' | 'helper'
}

export interface CoverageBindingInput {
  clauseId: string
  componentId: string
  sectionKey: string
  realization: 'verbatim' | 'reexpressed'
  requiredLoadPhase: 'initial' | 'conditional'
}

export interface ComponentGraphInput {
  components: ComponentInput[]
  coverageBindings: CoverageBindingInput[]
  /** optional maintenance pins — which basis ref each component is maintained against */
  maintenanceBindings?: MaintenanceBindingInput[]
}

export interface MaintenanceBindingInput {
  bindingId: string
  basisRef: unknown
  componentRef: { componentId: string; sectionKey?: string }
}

function isComponentKind(v: string): v is ComponentKind {
  return (COMPONENT_KINDS as readonly string[]).includes(v)
}

/** parse + structurally validate one component entry */
export function parseComponent(raw: unknown): ComponentInput {
  const r = asRecord(raw, 'component')
  const componentId = reqString(r, 'componentId')
  const kindRaw = reqString(r, 'kind')
  if (!isComponentKind(kindRaw)) {
    fail('MODEL_INVALID', `component ${componentId}: unknown kind ${kindRaw}`, {
      details: { allowedKinds: COMPONENT_KINDS }
    })
  }

  const activation = parseActivation(r['activation'], componentId)
  const consumes = optArray(r, 'consumes').map((c, i) => {
    if (typeof c !== 'string' || c.length === 0) {
      fail('MODEL_INVALID', `component ${componentId}: consumes[${i}] must be a component id`)
    }
    return c
  })
  const outputs = optArray(r, 'outputs').map((o, i) => {
    if (typeof o !== 'string' || o.length === 0) {
      fail('MODEL_INVALID', `component ${componentId}: outputs[${i}] must be a path string`)
    }
    return o
  })
  const permissionRequirements = optArray(r, 'permissionRequirements')

  let subagentRole: 'primary' | 'helper' | undefined
  if (kindRaw === 'subagent') {
    const roleRaw = optString(r, 'subagentRole')
    if (roleRaw !== 'primary' && roleRaw !== 'helper') {
      fail(
        'MODEL_INVALID',
        `component ${componentId}: subagent requires subagentRole 'primary'|'helper' — ` +
          'a native helper is never an implicit independent mahas Member (role-realization.md §4)'
      )
    }
    subagentRole = roleRaw
    // injection.md §4: helpers run under the invoker's credential and result
    // responsibility — a helper declaring its own permissionRequirements is
    // exactly the implicit grant path the spec forbids.
    if (subagentRole === 'helper' && permissionRequirements.length > 0) {
      fail(
        'MODEL_INVALID',
        `component ${componentId}: helper subagent may not declare permissionRequirements — ` +
          'it inherits the invoking member’s credential; new grants go through team.assign/worker.start'
      )
    }
  } else if (r['subagentRole'] !== undefined) {
    fail('MODEL_INVALID', `component ${componentId}: subagentRole only valid on kind 'subagent'`)
  }

  return {
    componentId,
    kind: kindRaw,
    contentBinding: r['contentBinding'],
    config: r['config'],
    consumes,
    outputs,
    activation,
    permissionRequirements,
    subagentRole
  }
}

function parseActivation(
  raw: unknown,
  componentId: string
): { phase: ActivationPhase; route?: string } {
  if (typeof raw === 'string') {
    if (raw === 'initial' || raw === 'conditional') return { phase: raw }
    fail('MODEL_INVALID', `component ${componentId}: activation must be 'initial'|'conditional'`)
  }
  const r = asRecord(raw, `component ${componentId} activation`)
  const phase = reqString(r, 'phase')
  if (phase !== 'initial' && phase !== 'conditional') {
    fail(
      'MODEL_INVALID',
      `component ${componentId}: activation.phase must be 'initial'|'conditional'`
    )
  }
  const route = optString(r, 'route')
  return route === undefined ? { phase } : { phase, route }
}

export function parseCoverageBinding(raw: unknown): CoverageBindingInput {
  const r = asRecord(raw, 'coverageBinding')
  const clauseId = reqString(r, 'clauseId')
  const componentId = reqString(r, 'componentId')
  const sectionKey = reqString(r, 'sectionKey')
  const realization = reqString(r, 'realization')
  if (realization !== 'verbatim' && realization !== 'reexpressed') {
    fail(
      'MODEL_INVALID',
      `binding ${clauseId}->${componentId}: realization must be verbatim|reexpressed`
    )
  }
  const requiredLoadPhase = reqString(r, 'requiredLoadPhase')
  if (requiredLoadPhase !== 'initial' && requiredLoadPhase !== 'conditional') {
    fail(
      'MODEL_INVALID',
      `binding ${clauseId}->${componentId}: requiredLoadPhase must be initial|conditional`
    )
  }
  return { clauseId, componentId, sectionKey, realization, requiredLoadPhase }
}

export function parseMaintenanceBinding(raw: unknown): MaintenanceBindingInput {
  const r = asRecord(raw, 'maintenanceBinding')
  const bindingId = reqString(r, 'bindingId')
  if (r['basisRef'] === undefined) {
    fail('MODEL_INVALID', `maintenanceBinding ${bindingId}: basisRef required`)
  }
  const componentRef = asRecord(r['componentRef'], `maintenanceBinding ${bindingId} componentRef`)
  const componentId = reqString(componentRef, 'componentId')
  const sectionKey = optString(componentRef, 'sectionKey')
  return {
    bindingId,
    basisRef: r['basisRef'],
    componentRef: sectionKey === undefined ? { componentId } : { componentId, sectionKey }
  }
}

export function parseComponentGraph(raw: unknown): ComponentGraphInput {
  const r = asRecord(raw, 'componentGraph')
  const components = reqArray(r, 'components').map(parseComponent)
  const coverageBindings = optArray(r, 'coverageBindings').map(parseCoverageBinding)
  const maintenanceBindings = optArray(r, 'maintenanceBindings').map(parseMaintenanceBinding)
  const graph: ComponentGraphInput = { components, coverageBindings }
  if (maintenanceBindings.length > 0) graph.maintenanceBindings = maintenanceBindings
  validateComponentGraph(graph)
  return graph
}

/* ------------------------------------------------------------------ *
 * structural validation — malformed graphs are refused, not diagnosed
 * ------------------------------------------------------------------ */

/**
 * spec/contracts/realization.md build rules: the install graph is acyclic,
 * consumes must reference declared components, declared output paths may not
 * collide. These are STRUCTURAL errors — the caller sent a graph that cannot
 * be a RoleImplementation at all, so they fail MODEL_INVALID rather than
 * landing as publishable-candidate diagnostics.
 */
export function validateComponentGraph(graph: ComponentGraphInput): void {
  const ids = new Set<string>()
  for (const c of graph.components) {
    if (ids.has(c.componentId)) {
      fail('MODEL_INVALID', `duplicate componentId ${c.componentId}`)
    }
    ids.add(c.componentId)
  }

  for (const c of graph.components) {
    for (const dep of c.consumes) {
      if (!ids.has(dep)) {
        fail('MODEL_INVALID', `component ${c.componentId} consumes unknown component ${dep}`)
      }
      if (dep === c.componentId) {
        fail('MODEL_INVALID', `component ${c.componentId} consumes itself`)
      }
    }
  }

  // acyclicity over the consumes edges (component -> its dependencies)
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string, stack: string[]): void => {
    const s = state.get(id)
    if (s === 'done') return
    if (s === 'visiting') {
      fail('MODEL_INVALID', `component graph cycle: ${[...stack, id].join(' -> ')}`)
    }
    state.set(id, 'visiting')
    const comp = graph.components.find((c) => c.componentId === id)!
    for (const dep of comp.consumes) visit(dep, [...stack, id])
    state.set(id, 'done')
  }
  for (const c of graph.components) visit(c.componentId, [])

  // output path collisions — two components may not claim the same install path
  const ownerByPath = new Map<string, string>()
  for (const c of graph.components) {
    for (const raw of c.outputs) {
      const path = raw.replace(/^\.\/+/, '').replace(/\/+/g, '/')
      const owner = ownerByPath.get(path)
      if (owner !== undefined && owner !== c.componentId) {
        fail(
          'MODEL_INVALID',
          `output path collision: '${path}' claimed by both ${owner} and ${c.componentId}`
        )
      }
      ownerByPath.set(path, c.componentId)
    }
  }

  // coverage binding endpoints must exist; duplicate (clause,component) refused
  const bindingKeys = new Set<string>()
  for (const b of graph.coverageBindings) {
    if (!ids.has(b.componentId)) {
      fail('MODEL_INVALID', `coverageBinding ${b.clauseId} -> unknown component ${b.componentId}`)
    }
    const key = `${b.clauseId}${b.componentId}`
    if (bindingKeys.has(key)) {
      fail('MODEL_INVALID', `duplicate coverageBinding ${b.clauseId} -> ${b.componentId}`)
    }
    bindingKeys.add(key)
  }
}

/* ------------------------------------------------------------------ *
 * clause coverage — which required meanings the graph actually delivers
 * ------------------------------------------------------------------ */

export type ClauseCoverageStatus = 'covered' | 'conditional-only' | 'uncovered'

export interface ClauseCoverage {
  clauseId: string
  status: ClauseCoverageStatus
  /** bindings that satisfy the clause's initial-delivery requirement */
  satisfyingBindings: CoverageBindingInput[]
  /** every binding that targets the clause, for diagnostics */
  allBindings: CoverageBindingInput[]
  reason?: string
}

export interface CoverageReport {
  clauses: ClauseCoverage[]
  /** clauseIds with no satisfying initial binding — prepare/publish verdict */
  uncoveredClauses: string[]
  /** required clauses bound ONLY through conditional components/routes */
  conditionalOnlyClauses: string[]
  /** bindings whose clauseId is not in the interface at all */
  orphanBindings: CoverageBindingInput[]
}

/**
 * Does one binding satisfy an initial-delivery requirement? Both sides must
 * be initial: the binding's declared requiredLoadPhase AND the bound
 * component's activation phase. A 'confirmed preload' is an initial route —
 * it lives on activation.phase 'initial' with route metadata.
 */
function bindingSatisfiesInitial(b: CoverageBindingInput, comp: ComponentInput): boolean {
  return b.requiredLoadPhase === 'initial' && comp.activation.phase === 'initial'
}

/**
 * Evaluate the graph's coverageBindings against the interface's
 * ContextRequirements. Pure — same inputs, same report.
 */
export function evaluateCoverage(
  requirements: readonly ContextRequirement[],
  graph: ComponentGraphInput
): CoverageReport {
  const compById = new Map(graph.components.map((c) => [c.componentId, c]))
  const reqClauseIds = new Set(requirements.map((r) => r.clauseId))
  const byClause = new Map<string, CoverageBindingInput[]>()
  const orphanBindings: CoverageBindingInput[] = []

  for (const b of graph.coverageBindings) {
    if (!reqClauseIds.has(b.clauseId)) {
      orphanBindings.push(b)
      continue
    }
    const list = byClause.get(b.clauseId) ?? []
    list.push(b)
    byClause.set(b.clauseId, list)
  }

  const clauses: ClauseCoverage[] = []
  const uncoveredClauses: string[] = []
  const conditionalOnlyClauses: string[] = []

  for (const req of requirements) {
    const all = byClause.get(req.clauseId) ?? []
    const satisfying = all.filter((b) => {
      const comp = compById.get(b.componentId)
      return comp !== undefined && bindingSatisfiesInitial(b, comp)
    })

    let status: ClauseCoverageStatus
    let reason: string | undefined
    if (satisfying.length > 0) {
      status = 'covered'
    } else if (all.length > 0) {
      status = 'conditional-only'
      reason =
        'required clause bound only via conditional component or non-initial load phase — ' +
        'existence of a conditional skill never proves required meaning was delivered'
      conditionalOnlyClauses.push(req.clauseId)
    } else {
      status = 'uncovered'
      reason = 'no coverageBinding targets this required clause'
    }
    if (status !== 'covered') uncoveredClauses.push(req.clauseId)
    const entry: ClauseCoverage = {
      clauseId: req.clauseId,
      status,
      satisfyingBindings: satisfying,
      allBindings: all
    }
    if (reason !== undefined) entry.reason = reason
    clauses.push(entry)
  }

  return { clauses, uncoveredClauses, conditionalOnlyClauses, orphanBindings }
}

/* ------------------------------------------------------------------ *
 * row mapping — stored coverage_json shape (per component row)
 * ------------------------------------------------------------------ */

/** bindings grouped under their target component for implementation_components.coverage_json */
export function bindingsByComponent(
  graph: ComponentGraphInput
): Map<string, CoverageBindingInput[]> {
  const m = new Map<string, CoverageBindingInput[]>()
  for (const b of graph.coverageBindings) {
    const list = m.get(b.componentId) ?? []
    list.push(b)
    m.set(b.componentId, list)
  }
  return m
}

/** reconstruct stored component rows back into the graph input shape */
export function componentFromRow(row: {
  id: string
  kind: string
  activation: string
  binding_json: string
  consumes_json: string
  coverage_json: string
}): { component: ComponentInput; bindings: CoverageBindingInput[] } {
  const stored = JSON.parse(row.binding_json) as {
    contentBinding?: unknown
    config?: unknown
    outputs?: string[]
    permissionRequirements?: unknown[]
    subagentRole?: 'primary' | 'helper'
  }
  const activation = JSON.parse(row.activation) as { phase: ActivationPhase; route?: string }
  const component: ComponentInput = {
    componentId: row.id,
    kind: row.kind as ComponentKind,
    consumes: JSON.parse(row.consumes_json) as string[],
    outputs: stored.outputs ?? [],
    activation,
    permissionRequirements: stored.permissionRequirements ?? []
  }
  if (stored.contentBinding !== undefined) component.contentBinding = stored.contentBinding
  if (stored.config !== undefined) component.config = stored.config
  if (stored.subagentRole !== undefined) component.subagentRole = stored.subagentRole
  return { component, bindings: JSON.parse(row.coverage_json) as CoverageBindingInput[] }
}

/** serialize the opaque authored fields of one component into binding_json */
export function componentBindingJson(c: ComponentInput): string {
  const out: Record<string, unknown> = {}
  if (c.contentBinding !== undefined) out.contentBinding = c.contentBinding
  if (c.config !== undefined) out.config = c.config
  if (c.outputs.length > 0) out.outputs = c.outputs
  if (c.permissionRequirements.length > 0) out.permissionRequirements = c.permissionRequirements
  if (c.subagentRole !== undefined) out.subagentRole = c.subagentRole
  return JSON.stringify(out)
}
