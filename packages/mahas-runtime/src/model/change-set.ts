// mahas-runtime/model — TypedModelEdit application and base↔candidate diff.
//
// `model.change.prepare` receives edits:TypedModelEdit[] (C-MODEL / D-RDD §3):
//   goal.revise
//   boundary.create | boundary.revise | boundary.split | boundary.reparent |
//     boundary.retire
//   contract.bind | contract.revise | contract.retire
//   role.define | role.revise | role.retire
//   horizontalRole.revise
//   context.register | context.link | context.unlink
//   nonGoal.revise
//
// Edits apply SEQUENTIALLY in array order onto a clone of the base snapshot —
// deterministic, so commit can re-materialize the identical candidate from
// base+edits and re-verify the digest. An edit that references a missing or
// already-retired target does not abort the candidate: it is recorded as an
// error-severity diagnostic so prepare returns the complete MODEL_INVALID
// picture (commit re-derives the same errors and refuses).
//
// split / reparent / retire are computed as ONE change unit: parent, new
// children, role and contract remap are all part of the same candidate —
// "기존 FK가 끊어질 때는 같은 변경 안에서 detach/remap을 제공해야 한다".

import type { TargetRef } from '../access/authorize.ts'
import type { MahasError } from '../../../mahas-contracts/src/index.ts'
import type { Diagnostic } from './structural-rules.ts'
import {
  cloneSnapshot,
  type ModelSnapshot,
  type SnapshotCriterion,
  type SnapshotPath
} from './repository.ts'

/* ------------------------------------------------------------------ */
/* Edit payload schema (the TypedModelEdit wire shape — proposal for   */
/* IMP-02's ModelChangeEdit; structural field names follow D-RDD §3)   */
/* ------------------------------------------------------------------ */

export interface PathInput {
  path: string
  kind?: 'file' | 'directory'
}

export interface CriterionInput {
  id?: string
  criterion: string
  description: string
}

export interface NewBoundaryInput {
  id: string
  name: string
  responsibility: string
  /** contains parent; omitted = parentless (the single-root rule decides) */
  parentId?: string | null
  paths?: PathInput[]
  criteria?: CriterionInput[]
  contextIds?: string[]
}

export interface BoundaryReviseInput {
  name?: string
  responsibility?: string
  setPaths?: PathInput[]
  addPaths?: PathInput[]
  removePaths?: string[]
  setCriteria?: CriterionInput[]
  addCriteria?: CriterionInput[]
  removeCriterionIds?: string[]
  addContextIds?: string[]
  removeContextIds?: string[]
}

/** where a retired/split boundary's dependents re-anchor in the same change */
export interface BoundaryRemap {
  /** boundary that adopts the retired boundary's roles */
  rolesTo?: string
  /** boundary that becomes provider of the retired boundary's contracts */
  providedContractsTo?: string
  /** boundary that takes over the retired boundary's consumer edges */
  consumedContractsTo?: string
  /** boundary that adopts the retired boundary's non-goals */
  nonGoalsTo?: string
  /** boundary that adopts the retired boundary's context links */
  contextsTo?: string
  /** new parent for the retired boundary's direct children */
  reparentChildrenTo?: string
}

export type ContextLinkTarget =
  { kind: 'boundary'; boundaryId: string } | { kind: 'horizontalRole'; name: string }

export type ModelEdit =
  | { type: 'goal.revise'; goal: string }
  | { type: 'boundary.create'; boundary: NewBoundaryInput }
  | { type: 'boundary.revise'; boundaryId: string; set: BoundaryReviseInput }
  | {
      type: 'boundary.split'
      boundaryId: string
      children: NewBoundaryInput[]
      /** per-role remap to one of the new children (or any boundary) */
      roleRemap?: Record<string, string>
      /** per-contract provider remap */
      contractProviderRemap?: Record<string, string>
      /** per-contract consumer-edge move from the split boundary to a child */
      contractConsumerRemap?: Record<string, string>
      /** per-nonGoal remap */
      nonGoalRemap?: Record<string, string>
      /** context links to move from the split boundary to a child */
      contextRemap?: Record<string, string>
    }
  | { type: 'boundary.reparent'; boundaryId: string; newParentId: string }
  | { type: 'boundary.retire'; boundaryId: string; remap?: BoundaryRemap }
  | {
      type: 'contract.bind'
      contract: {
        id: string
        name: string
        schemaPath: string
        providerBoundaryId: string
        consumerBoundaryIds: string[]
      }
    }
  | {
      type: 'contract.revise'
      contractId: string
      set: {
        name?: string
        schemaPath?: string
        providerBoundaryId?: string
        addConsumerBoundaryIds?: string[]
        removeConsumerBoundaryIds?: string[]
        /** contract ModelChangeEdit full-replace alias */
        consumerBoundaryIds?: string[]
      }
    }
  | { type: 'contract.retire'; contractId: string }
  | {
      type: 'role.define'
      role: {
        id: string
        name: string
        description: string
        boundaryId: string
        horizontalRoleName: string
      }
    }
  | {
      type: 'role.revise'
      roleId: string
      set: {
        name?: string
        description?: string
        boundaryId?: string
        horizontalRoleName?: string
      }
    }
  | { type: 'role.retire'; roleId: string }
  | {
      type: 'horizontalRole.revise'
      name: string
      renameTo?: string
      addContextIds?: string[]
      removeContextIds?: string[]
    }
  | { type: 'context.register'; context: { id: string; path: string } }
  | { type: 'context.link'; contextId: string; target: ContextLinkTarget }
  | { type: 'context.unlink'; contextId: string; target: ContextLinkTarget }
  | {
      type: 'nonGoal.revise'
      nonGoal: { id: string; boundaryId?: string; statement?: string; remove?: boolean }
    }

/* ------------------------------------------------------------------ */
/* Payload normalization — strict shape validation of `unknown` input  */
/* ------------------------------------------------------------------ */

export function mahasError(
  code: MahasError['code'],
  message: string,
  retry: MahasError['retry'] = 'none',
  details?: unknown
): Error & MahasError {
  return Object.assign(new Error(message), { code, retry, details })
}

type Obj = Record<string, unknown>

export const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

export function bad(message: string, details?: unknown): never {
  throw mahasError('MODEL_INVALID', message, 'none', details)
}

export function reqStr(o: Obj, field: string): string {
  const v = o[field]
  if (typeof v !== 'string' || v.length === 0) bad(`missing required string field "${field}"`, o)
  return v
}

export function optStr(o: Obj, field: string): string | undefined {
  const v = o[field]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') bad(`field "${field}" must be a string`, o)
  return v
}

export function reqObj(o: Obj, field: string): Obj {
  const v = o[field]
  if (!isObj(v)) bad(`missing required object field "${field}"`, o)
  return v
}

export function optObj(o: Obj, field: string): Obj | undefined {
  const v = o[field]
  if (v === undefined || v === null) return undefined
  if (!isObj(v)) bad(`field "${field}" must be an object`, o)
  return v
}

export function strArr(o: Obj, field: string): string[] | undefined {
  const v = o[field]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    bad(`field "${field}" must be a string array`, o)
  }
  return v as string[]
}

function strMap(o: Obj, field: string): Record<string, string> | undefined {
  const v = o[field]
  if (v === undefined || v === null) return undefined
  if (!isObj(v) || Object.values(v).some((x) => typeof x !== 'string')) {
    bad(`field "${field}" must be an object of string→string`, o)
  }
  return v as Record<string, string>
}

function pathInputs(v: unknown, field: string): PathInput[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) bad(`field "${field}" must be an array of {path,kind?}`)
  return v.map((e): PathInput => {
    if (!isObj(e)) bad(`field "${field}" entries must be objects`, e)
    const kind = optStr(e, 'kind')
    if (kind !== undefined && kind !== 'file' && kind !== 'directory') {
      bad(`path kind must be "file" or "directory"`, e)
    }
    return { path: reqStr(e, 'path'), kind: kind as PathInput['kind'] }
  })
}

function criterionInputs(v: unknown, field: string): CriterionInput[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) bad(`field "${field}" must be an array of {criterion,description}`)
  return v.map((e): CriterionInput => {
    if (!isObj(e)) bad(`field "${field}" entries must be objects`, e)
    return {
      id: optStr(e, 'id'),
      criterion: reqStr(e, 'criterion'),
      description: reqStr(e, 'description')
    }
  })
}

function newBoundary(v: unknown): NewBoundaryInput {
  if (!isObj(v)) bad('boundary spec must be an object', v)
  const parentRaw = v.parentId ?? v.parentBoundaryId
  const parentId = parentRaw === undefined ? undefined : (parentRaw as string | null)
  if (parentId !== undefined && parentId !== null && typeof parentId !== 'string') {
    bad('parentId must be a string or null', v)
  }
  const id = optStr(v, 'id') ?? reqStr(v, 'boundaryId')
  const responsibility = optStr(v, 'responsibility') ?? reqStr(v, 'responsibilityStatement')
  return {
    id,
    name: reqStr(v, 'name'),
    responsibility,
    parentId: parentId ?? undefined,
    paths: pathInputs(v.paths, 'paths'),
    criteria: criterionInputs(v.criteria, 'criteria'),
    contextIds: strArr(v, 'contextIds')
  }
}

function contextTarget(v: unknown): ContextLinkTarget {
  if (!isObj(v)) bad('context link target must be an object', v)
  const kind = reqStr(v, 'kind')
  if (kind === 'boundary') return { kind: 'boundary', boundaryId: reqStr(v, 'boundaryId') }
  if (kind === 'horizontalRole')
    return { kind: 'horizontalRole', name: optStr(v, 'name') ?? reqStr(v, 'horizontalRoleName') }
  bad(`context link target kind must be "boundary" or "horizontalRole"`, v)
}

/** contract ModelChangeEdit is flat (boundaryId / horizontalRoleName); runtime uses `target` */
function contextLinkTarget(e: Obj): ContextLinkTarget {
  if (e.target !== undefined) return contextTarget(e.target)
  if (typeof e.boundaryId === 'string' && e.boundaryId.length > 0) {
    return { kind: 'boundary', boundaryId: e.boundaryId }
  }
  const hr = optStr(e, 'horizontalRoleName') ?? optStr(e, 'name')
  if (hr) return { kind: 'horizontalRole', name: hr }
  bad('context link needs target, boundaryId, or horizontalRoleName', e)
}

const EDIT_TYPES = [
  'goal.revise',
  'boundary.create',
  'boundary.revise',
  'boundary.split',
  'boundary.reparent',
  'boundary.retire',
  'contract.bind',
  'contract.revise',
  'contract.retire',
  'role.define',
  'role.revise',
  'role.retire',
  'horizontalRole.revise',
  'context.register',
  'context.link',
  'context.unlink',
  'nonGoal.revise'
] as const

export function normalizeEdits(raw: unknown): ModelEdit[] {
  if (!Array.isArray(raw)) bad('edits must be an array of TypedModelEdit objects')
  return raw.map((e, i): ModelEdit => {
    if (!isObj(e)) bad(`edit[${i}] must be an object`)
    const type = reqStr(e, 'type') as (typeof EDIT_TYPES)[number]
    if (!EDIT_TYPES.includes(type)) {
      bad(`edit[${i}].type "${type}" is not a TypedModelEdit kind`, { allowed: EDIT_TYPES })
    }
    return normalizeEdit(type, e, i)
  })
}

function normalizeEdit(type: ModelEdit['type'], e: Obj, i: number): ModelEdit {
  switch (type) {
    case 'goal.revise':
      return { type, goal: reqStr(e, 'goal') }
    case 'boundary.create':
      return { type, boundary: newBoundary(isObj(e.boundary) ? e.boundary : e) }
    case 'boundary.revise': {
      const set = optObj(e, 'set') ?? e
      return {
        type,
        boundaryId: reqStr(e, 'boundaryId'),
        set: {
          name: optStr(set, 'name'),
          responsibility: optStr(set, 'responsibility') ?? optStr(set, 'responsibilityStatement'),
          setPaths: pathInputs(set.setPaths ?? set.paths, 'paths'),
          addPaths: pathInputs(set.addPaths, 'addPaths'),
          removePaths: strArr(set, 'removePaths'),
          setCriteria: criterionInputs(set.setCriteria ?? set.criteria, 'criteria'),
          addCriteria: criterionInputs(set.addCriteria, 'addCriteria'),
          removeCriterionIds: strArr(set, 'removeCriterionIds'),
          addContextIds: strArr(set, 'addContextIds'),
          removeContextIds: strArr(set, 'removeContextIds')
        }
      }
    }
    case 'boundary.split': {
      const rawChildren = e.children
      if (!Array.isArray(rawChildren) || rawChildren.length === 0) {
        bad(`edit[${i}] boundary.split requires a non-empty children array`)
      }
      return {
        type,
        boundaryId: reqStr(e, 'boundaryId'),
        children: rawChildren.map(newBoundary),
        roleRemap: strMap(e, 'roleRemap'),
        contractProviderRemap: strMap(e, 'contractProviderRemap') ?? strMap(e, 'contractRemap'),
        contractConsumerRemap: strMap(e, 'contractConsumerRemap'),
        nonGoalRemap: strMap(e, 'nonGoalRemap'),
        contextRemap: strMap(e, 'contextRemap')
      }
    }
    case 'boundary.reparent':
      return {
        type,
        boundaryId: reqStr(e, 'boundaryId'),
        newParentId: optStr(e, 'newParentId') ?? reqStr(e, 'newParentBoundaryId')
      }
    case 'boundary.retire': {
      const remap = optObj(e, 'remap')
      return {
        type,
        boundaryId: reqStr(e, 'boundaryId'),
        remap: remap
          ? {
              rolesTo: optStr(remap, 'rolesTo'),
              providedContractsTo: optStr(remap, 'providedContractsTo'),
              consumedContractsTo: optStr(remap, 'consumedContractsTo'),
              nonGoalsTo: optStr(remap, 'nonGoalsTo'),
              contextsTo: optStr(remap, 'contextsTo'),
              reparentChildrenTo: optStr(remap, 'reparentChildrenTo')
            }
          : undefined
      }
    }
    case 'contract.bind': {
      const c = isObj(e.contract) ? e.contract : e
      return {
        type,
        contract: {
          id: optStr(c, 'id') ?? reqStr(c, 'contractId'),
          name: reqStr(c, 'name'),
          schemaPath: reqStr(c, 'schemaPath'),
          providerBoundaryId: reqStr(c, 'providerBoundaryId'),
          consumerBoundaryIds:
            strArr(c, 'consumerBoundaryIds') ?? bad('contract.consumerBoundaryIds required')
        }
      }
    }
    case 'contract.revise': {
      const set = optObj(e, 'set') ?? e
      return {
        type,
        contractId: reqStr(e, 'contractId'),
        set: {
          name: optStr(set, 'name'),
          schemaPath: optStr(set, 'schemaPath'),
          providerBoundaryId: optStr(set, 'providerBoundaryId'),
          addConsumerBoundaryIds: strArr(set, 'addConsumerBoundaryIds'),
          removeConsumerBoundaryIds: strArr(set, 'removeConsumerBoundaryIds'),
          consumerBoundaryIds: strArr(set, 'consumerBoundaryIds')
        }
      }
    }
    case 'contract.retire':
      return { type, contractId: reqStr(e, 'contractId') }
    case 'role.define': {
      const r = isObj(e.role) ? e.role : e
      return {
        type,
        role: {
          id: optStr(r, 'id') ?? reqStr(r, 'roleId'),
          name: reqStr(r, 'name'),
          description: reqStr(r, 'description'),
          boundaryId: reqStr(r, 'boundaryId'),
          horizontalRoleName: reqStr(r, 'horizontalRoleName')
        }
      }
    }
    case 'role.revise': {
      const set = optObj(e, 'set') ?? e
      return {
        type,
        roleId: reqStr(e, 'roleId'),
        set: {
          name: optStr(set, 'name'),
          description: optStr(set, 'description'),
          boundaryId: optStr(set, 'boundaryId'),
          horizontalRoleName: optStr(set, 'horizontalRoleName')
        }
      }
    }
    case 'role.retire':
      return { type, roleId: reqStr(e, 'roleId') }
    case 'horizontalRole.revise':
      return {
        type,
        name: optStr(e, 'name') ?? reqStr(e, 'horizontalRoleName'),
        renameTo: optStr(e, 'renameTo'),
        addContextIds: strArr(e, 'addContextIds'),
        removeContextIds: strArr(e, 'removeContextIds')
      }
    case 'context.register': {
      const c = isObj(e.context) ? e.context : e
      return {
        type,
        context: { id: optStr(c, 'id') ?? reqStr(c, 'contextId'), path: reqStr(c, 'path') }
      }
    }
    case 'context.link':
      return { type, contextId: reqStr(e, 'contextId'), target: contextLinkTarget(e) }
    case 'context.unlink':
      return { type, contextId: reqStr(e, 'contextId'), target: contextLinkTarget(e) }
    case 'nonGoal.revise': {
      const n = isObj(e.nonGoal) ? e.nonGoal : e
      return {
        type,
        nonGoal: {
          id: optStr(n, 'id') ?? reqStr(n, 'nonGoalId'),
          boundaryId: optStr(n, 'boundaryId'),
          statement: optStr(n, 'statement'),
          remove: typeof n.remove === 'boolean' ? n.remove : undefined
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Edit application — sequential, deterministic, diagnostics not throws */
/* ------------------------------------------------------------------ */

export interface ApplyResult {
  snapshot: ModelSnapshot
  /** error-severity diagnostics for edits whose targets did not resolve */
  diagnostics: Diagnostic[]
}

const editErr = (code: string, message: string, target?: TargetRef): Diagnostic => ({
  severity: 'error',
  code,
  message,
  target
})

export function applyEdits(base: ModelSnapshot, edits: ModelEdit[]): ApplyResult {
  const s = cloneSnapshot(base)
  const diagnostics: Diagnostic[] = []
  for (const e of edits) applyOne(s, e, diagnostics)
  return { snapshot: s, diagnostics }
}

function toPaths(input: PathInput[] | undefined): SnapshotPath[] {
  return (input ?? []).map((p) => ({ path: p.path, kind: p.kind ?? 'directory' }))
}

function toCriteria(input: CriterionInput[] | undefined): SnapshotCriterion[] {
  return (input ?? []).map((c, i) => ({
    id: c.id ?? `crit_${i + 1}`,
    criterion: c.criterion,
    description: c.description,
    ordinal: i + 1
  }))
}

function applyOne(s: ModelSnapshot, e: ModelEdit, d: Diagnostic[]): void {
  switch (e.type) {
    case 'goal.revise': {
      s.goal = e.goal
      return
    }
    case 'boundary.create': {
      if (s.boundaries.has(e.boundary.id)) {
        d.push(
          editErr('DUPLICATE_BOUNDARY', `boundary.create id "${e.boundary.id}" already exists`, {
            kind: 'boundary',
            id: e.boundary.id
          })
        )
        return
      }
      s.boundaries.set(e.boundary.id, {
        id: e.boundary.id,
        name: e.boundary.name,
        responsibilityStatement: e.boundary.responsibility,
        parentId: e.boundary.parentId ?? null,
        paths: toPaths(e.boundary.paths),
        criteria: toCriteria(e.boundary.criteria),
        contextIds: [...(e.boundary.contextIds ?? [])]
      })
      return
    }
    case 'boundary.revise': {
      const b = s.boundaries.get(e.boundaryId)
      if (!b) {
        d.push(missing('boundary', e.boundaryId, 'boundary.revise'))
        return
      }
      const set = e.set
      if (set.name !== undefined) b.name = set.name
      if (set.responsibility !== undefined) b.responsibilityStatement = set.responsibility
      if (set.setPaths !== undefined) b.paths = toPaths(set.setPaths)
      if (set.addPaths !== undefined) {
        const have = new Set(b.paths.map((p) => p.path))
        for (const p of toPaths(set.addPaths)) if (!have.has(p.path)) b.paths.push(p)
      }
      if (set.removePaths !== undefined) {
        const drop = new Set(set.removePaths)
        b.paths = b.paths.filter((p) => !drop.has(p.path))
      }
      if (set.setCriteria !== undefined) b.criteria = toCriteria(set.setCriteria)
      if (set.addCriteria !== undefined) {
        let ord = b.criteria.reduce((m, c) => Math.max(m, c.ordinal), 0)
        for (const c of set.addCriteria)
          b.criteria.push({ ...c, id: c.id ?? `crit_${ord + 1}`, ordinal: ++ord })
      }
      if (set.removeCriterionIds !== undefined) {
        const drop = new Set(set.removeCriterionIds)
        b.criteria = b.criteria.filter((c) => !drop.has(c.id))
      }
      if (set.addContextIds !== undefined) {
        for (const cx of set.addContextIds) if (!b.contextIds.includes(cx)) b.contextIds.push(cx)
      }
      if (set.removeContextIds !== undefined) {
        const drop = new Set(set.removeContextIds)
        b.contextIds = b.contextIds.filter((x) => !drop.has(x))
      }
      return
    }
    case 'boundary.split': {
      const parent = s.boundaries.get(e.boundaryId)
      if (!parent) {
        d.push(missing('boundary', e.boundaryId, 'boundary.split'))
        return
      }
      // carve out children under the split boundary (it keeps its own
      // responsibility + the coordination duty — D-RDD §3)
      for (const child of e.children) {
        if (s.boundaries.has(child.id)) {
          d.push(
            editErr('DUPLICATE_BOUNDARY', `boundary.split child id "${child.id}" already exists`, {
              kind: 'boundary',
              id: child.id
            })
          )
          continue
        }
        s.boundaries.set(child.id, {
          id: child.id,
          name: child.name,
          responsibilityStatement: child.responsibility,
          parentId: child.parentId ?? parent.id,
          paths: toPaths(child.paths),
          criteria: toCriteria(child.criteria),
          contextIds: [...(child.contextIds ?? [])]
        })
      }
      // explicit remaps — all part of the same change unit
      for (const [roleId, toBoundary] of Object.entries(e.roleRemap ?? {})) {
        const role = s.roles.get(roleId)
        if (!role) d.push(missing('role', roleId, 'boundary.split roleRemap'))
        else if (role.boundaryId !== parent.id)
          d.push(
            editErr(
              'REMAP_SOURCE_MISMATCH',
              `roleRemap: role "${roleId}" is not on split boundary "${parent.id}"`,
              { kind: 'role', id: roleId }
            )
          )
        else role.boundaryId = toBoundary
      }
      for (const [contractId, toBoundary] of Object.entries(e.contractProviderRemap ?? {})) {
        const c = s.contracts.get(contractId)
        if (!c) d.push(missing('contract', contractId, 'boundary.split contractProviderRemap'))
        else if (c.providerBoundaryId !== parent.id)
          d.push(
            editErr(
              'REMAP_SOURCE_MISMATCH',
              `contractProviderRemap: contract "${contractId}" is not provided by "${parent.id}"`,
              { kind: 'contract', id: contractId }
            )
          )
        else c.providerBoundaryId = toBoundary
      }
      for (const [contractId, toBoundary] of Object.entries(e.contractConsumerRemap ?? {})) {
        const c = s.contracts.get(contractId)
        if (!c) d.push(missing('contract', contractId, 'boundary.split contractConsumerRemap'))
        else {
          const idx = c.consumerBoundaryIds.indexOf(parent.id)
          if (idx === -1)
            d.push(
              editErr(
                'REMAP_SOURCE_MISMATCH',
                `contractConsumerRemap: "${parent.id}" is not a consumer of contract "${contractId}"`,
                { kind: 'contract', id: contractId }
              )
            )
          else c.consumerBoundaryIds[idx] = toBoundary
        }
      }
      for (const [nonGoalId, toBoundary] of Object.entries(e.nonGoalRemap ?? {})) {
        const n = s.nonGoals.get(nonGoalId)
        if (!n) d.push(missing('non-goal', nonGoalId, 'boundary.split nonGoalRemap'))
        else if (n.boundaryId !== parent.id)
          d.push(
            editErr(
              'REMAP_SOURCE_MISMATCH',
              `nonGoalRemap: non-goal "${nonGoalId}" is not on split boundary "${parent.id}"`,
              { kind: 'non-goal', id: nonGoalId }
            )
          )
        else n.boundaryId = toBoundary
      }
      for (const [contextId, toBoundary] of Object.entries(e.contextRemap ?? {})) {
        const idx = parent.contextIds.indexOf(contextId)
        if (idx === -1)
          d.push(
            editErr(
              'REMAP_SOURCE_MISMATCH',
              `contextRemap: context "${contextId}" is not linked to "${parent.id}"`,
              { kind: 'context', id: contextId }
            )
          )
        else {
          parent.contextIds.splice(idx, 1)
          const to = s.boundaries.get(toBoundary)
          if (to && !to.contextIds.includes(contextId)) to.contextIds.push(contextId)
        }
      }
      return
    }
    case 'boundary.reparent': {
      const b = s.boundaries.get(e.boundaryId)
      if (!b) {
        d.push(missing('boundary', e.boundaryId, 'boundary.reparent'))
        return
      }
      b.parentId = e.newParentId
      return
    }
    case 'boundary.retire': {
      const b = s.boundaries.get(e.boundaryId)
      if (!b) {
        d.push(missing('boundary', e.boundaryId, 'boundary.retire'))
        return
      }
      const remap = e.remap ?? {}
      // dependents must be detached/remapped inside the same change unit —
      // anything left pointing at the removed boundary is reported by the
      // structural FK checks as a dangling reference
      for (const role of s.roles.values()) {
        if (role.boundaryId === b.id && remap.rolesTo !== undefined) role.boundaryId = remap.rolesTo
      }
      for (const c of s.contracts.values()) {
        if (c.providerBoundaryId === b.id && remap.providedContractsTo !== undefined) {
          c.providerBoundaryId = remap.providedContractsTo
        }
        if (remap.consumedContractsTo !== undefined) {
          c.consumerBoundaryIds = c.consumerBoundaryIds.map((x) =>
            x === b.id ? remap.consumedContractsTo! : x
          )
        }
      }
      for (const n of s.nonGoals.values()) {
        if (n.boundaryId === b.id && remap.nonGoalsTo !== undefined) n.boundaryId = remap.nonGoalsTo
      }
      if (remap.contextsTo !== undefined) {
        const to = s.boundaries.get(remap.contextsTo)
        if (to) {
          for (const cx of b.contextIds) if (!to.contextIds.includes(cx)) to.contextIds.push(cx)
        }
      }
      if (remap.reparentChildrenTo !== undefined) {
        for (const child of s.boundaries.values()) {
          if (child.parentId === b.id) child.parentId = remap.reparentChildrenTo
        }
      }
      s.boundaries.delete(b.id)
      return
    }
    case 'contract.bind': {
      if (s.contracts.has(e.contract.id)) {
        d.push(
          editErr('DUPLICATE_CONTRACT', `contract.bind id "${e.contract.id}" already exists`, {
            kind: 'contract',
            id: e.contract.id
          })
        )
        return
      }
      s.contracts.set(e.contract.id, {
        id: e.contract.id,
        name: e.contract.name,
        schemaPath: e.contract.schemaPath,
        providerBoundaryId: e.contract.providerBoundaryId,
        consumerBoundaryIds: [...e.contract.consumerBoundaryIds]
      })
      return
    }
    case 'contract.revise': {
      const c = s.contracts.get(e.contractId)
      if (!c) {
        d.push(missing('contract', e.contractId, 'contract.revise'))
        return
      }
      const set = e.set
      if (set.name !== undefined) c.name = set.name
      if (set.schemaPath !== undefined) c.schemaPath = set.schemaPath
      if (set.providerBoundaryId !== undefined) c.providerBoundaryId = set.providerBoundaryId
      if (set.consumerBoundaryIds !== undefined) {
        c.consumerBoundaryIds = [...set.consumerBoundaryIds]
      }
      if (set.addConsumerBoundaryIds !== undefined) {
        for (const x of set.addConsumerBoundaryIds)
          if (!c.consumerBoundaryIds.includes(x)) c.consumerBoundaryIds.push(x)
      }
      if (set.removeConsumerBoundaryIds !== undefined) {
        const drop = new Set(set.removeConsumerBoundaryIds)
        c.consumerBoundaryIds = c.consumerBoundaryIds.filter((x) => !drop.has(x))
      }
      return
    }
    case 'contract.retire': {
      if (!s.contracts.delete(e.contractId)) {
        d.push(missing('contract', e.contractId, 'contract.retire'))
      }
      return
    }
    case 'role.define': {
      if (s.roles.has(e.role.id)) {
        d.push(
          editErr('DUPLICATE_ROLE', `role.define id "${e.role.id}" already exists`, {
            kind: 'role',
            id: e.role.id
          })
        )
        return
      }
      s.roles.set(e.role.id, {
        id: e.role.id,
        name: e.role.name,
        description: e.role.description,
        boundaryId: e.role.boundaryId,
        horizontalRoleName: e.role.horizontalRoleName
      })
      return
    }
    case 'role.revise': {
      const r = s.roles.get(e.roleId)
      if (!r) {
        d.push(missing('role', e.roleId, 'role.revise'))
        return
      }
      const set = e.set
      if (set.name !== undefined) r.name = set.name
      if (set.description !== undefined) r.description = set.description
      if (set.boundaryId !== undefined) r.boundaryId = set.boundaryId
      if (set.horizontalRoleName !== undefined) r.horizontalRoleName = set.horizontalRoleName
      return
    }
    case 'role.retire': {
      if (!s.roles.delete(e.roleId)) d.push(missing('role', e.roleId, 'role.retire'))
      return
    }
    case 'horizontalRole.revise': {
      const existing = s.horizontalRoles.get(e.name)
      const h = existing ?? { name: e.name, contextIds: [] as string[] }
      if (!existing) s.horizontalRoles.set(e.name, h)
      if (e.renameTo !== undefined && e.renameTo !== e.name) {
        if (s.horizontalRoles.has(e.renameTo)) {
          d.push(
            editErr(
              'DUPLICATE_HORIZONTAL_ROLE',
              `horizontalRole.revise rename target "${e.renameTo}" already exists`,
              { kind: 'horizontal-role', id: e.renameTo }
            )
          )
        } else {
          s.horizontalRoles.delete(e.name)
          h.name = e.renameTo
          s.horizontalRoles.set(e.renameTo, h)
          for (const r of s.roles.values()) {
            if (r.horizontalRoleName === e.name) r.horizontalRoleName = e.renameTo
          }
        }
      }
      if (e.addContextIds !== undefined) {
        for (const cx of e.addContextIds) if (!h.contextIds.includes(cx)) h.contextIds.push(cx)
      }
      if (e.removeContextIds !== undefined) {
        const drop = new Set(e.removeContextIds)
        h.contextIds = h.contextIds.filter((x) => !drop.has(x))
      }
      return
    }
    case 'context.register': {
      if (s.contexts.has(e.context.id)) {
        d.push(
          editErr('DUPLICATE_CONTEXT', `context.register id "${e.context.id}" already exists`, {
            kind: 'context',
            id: e.context.id
          })
        )
        return
      }
      s.contexts.set(e.context.id, { id: e.context.id, path: e.context.path })
      return
    }
    case 'context.link': {
      linkContext(s, e.contextId, e.target, true, d)
      return
    }
    case 'context.unlink': {
      linkContext(s, e.contextId, e.target, false, d)
      return
    }
    case 'nonGoal.revise': {
      const n = e.nonGoal
      if (n.remove === true) {
        if (!s.nonGoals.delete(n.id)) d.push(missing('non-goal', n.id, 'nonGoal.revise remove'))
        return
      }
      const existing = s.nonGoals.get(n.id)
      if (existing) {
        if (n.boundaryId !== undefined) existing.boundaryId = n.boundaryId
        if (n.statement !== undefined) existing.statement = n.statement
      } else {
        if (n.boundaryId === undefined || n.statement === undefined) {
          d.push(
            editErr(
              'INCOMPLETE_NON_GOAL',
              `nonGoal.revise create for "${n.id}" needs boundaryId and statement`,
              { kind: 'non-goal', id: n.id }
            )
          )
          return
        }
        s.nonGoals.set(n.id, { id: n.id, boundaryId: n.boundaryId, statement: n.statement })
      }
      return
    }
  }
}

function linkContext(
  s: ModelSnapshot,
  contextId: string,
  target: ContextLinkTarget,
  add: boolean,
  d: Diagnostic[]
): void {
  const list = (ids: string[]): string[] =>
    add ? (ids.includes(contextId) ? ids : [...ids, contextId]) : ids.filter((x) => x !== contextId)
  if (target.kind === 'boundary') {
    const b = s.boundaries.get(target.boundaryId)
    if (!b) {
      d.push(missing('boundary', target.boundaryId, 'context.link'))
      return
    }
    b.contextIds = list(b.contextIds)
  } else {
    const h = s.horizontalRoles.get(target.name)
    if (!h) {
      d.push(missing('horizontal-role', target.name, 'context.link'))
      return
    }
    h.contextIds = list(h.contextIds)
  }
}

const missing = (kind: string, id: string, edit: string): Diagnostic =>
  editErr('EDIT_TARGET_MISSING', `${edit}: ${kind} "${id}" does not exist in the candidate`, {
    kind,
    id
  })

/* ------------------------------------------------------------------ */
/* base ↔ candidate diff → actual touchedTargets for the access check   */
/* and impact-candidate generation at publish                          */
/* ------------------------------------------------------------------ */

export interface BoundaryDiff {
  id: string
  changes: ('name' | 'responsibility' | 'paths' | 'criteria' | 'parent' | 'contexts')[]
  beforeParentId: string | null
  afterParentId: string | null
}

export interface ContractDiff {
  id: string
  changes: ('name' | 'schemaPath' | 'provider' | 'consumers')[]
}

export interface RoleDiff {
  id: string
  changes: ('name' | 'description' | 'boundary' | 'horizontalRole')[]
}

export interface SnapshotDiff {
  goalChanged: boolean
  addedBoundaries: string[]
  removedBoundaries: string[]
  changedBoundaries: BoundaryDiff[]
  movedSubtrees: {
    boundaryId: string
    oldParentId: string
    newParentId: string
    descendants: string[]
  }[]
  addedContracts: string[]
  removedContracts: string[]
  changedContracts: ContractDiff[]
  addedRoles: string[]
  removedRoles: string[]
  changedRoles: RoleDiff[]
  addedHorizontalRoles: string[]
  removedHorizontalRoles: string[]
  changedHorizontalRoles: { name: string; changes: 'contexts'[] }[]
  addedContexts: string[]
  removedContexts: string[]
  addedNonGoals: string[]
  removedNonGoals: string[]
  changedNonGoals: { id: string; changes: ('boundary' | 'statement')[] }[]
}

function samePaths(a: SnapshotPath[], b: SnapshotPath[]): boolean {
  if (a.length !== b.length) return false
  const key = (p: SnapshotPath): string => `${p.kind}:${p.path}`
  const sa = a.map(key).sort()
  const sb = b.map(key).sort()
  return sa.every((x, i) => x === sb[i])
}

function sameCriteria(a: SnapshotCriterion[], b: SnapshotCriterion[]): boolean {
  if (a.length !== b.length) return false
  const key = (c: SnapshotCriterion): string =>
    `${c.id}:${c.criterion}:${c.description}:${c.ordinal}`
  const sa = a.map(key).sort()
  const sb = b.map(key).sort()
  return sa.every((x, i) => x === sb[i])
}

function sameStrings(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((x, i) => x === sb[i])
}

export function diffSnapshots(base: ModelSnapshot, cand: ModelSnapshot): SnapshotDiff {
  const diff: SnapshotDiff = {
    goalChanged: base.goal !== cand.goal,
    addedBoundaries: [],
    removedBoundaries: [],
    changedBoundaries: [],
    movedSubtrees: [],
    addedContracts: [],
    removedContracts: [],
    changedContracts: [],
    addedRoles: [],
    removedRoles: [],
    changedRoles: [],
    addedHorizontalRoles: [],
    removedHorizontalRoles: [],
    changedHorizontalRoles: [],
    addedContexts: [],
    removedContexts: [],
    addedNonGoals: [],
    removedNonGoals: [],
    changedNonGoals: []
  }

  for (const [id, b] of base.boundaries) {
    const after = cand.boundaries.get(id)
    if (!after) {
      diff.removedBoundaries.push(id)
      continue
    }
    const changes: BoundaryDiff['changes'] = []
    if (b.name !== after.name) changes.push('name')
    if (b.responsibilityStatement !== after.responsibilityStatement) changes.push('responsibility')
    if (!samePaths(b.paths, after.paths)) changes.push('paths')
    if (!sameCriteria(b.criteria, after.criteria)) changes.push('criteria')
    if (b.parentId !== after.parentId) changes.push('parent')
    if (!sameStrings(b.contextIds, after.contextIds)) changes.push('contexts')
    if (changes.length > 0) {
      diff.changedBoundaries.push({
        id,
        changes,
        beforeParentId: b.parentId,
        afterParentId: after.parentId
      })
    }
  }
  for (const id of cand.boundaries.keys()) {
    if (!base.boundaries.has(id)) diff.addedBoundaries.push(id)
  }

  const descendantsOf = (s: ModelSnapshot, root: string): string[] => {
    // F-012: visited set — a cyclic parent map must not loop forever
    // pushing ids (RangeError escape). Cycle members are skipped here;
    // validateCandidate already reports CONTAINS_CYCLE for the refusal.
    const out: string[] = []
    const seen = new Set<string>([root])
    const queue = [root]
    while (queue.length > 0) {
      const cur = queue.shift()!
      for (const b of s.boundaries.values()) {
        if (b.parentId === cur && !seen.has(b.id)) {
          seen.add(b.id)
          out.push(b.id)
          queue.push(b.id)
        }
      }
    }
    return out
  }
  for (const cb of diff.changedBoundaries) {
    if (cb.changes.includes('parent') && cb.beforeParentId !== cb.afterParentId) {
      diff.movedSubtrees.push({
        boundaryId: cb.id,
        oldParentId: cb.beforeParentId ?? '(root)',
        newParentId: cb.afterParentId ?? '(root)',
        descendants: descendantsOf(cand, cb.id)
      })
    }
  }

  for (const [id, c] of base.contracts) {
    const after = cand.contracts.get(id)
    if (!after) {
      diff.removedContracts.push(id)
      continue
    }
    const changes: ContractDiff['changes'] = []
    if (c.name !== after.name) changes.push('name')
    if (c.schemaPath !== after.schemaPath) changes.push('schemaPath')
    if (c.providerBoundaryId !== after.providerBoundaryId) changes.push('provider')
    if (!sameStrings(c.consumerBoundaryIds, after.consumerBoundaryIds)) changes.push('consumers')
    if (changes.length > 0) diff.changedContracts.push({ id, changes })
  }
  for (const id of cand.contracts.keys()) {
    if (!base.contracts.has(id)) diff.addedContracts.push(id)
  }

  for (const [id, r] of base.roles) {
    const after = cand.roles.get(id)
    if (!after) {
      diff.removedRoles.push(id)
      continue
    }
    const changes: RoleDiff['changes'] = []
    if (r.name !== after.name) changes.push('name')
    if (r.description !== after.description) changes.push('description')
    if (r.boundaryId !== after.boundaryId) changes.push('boundary')
    if (r.horizontalRoleName !== after.horizontalRoleName) changes.push('horizontalRole')
    if (changes.length > 0) diff.changedRoles.push({ id, changes })
  }
  for (const id of cand.roles.keys()) {
    if (!base.roles.has(id)) diff.addedRoles.push(id)
  }

  for (const [name, h] of base.horizontalRoles) {
    const after = cand.horizontalRoles.get(name)
    if (!after) {
      diff.removedHorizontalRoles.push(name)
      continue
    }
    if (!sameStrings(h.contextIds, after.contextIds)) {
      diff.changedHorizontalRoles.push({ name, changes: ['contexts'] })
    }
  }
  for (const name of cand.horizontalRoles.keys()) {
    if (!base.horizontalRoles.has(name)) diff.addedHorizontalRoles.push(name)
  }

  for (const [id, c] of base.contexts) {
    const after = cand.contexts.get(id)
    if (!after) diff.removedContexts.push(id)
    else if (after.path !== c.path) {
      diff.removedContexts.push(id)
      diff.addedContexts.push(id)
    }
  }
  for (const id of cand.contexts.keys()) {
    if (!base.contexts.has(id)) diff.addedContexts.push(id)
  }

  for (const [id, n] of base.nonGoals) {
    const after = cand.nonGoals.get(id)
    if (!after) {
      diff.removedNonGoals.push(id)
      continue
    }
    const changes: ('boundary' | 'statement')[] = []
    if (n.boundaryId !== after.boundaryId) changes.push('boundary')
    if (n.statement !== after.statement) changes.push('statement')
    if (changes.length > 0) diff.changedNonGoals.push({ id, changes })
  }
  for (const id of cand.nonGoals.keys()) {
    if (!base.nonGoals.has(id)) diff.addedNonGoals.push(id)
  }

  return diff
}

/**
 * The ACTUAL target set handed to the access resolver (IMP-10 decide) —
 * computed from the real before/after diff, never from the request's claims.
 * reparent contributes both the old and the new parent plus the whole moved
 * subtree (D-RDD §3, instruction §4.4).
 */
export function touchedTargetsFromDiff(
  projectId: string,
  baseVersion: string,
  diff: SnapshotDiff
): TargetRef[] {
  const set = new Map<string, TargetRef>()
  const add = (kind: string, id: string): void => {
    set.set(`${kind}:${id}`, { kind, id })
  }
  add('project', projectId)
  add('model-version', baseVersion)
  for (const id of diff.addedBoundaries) add('boundary', id)
  for (const id of diff.removedBoundaries) add('boundary', id)
  for (const cb of diff.changedBoundaries) {
    add('boundary', cb.id)
    if (cb.beforeParentId !== null) add('boundary', cb.beforeParentId)
    if (cb.afterParentId !== null) add('boundary', cb.afterParentId)
  }
  for (const m of diff.movedSubtrees) {
    if (m.oldParentId !== '(root)') add('boundary', m.oldParentId)
    if (m.newParentId !== '(root)') add('boundary', m.newParentId)
    for (const d of m.descendants) add('boundary', d)
  }
  for (const id of diff.addedContracts) add('contract', id)
  for (const id of diff.removedContracts) add('contract', id)
  for (const c of diff.changedContracts) add('contract', c.id)
  for (const id of diff.addedRoles) add('role', id)
  for (const id of diff.removedRoles) add('role', id)
  for (const r of diff.changedRoles) add('role', r.id)
  for (const name of diff.addedHorizontalRoles) add('horizontal-role', name)
  for (const name of diff.removedHorizontalRoles) add('horizontal-role', name)
  for (const h of diff.changedHorizontalRoles) add('horizontal-role', h.name)
  for (const id of diff.addedContexts) add('context', id)
  for (const id of diff.removedContexts) add('context', id)
  for (const id of diff.addedNonGoals) add('non-goal', id)
  for (const id of diff.removedNonGoals) add('non-goal', id)
  for (const n of diff.changedNonGoals) add('non-goal', n.id)
  if (diff.goalChanged) add('goal', projectId)
  return [...set.values()]
}

/**
 * Semantic-review items derived from the diff — things a maintainer must
 * consciously judge (structural errors are produced separately by
 * validateCandidate). Review notes never block; they return in prepare's
 * semanticReviewItems and ride the ModelPublished payload.
 */
export function reviewItemsFromDiff(diff: SnapshotDiff): Diagnostic[] {
  const out: Diagnostic[] = []
  const rev = (code: string, message: string, target?: TargetRef): void => {
    out.push({ severity: 'review', code, message, target })
  }
  if (diff.goalChanged) {
    rev(
      'GOAL_CHANGED',
      'project goal changes with this publication — confirm the restated goal still anchors the same project',
      { kind: 'goal', id: 'goal' }
    )
  }
  for (const id of diff.removedBoundaries) {
    rev(
      'BOUNDARY_RETIRED',
      `boundary "${id}" is retired — verify dependents were remapped and running snapshots are not assumed to change`,
      { kind: 'boundary', id }
    )
  }
  for (const m of diff.movedSubtrees) {
    rev(
      'SUBTREE_MOVED',
      `boundary "${m.boundaryId}" reparented ${m.oldParentId} → ${m.newParentId} moving ${m.descendants.length + 1} boundary(ies); children must re-read the new parent's constraints`,
      { kind: 'boundary', id: m.boundaryId }
    )
  }
  for (const cb of diff.changedBoundaries) {
    if (cb.changes.includes('responsibility')) {
      rev(
        'RESPONSIBILITY_CHANGED',
        `boundary "${cb.id}" responsibility changed — direct children become re-review candidates (D-RDD §2)`,
        { kind: 'boundary', id: cb.id }
      )
    }
  }
  for (const c of diff.changedContracts) {
    if (c.changes.includes('provider') || c.changes.includes('consumers')) {
      rev(
        'CONTRACT_PARTIES_CHANGED',
        `contract "${c.id}" provider/consumer set changed — affected roles need the dependency re-acknowledged`,
        { kind: 'contract', id: c.id }
      )
    }
    if (c.changes.includes('schemaPath')) {
      rev(
        'CONTRACT_SCHEMA_MOVED',
        `contract "${c.id}" schema anchor moved — interface producers/consumers should re-confirm the schema`,
        { kind: 'contract', id: c.id }
      )
    }
  }
  for (const id of diff.removedContracts) {
    rev(
      'CONTRACT_RETIRED',
      `contract "${id}" is retired — consumers lose the declared dependency`,
      { kind: 'contract', id }
    )
  }
  for (const id of diff.removedRoles) {
    rev('ROLE_RETIRED', `role "${id}" is retired — implementations pinned to it become stale`, {
      kind: 'role',
      id
    })
  }
  for (const r of diff.changedRoles) {
    if (r.changes.includes('boundary') || r.changes.includes('horizontalRole')) {
      rev(
        'ROLE_REANCHORED',
        `role "${r.id}" boundary/horizontalRole changed — its interface requirements may shift`,
        { kind: 'role', id: r.id }
      )
    }
  }
  for (const name of diff.removedHorizontalRoles) {
    rev(
      'HORIZONTAL_ROLE_REMOVED',
      `horizontalRole "${name}" removed — specialist guidance binding is gone`,
      { kind: 'horizontal-role', id: name }
    )
  }
  return out
}
