// workbench/PlanView.tsx — META DAG 작업대 (C-WORK §plan).
//
// Edits are a PlanPatch against the run's plan revision: task requirement /
// inputs / outputs / settlement-policy drafts, execution-order edges,
// retireTaskIds and explicit active-attempt dispositions. Nothing mutates in
// place — plan.prepare stamps a candidate, plan.commit (CAS on
// expectedPlanRevision) publishes a NEW plan revision.
//
// Edges are execution order only. The editor offers dependency edges with
// required outputs and a settlement requirement — there is deliberately no
// "they talk to each other" edge kind; members converse by mail, not by DAG
// edge (work.md Plan 문법).
//
// The drafts and the patch are built by view-model.ts mappers against the
// canonical DTOs: a field the contract does not define is never sent, and the
// fields this editor does not model are carried back untouched.

import { useState } from 'react'
import { GitBranch, Plus, Trash2 } from 'lucide-react'
import { useT } from '../i18n.ts'
import { opError, opErrorKind, type OpErrorKind } from './client.ts'
import { commitPlan, getRun, preparePlan } from './ops.ts'
import type {
  CoordinatorRunProjection,
  PendingInput,
  PlanCommitResult,
  PlanPrepareResult,
  TaskEligibility,
  TaskSpecProjection
} from './contracts.ts'
import {
  newEdgeDraft,
  newInputDraft,
  newOutputDraft,
  newTaskDraft,
  readPlanDrafts,
  toPlanPatch,
  type EdgeDraft,
  type InputBindingDraft,
  type OutputSlotDraft,
  type PlanDraftModel,
  type TaskSpecDraft
} from './plan-drafts.ts'
import { useScopeCaller, useWorkbenchActions, useWorkbenchContext } from './scope.ts'
import { ContextBar, Field, KV, OpError, Pill, Section, TextLines } from './bits.tsx'

const pendingText = (p: PendingInput): string => `${p.slot} (${p.kind}) — ${p.reason}`

const eligibilityText = (e: TaskEligibility): string => {
  const parts = [`${e.taskId}@${e.taskRevision} · ${e.state}`]
  if (e.assignedMemberId) parts.push(`member ${e.assignedMemberId}`)
  if (e.blockedReasons.length) parts.push(e.blockedReasons.join('; '))
  if (e.pendingInputs.length) parts.push(`pending: ${e.pendingInputs.map(pendingText).join(', ')}`)
  return parts.join(' — ')
}

export default function PlanView(): React.JSX.Element {
  const t = useT()
  const call = useScopeCaller()
  const { runId } = useWorkbenchContext()
  const { noteHead } = useWorkbenchActions()
  const [projection, setProjection] = useState<CoordinatorRunProjection | null>(null)
  const [loadedSpecs, setLoadedSpecs] = useState<Map<string, TaskSpecProjection>>(new Map())
  const [drafts, setDrafts] = useState<PlanDraftModel>({ tasks: [], edges: [] })
  const [prepared, setPrepared] = useState<PlanPrepareResult | null>(null)
  const [committed, setCommitted] = useState<PlanCommitResult | null>(null)
  const [err, setErr] = useState<{ kind: OpErrorKind; msg: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const fail = (e: unknown): void => {
    setErr({ kind: opErrorKind(e), msg: opError(e).message })
  }

  const loadRun = (): void => {
    setErr(null)
    getRun(call, { runId, projection: 'coordinator' })
      .then((r) => {
        setProjection(r)
        setLoadedSpecs(new Map(r.planTasks.map((spec) => [spec.taskId, spec])))
        setDrafts(readPlanDrafts(r))
        // run.get names the run's pinned model — the base every work
        // mutation is checked against, so it IS the current head here
        noteHead({
          modelVersion: r.run.modelVersion,
          declaredBy: 'run',
          current: true
        })
        setPrepared(null)
      })
      .catch(fail)
  }

  const patchTask = (key: string, p: Partial<TaskSpecDraft>): void =>
    setDrafts((d) => ({
      ...d,
      tasks: d.tasks.map((task) => (task.key === key ? { ...task, ...p } : task))
    }))

  const patchInputs = (key: string, inputs: InputBindingDraft[]): void => patchTask(key, { inputs })

  const patchOutputs = (key: string, outputs: OutputSlotDraft[]): void =>
    patchTask(key, { outputs })

  const doPrepare = (): void => {
    if (!runId) return
    setBusy(true)
    setErr(null)
    setCommitted(null)
    preparePlan(call, { runId, patch: toPlanPatch(drafts, loadedSpecs) })
      .then(setPrepared)
      .catch(fail)
      .finally(() => setBusy(false))
  }

  const doCommit = (): void => {
    if (!prepared || drafts.baseRevision === undefined) return
    setBusy(true)
    setErr(null)
    commitPlan(call, {
      candidatePlanId: prepared.candidatePlanId,
      digest: prepared.digest,
      expectedPlanRevision: drafts.baseRevision
    })
      .then((r) => {
        setCommitted(r)
        setPrepared(null)
        loadRun()
      })
      .catch(fail)
      .finally(() => setBusy(false))
  }

  const taskIds = drafts.tasks.map((x) => x.taskId).filter(Boolean)
  const planRev = projection?.plan?.revision ?? projection?.run.currentPlanRevision

  return (
    <div className="wb-view">
      <ContextBar />
      <Section
        title={t('wbPlanTitle')}
        right={
          <button className="wb-btn" onClick={loadRun} disabled={!runId}>
            {t('wbLoadRun')}
          </button>
        }
      >
        {projection && (
          <div className="wb-row">
            <Pill tone="accent">
              run {projection.run.id} · {projection.run.state}
            </Pill>
            <Pill>plan rev {planRev ?? '—'}</Pill>
            <Pill>model {projection.run.modelVersion}</Pill>
            <Pill>{projection.members.length} members</Pill>
            <Pill>{projection.assignments.length} assignments</Pill>
          </div>
        )}
        {projection?.plan && (
          <div className="wb-row">
            <span className="wb-dim mono">digest {projection.plan.digest}</span>
          </div>
        )}
        <div className="wb-row">
          <Field
            label={t('wbBaseRev')}
            value={drafts.baseRevision !== undefined ? String(drafts.baseRevision) : ''}
            onChange={(v) => {
              const n = Number(v)
              setDrafts((d) => ({
                ...d,
                baseRevision: v.trim() && Number.isFinite(n) ? n : undefined
              }))
            }}
            mono
          />
        </div>
        <div className="wb-note">{t('wbEdgeNote')}</div>
      </Section>

      <Section
        title={`${t('wbTasks')} · ${drafts.tasks.length}`}
        right={
          <button
            className="wb-btn"
            onClick={() => setDrafts((d) => ({ ...d, tasks: [...d.tasks, newTaskDraft()] }))}
          >
            <Plus className="wb-ico" />
            {t('wbAddTask')}
          </button>
        }
      >
        {drafts.tasks.length === 0 && (
          <div className="wb-note">
            {projection ? t('wbNoTasks') : 'Load a run to edit its plan, or add a task'}
          </div>
        )}
        {drafts.tasks.map((task) => (
          <div key={task.key} className={`wb-card${task.retired ? ' retired' : ''}`}>
            <div className="wb-card-h">
              <span className="wb-card-name">{task.title || t('wbNewTask')}</span>
              {task.taskId ? (
                <span className="wb-card-role mono">{task.taskId}</span>
              ) : (
                <Pill tone="dim">new task — taskId is minted by the server</Pill>
              )}
              <label className="wb-check">
                <input
                  type="checkbox"
                  checked={task.retired}
                  onChange={(e) => patchTask(task.key, { retired: e.target.checked })}
                />
                {t('wbRetire')}
              </label>
              <button
                className="wb-x"
                onClick={() =>
                  setDrafts((d) => ({ ...d, tasks: d.tasks.filter((x) => x.key !== task.key) }))
                }
              >
                <Trash2 />
              </button>
            </div>
            <div className="wb-row">
              <Field
                label={t('wbReqTitle')}
                value={task.title}
                onChange={(v) => patchTask(task.key, { title: v })}
                wide
              />
              <Field
                label={t('wbOwner')}
                value={task.ownerRoleId}
                onChange={(v) => patchTask(task.key, { ownerRoleId: v })}
                mono
              />
              <Field
                label={t('wbMember')}
                value={task.assignedMemberId}
                onChange={(v) => patchTask(task.key, { assignedMemberId: v })}
                mono
              />
            </div>
            {task.assignedMemberIdWas && !task.assignedMemberId && (
              <div className="wb-note">clearing this member is sent as an explicit null</div>
            )}
            <Field
              label={t('wbReqText')}
              value={task.requirementText}
              onChange={(v) => patchTask(task.key, { requirementText: v })}
              wide
            />
            {/* an attempt is never silently orphaned — the disposition is an
                explicit row for every task the plan already has */}
            {task.taskId && (
              <label className="wb-field">
                <span className="wb-field-l">{t('wbDispo')}</span>
                <select
                  className="wb-in"
                  value={task.disposition}
                  onChange={(e) =>
                    patchTask(task.key, {
                      disposition: e.target.value as TaskSpecDraft['disposition']
                    })
                  }
                >
                  <option value="keep">{t('wbKeep')}</option>
                  <option value="revoke">{t('wbStop')}</option>
                  <option value="replace">replace</option>
                </select>
              </label>
            )}

            <div className="wb-sub">
              <span className="wb-sub-l">
                {t('wbInputs')}
                <button
                  className="wb-mini"
                  onClick={() => patchInputs(task.key, [...task.inputs, newInputDraft()])}
                >
                  +
                </button>
              </span>
              {task.inputs.map((inp, i) => (
                <div key={i} className="wb-row">
                  <input
                    className="wb-in mono"
                    placeholder={t('wbSlot')}
                    value={inp.slot}
                    onChange={(e) =>
                      patchInputs(
                        task.key,
                        task.inputs.map((x, j) => (j === i ? { ...x, slot: e.target.value } : x))
                      )
                    }
                  />
                  <select
                    className="wb-in"
                    value={inp.kind}
                    onChange={(e) =>
                      patchInputs(
                        task.key,
                        task.inputs.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x))
                      )
                    }
                  >
                    <option value="artifact">artifact</option>
                    <option value="task-output">task-output</option>
                    <option value="contract">contract</option>
                    {/* a stored kind this editor does not model stays visible
                        instead of silently snapping to the first option */}
                    {inp.kind !== 'artifact' &&
                      inp.kind !== 'task-output' &&
                      inp.kind !== 'contract' && <option value={inp.kind}>{inp.kind}</option>}
                  </select>
                  {inp.kind === 'task-output' && (
                    <>
                      <input
                        className="wb-in mono"
                        placeholder="taskId"
                        value={inp.taskId}
                        onChange={(e) =>
                          patchInputs(
                            task.key,
                            task.inputs.map((x, j) =>
                              j === i ? { ...x, taskId: e.target.value } : x
                            )
                          )
                        }
                      />
                      <input
                        className="wb-in mono"
                        placeholder="outputSlot"
                        value={inp.outputSlot}
                        onChange={(e) =>
                          patchInputs(
                            task.key,
                            task.inputs.map((x, j) =>
                              j === i ? { ...x, outputSlot: e.target.value } : x
                            )
                          )
                        }
                      />
                    </>
                  )}
                  {inp.kind === 'artifact' && (
                    <>
                      <input
                        className="wb-in mono"
                        placeholder="artifactId"
                        value={inp.artifactId}
                        onChange={(e) =>
                          patchInputs(
                            task.key,
                            task.inputs.map((x, j) =>
                              j === i ? { ...x, artifactId: e.target.value } : x
                            )
                          )
                        }
                      />
                      <input
                        className="wb-in mono"
                        placeholder="artifactRevision"
                        value={inp.artifactRevision}
                        onChange={(e) =>
                          patchInputs(
                            task.key,
                            task.inputs.map((x, j) =>
                              j === i ? { ...x, artifactRevision: e.target.value } : x
                            )
                          )
                        }
                      />
                    </>
                  )}
                  {inp.kind === 'contract' && (
                    <>
                      <input
                        className="wb-in mono"
                        placeholder="contractId"
                        value={inp.contractId}
                        onChange={(e) =>
                          patchInputs(
                            task.key,
                            task.inputs.map((x, j) =>
                              j === i ? { ...x, contractId: e.target.value } : x
                            )
                          )
                        }
                      />
                      <input
                        className="wb-in mono"
                        placeholder="contractRevision"
                        value={inp.contractRevision}
                        onChange={(e) =>
                          patchInputs(
                            task.key,
                            task.inputs.map((x, j) =>
                              j === i ? { ...x, contractRevision: e.target.value } : x
                            )
                          )
                        }
                      />
                    </>
                  )}
                  <label className="wb-check">
                    <input
                      type="checkbox"
                      checked={inp.required}
                      onChange={(e) =>
                        patchInputs(
                          task.key,
                          task.inputs.map((x, j) =>
                            j === i ? { ...x, required: e.target.checked } : x
                          )
                        )
                      }
                    />
                    {t('wbRequired2')}
                  </label>
                  <button
                    className="wb-x"
                    onClick={() =>
                      patchInputs(
                        task.key,
                        task.inputs.filter((_, j) => j !== i)
                      )
                    }
                  >
                    <Trash2 />
                  </button>
                </div>
              ))}
            </div>

            <div className="wb-sub">
              <span className="wb-sub-l">
                {t('wbOutputs')}
                <button
                  className="wb-mini"
                  onClick={() => patchOutputs(task.key, [...task.outputs, newOutputDraft()])}
                >
                  +
                </button>
              </span>
              {task.outputs.map((out, i) => (
                <div key={i} className="wb-row">
                  <input
                    className="wb-in mono"
                    placeholder={t('wbSlot')}
                    value={out.slot}
                    onChange={(e) =>
                      patchOutputs(
                        task.key,
                        task.outputs.map((x, j) => (j === i ? { ...x, slot: e.target.value } : x))
                      )
                    }
                  />
                  <input
                    className="wb-in"
                    placeholder="description"
                    value={out.description}
                    onChange={(e) =>
                      patchOutputs(
                        task.key,
                        task.outputs.map((x, j) =>
                          j === i ? { ...x, description: e.target.value } : x
                        )
                      )
                    }
                  />
                  <input
                    className="wb-in mono"
                    placeholder="contractId"
                    value={out.contractId}
                    onChange={(e) =>
                      patchOutputs(
                        task.key,
                        task.outputs.map((x, j) =>
                          j === i ? { ...x, contractId: e.target.value } : x
                        )
                      )
                    }
                  />
                  <button
                    className="wb-x"
                    onClick={() =>
                      patchOutputs(
                        task.key,
                        task.outputs.filter((_, j) => j !== i)
                      )
                    }
                  >
                    <Trash2 />
                  </button>
                </div>
              ))}
            </div>

            <Field
              label={t('wbSettlePol')}
              value={task.settlementText}
              onChange={(v) => patchTask(task.key, { settlementText: v })}
              placeholder='{"policy": "…"} — text stays text unless it is JSON'
              wide
            />
          </div>
        ))}
      </Section>

      <Section
        title={`${t('wbEdges')} · ${drafts.edges.length}`}
        right={
          <button
            className="wb-btn"
            onClick={() => setDrafts((d) => ({ ...d, edges: [...d.edges, newEdgeDraft()] }))}
            disabled={taskIds.length < 2}
          >
            <Plus className="wb-ico" />
            {t('wbAddEdge')}
          </button>
        }
      >
        {drafts.edges.map((edge: EdgeDraft) => (
          <div key={edge.key} className="wb-row">
            <GitBranch className="wb-ico" />
            <select
              className="wb-in"
              value={edge.fromTask}
              onChange={(ev) =>
                setDrafts((d) => ({
                  ...d,
                  edges: d.edges.map((x) =>
                    x.key === edge.key ? { ...x, fromTask: ev.target.value } : x
                  )
                }))
              }
            >
              <option value="">{t('wbFrom')}</option>
              {taskIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <select
              className="wb-in"
              value={edge.toTask}
              onChange={(ev) =>
                setDrafts((d) => ({
                  ...d,
                  edges: d.edges.map((x) =>
                    x.key === edge.key ? { ...x, toTask: ev.target.value } : x
                  )
                }))
              }
            >
              <option value="">{t('wbTo')}</option>
              {taskIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <input
              className="wb-in mono"
              placeholder={t('wbReqOutputs')}
              value={edge.requiredOutputs}
              onChange={(ev) =>
                setDrafts((d) => ({
                  ...d,
                  edges: d.edges.map((x) =>
                    x.key === edge.key ? { ...x, requiredOutputs: ev.target.value } : x
                  )
                }))
              }
            />
            <input
              className="wb-in"
              placeholder={t('wbSettlement')}
              value={edge.settlementRequirement}
              onChange={(ev) =>
                setDrafts((d) => ({
                  ...d,
                  edges: d.edges.map((x) =>
                    x.key === edge.key ? { ...x, settlementRequirement: ev.target.value } : x
                  )
                }))
              }
            />
            <button
              className="wb-x"
              onClick={() =>
                setDrafts((d) => ({ ...d, edges: d.edges.filter((x) => x.key !== edge.key) }))
              }
            >
              <Trash2 />
            </button>
          </div>
        ))}
        {drafts.edges.some((e) => !e.fromTask || !e.toTask || e.fromTask === e.toTask) && (
          <div className="wb-note">
            an edge needs two distinct endpoints — incomplete rows are not sent
          </div>
        )}
      </Section>

      {projection && projection.eligibility.length > 0 && (
        <Section title={`eligibility · ${projection.eligibility.length}`}>
          <TextLines items={projection.eligibility.map(eligibilityText)} />
        </Section>
      )}

      {err && <OpError kind={err.kind} message={err.msg} />}

      <Section title={t('wbPrepare')}>
        <div className="wb-row">
          <button className="wb-btn accent" onClick={doPrepare} disabled={busy || !runId}>
            {t('wbPrepare')}
          </button>
          <button
            className="wb-btn"
            onClick={doCommit}
            disabled={busy || !prepared || drafts.baseRevision === undefined}
          >
            {t('wbCommit')}
          </button>
          {drafts.baseRevision === undefined && (
            <span className="wb-dim">commit needs the base plan revision</span>
          )}
        </div>
        {prepared && (
          <div className="wb-drawer">
            <KV value={{ candidatePlanId: prepared.candidatePlanId, digest: prepared.digest }} />
            {prepared.structuralErrors.length > 0 && (
              <div className="wb-sub">
                <span className="wb-sub-l">{t('wbStructErr')}</span>
                <TextLines items={prepared.structuralErrors} />
              </div>
            )}
            {prepared.unresolvedInputs.length > 0 && (
              <div className="wb-sub">
                {/* INPUT_NOT_READY is a normal pending state — commit may
                    still publish with pending inputs */}
                <span className="wb-sub-l">{t('wbUnresIn')}</span>
                <TextLines items={prepared.unresolvedInputs.map(pendingText)} />
              </div>
            )}
          </div>
        )}
        {committed && (
          <div className="wb-drawer">
            <Pill tone="ok">
              {t('wbPublished')} · {committed.planRevision}
            </Pill>
            <div className="wb-dim mono">digest {committed.digest}</div>
            <TextLines items={committed.eligibility.map(eligibilityText)} />
          </div>
        )}
      </Section>
    </div>
  )
}
