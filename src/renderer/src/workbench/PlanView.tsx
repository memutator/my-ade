// workbench/PlanView.tsx — META DAG 작업대 (IMP-31 §4.4, REQ-17).
//
// Edits are a PlanPatch against basePlanRevision: task requirement /
//  inputBindings / outputSlots / settlementPolicy drafts, execution-order
//  edges, retireTaskIds and explicit active-attempt dispositions. Nothing
//  mutates in place — plan.prepare stamps a candidate; plan.commit (CAS on
//  expectedPlanRevision) publishes a NEW PlanRevision.
//
// Edges are execution order only. The editor offers dependency edges with
//  required outputs and a settlement requirement — there is deliberately
//  no 'they talk to each other' edge kind; members converse by mail, not
//  by DAG edge (work.md Plan 문법, architecture.md §3).

import { useState } from 'react'
import { GitBranch, Plus, Trash2 } from 'lucide-react'
import { useT } from '../i18n.ts'
import { workbenchCaller, opError, opErrorKind, type OpErrorKind } from './client.ts'
import { commitPlan, getRun, preparePlan } from './ops.ts'
import type {
  CommitPlanResult,
  PlanEdgeDraft,
  PlanPatch,
  PlanTaskDraft,
  PreparePlanResult,
  RunProjection
} from './contracts.ts'
import { useWorkbench } from './store.ts'
import { Field, KV, ListLines, OpError, Pill, Section } from './bits.tsx'

// local draft-row shapes — mapped onto the contract's TaskSpecRevision /
//  edge payloads on send. taskId empty = a new task in the draft.
interface TaskDraft extends Omit<PlanTaskDraft, 'inputBindings' | 'outputSlots'> {
  key: string
  retired: boolean
  disposition: 'keep' | 'stop'
  inputs: { slot: string; kind: string; identity: string; revision: string; required: boolean }[]
  outputs: { name: string }[]
  settlementText: string
}

interface EdgeDraft extends PlanEdgeDraft {
  key: string
}

const uid = (): string => crypto.randomUUID()

const newTask = (): TaskDraft => ({
  key: uid(),
  title: '',
  requirementText: '',
  ownerRoleId: '',
  assignedMemberId: '',
  retired: false,
  disposition: 'keep',
  inputs: [],
  outputs: [],
  settlementText: ''
})

const toPatch = (tasks: TaskDraft[], edges: EdgeDraft[], base: number): PlanPatch => ({
  basePlanRevision: base,
  tasks: tasks
    .filter((t) => !t.retired)
    .map((t) => ({
      taskId: t.taskId || undefined,
      revision: t.revision,
      title: t.title,
      requirementText: t.requirementText,
      ownerRoleId: t.ownerRoleId || undefined,
      assignedMemberId: t.assignedMemberId || undefined,
      inputBindings: t.inputs.map((i) => ({
        slot: i.slot,
        kind: i.kind,
        identity: i.identity || undefined,
        revision: i.revision ? Number(i.revision) : undefined,
        required: i.required
      })),
      outputSlots: t.outputs.map((o) => ({ name: o.name })),
      settlementPolicy: t.settlementText || undefined
    })) as unknown as PlanTaskDraft[],
  edges: edges.map((e) => ({
    fromTask: e.fromTask,
    toTask: e.toTask,
    requiredOutputs: e.requiredOutputs,
    settlementRequirement: e.settlementRequirement
  })),
  retireTaskIds: tasks.filter((t) => t.retired && t.taskId).map((t) => t.taskId!),
  activeAttemptDisposition: tasks
    .filter((t) => !t.retired && t.taskId)
    .map((t) => ({ taskId: t.taskId!, disposition: t.disposition }))
})

export default function PlanView(): React.JSX.Element {
  const t = useT()
  const { runId } = useWorkbench()
  const [run, setRun] = useState<RunProjection | null>(null)
  const [baseRev, setBaseRev] = useState('')
  const [tasks, setTasks] = useState<TaskDraft[]>([])
  const [edges, setEdges] = useState<EdgeDraft[]>([])
  const [prepared, setPrepared] = useState<PreparePlanResult | null>(null)
  const [committed, setCommitted] = useState<CommitPlanResult | null>(null)
  const [err, setErr] = useState<{ kind: OpErrorKind; msg: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const fail = (e: unknown): void => {
    const oe = opError(e)
    setErr({ kind: opErrorKind(e), msg: oe.message })
  }

  const loadRun = (): void => {
    setErr(null)
    getRun(workbenchCaller(), { runId, projection: 'coordinator' })
      .then((r) => {
        setRun(r)
        const rev = r.planRevision ?? r.run?.currentPlanRevision
        if (rev !== undefined) setBaseRev(String(rev))
      })
      .catch(fail)
  }

  const patchTask = (key: string, p: Partial<TaskDraft>): void =>
    setTasks((ts) => ts.map((x) => (x.key === key ? { ...x, ...p } : x)))

  const doPrepare = (): void => {
    const base = Number(baseRev)
    if (!Number.isFinite(base)) return
    setBusy(true)
    setErr(null)
    setCommitted(null)
    preparePlan(workbenchCaller(), runId, toPatch(tasks, edges, base))
      .then(setPrepared)
      .catch(fail)
      .finally(() => setBusy(false))
  }

  const doCommit = (): void => {
    if (!prepared) return
    setBusy(true)
    setErr(null)
    commitPlan(workbenchCaller(), {
      candidatePlanId: prepared.candidatePlanId,
      digest: prepared.digest,
      expectedPlanRevision: Number(baseRev)
    })
      .then((r) => {
        setCommitted(r)
        setPrepared(null)
        loadRun()
      })
      .catch(fail)
      .finally(() => setBusy(false))
  }

  const taskIds = tasks.map((x) => x.taskId || x.key)

  return (
    <div className="wb-view">
      <Section
        title={t('wbPlanTitle')}
        right={
          <button className="wb-btn" onClick={loadRun} disabled={!runId}>
            {t('wbLoadRun')}
          </button>
        }
      >
        {run && (
          <div className="wb-row">
            <Pill tone="accent">
              run {run.run?.id ?? runId} · {run.run?.state ?? '?'}
            </Pill>
            <Pill>plan rev {run.planRevision ?? run.run?.currentPlanRevision ?? '—'}</Pill>
            {run.members && <Pill>{run.members.length} members</Pill>}
          </div>
        )}
        <Field label={t('wbBaseRev')} value={baseRev} onChange={setBaseRev} mono />
        <div className="wb-note">{t('wbEdgeNote')}</div>
      </Section>

      <Section
        title={`${t('wbTasks')} · ${tasks.length}`}
        right={
          <button className="wb-btn" onClick={() => setTasks((ts) => [...ts, newTask()])}>
            <Plus className="wb-ico" />
            {t('wbAddTask')}
          </button>
        }
      >
        {tasks.length === 0 && <div className="wb-note">{t('wbNoTasks')}</div>}
        {tasks.map((task) => (
          <div key={task.key} className={`wb-card${task.retired ? ' retired' : ''}`}>
            <div className="wb-card-h">
              <span className="wb-card-name">{task.title || t('wbNewTask')}</span>
              {task.taskId && <span className="wb-card-role mono">{task.taskId}</span>}
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
                onClick={() => setTasks((ts) => ts.filter((x) => x.key !== task.key))}
              >
                <Trash2 />
              </button>
            </div>
            {!task.retired && (
              <>
                <div className="wb-row">
                  <Field
                    label={t('wbReqTitle')}
                    value={task.title}
                    onChange={(v) => patchTask(task.key, { title: v })}
                    wide
                  />
                  <Field
                    label="task id"
                    value={task.taskId ?? ''}
                    onChange={(v) => patchTask(task.key, { taskId: v || undefined })}
                    mono
                  />
                </div>
                <Field
                  label={t('wbReqText')}
                  value={task.requirementText}
                  onChange={(v) => patchTask(task.key, { requirementText: v })}
                  wide
                />
                <div className="wb-row">
                  <Field
                    label={t('wbOwner')}
                    value={task.ownerRoleId ?? ''}
                    onChange={(v) => patchTask(task.key, { ownerRoleId: v })}
                    mono
                  />
                  <Field
                    label={t('wbMember')}
                    value={task.assignedMemberId ?? ''}
                    onChange={(v) => patchTask(task.key, { assignedMemberId: v })}
                    mono
                  />
                  {task.taskId && (
                    <label className="wb-field">
                      <span className="wb-field-l">{t('wbDispo')}</span>
                      <select
                        className="wb-in"
                        value={task.disposition}
                        onChange={(e) =>
                          patchTask(task.key, {
                            disposition: e.target.value as 'keep' | 'stop'
                          })
                        }
                      >
                        <option value="keep">{t('wbKeep')}</option>
                        <option value="stop">{t('wbStop')}</option>
                      </select>
                    </label>
                  )}
                </div>

                <div className="wb-sub">
                  <span className="wb-sub-l">
                    {t('wbInputs')}
                    <button
                      className="wb-mini"
                      onClick={() =>
                        patchTask(task.key, {
                          inputs: [
                            ...task.inputs,
                            {
                              slot: '',
                              kind: 'task-output',
                              identity: '',
                              revision: '',
                              required: true
                            }
                          ]
                        })
                      }
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
                          patchTask(task.key, {
                            inputs: task.inputs.map((x, j) =>
                              j === i ? { ...x, slot: e.target.value } : x
                            )
                          })
                        }
                      />
                      <select
                        className="wb-in"
                        value={inp.kind}
                        onChange={(e) =>
                          patchTask(task.key, {
                            inputs: task.inputs.map((x, j) =>
                              j === i ? { ...x, kind: e.target.value } : x
                            )
                          })
                        }
                      >
                        <option value="artifact">artifact</option>
                        <option value="task-output">task-output</option>
                        <option value="contract">contract</option>
                      </select>
                      <input
                        className="wb-in mono"
                        placeholder={t('wbIdentity')}
                        value={inp.identity}
                        onChange={(e) =>
                          patchTask(task.key, {
                            inputs: task.inputs.map((x, j) =>
                              j === i ? { ...x, identity: e.target.value } : x
                            )
                          })
                        }
                      />
                      <label className="wb-check">
                        <input
                          type="checkbox"
                          checked={inp.required}
                          onChange={(e) =>
                            patchTask(task.key, {
                              inputs: task.inputs.map((x, j) =>
                                j === i ? { ...x, required: e.target.checked } : x
                              )
                            })
                          }
                        />
                        {t('wbRequired2')}
                      </label>
                      <button
                        className="wb-x"
                        onClick={() =>
                          patchTask(task.key, { inputs: task.inputs.filter((_, j) => j !== i) })
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
                      onClick={() =>
                        patchTask(task.key, { outputs: [...task.outputs, { name: '' }] })
                      }
                    >
                      +
                    </button>
                  </span>
                  {task.outputs.map((o, i) => (
                    <div key={i} className="wb-row">
                      <input
                        className="wb-in mono"
                        placeholder={t('wbName')}
                        value={o.name}
                        onChange={(e) =>
                          patchTask(task.key, {
                            outputs: task.outputs.map((x, j) =>
                              j === i ? { name: e.target.value } : x
                            )
                          })
                        }
                      />
                      <button
                        className="wb-x"
                        onClick={() =>
                          patchTask(task.key, { outputs: task.outputs.filter((_, j) => j !== i) })
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
                  wide
                />
              </>
            )}
          </div>
        ))}
      </Section>

      <Section
        title={`${t('wbEdges')} · ${edges.length}`}
        right={
          <button
            className="wb-btn"
            onClick={() =>
              setEdges((es) => [
                ...es,
                {
                  key: uid(),
                  fromTask: '',
                  toTask: '',
                  requiredOutputs: [],
                  settlementRequirement: ''
                }
              ])
            }
            disabled={taskIds.length < 2}
          >
            <Plus className="wb-ico" />
            {t('wbAddEdge')}
          </button>
        }
      >
        {edges.map((e) => (
          <div key={e.key} className="wb-row">
            <GitBranch className="wb-ico" />
            <select
              className="wb-in"
              value={e.fromTask}
              onChange={(ev) =>
                setEdges((es) =>
                  es.map((x) => (x.key === e.key ? { ...x, fromTask: ev.target.value } : x))
                )
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
              value={e.toTask}
              onChange={(ev) =>
                setEdges((es) =>
                  es.map((x) => (x.key === e.key ? { ...x, toTask: ev.target.value } : x))
                )
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
              value={e.requiredOutputs.join(',')}
              onChange={(ev) =>
                setEdges((es) =>
                  es.map((x) =>
                    x.key === e.key
                      ? {
                          ...x,
                          requiredOutputs: ev.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean)
                        }
                      : x
                  )
                )
              }
            />
            <input
              className="wb-in"
              placeholder={t('wbSettlement')}
              value={e.settlementRequirement ?? ''}
              onChange={(ev) =>
                setEdges((es) =>
                  es.map((x) =>
                    x.key === e.key ? { ...x, settlementRequirement: ev.target.value } : x
                  )
                )
              }
            />
            <button
              className="wb-x"
              onClick={() => setEdges((es) => es.filter((x) => x.key !== e.key))}
            >
              <Trash2 />
            </button>
          </div>
        ))}
      </Section>

      {err && <OpError kind={err.kind} message={err.msg} />}

      <Section title={t('wbPrepare')}>
        <div className="wb-row">
          <button
            className="wb-btn accent"
            onClick={doPrepare}
            disabled={busy || !runId || !baseRev}
          >
            {t('wbPrepare')}
          </button>
          <button className="wb-btn" onClick={doCommit} disabled={busy || !prepared}>
            {t('wbCommit')}
          </button>
        </div>
        {prepared && (
          <div className="wb-drawer">
            <KV value={{ candidatePlanId: prepared.candidatePlanId, digest: prepared.digest }} />
            {prepared.structuralErrors.length > 0 && (
              <div className="wb-sub">
                <span className="wb-sub-l">{t('wbStructErr')}</span>
                <ListLines items={prepared.structuralErrors} />
              </div>
            )}
            {prepared.unresolvedInputs.length > 0 && (
              <div className="wb-sub">
                {/* INPUT_NOT_READY is a normal pending state — commit may
                    still publish with pending inputs */}
                <span className="wb-sub-l">{t('wbUnresIn')}</span>
                <ListLines items={prepared.unresolvedInputs} />
              </div>
            )}
          </div>
        )}
        {committed && (
          <div className="wb-drawer">
            <Pill tone="ok">
              {t('wbPublished')} · {committed.planRevision}
            </Pill>
            {committed.eligibility !== undefined && <KV value={committed.eligibility} />}
          </div>
        )}
      </Section>
    </div>
  )
}
