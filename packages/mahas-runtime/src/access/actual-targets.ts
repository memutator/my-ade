// actual-targets.ts — actual-target resolver (spec/domains/access.md §2,
// IMP-10 instruction §4.3).
//
// Request payloads name intent, not authority. Before any allow/deny we
// re-resolve what a target actually IS from the DB:
//
//   Task       → owner Role → Boundary, assigned Member, Run
//   Delivery   → recipient Member (+ Message → Run)
//   Artifact   → producer Dispatch → Task/Member/Execution, Run
//   ChangeSet  → before/after touched set (model_changes.touched_targets_json)
//   Member     → Run, Role, current Execution
//   Execution  → Member
//   Grant      → Principal, parent Grant
//   Boundary   → ModelVersion → Project
//
// A scope entry COVERS a required target iff it equals the target or one of
// these resolved ancestors — that is what lets a run-scoped grant cover the
// tasks/deliveries inside it while a task-scoped grant can never cover the
// boundary above it.
//
// Composite-keyed entities (rdd_roles, rdd_boundaries are keyed by
// model_version + id) resolve to BOTH the bare id and the qualified
// `<modelVersion>:<id>` form, so grants may scope a boundary precisely or by
// bare name. Request targets may use either form.

import type { DatabaseSync } from 'node:sqlite'

export interface TargetRef {
  kind: string
  id: string
}

export interface ResolvedTargets {
  /** targets exactly as requested */
  primary: TargetRef[]
  /** primary + ancestors, deduplicated; includes each primary itself */
  all: TargetRef[]
  /** ancestors keyed by `${kind}:${id}` for every resolved node */
  ancestors: Record<string, TargetRef[]>
  /**
   * requested targets that resolved to no row — they contribute only
   * themselves to `all`, so coverage still requires an explicit scope entry
   */
  unresolved: TargetRef[]
  /** diagnostic hop descriptions recorded in authorization_decisions */
  relations: string[]
}

export function targetKey(t: TargetRef): string {
  return `${t.kind}:${t.id}`
}

const MAX_DEPTH = 8

type SqlParam = string | number | null
type Row = Record<string, unknown>

function rows(db: DatabaseSync, sql: string, ...params: SqlParam[]): Row[] {
  return db.prepare(sql).all(...params) as Row[]
}

/**
 * BFS expansion of request targets into the full set of protected objects
 * they touch. Missing tables/rows leave the target in `unresolved` — the
 * caller decides whether that is still coverable (explicit scope match only).
 */
export function resolveActualTargets(db: DatabaseSync, targets: TargetRef[]): ResolvedTargets {
  const all: TargetRef[] = []
  const ancestors: Record<string, TargetRef[]> = {}
  const unresolved: TargetRef[] = []
  const relations: string[] = []
  const seen = new Set<string>()
  const queue: Array<{ target: TargetRef; depth: number }> = []

  for (const t of targets) queue.push({ target: t, depth: 0 })

  while (queue.length > 0) {
    const { target, depth } = queue.shift() as { target: TargetRef; depth: number }
    const key = targetKey(target)
    if (seen.has(key)) continue
    seen.add(key)
    all.push(target)
    if (depth >= MAX_DEPTH) {
      relations.push(`${key}: depth cap reached`)
      continue
    }
    const hops = expandOne(db, target, relations)
    ancestors[key] = hops
    if (hops.length === 0 && depth === 0 && !isSelfOnlyKind(target.kind)) {
      unresolved.push(target)
    }
    for (const hop of hops) {
      if (!seen.has(targetKey(hop))) queue.push({ target: hop, depth: depth + 1 })
    }
  }

  return { primary: [...targets], all, ancestors, unresolved, relations }
}

/** Kinds that legitimately have no ancestors — never flagged unresolved. */
function isSelfOnlyKind(kind: string): boolean {
  return (
    kind === '*' ||
    kind === 'principal' ||
    kind === 'project' ||
    kind === 'policy' ||
    kind === 'surface' ||
    kind === 'operation' ||
    kind === 'resource' ||
    kind === 'host' ||
    kind === 'envelope' ||
    kind === 'bundle' ||
    kind === 'handoff' ||
    kind === 'settlement' ||
    kind === 'plan'
  )
}

/** Split a possibly-qualified id `mv:b_core` → ['mv','b_core']; bare → [null,id]. */
function splitQualified(id: string): [string | null, string] {
  const idx = id.indexOf(':')
  if (idx <= 0) return [null, id]
  return [id.slice(0, idx), id.slice(idx + 1)]
}

/** Emit a boundary ref in both bare and qualified form (see file header). */
function boundaryRef(modelVersion: unknown, boundaryId: unknown): TargetRef[] {
  const mv = String(modelVersion)
  const b = String(boundaryId)
  return [
    { kind: 'boundary', id: b },
    { kind: 'boundary', id: `${mv}:${b}` }
  ]
}

function expandOne(db: DatabaseSync, target: TargetRef, relations: string[]): TargetRef[] {
  const note = (text: string): number => relations.push(`${targetKey(target)}: ${text}`)
  switch (target.kind) {
    case 'task': {
      const task = rows(db, 'SELECT run_id, current_revision FROM tasks WHERE id = ?', target.id)[0]
      if (!task) return []
      const out: TargetRef[] = []
      if (task.run_id != null) {
        out.push({ kind: 'run', id: String(task.run_id) })
        note(`tasks.run_id -> run:${String(task.run_id)}`)
      }
      const spec = rows(
        db,
        'SELECT owner_role_id, assigned_member_id FROM task_specs WHERE task_id = ? AND revision = ?',
        target.id,
        Number(task.current_revision)
      )[0]
      if (spec?.owner_role_id != null) {
        out.push({ kind: 'role', id: String(spec.owner_role_id) })
        note(`task_specs.owner_role_id -> role:${String(spec.owner_role_id)}`)
      }
      if (spec?.assigned_member_id != null) {
        out.push({ kind: 'member', id: String(spec.assigned_member_id) })
        note(`task_specs.assigned_member_id -> member:${String(spec.assigned_member_id)}`)
      }
      return out
    }

    case 'member': {
      const m = rows(
        db,
        'SELECT run_id, model_version, role_id, current_execution_id FROM members WHERE id = ?',
        target.id
      )[0]
      if (!m) return []
      const out: TargetRef[] = []
      if (m.run_id != null) out.push({ kind: 'run', id: String(m.run_id) })
      if (m.role_id != null) {
        out.push({ kind: 'role', id: String(m.role_id) })
        if (m.model_version != null)
          out.push({ kind: 'role', id: `${String(m.model_version)}:${String(m.role_id)}` })
      }
      if (m.current_execution_id != null)
        out.push({ kind: 'execution', id: String(m.current_execution_id) })
      note(`members -> run:${String(m.run_id)} role:${String(m.role_id)}`)
      return out
    }

    case 'role': {
      const [mv, rid] = splitQualified(target.id)
      const rs = mv
        ? rows(
            db,
            'SELECT model_version, boundary_id FROM rdd_roles WHERE model_version = ? AND id = ?',
            mv,
            rid
          )
        : rows(db, 'SELECT model_version, boundary_id FROM rdd_roles WHERE id = ?', target.id)
      const out: TargetRef[] = []
      for (const r of rs) {
        out.push(...boundaryRef(r.model_version, r.boundary_id))
        out.push({ kind: 'modelVersion', id: String(r.model_version) })
        note(`rdd_roles(${String(r.model_version)}) -> boundary:${String(r.boundary_id)}`)
      }
      return out
    }

    case 'boundary': {
      const [mv, bid] = splitQualified(target.id)
      const bs = mv
        ? rows(
            db,
            'SELECT model_version FROM rdd_boundaries WHERE model_version = ? AND id = ?',
            mv,
            bid
          )
        : rows(db, 'SELECT model_version FROM rdd_boundaries WHERE id = ?', target.id)
      const out: TargetRef[] = []
      for (const b of bs) {
        out.push({ kind: 'modelVersion', id: String(b.model_version) })
        if (!mv) out.push({ kind: 'boundary', id: `${String(b.model_version)}:${target.id}` })
        note(`rdd_boundaries -> modelVersion:${String(b.model_version)}`)
      }
      return out
    }

    case 'modelVersion': {
      const m = rows(
        db,
        'SELECT project_id, parent_version FROM model_versions WHERE id = ?',
        target.id
      )[0]
      if (!m) return []
      const out: TargetRef[] = []
      if (m.project_id != null) out.push({ kind: 'project', id: String(m.project_id) })
      if (m.parent_version != null) out.push({ kind: 'modelVersion', id: String(m.parent_version) })
      return out
    }

    case 'run': {
      const r = rows(
        db,
        'SELECT project_id, coordinator_member_id FROM runs WHERE id = ?',
        target.id
      )[0]
      if (!r) return []
      const out: TargetRef[] = []
      if (r.project_id != null) out.push({ kind: 'project', id: String(r.project_id) })
      if (r.coordinator_member_id != null)
        out.push({ kind: 'member', id: String(r.coordinator_member_id) })
      return out
    }

    case 'execution': {
      const e = rows(db, 'SELECT member_id FROM executions WHERE id = ?', target.id)[0]
      if (!e) return []
      return e.member_id != null ? [{ kind: 'member', id: String(e.member_id) }] : []
    }

    case 'assignment': {
      // An assignment is owned by its member and therefore by that member's
      // run. worker.prepare protects the assignment itself; without these
      // ancestors a normal run/member-scoped grant can never cover the call.
      const assignment = rows(
        db,
        `SELECT a.member_id AS member_id, m.run_id AS run_id
         FROM assignments a
         JOIN members m ON m.id = a.member_id
         WHERE a.id = ?`,
        target.id
      )[0]
      if (!assignment) return []
      const out: TargetRef[] = []
      if (assignment.member_id != null) {
        out.push({ kind: 'member', id: String(assignment.member_id) })
        note(`assignments -> member:${String(assignment.member_id)}`)
      }
      if (assignment.run_id != null) {
        out.push({ kind: 'run', id: String(assignment.run_id) })
        note(`assignments -> run:${String(assignment.run_id)}`)
      }
      return out
    }

    case 'launchPlan': {
      // F-055: a launch plan belongs to a member's assignment in a run
      // (launch_plans → assignments → members). Without this ancestry the
      // join target set {execution, member, launchPlan} is structurally
      // uncoverable by any run/member-scoped grant — only '*' passes —
      // so execution.join can never commit under realistic authority.
      const lp = rows(
        db,
        `SELECT a.member_id AS member_id, m.run_id AS run_id
         FROM launch_plans lp
         JOIN assignments a ON a.id = lp.assignment_id AND a.revision = lp.assignment_revision
         JOIN members m ON m.id = a.member_id
         WHERE lp.id = ?`,
        target.id
      )[0]
      if (!lp) return []
      const out: TargetRef[] = []
      if (lp.member_id != null) {
        out.push({ kind: 'member', id: String(lp.member_id) })
        note(`launch_plans -> member:${String(lp.member_id)}`)
      }
      if (lp.run_id != null) {
        out.push({ kind: 'run', id: String(lp.run_id) })
        note(`launch_plans -> run:${String(lp.run_id)}`)
      }
      return out
    }

    case 'dispatch': {
      const d = rows(
        db,
        'SELECT task_id, member_id, execution_id FROM dispatches WHERE id = ?',
        target.id
      )[0]
      if (!d) return []
      const out: TargetRef[] = []
      if (d.task_id != null) out.push({ kind: 'task', id: String(d.task_id) })
      if (d.member_id != null) out.push({ kind: 'member', id: String(d.member_id) })
      if (d.execution_id != null) out.push({ kind: 'execution', id: String(d.execution_id) })
      return out
    }

    case 'delivery': {
      const d = rows(
        db,
        'SELECT message_id, recipient_member_id FROM deliveries WHERE id = ?',
        target.id
      )[0]
      if (!d) return []
      const out: TargetRef[] = []
      if (d.message_id != null) out.push({ kind: 'message', id: String(d.message_id) })
      if (d.recipient_member_id != null) {
        out.push({ kind: 'member', id: String(d.recipient_member_id) })
        note(`deliveries.recipient_member_id -> member:${String(d.recipient_member_id)}`)
      }
      return out
    }

    case 'message': {
      const m = rows(db, 'SELECT run_id, sender_member_id FROM messages WHERE id = ?', target.id)[0]
      if (!m) return []
      const out: TargetRef[] = []
      if (m.run_id != null) out.push({ kind: 'run', id: String(m.run_id) })
      if (m.sender_member_id != null) out.push({ kind: 'member', id: String(m.sender_member_id) })
      return out
    }

    case 'artifact': {
      const arts = rows(
        db,
        'SELECT run_id, producer_dispatch_id FROM artifacts WHERE id = ?',
        target.id
      )
      const out: TargetRef[] = []
      for (const a of arts) {
        if (a.run_id != null) out.push({ kind: 'run', id: String(a.run_id) })
        if (a.producer_dispatch_id != null)
          out.push({ kind: 'dispatch', id: String(a.producer_dispatch_id) })
        note(`artifacts -> dispatch:${String(a.producer_dispatch_id)}`)
      }
      return out
    }

    case 'outcome': {
      const o = rows(db, 'SELECT task_id, dispatch_id FROM outcomes WHERE id = ?', target.id)[0]
      if (!o) return []
      const out: TargetRef[] = []
      if (o.task_id != null) out.push({ kind: 'task', id: String(o.task_id) })
      if (o.dispatch_id != null) out.push({ kind: 'dispatch', id: String(o.dispatch_id) })
      return out
    }

    case 'modelChange':
    case 'changeSet':
    case 'change': {
      const c = rows(
        db,
        'SELECT project_id, base_version, touched_targets_json FROM model_changes WHERE id = ?',
        target.id
      )[0]
      if (!c) return []
      const out: TargetRef[] = []
      if (c.project_id != null) out.push({ kind: 'project', id: String(c.project_id) })
      if (c.base_version != null) out.push({ kind: 'modelVersion', id: String(c.base_version) })
      for (const touched of parseTouchedTargets(c.touched_targets_json)) {
        out.push(touched)
        note(`touched set -> ${targetKey(touched)}`)
      }
      return out
    }

    case 'grant': {
      const g = rows(
        db,
        'SELECT principal_id, parent_grant_id FROM grants WHERE id = ?',
        target.id
      )[0]
      if (!g) return []
      const out: TargetRef[] = []
      if (g.principal_id != null) out.push({ kind: 'principal', id: String(g.principal_id) })
      if (g.parent_grant_id != null) out.push({ kind: 'grant', id: String(g.parent_grant_id) })
      return out
    }

    case 'executionCredential': {
      const c = rows(
        db,
        'SELECT execution_id, principal_id FROM execution_credentials WHERE id = ?',
        target.id
      )[0]
      if (!c) return []
      const out: TargetRef[] = []
      if (c.execution_id != null) out.push({ kind: 'execution', id: String(c.execution_id) })
      if (c.principal_id != null) out.push({ kind: 'principal', id: String(c.principal_id) })
      return out
    }

    case 'workspace': {
      const w = rows(db, 'SELECT project_id FROM workspaces WHERE id = ?', target.id)[0]
      if (!w) return []
      return w.project_id != null ? [{ kind: 'project', id: String(w.project_id) }] : []
    }

    case 'checkout': {
      const c = rows(db, 'SELECT resource_id, host_id FROM checkouts WHERE id = ?', target.id)[0]
      if (!c) return []
      const out: TargetRef[] = []
      if (c.resource_id != null) out.push({ kind: 'resource', id: String(c.resource_id) })
      if (c.host_id != null) out.push({ kind: 'host', id: String(c.host_id) })
      return out
    }

    case 'terminal': {
      const t = rows(
        db,
        'SELECT resource_id, host_id FROM terminal_records WHERE id = ?',
        target.id
      )[0]
      if (!t) return []
      const out: TargetRef[] = []
      if (t.resource_id != null) out.push({ kind: 'resource', id: String(t.resource_id) })
      if (t.host_id != null) out.push({ kind: 'host', id: String(t.host_id) })
      return out
    }

    default:
      return []
  }
}

/**
 * Parse model_changes.touched_targets_json — the before/after touched set.
 * Tolerates both `[{kind,id}]` entries and bare strings (treated as
 * boundary ids); a `{before:[],after:[]}` wrapper is unwrapped too.
 */
function parseTouchedTargets(json: unknown): TargetRef[] {
  if (typeof json !== 'string') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const out: TargetRef[] = []
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) out.push({ kind: 'boundary', id: v })
    else if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.kind === 'string' && typeof o.id === 'string')
        out.push({ kind: o.kind, id: o.id })
    }
  }
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(push)
    else if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (Array.isArray(o.before)) o.before.forEach(push)
      if (Array.isArray(o.after)) o.after.forEach(push)
      if (Array.isArray(o.touched)) o.touched.forEach(push)
    }
  }
  walk(parsed)
  return out
}
