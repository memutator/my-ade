// workbench/InspectorView.tsx — role / context / surface / access / worker
// inspector (C-REALIZATION · C-ACCESS · C-LAUNCH).
//
// Reads domain operations by name through the workbench caller and never
// imports runtime internals (the renderer may only type-import contracts).
// Every lane renders the CANONICAL operation DTO the handler returns:
//   interface.get        {modelVersion, roleId} → digest/contextRequirements/
//                        maintenanceRefs/modelStatus + the nested interface
//   role.implementations {modelVersion, roleId, hostId?} → offers + excluded
//   context.inspect      {bundleDigest? | executionId?, detail} → planned vs
//                        attached evidence, inherited, missing, unknowns, pins
//   surface.describe     {operation?, expectedSurfaceDigest?} → digest/stale/ops
//   access.inspect       {memberId? | grantId?} → subject, policy, grant rows
//   worker.inspect       {executionId? | memberId?} → the flattened execution
// A lane whose required input is missing is not sent at all — the surface
// says which field it needs instead of firing a request that cannot answer.
//
// The allowed command surface and the caller's actual grants stay SEPARATE
// lanes: one is the ceiling, the other is what was granted. A receipt lane is
// evidence of what happened, never an implied "done", and worker.start is not
// on this surface.

import { useState } from 'react'
import { useT } from '../i18n.ts'
import { opError, opErrorKind, type OpErrorKind } from './client.ts'
import {
  describeSurface,
  getRoleInterface,
  inspectAccess,
  inspectContext,
  inspectWorker,
  listImplementations
} from './ops.ts'
import type {
  ContextInspectResult,
  SurfaceDescribePayload,
  WorkerInspectPayload
} from './contracts.ts'
import { toImplementationOfferRow, type ImplementationsViewModel } from './view-model.ts'
import {
  toAccessLane,
  toComponentRows,
  toInheritanceRows,
  toInterfaceGetPayload,
  toInterfaceLane,
  toPinRows,
  toStageRows,
  toSurfaceLane,
  toWorkerLane,
  type AccessLaneView,
  type InterfaceLaneView,
  type SurfaceLaneView,
  type WorkerLaneView
} from './inspector-lanes.ts'
import { useModelHead, useScopeCaller, useWorkbenchContext } from './scope.ts'
import { ContextBar, Field, KV, OpError, Pill, Section, TextLines } from './bits.tsx'

type LaneBody =
  | { kind: 'interface'; view: InterfaceLaneView }
  | { kind: 'implementations'; view: ImplementationsViewModel }
  | { kind: 'context'; view: ContextInspectResult }
  | { kind: 'surface'; view: SurfaceLaneView }
  | { kind: 'access'; view: AccessLaneView }
  | { kind: 'worker'; view: WorkerLaneView }

interface Lane {
  id: string
  title: string
  /** the payload exactly as sent — the surface shows its own requests */
  request: Record<string, unknown>
  error?: { kind: OpErrorKind; message: string }
  body?: LaneBody
}

function InterfaceLane({ view }: { view: InterfaceLaneView }): React.JSX.Element {
  return (
    <>
      <div className="wb-row">
        <Pill tone="accent">role {view.roleId}</Pill>
        <Pill>model {view.modelVersion}</Pill>
        <Pill>{view.modelStatus}</Pill>
      </div>
      <div className="wb-dim mono">digest {view.digest}</div>
      <div className="wb-sub">
        <span className="wb-sub-l">judgment scope</span>
        <div className="wb-resp">{view.judgmentScope.scopeOfJudgment}</div>
        <TextLines items={view.judgmentScope.invariantRefs.map((i) => 'invariant ' + i)} />
      </div>
      {view.responsibilityRefs.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">responsibilities held together</span>
          <TextLines items={view.responsibilityRefs} />
        </div>
      )}
      <div className="wb-sub">
        <span className="wb-sub-l">context requirements</span>
        <TextLines
          items={view.requirements.map(
            (r) =>
              r.clauseId +
              ' · ' +
              r.requiredMeaning +
              ' [' +
              r.deliveryClass +
              '] from ' +
              r.source +
              ' · ' +
              r.readerPerspective
          )}
        />
      </div>
      {view.maintenanceRefs.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">staleness refs</span>
          <TextLines
            items={view.maintenanceRefs.map(
              (r) => r.kind + ' ' + r.id + (r.path ? ' · ' + r.path : '')
            )}
          />
        </div>
      )}
    </>
  )
}

function ImplementationsLane({ view }: { view: ImplementationsViewModel }): React.JSX.Element {
  const t = useT()
  return (
    <>
      <div className="wb-row">
        <Pill tone={view.status === 'implementation-missing' ? 'warn' : 'ok'}>{view.status}</Pill>
        <Pill>role {view.roleId}</Pill>
      </div>
      {view.interfaceDigests.length > 0 && (
        <TextLines items={view.interfaceDigests.map((d) => 'interface digest ' + d)} />
      )}
      <TextLines
        items={view.implementations.map((impl) => {
          const row = toImplementationOfferRow(impl)
          const blockers = row.blockers.length ? ' · ' + row.blockers.join(', ') : ''
          return row.label + ' — ' + row.detail + ' · ' + row.support + blockers
        })}
      />
      {view.implementations.length === 0 && <div className="wb-note">{t('wbNoImpl')}</div>}
      {view.excluded.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">excluded for this host</span>
          <TextLines
            items={view.excluded.map(
              (e) => e.implementationId + '@' + e.revision + ' — needs ' + e.missingNeeds.join(', ')
            )}
          />
        </div>
      )}
    </>
  )
}

function ContextLane({ view }: { view: ContextInspectResult }): React.JSX.Element {
  const components = toComponentRows(view.planned)
  const inherited = toInheritanceRows(view.inherited)
  return (
    <>
      <div className="wb-row">
        <Pill>bundle {String(view.bundleDigest)}</Pill>
        {view.executionId && <Pill>execution {String(view.executionId)}</Pill>}
        <Pill tone={view.attached.length > 0 ? 'ok' : 'dim'}>
          {view.attached.length} attached receipt revision(s)
        </Pill>
        {view.missing.length > 0 && (
          <Pill tone="warn">{view.missing.length} planned component(s) without evidence</Pill>
        )}
      </div>
      <div className="wb-sub">
        <span className="wb-sub-l">pins</span>
        <TextLines items={toPinRows(view.pins)} />
      </div>
      <div className="wb-sub">
        <span className="wb-sub-l">planned components (manifest intent)</span>
        {components.length ? (
          <TextLines
            items={components.map(
              (row) =>
                row.componentId +
                ' · ' +
                row.kind +
                ' · ' +
                row.scope +
                ' · ' +
                row.path +
                ' · ' +
                row.activation +
                ' · ' +
                row.digest
            )}
          />
        ) : (
          <div className="wb-note">no planned components in this bundle manifest</div>
        )}
      </div>
      <div className="wb-sub">
        <span className="wb-sub-l">attached (recorded delivery evidence)</span>
        {view.attached.length ? (
          <TextLines
            items={view.attached.map(
              (a) =>
                a.phase +
                '@' +
                a.revision +
                ' · ' +
                a.components.length +
                ' component(s) · ' +
                a.inherited.length +
                ' inherited'
            )}
          />
        ) : (
          <div className="wb-note">no injection receipt recorded for this projection</div>
        )}
      </div>
      {view.missing.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">planned without materialized evidence</span>
          <TextLines items={view.missing} />
        </div>
      )}
      <div className="wb-sub">
        <span className="wb-sub-l">inherited inputs</span>
        <TextLines
          items={inherited.map(
            (row) =>
              row.scope +
              ' · ' +
              row.path +
              ' · ' +
              row.status +
              ' · ' +
              row.digest +
              (row.note ? ' · ' + row.note : '')
          )}
        />
      </div>
      <div className="wb-sub">
        <span className="wb-sub-l">unknowns</span>
        {/* unknowns are a result state, not an empty section */}
        <TextLines
          items={view.unknowns.map((u) => (u.reason ? u.what + ' — ' + u.reason : u.what))}
        />
      </div>
      {view.manifestDigest && (
        <div className="wb-dim mono">manifest digest {view.manifestDigest}</div>
      )}
    </>
  )
}

function SurfaceLane({ view }: { view: SurfaceLaneView }): React.JSX.Element {
  return (
    <>
      <div className="wb-row">
        <Pill tone={view.stale ? 'warn' : 'ok'}>{view.stale ? 'stale digest' : 'current'}</Pill>
        <span className="wb-dim mono">surface digest {view.digest}</span>
        <Pill>{view.operations.length} operations</Pill>
      </div>
      <TextLines
        items={view.operations.map(
          (op) =>
            op.name +
            ' · ' +
            op.visibility +
            ' · ' +
            (op.mutation ? 'mutation' : 'query') +
            (op.summary ? ' — ' + op.summary : '')
        )}
      />
    </>
  )
}

function AccessLane({ view }: { view: AccessLaneView }): React.JSX.Element {
  return (
    <>
      <div className="wb-row">
        <Pill tone={view.revoked ? 'err' : 'ok'}>{view.revoked ? 'revoked' : 'live'}</Pill>
        <Pill>{view.subject}</Pill>
        {view.policy !== '—' && <Pill>policy {view.policy}</Pill>}
      </div>
      <div className="wb-sub">
        <span className="wb-sub-l">effective actions</span>
        <TextLines items={view.effectiveActions} />
      </div>
      <div className="wb-sub">
        <span className="wb-sub-l">grants</span>
        {view.grants.length ? (
          <TextLines
            items={view.grants.map(
              (g) =>
                g.grantId +
                '@' +
                g.revision +
                ' · ' +
                g.kind +
                ' · ' +
                g.status +
                ' · ' +
                (g.actions.join(', ') || '—') +
                (g.targets.length ? ' · targets ' + g.targets.join(', ') : '') +
                (g.provisioning ? ' · ' + g.provisioning : '') +
                (g.expiresAt !== null ? ' · expires ' + g.expiresAt : '') +
                (g.revokedAt !== null ? ' · revoked at ' + g.revokedAt : '')
            )}
          />
        ) : (
          <div className="wb-note">no grant behind this subject</div>
        )}
      </div>
    </>
  )
}

function WorkerLane({ view }: { view: WorkerLaneView }): React.JSX.Element {
  const stages = toStageRows(view.receipt)
  return (
    <>
      <div className="wb-row">
        <Pill tone="accent">execution {view.executionId}</Pill>
        <Pill>member {view.memberId}</Pill>
        <Pill>gen {view.generation}</Pill>
        <Pill>{view.phase}</Pill>
        <Pill tone={view.liveness === 'live' ? 'ok' : 'dim'}>{view.liveness}</Pill>
      </div>
      <div className="wb-dim mono">
        host {view.hostId} · launch plan {view.launchPlanId} · digest {view.planDigest}
      </div>
      <div className="wb-sub">
        <span className="wb-sub-l">task authority</span>
        <div className="wb-note">{view.authority}</div>
      </div>
      <div className="wb-sub">
        <span className="wb-sub-l">receipt stages</span>
        {stages.length ? (
          <TextLines
            items={stages.map(
              (s) => s.stage + ' · ' + s.state + (s.at !== undefined ? ' @ ' + s.at : '')
            )}
          />
        ) : (
          <div className="wb-note">no stage receipt recorded</div>
        )}
        {view.failedStage && <Pill tone="err">failed at {view.failedStage}</Pill>}
      </div>
      <div className="wb-sub">
        <span className="wb-sub-l">residuals</span>
        <TextLines items={view.residuals} />
      </div>
      <div className="wb-sub">
        <span className="wb-sub-l">next allowed actions</span>
        <TextLines items={view.nextAllowedActions} />
      </div>
      {view.injectionReceipts.length > 0 && (
        <div className="wb-sub">
          <span className="wb-sub-l">injection receipts</span>
          <TextLines items={view.injectionReceipts} />
        </div>
      )}
      <div className="wb-note">
        {view.join} · terminal {view.terminalId}
      </div>
      <div className="wb-sub">
        <span className="wb-sub-l">recorded process identity</span>
        <KV value={view.processEvidence} />
      </div>
      {view.probe != null && (
        <div className="wb-sub">
          <span className="wb-sub-l">host probe</span>
          <KV value={view.probe} />
        </div>
      )}
    </>
  )
}

function LaneValue({ lane }: { lane: Lane }): React.JSX.Element {
  const body = lane.body
  if (!body) return <div className="wb-note">—</div>
  switch (body.kind) {
    case 'interface':
      return <InterfaceLane view={body.view} />
    case 'implementations':
      return <ImplementationsLane view={body.view} />
    case 'context':
      return <ContextLane view={body.view} />
    case 'surface':
      return <SurfaceLane view={body.view} />
    case 'access':
      return <AccessLane view={body.view} />
    case 'worker':
      return <WorkerLane view={body.view} />
  }
}

export default function InspectorView(): React.JSX.Element {
  const call = useScopeCaller()
  const { projectId, modelVersion } = useWorkbenchContext()
  const head = useModelHead()
  const resolvedModel = modelVersion || head?.modelVersion || ''

  const [roleId, setRoleId] = useState('')
  const [hostId, setHostId] = useState('')
  const [bundleDigest, setBundleDigest] = useState('')
  const [executionId, setExecutionId] = useState('')
  const [detail, setDetail] = useState<'own' | 'composition' | 'maintenance'>('own')
  const [surfaceOperation, setSurfaceOperation] = useState('')
  const [expectedSurfaceDigest, setExpectedSurfaceDigest] = useState('')
  const [memberId, setMemberId] = useState('')
  const [grantId, setGrantId] = useState('')
  const [probe, setProbe] = useState(false)
  const [lanes, setLanes] = useState<Lane[]>([])
  const [busy, setBusy] = useState(false)

  async function load(): Promise<void> {
    setBusy(true)
    const next: Lane[] = []

    if (roleId && resolvedModel) {
      const request = toInterfaceGetPayload(resolvedModel, roleId)
      try {
        const result = await getRoleInterface(call, request)
        next.push({
          id: 'interface',
          title: 'interface.get',
          request: { ...request },
          body: { kind: 'interface', view: toInterfaceLane(result) }
        })
      } catch (e) {
        next.push({
          id: 'interface',
          title: 'interface.get',
          request: { ...request },
          error: { kind: opErrorKind(e), message: opError(e).message }
        })
      }

      const implRequest = { modelVersion: resolvedModel, roleId, hostId: hostId || undefined }
      try {
        const result = await listImplementations(call, implRequest)
        next.push({
          id: 'implementations',
          title: 'role.implementations',
          request: { ...implRequest },
          body: { kind: 'implementations', view: result }
        })
      } catch (e) {
        next.push({
          id: 'implementations',
          title: 'role.implementations',
          request: { ...implRequest },
          error: { kind: opErrorKind(e), message: opError(e).message }
        })
      }
    }

    if (bundleDigest || executionId) {
      const request = {
        ...(bundleDigest ? { bundleDigest } : {}),
        ...(executionId ? { executionId } : {}),
        detail
      }
      try {
        const result = await inspectContext(call, request)
        next.push({
          id: 'context',
          title: 'context.inspect',
          request,
          body: { kind: 'context', view: result }
        })
      } catch (e) {
        next.push({
          id: 'context',
          title: 'context.inspect',
          request,
          error: { kind: opErrorKind(e), message: opError(e).message }
        })
      }
    }

    const surfaceRequest: SurfaceDescribePayload = {
      ...(surfaceOperation ? { operation: surfaceOperation } : {}),
      ...(expectedSurfaceDigest ? { expectedSurfaceDigest } : {})
    }
    try {
      const result = await describeSurface(call, surfaceRequest)
      next.push({
        id: 'surface',
        title: 'surface.describe',
        request: { ...surfaceRequest },
        body: { kind: 'surface', view: toSurfaceLane(result) }
      })
    } catch (e) {
      next.push({
        id: 'surface',
        title: 'surface.describe',
        request: { ...surfaceRequest },
        error: { kind: opErrorKind(e), message: opError(e).message }
      })
    }

    if (memberId || grantId) {
      const request = { ...(memberId ? { memberId } : {}), ...(grantId ? { grantId } : {}) }
      try {
        const result = await inspectAccess(call, request)
        next.push({
          id: 'access',
          title: 'access.inspect',
          request,
          body: { kind: 'access', view: toAccessLane(result) }
        })
      } catch (e) {
        next.push({
          id: 'access',
          title: 'access.inspect',
          request,
          error: { kind: opErrorKind(e), message: opError(e).message }
        })
      }
    }

    if (executionId || memberId) {
      const request: WorkerInspectPayload = {
        ...(executionId ? { executionId } : {}),
        ...(memberId ? { memberId } : {}),
        ...(probe ? { probe: true } : {})
      }
      try {
        const result = await inspectWorker(call, request)
        next.push({
          id: 'worker',
          title: 'worker.inspect',
          request: { ...request },
          body: { kind: 'worker', view: toWorkerLane(result) }
        })
      } catch (e) {
        next.push({
          id: 'worker',
          title: 'worker.inspect',
          request: { ...request },
          error: { kind: opErrorKind(e), message: opError(e).message }
        })
      }
    }

    setLanes(next)
    setBusy(false)
  }

  return (
    <div className="wb-view">
      <ContextBar />
      <Section title="inspector">
        <div className="wb-row">
          <Field label="role id" value={roleId} onChange={setRoleId} mono />
          <Field label="host id" value={hostId} onChange={setHostId} mono />
        </div>
        <div className="wb-row">
          <Field label="bundle digest" value={bundleDigest} onChange={setBundleDigest} mono wide />
          <Field label="execution id" value={executionId} onChange={setExecutionId} mono wide />
          <label className="wb-field">
            <span className="wb-field-l">detail</span>
            <select
              className="wb-in"
              value={detail}
              onChange={(e) => setDetail(e.target.value as 'own' | 'composition' | 'maintenance')}
            >
              <option value="own">own</option>
              <option value="composition">composition</option>
              <option value="maintenance">maintenance</option>
            </select>
          </label>
        </div>
        <div className="wb-row">
          <Field
            label="surface operation"
            value={surfaceOperation}
            onChange={setSurfaceOperation}
            mono
          />
          <Field
            label="expected surface digest"
            value={expectedSurfaceDigest}
            onChange={setExpectedSurfaceDigest}
            mono
            wide
          />
        </div>
        <div className="wb-row">
          <Field label="member id" value={memberId} onChange={setMemberId} mono />
          <Field label="grant id" value={grantId} onChange={setGrantId} mono />
          <label className="wb-check">
            <input type="checkbox" checked={probe} onChange={(e) => setProbe(e.target.checked)} />
            probe the recorded process
          </label>
        </div>
        <div className="wb-row">
          <button className="wb-btn" disabled={busy} onClick={() => void load()}>
            {busy ? 'loading…' : 'inspect'}
          </button>
          <span className="wb-dim">
            project {projectId || '—'} · model {resolvedModel || 'unknown'}
          </span>
        </div>
        <p className="wb-note">
          surface vs grants stay separate. A receipt lane is evidence, never an implied done.
          interface.get and role.implementations need a role id; context.inspect needs a bundle
          digest or an execution id; access.inspect needs a member or grant id.
        </p>
      </Section>
      {lanes.map((lane) => (
        <Section
          key={lane.id}
          title={lane.title}
          right={<span className="wb-dim mono">{JSON.stringify(lane.request)}</span>}
        >
          {lane.error ? (
            <OpError
              kind={lane.error.kind}
              message={lane.error.message}
              onRetry={() => void load()}
            />
          ) : (
            <LaneValue lane={lane} />
          )}
        </Section>
      ))}
    </div>
  )
}
