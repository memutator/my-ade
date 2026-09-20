// workbench/store.smoke.ts — focused fixtures for the workbench scope.
//
// What these fixtures are - and are not: they exercise the pure scope/queue/
// mapper logic (isolation, incompatible-context reset, server-declared head
// semantics, per project/run queue handoff, request payload grammar) with
// synthetic data. They do not touch a control plane, a database, or a real
// provider API, and they do not prove the desktop transport works.
//
// Run: node src/renderer/src/workbench/store.smoke.ts

import assert from 'node:assert/strict'
import type { OpCaller } from './client.ts'
import { newOperationId } from './client.ts'
import { previewAssignment, searchResponsibilities } from './ops.ts'
import { WorkbenchQueueRegistry, queueKey } from './queues.ts'
import { createWorkbenchScope, isResultStale } from './store.ts'
import type { SearchResult } from './contracts.ts'
import type { InputBindingWire } from './contracts.ts'
import {
  toAssignRequest,
  toPlacementIntent,
  toPreviewRequest,
  type AssignmentForm
} from './assignment.ts'
import { toPlanPatch, type PlanDraftModel } from './plan-drafts.ts'
import { toSearchViewModel } from './view-model.ts'

let failures = 0
let checks = 0

function check(name: string, fn: () => void): void {
  checks += 1
  try {
    fn()
    console.log('  ok   ' + name)
  } catch (e) {
    failures += 1
    console.log('  FAIL ' + name)
    console.log('       ' + (e instanceof Error ? e.message : String(e)))
  }
}

async function scenario(title: string, fn: () => void | Promise<void>): Promise<void> {
  console.log('\n' + title)
  await fn()
}

// ── synthetic fixtures ─────────────────────────────────────────────────────

function card(token: string, boundaryId: string, roleId: string): SearchResult['items'][number] {
  return {
    boundary: { id: boundaryId, name: boundaryId, responsibility: 'r', criteria: [] },
    role: { id: roleId, name: roleId, description: 'd', horizontalRole: 'impl' },
    matchReasons: [],
    relationshipRefs: [],
    implementationAvailability: [],
    memberAvailability: [],
    scopeCoverage: { matchedPaths: [], matchedContractIds: [], coversScope: true },
    selectionToken: token
  }
}

function searchResult(modelVersion: string, staleModel: boolean, token: string): SearchResult {
  return {
    modelVersion,
    snapshotRevision: 7,
    staleModel,
    status: 'ok',
    items: [card(token, 'bnd-' + token, 'role-' + token)],
    unmatchedPaths: [],
    ambiguityGroups: [],
    diagnostics: { rolelessBoundaryIds: [], unmatchedContractIds: [] },
    visibility: { visibilityDigest: 'vd', grantRevisions: {} }
  }
}

function form(overrides: Partial<AssignmentForm> = {}): AssignmentForm {
  return {
    assignmentKind: 'task',
    mandateText: 'do the thing',
    taskId: '',
    taskRevision: '',
    placementKind: '',
    placementHostId: '',
    placementTargetPath: '',
    placementProjectRoot: '',
    placementCheckoutId: '',
    expectedPlanRevision: '',
    ...overrides
  }
}

// ── 1. scope isolation ────────────────────────────────────────────────────

await scenario('unconnected — a mount without a domain project id stays empty', () => {
  const scope = createWorkbenchScope()
  check('default projectId is empty, not a desktop folder uid', () => {
    assert.equal(scope.store.getState().context.projectId, '')
  })
})

await scenario('isolation — one mounted widget never rewrites another mount', () => {
  const queues = new WorkbenchQueueRegistry()
  const a = createWorkbenchScope({ projectId: 'proj-a', runId: 'run-1', queues })
  const b = createWorkbenchScope({ projectId: 'proj-b', runId: 'run-9', queues })

  check('a background mount converges on its own context', () => {
    a.actions.setContext({ projectId: 'proj-b' })
    assert.equal(b.store.getState().context.projectId, 'proj-b')
    assert.equal(a.store.getState().context.projectId, 'proj-b')
    // and the sibling that was not touched keeps its own context
    const c = createWorkbenchScope({ projectId: 'proj-c', runId: 'run-3', queues })
    a.actions.setContext({ projectId: 'proj-a', runId: 'run-1' })
    assert.equal(c.store.getState().context.projectId, 'proj-c')
    assert.equal(c.store.getState().context.runId, 'run-3')
  })

  check('model head and implementation choice stay inside their scope', () => {
    a.actions.noteHead({ modelVersion: 'mv-1', declaredBy: 'search', current: true })
    assert.equal(a.store.getState().head?.modelVersion, 'mv-1')
    assert.equal(b.store.getState().head, null)
    b.actions.chooseImpl('tok-x', {
      implementationId: 'impl-1',
      implementationRevision: 1,
      interfaceDigest: 'd',
      profileId: 'p',
      profileRevision: 1,
      status: 'published',
      profileState: 'verified',
      support: 'verified',
      blockers: [],
      observedAt: 1
    })
    assert.equal(a.store.getState().implChoices['tok-x'], undefined)
    assert.ok(b.store.getState().implChoices['tok-x'])
  })
})

// ── 2. incompatible context reset ─────────────────────────────────────────

await scenario('context reset — pins never carry across an incompatible move', () => {
  const scope = createWorkbenchScope({ projectId: 'proj-a', runId: 'run-1' })
  scope.actions.setContext({ modelVersion: 'mv-pin' })
  scope.actions.noteHead({ modelVersion: 'mv-head', declaredBy: 'run', current: true })

  check('a project move drops the other project pins and the head', () => {
    scope.actions.setContext({ projectId: 'proj-z' })
    assert.deepEqual(scope.store.getState().context, {
      projectId: 'proj-z',
      modelVersion: '',
      runId: ''
    })
    assert.equal(scope.store.getState().head, null)
  })

  check('a patch that declares the new context applies all of it', () => {
    scope.actions.setContext({ projectId: 'proj-a', modelVersion: 'mv-2', runId: 'run-2' })
    assert.deepEqual(scope.store.getState().context, {
      projectId: 'proj-a',
      modelVersion: 'mv-2',
      runId: 'run-2'
    })
  })

  check('a run move clears the pin and the head', () => {
    scope.actions.setContext({ modelVersion: 'mv-3' })
    scope.actions.noteHead({ modelVersion: 'mv-3', declaredBy: 'run', current: true })
    scope.actions.setContext({ runId: 'run-3' })
    assert.equal(scope.store.getState().context.modelVersion, '')
    assert.equal(scope.store.getState().context.runId, 'run-3')
    assert.equal(scope.store.getState().head, null)
  })

  check('an unchanged context is not a reset', () => {
    scope.actions.setContext({ modelVersion: 'mv-4' })
    scope.actions.noteHead({ modelVersion: 'mv-4', declaredBy: 'search', current: true })
    scope.actions.setContext({ projectId: 'proj-a', modelVersion: 'mv-4', runId: 'run-3' })
    assert.equal(scope.store.getState().context.modelVersion, 'mv-4')
    assert.equal(scope.store.getState().head?.modelVersion, 'mv-4')
  })
})

// ── 3. head semantics (no opaque id ordering) ─────────────────────────────

await scenario('head — the server declares it; ids are never ordered', () => {
  const scope = createWorkbenchScope({ projectId: 'proj-a' })

  check('a lexically smaller id still becomes the head when declared current', () => {
    // 'mv-9' > 'mv-10' as strings: an ordering client would refuse this move
    assert.ok('mv-9' > 'mv-10')
    scope.actions.noteHead({ modelVersion: 'mv-9', declaredBy: 'search', current: true })
    scope.actions.noteHead({ modelVersion: 'mv-10', declaredBy: 'run', current: true })
    assert.equal(scope.store.getState().head?.modelVersion, 'mv-10')
  })

  check('a behind-the-head response never moves the head', () => {
    const moved = scope.actions.noteHead({
      modelVersion: 'mv-8',
      declaredBy: 'search',
      current: false
    })
    assert.equal(moved, false)
    assert.equal(scope.store.getState().head?.modelVersion, 'mv-10')
  })

  check('staleness: server flag first, then head identity, never an ordering', () => {
    const head = scope.store.getState().head
    assert.equal(isResultStale('mv-10', false, head), false)
    assert.equal(isResultStale('mv-9', false, head), true)
    assert.equal(isResultStale('mv-9', true, head), true)
    assert.equal(isResultStale('mv-9', false, null), false)
    assert.equal(isResultStale(undefined, undefined, head), false)
  })
})

// ── 4. queue: per project/run handoff ─────────────────────────────────────

await scenario('queue — handoff inside a project/run, isolation across them', () => {
  const queues = new WorkbenchQueueRegistry()
  const find = createWorkbenchScope({ projectId: 'proj-a', runId: 'run-1', queues })
  const assign = createWorkbenchScope({ projectId: 'proj-a', runId: 'run-1', queues })
  const otherRun = createWorkbenchScope({ projectId: 'proj-a', runId: 'run-2', queues })
  const otherProject = createWorkbenchScope({ projectId: 'proj-b', runId: 'run-1', queues })

  check('a candidate queued in the find widget reaches the assign widget', () => {
    find.actions.queueCandidate(card('tok-1', 'b-1', 'r-1'), 'mv-1', false)
    assert.equal(assign.queueSnapshot().length, 1)
    assert.equal(assign.queueSnapshot()[0]?.card.selectionToken, 'tok-1')
  })

  check('the same run of another project and another run see nothing', () => {
    assert.equal(otherRun.queueSnapshot().length, 0)
    assert.equal(otherProject.queueSnapshot().length, 0)
  })

  check('queueing the same token twice keeps one entry', () => {
    find.actions.queueCandidate(card('tok-1', 'b-1', 'r-1'), 'mv-1', false)
    assert.equal(find.queueSnapshot().length, 1)
  })

  check('leaving and returning restores that run queue', () => {
    find.actions.setContext({ runId: 'run-2' })
    assert.equal(find.queueSnapshot().length, 0)
    find.actions.queueCandidate(card('tok-2', 'b-2', 'r-2'), 'mv-1', false)
    find.actions.setContext({ runId: 'run-1' })
    assert.deepEqual(
      find.queueSnapshot().map((e) => e.card.selectionToken),
      ['tok-1']
    )
    assert.deepEqual(
      otherRun
        .queueSnapshot()
        .map((e) => e.card.selectionToken)
        .filter((token) => token === 'tok-2'),
      ['tok-2']
    )
  })

  check('unqueue and clear only touch their own key', () => {
    find.actions.unqueueCandidate('tok-1')
    assert.equal(find.queueSnapshot().length, 0)
    assert.equal(otherRun.queueSnapshot().length, 1)
    otherRun.actions.clearQueue()
    assert.equal(otherRun.queueSnapshot().length, 0)
    assert.equal(queueKey({ projectId: 'proj-a', runId: 'run-1' }), 'proj-a\u0000run-1')
    assert.notEqual(
      queueKey({ projectId: 'proj-a', runId: 'run-1' }),
      queueKey({ projectId: 'proj-a', runId: 'run-2' })
    )
  })
})

// ── 5. request payloads (runtime-aligned grammar) ─────────────────────────

await scenario('payloads — preview vs assign, and the PlanPatch grammar', () => {
  const preview = toPreviewRequest(
    'run-1',
    'tok-1',
    'impl-1',
    3,
    form({
      taskId: 'tsk-1',
      taskRevision: '2',
      expectedPlanRevision: '5'
    })
  )
  const assignPayload = toAssignRequest(
    'run-1',
    'tok-1',
    'impl-1',
    3,
    form({
      taskId: 'tsk-1',
      taskRevision: '2',
      expectedPlanRevision: '5'
    })
  )

  check('preview carries no plan CAS; assign does', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(preview, 'expectedPlanRevision'), false)
    assert.equal(assignPayload.expectedPlanRevision, 5)
    assert.equal(assignPayload.taskId, 'tsk-1')
    assert.equal(assignPayload.taskRevision, 2)
  })

  check('a coordination assignment sends no task fields', () => {
    const coordination = toAssignRequest(
      'run-1',
      'tok-1',
      'impl-1',
      3,
      form({ assignmentKind: 'coordination', taskId: 'tsk-1', taskRevision: '2' })
    )
    assert.equal(coordination.taskId, undefined)
    assert.equal(coordination.taskRevision, undefined)
  })

  check('placement intent carries only the fields that were filled', () => {
    assert.equal(toPlacementIntent(form()), undefined)
    assert.deepEqual(
      toPlacementIntent(form({ placementKind: 'worktree', placementHostId: 'h1' })),
      {
        kind: 'worktree',
        hostId: 'h1'
      }
    )
  })

  const drafts: PlanDraftModel = {
    baseRevision: 4,
    tasks: [
      {
        key: 'k1',
        taskId: 'tsk-1',
        title: 'title',
        requirementText: 'req',
        ownerRoleId: 'role-1',
        assignedMemberId: '',
        assignedMemberIdWas: 'mem-1',
        retired: false,
        disposition: 'revoke',
        inputs: [
          {
            // a stored field this editor does not model — the fixture checks
            // it survives a partial edit instead of being dropped
            raw: {
              slot: 'in',
              kind: 'task-output',
              taskId: 'tsk-1',
              outputSlot: 'out',
              extra: 'kept'
            } as unknown as InputBindingWire,
            slot: 'in',
            kind: 'task-output',
            required: true,
            taskId: 'tsk-1',
            taskRevision: '',
            outputSlot: 'out',
            artifactId: '',
            artifactRevision: '',
            contractId: '',
            contractRevision: '',
            modelVersion: ''
          }
        ],
        outputs: [
          {
            raw: { slot: 'out', required: true },
            slot: 'out',
            description: '',
            contractId: '',
            required: true
          }
        ],
        settlementText: '{"policy":"accepted"}',
        settlementTextWas: ''
      },
      {
        key: 'k2',
        taskId: '',
        title: '',
        requirementText: '',
        ownerRoleId: '',
        assignedMemberId: '',
        assignedMemberIdWas: '',
        retired: false,
        disposition: 'keep',
        inputs: [],
        outputs: [],
        settlementText: '',
        settlementTextWas: ''
      },
      {
        key: 'k3',
        taskId: 'tsk-3',
        title: 't3',
        requirementText: 'r3',
        ownerRoleId: 'role-1',
        assignedMemberId: '',
        assignedMemberIdWas: '',
        retired: true,
        disposition: 'revoke',
        inputs: [],
        outputs: [],
        settlementText: '',
        settlementTextWas: ''
      }
    ],
    edges: [
      {
        key: 'e1',
        fromTask: 'tsk-1',
        toTask: '',
        requiredOutputs: 'out',
        settlementRequirement: ''
      },
      {
        key: 'e2',
        fromTask: 'tsk-1',
        toTask: 'tsk-3',
        requiredOutputs: 'out, val',
        settlementRequirement: 'accepted'
      }
    ]
  }
  const patch = toPlanPatch(drafts, new Map())

  check('the patch uses the contract grammar only', () => {
    const task = patch.tasks?.[0]
    assert.ok(task)
    assert.equal(Object.prototype.hasOwnProperty.call(task, 'inputBindings'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(task, 'outputSlots'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(task, 'revision'), false)
    assert.equal(task.assignedMemberId, null)
    assert.deepEqual(Object.keys(task.inputs?.[0] ?? {}).sort(), [
      'extra',
      'kind',
      'outputSlot',
      'required',
      'slot',
      'taskId'
    ])
    assert.equal((task.inputs?.[0] as { extra?: string }).extra, 'kept')
    assert.deepEqual(task.settlementPolicy, { policy: 'accepted' })
  })

  check('a new task sends no taskId; retire and dispositions stay explicit', () => {
    const fresh = patch.tasks?.[1]
    assert.ok(fresh)
    assert.equal(fresh.taskId, undefined)
    assert.deepEqual(patch.retireTaskIds, ['tsk-3'])
    assert.deepEqual(
      patch.activeAttemptDisposition?.map((d) => d.taskId + ':' + d.action),
      ['tsk-1:revoke', 'tsk-3:revoke']
    )
  })

  check('an endpoint-less edge is not sent', () => {
    assert.equal(patch.edges?.length, 1)
    assert.deepEqual(patch.edges?.[0], {
      fromTask: 'tsk-1',
      toTask: 'tsk-3',
      requiredOutputs: ['out', 'val'],
      settlementRequirement: 'accepted'
    })
  })
})

// ── 6. ops seam ───────────────────────────────────────────────────────────

await scenario('ops — canonical result mapping and mutation ids', async () => {
  const seen: { operation: string; payload: unknown; operationId?: string }[] = []
  const caller: OpCaller = async (operation, payload, opts) => {
    seen.push({ operation, payload, operationId: opts?.operationId })
    if (operation === 'responsibility.search') return searchResult('mv-1', false, 'tok-1') as never
    return { ok: true } as never
  }

  const model = await searchResponsibilities(caller, { projectId: 'proj-a' })
  assert.equal(seen[0]?.operation, 'responsibility.search')
  assert.deepEqual(seen[0]?.payload, { projectId: 'proj-a' })
  assert.equal(model.candidates.length, 1)
  assert.equal(model.staleModel, false)
  assert.equal(toSearchViewModel(searchResult('mv-2', true, 'tok-2')).staleModel, true)

  await previewAssignment(caller, {
    runId: 'run-1',
    selectionToken: 'tok-1',
    implementationId: 'impl-1',
    implementationRevision: 1,
    assignmentKind: 'task',
    mandateText: 'm'
  })
  assert.equal(seen[1]?.operation, 'assignment.preview')
  assert.ok(seen[1]?.operationId, 'a mutation call carries an idempotency key')
  assert.equal(newOperationId().length > 0, true)
})

console.log(
  '\n' + (failures ? 'FAIL ' + failures + '/' + checks : 'PASS all ' + checks + ' checks')
)
if (failures) process.exitCode = 1
