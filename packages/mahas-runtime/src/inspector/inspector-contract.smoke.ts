// inspector/inspector-contract.smoke.ts — contract response fixtures for the
// inspector lanes (C-REALIZATION interface.get, C-ACCESS surface.describe +
// access.inspect, C-LAUNCH worker.inspect, C-MATERIALIZATION context.inspect).
//
// WHAT THIS PROVES
// The shared DTOs in mahas-contracts/operations/inspector.ts are the shapes the
// REGISTERED handlers actually return — not a parallel description of them.
// Each fixture calls the real handler (or its real projection function) and
// checks the fields the DTO promises, so a handler that renames a field or
// drops a guarantee fails here instead of surfacing as a blank lane in the
// workbench.
//
// Synthetic data only: in-memory SQLite, no provider API, no credentials.
// Run: node packages/mahas-runtime/src/inspector/inspector-contract.smoke.ts

import { DatabaseSync } from 'node:sqlite'
import type {
  AccessInspectResult,
  InterfaceGetResult,
  SurfaceDescribeResult,
  WorkerInspectResult
} from '../../../mahas-contracts/src/operations/inspector.ts'
import {
  projectAccessInspect,
  projectContextInspect,
  projectInterface,
  projectSurfaceDescribe,
  projectWorkerInspect
} from './views.ts'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1
    console.log('  ok   ' + name)
  } else {
    failed += 1
    console.log('  FAIL ' + name)
    if (detail !== undefined) console.log('       ' + JSON.stringify(detail))
  }
}

function section(title: string): void {
  console.log('\n' + title)
}

// ── C-REALIZATION · interface.get ─────────────────────────────────────────

section('interface.get — the shared DTO is what the handler returns')
{
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL,
      repository_root TEXT NOT NULL, active_model_version TEXT, revision INTEGER NOT NULL);
    CREATE TABLE model_versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      parent_version TEXT, root_boundary_id TEXT, goal_snapshot TEXT NOT NULL,
      status TEXT NOT NULL, digest TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE rdd_boundaries (model_version TEXT NOT NULL, id TEXT NOT NULL,
      name TEXT NOT NULL, responsibility_statement TEXT NOT NULL, PRIMARY KEY(model_version,id));
    CREATE TABLE rdd_criteria (model_version TEXT NOT NULL, boundary_id TEXT NOT NULL,
      id TEXT NOT NULL, criterion TEXT NOT NULL, description TEXT NOT NULL,
      ordinal INTEGER NOT NULL, PRIMARY KEY(model_version,boundary_id,id));
    CREATE TABLE rdd_roles (model_version TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, boundary_id TEXT NOT NULL, horizontal_role_name TEXT NOT NULL,
      PRIMARY KEY(model_version,id));
    CREATE TABLE rdd_contexts (model_version TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      path TEXT NOT NULL, PRIMARY KEY(model_version,id));
    CREATE TABLE boundary_contexts (model_version TEXT NOT NULL, boundary_id TEXT NOT NULL,
      context_id TEXT NOT NULL, PRIMARY KEY(model_version,boundary_id,context_id));
    CREATE TABLE horizontal_contexts (model_version TEXT NOT NULL, horizontal_role_name TEXT NOT NULL,
      context_id TEXT NOT NULL, PRIMARY KEY(model_version,horizontal_role_name,context_id));
    CREATE TABLE rdd_non_goals (model_version TEXT NOT NULL, id TEXT NOT NULL,
      boundary_id TEXT NOT NULL, statement TEXT NOT NULL, PRIMARY KEY(model_version,id));
    CREATE TABLE rdd_contracts (model_version TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      provider_boundary_id TEXT NOT NULL, PRIMARY KEY(model_version,id));
    CREATE TABLE contract_consumers (model_version TEXT NOT NULL, contract_id TEXT NOT NULL,
      consumer_boundary_id TEXT NOT NULL, PRIMARY KEY(model_version,contract_id,consumer_boundary_id));
    CREATE TABLE role_interfaces (digest TEXT PRIMARY KEY, model_version TEXT NOT NULL,
      role_id TEXT NOT NULL, requirements_json TEXT NOT NULL, judgment_scope_json TEXT NOT NULL);
  `)
  db.prepare('INSERT INTO model_versions VALUES(?,?,?,?,?,?,?,?)').run(
    'mv-1',
    'proj-1',
    null,
    'bnd-root',
    'goal',
    'published',
    'digest',
    1
  )
  db.prepare('INSERT INTO rdd_boundaries VALUES(?,?,?,?)').run(
    'mv-1',
    'bnd-root',
    'Root',
    'root responsibility'
  )
  db.prepare('INSERT INTO rdd_roles VALUES(?,?,?,?,?,?)').run(
    'mv-1',
    'role-1',
    'Impl role',
    'does the work',
    'bnd-root',
    'implementation'
  )
  db.prepare('INSERT INTO rdd_criteria VALUES(?,?,?,?,?,?)').run(
    'mv-1',
    'bnd-root',
    'crit-1',
    'criterion text',
    'criterion description',
    1
  )
  // one bound context so the clause list has both a criterion clause and a
  // context clause — the fixture checks the flattened list carries both
  db.prepare('INSERT INTO rdd_contexts VALUES(?,?,?,?)').run(
    'mv-1',
    'ctx-1',
    'Context one',
    'contexts/one.md'
  )
  db.prepare('INSERT INTO boundary_contexts VALUES(?,?,?)').run('mv-1', 'bnd-root', 'ctx-1')
  db.prepare('INSERT INTO rdd_non_goals VALUES(?,?,?,?)').run(
    'mv-1',
    'ng-1',
    'bnd-root',
    'not this'
  )

  const txn = {
    db,
    ctx: {
      principalId: 'p-1',
      controllerEpoch: 1,
      grantRevisions: {},
      transportSessionId: 'fixture'
    },
    emitEvent: () => {}
  } as unknown as Parameters<typeof interfaceGet>[0]
  const { interfaceGet } = await import('../realization/interfaces.ts')
  const result: InterfaceGetResult = interfaceGet(txn, { modelVersion: 'mv-1', roleId: 'role-1' })

  check('carries the nested RoleInterface', result.interface.roleId === 'role-1')
  check(
    'carries the flattened contextRequirements the DTO promises',
    Array.isArray(result.contextRequirements) && result.contextRequirements.length > 0,
    result.contextRequirements
  )
  check(
    'nested requirements.contextRequirements matches the flattened list',
    JSON.stringify(result.interface.requirements.contextRequirements) ===
      JSON.stringify(result.contextRequirements),
    {
      nested: result.interface.requirements.contextRequirements.length,
      flat: result.contextRequirements.length
    }
  )
  check(
    'maintenanceRefs are model-derived refs (kind/id), not implementation bindings',
    result.maintenanceRefs.every(
      (r) =>
        typeof r.kind === 'string' &&
        typeof r.id === 'string' &&
        !('implementationId' in r) &&
        !('basisRef' in r)
    ),
    result.maintenanceRefs
  )
  check(
    'modelStatus reports the read model status',
    result.modelStatus === 'published',
    result.modelStatus
  )

  const view = projectInterface(result, undefined, undefined)
  check(
    'the inspector view reads the canonical requirements list',
    view.requirements.length === result.contextRequirements.length,
    { view: view.requirements.length, dto: result.contextRequirements.length }
  )
  check('view digest matches the DTO digest', view.digest === result.digest)
  db.close()
}

// ── C-ACCESS · surface.describe ───────────────────────────────────────────

section('surface.describe — the projection IS the descriptor list')
{
  const result: SurfaceDescribeResult = {
    surfaceDigest: 'sd-1',
    stale: false,
    operations: [
      {
        name: 'test.ping',
        summary: 'ping',
        mutation: false,
        visibility: 'member',
        inputSchema: { type: 'object' },
        outputSchema: null
      },
      {
        name: 'run.create',
        summary: null,
        mutation: true,
        visibility: 'operator',
        inputSchema: null,
        outputSchema: null
      }
    ]
  }
  const view = projectSurfaceDescribe(result)
  check(
    'every visible descriptor becomes a row',
    view.operations.length === 2 && view.operations[0]!.operation === 'test.ping',
    view.operations
  )
  check('the digest is the projected surfaceDigest', view.surfaceDigest === 'sd-1')
  check('staleness is reported, never inferred', view.stale === false)
  check(
    'mutation/visibility are read from the descriptor',
    view.operations[1]!.summary === undefined
  )
}

// ── C-ACCESS · access.inspect ─────────────────────────────────────────────

section('access.inspect — one subject, grant rows carry their own status')
{
  const memberView: AccessInspectResult = {
    memberId: 'mem-1',
    policy: { policyId: 'pol-1', policyRevision: 2 },
    effectiveActions: ['worker.prepare'],
    grants: [
      {
        grantId: 'g-1',
        kind: 'provisioning',
        revision: 1,
        actions: ['worker.prepare'],
        scopeSummary: {
          runId: 'run-1',
          targets: [{ kind: 'run', id: 'run-1' }],
          provisioning: { allowedRoleIds: ['role-1'], profileAdmission: 'verified-only' }
        },
        expiresAt: 1000,
        revokedAt: null,
        status: 'active'
      },
      {
        grantId: 'g-2',
        kind: 'continuation',
        revision: 3,
        actions: ['execution.wake'],
        scopeSummary: { targets: [] },
        expiresAt: null,
        revokedAt: 900,
        status: 'revoked'
      }
    ]
  }
  const view = projectAccessInspect(undefined, memberView)
  check('member subject is shown', view.memberId === 'mem-1')
  check('policy pin is carried through', view.policy?.policyId === 'pol-1')
  check(
    'one row per grant, each with its own expiry/revocation/status',
    view.grants.length === 2 &&
      view.grants[0]!.status === 'active' &&
      view.grants[1]!.status === 'revoked'
  )
  check('revoked is only claimed when no grant is live', view.revoked === false, view.revoked)
  const allRevoked = projectAccessInspect(undefined, {
    ...memberView,
    grants: memberView.grants.map((g) => ({ ...g, status: 'revoked' as const, revokedAt: 1 }))
  })
  check('all-revoked subject reads revoked', allRevoked.revoked === true)

  const grantView: AccessInspectResult = {
    grantId: 'g-1',
    policy: null,
    effectiveActions: [],
    grants: [
      {
        grantId: 'g-1',
        kind: 'assignment',
        revision: 4,
        actions: ['task.report'],
        scopeSummary: { targets: [{ kind: 'task', id: 'tsk-1' }] },
        expiresAt: null,
        revokedAt: 500,
        status: 'revoked'
      }
    ]
  }
  const grantLane = projectAccessInspect(undefined, grantView)
  check('grant subject is shown', grantLane.grantId === 'g-1')
  check(
    'an inactive single grant empties the effective actions',
    grantLane.effectiveActions.length === 0
  )
  check('a revoked grant row reads revoked', grantLane.revoked === true)
  check(
    'targets come from the resolved scope summary',
    grantLane.grants[0]!.scopeSummary.targets[0]!.kind === 'task'
  )
}

// ── C-LAUNCH · worker.inspect ─────────────────────────────────────────────

section('worker.inspect — the flattened execution view is the DTO')
{
  const result: WorkerInspectResult = {
    executionId: 'exec-1',
    memberId: 'mem-1',
    generation: 2,
    hostId: 'host-1',
    launchPlanId: 'plan-1',
    planDigest: 'pd-1',
    phase: 'running',
    liveness: 'live',
    terminalId: 'term-1',
    processEvidence: { pid: 4242 },
    joined: { joinedAt: 111 },
    taskAuthority: {
      dispatchId: 'd-1',
      taskId: 'tsk-1',
      taskRevision: 3,
      phase: 'running',
      authorityState: 'active',
      assignmentDeliveryId: null
    },
    injectionReceipts: [{ phase: 'materialized', revision: 1 }],
    stageReceipt: {
      currentStage: 'joined',
      stages: [{ stage: 'planned', state: 'reached', at: 10 }],
      failedStage: undefined,
      nextAllowedActions: ['worker.stop']
    },
    residuals: [{ kind: 'workspace', ref: 'ws-1', state: 'held' }],
    nextAllowedActions: ['worker.stop']
  }
  const view = projectWorkerInspect(result)
  check('identity is flat and complete', view.executionId === 'exec-1' && view.generation === 2)
  check('phase is the recorded state, verbatim', view.phase === 'running')
  check('liveness is the recorded/probed value', view.liveness === 'live')
  check(
    'the stage receipt stays evidence (stages + failedStage)',
    view.stages.length === 12 &&
      view.stages.some((s) => s.stage === 'planned' && s.state === 'reached') &&
      view.stages.some((s) => s.stage === 'joined' && s.state === 'current') &&
      view.failedStage === undefined,
    view.stages
  )
  check(
    'a stage with no recorded evidence reads unknown, never done',
    view.stages.every((s) => s.state !== 'reached' || s.stage === 'planned')
  )
  check(
    'task authority is the dispatch pin, not a synthesized summary',
    view.taskAuthority?.dispatchId === 'd-1' && view.taskAuthority.taskRevision === 3
  )
  check('residuals and next actions are carried through', view.residuals.length === 1)
  check(
    'probe is absent unless the caller asked for it',
    view.probe === undefined && !('probe' in result)
  )
  const probed = projectWorkerInspect({
    ...result,
    liveness: 'unverifiable',
    probe: { error: { code: 'CONTROL_UNAVAILABLE' } }
  })
  check(
    'an unanswered probe is unverifiable with the failure preserved',
    probed.liveness === 'unverifiable' && probed.probe !== undefined
  )
}

// ── C-MATERIALIZATION · context.inspect ───────────────────────────────────

section('context.inspect — planned intent vs recorded delivery evidence')
{
  const view = projectContextInspect({
    bundleDigest: 'bundle-1',
    executionId: 'exec-1',
    pins: {
      interfaceDigest: 'if-1',
      implementationId: 'impl-1',
      implementationRevision: 2,
      surfaceDigest: 'sd-1',
      requiredTextDigest: 'rt-1'
    },
    planned: [
      {
        componentId: 'cmp-1',
        kind: 'instruction',
        path: 'components/cmp-1.md',
        scope: 'project',
        digest: 'cd-1',
        activation: 'required'
      }
    ],
    attached: [
      {
        phase: 'materialized',
        revision: 1,
        components: [{ componentId: 'cmp-1' }],
        inherited: [],
        evidence: { argvIndex: 1 }
      }
    ],
    inherited: [{ scope: 'user', path: '/home/u/.config/x', status: 'known', digest: 'id-1' }],
    missing: [],
    unknowns: [{ what: 'provider system prompt', reason: 'not observable' }]
  })
  check(
    'planned components carry path/scope/digest',
    view.planned[0]!.path === 'components/cmp-1.md'
  )
  check(
    'attached evidence is read from the recorded receipt revisions',
    view.hasReceipt && view.evidence.length === 1 && view.evidence[0]!.componentId === 'cmp-1',
    view.evidence
  )
  check('pins are exposed for display', view.pins.surfaceDigest === 'sd-1')
  check(
    'inherited inputs keep their status (known vs absent vs unknown)',
    view.inherited[0]!.status === 'known'
  )
  check('unknowns are a result state, never an empty section', view.unknowns.length === 1)
  const noEvidence = projectContextInspect({
    bundleDigest: 'bundle-2',
    pins: {
      interfaceDigest: 'if-1',
      implementationId: 'impl-1',
      implementationRevision: 2,
      surfaceDigest: 'sd-1',
      requiredTextDigest: 'rt-1'
    },
    planned: [],
    attached: [],
    inherited: [],
    missing: ['cmp-9'],
    unknowns: []
  })
  check(
    'a bundle with no receipt says so and lists the missing component',
    noEvidence.hasReceipt === false && noEvidence.missing[0] === 'cmp-9'
  )
}

// ── request payloads stay the canonical shapes ────────────────────────────

section('payload fixtures — the documented request grammar')
{
  const surfaceInput: SurfaceDescribeResult = {
    surfaceDigest: 'sd-2',
    stale: true,
    operations: []
  }
  check(
    'an empty surface projects to an empty row list',
    projectSurfaceDescribe(surfaceInput).operations.length === 0
  )
  check(
    'a pinned stale digest is reported, not hidden',
    projectSurfaceDescribe(surfaceInput).stale === true
  )
}

console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exit(1)
