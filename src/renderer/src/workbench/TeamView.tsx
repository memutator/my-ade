// workbench/TeamView.tsx — preview → 명시 assign (C-WORK).
//
// The queue carries candidates from the find view; EACH queued entry still
// needs its own preview + explicit assign — queueing never assigns and a
// search rank never becomes a default pick (REQ-04). Provider and consumer of
// the same initial negotiation can both be queued and assigned independently,
// so neither waits on the other's tasks.
//
// assignment.preview shows relations / grant coverage / blockers BEFORE
// commit and creates nothing; team.assign is the explicit commit, with the
// plan CAS (expectedPlanRevision) riding on the commit only. The server
// re-checks the token's pins and the current grants, so STALE_REVISION is a
// normal answer rendered as its own state.

import { useState } from 'react'
import { UserCheck, X } from 'lucide-react'
import { useT } from '../i18n.ts'
import { opError, opErrorKind, type OpErrorKind } from './client.ts'
import { assignTeam, getRun, listImplementations, previewAssignment } from './ops.ts'
import type { AssignmentPreviewResult, TeamAssignResult } from './contracts.ts'
import {
  emptyAssignmentForm,
  toAssignRequest,
  toPreviewRequest,
  type AssignmentForm
} from './assignment.ts'
import { type ImplementationOfferView, type ImplementationsViewModel } from './view-model.ts'
import type { AssignQueueEntry } from './queues.ts'
import {
  useAssignQueue,
  useImplementationChoice,
  useModelHead,
  useScopeCaller,
  useWorkbenchActions,
  useWorkbenchContext
} from './scope.ts'
import { isResultStale } from './store.ts'
import { ContextBar, Field, KV, OpError, Pill, Section, TextLines } from './bits.tsx'

type Step =
  | { phase: 'form' }
  | { phase: 'previewing' }
  | { phase: 'previewed'; preview: AssignmentPreviewResult }
  | { phase: 'assigning' }
  | { phase: 'done'; result: TeamAssignResult }

function ImplRow({
  impl,
  selected,
  onSelect
}: {
  impl: ImplementationOfferView
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <label className="wb-impl">
      <input type="radio" checked={selected} onChange={onSelect} />
      <span className="mono">
        {impl.implementationId}@{impl.implementationRevision}
      </span>
      <span className="wb-dim">
        {impl.profileId}@{impl.profileRevision} · {impl.status}/{impl.profileState}
      </span>
      <Pill>{impl.support}</Pill>
      {impl.blockers.map((b, i) => (
        <Pill key={i} tone="warn">
          {b.kind}: {b.detail}
        </Pill>
      ))}
    </label>
  )
}

function AssignCard({ entry }: { entry: AssignQueueEntry }): React.JSX.Element {
  const t = useT()
  const call = useScopeCaller()
  const { runId } = useWorkbenchContext()
  const head = useModelHead()
  const { unqueueCandidate } = useWorkbenchActions()
  const implChoice = useImplementationChoice(entry.card.selectionToken)
  const { chooseImpl } = useWorkbenchActions()
  const [form, setForm] = useState<AssignmentForm>(emptyAssignmentForm)
  const [impls, setImpls] = useState<ImplementationsViewModel | null>(null)
  const [step, setStep] = useState<Step>({ phase: 'form' })
  const [err, setErr] = useState<{ kind: OpErrorKind; msg: string } | null>(null)
  const stale = isResultStale(entry.modelVersion, entry.staleModel, head)

  const patch = (p: Partial<AssignmentForm>): void => setForm((f) => ({ ...f, ...p }))

  const fail = (e: unknown): void => {
    setErr({ kind: opErrorKind(e), msg: opError(e).message })
    setStep({ phase: 'form' })
  }

  const loadImpls = (): void => {
    setErr(null)
    listImplementations(call, {
      modelVersion: entry.modelVersion,
      roleId: entry.card.role.id
    })
      .then(setImpls)
      .catch(fail)
  }

  const doPreview = (): void => {
    if (!implChoice || !runId) return
    setStep({ phase: 'previewing' })
    setErr(null)
    previewAssignment(
      call,
      toPreviewRequest(
        runId,
        entry.card.selectionToken,
        implChoice.implementationId,
        implChoice.implementationRevision,
        form
      )
    )
      .then((preview) => setStep({ phase: 'previewed', preview }))
      .catch(fail)
  }

  const doAssign = (): void => {
    if (!implChoice || !runId) return
    setStep({ phase: 'assigning' })
    setErr(null)
    assignTeam(
      call,
      toAssignRequest(
        runId,
        entry.card.selectionToken,
        implChoice.implementationId,
        implChoice.implementationRevision,
        form
      )
    )
      .then((result) => {
        // an assign receipt carries no freshness information, so it never
        // moves the model head — only a discovery/run response can
        setStep({ phase: 'done', result })
      })
      .catch(fail)
  }

  const fillPlanRev = (): void => {
    if (!runId) return
    getRun(call, { runId, projection: 'coordinator' })
      .then((r) => {
        const rev = r.plan?.revision ?? r.run.currentPlanRevision
        if (rev !== undefined) patch({ expectedPlanRevision: String(rev) })
      })
      .catch(() => {})
  }

  const preview = step.phase === 'previewed' ? step.preview : null

  return (
    <div className="wb-card">
      <div className="wb-card-h">
        <span className="wb-card-name">{entry.card.boundary.name || entry.card.boundary.id}</span>
        {stale && <Pill tone="warn">{t('wbStale')}</Pill>}
        <span className="wb-card-role">
          {entry.card.role.name} · {entry.card.role.horizontalRole}
        </span>
        <span className="wb-card-role mono">model {entry.modelVersion}</span>
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
                onChange={(e) =>
                  patch({ assignmentKind: e.target.value as AssignmentForm['assignmentKind'] })
                }
              >
                <option value="task">{t('wbTask')}</option>
                <option value="coordination">{t('wbCoordination')}</option>
              </select>
            </label>
            {/* a coordination assignment takes no Task (D-WORK §2) */}
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

          <div className="wb-sub">
            <span className="wb-sub-l">{t('wbPlacement')}</span>
            <div className="wb-row">
              <label className="wb-field">
                <span className="wb-field-l">kind</span>
                <select
                  className="wb-in"
                  value={form.placementKind}
                  onChange={(e) =>
                    patch({ placementKind: e.target.value as AssignmentForm['placementKind'] })
                  }
                >
                  <option value="">—</option>
                  <option value="folder">folder</option>
                  <option value="worktree">worktree</option>
                </select>
              </label>
              <Field
                label="host id"
                value={form.placementHostId}
                onChange={(v) => patch({ placementHostId: v })}
                mono
              />
              <Field
                label="target path"
                value={form.placementTargetPath}
                onChange={(v) => patch({ placementTargetPath: v })}
                mono
                wide
              />
            </div>
            <div className="wb-row">
              <Field
                label="project root"
                value={form.placementProjectRoot}
                onChange={(v) => patch({ placementProjectRoot: v })}
                mono
                wide
              />
              <Field
                label="checkout id"
                value={form.placementCheckoutId}
                onChange={(v) => patch({ placementCheckoutId: v })}
                mono
              />
            </div>
            <div className="wb-note">
              only the fields you fill are sent — the server decides what the provisioning grant
              allows
            </div>
          </div>

          <div className="wb-row">
            <Field
              label={t('wbExpectedPlanRev')}
              value={form.expectedPlanRevision}
              onChange={(v) => patch({ expectedPlanRevision: v })}
              mono
            />
            <button className="wb-btn" onClick={fillPlanRev} disabled={!runId}>
              {t('wbFromRun')}
            </button>
            <span className="wb-dim">rides on the assign commit only — preview CASes nothing</span>
          </div>

          {/* the implementation choice is explicit — the list loads on demand
              and nothing is pre-selected; IMPLEMENTATION_MISSING is a state */}
          <div className="wb-sub">
            <span className="wb-sub-l">{t('wbImpl')}</span>
            {impls === null ? (
              <button className="wb-btn" onClick={loadImpls}>
                {t('wbLoadImpl')}
              </button>
            ) : impls.status === 'implementation-missing' || impls.implementations.length === 0 ? (
              <Pill tone="warn">{t('wbNoImpl')}</Pill>
            ) : (
              impls.implementations.map((impl) => (
                <ImplRow
                  key={`${impl.implementationId}@${impl.implementationRevision}`}
                  impl={impl}
                  selected={
                    implChoice?.implementationId === impl.implementationId &&
                    implChoice?.implementationRevision === impl.implementationRevision
                  }
                  onSelect={() => chooseImpl(entry.card.selectionToken, impl)}
                />
              ))
            )}
            {impls && impls.excluded.length > 0 && (
              <div className="wb-sub">
                <span className="wb-sub-l">excluded for this host</span>
                <TextLines
                  items={impls.excluded.map(
                    (e) =>
                      `${e.implementationId}@${e.revision} — needs ${e.missingNeeds.join(', ')}`
                  )}
                />
              </div>
            )}
          </div>

          {preview && (
            <div className="wb-drawer">
              <div className="wb-note">{t('wbPreviewNote')}</div>
              <div className="wb-sub">
                <span className="wb-sub-l">proposed member</span>
                <KV value={preview.proposedMember} />
              </div>
              <div className="wb-sub">
                <span className="wb-sub-l">proposed assignment</span>
                <KV value={preview.proposedAssignment} />
              </div>
              {preview.requiredActions.length > 0 && (
                <div className="wb-sub">
                  <span className="wb-sub-l">{t('wbRequired')}</span>
                  <TextLines items={preview.requiredActions} />
                </div>
              )}
              <div className="wb-sub">
                <span className="wb-sub-l">{t('wbGrantCov')}</span>
                <KV value={preview.grantCoverage} />
                {preview.grantCoverage.missing.length > 0 && (
                  <TextLines items={preview.grantCoverage.missing.map((m) => `missing: ${m}`)} />
                )}
              </div>
              {preview.contextBlockers.length > 0 && (
                <div className="wb-sub">
                  <span className="wb-sub-l">{t('wbBlockers')}</span>
                  <TextLines items={preview.contextBlockers} />
                </div>
              )}
              {preview.resourceConditions.length > 0 && (
                <div className="wb-sub">
                  <span className="wb-sub-l">{t('wbResCond')}</span>
                  <TextLines items={preview.resourceConditions} />
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
                (preview !== null && preview.contextBlockers.length > 0)
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
              grantId: step.result.effectiveGrantBinding.grantId,
              actions: step.result.effectiveGrantBinding.actions
            }}
          />
          {/* both sides of an initial negotiation get assigned here, one
              explicit commit each — no one waits on a predecessor output */}
          <button
            className="wb-btn"
            onClick={() => {
              unqueueCandidate(entry.card.selectionToken)
              setStep({ phase: 'form' })
              setForm(emptyAssignmentForm())
              setImpls(null)
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
  const { projectId, runId } = useWorkbenchContext()
  const assignQueue = useAssignQueue()
  const { clearQueue } = useWorkbenchActions()

  return (
    <div className="wb-view">
      <ContextBar />
      <div className="wb-note">
        queue scope: project {projectId || '—'} · run {runId || '(no run)'} — a queue belongs to its
        project/run and never follows you into another one
      </div>
      {!runId && <div className="wb-note">{t('wbNeedRun')}</div>}
      {assignQueue.length === 0 ? (
        <div className="wb-empty">
          <UserCheck className="wb-ico" />
          {t('wbEmptyQueue')}
        </div>
      ) : (
        <Section
          title={`${t('widgetWorkbenchAssign')} · ${assignQueue.length}`}
          right={
            <button className="wb-btn" onClick={clearQueue}>
              clear
            </button>
          }
        >
          {assignQueue.map((e) => (
            <AssignCard key={e.card.selectionToken} entry={e} />
          ))}
        </Section>
      )}
      <div className="wb-foot">{t('wbFootAssign')}</div>
    </div>
  )
}
