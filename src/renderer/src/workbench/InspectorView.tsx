// workbench/InspectorView.tsx — role/context/access/launch inspector (IMP-32).
//
// Reads domain ops by name through the workbench caller. Does not import
// mahas-runtime inspector internals (renderer may only type-import contracts).
// Coverage rows are built here from the envelopes: first binding per clause,
// every load route shown, planned vs receipt kept separate.

import { useState } from 'react'
import { workbenchCaller, opError, opErrorKind } from './client.ts'
import { ContextBar, KV, OpError, Pill, Section } from './bits.tsx'
import { useWorkbench } from './store.ts'

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

interface Lane {
  title: string
  error?: { kind: ReturnType<typeof opErrorKind>; message: string }
  body?: unknown
}

export default function InspectorView(): React.JSX.Element {
  const { projectId, modelVersion } = useWorkbench()
  const [interfaceDigest, setInterfaceDigest] = useState('')
  const [implementationId, setImplementationId] = useState('')
  const [executionId, setExecutionId] = useState('')
  const [lanes, setLanes] = useState<Lane[]>([])
  const [busy, setBusy] = useState(false)

  async function load(): Promise<void> {
    const call = workbenchCaller()
    setBusy(true)
    const next: Lane[] = []
    const pull = async (title: string, op: string, payload: unknown): Promise<unknown> => {
      try {
        const body = await call(op, payload)
        next.push({ title, body })
        return body
      } catch (e) {
        next.push({ title, error: { kind: opErrorKind(e), message: opError(e).message } })
        return null
      }
    }
    if (interfaceDigest) {
      const iface = rec(
        await pull('interface', 'interface.get', { digest: interfaceDigest, modelVersion })
      )
      await pull('implementations', 'role.implementations', {
        interfaceDigest,
        modelVersion,
        projectId
      })
      const reqs = arr(iface?.requirements)
      const bindings = arr(iface?.coverage ?? iface?.bindings)
      const components = arr(iface?.components)
      if (reqs.length || bindings.length) {
        next.push({
          title: 'coverage (clause → first binding + all routes)',
          body: reqs.map((r) => {
            const row = rec(r) ?? {}
            const clauseId = str(row.clauseId) || str(row.id)
            const matches = bindings.filter((b) => {
              const br = rec(b) ?? {}
              return str(br.clauseId) === clauseId || str(br.requirementId) === clauseId
            })
            const first = rec(matches[0]) ?? {}
            const phase = str(first.requiredLoadPhase) || str(first.loadPhase)
            return {
              clauseId,
              requiredMeaning: str(row.requiredMeaning) || str(row.text),
              readerPerspective: str(row.readerPerspective),
              firstBinding: first,
              allRoutes: matches,
              gap:
                matches.length === 0
                  ? 'uncovered'
                  : phase === 'conditional' || phase === 'catalog'
                    ? 'conditional-only'
                    : 'none'
            }
          })
        })
      }
      if (components.length) next.push({ title: 'components', body: components })
    }
    if (implementationId) {
      await pull('context.inspect', 'context.inspect', {
        implementationId,
        detail: 'effective'
      })
      await pull('profile.inspect', 'harness.profile.inspect', { implementationId })
    }
    await pull('surface.describe', 'surface.describe', { projectId })
    await pull('access.inspect', 'access.inspect', { projectId })
    if (executionId) {
      await pull('worker.inspect', 'worker.inspect', { executionId })
    }
    setLanes(next)
    setBusy(false)
  }

  return (
    <div className="wb-view">
      <ContextBar />
      <Section title="inspector">
        <div className="wb-row">
          <input
            className="wb-in mono"
            placeholder="interface digest"
            value={interfaceDigest}
            onChange={(e) => setInterfaceDigest(e.target.value)}
          />
          <input
            className="wb-in mono"
            placeholder="implementation id"
            value={implementationId}
            onChange={(e) => setImplementationId(e.target.value)}
          />
          <input
            className="wb-in mono"
            placeholder="execution id"
            value={executionId}
            onChange={(e) => setExecutionId(e.target.value)}
          />
          <button className="wb-btn" disabled={busy} onClick={() => void load()}>
            {busy ? 'loading…' : 'inspect'}
          </button>
        </div>
        <p className="wb-note">
          surface vs grants stay separate. a receipt lane is evidence, never an implied done.
          worker.start is not on this surface.
        </p>
      </Section>
      {lanes.map((lane) => (
        <Section key={lane.title} title={lane.title}>
          {lane.error ? (
            <OpError kind={lane.error.kind} message={lane.error.message} onRetry={() => void load()} />
          ) : (
            <KV value={lane.body} />
          )}
          {lane.title === 'coverage (clause → first binding + all routes)' &&
            arr(lane.body).map((row, i) => {
              const r = rec(row) ?? {}
              const gap = str(r.gap)
              return (
                <div key={i} className="wb-kv-row">
                  <span className="wb-kv-k">{str(r.clauseId)}</span>
                  <span className="wb-kv-v">
                    {str(r.requiredMeaning) || '—'}{' '}
                    <Pill tone={gap === 'none' ? 'ok' : gap === 'uncovered' ? 'err' : 'warn'}>
                      {gap || 'unknown'}
                    </Pill>
                  </span>
                </div>
              )
            })}
        </Section>
      ))}
    </div>
  )
}
