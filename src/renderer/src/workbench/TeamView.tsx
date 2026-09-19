// workbench/TeamView.tsx — preview → 명시 assign (IMP-31 §4.3, §4.5).
//
// The queue carries candidates from the find view; EACH queued entry still
// needs its own preview + explicit assign — queueing never assigns and a
// search rank never becomes a default pick (REQ-04). Provider and consumer
// for the same initial negotiation can both be queued and assigned
// independently, so neither side waits on the other's tasks (§4.5).
//
// assignment.preview shows relations/grant coverage/blockers BEFORE commit
// and creates nothing; team.assign is the explicit commit — the server
// re-checks token version + current grants, so STALE_REVISION is a normal
// answer rendered as its own state.

import { useState } from 'react'
import { UserCheck, X } from 'lucide-react'
import { useT } from '../i18n.ts'
import { workbenchCaller, opError, opErrorKind, type OpErrorKind } from './client.ts'
import { assignTeam, getRun, listImplementations, previewAssignment } from './ops.ts'
import type { AssignQueueEntry } from './store.ts'
import { isStale, useWorkbench } from './store.ts'
import type {
  AssignRequest,
  AssignResult,
  AssignmentKind,
  AssignmentPreview,
  ImplementationOffer
} from './contracts.ts'
import { ContextBar, Field, KV, ListLines, OpError, Pill, Section } from './bits.tsx'

interface AssignForm {
  assignmentKind: AssignmentKind
  mandateText: string
  taskId: string
  taskRevision: string
  placementIntent: string
  expectedPlanRevision: string
}

const emptyForm: AssignForm = {
  assignmentKind: 'task',
  mandateText: '',
  taskId: '',
  taskRevision: '',
  placementIntent: '',
  expectedPlanRevision: ''
}

/** placement intent is an object on the wire ({hostId, kind, ...}); the
 //  form takes either raw JSON or a bare host id for the common case */
function parsePlacement(raw: string): Record<string, unknown> | undefined {
  const v = raw.trim()
  if (!v) return undefined
  if (v.startsWith('{')) {
    try {
      const parsed = JSON.parse(v) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* not JSON — treat as a host id */
    }
  }
  return { hostId: v }
}

type Step =
  | { phase: 'form' }
  | { phase: 'previewing' }
  | { phase: 'previewed'; preview: AssignmentPreview }
  | { phase: 'assigning' }
  | { phase: 'done'; result: AssignResult }

function AssignCard({ entry }: { entry: AssignQueueEntry }): React.JSX.Element {
  const t = useT()
  const { runId, latestModelVersion, unqueueCandidate } = useWorkbench()
  const implChoice = useWorkbench((s) => s.implChoices[entry.card.selectionToken])
  const chooseImpl = useWorkbench((s) => s.chooseImpl)
  const [form, setForm] = useState<AssignForm>(emptyForm)
  const [impls, setImpls] = useState<ImplementationOffer[] | null>(null)
  const [step, setStep] = useState<Step>({ phase: 'form' })
  const [err, setErr] = useState<{ kind: OpErrorKind; msg: string } | null>(null)
  const stale = isStale(entry.modelVersion, latestModelVersion)

  const patch = (p: Partial<AssignForm>): void => setForm((f) => ({ ...f, ...p }))

  const fail = (e: unknown): void => {
    const oe = opError(e)
    setErr({ kind: opErrorKind(e), msg: oe.message })
    setStep({ phase: 'form' })
  }

  const loadImpls = (): void => {
    setErr(null)
    listImplementations(workbenchCaller(), {
      modelVersion: entry.modelVersion,
      roleId: entry.card.role.id
    })
      .then((r) => setImpls(r.implementations))
      .catch(fail)
  }

  const payload = (): AssignRequest | null => {
    if (!implChoice) return null
    return {
      runId,
      selectionToken: entry.card.selectionToken,
      implementationId: implChoice.implementationId,
      implementationRevision: implChoice.implementationRevision,
      assignmentKind: form.assignmentKind,
      mandateText: form.mandateText,
      taskId: form.taskId || undefined,
      taskRevision: form.taskRevision ? Number(form.taskRevision) : undefined,
      placementIntent: parsePlacement(form.placementIntent),
      expectedPlanRevision: form.expectedPlanRevision
        ? Number(form.expectedPlanRevision)
        : undefined
    }
  }

  const doPreview = (): void => {
    const req = payload()
    if (!req) return
    setStep({ phase: 'previewing' })
    setErr(null)
    previewAssignment(workbenchCaller(), req)
      .then((preview) => setStep({ phase: 'previewed', preview }))
      .catch(fail)
  }

  const doAssign = (): void => {
    const req = payload()
    if (!req) return
    setStep({ phase: 'assigning' })
    setErr(null)
    assignTeam(workbenchCaller(), req)
      .then((result) => {
        setStep({ phase: 'done', result })
        useWorkbench.getState().noteModelVersion(entry.modelVersion)
      })
      .catch(fail)
  }

  const fillPlanRev = (): void => {
    if (!runId) return
    getRun(workbenchCaller(), { runId, projection: 'coordinator' })
      .then((r) => {
        const rev = r.planRevision ?? r.run?.currentPlanRevision
        if (rev !== undefined) patch({ expectedPlanRevision: String(rev) })
      })
      .catch(() => {})
  }

  return (
    <div className="wb-card">
      <div className="wb-card-h">
        <span className="wb-card-name">{entry.card.boundary.name || entry.card.boundary.id}</span>
        {stale && <Pill tone="warn">{t('wbStale')}</Pill>}
        <span className="wb-card-role">
          {entry.card.role.name} · {entry.card.role.horizontalRole}
        </span>
        <button
          className="wb-x"
          onClick={() => unqueueCandidate(entry.card.selectionToken)}
          title={t('close')}
        >
          <X />
        </button>
      </div>
      <div className="wb-resp">{entry.card.boundary.responsibility}</div>

      {step.phase !== 'done' && (
        <>
          <Field
            label={t('wbMandate')}
            value={form.mandateText}
            onChange={(v) => patch({ mandateText: v })}
            wide
          />
          <div className="wb-row">
            <label className="wb-field">
              <span className="wb-field-l">{t('wbKind')}</span>
              <select
                className="wb-in"
                value={form.assignmentKind}
                onChange={(e) => patch({ assignmentKind: e.target.value as AssignmentKind })}
              >
                <option value="task">{t('wbTask')}</option>
                <option value="coordination">{t('wbCoordination')}</option>
              </select>
            </label>
            {form.assignmentKind === 'task' && (
              <>
                <Field
                  label={t('wbTaskId')}
                  value={form.taskId}
                  onChange={(v) => patch({ taskId: v })}
                  mono
                />
                <Field
                  label={t('wbTaskRev')}
                  value={form.taskRevision}
                  onChange={(v) => patch({ taskRevision: v })}
                  mono
                />
              </>
            )}
          </div>
          <div className="wb-row">
            <Field
              label={t('wbPlacement')}
              value={form.placementIntent}
              onChange={(v) => patch({ placementIntent: v })}
              mono
              wide
            />
            <Field
              label={t('wbExpectedPlanRev')}
              value={form.expectedPlanRevision}
              onChange={(v) => patch({ expectedPlanRevision: v })}
              mono
            />
            <button className="wb-btn" onClick={fillPlanRev} disabled={!runId}>
              {t('wbFromRun')}
            </button>
          </div>

          {/* implementation choice is explicit — list loads on demand,
              nothing is pre-selected, IMPLEMENTATION_MISSING is a state */}
          <div className="wb-sub">
            <span className="wb-sub-l">{t('wbImpl')}</span>
            {impls === null ? (
              <button className="wb-btn" onClick={loadImpls}>
                {t('wbLoadImpl')}
              </button>
            ) : impls.length === 0 ? (
              <Pill tone="warn">{t('wbNoImpl')}</Pill>
            ) : (
              impls.map((im) => (
                <label
                  key={`${im.implementationId}@${im.implementationRevision}`}
                  className="wb-impl"
                >
                  <input
                    type="radio"
                    name={`impl-${entry.card.selectionToken}`}
                    checked={
                      implChoice?.implementationId === im.implementationId &&
                      implChoice?.implementationRevision === im.implementationRevision
                    }
                    onChange={() => chooseImpl(entry.card.selectionToken, im)}
                  />
                  <span className="mono">
                    {im.implementationId}@{im.implementationRevision}
                  </span>
                  {im.profile && <span className="wb-dim">{im.profile}</span>}
                  {im.support && <Pill>{im.support}</Pill>}
                  {im.blockers?.map((b, i) => (
                    <Pill key={i} tone="warn">
                      {typeof b === 'string' ? b : (b.detail ?? b.kind ?? JSON.stringify(b))}
                    </Pill>
                  ))}
                </label>
              ))
            )}
          </div>

          {step.phase === 'previewed' && (
            <div className="wb-drawer">
              <div className="wb-note">{t('wbPreviewNote')}</div>
              {step.preview.proposedMember && (
                <div className="wb-sub">
                  <span className="wb-sub-l">member</span>
                  <KV value={step.preview.proposedMember} />
                </div>
              )}
              {step.preview.proposedAssignment && (
                <div className="wb-sub">
                  <span className="wb-sub-l">assignment</span>
                  <KV value={step.preview.proposedAssignment} />
                </div>
              )}
              {step.preview.requiredActions.length > 0 && (
                <div className="wb-sub">
                  <span className="wb-sub-l">{t('wbRequired')}</span>
                  <ListLines items={step.preview.requiredActions} />
                </div>
              )}
              {step.preview.grantCoverage !== undefined && (
                <div className="wb-sub">
                  <span className="wb-sub-l">{t('wbGrantCov')}</span>
                  <KV value={step.preview.grantCoverage} />
                </div>
              )}
              {step.preview.contextBlockers.length > 0 && (
                <div className="wb-sub">
                  <span className="wb-sub-l">{t('wbBlockers')}</span>
                  <ListLines items={step.preview.contextBlockers} />
                </div>
              )}
              {step.preview.resourceConditions.length > 0 && (
                <div className="wb-sub">
                  <span className="wb-sub-l">{t('wbResCond')}</span>
                  <ListLines items={step.preview.resourceConditions} />
                </div>
              )}
            </div>
          )}

          {err && <OpError kind={err.kind} message={err.msg} />}

          <div className="wb-card-a">
            <button
              className="wb-btn"
              onClick={doPreview}
              disabled={!runId || !implChoice || step.phase === 'previewing'}
            >
              {step.phase === 'previewing' ? '…' : t('wbPreview')}
            </button>
            {/* the ONLY assign path — an explicit click after a preview;
                search order never reaches here (REQ-04) */}
            <button
              className="wb-btn accent"
              onClick={doAssign}
              disabled={
                step.phase !== 'previewed' ||
                !runId ||
                (step.phase === 'previewed' && step.preview.contextBlockers.length > 0)
              }
            >
              <UserCheck className="wb-ico" />
              {step.phase === 'assigning' ? '…' : t('wbAssignBtn')}
            </button>
          </div>
        </>
      )}

      {step.phase === 'done' && (
        <div className="wb-done">
          <Pill tone="ok">{t('wbAssignedOk')}</Pill>
          <KV
            value={{
              memberId: step.result.memberId,
              assignmentId: step.result.assignmentId,
              state: step.result.state,
              effectiveGrantBinding: step.result.effectiveGrantBinding
            }}
          />
          {/* both sides of an initial negotiation get assigned here, one
              explicit commit each — no one waits on a predecessor output */}
          <button
            className="wb-btn"
            onClick={() => {
              unqueueCandidate(entry.card.selectionToken)
              setStep({ phase: 'form' })
              setForm(emptyForm)
            }}
          >
            {t('wbAssignAnother')}
          </button>
        </div>
      )}
    </div>
  )
}

export default function TeamView(): React.JSX.Element {
  const t = useT()
  const { runId } = useWorkbench()
  const assignQueue = useWorkbench((s) => s.assignQueue)

  return (
    <div className="wb-view">
      <ContextBar />
      {!runId && <div className="wb-note">{t('wbNeedRun')}</div>}
      {assignQueue.length === 0 ? (
        <div className="wb-empty">
          <UserCheck className="wb-ico" />
          {t('wbEmptyQueue')}
        </div>
      ) : (
        <Section title={`${t('widgetWorkbenchAssign')} · ${assignQueue.length}`}>
          {assignQueue.map((e) => (
            <AssignCard key={e.card.selectionToken} entry={e} />
          ))}
        </Section>
      )}
      <div className="wb-foot">{t('wbFootAssign')}</div>
    </div>
  )
}
