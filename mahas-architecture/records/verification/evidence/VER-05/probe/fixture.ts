// VER-05 fixture — model + roles + contexts + interfaces + profile + impls +
// run + tasks + members, built through the real dispatch pipeline (in-process
// registry — same operations, same admission as the socket path).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { REPO_ROOT, q1, type Receipt } from './common.ts'

export type Dispatch = (ctx: unknown, op: string, payload?: unknown, opId?: string) => Promise<Receipt>
export interface Ctx { [k: string]: unknown }

/** repo-relative source paths pinned into the fixture model */
export const SHARED_SRC = 'src/shared/ver05-source.md'   // same source for all 3 roles
export const CHARTER_SRC = 'src/charter/root-charter.md' // parent long-form source

export const ROLE_IDS = ['r-lead', 'r-asm', 'r-tool'] as const

export interface MemberFixture {
  memberId: string
  assignmentId: string
  assignmentRevision: number
  grantId: string
  grantRevision: number
  grantActions: string[]
  taskId?: string
}

export interface ModelFixture {
  projectId: string
  mv1: string
  runId: string
  ifaceDigest: Record<string, string>
  ifaceClauses: Record<string, string[]>
  impls: Record<string, { implId: string; revision: number }>
  provAll: { grantId: string; revision: number }
  profileId: string
  profileRevision: number
  taskIds: Record<string, string>
  planRevision: number
}

export interface Fixture extends ModelFixture {
  members: { lead: MemberFixture; asm: MemberFixture; tool: MemberFixture }
}

function must(r: Receipt, what: string): Receipt {
  if (r.status !== 'committed') {
    throw new Error(
      `${what}: expected committed, got ${r.status} ${r.error?.code ?? ''} ${r.error?.message ?? ''}`
    )
  }
  return r
}

/** member vocabulary — same derivation as VER-03 (coordination/member.ts). */
const BASE_ACTIONS = [
  'surface.describe', 'operation.get', 'assignment.show', 'inbox.check', 'inbox.wait',
  'delivery.ack', 'message.send', 'message.replyAndAck', 'artifact.read'
]
export const COORD_ACTIONS = [
  ...BASE_ACTIONS,
  'responsibility.search', 'responsibility.inspect', 'responsibility.locate',
  'responsibility.collaborators', 'role.implementations', 'assignment.preview',
  'run.get', 'run.close', 'plan.prepare', 'plan.commit', 'team.assign', 'team.retire',
  'task.dispatch', 'worker.prepare', 'worker.start', 'worker.inspect', 'worker.stop',
  'worker.resume', 'worker.release', 'execution.wake', 'outcome.decide', 'model.impact.list',
  'workspace.prepare', 'workspace.inspect'
]
export const TASK_ACTIONS = [
  ...BASE_ACTIONS,
  'execution.join', 'execution.heartbeat', 'task.accept', 'task.report', 'artifact.publish',
  'workspace.prepare', 'workspace.inspect'
]
export const PROV_ACTIONS = [...new Set([...COORD_ACTIONS, ...TASK_ACTIONS])]

/** write the source files the model binds (real bytes under REPO_ROOT) */
export function writeRepoFiles(): void {
  mkdirSync(join(REPO_ROOT, 'src/shared'), { recursive: true })
  mkdirSync(join(REPO_ROOT, 'src/charter'), { recursive: true })
  writeFileSync(
    join(REPO_ROOT, SHARED_SRC),
    [
      '# VER-05 shared source — identical bytes bound into three roles',
      '',
      'SHARED-MARKER-7f3a91 — the common contract body every role must carry.',
      '이 문장은 팀장/조립/tool 세 역할의 mandatory text에 동일하게 실려야 한다.',
      'Line three: 0123456789abcdefghijklmnopqrstuvwxyz deterministic bytes.',
      ''
    ].join('\n')
  )
  writeFileSync(
    join(REPO_ROOT, CHARTER_SRC),
    [
      '# VER-05 root charter — parent long-form text',
      '',
      'CHARTER-MARKER-4c2e08 — this body must NOT be auto-injected into role',
      'mandatory text when the clause is realized as reexpressed. It may only',
      'arrive through an explicit verbatim section.source pin.',
      ''
    ].join('\n')
  )
}

export async function buildModelFixture(dispatch: Dispatch, ctx: Ctx): Promise<ModelFixture> {
  writeRepoFiles()

  const rCreate = must(
    await dispatch(ctx, 'project.create', {
      name: 'ver05-product',
      repositoryRoot: REPO_ROOT,
      goal: 'VER-05 fixture — shared source, three role shapes'
    }),
    'project.create'
  )
  const projectId = (rCreate.result as { projectId: string }).projectId
  const mv0 = (rCreate.result as { draftModelVersion: string }).draftModelVersion

  const edits: unknown[] = [
    { type: 'horizontalRole.revise', name: 'coordinator' },
    { type: 'horizontalRole.revise', name: 'worker' },
    { type: 'context.register', context: { id: 'ctx-shared', path: SHARED_SRC } },
    { type: 'context.register', context: { id: 'ctx-charter', path: CHARTER_SRC } },
    {
      type: 'boundary.create',
      boundary: {
        id: 'b-root',
        name: 'product-root',
        responsibility: 'VER-05 루트 책임 — 세 역할이 같은 원본을 공유',
        parentId: null,
        paths: [{ path: 'src', kind: 'directory' }],
        criteria: [
          { id: 'crit-root-1', criterion: '공유 원본이 mandatory text에 도달한다', description: 'shared delivery' }
        ],
        contextIds: ['ctx-shared', 'ctx-charter']
      }
    },
    {
      type: 'role.define',
      role: { id: 'r-lead', name: 'team-lead', description: '조정 팀장 — 책임 검색·팀 배정', boundaryId: 'b-root', horizontalRoleName: 'coordinator' }
    },
    {
      type: 'role.define',
      role: { id: 'r-asm', name: 'assembly', description: '조립 워커 — 태스크 수행', boundaryId: 'b-root', horizontalRoleName: 'worker' }
    },
    {
      type: 'role.define',
      role: { id: 'r-tool', name: 'tool-role', description: 'tool-carrying worker', boundaryId: 'b-root', horizontalRoleName: 'worker' }
    }
  ]
  const rPrep = must(
    await dispatch(ctx, 'model.change.prepare', { projectId, baseVersion: mv0, edits }),
    'model.change.prepare'
  )
  const prep = rPrep.result as { changeId: string; candidateDigest: string; structuralErrors: { code: string }[] }
  if (prep.structuralErrors.length) {
    throw new Error(`model structural errors: ${JSON.stringify(prep.structuralErrors)}`)
  }
  must(
    await dispatch(ctx, 'model.change.commit', {
      changeId: prep.changeId,
      candidateDigest: prep.candidateDigest,
      expectedActiveVersion: null,
      semanticDecision: 'VER-05 v1 publish'
    }),
    'model.change.commit'
  )
  const mv1 = (
    (must(await dispatch(ctx, 'project.get', { projectId }), 'project.get').result) as {
      activeModelVersion: string
    }
  ).activeModelVersion

  const ifaceDigest: Record<string, string> = {}
  const ifaceClauses: Record<string, string[]> = {}
  for (const roleId of ROLE_IDS) {
    const r = must(await dispatch(ctx, 'interface.get', { modelVersion: mv1, roleId }), `interface.get ${roleId}`)
    ifaceDigest[roleId] = (r.result as { digest: string }).digest
    ifaceClauses[roleId] = (
      (r.result as { contextRequirements: { clauseId: string }[] }).contextRequirements ?? []
    ).map((x) => x.clauseId)
  }

  must(
    await dispatch(ctx, 'harness.profile.register', {
      profileId: 'hp-main',
      executableLocator: '/usr/bin/mahas-ver05-harness',
      versionRange: '>=1.0.0 <2.0.0',
      supportedComponents: ['instruction', 'skill', 'subagent', 'tool-config', 'launch-config'],
      injectionRecipe: { routes: ['instruction-file', 'instruction-text', 'confirmed-preload'] }
    }),
    'harness.profile.register'
  )
  const rAdmit = must(
    await dispatch(ctx, 'harness.profile.admit', {
      profileId: 'hp-main',
      profileRevision: 1,
      attestation: { decision: 'verified', evidence: [{ kind: 'test-launch', summary: 'VER-05 harness admission' }] },
      expectedExecutableIdentity: { locator: '/usr/bin/mahas-ver05-harness', versionRange: '>=1.0.0 <2.0.0' }
    }),
    'harness.profile.admit'
  )
  const profileRevision = (rAdmit.result as { revision: number }).revision

  // Tier-A impls — authored through the real implementation.prepare/publish ops.
  // (context.build's verdict on these rows is itself part of the evidence.)
  const impls: Record<string, { implId: string; revision: number }> = {}
  for (const roleId of ROLE_IDS) {
    const clauses = ifaceClauses[roleId]!
    const prepR = must(
      await dispatch(ctx, 'implementation.prepare', {
        interfaceDigest: ifaceDigest[roleId],
        profileId: 'hp-main',
        profileRevision,
        maintainerRoleId: 'r-lead',
        componentGraph: {
          components: [
            {
              componentId: 'comp-core',
              kind: 'instruction',
              contentBinding: { text: `VER-05 authored instruction for ${roleId}` },
              consumes: [],
              outputs: [],
              activation: { phase: 'initial' },
              permissionRequirements: []
            }
          ]
        },
        coverageBindings: clauses.map((clauseId) => ({
          clauseId,
          componentId: 'comp-core',
          sectionKey: 'main',
          realization: 'reexpressed',
          requiredLoadPhase: 'initial'
        }))
      }),
      `implementation.prepare ${roleId}`
    )
    const pr = prepR.result as { candidateImplementation: { implementationId: string }; digest: string }
    const pubR = must(
      await dispatch(ctx, 'implementation.publish', {
        candidateId: pr.candidateImplementation.implementationId,
        candidateDigest: pr.digest,
        expectedInterfaceDigest: ifaceDigest[roleId],
        semanticDecision: { statement: `VER-05 ${roleId} impl` }
      }),
      `implementation.publish ${roleId}`
    )
    impls[roleId] = {
      implId: (pubR.result as { implementationId: string }).implementationId,
      revision: (pubR.result as { revision: number }).revision
    }
  }

  const rRun = must(
    await dispatch(ctx, 'run.create', {
      projectId,
      modelVersion: mv1,
      goalText: 'VER-05 run — injection verification',
      coordinatorRoleId: 'r-lead',
      purpose: 'work'
    }),
    'run.create'
  )
  const runId = ((rRun.result as { runId?: string; id?: string }).runId ??
    (rRun.result as { id?: string }).id) as string

  const rProvAll = must(
    await dispatch(ctx, 'access.grant', {
      kind: 'provisioning',
      subject: { principalId: 'operator-local' },
      scope: {
        targets: [{ kind: 'project', id: projectId }],
        provisioning: {
          allowedRoleIds: [...ROLE_IDS],
          placementScope: [{ kind: 'project', id: projectId }],
          profileAdmission: 'verified-only'
        }
      },
      actions: PROV_ACTIONS
    }),
    'access.grant provAll'
  )
  const provAll = rProvAll.result as { grantId: string; revision: number }

  return {
    projectId,
    mv1,
    runId,
    ifaceDigest,
    ifaceClauses,
    impls,
    provAll,
    profileId: 'hp-main',
    profileRevision,
    taskIds: {},
    planRevision: 0
  }
}

/** negotiation plan → task_specs rows (t-asm → r-asm, t-tool → r-tool) */
export async function commitNegotiationPlan(dispatch: Dispatch, ctx: Ctx, runId: string): Promise<number> {
  const rPlanPrep = must(
    await dispatch(ctx, 'plan.prepare', {
      runId,
      patch: {
        tasks: [
          { taskId: 't-asm', title: '조립 태스크', requirementText: '공유 원본을 사용해 조립 결과를 산출한다', ownerRoleId: 'r-asm' },
          { taskId: 't-tool', title: 'tool 태스크', requirementText: '승인된 도구로 검증 산출물을 만든다', ownerRoleId: 'r-tool' }
        ]
      }
    }),
    'plan.prepare'
  )
  const planPrep = rPlanPrep.result as { candidatePlanId: string; digest: string }
  const rCommit = must(
    await dispatch(ctx, 'plan.commit', {
      candidatePlanId: planPrep.candidatePlanId,
      digest: planPrep.digest,
      expectedPlanRevision: 0
    }),
    'plan.commit'
  )
  return (rCommit.result as { planRevision: number }).planRevision
}

/** member principal + member + assignment + real access.grant (VER-03 pattern) */
export async function seedMember(
  db: DatabaseSync,
  dispatch: Dispatch,
  ctx: Ctx,
  fx: ModelFixture,
  opts: { roleId: string; kind: 'coordination' | 'task'; taskId?: string; mandate: string }
): Promise<MemberFixture> {
  const memberId = `mem-ver05-${opts.roleId}-${Math.random().toString(36).slice(2, 8)}`
  const assignmentId = `asg-ver05-${opts.roleId}-${Math.random().toString(36).slice(2, 8)}`
  const impl = fx.impls[opts.roleId]!
  const actions = opts.kind === 'coordination' ? COORD_ACTIONS : TASK_ACTIONS
  const boundaryId = 'b-root'

  db.prepare("INSERT INTO principals(id,kind,status) VALUES(?,'member','active')").run(memberId)
  db.prepare(
    "INSERT INTO members(id,run_id,model_version,role_id,implementation_id,implementation_revision,generation,current_execution_id,state,revision) VALUES(?,?,?,?,?,?,1,NULL,'assigned',1)"
  ).run(memberId, fx.runId, fx.mv1, opts.roleId, impl.implId, impl.revision)

  const scope = {
    runId: fx.runId,
    roleId: opts.roleId,
    boundaryId,
    taskIds: opts.taskId ? [opts.taskId] : [],
    placement: {},
    parentProvisioningGrant: fx.provAll.grantId
  }
  const rGrant = must(
    await dispatch(ctx, 'access.grant', {
      kind: 'assignment',
      subject: { principalId: memberId },
      scope,
      actions,
      parentGrantId: fx.provAll.grantId
    }),
    `access.grant member ${opts.roleId}`
  )
  const g = rGrant.result as { grantId: string; revision: number }

  db.prepare(
    'INSERT INTO assignments(id,revision,member_id,kind,mandate_text,grant_id,task_id,task_revision,scope_json) VALUES(?,1,?,?,?,?,?,?,?)'
  ).run(
    assignmentId,
    memberId,
    opts.kind,
    opts.mandate,
    g.grantId,
    opts.taskId ?? null,
    opts.taskId ? 1 : null,
    JSON.stringify(scope)
  )
  if (opts.kind === 'coordination') {
    db.prepare('UPDATE runs SET coordinator_member_id=?, revision=revision+1 WHERE id=?').run(memberId, fx.runId)
  }
  return {
    memberId,
    assignmentId,
    assignmentRevision: 1,
    grantId: g.grantId,
    grantRevision: g.revision,
    grantActions: actions,
    ...(opts.taskId ? { taskId: opts.taskId } : {})
  }
}
