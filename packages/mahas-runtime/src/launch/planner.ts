// mahas-runtime/launch — worker.prepare: the immutable LaunchPlan (IMP-19).
//
// C-LAUNCH `worker.prepare`: from assignment/interface/implementation/
// profile/command-surface/grant/input/resource pins, produce ONE immutable
// launch_plans row — digest over the full pin set, exact processSpec
// template, reservation ids — without creating any process or worktree.
// Blocked prepares reject with the spec codes (INPUT_NOT_READY,
// INTERFACE_STALE, REQUIRED_ACTION_DENIED, INJECTION_UNSUPPORTED); they do
// not store a plan that could later be started.
//
// Re-planning rule (instruction §5): a changed execution config produces a
// different digest → a NEW launch_plans row; an existing plan row is never
// mutated. Re-preparing identical pins returns the existing plan.

import type { DatabaseSync } from 'node:sqlite'
import type {
  AuthenticatedContext,
  ErrorCode,
  MahasError
} from '../../../mahas-contracts/src/common.ts'
import type { TxnContext } from '../api/registry.ts'
import type { Assignment, Member, Run } from '../../../mahas-contracts/src/work.ts'
import {
  canonicalJson,
  describeError,
  getRow,
  isMahasError,
  mahasError,
  runSql,
  type ResolvedDeps
} from './deps.ts'
import {
  planRoutes,
  REQUIRED_SOURCES,
  type ArgvEntry,
  type InjectionRoute,
  type PlannedProcessSpec
} from './initial-attachment.ts'
import { launchRecipeFromProfile } from './recipe-adapter.ts'

// ---------------------------------------------------------------------------
// storage projections (snake_case rows per spec/storage.md §3)

interface AssignmentRow {
  id: string
  revision: number
  member_id: string
  kind: 'task' | 'coordination'
  mandate_text: string
  grant_id: string
  task_id: string | null
  task_revision: number | null
  scope_json: string
}
interface MemberRow {
  id: string
  run_id: string
  model_version: string
  role_id: string
  implementation_id: string
  implementation_revision: number
  generation: number
  current_execution_id: string | null
  state: string
  revision: number
}
interface RunRow {
  id: string
  project_id: string
  model_version: string
  goal_text: string
  purpose: string
  state: string
  revision: number
}
interface GrantRow {
  id: string
  revision: number
  kind: string
  principal_id: string
  policy_id: string | null
  policy_revision: number | null
  expires_at: number | null
  revoked_at: number | null
  scope_json: string
  actions_json: string
}
interface PolicyRow {
  id: string
  revision: number
  action_ceiling_json: string
}
interface ImplRow {
  id: string
  revision: number
  interface_digest: string
  profile_id: string
  profile_revision: number
  status: string
}
interface InterfaceRow {
  digest: string
}
interface ProfileRow {
  id: string
  revision: number
  state: string
  recipe_json: string
  capabilities_json: string
  executable_identity_json: string
}
interface EnvelopeRow {
  digest: string
  kind: string
  bindings_json: string
}
interface HostRow {
  id: string
  incarnation: string
  protocol_version: string
  state: string
}

// ---------------------------------------------------------------------------
// payloads / results (C-LAUNCH worker.prepare contract)

export interface PlacementIntent {
  hostId: string
  kind?: 'worktree' | 'folder'
  projectId?: string
  baseRevision?: string
  targetPath?: string
}

export interface PrepareInput {
  assignmentId: string
  assignmentRevision: number
  implementationRevision: number
  taskRevision?: number
  placementIntent: PlacementIntent
  harnessProfileRevision: number
  purpose: 'work' | 'verification'
}

export interface PrepareBlocker {
  code: ErrorCode
  detail: string
}

export interface PrepareResult {
  launchPlanId: string
  digest: string
  state: string
  /** true when identical pins were already planned (idempotent re-prepare) */
  existing: boolean
  pins: LaunchPins
  processSpec: PlannedProcessSpec
  plannedSurface: { digest: string; actions: string[] }
  requiredComponents: string[]
  reservations: Reservation[]
  blockers: PrepareBlocker[]
}

export interface Reservation {
  reservationId: string
  kind: string
  mode: string
}

export interface LaunchPins {
  assignment: { id: string; revision: number; kind: 'task' | 'coordination' }
  member: { id: string }
  run: { id: string; purpose: string }
  modelVersion: string
  roleId: string
  interfaceDigest: string
  implementation: { id: string; revision: number }
  harnessProfile: { id: string; revision: number }
  grant: { id: string; revision: number }
  policy: { id: string; revision: number } | null
  task: { id: string; revision: number } | null
  envelope: { digest: string }
  bundle: { digest: string }
  surface: { digest: string }
  host: { id: string; incarnation: string }
  placementIntent: PlacementIntent
  purpose: 'work' | 'verification'
  routes: InjectionRoute[]
  inputs: unknown
}

// ---------------------------------------------------------------------------

function blocker(code: ErrorCode, detail: string): PrepareBlocker {
  return { code, detail }
}

function fail(blockers: PrepareBlocker[]): never {
  const first = blockers[0]!
  const err: MahasError = {
    code: first.code,
    message: first.detail,
    retry: first.code === 'INTERFACE_STALE' || first.code === 'INPUT_NOT_READY' ? 'replan' : 'none',
    details: { blockers }
  }
  throw err
}

function asStringArray(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
    if (
      typeof v === 'object' &&
      v !== null &&
      Array.isArray((v as { actions?: unknown }).actions)
    ) {
      return ((v as { actions: unknown[] }).actions as unknown[]).filter(
        (x): x is string => typeof x === 'string'
      )
    }
  } catch {
    /* malformed → treated as empty, surfaced by the caller */
  }
  return []
}

export async function workerPrepare(
  txn: TxnContext,
  payload: unknown,
  deps: ResolvedDeps
): Promise<PrepareResult> {
  const db = txn.db
  const p = payload as Partial<PrepareInput>
  if (
    typeof p.assignmentId !== 'string' ||
    typeof p.assignmentRevision !== 'number' ||
    typeof p.implementationRevision !== 'number' ||
    typeof p.harnessProfileRevision !== 'number' ||
    (p.purpose !== 'work' && p.purpose !== 'verification') ||
    typeof p.placementIntent?.hostId !== 'string'
  ) {
    throw mahasError('INPUT_NOT_READY', 'worker.prepare: malformed input', 'none', { got: p })
  }
  const input = p as PrepareInput
  const blockers: PrepareBlocker[] = []

  // ---- assignment pin -----------------------------------------------------
  const assignment = getRow<AssignmentRow>(
    db,
    'SELECT * FROM assignments WHERE id=? AND revision=?',
    input.assignmentId,
    input.assignmentRevision
  )
  if (!assignment) {
    throw mahasError(
      'INPUT_NOT_READY',
      `assignment ${input.assignmentId}@${input.assignmentRevision} not found`,
      'replan'
    )
  }
  const member = getRow<MemberRow>(db, 'SELECT * FROM members WHERE id=?', assignment.member_id)
  if (!member) {
    throw mahasError('INPUT_NOT_READY', `member ${assignment.member_id} not found`, 'replan')
  }
  const run = getRow<RunRow>(db, 'SELECT * FROM runs WHERE id=?', member.run_id)
  if (!run) throw mahasError('INPUT_NOT_READY', `run ${member.run_id} not found`, 'replan')

  if (assignment.kind === 'task') {
    if (!assignment.task_id || assignment.task_revision == null) {
      blockers.push(blocker('INPUT_NOT_READY', 'task assignment has no task pin'))
    } else if (
      input.taskRevision !== undefined &&
      input.taskRevision !== assignment.task_revision
    ) {
      blockers.push(
        blocker(
          'INTERFACE_STALE',
          `requested taskRevision ${input.taskRevision} != assignment pin ${assignment.task_revision}`
        )
      )
    }
  }

  // ---- grant / policy pins (permission intersection inputs) ---------------
  const grant = getRow<GrantRow>(db, 'SELECT * FROM grants WHERE id=?', assignment.grant_id)
  if (!grant) {
    blockers.push(blocker('REQUIRED_ACTION_DENIED', `grant ${assignment.grant_id} missing`))
  } else {
    if (grant.revoked_at != null) {
      throw mahasError('GRANT_REVOKED', `grant ${grant.id} revoked`, 'replan')
    }
    if (grant.expires_at != null && grant.expires_at <= deps.now()) {
      blockers.push(blocker('REQUIRED_ACTION_DENIED', `grant ${grant.id} expired`))
    }
  }
  const policy =
    grant?.policy_id != null
      ? getRow<PolicyRow>(
          db,
          'SELECT * FROM role_policies WHERE id=? AND revision=?',
          grant.policy_id,
          grant.policy_revision
        )
      : null

  // ---- implementation / interface / profile pins --------------------------
  const impl = getRow<ImplRow>(
    db,
    'SELECT * FROM role_implementations WHERE id=? AND revision=?',
    member.implementation_id,
    member.implementation_revision
  )
  if (!impl) {
    blockers.push(
      blocker(
        'IMPLEMENTATION_MISSING',
        `implementation ${member.implementation_id}@${member.implementation_revision} missing`
      )
    )
  } else {
    if (input.implementationRevision !== member.implementation_revision) {
      blockers.push(
        blocker(
          'INTERFACE_STALE',
          `requested implementationRevision ${input.implementationRevision} != member pin ${member.implementation_revision}`
        )
      )
    }
    if (impl.status !== 'published') {
      blockers.push(
        blocker(
          'IMPLEMENTATION_MISSING',
          `implementation ${impl.id}@${impl.revision} not published (status=${impl.status})`
        )
      )
    }
    if (input.harnessProfileRevision !== impl.profile_revision) {
      blockers.push(
        blocker(
          'INTERFACE_STALE',
          `requested harnessProfileRevision ${input.harnessProfileRevision} != implementation pin ${impl.profile_revision}`
        )
      )
    }
  }

  const iface = getRow<InterfaceRow>(
    db,
    'SELECT digest FROM role_interfaces WHERE model_version=? AND role_id=?',
    member.model_version,
    member.role_id
  )
  const interfaceDigest = impl?.interface_digest ?? ''
  if (!iface) {
    blockers.push(
      blocker(
        'INTERFACE_STALE',
        `no role interface for ${member.role_id} @ ${member.model_version}`
      )
    )
  } else if (iface.digest !== interfaceDigest) {
    blockers.push(
      blocker(
        'INTERFACE_STALE',
        `current interface ${iface.digest} != implementation pin ${interfaceDigest}`
      )
    )
  }

  const profile = impl
    ? getRow<ProfileRow>(
        db,
        'SELECT * FROM harness_profiles WHERE id=? AND revision=?',
        impl.profile_id,
        impl.profile_revision
      )
    : null
  if (!profile) {
    blockers.push(
      blocker(
        'INPUT_NOT_READY',
        `harness profile ${impl?.profile_id ?? '?'}@${impl?.profile_revision ?? '?'} missing`
      )
    )
  }

  // ---- purpose / profile admission ----------------------------------------
  if (profile) {
    if (input.purpose === 'work' && profile.state !== 'verified') {
      blockers.push(
        blocker(
          'REQUIRED_ACTION_DENIED',
          `purpose=work requires a verified harness profile (state=${profile.state})`
        )
      )
    }
    if (input.purpose === 'verification') {
      if (run.purpose !== 'verification') {
        blockers.push(
          blocker(
            'REQUIRED_ACTION_DENIED',
            `purpose=verification launch requires a verification Run (run purpose=${run.purpose})`
          )
        )
      }
      const admission = callerProfileAdmission(txn.ctx, db, deps)
      if (!admission) {
        blockers.push(
          blocker(
            'REQUIRED_ACTION_DENIED',
            'no caller ProvisioningGrant with profileAdmission=documented-in-verification-run'
          )
        )
      } else if (
        admission.profileId !== undefined &&
        (admission.profileId !== profile.id || admission.profileRevision !== profile.revision)
      ) {
        blockers.push(
          blocker(
            'REQUIRED_ACTION_DENIED',
            'verification grant is scoped to a different profile revision'
          )
        )
      }
    }
  }

  // ---- placement host ------------------------------------------------------
  const host = getRow<HostRow>(
    db,
    'SELECT * FROM execution_hosts WHERE id=?',
    input.placementIntent.hostId
  )
  if (!host) {
    blockers.push(
      blocker('INPUT_NOT_READY', `execution host ${input.placementIntent.hostId} unknown`)
    )
  }

  // ---- permission intersection → CommandSurface ---------------------------
  const grantActions = grant ? asStringArray(grant.actions_json) : []
  const policyCeiling = policy ? asStringArray(policy.action_ceiling_json) : null
  const allowed = [
    ...new Set(
      policyCeiling === null ? grantActions : grantActions.filter((a) => policyCeiling.includes(a))
    )
  ].sort()
  let surfaceDigest = ''
  if (grant && allowed.length === 0) {
    blockers.push(blocker('REQUIRED_ACTION_DENIED', 'grant ∩ role-policy action ceiling is empty'))
  } else if (grant) {
    const surfaceDoc = {
      actionsAndSchemas: { allowed },
      policyPins: {
        grantId: grant.id,
        grantRevision: grant.revision,
        ...(policy ? { policyId: policy.id, policyRevision: policy.revision } : {})
      }
    }
    surfaceDigest = deps.digest(canonicalJson(surfaceDoc))
    runSql(
      db,
      'INSERT OR IGNORE INTO command_surfaces(digest,actions_and_schemas_json,policy_pins_json) VALUES (?,?,?)',
      surfaceDigest,
      JSON.stringify(surfaceDoc.actionsAndSchemas),
      JSON.stringify(surfaceDoc.policyPins)
    )
  }

  // ---- context bundle via C-REALIZATION context.build ---------------------
  let bundleDigest = ''
  let manifest: unknown = null
  let requiredTextDigest = ''
  if (iface && impl && surfaceDigest && !blockers.length) {
    if (!deps.call) {
      blockers.push(
        blocker('CONTROL_UNAVAILABLE', 'context.build caller not wired (handoff:IMP-11 pending)')
      )
    } else {
      try {
        const built = (await deps.call(txn.ctx, 'context.build', {
          interfaceDigest,
          implementationId: impl.id,
          implementationRevision: impl.revision,
          surfaceDigest,
          sourceSnapshotPins: [] as Array<{ path: string; digest: string }>
        })) as { bundleDigest?: string; manifest?: unknown; requiredTextDigest?: string }
        bundleDigest = built.bundleDigest ?? ''
        manifest = built.manifest ?? null
        requiredTextDigest = built.requiredTextDigest ?? ''
        if (!bundleDigest) {
          blockers.push(
            blocker('MANDATORY_COMPONENT_MISSING', 'context.build returned no bundleDigest')
          )
        }
      } catch (e) {
        const d = describeError(e)
        blockers.push(
          blocker(isMahasError(e) ? e.code : 'INPUT_NOT_READY', `context.build: ${d.message}`)
        )
      }
    }
  }

  // ---- WorkEnvelope pin (IMP-14) ------------------------------------------
  let envelopeDigest = ''
  let envelopeBindings: unknown = null
  const envRow = getRow<EnvelopeRow>(
    db,
    'SELECT * FROM work_envelopes WHERE assignment_id=? AND assignment_revision=?',
    assignment.id,
    assignment.revision
  )
  if (envRow) {
    envelopeDigest = envRow.digest
    try {
      envelopeBindings = JSON.parse(envRow.bindings_json)
    } catch {
      envelopeBindings = null
    }
  } else if (deps.ensureEnvelope) {
    const built = await deps.ensureEnvelope(db, {
      assignment: assignment as unknown as Assignment,
      member: member as unknown as Member,
      run: run as unknown as Run
    })
    if (built?.digest) {
      envelopeDigest = built.digest
    } else {
      blockers.push(
        blocker('INPUT_NOT_READY', 'work envelope could not be built for this assignment')
      )
    }
  } else {
    blockers.push(
      blocker(
        'INPUT_NOT_READY',
        `no WorkEnvelope pinned for ${assignment.id}@${assignment.revision} (handoff:IMP-14 port unwired)`
      )
    )
  }

  // ---- recipe → process spec + injection routes ----------------------------
  let processSpec: PlannedProcessSpec | null = null
  let routes: InjectionRoute[] = []
  if (profile) {
    const recipe = launchRecipeFromProfile(profile)
    const exe = recipe?.process?.executable
    if (
      !recipe ||
      !Array.isArray(recipe.process?.argv) ||
      typeof exe !== 'string' ||
      !exe.startsWith('/')
    ) {
      blockers.push(
        blocker(
          'INJECTION_UNSUPPORTED',
          `profile ${profile.id}@${profile.revision} recipe lacks an absolute executable/argv template`
        )
      )
    } else {
      const recipeArgv = recipe.process.argv as ArgvEntry[]
      const argv0 = recipeArgv[0]
      const exeAlready = argv0 !== undefined && 'literal' in argv0 && argv0.literal === exe
      processSpec = {
        executable: exe,
        argv: exeAlready ? recipeArgv : [{ literal: exe }, ...recipeArgv],
        stdio: recipe.process.stdio ?? 'pty',
        ...(recipe.process.terminalSize ? { terminalSize: recipe.process.terminalSize } : {}),
        ...(recipe.process.env ? { env: recipe.process.env } : {}),
        ...(recipe.process.envAllowlist ? { envAllowlist: recipe.process.envAllowlist } : {})
      }
      const caps = JSON.parse(profile.capabilities_json) as { components?: string[] }
      const supported = Array.isArray(caps?.components) ? caps.components : []
      const planned = planRoutes(recipe, manifest, supported)
      routes = planned.routes
      blockers.push(...planned.blockers)
      const stdinRoute = routes.find((r) => r.kind === 'stdin')
      if (stdinRoute) processSpec.stdin = { source: stdinRoute.source }
    }
  }

  if (blockers.length) fail(blockers)
  if (!processSpec || !profile || !impl || !grant || !host) {
    throw mahasError('INPUT_NOT_READY', 'prepare produced incomplete pins', 'replan')
  }

  // ---- reservations + digest + immutable row -------------------------------
  const reservationIds = {
    checkout: `rsv-checkout-${deps.digest(`${input.assignmentId}:${input.assignmentRevision}:checkout`).slice(0, 24)}`,
    executionRoot: `rsv-execroot-${deps.digest(`${input.assignmentId}:${input.assignmentRevision}:execroot`).slice(0, 24)}`,
    terminal: `rsv-terminal-${deps.digest(`${input.assignmentId}:${input.assignmentRevision}:terminal`).slice(0, 24)}`
  }
  const reservations: Reservation[] = [
    { reservationId: reservationIds.checkout, kind: 'checkout', mode: 'write' },
    { reservationId: reservationIds.executionRoot, kind: 'execution-directory', mode: 'exclusive' },
    { reservationId: reservationIds.terminal, kind: 'terminal', mode: 'exclusive' }
  ]

  const pins: LaunchPins = {
    assignment: { id: assignment.id, revision: assignment.revision, kind: assignment.kind },
    member: { id: member.id },
    run: { id: run.id, purpose: run.purpose },
    modelVersion: member.model_version,
    roleId: member.role_id,
    interfaceDigest,
    implementation: { id: impl.id, revision: impl.revision },
    harnessProfile: { id: profile.id, revision: profile.revision },
    grant: { id: grant.id, revision: grant.revision },
    policy: policy ? { id: policy.id, revision: policy.revision } : null,
    task:
      assignment.kind === 'task' && assignment.task_id != null && assignment.task_revision != null
        ? { id: assignment.task_id, revision: assignment.task_revision }
        : null,
    envelope: { digest: envelopeDigest },
    bundle: { digest: bundleDigest },
    surface: { digest: surfaceDigest },
    host: { id: host.id, incarnation: host.incarnation },
    placementIntent: input.placementIntent,
    purpose: input.purpose,
    routes,
    inputs: envelopeBindings
  }

  const digest = deps.digest(canonicalJson({ pins, processSpec, reservations, requiredTextDigest }))
  const launchPlanId = `launchplan-${digest.slice(0, 40)}`

  const existing = getRow<{ id: string; digest: string; state: string }>(
    db,
    'SELECT id,digest,state FROM launch_plans WHERE id=?',
    launchPlanId
  )
  if (existing) {
    // identical pins → identical idempotent plan; return it unchanged
    const row = getRow<{ process_spec_json: string; pins_json: string; reservations_json: string }>(
      db,
      'SELECT process_spec_json,pins_json,reservations_json FROM launch_plans WHERE id=?',
      launchPlanId
    )!
    return {
      launchPlanId,
      digest: existing.digest,
      state: existing.state,
      existing: true,
      pins: JSON.parse(row.pins_json) as LaunchPins,
      processSpec: JSON.parse(row.process_spec_json) as PlannedProcessSpec,
      plannedSurface: { digest: surfaceDigest, actions: allowed },
      requiredComponents: requiredComponentList(manifest),
      reservations: JSON.parse(row.reservations_json) as Reservation[],
      blockers: []
    }
  }

  runSql(
    db,
    `INSERT INTO launch_plans(id,assignment_id,assignment_revision,digest,bundle_digest,envelope_digest,surface_digest,state,process_spec_json,pins_json,reservations_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    launchPlanId,
    assignment.id,
    assignment.revision,
    digest,
    bundleDigest,
    envelopeDigest,
    surfaceDigest,
    'planned',
    JSON.stringify(processSpec),
    JSON.stringify(pins),
    JSON.stringify(reservations)
  )

  return {
    launchPlanId,
    digest,
    state: 'planned',
    existing: false,
    pins,
    processSpec,
    plannedSurface: { digest: surfaceDigest, actions: allowed },
    requiredComponents: requiredComponentList(manifest),
    reservations,
    blockers: []
  }
}

function requiredComponentList(manifest: unknown): string[] {
  const out: string[] = [...REQUIRED_SOURCES]
  if (typeof manifest === 'object' && manifest !== null) {
    const list = (manifest as { components?: unknown }).components
    if (Array.isArray(list)) {
      for (const c of list as { id?: string; activation?: string; path?: string }[]) {
        if ((c.activation === 'required' || c.activation === 'mandatory') && (c.path ?? c.id)) {
          out.push((c.path ?? c.id)!)
        }
      }
    }
  }
  return [...new Set(out)]
}

/**
 * Scans the caller's grants for the verification-run profile admission
 * (C-LAUNCH limited launch). Returns the grant's profile scope when found.
 */
function callerProfileAdmission(
  ctx: AuthenticatedContext,
  db: DatabaseSync,
  deps: ResolvedDeps
): { profileId?: string; profileRevision?: number } | null {
  void deps
  for (const grantId of Object.keys(ctx.grantRevisions ?? {})) {
    const g = getRow<GrantRow>(db, 'SELECT * FROM grants WHERE id=?', grantId)
    if (!g || g.kind !== 'provisioning' || g.revoked_at != null) continue
    if (g.expires_at != null && g.expires_at <= deps.now()) continue
    try {
      const scope = JSON.parse(g.scope_json) as {
        profileAdmission?: string
        harnessProfileId?: string
        harnessProfileRevision?: number
      }
      if (scope.profileAdmission === 'documented-in-verification-run') {
        return { profileId: scope.harnessProfileId, profileRevision: scope.harnessProfileRevision }
      }
    } catch {
      /* malformed scope → not an admission grant */
    }
  }
  return null
}
